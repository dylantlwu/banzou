//! 下载 YouTube 视频（PRD 4.10）：粘贴链接 → 读视频信息 → 下载到素材文件夹。
//!
//! 用两个外部程序，都由应用自己管理（放在应用数据目录的 tools/，不依赖 PATH）：
//! - yt-dlp：GitHub 官方发布的 macOS 文件夹版 yt-dlp_macos.zip，核对 GitHub 给的 SHA-256
//! - ffmpeg：PyPI 上 imageio-ffmpeg 的 macOS 安装包里自带的静态 ffmpeg，核对 PyPI 给的 SHA-256
//!
//! 安装和下载都是长任务，进度写在一个状态文件里（job.json），前端轮询读取；
//! 这样正式应用和测试模式（每次调用一个新进程的 devbridge）用同一套逻辑。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const YTDLP_RELEASE_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const YTDLP_ASSET: &str = "yt-dlp_macos.zip";
const YTDLP_DIR: &str = "yt-dlp_macos";
const YTDLP_EXE: &str = "yt-dlp_macos";
const FFMPEG_PYPI: &str = "https://pypi.org/pypi/imageio-ffmpeg/json";

/// 兼容版：H.264 + AAC（QuickTime 能直接放，YouTube 上最高 1080p）
const FORMAT_COMPAT: &str = "bv*[vcodec^=avc1]+ba[ext=m4a]/b[vcodec^=avc1]/bv*+ba/b";
/// 最高画质：常常是 AV1 / VP9，声音仍优先 AAC
const FORMAT_BEST: &str = "bv*+ba[ext=m4a]/bv*+ba/b";

/// 应用自己的工具和临时文件放在哪
#[derive(Debug, Clone)]
pub struct Dirs {
    /// yt-dlp、ffmpeg 所在目录
    pub tools: PathBuf,
    /// 任务状态文件和下载临时文件
    pub work: PathBuf,
}

impl Dirs {
    /// 文件夹版 tools/yt-dlp_macos/yt-dlp_macos；没有时退回单文件 tools/yt-dlp（自己放进去的）
    fn ytdlp(&self) -> PathBuf {
        find_ytdlp_exe(&self.tools.join(YTDLP_DIR)).unwrap_or_else(|| self.tools.join("yt-dlp"))
    }
    pub(crate) fn ffmpeg(&self) -> PathBuf {
        self.tools.join("ffmpeg")
    }
    fn job_file(&self) -> PathBuf {
        self.work.join("job.json")
    }
    fn cancel_file(&self) -> PathBuf {
        self.work.join("job.cancel")
    }
}

// ---------- 任务状态 ----------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// "install" | "download" | "update"
    pub kind: String,
    /// 显示给用户的当前步骤，如「下载画面」
    pub text: String,
    /// 0–100；不知道总大小时为空
    pub percent: Option<f64>,
    /// 正在跑的子进程（进程组号），取消时整组结束
    pub pid: Option<u32>,
    /// 执行任务的进程（应用本身，或测试模式的 devbridge）；它没了任务就算结束
    pub owner: u32,
    pub running: bool,
    pub started: u64,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub(crate) fn write_job(dirs: &Dirs, job: &Job) {
    let _ = fs::create_dir_all(&dirs.work);
    let tmp = dirs.work.join("job.json.tmp");
    if fs::write(&tmp, serde_json::to_vec(job).unwrap_or_default()).is_ok() {
        let _ = fs::rename(&tmp, dirs.job_file());
    }
}

