//! 问老师（PRD 4.12）：Claude 当老师回答问题；我纠正它时它调用 remember 记进老师笔记，
//! 以后每次调用都把笔记放进系统提示（缓存前缀）；念出来之前按笔记里的读音替换。
//!
//! - 对话按歌存在 `<曲库>/录音/<歌名>/teacher-chat.json`
//! - 系统提示每轮开头拼一次：守则 → 通用笔记 → 这首歌（名字、自带标注、歌词）和它的笔记。
//!   一轮里不变（工具调用前后要一致）；下一轮笔记改了就带上新的
//! - 存历史时去掉 thinking 块（只留文字、工具调用和结果），这样系统提示换了也不影响旧对话
//! - 只发文字：问题、歌词、文件名、笔记

use base64::Engine;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use super::notes::{self, Note, Scope};
use crate::{ai, library, recording, settings, songmeta};

const CHAT_FILE: &str = "teacher-chat.json";
const TTS_CACHE: &str = "tts-cache";
/// 一轮里最多来回几次（老师记笔记 → 拿到结果 → 接着说）
const MAX_STEPS: usize = 4;
const MAX_LYRICS_CHARS: usize = 6000;
pub const DEFAULT_LANGUAGE: &str = "中文";

#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remembered {
    pub scope: Scope,
    pub text: String,
    /// 替换掉的旧笔记（撤销时换回来）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced: Option<String>,
    /// 旧笔记原来在哪本（通常和 scope 一样）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced_scope: Option<Scope>,
}

/// 界面上的一条对话
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    /// "me" 或 "teacher"
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remembered: Vec<Remembered>,
}

#[derive(Debug, Default, Serialize, serde::Deserialize)]
struct ChatFile {
    /// 发给 API 的历史（不含 thinking 块）
    #[serde(default)]
    messages: Vec<Value>,
    #[serde(default)]
    turns: Vec<Turn>,
}

fn chat_path(root: &Path, title: &str) -> PathBuf {
    recording::song_dir(root, title).join(CHAT_FILE)
}

