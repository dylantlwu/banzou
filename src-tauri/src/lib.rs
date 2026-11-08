pub mod dsp;
pub mod library;
pub mod live;
pub mod lyrics_store;
pub mod obs;
pub mod recording;
pub mod settings;
pub mod studio;
pub mod transcribe;

use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tauri::Manager;

/// 当前素材文件夹（第一次打开时由用户选择，存在应用配置目录的 library.json）
static LIBRARY_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

/// 还没选素材文件夹时命令返回的错误，前端据此显示欢迎页
const NO_LIBRARY: &str = "NO_LIBRARY";

fn default_library_dir() -> Result<PathBuf, String> {
    LIBRARY_DIR.read().unwrap().clone().ok_or_else(|| NO_LIBRARY.to_string())
}

/// 切换素材文件夹：放开这个文件夹的音频读取权限（asset 协议），记住它
fn use_library(app: &tauri::AppHandle, dir: PathBuf) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!("文件夹不存在：{}", dir.display()));
    }
    app.asset_protocol_scope().allow_directory(&dir, true).map_err(|e| e.to_string())?;
    *LIBRARY_DIR.write().unwrap() = Some(dir);
    Ok(())
}

#[tauri::command]
fn library_dir() -> Option<String> {
    LIBRARY_DIR.read().unwrap().as_ref().map(|p| p.to_string_lossy().into_owned())
}

/// 弹出系统的选择文件夹窗口；取消返回 None
#[tauri::command]
async fn choose_library_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(settings::pick_folder).await.map_err(|e| e.to_string())??;
    let Some(dir) = picked else { return Ok(None) };
    use_library(&app, dir.clone())?;
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    settings::save_library_dir(&config, &dir).map_err(|e| format!("保存失败：{e}"))?;
    Ok(Some(dir.to_string_lossy().into_owned()))
}

/// 扫描素材文件夹，返回配对好的曲库。`dir` 为空时用当前选好的素材文件夹
#[tauri::command]
fn scan_library(dir: Option<String>) -> Result<library::Library, String> {
    let root = match dir {
        Some(d) => PathBuf::from(d),
        None => default_library_dir()?,
    };
    library::scan_dir(&root).map_err(|e| format!("扫描 {} 失败：{}", root.display(), e))
}

#[tauri::command]
fn read_lyrics(path: String) -> Result<String, String> {
    let root = default_library_dir()?;
    lyrics_store::read_lyrics(&root, Path::new(&path)).map_err(|e| format!("读取歌词失败：{e}"))
}

/// 保存歌词，返回写入的文件路径
#[tauri::command]
fn save_lyrics(title: String, existing_path: Option<String>, content: String) -> Result<String, String> {
    let root = default_library_dir()?;
    let existing = existing_path.as_deref().map(Path::new);
    lyrics_store::save_lyrics(&root, &title, existing, &content)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("保存歌词失败：{e}"))
}

/// 智能对齐：识别人声分轨里每个字的时间（第一次几秒钟，之后走缓存）
#[tauri::command]
async fn transcribe_vocals(app: tauri::AppHandle, path: String) -> Result<Vec<transcribe::Token>, String> {
    let root = default_library_dir()?;
    let audio = transcribe::checked_audio_path(&root, Path::new(&path))?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    // sidecar 和主程序放在同一个目录（.app/Contents/MacOS）
    let helper = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name("banzou-helper");
    tauri::async_runtime::spawn_blocking(move || transcribe::transcribe(&helper, &audio, &cache))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    settings::load(&dir).map_err(|e| format!("读取设置失败：{e}"))
}

#[tauri::command]
fn load_store(app: tauri::AppHandle, name: String) -> Result<serde_json::Value, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    settings::load_store(&dir, &name).map_err(|e| format!("读取 {name} 失败：{e}"))
}

#[tauri::command]
fn save_store(app: tauri::AppHandle, name: String, value: serde_json::Value) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    settings::save_store(&dir, &name, &value).map_err(|e| format!("保存 {name} 失败：{e}"))
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, value: serde_json::Value) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    settings::save(&dir, &value).map_err(|e| format!("保存设置失败：{e}"))
}

/// 直播叠加层服务（应用启动时开启；端口被占用时为 None）
struct Live(Option<live::LiveServer>);

#[derive(serde::Serialize)]
struct LiveInfo {
    port: u16,
    url: String,
}

