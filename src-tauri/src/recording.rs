//! 录音文件与 Take 信息（PRD 4.4 / 7.2）。
//!
//! - 录音放在 `<曲库>/录音/<歌名>/take-NN.wav`，Take 信息存同目录 `takes.json`
//! - 边录边写：开始时建 `.wav.part`（32 位浮点单声道 WAV，长度先填 0），每秒追加一段，结束时补写长度并改名
//! - 全部是无状态的文件操作（每次调用都按路径打开），测试模式的一次性进程也能用
//! - 删除 Take 是把文件移到废纸篓，不直接删

use base64::Engine;
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::lyrics_store::sanitize_file_stem;

pub const RECORDINGS_DIR: &str = "录音";
const TAKES_FILE: &str = "takes.json";

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
        if !wav.exists() && !part.exists() {
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

/// 上次录到一半退出（崩溃、强制退出）留下的 `.wav.part`：补好长度变成正常的 wav，返回 (文件名, 秒数)
pub fn recover_parts(root: &Path, title: &str) -> io::Result<Vec<(String, f64)>> {
    let dir = song_dir(root, title);
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(out) };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".wav.part") || name.starts_with('.') {
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
    Ok(out)
}

/// 读取 Take 列表：`{"dir": 录音文件夹, "takes": [...], "recovered": [{file, seconds}]}`
pub fn load_takes(root: &Path, title: &str) -> io::Result<Value> {
    let recovered = recover_parts(root, title)?;
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
    Ok(serde_json::json!({ "dir": dir.to_string_lossy(), "takes": takes, "recovered": recovered }))
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

/// 把这首歌录音文件夹里的若干文件移到废纸篓
pub fn trash(root: &Path, title: &str, files: &[String], trash_dir: &Path) -> io::Result<()> {
    let dir = song_dir(root, title);
    fs::create_dir_all(trash_dir)?;
    for name in files {
        let path = checked_path(root, &dir.join(name), ".wav")?;
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
        assert_eq!(load_takes(root, "歌").unwrap()["takes"], serde_json::json!([]));
        let takes = serde_json::json!([{ "id": "a", "name": "第一遍" }]);
        save_takes(root, "歌", &takes).unwrap();
        let loaded = load_takes(root, "歌").unwrap();
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
        let loaded = load_takes(root, "歌").unwrap();
        assert_eq!(loaded["recovered"][0]["file"], "take-01.wav");
        assert!((loaded["recovered"][0]["seconds"].as_f64().unwrap() - 1.0).abs() < 1e-6);
        assert!(!part.exists());
        assert!(load_takes(root, "歌").unwrap()["recovered"].as_array().unwrap().is_empty());
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
