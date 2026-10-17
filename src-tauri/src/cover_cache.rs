//! Bounded public-cover cache. No cookies, novel text, or arbitrary local paths.
use crate::transport::Transport;
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{redirect::Policy, Client, Url};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Arc, Weak, atomic::{AtomicUsize, Ordering}}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::sync::{Mutex, Semaphore};
const MAX_BYTES: usize = 1024 * 1024;
const MAX_AGE: u64 = 7 * 24 * 60 * 60;
const MAX_DISK: u64 = 80 * 1024 * 1024;
fn book_key(book: &str) -> Result<String,String> {
    if !(5..=24).contains(&book.len()) || !book.bytes().all(|b|b.is_ascii_digit()) {return Err("封面书籍ID无效".into());}
    Ok(format!("{:x}",Sha256::digest(format!("book:{book}").as_bytes())))
}
fn allowed(url: &Url) -> bool {
    url.scheme() == "https" && url.username().is_empty() && url.password().is_none() && url.port().is_none()
        && url.host_str().is_some_and(|host| ["byteimg.com","toutiaoimg.com","fqnovelstatic.com","fqnovelpic.com","bytescm.com","bytecdn.cn"].iter().any(|d|host == *d || host.ends_with(&format!(".{d}"))))
}
fn key(url: &Url, book: Option<&str>) -> Result<String, String> {
    let resource = if let Some(book) = book {
        book_key(book)?;
        // A book ID plus resource path identifies a cover despite refreshed signed
        // query parameters. A changed image path invalidates the old cover.
        let mut stable = url.clone(); stable.set_fragment(None);
        let query: Vec<(String,String)> = url.query_pairs().filter(|(name,_)| !matches!(name.to_ascii_lowercase().as_str(), "x-signature" | "x-expires")).map(|(key,value)|(key.into_owned(),value.into_owned())).collect();
        stable.set_query(None);
        if !query.is_empty() {stable.query_pairs_mut().extend_pairs(query);}
        format!("{book}:{stable}")
    } else { url.as_str().to_string() };
    Ok(format!("{:x}",Sha256::digest(resource.as_bytes())))
}
fn mime(bytes: &[u8]) -> Option<(&'static str, u8)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {Some(("image/png",1))}
    else if bytes.starts_with(b"\xff\xd8\xff") {Some(("image/jpeg",2))}
    else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {Some(("image/webp",3))}
    else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {Some(("image/gif",4))}
    else {None}
}
fn now() -> u64 {SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()}
fn image(bytes: &[u8], cached: bool) -> Result<Value,String> {
    let (mime, _) = mime(bytes).ok_or("封面格式不支持")?;
    Ok(json!({"dataUrl":format!("data:{mime};base64,{}",STANDARD.encode(bytes)),"cached":cached,"bytes":bytes.len()}))
}
fn read(path: &Path) -> Option<Vec<u8>> {
    let metadata = std::fs::metadata(path).ok()?;
    if metadata.len() > (MAX_BYTES + 13) as u64 {return None;}
    let data = std::fs::read(path).ok()?;
    if data.len() < 13 || &data[..4] != b"TMC1" {return None;}
    let saved = u64::from_le_bytes(data[4..12].try_into().ok()?);
    if now().checked_sub(saved)? > MAX_AGE {return None;}
    let bytes = &data[13..];
    if mime(bytes)?.1 != data[12] {return None;}
    Some(bytes.to_vec())
}
fn store(root: &Path, path: &Path, bytes: &[u8]) {
    let Some((_,kind)) = mime(bytes) else {return};
    if bytes.len() > MAX_BYTES || std::fs::create_dir_all(root).is_err() {return;}
    let mut data = b"TMC1".to_vec(); data.extend_from_slice(&now().to_le_bytes()); data.push(kind); data.extend_from_slice(bytes);
    let temporary = path.with_extension("tmp");
    if std::fs::write(&temporary,data).is_ok() {let _ = std::fs::rename(&temporary,path);}
    let _ = std::fs::remove_file(temporary);
}
fn prune(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {return};
    let mut files:Vec<_> = entries.filter_map(Result::ok).filter_map(|entry| {
        let path = entry.path();
        let stem = path.file_stem()?.to_str()?;
        if path.extension()?.to_str()? != "cover" || stem.len()!=64 || !stem.bytes().all(|b|b.is_ascii_hexdigit()) {return None;}
        let meta = entry.metadata().ok()?;
        if !meta.is_file() {return None;}
        Some((meta.modified().unwrap_or(UNIX_EPOCH),meta.len(),path))
    }).collect();
    files.sort_by_key(|(time,_,_)|*time);
    let mut total:u64 = files.iter().map(|(_,size,_)|size).sum();
    let mut count = files.len();
    for (time,size,path) in files {
        let expired = SystemTime::now().duration_since(time).unwrap_or_default().as_secs()>MAX_AGE;
        if expired || total > MAX_DISK || count > 512 {
            if std::fs::remove_file(path).is_ok() {total = total.saturating_sub(size);count-=1;}
        }
    }
}
pub(crate) struct CoverCache {
    root: PathBuf,
    client: Client,
    transport: Arc<Transport>,
    slots: Semaphore,
    requests: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    writes: AtomicUsize,
}
impl CoverCache {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {root, client:Client::builder().https_only(true).timeout(Duration::from_secs(10))
            .user_agent("Mozilla/5.0 TomatoReader/cover")
            .redirect(Policy::custom(|attempt|if attempt.previous().len()<4 && allowed(attempt.url()) {attempt.follow()} else {attempt.stop()})).build().expect("cover client"),
            transport:Arc::new(Transport::default()),slots:Semaphore::new(4),requests:Mutex::new(HashMap::new()),writes:AtomicUsize::new(0)}
    }
    pub(crate) fn lookup(&self, raw: &str, book: Option<&str>) -> Result<Option<Value>,String> {
        if raw.len()>8192 {return Err("封面地址过长".into());}
        let url=Url::parse(raw).map_err(|_|"封面地址无效")?;
        if !allowed(&url) {return Err("封面地址不在官方图片域名内".into());}
        let key=key(&url,book)?;
        read(&self.root.join(format!("{key}.cover"))).map(|bytes|image(&bytes,true)).transpose()
    }
    pub(crate) fn lookup_book(&self, book: &str) -> Result<Option<Value>,String> {
        let key=book_key(book)?;
        read(&self.root.join(format!("{key}.cover"))).map(|bytes|image(&bytes,true)).transpose()
    }
    pub(crate) fn alias_book(&self, book: &str, value: &Value) {
        if let Ok(key)=book_key(book) {self.store_value(&key,value);}
    }
    fn store_value(&self, key: &str, value: &Value) {
        let Some(encoded)=value["dataUrl"].as_str().and_then(|s|s.split_once(',').map(|(_,data)|data)) else {return};
        let Ok(bytes)=STANDARD.decode(encoded) else {return};
        store(&self.root,&self.root.join(format!("{key}.cover")),&bytes);
        if self.writes.fetch_add(1,Ordering::Relaxed)%16==0 {prune(&self.root);}
    }
    pub(crate) fn alias(&self, raw: &str, book: &str, value: &Value) {
        let Ok(url)=Url::parse(raw) else {return};
        if !allowed(&url) {return;}
        let Ok(key)=key(&url,Some(book)) else {return};
        self.store_value(&key,value);
    }
    pub(crate) async fn get(&self, raw: &str, book: Option<&str>) -> Result<Value,String> {
        if raw.len()>8192 {return Err("封面地址过长".into());}
        let url = Url::parse(raw).map_err(|_|"封面地址无效")?;
        if !allowed(&url) {return Err("封面地址不在官方图片域名内".into());}
        let key = key(&url,book)?;
        let path = self.root.join(format!("{key}.cover"));
        if let Some(bytes) = read(&path) {return image(&bytes,true);}
        let lock = {
            let mut requests = self.requests.lock().await;
            requests.retain(|_,value|value.strong_count()>0);
            match requests.get(&key).and_then(Weak::upgrade) {
                Some(lock)=>lock,
                None=>{let lock=Arc::new(Mutex::new(()));requests.insert(key,Arc::downgrade(&lock));lock}
            }
        };
        let _guard = lock.lock().await;
        if let Some(bytes) = read(&path) {return image(&bytes,true);}
        let _slot = self.slots.acquire().await.map_err(|_|"封面队列已关闭")?;
        let mut response = self.transport.send_asset(self.client.get(url).header("Accept","image/webp,image/png,image/jpeg,image/gif")).await?;
        if response.headers().contains_key("bdturing-verify") {return Err("图片服务要求验证，请在官网处理".into());}
        if !response.status().is_success() {return Err(format!("封面返回HTTP {}",response.status().as_u16()));}
        if response.content_length().is_some_and(|n|n>MAX_BYTES as u64) {return Err("封面大小超限".into());}
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_|"封面读取失败")? {
            if bytes.len()+chunk.len()>MAX_BYTES {return Err("封面大小超限".into());}
            bytes.extend_from_slice(&chunk);
        }
        let result = image(&bytes,false)?;
        store(&self.root,&path,&bytes);
        if let Some(book)=book {self.alias_book(book,&result);}
        if self.writes.fetch_add(1,Ordering::Relaxed)%16==0 {prune(&self.root);}
        Ok(result)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn covers_without_hardcoded_urls_survive_restart_and_stay_separate_from_url_keys() {
        let root=std::env::temp_dir().join(format!("tomato-cover-book-{}",crate::app_crypto::hex(&crate::app_crypto::random(8))));
        let cache=CoverCache::new(root.clone());
        assert!(cache.lookup_book("123456").unwrap().is_none());
        cache.alias_book("123456",&image(b"\x89PNG\r\n\x1a\nfixture",false).unwrap());
        let restarted=CoverCache::new(root.clone());
        assert_eq!(restarted.lookup_book("123456").unwrap().unwrap()["cached"],true);
        assert!(restarted.lookup_book("654321").unwrap().is_none());
        assert!(restarted.lookup_book("../unsafe").is_err());
        assert!(restarted.lookup("https://p3.fqnovelpic.com/new.webp",Some("123456")).unwrap().is_none());
        std::fs::remove_file(root.join(format!("{}.cover",book_key("123456").unwrap()))).unwrap();std::fs::remove_dir(root).unwrap();
    }
    #[test] fn trusted_images_only_and_signatures_do_not_change_resource_identity() {
        for raw in ["http://p3.fqnovelpic.com/a","https://fqnovelpic.com.evil.test/a","https://u:p@p3.fqnovelpic.com/a","https://p3.fqnovelpic.com:8443/a","https://127.0.0.1/a","https://fanqienovel.com/a"] {assert!(!allowed(&Url::parse(raw).unwrap()));}
        let a=Url::parse("https://p3.fqnovelpic.com/cover.webp?x-signature=one").unwrap();
        let b=Url::parse("https://p3.fqnovelpic.com/cover.webp?x-signature=two").unwrap();
        assert!(allowed(&a));assert_eq!(key(&a,Some("123456")).unwrap(),key(&b,Some("123456")).unwrap());
        assert_ne!(key(&a,None).unwrap(),key(&b,None).unwrap());
        let different=Url::parse("https://p3.fqnovelpic.com/cover.webp?width=300").unwrap();
        assert_ne!(key(&a,Some("123456")).unwrap(),key(&different,Some("123456")).unwrap());
        assert!(key(&a,Some("../unsafe")).is_err());
    }
    #[tokio::test] async fn a_warm_disk_cover_never_needs_the_network() {
        let root=std::env::temp_dir().join(format!("tomato-cover-warm-{}",crate::app_crypto::hex(&crate::app_crypto::random(8))));
        let url=Url::parse("https://p3.fqnovelpic.com/cover.webp?x-signature=expired").unwrap();
        let path=root.join(format!("{}.cover",key(&url,Some("123456")).unwrap()));
        store(&root,&path,b"\x89PNG\r\n\x1a\nfixture");
        let cache=CoverCache::new(root.clone());
        assert_eq!(cache.get(url.as_str(),Some("123456")).await.unwrap()["cached"],true);
        assert!(cache.get("https://127.0.0.1/private",None).await.is_err());
        std::fs::remove_file(path).unwrap();std::fs::remove_dir(root).unwrap();
    }
    #[tokio::test] async fn refreshed_cover_is_cached_under_the_original_resource_too() {
        let root=std::env::temp_dir().join(format!("tomato-cover-alias-{}",crate::app_crypto::hex(&crate::app_crypto::random(8))));
        let cache=CoverCache::new(root.clone());let old="https://p6-tt.bytecdn.cn/old-cover.image";
        cache.alias(old,"123456",&image(b"\x89PNG\r\n\x1a\nfixture",false).unwrap());
        assert!(cache.lookup(old,Some("123456")).unwrap().is_some());
        assert_eq!(cache.get(old,Some("123456")).await.unwrap()["cached"],true);
        let path=root.join(format!("{}.cover",key(&Url::parse(old).unwrap(),Some("123456")).unwrap()));
        std::fs::remove_file(path).unwrap();std::fs::remove_dir(root).unwrap();
    }
    #[test] fn eviction_is_bounded_and_only_touches_cover_cache_entries() {
        let root=std::env::temp_dir().join(format!("tomato-cover-limit-{}",crate::app_crypto::hex(&crate::app_crypto::random(8))));
        std::fs::create_dir_all(&root).unwrap();
        let keep=root.join("unrelated.txt");std::fs::write(&keep,b"keep").unwrap();
        for i in 0..515 {std::fs::write(root.join(format!("{i:064x}.cover")),b"cache").unwrap();}
        prune(&root);
        let files:Vec<_>=std::fs::read_dir(&root).unwrap().map(|e|e.unwrap().path()).collect();
        assert_eq!(files.len(),513);assert!(keep.exists());
        for file in files {std::fs::remove_file(file).unwrap();}std::fs::remove_dir(root).unwrap();
    }
    #[test] fn disk_roundtrip_rejects_corruption_and_non_images() {
        let root=std::env::temp_dir().join(format!("tomato-cover-test-{}",crate::app_crypto::hex(&crate::app_crypto::random(8))));
        let path=root.join("fixture.cover");
        let bytes=b"\x89PNG\r\n\x1a\nfixture";
        store(&root,&path,bytes);assert_eq!(read(&path).unwrap(),bytes);assert_eq!(image(bytes,true).unwrap()["cached"],true);
        assert!(image(b"<svg></svg>",false).is_err());
        std::fs::write(&path,b"corrupt").unwrap();assert!(read(&path).is_none());
        std::fs::remove_file(path).unwrap();std::fs::remove_dir(root).unwrap();
    }
}
