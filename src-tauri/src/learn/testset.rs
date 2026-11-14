//! 我的测试集（PRD 4.12）：用我自己的声音录「问老师 / 念歌词 / 清唱」，用来定识别模型和「过了」的阈值。
//!
//! 只存本机、不进仓库（里面有歌词和我的声音）。文件夹里：
//! - `题目.json`：题目（自己生成，`items[]` 每条有 id、kind = ask / read / sing、text，以及预期读音、故意念错的地方）
//! - `录音/<id>.wav`：录好的一句（16 位单声道）；重录直接覆盖
//! - `录音/<id>.json`：这条题目 + 录音信息（时长、采样率、麦克风、第几次录）
//! - `录音/记录.json`：每题的状态（录好 / 跳过），录音页靠它接着上次录
//!
//! 现在只在测试模式里用（devbridge 的 testset_* 命令）。

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const ITEMS_FILE: &str = "题目.json";
pub const TAKES_DIR: &str = "录音";
pub const RECORD_FILE: &str = "记录.json";

/// 一题现在的状态
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// "done" 录好了 / "skipped" 跳过了
    pub status: String,
    #[serde(default)]
    pub seconds: f64,
    /// 录了几次（重录会加一）
    #[serde(default)]
    pub takes: u32,
    /// 最后一次改动（Unix 秒）
    #[serde(default)]
    pub at: u64,
}

/// 录音时界面带过来的信息
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeInfo {
    pub seconds: f64,
    pub sample_rate: u32,
    #[serde(default)]
    pub device: String,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("读不了 {}：{e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{} 格式不对：{e}", path.display()))
}

/// 先写临时文件再改名，录到一半关掉也不会留下半个文件
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("写不了 {}：{e}", path.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("写不了 {}：{e}", path.display()))
}

fn items(dir: &Path) -> Result<(Value, Vec<Value>), String> {
    let file = dir.join(ITEMS_FILE);
    if !file.exists() {
        return Err(format!("还没有题目：{} 不存在", file.display()));
    }
    let all = read_json(&file)?;
    let list = all.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok((all, list))
}

fn records(dir: &Path) -> BTreeMap<String, Record> {
    read_json(&dir.join(TAKES_DIR).join(RECORD_FILE)).ok().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn save_records(dir: &Path, r: &BTreeMap<String, Record>) -> Result<(), String> {
    let takes = dir.join(TAKES_DIR);
    fs::create_dir_all(&takes).map_err(|e| format!("建不了 {}：{e}", takes.display()))?;
    write_atomic(&takes.join(RECORD_FILE), serde_json::to_string_pretty(r).unwrap().as_bytes())
}

/// 题目里找这个 id；id 只能是字母数字和横线（拿来当文件名）
fn find_item(list: &[Value], id: &str) -> Result<Value, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("题目编号不对：{id}"));
    }
    list.iter().find(|it| it.get("id").and_then(Value::as_str) == Some(id)).cloned().ok_or_else(|| format!("题目里没有 {id}"))
}

/// 录音页要的全部：题目、每题状态、文件夹位置
pub fn load(dir: &Path) -> Result<Value, String> {
    let (all, list) = items(dir)?;
    let mut out = Map::new();
    out.insert("dir".into(), Value::from(dir.to_string_lossy().into_owned()));
    out.insert("song".into(), all.get("song").cloned().unwrap_or(Value::Null));
    out.insert("items".into(), Value::from(list));
    out.insert("records".into(), serde_json::to_value(records(dir)).unwrap());
    Ok(Value::Object(out))
}

/// 存一句：wav 是 base64 的完整 wav 文件。同时写一份 json（题目 + 录音信息），返回这题的新状态
pub fn save(dir: &Path, id: &str, wav_base64: &str, info: &TakeInfo) -> Result<Record, String> {
    let (_, list) = items(dir)?;
    let item = find_item(&list, id)?;
    let wav = base64::engine::general_purpose::STANDARD.decode(wav_base64.trim()).map_err(|e| format!("录音数据坏了：{e}"))?;
    if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err("录音数据不是 wav".into());
    }
    if wav.len() == 44 {
        return Err("录音是空的".into());
    }
    let takes = dir.join(TAKES_DIR);
    fs::create_dir_all(&takes).map_err(|e| format!("建不了 {}：{e}", takes.display()))?;

    let mut recs = records(dir);
    let prev = recs.get(id).map(|r| r.takes).unwrap_or(0);
    let rec = Record { status: "done".into(), seconds: (info.seconds * 100.0).round() / 100.0, takes: prev + 1, at: now() };

    write_atomic(&takes.join(format!("{id}.wav")), &wav)?;
    let mut meta = item.as_object().cloned().unwrap_or_default();
    meta.insert(
        "recording".into(),
        serde_json::json!({
            "file": format!("{id}.wav"),
            "seconds": rec.seconds,
            "sampleRate": info.sample_rate,
            "device": info.device,
            "take": rec.takes,
            "at": rec.at,
        }),
    );
    write_atomic(&takes.join(format!("{id}.json")), serde_json::to_string_pretty(&Value::Object(meta)).unwrap().as_bytes())?;
    recs.insert(id.to_string(), rec.clone());
    save_records(dir, &recs)?;
    Ok(rec)
}