fn load_chat_file(root: &Path, title: &str) -> ChatFile {
    fs::read(chat_path(root, title)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_chat_file(root: &Path, title: &str, chat: &ChatFile) -> Result<(), String> {
    let path = chat_path(root, title);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| format!("保存对话失败：{e}"))?;
    fs::write(&path, serde_json::to_vec_pretty(chat).unwrap()).map_err(|e| format!("保存对话失败：{e}"))
}

pub fn load_chat(root: &Path, title: &str) -> Vec<Turn> {
    load_chat_file(root, title).turns
}

pub fn clear_chat(root: &Path, title: &str) -> Result<(), String> {
    let path = chat_path(root, title);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("清空对话失败：{e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------- 这首歌

/// 发给老师的歌曲信息：曲库里的名字、原唱、歌曲自带的标注（原视频文件名）、歌词
#[derive(Debug, Default, Clone, PartialEq)]
pub struct SongInfo {
    /// 文件名里的歌名键
    pub title: String,
    /// 资料表里的显示名（老师称呼歌名用它）；没有资料表就是 None
    pub shown_title: Option<String>,
    /// 资料表里的歌名读音（用户确认的，以它为准）
    pub title_reading: Option<String>,
    /// 资料表里的语种
    pub lang: Option<String>,
    pub artist: Option<String>,
    pub annotations: Vec<String>,
    pub lyrics: Option<String>,
}

/// LRC 去掉时间和标签，只留歌词文字
pub fn lyrics_text(lrc: &str) -> String {
    let mut out = Vec::new();
    for line in lrc.lines() {
        let mut rest = line.trim();
        let mut tagged = false;
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(end) = stripped.find(']') else { break };
            rest = stripped[end + 1..].trim_start();
            tagged = true;
        }
        // [ar:...] 这类标签行整行都在括号里，剩下的是空的
        if !rest.is_empty() || !tagged {
            out.push(rest.to_string());
        }
    }
    let text = out.join("\n").trim().to_string();
    if text.chars().count() > MAX_LYRICS_CHARS { text.chars().take(MAX_LYRICS_CHARS).collect::<String>() + "\n……" } else { text }
}

pub fn song_info(root: &Path, title: &str) -> SongInfo {
    let mut info = SongInfo { title: title.to_string(), ..Default::default() };
    let Ok(lib) = library::scan_dir(root) else { return info };
    let key = library::normalize_title(title);
    let Some(song) = lib.songs.into_iter().find(|s| library::normalize_title(&s.title) == key) else { return info };
    if let Some(m) = &song.meta {
        info.shown_title = Some(m.shown_title().to_string()).filter(|t| !t.trim().is_empty());
        info.title_reading = m.text("titleReading").map(str::to_string);
        info.lang = m.text("lang").map(str::to_string);
        info.artist = m.text("artist").map(str::to_string);
    }
    info.artist = info.artist.or(song.artist);
    info.annotations = song
        .originals
        .iter()
        .map(|f| f.file_name.rsplit_once('.').map(|(stem, _)| stem.to_string()).unwrap_or_else(|| f.file_name.clone()))
        .collect();
    info.lyrics = song.lyrics.and_then(|l| fs::read_to_string(&l.path).ok()).map(|t| lyrics_text(&t)).filter(|t| !t.is_empty());
    info
}

// ---------------------------------------------------------------- 系统提示

fn rules(language: &str) -> String {
    format!(
        "你是「波点」应用里的唱歌老师，教我用{language}学唱外语歌。

怎么回答：
- 用{language}回答，口语、简短，一般一到三句话；我问得细再展开。你的话会被念出来，不要用 Markdown 标题、列表符号、表格、表情。
- 讲到歌词里的外语词时写原文，需要时在后面括号注读音。
- 歌名、人名、地名这类专有名词的读音，以这首歌自带的标注为准（原视频文件名里的罗马音、歌词注音）；没有标注又拿不准时，说「读音待确认」并问我，不要按常见读法猜。

老师笔记：
- 下面「老师笔记」里是我纠正过你、或者让你记住的事。它们比你自己知道的优先，每次回答都照做，不用提起笔记本身。
- 我纠正你、或者明确让你记住什么时，调用 remember 工具记下来：只管这首歌的记 song，对所有歌都成立的记 global。和已有某条笔记矛盾或重复时，用 replaces 填那条的编号（如 S2），新的替换旧的。记完用一句话确认就行。
- 读音条目写成「读音：原文 = 读音（罗马音）」，比如「读音：夏実 = かじつ（Kajitsu）」。应用会在念出来之前按它替换，所以原文要和歌名、歌词里写的一模一样。
- 我只是在问问题、没有纠正你时，不要调用 remember。"
    )
}

fn notes_block(heading: &str, scope: Scope, notes: &[Note]) -> String {
    let mut out = format!("## {heading}\n");
    if notes.is_empty() {
        out += "（还没有）\n";
    }
    for (i, n) in notes.iter().enumerate() {
        out += &format!("{}{}. {}\n", scope.prefix(), i + 1, n.text);
    }
    out
}

fn song_block(song: &SongInfo, song_notes: &[Note]) -> String {
    let mut out = String::from("## 正在学的歌\n");
    match song.shown_title.as_deref().filter(|t| *t != song.title) {
        Some(t) => out += &format!("歌名：{t}（我在资料表里确认过；文件名里叫 {}）\n", song.title),
        None => out += &format!("曲库里的名字：{}（这是我存文件时起的名字，不一定是真正的歌名）\n", song.title),
    }
    if let Some(r) = &song.title_reading {
        out += &format!("歌名读音：{r}（我确认过的，以这个为准）\n");
    }
    if let Some(l) = &song.lang {
        out += &format!("语种：{l}\n");
    }
    if let Some(a) = &song.artist {
        out += &format!("原唱：{a}\n");
    }
    if song.annotations.is_empty() {
        out += "歌曲自带的标注：没有\n";
    } else {
        out += "歌曲自带的标注（原视频的文件名，通常就是 YouTube 标题）：\n";
        for a in &song.annotations {
            out += &format!("- {a}\n");
        }
    }
    match &song.lyrics {
        Some(l) => out += &format!("歌词：\n{l}\n"),
        None => out += "歌词：还没有\n",
    }
    out += "\n";
    out + &notes_block("老师笔记（这首歌）", Scope::Song, song_notes)
}

/// 系统提示：守则、通用笔记、这首歌三段，最后一段打缓存标记（前面两段一起缓存）
pub fn system_blocks(language: &str, global: &[Note], song: &SongInfo, song_notes: &[Note]) -> Value {
    json!([
        { "type": "text", "text": rules(language) },
        { "type": "text", "text": notes_block("老师笔记（所有歌）", Scope::Global, global) },
        { "type": "text", "text": song_block(song, song_notes), "cache_control": { "type": "ephemeral" } },
    ])
}

fn remember_tool() -> Value {
    json!({
        "name": "remember",
        "description": "把我纠正你的事、或者我明确让你记住的事记进老师笔记。以后备课、回答、念出来都会照着做。我只是提问时不要调用。",
        "strict": true,
        "input_schema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["scope", "note", "replaces"],
            "properties": {
                "scope": { "type": "string", "enum": ["global", "song"], "description": "global：对所有歌都成立；song：只管正在学的这首歌" },
                "note": { "type": "string", "description": "一句话写清楚以后该怎么做。读音写成「读音：原文 = 读音（罗马音）」" },
                "replaces": { "type": "string", "description": "和已有笔记矛盾或重复时，填那条的编号（如 G1、S2），新的替换旧的；没有就填空字符串" }
            }
        }
    })
}

// ---------------------------------------------------------------- 问老师

/// 今天的日期（本地时区，笔记行尾用）
fn today() -> String {
    let out = std::process::Command::new("/bin/date").arg("+%Y-%m-%d").output().ok();
    out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| s.len() == 10).unwrap_or_default()
}

