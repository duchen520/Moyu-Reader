//! Read-only first-party web rankings. Never synthesize rankings from search.
use crate::transport::Transport;
use reqwest::{Client, Method};
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, sync::{Arc, OnceLock, atomic::{AtomicU64, Ordering}}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tokio::sync::Mutex;

const HOST: &str = "https://fanqienovel.com";
const PAGE_SIZE: usize = 10;
type Cached = (Instant, Value);
static CATALOG: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
static METADATA: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
static REQUEST: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn text(value: &Value) -> String { value.as_str().map(str::to_owned).or_else(|| value.as_u64().map(|n| n.to_string())).unwrap_or_default() }
fn clean(value: &Value) -> String {
    let text = text(value);
    if text.chars().any(|c| ('\u{e000}'..='\u{f8ff}').contains(&c)) { String::new() } else { text }
}
fn digits(value: &str, max: usize) -> bool { !value.is_empty() && value.len() <= max && value.bytes().all(|b| b.is_ascii_digit()) }
fn book_id(value: &str) -> bool { value.len() >= 5 && digits(value, 24) }
fn success(value: &Value) -> Result<(), String> {
    if value["code"].as_i64().or_else(|| value["code"].as_str().and_then(|s| s.parse().ok())) == Some(0) { Ok(()) }
    else { Err("官方榜单接口未成功，请稍后刷新或在官网查看".into()) }
}
async fn response(transport: &Arc<Transport>, request: reqwest::RequestBuilder) -> Result<Vec<u8>, String> {
    let result = transport.send(request).await?;
    if !result.status().is_success() { return Err(format!("官方榜单返回 HTTP {}", result.status().as_u16())); }
    if result.headers().contains_key("bdturing-verify") { return Err("官方要求验证，请打开官网完成验证后刷新榜单".into()); }
    let body = result.bytes().await.map_err(|_| "官方榜单读取失败")?;
    if body.is_empty() || body.len() > 2 * 1024 * 1024 { return Err("官方榜单响应为空或超出大小限制".into()); }
    Ok(body.to_vec())
}
async fn api(client: &Client, transport: &Arc<Transport>, method: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let mut request = client.request(method, format!("{HOST}{path}"))
        .header("Referer", format!("{HOST}/rank"))
        .header("Origin", HOST)
        .header("Accept", "application/json").header("ismobile", "0");
    if let Some(body) = body { request = request.json(&body); }
    let bytes = response(transport, request).await?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "官方榜单返回了非 JSON 数据，请在官网检查")?;
    success(&value)?;
    Ok(value)
}

fn parse_catalog(html: &str) -> Result<Value, String> {
    let rest = html.split_once("window.__INITIAL_STATE__=").map(|(_, rest)| rest).ok_or("官网榜单分类格式已变化")?;
    let state = serde_json::Deserializer::from_str(rest).into_iter::<Value>().next().ok_or("官网分类数据缺失")?
        .map_err(|_| "官网分类数据无法识别")?;
    let source = &state["rank"]["rankCategoryTypeList"];
    let mut result = json!({"male":[], "female":[]});
    for gender in ["male", "female"] {
        let items = source[gender].as_array().ok_or("官网榜单分类不完整")?;
        let mut seen = HashSet::new();
        let mut categories = Vec::new();
        for item in items {
            let id = text(&item["id"]); let name = clean(&item["name"]);
            if !digits(&id, 8) || name.is_empty() { return Err("官网榜单分类含有无效条目".into()); }
            if seen.insert(id.clone()) { categories.push(json!({"id":id,"name":name})); }
        }
        if categories.is_empty() { return Err("官网未返回可用的榜单分类".into()); }
        result[gender] = Value::Array(categories);
    }
    Ok(result)
}

