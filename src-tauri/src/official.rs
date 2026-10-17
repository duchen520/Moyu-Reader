//! Experimental first-party integration. No third-party content proxy or credential export.
use crate::transport::Transport;
#[cfg(target_os = "windows")]
use reqwest::cookie::CookieStore;
use reqwest::{cookie::Jar, redirect::Policy, Client, Method, Url};
use serde_json::{json, Value};
use std::{
    sync::Arc,
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

const HOST: &str = "https://fanqienovel.com";
const COMMENT_HOST: &str = "https://novel.snssdk.com";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

struct Ticket {
    token: String,
    started: Instant,
    lifetime: u64,
}
struct Session {
    transport: Arc<Transport>,
    client: Client,
    #[allow(dead_code)]
    jar: Arc<Jar>,
    ticket: Option<Ticket>,
}
pub struct OfficialService {
    app: crate::app_content::AppContent,
    session: Mutex<Session>,
    book_metadata: Mutex<HashMap<String, (Instant, Value)>>,
    transport: Arc<Transport>,
}

fn allowed_redirect(url: &Url) -> bool {
    url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some("fanqienovel.com" | "www.fanqienovel.com" | "sso.douyin.com")
        )
}
fn new_session(restore: bool, transport: Arc<Transport>) -> Session {
    let jar = Arc::new(Jar::default());
    if restore {
        if let Some(header) = load_credential() {
            let url = Url::parse(HOST).expect("constant URL");
            for pair in header.split(';').map(str::trim).filter(|s| !s.is_empty()) {
                jar.add_cookie_str(&format!("{pair}; Path=/; Secure; HttpOnly"), &url);
            }
        }
    }
    let client = Client::builder()
        .cookie_provider(jar.clone())
        .user_agent(UA)
        .timeout(Duration::from_secs(15))
        .https_only(true)
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= 6 || !allowed_redirect(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .expect("HTTP client configuration");
    Session {
        transport,
        client,
        jar,
        ticket: None,
    }
}

#[cfg(target_os = "windows")]
fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("dev.tomatoreader.desktop", "fanqie-session")
        .map_err(|_| "无法访问 Windows 凭据管理器".into())
}
#[cfg(target_os = "windows")]
fn load_credential() -> Option<String> {
    credential_entry().ok()?.get_password().ok()
}
#[cfg(not(target_os = "windows"))]
fn load_credential() -> Option<String> {
    None
}

fn persist(session: &Session) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let url = Url::parse(HOST).expect("constant URL");
        let header = session.jar.cookies(&url).ok_or("没有可保存的官方会话")?;
        credential_entry()?
            .set_password(header.to_str().map_err(|_| "会话格式错误")?)
            .map_err(|_| {
                "登录已验证，但 Windows 会话保存失败；本次可用，重启需重新登录".to_string()
            })?;
    }
    #[cfg(not(target_os = "windows"))]
    let _ = session;
    Ok(())
}
fn clear_credential() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err("本次会话已关闭，但 Windows 中的登录记录删除失败，请重试退出".into()),
    }
    Ok(())
}

