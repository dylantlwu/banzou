//! 老师笔记（PRD 4.12「老师的记性」）：我纠正过老师的事，记下来以后每次都照做。
//!
//! - 通用笔记：配置目录的 `teacher-notes.md`，管所有歌
//! - 这首歌的笔记：歌旁边的 `<歌名>.notes.md`，只管这首歌
//! - 纯文本 Markdown，一行一条，以「- 」开头；行尾的〔…〕是什么时候、从哪记下的。其余的行原样保留
//! - 读音条目写成 `读音：原文 = 读音`，念出来之前按它替换

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::lyrics_store::sanitize_file_stem;

pub const GLOBAL_FILE: &str = "teacher-notes.md";
const SONG_SUFFIX: &str = ".notes.md";

/// 第一次用时通用笔记里就有的一条：我纠正过的第一件事
const SEED: &str = "歌名一律叫原文：原文是日文汉字就照写（夏実 不写成 夏实），不翻译成中文，也不按常见读法猜读音；读音以歌曲自带的标注为准（比如 YouTube 标题里的罗马音）";
const SEED_TAG: &str = "2026-11-13 · 你纠正的";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Global,
    Song,
}

impl Scope {
    /// 发给老师时的编号前缀：G1、S2
    pub fn prefix(self) -> char {
        match self {
            Scope::Global => 'G',
            Scope::Song => 'S',
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub text: String,
    /// 行尾〔…〕里的说明：日期 · 来源
    pub tag: Option<String>,
}

/// 一本笔记：开头的说明文字 + 一条条笔记（Markdown 里其他行放在 header 里原样保留）
#[derive(Debug, Clone, PartialEq)]
struct Book {
    header: Vec<String>,
    notes: Vec<Note>,
}

pub fn global_path(config: &Path) -> PathBuf {
    config.join(GLOBAL_FILE)
}

pub fn song_path(root: &Path, title: &str) -> PathBuf {
    root.join(format!("{}{SONG_SUFFIX}", sanitize_file_stem(title)))
}

fn parse_line(line: &str) -> Option<Note> {
    let rest = line.trim().strip_prefix("- ").or_else(|| line.trim().strip_prefix("* "))?;
    let rest = rest.trim();
    if rest.is_empty() {
        return None;
    }
    if let Some(body) = rest.strip_suffix('〕') {
        if let Some(i) = body.rfind('〔') {
            let text = body[..i].trim();
            if !text.is_empty() {
                return Some(Note { text: text.to_string(), tag: Some(body[i + '〔'.len_utf8()..].trim().to_string()) });
            }
        }
    }
    Some(Note { text: rest.to_string(), tag: None })
}

fn parse(text: &str) -> Book {
    let mut header = Vec::new();
    let mut notes = Vec::new();
    for line in text.lines() {
        match parse_line(line) {
            Some(n) => notes.push(n),
            // 笔记之后的空行不留，写回去时统一排版
            // 空的「- 」行不要
            None if matches!(line.trim(), "-" | "*") => {}
            None if notes.is_empty() => header.push(line.to_string()),
            None if !line.trim().is_empty() => header.push(line.to_string()),
            None => {}
        }
    }
    while header.last().is_some_and(|l| l.trim().is_empty()) {
        header.pop();
    }
    Book { header, notes }
}

/// 笔记里不能换行：一条就是一行
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").replace(['〔', '〕'], "")
}

fn render(book: &Book) -> String {
    let mut out = book.header.join("\n");
    if !out.is_empty() {
        out += "\n\n";
    }
    for n in &book.notes {
        out += &format!("- {}", n.text);
        if let Some(tag) = n.tag.as_deref().filter(|t| !t.is_empty()) {
            out += &format!(" 〔{tag}〕");
        }
        out += "\n";
    }
    out
}

fn default_header(scope: Scope, title: &str) -> Vec<String> {
    let first = match scope {
        Scope::Global => "# 老师笔记（所有歌）".to_string(),
        Scope::Song => format!("# 老师笔记：{title}"),
    };
    vec![
        first,
        String::new(),
        "老师每次上课、回答、开口说话前都会先读这里，这里写的比老师自己知道的优先。".into(),
        "一行一条，以「- 」开头，可以直接改。读音写成：- 读音：原文 = 读音".into(),
    ]
}

fn load_book(path: &Path) -> Book {
    fs::read_to_string(path).map(|t| parse(t.trim_start_matches('\u{feff}'))).unwrap_or(Book { header: Vec::new(), notes: Vec::new() })
}

fn save_book(path: &Path, book: &Book) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("保存老师笔记失败：{e}"))?;
    }
    fs::write(path, render(book)).map_err(|e| format!("保存老师笔记失败：{e}"))
}