#[tauri::command]
fn live_info(live: tauri::State<Live>) -> Result<LiveInfo, String> {
    let server = live.0.as_ref().ok_or("直播叠加层服务没启动（端口被占用）")?;
    Ok(LiveInfo { port: server.port, url: format!("http://127.0.0.1:{}/overlay", server.port) })
}

#[tauri::command]
fn live_update(live: tauri::State<Live>, body: String) -> Result<(), String> {
    live.0.as_ref().ok_or("直播叠加层服务没启动")?.update(&body)
}

/// 直播混音片段（原始字节，不走 JSON），转发给 OBS 里的叠加层
#[tauri::command]
fn live_audio(live: tauri::State<Live>, request: tauri::ipc::Request) -> Result<(), String> {
    let server = live.0.as_ref().ok_or("直播叠加层服务没启动")?;
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => server.push_audio(bytes),
        _ => return Err("直播音频格式不对".into()),
    }
    Ok(())
}

/// 打开独立的歌词窗口（绿幕 / 黑底），给 OBS 窗口捕获或第二块屏幕用
#[tauri::command]
fn open_live_window(app: tauri::AppHandle, live: tauri::State<Live>, bg: String) -> Result<(), String> {
    let server = live.0.as_ref().ok_or("直播叠加层服务没启动")?;
    let bg = if bg == "black" { "black" } else { "green" };
    let url = format!("http://127.0.0.1:{}/overlay?bg={bg}", server.port);
    if let Some(win) = app.get_webview_window("live-lyrics") {
        win.navigate(url.parse().map_err(|e| format!("{e}"))?).map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, "live-lyrics", tauri::WebviewUrl::External(url.parse().map_err(|e| format!("{e}"))?))
        .title("直播歌词")
        .inner_size(960.0, 300.0)
        .min_inner_size(320.0, 120.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 诊断：启动时带环境变量 BANZOU_SELFTEST=1，前端会自检麦克风等能力并写日志
#[tauri::command]
fn selftest_enabled() -> bool {
    std::env::var("BANZOU_SELFTEST").is_ok_and(|v| v == "1")
}

/// 诊断日志写到应用日志目录 selftest.log
#[tauri::command]
fn debug_log(app: tauri::AppHandle, message: String) -> Result<(), String> {
    use std::io::Write;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("selftest.log"))
        .map_err(|e| e.to_string())?;
    writeln!(f, "{message}").map_err(|e| e.to_string())
}

// ---------- 录音（M2） ----------

#[tauri::command]
fn rec_begin(title: String, sample_rate: u32) -> Result<String, String> {
    let root = default_library_dir()?;
    recording::begin(&root, &title, sample_rate)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("开始录音失败：{e}"))
}

#[tauri::command]
fn rec_append(path: String, data: String) -> Result<(), String> {
    let root = default_library_dir()?;
    recording::append(&root, Path::new(&path), &data).map_err(|e| format!("写录音失败：{e}"))
}

#[tauri::command]
fn rec_finish(path: String) -> Result<String, String> {
    let root = default_library_dir()?;
    recording::finish(&root, Path::new(&path))
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("保存录音失败：{e}"))
}

#[tauri::command]
fn rec_discard(path: String) -> Result<(), String> {
    let root = default_library_dir()?;
    recording::discard(&root, Path::new(&path)).map_err(|e| format!("丢弃录音失败：{e}"))
}

#[tauri::command]
fn load_takes(title: String) -> Result<serde_json::Value, String> {
    let root = default_library_dir()?;
    recording::load_takes(&root, &title).map_err(|e| format!("读取录音列表失败：{e}"))
}

#[tauri::command]
fn save_takes(title: String, takes: serde_json::Value) -> Result<(), String> {
    let root = default_library_dir()?;
    recording::save_takes(&root, &title, &takes).map_err(|e| format!("保存录音列表失败：{e}"))
}

#[tauri::command]
fn trash_takes(title: String, files: Vec<String>) -> Result<(), String> {
    let root = default_library_dir()?;
    let trash_dir = dirs::home_dir().ok_or("找不到用户主目录")?.join(".Trash");
    recording::trash(&root, &title, &files, &trash_dir).map_err(|e| format!("删除录音失败：{e}"))
}

