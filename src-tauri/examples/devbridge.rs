//! 测试模式用的后端桥：浏览器里跑前端时，由 Vite 开发服务器调用这个程序执行真实的后端逻辑。
//!
//! 用法：devbridge <测试曲库目录> <命令>，参数 JSON 从标准输入读，结果 JSON 写到标准输出：
//! {"ok": ...} 或 {"err": "..."}。只操作测试曲库目录（app/.testlib），不碰真正的素材文件夹。

use banzou_lib::{library, lyrics_store, obs, recording, separate, settings, studio, transcribe, tv, video};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

const DEV_LIVE_PORT: u16 = 17890;

fn video_dirs(root: &Path) -> video::Dirs {
    video::Dirs { tools: root.join(".tools"), work: root.join(".cache/video") }
}

fn tv_dirs(root: &Path) -> video::Dirs {
    video::Dirs { tools: root.join(".tools"), work: root.join(".cache/tv") }
}

/// 测试模式只连 BANZOU_TEST_TV 指定的设备，没指定就不连电视
fn test_tv(addr: &str) -> Result<String, String> {
    tv::test_mode_target(addr, std::env::var("BANZOU_TEST_TV").ok().as_deref())
}

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
        // 外语学唱：key 存在测试曲库的 .settings 里，不碰正式应用的配置
        "ai_key_status" => Ok(Value::from(banzou_lib::tags::has_key(&settings_dir))),
        "ai_key_save" => banzou_lib::tags::save_key(&settings_dir, &s("key").unwrap_or_default()).map(|_| Value::Null),
        "ai_status" => Ok(serde_json::to_value(banzou_lib::ai::status(&settings_dir)).unwrap()),
        "ai_save_tts" => {
            let patch: banzou_lib::ai::TtsPatch = serde_json::from_value(args.get("patch").cloned().unwrap_or_default()).map_err(|e| e.to_string())?;
            banzou_lib::ai::save_tts(&settings_dir, &patch).map(|_| Value::Null)
        }
        "ai_test_claude" => banzou_lib::ai::test_claude(&settings_dir).map(|v| serde_json::to_value(v).unwrap()),
        "ai_test_tts" => banzou_lib::ai::test_tts(&settings_dir, &s("text").unwrap_or_default()).map(|v| serde_json::to_value(v).unwrap()),
        // 外语学唱：通用笔记在 .settings，这首歌的笔记和对话在测试曲库
        "learn_notes" => Ok(serde_json::to_value(banzou_lib::learn::notes_view(&settings_dir, Some(root), s("title").as_deref())).unwrap()),
        "learn_note_set" => {
            let scope = serde_json::from_value(args.get("scope").cloned().unwrap_or_default()).map_err(|e| e.to_string())?;
            let index = args.get("index").and_then(Value::as_u64).map(|i| i as usize);
            banzou_lib::learn::note_set(&settings_dir, root, scope, s("title").as_deref(), index, &s("text").unwrap_or_default()).map(|_| Value::Null)
        }
        "learn_undo_remember" => {
            let r = serde_json::from_value(args.get("remembered").cloned().unwrap_or_default()).map_err(|e| e.to_string())?;
            banzou_lib::learn::teacher::undo_remember(&settings_dir, root, &s("title").ok_or("缺少 title")?, &r).map(|_| Value::Null)
        }
        "learn_chat" => Ok(serde_json::to_value(banzou_lib::learn::teacher::load_chat(root, &s("title").ok_or("缺少 title")?)).unwrap()),
        "learn_chat_clear" => banzou_lib::learn::teacher::clear_chat(root, &s("title").ok_or("缺少 title")?).map(|_| Value::Null),
        "learn_ask" => banzou_lib::learn::teacher::ask(
            &settings_dir,
            root,
            &s("title").ok_or("缺少 title")?,
            &s("question").unwrap_or_default(),
            &s("language").unwrap_or_else(|| banzou_lib::learn::teacher::DEFAULT_LANGUAGE.into()),
        )
        .map(|v| serde_json::to_value(v).unwrap()),
        // 网络路线：改过的路线存在 .settings/network.json
        "net_services" => Ok(serde_json::to_value(banzou_lib::net::services(&settings_dir)).unwrap()),
        "net_set_route" => {
            let route = serde_json::from_value(args.get("route").cloned().unwrap_or_default()).map_err(|e| e.to_string())?;
            banzou_lib::net::set_route(&settings_dir, &s("id").ok_or("缺少 id")?, route).map(|_| Value::Null)
        }
        "net_test" => banzou_lib::net::test(&settings_dir, &s("id").ok_or("缺少 id")?).map(|v| serde_json::to_value(v).unwrap()),
        "learn_speak" =>banzou_lib::learn::teacher::speak(&settings_dir, root, s("title").as_deref(), &s("text").unwrap_or_default()).map(|v| serde_json::to_value(v).unwrap()),
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
        "load_takes" => {
            let title = s("title").ok_or("缺少 title")?;
            recording::load_takes(root, &title, recording::song_seconds(root, &title)).map_err(|e| e.to_string())
        }
        "abnormal_recordings" => recording::abnormal_recordings(root).map(Value::from).map_err(|e| e.to_string()),
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
        // 下载视频：工具装在测试曲库的 .tools（和正式应用分开，测得到第一次安装），视频下载到测试曲库
        "video_tools" => Ok(serde_json::to_value(video::tool_status(&video_dirs(root))).unwrap()),
        "video_install_tools" => video::install_tools(&video_dirs(root)).map(|v| serde_json::to_value(v).unwrap()),
        "video_update_ytdlp" => video::update_ytdlp(&video_dirs(root)).map(Value::from),
        "video_probe" => video::probe(&video_dirs(root), &s("url").ok_or("缺少 url")?).map(|v| serde_json::to_value(v).unwrap()),
        "video_download" => video::download(&video_dirs(root), &s("url").ok_or("缺少 url")?, &s("quality").unwrap_or_default(), root).map(|v| serde_json::to_value(v).unwrap()),
        "video_job" => Ok(serde_json::to_value(video::job_status(&video_dirs(root))).unwrap()),
        "to_simplified" => Ok(Value::from(fast2s::convert(&s("text").unwrap_or_default()))),
        "sep_status" => Ok(serde_json::to_value(separate::status(&video_dirs(root))).unwrap()),
        "sep_install" => separate::install(&video_dirs(root)).map(|v| serde_json::to_value(v).unwrap()),
        "sep_run" => separate::run(&video_dirs(root), root, &s("path").ok_or("缺少 path")?, &s("name").ok_or("缺少 name")?).map(|v| serde_json::to_value(v).unwrap()),
        "video_cancel" => {
            video::cancel(&video_dirs(root));
            Ok(Value::Null)
        }
        // 电视 KTV：测试模式连的是真的电视，工具装在测试曲库的 .tools
        // 连设备的电视命令先过测试模式检查：不会碰真电视（见 tv::test_mode_target）
        "tv_status" | "tv_install_app" | "tv_open_app" | "tv_push" | "tv_remove" | "tv_sync_catalog" | "tv_serve_requests"
            if test_tv(&s("addr").unwrap_or_default()).is_err() =>
        {
            test_tv(&s("addr").unwrap_or_default()).map(|_| Value::Null)
        }
        "tv_status" => Ok(serde_json::to_value(tv::status(&tv_dirs(root), &s("addr").unwrap_or_default())).unwrap()),
        "tv_discover" => test_tv("").map(|a| json!([a.trim_end_matches(":5555")])),
        "tv_install_tools" => tv::install_tools(&tv_dirs(root)).map(|v| serde_json::to_value(v).unwrap()),
        "tv_install_app" => tv::install_app(&tv_dirs(root), &s("addr").unwrap_or_default()).map(|_| Value::Null),
        "tv_open_app" => tv::open_app(&tv_dirs(root), &s("addr").unwrap_or_default()).map(|_| Value::Null),
        "tv_choose_mv" => {
            let videos: Vec<PathBuf> = args.get("videos").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(PathBuf::from).collect()).unwrap_or_default();
            Ok(serde_json::to_value(tv::choose_mv(&tv_dirs(root), Path::new(&s("accompaniment").ok_or("缺少 accompaniment")?), &videos)).unwrap())
        }
        "tv_push" => {
            let req: tv::PushRequest = serde_json::from_value(args.get("req").cloned().unwrap_or_default()).map_err(|e| e.to_string())?;
            req.check_inside(root)?;
            tv::push(&tv_dirs(root), &s("addr").unwrap_or_default(), &req).map(|v| serde_json::to_value(v).unwrap())
        }
        "tv_remove" => tv::remove(&tv_dirs(root), &s("addr").unwrap_or_default(), &s("title").ok_or("缺少 title")?).map(|_| Value::Null),
        "tv_sync_catalog" => {
            let lib = library::scan_dir(root).map_err(|e| e.to_string())?;
            let tags = settings::load_store(&settings_dir, "tags").unwrap_or(Value::Null);
            let (songs, tags) = banzou_lib::songmeta::catalog_songs(root, &lib, &tags);
            let pulled = tv_dirs(root).work.join("plays-from-tv.json");
            let _ = std::fs::remove_file(&pulled);
            let r = tv::sync_catalog(&tv_dirs(root), &s("addr").unwrap_or_default(), &songs, &tags, &pulled);
            if pulled.is_file() {
                let _ = std::fs::copy(&pulled, settings_dir.join("plays.json"));
            }
            r.map(|v| serde_json::to_value(v).unwrap())
        }
        // 测试模式没有后台线程：手动处理一次电视的点歌请求
        "tv_serve_requests" => {
            let lib = library::scan_dir(root).map_err(|e| e.to_string())?;
            let songs = banzou_lib::songmeta::catalog_songs(root, &lib, &Value::Null).0;
            tv::serve_requests(&tv_dirs(root), &s("addr").unwrap_or_default(), &songs).map(|v| serde_json::to_value(v).unwrap())
        }
        "tv_job" => Ok(serde_json::to_value(video::job_status(&tv_dirs(root))).unwrap()),
        "tv_cancel" => {
            video::cancel(&tv_dirs(root));
            Ok(Value::Null)
        }
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
        // 资料表（songmeta.rs）：和应用走同一个入口，配置目录是 .settings
        "song_meta" => {
            let sub = s("cmd").ok_or("缺少 cmd")?;
            banzou_lib::songmeta::command(root, &settings_dir, &tv_dirs(root).work, &sub, args.get("args").unwrap_or(&Value::Null)).unwrap_or_else(|| Err(format!("不认识的命令：{sub}")))
        }
        "ai_tag_songs" => {
            let titles: Option<Vec<String>> = args.get("titles").and_then(|t| serde_json::from_value(t.clone()).ok());
            let hints: Option<std::collections::HashMap<String, String>> = args.get("hints").and_then(|t| serde_json::from_value(t.clone()).ok());
            let tags = settings::load_store(&settings_dir, "tags").unwrap_or(Value::Null);
            banzou_lib::songmeta::ai_fill(&settings_dir, root, &tags, titles.as_deref(), args.get("retag").and_then(Value::as_bool).unwrap_or(false), hints.as_ref(), |p| video::media_info(&tv_dirs(root), p).duration)
        }
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
