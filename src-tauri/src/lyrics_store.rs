//! 歌词文件读写（PRD 7.1）：.lrc 保存在歌曲文件旁边，只允许读写素材文件夹里的 .lrc

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg.into())
}

/// 把歌名变成安全的文件名
pub fn sanitize_file_stem(title: &str) -> String {
    let s: String = title
        .trim()
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '\0') || c.is_control() { '_' } else { c })
        .collect();
    let s = s.trim_start_matches('.').trim().to_string();
    if s.is_empty() { "未命名".to_string() } else { s }
}

/// 校验路径是 root 第一层里的 .lrc 文件，返回规范化后的路径
fn checked_lrc_path(root: &Path, path: &Path) -> io::Result<PathBuf> {
    let is_lrc = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("lrc"));
    if !is_lrc {
        return Err(invalid("只能读写 .lrc 文件"));
    }
    let root = root.canonicalize()?;
    let parent = path.parent().ok_or_else(|| invalid("路径无效"))?.canonicalize()?;
    if parent != root {
        return Err(invalid("歌词文件必须在素材文件夹里"));
    }
    let name = path.file_name().ok_or_else(|| invalid("路径无效"))?;
    Ok(root.join(name))
}

pub fn read_lyrics(root: &Path, path: &Path) -> io::Result<String> {
    let path = checked_lrc_path(root, path)?;
    let bytes = fs::read(path)?;
    // 兼容带 BOM 的文件
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

/// 保存歌词。`existing` 是歌曲已有的 .lrc 路径（覆盖它），否则写成 `<歌名>.lrc`。
/// 先写临时文件再改名，避免写一半崩溃导致文件损坏。
pub fn save_lyrics(root: &Path, title: &str, existing: Option<&Path>, content: &str) -> io::Result<PathBuf> {
    let target = match existing {
        Some(p) => p.to_path_buf(),
        None => root.join(format!("{}.lrc", sanitize_file_stem(title))),
    };
    let target = checked_lrc_path(root, &target)?;
    let tmp = target.with_file_name(format!(
        ".{}.tmp",
        target.file_name().and_then(|n| n.to_str()).unwrap_or("lyrics")
    ));
    fs::write(&tmp, content.as_bytes())?;
    fs::rename(&tmp, &target)?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_titles() {
        assert_eq!(sanitize_file_stem("月光 Lo-fi Remix"), "月光 Lo-fi Remix");
        assert_eq!(sanitize_file_stem("a/b:c"), "a_b_c");
        assert_eq!(sanitize_file_stem("../x"), "_x");
        assert_eq!(sanitize_file_stem("  "), "未命名");
    }

    #[test]
    fn save_then_read_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = save_lyrics(dir.path(), "夜曲", None, "[00:01.00]第一句\n").unwrap();
        assert_eq!(path.file_name().unwrap(), "夜曲.lrc");
        assert_eq!(read_lyrics(dir.path(), &path).unwrap(), "[00:01.00]第一句\n");
        // 覆盖已有文件，且不留临时文件
        save_lyrics(dir.path(), "夜曲", Some(&path), "新内容").unwrap();
        assert_eq!(read_lyrics(dir.path(), &path).unwrap(), "新内容");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn writes_to_existing_file_name() {
        let dir = tempfile::tempdir().unwrap();
        let existing = dir.path().join("歌  A.lrc");
        fs::write(&existing, "旧").unwrap();
        let path = save_lyrics(dir.path(), "歌 A", Some(&existing), "新").unwrap();
        assert_eq!(path.file_name().unwrap(), "歌  A.lrc");
    }

    #[test]
    fn strips_bom() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.lrc");
        fs::write(&p, "\u{feff}[00:01.00]a").unwrap();
        assert_eq!(read_lyrics(dir.path(), &p).unwrap(), "[00:01.00]a");
    }

    #[test]
    fn rejects_paths_outside_root_or_wrong_type() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("我的歌");
        fs::create_dir(&root).unwrap();
        fs::write(dir.path().join("outside.lrc"), "x").unwrap();
        fs::write(root.join("notes.txt"), "x").unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("deep.lrc"), "x").unwrap();

        assert!(read_lyrics(&root, &dir.path().join("outside.lrc")).is_err());
        assert!(read_lyrics(&root, &root.join("..").join("outside.lrc")).is_err());
        assert!(read_lyrics(&root, &root.join("notes.txt")).is_err());
        assert!(read_lyrics(&root, &root.join("sub").join("deep.lrc")).is_err());
        assert!(save_lyrics(&root, "x", Some(&dir.path().join("outside.lrc")), "y").is_err());
        assert_eq!(fs::read_to_string(dir.path().join("outside.lrc")).unwrap(), "x");
    }
}
