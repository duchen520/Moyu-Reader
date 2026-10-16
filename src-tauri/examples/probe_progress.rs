//! Read-only diagnosis using the normal locally saved session. No cloud writes.
#[cfg(debug_assertions)]
use tomato_reader_lib::official::OfficialService;
#[cfg(debug_assertions)]
#[tokio::main]
async fn main() {
    let service = OfficialService::default();
    match service.diagnose_progress().await {
        Ok(mut data) => {
            if let Some(book_id) = std::env::args().nth(1) {
                match service.book(&book_id).await {
                    Ok(book) => {
                        let chapters = book["chapters"].as_array().unwrap();
                        let item = data["webProgress"].as_array().unwrap().iter().find(|p| p["fields"]["book_id"].as_str() == Some(&book_id)).and_then(|p| p["fields"]["item_id"].as_str()).unwrap_or("");
                        let current = chapters.iter().position(|c| c["id"].as_str() == Some(item));
                        data["bookSummary"] = serde_json::json!({"title":book["title"],"chapterCount":chapters.len(),"serverChapterIndex":current,"serverChapterTitle":current.map(|i|&chapters[i]["title"])});
                        match service.diagnose_read_items(&book_id).await {
                            Ok(items) => {
                                let ids: Vec<String> = items.as_array().into_iter().flatten().map(|v| {
                                    let v = v.get("item_id").unwrap_or(v);
                                    v.as_str().map(str::to_string).unwrap_or_else(||v.to_string())
                                }).collect();
                                let furthest = chapters.iter().enumerate().filter(|(_,c)| ids.iter().any(|id| c["id"].as_str()==Some(id))).map(|(i,_)|i).max();
                                data["readHistorySummary"]=serde_json::json!({"isArray":items.is_array(),"count":ids.len(),"furthestKnownIndex":furthest,"furthestKnownTitle":furthest.map(|i|&chapters[i]["title"])});
                            }
                            Err(error) => data["readHistoryError"]=serde_json::json!(error),
                        }
                    }
                    Err(error) => data["bookError"]=serde_json::json!(error),
                }
            }
            println!("{}", serde_json::to_string_pretty(&data).unwrap());
        }
        Err(error) => { eprintln!("{error}"); std::process::exit(1); }
    }
}
#[cfg(not(debug_assertions))]
fn main() { eprintln!("请使用调试构建运行此只读诊断工具"); std::process::exit(2); }
