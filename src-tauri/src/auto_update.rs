use reqwest::{Client, Response};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tokio::sync::Notify;

const LATEST: &str = "https://api.github.com/repos/duchen520/Moyu-Reader/releases/latest";
const MAX_INSTALLER: u64 = 256 * 1024 * 1024;

#[derive(Clone)]
struct Installer { version: String, url: String, digest: String, size: u64 }
#[derive(Clone)]
struct Ready { installer: Installer, path: PathBuf }
#[derive(Default)]
struct State { active: Option<Arc<Notify>>, ready: Option<Ready>, installing: bool }
pub struct UpdateService { root: PathBuf, state: Mutex<State> }

fn stable_version(text: &str) -> Result<[u64; 3], String> {
    let text = text.strip_prefix('v').unwrap_or(text);
    let parts: Vec<_> = text.split('.').collect();
    if parts.len() != 3 { return Err("更新版本号无效".into()); }
    let mut result = [0; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) || (part.len() > 1 && part.starts_with('0')) { return Err("更新版本号无效".into()); }
        result[i] = part.parse().map_err(|_| "更新版本号无效")?;
    }
    Ok(result)
}
fn select_installer(data: &Value, requested: &str, current: &str) -> Result<Installer, String> {
    let latest = data["tag_name"].as_str().ok_or("发布资料缺少版本号")?;
    let version = latest.strip_prefix('v').unwrap_or(latest);
    if version != requested || stable_version(version)? <= stable_version(current)? || data["draft"].as_bool().unwrap_or(true) || data["prerelease"].as_bool().unwrap_or(true) {
        return Err("发布版本已变化或不是较新的正式版，请重新检查更新".into());
    }
    let asset = data["assets"].as_array().ok_or("发布资料没有附件")?.iter().find(|asset| {
        let name = asset["name"].as_str().unwrap_or("").to_ascii_lowercase();
        name.ends_with(&format!("-{version}-x64-setup.exe")) || name.ends_with(&format!("_{version}_x64-setup.exe"))
    }).ok_or("新版尚未提供 Windows x64 Setup 安装包")?;
    let size = asset["size"].as_u64().filter(|n| *n >= 2 && *n <= MAX_INSTALLER).ok_or("安装包大小无效")?;
    let digest = asset["digest"].as_str().and_then(|s| s.strip_prefix("sha256:")).filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())).ok_or("安装包校验资料尚未就绪，请稍后重试")?.to_ascii_lowercase();
    let raw_url = asset["browser_download_url"].as_str().ok_or("安装包下载地址无效")?;
    let url = url::Url::parse(raw_url).map_err(|_| "安装包下载地址无效")?;
    let segments: Vec<_> = url.path_segments().ok_or("安装包下载地址无效")?.collect();
    if url.scheme() != "https" || url.host_str() != Some("github.com") || url.port_or_known_default() != Some(443) || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        || segments.len() != 6 || segments[0] != "duchen520" || !["Moyu-Reader", "Tomato-Reader"].contains(&segments[1]) || segments[2] != "releases" || segments[3] != "download" || segments[4] != latest {
        return Err("拒绝非本应用仓库的安装包地址".into());
    }
    let mut expected = url::Url::parse("https://github.com").unwrap();
    expected.path_segments_mut().unwrap().extend(["duchen520", segments[1], "releases", "download", latest, asset["name"].as_str().unwrap_or("")]);
    if expected != url { return Err("安装包地址与附件名称不匹配".into()); }
    Ok(Installer { version: version.into(), url: raw_url.into(), digest, size })
}

// This object owns only the files in a freshly created random update directory.
// Dropping a failed/cancelled download removes its partial file, never user data.
struct PartialFile { path: PathBuf, keep: bool }
impl Drop for PartialFile {
    fn drop(&mut self) {
        if !self.keep { let _ = fs::remove_file(&self.path); if let Some(dir) = self.path.parent() { let _ = fs::remove_dir(dir); } }
    }
}
fn discard(ready: Ready) {
    let _ = fs::remove_file(&ready.path);
    if let Some(dir) = ready.path.parent() { let _ = fs::remove_dir(dir); }
}
fn hash_file(file: &mut File) -> Result<String, String> {
    let mut hash = Sha256::new(); let mut buf = [0u8; 64 * 1024];
    loop { let n = file.read(&mut buf).map_err(|e| format!("无法复核安装包：{e}"))?; if n == 0 { break; } hash.update(&buf[..n]); }
    Ok(format!("{:x}", hash.finalize()))
}

