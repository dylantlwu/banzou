//! 电视 KTV：把歌传到安卓电视上的「波点」APP（源码在 app/tv/）。
//!
//! - 连电视用安卓官方的 adb（Google 发布的 platform-tools，核对 Google SDK 索引里的 SHA-1），
//!   放在应用自己的 tools/platform-tools/ 里；电视要在工程菜单里打开 adb debug（网络调试，端口 5555）
//! - 每首歌转换成一个文件：MV 画面（原样复制，不重新编码）+ 4 声道声音
//!   [伴奏左, 伴奏右, 人声左, 人声右]，电视 APP 靠它瞬间切换原唱 / 伴唱、分别调音量
//! - 电视上的位置：/sdcard/BanzouKTV/<歌名>/{song.mp4 或 song.m4a, lyrics.lrc, info.json}
//!
//! 长任务（装工具、传歌）沿用 video.rs 的任务状态文件，放在单独的 work 目录，不和下载视频抢。

use crate::video::{self, Dirs, Job};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const SDK_INDEX: &str = "https://dl.google.com/android/repository/repository2-3.xml";
const SDK_BASE: &str = "https://dl.google.com/android/repository/";
pub const REMOTE_ROOT: &str = "/sdcard/BanzouKTV";
const PACKAGE: &str = "com.banzou.ktv";

/// 随应用带的电视 APP；改了 app/tv 以后用 app/tv/build-apk.sh 重新生成
const APK: &[u8] = include_bytes!("../tv/BanzouKTV.apk");
/// 和 app/tv/app/build.gradle.kts 里的 versionCode 一致
pub const APP_VERSION: u32 = 6;

fn adb_path(dirs: &Dirs) -> PathBuf {
    dirs.tools.join("platform-tools").join("adb")
}

// ---------- 状态 ----------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TvStatus {
    /// adb 装了没有
    pub adb: bool,
    /// ffmpeg 装了没有（转换要用，和下载视频共用）
    pub ffmpeg: bool,
    pub connected: bool,
    /// 连不上时给用户看的原因
    pub error: Option<String>,
    pub model: Option<String>,
    /// 电视剩余空间（字节）
    pub free_bytes: Option<u64>,
    /// 电视上「波点」的版本；没装为空
    pub app_version: Option<u32>,
    /// 应用自带的电视 APP 版本
    pub bundled_version: u32,
    /// 电视上已有的歌（文件夹名 = 歌名）
    pub songs: Vec<String>,
}

/// 「192.168.2.9」→「192.168.2.9:5555」；拒绝看起来不是地址的输入（免得被当成 adb 参数）
pub fn clean_addr(input: &str) -> Result<String, String> {
    let a = input.trim();
    if a.is_empty() {
        return Err("先填电视的 IP 地址".into());
    }
    if !a.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == ':' || c == '-') || a.starts_with('-') {
        return Err(format!("「{a}」不像 IP 地址，应该是 192.168.x.x 这样"));
    }
    Ok(if a.contains(':') { a.to_string() } else { format!("{a}:5555") })
}

/// 测试模式（浏览器 `?test`）只许连 BANZOU_TEST_TV 指定的那台设备；没指定就一台都不连。
/// 测试曲库同步过去会覆盖真电视上的歌单（2026-11-13 出过一次）。
pub fn test_mode_target(addr: &str, allowed: Option<&str>) -> Result<String, String> {
    let refuse = || "测试模式不连真电视（会用测试曲库覆盖电视上的歌单）。要测电视请在正式应用里测，或者用 BANZOU_TEST_TV=设备地址 启动测试模式".to_string();
    let allowed = allowed.map(str::trim).filter(|a| !a.is_empty()).ok_or_else(refuse)?;
    let want = clean_addr(allowed).map_err(|_| refuse())?;
    // 没填地址（自动找电视）就用指定的那台
    let got = if addr.trim().is_empty() { want.clone() } else { clean_addr(addr)? };
    if got == want { Ok(got) } else { Err(refuse()) }
}

/// 给电视上 sh 用的单引号字符串
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// 歌名当文件夹名：不能带 / 或者是 . / ..
fn remote_dir(title: &str) -> Result<String, String> {
    let t = title.trim();
    if t.is_empty() || t == "." || t == ".." || t.contains('/') || t.contains('\0') {
        return Err(format!("歌名「{title}」不能当文件夹名"));
    }
    Ok(format!("{REMOTE_ROOT}/{t}"))
}

/// 跑一次 adb，限时；返回标准输出
fn adb(dirs: &Dirs, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut child = Command::new(adb_path(dirs))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("adb 启动失败：{e}"))?;
    let start = Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("电视没有回应（超时）".into());
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).replace('\r', "");
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.trim().lines().last().unwrap_or("adb 出错了").to_string());
    }
    Ok(text)
}

fn shell(dirs: &Dirs, addr: &str, cmd: &str) -> Result<String, String> {
    adb(dirs, &["-s", addr, "shell", cmd], Duration::from_secs(20))
}