fn pid_alive(pid: u32) -> bool {
    Command::new("/bin/kill").args(["-0", &pid.to_string()]).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

/// 当前任务的状态；没有任务、或者上次应用退出时留下的旧状态，返回 None
pub fn job_status(dirs: &Dirs) -> Option<Job> {
    let job: Job = serde_json::from_slice(&fs::read(dirs.job_file()).ok()?).ok()?;
    if !job.running {
        return None;
    }
    pid_alive(job.owner).then_some(job)
}

/// 取消当前任务：结束整个子进程组（yt-dlp 合并时还会再起 ffmpeg）
pub fn cancel(dirs: &Dirs) {
    let _ = fs::create_dir_all(&dirs.work);
    let _ = fs::write(dirs.cancel_file(), b"1");
    if let Some(pid) = job_status(dirs).and_then(|j| j.pid) {
        let _ = Command::new("/bin/kill").args(["-TERM", "--", &format!("-{pid}")]).status();
    }
}

pub(crate) fn cancelled(dirs: &Dirs) -> bool {
    dirs.cancel_file().exists()
}

/// 开始一个任务；已有任务在跑时拒绝
pub(crate) fn begin(dirs: &Dirs, kind: &str, text: &str) -> Result<Job, String> {
    if let Some(j) = job_status(dirs) {
        return Err(format!("还有一个任务没完成：{}", j.text));
    }
    let _ = fs::remove_file(dirs.cancel_file());
    let job = Job { kind: kind.into(), text: text.into(), percent: None, pid: None, owner: std::process::id(), running: true, started: now_secs() };
    write_job(dirs, &job);
    Ok(job)
}

pub(crate) fn finish(dirs: &Dirs, job: &mut Job) {
    job.running = false;
    job.pid = None;
    write_job(dirs, job);
    let _ = fs::remove_file(dirs.cancel_file());
}

// ---------- 工具 ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    /// yt-dlp 版本；没装为空
    pub ytdlp: Option<String>,
    /// ffmpeg 版本；没装为空
    pub ffmpeg: Option<String>,
    pub dir: String,
}

pub(crate) fn first_line_of(cmd: &Path, args: &[&str]) -> Option<String> {
    if !cmd.is_file() {
        return None;
    }
    let out = Command::new(cmd).args(args).stdin(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().next().map(|l| l.trim().to_string())
}

fn ffmpeg_version(path: &Path) -> Option<String> {
    // "ffmpeg version 7.1 Copyright ..." → "7.1"
    let line = first_line_of(path, &["-hide_banner", "-version"])?;
    Some(line.split_whitespace().nth(2).unwrap_or(&line).to_string())
}

pub fn tool_status(dirs: &Dirs) -> ToolStatus {
    ToolStatus {
        ytdlp: first_line_of(&dirs.ytdlp(), &["--version"]),
        ffmpeg: ffmpeg_version(&dirs.ffmpeg()),
        dir: dirs.tools.to_string_lossy().into_owned(),
    }
}

/// 用系统自带的 curl 取一个小文件（JSON 等）
fn curl_text(url: &str) -> Result<String, String> {
    let out = Command::new("/usr/bin/curl")
        .args(["-fsSL", "--retry", "2", "--max-time", "30", "-H", "User-Agent: banzou", url])
        .output()
        .map_err(|e| format!("curl 启动失败：{e}"))?;
    if !out.status.success() {
        return Err(format!("连不上 {}（{}）", host_of(url), String::from_utf8_lossy(&out.stderr).trim()));
    }
    String::from_utf8(out.stdout).map_err(|e| e.to_string())
}

fn host_of(url: &str) -> &str {
    url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url)
}

/// 下载一个大文件到 `dest`，边下边把进度写进任务状态
fn curl_file(dirs: &Dirs, job: &mut Job, url: &str, dest: &Path, size: Option<u64>, label: &str) -> Result<(), String> {
    if cancelled(dirs) {
        return Err("已取消".into());
    }
    let _ = fs::remove_file(dest);
    let mut child = Command::new("/usr/bin/curl")
        .args(["-fsSL", "--retry", "2", "--connect-timeout", "20", "-H", "User-Agent: banzou", "-o"])
        .arg(dest)
        .arg(url)
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("curl 启动失败：{e}"))?;
    job.pid = Some(child.id());
    job.text = label.into();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            job.pid = None;
            if cancelled(dirs) {
                return Err("已取消".into());
            }
            if !status.success() {
                let mut err = String::new();
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_string(&mut err);
                }
                return Err(format!("下载 {label} 失败：{}", err.trim()));
            }
            return Ok(());
        }
        if cancelled(dirs) {
            let _ = child.kill();
        }
        let got = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        job.percent = size.filter(|s| *s > 0).map(|s| (got as f64 / s as f64 * 100.0).min(100.0));
        write_job(dirs, job);
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())
}