/// 当前音频输出 / 输入设备（录音前的耳机检测）
#[tauri::command]
async fn audio_route() -> Result<serde_json::Value, String> {
    let helper = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name("banzou-helper");
    tauri::async_runtime::spawn_blocking(move || transcribe::route(&helper))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- 修音 / 导出（M3） ----------

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_cache_dir().map_err(|e| e.to_string())
}

#[tauri::command]
async fn analyze_pitch(app: tauri::AppHandle, path: String) -> Result<dsp::pitch::PitchTrack, String> {
    let root = default_library_dir()?;
    let cache = cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || studio::analyze_pitch(&root, &cache, &path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn render_take(title: String, take_id: String, clips: serde_json::Value, adjust_ms: f64) -> Result<dsp::process::Rendered, String> {
    let root = default_library_dir()?;
    tauri::async_runtime::spawn_blocking(move || studio::render_take(&root, &title, &take_id, clips, adjust_ms))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn render_tuned(app: tauri::AppHandle, title: String, take_id: String, job: serde_json::Value, range: Option<(f64, f64)>) -> Result<String, String> {
    let root = default_library_dir()?;
    let cache = cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || studio::render_tuned(&root, &cache, &title, &take_id, job, range)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn load_tune(title: String, take_id: String) -> Result<serde_json::Value, String> {
    studio::load_tune(&default_library_dir()?, &title, &take_id)
}

#[tauri::command]
fn save_tune(title: String, take_id: String, value: serde_json::Value) -> Result<(), String> {
    studio::save_tune(&default_library_dir()?, &title, &take_id, &value)
}

#[tauri::command]
fn export_begin(title: String, name: String, sample_rate: u32, channels: u16) -> Result<String, String> {
    studio::export_begin(&default_library_dir()?, &title, &name, sample_rate, channels)
}

#[tauri::command]
fn export_append(path: String, data: String) -> Result<(), String> {
    studio::export_append(&default_library_dir()?, &path, &data)
}

#[tauri::command]
async fn export_finish(path: String, m4a: bool) -> Result<Vec<String>, String> {
    let root = default_library_dir()?;
    tauri::async_runtime::spawn_blocking(move || studio::export_finish(&root, &path, m4a)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn export_dry(title: String, take_id: String, name: String) -> Result<String, String> {
    studio::export_dry(&default_library_dir()?, &title, &take_id, &name)
}

#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    studio::reveal(&default_library_dir()?, &path)
}

#[tauri::command]
async fn transpose_file(path: String, semitones: f64) -> Result<String, String> {
    let root = default_library_dir()?;
    tauri::async_runtime::spawn_blocking(move || studio::transpose_file(&root, &path, semitones)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn extract_audio(video: String, title: String) -> Result<String, String> {
    let root = default_library_dir()?;
    tauri::async_runtime::spawn_blocking(move || studio::extract_audio(&root, &video, &title)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    studio::open_file(&default_library_dir()?, &path)
}

// ---------- 一键开播（OBS） ----------

#[tauri::command]
async fn obs_go_live(password: String, overlay_url: String, server: String, key: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || obs::go_live(&password, &overlay_url, &server, &key)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn obs_stop(password: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || obs::stop(&password)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn obs_status(password: String) -> Result<obs::ObsStatus, String> {
    tauri::async_runtime::spawn_blocking(move || obs::status(&password)).await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Live(live::LiveServer::start(live::DEFAULT_PORT).ok()))
        .setup(|app| {
            if let Ok(config) = app.path().app_config_dir()
                && let Some(dir) = settings::load_library_dir(&config)
            {
                let _ = use_library(app.handle(), dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_library,
            library_dir,
            choose_library_dir,
            read_lyrics,
            save_lyrics,
            transcribe_vocals,
            load_settings,
            save_settings,
            load_store,
            save_store,
            live_info,
            live_update,
            live_audio,
            open_live_window,
            selftest_enabled,
            debug_log,
            rec_begin,
            rec_append,
            rec_finish,
            rec_discard,
            load_takes,
            save_takes,
            trash_takes,
            audio_route,
            analyze_pitch,
            render_take,
            render_tuned,
            load_tune,
            save_tune,
            export_begin,
            export_append,
            export_finish,
            export_dry,
            reveal_file,
            transpose_file,
            extract_audio,
            open_file,
            obs_go_live,
            obs_stop,
            obs_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
