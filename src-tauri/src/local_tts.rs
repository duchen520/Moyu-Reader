//! CPU-only, in-process Kokoro. Work is serialized off the UI thread; audio is
//! returned in memory and never written to the user's book/reading database.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::{Path, PathBuf}, sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}, mpsc}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::sync::oneshot;
const FILES: &[&str] = &["model.int8.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt", "lexicon-zh.txt", "date-zh.fst", "number-zh.fst", "phone-zh.fst", "LICENSE"];
fn manifest()->Value {serde_json::from_str(include_str!("../native/kokoro-model-manifest.json")).expect("embedded public model manifest")}
fn required(root: &Path) -> bool { FILES.iter().all(|name| root.join(name).is_file()) && root.join("dict").is_dir() && root.join("espeak-ng-data").is_dir() }
fn verified(root: &Path) -> Result<(), String> {
    if !required(root) {return Err("语音包不完整，请选择包含 model.int8.onnx 和 voices.bin 的文件夹".into());}
    for record in manifest()["files"].as_array().unwrap() {
        let name=record["path"].as_str().unwrap();let expected=record["hash"].as_str().unwrap();
        let path=root.join(name);
        if fs::symlink_metadata(&path).map_err(|_|"语音包文件缺失")?.len()!=record["size"].as_u64().unwrap() {return Err("语音包文件大小不匹配".into());}
        let mut file = fs::File::open(&path).map_err(|_|"无法读取语音包")?;
        let mut hash = Sha256::new(); let mut bytes = [0u8; 65536];
        loop {let n=file.read(&mut bytes).map_err(|_|"无法读取语音包")?; if n==0 {break;} hash.update(&bytes[..n]);}
        if format!("{:x}",hash.finalize())!=expected {return Err("语音包版本或校验值不匹配，请使用 Kokoro 1.1 中文 INT8 包".into());}
    }
    Ok(())
}
fn installed(root: &Path) -> Option<PathBuf> {
    let name=fs::read_to_string(root.join("active.txt")).ok()?;
    if !name.starts_with("model-") || !name.bytes().all(|c|c.is_ascii_alphanumeric() || c==b'-') {return None;}
    let path=root.join(name); required(&path).then_some(path)
}
struct Maintenance(Arc<AtomicBool>);
impl Maintenance {
    fn acquire(flag: &Arc<AtomicBool>) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "语音包正在导入或卸载，请稍等".to_string())?;
        Ok(Self(flag.clone()))
    }
}
impl Drop for Maintenance { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }
fn remove_models(root: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("无法读取离线语音目录：{error}")),
    };
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取语音包文件：{error}"))?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with("model-") {
            fs::remove_dir_all(entry.path()).map_err(|error| format!("语音包尚未完全卸载，请重试：{error}"))?;
        }
    }
    // Publish the uninstalled state only after model handles and files are gone.
    for name in ["active.txt", "active.next"] {
        match fs::remove_file(root.join(name)) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(format!("无法清理语音包记录：{error}")),
        }
    }
    Ok(())
}
enum Job {
    Generate {session:u64, text:String, speaker:i32, reply:oneshot::Sender<Result<Value,String>>},
    Release {epoch:u64},
    Uninstall {guard:Maintenance, reply:mpsc::Sender<Result<(),String>>},
}
pub(crate) struct LocalTts {
    root:PathBuf, engine:PathBuf, epoch:Arc<AtomicU64>, importing:Arc<AtomicBool>, loaded:Arc<AtomicBool>, sender:mpsc::SyncSender<Job>,
}
impl LocalTts {
    pub(crate) fn new(root:PathBuf, engine:PathBuf) -> Self {
        let epoch=Arc::new(AtomicU64::new(1)); let importing=Arc::new(AtomicBool::new(false));
        let loaded=Arc::new(AtomicBool::new(false));let worker_loaded=loaded.clone();
        let (sender,receiver)=mpsc::sync_channel(2);
        let (worker_root,worker_engine,worker_epoch)=(root.clone(),engine.clone(),epoch.clone());
        std::thread::Builder::new().name("kokoro-cpu".into()).spawn(move || {
            let mut native:Option<native::Native>=None;
            loop {
                match receiver.recv_timeout(Duration::from_secs(30)) {
                    Ok(Job::Release{epoch}) => {if worker_epoch.load(Ordering::SeqCst)==epoch {native=None;worker_loaded.store(false,Ordering::SeqCst);}},
                    Ok(Job::Uninstall{guard,reply}) => {
                        // Drop the native model on its owner thread before touching
                        // the mapped files. Windows keeps those handles locked.
                        native=None; worker_loaded.store(false,Ordering::SeqCst);
                        let result=remove_models(&worker_root);
                        drop(guard);
                        let _=reply.send(result);
                    },
                    Ok(Job::Generate{session,text,speaker,reply}) => {
                        let result=(|| {
                            if worker_epoch.load(Ordering::SeqCst)!=session {return Err("朗读已取消".into());}
                            if native.is_none() {
                                let model=installed(&worker_root).ok_or("请先导入 Kokoro 离线语音包")?;
                                verified(&model)?;
                                native=Some(native::Native::load(&worker_engine,&model)?);
                                worker_loaded.store(true,Ordering::SeqCst);
                            }
                            if worker_epoch.load(Ordering::SeqCst)!=session {return Err("朗读已取消".into());}
                            let wav=native.as_mut().unwrap().generate(&text,speaker,session,&worker_epoch)?;
                            if worker_epoch.load(Ordering::SeqCst)!=session {return Err("朗读已取消".into());}
                            Ok(json!({"audioBase64":STANDARD.encode(wav),"mime":"audio/wav","session":session}))
                        })();
                        if worker_epoch.load(Ordering::SeqCst)!=session {native=None;worker_loaded.store(false,Ordering::SeqCst);}
                        let _=reply.send(result);
                    },
                    Err(mpsc::RecvTimeoutError::Timeout) => {native=None;worker_loaded.store(false,Ordering::SeqCst);},
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        }).expect("Kokoro worker thread");
        Self{root,engine,epoch,importing,loaded,sender}
    }
    pub(crate) fn status(&self) -> Value {
        let available=self.engine.join("tomato-kokoro.dll").is_file();
        json!({"installed":installed(&self.root).is_some(),"engineAvailable":available,"importing":self.importing.load(Ordering::SeqCst),"modelLoaded":self.loaded.load(Ordering::SeqCst)})
    }
    pub(crate) fn begin(&self) -> Result<u64,String> {
        if self.importing.load(Ordering::SeqCst) {return Err("正在导入语音包，请稍等".into());}
        if installed(&self.root).is_none() {return Err("请先导入 Kokoro 离线语音包".into());}
        Ok(self.epoch.fetch_add(1,Ordering::SeqCst)+1)
    }
    pub(crate) fn stop(&self, session:u64) {
        if self.epoch.compare_exchange(session,session.wrapping_add(1),Ordering::SeqCst,Ordering::SeqCst).is_ok() {
            let _=self.sender.try_send(Job::Release{epoch:session.wrapping_add(1)});
        }
    }
    pub(crate) async fn synthesize(&self, session:u64, text:String, speaker:i32) -> Result<Value,String> {
        validate_text(&text,speaker)?;
        if self.importing.load(Ordering::SeqCst) || session<2 || self.epoch.load(Ordering::SeqCst)!=session {return Err("朗读已取消".into());}
        let (reply,receiver)=oneshot::channel();
        self.sender.try_send(Job::Generate{session,text,speaker,reply}).map_err(|_|"语音引擎忙，请停止后重试")?;
        receiver.await.map_err(|_|"语音引擎已退出")?
    }
    pub(crate) fn import(&self, source:&Path) -> Result<Value,String> {
        let _reset=Maintenance::acquire(&self.importing)?;
        verified(source)?;
        if let Some(model)=installed(&self.root) {if verified(&model).is_ok() {drop(_reset); return Ok(self.status());}}
        // Never mutate or move the source package. Publish the installed copy only
        // after verification; an interrupted import does not replace a working one.
        fs::create_dir_all(&self.root).map_err(|_|"无法创建离线语音目录")?;
        let stamp=SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let name=format!("model-{stamp}"); let destination=self.root.join(&name);
        fs::create_dir(&destination).map_err(|_|"无法创建离线语音目录")?;
        let result=(|| {
        for record in manifest()["files"].as_array().unwrap() {
            let name=record["path"].as_str().unwrap();let output=destination.join(name);
            fs::create_dir_all(output.parent().unwrap()).map_err(|_|"无法创建本地语音目录")?;
            fs::copy(source.join(name),output).map_err(|_|"语音包复制失败，请检查磁盘空间和权限")?;
        }
        verified(&destination)?;
        fs::write(self.root.join("active.next"),name.as_bytes()).map_err(|_|"语音包保存失败")?;
        fs::rename(self.root.join("active.next"),self.root.join("active.txt")).map_err(|_|"语音包保存失败")?;
        Ok::<(),String>(())
        })();
        if result.is_err() { let _=fs::remove_dir_all(&destination); let _=fs::remove_file(self.root.join("active.next")); }
        result?;
        drop(_reset); Ok(self.status())
    }
    pub(crate) fn uninstall(&self) -> Result<Value, String> {
        let guard=Maintenance::acquire(&self.importing)?;
        self.epoch.fetch_add(1,Ordering::SeqCst);
        let (reply,receiver)=mpsc::channel();
        self.sender.try_send(Job::Uninstall{guard,reply})
            .map_err(|_| "语音引擎忙，暂未卸载，请稍后重试".to_string())?;
        match receiver.recv_timeout(Duration::from_secs(30)) {
            Ok(result) => result?,
            Err(mpsc::RecvTimeoutError::Timeout) => return Err("卸载仍在处理中，请稍后重新检查语音包状态".into()),
            Err(_) => return Err("语音引擎已退出，卸载未完成".into()),
        }
        Ok(self.status())
    }
}
fn validate_text(text:&str,speaker:i32)->Result<(),String>{
    if text.trim().is_empty() || text.chars().count()>80 || text.contains('\0') {return Err("每段朗读需要1至80个文字字符".into());}
    if !(3..=102).contains(&speaker) {return Err("请选择有效的中文音色".into());}
    Ok(())
}
fn wave(samples:&[f32],rate:i32)->Result<Vec<u8>,String>{
    if rate!=24000 || samples.is_empty() || samples.len()>24000*120 || samples.iter().any(|v|!v.is_finite()) {return Err("离线语音返回了无效音频".into());}
    let size=(samples.len()*2) as u32;let mut out=Vec::with_capacity(44+size as usize);
    out.extend_from_slice(b"RIFF");out.extend_from_slice(&(36+size).to_le_bytes());out.extend_from_slice(b"WAVEfmt ");out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());out.extend_from_slice(&1u16.to_le_bytes());out.extend_from_slice(&(rate as u32).to_le_bytes());out.extend_from_slice(&((rate*2) as u32).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());out.extend_from_slice(&16u16.to_le_bytes());out.extend_from_slice(b"data");out.extend_from_slice(&size.to_le_bytes());
    for sample in samples {out.extend_from_slice(&((sample.clamp(-1.,1.)*32767.) as i16).to_le_bytes());}
    Ok(out)
}
#[cfg(windows)]
mod native {
    use super::*;
    use std::{ffi::{CString,CStr,c_void,c_char},os::windows::ffi::OsStrExt};
    #[link(name="kernel32")] extern "system" {fn LoadLibraryExW(name:*const u16,file:*mut c_void,flags:u32)->*mut c_void;fn GetProcAddress(module:*mut c_void,name:*const c_char)->*mut c_void;fn FreeLibrary(module:*mut c_void)->i32;}
    #[repr(C)] struct Audio {samples:*const f32,n:i32,rate:i32}
    type Create=unsafe extern "C" fn(*const c_char)->*mut c_void;
    type Destroy=unsafe extern "C" fn(*mut c_void);
    type Generate=unsafe extern "C" fn(*mut c_void,*const c_char,i32,unsafe extern "C" fn(*mut c_void)->i32,*mut c_void)->*const Audio;
    type Free=unsafe extern "C" fn(*const Audio);
    type Version=unsafe extern "C" fn()->*const c_char;
    pub struct Native {model:*mut c_void,library:*mut c_void,destroy:Destroy,generate:Generate,free:Free}
    impl Drop for Native {fn drop(&mut self){unsafe{(self.destroy)(self.model);FreeLibrary(self.library);}}}
    struct Cancellation<'a>{epoch:&'a AtomicU64,session:u64}
    unsafe extern "C" fn proceed(opaque:*mut c_void)->i32 {let state=&*(opaque as *const Cancellation<'_>);i32::from(state.epoch.load(Ordering::SeqCst)==state.session)}
    impl Native {
        pub fn load(engine:&Path,model:&Path)->Result<Self,String>{unsafe{
            let path:Vec<u16>=engine.join("tomato-kokoro.dll").as_os_str().encode_wide().chain(Some(0)).collect();
            // Restrict dependencies to the bundled DLL directory and system/default
            // directories; do not search the caller's current working directory.
            let library=LoadLibraryExW(path.as_ptr(),std::ptr::null_mut(),0x100|0x1000);
            if library.is_null(){return Err("离线语音引擎缺失或无法加载，请重新安装阅读器".into());}
            macro_rules! symbol {($name:literal,$ty:ty)=>{{let ptr=GetProcAddress(library,concat!($name,"\0").as_ptr().cast());if ptr.is_null(){FreeLibrary(library);return Err("离线语音引擎版本不匹配".into());}std::mem::transmute::<*mut c_void,$ty>(ptr)}}}
            let version=symbol!("TrKokoroVersion",Version);
            if CStr::from_ptr(version()).to_bytes()!=b"1.13.8"{FreeLibrary(library);return Err("离线语音引擎版本不匹配".into());}
            let create=symbol!("TrKokoroCreate",Create);let destroy=symbol!("TrKokoroDestroy",Destroy);let generate=symbol!("TrKokoroGenerate",Generate);let free=symbol!("TrKokoroFreeAudio",Free);
            let path=CString::new(model.to_string_lossy().as_bytes()).map_err(|_|"语音包路径无效")?;
            let model=create(path.as_ptr());
            if model.is_null(){FreeLibrary(library);return Err("离线语音模型加载失败，请检查语音包".into());}
            Ok(Self{model,library,destroy,generate,free})
        }}
        pub fn generate(&mut self,text:&str,speaker:i32,session:u64,epoch:&AtomicU64)->Result<Vec<u8>,String>{unsafe{
            let text=CString::new(text).map_err(|_|"朗读文本包含无效字符")?;
            let mut cancel=Cancellation{epoch,session};
            let audio=(self.generate)(self.model,text.as_ptr(),speaker,proceed,(&mut cancel as *mut Cancellation<'_>).cast());
            if audio.is_null(){return Err("本段离线语音合成失败，请重试或更换音色".into());}
            let result=if (*audio).samples.is_null() || (*audio).n<=0 || (*audio).n>24000*120 {Err("离线语音返回了无效音频".into())}
                else {wave(std::slice::from_raw_parts((*audio).samples,(*audio).n as usize),(*audio).rate)};
            (self.free)(audio);result
        }}
    }
}
#[cfg(not(windows))]
mod native {use super::*;pub struct Native;impl Native{pub fn load(_: &Path,_:&Path)->Result<Self,String>{Err("此离线语音版本需要Windows桌面客户端".into())}pub fn generate(&mut self,_:&str,_:i32,_:u64,_:&AtomicU64)->Result<Vec<u8>,String>{Err("此离线语音版本需要Windows桌面客户端".into())}}}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn rejects_unbounded_text_and_invalid_voice(){assert!(validate_text("你好",3).is_ok());assert!(validate_text("",3).is_err());assert!(validate_text(&"中".repeat(81),3).is_err());assert!(validate_text("你\0好",3).is_err());assert!(validate_text("你好",2).is_err());assert!(validate_text("你好",103).is_err());}
    #[test] fn wave_is_bounded_and_clamps_pcm(){let w=wave(&[-2.,0.,2.],24000).unwrap();assert_eq!(&w[..4],b"RIFF");assert_eq!(w.len(),50);assert_eq!(&w[44..46],&(-32767i16).to_le_bytes());assert_eq!(&w[48..],&32767i16.to_le_bytes());assert!(wave(&[f32::NAN],24000).is_err());assert!(wave(&[],24000).is_err());assert!(wave(&[0.],0).is_err());}
    #[test] fn stale_stop_does_not_cancel_a_new_session(){let dir=std::env::temp_dir().join(format!("kokoro-test-{}",rand::random::<u64>()));let service=LocalTts::new(dir.clone(),dir);service.epoch.store(9,Ordering::SeqCst);service.stop(8);assert_eq!(service.epoch.load(Ordering::SeqCst),9);service.stop(9);assert_eq!(service.epoch.load(Ordering::SeqCst),10);}
    #[test] fn active_model_name_cannot_escape_root(){let dir=std::env::temp_dir().join(format!("kokoro-pointer-{}",rand::random::<u64>()));fs::create_dir(&dir).unwrap();fs::write(dir.join("active.txt"),"../other").unwrap();assert!(installed(&dir).is_none());fs::remove_file(dir.join("active.txt")).unwrap();fs::remove_dir(dir).unwrap();}
    #[test] fn uninstall_is_serialized_and_preserves_unrelated_files() {
        let dir=std::env::temp_dir().join(format!("kokoro-uninstall-{}",rand::random::<u64>()));
        fs::create_dir_all(dir.join("model-123")).unwrap();
        fs::write(dir.join("model-123/model.int8.onnx"),b"fixture").unwrap();
        fs::write(dir.join("active.txt"),b"model-123").unwrap();
        fs::write(dir.join("keep.txt"),b"unrelated").unwrap();
        let service=LocalTts::new(dir.clone(),dir.clone());
        let epoch=service.epoch.load(Ordering::SeqCst);
        let status=service.uninstall().unwrap();
        assert_eq!(status["installed"],false);
        assert_eq!(status["importing"],false);
        assert!(!dir.join("model-123").exists());
        assert!(!dir.join("active.txt").exists());
        assert!(dir.join("keep.txt").exists());
        assert!(service.epoch.load(Ordering::SeqCst)>epoch);
        service.uninstall().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
    #[test] fn maintenance_rejects_import_uninstall_overlap_and_reports_cleanup_failure() {
        let dir=std::env::temp_dir().join(format!("kokoro-maintenance-{}",rand::random::<u64>()));
        fs::create_dir(&dir).unwrap();
        let service=LocalTts::new(dir.clone(),dir.clone());
        let guard=Maintenance::acquire(&service.importing).unwrap();
        assert!(service.uninstall().is_err());
        assert!(service.import(&dir).is_err());
        assert!(service.importing.load(Ordering::SeqCst));
        drop(guard);
        // An unexpected regular file cannot be recursively removed as a model directory.
        fs::write(dir.join("model-locked"),b"fixture").unwrap();
        fs::write(dir.join("active.txt"),b"model-locked").unwrap();
        assert!(service.uninstall().is_err());
        assert!(!service.importing.load(Ordering::SeqCst));
        assert!(dir.join("active.txt").exists());
        assert!(dir.join("model-locked").exists());
        fs::remove_dir_all(dir).unwrap();
    }

}