/// 通用笔记；还没有这个文件时先写上第一条（种子）
pub fn load_global(config: &Path) -> Vec<Note> {
    let path = global_path(config);
    if !path.exists() {
        let book = Book { header: default_header(Scope::Global, ""), notes: vec![Note { text: SEED.into(), tag: Some(SEED_TAG.into()) }] };
        let _ = save_book(&path, &book);
    }
    load_book(&path).notes
}

pub fn load(path: &Path) -> Vec<Note> {
    load_book(path).notes
}

/// 记一条新的。`replaces` 是要被替换的那条（从 0 数），返回被替换掉的原文
pub fn add(path: &Path, scope: Scope, title: &str, text: &str, tag: &str, replaces: Option<usize>) -> Result<Option<String>, String> {
    let text = one_line(text);
    if text.is_empty() {
        return Err("笔记是空的".into());
    }
    let mut book = load_book(path);
    if book.header.is_empty() && book.notes.is_empty() {
        book.header = default_header(scope, title);
    }
    let note = Note { text, tag: Some(tag.to_string()).filter(|t| !t.is_empty()) };
    match replaces.filter(|&i| i < book.notes.len()) {
        Some(i) => {
            let old = std::mem::replace(&mut book.notes[i], note);
            save_book(path, &book)?;
            Ok(Some(old.text))
        }
        None => {
            // 一模一样的已经有了就不重复记
            if !book.notes.iter().any(|n| n.text == note.text) {
                book.notes.push(note);
                save_book(path, &book)?;
            }
            Ok(None)
        }
    }
}

/// 改第 index 条（从 0 数）；text 为空就删掉
pub fn set(path: &Path, index: usize, text: &str) -> Result<(), String> {
    let mut book = load_book(path);
    if index >= book.notes.len() {
        return Err("这条笔记已经不在了，刷新一下再试".into());
    }
    let text = one_line(text);
    if text.is_empty() {
        book.notes.remove(index);
    } else {
        book.notes[index].text = text;
    }
    save_book(path, &book)
}

/// 撤销刚记下的一条：替换过旧笔记就换回旧的，否则删掉
pub fn undo(path: &Path, text: &str, replaced: Option<&str>) -> Result<(), String> {
    let mut book = load_book(path);
    let text = one_line(text);
    let Some(i) = book.notes.iter().rposition(|n| n.text == text) else {
        return Err("这条笔记已经不在了".into());
    };
    match replaced {
        Some(old) => book.notes[i].text = one_line(old),
        None => {
            book.notes.remove(i);
        }
    }
    save_book(path, &book)
}

/// 一条读音笔记：`读音：夏実 = かじつ（Kajitsu），不是なつみ` → ("夏実", "かじつ（Kajitsu）")。
/// 后面的补充说明（逗号以后）不算读音
pub fn reading_entry(text: &str) -> Option<(String, String)> {
    let rest = text.strip_prefix("读音").or_else(|| text.strip_prefix("讀音"))?;
    let rest = rest.trim_start_matches([':', '：', ' ']);
    let (word, say) = rest.split_once('=').or_else(|| rest.split_once('＝'))?;
    let say = say.split(['，', ',', '；', ';']).next()?.trim();
    let word = word.trim().trim_matches(['《', '》', '「', '」']);
    (!word.is_empty() && !say.is_empty()).then(|| (word.to_string(), say.to_string()))
}

