//! 把视频 / 歌曲做成伴奏（PRD 4.11）：用 Demucs（htdemucs_ft，两轨）分离出人声和伴奏，
//! 存成素材文件夹里的「歌名 - 伴奏.wav」「歌名 - 人声.wav」，曲库自动配成一首歌。
//!
//! Demucs 装在应用数据目录 tools/demucs 的 Python 虚拟环境里（系统自带的 python3 建，
//! pip 装 demucs + soundfile），第一次分离时 Demucs 会自己下载模型（约 300 MB，缓存在 ~/.cache/torch）。
//! 进度和下载视频共用同一个任务状态文件。

use crate::video::{self, Dirs};
use serde::Serialize;
use std::fs;
use std::io::{BufReader, Read};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SYSTEM_PYTHON: &str = "/usr/bin/python3";
const MODEL: &str = "htdemucs_ft";
/// htdemucs_ft 是 4 个模型的组合，每个模型各跑一遍进度条
const MODEL_PARTS: f64 = 4.0;

fn venv(dirs: &Dirs) -> PathBuf {
    dirs.tools.join("demucs")
}

fn python(dirs: &Dirs) -> PathBuf {
    venv(dirs).join("bin/python")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SepStatus {
    /// 装好的 demucs 版本；没装为空
    pub demucs: Option<String>,
    /// 系统有没有 python3（要先装 Xcode 命令行工具）
    pub has_python: bool,
}

/// 从 site-packages 里的 demucs-x.y.z.dist-info 读版本（不用启动 Python，打开窗口时要快）
fn installed_version(dirs: &Dirs) -> Option<String> {
    if !python(dirs).exists() {
        return None;
    }
    let lib = venv(dirs).join("lib");
    for py in fs::read_dir(&lib).ok()?.flatten() {
        let site = py.path().join("site-packages");
        for e in fs::read_dir(&site).ok()?.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(v) = name.strip_prefix("demucs-").and_then(|r| r.strip_suffix(".dist-info")) {
                return Some(v.to_string());
            }
        }
    }
    None
}

pub fn status(dirs: &Dirs) -> SepStatus {
    // 没装 Xcode 命令行工具时，运行 /usr/bin/python3 会弹窗让用户装，所以先看 xcode-select
    let has_python = Command::new("/usr/bin/xcode-select").arg("-p").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
    SepStatus { demucs: installed_version(dirs), has_python }
}

/// 跑一个命令，输出逐行交给 `on_line`；可被取消（整个进程组结束）
fn run_streaming(dirs: &Dirs, job: &mut video::Job, cmd: &mut Command, mut on_line: impl FnMut(&mut video::Job, &str) -> bool) -> Result<String, String> {
    if video::cancelled(dirs) {
        return Err("已取消".into());
    }
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0).spawn().map_err(|e| e.to_string())?;
    job.pid = Some(child.id());
    video::write_job(dirs, job);
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let tx2 = tx.clone();
    let out = child.stdout.take().ok_or("拿不到输出")?;
    let err = child.stderr.take().ok_or("拿不到输出")?;
    // tqdm 进度条用回车刷新，不换行，所以按字节读、遇到 \r 或 \n 都算一行
    let reader = |r: Box<dyn std::io::Read + Send>, tx: std::sync::mpsc::Sender<String>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            for b in BufReader::new(r).bytes().map_while(Result::ok) {
                if b == b'\r' || b == b'\n' {
                    if !buf.is_empty() {
                        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
                        buf.clear();
                    }
                } else {
                    buf.push(b);
                }
            }
            if !buf.is_empty() {
                let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
            }
        })
    };
    let t1 = reader(Box::new(out), tx);
    let t2 = reader(Box::new(err), tx2);
    let mut log = String::new();
    let mut last = Instant::now();
    for line in rx {
        if on_line(job, &line) && (last.elapsed() > Duration::from_millis(250) || job.percent.is_none()) {
            video::write_job(dirs, job);
            last = Instant::now();
        }
        if !line.contains("%|") {
            log.push_str(&line);
            log.push('\n');
        }
    }
    let _ = t1.join();
    let _ = t2.join();
    let status = child.wait().map_err(|e| e.to_string())?;
    job.pid = None;
    if video::cancelled(dirs) {
        return Err("已取消".into());
    }
    if !status.success() {
        let tail: Vec<&str> = log.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = tail[tail.len().saturating_sub(3)..].join(" / ");
        return Err(tail);
    }
    Ok(log)
}

