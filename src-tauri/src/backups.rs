use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{self, Write}, path::{Path, PathBuf}, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};

const MAX_BYTES: u64 = 256 * 1024 * 1024;
const MAGIC: &[u8] = b"MOYU_BACKUP_V1";
pub struct Backups { root: PathBuf, lock: Mutex<()> }
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn valid_id(id: &str) -> bool {
    let Some(text) = id.strip_prefix("moyu-").and_then(|s| s.strip_suffix(".moyubak")) else { return false; };
    let Some((time, nonce)) = text.split_once('-') else { return false; };
    time.parse::<u64>().is_ok() && nonce.len() == 32 && nonce.bytes().all(|b| b.is_ascii_hexdigit())
}
fn validate(value: &Value) -> Result<(), String> {
    if value["schema"] != 1 || !value["version"].is_string() || !value["progress"].is_object() || !value["preferences"].is_object() { return Err("备份格式不兼容".into()); }
    let books = value["books"].as_array().ok_or("备份缺少书架")?;
    if books.len() > 10000 { return Err("备份书架数量异常".into()); }
    for book in books {
        if !book["id"].is_string() || !book["title"].is_string() || !book["chapters"].is_array() || ![Some("local"), Some("official")].contains(&book["source"].as_str()) { return Err("备份书籍资料不完整".into()); }
    }
    Ok(())
}
fn decode(bytes: &[u8]) -> Result<Value, String> {
    let mut parts = bytes.splitn(3, |b| *b == b'\n');
    if parts.next() != Some(MAGIC) { return Err("不是墨屿备份文件".into()); }
    let expected = parts.next().ok_or("备份校验资料缺失")?;
    let body = parts.next().ok_or("备份内容缺失")?;
    if format!("{:x}", Sha256::digest(body)).as_bytes() != expected { return Err("备份校验失败，不能恢复".into()); }
    let value: Value = serde_json::from_slice(body).map_err(|_| "备份内容无法解析")?;
    validate(&value)?; Ok(value)
}
fn info(id: &str, bytes: u64, value: &Value) -> Value {
    let books = value["books"].as_array().unwrap();
    json!({"id":id,"bytes":bytes,"createdAt":value["createdAt"],"kind":value["kind"],"version":value["version"],"books":books.len(),"localBooks":books.iter().filter(|b| b["source"] == "local").count(),"valid":true})
}
fn copy_commit(source: &Path, destination: &Path) -> Result<(), String> {
    let mut created = false;
    let result = (|| {
        let mut input = File::open(source).map_err(|e| e.to_string())?;
        // A rename can report a cross-volume error on redirected Windows data
        // directories. Never overwrite a snapshot while handling that case.
        let mut output = OpenOptions::new().create_new(true).write(true).open(destination).map_err(|e| e.to_string())?;
        created = true;
        io::copy(&mut input, &mut output).and_then(|_| output.sync_all()).map_err(|e| e.to_string())?;
        drop(output);
        decode(&fs::read(destination).map_err(|e| e.to_string())?)?;
        Ok(())
    })();
    if result.is_err() && created { let _ = fs::remove_file(destination); }
    if result.is_ok() { let _ = fs::remove_file(source); }
    result
}
fn commit(source: &Path, destination: &Path) -> Result<(), String> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error().is_some_and(|code| (cfg!(windows) && code == 17) || (cfg!(unix) && code == 18)) => copy_commit(source, destination).map_err(|e| format!("备份提交失败：{e}")),
        Err(error) => Err(format!("备份提交失败：{error}")),
    }
}
impl Backups {
    pub fn new(root: PathBuf) -> Self { Self { root, lock: Mutex::new(()) } }
    fn read(&self, id: &str) -> Result<(Vec<u8>, Value), String> {
        if !valid_id(id) { return Err("备份编号无效".into()); }
        let path = self.root.join(id);
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("无法读取备份：{e}"))?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_BYTES { return Err("备份文件大小或类型异常".into()); }
        let bytes = fs::read(path).map_err(|e| format!("备份读取失败：{e}"))?;
        if bytes.len() as u64 > MAX_BYTES { return Err("备份文件过大".into()); }
        let value = decode(&bytes)?; Ok((bytes, value))
    }
    fn entries(&self) -> Result<Vec<Value>, String> {
        if !self.root.exists() { return Ok(vec![]); }
        let mut result = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|e| format!("备份目录读取失败：{e}"))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let id = entry.file_name().to_string_lossy().to_string();
            if !valid_id(&id) || !entry.file_type().map_err(|e| e.to_string())?.is_file() { continue; }
            result.push(match self.read(&id) {
                Ok((bytes, value)) => info(&id, bytes.len() as u64, &value),
                Err(error) => json!({"id":id,"valid":false,"error":error,"createdAt":0,"bytes":0,"books":0,"localBooks":0}),
            });
        }
        result.sort_by_key(|v| std::cmp::Reverse(v["createdAt"].as_u64().unwrap_or(0)));
        Ok(result)
    }
    pub fn list(&self) -> Result<Value, String> {
        let _guard = self.lock.lock().map_err(|_| "备份服务不可用")?;
        Ok(json!({"path":self.root,"backups":self.entries()?}))
    }
    pub fn load(&self, id: &str) -> Result<String, String> {
        let _guard = self.lock.lock().map_err(|_| "备份服务不可用")?;
        let (_, value) = self.read(id)?;
        serde_json::to_string(&value).map_err(|e| e.to_string())
    }
    pub fn create(&self, payload: &str, kind: &str) -> Result<Value, String> {
        let _guard = self.lock.lock().map_err(|_| "备份服务不可用")?;
        if !["auto", "manual", "before-update", "before-restore"].contains(&kind) { return Err("备份类型无效".into()); }
        if payload.len() as u64 > MAX_BYTES - 128 { return Err("备份超过 256 MB，原有备份已保留".into()); }
        let mut value: Value = serde_json::from_str(payload).map_err(|_| "备份资料无法解析")?;
        validate(&value)?;
        let previous = self.entries()?;
        if kind == "auto" && value["books"].as_array().unwrap().is_empty() && previous.iter().any(|v| v["valid"] == true && v["books"].as_u64().unwrap_or(0) > 0) { return Err("当前书架为空，自动备份已暂停以保留旧备份；如为主动清空，可手动创建备份。".into()); }
        let created = now().max(previous.iter().filter_map(|v| v["createdAt"].as_u64()).max().unwrap_or(0).saturating_add(1));
        value["kind"] = json!(kind); value["createdAt"] = json!(created);
        let body = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        fs::create_dir_all(&self.root).map_err(|e| format!("无法创建备份目录：{e}"))?;
        let id = format!("moyu-{created}-{:032x}.moyubak", rand::random::<u128>());
        let temporary = self.root.join(format!("{id}.pending")); let final_path = self.root.join(&id);
        let result = (|| {
            let mut file = OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|e| format!("无法写入备份：{e}"))?;
            file.write_all(MAGIC).and_then(|_| file.write_all(b"\n")).and_then(|_| file.write_all(format!("{:x}\n", Sha256::digest(&body)).as_bytes())).and_then(|_| file.write_all(&body)).and_then(|_| file.sync_all()).map_err(|e| format!("备份保存失败：{e}"))?;
            drop(file);
            decode(&fs::read(&temporary).map_err(|e| e.to_string())?)?;
            commit(&temporary, &final_path)?;
            Ok(info(&id, fs::metadata(&final_path).map_err(|e| e.to_string())?.len(), &value))
        })();
        if result.is_err() { let _ = fs::remove_file(&temporary); return result; }
        // Rotation happens only after a durable, verified new snapshot exists.
        // Corrupt/unknown files are retained for inspection, never pruned.
        if let Ok(entries) = self.entries() {
            let mut automatic = 0; let mut protected = 0;
            for item in entries {
                if item["valid"] != true { continue; }
                let count = if item["kind"] == "auto" { automatic += 1; automatic } else { protected += 1; protected };
                let limit = if item["kind"] == "auto" { 10 } else { 8 };
                if count > limit { if let Some(id) = item["id"].as_str() { let _ = fs::remove_file(self.root.join(id)); } }
            }
        }
        result
    }
}