/// GitHub 上 yt-dlp 最新版：(版本号, 下载地址, 大小, SHA-256)
fn latest_ytdlp() -> Result<(String, String, Option<u64>, String), String> {
    let release: Value = serde_json::from_str(&curl_text(YTDLP_RELEASE_API)?).map_err(|e| e.to_string())?;
    let assets = release["assets"].as_array().ok_or("GitHub 返回的信息不对")?;
    let asset = assets.iter().find(|a| a["name"] == YTDLP_ASSET).ok_or("GitHub 上没找到 yt-dlp_macos.zip")?;
    let url = asset["browser_download_url"].as_str().ok_or("GitHub 返回的信息不对")?;
    let expected = match asset["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")) {
        Some(d) => d.to_string(),
        None => {
            // 旧接口没有 digest 字段时，读同一版本的 SHA2-256SUMS
            let sums_url = assets.iter().find(|a| a["name"] == "SHA2-256SUMS").and_then(|a| a["browser_download_url"].as_str()).ok_or("没找到 yt-dlp 的校验文件")?;
            let sums = curl_text(sums_url)?;
            sums.lines()
                .find_map(|l| {
                    let mut p = l.split_whitespace();
                    let (hash, name) = (p.next()?, p.next()?);
                    (name == YTDLP_ASSET).then(|| hash.to_string())
                })
                .ok_or("校验文件里没有 yt-dlp_macos.zip")?
        }
    };
    let version = release["tag_name"].as_str().unwrap_or("").to_string();
    Ok((version, url.to_string(), asset["size"].as_u64(), expected.to_lowercase()))
}

/// 从 GitHub 官方发布下载 yt-dlp（文件夹版 yt-dlp_macos.zip），解压到 tools/yt-dlp_macos/
///
/// 不用单文件版 yt-dlp_macos：它每次运行都把一百多个库解压到新的临时文件夹，
/// macOS 每次都要重新核对这些库的签名，光启动就要二三十秒；文件夹版只在第一次核对。
fn install_ytdlp(dirs: &Dirs, job: &mut Job, tmp: &Path) -> Result<String, String> {
    job.text = "查询 yt-dlp 最新版本".into();
    write_job(dirs, job);
    let (version, url, size, expected) = latest_ytdlp()?;
    let zip = tmp.join("yt-dlp.zip");
    curl_file(dirs, job, &url, &zip, size, &format!("下载 yt-dlp {version}"))?;
    if sha256_file(&zip)? != expected {
        return Err("下载的 yt-dlp 校验不对，没有安装（可能是网络问题，再试一次）".into());
    }
    job.text = "解压 yt-dlp".into();
    job.percent = None;
    write_job(dirs, job);
    let unpacked = tmp.join("yt-dlp_macos");
    let _ = fs::remove_dir_all(&unpacked);
    // ditto 会保留可执行权限和符号链接（里面有 Python.framework）
    let status = Command::new("/usr/bin/ditto").args(["-x", "-k"]).arg(&zip).arg(&unpacked).status().map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&zip);
    if !status.success() {
        return Err("解压 yt-dlp 失败".into());
    }
    let exe = find_ytdlp_exe(&unpacked).ok_or("解压出来的文件里没有 yt-dlp_macos")?;
    job.text = "第一次启动 yt-dlp（macOS 要核对一遍，可能要半分钟）".into();
    write_job(dirs, job);
    let got = first_line_of(&exe, &["--version"]).ok_or("下载的 yt-dlp 运行不了")?;
    // 换上新的：先挪走旧的，换好再删
    let dest = dirs.tools.join(YTDLP_DIR);
    let old = dirs.tools.join(".old-yt-dlp");
    let _ = fs::remove_dir_all(&old);
    if dest.exists() {
        fs::rename(&dest, &old).map_err(|e| e.to_string())?;
    }
    if let Err(e) = fs::rename(&unpacked, &dest) {
        let _ = fs::rename(&old, &dest);
        return Err(format!("安装 yt-dlp 失败：{e}"));
    }
    let _ = fs::remove_dir_all(&old);
    // 以前单文件版留下的不再用
    let _ = fs::remove_file(dirs.tools.join("yt-dlp"));
    Ok(got)
}

/// 解压出来的文件夹里找 yt-dlp_macos 可执行文件（在根目录，或多一层文件夹）
fn find_ytdlp_exe(dir: &Path) -> Option<PathBuf> {
    let direct = dir.join(YTDLP_EXE);
    if direct.is_file() {
        return Some(direct);
    }
    fs::read_dir(dir).ok()?.flatten().map(|e| e.path().join(YTDLP_EXE)).find(|p| p.is_file())
}