fn sid(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
fn number(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}
fn business(j: &Value) -> Result<(), String> {
    let code = j.get("code").and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
    });
    match code {
        Some(0) => Ok(()),
        Some(n) => Err(format!("官方接口未成功（代码 {n}），请检查登录或稍后重试")),
        None => Err("官方接口缺少有效状态码，当前响应未确认成功".into()),
    }
}
async fn request(
    session: &Session,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let url = format!("{HOST}{path}");
    let mut r = session
        .client
        .request(method, url)
        .header("Referer", format!("{HOST}/"))
        .header("Origin", HOST)
        .header("Accept", "application/json")
        .header("ismobile", "0");
    if let Some(b) = body {
        r = r.json(&b);
    }
    parse_response(session.transport.send(r).await?).await
}
async fn parse_response(r: reqwest::Response) -> Result<Value, String> {
    let status = r.status();
    if !status.is_success() {
        return Err(format!("官方服务返回 HTTP {}", status.as_u16()));
    }
    if r.headers().contains_key("bdturing-verify") {
        return Err("官方要求人机验证，请打开官网完成验证后重试".into());
    }
    let bytes = r.bytes().await.map_err(|_| "官方响应读取失败")?;
    if bytes.is_empty() {
        return Err("官方返回空响应，尚未取得可用数据；本次没有自动重试".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "官方返回非 JSON 数据，当前接口可能已经变化".into())
}
async fn user(session: &Session) -> Result<Value, String> {
    let j = request(session, Method::GET, "/api/user/info/v2", None).await?;
    // A successful HTTP response is never enough to mark an account authenticated.
    if business(&j).is_err() || number(&j["data"]["id"]) <= 1 {
        return Ok(Value::Null);
    }
    Ok(json!({"id":sid(&j["data"]["id"]), "name":j["data"]["name"].as_str().unwrap_or("番茄读者")}))
}
fn passport_query(token: Option<&str>) -> String {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    q.extend_pairs([
        ("next", "https://fanqienovel.com/"),
        ("aid", "2503"),
        ("app_name", "novelapp"),
        ("version_code", "57700"),
        ("device_platform", "web"),
        ("channel", "novel"),
        ("sdk_version", "1.6.1"),
        ("passport_sdk_version", "2.0.0"),
        ("new_user", "0"),
    ]);
    if let Some(t) = token {
        q.append_pair("token", t);
    }
    q.finish()
}
fn check_id(id: &str) -> Result<(), String> {
    if id.len() < 5 || id.len() > 24 || !id.bytes().all(|c| c.is_ascii_digit()) {
        return Err("书籍或章节 ID 格式不正确".into());
    }
    Ok(())
}

#[cfg(test)]
fn https_url(raw: &str) -> Option<String> {
    let expanded = if raw.starts_with("//") {
        format!("https:{raw}")
    } else {
        raw.to_string()
    };
    let u = Url::parse(&expanded).ok()?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return None;
    }
    Some(u.to_string())
}
#[cfg(test)]
fn comment_image(raw: &str) -> Option<String> {
    let value = https_url(raw)?;
    let url = Url::parse(&value).ok()?;
    let host = url.host_str()?;
    if [
        "byteimg.com",
        "toutiaoimg.com",
        "fqnovelstatic.com",
        "bytescm.com",
    ]
    .iter()
    .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    {
        Some(value)
    } else {
        None
    }
}
// The official web service rounds some numeric 64-bit IDs through JavaScript Number.
// Only accept that representation for one parent scoped by the exact requested comment URL.
#[cfg(test)]
fn matches_rounded_web_id(returned: &Value, requested: &str) -> bool {
    let Some(expected) = requested.parse::<u64>().ok() else {
        return false;
    };
    expected > 0 && returned.is_number() && returned.as_f64() == Some(expected as f64)
}
#[cfg(test)]
fn normalize_web_comment(c: &Value, depth: usize) -> Value {
    let info = &c["info"];
    let mut images = Vec::<String>::new();
    if let Some(array) = info["image_urls"].as_array() {
        for u in array
            .iter()
            .filter_map(Value::as_str)
            .filter_map(comment_image)
            .take(12)
        {
            if !images.contains(&u) {
                images.push(u);
            }
        }
    }
    if let Some(array) = info["image_data"].as_array() {
        for img in array.iter().take(12) {
            if let Some(u) = img["web_uri"]
                .as_str()
                .or_else(|| img["expand_web_url"].as_str())
                .and_then(comment_image)
            {
                if !images.contains(&u) {
                    images.push(u);
                }
            }
        }
    }
    let children = if depth < 3 {
        c["replies"]
            .as_array()
            .map(|a| {
                a.iter()
                    .take(100)
                    .map(|v| normalize_web_comment(v, depth + 1))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    json!({"id":sid(&info["comment_id"]), "userId":sid(&info["user_id"]),"name":c["user"]["nick_name"].as_str().unwrap_or("书友"),
        "text":info["text"].as_str().unwrap_or(""),"likes":number(&info["digg_count"]),"replies":number(&info["reply_count"]),
        "createdAt":number(&info["create_time"]),"images":images,"children":children,
        "replyTo":c["reply_to_user_info"]["nick_name"].as_str().unwrap_or("")})
}
fn directory_rows(data: &Value) -> Result<Vec<Value>, String> {
    let volumes = data["chapterListWithVolume"]
        .as_array()
        .ok_or("官方目录格式已变化")?;
    let mut chapters = Vec::new();
    for volume in volumes {
        let items: Vec<&Value> = if let Some(list) = volume.as_array() {
            list.iter().collect()
        } else if volume.get("itemId").is_some() || volume.get("item_id").is_some() {
            vec![volume]
        } else {
            volume["chapterList"]
                .as_array()
                .map(|a| a.iter().collect())
                .unwrap_or_default()
        };
        for c in items {
            let id = sid(c.get("itemId").unwrap_or(&c["item_id"]));
            if check_id(&id).is_ok() {
                chapters.push(json!({"id":id,"title":c["title"].as_str().unwrap_or("未返回标题")}));
            }
        }
    }
    Ok(chapters)
}
#[cfg(test)]
fn normalize_play_info(j: &Value, item_id: &str) -> Result<Value, String> {
    business(j)?;
    let items = j["data"].as_array().ok_or("官方未返回可播放音频")?;
    let d = items
        .iter()
        .find(|d| sid(&d["item_id"]) == item_id)
        .ok_or("音频响应与所选集数不匹配")?;
    let encrypted = match d.get("is_encrypt") {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) if value.as_i64() == Some(0) => false,
        Some(Value::Number(value)) if value.as_i64() == Some(1) => true,
        Some(Value::String(value)) if value == "0" => false,
        Some(Value::String(value)) if value == "1" => true,
        _ => return Err("官方音频保护状态不明确，本次未尝试直接播放".into()),
    };
    if encrypted {
        return Err(
            "该音频需要官方受保护播放器，当前桌面播放器不能直接播放，请使用番茄官方App".into(),
        );
    }
    let urls = ["main_url", "backup_url"]
        .iter()
        .filter_map(|key| d[key].as_str().and_then(https_url))
        .collect::<Vec<_>>();
    if urls.is_empty() {
        return Err("官方未提供可直接播放的HTTPS音频地址".into());
    }
    Ok(json!({"itemId":item_id,"urls":urls}))
}
fn cover_url(info: &Value) -> String {
    ["thumb_url", "thumbUrl", "thumbUri", "cover_url", "coverUrl"]
        .iter()
        .filter_map(|k| info[*k].as_str())
        .find(|s| s.starts_with("https://") || s.starts_with("//"))
        .unwrap_or("")
        .to_string()
}
fn progress_rows(data: &Value) -> Result<Vec<Value>, String> {
    let rows = data.as_array().ok_or("官方进度格式已变化，自动同步暂停")?;
    let mut valid: Vec<Value> = Vec::new();
    let mut ambiguous = std::collections::HashSet::new();
    for row in rows {
        let book = sid(&row["book_id"]);
        let item = sid(&row["item_id"]);
        if check_id(&book).is_ok() && (item.is_empty() || item == "0") {
            continue;
        }
        if check_id(&book).is_err() || check_id(&item).is_err() {
            return Err("官方返回不完整的章节进度，自动同步暂停".into());
        }
        let raw_timestamp = number(&row["read_timestamp"]);
        let timestamp = if raw_timestamp >= 1_000_000_000_000 { raw_timestamp / 1000 } else { raw_timestamp };
        let candidate = json!({"book_id":book,"item_id":item,"read_timestamp":timestamp});
        if let Some(previous) = valid.iter_mut().find(|value| sid(&value["book_id"]) == book) {
            let previous_timestamp = number(&previous["read_timestamp"]);
            if timestamp == previous_timestamp && sid(&previous["item_id"]) != item {
                ambiguous.insert(book.clone());
            }
            if timestamp > previous_timestamp { ambiguous.remove(&book); *previous = candidate; }
        } else { valid.push(candidate); }
    }
    if !ambiguous.is_empty() {
        return Err("官网返回同一时间的不同章节记录，无法确认最新进度，自动同步暂停".into());
    }
    Ok(valid)
}
fn read_item_ids(data: &Value) -> Result<Vec<String>, String> {
    let rows = data.as_array().ok_or("官网已读记录格式已变化")?;
    let mut seen = std::collections::HashSet::new();
    let mut ids = Vec::new();
    for row in rows {
        let item = sid(row.get("item_id").unwrap_or(row));
        check_id(&item).map_err(|_| "官网已读记录包含无效章节，未猜测恢复位置")?;
        if seen.insert(item.clone()) { ids.push(item); }
    }
    Ok(ids)
}
impl Default for OfficialService {
    fn default() -> Self {
        let transport = Arc::new(Transport::default());
        Self {
            app: crate::app_content::AppContent::new(transport.clone()),
            session: Mutex::new(new_session(true, transport.clone())),
            book_metadata: Mutex::new(HashMap::new()),
            transport,
        }
    }
}
impl OfficialService {
    async fn remember_books(&self, books: &[Value]) {
        let mut cache = self.book_metadata.lock().await;
        cache.retain(|_, (time, _)|time.elapsed() < Duration::from_secs(300));
        for book in books {
            let id = ["id", "book_id", "bookId"].iter().map(|key|sid(&book[*key])).find(|id|check_id(id).is_ok());
            let Some(id) = id else {continue};
            // Recent website/shelf details should not be replaced by older
            // search CDN links. A forced cover refresh explicitly replaces it.
            if cache.contains_key(&id) {continue;}
            let first = |keys: &[&str]| keys.iter().find_map(|key|book[*key].as_str().filter(|s|!s.is_empty())).unwrap_or("").to_string();
            let title = first(&["title", "book_name", "bookName"]);
            if title.is_empty() || title == "未返回书名" || book["metadataMissing"] == true {continue;}
            let author = first(&["author", "author_name", "authorName"]);
            if author.is_empty() {continue;}
            let value = json!({"title":title,"author":author,"description":first(&["description", "abstract"]),"coverUrl":cover_url(book)});
            cache.insert(id, (Instant::now(), value));
        }
        while cache.len() > 512 {
            let Some(oldest) = cache.iter().min_by_key(|(_, (time, _))|time).map(|(id,_)|id.clone()) else {break;};
            cache.remove(&oldest);
        }
    }

    // Clone the HTTP handles under a short lock. A whole shelf refresh must not
    // hold the account mutex while other pages wait to open books or rankings.
    // The cookie jar belongs to this snapshot; logout creates a different jar.
    async fn read_session(&self) -> Session {
        let session = self.session.lock().await;
        Session {
            transport: session.transport.clone(),
            client: session.client.clone(),
            jar: session.jar.clone(),
            ticket: None,
        }
    }
    pub async fn ranking_categories(&self) -> Result<Value, String> {
        let client = self.read_session().await.client;
        crate::rankings::categories(&client, &self.transport).await
    }
    pub async fn rankings(&self, gender: u8, mold: u8, category: &str, offset: u32, version: &str) -> Result<Value, String> {
        let client = self.read_session().await.client;
        let page = crate::rankings::page(&client, &self.transport, gender, mold, category, offset, version).await?;
        if let Some(books) = page["books"].as_array() { self.remember_books(books).await; }
        Ok(page)
    }
    /// Read-only local diagnosis. Never exports session cookies or account identity.
    #[cfg(debug_assertions)]
    pub async fn diagnose_progress(&self) -> Result<Value, String> {
        let s = self.read_session().await;
        if user(&s).await?.is_null() {
            return Err("本机没有可恢复的登录会话，未读取账号进度".into());
        }
        let shelf = request(&s, Method::GET, "/reading/bookapi/bookshelf/info/v:version/?aid=1967&app_name=novelapp&version_code=57700&update_version_code=57700&device_platform=web&iid=0", None).await?;
        business(&shelf)?;
        let progress = request(&s, Method::GET, "/api/reader/book/progress", None).await?;
        business(&progress)?;
        fn summarize(rows: &Value) -> Value {
            Value::Array(rows.as_array().into_iter().flatten().map(|row| {
                let keys: Vec<_> = row.as_object().into_iter().flat_map(|m| m.keys()).collect();
                let fields: serde_json::Map<String, Value> = row.as_object().into_iter().flat_map(|m| m.iter()).filter(|(key, value)| {
                    (key.as_str() == "book_id" || key.as_str() == "item_id" || ["chapter", "progress", "read", "time", "index"].iter().any(|part| key.contains(part)))
                        && !key.contains("user") && !key.contains("token") && !key.contains("cookie")
                        && (value.is_number() || value.is_boolean() || value.is_null() || value.as_str().is_some_and(|s| s.len() <= 256))
                }).map(|(k,v)| (k.clone(), v.clone())).collect();
                json!({"keys":keys,"fields":fields})
            }).collect())
        }
        Ok(json!({"shelf":summarize(&shelf["data"]["book_shelf_info"]),"webProgress":summarize(&progress["data"])}))
    }
    #[cfg(debug_assertions)]
    pub async fn diagnose_read_items(&self, book_id: &str) -> Result<Value, String> {
        self.read_history(book_id).await
    }
    pub async fn read_history(&self, book_id: &str) -> Result<Value, String> {
        check_id(book_id)?;
        let s = self.read_session().await;
        if user(&s).await?.is_null() { return Err("登录会话不可用，未读取历史".into()); }
        let data = request(&s, Method::GET, &format!("/api/reader/book/read_item_list?book_id={book_id}"), None).await?;
        business(&data)?;
        Ok(json!(read_item_ids(&data["data"])?))
    }
    pub async fn account(&self) -> Result<Value, String> {
        user(&self.read_session().await).await
    }
    pub async fn start_login(&self) -> Result<Value, String> {
        let mut s = self.session.lock().await;
        if !user(&s).await?.is_null() {
            return Err("当前已登录，请先退出再切换账号".into());
        }
        *s = new_session(false, self.transport.clone());
        let j = request(
            &s,
            Method::GET,
            &format!("/passport/web/get_qrcode/?{}", passport_query(None)),
            None,
        )
        .await?;
        let d = &j["data"];
        if number(&d["error_code"]) != 0 {
            return Err(format!(
                "官方未生成二维码（代码 {}）",
                number(&d["error_code"])
            ));
        }
        let token = d["token"]
            .as_str()
            .filter(|t| !t.is_empty())
            .ok_or("官方未返回二维码会话")?;
        let image = d["qrcode"]
            .as_str()
            .filter(|t| !t.is_empty())
            .ok_or("官方未返回二维码图片")?;
        // Official expire_time can be either a TTL or a unix timestamp; cap pending sessions.
        let expiry = number(&d["expire_time"]);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let seconds = if expiry > now { expiry - now } else { expiry };
        let lifetime = if seconds > 0 {
            seconds.min(180) as u64
        } else {
            180
        };
        s.ticket = Some(Ticket {
            token: token.into(),
            started: Instant::now(),
            lifetime,
        });
        Ok(
            json!({"imageDataUrl":format!("data:image/png;base64,{image}"),"expiresInSeconds":lifetime}),
        )
    }
    pub async fn poll_login(&self) -> Result<Value, String> {
        let mut s = self.session.lock().await;
        let t = s.ticket.as_ref().ok_or("没有待确认的二维码，请重新生成")?;
        if t.started.elapsed().as_secs() >= t.lifetime {
            s.ticket = None;
            return Ok(json!({"stage":"expired"}));
        }
        let q = passport_query(Some(&t.token));
        let j = request(
            &s,
            Method::GET,
            &format!("/passport/web/check_qrconnect/?{q}"),
            None,
        )
        .await?;
        let d = &j["data"];
        if number(&d["error_code"]) != 0 {
            s.ticket = None;
            return Err("二维码已失效或官方拒绝请求，请刷新二维码".into());
        }
        let status = d["status"].as_str().unwrap_or("").to_ascii_lowercase();
        if matches!(
            status.as_str(),
            "expired" | "cancelled" | "canceled" | "failure"
        ) {
            s.ticket = None;
            return Ok(json!({"stage":"expired"}));
        }
        let confirmed = matches!(
            status.as_str(),
            "confirmed" | "success" | "done" | "ok" | "scanned-ok" | "accepted"
        );
        let redirect = ["redirect_url", "redirectUrl", "url", "next_url"]
            .iter()
            .find_map(|k| d[k].as_str().filter(|s| !s.is_empty()));
        if confirmed || redirect.is_some() {
            if let Some(target) = redirect {
                let u = Url::parse(target)
                    .or_else(|_| Url::parse(HOST).unwrap().join(target))
                    .map_err(|_| "官方登录跳转格式错误")?;
                if !allowed_redirect(&u) {
                    s.ticket = None;
                    return Err("官方登录跳转到了未验证的地址，本次登录已停止".into());
                }
                let res = self.transport.send(s.client.get(u)).await?;
                if !res.status().is_success() {
                    return Err("官方登录确认未完成，请重试".into());
                }
            }
            let u = user(&s).await?;
            if !u.is_null() {
                s.ticket = None;
                let warning = persist(&s).err();
                return Ok(json!({"stage":"authenticated", "user":u, "warning":warning}));
            }
            return Ok(json!({"stage":"confirming"}));
        }
        Ok(
            json!({"stage":if matches!(status.as_str(), "scanned" | "scanning" | "scan") { "scanned" } else { "waiting" }}),
        )
    }
    pub async fn cancel_login(&self) {
        self.session.lock().await.ticket = None;
    }
    pub async fn logout(&self) -> Result<(), String> {
        *self.session.lock().await = new_session(false, self.transport.clone());
        clear_credential()
    }
    pub async fn bookshelf(&self) -> Result<Value, String> { self.bookshelf_updates(None).await }
    pub async fn bookshelf_updates(&self, updates: Option<Box<dyn Fn(Value) + Send + Sync>>) -> Result<Value, String> {
        let s = self.read_session().await;
        if user(&s).await?.is_null() {
            return Err("登录会话无效，请重新扫码登录".into());
        }
        let j = request(&s, Method::GET, "/reading/bookapi/bookshelf/info/v:version/?aid=1967&app_name=novelapp&version_code=57700&update_version_code=57700&device_platform=web&iid=0", None).await?;
        business(&j)?;
        let entries = j["data"]["book_shelf_info"]
            .as_array()
            .ok_or("官方书架格式已变化")?;
        let mut ids: Vec<String> = entries
            .iter()
            .map(|b| sid(&b["book_id"]))
            .filter(|id| check_id(id).is_ok())
            .collect();
        let mut seen = std::collections::HashSet::new();
        ids.retain(|id| seen.insert(id.clone()));
        let mut details = Vec::new();
        let mut metadata_warning = None;
        for chunk in ids.chunks(40) {
            let result = request(
                &s,
                Method::POST,
                "/api/book/simple/info",
                Some(json!({"book_ids":chunk})),
            )
            .await;
            match result.and_then(|j| {
                business(&j)?;
                j["data"]["bookList"]
                    .as_array()
                    .cloned()
                    .ok_or("官方书籍资料格式已变化".into())
            }) {
                Ok(list) => {
                    self.remember_books(&list).await;
                    details.extend(list);
                    if let Some(update) = &updates {
                        let ready: Vec<Value> = ids.iter().filter_map(|id| {
                            let info = details.iter().find(|b| sid(&b["book_id"]) == *id)?;
                            Some(json!({"id":id,"title":info["book_name"].as_str().unwrap_or("未返回书名"),"author":info["author_name"].as_str().unwrap_or(""),"coverUrl":cover_url(info),"progressState":"loading"}))
                        }).collect();
                        update(json!({"entries":ready,"partial":true,"total":ids.len()}));
                    }
                },
                Err(e) => {
                    metadata_warning = Some(format!("书架已读取，部分封面/书名未取得：{e}"));
                    break;
                }
            }
        }
        let (progress, progress_error) = if ids.is_empty() || metadata_warning.is_some() {
            (
                Vec::new(),
                metadata_warning
                    .as_ref()
                    .map(|_| "本次书籍资料请求失败，未继续请求章节进度".to_string()),
            )
        } else {
            match request(&s, Method::GET, "/api/reader/book/progress", None)
                .await
                .and_then(|j| {
                    business(&j)?;
                    progress_rows(&j["data"])
                }) {
                Ok(list) => (list, None),
                Err(e) => (Vec::new(), Some(format!("书架已读取，章节进度未取得：{e}"))),
            }
        };
        let mut chapter_details = Vec::new();
        let with_progress: Vec<Value> = ids
            .iter()
            .filter_map(|id| {
                progress
                    .iter()
                    .find(|p| sid(&p["book_id"]) == *id)
                    .map(|p| json!({"book_id":id,"item_id":p["item_id"]}))
            })
            .collect();
        for chunk in with_progress.chunks(40) {
            let result = request(
                &s,
                Method::POST,
                "/api/bookshelf/multidetail",
                Some(json!({"books":chunk})),
            )
            .await;
            match result.and_then(|j| {
                business(&j)?;
                j["data"]["detail_list"]
                    .as_array()
                    .cloned()
                    .ok_or("官方章节资料格式已变化".into())
            }) {
                Ok(list) => chapter_details.extend(list),
                Err(e) => {
                    metadata_warning = Some(format!("章节位置已读取，部分章节标题未取得：{e}"));
                    break;
                }
            }
        }
        let books: Vec<Value> = ids.iter().map(|id| {
            let info = details.iter().find(|b| sid(&b["book_id"]) == *id).unwrap_or(&Value::Null);
            let remote = progress.iter().find(|p| sid(&p["book_id"]) == *id);
            let detail = chapter_details.iter().find(|b| sid(&b["book_id"]) == *id && remote.is_some_and(|p| sid(&b["item_id"]) == sid(&p["item_id"])));
            json!({"id":id,"title":info["book_name"].as_str().unwrap_or("未返回书名"),
                "author":info["author_name"].as_str().unwrap_or(""),"coverUrl":cover_url(info),
                "lastReadItemId":remote.map(|p| sid(&p["item_id"])),
                "lastReadTitle":detail.and_then(|d| d["item_show_title"].as_str()),
                "progressState":if progress_error.is_some() { "failed" } else if remote.is_some() { "available" } else { "missing" }})
        }).collect();
        Ok(
            json!({"entries":books,"progressError":progress_error,"metadataWarning":metadata_warning}),
        )
    }
    pub(crate) async fn fresh_cover(&self, id: &str, previous: &str) -> Result<String,String> {
        check_id(id)?;
        if let Some((time, info)) = self.book_metadata.lock().await.get(id) {
            let cover = cover_url(info);
            if time.elapsed()<Duration::from_secs(300) && !cover.is_empty() && cover != previous && !cover.contains("p6-tt.bytecdn.cn/") {return Ok(cover);}
        }
        let session=self.read_session().await;
        let response=request(&session,Method::GET,&format!("/api/book/info?bookId={id}"),None).await?;
        business(&response)?;
        let data=&response["data"];
        let returned=sid(data.get("bookId").unwrap_or(&data["book_id"]));
        if !returned.is_empty() && returned!=id {return Err("封面资料与书籍不一致".into());}
        let cover=cover_url(data);
        if cover.is_empty() {return Err("官网未提供当前封面".into());}
        let info=json!({"id":id,"title":data["bookName"].as_str().or_else(||data["book_name"].as_str()).unwrap_or("番茄小说"),"author":data["author"].as_str().or_else(||data["authorName"].as_str()).unwrap_or(""),"description":data["abstract"].as_str().unwrap_or(""),"coverUrl":cover});
        self.book_metadata.lock().await.remove(id);
        self.remember_books(&[info]).await;
        Ok(if cover.starts_with("//") {format!("https:{cover}")} else {cover})
    }

    pub async fn book(&self, id: &str) -> Result<Value, String> {
        check_id(id)?;
        let cached = {
            let mut cache = self.book_metadata.lock().await;
            cache.retain(|_, (time, _)|time.elapsed() < Duration::from_secs(300));
            cache.get(id).map(|(_,value)|value.clone())
        };
        let s = self.read_session().await;
        let d = if let Some(info) = cached { info } else {
            let j = request(&s, Method::GET, &format!("/api/book/info?bookId={id}"), None).await?;
            business(&j)?;
            let raw = &j["data"];
            let info = json!({"id":id,"title":raw["bookName"].as_str().or_else(||raw["book_name"].as_str()).unwrap_or("番茄小说"),
                "author":raw["author"].as_str().or_else(||raw["authorName"].as_str()).unwrap_or(""),
                "description":raw["abstract"].as_str().unwrap_or(""),"coverUrl":cover_url(raw)});
            self.remember_books(&[info.clone()]).await;
            info
        };
        let directory = request(
            &s,
            Method::GET,
            &format!("/api/reader/directory/detail?bookId={id}&enter_from=0"),
            None,
        )
        .await?;
        business(&directory)?;
        let volumes = directory["data"]["chapterListWithVolume"]
            .as_array()
            .ok_or("官方目录格式已变化")?;
        let mut chapters = Vec::new();
        for volume in volumes {
            let items: Vec<&Value> = if let Some(list) = volume.as_array() {
                list.iter().collect()
            } else if volume.get("itemId").is_some() || volume.get("item_id").is_some() {
                vec![volume]
            } else {
                volume["chapterList"]
                    .as_array()
                    .map(|a| a.iter().collect())
                    .unwrap_or_default()
            };
            for c in items {
                let cid = sid(c.get("itemId").unwrap_or(&c["item_id"]));
                if check_id(&cid).is_ok() {
                    chapters.push(json!({"id":cid,"title":c["title"].as_str().unwrap_or("未返回章节标题"),"content":"","loaded":false}));
                }
            }
        }
        if chapters.is_empty() {
            return Err("官方未返回可读章节".into());
        }
        Ok(
            json!({"id":id,"title":d["title"].as_str().unwrap_or("番茄小说"),
            "author":d["author"].as_str().unwrap_or(""),
            "description":d["description"].as_str().unwrap_or(""),"source":"official", "coverStyle":0,"coverUrl":cover_url(&d),"chapters":chapters,
            "addedAt":0}),
        )
    }
    pub async fn chapter(&self, id: &str) -> Result<Value, String> {
        self.app.chapter(id).await
    }
    pub async fn read_progress(&self) -> Result<Value, String> {
        let s = self.read_session().await;
        if user(&s).await?.is_null() {
            return Err("登录会话已过期，请重新登录".into());
        }
        let j = request(&s, Method::GET, "/api/reader/book/progress", None).await?;
        business(&j)?;
        Ok(Value::Array(progress_rows(&j["data"])?))
    }
    pub async fn sync_progress(
        &self,
        book_id: &str,
        item_id: &str,
        index: usize,
    ) -> Result<Value, String> {
        check_id(book_id)?;
        check_id(item_id)?;
        let s = self.session.lock().await;
        if user(&s).await?.is_null() {
            return Err("登录会话已过期，请重新登录".into());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let j = request(
            &s,
            Method::POST,
            "/api/reader/book/update_progress",
            Some(json!({"book_id":book_id,"item_id":item_id,
            "read_progress":index,"index":index,"read_timestamp":now,"genre_type":0})),
        )
        .await?;
        business(&j)?;
        // Read back instead of treating an HTTP 200 as successful synchronization.
        let back = request(&s, Method::GET, "/api/reader/book/progress", None).await?;
        business(&back)?;
        let list = progress_rows(&back["data"])?;
        if !list
            .iter()
            .any(|p| sid(&p["book_id"]) == book_id && sid(&p["item_id"]) == item_id)
        {
            return Err("服务端未确认本章进度，已保留本地记录，请稍后重试".into());
        }
        Ok(json!({"confirmed":true,"chapterId":item_id}))
    }
    pub async fn comments(&self, id: &str, page: u32) -> Result<Value, String> {
        self.app.comments(id, page).await
    }
    pub async fn search(&self, keyword: &str, offset: u32) -> Result<Value, String> {
        let keyword = keyword.trim();
        if keyword.is_empty() || keyword.chars().count() > 100 {
            return Err("搜索关键词应为1至100个字符".into());
        }
        let query = {
            let mut q = url::form_urlencoded::Serializer::new(String::new());
            q.extend_pairs([
                ("aid", "1967"),
                ("app_name", "novelapp"),
                ("device_platform", "android"),
                ("version_code", "57700"),
                ("update_version_code", "57700"),
                ("channel", "0"),
                ("version_name", "5.7.7"),
                ("q", keyword),
                ("count", "10"),
            ]);
            q.append_pair("offset", &offset.min(10000).to_string());
            q.finish()
        };
        let client = Client::builder()
            .user_agent(UA)
            .timeout(Duration::from_secs(15))
            .https_only(true)
            .redirect(Policy::none())
            .build()
            .map_err(|_| "搜索服务初始化失败")?;
        let j = parse_response(
            self.transport
                .send(
                    client
                        .get(format!(
                            "{COMMENT_HOST}/api/novel/channel/homepage/search/search/v1/?{}",
                            query
                        ))
                        .header("Referer", "https://api.fanqiesdk.com/"),
                )
                .await?,
        )
        .await?;
        business(&j)?;
        let d = &j["data"];
        let rows = d["ret_data"].as_array().ok_or("官方搜索格式已变化")?;
        let books=rows.iter().filter(|b| check_id(&sid(&b["book_id"])).is_ok()).map(|b|json!({"id":sid(&b["book_id"]),"title":b["title"].as_str().or_else(||b["book_name"].as_str()).unwrap_or("未返回书名"),"author":b["author"].as_str().unwrap_or(""),"description":b["abstract"].as_str().unwrap_or(""),"score":sid(&b["score"]),"coverUrl":cover_url(b)})).collect::<Vec<_>>();
        self.remember_books(&books).await;
        let next = number(&d["offset"]);
        Ok(
            json!({"books":books,"hasMore":d["has_more"].as_bool().unwrap_or(number(&d["has_more"])>0),"nextOffset":if next>offset as i64 {next} else {offset as i64+10}}),
        )
    }
    pub async fn comment_details(
        &self,
        book_id: &str,
        comment_id: &str,
        _user_id: &str,
    ) -> Result<Value, String> {
        self.app.replies(book_id, comment_id, None).await
    }
    pub async fn comment_replies(
        &self,
        book: &str,
        parent: &str,
        cursor: Option<&str>,
    ) -> Result<Value, String> {
        self.app.replies(book, parent, cursor).await
    }
    pub async fn audio_catalog(&self, book_id: &str) -> Result<Value, String> {
        check_id(book_id)?;
        let s = self.read_session().await;
        let j=request(&s,Method::GET,&format!("/reading/bookapi/audio/toneinfo/?aid=1967&app_name=novelapp&version_code=57700&update_version_code=57700&device_platform=web&iid=0&book_id={book_id}"),None).await?;
        business(&j)?;
        let d = &j["data"];
        let audio = d["audio_tones"]
            .as_array()
            .ok_or("官方音色目录格式已变化")?;
        let infos = d["book_infos"].as_array();
        let albums=audio.iter().filter_map(|a|{
            let id=sid(&a["abook_id"]);if check_id(&id).is_err(){return None;}
            let info=infos.and_then(|b|b.iter().find(|b|sid(&b["book_id"])==id));
            Some(json!({"id":id,"name":info.and_then(|b|b["book_name"].as_str()).unwrap_or("官方有声版"),"narrator":a["title"].as_str().unwrap_or("官方有声版"),"kind":"recorded"}))
        }).collect::<Vec<_>>();
        let tones=d["tts_tones"].as_array().map(|a|a.iter().map(|t|json!({"id":sid(&t["id"]),"name":t["title"].as_str().unwrap_or("官方AI声音")})).collect::<Vec<_>>()).unwrap_or_default();
        Ok(json!({"albums":albums,"ttsTones":tones}))
    }
    pub async fn audio_episodes(&self, album_id: &str) -> Result<Value, String> {
        check_id(album_id)?;
        let s = self.read_session().await;
        let j = request(
            &s,
            Method::GET,
            &format!("/api/reader/directory/detail?bookId={album_id}&enter_from=0"),
            None,
        )
        .await?;
        business(&j)?;
        let rows = directory_rows(&j["data"])?;
        if rows.is_empty() {
            return Err("官方没有返回有声版目录".into());
        }
        Ok(Value::Array(rows))
    }
    pub async fn audio_play(&self, item_id: &str) -> Result<Value, String> {
        self.app.audio(item_id).await
    }
    pub async fn paragraph_counts(&self, item: &str, version: &str) -> Result<Value, String> { self.app.paragraph_counts(item, version).await }
    pub async fn paragraph_comments(&self, book: &str, item: &str, para: u32, version: &str, cursor: &str) -> Result<Value, String> { self.app.paragraph_comments(book, item, para, version, cursor).await }
    pub async fn paragraph_replies(&self, book: &str, item: &str, comment: &str, cursor: &str) -> Result<Value, String> { self.app.paragraph_replies(book, item, comment, cursor).await }
    pub async fn audio_alignment(&self, book: &str, item: &str, album: &str) -> Result<Value, String> {
        check_id(book)?;
        check_id(item)?;
        check_id(album)?;
        let catalog = self.audio_catalog(book).await?;
        if !catalog["albums"].as_array().is_some_and(|a| a.iter().any(|a| a["id"].as_str() == Some(album))) {
            return Err("该有声版本不属于当前作品".into());
        }
        self.app.audio_alignment(item, album).await
    }
    pub async fn tts_play(&self, book_id: &str, item_id: &str, tone_id: &str) -> Result<Value, String> {
        check_id(book_id)?;
        check_id(item_id)?;
        if tone_id.is_empty() || tone_id.len() > 10 || !tone_id.bytes().all(|b| b.is_ascii_digit()) {
            return Err("官方音色ID格式错误".into());
        }
        let catalog = self.audio_catalog(book_id).await?;
        if !catalog["ttsTones"].as_array().is_some_and(|tones| tones.iter().any(|t| t["id"].as_str() == Some(tone_id))) {
            return Err("该书本次没有提供所选AI音色，请重新检查音色".into());
        }
        self.app.audio_with_tone(item_id, tone_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn slow_read_does_not_hold_account_state_and_logout_isolates_cookies() {
        use std::{io::{Read, Write}, net::TcpListener};
        let transport = Arc::new(Transport::default());
        let service = OfficialService {
            app: crate::app_content::AppContent::new(transport.clone()),
            session: Mutex::new(new_session(false, transport.clone())),
            book_metadata: Mutex::new(HashMap::new()),
            transport,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (started, received) = tokio::sync::oneshot::channel();
        let (finish, blocked) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut buffer = [0; 2048];
            stream.read(&mut buffer).unwrap();
            let _ = started.send(());
            blocked.recv_timeout(Duration::from_secs(5)).unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
        });
        let snapshot = service.read_session().await;
        let old_jar = snapshot.jar.clone();
        let background = tokio::spawn(async move {
            let client = Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap();
            snapshot.transport.send(client.get(format!("http://{address}/slow-read"))).await
        });
        tokio::time::timeout(Duration::from_secs(5), received).await.unwrap().unwrap();
        let foreground = tokio::time::timeout(Duration::from_millis(500), service.read_session()).await.unwrap();
        assert!(Arc::ptr_eq(&foreground.jar, &old_jar));
        // Replace only in-memory state: never touch the user's saved credential.
        *service.session.lock().await = new_session(false, service.transport.clone());
        let after_logout = service.read_session().await;
        assert!(!Arc::ptr_eq(&after_logout.jar, &old_jar));
        assert!(Arc::ptr_eq(&after_logout.transport, &foreground.transport));
        finish.send(()).unwrap();
        assert!(background.await.unwrap().is_ok());
        server.join().unwrap();
    }
    #[tokio::test]
    async fn metadata_cache_reuses_known_details_and_expires_old_entries() {
        let transport=Arc::new(Transport::default());
        let service=OfficialService {app:crate::app_content::AppContent::new(transport.clone()),session:Mutex::new(new_session(false,transport.clone())),book_metadata:Mutex::new(HashMap::new()),transport};
        service.book_metadata.lock().await.insert("987654".into(),(Instant::now()-Duration::from_secs(301),json!({"title":"expired"})));
        service.remember_books(&[json!({"book_id":"123456","book_name":"缓存作品","author_name":"作者","thumb_url":"https://p3.fqnovelpic.com/a.webp","abstract":"简介"})]).await;
        let cache=service.book_metadata.lock().await;
        assert!(!cache.contains_key("987654"));assert_eq!(cache["123456"].1["title"],"缓存作品");assert_eq!(cache["123456"].1["coverUrl"],"https://p3.fqnovelpic.com/a.webp");
        drop(cache);
        service.remember_books(&[json!({"id":"123456","title":"旧搜索标题","author":"作者","coverUrl":"https://p6-tt.bytecdn.cn/old.image"})]).await;
        assert_eq!(service.fresh_cover("123456","https://p6-tt.bytecdn.cn/old.image").await.unwrap(),"https://p3.fqnovelpic.com/a.webp");
    }
    #[test]
    fn command_futures_can_move_between_desktop_threads() {
        fn require_send<T: Send>(_: T) {}
        let transport = Arc::new(Transport::default());
        let service = OfficialService {
            app: crate::app_content::AppContent::new(transport.clone()),
            session: Mutex::new(new_session(false, transport.clone())),
            book_metadata: Mutex::new(HashMap::new()),
            transport,
        };
        // Dropped without polling: this checks the desktop command contract without HTTP.
        require_send(service.search("测试", 0));
        require_send(service.ranking_categories());
        require_send(service.rankings(1, 2, "257", 0, ""));
        require_send(service.comment_details("123456", "234567", ""));
        require_send(service.tts_play("7069948840148732967", "7083521020400763392", "74"));
        require_send(service.audio_alignment("7255936586997566505", "7399337929476162072", "7325015266541423678"));
        require_send(service.paragraph_counts("7399337929476162072", ""));
        require_send(service.paragraph_comments("7255936586997566505", "7399337929476162072", 0, "", ""));
        require_send(service.paragraph_replies("7255936586997566505", "7399337929476162072", "123456", ""));
    }
    #[test]
    fn official_cover_and_progress_shapes() {
        assert_eq!(
            cover_url(&json!({"thumb_url":"https://p6-tt.bytecdn.cn/cover.image"})),
            "https://p6-tt.bytecdn.cn/cover.image"
        );
        assert_eq!(
            cover_url(&json!({"thumbUrl":"https://p6-novel.byteimg.com/cover.image"})),
            "https://p6-novel.byteimg.com/cover.image"
        );
        assert_eq!(cover_url(&json!({"thumb_url":"javascript:alert(1)"})), "");
        let rows = progress_rows(&json!([{"book_id":123456,"item_id":987654,"read_timestamp":"42"},{"book_id":"234567","item_id":"0"}])).unwrap();
        assert_eq!(
            rows,
            vec![json!({"book_id":"123456","item_id":"987654","read_timestamp":42})]
        );
        assert!(progress_rows(&json!({"unexpected":[]})).is_err());
        assert!(progress_rows(&json!([{"book_id":"123456","item_id":"invalid"}])).is_err());
        assert!(progress_rows(&json!([])).unwrap().is_empty());
    }
    #[test]
    fn progress_selects_latest_timestamp_instead_of_first_row() {
        let rows = progress_rows(&json!([
            {"book_id":"123456","item_id":"111111","read_timestamp":100},
            {"book_id":"123456","item_id":"222222","read_timestamp":200},
            {"book_id":"123456","item_id":"333333","read_timestamp":150}
        ])).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["item_id"], "222222");
    }
    #[test]
    fn progress_compares_seconds_and_milliseconds_consistently() {
        let rows = progress_rows(&json!([
            {"book_id":"123456","item_id":"111111","read_timestamp":1_792_000_000_000i64},
            {"book_id":"123456","item_id":"222222","read_timestamp":1_792_000_001}
        ])).unwrap();
        assert_eq!(rows[0]["item_id"], "222222");
        assert_eq!(rows[0]["read_timestamp"], 1_792_000_001);
    }
    #[test]
    fn ambiguous_equal_time_progress_stops_instead_of_guessing() {
        assert!(progress_rows(&json!([
            {"book_id":"123456","item_id":"111111","read_timestamp":200},
            {"book_id":"123456","item_id":"222222","read_timestamp":200}
        ])).is_err());
    }
    #[test]
    fn ambiguous_old_records_do_not_hide_a_newer_unique_record() {
        let rows = progress_rows(&json!([
            {"book_id":"123456","item_id":"111111","read_timestamp":100},
            {"book_id":"123456","item_id":"222222","read_timestamp":100},
            {"book_id":"123456","item_id":"333333","read_timestamp":200}
        ])).unwrap();
        assert_eq!(rows[0]["item_id"], "333333");
    }
    #[test]
    fn read_history_keeps_exact_ids_and_rejects_invalid_data() {
        assert_eq!(read_item_ids(&json!(["7255936586997566505",{"item_id":"123456"},"123456"])).unwrap(), vec!["7255936586997566505", "123456"]);
        assert!(read_item_ids(&json!({"items":[]})).is_err());
        assert!(read_item_ids(&json!(["not-an-id"])).is_err());
    }
    #[test]
    fn redirects_only_to_known_https_hosts() {
        for raw in [
            "http://fanqienovel.com/",
            "https://fanqienovel.com.evil.example/",
            "https://evil.example/",
        ] {
            assert!(!allowed_redirect(&Url::parse(raw).unwrap()));
        }
        assert!(allowed_redirect(
            &Url::parse("https://fanqienovel.com/passport/").unwrap()
        ));
    }
    #[test]
    fn ids_reject_url_injection() {
        assert!(check_id("7069948840148732967").is_ok());
        assert!(check_id("12&token=secret").is_err());
    }
    #[test]
    fn business_failure_is_not_http_success() {
        assert!(business(&json!({"code":-1})).is_err());
        assert!(business(&json!({"code":0})).is_ok());
        assert!(business(&json!({"code":"failure"})).is_err());
        assert!(business(&json!({"data":{}})).is_err());
    }
    #[test]
    fn ids_preserve_large_integers() {
        assert_eq!(sid(&json!(7069948840148732967_u64)), "7069948840148732967");
    }
    #[test]
    fn comment_images_are_https_and_official() {
        assert!(comment_image("javascript:alert(1)").is_none());
        assert!(comment_image("https://byteimg.com.evil.example/a").is_none());
        assert!(comment_image("https://user:secret@p3-novel.byteimg.com/a").is_none());
        assert!(comment_image("//p3-novel.byteimg.com/a")
            .unwrap()
            .starts_with("https://"));
    }
    #[test]
    fn details_keep_images_and_nested_replies() {
        let c = json!({"info":{"comment_id":"123456","text":"文字","image_urls":["https://p3-novel.byteimg.com/a","javascript:alert(1)"]},"user":{"nick_name":"测试"},"replies":[{"info":{"comment_id":"234567","text":"回复"}}]});
        let got = normalize_web_comment(&c, 0);
        assert_eq!(got["images"].as_array().unwrap().len(), 1);
        assert_eq!(got["children"][0]["text"], "回复");
    }
    #[test]
    fn directory_supports_official_nested_and_flat_shapes() {
        for value in [
            json!({"chapterListWithVolume":[[{"itemId":"123456","title":"第一集"}]]}),
            json!({"chapterListWithVolume":[{"item_id":"123456","title":"第一集"}]}),
        ] {
            assert_eq!(directory_rows(&value).unwrap()[0]["id"], "123456");
        }
    }
    #[test]
    fn protected_or_mismatched_audio_is_not_plain_playable() {
        let protected = json!({"code":0,"data":[{"item_id":"123456","is_encrypt":1,"main_url":"https://media.example/a"}]});
        assert!(normalize_play_info(&protected, "123456").is_err());
        let plain = json!({"code":0,"data":[{"item_id":"123456","is_encrypt":0,"main_url":"https://media.example/a","backup_url":"javascript:bad"}]});
        assert_eq!(
            normalize_play_info(&plain, "123456").unwrap()["urls"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(normalize_play_info(&plain, "234567").is_err());
    }
    #[test]
    fn web_number_rounding_does_not_replace_canonical_comment_ids() {
        assert!(matches_rounded_web_id(
            &json!(7146083118167000000_u64),
            "7146083118166999816"
        ));
        assert!(!matches_rounded_web_id(
            &json!(7146083118167000000_u64),
            "7203370909527261989"
        ));
        assert!(!matches_rounded_web_id(
            &json!("7146083118167000000"),
            "7146083118166999816"
        ));
    }
}
