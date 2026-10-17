//! Official signed App reads. Stable normal device; no privilege writes or rotation.
use crate::{app_crypto as c, app_media, transport::Transport};
use reqwest::{redirect::Policy, Client, Url};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
struct State {
    device: Option<(String, String)>,
    key: Option<(Vec<u8>, String)>,
    cursors: HashMap<(String, u32), String>,
    versions: HashMap<String, String>,
}
pub struct AppContent {
    client: Client,
    transport: Arc<Transport>,
    state: Mutex<State>,
}
fn id(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
fn num(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}
fn check(v: &str) -> Result<(), String> {
    if (5..=24).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err("官方ID格式错误".into())
    }
}
fn load_device() -> Option<(String, String)> {
    #[cfg(target_os = "windows")]
    let data = keyring::Entry::new("dev.tomatoreader.desktop", "fanqie-app-device")
        .ok()?
        .get_password()
        .ok()?;
    #[cfg(not(target_os = "windows"))]
    let data = {
        if !cfg!(debug_assertions) {
            return None;
        }
        let p = std::env::var("TOMATO_DEVICE_STATE").ok()?;
        std::fs::read_to_string(p).ok()?
    };
    let v: Value = serde_json::from_str(&data).ok()?;
    let (a, b) = (id(&v["device_id"]), id(&v["install_id"]));
    check(&a).ok()?;
    check(&b).ok()?;
    Some((a, b))
}
fn persist(a: &str, b: &str) -> Result<(), String> {
    let v = json!({"device_id":a,"install_id":b}).to_string();
    #[cfg(target_os = "windows")]
    {
        keyring::Entry::new("dev.tomatoreader.desktop", "fanqie-app-device")
            .map_err(|_| "无法保存App会话")?
            .set_password(&v)
            .map_err(|_| "无法保存App会话；已停止重复注册")?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        if cfg!(debug_assertions) {
            if let Ok(p) = std::env::var("TOMATO_DEVICE_STATE") {
                std::fs::write(&p, v).map_err(|_| "无法保存验证会话")?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
                }
            }
        }
    }
    Ok(())
}
impl AppContent {
    pub(crate) fn new(t: Arc<Transport>) -> Self {
        Self {
            client: Client::builder()
                .https_only(true)
                .timeout(Duration::from_secs(40))
                .redirect(Policy::none())
                .build()
                .expect("App client"),
            transport: t,
            state: Mutex::new(State {
                device: load_device(),
                key: None,
                cursors: HashMap::new(),
                versions: HashMap::new(),
            }),
        }
    }
    async fn parse(mut r: reqwest::Response) -> Result<Value, String> {
        if !r.status().is_success() {
            return Err(format!("官方App返回HTTP {}", r.status().as_u16()));
        }
        if r.headers().contains_key("bdturing-verify") {
            return Err("官方要求人机验证，已停止请求".into());
        }
        if r.content_length().is_some_and(|n| n > 2 * 1024 * 1024) {
            return Err("官方数据过大".into());
        }
        let mut b = vec![];
        while let Some(x) = r.chunk().await.map_err(|_| "官方数据读取失败")? {
            if b.len() + x.len() > 2 * 1024 * 1024 {
                return Err("官方数据过大".into());
            }
            b.extend(x);
        }
        if b.is_empty() {
            return Err("官方App返回空响应；本次没有自动重试或更换设备".into());
        }
        serde_json::from_slice(&b).map_err(|_| "官方App返回非JSON数据，可能需要验证".into())
    }
    async fn ensure_device(&self, s: &mut State) -> Result<(), String> {
        if s.device.is_some() {
            return Ok(());
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "系统时间错误")?
            .as_millis() as u64;
        let uid = || c::hex(&c::random(16));
        let v = json!({"magic_tag":"ss_app_log","header":{"display_name":"番茄免费小说","aid":1967,"channel":"43536163a","package":"com.dragon.read","sdk_version":"3.7.0-rc.25-fanqie-xiaoshuo","sdk_target_version":29,"git_hash":"711d1a7","density_dpi":240,"display_density":"hdpi","resolution":"720x1280","language":"zh","timezone":8,"access":"wifi","region":"CN","tz_name":"Asia/Shanghai","tz_offset":28800,"sim_region":"cn","sim_serial_number":[],"oaid_may_support":false,"device_platform":"android","custom":{"host_bit":32,"dragon_device_type":0},"sdk_flavor":"china","guest_mode":0,"os":"Android","os_version":"10","os_api":29,"device_model":"P30","device_brand":"Huawei","device_manufacturer":"Huawei","cpu_abi":"arm64-v8a","release_build":"711d1a7","cdid":uid(),"sig_hash":"a4a27c2633195374c15651ffc3c4a497","openudid":uid(),"clientudid":uid(),"req_id":uid(),"apk_first_install_time":now},"_gen_time":now});
        let r = self
            .transport
            .send(
                self.client
                    .post("https://i.snssdk.com/service/2/device_register/?tt_data=a")
                    .header("User-Agent", "okhttp/4.10.0")
                    .header("Content-Type", "application/octet-stream; tt-data=a")
                    .body(c::device_body(&v)?),
            )
            .await?;
        let v = Self::parse(r).await?;
        let (a, b) = (id(&v["device_id_str"]), id(&v["install_id_str"]));
        check(&a).map_err(|_| "设备注册未成功")?;
        check(&b).map_err(|_| "设备注册未成功")?;
        s.device = Some((a.clone(), b.clone()));
        persist(&a, &b)
    }
    async fn request(
        &self,
        s: &mut State,
        path: &str,
        extra: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value, String> {
        self.ensure_device(s).await?;
        let (a, b) = s.device.as_ref().unwrap();
        let query = {
            let mut q = url::form_urlencoded::Serializer::new(String::new());
            for (k, v) in [
                ("iid", b.as_str()),
                ("device_id", a.as_str()),
                ("ac", "wifi"),
                ("channel", "43536163a"),
                ("aid", "1967"),
                ("app_name", "novelapp"),
                ("version_code", "70132"),
                ("version_name", "7.0.1.32"),
                ("device_platform", "android"),
                ("os", "android"),
                ("ssmix", "a"),
                ("os_version", "10"),
                ("device_type", "P30"),
                ("device_brand", "Huawei"),
                ("update_version_code", "70132"),
                ("manifest_version_code", "70132"),
            ] {
                q.append_pair(k, v);
            }
            for (k, v) in extra {
                q.append_pair(k, v);
            }
            q.finish()
        };
        let payload = body.as_ref().map(Value::to_string).unwrap_or_default();
        let u = format!("https://reading.snssdk.com{path}?{query}");
        let mut r = if body.is_some() {
            self.client
                .post(u)
                .header("Content-Type", "application/json; charset=utf-8")
                .body(payload.clone())
        } else {
            self.client.get(u)
        };
        for (k, v) in c::sign(&query, payload.as_bytes())? {
            r = r.header(k, v);
        }
        let v = Self::parse(
            self.transport
                .send(
                    r.header("User-Agent", "com.dragon.read")
                        .header("Accept", "application/json"),
                )
                .await?,
        )
        .await?;
        let code = v.get("code").or_else(|| v.get("Code"));
        if !code.is_some_and(|v| v.as_i64() == Some(0) || v.as_str() == Some("0")) {
            return Err(format!(
                "官方App未成功（代码{}），本次没有自动重试",
                code.map(id).unwrap_or_default()
            ));
        }
        Ok(v)
    }
    pub async fn chapter(&self, item: &str) -> Result<Value, String> {
        check(item)?;
        let mut s = self.state.lock().await;
        if s.key.is_none() {
            self.ensure_device(&mut s).await?;
            let a = s.device.as_ref().unwrap().0.clone();
            let v = self
                .request(
                    &mut s,
                    "/reading/crypt/registerkey",
                    &[],
                    Some(c::key_body(&a)?),
                )
                .await?;
            let key = c::session_key(v["data"]["key"].as_str().ok_or("未取得正常正文会话")?)?;
            if key.len() != 16 {
                return Err("正文会话格式错误".into());
            }
            s.key = Some((key, id(&v["data"]["keyver"])));
        }
        let v = self
            .request(
                &mut s,
                "/reading/reader/full/v",
                &[("item_id", item), ("req_type", "1")],
                None,
            )
            .await?;
        let d = &v["data"];
        let meta = &d["novel_data"];
        if id(&meta["item_id"]) != item {
            return Err("正文与所选章节不一致".into());
        }
        if meta.get("need_pay").is_none() || num(&meta["need_pay"]) != 0 {
            return Err("本章需要官方阅读权限，请在官方App处理".into());
        }
        let (key, ver) = s.key.as_ref().unwrap();
        let content = d["content"].as_str().ok_or("官方未返回正文")?;
        if content == "Invalid" || id(&d["key_version"]) != *ver {
            s.key = None;
            return Err("正文会话过期，请重新打开本章；本次没有自动重试".into());
        }
        let text = c::chapter(content, key, num(&d["compress_status"]) == 1)?;
        let text = if text.trim_start().starts_with('<') {
            text
        } else {
            let v: Value = serde_json::from_str(&text).map_err(|_| "正文结构不支持")?;
            ["content", "html", "body"]
                .iter()
                .find_map(|k| v[*k].as_str())
                .ok_or("正文结构不支持")?
                .into()
        };
        if text.is_empty() || text.chars().any(|c| ('\u{e000}'..='\u{f8ff}').contains(&c)) {
            return Err("本章正文不完整或编码不支持".into());
        }
        let n = num(&d["paragraphs_num"]);
        #[cfg(test)]
        if std::env::var("TOMATO_DIAGNOSE_CHAPTER").ok().is_some_and(|items|items.split(',').any(|id|id==item)) {
            let mut diagnostic = crate::chapter_html::diagnose(&text, n);
            for field in ["free_para_nums", "parse_mode", "text_type"] { diagnostic[field] = d[field].clone(); }
            let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-output/chapter-structures");
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join(format!("{item}.json")),serde_json::to_vec_pretty(&diagnostic).unwrap()).unwrap();
            diagnostic.as_object_mut().unwrap().remove("structuralHtml");
            println!("Chapter structure only: {}",diagnostic);
        }
        crate::chapter_html::validate(&text, n, d.get("free_para_nums").map(num))?;
        Ok(
            json!({"id":item,"title":d["title"].as_str().unwrap_or(""),"content":text,"loaded":true,"itemVersion":id(d.get("item_version").unwrap_or(&meta["item_version"]))}),
        )
    }
    pub async fn comments(&self, book: &str, page: u32) -> Result<Value, String> {
        check(book)?;
        if page == 0 || page > 500 {
            return Err("页码无效".into());
        }
        let mut s = self.state.lock().await;
        let mut b = json!({"business_param":{"book_id":book,"need_count":true,"fold_type":1},"comment_source":1,"comment_type":2,"count":20,"group_id":book,"group_type":1,"server_channel":5,"sort":1});
        if page > 1 {
            b["cursor"] = json!(s
                .cursors
                .get(&(book.into(), page))
                .ok_or("请从第一页按顺序加载")?);
        }
        let v = self
            .request(
                &mut s,
                &format!("/novel/commentapi/comment/list/{book}/v1"),
                &[],
                Some(b),
            )
            .await?;
        let d = &v["data"];
        let i = &d["common_list_info"];
        if s.cursors.len() > 1000 {
            s.cursors.clear();
        }
        if i["has_more"].as_bool() == Some(true) {
            s.cursors.insert((book.into(), page + 1), id(&i["cursor"]));
        }
        let a = d["data_list"]
            .as_array()
            .ok_or("书评结构已变化")?
            .iter()
            .filter_map(|x| x.get("comment"))
            .map(normalize)
            .collect::<Vec<_>>();
        Ok(
            json!({"comments":a,"total":num(&i["total"]),"hasMore":i["has_more"].as_bool().unwrap_or(false),"source":"official-app"}),
        )
    }
    pub async fn replies(
        &self,
        book: &str,
        parent: &str,
        cursor: Option<&str>,
    ) -> Result<Value, String> {
        check(book)?;
        check(parent)?;
        let mut s = self.state.lock().await;
        let mut b = json!({"business_param":{"book_id":book,"need_count":true},"comment_id":parent,"comment_source":501,"comment_type":2,"count":20,"group_id":book,"group_type":1});
        if let Some(x) = cursor {
            if x.len() > 4096 {
                return Err("分页参数过长".into());
            }
            b["cursor"] = json!(x);
        }
        let v = self
            .request(
                &mut s,
                &format!("/novel/commentapi/reply/list/{parent}/v1"),
                &[],
                Some(b),
            )
            .await?;
        let d = &v["data"];
        if id(&d["comment"]["comment_id"]) != parent {
            return Err("回复与书评不一致".into());
        }
        let a = d["reply_list"]
            .as_array()
            .ok_or("回复结构已变化")?
            .iter()
            .map(normalize)
            .collect::<Vec<_>>();
        let i = &d["comment_list_info"];
        Ok(
            json!({"comment":normalize(&d["comment"]),"replies":a,"source":"official-app","complete":!i["has_more"].as_bool().unwrap_or(false),"hasMore":i["has_more"].as_bool().unwrap_or(false),"nextCursor":id(&i["cursor"]),"total":num(&i["total"])}),
        )
    }
    pub async fn audio(&self, item: &str) -> Result<Value, String> {
        self.audio_with_tone(item, "0").await
    }
    pub async fn paragraph_counts(&self, item: &str, version: &str) -> Result<Value, String> {
        check(item)?;
        check_version(version)?;
        let mut state = self.state.lock().await;
        let value = self.request(&mut state, &format!("/novel/commentapi/idea/list/{item}/v1/"), &[],
            Some(json!({"comment_source":3,"compliance_status":0,"item_id":item,"item_version":version,"server_channel":7}))).await?;
        let data = &value["data"];
        let buckets = data["data"].as_object().ok_or("官方段评计数格式已变化")?;
        let mut counts = serde_json::Map::new();
        for (key, bucket) in buckets {
            if key.parse::<u32>().is_ok_and(|v| v <= 100000) && num(&bucket["count"]) > 0 {
                counts.insert(key.clone(), json!(num(&bucket["count"])));
            }
        }
        Ok(json!({"chapterId":item,"itemVersion":id(&data["item_version"]),"counts":counts}))
    }
    pub async fn paragraph_comments(&self, book: &str, item: &str, para: u32, version: &str, cursor: &str) -> Result<Value, String> {
        check(book)?; check(item)?; check_version(version)?;
        if para > 100000 || cursor.len() > 4096 { return Err("段评参数无效，请刷新本章后重试".into()); }
        let mut state = self.state.lock().await;
        let mut version = version.to_string();
        if version.is_empty() {
            if !state.versions.contains_key(item) {
                let directory = self.request(&mut state, "/reading/bookapi/directory/all_items/v", &[("book_id",book),("need_version","true")], None).await?;
                if state.versions.len() > 50000 { state.versions.clear(); }
                for key in ["item_data_list", "catalog_data", "items"] {
                    if let Some(items) = directory["data"][key].as_array() {
                        for entry in items {
                            let item_id = id(entry.get("item_id").or_else(||entry.get("catalog_id")).unwrap_or(&entry["id"]));
                            let version = id(entry.get("item_version").unwrap_or(&entry["version"]));
                            if check(&item_id).is_ok() && !version.is_empty() && check_version(&version).is_ok() { state.versions.insert(item_id, version); }
                        }
                    }
                }
            }
            version = state.versions.get(item).cloned().ok_or("官方未返回本章版本，请刷新目录后重试")?;
        }
        let mut body = json!({"business_param":{"book_id":book,"fold_type":1,"item_version":version,"para_index":para,"need_count":cursor.is_empty(),"item_count":0,"req_type":0},"comment_source":2,"comment_type":1,"group_id":item,"group_type":15,"server_channel":38,"sort":1,"count":20});
        if !cursor.is_empty() { body["cursor"] = json!(cursor); }
        let value = self.request(&mut state, &format!("/novel/commentapi/comment/list/{item}/v1/"), &[], Some(body)).await?;
        normalize_paragraph_page(&value, item, para)
    }
    pub async fn paragraph_replies(&self, book: &str, item: &str, comment: &str, cursor: &str) -> Result<Value, String> {
        check(book)?; check(item)?; check(comment)?;
        if cursor.len() > 4096 { return Err("分页参数过长".into()); }
        let mut state = self.state.lock().await;
        let value = self.request(&mut state, &format!("/novel/commentapi/reply/list/{comment}/v1/"), &[],
            Some(json!({"business_param":{"book_id":book,"need_count":true},"comment_id":comment,"comment_source":502,"comment_type":1,"count":20,"group_id":item,"group_type":15,"cursor":cursor}))).await?;
        let data = &value["data"];
        if id(&data["comment"]["comment_id"]) != comment { return Err("段评回复与所选评论不一致".into()); }
        let rows = data["reply_list"].as_array().ok_or("段评回复格式已变化")?;
        let info = &data["comment_list_info"];
        Ok(json!({"comments":rows.iter().map(normalize).collect::<Vec<_>>(),"hasMore":info["has_more"].as_bool().unwrap_or(false),"nextCursor":id(&info["cursor"]),"total":num(&info["total"]),"chapterId":item,"commentId":comment}))
    }
    pub async fn audio_alignment(&self, item: &str, album: &str) -> Result<Value, String> {
        check(item)?;
        check(album)?;
        let mut state = self.state.lock().await;
        let value = self.request(&mut state, "/reading/reader/audio/timepoint/", &[("item_id", item), ("tone_id", "0")], None).await?;
        normalize_alignment(&value, item, album)
    }
    pub async fn audio_with_tone(&self, item: &str, tone: &str) -> Result<Value, String> {
        check(item)?;
        if tone.is_empty() || tone.len() > 10 || !tone.bytes().all(|b| b.is_ascii_digit()) {
            return Err("官方音色ID格式错误".into());
        }
        let mut s = self.state.lock().await;
        let v = self
            .request(
                &mut s,
                "/reading/reader/audio/playinfo/",
                &[("item_ids", item), ("tone_id", tone)],
                None,
            )
            .await?;
        drop(s);
        let row = v["data"]
            .as_array()
            .and_then(|a| a.iter().find(|x| id(&x["item_id"]) == item))
            .ok_or("官方没有提供本集音频")?;
        let u = Url::parse(row["main_url"].as_str().ok_or("没有媒体地址")?)
            .map_err(|_| "音频地址无效")?;
        if !media_host(&u) {
            return Err(format!(
                "音频地址不是已验证的官方媒体主机（{}）",
                u.host_str().unwrap_or("未知")
            ));
        }
        let mut r = self
            .transport
            .send(self.client.get(u).header("User-Agent", "com.dragon.read"))
            .await?;
        if !r.status().is_success() {
            return Err("官方音频加载失败".into());
        }
        if r.content_length().is_some_and(|n| n > 32 * 1024 * 1024) {
            return Err("本集超过32MB，当前暂不支持".into());
        }
        let mut data = vec![];
        while let Some(x) = r.chunk().await.map_err(|_| "音频加载中断")? {
            if data.len() + x.len() > 32 * 1024 * 1024 {
                return Err("本集超过32MB，当前暂不支持".into());
            }
            data.extend(x);
        }
        let data = if row["is_encrypt"].as_bool() == Some(true) {
            app_media::clear_audio(
                data,
                &c::media_key(row["encryption_key"].as_str().ok_or("音频播放参数缺失")?)?,
            )?
        } else {
            data
        };
        Ok(json!({"itemId":item,"toneId":tone,"urls":[],"audioBase64":c::encode(&data),"mime":"audio/mp4"}))
    }
}
fn media_host(u: &Url) -> bool {
    u.scheme() == "https"
        && u.username().is_empty()
        && u.password().is_none()
        && u.port_or_known_default() == Some(443)
        && u.host_str()
            .is_some_and(|h| h.ends_with(".fqnovelvod.com") || h == "v3-novelapp.ixigua.com")
}
fn normalize_alignment(value: &Value, item: &str, album: &str) -> Result<Value, String> {
    let data = &value["para_match_data"];
    let Some(rows) = data["text_para_match_data"][album].as_array() else {
        return Ok(json!({"matched":false,"chapterId":item,"albumId":album}));
    };
    for row in rows {
        let episode = id(&row["item_id"]);
        let Some(index) = row["item_idx"].as_u64().filter(|n| *n < 100000) else { continue; };
        let Some(ms) = row["start_time"].as_f64().filter(|v| v.is_finite() && *v >= 0.0 && *v <= 86400000.0) else { continue; };
        if check(&episode).is_err() || id(&data["item_ids"][album][index.to_string()]) != episode { continue; }
        return Ok(json!({"matched":true,"chapterId":item,"albumId":album,"episodeId":episode,"episodeIndex":index,"seconds":ms / 1000.0}));
    }
    Err("官方章节对应数据不完整，未自动定位有声集数".into())
}
fn check_version(value: &str) -> Result<(), String> {
    if value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) { Ok(()) } else { Err("正文版本参数无效".into()) }
}
fn normalize_paragraph_page(value: &Value, item: &str, para: u32) -> Result<Value, String> {
    let data = &value["data"];
    let rows = data["data_list"].as_array().ok_or("官方段评列表格式已变化")?;
    let info = &data["common_list_info"];
    Ok(json!({"chapterId":item,"paragraphId":para,"comments":rows.iter().filter_map(|r|r.get("comment")).map(normalize).collect::<Vec<_>>(),"total":num(&info["total"]),"hasMore":info["has_more"].as_bool().unwrap_or(false),"nextCursor":id(&info["cursor"])}))
}
fn normalize(v: &Value) -> Value {
    let common = v
        .get("common")
        .or_else(|| v.get("Common"))
        .unwrap_or(&Value::Null);
    let content = &common["content"];
    let user = &common["user_info"]["base_info"];
    let children = v["sub_reply"]
        .as_array()
        .map(|a| {
            a.iter()
                .take(100)
                .map(|x| {
                    let mut x = x.clone();
                    x["sub_reply"] = Value::Null;
                    normalize(&x)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut images = Vec::new();
    collect_images(&content["image_urls"], 0, &mut images);
    collect_images(&content["image_data_list"], 0, &mut images);
    images.sort();
    images.dedup();
    json!({"id":id(v.get("comment_id").or_else(||v.get("reply_id")).unwrap_or(&Value::Null)),"name":user["user_name"].as_str().unwrap_or("书友"),"text":content["text"].as_str().unwrap_or(""),"userId":id(&user["user_id"]),"createdAt":num(&common["create_timestamp"]),"likes":num(&v["stat"]["digg_count"]),"replies":num(&v["stat"]["reply_count"]),"images":images,"children":children,"replyTo":v["reply_to_user_info"]["base_info"]["user_name"].as_str().unwrap_or("")})
}
fn collect_images(v: &Value, depth: usize, out: &mut Vec<String>) {
    if depth > 4 || out.len() >= 20 {
        return;
    }
    match v {
        Value::String(s) if s.len() < 8192 && s.starts_with("https://") => out.push(s.clone()),
        Value::Array(a) => {
            for x in a.iter().take(100) {
                collect_images(x, depth + 1, out);
            }
        }
        Value::Object(a) => {
            for x in a.values().take(30) {
                collect_images(x, depth + 1, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "Explicit read-only diagnosis of a user-reported free chapter"]
    async fn live_chapter_structure() {
        let items = std::env::var("TOMATO_DIAGNOSE_CHAPTER").expect("explicit chapter IDs required");
        let app = AppContent::new(Arc::new(Transport::default()));
        let mut failures = Vec::new();
        for item in items.split(',') {
            match app.chapter(item).await {
                Ok(v) => println!("Chapter {item}: loaded={}, content bytes={}", v["loaded"], v["content"].as_str().unwrap_or_default().len()),
                Err(e) if e == "官方正文段落不完整，未标记已读" => {
                    println!("Chapter {item}: structure rejected"); failures.push(item.to_owned());
                }
                Err(e) => panic!("Chapter {item}: {e}; stopping without retries"),
            }
        }
        assert!(failures.is_empty(), "Rejected chapters: {:?}", failures);
    }

    #[test]
    fn recorded_alignment_keeps_exact_ids_and_milliseconds() {
        let raw = json!({"para_match_data":{"item_ids":{"7325015266541423678":{"728":7417131808128830488u64}},"text_para_match_data":{"7325015266541423678":[{"item_id":7417131808128830488u64,"item_idx":728,"start_time":227170}]}}});
        let result = normalize_alignment(&raw, "7399337929476162072", "7325015266541423678").unwrap();
        assert_eq!(result["episodeId"], "7417131808128830488");
        assert_eq!(result["episodeIndex"], 728);
        assert_eq!(result["seconds"], 227.17);
        assert_eq!(normalize_alignment(&raw, "7399337929476162072", "999999").unwrap()["matched"], false);
        let mut invalid = raw.clone();
        invalid["para_match_data"]["item_ids"]["7325015266541423678"]["728"] = json!("999999");
        assert!(normalize_alignment(&invalid, "7399337929476162072", "7325015266541423678").is_err());
    }
    #[test]
    fn paragraph_page_preserves_parent_and_cursor() {
        let raw = json!({"data":{"data_list":[{"comment":{"comment_id":7417131808128830488u64,"common":{"content":{"text":"段评"},"user_info":{"base_info":{"user_name":"书友"}}},"stat":{"digg_count":8,"reply_count":2}}}],"common_list_info":{"total":21,"has_more":true,"cursor":9007199254740993u64}}});
        let page = normalize_paragraph_page(&raw, "7399337929476162072", 4).unwrap();
        assert_eq!(page["paragraphId"], 4);
        assert_eq!(page["comments"][0]["id"], "7417131808128830488");
        assert_eq!(page["comments"][0]["replies"], 2);
        assert_eq!(page["nextCursor"], "9007199254740993");
        assert!(normalize_paragraph_page(&json!({"data":{}}), "7399337929476162072", 4).is_err());
    }
    #[tokio::test]
    async fn tts_rejects_invalid_parameters_without_network() {
        let app = AppContent::new(Arc::new(Transport::default()));
        for tone in ["", "-1", "74&item_ids=123456", "1.5", "12345678901"] {
            assert!(app.audio_with_tone("7083521020400763392", tone).await.unwrap_err().contains("音色ID"));
        }
        assert!(app.audio_with_tone("not-a-chapter", "74").await.unwrap_err().contains("ID格式"));
    }
    #[test]
    fn app_comments_keep_images_and_nested_replies() {
        let raw = json!({"comment_id":"123456","common":{"content":{"text":"review","image_data_list":[{"image":{"url_list":["https://p3-novel.byteimg.com/test.png"]}}]}},"sub_reply":[{"reply_id":"234567","Common":{"content":{"text":"reply"}}}]});
        let v = normalize(&raw);
        assert_eq!(v["images"][0], "https://p3-novel.byteimg.com/test.png");
        assert_eq!(v["children"][0]["text"], "reply");
    }
    #[test]
    fn reject_untrusted_media() {
        for s in [
            "http://v3-novelapp.ixigua.com/x",
            "https://v3-novelapp.ixigua.com.evil.test/x",
            "https://foo.fqnovelvod.com:123/x",
            "https://u:p@v3-novelapp.ixigua.com/x",
        ] {
            assert!(!media_host(&Url::parse(s).unwrap()));
        }
        assert!(media_host(
            &Url::parse("https://v3-novelapp.ixigua.com/x").unwrap()
        ));
    }
}