/// 从 PyPI 的 imageio-ffmpeg 安装包里取出静态 ffmpeg
fn install_ffmpeg(dirs: &Dirs, job: &mut Job, tmp: &Path) -> Result<(), String> {
    job.text = "查询 ffmpeg".into();
    write_job(dirs, job);
    let info: Value = serde_json::from_str(&curl_text(FFMPEG_PYPI)?).map_err(|e| e.to_string())?;
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x86_64" };
    let wheel = info["urls"]
        .as_array()
        .and_then(|u| u.iter().find(|f| f["filename"].as_str().is_some_and(|n| n.contains("macosx") && n.ends_with(&format!("{arch}.whl")))))
        .ok_or("PyPI 上没找到适合这台 Mac 的 ffmpeg")?;
    let url = wheel["url"].as_str().ok_or("PyPI 返回的信息不对")?;
    let expected = wheel["digests"]["sha256"].as_str().ok_or("PyPI 没给校验值")?;
    let whl = tmp.join("ffmpeg.whl");
    curl_file(dirs, job, url, &whl, wheel["size"].as_u64(), "下载 ffmpeg")?;
    if sha256_file(&whl)? != expected.to_lowercase() {
        return Err("下载的 ffmpeg 校验不对，没有安装（可能是网络问题，再试一次）".into());
    }
    job.text = "解压 ffmpeg".into();
    job.percent = None;
    write_job(dirs, job);
    let list = Command::new("/usr/bin/unzip").arg("-Z1").arg(&whl).output().map_err(|e| e.to_string())?;
    let entry = String::from_utf8_lossy(&list.stdout)
        .lines()
        .find(|l| l.starts_with("imageio_ffmpeg/binaries/ffmpeg-") && !l.ends_with(".md"))
        .map(str::to_string)
        .ok_or("安装包里没有 ffmpeg")?;
    let file = tmp.join("ffmpeg");
    let out = fs::File::create(&file).map_err(|e| e.to_string())?;
    let status = Command::new("/usr/bin/unzip").arg("-p").arg(&whl).arg(&entry).stdout(out).status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("解压 ffmpeg 失败".into());
    }
    let _ = fs::remove_file(&whl);
    make_executable(&file)?;
    ffmpeg_version(&file).ok_or("下载的 ffmpeg 运行不了")?;
    fs::rename(&file, dirs.ffmpeg()).map_err(|e| e.to_string())
}

/// 安装缺的工具（已经装好的跳过）
pub fn install_tools(dirs: &Dirs) -> Result<ToolStatus, String> {
    let mut job = begin(dirs, "install", "准备下载工具")?;
    let tmp = dirs.tools.join(".downloading");
    let result = (|| {
        fs::create_dir_all(&tmp).map_err(|e| format!("建不了工具文件夹：{e}"))?;
        let status = tool_status(dirs);
        if status.ytdlp.is_none() {
            install_ytdlp(dirs, &mut job, &tmp)?;
        }
        if cancelled(dirs) {
            return Err("已取消".into());
        }
        if status.ffmpeg.is_none() {
            install_ffmpeg(dirs, &mut job, &tmp)?;
        }
        Ok(tool_status(dirs))
    })();
    let _ = fs::remove_dir_all(&tmp);
    finish(dirs, &mut job);
    result
}

/// 更新 yt-dlp：GitHub 上有新版就重新下载（文件夹版不支持 yt-dlp -U）；返回现在的版本号
pub fn update_ytdlp(dirs: &Dirs) -> Result<String, String> {
    if !dirs.ytdlp().is_file() {
        return Err("还没装 yt-dlp".into());
    }
    let current = first_line_of(&dirs.ytdlp(), &["--version"]);
    let mut job = begin(dirs, "update", "查询 yt-dlp 最新版本")?;
    let tmp = dirs.tools.join(".downloading");
    let result = (|| {
        let (latest, ..) = latest_ytdlp()?;
        // 文件夹版已经是最新就不用重下；单文件版（旧的）一律换成文件夹版
        if current.as_deref() == Some(latest.as_str()) && dirs.ytdlp().starts_with(dirs.tools.join(YTDLP_DIR)) {
            return Ok(latest);
        }
        fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        install_ytdlp(dirs, &mut job, &tmp)
    })();
    let _ = fs::remove_dir_all(&tmp);
    finish(dirs, &mut job);
    result
}