/// 安装 Demucs：建虚拟环境，pip 装 demucs 和 soundfile（PyTorch 跟着装，约 1 GB）
pub fn install(dirs: &Dirs) -> Result<SepStatus, String> {
    if !status(dirs).has_python {
        return Err("这台 Mac 还没有 Python：先在「终端」里运行 xcode-select --install 装好命令行工具，再回来点安装".into());
    }
    let mut job = video::begin(dirs, "install-sep", "准备 Python 环境")?;
    let dir = venv(dirs);
    let result = (|| {
        fs::create_dir_all(&dirs.tools).map_err(|e| e.to_string())?;
        let _ = fs::remove_dir_all(&dir);
        run_streaming(dirs, &mut job, Command::new(SYSTEM_PYTHON).args(["-m", "venv"]).arg(&dir), |_, _| false).map_err(|e| format!("建 Python 环境失败：{e}"))?;
        job.text = "升级 pip".into();
        run_streaming(dirs, &mut job, Command::new(python(dirs)).args(["-m", "pip", "install", "-q", "--disable-pip-version-check", "--upgrade", "pip"]), |_, _| false)
            .map_err(|e| format!("升级 pip 失败：{e}"))?;
        job.text = "下载 Demucs 和 PyTorch（约 1 GB）".into();
        run_streaming(
            dirs,
            &mut job,
            Command::new(python(dirs)).args(["-m", "pip", "install", "--disable-pip-version-check", "--progress-bar", "off", "demucs", "soundfile"]),
            |job, line| {
                // 「Downloading torch-2.8.0-…whl (74.7 MB)」→ 显示正在下哪个包
                let l = line.trim();
                if let Some(rest) = l.strip_prefix("Downloading ").or_else(|| l.strip_prefix("Collecting ")) {
                    let pkg = rest.split(['-', ' ', '=', '>', '<']).next().unwrap_or(rest);
                    job.text = format!("下载 {pkg}（Demucs 和 PyTorch 共约 1 GB）");
                    return true;
                }
                if l.starts_with("Installing collected packages") {
                    job.text = "安装中…".into();
                    return true;
                }
                false
            },
        )
        .map_err(|e| format!("安装 Demucs 失败：{e}"))?;
        installed_version(dirs).ok_or("装完了但找不到 demucs")?;
        Ok(status(dirs))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&dir);
    }
    video::finish(dirs, &mut job);
    result
}

