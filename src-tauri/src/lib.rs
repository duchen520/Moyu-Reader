mod backups;
mod auto_update;
mod cover_cache;
mod local_tts;
mod chapter_html;
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
    async fn backup_create(window: WebviewWindow, service: State<'_, std::sync::Arc<crate::backups::Backups>>, payload: String, kind: String) -> Result<Value, String> {
        local_only(&window)?; let service = service.inner().clone();
        tauri::async_runtime::spawn_blocking(move || service.create(&payload, &kind)).await.map_err(|_| "备份保存任务失败")?
    }
    #[tauri::command]
    async fn backup_list(window: WebviewWindow, service: State<'_, std::sync::Arc<crate::backups::Backups>>) -> Result<Value, String> {
        local_only(&window)?; let service = service.inner().clone();
        tauri::async_runtime::spawn_blocking(move || service.list()).await.map_err(|_| "备份列表读取任务失败")?
    }
    #[tauri::command]
    async fn backup_load(window: WebviewWindow, service: State<'_, std::sync::Arc<crate::backups::Backups>>, id: String) -> Result<String, String> {
        local_only(&window)?; let service = service.inner().clone();
        tauri::async_runtime::spawn_blocking(move || service.load(&id)).await.map_err(|_| "备份读取任务失败")?
    }

    #[tauri::command]
    async fn update_download(window: WebviewWindow, service: State<'_, std::sync::Arc<crate::auto_update::UpdateService>>, version: String, progress: tauri::ipc::Channel<Value>) -> Result<Value, String> {
        local_only(&window)?;
        service.download(&version, env!("CARGO_PKG_VERSION"), &move |value| { let _ = progress.send(value); }).await
    }
    #[tauri::command]
    fn update_cancel(window: WebviewWindow, service: State<'_, std::sync::Arc<crate::auto_update::UpdateService>>) -> Result<(), String> {
        local_only(&window)?; service.cancel()
    }
    #[tauri::command]
    async fn update_install(window: WebviewWindow, app: tauri::AppHandle, service: State<'_, std::sync::Arc<crate::auto_update::UpdateService>>) -> Result<(), String> {
        local_only(&window)?;
        let service = service.inner().clone();
        let executable = std::env::current_exe().map_err(|e| format!("无法确定应用位置：{e}"))?;
        tauri::async_runtime::spawn_blocking(move || service.launch_installer(&executable)).await.map_err(|_| "安装启动任务失败")??;
        // Exit only after the verified installer was successfully started.
        std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(500)); app.exit(0); });
        Ok(())
    }

    #[tauri::command]
    fn kokoro_status(window:WebviewWindow, service:State<'_,std::sync::Arc<crate::local_tts::LocalTts>>) -> Result<Value,String> {
        local_only(&window)?; Ok(service.status())
    }
    #[tauri::command]
    async fn kokoro_import(window:WebviewWindow, service:State<'_,std::sync::Arc<crate::local_tts::LocalTts>>, directory:String) -> Result<Value,String> {
        local_only(&window)?;
        if directory.len()>4096 {return Err("语音包路径过长".into());}
        let service=service.inner().clone();
        tauri::async_runtime::spawn_blocking(move || service.import(std::path::Path::new(directory.trim()))).await.map_err(|_|"语音包导入任务失败")?
    }
    #[tauri::command]
    fn kokoro_begin(window:WebviewWindow, service:State<'_,std::sync::Arc<crate::local_tts::LocalTts>>) -> Result<u64,String> {
        local_only(&window)?; service.begin()
    }
    #[tauri::command]
    fn kokoro_stop(window:WebviewWindow, service:State<'_,std::sync::Arc<crate::local_tts::LocalTts>>, session:u64) -> Result<(),String> {
        local_only(&window)?; service.stop(session); Ok(())
    }
    #[tauri::command]
    async fn kokoro_synthesize(window:WebviewWindow, service:State<'_,std::sync::Arc<crate::local_tts::LocalTts>>, session:u64, text:String, speaker:i32) -> Result<Value,String> {
        local_only(&window)?; service.synthesize(session,text,speaker).await
    }
    #[tauri::command]
    async fn kokoro_uninstall(window: WebviewWindow, service: State<'_, std::sync::Arc<crate::local_tts::LocalTts>>) -> Result<Value, String> {
        local_only(&window)?;
        let service = service.inner().clone();
        tauri::async_runtime::spawn_blocking(move || service.uninstall()).await.map_err(|_| String::from("语音包卸载任务失败"))?
    }
    #[tauri::command]
    async fn kokoro_pick_directory(window: WebviewWindow) -> Result<Option<String>, String> {
        local_only(&window)?;
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let script = r#"[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = '选择包含 model.int8.onnx 的 Kokoro 语音包文件夹'; $f.ShowNewFolderButton = $false; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }"#;
                let output = std::process::Command::new("powershell")
                    .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script])
                    .creation_flags(0x08000000)
                    .output()
                    .map_err(|e| format!("无法打开文件夹选择窗口: {e}"))?;
                if !output.status.success() { return Err(String::from("文件夹选择窗口未能正常打开，请手工输入路径")); }
                let path = String::from_utf8(output.stdout).map_err(|_| String::from("文件夹路径编码无效，请手工输入路径"))?.trim().trim_start_matches('\u{feff}').to_string();
                if path.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(path))
                }
            }
            #[cfg(not(windows))]
            {
                Ok(None)
            }
        }).await.map_err(|_| String::from("目录选择任务失败"))?
    }

    #[tauri::command]
    async fn official_cover(window: WebviewWindow, cache: State<'_, crate::cover_cache::CoverCache>, service: State<'_, OfficialService>, url: String, book_id: Option<String>) -> Result<Value,String> {
        local_only(&window)?;
        if url.is_empty() {
            let book=book_id.as_deref().ok_or("封面书籍ID无效")?;
            if let Some(value)=cache.lookup_book(book)? {return Ok(value);}
            let fresh=service.fresh_cover(book,"").await?;
            let value=cache.get(&fresh,Some(book)).await?;
            cache.alias_book(book,&value);
            return Ok(value);
        }
        if let Some(value)=cache.lookup(&url,book_id.as_deref())? {return Ok(value);}
        // Search still supplies this obsolete CDN; obtain its current first-party
        // cover before a network timeout, while keeping the original cache alias.
        let legacy = reqwest::Url::parse(&url).ok().is_some_and(|url|url.host_str()==Some("p6-tt.bytecdn.cn"));
        if legacy {
            if let Some(book)=book_id.as_deref() {
                let fresh=service.fresh_cover(book,&url).await?;
                if fresh!=url {
                    let value=cache.get(&fresh,Some(book)).await?;
                    cache.alias(&url,book,&value);
                    return Ok(value);
                }
            }
        }
        match cache.get(&url,book_id.as_deref()).await {
            Err(error) if matches!(error.as_str(),"封面返回HTTP 403" | "封面返回HTTP 404" | "封面连接失败，请稍后重试") && book_id.is_some() => {
                // A stale public cover link can be replaced only by the current
                // first-party book metadata, never by guessing CDN signatures.
                let book=book_id.as_deref().unwrap();
                let fresh=service.fresh_cover(book,&url).await?;
                if fresh==url {return Err(error);}
                let value=cache.get(&fresh,Some(book)).await?;
                cache.alias(&url,book,&value);
                Ok(value)
            }
            value=>value,
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
        updates: Option<tauri::ipc::JavaScriptChannelId>,
    ) -> Result<Value, String> {
        local_only(&window)?;
        s.bookshelf_updates(updates.map(|id| { let channel: tauri::ipc::Channel<Value> = id.channel_on(window.as_ref().clone()); Box::new(move |value| { let _ = channel.send(value); }) as Box<dyn Fn(Value) + Send + Sync> })).await
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
            .setup(|app| {
                use tauri::Manager;
                let root = if let Some(profile) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
                    std::path::PathBuf::from(profile).join("tomato-cover-cache")
                } else { app.path().app_cache_dir()?.join("covers") };
                app.manage(crate::cover_cache::CoverCache::new(root));
                let backups = if let Some(profile) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") { std::path::PathBuf::from(profile).join("moyu-backups") } else { app.path().app_local_data_dir()?.join("backups") };
                app.manage(std::sync::Arc::new(crate::backups::Backups::new(backups)));
                let updates = if let Some(profile) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") { std::path::PathBuf::from(profile).join("moyu-updates") } else { app.path().app_cache_dir()?.join("updates") };
                app.manage(std::sync::Arc::new(crate::auto_update::UpdateService::new(updates)));
                let data = if let Some(profile)=std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
                    std::path::PathBuf::from(profile).join("tomato-kokoro")
                } else {app.path().app_local_data_dir()?.join("kokoro")};
                let engine=app.path().resource_dir()?.join("resources/kokoro/engine");
                app.manage(std::sync::Arc::new(crate::local_tts::LocalTts::new(data,engine)));
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                backup_create,
                backup_list,
                backup_load,
                update_download,
                update_cancel,
                update_install,
                official_cover,
                kokoro_status,
                kokoro_import,
                kokoro_uninstall,
                kokoro_pick_directory,
                kokoro_begin,
                kokoro_stop,
                kokoro_synthesize,
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
