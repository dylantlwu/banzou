//! 智能对齐用的语音识别：调用 sidecar（helpers/helper.swift 编译出的 banzou-helper），
//! 拿到人声分轨里每个字的时间。结果按文件缓存，同一个文件只识别一次。

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;

/// 识别结果格式变了就加一，旧缓存自动作废
const CACHE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Token {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// 解析 sidecar 的输出：每行一个 JSON，有 error 字段就是出错
pub fn parse_output(stdout: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    for line in stdout.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let value: serde_json::Value = serde_json::from_str(line).map_err(|e| format!("识别输出格式不对：{e}"))?;
        if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
            return Err(err.to_string());
        }
        let token: Token = serde_json::from_value(value).map_err(|e| format!("识别输出格式不对：{e}"))?;
        if !token.text.trim().is_empty() {
            tokens.push(token);
        }
    }
    Ok(tokens)
}

fn cache_path(cache_dir: &Path, audio: &Path) -> Option<PathBuf> {
    let meta = fs::metadata(audio).ok()?;
    let mut h = DefaultHasher::new();
    CACHE_VERSION.hash(&mut h);
    audio.hash(&mut h);
    meta.len().hash(&mut h);
    meta.modified().ok()?.hash(&mut h);
    Some(cache_dir.join("transcripts").join(format!("{:016x}.json", h.finish())))
}

/// 识别一个音频文件；有缓存直接用缓存
pub fn transcribe(helper: &Path, audio: &Path, cache_dir: &Path) -> Result<Vec<Token>, String> {
    let cache = cache_path(cache_dir, audio);
    if let Some(tokens) = cache
        .as_ref()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<Token>>(&s).ok())
    {
        return Ok(tokens);
    }

    let output = Command::new(helper)
        .arg("transcribe")
        .arg(audio)
        .output()
        .map_err(|e| format!("启动语音识别失败（{}）：{e}", helper.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let tokens = parse_output(&stdout)?;
    if !output.status.success() {
        return Err(format!("语音识别异常退出：{}", String::from_utf8_lossy(&output.stderr).trim()));
    }

    if let Some(path) = cache {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("tmp");
        if fs::write(&tmp, serde_json::to_vec(&tokens).unwrap_or_default()).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
    Ok(tokens)
}

/// 当前音频输出 / 输入设备：`{"output":{"name","kind"},"input":{...}}`
pub fn route(helper: &Path) -> Result<serde_json::Value, String> {
    let output = Command::new(helper).arg("route").output().map_err(|e| format!("检测音频设备失败：{e}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(text.trim()).map_err(|e| format!("设备信息格式不对：{e}"))?;
    if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(value)
}

/// 只允许识别曲库文件夹第一层里的文件
pub fn checked_audio_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| format!("曲库文件夹不可用：{e}"))?;
    let path = path.canonicalize().map_err(|e| format!("找不到音频文件：{e}"))?;
    if path.parent() != Some(root.as_path()) {
        return Err("只能识别曲库文件夹里的音频".into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tokens_and_skips_blank() {
        let out = "{\"start\":1.0,\"end\":1.5,\"text\":\"宝\"}\n{\"start\":2,\"end\":2.1,\"text\":\" \"}\n";
        assert_eq!(
            parse_output(out).unwrap(),
            vec![Token { start: 1.0, end: 1.5, text: "宝".into() }]
        );
    }

    #[test]
    fn reports_helper_error() {
        assert_eq!(parse_output("{\"error\":\"没有模型\"}").unwrap_err(), "没有模型");
    }

    #[test]
    fn uses_cache_and_rejects_outside_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("lib");
        fs::create_dir(&root).unwrap();
        let audio = root.join("a - 人声.wav");
        fs::write(&audio, b"x").unwrap();
        let cache_dir = dir.path().join("cache");
        let cached = vec![Token { start: 0.5, end: 0.8, text: "嗯".into() }];
        let p = cache_path(&cache_dir, &audio).unwrap();
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, serde_json::to_vec(&cached).unwrap()).unwrap();
        // helper 不存在也能用缓存
        assert_eq!(transcribe(Path::new("/nonexistent"), &audio, &cache_dir).unwrap(), cached);

        assert!(checked_audio_path(&root, &audio).is_ok());
        let outside = dir.path().join("b.wav");
        fs::write(&outside, b"x").unwrap();
        assert!(checked_audio_path(&root, &outside).is_err());
    }
}
