mod app_content;
mod app_crypto;
mod app_media;
pub mod official;
mod transport;
mod rankings;

#[cfg(feature = "desktop")]
mod desktop {
    use crate::official::OfficialService;
    use serde_json::Value;
    use tauri::{State, WebviewWindow};
    fn local_only(window: &WebviewWindow) -> Result<(), String> {
        if window.label() == "main" {
            Ok(())
        } else {
            Err("远程窗口不能访问本地账号服务".into())
        }
    }

    #[tauri::command]
    async fn official_account(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.account().await
    }
    #[tauri::command]
    async fn official_start_login(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.start_login().await
    }
    #[tauri::command]
    async fn official_poll_login(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.poll_login().await
    }
    #[tauri::command]
    async fn official_cancel_login(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
    ) -> Result<(), String> {
        local_only(&window)?;
        s.cancel_login().await;
        Ok(())
    }
    #[tauri::command]
    async fn official_logout(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
    ) -> Result<(), String> {
        local_only(&window)?;
        s.logout().await
    }
    #[tauri::command]
    async fn official_bookshelf(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.bookshelf().await
    }
    #[tauri::command]
    async fn official_book(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
        id: String,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.book(&id).await
    }
    #[tauri::command]
    async fn official_chapter(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
        id: String,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.chapter(&id).await
    }
    #[tauri::command]
    async fn official_read_progress(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.read_progress().await
    }
    #[tauri::command]
    async fn official_read_history(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
        book_id: String,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.read_history(&book_id).await
    }
    #[tauri::command]
    async fn official_sync_progress(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
        book_id: String,
        item_id: String,
        index: usize,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.sync_progress(&book_id, &item_id, index).await
    }
    #[tauri::command]
    async fn official_comments(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
        id: String,
        page: u32,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.comments(&id, page).await
    }

    #[tauri::command]
    async fn official_ranking_categories(window: WebviewWindow, s: State<'_, OfficialService>) -> Result<Value, String> {
        local_only(&window)?;
        s.ranking_categories().await
    }
    #[tauri::command]
    async fn official_rankings(window: WebviewWindow, s: State<'_, OfficialService>, gender: u8, mold: u8, category: String, offset: u32, version: String) -> Result<Value, String> {
        local_only(&window)?;
        s.rankings(gender, mold, &category, offset, &version).await
    }
    #[tauri::command]
    async fn official_search(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
        keyword: String,
        offset: u32,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.search(&keyword, offset).await
    }
    #[tauri::command]
    async fn official_comment_details(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
        book_id: String,
        comment_id: String,
        user_id: String,
        cursor: Option<String>,
    ) -> Result<Value, String> {
        local_only(&window)?;
        let _ = user_id;
        s.comment_replies(&book_id, &comment_id, cursor.as_deref())
            .await
    }
    #[tauri::command]
    async fn official_audio_catalog(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
        book_id: String,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.audio_catalog(&book_id).await
    }
    #[tauri::command]
    async fn official_audio_episodes(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
        album_id: String,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.audio_episodes(&album_id).await
    }
    #[tauri::command]
    async fn official_audio_play(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
        item_id: String,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.audio_play(&item_id).await
    }
    #[tauri::command]
    async fn official_tts_play(
        window: WebviewWindow,
        s: State<'_, OfficialService>,
        book_id: String,
        item_id: String,
        tone_id: String,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.tts_play(&book_id, &item_id, &tone_id).await
    }

    #[tauri::command]
    async fn official_audio_alignment(window: WebviewWindow, s: State<'_, OfficialService>, book_id: String, item_id: String, album_id: String) -> Result<Value, String> {
        local_only(&window)?;
        s.audio_alignment(&book_id, &item_id, &album_id).await
    }
    #[tauri::command]
    async fn official_paragraph_counts(window: WebviewWindow, s: State<'_, OfficialService>, item_id: String, item_version: String) -> Result<Value, String> {
        local_only(&window)?;
        s.paragraph_counts(&item_id, &item_version).await
    }
    #[tauri::command]
    async fn official_paragraph_comments(window: WebviewWindow, s: State<'_, OfficialService>, book_id: String, item_id: String, paragraph_id: u32, item_version: String, cursor: String) -> Result<Value, String> {
        local_only(&window)?;
        s.paragraph_comments(&book_id, &item_id, paragraph_id, &item_version, &cursor).await
    }
    #[tauri::command]
    async fn official_paragraph_replies(window: WebviewWindow, s: State<'_, OfficialService>, book_id: String, item_id: String, comment_id: String, cursor: String) -> Result<Value, String> {
        local_only(&window)?;
        s.paragraph_replies(&book_id, &item_id, &comment_id, &cursor).await
    }
    #[cfg_attr(mobile, tauri::mobile_entry_point)]
    pub fn run() {
        tauri::Builder::default()
            .manage(OfficialService::default())
            .invoke_handler(tauri::generate_handler![
                official_account,
                official_start_login,
                official_poll_login,
                official_cancel_login,
                official_logout,
                official_bookshelf,
                official_book,
                official_chapter,
                official_read_progress,
                official_read_history,
                official_sync_progress,
                official_comments,
                official_search,
                official_ranking_categories,
                official_rankings,
                official_comment_details,
                official_audio_catalog,
                official_audio_episodes,
                official_audio_play,
                official_tts_play,
                official_audio_alignment,
                official_paragraph_counts,
                official_paragraph_comments,
                official_paragraph_replies
            ])
            .run(tauri::generate_context!())
            .expect("error while running Tomato Reader");
    }
}
#[cfg(feature = "desktop")]
pub use desktop::run;