// ---------- 视频信息 ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    /// "compat" | "best"
    pub id: String,
    pub height: u32,
    /// 视频编码，如 H.264 / AV1 / VP9
    pub codec: String,
    /// 估计大小（字节），YouTube 没给时为空
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub title: String,
    pub uploader: Option<String>,
    pub duration: Option<f64>,
    pub url: String,
    /// 第一项是兼容版（默认）；有更高画质时多一项 best
    pub qualities: Vec<Quality>,
}

/// 粘贴来的文字里取出链接；只接受 http(s)
pub fn clean_url(input: &str) -> Result<String, String> {
    let url = input.split_whitespace().find(|w| w.starts_with("http://") || w.starts_with("https://")).ok_or("没认出链接：复制 YouTube 视频页的地址，粘贴进来")?;
    Ok(url.to_string())
}

fn codec_name(vcodec: &str) -> String {
    let v = vcodec.to_lowercase();
    if v.starts_with("avc") || v.starts_with("h264") {
        "H.264".into()
    } else if v.starts_with("av01") || v == "av1" {
        "AV1".into()
    } else if v.starts_with("vp09") || v.starts_with("vp9") {
        "VP9".into()
    } else if v.starts_with("hev") || v.starts_with("hvc") {
        "HEVC".into()
    } else {
        vcodec.to_string()
    }
}

fn fmt_size(f: &Value) -> Option<u64> {
    f["filesize"].as_u64().or_else(|| f["filesize_approx"].as_u64()).or_else(|| f["filesize"].as_f64().map(|v| v as u64))
}

/// 从 yt-dlp -J 的结果里挑出兼容版和最高画质
pub fn qualities_from(info: &Value) -> Vec<Quality> {
    let formats = info["formats"].as_array().cloned().unwrap_or_default();
    let video = |f: &&Value| f["vcodec"].as_str().is_some_and(|v| v != "none") && f["height"].as_u64().is_some();
    let audio = formats
        .iter()
        .filter(|f| f["vcodec"] == "none" && f["ext"] == "m4a")
        .max_by_key(|f| f["abr"].as_f64().map(|v| v as u64).unwrap_or(0));
    let audio_size = audio.and_then(fmt_size);
    let pick = |filter: &dyn Fn(&Value) -> bool| {
        formats
            .iter()
            .filter(video)
            .filter(|f| filter(f))
            .max_by_key(|f| (f["height"].as_u64().unwrap_or(0), f["tbr"].as_f64().map(|v| v as u64).unwrap_or(0)))
    };
    let mut out = Vec::new();
    let to_q = |id: &str, f: &Value| Quality {
        id: id.into(),
        height: f["height"].as_u64().unwrap_or(0) as u32,
        codec: codec_name(f["vcodec"].as_str().unwrap_or("")),
        size: fmt_size(f).map(|v| v + audio_size.unwrap_or(0)),
    };
    let compat = pick(&|f| f["vcodec"].as_str().is_some_and(|v| v.starts_with("avc1")));
    let best = pick(&|_| true);
    if let Some(c) = compat {
        out.push(to_q("compat", c));
    }
    if let Some(b) = best
        && compat.is_none_or(|c| b["height"].as_u64() > c["height"].as_u64())
    {
        out.push(to_q("best", b));
    }
    out
}

fn last_error_line(text: &str) -> Option<String> {
    text.lines().rev().find(|l| l.contains("ERROR")).map(|l| l.trim().trim_start_matches("ERROR:").trim().to_string())
}