pub(crate) async fn categories(client: &Client, transport: &Arc<Transport>) -> Result<Value, String> {
    let mut cache = CATALOG.get_or_init(|| Mutex::new(None)).lock().await;
    if let Some((time, value)) = &*cache {
        if time.elapsed() < Duration::from_secs(1800) { return Ok(value.clone()); }
    }
    let bytes = response(transport, client.get(format!("{HOST}/rank")).header("Accept", "text/html")).await?;
    let html = std::str::from_utf8(&bytes).map_err(|_| "官网分类编码无法识别")?;
    let value = parse_catalog(html)?;
    *cache = Some((Instant::now(), value.clone()));
    Ok(value)
}

fn validate(gender: u8, mold: u8, category: &str, offset: u32, version: &str) -> Result<(), String> {
    if gender > 1 || ![1, 2].contains(&mold) || !digits(category, 8) || offset > 990 || offset % PAGE_SIZE as u32 != 0
        || (!version.is_empty() && !digits(version, 16)) || (offset > 0 && version.is_empty()) {
        return Err("无效的榜单分类或分页参数，请重新选择榜单".into());
    }
    Ok(())
}

fn rank_data(value: &Value, requested_version: &str) -> Result<(Vec<Value>, u64, String), String> {
    success(value)?;
    let data = &value["data"];
    let rows = data["book_list"].as_array().ok_or("官方榜单作品列表格式已变化")?;
    let total = text(&data["total_num"]).parse::<u64>().map_err(|_| "官方榜单未返回有效总数")?;
    let version = text(&data["rankVersion"]);
    if rows.len() > PAGE_SIZE || total > 10000 || !digits(&version, 16) { return Err("官方榜单分页信息异常，未猜测排名".into()); }
    if !requested_version.is_empty() && requested_version != version { return Err("官方榜单已更新，请刷新后重新加载，避免混合不同日期的排名".into()); }
    for row in rows {
        let id = text(&row["bookId"]);
        let position = text(&row["currentPos"]).parse::<u64>().unwrap_or(0);
        if !book_id(&id) || position == 0 || position > 10000 { return Err("官方榜单缺少有效的作品 ID 或排名，未猜测补齐".into()); }
    }
    Ok((rows.clone(), total, version))
}

fn normalize(row: &Value, metadata: Option<&Value>, category: &str) -> Value {
    let id = text(&row["bookId"]);
    let field = |names: &[&str], fallback: &Value| -> String {
        metadata.and_then(|info| names.iter().map(|name| clean(&info[*name])).find(|s| !s.is_empty()))
            .unwrap_or_else(|| clean(fallback))
    };
    let title = field(&["book_name", "bookName"], &row["bookName"]);
    let missing = title.is_empty();
    let score = metadata.map(|v| clean(&v["score"])).unwrap_or_default();
    let score = if score.parse::<f64>().is_ok_and(|n| n.is_finite() && n > 0.0 && n <= 10.0) { score } else { String::new() };
    let status = match text(&row["creationStatus"]).as_str() { "0" => "已完结", "1" => "连载中", _ => "状态未返回" };
    json!({"id":id,"rank":row["currentPos"].as_u64().unwrap_or_else(|| text(&row["currentPos"]).parse().unwrap_or(0)),
        "title":if missing {format!("书籍 {id}（资料暂未取得）")} else {title},
        "author":field(&["author_name","authorName","author"], &row["author"]),
        "description":field(&["abstract"], &row["abstract"]), "coverUrl":clean(&row["thumbUri"]),
        "category":category,"score":score,"readCount":text(&row["read_count"]),"wordCount":text(&row["wordNumber"]),
        "status":status,"metadataMissing":missing})
}

