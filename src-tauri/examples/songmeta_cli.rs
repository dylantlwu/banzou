//! 给真实曲库建资料表（docs/资料清单.md §6.3）：先预演，用户确认后再写。
//!
//! 用法：songmeta_cli <素材文件夹> <配置目录> plan|apply [定好的值.json]
//!       songmeta_cli <素材文件夹> <配置目录> ai-plan <预演.json>   AI 联网查，只把打算写的存进预演文件
//!       songmeta_cli <素材文件夹> <配置目录> ai-apply <预演.json>  照预演原样写（by = ai，用户填的不覆盖），顺手搜歌词
//!       songmeta_cli <素材文件夹> <配置目录> tv-install <电视地址> <缓存目录>  把随应用带的电视 APP 装到电视（和「电视」窗口一样）
//!       songmeta_cli <素材文件夹> <配置目录> video-probe|video-download <缓存目录> <链接>   读视频信息 / 下载（只下这一个，不下播放列表）
//!       songmeta_cli <素材文件夹> <配置目录> separate <缓存目录> <视频路径> <歌名>     做成伴奏（已有的伴奏 / 人声不覆盖）
//!       songmeta_cli <素材文件夹> <配置目录> lyrics-search <歌名键> <电视缓存目录>   搜歌词（时长对不上时返回候选，不写）
//!       songmeta_cli <素材文件夹> <配置目录> transcribe <人声文件> <缓存目录>        识别人声（智能对齐用）
//!       songmeta_cli <素材文件夹> <配置目录> lyrics-result <歌名键> <歌词文件|空> <说明>  写对齐结果（不覆盖已有 .lrc）
//!       songmeta_cli <素材文件夹> <配置目录> tv-sync <电视地址> <缓存目录>     同步电视歌单（和应用里一样：资料表 + 歌单，拉回常点）
//! - 读配置目录里的 tags.json；ai-plan 另外由 tags::guess_all 读 ai.json 里的 key 去问 Claude（不打印、不写）
//! - plan：只打印会写什么，不写任何文件
//! - apply：只新建 `<歌名>.song.json`、改资料表里的字段，不删、不改其他文件；tags.json 不动
//! - 定好的值.json：{ "歌名键": { "字段": "值" } }，按「用户填的」写（这份文件放在仓库外面）

