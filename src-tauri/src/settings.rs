//! 应用设置：存成 JSON，放在系统的应用配置目录里。
//! 内容由前端定义（耳机延迟、反应时间、默认音量等），后端只负责读写。

use serde_json::Value;
use std::fs;
use std::io;
use std::path::Path;

const FILE_NAME: &str = "settings.json";

/// 其他小数据（练声记录等）也存成同目录下的 JSON，名字必须在这个白名单里
pub const STORES: &[&str] = &["practice", "tv", "tags", "plays"];

pub fn load(dir: &Path) -> io::Result<Value> {
    load_file(dir, FILE_NAME)
}

pub fn save(dir: &Path, value: &Value) -> io::Result<()> {
    save_file(dir, FILE_NAME, value)
}

fn store_file(name: &str) -> io::Result<String> {
    if STORES.contains(&name) {
        Ok(format!("{name}.json"))
    } else {
        Err(io::Error::new(io::ErrorKind::InvalidInput, "不认识的数据名"))
    }
}

pub fn load_store(dir: &Path, name: &str) -> io::Result<Value> {
    load_file(dir, &store_file(name)?)
}

pub fn save_store(dir: &Path, name: &str, value: &Value) -> io::Result<()> {
    save_file(dir, &store_file(name)?, value)
}

const LIBRARY_FILE: &str = "library.json";

/// 记住的素材文件夹；没有或已经不存在返回 None
pub fn load_library_dir(dir: &Path) -> Option<std::path::PathBuf> {
    let v = load_file(dir, LIBRARY_FILE).ok()?;
    let p = std::path::PathBuf::from(v.get("dir")?.as_str()?);
    p.is_dir().then_some(p)
}

pub fn save_library_dir(dir: &Path, library: &Path) -> io::Result<()> {
    save_file(dir, LIBRARY_FILE, &serde_json::json!({ "dir": library.to_string_lossy() }))
}

/// 用系统的「选择文件夹」窗口（osascript，不需要额外插件）；用户取消返回 None
pub fn pick_folder() -> Result<Option<std::path::PathBuf>, String> {
    let out = std::process::Command::new("osascript")
        .args(["-e", "POSIX path of (choose folder with prompt \"选择放伴奏和歌词的文件夹\")"])
        .output()
        .map_err(|e| format!("打不开选择窗口：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        // -128 = 用户点了取消
        return if err.contains("-128") { Ok(None) } else { Err(format!("选择文件夹失败：{}", err.trim())) };
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().trim_end_matches('/').to_string();
    Ok((!path.is_empty()).then(|| std::path::PathBuf::from(path)))
}

fn load_file(dir: &Path, file: &str) -> io::Result<Value> {
    match fs::read_to_string(dir.join(file)) {
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_else(|_| Value::Object(Default::default()))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Value::Object(Default::default())),
        Err(e) => Err(e),
    }
}

fn save_file(dir: &Path, file: &str, value: &Value) -> io::Result<()> {
    if !value.is_object() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "设置必须是对象"));
    }
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{file}.tmp"));
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(tmp, dir.join(file))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn named_stores_are_whitelisted() {
        let dir = tempfile::tempdir().unwrap();
        save_store(dir.path(), "practice", &json!({ "days": {} })).unwrap();
        assert_eq!(load_store(dir.path(), "practice").unwrap(), json!({ "days": {} }));
        assert!(save_store(dir.path(), "../evil", &json!({})).is_err());
    }

    #[test]
    fn library_dir_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_library_dir(dir.path()), None);
        let lib = dir.path().join("我的歌");
        fs::create_dir(&lib).unwrap();
        save_library_dir(dir.path(), &lib).unwrap();
        assert_eq!(load_library_dir(dir.path()), Some(lib.clone()));
        fs::remove_dir(&lib).unwrap();
        assert_eq!(load_library_dir(dir.path()), None); // 文件夹被删了就当没选过
    }

    #[test]
    fn missing_or_corrupt_file_gives_empty_object() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), json!({}));
        fs::write(dir.path().join(FILE_NAME), "{坏掉的").unwrap();
        assert_eq!(load(dir.path()).unwrap(), json!({}));
    }

    #[test]
    fn save_then_load() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("新目录");
        let v = json!({ "outputLatencyMs": 180, "reactionMs": 100 });
        save(&sub, &v).unwrap();
        assert_eq!(load(&sub).unwrap(), v);
        assert!(save(&sub, &json!([1])).is_err());
    }
}