/// 连上电视（第一次连常常要等几秒，失败重试两次）
fn connect(dirs: &Dirs, addr: &str) -> Result<(), String> {
    let ok = |dirs: &Dirs| adb(dirs, &["-s", addr, "get-state"], Duration::from_secs(5)).is_ok_and(|s| s.trim() == "device");
    if ok(dirs) {
        return Ok(());
    }
    let mut last = String::new();
    for _ in 0..3 {
        match adb(dirs, &["connect", addr], Duration::from_secs(12)) {
            Ok(out) if out.contains("connected to") => {
                if ok(dirs) {
                    return Ok(());
                }
                last = "电视拒绝了连接：看看电视上有没有弹出「允许调试」，选允许".into();
            }
            Ok(out) => last = out.trim().to_string(),
            Err(e) => last = e,
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(friendly_connect_error(&last))
}

fn friendly_connect_error(raw: &str) -> String {
    let r = raw.to_lowercase();
    if r.contains("refused") {
        "电视开着，但没开调试：在电视工程菜单里把 adb debug 打开（电视重启后可能会自己关掉）".into()
    } else if r.contains("timed out") || r.contains("超时") || r.contains("no route") || r.contains("unreachable") {
        "找不到电视：确认电视开着、和这台 Mac 连的是同一个网络，IP 地址没填错".into()
    } else if r.contains("允许调试") || r.contains("unauthorized") {
        "电视上弹出了「允许调试」，用遥控器选允许，再点一次连接".into()
    } else {
        format!("连不上电视：{raw}")
    }
}

/// `df /sdcard` 的「Free」一栏（安卓 5 显示成 4.3G 这样）
fn parse_df_free(text: &str) -> Option<u64> {
    let line = text.lines().find(|l| l.starts_with('/'))?;
    let free = line.split_whitespace().nth(3)?;
    parse_size(free)
}

fn parse_size(s: &str) -> Option<u64> {
    let (num, unit) = s.split_at(s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len()));
    let n: f64 = num.parse().ok()?;
    let mul = match unit.to_ascii_uppercase().as_str() {
        "" => 1024.0, // 没单位时是 KB 块
        "K" => 1024.0,
        "M" => 1024.0 * 1024.0,
        "G" => 1024.0 * 1024.0 * 1024.0,
        "T" => 1024f64.powi(4),
        _ => return None,
    };
    Some((n * mul) as u64)
}

fn parse_version_code(dumpsys: &str) -> Option<u32> {
    let i = dumpsys.find("versionCode=")? + "versionCode=".len();
    dumpsys[i..].chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

pub fn status(dirs: &Dirs, addr: &str) -> TvStatus {
    let mut st = TvStatus {
        adb: adb_path(dirs).is_file(),
        ffmpeg: video::ffmpeg_version(&dirs.ffmpeg()).is_some(),
        bundled_version: APP_VERSION,
        ..Default::default()
    };
    if !st.adb {
        return st;
    }
    let addr = match clean_addr(addr) {
        Ok(a) => a,
        Err(e) => {
            st.error = Some(e);
            return st;
        }
    };
    if let Err(e) = connect(dirs, &addr) {
        st.error = Some(e);
        return st;
    }
    st.connected = true;
    st.model = shell(dirs, &addr, "getprop ro.product.model").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    st.free_bytes = shell(dirs, &addr, "df /sdcard").ok().and_then(|t| parse_df_free(&t));
    st.app_version = shell(dirs, &addr, &format!("dumpsys package {PACKAGE}")).ok().and_then(|t| parse_version_code(&t));
    st.songs = shell(dirs, &addr, &format!("ls {REMOTE_ROOT} 2>/dev/null"))
        .map(|t| t.lines().map(str::trim).filter(|l| !l.is_empty() && !l.contains("No such file")).map(str::to_string).collect())
        .unwrap_or_default();
    st.songs.sort();
    st
}

/// 在这台 Mac 所在的网段里找开着调试端口（5555）的设备
pub fn discover() -> Vec<String> {
    let mut prefixes = Vec::new();
    for iface in ["en0", "en1", "en2", "en3"] {
        if let Ok(out) = Command::new("/usr/sbin/ipconfig").args(["getifaddr", iface]).output() {
            let ip = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Some((prefix, _)) = ip.rsplit_once('.')
                && !prefixes.contains(&prefix.to_string())
            {
                prefixes.push(prefix.to_string());
            }
        }
    }
    let mut handles = Vec::new();
    for prefix in prefixes {
        for chunk in (1..=254u32).collect::<Vec<_>>().chunks(32) {
            let prefix = prefix.clone();
            let chunk = chunk.to_vec();
            handles.push(std::thread::spawn(move || {
                chunk
                    .into_iter()
                    .filter_map(|i| {
                        let ip = format!("{prefix}.{i}");
                        let sock: SocketAddr = format!("{ip}:5555").parse().ok()?;
                        TcpStream::connect_timeout(&sock, Duration::from_millis(400)).ok().map(|_| ip)
                    })
                    .collect::<Vec<_>>()
            }));
        }
    }
    let mut found: Vec<String> = handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect();
    found.sort();
    found
}

// ---------- 装工具 ----------

/// Google SDK 索引里 macOS 版 platform-tools：(文件名, 大小, SHA-1)
fn latest_platform_tools() -> Result<(String, Option<u64>, String), String> {
    let xml = video::curl_text(SDK_INDEX)?;
    parse_platform_tools(&xml).ok_or_else(|| "Google 的 SDK 索引里没找到 macOS 版 platform-tools".into())
}

fn tag<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}");
    let i = s.find(&open)?;
    let body_start = i + s[i..].find('>')? + 1;
    let end = body_start + s[body_start..].find(&format!("</{name}>"))?;
    Some(&s[body_start..end])
}

pub fn parse_platform_tools(xml: &str) -> Option<(String, Option<u64>, String)> {
    let start = xml.find(r#"<remotePackage path="platform-tools">"#)?;
    let pkg = &xml[start..start + xml[start..].find("</remotePackage>")?];
    let mut rest = pkg;
    while let Some(i) = rest.find("<archive>") {
        let end = i + rest[i..].find("</archive>")?;
        let archive = &rest[i..end];
        if tag(archive, "host-os").is_some_and(|h| h.trim() == "macosx") {
            let url = tag(archive, "url")?.trim().to_string();
            let sha1 = tag(archive, "checksum")?.trim().to_lowercase();
            let size = tag(archive, "size").and_then(|s| s.trim().parse().ok());
            return Some((url, size, sha1));
        }
        rest = &rest[end..];
    }
    None
}

fn sha1_file(path: &Path) -> Result<String, String> {
    let out = Command::new("/usr/bin/shasum").args(["-a", "1"]).arg(path).output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).split_whitespace().next().unwrap_or("").to_lowercase())
}

