#[cfg(feature = "desktop")]
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "official_account",
            "official_start_login",
            "official_poll_login",
            "official_cancel_login",
            "official_logout",
            "official_bookshelf",
            "official_book",
            "official_chapter",
            "official_read_progress",
            "official_read_history",
            "official_sync_progress",
            "official_comments",
            "official_search",
            "official_ranking_categories",
            "official_rankings",
            "official_comment_details",
            "official_audio_catalog",
            "official_audio_episodes",
            "official_audio_play",
            "official_tts_play",
            "official_audio_alignment",
            "official_paragraph_counts",
            "official_paragraph_comments",
            "official_paragraph_replies",
        ]),
    ))
    .expect("failed to build app permissions");
}
#[cfg(not(feature = "desktop"))]
fn main() {}
