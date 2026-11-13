//! 录音文件与 Take 信息（PRD 4.4 / 7.2）。
//!
//! - 录音放在 `<曲库>/录音/<歌名>/take-NN.wav`，Take 信息存同目录 `takes.json`
//! - 边录边写：开始时建 `.wav.part`（32 位浮点单声道 WAV，长度先填 0），每秒追加一段，结束时补写长度并改名
//! - 全部是无状态的文件操作（每次调用都按路径打开），测试模式的一次性进程也能用
//! - 删除 Take 是把文件移到废纸篓，不直接删
//! - 异常录音（`.wav.part` 比歌长很多，多半是忘了停）不自动恢复，改名成 `take-NN.异常录音.part`，
//!   列进资料检查页，用户点了才移到废纸篓（资料清单 §5-9）

use base64::Engine;
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::lyrics_store::sanitize_file_stem;

pub const RECORDINGS_DIR: &str = "录音";
const TAKES_FILE: &str = "takes.json";
/// 异常录音的后缀：不以 `.wav.part` 结尾，所以不会再被恢复，也不进录音列表
pub const ABNORMAL_SUFFIX: &str = ".异常录音.part";
/// 未完成录音超过歌长的这么多倍，算异常
const ABNORMAL_RATIO: f64 = 1.5;
/// 不知道歌长时，超过这么长（秒）算异常
const ABNORMAL_FALLBACK_SECONDS: f64 = 15.0 * 60.0;
/// 资料检查扫描时，最近这么多秒内还在写的 `.wav.part` 可能正在录，不动
const BUSY_PART_SECONDS: u64 = 60;

pub fn song_dir(root: &Path, title: &str) -> PathBuf {
    root.join(RECORDINGS_DIR).join(sanitize_file_stem(title))
}