fn install_adb(dirs: &Dirs, job: &mut Job, tmp: &Path) -> Result<(), String> {
    job.text = "查询安卓连接工具 adb".into();
    video::write_job(dirs, job);
    let (file, size, sha1) = latest_platform_tools()?;
    if file.contains('/') || !file.ends_with(".zip") {
        return Err("Google 的 SDK 索引内容不对".into());
    }
    let zip = tmp.join("platform-tools.zip");
    video::curl_file(dirs, job, &format!("{SDK_BASE}{file}"), &zip, size, "下载 adb")?;
    if sha1_file(&zip)? != sha1 {
        return Err("下载的 adb 校验不对，没有安装（可能是网络问题，再试一次）".into());
    }
    job.text = "解压 adb".into();
    job.percent = None;
    video::write_job(dirs, job);
    let unpacked = tmp.join("unpacked");
    let _ = fs::remove_dir_all(&unpacked);
    let status = Command::new("/usr/bin/ditto").args(["-x", "-k"]).arg(&zip).arg(&unpacked).status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("解压 adb 失败".into());
    }
    let new = unpacked.join("platform-tools");
    video::first_line_of(&new.join("adb"), &["version"]).ok_or("下载的 adb 运行不了")?;
    let dest = dirs.tools.join("platform-tools");
    let _ = fs::remove_dir_all(&dest);
    fs::rename(&new, &dest).map_err(|e| format!("安装 adb 失败：{e}"))
}

/// 装缺的工具：adb，以及转换用的 ffmpeg（和下载视频共用）
pub fn install_tools(dirs: &Dirs) -> Result<TvStatus, String> {
    let mut job = video::begin(dirs, "tv-install", "准备下载工具")?;
    let tmp = dirs.tools.join(".downloading-tv");
    let result = (|| {
        fs::create_dir_all(&tmp).map_err(|e| format!("建不了工具文件夹：{e}"))?;
        if !adb_path(dirs).is_file() {
            install_adb(dirs, &mut job, &tmp)?;
        }
        if video::cancelled(dirs) {
            return Err("已取消".into());
        }
        if video::ffmpeg_version(&dirs.ffmpeg()).is_none() {
            video::install_ffmpeg(dirs, &mut job, &tmp)?;
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&tmp);
    video::finish(dirs, &mut job);
    result.map(|_| TvStatus { adb: adb_path(dirs).is_file(), ffmpeg: video::ffmpeg_version(&dirs.ffmpeg()).is_some(), bundled_version: APP_VERSION, ..Default::default() })
}

/// 把应用自带的「波点」装到电视上（已装旧版就升级）
pub fn install_app(dirs: &Dirs, addr: &str) -> Result<(), String> {
    let addr = clean_addr(addr)?;
    connect(dirs, &addr)?;
    let mut job = video::begin(dirs, "tv-app", "把「波点」传到电视")?;
    let result = (|| {
        fs::create_dir_all(&dirs.work).map_err(|e| e.to_string())?;
        let apk = dirs.work.join("BanzouKTV.apk");
        fs::write(&apk, APK).map_err(|e| e.to_string())?;
        let out = adb(dirs, &["-s", &addr, "install", "-r", &apk.to_string_lossy()], Duration::from_secs(180));
        let _ = fs::remove_file(&apk);
        let out = out?;
        if !out.contains("Success") {
            return Err(format!("电视没装上：{}", out.trim().lines().last().unwrap_or("")));
        }
        Ok(())
    })();
    video::finish(dirs, &mut job);
    result
}

/// 在电视上打开「波点」
pub fn open_app(dirs: &Dirs, addr: &str) -> Result<(), String> {
    let addr = clean_addr(addr)?;
    connect(dirs, &addr)?;
    shell(dirs, &addr, &format!("am start -n {PACKAGE}/.MainActivity")).map(|_| ())
}

// ---------- MV ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvChoice {
    /// 能用的 MV；没有为空
    pub path: Option<String>,
    /// 给用户看的说明：为什么没用某个视频
    pub note: Option<String>,
    /// 估计传过去多大（字节）
    pub size: u64,
}

/// 从挂在这首歌上的视频里挑能放到电视上的 MV：H.264（电视解不了 AV1 / VP9），
/// 而且长度和伴奏对得上（伴奏通常是从这个视频分离出来的，差不到 1 秒；对不上说明不是同一个版本，会错位）
pub fn choose_mv(dirs: &Dirs, accompaniment: &Path, videos: &[PathBuf]) -> MvChoice {
    let acc = video::media_info(dirs, accompaniment).duration;
    let audio_size = acc.map(|d| (d * 320_000.0 / 8.0) as u64).unwrap_or(10_000_000);
    let mut note = None;
    let mut best: Option<(f64, &PathBuf)> = None;
    for v in videos {
        let info = video::media_info(dirs, v);
        if info.codec.as_deref() != Some("H.264") {
            note.get_or_insert_with(|| format!("「{}」是 {} 编码，电视放不了", file_name(v), info.codec.as_deref().unwrap_or("未知")));
            continue;
        }
        let diff = match (acc, info.duration) {
            (Some(a), Some(d)) => (a - d).abs(),
            _ => f64::MAX,
        };
        if diff > 1.0 {
            note = Some(format!("「{}」和伴奏长度差了 {:.0} 秒，不是同一个版本，不用它", file_name(v), diff.min(9999.0)));
            continue;
        }
        if best.is_none_or(|(d, _)| diff < d) {
            best = Some((diff, v));
        }
    }
    match best {
        Some((_, v)) => MvChoice { path: Some(v.to_string_lossy().into_owned()), note: None, size: fs::metadata(v).map(|m| m.len()).unwrap_or(0) + audio_size },
        None => MvChoice { path: None, note, size: audio_size },
    }
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

// ---------- 传歌 ----------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    /// 文件名键（电视上的文件夹名）
    pub title: String,
    pub accompaniment: String,
    pub vocal: Option<String>,
    pub lyrics: Option<String>,
    pub video: Option<String>,
    /// 稳定编号（资料表里的 id），写进 info.json，电视用它对上歌单
    #[serde(default)]
    pub id: Option<String>,
    /// 显示名（资料表里的 title），写进 info.json
    #[serde(default)]
    pub name: Option<String>,
}

impl PushRequest {
    /// 只允许素材文件夹里的文件
    pub fn check_inside(&self, root: &Path) -> Result<(), String> {
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        for p in [Some(&self.accompaniment), self.vocal.as_ref(), self.lyrics.as_ref(), self.video.as_ref()].into_iter().flatten() {
            let c = Path::new(p).canonicalize().map_err(|_| format!("找不到文件：{p}"))?;
            if !c.starts_with(&root) {
                return Err(format!("不在素材文件夹里：{p}"));
            }
        }
        Ok(())
    }
}

/// 转换用的 ffmpeg 参数（不含程序名和输出文件）
pub fn convert_args(req: &PushRequest) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y", "-nostats", "-progress", "pipe:1"].map(String::from).to_vec();
    let mut idx = 0;
    if let Some(v) = &req.video {
        a.extend(["-i".into(), v.clone()]);
        idx += 1;
    }
    let acc = idx;
    a.extend(["-i".into(), req.accompaniment.clone()]);
    let voc = req.vocal.as_ref().map(|v| {
        a.extend(["-i".into(), v.clone()]);
        acc + 1
    });
    let norm = |i: usize, name: &str| format!("[{i}:a]aresample=44100,aformat=channel_layouts=stereo[{name}]");
    let filter = match voc {
        Some(v) => format!("{};{};[A][B]join=inputs=2:channel_layout=4.0:map=0.FL-FL|0.FR-FR|1.FL-FC|1.FR-BC[a]", norm(acc, "A"), norm(v, "B")),
        None => format!("{};[A]pan=4.0|FL=c0|FR=c1|FC=0*c0|BC=0*c1[a]", norm(acc, "A")),
    };
    a.extend(["-filter_complex".into(), filter]);
    if req.video.is_some() {
        a.extend(["-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-shortest"].map(String::from));
    } else {
        a.extend(["-map", "[a]"].map(String::from));
    }
    a.extend(["-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart"].map(String::from));
    a
}

