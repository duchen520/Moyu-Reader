//! Targeted continuation: only the two unfinished reads, one attempt each.
//! IDs come from the retained v0.3 directory and public review response.
use serde_json::json;
use tomato_reader_lib::official::OfficialService;

#[tokio::main]
async fn main() {
    let service = OfficialService::default();
    match service
        .comment_details(
            "7069948840148732967",
            "7203370909527261989",
            "4274557566852590",
        )
        .await
    {
        Ok(j) => println!(
            "{}",
            json!({
                "feature":"public-comment-detail", "success":true,
                "images":j["comment"]["images"].as_array().map_or(0,Vec::len),
                "reported_replies":j["comment"]["replies"],
                "visible_replies":j["replies"].as_array().map_or(0,Vec::len),
                "complete":j["complete"], "attempts":1
            })
        ),
        Err(e) => println!(
            "{}",
            json!({"feature":"public-comment-detail","success":false,"error":e,"attempts":1})
        ),
    }
    match service.audio_play("7281123825041804322").await {
        Ok(j) => println!(
            "{}",
            json!({"feature":"audio-play-info","success":true,"candidates":j["urls"].as_array().map_or(0,Vec::len),"actual_playback_verified":false,"attempts":1})
        ),
        Err(e) => println!(
            "{}",
            json!({"feature":"audio-play-info","success":false,"error":e,"actual_playback_verified":false,"attempts":1})
        ),
    }
}