/// 32 位浮点 WAV 头
fn wav_header(sample_rate: u32, channels: u16, data_bytes: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_bytes).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&3u16.to_le_bytes()); // IEEE float
    h[22..24].copy_from_slice(&channels.to_le_bytes());
    h[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    h[28..32].copy_from_slice(&(sample_rate * 4 * channels as u32).to_le_bytes());
    h[32..34].copy_from_slice(&(4 * channels).to_le_bytes());
    h[34..36].copy_from_slice(&32u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    h
}

/// 校验是 `<曲库>/录音/<某首歌>/`（或其下的「导出」）里的文件
pub fn checked_path(root: &Path, path: &Path, suffix: &str) -> io::Result<PathBuf> {
    let bad = || io::Error::new(io::ErrorKind::InvalidInput, "不是录音文件夹里的文件");
    let name = path.file_name().and_then(|n| n.to_str()).ok_or_else(bad)?;
    if !name.ends_with(suffix) || name.starts_with('.') {
        return Err(bad());
    }
    let parent = path.parent().ok_or_else(bad)?.canonicalize()?;
    let rec = root.join(RECORDINGS_DIR).canonicalize()?;
    let song = if parent.file_name().is_some_and(|n| n == EXPORT_DIR) { parent.parent() } else { Some(parent.as_path()) };
    if song.and_then(Path::parent) != Some(rec.as_path()) {
        return Err(bad());
    }
    Ok(parent.join(name))
}

pub const EXPORT_DIR: &str = "导出";

/// 开始写一个导出文件（多声道 32 位浮点），返回 `.wav.part` 路径；重名自动加序号
pub fn begin_export(root: &Path, title: &str, name: &str, sample_rate: u32, channels: u16) -> io::Result<PathBuf> {
    let dir = song_dir(root, title).join(EXPORT_DIR);
    fs::create_dir_all(&dir)?;
    let stem = sanitize_file_stem(name);
    let mut n = 1;
    let path = loop {
        let base = if n == 1 { stem.clone() } else { format!("{stem} ({n})") };
        if !dir.join(format!("{base}.wav")).exists() && !dir.join(format!("{base}.m4a")).exists() && !dir.join(format!("{base}.wav.part")).exists() {
            break dir.join(format!("{base}.wav.part"));
        }
        n += 1;
    };
    fs::write(&path, wav_header(sample_rate, channels, 0))?;
    Ok(path)
}

/// 开始一条录音：返回 `.wav.part` 路径
pub fn begin(root: &Path, title: &str, sample_rate: u32) -> io::Result<PathBuf> {
    let dir = song_dir(root, title);
    fs::create_dir_all(&dir)?;
    let mut n = 1;
    let path = loop {
        let wav = dir.join(format!("take-{n:02}.wav"));
        let part = dir.join(format!("take-{n:02}.wav.part"));
        let abnormal = dir.join(format!("take-{n:02}{ABNORMAL_SUFFIX}"));
        if !wav.exists() && !part.exists() && !abnormal.exists() {
            break part;
        }
        n += 1;
    };
    fs::write(&path, wav_header(sample_rate, 1, 0))?;
    Ok(path)
}

/// 追加一段 32 位浮点小端采样（base64）
pub fn append(root: &Path, part: &Path, data_b64: &str) -> io::Result<()> {
    let part = checked_path(root, part, ".wav.part")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let mut f = OpenOptions::new().append(true).open(part)?;
    f.write_all(&bytes)
}

/// 结束：补写 WAV 长度并改名为 `.wav`，返回最终路径
pub fn finish(root: &Path, part: &Path) -> io::Result<PathBuf> {
    let part = checked_path(root, part, ".wav.part")?;
    let len = fs::metadata(&part)?.len();
    let data = (len.saturating_sub(44) / 4 * 4) as u32;
    let mut f = OpenOptions::new().read(true).write(true).open(&part)?;
    let mut head = [0u8; 44];
    io::Read::read_exact(&mut f, &mut head)?;
    let channels = u16::from_le_bytes([head[22], head[23]]).max(1);
    let rate = u32::from_le_bytes(head[24..28].try_into().unwrap());
    let data = data / (4 * channels as u32) * (4 * channels as u32);
    f.seek(SeekFrom::Start(0))?;
    f.write_all(&wav_header(rate, channels, data))?;
    f.set_len(44 + data as u64)?;
    drop(f);
    let wav = part.with_extension(""); // take-01.wav.part → take-01.wav
    fs::rename(&part, &wav)?;
    Ok(wav)
}

pub fn discard(root: &Path, part: &Path) -> io::Result<()> {
    fs::remove_file(checked_path(root, part, ".wav.part")?)
}

/// 一条异常录音（文件名、字节数、按文件头算的秒数）
#[derive(Debug, Clone, PartialEq)]
pub struct Abnormal {
    pub file: String,
    pub bytes: u64,
    pub seconds: f64,
}

impl Abnormal {
    fn json(&self) -> Value {
        serde_json::json!({ "file": self.file, "bytes": self.bytes, "seconds": self.seconds })
    }
}

/// 未完成 / 异常录音的大小和长度：(字节数 - 44) / (4 × 声道) / 采样率
fn part_info(path: &Path) -> io::Result<(u64, f64)> {
    let bytes = fs::metadata(path)?.len();
    let mut head = [0u8; 44];
    let mut f = fs::File::open(path)?;
    let (channels, rate) = match io::Read::read_exact(&mut f, &mut head) {
        Ok(()) => (u16::from_le_bytes([head[22], head[23]]).max(1), u32::from_le_bytes(head[24..28].try_into().unwrap()).max(1)),
        Err(_) => (1, 48000),
    };
    Ok((bytes, bytes.saturating_sub(44) as f64 / (4.0 * channels as f64) / rate as f64))
}

/// 这么长的未完成录音算不算异常：超过歌长 1.5 倍；不知道歌长时超过 15 分钟
pub fn is_abnormal(seconds: f64, song_seconds: Option<f64>) -> bool {
    match song_seconds.filter(|s| *s > 0.0) {
        // 短歌按 1.5 倍算太紧（自动停在歌长 + 30 秒），至少要多出 60 秒才算
        Some(song) => seconds > (song * ABNORMAL_RATIO).max(song + 60.0),
        None => seconds > ABNORMAL_FALLBACK_SECONDS,
    }
}

/// 歌长（秒）：读这首歌 wav 伴奏（没有就读 wav 人声）的文件头。只有 mp3 / m4a 等时返回 None
pub fn song_seconds(root: &Path, title: &str) -> Option<f64> {
    let names: Vec<String> = fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    let lib = crate::library::build_library(root, &names);
    let id = crate::library::normalize_title(title);
    lib.songs.iter().find(|s| s.id == id || s.title == title).and_then(song_wav_seconds)
}

fn song_wav_seconds(song: &crate::library::Song) -> Option<f64> {
    song.accompaniments.iter().chain(&song.vocals).filter(|f| f.format == "wav").find_map(|f| {
        let r = hound::WavReader::open(&f.path).ok()?;
        let rate = r.spec().sample_rate;
        (rate > 0).then(|| r.duration() as f64 / rate as f64)
    })
}

/// 把异常的 `take-NN.wav.part` 改名成 `take-NN.异常录音.part`（重名加序号），内容不动
fn mark_abnormal(part: &Path) -> io::Result<PathBuf> {
    let name = part.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let stem = name.strip_suffix(".wav.part").unwrap_or(name);
    let mut target = part.with_file_name(format!("{stem}{ABNORMAL_SUFFIX}"));
    let mut n = 2;
    while target.exists() {
        target = part.with_file_name(format!("{stem} ({n}){ABNORMAL_SUFFIX}"));
        n += 1;
    }
    fs::rename(part, &target)?;
    Ok(target)
}

/// 这首歌录音文件夹里已经标成异常的录音
fn list_abnormal(dir: &Path) -> Vec<Abnormal> {
    let Ok(entries) = fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<Abnormal> = entries
        .flatten()
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().into_owned();
            if !file.ends_with(ABNORMAL_SUFFIX) || file.starts_with('.') {
                return None;
            }
            let (bytes, seconds) = part_info(&e.path()).ok()?;
            Some(Abnormal { file, bytes, seconds })
        })
        .collect();
    out.sort_by(|a, b| a.file.cmp(&b.file));
    out
}