use banzou_lib::{library, settings, songmeta, tv, video};
use serde_json::Value;
use std::path::Path;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let (Some(root), Some(config), Some(mode)) = (argv.get(1), argv.get(2), argv.get(3)) else {
        eprintln!("用法：songmeta_cli <素材文件夹> <配置目录> plan|apply [定好的值.json]");
        std::process::exit(2);
    };
    let root = Path::new(root);
    let tags = settings::load_store(Path::new(config), "tags").unwrap_or(Value::Null);
    // 下载视频 / 做成伴奏：和应用「下载视频」「做成伴奏」同一套代码（工具在配置目录 tools/，临时文件在 <缓存目录>/video）
    if mode == "video-probe" || mode == "video-download" || mode == "separate" {
        let arg = |i: usize| argv.get(i).cloned().unwrap_or_else(|| {
            eprintln!("参数不够");
            std::process::exit(2)
        });
        let dirs = video::Dirs { tools: Path::new(config).join("tools"), work: Path::new(&arg(4)).join("video") };
        let r: Result<String, String> = match mode.as_str() {
            "video-probe" => video::probe(&dirs, &arg(5)).map(|v| serde_json::to_string(&v).unwrap()),
            "video-download" => video::download(&dirs, &arg(5), "compat", root).map(|v| serde_json::to_string(&v).unwrap()),
            _ => banzou_lib::separate::run(&dirs, root, &arg(5), &arg(6)).map(|v| serde_json::to_string(&v).unwrap()),
        };
        match r {
            Ok(t) => println!("{t}"),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        return;
    }
    // 搜歌词 / 识别人声 / 写对齐结果（和应用里「AI 搜歌词」的同一套后端；对齐本身在前端 smartAlign）
    if mode == "lyrics-search" || mode == "transcribe" || mode == "lyrics-result" {
        let arg = |i: usize| argv.get(i).cloned().unwrap_or_else(|| {
            eprintln!("参数不够");
            std::process::exit(2)
        });
        let cfg = Path::new(config);
        let r: Result<String, String> = match mode.as_str() {
            "lyrics-search" => songmeta::command(root, cfg, Path::new(&arg(5)), "lyrics_search", &serde_json::json!({ "key": arg(4) })).unwrap().map(|v| v.to_string()),
            "transcribe" => {
                let helper = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/banzou-helper-aarch64-apple-darwin");
                banzou_lib::transcribe::checked_audio_path(root, Path::new(&arg(4)))
                    .and_then(|a| banzou_lib::transcribe::transcribe(&helper, &a, Path::new(&arg(5))))
                    .map(|t| serde_json::to_string(&t).unwrap())
            }
            _ => {
                let content = std::fs::read_to_string(arg(5)).ok().filter(|c| !c.trim().is_empty());
                let lib = library::scan_dir(root).expect("扫描曲库失败");
                songmeta::lyrics_result(root, &lib, &tags, &arg(4), content.as_deref(), &arg(6)).map(|_| "写好了".to_string())
            }
        };
        match r {
            Ok(t) => println!("{t}"),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        return;
    }
    if mode == "tv-install" || mode == "tv-sync" {
        let (Some(addr), Some(cache)) = (argv.get(4), argv.get(5)) else {
            eprintln!("缺少电视地址或缓存目录");
            std::process::exit(2);
        };
        let dirs = video::Dirs { tools: Path::new(config).join("tools"), work: Path::new(cache).join("tv") };
        let r = if mode == "tv-install" {
            tv::install_app(&dirs, addr).map(|_| format!("电视 APP 已装好（版本 {}）", tv::APP_VERSION))
        } else {
            let lib = library::scan_dir(root).expect("扫描曲库失败");
            let (songs, view) = songmeta::catalog_songs(root, &lib, &tags);
            let pulled = dirs.work.join("plays-from-tv.json");
            let _ = std::fs::remove_file(&pulled);
            let r = tv::sync_catalog(&dirs, addr, &songs, &view, &pulled);
            if pulled.is_file() && serde_json::from_slice::<Value>(&std::fs::read(&pulled).unwrap_or_default()).is_ok_and(|v| v.is_object()) {
                let _ = std::fs::copy(&pulled, Path::new(config).join("plays.json"));
            }
            r.map(|x| format!("电视歌单同步好了：{} 首，新做了 {} 个预览", x.songs, x.new_previews))
        };
        match r {
            Ok(t) => println!("{t}"),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        return;
    }
    if mode == "ai-plan" || mode == "ai-apply" {
        let file = argv.get(4).expect("缺少预演文件路径");
        let r = if mode == "ai-plan" {
            songmeta::ai_propose(Path::new(config), root, &tags, None, false, None).map(|p| {
                std::fs::write(file, serde_json::to_vec_pretty(&p).unwrap()).expect("写不了预演文件");
                format!("查了 {} 首，预演存在 {file}", p.len())
            })
        } else {
            let p: Vec<songmeta::AiProposal> = serde_json::from_slice(&std::fs::read(file).expect("读不了预演文件")).expect("预演文件格式不对");
            let dirs = video::Dirs { tools: Path::new(config).join("tools"), work: std::env::temp_dir() };
            songmeta::ai_apply(root, &tags, &p, |a| video::media_info(&dirs, a).duration).map(|v| v.to_string())
        };
        match r {
            Ok(t) => println!("{t}"),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        return;
    }
    let settled: Value = argv.get(4).map(|p| serde_json::from_slice(&std::fs::read(p).expect("读不了定好的值")).expect("定好的值格式不对")).unwrap_or(Value::Null);
    let lib = library::scan_dir(root).expect("扫描曲库失败");
    if let Some(obj) = settled.as_object() {
        for k in obj.keys() {
            if !lib.songs.iter().any(|s| &s.title == k) {
                eprintln!("定好的值里的「{k}」不在曲库里");
                std::process::exit(1);
            }
        }
    }
    match mode.as_str() {
        "plan" => println!("{}", serde_json::to_string_pretty(&songmeta::migrate_plan(root, &lib, &tags, &settled)).unwrap()),
        "apply" => match songmeta::migrate_apply(root, &lib, &tags, &settled) {
            Ok(n) => println!("写好了 {n} 个资料表"),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        },
        _ => {
            eprintln!("第三个参数只能是 plan 或 apply");
            std::process::exit(2);
        }
    }
}