/// 跑一个子进程，同时每隔一会儿调 `tick` 更新进度；可以取消
fn run_with_progress(dirs: &Dirs, job: &mut Job, mut child: Child, mut tick: impl FnMut(&mut Job, &mut Option<String>) -> bool) -> Result<String, String> {
    job.pid = Some(child.id());
    video::write_job(dirs, job);
    let mut stderr = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
    }
    let mut last = Instant::now();
    loop {
        let mut line = None;
        if let Ok(l) = rx.recv_timeout(Duration::from_millis(250)) {
            line = Some(l);
        }
        let done = child.try_wait().map_err(|e| e.to_string())?;
        if tick(job, &mut line) || last.elapsed() > Duration::from_millis(400) {
            video::write_job(dirs, job);
            last = Instant::now();
        }
        if video::cancelled(dirs) && done.is_none() {
            let _ = Command::new("/bin/kill").args(["-TERM", "--", &format!("-{}", child.id())]).status();
        }
        if let Some(status) = done {
            job.pid = None;
            let err = err_thread.join().unwrap_or_default();
            if video::cancelled(dirs) {
                return Err("已取消".into());
            }
            if !status.success() {
                return Err(err.trim().lines().last().unwrap_or("出错了").to_string());
            }
            return Ok(err);
        }
    }
}

/// `ls -l` 一行里的文件大小（安卓 5：权限 用户 组 大小 日期 时间 名字）
fn parse_ls_size(line: &str) -> Option<u64> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    (1..parts.len()).find_map(|i| if parts[i].chars().all(|c| c.is_ascii_digit()) && parts.get(i + 1).is_some_and(|d| d.contains('-')) { parts[i].parse().ok() } else { None })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pushed {
    pub title: String,
    pub size: u64,
    pub video: bool,
    pub free_bytes: Option<u64>,
}