fn note_path(config: &Path, root: &Path, title: &str, scope: Scope) -> PathBuf {
    match scope {
        Scope::Global => notes::global_path(config),
        Scope::Song => notes::song_path(root, title),
    }
}

/// 「S2」→（这首歌，下标 1）
fn parse_ref(s: &str) -> Option<(Scope, usize)> {
    let s = s.trim();
    let scope = match s.chars().next()?.to_ascii_uppercase() {
        'G' => Scope::Global,
        'S' => Scope::Song,
        _ => return None,
    };
    let n: usize = s[1..].trim().parse().ok()?;
    n.checked_sub(1).map(|i| (scope, i))
}

/// 执行老师的 remember：记进笔记，返回给老师看的结果和界面上的卡片
fn remember(config: &Path, root: &Path, title: &str, input: &Value) -> Result<(String, Remembered), String> {
    let scope = match input.get("scope").and_then(Value::as_str) {
        Some("global") => Scope::Global,
        _ => Scope::Song,
    };
    let text = input.get("note").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err("笔记是空的".into());
    }
    let tag = format!("{} · 对话里记下", today()).trim_start_matches(" · ").to_string();
    let target = note_path(config, root, title, scope);
    let old_ref = input.get("replaces").and_then(Value::as_str).and_then(parse_ref);
    let (replaced, replaced_scope) = match old_ref {
        Some((s, i)) if s == scope => (notes::add(&target, scope, title, &text, &tag, Some(i))?, Some(s)),
        Some((s, i)) => {
            // 从一本挪到另一本：旧的删掉，新的记进来
            let other = note_path(config, root, title, s);
            let old = notes::load(&other).get(i).map(|n| n.text.clone());
            if old.is_some() {
                notes::set(&other, i, "")?;
            }
            notes::add(&target, scope, title, &text, &tag, None)?;
            (old, Some(s))
        }
        None => (notes::add(&target, scope, title, &text, &tag, None)?, None),
    };
    // 记的是这首歌歌名的读音：同时写进资料表
    if scope == Scope::Song {
        if let Some((word, say)) = notes::reading_entry(&text) {
            sync_title_reading(config, root, title, &word, &say)?;
        }
    }
    let saved = notes::load(&target);
    let n = saved.iter().position(|x| x.text == text.split_whitespace().collect::<Vec<_>>().join(" ")).map(|i| i + 1).unwrap_or(saved.len());
    let result = match &replaced {
        Some(old) => format!("已记下（{}{n}），替换了旧的：{old}", scope.prefix()),
        None => format!("已记下（{}{n}）", scope.prefix()),
    };
    let replaced_scope = replaced.as_ref().and(replaced_scope);
    Ok((result, Remembered { scope, text, replaced, replaced_scope }))
}

/// 存历史只留文字、工具调用和工具结果（thinking 块和服务端兜底的标记都不留）
fn keep_for_history(content: &[Value]) -> Vec<Value> {
    content
        .iter()
        .filter(|b| matches!(b.get("type").and_then(Value::as_str), Some("text" | "tool_use" | "tool_result")))
        .cloned()
        .collect()
}