/// yt-dlp 的英文报错换成能看懂的话
pub fn friendly_error(raw: &str) -> String {
    let r = raw.to_lowercase();
    let msg = if r.contains("private video") {
        "这是私密视频，下载不了"
    } else if r.contains("confirm your age") || r.contains("age-restricted") {
        "这个视频要登录确认年龄，下载不了"
    } else if r.contains("not a bot") {
        "YouTube 要求验证不是机器人。先点下面的「更新 yt-dlp」再试；还不行就过一阵再下"
    } else if r.contains("unavailable") || r.contains("has been removed") || r.contains("not available") {
        "视频不存在、已下架，或者在这个地区看不了"
    } else if r.contains("unsupported url") || r.contains("is not a valid url") {
        "这个链接认不出来：复制 YouTube 视频页的地址再试"
    } else if r.contains("unable to download") || r.contains("failed to resolve") || r.contains("timed out") || r.contains("connection") || r.contains("nodename nor servname") {
        "连不上 YouTube，检查一下网络"
    } else if r.contains("requested format is not available") {
        "这个视频没有能下载的画质。先点下面的「更新 yt-dlp」再试"
    } else {
        return format!("下载失败：{}。可以先点下面的「更新 yt-dlp」再试", raw.trim());
    };
    msg.to_string()
}

fn need_tools(dirs: &Dirs) -> Result<(), String> {
    if !dirs.ytdlp().is_file() || !dirs.ffmpeg().is_file() {
        return Err("TOOLS_MISSING".into());
    }
    Ok(())
}

/// 读视频信息（标题、时长、有哪些画质），不下载
pub fn probe(dirs: &Dirs, input: &str) -> Result<VideoInfo, String> {
    need_tools(dirs)?;
    let url = clean_url(input)?;
    let out = Command::new(dirs.ytdlp())
        .args(["-J", "--no-playlist", "--no-warnings", "--"])
        .arg(&url)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("yt-dlp 启动失败：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(friendly_error(&last_error_line(&err).unwrap_or_else(|| err.trim().to_string())));
    }
    let info: Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("读不懂 yt-dlp 的结果：{e}"))?;
    let qualities = qualities_from(&info);
    if qualities.is_empty() {
        return Err("这个链接里没有视频".into());
    }
    Ok(VideoInfo {
        title: info["title"].as_str().unwrap_or("").to_string(),
        uploader: info["uploader"].as_str().or_else(|| info["channel"].as_str()).map(str::to_string),
        duration: info["duration"].as_f64(),
        url: info["webpage_url"].as_str().map(str::to_string).unwrap_or(url),
        qualities,
    })
}

// ---------- 下载 ----------

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
    pub codec: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Downloaded {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    /// 同名文件之前就下载过，这次没有重新下
    pub already: bool,
    #[serde(flatten)]
    pub media: MediaInfo,
}

/// 解析 `ffmpeg -i` 打印的信息：时长、第一条视频流的编码和分辨率
pub fn parse_media_info(text: &str) -> MediaInfo {
    let mut info = MediaInfo::default();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Duration:") {
            let t = rest.split(',').next().unwrap_or("").trim();
            let parts: Vec<f64> = t.split(':').filter_map(|p| p.parse().ok()).collect();
            if parts.len() == 3 {
                info.duration = Some(parts[0] * 3600.0 + parts[1] * 60.0 + parts[2]);
            }
        }
        if info.width.is_none() && line.starts_with("Stream #") && line.contains("Video:") {
            let after = line.split("Video:").nth(1).unwrap_or("");
            info.codec = after.split_whitespace().next().map(|c| codec_name(c.trim_end_matches(',')));
            for token in after.split([',', ' ']) {
                if let Some((w, h)) = token.split_once('x')
                    && let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>())
                    && w >= 16
                    && h >= 16
                {
                    info.width = Some(w);
                    info.height = Some(h);
                    break;
                }
            }
        }
    }
    info
}

pub fn media_info(dirs: &Dirs, file: &Path) -> MediaInfo {
    match Command::new(dirs.ffmpeg()).arg("-hide_banner").arg("-i").arg(file).stdin(Stdio::null()).output() {
        Ok(out) => parse_media_info(&String::from_utf8_lossy(&out.stderr)),
        Err(_) => MediaInfo::default(),
    }
}

/// 一行 yt-dlp 进度 → 任务状态。返回 true 表示要刷新状态文件
fn apply_progress(job: &mut Job, line: &str) -> bool {
    if let Some(rest) = line.strip_prefix("BZP ") {
        let p: Vec<&str> = rest.split_whitespace().collect();
        let num = |i: usize| p.get(i).and_then(|v| v.parse::<f64>().ok());
        let got = num(0).unwrap_or(0.0);
        let total = num(1).or(num(2));
        let is_audio = p.get(3).is_some_and(|v| *v == "none");
        job.text = if is_audio { "下载声音".into() } else { "下载画面".into() };
        job.percent = total.filter(|t| *t > 0.0).map(|t| (got / t * 100.0).min(100.0));
        return true;
    }
    if let Some(rest) = line.strip_prefix("BZPP ") {
        job.text = match rest.trim() {
            "Merger" => "把画面和声音合成一个文件".into(),
            "MoveFiles" => "保存".into(),
            _ => "整理文件".into(),
        };
        job.percent = None;
        return true;
    }
    false
}