async fn receive(mut response: Response, installer: &Installer, path: &Path, progress: &(dyn Fn(Value) + Send + Sync)) -> Result<(), String> {
    if !response.status().is_success() { return Err(format!("下载失败：HTTP {}", response.status())); }
    if let Some(length) = response.content_length() { if length != installer.size { return Err("安装包长度与发布资料不一致".into()); } }
    let mut file = OpenOptions::new().create_new(true).write(true).open(path).map_err(|e| format!("无法保存更新：{e}"))?;
    let mut received = 0u64; let mut hasher = Sha256::new(); let mut last = Instant::now() - Duration::from_secs(1);
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(30), response.chunk()).await.map_err(|_| "下载长时间没有响应，请重试")?.map_err(|e| format!("下载中断：{e}"))? {
        received += chunk.len() as u64;
        if received > installer.size { return Err("下载内容超过安装包声明大小".into()); }
        file.write_all(&chunk).map_err(|e| format!("写入更新失败：{e}"))?;
        hasher.update(&chunk);
        if last.elapsed() >= Duration::from_millis(120) { progress(json!({"phase":"downloading","received":received,"total":installer.size})); last = Instant::now(); }
    }
    progress(json!({"phase":"verifying","received":received,"total":installer.size}));
    if received != installer.size || format!("{:x}", hasher.finalize()) != installer.digest { return Err("安装包校验失败，已丢弃下载，请重试".into()); }
    file.sync_all().map_err(|e| format!("保存安装包失败：{e}"))?;
    drop(file);
    let mut file = File::open(path).map_err(|e| format!("无法读取下载：{e}"))?;
    let mut magic = [0u8; 2]; file.read_exact(&mut magic).map_err(|_| "安装包内容不完整")?;
    if magic != *b"MZ" { return Err("下载内容不是 Windows 安装程序".into()); }
    Ok(())
}

impl UpdateService {
    pub fn new(root: PathBuf) -> Self { Self { root, state: Mutex::new(State::default()) } }
    pub fn cancel(&self) -> Result<(), String> {
        let state = self.state.lock().map_err(|_| "更新状态不可用")?;
        if state.installing { return Err("安装程序正在启动".into()); }
        if let Some(signal) = &state.active { signal.notify_one(); }
        Ok(())
    }
    pub async fn download(&self, requested: &str, current: &str, progress: &(dyn Fn(Value) + Send + Sync)) -> Result<Value, String> {
        if stable_version(requested)? <= stable_version(current)? { return Err("没有可下载的较新正式版，请重新检查更新".into()); }
        let signal = Arc::new(Notify::new());
        {
            let mut state = self.state.lock().map_err(|_| "更新状态不可用")?;
            if state.active.is_some() || state.installing { return Err("已有更新任务正在进行".into()); }
            if let Some(old) = state.ready.take() { discard(old); }
            state.active = Some(signal.clone());
        }
        let result = cancellable(&signal, self.download_inner(requested, current, progress)).await;
        let mut state = self.state.lock().map_err(|_| "更新状态不可用")?;
        state.active = None;
        match result {
            Ok(ready) => {
                let result = json!({"version":ready.installer.version,"total":ready.installer.size});
                state.ready = Some(ready); Ok(result)
            }
            Err(error) => Err(error),
        }
    }
    async fn download_inner(&self, requested: &str, current: &str, progress: &(dyn Fn(Value) + Send + Sync)) -> Result<Ready, String> {
        progress(json!({"phase":"preparing","received":0,"total":0}));
        let client = Client::builder().https_only(true).user_agent("Moyu-Reader-Updater").connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(15 * 60)).redirect(reqwest::redirect::Policy::limited(8)).build().map_err(|e| format!("更新连接失败：{e}"))?;
        let response = client.get(LATEST).header("Accept", "application/vnd.github+json").timeout(Duration::from_secs(20)).send().await.map_err(|e| format!("无法读取发布资料：{e}"))?;
        if !response.status().is_success() { return Err(format!("读取发布资料失败：HTTP {}", response.status())); }
        if response.content_length().unwrap_or(0) > 2 * 1024 * 1024 { return Err("发布资料过大".into()); }
        let bytes = response.bytes().await.map_err(|e| format!("读取发布资料中断：{e}"))?;
        if bytes.len() > 2 * 1024 * 1024 { return Err("发布资料过大".into()); }
        let data: Value = serde_json::from_slice(&bytes).map_err(|_| "发布资料格式无效")?;
        let installer = select_installer(&data, requested, current)?;
        fs::create_dir_all(&self.root).map_err(|e| format!("无法创建更新缓存：{e}"))?;
        let nonce: u128 = rand::random();
        let dir = self.root.join(format!("download-{nonce:032x}"));
        fs::create_dir(&dir).map_err(|e| format!("无法创建下载目录：{e}"))?;
        let path = dir.join("moyu-setup.exe");
        let mut partial = PartialFile { path: path.clone(), keep: false };
        let response = client.get(&installer.url).send().await.map_err(|e| format!("无法下载安装包：{e}"))?;
        receive(response, &installer, &path, progress).await?;
        partial.keep = true;
        Ok(Ready { installer, path })
    }
    pub fn launch_installer(&self, current_exe: &Path) -> Result<(), String> {
        let ready = {
            let mut state = self.state.lock().map_err(|_| "更新状态不可用")?;
            if state.active.is_some() || state.installing { return Err("更新任务尚未就绪".into()); }
            let ready = state.ready.clone().ok_or("请先下载并校验新版安装包")?;
            state.installing = true;
            ready
        };
        let result = launch_verified(&ready, current_exe);
        if result.is_err() { self.state.lock().map_err(|_| "更新状态不可用")?.installing = false; }
        result
    }
}