pub fn push(dirs: &Dirs, addr: &str, req: &PushRequest) -> Result<Pushed, String> {
    let addr = clean_addr(addr)?;
    let remote = remote_dir(&req.title)?;
    if !dirs.ffmpeg().is_file() || !adb_path(dirs).is_file() {
        return Err("TOOLS_MISSING".into());
    }
    let mut job = video::begin(dirs, "tv-push", &format!("准备「{}」", req.title))?;
    let tmp = dirs.work.join(format!("push-{}", job.started));
    let result = (|| {
        connect(dirs, &addr)?;
        fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        // 1. 转换
        let media = if req.video.is_some() { "song.mp4" } else { "song.m4a" };
        let out_file = tmp.join(media);
        let total = video::media_info(dirs, Path::new(&req.accompaniment)).duration.unwrap_or(0.0);
        let child = Command::new(dirs.ffmpeg())
            .args(convert_args(req))
            .arg(&out_file)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .map_err(|e| format!("ffmpeg 启动失败：{e}"))?;
        job.text = format!("转换「{}」", req.title);
        job.percent = Some(0.0);
        run_with_progress(dirs, &mut job, child, |job, line| {
            if let Some(us) = line.as_deref().and_then(|l| l.strip_prefix("out_time_us=")).and_then(|v| v.trim().parse::<f64>().ok())
                && total > 0.0
            {
                job.percent = Some((us / 1e6 / total * 100.0).clamp(0.0, 100.0));
                return true;
            }
            false
        })
        .map_err(|e| if e == "已取消" { e } else { format!("转换失败：{e}") })?;

        // 2. 歌词和说明
        let mut files = vec![out_file.clone()];
        if let Some(l) = &req.lyrics {
            let dest = tmp.join("lyrics.lrc");
            fs::copy(l, &dest).map_err(|e| format!("读不了歌词：{e}"))?;
            files.push(dest);
        }
        let mut info = serde_json::json!({
            "title": req.title,
            "media": media,
            "video": req.video.is_some(),
            "vocal": req.vocal.is_some(),
            "lyricsInVideo": req.video.as_deref().is_some_and(|v| v.to_lowercase().contains("lyric")),
        });
        if let Some(id) = &req.id {
            info["id"] = id.clone().into();
        }
        if let Some(n) = &req.name {
            info["name"] = n.clone().into();
        }
        let info_file = tmp.join("info.json");
        fs::write(&info_file, serde_json::to_vec(&info).unwrap_or_default()).map_err(|e| e.to_string())?;
        files.push(info_file);

        // 3. 看空间够不够
        let size: u64 = files.iter().map(|f| fs::metadata(f).map(|m| m.len()).unwrap_or(0)).sum();
        if let Some(free) = shell(dirs, &addr, "df /sdcard").ok().and_then(|t| parse_df_free(&t))
            && size + 200 * 1024 * 1024 > free
        {
            return Err(format!("电视空间不够：这首要 {} MB，电视只剩 {} MB（要留 200 MB 给系统）。先从电视上删几首", size / 1_000_000, free / 1_000_000));
        }

        // 4. 传过去：先传到临时文件夹，传完再改名，中途断了电视上也不会留下半首
        let partial = format!("{remote}.part");
        shell(dirs, &addr, &format!("rm -rf {q}; mkdir -p {q}", q = sh_quote(&partial)))?;
        let mut sent = 0u64;
        for f in &files {
            let len = fs::metadata(f).map(|m| m.len()).unwrap_or(0);
            let dest = format!("{partial}/{}", file_name(f));
            let child = Command::new(adb_path(dirs))
                .args(["-s", &addr, "push"])
                .arg(f)
                .arg(&dest)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .process_group(0)
                .spawn()
                .map_err(|e| format!("adb 启动失败：{e}"))?;
            job.text = format!("传到电视「{}」", req.title);
            let mut last_poll = Instant::now();
            let base = sent;
            run_with_progress(dirs, &mut job, child, |job, _| {
                if len < 2_000_000 || last_poll.elapsed() < Duration::from_secs(1) {
                    return false;
                }
                last_poll = Instant::now();
                let got = shell(dirs, &addr, &format!("ls -l {}", sh_quote(&dest))).ok().and_then(|l| parse_ls_size(&l)).unwrap_or(0);
                job.percent = Some(((base + got) as f64 / size.max(1) as f64 * 100.0).min(100.0));
                true
            })
            .map_err(|e| if e == "已取消" { e } else { format!("传到电视失败：{e}") })?;
            sent += len;
        }
        shell(dirs, &addr, &format!("rm -rf {r}; mv {p} {r}", r = sh_quote(&remote), p = sh_quote(&partial)))?;
        let free = shell(dirs, &addr, "df /sdcard").ok().and_then(|t| parse_df_free(&t));
        Ok(Pushed { title: req.title.clone(), size, video: req.video.is_some(), free_bytes: free })
    })();
    if result.is_err() {
        let _ = shell(dirs, &addr, &format!("rm -rf {}", sh_quote(&format!("{remote}.part"))));
    }
    let _ = fs::remove_dir_all(&tmp);
    video::finish(dirs, &mut job);
    result
}

// ---------- 电视歌单（全部歌曲 + 副歌预览）----------
//
// 电视上能看到电脑曲库里的全部歌：/sdcard/BanzouKTV/.catalog/catalog.json 加上每首一小段副歌预览
// （20 秒，360p，几 MB 以内）。整首歌只有点了才传：电视在 .requests/ 里放一个请求文件，
// 波点开着时在后台看到就传过去（serve_requests）。

const CATALOG_DIR: &str = "/sdcard/BanzouKTV/.catalog";
const REQUEST_DIR: &str = "/sdcard/BanzouKTV/.requests";
const PREVIEW_SECONDS: f64 = 20.0;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSong {
    /// 文件名键
    pub title: String,
    pub artist: Option<String>,
    pub accompaniment: String,
    pub vocal: Option<String>,
    pub lyrics: Option<String>,
    /// 挂在这首歌上的视频（挑 MV 用）
    pub videos: Vec<String>,
    /// 稳定编号（资料表里的 id）；没有就按文件名键算
    #[serde(default)]
    pub id: Option<String>,
    /// 显示名（资料表里的 title）；没有就是文件名键
    #[serde(default)]
    pub name: Option<String>,
    /// 歌名读音（点歌首字母用里面的拉丁字母）
    #[serde(default)]
    pub reading: Option<String>,
}

impl CatalogSong {
    pub fn stable_id(&self) -> String {
        self.id.clone().filter(|i| !i.is_empty()).unwrap_or_else(|| song_id(&self.title))
    }
    pub fn shown(&self) -> &str {
        self.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&self.title)
    }
}

/// 歌名的稳定编号（电视上的预览文件名、点歌请求都用它）
pub fn song_id(title: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(title.trim().as_bytes()).iter().take(6).map(|b| format!("{b:02x}")).collect()
}

/// 拼音首字母 + 英文单词首字母，KTV 点歌用：「寂寞先生 曹格」→ JMXSCG，「The Door Teddy Swims」→ TDTS
pub fn initials(text: &str) -> String {
    use pinyin::ToPinyin;
    let simplified = fast2s::convert(text);
    let mut out = String::new();
    let mut in_word = false;
    for c in simplified.chars() {
        if let Some(p) = c.to_pinyin() {
            out.push(p.first_letter().chars().next().unwrap_or(c).to_ascii_uppercase());
            in_word = false;
        } else if c.is_ascii_alphanumeric() {
            if !in_word {
                out.push(c.to_ascii_uppercase());
            }
            in_word = true;
        } else {
            in_word = c == '\'';
        }
    }
    out
}

/// LRC 的每一句：(秒, 文字)
pub fn lrc_lines(text: &str) -> Vec<(f64, String)> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let mut rest = raw.trim();
        let mut times = Vec::new();
        while let Some(r) = rest.strip_prefix('[') {
            let Some(end) = r.find(']') else { break };
            let tag = &r[..end];
            if let Some((m, s)) = tag.split_once(':')
                && let (Ok(m), Ok(s)) = (m.parse::<f64>(), s.parse::<f64>())
            {
                times.push(m * 60.0 + s);
            }
            rest = &r[end + 1..];
        }
        let body = rest.trim();
        if !body.is_empty() {
            out.extend(times.into_iter().map(|t| (t, body.to_string())));
        }
    }
    out.sort_by(|a, b| a.0.total_cmp(&b.0));
    out
}

