//! Opt-in one-pass live validation. No plaintext, credentials or URLs are printed.
use serde_json::json;
use tomato_reader_lib::official::OfficialService;
#[tokio::main]
async fn main() -> Result<(), String> {
    if std::env::var("TOMATO_LIVE_VALIDATION").as_deref() != Ok("1")
        || std::env::var("TOMATO_DEVICE_STATE").is_err()
    {
        return Err("Explicit private validation environment required".into());
    }
    let s = OfficialService::default();
    let chapter = s.chapter("7083521020400763392").await?;
    println!(
        "Native chapter: loaded={}, paragraphs={}",
        chapter["loaded"],
        chapter["content"]
            .as_str()
            .unwrap_or("")
            .matches("<p")
            .count()
    );
    let comments = s.comments("7069948840148732967", 1).await?;
    let second = s.comments("7069948840148732967", 2).await?;
    println!(
        "Native comments: page1={}, page2={}",
        comments["comments"].as_array().map_or(0, Vec::len),
        second["comments"].as_array().map_or(0, Vec::len)
    );
    let replies = s
        .comment_details("7069948840148732967", "7466785233132946238", "")
        .await?;
    println!(
        "Native replies: count={}",
        replies["replies"].as_array().map_or(0, Vec::len)
    );
    let audio = s.audio_play("7281123825041804322").await?;
    println!(
        "Native audio: base64 bytes={}",
        audio["audioBase64"].as_str().map_or(0, str::len)
    );
    if let Ok(p) = std::env::var("TOMATO_PRIVATE_VALIDATION_OUTPUT") {
        std::fs::write(p,json!({"chapter":chapter,"comments":comments,"second":second,"replies":replies,"audio":audio}).to_string()).map_err(|_|"Cannot save private result")?;
    }
    Ok(())
}