/// 问老师一句。老师可能先记笔记再回答；返回老师这一轮说的话和记下的笔记
pub fn ask(config: &Path, root: &Path, title: &str, question: &str, language: &str) -> Result<Turn, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("问题是空的".into());
    }
    let mut chat = load_chat_file(root, title);
    let song = song_info(root, title);
    let system = system_blocks(language, &notes::load_global(config), &song, &notes::load(&notes::song_path(root, title)));
    let tools = json!([remember_tool()]);

    let user = json!({ "role": "user", "content": [{ "type": "text", "text": question }] });
    // 这一轮发给 API 的（含 thinking 块，工具调用前后要原样带回）和要存下来的
    let mut live: Vec<Value> = chat.messages.clone();
    live.push(user.clone());
    let mut keep: Vec<Value> = vec![user];
    let mut texts: Vec<String> = Vec::new();
    let mut remembered: Vec<Remembered> = Vec::new();

    for _ in 0..MAX_STEPS {
        let body = json!({
            "model": ai::CLAUDE_MODEL,
            "max_tokens": 4000,
            "output_config": { "effort": "low" },
            "cache_control": { "type": "ephemeral" },
            "system": system,
            "tools": tools,
            "messages": live,
        });
        let reply = match ai::claude_post(config, &body, 90) {
            Ok(r) => r,
            // 已经记下笔记了就先把这些存起来，别丢
            Err(e) if !remembered.is_empty() => {
                texts.push(format!("（老师没说完：{e}）"));
                break;
            }
            Err(e) => return Err(e),
        };
        let stop = reply.get("stop_reason").and_then(Value::as_str).unwrap_or("");
        if stop == "refusal" {
            if remembered.is_empty() {
                return Err("老师这次没有回答，换个说法再问".into());
            }
            break;
        }
        let content: Vec<Value> = reply.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
        for b in &content {
            if b.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(t) = b.get("text").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) {
                    texts.push(t.to_string());
                }
            }
        }
        live.push(json!({ "role": "assistant", "content": content }));
        let kept = keep_for_history(&content);
        if !kept.is_empty() {
            keep.push(json!({ "role": "assistant", "content": kept }));
        }
        let calls: Vec<&Value> = content.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use")).collect();
        if stop != "tool_use" || calls.is_empty() {
            break;
        }
        let mut results = Vec::new();
        for call in calls {
            let id = call.get("id").and_then(Value::as_str).unwrap_or("");
            let (text, is_error) = if call.get("name").and_then(Value::as_str) == Some("remember") {
                match remember(config, root, title, call.get("input").unwrap_or(&Value::Null)) {
                    Ok((text, r)) => {
                        remembered.push(r);
                        (text, false)
                    }
                    Err(e) => (format!("没记下：{e}"), true),
                }
            } else {
                ("没有这个工具".to_string(), true)
            };
            results.push(json!({ "type": "tool_result", "tool_use_id": id, "content": text, "is_error": is_error }));
        }
        let msg = json!({ "role": "user", "content": results });
        live.push(msg.clone());
        keep.push(msg);
    }

    // 停在工具调用上（来回次数用完）：补一个空结果之前不能存，免得下次请求格式不对
    if keep.last().and_then(|m| m.get("role")).and_then(Value::as_str) == Some("user") && keep.len() > 1 {
        keep.push(json!({ "role": "assistant", "content": [{ "type": "text", "text": "好的，记下了。" }] }));
    }
    if keep.iter().filter(|m| m.get("role").and_then(Value::as_str) == Some("assistant")).count() == 0 {
        keep.push(json!({ "role": "assistant", "content": [{ "type": "text", "text": "……" }] }));
    }

    let text = if texts.is_empty() && !remembered.is_empty() { "好的，记下了。".to_string() } else { texts.join("\n\n") };
    let turn = Turn { role: "teacher".into(), text, remembered };
    chat.messages.extend(keep);
    chat.turns.push(Turn { role: "me".into(), text: question.to_string(), remembered: Vec::new() });
    chat.turns.push(turn.clone());
    save_chat_file(root, title, &chat)?;
    Ok(turn)
}

/// 撤销老师刚记下的一条
/// 笔记里记的是这首歌歌名的读音：同步写进资料表的 titleReading（读音以资料表为准）。
/// `reading` 为空 = 删掉。返回有没有写
fn sync_title_reading(config: &Path, root: &Path, title: &str, word: &str, reading: &str) -> Result<bool, String> {
    let lib = library::scan_dir(root).map_err(|e| format!("扫描曲库失败：{e}"))?;
    let Ok(song) = songmeta::find(&lib, title) else { return Ok(false) };
    let shown = song.meta.as_ref().map(|m| m.shown_title().to_string()).unwrap_or_else(|| song.title.clone());
    let same = |a: &str| library::normalize_title(a) == library::normalize_title(word);
    if !same(&shown) && !same(&song.title) {
        return Ok(false);
    }
    let tags = settings::load_store(config, "tags").unwrap_or(Value::Null);
    let patch = serde_json::Map::from_iter([("titleReading".to_string(), Value::from(reading))]);
    songmeta::save_fields(root, song, &tags, &patch, songmeta::USER)?;
    Ok(true)
}

