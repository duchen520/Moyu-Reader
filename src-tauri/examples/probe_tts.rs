//! Read-only official voice discovery / optional single-chapter playback check.
use tomato_reader_lib::official::OfficialService;
#[tokio::main]
async fn main() -> Result<(), String> {
    let service = OfficialService::default();
    let catalog = service.audio_catalog("7069948840148732967").await?;
    println!("{}", serde_json::json!({"albums":catalog["albums"].as_array().map_or(0, Vec::len),"tones":catalog["ttsTones"]}));
    if std::env::var("TOMATO_TEST_TTS_PLAY").as_deref() == Ok("1") {
        let preferred = std::env::var("TOMATO_TEST_TTS_TONE").unwrap_or_else(|_| "74".into());
        let tone = catalog["ttsTones"].as_array().and_then(|tones| tones.iter().find(|tone| tone["id"].as_str() == Some(&preferred))).and_then(|tone| tone["id"].as_str()).ok_or("Requested TTS voice is unavailable")?;
        let audio = service.tts_play("7069948840148732967", "7083521020400763392", tone).await?;
        println!("{}", serde_json::json!({"itemId":audio["itemId"],"toneId":audio["toneId"],"base64Bytes":audio["audioBase64"].as_str().map_or(0,str::len),"mime":audio["mime"]}));
        if let Ok(path) = std::env::var("TOMATO_TEST_TTS_OUTPUT") { std::fs::write(path, audio.to_string()).map_err(|_| "Cannot save playback fixture")?; }
    }
    Ok(())
}