/// 跳过一题（skip = false 取消跳过）。已经录好的不会被删，只是标成跳过
pub fn skip(dir: &Path, id: &str, skip: bool) -> Result<Option<Record>, String> {
    let (_, list) = items(dir)?;
    find_item(&list, id)?;
    let mut recs = records(dir);
    let has_wav = dir.join(TAKES_DIR).join(format!("{id}.wav")).exists();
    let next = match (skip, recs.get(id).cloned()) {
        (true, r) => Some(Record { status: "skipped".into(), at: now(), ..r.unwrap_or_default() }),
        (false, Some(r)) if has_wav => Some(Record { status: "done".into(), at: now(), ..r }),
        (false, _) => None,
    };
    match &next {
        Some(r) => recs.insert(id.to_string(), r.clone()),
        None => recs.remove(id),
    };
    save_records(dir, &recs)?;
    Ok(next)
}

/// 录好的那句（base64 的 wav），给录音页回放
pub fn audio(dir: &Path, id: &str) -> Result<String, String> {
    let (_, list) = items(dir)?;
    find_item(&list, id)?;
    let path: PathBuf = dir.join(TAKES_DIR).join(format!("{id}.wav"));
    let bytes = fs::read(&path).map_err(|_| "这题还没录".to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let items = serde_json::json!({
            "song": "测试",
            "items": [
                { "id": "ask-01", "kind": "ask", "text": "夏実{かじつ} 怎么念？", "expect": "夏実 怎么念？" },
                { "id": "read-01", "kind": "read", "text": "原文", "reading": "げんぶん", "say": "げんもん",
                  "mistake": { "word": "原文", "correct": "げんぶん", "wrong": "げんもん" } }
            ]
        });
        fs::write(d.path().join(ITEMS_FILE), items.to_string()).unwrap();
        d
    }

    fn wav(samples: usize) -> String {
        let mut b = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        b.resize(44, 0);
        b.extend(std::iter::repeat_n(1u8, samples * 2));
        base64::engine::general_purpose::STANDARD.encode(b)
    }

    #[test]
    fn record_rerecord_skip() {
        let d = setup();
        let dir = d.path();
        let info = TakeInfo { seconds: 1.234, sample_rate: 48000, device: "麦克风".into() };

        let r = save(dir, "read-01", &wav(10), &info).unwrap();
        assert_eq!((r.status.as_str(), r.takes, r.seconds), ("done", 1, 1.23));
        let meta = read_json(&dir.join(TAKES_DIR).join("read-01.json")).unwrap();
        assert_eq!(meta["mistake"]["wrong"], "げんもん");
        assert_eq!(meta["recording"]["sampleRate"], 48000);

        // 重录：覆盖 wav，次数加一
        let r = save(dir, "read-01", &wav(20), &info).unwrap();
        assert_eq!(r.takes, 2);
        assert_eq!(fs::read(dir.join(TAKES_DIR).join("read-01.wav")).unwrap().len(), 44 + 40);

        // 跳过没录过的、取消跳过
        assert_eq!(skip(dir, "ask-01", true).unwrap().unwrap().status, "skipped");
        assert_eq!(skip(dir, "ask-01", false).unwrap(), None);
        // 录过的跳过再取消，回到录好
        skip(dir, "read-01", true).unwrap();
        assert_eq!(skip(dir, "read-01", false).unwrap().unwrap().status, "done");

        let v = load(dir).unwrap();
        assert_eq!(v["records"]["read-01"]["takes"], 2);
        assert!(v["records"].get("ask-01").is_none());
        assert!(audio(dir, "read-01").is_ok());
        assert!(audio(dir, "ask-01").is_err());
    }

    #[test]
    fn rejects_bad_input() {
        let d = setup();
        let info = TakeInfo::default();
        assert!(save(d.path(), "../x", &wav(10), &info).is_err());
        assert!(save(d.path(), "nope", &wav(10), &info).is_err());
        assert!(save(d.path(), "ask-01", "bm90IGEgd2F2", &info).is_err());
        assert!(save(d.path(), "ask-01", &wav(0), &info).is_err());
        assert!(load(tempfile::tempdir().unwrap().path()).is_err());
    }
}
