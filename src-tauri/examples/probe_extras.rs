//! Read-only live probe for v0.3. No credentials, image links, audio links or comment text are printed.
use tomato_reader_lib::official::OfficialService;
#[tokio::main]
async fn main() {
    let service = OfficialService::default();
    match service.search("部族荣光", 0).await {
        Ok(j) => println!(
            "Official search: {} results",
            j["books"].as_array().map_or(0, Vec::len)
        ),
        Err(e) => println!("Official search: {e}"),
    }
    if let Ok(page) = service.comments("7069948840148732967", 1).await {
        if let Some(c) = page["comments"].as_array().and_then(|a| a.first()) {
            let id = c["id"].as_str().unwrap_or("");
            let uid = c["userId"].as_str().unwrap_or("");
            match service
                .comment_details("7069948840148732967", id, uid)
                .await
            {
                Ok(j) => println!(
                    "Public comment detail: images={}, visible_replies={}, complete={}",
                    j["comment"]["images"].as_array().map_or(0, Vec::len),
                    j["replies"].as_array().map_or(0, Vec::len),
                    j["complete"]
                ),
                Err(e) => println!("Public comment detail: {e}"),
            }
        }
    }
    match service.audio_catalog("7069948840148732967").await {
        Ok(j) => {
            println!(
                "Official audio catalog: {} editions",
                j["albums"].as_array().map_or(0, Vec::len)
            );
            if let Some(a) = j["albums"].as_array().and_then(|a| a.first()) {
                match service.audio_episodes(a["id"].as_str().unwrap_or("")).await {
                    Ok(episodes) => {
                        println!(
                            "Official audio directory: {} episodes",
                            episodes.as_array().map_or(0, Vec::len)
                        );
                        if let Some(e) = episodes.as_array().and_then(|a| a.first()) {
                            match service.audio_play(e["id"].as_str().unwrap_or("")).await {
                                Ok(j) => println!(
                                    "Plain audio response: {} candidates",
                                    j["urls"].as_array().map_or(0, Vec::len)
                                ),
                                Err(e) => println!("Audio playback NOT verified: {e}"),
                            }
                        }
                    }
                    Err(e) => println!("Official audio directory: {e}"),
                }
            }
        }
        Err(e) => println!("Official audio catalog: {e}"),
    }
}