/// 读音条目：`读音：夏実 = かじつ（Kajitsu）` → ("夏実", "かじつ")。括号里的罗马音只给人看，不念
pub fn readings(notes: &[Note]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = notes
        .iter()
        .filter_map(|n| reading_entry(&n.text))
        .filter_map(|(word, say)| {
            let say = say.split(['（', '(']).next()?.trim().to_string();
            (!say.is_empty()).then_some((word, say))
        })
        .collect();
    // 长的先换，免得「夏実」被「夏」抢先
    out.sort_by_key(|(w, _)| std::cmp::Reverse(w.chars().count()));
    out
}

/// 念出来之前按读音条目替换
pub fn apply_readings(text: &str, readings: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (word, say) in readings {
        out = out.replace(word.as_str(), say);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_seeds_once_and_keeps_user_edits() {
        let dir = tempfile::tempdir().unwrap();
        let notes = load_global(dir.path());
        assert_eq!(notes.len(), 1);
        assert!(notes[0].text.contains("原文"));
        // 用户删光了也不再种回来
        set(&global_path(dir.path()), 0, "").unwrap();
        assert!(load_global(dir.path()).is_empty());
    }

    #[test]
    fn add_replace_undo_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = song_path(dir.path(), "夏実");
        assert_eq!(path.file_name().unwrap(), "夏実.notes.md");
        add(&path, Scope::Song, "夏実", "读音：夏実 = なつみ", "对话", None).unwrap();
        add(&path, Scope::Song, "夏実", "第二句 気付いて 的 い 要拖长", "对话", None).unwrap();
        // 同样的不重复记
        add(&path, Scope::Song, "夏実", "第二句 気付いて 的 い 要拖长", "对话", None).unwrap();
        assert_eq!(load(&path).len(), 2);
        let old = add(&path, Scope::Song, "夏実", "读音：夏実 = かじつ（Kajitsu）", "你纠正的", Some(0)).unwrap();
        assert_eq!(old.as_deref(), Some("读音：夏実 = なつみ"));
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("# 老师笔记：夏実"));
        assert!(text.contains("- 读音：夏実 = かじつ（Kajitsu） 〔你纠正的〕\n"));
        undo(&path, "读音：夏実 = かじつ（Kajitsu）", old.as_deref()).unwrap();
        assert_eq!(load(&path)[0].text, "读音：夏実 = なつみ");
        undo(&path, "第二句 気付いて 的 い 要拖长", None).unwrap();
        assert_eq!(load(&path).len(), 1);
    }

    #[test]
    fn hand_edited_files_survive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.notes.md");
        fs::write(&path, "# 我的笔记\n随便写的说明\n\n* 第一条\n-  \n- 第二条〔今天〕\n").unwrap();
        let notes = load(&path);
        assert_eq!(notes, vec![Note { text: "第一条".into(), tag: None }, Note { text: "第二条".into(), tag: Some("今天".into()) }]);
        set(&path, 0, "第一条\n改过").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "# 我的笔记\n随便写的说明\n\n- 第一条 改过\n- 第二条 〔今天〕\n");
        assert!(set(&path, 5, "x").is_err());
    }

    #[test]
    fn readings_replace_longest_first() {
        let notes = vec![
            Note { text: "读音：夏 = なつ".into(), tag: None },
            Note { text: "读音：《夏実》 = かじつ（Kajitsu）".into(), tag: None },
            Note { text: "歌名一律叫原文".into(), tag: None },
        ];
        let r = readings(&notes);
        assert_eq!(r, vec![("夏実".to_string(), "かじつ".to_string()), ("夏".to_string(), "なつ".to_string())]);
        assert_eq!(apply_readings("这首歌叫《夏実》，夏天的夏", &r), "这首歌叫《かじつ》，なつ天的なつ");
    }
}
