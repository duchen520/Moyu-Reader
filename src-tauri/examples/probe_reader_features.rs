//! One-chapter read-only validation. No progress writes.
use tomato_reader_lib::official::OfficialService;
#[tokio::main]
async fn main() -> Result<(), String> {
    let s = OfficialService::default();
    let item = "7399337929476162072";
    let chapter = s.chapter(item).await?;
    println!("chapter version {}", chapter["itemVersion"]);
    std::fs::write("test-output/paragraph-chapter.json", chapter.to_string()).map_err(|_| "Save failed")?;
    let counts = s.paragraph_counts(item, chapter["itemVersion"].as_str().unwrap_or("")).await?;
    println!("counts {}", counts);
    std::fs::write("test-output/paragraph-counts.json", counts.to_string()).map_err(|_| "Save failed")?;
    let version = counts["itemVersion"].as_str().filter(|v| !v.is_empty()).or(chapter["itemVersion"].as_str()).ok_or("No version")?;
    if let Some((para, _)) = counts["counts"].as_object().and_then(|m|m.iter().next()) {
        let comments = s.paragraph_comments("7255936586997566505", item, para.parse().map_err(|_| "Bad para")?, version, "").await?;
        println!("comments total={} firstPage={} more={}", comments["total"], comments["comments"].as_array().map_or(0,Vec::len), comments["hasMore"]);
        std::fs::write("test-output/paragraph-comments.json", comments.to_string()).map_err(|_| "Save failed")?;
    }
    let alignment = s.audio_alignment("7255936586997566505", item, "7325015266541423678").await?;
    println!("alignment {}", alignment);
    let page = s.paragraph_comments("7255936586997566505", item, 97, version, "").await?;
    println!("last paragraph total={} first={} more={}", page["total"], page["comments"].as_array().map_or(0,Vec::len), page["hasMore"]);
    if page["hasMore"] == true {
        let second = s.paragraph_comments("7255936586997566505", item, 97, version, page["nextCursor"].as_str().ok_or("Missing cursor")?).await?;
        println!("second page count={}", second["comments"].as_array().map_or(0,Vec::len));
    }
    if let Some(comment) = page["comments"].as_array().and_then(|a| a.iter().find(|c| c["replies"].as_i64().unwrap_or(0) > 0)) {
        let replies = s.paragraph_replies("7255936586997566505", item, comment["id"].as_str().ok_or("Missing comment id")?, "").await?;
        println!("replies total={} first={}", replies["total"], replies["comments"].as_array().map_or(0,Vec::len));
    }
    Ok(())
}
