//! 测试模式用的后端桥：浏览器里跑前端时，由 Vite 开发服务器调用这个程序执行真实的后端逻辑。
//!
//! 用法：devbridge <测试曲库目录> <命令>，参数 JSON 从标准输入读，结果 JSON 写到标准输出：
//! {"ok": ...} 或 {"err": "..."}。只操作测试曲库目录（app/.testlib），不碰真正的素材文件夹。

use banzou_lib::{library, lyrics_store, obs, recording, settings, studio, transcribe};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

const DEV_LIVE_PORT: u16 = 17890;

fn run(root: &Path, cmd: &str, args: &Value) -> Result<Value, String> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
    let settings_dir = root.join(".settings");
    match cmd {
        "scan_library" => library::scan_dir(root)
            .map(|lib| serde_json::to_value(lib).unwrap())
            .map_err(|e| format!("扫描 {} 失败：{}", root.display(), e)),
        // 测试模式的素材文件夹固定是测试曲库
        "library_dir" | "choose_library_dir" => Ok(Value::from(root.to_string_lossy().into_owned())),
        "read_lyrics" => {
            let path = s("path").ok_or("缺少 path")?;
            lyrics_store::read_lyrics(root, Path::new(&path))
                .map(Value::from)
                .map_err(|e| format!("读取歌词失败：{e}"))
        }
        "save_lyrics" => {
            let title = s("title").ok_or("缺少 title")?;
            let content = s("content").ok_or("缺少 content")?;
            let existing = s("existingPath").map(PathBuf::from);
            lyrics_store::save_lyrics(root, &title, existing.as_deref(), &content)
                .map(|p| Value::from(p.to_string_lossy().into_owned()))
                .map_err(|e| format!("保存歌词失败：{e}"))
        }
        "load_store" => settings::load_store(&settings_dir, &s("name").ok_or("缺少 name")?).map_err(|e| e.to_string()),
        "save_store" => settings::save_store(&settings_dir, &s("name").ok_or("缺少 name")?, args.get("value").unwrap_or(&Value::Null))
            .map(|_| Value::Null)
            .map_err(|e| e.to_string()),
        "load_settings" => settings::load(&settings_dir).map_err(|e| format!("读取设置失败：{e}")),
        "save_settings" => settings::save(&settings_dir, args.get("value").unwrap_or(&Value::Null))
            .map(|_| Value::Null)
            .map_err(|e| format!("保存设置失败：{e}")),
        "transcribe_vocals" => {
            let path = s("path").ok_or("缺少 path")?;
            let audio = transcribe::checked_audio_path(root, Path::new(&path))?;
            let helper = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/banzou-helper-aarch64-apple-darwin");
            transcribe::transcribe(&helper, &audio, &root.join(".cache"))
                .map(|t| serde_json::to_value(t).unwrap())
        }
        // 测试模式的直播服务由 examples/devlive 单独运行在 17890 端口，这里转发过去
        "live_info" => Ok(serde_json::json!({ "port": DEV_LIVE_PORT, "url": format!("http://127.0.0.1:{DEV_LIVE_PORT}/overlay") })),
        "live_update" => {
            let body = s("body").ok_or("缺少 body")?;
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", DEV_LIVE_PORT)).map_err(|e| format!("测试直播服务没开（cargo run --example devlive）：{e}"))?;
            use std::io::Write;
            write!(stream, "POST /update HTTP/1.1\r\nContent-Length: {}\r\n\r\n{body}", body.len()).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "open_live_window" => Ok(Value::Null),
        "rec_begin" => {
            let title = s("title").ok_or("缺少 title")?;
            let rate = args.get("sampleRate").and_then(Value::as_u64).unwrap_or(48000) as u32;
            recording::begin(root, &title, rate).map(|p| Value::from(p.to_string_lossy().into_owned())).map_err(|e| e.to_string())
        }
        "rec_append" => recording::append(root, Path::new(&s("path").ok_or("缺少 path")?), &s("data").ok_or("缺少 data")?)
            .map(|_| Value::Null)
            .map_err(|e| e.to_string()),
        "rec_finish" => recording::finish(root, Path::new(&s("path").ok_or("缺少 path")?))
            .map(|p| Value::from(p.to_string_lossy().into_owned()))
            .map_err(|e| e.to_string()),
        "rec_discard" => recording::discard(root, Path::new(&s("path").ok_or("缺少 path")?)).map(|_| Value::Null).map_err(|e| e.to_string()),
        "load_takes" => recording::load_takes(root, &s("title").ok_or("缺少 title")?).map_err(|e| e.to_string()),
        "save_takes" => recording::save_takes(root, &s("title").ok_or("缺少 title")?, args.get("takes").unwrap_or(&Value::Null))
            .map(|_| Value::Null)
            .map_err(|e| e.to_string()),
        "trash_takes" => {
            let files: Vec<String> = serde_json::from_value(args.get("files").cloned().unwrap_or_default()).map_err(|e| e.to_string())?;
            recording::trash(root, &s("title").ok_or("缺少 title")?, &files, &root.join(".trash")).map(|_| Value::Null).map_err(|e| e.to_string())
        }
        "audio_route" => transcribe::route(&Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/banzou-helper-aarch64-apple-darwin")),
        "analyze_pitch" => studio::analyze_pitch(root, &root.join(".cache"), &s("path").ok_or("缺少 path")?).map(|t| serde_json::to_value(t).unwrap()),
        "render_take" => studio::render_take(
            root,
            &s("title").ok_or("缺少 title")?,
            &s("takeId").ok_or("缺少 takeId")?,
            args.get("clips").cloned().unwrap_or_default(),
            args.get("adjustMs").and_then(Value::as_f64).unwrap_or(0.0),
        )
        .map(|r| serde_json::to_value(r).unwrap()),
        "render_tuned" => studio::render_tuned(
            root,
            &root.join(".cache"),
            &s("title").ok_or("缺少 title")?,
            &s("takeId").ok_or("缺少 takeId")?,
            args.get("job").cloned().unwrap_or_default(),
            args.get("range").and_then(|r| serde_json::from_value::<(f64, f64)>(r.clone()).ok()),
        )
        .map(Value::from),
        "load_tune" => studio::load_tune(root, &s("title").ok_or("缺少 title")?, &s("takeId").ok_or("缺少 takeId")?),
        "save_tune" => studio::save_tune(root, &s("title").ok_or("缺少 title")?, &s("takeId").ok_or("缺少 takeId")?, args.get("value").unwrap_or(&Value::Null)).map(|_| Value::Null),
        "export_begin" => studio::export_begin(
            root,
            &s("title").ok_or("缺少 title")?,
            &s("name").ok_or("缺少 name")?,
            args.get("sampleRate").and_then(Value::as_u64).unwrap_or(48000) as u32,
            args.get("channels").and_then(Value::as_u64).unwrap_or(2) as u16,
        )
        .map(Value::from),
        "export_append" => studio::export_append(root, &s("path").ok_or("缺少 path")?, &s("data").ok_or("缺少 data")?).map(|_| Value::Null),
        "export_finish" => studio::export_finish(root, &s("path").ok_or("缺少 path")?, args.get("m4a").and_then(Value::as_bool).unwrap_or(false)).map(|v| serde_json::to_value(v).unwrap()),
        "export_dry" => studio::export_dry(root, &s("title").ok_or("缺少 title")?, &s("takeId").ok_or("缺少 takeId")?, &s("name").ok_or("缺少 name")?).map(Value::from),
        "reveal_file" => Ok(Value::Null),
        "list_exports" => studio::list_exports(root, &s("title").ok_or("缺少 title")?).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "transpose_file" => studio::transpose_file(root, &s("path").ok_or("缺少 path")?, args.get("semitones").and_then(Value::as_f64).unwrap_or(0.0)).map(Value::from),
        "extract_audio" => studio::extract_audio(root, &s("video").ok_or("缺少 video")?, &s("title").ok_or("缺少 title")?).map(Value::from),
        "open_file" => Ok(Value::Null),
        // 测试模式也能控制本机真的 OBS（用来验证一键开播）
        "obs_go_live" => obs::go_live(
            &s("password").ok_or("缺少 password")?,
            &s("overlayUrl").ok_or("缺少 overlayUrl")?,
            &s("server").unwrap_or_default(),
            &s("key").unwrap_or_default(),
        )
        .map(|v| serde_json::to_value(v).unwrap()),
        "obs_stop" => obs::stop(&s("password").ok_or("缺少 password")?).map(|_| Value::Null),
        "obs_status" => Ok(serde_json::to_value(obs::status(&s("password").ok_or("缺少 password")?)).unwrap()),
        other => Err(format!("测试桥不支持的命令：{other}")),
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let (Some(root), Some(cmd)) = (argv.get(1), argv.get(2)) else {
        eprintln!("用法：devbridge <目录> <命令>");
        std::process::exit(2);
    };
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).ok();
    let args: Value = serde_json::from_str(&input).unwrap_or(Value::Null);
    let out = match run(Path::new(root), cmd, &args) {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "err": e }),
    };
    println!("{out}");
}