async fn cancellable<T>(signal: &Notify, work: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::select! { biased; _ = signal.notified() => Err(String::from("更新下载已取消")), result = work => result }
}

fn installer_args(current_exe: &Path) -> Vec<String> {
    let mut args = vec!["/P".into(), "/R".into()];
    // Only an installed copy can supply an installation directory. A standalone
    // executable uses the installer's saved/default directory instead of
    // unexpectedly turning the user's Downloads folder into an installation.
    if let Some(dir) = current_exe.parent() {
        if current_exe.file_name().and_then(|s| s.to_str()) == Some("tomato-reader.exe") && dir.join("uninstall.exe").is_file() {
            args.push("/UPDATE".into()); args.push(format!("/D={}", dir.display())); // NSIS /D must be last.
        }
    }
    args
}
fn launch_verified(ready: &Ready, current_exe: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, process::CommandExt};
        // Deny writes/deletion while checking and starting the exact cached file.
        let mut file = OpenOptions::new().read(true).share_mode(1).open(&ready.path).map_err(|e| format!("无法打开安装包：{e}"))?;
        if file.metadata().map_err(|e| e.to_string())?.len() != ready.installer.size || hash_file(&mut file)? != ready.installer.digest { return Err("安装包已发生变化，请重新下载".into()); }
        // NSIS consumes the unquoted remainder after its final /D= option.
        // These arguments come only from this code and the current EXE path;
        // no shell or frontend-provided command line is involved.
        std::process::Command::new(&ready.path).raw_arg(installer_args(current_exe).join(" ")).creation_flags(0x08000000).spawn().map_err(|e| format!("无法启动安装程序：{e}；应用尚未退出"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    { let _ = (ready, current_exe); Err("内置安装更新目前仅支持 Windows".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release() -> Value { json!({"tag_name":"v1.2.3","draft":false,"prerelease":false,"assets":[{"name":"Moyu-Reader-1.2.3-x64-setup.exe","size":8,"digest":format!("sha256:{}", "a".repeat(64)),"browser_download_url":"https://github.com/duchen520/Moyu-Reader/releases/download/v1.2.3/Moyu-Reader-1.2.3-x64-setup.exe"}]}) }
    #[test] fn only_new_stable_installer_from_own_repository_is_accepted() {
        let mut data = release(); assert!(select_installer(&data, "1.2.3", "1.2.2").is_ok());
        assert!(select_installer(&data, "1.2.3", "1.2.3").is_err()); assert!(select_installer(&data, "1.2.4", "1.2.2").is_err());
        data["prerelease"] = json!(true); assert!(select_installer(&data, "1.2.3", "1.2.2").is_err());
        for url in ["https://github.com/attacker/Moyu-Reader/releases/download/v1.2.3/Moyu-Reader-1.2.3-x64-setup.exe", "http://github.com/duchen520/Moyu-Reader/releases/download/v1.2.3/Moyu-Reader-1.2.3-x64-setup.exe", "https://github.com/duchen520/Moyu-Reader/releases/download/v1.2.3/Moyu-Reader-1.2.3-x64-setup.exe?redirect=bad"] {
            let mut data = release(); data["assets"][0]["browser_download_url"] = json!(url); assert!(select_installer(&data, "1.2.3", "1.2.2").is_err());
        }
    }
    #[test] fn raw_exe_missing_digest_and_oversize_assets_cannot_be_installed() {
        for (key, value) in [("name", json!("Moyu-Reader-1.2.3.exe")), ("digest", Value::Null), ("digest", json!("sha256:bad")), ("size", json!(MAX_INSTALLER + 1))] {
            let mut data = release(); data["assets"][0][key] = value; assert!(select_installer(&data, "1.2.3", "1.2.2").is_err());
        }
        for value in ["1.02.3", "1.2.3-beta", "../setup", "1.2", "1.2.3.4"] { assert!(stable_version(value).is_err()); }
    }
    fn temp() -> PathBuf { let path = std::env::temp_dir().join(format!("moyu-update-test-{:032x}", rand::random::<u128>())); fs::create_dir(&path).unwrap(); path }
    async fn response(body: &'static [u8]) -> Response {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); let address = listener.local_addr().unwrap();
        std::thread::spawn(move || { let (mut stream, _) = listener.accept().unwrap(); let mut request = [0; 2048]; let _ = stream.read(&mut request); write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap(); stream.write_all(body).unwrap(); });
        Client::new().get(format!("http://{address}")).send().await.unwrap()
    }
    #[tokio::test] async fn streamed_download_rejects_corruption_html_and_wrong_lengths() {
        for (body, size, digest, expected) in [(b"MZ123456" as &'static [u8], 8, format!("{:x}", Sha256::digest(b"MZ123456")), true), (b"MZ123456", 8, "a".repeat(64), false), (b"<html />", 8, format!("{:x}", Sha256::digest(b"<html />")), false), (b"MZ123456", 9, "a".repeat(64), false)] {
            let dir = temp(); let path = dir.join("setup.exe");
            let asset = Installer { version: "1.2.3".into(), url: String::new(), size, digest };
            let mut partial = PartialFile { path: path.clone(), keep: false };
            assert_eq!(receive(response(body).await, &asset, &path, &|_| {}).await.is_ok(), expected);
            partial.keep = false; drop(partial); assert!(!dir.exists());
        }
    }
    #[test] fn installer_directory_is_only_overridden_for_an_installed_copy() {
        let dir = temp(); fs::write(dir.join("uninstall.exe"), b"fixture").unwrap();
        let installed = installer_args(&dir.join("tomato-reader.exe")); assert_eq!(&installed[..3], &["/P", "/R", "/UPDATE"]); assert!(installed.last().unwrap().starts_with("/D="));
        assert_eq!(installer_args(&dir.join("Moyu-Reader.exe")), vec!["/P", "/R"]);
        fs::remove_file(dir.join("uninstall.exe")).unwrap(); fs::remove_dir(dir).unwrap();
    }
    #[tokio::test] async fn cancellation_prevents_an_inflight_request_and_does_not_delete_user_files() {
        let dir = temp(); let user = dir.join("library.txt"); fs::write(&user, b"keep").unwrap();
        let service = UpdateService::new(dir.join("updates")); let signal = Arc::new(Notify::new()); service.state.lock().unwrap().active = Some(signal.clone());
        service.cancel().unwrap(); tokio::time::timeout(Duration::from_millis(200), signal.notified()).await.unwrap();
        assert!(service.download("1.2.3", "1.2.2", &|_| {}).await.is_err()); assert!(service.launch_installer(Path::new("app.exe")).is_err());
        assert_eq!(fs::read(&user).unwrap(), b"keep"); fs::remove_file(user).unwrap(); fs::remove_dir(dir).unwrap();
    }
    #[tokio::test] async fn cancelling_a_stalled_transfer_removes_the_partial_file() {
        let dir = temp(); let path = dir.join("moyu-setup.exe"); let signal = Notify::new();
        let result: Result<(), String> = cancellable(&signal, async {
            let _partial = PartialFile { path: path.clone(), keep: false };
            fs::write(&path, b"partial download").unwrap();
            signal.notify_one();
            std::future::pending().await
        }).await;
        assert_eq!(result.unwrap_err(), "更新下载已取消"); assert!(!dir.exists());
    }
    #[test] fn a_modified_cached_installer_cannot_be_started() {
        let dir = temp(); let path = dir.join("setup.exe"); fs::write(&path, b"MZ123456").unwrap();
        let service = UpdateService::new(dir.clone());
        service.state.lock().unwrap().ready = Some(Ready { path: path.clone(), installer: Installer { version: "1.2.3".into(), url: String::new(), digest: "a".repeat(64), size: 8 } });
        assert!(service.launch_installer(Path::new("tomato-reader.exe")).is_err());
        assert!(!service.state.lock().unwrap().installing);
        fs::remove_file(path).unwrap(); fs::remove_dir(dir).unwrap();
    }
    #[tokio::test]
    #[ignore = "Requires the public GitHub endpoint; downloads only, never installs"]
    async fn published_github_installer_download_and_digest() {
        let dir = temp();
        let client = Client::builder().https_only(true).user_agent("Moyu-Reader-Updater-Test").timeout(Duration::from_secs(30)).build().unwrap();
        let data: Value = client.get(LATEST).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
        let version = data["tag_name"].as_str().unwrap().trim_start_matches('v');
        let service = UpdateService::new(dir.join("updates"));
        let ready = service.download(version, "0.0.0", &|_| {}).await.unwrap();
        println!("Verified published GitHub installer v{}: {} bytes; no execution", version, ready["total"]);
        let cached = service.state.lock().unwrap().ready.take().unwrap();
        assert_eq!(hash_file(&mut File::open(&cached.path).unwrap()).unwrap(), cached.installer.digest);
        discard(cached); fs::remove_dir(dir.join("updates")).unwrap(); fs::remove_dir(dir).unwrap();
    }
    #[test]
    #[cfg(windows)]
    #[ignore = "Requires MOYU_TEST_INSTALLER pointing to a harmless NSIS fixture"]
    fn a_verified_nsis_fixture_launches_with_the_exact_space_and_unicode_directory() {
        let path = PathBuf::from(std::env::var_os("MOYU_TEST_INSTALLER").expect("fixture path"));
        let log = path.parent().unwrap().join("launched.txt"); if log.is_file() { fs::remove_file(&log).unwrap(); }
        let dir = temp().join("fixture install 中文"); fs::create_dir(&dir).unwrap(); fs::write(dir.join("uninstall.exe"), b"fixture").unwrap();
        let service = UpdateService::new(dir.clone());
        let digest = hash_file(&mut File::open(&path).unwrap()).unwrap();
        service.state.lock().unwrap().ready = Some(Ready { installer: Installer { version: "1.2.3".into(), url: String::new(), size: fs::metadata(&path).unwrap().len(), digest }, path: path.clone() });
        service.launch_installer(&dir.join("tomato-reader.exe")).unwrap();
        assert!(service.launch_installer(&dir.join("tomato-reader.exe")).is_err());
        for _ in 0..100 { if log.is_file() { break; } std::thread::sleep(Duration::from_millis(30)); }
        std::thread::sleep(Duration::from_millis(50));
        let bytes = fs::read(&log).unwrap();
        let wide: Vec<u16> = bytes.chunks_exact(2).map(|v| u16::from_le_bytes([v[0], v[1]])).collect();
        let log = String::from_utf16_lossy(&wide);
        assert_eq!(log.lines().last().unwrap(), dir.display().to_string()); assert!(log.contains("/P /R /UPDATE"), "{log}"); // NSIS removes /D from $CMDLINE after parsing it.
        println!("Verified benign NSIS fixture launch, exact /D directory, restart switches, and duplicate-launch rejection");
        fs::remove_file(dir.join("uninstall.exe")).unwrap(); fs::remove_dir(&dir).unwrap(); fs::remove_dir(dir.parent().unwrap()).unwrap();
    }
}