/// 下载到 `out_dir`。quality = "compat"（H.264，默认）或 "best"（最高画质，文件名带分辨率）
pub fn download(dirs: &Dirs, input: &str, quality: &str, out_dir: &Path) -> Result<Downloaded, String> {
    need_tools(dirs)?;
    let url = clean_url(input)?;
    if !out_dir.is_dir() {
        return Err(format!("文件夹不存在：{}", out_dir.display()));
    }
    let mut job = begin(dirs, "download", "连接 YouTube")?;
    let tmp = dirs.work.join(format!("tmp-{}", job.started));
    let started = SystemTime::now();
    let result = (|| {
        fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        if cancelled(dirs) {
            return Err("已取消".into());
        }
        let (format, name) = if quality == "best" { (FORMAT_BEST, "%(title)s（%(height)sp）.%(ext)s") } else { (FORMAT_COMPAT, "%(title)s.%(ext)s") };
        let mut child = Command::new(dirs.ytdlp())
            .arg("--no-playlist")
            .arg("--ffmpeg-location")
            .arg(&dirs.tools)
            .args(["-f", format, "--merge-output-format", "mp4"])
            .arg("-P")
            .arg(out_dir)
            .arg("-P")
            .arg(format!("temp:{}", tmp.display()))
            .args(["-o", name])
            .args(["--print", "after_move:BZFILE %(filepath)s", "--no-simulate"])
            .args(["--progress", "--newline", "--no-mtime", "--no-warnings"])
            .args([
                "--progress-template",
                "download:BZP %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(info.vcodec)s",
                "--progress-template",
                "postprocess:BZPP %(progress.postprocessor)s",
            ])
            .arg("--")
            .arg(&url)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .map_err(|e| format!("yt-dlp 启动失败：{e}"))?;
        job.pid = Some(child.id());
        write_job(dirs, &job);

        // stderr 另开线程收，免得管道写满卡住；进度在 stdout 或 stderr 都可能出现
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let err_tx = tx.clone();
        let stderr = child.stderr.take().ok_or("拿不到 yt-dlp 输出")?;
        let stdout = child.stdout.take().ok_or("拿不到 yt-dlp 输出")?;
        let t1 = std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = err_tx.send(line);
            }
        });
        let t2 = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
        let mut file: Option<PathBuf> = None;
        let mut errors = String::new();
        let mut last_write = Instant::now();
        for line in rx {
            // 进度可能带回车分段
            for part in line.split('\r') {
                let part = part.trim();
                if let Some(p) = part.strip_prefix("BZFILE ") {
                    file = Some(PathBuf::from(p));
                } else if apply_progress(&mut job, part) {
                    if last_write.elapsed() > Duration::from_millis(200) || job.percent.is_none() {
                        write_job(dirs, &job);
                        last_write = Instant::now();
                    }
                } else if !part.is_empty() {
                    errors.push_str(part);
                    errors.push('\n');
                }
            }
        }
        let _ = t1.join();
        let _ = t2.join();
        let status = child.wait().map_err(|e| e.to_string())?;
        job.pid = None;
        if cancelled(dirs) {
            return Err("已取消".into());
        }
        let file = match (status.success(), file) {
            (true, Some(f)) if f.is_file() => f,
            _ => return Err(friendly_error(&last_error_line(&errors).unwrap_or_else(|| errors.trim().to_string()))),
        };
        let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
        // 加了 --no-mtime，新下载的文件修改时间就是现在；早于开始时间说明是之前下过的
        let already = meta.modified().is_ok_and(|m| m + Duration::from_secs(2) < started);
        job.text = "读取文件信息".into();
        write_job(dirs, &job);
        Ok(Downloaded {
            path: file.to_string_lossy().into_owned(),
            file_name: file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            size: meta.len(),
            already,
            media: media_info(dirs, &file),
        })
    })();
    let _ = fs::remove_dir_all(&tmp);
    finish(dirs, &mut job);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn picks_compat_and_best() {
        let info = json!({ "formats": [
            { "format_id": "140", "vcodec": "none", "ext": "m4a", "abr": 129.5, "filesize": 3_000_000 },
            { "format_id": "251", "vcodec": "none", "ext": "webm", "abr": 140.0 },
            { "format_id": "137", "vcodec": "avc1.640028", "ext": "mp4", "height": 1080, "tbr": 4000.0, "filesize": 50_000_000 },
            { "format_id": "136", "vcodec": "avc1.4d401f", "ext": "mp4", "height": 720, "tbr": 2000.0 },
            { "format_id": "401", "vcodec": "av01.0.12M.08", "ext": "mp4", "height": 2160, "tbr": 18000.0, "filesize_approx": 200_000_000 },
            { "format_id": "313", "vcodec": "vp9", "ext": "webm", "height": 2160, "tbr": 16000.0 },
            { "format_id": "sb0", "vcodec": "none", "ext": "mhtml" }
        ]});
        let q = qualities_from(&info);
        assert_eq!(q.len(), 2);
        assert_eq!((q[0].id.as_str(), q[0].height, q[0].codec.as_str(), q[0].size), ("compat", 1080, "H.264", Some(53_000_000)));
        assert_eq!((q[1].id.as_str(), q[1].height, q[1].codec.as_str()), ("best", 2160, "AV1"));
    }

    #[test]
    fn no_best_when_h264_is_highest() {
        let info = json!({ "formats": [
            { "vcodec": "avc1.640028", "ext": "mp4", "height": 1080, "tbr": 4000.0 },
            { "vcodec": "vp9", "ext": "webm", "height": 1080, "tbr": 3000.0 }
        ]});
        let q = qualities_from(&info);
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].id, "compat");
    }

    #[test]
    fn parses_ffmpeg_info() {
        let text = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':\n  Duration: 00:03:45.12, start: 0.000000, bitrate: 2500 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 2368 kb/s, 25 fps\n  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s";
        let m = parse_media_info(text);
        assert_eq!((m.width, m.height, m.codec.as_deref()), (Some(1920), Some(1080), Some("H.264")));
        assert!((m.duration.unwrap() - 225.12).abs() < 1e-6);
    }

    #[test]
    fn progress_lines() {
        let mut job = Job::default();
        assert!(apply_progress(&mut job, "BZP 500 1000 NA avc1.640028"));
        assert_eq!((job.text.as_str(), job.percent), ("下载画面", Some(50.0)));
        assert!(apply_progress(&mut job, "BZP 10 NA 40 none"));
        assert_eq!((job.text.as_str(), job.percent), ("下载声音", Some(25.0)));
        assert!(apply_progress(&mut job, "BZPP Merger"));
        assert_eq!(job.percent, None);
        assert!(!apply_progress(&mut job, "ERROR: x"));
    }

    #[test]
    fn url_and_errors() {
        assert_eq!(clean_url("  https://www.youtube.com/watch?v=abc&list=RDabc \n").unwrap(), "https://www.youtube.com/watch?v=abc&list=RDabc");
        assert_eq!(clean_url("看这个 https://youtu.be/abc").unwrap(), "https://youtu.be/abc");
        assert!(clean_url("-o /tmp/x").is_err());
        assert_eq!(friendly_error("[youtube] abc: Private video. Sign in if you've been granted access"), "这是私密视频，下载不了");
        assert!(friendly_error("[youtube] abc: Video unavailable").starts_with("视频不存在"));
        assert!(friendly_error("[youtube] abc: This video is unavailable").starts_with("视频不存在"));
    }

    #[test]
    fn stale_job_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let dirs = Dirs { tools: dir.path().join("tools"), work: dir.path().join("work") };
        assert!(job_status(&dirs).is_none());
        // 进程早就没了的旧状态不算在跑
        write_job(&dirs, &Job { kind: "download".into(), text: "下载画面".into(), percent: Some(3.0), pid: None, owner: 999_999, running: true, started: now_secs() });
        assert!(job_status(&dirs).is_none());
        assert!(begin(&dirs, "download", "x").is_ok());
        assert!(job_status(&dirs).is_some());
        assert!(begin(&dirs, "download", "y").is_err());
    }
}