/// Demucs 输出的一行 → 进度。返回 true 表示要刷新状态
///
/// 第一次用时先下载模型（torch.hub 打印「Downloading: …」再出进度条），
/// 然后「Separating track …」，4 个模型各跑一条 0–100% 的进度条。
pub fn apply_demucs_line(job: &mut video::Job, state: &mut (bool, usize, f64), line: &str) -> bool {
    let (separating, part, last) = state;
    if line.contains("Downloading:") || line.contains("Downloading ") {
        *separating = false;
        job.text = "第一次用，下载分离模型（约 300 MB）".into();
        job.percent = Some(0.0);
        return true;
    }
    if line.contains("Separating track") {
        *separating = true;
        *part = 0;
        *last = 0.0;
        job.text = "分离人声".into();
        job.percent = Some(0.0);
        return true;
    }
    let Some(i) = line.find("%|") else { return false };
    let digits: String = line[..i].chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
    let Ok(p) = digits.parse::<f64>() else { return false };
    if !*separating {
        job.percent = Some(p);
        return true;
    }
    // 进度条从头开始 = 换到下一个模型
    if p + 30.0 < *last && (*part as f64) < MODEL_PARTS - 1.0 {
        *part += 1;
    }
    *last = p;
    job.percent = Some(((*part as f64 * 100.0 + p) / MODEL_PARTS).min(100.0));
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Separated {
    pub name: String,
    /// 这次写出来的文件（已经存在的不覆盖，不在这里）
    pub written: Vec<String>,
    /// 已经存在、没有覆盖的文件
    pub kept: Vec<String>,
    pub seconds: f64,
}

/// 歌名里不能放进文件名的字符换掉
pub fn clean_name(name: &str) -> String {
    name.chars()
        .map(|c| if matches!(c, '/' | ':' | '\\' | '\0') { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_start_matches('.')
        .to_string()
}

/// 把 `source`（素材文件夹里的视频或音频）做成「name - 伴奏.wav」「name - 人声.wav」
pub fn run(dirs: &Dirs, root: &Path, source: &str, name: &str) -> Result<Separated, String> {
    let root_c = root.canonicalize().map_err(|e| format!("素材文件夹不可用：{e}"))?;
    let src = Path::new(source).canonicalize().map_err(|e| format!("找不到文件：{e}"))?;
    if !src.starts_with(&root_c) {
        return Err("只能处理素材文件夹里的文件".into());
    }
    let name = clean_name(name);
    if name.is_empty() {
        return Err("先填歌名".into());
    }
    if installed_version(dirs).is_none() {
        return Err("SEP_MISSING".into());
    }
    let ffmpeg = dirs.ffmpeg();
    if !ffmpeg.is_file() {
        return Err("TOOLS_MISSING".into());
    }
    let acc = root.join(format!("{name} - 伴奏.wav"));
    let voc = root.join(format!("{name} - 人声.wav"));
    if acc.exists() && voc.exists() {
        return Err(format!("「{name} - 伴奏.wav」和「{name} - 人声.wav」都已经有了；要重做就先把它们删掉，或者换个歌名"));
    }

    let mut job = video::begin(dirs, "separate", "抽出音频")?;
    let tmp = dirs.work.join(format!("sep-{}", job.started));
    let started = Instant::now();
    let result = (|| {
        fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let wav = tmp.join("song.wav");
        run_streaming(dirs, &mut job, Command::new(&ffmpeg).args(["-hide_banner", "-loglevel", "error", "-y", "-i"]).arg(&src).args(["-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le"]).arg(&wav), |_, _| false)
            .map_err(|e| format!("抽出音频失败：{e}"))?;

        job.text = "启动 Demucs".into();
        let device = if cfg!(target_arch = "aarch64") { "mps" } else { "cpu" };
        let mut state = (false, 0usize, 0.0f64);
        run_streaming(
            dirs,
            &mut job,
            Command::new(python(dirs))
                .args(["-m", "demucs", "-n", MODEL, "--two-stems", "vocals", "-d", device, "--float32", "-o"])
                .arg(tmp.join("sep"))
                .arg(&wav)
                .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
                .env("PYTHONUNBUFFERED", "1"),
            |job, line| apply_demucs_line(job, &mut state, line),
        )
        .map_err(|e| format!("分离失败：{e}"))?;

        job.text = "保存".into();
        job.percent = None;
        video::write_job(dirs, &job);
        let out = tmp.join("sep").join(MODEL).join("song");
        let mut written = Vec::new();
        let mut kept = Vec::new();
        for (stem, dest) in [("no_vocals.wav", &acc), ("vocals.wav", &voc)] {
            if dest.exists() {
                kept.push(dest.to_string_lossy().into_owned());
                continue;
            }
            // 先写到临时文件再改名，曲库不会扫到写了一半的文件
            let part = tmp.join(format!("out-{stem}"));
            run_streaming(dirs, &mut job, Command::new(&ffmpeg).args(["-hide_banner", "-loglevel", "error", "-y", "-i"]).arg(out.join(stem)).args(["-c:a", "pcm_s16le"]).arg(&part), |_, _| false)
                .map_err(|e| format!("保存失败：{e}"))?;
            if fs::rename(&part, dest).is_err() {
                fs::copy(&part, dest).map_err(|e| format!("保存失败：{e}"))?;
            }
            written.push(dest.to_string_lossy().into_owned());
        }
        Ok(Separated { name: name.clone(), written, kept, seconds: started.elapsed().as_secs_f64() })
    })();
    let _ = fs::remove_dir_all(&tmp);
    video::finish(dirs, &mut job);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demucs_progress_over_four_models() {
        let mut job = video::Job::default();
        let mut st = (false, 0usize, 0.0);
        assert!(apply_demucs_line(&mut job, &mut st, "Downloading: \"https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/f7e0c4bc-ba3fe64a.th\" to /x"));
        assert!(apply_demucs_line(&mut job, &mut st, " 50%|█████     | 40.1M/80.2M [00:03<00:03, 12.0MB/s]"));
        assert_eq!(job.percent, Some(50.0));
        assert!(apply_demucs_line(&mut job, &mut st, "Separating track /tmp/song.wav"));
        assert_eq!((job.text.as_str(), job.percent), ("分离人声", Some(0.0)));
        apply_demucs_line(&mut job, &mut st, "100%|██████████| 234.0/234.0 [00:41<00:00,  5.62seconds/s]");
        assert_eq!(job.percent, Some(25.0));
        apply_demucs_line(&mut job, &mut st, "  4%|▍         | 10.0/234.0 [00:01<00:30,  7.1seconds/s]");
        assert_eq!(job.percent, Some(26.0));
        apply_demucs_line(&mut job, &mut st, "100%|██████████| 234.0/234.0");
        apply_demucs_line(&mut job, &mut st, "  0%|          | 0/234.0");
        apply_demucs_line(&mut job, &mut st, "100%|██████████| 234.0/234.0");
        apply_demucs_line(&mut job, &mut st, "  0%|          | 0/234.0");
        apply_demucs_line(&mut job, &mut st, "100%|██████████| 234.0/234.0");
        assert_eq!(job.percent, Some(100.0));
        assert!(!apply_demucs_line(&mut job, &mut st, "Selected model is a bag of 4 models."));
    }

    #[test]
    fn names_are_file_safe() {
        assert_eq!(clean_name("  寂寞先生 / 曹格 "), "寂寞先生 曹格");
        assert_eq!(clean_name("..a:b"), "a b");
        assert_eq!(clean_name("   "), "");
    }
}