pub fn undo_remember(config: &Path, root: &Path, title: &str, r: &Remembered) -> Result<(), String> {
    // 撤销的是歌名读音：资料表也换回旧的（没有旧的就删掉）
    if let Some((word, _)) = notes::reading_entry(&r.text) {
        let old = r.replaced.as_deref().and_then(notes::reading_entry).filter(|(w, _)| *w == word).map(|(_, say)| say);
        sync_title_reading(config, root, title, &word, old.as_deref().unwrap_or(""))?;
    }
    let path = note_path(config, root, title, r.scope);
    match (&r.replaced, r.replaced_scope) {
        (Some(old), Some(s)) if s != r.scope => {
            notes::undo(&path, &r.text, None)?;
            notes::add(&note_path(config, root, title, s), s, title, old, "", None).map(|_| ())
        }
        (old, _) => notes::undo(&path, &r.text, old.as_deref()),
    }
}

// ---------------------------------------------------------------- 念出来

/// 念之前：去掉 Markdown 符号和换行
fn clean_for_speech(text: &str) -> String {
    let t = text.replace(['*', '#', '`', '_'], "");
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 实际发给豆包的文字：按两本笔记里的读音条目替换（这首歌的优先）
pub fn speech_text(config: &Path, root: &Path, title: Option<&str>, text: &str) -> String {
    let mut all = Vec::new();
    if let Some(t) = title {
        // 资料表里的歌名读音最优先（用户确认的规则：读音以资料表为准）
        if let Ok(Some(m)) = songmeta::read(root, t) {
            if let Some(r) = m.text("titleReading") {
                all.push(Note { text: format!("读音：{} = {r}", m.shown_title()), tag: None });
            }
        }
        all.extend(notes::load(&notes::song_path(root, t)));
    }
    all.extend(notes::load_global(config));
    clean_for_speech(&notes::apply_readings(text, &notes::readings(&all)))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spoken {
    /// mp3 的 base64
    pub audio: String,
    /// 实际念的文字（读音替换之后）
    pub said: String,
    pub cached: bool,
    pub ms: u64,
}

/// 用豆包念老师的话；同一句话、同一个音色只合成一次（缓存在配置目录）
pub fn speak(config: &Path, root: &Path, title: Option<&str>, text: &str) -> Result<Spoken, String> {
    let started = Instant::now();
    let said = speech_text(config, root, title, text);
    if said.is_empty() {
        return Err("没有要念的话".into());
    }
    let hash = Sha256::digest(format!("{}\n{said}", ai::voice_key(config)).as_bytes());
    let name: String = hash.iter().take(16).map(|b| format!("{b:02x}")).collect();
    let cache = config.join(TTS_CACHE).join(format!("{name}.mp3"));
    let (mp3, cached) = match fs::read(&cache) {
        Ok(b) if !b.is_empty() => (b, true),
        _ => {
            let b = ai::speak(config, &said)?;
            let _ = fs::create_dir_all(cache.parent().unwrap());
            let _ = fs::write(&cache, &b);
            (b, false)
        }
    };
    Ok(Spoken { audio: base64::engine::general_purpose::STANDARD.encode(&mp3), said, cached, ms: started.elapsed().as_millis() as u64 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lyrics_without_timestamps() {
        let lrc = "[ar:AKASAKI]\n[00:01.00]夏の実\n[00:02.00][00:30.00]気付いて\n\n[00:03.00]";
        assert_eq!(lyrics_text(lrc), "夏の実\n気付いて");
    }

    #[test]
    fn system_prompt_carries_both_notebooks_and_annotations() {
        let song = SongInfo { title: "AKASAKI".into(), annotations: vec!["【AKASAKI】夏実 ⧸ Kajitsu（Lyric Video）".into()], ..Default::default() };
        let global = vec![Note { text: "歌名一律叫原文".into(), tag: None }];
        let local = vec![Note { text: "读音：夏実 = かじつ（Kajitsu）".into(), tag: None }];
        let sys = system_blocks("中文", &global, &song, &local);
        let blocks = sys.as_array().unwrap();
        assert_eq!(blocks.len(), 3);
        assert!(blocks[1]["text"].as_str().unwrap().contains("G1. 歌名一律叫原文"));
        let last = blocks[2]["text"].as_str().unwrap();
        assert!(last.contains("夏実 ⧸ Kajitsu") && last.contains("S1. 读音：夏実 = かじつ"));
        assert!(blocks[2].get("cache_control").is_some() && blocks[0].get("cache_control").is_none());
        // 守则不随歌变：前缀稳定才能缓存
        let other = system_blocks("中文", &[], &SongInfo::default(), &[]);
        assert_eq!(other[0], blocks[0]);
    }

    #[test]
    fn remember_writes_replaces_and_undoes() {
        let config = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let (c, r) = (config.path(), root.path());
        let (msg, rem) = remember(c, r, "AKASAKI", &json!({ "scope": "song", "note": "读音：夏実 = なつみ", "replaces": "" })).unwrap();
        assert!(msg.contains("S1"));
        assert_eq!(rem.replaced, None);
        let (msg, rem) = remember(c, r, "AKASAKI", &json!({ "scope": "song", "note": "读音：夏実 = かじつ（Kajitsu）", "replaces": "S1" })).unwrap();
        assert!(msg.contains("替换了旧的：读音：夏実 = なつみ"));
        assert_eq!(notes::load(&notes::song_path(r, "AKASAKI")).len(), 1);
        assert_eq!(speech_text(c, r, Some("AKASAKI"), "这首歌叫《夏実》。"), "这首歌叫《かじつ》。");
        undo_remember(c, r, "AKASAKI", &rem).unwrap();
        assert_eq!(notes::load(&notes::song_path(r, "AKASAKI"))[0].text, "读音：夏実 = なつみ");
        // 从这首歌挪到通用
        let (_, rem) = remember(c, r, "AKASAKI", &json!({ "scope": "global", "note": "日文汉字不改成简体", "replaces": "S1" })).unwrap();
        assert_eq!(rem.replaced_scope, Some(Scope::Song));
        assert!(notes::load(&notes::song_path(r, "AKASAKI")).is_empty());
        undo_remember(c, r, "AKASAKI", &rem).unwrap();
        assert_eq!(notes::load(&notes::song_path(r, "AKASAKI")).len(), 1);
        assert!(!notes::load_global(c).iter().any(|n| n.text == "日文汉字不改成简体"));
    }

    #[test]
    fn title_reading_syncs_to_song_sheet() {
        let config = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let (c, r) = (config.path(), root.path());
        fs::write(r.join("夏実 - 伴奏.wav"), b"").unwrap();
        let read = || songmeta::read(r, "夏実").unwrap().and_then(|m| m.text("titleReading").map(str::to_string));
        // 不是歌名的读音不碰资料表
        remember(c, r, "夏実", &json!({ "scope": "song", "note": "读音：気付いて = きづいて", "replaces": "" })).unwrap();
        assert_eq!(read(), None);
        let (_, rem) = remember(c, r, "夏実", &json!({ "scope": "song", "note": "读音：夏実 = かじつ（Kajitsu），不是なつみ", "replaces": "" })).unwrap();
        assert_eq!(read().as_deref(), Some("かじつ（Kajitsu）"));
        let m = songmeta::read(r, "夏実").unwrap().unwrap();
        assert!(m.by_user("titleReading"));
        // 歌名信息进系统提示；念的时候按资料表换
        let info = song_info(r, "夏実");
        assert!(song_block(&info, &[]).contains("歌名读音：かじつ（Kajitsu）"));
        assert_eq!(speech_text(c, r, Some("夏実"), "《夏実》"), "《かじつ》");
        undo_remember(c, r, "夏実", &rem).unwrap();
        assert_eq!(read(), None);
    }

    #[test]
    fn history_drops_thinking() {
        let content = vec![json!({ "type": "thinking", "thinking": "", "signature": "x" }), json!({ "type": "text", "text": "好" }), json!({ "type": "tool_use", "id": "t", "name": "remember", "input": {} })];
        let kept = keep_for_history(&content);
        assert_eq!(kept.len(), 2);
        assert_eq!(parse_ref("S2"), Some((Scope::Song, 1)));
        assert_eq!(parse_ref("g1"), Some((Scope::Global, 0)));
        assert_eq!(parse_ref(""), None);
        assert_eq!(parse_ref("S0"), None);
    }
}