#[cfg(test)] mod tests {
    use super::*;
    fn temp() -> PathBuf { let path = std::env::temp_dir().join(format!("moyu-backup-test-{:032x}", rand::random::<u128>())); fs::create_dir(&path).unwrap(); path }
    fn sample() -> String { json!({"schema":1,"version":"0.5.21","books":[{"id":"test","title":"测试小说","source":"local","chapters":[{"id":"c","content":"完整正文"}]}],"progress":{"test":{"chapterIndex":0}},"preferences":{"theme":"night"}}).to_string() }
    #[test] fn disk_roundtrip_checksum_and_path_validation() {
        let dir = temp(); let backups = Backups::new(dir.clone());
        let item = backups.create(&sample(), "manual").unwrap(); let id = item["id"].as_str().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&backups.load(id).unwrap()).unwrap()["books"][0]["chapters"][0]["content"], "完整正文");
        assert!(backups.load("../secret").is_err());
        let path = dir.join(id); let mut bytes = fs::read(&path).unwrap(); *bytes.last_mut().unwrap() ^= 1; fs::write(&path, bytes).unwrap();
        assert!(backups.load(id).is_err()); assert_eq!(backups.list().unwrap()["backups"][0]["valid"], false);
        fs::remove_file(path).unwrap(); fs::remove_dir(dir).unwrap();
    }
    #[test] fn rotation_preserves_manual_corrupt_and_unrelated_files() {
        let dir = temp(); let backups = Backups::new(dir.clone());
        let manual = backups.create(&sample(), "manual").unwrap();
        let mut empty: Value = serde_json::from_str(&sample()).unwrap(); empty["books"] = json!([]);
        assert!(backups.create(&empty.to_string(), "auto").is_err());
        let corrupt = format!("moyu-1-{}.moyubak", "0".repeat(32)); fs::write(dir.join(&corrupt), b"damaged").unwrap();
        fs::write(dir.join("unrelated.txt"), b"keep").unwrap();
        for _ in 0..12 { backups.create(&sample(), "auto").unwrap(); }
        let items = backups.list().unwrap(); assert_eq!(items["backups"].as_array().unwrap().len(), 12);
        assert!(dir.join(manual["id"].as_str().unwrap()).is_file()); assert!(dir.join(&corrupt).is_file());
        assert!(backups.create("{}", "auto").is_err()); assert!(backups.create(&sample(), "../wrong").is_err());
        assert_eq!(fs::read(dir.join("unrelated.txt")).unwrap(), b"keep");
        for entry in fs::read_dir(&dir).unwrap() { fs::remove_file(entry.unwrap().path()).unwrap(); } fs::remove_dir(dir).unwrap();
    }
    #[test] fn redirected_directory_copy_commit_never_overwrites_and_rechecks_bytes() {
        let dir = temp(); let backups = Backups::new(dir.clone());
        let original = backups.create(&sample(), "manual").unwrap(); let original = dir.join(original["id"].as_str().unwrap());
        let bytes = fs::read(&original).unwrap(); let pending = dir.join("test.pending"); fs::write(&pending, &bytes).unwrap();
        assert!(copy_commit(&pending, &original).is_err()); assert_eq!(fs::read(&original).unwrap(), bytes);
        let copied = dir.join("copied.moyubak"); copy_commit(&pending, &copied).unwrap(); assert!(!pending.exists()); assert_eq!(fs::read(&copied).unwrap(), bytes);
        fs::write(&pending, b"damaged").unwrap(); let rejected = dir.join("rejected.moyubak"); assert!(copy_commit(&pending, &rejected).is_err()); assert!(!rejected.exists());
        for entry in fs::read_dir(&dir).unwrap() { fs::remove_file(entry.unwrap().path()).unwrap(); } fs::remove_dir(dir).unwrap();
    }
}