/// 上次录到一半退出（崩溃、强制退出）留下的 `.wav.part`：补好长度变成正常的 wav，返回 (文件名, 秒数)。
/// 比歌长很多的（见 `is_abnormal`）不恢复，改名标成异常录音，和以前标过的一起放在第二个返回值里
pub fn recover_parts(root: &Path, title: &str, song_seconds: Option<f64>) -> io::Result<(Vec<(String, f64)>, Vec<Abnormal>)> {
    let dir = song_dir(root, title);
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else { return Ok((out, vec![])) };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".wav.part") || name.starts_with('.') {
            continue;
        }
        let (_, seconds) = match part_info(&entry.path()) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            r => r?,
        };
        if is_abnormal(seconds, song_seconds) {
            match mark_abnormal(&entry.path()) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                r => {
                    r?;
                }
            }
            continue;
        }
        let wav = finish(root, &entry.path())?;
        let bytes = fs::metadata(&wav)?.len().saturating_sub(44);
        let mut f = fs::File::open(&wav)?;
        let mut rate = [0u8; 4];
        f.seek(SeekFrom::Start(24))?;
        io::Read::read_exact(&mut f, &mut rate)?;
        let rate = u32::from_le_bytes(rate).max(1) as f64;
        out.push((wav.file_name().unwrap().to_string_lossy().into_owned(), bytes as f64 / 4.0 / rate));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((out, list_abnormal(&dir)))
}

/// 读取 Take 列表：`{"dir": 录音文件夹, "takes": [...], "recovered": [{file, seconds}], "abnormal": [{file, bytes, seconds}]}`。
/// `song_seconds` 是歌长（判断异常录音用，见 `song_seconds`）
pub fn load_takes(root: &Path, title: &str, song_seconds: Option<f64>) -> io::Result<Value> {
    let (recovered, abnormal) = recover_parts(root, title, song_seconds)?;
    let dir = song_dir(root, title);
    let takes = match fs::read_to_string(dir.join(TAKES_FILE)) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => Value::Array(vec![]),
        Err(e) => return Err(e),
    };
    let recovered: Vec<Value> = recovered
        .into_iter()
        .map(|(file, seconds)| serde_json::json!({ "file": file, "seconds": seconds }))
        .collect();
    let abnormal: Vec<Value> = abnormal.iter().map(Abnormal::json).collect();
    Ok(serde_json::json!({ "dir": dir.to_string_lossy(), "takes": takes, "recovered": recovered, "abnormal": abnormal }))
}