pub(crate) async fn page(client: &Client, transport: &Arc<Transport>, gender: u8, mold: u8, category: &str, offset: u32, version: &str) -> Result<Value, String> {
    validate(gender, mold, category, offset, version)?;
    let request_id = REQUEST.fetch_add(1, Ordering::SeqCst) + 1;
    let current = || REQUEST.load(Ordering::SeqCst) == request_id;
    let catalog = categories(client, transport).await?;
    let options = catalog[if gender == 1 { "male" } else { "female" }].as_array().ok_or("榜单分类缺失")?;
    let name = options.iter().find(|c| c["id"].as_str() == Some(category)).and_then(|c| c["name"].as_str()).ok_or("官网未提供此分类，请刷新分类列表")?;
    let path = format!("/api/rank/category/list?app_id=2503&rank_list_type=3&offset={offset}&limit={PAGE_SIZE}&category_id={category}&rank_version={version}&gender={gender}&rankMold={mold}");
    if !current() { return Err("已切换到其他榜单".into()); }
    let value = api(client, transport, Method::GET, &path, None).await?;
    let (rows, total, actual_version) = rank_data(&value, version)?;
    let mut metadata = HashMap::new();
    let cache = METADATA.get_or_init(|| Mutex::new(HashMap::new()));
    {
        let mut cache = cache.lock().await;
        cache.retain(|_, (time, _)| time.elapsed() < Duration::from_secs(3600));
        for row in &rows {
            let id = text(&row["bookId"]);
            if let Some((_, value)) = cache.get(&id) { metadata.insert(id, value.clone()); }
        }
    }
    let missing: Vec<String> = rows.iter().map(|row| text(&row["bookId"])).filter(|id| !metadata.contains_key(id)).collect();
    if !missing.is_empty() && current() {
        // The batch endpoint needs a valid saved login; anonymous users fall back
        // to the public per-book metadata endpoint, with the same host pacing.
        let batch = api(client, transport, Method::POST, "/api/book/simple/info", Some(json!({"book_ids":missing}))).await;
        if let Err(error) = &batch {
            // An anonymous batch permission error can use public metadata. Network
            // failures, verification and cooldown must not trigger further calls.
            if error != "官方榜单接口未成功，请稍后刷新或在官网查看" { return Err(error.clone()); }
        }
        if let Ok(batch) = batch {
            if let Some(items) = batch["data"]["bookList"].as_array() {
                for item in items {
                    let id = ["book_id", "bookId"].iter().map(|key| text(&item[*key])).find(|id| book_id(id)).unwrap_or_default();
                    let title = ["book_name", "bookName"].iter().any(|key| !clean(&item[*key]).is_empty());
                    if missing.contains(&id) && title { metadata.insert(id, item.clone()); }
                }
            }
        }
        for id in &missing {
            if !current() { return Err("已切换到其他榜单".into()); }
            if metadata.contains_key(id) { continue; }
            match api(client, transport, Method::GET, &format!("/api/book/info?bookId={id}"), None).await {
                Ok(info) => {
                    let returned_id = text(&info["data"]["bookId"]);
                    if (returned_id.is_empty() || returned_id == *id) && !clean(&info["data"]["bookName"]).is_empty() {
                        metadata.insert(id.clone(), info["data"].clone());
                    }
                }
                Err(error) => {
                    if error != "官方榜单接口未成功，请稍后刷新或在官网查看" { return Err(error); }
                }
            }
        }
        let mut cache = cache.lock().await;
        for (id, value) in &metadata { cache.insert(id.clone(), (Instant::now(), value.clone())); }
    }
    if !current() { return Err("已切换到其他榜单".into()); }
    let books: Vec<Value> = rows.iter().map(|row| normalize(row, metadata.get(&text(&row["bookId"])), name)).collect();
    let warning = if books.iter().any(|book| book["metadataMissing"] == true) { "部分作品资料未取得，可刷新重试或在官网查看。" } else { "" };
    let next_offset = offset as usize + rows.len();
    Ok(json!({"books":books,"total":total,"nextOffset":next_offset,"hasMore":!rows.is_empty() && (next_offset as u64) < total && next_offset < 1000,
        "version":actual_version,"fetchedAt":now_ms(),"warning":warning,
        "sourceUrl":format!("{HOST}/rank/{gender}_{mold}_{category}")}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Value { json!({"code":0,"data":{"book_list":[{"bookId":"7590221243043826712","currentPos":11,"bookName":"\u{e446}","author":"\u{e446}","abstract":"\u{e446}","creationStatus":"1","read_count":"10000","wordNumber":"20000"}],"total_num":100,"rankVersion":"1792086600"}}) }
    #[test] fn category_state_is_data_not_executable_javascript() {
        let html = r#"<script>window.__INITIAL_STATE__={"rank":{"rankCategoryTypeList":{"male":[{"id":"257","name":"玄幻脑洞"}],"female":[{"id":"24","name":"快穿"}]}}};evil()</script>"#;
        assert_eq!(parse_catalog(html).unwrap()["male"][0]["name"], "玄幻脑洞");
        assert!(parse_catalog("window.__INITIAL_STATE__=evil()").is_err());
    }
    #[test] fn invalid_rank_arguments_do_not_build_urls() {
        assert!(validate(1,2,"257",10,"1792086600").is_ok());
        for args in [(2,2,"257",0,""),(1,3,"257",0,""),(1,2,"../x",0,""),(1,2,"257",11,"123"),(1,2,"257",10,"")] {
            assert!(validate(args.0,args.1,args.2,args.3,args.4).is_err());
        }
    }
    #[test] fn paging_rejects_a_changed_official_snapshot() {
        assert!(rank_data(&sample(),"1792086600").is_ok());
        assert!(rank_data(&sample(),"1792000000").is_err());
    }
    #[test] fn invalid_ids_and_missing_rank_are_not_guessed() {
        let mut value=sample(); value["data"]["book_list"][0]["bookId"]=json!("https://bad.example"); assert!(rank_data(&value,"").is_err());
        value=sample(); value["data"]["book_list"][0]["currentPos"]=Value::Null; assert!(rank_data(&value,"").is_err());
    }
    #[test] fn official_rank_survives_metadata_enrichment_and_font_obfuscation_is_never_shown() {
        let data=sample(); let row=&data["data"]["book_list"][0];
        let info=json!({"bookName":"真实书名","authorName":"真实作者","abstract":"真实简介"});
        let book=normalize(row,Some(&info),"玄幻脑洞");
        assert_eq!(book["rank"],11); assert_eq!(book["title"],"真实书名"); assert_eq!(book["readCount"],"10000");
        let unavailable=normalize(row,None,"玄幻脑洞"); assert_eq!(unavailable["metadataMissing"],true);
        assert!(!unavailable.to_string().chars().any(|c| ('\u{e000}'..='\u{f8ff}').contains(&c)));
    }
    #[tokio::test]
    #[ignore = "Explicit read-only live check against the official public ranking service"]
    async fn live_public_pages() {
        let client=Client::builder().user_agent("Mozilla/5.0").https_only(true).timeout(Duration::from_secs(15)).build().unwrap();
        let transport=Arc::new(Transport::default());
        let catalog=categories(&client,&transport).await.unwrap();
        assert!(catalog["male"].as_array().unwrap().len()>10);
        assert!(catalog["female"].as_array().unwrap().len()>10);
        let first=page(&client,&transport,1,2,"257",0,"").await.unwrap();
        assert_eq!(first["books"].as_array().unwrap().len(),10);
        assert!(first["books"].as_array().unwrap().iter().all(|book| book["metadataMissing"]==false));
        let second=page(&client,&transport,1,2,"257",10,first["version"].as_str().unwrap()).await.unwrap();
        assert_eq!(second["books"].as_array().unwrap().len(),10);
        assert_eq!(second["books"][0]["rank"],11);
        let first_ids:HashSet<String>=first["books"].as_array().unwrap().iter().map(|book|text(&book["id"])).collect();
        assert!(second["books"].as_array().unwrap().iter().all(|book|!first_ids.contains(&text(&book["id"]))));
        println!("Live public catalog: {} male and {} female categories; two pages: {} + {} books; total {}; version {}",catalog["male"].as_array().unwrap().len(),catalog["female"].as_array().unwrap().len(),first["books"].as_array().unwrap().len(),second["books"].as_array().unwrap().len(),first["total"],first["version"]);
    }
}
