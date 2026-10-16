//! Explicit read-only check of public rankings using the app's normal session.
use tomato_reader_lib::official::OfficialService;
#[tokio::main]
async fn main() -> Result<(), String> {
    let service = OfficialService::default();
    let start = std::time::Instant::now();
    let catalog = service.ranking_categories().await?;
    let first = service.rankings(1, 2, "257", 0, "").await?;
    let second = service.rankings(1, 2, "257", 10, first["version"].as_str().ok_or("Version missing")?).await?;
    let last = service.rankings(1, 2, "257", 90, first["version"].as_str().ok_or("Version missing")?).await?;
    assert_eq!(second["books"][0]["rank"], 11);
    assert!(first["books"].as_array().unwrap().iter().all(|book| book["metadataMissing"] == false));
    assert_eq!(last["books"][0]["rank"], 91);
    assert_eq!(last["books"].as_array().unwrap().last().unwrap()["rank"], 100);
    assert_eq!(last["hasMore"], false);
    println!("{}", serde_json::json!({"elapsedMs":start.elapsed().as_millis(),"maleCategories":catalog["male"].as_array().unwrap().len(),
        "femaleCategories":catalog["female"].as_array().unwrap().len(),"firstPage":first["books"].as_array().unwrap().len(),
        "secondPage":second["books"].as_array().unwrap().len(),"total":first["total"],"version":first["version"],
        "firstTitle":first["books"][0]["title"],"secondPageFirstRank":second["books"][0]["rank"],"lastRank":last["books"].as_array().unwrap().last().unwrap()["rank"]}));
    Ok(())
}