/// 资料检查：整个曲库的异常录音 `[{title, file, bytes, seconds}]`（title 用来调 trash_takes）。
/// 顺手把还没判断过的超长 `.wav.part` 标成异常（最近 1 分钟内还在写的可能正在录，不动；正常长度的留给打开这首歌时恢复）
pub fn abnormal_recordings(root: &Path) -> io::Result<Vec<Value>> {
    let rec = root.join(RECORDINGS_DIR);
    let Ok(dirs) = fs::read_dir(&rec) else { return Ok(vec![]) };
    let names: Vec<String> = fs::read_dir(root)?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    let lib = crate::library::build_library(root, &names);
    let mut out = Vec::new();
    for d in dirs.flatten() {
        if !d.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let folder = d.file_name().to_string_lossy().into_owned();
        let song = lib.songs.iter().find(|s| sanitize_file_stem(&s.title) == folder);
        let title = song.map_or_else(|| folder.clone(), |s| s.title.clone());
        let mut song_secs: Option<Option<f64>> = None;
        for e in fs::read_dir(d.path())?.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".wav.part") || name.starts_with('.') {
                continue;
            }
            let busy = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_none_or(|age| age.as_secs() < BUSY_PART_SECONDS);
            if busy {
                continue;
            }
            // 同时打开了这首歌（load_takes）时文件可能刚被改名或恢复，跳过
            let Ok((_, seconds)) = part_info(&e.path()) else { continue };
            let secs = *song_secs.get_or_insert_with(|| song.and_then(song_wav_seconds));
            if is_abnormal(seconds, secs) {
                match mark_abnormal(&e.path()) {
                    Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                    r => {
                        r?;
                    }
                }
            }
        }
        for a in list_abnormal(&d.path()) {
            let mut v = a.json();
            v["title"] = Value::from(title.clone());
            out.push(v);
        }
    }
    out.sort_by(|a, b| (a["title"].as_str(), a["file"].as_str()).cmp(&(b["title"].as_str(), b["file"].as_str())));
    Ok(out)
}

pub fn save_takes(root: &Path, title: &str, takes: &Value) -> io::Result<()> {
    if !takes.is_array() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "takes 必须是数组"));
    }
    let dir = song_dir(root, title);
    fs::create_dir_all(&dir)?;
    let tmp = dir.join(".takes.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(takes).unwrap())?;
    fs::rename(tmp, dir.join(TAKES_FILE))
}

