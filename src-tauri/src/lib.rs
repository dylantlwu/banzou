pub mod ai;
pub mod dsp;
pub mod learn;
pub mod library;
pub mod live;
pub mod net;
pub mod lyrics_store;
pub mod obs;
pub mod recording;
pub mod separate;
pub mod settings;
pub mod songmeta;
pub mod studio;
pub mod tags;
pub mod transcribe;
pub mod tv;
pub mod video;

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
    // 歌长（读 wav 伴奏的文件头）：判断上次留下的未完成录音是不是异常（资料清单 §5-9）
    let song_seconds = recording::song_seconds(&root, &title);
    recording::load_takes(&root, &title, song_seconds).map_err(|e| format!("读取录音列表失败：{e}"))
}

/// 资料检查：整个曲库的异常录音（超长、没自动恢复的）
#[tauri::command]
async fn abnormal_recordings() -> Result<Vec<serde_json::Value>, String> {
    let root = default_library_dir()?;
    tauri::async_runtime::spawn_blocking(move || recording::abnormal_recordings(&root))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("检查异常录音失败：{e}"))
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
fn list_exports(title: String) -> Result<Vec<studio::ExportFile>, String> {
    studio::list_exports(&default_library_dir()?, &title)
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

// ---------- 下载视频（PRD 4.10） ----------

fn video_dirs(app: &tauri::AppHandle) -> Result<video::Dirs, String> {
    Ok(video::Dirs {
        tools: app.path().app_data_dir().map_err(|e| e.to_string())?.join("tools"),
        work: cache_dir(app)?.join("video"),
    })
}

#[tauri::command]
async fn video_tools(app: tauri::AppHandle) -> Result<video::ToolStatus, String> {
    let dirs = video_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || video::tool_status(&dirs)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn video_install_tools(app: tauri::AppHandle) -> Result<video::ToolStatus, String> {
    let dirs = video_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || video::install_tools(&dirs)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn video_update_ytdlp(app: tauri::AppHandle) -> Result<String, String> {
    let dirs = video_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || video::update_ytdlp(&dirs)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn video_probe(app: tauri::AppHandle, url: String) -> Result<video::VideoInfo, String> {
    let dirs = video_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || video::probe(&dirs, &url)).await.map_err(|e| e.to_string())?
}

/// 下载到素材文件夹
#[tauri::command]
async fn video_download(app: tauri::AppHandle, url: String, quality: String) -> Result<video::Downloaded, String> {
    let dirs = video_dirs(&app)?;
    let root = default_library_dir()?;
    tauri::async_runtime::spawn_blocking(move || video::download(&dirs, &url, &quality, &root)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn video_job(app: tauri::AppHandle) -> Result<Option<video::Job>, String> {
    Ok(video::job_status(&video_dirs(&app)?))
}

#[tauri::command]
fn video_cancel(app: tauri::AppHandle) -> Result<(), String> {
    video::cancel(&video_dirs(&app)?);
    Ok(())
}

/// 繁体转简体（做成伴奏时默认歌名用简体，和素材文件夹的习惯一致）
#[tauri::command]
fn to_simplified(text: String) -> String {
    fast2s::convert(&text)
}

#[tauri::command]
fn sep_status(app: tauri::AppHandle) -> Result<separate::SepStatus, String> {
    Ok(separate::status(&video_dirs(&app)?))
}

#[tauri::command]
async fn sep_install(app: tauri::AppHandle) -> Result<separate::SepStatus, String> {
    let dirs = video_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || separate::install(&dirs)).await.map_err(|e| e.to_string())?
}

/// 做成伴奏：素材文件夹里的视频 / 音频 →「歌名 - 伴奏.wav」「歌名 - 人声.wav」
#[tauri::command]
async fn sep_run(app: tauri::AppHandle, path: String, name: String) -> Result<separate::Separated, String> {
    let dirs = video_dirs(&app)?;
    let root = default_library_dir()?;
    tauri::async_runtime::spawn_blocking(move || separate::run(&dirs, &root, &path, &name)).await.map_err(|e| e.to_string())?
}

// ---------- 电视 KTV ----------

fn tv_dirs(app: &tauri::AppHandle) -> Result<video::Dirs, String> {
    Ok(video::Dirs { tools: app.path().app_data_dir().map_err(|e| e.to_string())?.join("tools"), work: cache_dir(app)?.join("tv") })
}

#[tauri::command]
async fn tv_status(app: tauri::AppHandle, addr: String) -> Result<tv::TvStatus, String> {
    let dirs = tv_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || tv::status(&dirs, &addr)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn tv_discover() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(tv::discover).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn tv_install_tools(app: tauri::AppHandle) -> Result<tv::TvStatus, String> {
    let dirs = tv_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || tv::install_tools(&dirs)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn tv_install_app(app: tauri::AppHandle, addr: String) -> Result<(), String> {
    let dirs = tv_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || tv::install_app(&dirs, &addr)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn tv_open_app(app: tauri::AppHandle, addr: String) -> Result<(), String> {
    let dirs = tv_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || tv::open_app(&dirs, &addr)).await.map_err(|e| e.to_string())?
}

/// 每首歌挑一个能放到电视上的 MV（读文件信息，几十首要一两秒）
#[tauri::command]
async fn tv_choose_mv(app: tauri::AppHandle, accompaniment: String, videos: Vec<String>) -> Result<tv::MvChoice, String> {
    let dirs = tv_dirs(&app)?;
    let root = default_library_dir()?;
    tv::PushRequest { accompaniment: accompaniment.clone(), ..Default::default() }.check_inside(&root)?;
    let videos: Vec<PathBuf> = videos.into_iter().map(PathBuf::from).filter(|v| v.starts_with(&root)).collect();
    tauri::async_runtime::spawn_blocking(move || tv::choose_mv(&dirs, Path::new(&accompaniment), &videos)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn tv_push(app: tauri::AppHandle, addr: String, req: tv::PushRequest) -> Result<tv::Pushed, String> {
    let dirs = tv_dirs(&app)?;
    req.check_inside(&default_library_dir()?)?;
    tauri::async_runtime::spawn_blocking(move || tv::push(&dirs, &addr, &req)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn tv_remove(app: tauri::AppHandle, addr: String, title: String) -> Result<(), String> {
    let dirs = tv_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || tv::remove(&dirs, &addr, &title)).await.map_err(|e| e.to_string())?
}

/// 曲库里有伴奏的歌 → 电视歌单（编号、显示名、歌手等从资料表来，见 songmeta.rs）
fn tv_catalog_songs(root: &Path) -> Result<Vec<tv::CatalogSong>, String> {
    Ok(tv_catalog(root, &serde_json::Value::Null)?.0)
}

/// 电视歌单 + 给电视用的标签（资料表合并 tags.json 的歌单）
fn tv_catalog(root: &Path, tags: &serde_json::Value) -> Result<(Vec<tv::CatalogSong>, serde_json::Value), String> {
    let lib = library::scan_dir(root).map_err(|e| format!("扫描曲库失败：{e}"))?;
    Ok(songmeta::catalog_songs(root, &lib, tags))
}

/// 把全部歌曲的歌单和副歌预览同步到电视
#[tauri::command]
async fn tv_sync_catalog(app: tauri::AppHandle, addr: String) -> Result<tv::Synced, String> {
    let dirs = tv_dirs(&app)?;
    let root = default_library_dir()?;
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let tags = settings::load_store(&config, "tags").unwrap_or(serde_json::Value::Null);
    let pulled = dirs.work.join("plays-from-tv.json");
    let plays = config.join("plays.json");
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _ = std::fs::remove_file(&pulled);
        let (songs, tags) = tv_catalog(&root, &tags)?;
        let r = tv::sync_catalog(&dirs, &addr, &songs, &tags, &pulled);
        // 电视上的点歌次数拉回来才覆盖本地的
        if pulled.is_file() && serde_json::from_slice::<serde_json::Value>(&std::fs::read(&pulled).unwrap_or_default()).is_ok_and(|v| v.is_object()) {
            let _ = std::fs::copy(&pulled, &plays);
        }
        r
    })
    .await
    .map_err(|e| e.to_string())?;
    result
}

#[tauri::command]
fn ai_key_status(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(tags::has_key(&app.path().app_config_dir().map_err(|e| e.to_string())?))
}

/// 保存 Claude API key（空字符串 = 删掉）。key 只存在本机配置目录，不会再传回界面
#[tauri::command]
fn ai_key_save(app: tauri::AppHandle, key: String) -> Result<(), String> {
    tags::save_key(&app.path().app_config_dir().map_err(|e| e.to_string())?, &key)
}

/// 外语学唱：Claude key 和豆包语音填了没有（只给末四位）、音色、语速
#[tauri::command]
fn ai_status(app: tauri::AppHandle) -> Result<ai::AiStatus, String> {
    Ok(ai::status(&app.path().app_config_dir().map_err(|e| e.to_string())?))
}

/// 外语学唱：保存豆包语音的 APP ID / Access Token / 音色 / 语速（没传的不动，空字符串 = 删掉）
#[tauri::command]
fn ai_save_tts(app: tauri::AppHandle, patch: ai::TtsPatch) -> Result<(), String> {
    ai::save_tts(&app.path().app_config_dir().map_err(|e| e.to_string())?, &patch)
}

/// 外语学唱：问 Claude 一句，确认 key、余额、网络
#[tauri::command]
async fn ai_test_claude(app: tauri::AppHandle) -> Result<ai::ClaudeReply, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || ai::test_claude(&dir)).await.map_err(|e| e.to_string())?
}

/// 外语学唱：用豆包念一句试听，返回 mp3（base64）
#[tauri::command]
async fn ai_test_tts(app: tauri::AppHandle, text: String) -> Result<ai::SpokenTest, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || ai::test_tts(&dir, &text)).await.map_err(|e| e.to_string())?
}

/// 外语学唱：两本老师笔记（通用 + 这首歌）
#[tauri::command]
fn learn_notes(app: tauri::AppHandle, title: Option<String>) -> Result<learn::NotesView, String> {
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let root = default_library_dir().ok();
    Ok(learn::notes_view(&config, root.as_deref(), title.as_deref()))
}

/// 外语学唱：在应用里改老师笔记（index 为空 = 加一条，text 为空 = 删掉）
#[tauri::command]
fn learn_note_set(app: tauri::AppHandle, scope: learn::notes::Scope, title: Option<String>, index: Option<usize>, text: String) -> Result<(), String> {
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    learn::note_set(&config, &default_library_dir()?, scope, title.as_deref(), index, &text)
}

/// 外语学唱：撤销老师刚记下的一条笔记
#[tauri::command]
fn learn_undo_remember(app: tauri::AppHandle, title: String, remembered: learn::teacher::Remembered) -> Result<(), String> {
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    learn::teacher::undo_remember(&config, &default_library_dir()?, &title, &remembered)
}

/// 外语学唱：这首歌和老师的对话
#[tauri::command]
fn learn_chat(title: String) -> Result<Vec<learn::teacher::Turn>, String> {
    Ok(learn::teacher::load_chat(&default_library_dir()?, &title))
}

#[tauri::command]
fn learn_chat_clear(title: String) -> Result<(), String> {
    learn::teacher::clear_chat(&default_library_dir()?, &title)
}

/// 外语学唱：问老师一句（老师可能顺手记笔记）
#[tauri::command]
async fn learn_ask(app: tauri::AppHandle, title: String, question: String, language: Option<String>) -> Result<learn::teacher::Turn, String> {
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let root = default_library_dir()?;
    let language = language.unwrap_or_else(|| learn::teacher::DEFAULT_LANGUAGE.to_string());
    tauri::async_runtime::spawn_blocking(move || learn::teacher::ask(&config, &root, &title, &question, &language)).await.map_err(|e| e.to_string())?
}

/// 外语学唱：用豆包念老师的话（先按笔记里的读音替换）
#[tauri::command]
async fn learn_speak(app: tauri::AppHandle, title: Option<String>, text: String) -> Result<learn::teacher::Spoken, String> {
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let root = default_library_dir()?;
    tauri::async_runtime::spawn_blocking(move || learn::teacher::speak(&config, &root, title.as_deref(), &text)).await.map_err(|e| e.to_string())?
}

/// 网络路线：每个外部服务走哪条路（直连 / 跟系统走）
#[tauri::command]
fn net_services(app: tauri::AppHandle) -> Result<Vec<net::Service>, String> {
    Ok(net::services(&app.path().app_config_dir().map_err(|e| e.to_string())?))
}

/// 网络路线：改一个服务的路线；route 为空 = 恢复默认
#[tauri::command]
fn net_set_route(app: tauri::AppHandle, id: String, route: Option<net::Route>) -> Result<(), String> {
    net::set_route(&app.path().app_config_dir().map_err(|e| e.to_string())?, &id, route)
}

/// 网络路线：按现在的路线连一下
#[tauri::command]
async fn net_test(app: tauri::AppHandle, id: String) -> Result<net::TestResult, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || net::test(&dir, &id)).await.map_err(|e| e.to_string())?
}

/// 给歌打标签（联网查资料）。retag=false 只打还缺标签的歌；retag=true 重打全部，但手动改过的字段不动。
/// 用户手动改过的歌最多 20 首当范例一起发给 AI。返回本次猜了几首
#[tauri::command]
async fn ai_tag_songs(app: tauri::AppHandle, retag: Option<bool>, titles: Option<Vec<String>>, hints: Option<std::collections::HashMap<String, String>>) -> Result<serde_json::Value, String> {
    let retag = retag.unwrap_or(false);
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let root = default_library_dir()?;
    let dirs = tv_dirs(&app)?;
    // 写进每首歌的资料表（songmeta.rs），用户填的不覆盖；没有歌词的顺手去 LRCLIB 搜
    tauri::async_runtime::spawn_blocking(move || {
        let tags = settings::load_store(&config, "tags").unwrap_or(serde_json::Value::Null);
        songmeta::ai_fill(&config, &root, &tags, titles.as_deref(), retag, hints.as_ref(), |p| video::media_info(&dirs, p).duration)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 资料表相关命令（tags_load、tags_save、songs_check、song_meta_save、song_rename_plan、song_rename、
/// songs_migrate_plan、songs_migrate），实现在 songmeta::command，测试桥也走同一个入口
#[tauri::command]
async fn song_meta(app: tauri::AppHandle, cmd: String, args: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let root = default_library_dir()?;
    let tv_cache = tv_dirs(&app)?.work;
    tauri::async_runtime::spawn_blocking(move || songmeta::command(&root, &config, &tv_cache, &cmd, &args.unwrap_or_default()).unwrap_or_else(|| Err(format!("不认识的命令：{cmd}"))))
        .await
        .map_err(|e| e.to_string())?
}

/// 后台：电视上点了还没传过去的歌，波点开着就自动传
fn start_tv_request_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(8));
            let Ok(config) = app.path().app_config_dir() else { continue };
            let addr = settings::load_store(&config, "tv").ok().and_then(|v| v["address"].as_str().map(str::to_string));
            let (Some(addr), Ok(root), Ok(dirs)) = (addr, default_library_dir(), tv_dirs(&app)) else { continue };
            let Ok(songs) = tv_catalog_songs(&root) else { continue };
            let _ = tv::serve_requests(&dirs, &addr, &songs);
        }
    });
}

