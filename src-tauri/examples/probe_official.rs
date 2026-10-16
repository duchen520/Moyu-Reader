//! Opt-in anonymous live probe. Never prints QR image, token, cookies or account details.
use tomato_reader_lib::official::OfficialService;
#[tokio::main]
async fn main() {
    let service = OfficialService::default();
    match service.start_login().await {
        Ok(q) => {
            println!(
                "QR: image_present={}, lifetime_present={}",
                q["imageDataUrl"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("data:image/png;base64,")),
                q["expiresInSeconds"].as_u64().is_some()
            );
            match service.poll_login().await {
                Ok(p) => println!("QR poll: {}", p["stage"]),
                Err(e) => println!("QR poll: {e}"),
            }
            service.cancel_login().await;
        }
        Err(e) => println!("QR: {e}"),
    }
    match service.comments("7069948840148732967", 1).await {
        Ok(c) => println!(
            "Book reviews: page_count={}, total_present={}",
            c["comments"].as_array().map_or(0, Vec::len),
            c["total"].is_number()
        ),
        Err(e) => println!("Book reviews: {e}"),
    }
    match service.book("7069948840148732967").await {
        Ok(b) => println!(
            "Directory: count={}",
            b["chapters"].as_array().map_or(0, Vec::len)
        ),
        Err(e) => println!("Book metadata/directory: {e}"),
    }
    match service.chapter("7696470987247731224").await {
        Ok(c) => println!(
            "Chapter: text_returned={}",
            c["content"].as_str().is_some_and(|s| !s.is_empty())
        ),
        Err(e) => println!("Chapter: {e}"),
    }
}