/// 把这首歌录音文件夹里的若干文件（`.wav`，或异常录音）移到废纸篓
pub fn trash(root: &Path, title: &str, files: &[String], trash_dir: &Path) -> io::Result<()> {
    let dir = song_dir(root, title);
    fs::create_dir_all(trash_dir)?;
    for name in files {
        let suffix = if name.ends_with(ABNORMAL_SUFFIX) { ABNORMAL_SUFFIX } else { ".wav" };
        let path = checked_path(root, &dir.join(name), suffix)?;
        if !path.exists() {
            continue;
        }
        let stem = format!("{}-{}", sanitize_file_stem(title), name);
        let mut target = trash_dir.join(&stem);
        let mut n = 1;
        while target.exists() {
            target = trash_dir.join(format!("{n}-{stem}"));
            n += 1;
        }
        if fs::rename(&path, &target).is_err() {
            fs::copy(&path, &target)?;
            fs::remove_file(&path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_appends_and_finishes_a_valid_wav() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let part = begin(root, "月光 Lo-fi", 48000).unwrap();
        assert!(part.ends_with("录音/月光 Lo-fi/take-01.wav.part"));
        let samples: Vec<u8> = [0.5f32, -0.25, 0.0].iter().flat_map(|v| v.to_le_bytes()).collect();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&samples);
        append(root, &part, &b64).unwrap();
        append(root, &part, &b64).unwrap();
        let wav = finish(root, &part).unwrap();
        assert!(wav.ends_with("take-01.wav"));
        let bytes = fs::read(&wav).unwrap();
        assert_eq!(bytes.len(), 44 + 24);
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 24);
        assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 48000);
        assert_eq!(f32::from_le_bytes(bytes[44..48].try_into().unwrap()), 0.5);
        // 下一条编号递增
        assert!(begin(root, "月光 Lo-fi", 48000).unwrap().ends_with("take-02.wav.part"));
    }

    #[test]
    fn takes_json_roundtrip_and_trash() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(load_takes(root, "歌", None).unwrap()["takes"], serde_json::json!([]));
        let takes = serde_json::json!([{ "id": "a", "name": "第一遍" }]);
        save_takes(root, "歌", &takes).unwrap();
        let loaded = load_takes(root, "歌", None).unwrap();
        assert_eq!(loaded["takes"], takes);
        assert!(loaded["dir"].as_str().unwrap().ends_with("录音/歌"));

        let part = begin(root, "歌", 44100).unwrap();
        let wav = finish(root, &part).unwrap();
        let trash_dir = dir.path().join("trash");
        trash(root, "歌", &["take-01.wav".into()], &trash_dir).unwrap();
        assert!(!wav.exists());
        assert!(trash_dir.join("歌-take-01.wav").exists());
    }

    #[test]
    fn recovers_unfinished_recordings() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let part = begin(root, "歌", 48000).unwrap();
        let samples: Vec<u8> = vec![0.1f32; 48000].iter().flat_map(|v| v.to_le_bytes()).collect();
        append(root, &part, &base64::engine::general_purpose::STANDARD.encode(&samples)).unwrap();
        // 模拟没调 finish 就退出
        let loaded = load_takes(root, "歌", None).unwrap();
        assert_eq!(loaded["recovered"][0]["file"], "take-01.wav");
        assert!((loaded["recovered"][0]["seconds"].as_f64().unwrap() - 1.0).abs() < 1e-6);
        assert!(!part.exists());
        assert!(load_takes(root, "歌", None).unwrap()["recovered"].as_array().unwrap().is_empty());
    }

    /// 写一条没 finish 的录音：采样率 rate、seconds 秒
    fn leftover_part(root: &Path, title: &str, rate: u32, seconds: f64) -> PathBuf {
        let part = begin(root, title, rate).unwrap();
        let n = (rate as f64 * seconds).round() as usize;
        let samples: Vec<u8> = vec![0.1f32; n].iter().flat_map(|v| v.to_le_bytes()).collect();
        append(root, &part, &base64::engine::general_purpose::STANDARD.encode(&samples)).unwrap();
        part
    }

    #[test]
    fn abnormal_rule() {
        assert!(!is_abnormal(300.0, Some(240.0)));
        assert!(!is_abnormal(360.0, Some(240.0)));
        assert!(is_abnormal(361.0, Some(240.0)));
        // 短歌：自动停在歌长 + 前置 + 30 秒的不算异常
        assert!(!is_abnormal(95.0, Some(60.0)));
        assert!(is_abnormal(121.0, Some(60.0)));
        // 不知道歌长：15 分钟
        assert!(!is_abnormal(900.0, None));
        assert!(is_abnormal(901.0, None));
        assert!(is_abnormal(901.0, Some(0.0)));
    }

    #[test]
    fn overlong_part_is_marked_not_recovered() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let part = leftover_part(root, "歌", 1000, 63.0);
        // 歌长 2 秒：63 秒超过 1.5 倍、也多出 60 秒以上
        let loaded = load_takes(root, "歌", Some(2.0)).unwrap();
        assert!(loaded["recovered"].as_array().unwrap().is_empty());
        assert_eq!(loaded["abnormal"][0]["file"], "take-01.异常录音.part");
        assert_eq!(loaded["abnormal"][0]["bytes"], 44 + 63000 * 4);
        assert!((loaded["abnormal"][0]["seconds"].as_f64().unwrap() - 63.0).abs() < 1e-6);
        assert!(!part.exists());
        let marked = song_dir(root, "歌").join("take-01.异常录音.part");
        let before = fs::read(&marked).unwrap();
        // 再读一次：不恢复、不重复改名，内容不动
        let again = load_takes(root, "歌", None).unwrap();
        assert!(again["recovered"].as_array().unwrap().is_empty());
        assert_eq!(again["abnormal"].as_array().unwrap().len(), 1);
        assert_eq!(fs::read(&marked).unwrap(), before);
        // 新录音不占这个编号
        assert!(begin(root, "歌", 1000).unwrap().ends_with("take-02.wav.part"));
        // 移到废纸篓
        let trash_dir = root.join("trash");
        trash(root, "歌", &["take-01.异常录音.part".into()], &trash_dir).unwrap();
        assert!(!marked.exists());
        assert!(trash_dir.join("歌-take-01.异常录音.part").exists());
    }

    #[test]
    fn normal_part_still_recovered_with_song_length() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        leftover_part(root, "歌", 1000, 2.5);
        let loaded = load_takes(root, "歌", Some(2.0)).unwrap();
        assert_eq!(loaded["recovered"][0]["file"], "take-01.wav");
        assert!(loaded["abnormal"].as_array().unwrap().is_empty());
    }

    #[test]
    fn unknown_song_length_uses_15_minutes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        leftover_part(root, "短", 100, 14.0 * 60.0);
        assert_eq!(load_takes(root, "短", None).unwrap()["recovered"][0]["file"], "take-01.wav");
        leftover_part(root, "长", 100, 16.0 * 60.0);
        let loaded = load_takes(root, "长", None).unwrap();
        assert!(loaded["recovered"].as_array().unwrap().is_empty());
        assert_eq!(loaded["abnormal"][0]["file"], "take-01.异常录音.part");
    }

    #[test]
    fn reads_song_length_from_wav_accompaniment() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let spec = hound::WavSpec { channels: 2, sample_rate: 1000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(root.join("月光 - 伴奏.wav"), spec).unwrap();
        for _ in 0..3000 * 2 {
            w.write_sample(0i16).unwrap();
        }
        w.finalize().unwrap();
        fs::write(root.join("别的 - 伴奏.mp3"), b"x").unwrap();
        assert_eq!(song_seconds(root, "月光"), Some(3.0));
        assert_eq!(song_seconds(root, "别的"), None);
        assert_eq!(song_seconds(root, "没有"), None);
    }

    #[test]
    fn check_scan_marks_idle_overlong_parts_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(abnormal_recordings(root).unwrap().is_empty());
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        // 很久没动的超长录音：标成异常
        let idle = leftover_part(root, "甲", 100, 16.0 * 60.0);
        fs::File::options().write(true).open(&idle).unwrap().set_modified(old).unwrap();
        // 正在写的超长录音：不动
        let busy = leftover_part(root, "乙", 100, 16.0 * 60.0);
        // 正常长度：留给打开这首歌时恢复
        let normal = leftover_part(root, "丙", 100, 60.0);
        fs::File::options().write(true).open(&normal).unwrap().set_modified(old).unwrap();
        let list = abnormal_recordings(root).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["title"], "甲");
        assert_eq!(list[0]["file"], "take-01.异常录音.part");
        assert!(!idle.exists() && busy.exists() && normal.exists());
        assert_eq!(abnormal_recordings(root).unwrap().len(), 1);
    }

    #[test]
    fn rejects_paths_outside_recordings() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(RECORDINGS_DIR)).unwrap();
        let outside = root.join("x.wav.part");
        fs::write(&outside, b"x").unwrap();
        assert!(append(root, &outside, "AAAA").is_err());
        assert!(trash(root, "歌", &["../../x.wav".into()], &root.join("t")).is_err());
    }
}