#[tauri::command]
fn tv_job(app: tauri::AppHandle) -> Result<Option<video::Job>, String> {
    Ok(video::job_status(&tv_dirs(&app)?))
}

#[tauri::command]
fn tv_cancel(app: tauri::AppHandle) -> Result<(), String> {
    video::cancel(&tv_dirs(&app)?);
    Ok(())
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Live(live::LiveServer::start(live::DEFAULT_PORT).ok()))
        .setup(|app| {
            if let Ok(config) = app.path().app_config_dir()
                && let Some(dir) = settings::load_library_dir(&config)
            {
                let _ = use_library(app.handle(), dir);
            }
            start_tv_request_watcher(app.handle().clone());
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
            abnormal_recordings,
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
            list_exports,
            transpose_file,
            extract_audio,
            open_file,
            obs_go_live,
            obs_stop,
            obs_status,
            video_tools,
            video_install_tools,
            video_update_ytdlp,
            video_probe,
            video_download,
            video_job,
            video_cancel,
            to_simplified,
            sep_status,
            sep_install,
            sep_run,
            tv_status,
            tv_discover,
            tv_install_tools,
            tv_install_app,
            tv_open_app,
            tv_choose_mv,
            tv_push,
            tv_remove,
            tv_sync_catalog,
            ai_key_status,
            ai_key_save,
            ai_tag_songs,
            ai_status,
            ai_save_tts,
            ai_test_claude,
            ai_test_tts,
            learn_notes,
            learn_note_set,
            learn_undo_remember,
            learn_chat,
            learn_chat_clear,
            learn_ask,
            learn_speak,
            net_services,
            net_set_route,
            net_test,
            tv_job,
            tv_cancel,
            song_meta
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