/// 副歌从哪里开始：歌词里重复出现的句子（一般就是副歌）第一次出现的时间；
/// 找不到就用全曲的 35% 处
pub fn chorus_start(lyrics: Option<&str>, duration: f64) -> f64 {
    let fallback = (duration * 0.35).max(0.0);
    let Some(text) = lyrics else { return fallback };
    let lines = lrc_lines(text);
    let key = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    let mut counts = std::collections::HashMap::<String, usize>::new();
    for (_, t) in &lines {
        let k = key(t);
        if k.chars().count() >= 4 {
            *counts.entry(k).or_default() += 1;
        }
    }
    // 跳过开头 15 秒（歌名、词曲那几行）
    let start = lines.iter().find(|(t, s)| *t >= 15.0 && counts.get(&key(s)).is_some_and(|n| *n >= 2)).map(|(t, _)| (t - 1.0).max(0.0));
    match start {
        Some(t) if duration <= 0.0 || t + 8.0 < duration => t,
        _ => fallback,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Synced {
    pub songs: usize,
    pub new_previews: usize,
}

/// 把全部歌曲的歌单和副歌预览同步到电视（已有的预览不重做、不重传）
pub fn sync_catalog(dirs: &Dirs, addr: &str, songs: &[CatalogSong], tags: &serde_json::Value, plays_out: &Path) -> Result<Synced, String> {
    let addr = clean_addr(addr)?;
    if !dirs.ffmpeg().is_file() || !adb_path(dirs).is_file() {
        return Err("TOOLS_MISSING".into());
    }
    let mut job = video::begin(dirs, "tv-catalog", "整理电视歌单")?;
    let cache = dirs.work.join("previews");
    let result = (|| {
        connect(dirs, &addr)?;
        fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        shell(dirs, &addr, &format!("mkdir -p {CATALOG_DIR} {REQUEST_DIR}"))?;
        let on_tv: Vec<String> = shell(dirs, &addr, &format!("ls {CATALOG_DIR}")).unwrap_or_default().lines().map(|l| l.trim().to_string()).collect();
        let mut entries = Vec::new();
        let mut keep = vec!["catalog.json".to_string(), "plays.json".to_string()];
        let mut new_previews = 0;
        for (n, song) in songs.iter().enumerate() {
            if video::cancelled(dirs) {
                return Err("已取消".into());
            }
            job.text = format!("副歌预览「{}」", song.title);
            job.percent = Some(n as f64 / songs.len().max(1) as f64 * 100.0);
            video::write_job(dirs, &job);
            let id = song.stable_id();
            let videos: Vec<PathBuf> = song.videos.iter().map(PathBuf::from).collect();
            let mv = choose_mv(dirs, Path::new(&song.accompaniment), &videos).path;
            let duration = video::media_info(dirs, Path::new(&song.accompaniment)).duration.unwrap_or(0.0);
            let lyrics = song.lyrics.as_ref().and_then(|l| fs::read_to_string(l).ok());
            let start = chorus_start(lyrics.as_deref(), duration);
            // 文件名里带上来源和起点的指纹：素材变了就重新做
            let source = mv.clone().unwrap_or_else(|| song.accompaniment.clone());
            let mtime = fs::metadata(&source).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            let ext = if mv.is_some() { "mp4" } else { "m4a" };
            let fp = song_id(&format!("{source}|{mtime}|{start:.1}|{}", song.vocal.as_deref().unwrap_or("")));
            let file = format!("{id}-{}.{ext}", &fp[..8]);
            keep.push(file.clone());
            if !on_tv.contains(&file) {
                let local = cache.join(&file);
                if !local.is_file() {
                    make_preview(dirs, song, mv.as_deref(), start, &local)?;
                }
                job.text = format!("把预览传到电视「{}」", song.title);
                video::write_job(dirs, &job);
                adb(dirs, &["-s", &addr, "push", &local.to_string_lossy(), &format!("{CATALOG_DIR}/{file}")], Duration::from_secs(120))?;
                new_previews += 1;
            }
            // 标签：手动填的和 AI 猜的都在 tags.json 里，歌手以标签为准，没有再用曲库里的
            let tag = |k: &str| tags.pointer(&format!("/songs/{id}/{k}")).and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
            let artist = tag("artist").or_else(|| song.artist.clone());
            // 读音里有拉丁字母（罗马音）就按它算首字母，日文汉字按拼音算会错
            let latin = song.reading.as_deref().map(|r| r.chars().map(|c| if c.is_ascii_alphanumeric() || c == '\'' { c } else { ' ' }).collect::<String>()).filter(|r| r.trim().len() > 1);
            let spoken = latin.as_deref().unwrap_or(song.shown());
            let mut entry = serde_json::json!({
                "id": id,
                "title": song.shown(),
                "artist": artist,
                "initials": initials(&format!("{} {}", spoken, artist.as_deref().unwrap_or(""))),
                "preview": file,
                "video": mv.is_some(),
            });
            if let Some(l) = tag("lang") {
                entry["lang"] = l.into();
            }
            if let Some(e) = tag("era") {
                entry["era"] = e.into();
            }
            entries.push(entry);
        }
        // 歌单本身：先写临时文件再改名，电视不会读到写了一半的
        let json = serde_json::to_vec(&serde_json::json!({ "version": 2, "songs": entries, "playlists": catalog_playlists(tags, &entries) })).map_err(|e| e.to_string())?;
        let local = cache.join("catalog.json");
        fs::write(&local, json).map_err(|e| e.to_string())?;
        adb(dirs, &["-s", &addr, "push", &local.to_string_lossy(), &format!("{CATALOG_DIR}/catalog.json.tmp")], Duration::from_secs(60))?;
        shell(dirs, &addr, &format!("mv {CATALOG_DIR}/catalog.json.tmp {CATALOG_DIR}/catalog.json"))?;
        // 删掉电视上用不到的旧预览
        let stale: Vec<String> = on_tv.iter().filter(|f| !f.is_empty() && !keep.contains(f) && !f.contains('\'')).map(|f| format!("{CATALOG_DIR}/{f}")).collect();
        if !stale.is_empty() {
            let _ = shell(dirs, &addr, &format!("rm -f {}", stale.iter().map(|f| sh_quote(f)).collect::<Vec<_>>().join(" ")));
        }
        // 电视上记的点歌次数拉回电脑（「常点」），拉不到就算了
        let _ = adb(dirs, &["-s", &addr, "pull", &format!("{CATALOG_DIR}/plays.json"), &plays_out.to_string_lossy()], Duration::from_secs(20));
        Ok(Synced { songs: entries.len(), new_previews })
    })();
    video::finish(dirs, &mut job);
    result
}

/// 歌单里只留曲库里还有的歌，空歌单也留着（电视上显示「还没有歌」）
pub fn catalog_playlists(tags: &serde_json::Value, entries: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let ids: std::collections::HashSet<&str> = entries.iter().filter_map(|e| e["id"].as_str()).collect();
    tags.get("playlists")
        .and_then(|p| p.as_array())
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let name = p.get("name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            let songs: Vec<&str> = p.get("songs").and_then(|s| s.as_array()).into_iter().flatten().filter_map(|s| s.as_str()).filter(|s| ids.contains(s)).collect();
            Some(serde_json::json!({ "id": p.get("id").and_then(|i| i.as_str()).unwrap_or(name), "name": name, "songs": songs }))
        })
        .collect()
}

/// 做一段副歌预览：有 MV 就截 MV（缩成 360p，带原曲声音），没有就用伴奏加人声
fn make_preview(dirs: &Dirs, song: &CatalogSong, mv: Option<&str>, start: f64, out: &Path) -> Result<(), String> {
    let ss = format!("{start:.2}");
    let t = format!("{PREVIEW_SECONDS}");
    let fade = format!("afade=t=in:d=0.6,afade=t=out:st={}:d=1.2", PREVIEW_SECONDS - 1.2);
    let tmp = out.with_extension(format!("part.{}", out.extension().and_then(|e| e.to_str()).unwrap_or("mp4")));
    let mut cmd = Command::new(dirs.ffmpeg());
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    if let Some(v) = mv {
        cmd.args(["-ss", &ss, "-t", &t, "-i", v])
            .args(["-vf", "scale=-2:360", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-profile:v", "main", "-pix_fmt", "yuv420p"])
            .args(["-af", &fade, "-c:a", "aac", "-b:a", "96k", "-ac", "2"]);
    } else {
        cmd.args(["-ss", &ss, "-t", &t, "-i", &song.accompaniment]);
        let filter = if let Some(v) = &song.vocal {
            cmd.args(["-ss", &ss, "-t", &t, "-i", v]);
            format!("[0:a][1:a]amix=inputs=2:normalize=0,{fade}[a]")
        } else {
            format!("[0:a]{fade}[a]")
        };
        cmd.args(["-filter_complex", &filter, "-map", "[a]", "-c:a", "aac", "-b:a", "96k", "-ac", "2"]);
    }
    let status = cmd.args(["-movflags", "+faststart"]).arg(&tmp).stdin(Stdio::null()).status().map_err(|e| format!("ffmpeg 启动失败：{e}"))?;
    if !status.success() {
        let _ = fs::remove_file(&tmp);
        return Err(format!("「{}」的预览没做出来", song.title));
    }
    fs::rename(&tmp, out).map_err(|e| e.to_string())
}

/// 电视在等的歌：波点开着时后台调用。电视点了还没传过去的歌，会在 .requests/ 放一个
/// <编号>.req（内容是歌名）；这里传过去后删掉它，传不了就写一个 <编号>.fail 告诉电视原因。
/// 返回这次传了哪首（没有请求返回 None）
pub fn serve_requests(dirs: &Dirs, addr: &str, songs: &[CatalogSong]) -> Result<Option<String>, String> {
    let addr = clean_addr(addr)?;
    // 先快速看一下电视在不在，免得每次都等 adb 超时
    let host = addr.split(':').next().unwrap_or("");
    let port = addr.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()).unwrap_or(5555);
    let sock: SocketAddr = format!("{host}:{port}").parse().map_err(|_| "地址不对".to_string())?;
    if TcpStream::connect_timeout(&sock, Duration::from_millis(600)).is_err() {
        return Ok(None);
    }
    if !adb_path(dirs).is_file() || !dirs.ffmpeg().is_file() || video::job_status(dirs).is_some() {
        return Ok(None);
    }
    connect(dirs, &addr)?;
    let list = shell(dirs, &addr, &format!("ls {REQUEST_DIR} 2>/dev/null"))?;
    let Some(req) = list.lines().map(str::trim).find(|l| l.ends_with(".req")).map(str::to_string) else { return Ok(None) };
    let req_path = format!("{REQUEST_DIR}/{req}");
    let title = shell(dirs, &addr, &format!("cat {}", sh_quote(&req_path)))?.trim().to_string();
    let fail = |msg: &str| {
        let _ = shell(dirs, &addr, &format!("echo {} > {}; rm -f {}", sh_quote(msg), sh_quote(&req_path.replace(".req", ".fail")), sh_quote(&req_path)));
    };
    // 请求文件名是编号（<编号>.req），内容是电视上看到的歌名：先按编号找，再按歌名找
    let req_id = req.trim_end_matches(".req");
    let Some(song) = songs.iter().find(|s| s.stable_id() == req_id).or_else(|| songs.iter().find(|s| s.title == title || s.shown() == title)) else {
        fail("电脑的曲库里没有这首了");
        return Ok(None);
    };
    let videos: Vec<PathBuf> = song.videos.iter().map(PathBuf::from).collect();
    let mv = choose_mv(dirs, Path::new(&song.accompaniment), &videos).path;
    let push_req = PushRequest {
        title: song.title.clone(),
        accompaniment: song.accompaniment.clone(),
        vocal: song.vocal.clone(),
        lyrics: song.lyrics.clone(),
        video: mv,
        id: Some(song.stable_id()),
        name: song.name.clone(),
    };
    match push(dirs, &addr, &push_req) {
        Ok(_) => {
            let _ = shell(dirs, &addr, &format!("rm -f {}", sh_quote(&req_path)));
            Ok(Some(title))
        }
        Err(e) if e == "已取消" => Ok(None),
        Err(e) => {
            fail(&e);
            Err(e)
        }
    }
}

/// 从电视上删掉一首歌
pub fn remove(dirs: &Dirs, addr: &str, title: &str) -> Result<(), String> {
    let addr = clean_addr(addr)?;
    let remote = remote_dir(title)?;
    connect(dirs, &addr)?;
    shell(dirs, &addr, &format!("rm -r {}", sh_quote(&remote))).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn song_initials() {
        assert_eq!(initials("寂寞先生 曹格"), "JMXSCG");
        assert_eq!(initials("The Door Teddy Swims"), "TDTS");
        assert_eq!(initials("幾分之幾 盧廣仲"), "JFZJLGZ");
        assert_eq!(initials("李白 Neo Soul Reimagined"), "LBNSR");
        assert_eq!(initials("Don't Stop"), "DS");
    }

    #[test]
    fn finds_chorus() {
        let lrc = "[00:00.00]歌名 - 歌手\n[00:16.00]第一段主歌这一句\n[00:30.00]第二句主歌不一样\n[00:50.00]我可以无所谓\n[00:55.00]副歌第二句\n[01:40.00]主歌又一句\n[02:00.00]我可以无所谓\n";
        assert_eq!(chorus_start(Some(lrc), 240.0), 49.0);
        assert_eq!(chorus_start(Some("[00:10.00]只有一句"), 200.0), 70.0);
        assert_eq!(chorus_start(None, 100.0), 35.0);
        assert_eq!(lrc_lines("[00:01.50][01:00.00]重复\n")[1], (60.0, "重复".to_string()));
    }

    #[test]
    fn addresses() {
        assert_eq!(clean_addr(" 192.168.2.9 ").unwrap(), "192.168.2.9:5555");
        assert_eq!(clean_addr("192.168.2.9:5556").unwrap(), "192.168.2.9:5556");
        assert!(clean_addr("").is_err());
        assert!(clean_addr("-s x").is_err());
        assert!(clean_addr("1.2.3.4; rm").is_err());
    }

    #[test]
    fn test_mode_never_reaches_a_real_tv() {
        // 没指定测试设备：哪台都不连
        assert!(test_mode_target("192.168.2.9", None).unwrap_err().contains("测试模式不连真电视"));
        assert!(test_mode_target("192.168.2.9", Some("  ")).is_err());
        assert!(test_mode_target("", None).is_err());
        // 只连指定的那台
        assert_eq!(test_mode_target("10.0.2.2", Some("10.0.2.2")).unwrap(), "10.0.2.2:5555");
        assert_eq!(test_mode_target("", Some("10.0.2.2:5556")).unwrap(), "10.0.2.2:5556");
        assert!(test_mode_target("192.168.2.9", Some("10.0.2.2")).is_err());
    }

    #[test]
    fn remote_names() {
        assert_eq!(remote_dir("寂寞先生 曹格").unwrap(), "/sdcard/BanzouKTV/寂寞先生 曹格");
        assert!(remote_dir("../x").is_err());
        assert!(remote_dir("..").is_err());
        assert_eq!(sh_quote("It's"), r"'It'\''s'");
    }

    #[test]
    fn parses_tv_output() {
        let df = "Filesystem               Size     Used     Free   Blksize\n/sdcard                 11.8G     7.6G     4.3G   4096\n";
        assert_eq!(parse_df_free(df), Some((4.3 * 1024.0 * 1024.0 * 1024.0) as u64));
        assert_eq!(parse_ls_size("-rw-rw---- root     sdcard_r 15072082 2026-11-10 12:35 song.mp4"), Some(15072082));
        assert_eq!(parse_version_code("    versionCode=12 targetSdk=22"), Some(12));
    }

    #[test]
    fn parses_sdk_index() {
        let xml = r#"<remotePackage path="build-tools;1"><archives><archive><complete><size>1</size><checksum type="sha1">aa</checksum><url>bt-darwin.zip</url></complete><host-os>macosx</host-os></archive></archives></remotePackage>
<remotePackage path="platform-tools"><archives>
<archive><complete><size>9</size><checksum type="sha1">11</checksum><url>platform-tools_r37-linux.zip</url></complete><host-os>linux</host-os></archive>
<archive><complete><size>16110554</size><checksum type="sha1">6AE7</checksum><url>platform-tools_r37-darwin.zip</url></complete><host-os>macosx</host-os></archive>
</archives></remotePackage>"#;
        assert_eq!(parse_platform_tools(xml), Some(("platform-tools_r37-darwin.zip".into(), Some(16110554), "6ae7".into())));
    }

    #[test]
    fn convert_args_with_and_without_video() {
        let req = PushRequest { title: "x".into(), accompaniment: "acc.wav".into(), vocal: Some("voc.wav".into()), lyrics: None, video: Some("mv.mp4".into()), ..Default::default() };
        let a = convert_args(&req).join(" ");
        assert!(a.contains("-i mv.mp4 -i acc.wav -i voc.wav"));
        assert!(a.contains("[1:a]aresample") && a.contains("[2:a]aresample") && a.contains("join=inputs=2:channel_layout=4.0"));
        assert!(a.contains("-map 0:v:0") && a.contains("-c:v copy"));
        let req = PushRequest { video: None, vocal: None, ..req };
        let a = convert_args(&req).join(" ");
        assert!(a.contains("-i acc.wav -filter_complex [0:a]aresample") && a.contains("pan=4.0"));
        assert!(!a.contains("0:v"));
    }
}
