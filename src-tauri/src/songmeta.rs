//! 每首歌的资料表 `<歌名键>.song.json`（docs/资料清单.md §6）。
//!
//! - 放在歌旁边（和 `.lrc`、`.notes.md` 一样，文件就是数据）。扫描只认音频 / 视频 / lrc，不会把它当成未归类。
//! - `id` 是稳定编号：建表时取 `tv::song_id(歌名键)`（和以前的编号一样，标签、歌单、常点、电视预览都不用重编），
//!   之后改文件名也不变。没有资料表的歌，编号就是 `song_id(歌名键)`。
//! - 其余字段是开放的（字段登记表在前端 `src/songs/fields.ts`），新功能只要登记字段，不用改这里。
//! - `by` 记每个字段是谁填的：user（锁定，AI 不覆盖）/ ai / scan / tool。
//! - 以前的标签存在配置目录 `tags.json` 的 songs 里。没有资料表的歌照旧从那里读；第一次写这首歌的资料时，
//!   把 tags.json 里的旧值一起带进资料表。tags.json 的 songs 之后不再写（原样留着当备份），歌单还在 tags.json。

use crate::library::{self, Library, Song};
use crate::lyrics_store::sanitize_file_stem;
use crate::tv;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const SUFFIX: &str = ".song.json";
pub const SCHEMA: u64 = 1;
pub const USER: &str = "user";
pub const AI: &str = "ai";
pub const SCAN: &str = "scan";
pub const TOOL: &str = "tool";

/// 以前存在 tags.json 里的字段
pub const TAG_FIELDS: &[&str] = &["artist", "lang", "era", "note", "track"];
/// 资料表自己管的键，不能当普通字段写
const RESERVED: &[&str] = &["schema", "id", "key", "by"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SongMeta {
    #[serde(default)]
    pub schema: u64,
    pub id: String,
    /// 现在对应的文件名键（伴奏 / 人声去掉「 - 伴奏」后的部分），只用来对账
    #[serde(default)]
    pub key: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub by: BTreeMap<String, String>,
    /// title、titleReading、artist、performer、lang、era、note、track、source……
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

impl SongMeta {
    pub fn text(&self, k: &str) -> Option<&str> {
        self.fields.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
    }
    pub fn by_user(&self, k: &str) -> bool {
        self.by.get(k).is_some_and(|b| b == USER)
    }
    /// 显示用的歌名：资料表里的 title，没有就是文件名键
    pub fn shown_title(&self) -> &str {
        self.text("title").unwrap_or(&self.key)
    }
}

pub fn path(root: &Path, key: &str) -> PathBuf {
    root.join(format!("{}{SUFFIX}", sanitize_file_stem(key)))
}

/// 读资料表。没有返回 Ok(None)；有但读不懂返回 Err（不会被覆盖）
pub fn read(root: &Path, key: &str) -> Result<Option<SongMeta>, String> {
    let p = path(root, key);
    let bytes = match fs::read(&p) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读不了资料表：{e}")),
    };
    let mut m: SongMeta = serde_json::from_slice(&bytes).map_err(|e| format!("资料表格式不对（{}）：{e}", p.display()))?;
    if m.id.trim().is_empty() {
        return Err(format!("资料表里没有编号：{}", p.display()));
    }
    if m.key.is_empty() {
        m.key = key.trim().to_string();
    }
    Ok(Some(m))
}

/// 这首歌的稳定编号：资料表里有就用它，没有就是歌名键的编号（和以前一样）
pub fn id_for(root: &Path, key: &str) -> String {
    read(root, key).ok().flatten().map(|m| m.id).unwrap_or_else(|| tv::song_id(key))
}

/// 先写临时文件再改名，写一半崩溃不会坏
fn write(root: &Path, meta: &SongMeta) -> Result<(), String> {
    let target = path(root, &meta.key);
    let tmp = target.with_file_name(format!(".{}.tmp", target.file_name().and_then(|n| n.to_str()).unwrap_or("song.json")));
    let mut m = meta.clone();
    m.schema = SCHEMA;
    let text = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?;
    fs::write(&tmp, text + "\n").map_err(|e| format!("写资料表失败：{e}"))?;
    fs::rename(&tmp, &target).map_err(|e| format!("写资料表失败：{e}"))
}

/// tags.json 里这首歌的旧标签
fn legacy<'a>(tags: &'a Value, id: &str) -> Option<&'a Map<String, Value>> {
    tags.get("songs")?.get(id)?.as_object()
}

/// 没有资料表时，用 tags.json 的旧标签和扫描结果拼一份（不写盘）
pub fn synthesize(key: &str, scanned_artist: Option<&str>, tags: &Value) -> SongMeta {
    let id = tv::song_id(key);
    let mut m = SongMeta { schema: SCHEMA, id: id.clone(), key: key.trim().to_string(), ..Default::default() };
    if let Some(old) = legacy(tags, &id) {
        let manual: Vec<&str> = old.get("manual").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
        for f in TAG_FIELDS {
            if let Some(v) = old.get(*f).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()) {
                m.fields.insert((*f).into(), v.into());
                m.by.insert((*f).into(), if manual.contains(f) { USER } else { AI }.into());
            } else if manual.contains(f) {
                // 用户清空过：记成用户填的，AI 不再补
                m.by.insert((*f).into(), USER.into());
            }
        }
    }
    if m.text("artist").is_none()
        && !m.by_user("artist")
        && let Some(a) = scanned_artist.map(str::trim).filter(|a| !a.is_empty())
    {
        m.fields.insert("artist".into(), a.into());
        m.by.insert("artist".into(), SCAN.into());
    }
    m
}

/// 这首歌现在的资料：有资料表读资料表，没有就拼一份。第二个值：资料表在不在
pub fn view(root: &Path, song: &Song, tags: &Value) -> Result<(SongMeta, bool), String> {
    match read(root, &song.title)? {
        Some(m) => Ok((m, true)),
        None => Ok((synthesize(&song.title, song.artist.as_deref(), tags), false)),
    }
}

/// 检查一个字段能不能写、规整取值。返回 None = 清空
fn clean_value(k: &str, v: &Value) -> Result<Option<Value>, String> {
    if RESERVED.contains(&k) || k.is_empty() || k.len() > 32 || !k.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("不能写这个字段：{k}"));
    }
    match v {
        Value::Null => Ok(None),
        Value::String(s) => {
            let s = s.trim();
            if s.is_empty() {
                return Ok(None);
            }
            if s.chars().count() > 2000 {
                return Err(format!("{k} 太长了"));
            }
            if k == "lang" && !crate::tags::LANGS.contains(&s) {
                return Err(format!("语种只能是 {}", crate::tags::LANGS.join("、")));
            }
            if k == "era" && !crate::tags::ERAS.contains(&s) {
                return Err(format!("年代只能是 {}", crate::tags::ERAS.join("、")));
            }
            Ok(Some(Value::String(s.to_string())))
        }
        Value::Number(_) | Value::Bool(_) => Ok(Some(v.clone())),
        Value::Object(o) => {
            // 例如 source: { url, videoTitle, channel }：只收一层的文字
            let mut out = Map::new();
            for (ik, iv) in o {
                if let Some(s) = iv.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    out.insert(ik.clone(), s.chars().take(500).collect::<String>().into());
                }
            }
            Ok((!out.is_empty()).then_some(Value::Object(out)))
        }
        Value::Array(_) => Err(format!("{k} 的格式不对")),
    }
}

/// 把一组改动套到资料上。by=user 永远生效；其他来源不覆盖用户填的。返回真的改了的字段
pub fn apply(meta: &mut SongMeta, patch: &Map<String, Value>, by: &str) -> Result<Vec<String>, String> {
    let mut changed = Vec::new();
    for (k, v) in patch {
        let v = clean_value(k, v)?;
        if by != USER && meta.by_user(k) {
            continue;
        }
        let before = meta.fields.get(k).cloned();
        match &v {
            Some(v) => {
                meta.fields.insert(k.clone(), v.clone());
            }
            None => {
                meta.fields.remove(k);
            }
        }
        let by_before = meta.by.get(k).cloned();
        if v.is_some() || by == USER {
            meta.by.insert(k.clone(), by.to_string());
        } else {
            meta.by.remove(k);
        }
        if before != meta.fields.get(k).cloned() || by_before != meta.by.get(k).cloned() {
            changed.push(k.clone());
        }
    }
    Ok(changed)
}

/// 写一首歌的资料（没有资料表就先建一份，带上 tags.json 的旧值）。返回写好的资料
pub fn save_fields(root: &Path, song: &Song, tags: &Value, patch: &Map<String, Value>, by: &str) -> Result<SongMeta, String> {
    let (mut meta, exists) = view(root, song, tags)?;
    let changed = apply(&mut meta, patch, by)?;
    if !changed.is_empty() || !exists {
        meta.key = song.title.trim().to_string();
        write(root, &meta)?;
    }
    Ok(meta)
}

pub fn find<'a>(lib: &'a Library, key: &str) -> Result<&'a Song, String> {
    lib.songs.iter().find(|s| s.title == key).ok_or_else(|| format!("曲库里没有「{key}」"))
}

// ---------- 和标签功能接上（tags.json 的形状不变，前端照旧用） ----------

/// 标签窗口用的形状：{ songs: { 编号: { artist, lang, era, note, track, manual } }, playlists }
pub fn tags_view(root: &Path, lib: &Library, tags: &Value) -> Value {
    let mut songs = Map::new();
    for s in &lib.songs {
        let Ok((m, _)) = view(root, s, tags) else { continue };
        let mut o = Map::new();
        for f in TAG_FIELDS {
            if let Some(v) = m.text(f) {
                o.insert((*f).into(), v.into());
            }
        }
        let manual: Vec<Value> = TAG_FIELDS.iter().filter(|f| m.by_user(f)).map(|f| Value::from(*f)).collect();
        o.insert("manual".into(), manual.into());
        songs.insert(m.id.clone(), Value::Object(o));
    }
    json!({ "songs": songs, "playlists": tags.get("playlists").cloned().unwrap_or_else(|| json!([])) })
}

/// 标签窗口保存：每首歌改了的字段写进资料表；歌单写回 tags.json（tags.json 的 songs 原样不动）。
/// 只有「手动改过」的字段才会被清空——前端没带上的字段（比如老版本不认识的 track）不会被删。返回新的 tags.json
pub fn tags_save(root: &Path, lib: &Library, tags: &Value, incoming: &Value) -> Result<Value, String> {
    for s in &lib.songs {
        let (cur, _) = view(root, s, tags)?;
        let Some(inc) = incoming.pointer(&format!("/songs/{}", cur.id)).and_then(Value::as_object) else { continue };
        let manual: Vec<&str> = inc.get("manual").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
        let mut user = Map::new();
        let mut other = Map::new();
        for f in TAG_FIELDS {
            let new = inc.get(*f).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
            let is_manual = manual.contains(f);
            if is_manual {
                if new != cur.text(f) || !cur.by_user(f) {
                    user.insert((*f).into(), new.map(Value::from).unwrap_or(Value::Null));
                }
            } else if let Some(n) = new
                && Some(n) != cur.text(f)
            {
                other.insert((*f).into(), n.into());
            }
        }
        if !user.is_empty() {
            save_fields(root, s, tags, &user, USER)?;
        }
        if !other.is_empty() {
            save_fields(root, s, tags, &other, AI)?;
        }
    }
    let mut out = if tags.is_object() { tags.clone() } else { json!({}) };
    out["playlists"] = incoming.get("playlists").cloned().unwrap_or_else(|| json!([]));
    Ok(out)
}

// ---------- 电视 ----------

/// 曲库里有伴奏的歌 → 电视歌单（编号用稳定编号，歌名用显示名），以及给电视同步用的标签
pub fn catalog_songs(root: &Path, lib: &Library, tags: &Value) -> (Vec<tv::CatalogSong>, Value) {
    let songs = lib
        .songs
        .iter()
        .filter_map(|s| {
            let (m, _) = view(root, s, tags).ok().unwrap_or_else(|| (synthesize(&s.title, s.artist.as_deref(), tags), false));
            Some(tv::CatalogSong {
                title: s.title.clone(),
                artist: s.artist.clone(),
                accompaniment: s.accompaniments.first()?.path.clone(),
                vocal: s.vocals.first().map(|v| v.path.clone()),
                lyrics: s.lyrics.as_ref().map(|l| l.path.clone()),
                videos: s.originals.iter().map(|o| o.path.clone()).collect(),
                id: Some(m.id.clone()),
                name: m.text("title").map(str::to_string),
                reading: m.text("titleReading").map(str::to_string),
            })
        })
        .collect();
    (songs, tags_view(root, lib, tags))
}

// ---------- 建资料表（迁移） ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub key: String,
    pub id: String,
    /// create = 新建资料表；update = 已有资料表，改几个字段；same = 不用动；broken = 资料表读不懂（不碰）
    pub action: String,
    pub file: String,
    /// 会写进去的字段 → (值, 谁填的)
    pub fields: BTreeMap<String, (Value, String)>,
    pub error: Option<String>,
}

/// 预演：每首歌会写什么。`settled` 是用户定好的值：{ 歌名键: { 字段: 值 } }，按 user 写
pub fn migrate_plan(root: &Path, lib: &Library, tags: &Value, settled: &Value) -> Vec<PlanItem> {
    lib.songs
        .iter()
        .map(|s| {
            let file = path(root, &s.title).file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
            let (mut m, exists) = match view(root, s, tags) {
                Ok(v) => v,
                Err(e) => return PlanItem { key: s.title.clone(), id: String::new(), action: "broken".into(), file, fields: BTreeMap::new(), error: Some(e) },
            };
            let mut changed = Vec::new();
            if let Some(p) = settled.get(&s.title).and_then(Value::as_object) {
                match apply(&mut m, p, USER) {
                    Ok(c) => changed = c,
                    Err(e) => return PlanItem { key: s.title.clone(), id: m.id, action: "broken".into(), file, fields: BTreeMap::new(), error: Some(e) },
                }
            }
            let shown: Vec<String> = if exists { changed.clone() } else { m.fields.keys().cloned().chain(m.by.keys().cloned()).collect() };
            let fields = shown.iter().map(|k| (k.clone(), (m.fields.get(k).cloned().unwrap_or(Value::Null), m.by.get(k).cloned().unwrap_or_default()))).collect();
            let action = if !exists { "create" } else if changed.is_empty() { "same" } else { "update" };
            PlanItem { key: s.title.clone(), id: m.id, action: action.into(), file, fields, error: None }
        })
        .collect()
}

/// 照预演写：只新建资料表、改资料表里的字段，不删任何文件。返回写了几个
pub fn migrate_apply(root: &Path, lib: &Library, tags: &Value, settled: &Value) -> Result<usize, String> {
    let mut n = 0;
    for item in migrate_plan(root, lib, tags, settled) {
        if item.action != "create" && item.action != "update" {
            continue;
        }
        let s = find(lib, &item.key)?;
        let patch = settled.get(&s.title).and_then(Value::as_object).cloned().unwrap_or_default();
        save_fields(root, s, tags, &patch, USER)?;
        n += 1;
    }
    Ok(n)
}

// ---------- 改文件名（编号不变） ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenameStep {
    pub from: String,
    pub to: String,
}

fn file_names(root: &Path) -> Vec<String> {
    fs::read_dir(root)
        .map(|rd| rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_file())).filter_map(|e| e.file_name().to_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// 改文件名要动哪些文件：伴奏、人声、歌词、资料表、笔记、课程、录音文件夹；
/// 视频和外部录音按名字挂歌，改完还能挂上就不动，挂不上就在前面加上新歌名
pub fn rename_plan(root: &Path, lib: &Library, key: &str, new_key: &str) -> Result<Vec<RenameStep>, String> {
    let song = find(lib, key)?;
    let new_key = sanitize_file_stem(new_key);
    if new_key == key {
        return Err("新名字和现在一样".into());
    }
    if new_key.contains(['/', '\\']) {
        return Err("名字里不能有斜杠".into());
    }
    if lib.songs.iter().any(|s| s.title != key && library::normalize_title(&s.title) == library::normalize_title(&new_key)) {
        return Err(format!("曲库里已经有「{new_key}」了"));
    }
    let old_stem = sanitize_file_stem(key);
    let mut steps: Vec<RenameStep> = Vec::new();
    let rename_prefix = |name: &str| name.strip_prefix(old_stem.as_str()).map(|rest| format!("{new_key}{rest}"));
    for f in song.accompaniments.iter().chain(&song.vocals).chain(song.lyrics.iter()) {
        let to = rename_prefix(&f.file_name).ok_or_else(|| format!("「{}」的文件名不是以歌名开头，没法一起改", f.file_name))?;
        steps.push(RenameStep { from: f.file_name.clone(), to });
    }
    for suffix in [SUFFIX, ".notes.md", ".lesson.json"] {
        let from = format!("{old_stem}{suffix}");
        if root.join(&from).is_file() {
            steps.push(RenameStep { from, to: format!("{new_key}{suffix}") });
        }
    }
    // 模拟改完以后再扫一遍：视频、外部录音还挂不挂得上
    let mut names = file_names(root);
    for st in &steps {
        if let Some(n) = names.iter_mut().find(|n| **n == st.from) {
            n.clone_from(&st.to);
        }
    }
    let after = library::build_library(root, &names);
    let moved = after.songs.iter().find(|s| s.title == new_key);
    for f in song.originals.iter().chain(&song.external_recordings) {
        let still = moved.is_some_and(|m| m.originals.iter().chain(&m.external_recordings).any(|o| o.file_name == f.file_name));
        if !still {
            steps.push(RenameStep { from: f.file_name.clone(), to: format!("{new_key} - {}", f.file_name) });
        }
    }
    let rec = |k: &str| format!("{}/{}", crate::recording::RECORDINGS_DIR, sanitize_file_stem(k));
    if root.join(rec(key)).is_dir() {
        steps.push(RenameStep { from: rec(key), to: rec(&new_key) });
    }
    for st in &steps {
        if root.join(&st.to).exists() {
            return Err(format!("「{}」已经存在，先处理掉它再改", st.to));
        }
    }
    Ok(steps)
}

/// 改文件名：先确保有资料表（编号跟着走），再一个个改；中途失败就把已经改的改回去
pub fn rename_apply(root: &Path, lib: &Library, tags: &Value, key: &str, new_key: &str) -> Result<String, String> {
    let steps = rename_plan(root, lib, key, new_key)?;
    let song = find(lib, key)?;
    // 先写资料表（带上编号和旧标签），这样改名后编号不变
    let had_sheet = path(root, key).is_file();
    let meta = save_fields(root, song, tags, &Map::new(), USER)?;
    let mut steps = steps;
    if !had_sheet {
        let file = path(root, key).file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        let to = path(root, &sanitize_file_stem(new_key)).file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        steps.insert(0, RenameStep { from: file, to });
    }
    let mut done: Vec<&RenameStep> = Vec::new();
    for st in &steps {
        if let Err(e) = fs::rename(root.join(&st.from), root.join(&st.to)) {
            for d in done.iter().rev() {
                let _ = fs::rename(root.join(&d.to), root.join(&d.from));
            }
            if !had_sheet {
                let _ = fs::remove_file(path(root, key));
            }
            return Err(format!("改「{}」失败，已经全部改回去了：{e}", st.from));
        }
        done.push(st);
    }
    let new_key = sanitize_file_stem(new_key);
    let mut meta = meta;
    meta.key.clone_from(&new_key);
    write(root, &meta)?;
    Ok(new_key)
}

// ---------- 资料检查 ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRow {
    pub key: String,
    pub song_id: String,
    /// ok / none / broken
    pub sheet: String,
    pub sheet_error: Option<String>,
    pub meta: SongMeta,
    /// 歌词里有带时间的句子
    pub lyrics_timed: bool,
    /// 电视预览（本机缓存）：video = 带 MV 的小视频，audio = 只有声音，None = 还没做
    pub tv_preview: Option<String>,
    /// 上次同步给电视的歌单里有没有这首、内容是不是旧的
    pub tv_synced: bool,
    pub tv_stale: bool,
}

/// `tv_cache`：电视工作目录（里面有 previews/ 和 previews/catalog.json）
pub fn check(root: &Path, lib: &Library, tags: &Value, tv_cache: &Path) -> Vec<CheckRow> {
    let previews: Vec<String> = fs::read_dir(tv_cache.join("previews"))
        .map(|rd| rd.flatten().filter_map(|e| e.file_name().to_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let catalog: Value = fs::read(tv_cache.join("previews/catalog.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
    let entries: Vec<&Value> = catalog.get("songs").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
    lib.songs
        .iter()
        .map(|s| {
            let (meta, sheet, err) = match view(root, s, tags) {
                Ok((m, true)) => (m, "ok", None),
                Ok((m, false)) => (m, "none", None),
                Err(e) => (synthesize(&s.title, s.artist.as_deref(), tags), "broken", Some(e)),
            };
            let lyrics_timed = s.lyrics.as_ref().and_then(|l| fs::read_to_string(&l.path).ok()).is_some_and(|t| !tv::lrc_lines(&t).is_empty());
            let prefix = format!("{}-", meta.id);
            let pv = previews.iter().filter(|f| f.starts_with(&prefix) && !f.contains(".part")).collect::<Vec<_>>();
            let tv_preview = if pv.iter().any(|f| f.ends_with(".mp4")) {
                Some("video".to_string())
            } else if pv.iter().any(|f| f.ends_with(".m4a")) {
                Some("audio".to_string())
            } else {
                None
            };
            let entry = entries.iter().find(|e| e.get("id").and_then(Value::as_str) == Some(meta.id.as_str()));
            let artist = meta.text("artist").map(str::to_string).or_else(|| s.artist.clone());
            let tv_stale = entry.is_some_and(|e| {
                let get = |k: &str| e.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
                get("title").as_deref() != Some(meta.shown_title()) || get("artist") != artist || get("lang").as_deref() != meta.text("lang") || get("era").as_deref() != meta.text("era")
            });
            CheckRow { key: s.title.clone(), song_id: meta.id.clone(), sheet: sheet.into(), sheet_error: err, meta, lyrics_timed, tv_preview, tv_synced: entry.is_some(), tv_stale }
        })
        .collect()
}

// ---------- AI 补齐（背景、原曲名、歌手 / 语种 / 年代，顺手搜歌词） ----------

/// AI 查到的、准备写进一首歌资料表的值（预演给用户看，确认后原样写入，不再重新问 AI）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiProposal {
    pub key: String,
    pub id: String,
    /// 要写的字段（只含现在空着的，retag 时也含 AI 填过的；用户填的永远不在里面）
    pub patch: Map<String, Value>,
    /// 写的时候顺手去 LRCLIB 搜歌词（这首没有歌词，且有原曲名）
    pub search_lyrics: bool,
}

/// 第一步：联网查，只返回打算写什么，不写盘。`keys` 为空 = 曲库里还缺资料的、有伴奏的歌；retag = 已有的也重查（用户填的不动）
pub fn ai_propose(
    config: &Path,
    root: &Path,
    tags: &Value,
    keys: Option<&[String]>,
    retag: bool,
    hints: Option<&std::collections::HashMap<String, String>>,
) -> Result<Vec<AiProposal>, String> {
    let lib = library::scan_dir(root).map_err(|e| format!("扫描曲库失败：{e}"))?;
    let mut ask = Vec::new();
    let mut examples = Vec::new();
    let mut metas: BTreeMap<String, (SongMeta, bool)> = BTreeMap::new();
    for s in lib.songs.iter().filter(|s| keys.map_or(!s.accompaniments.is_empty(), |k| k.contains(&s.title))) {
        let (m, _) = view(root, s, tags)?;
        if TAG_FIELDS.iter().any(|f| m.by_user(f)) && examples.len() < 20 {
            examples.push(crate::tags::Example {
                title: m.shown_title().to_string(),
                artist: m.text("artist").map(str::to_string),
                lang: m.text("lang").map(str::to_string),
                era: m.text("era").map(str::to_string),
            });
        }
        let complete = TAG_FIELDS.iter().all(|f| m.text(f).is_some() || m.by_user(f));
        if !retag && complete {
            continue;
        }
        let lyrics = s.lyrics.as_ref().and_then(|l| fs::read_to_string(&l.path).ok()).map(|t| crate::tags::lyrics_snippet(&t, 6));
        let mut hint: Vec<String> = Vec::new();
        if let Some(h) = hints.and_then(|h| h.get(&s.title)) {
            hint.push(h.clone());
        }
        if let Some(src) = m.fields.get("source").and_then(Value::as_object) {
            hint.extend(["videoTitle", "channel"].iter().filter_map(|k| src.get(*k).and_then(Value::as_str).map(str::to_string)));
        }
        // 视频文件名里常有原唱、原曲名（YouTube 标题）
        hint.extend(s.originals.iter().take(2).map(|o| format!("视频：{}", o.file_name)));
        if m.shown_title() != s.title {
            hint.push(format!("文件名：{}", s.title));
        }
        if let Some(r) = m.text("titleReading") {
            hint.push(format!("歌名读音：{r}"));
        }
        if let Some(p) = m.text("performer") {
            hint.push(format!("演唱者（不是歌手）：{p}"));
        }
        ask.push(crate::tags::AskSong {
            id: m.id.clone(),
            title: m.shown_title().to_string(),
            artist: m.text("artist").map(str::to_string).or_else(|| s.artist.clone()),
            lyrics,
            hint: (!hint.is_empty()).then(|| hint.join(" · ")),
        });
        metas.insert(m.id.clone(), (m, s.lyrics.is_some()));
    }
    if ask.is_empty() {
        return Ok(Vec::new());
    }
    let guesses = crate::tags::guess_all(config, &ask, &examples, |_, _| {})?;
    let mut out = Vec::new();
    for g in &guesses {
        let Some((cur, has_lyrics)) = metas.get(&g.id) else { continue };
        let mut patch = Map::new();
        for (k, v) in [("artist", &g.artist), ("lang", &g.lang), ("era", &g.era), ("note", &g.note), ("track", &g.track)] {
            if let Some(v) = v
                && !cur.by_user(k)
                && (cur.text(k).is_none() || (retag && cur.text(k) != Some(v.as_str())))
            {
                patch.insert(k.into(), v.clone().into());
            }
        }
        let track = patch.get("track").and_then(Value::as_str).or(cur.text("track"));
        out.push(AiProposal { key: cur.key.clone(), id: g.id.clone(), search_lyrics: !has_lyrics && track.is_some(), patch });
    }
    Ok(out)
}

/// 第二步：把预演原样写进资料表（by = ai，用户填的不覆盖），需要的顺手搜歌词。返回 { songs: 写了几首, lyrics: 找到几首歌词 }
pub fn ai_apply(root: &Path, tags: &Value, proposals: &[AiProposal], duration: impl Fn(&Path) -> Option<f64>) -> Result<Value, String> {
    let lib = library::scan_dir(root).map_err(|e| format!("扫描曲库失败：{e}"))?;
    let (mut written, mut lyrics_found) = (0, 0);
    for p in proposals {
        let s = find(&lib, &p.key)?;
        let m = save_fields(root, s, tags, &p.patch, AI)?;
        if m.id != p.id {
            return Err(format!("「{}」的编号对不上，没有写", p.key));
        }
        written += 1;
        if !p.search_lyrics || s.lyrics.is_some() {
            continue;
        }
        let (Some(track), artist) = (m.text("track"), m.text("artist").unwrap_or_default()) else { continue };
        let dur = s.accompaniments.first().and_then(|a| duration(Path::new(&a.path)));
        if let Ok(Some(lrc)) = crate::tags::fetch_lrc(artist, track, dur) {
            let lrc = if m.text("lang") == Some("国语") { fast2s::convert(&lrc) } else { lrc };
            if crate::lyrics_store::save_lyrics(root, &s.title, None, &lrc).is_ok() {
                lyrics_found += 1;
            }
        }
    }
    Ok(json!({ "songs": written, "lyrics": lyrics_found }))
}

/// 查完直接写（应用里的「AI 查」按钮）。返回 { songs: 查了几首, lyrics: 找到几首歌词 }
pub fn ai_fill(
    config: &Path,
    root: &Path,
    tags: &Value,
    keys: Option<&[String]>,
    retag: bool,
    hints: Option<&std::collections::HashMap<String, String>>,
    duration: impl Fn(&Path) -> Option<f64>,
) -> Result<Value, String> {
    let proposals = ai_propose(config, root, tags, keys, retag, hints)?;
    ai_apply(root, tags, &proposals, duration)
}

// ---------- 命令（应用和测试桥共用） ----------

/// 应用和测试桥共用的命令入口。不认识的命令返回 None。
/// `config`：配置目录（tags.json 在这里）；`tv_cache`：电视工作目录
pub fn command(root: &Path, config: &Path, tv_cache: &Path, cmd: &str, args: &Value) -> Option<Result<Value, String>> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
    let tags = || crate::settings::load_store(config, "tags").unwrap_or(Value::Null);
    let scan = || library::scan_dir(root).map_err(|e| format!("扫描曲库失败：{e}"));
    let r = match cmd {
        "tags_load" => scan().map(|lib| tags_view(root, &lib, &tags())),
        "tags_save" => (|| {
            let lib = scan()?;
            let out = tags_save(root, &lib, &tags(), args.get("value").unwrap_or(&Value::Null))?;
            crate::settings::save_store(config, "tags", &out).map_err(|e| format!("保存歌单失败：{e}"))?;
            Ok(Value::Null)
        })(),
        "song_view" => (|| {
            let lib = scan()?;
            let (m, exists) = view(root, find(&lib, &s("key").ok_or("缺少 key")?)?, &tags())?;
            Ok(json!({ "meta": m, "exists": exists }))
        })(),
        "songs_check" =>scan().map(|lib| serde_json::to_value(check(root, &lib, &tags(), tv_cache)).unwrap_or_default()),
        "song_meta_save" => (|| {
            let lib = scan()?;
            let key = s("key").ok_or("缺少 key")?;
            let patch = args.get("patch").and_then(Value::as_object).cloned().unwrap_or_default();
            let m = save_fields(root, find(&lib, &key)?, &tags(), &patch, USER)?;
            Ok(serde_json::to_value(m).unwrap_or_default())
        })(),
        "song_rename_plan" => (|| {
            let lib = scan()?;
            Ok(serde_json::to_value(rename_plan(root, &lib, &s("key").ok_or("缺少 key")?, &s("newKey").ok_or("缺少 newKey")?)?).unwrap_or_default())
        })(),
        "song_rename" => (|| {
            let lib = scan()?;
            rename_apply(root, &lib, &tags(), &s("key").ok_or("缺少 key")?, &s("newKey").ok_or("缺少 newKey")?).map(Value::from)
        })(),
        "songs_migrate_plan" => scan().map(|lib| serde_json::to_value(migrate_plan(root, &lib, &tags(), &Value::Null)).unwrap_or_default()),
        "songs_migrate" => scan().and_then(|lib| migrate_apply(root, &lib, &tags(), &Value::Null)).map(Value::from),
        _ => return None,
    };
    Some(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib_with(dir: &Path, files: &[&str]) -> Library {
        for f in files {
            fs::write(dir.join(f), b"x").unwrap();
        }
        library::scan_dir(dir).unwrap()
    }

    fn old_tags() -> Value {
        json!({
            "songs": { tv::song_id("月光 张三"): { "artist": "张三", "lang": "国语", "era": "10s", "track": "月光", "manual": ["era"] } },
            "playlists": [{ "id": "p1", "name": "常唱", "songs": [tv::song_id("月光 张三")] }]
        })
    }

    #[test]
    fn view_without_sheet_comes_from_old_tags() {
        let d = tempfile::tempdir().unwrap();
        let lib = lib_with(d.path(), &["月光 张三 - 伴奏.wav"]);
        let (m, exists) = view(d.path(), &lib.songs[0], &old_tags()).unwrap();
        assert!(!exists);
        assert_eq!(m.id, tv::song_id("月光 张三"));
        assert_eq!(m.text("track"), Some("月光"));
        assert!(m.by_user("era"));
        assert_eq!(m.by.get("artist").map(String::as_str), Some(AI));
        assert_eq!(m.shown_title(), "月光 张三");
    }

    #[test]
    fn user_values_are_locked_against_ai() {
        let mut m = SongMeta { id: "x".into(), key: "k".into(), ..Default::default() };
        let p = |k: &str, v: &str| Map::from_iter([(k.to_string(), Value::from(v))]);
        apply(&mut m, &p("artist", "甲"), USER).unwrap();
        assert!(apply(&mut m, &p("artist", "乙"), AI).unwrap().is_empty());
        assert_eq!(m.text("artist"), Some("甲"));
        // 用户清空也锁定
        apply(&mut m, &p("artist", ""), USER).unwrap();
        assert_eq!(m.text("artist"), None);
        assert!(m.by_user("artist"));
        assert!(apply(&mut m, &p("artist", "乙"), AI).unwrap().is_empty());
        assert!(apply(&mut m, &p("lang", "火星语"), USER).is_err());
        assert!(apply(&mut m, &p("id", "y"), USER).is_err());
    }

    #[test]
    fn tags_save_writes_sheet_and_keeps_fields_the_ui_forgot() {
        let d = tempfile::tempdir().unwrap();
        let lib = lib_with(d.path(), &["月光 张三 - 伴奏.wav", "别的歌 - 伴奏.wav"]);
        let tags = old_tags();
        let id = tv::song_id("月光 张三");
        // 前端（老版本）没带 track，只手动改了歌手
        let incoming = json!({ "songs": { id.clone(): { "artist": "张三三", "lang": "国语", "era": "10s", "manual": ["era", "artist"] } }, "playlists": [] });
        let out = tags_save(d.path(), &lib, &tags, &incoming).unwrap();
        let m = read(d.path(), "月光 张三").unwrap().unwrap();
        assert_eq!(m.text("artist"), Some("张三三"));
        assert!(m.by_user("artist"));
        assert_eq!(m.text("track"), Some("月光"));
        assert_eq!(m.id, id);
        // 没改的歌不建资料表；tags.json 的 songs 原样留着，歌单换成新的
        assert!(!path(d.path(), "别的歌").exists());
        assert_eq!(out["songs"], tags["songs"]);
        assert_eq!(out["playlists"], json!([]));
        // 再读一遍标签：从资料表来
        let v = tags_view(d.path(), &lib, &out);
        assert_eq!(v["songs"][&id]["artist"], "张三三");
        assert_eq!(v["songs"][&id]["track"], "月光");
    }

    #[test]
    fn rename_keeps_id_and_moves_everything() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        let lib = lib_with(root, &["月光 张三 - 伴奏.wav", "月光 张三 - 人声.wav", "月光 张三.lrc", "月光 张三.notes.md", "[MV] 月光 张三 官方.mp4", "月光 张三 - 原曲.m4a"]);
        fs::create_dir_all(root.join("录音/月光 张三")).unwrap();
        fs::write(root.join("录音/月光 张三/take-01.wav"), b"x").unwrap();
        let plan = rename_plan(root, &lib, "月光 张三", "月光").unwrap();
        assert!(plan.contains(&RenameStep { from: "月光 张三 - 伴奏.wav".into(), to: "月光 - 伴奏.wav".into() }));
        assert!(plan.contains(&RenameStep { from: "录音/月光 张三".into(), to: "录音/月光".into() }));
        // 视频改完还挂得上（「月光」在视频名里），不动
        assert!(!plan.iter().any(|s| s.from.ends_with(".mp4")));
        let new_key = rename_apply(root, &lib, &old_tags(), "月光 张三", "月光").unwrap();
        assert_eq!(new_key, "月光");
        let after = library::scan_dir(root).unwrap();
        let s = find(&after, "月光").unwrap();
        assert_eq!((s.accompaniments.len(), s.vocals.len(), s.lyrics.is_some(), s.originals.len()), (1, 1, true, 1));
        let m = read(root, "月光").unwrap().unwrap();
        assert_eq!(m.id, tv::song_id("月光 张三"));
        assert_eq!(m.key, "月光");
        assert_eq!(m.text("artist"), Some("张三"));
        assert!(root.join("月光.notes.md").is_file());
        assert!(root.join("录音/月光/take-01.wav").is_file());
        assert!(!path(root, "月光 张三").exists());
        assert_eq!(id_for(root, "月光"), tv::song_id("月光 张三"));
    }

    #[test]
    fn tv_catalog_uses_stable_id_and_display_name() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        let lib = lib_with(root, &["ABC - 伴奏.wav"]);
        let p = Map::from_iter([("title".to_string(), Value::from("夏天")), ("titleReading".to_string(), Value::from("なつ (Natsu)"))]);
        save_fields(root, &lib.songs[0], &Value::Null, &p, USER).unwrap();
        rename_apply(root, &lib, &Value::Null, "ABC", "夏天").unwrap();
        let after = library::scan_dir(root).unwrap();
        assert_eq!(after.songs[0].song_id, tv::song_id("ABC"));
        let (songs, tags) = catalog_songs(root, &after, &json!({ "playlists": [{ "id": "p", "name": "x", "songs": [tv::song_id("ABC")] }] }));
        assert_eq!(songs[0].stable_id(), tv::song_id("ABC"));
        assert_eq!(songs[0].shown(), "夏天");
        assert_eq!(songs[0].reading.as_deref(), Some("なつ (Natsu)"));
        assert_eq!(tags["playlists"][0]["songs"][0], tv::song_id("ABC"));
    }

    #[test]
    fn ai_apply_writes_as_ai_and_never_over_user() {
        let d = tempfile::tempdir().unwrap();
        let lib = lib_with(d.path(), &["甲 - 伴奏.wav"]);
        save_fields(d.path(), &lib.songs[0], &Value::Null, &Map::from_iter([("artist".to_string(), Value::from("我填的"))]), USER).unwrap();
        let p = AiProposal {
            key: "甲".into(),
            id: tv::song_id("甲"),
            patch: Map::from_iter([("artist".to_string(), Value::from("AI 猜的")), ("note".to_string(), Value::from("背景"))]),
            search_lyrics: false,
        };
        assert_eq!(ai_apply(d.path(), &Value::Null, &[p], |_| None).unwrap()["songs"], 1);
        let m = read(d.path(), "甲").unwrap().unwrap();
        assert_eq!(m.text("artist"), Some("我填的"));
        assert_eq!(m.text("note"), Some("背景"));
        assert_eq!(m.by.get("note").map(String::as_str), Some(AI));
    }

    #[test]
    fn rename_refuses_clashes() {
        let d = tempfile::tempdir().unwrap();
        let lib = lib_with(d.path(), &["甲 - 伴奏.wav", "乙 - 伴奏.wav"]);
        assert!(rename_plan(d.path(), &lib, "甲", "乙").is_err());
        assert!(rename_plan(d.path(), &lib, "甲", "甲").is_err());
    }

    #[test]
    fn video_that_would_detach_gets_new_name_prefix() {
        let d = tempfile::tempdir().unwrap();
        let lib = lib_with(d.path(), &["ABC - 伴奏.wav", "ABC live.mp4"]);
        let plan = rename_plan(d.path(), &lib, "ABC", "夏天").unwrap();
        assert!(plan.contains(&RenameStep { from: "ABC live.mp4".into(), to: "夏天 - ABC live.mp4".into() }));
    }

    #[test]
    fn migrate_plan_then_apply_only_creates_files() {
        let d = tempfile::tempdir().unwrap();
        let lib = lib_with(d.path(), &["月光 张三 - 伴奏.wav", "别的歌 - 伴奏.wav"]);
        let settled = json!({ "别的歌": { "title": "另一首歌", "artist": "李四" } });
        let plan = migrate_plan(d.path(), &lib, &old_tags(), &settled);
        assert!(plan.iter().all(|p| p.action == "create"));
        assert_eq!(plan.iter().find(|p| p.key == "别的歌").unwrap().fields["title"], (Value::from("另一首歌"), USER.to_string()));
        assert_eq!(migrate_apply(d.path(), &lib, &old_tags(), &settled).unwrap(), 2);
        let again = migrate_plan(d.path(), &lib, &old_tags(), &settled);
        assert!(again.iter().all(|p| p.action == "same"));
        assert_eq!(read(d.path(), "别的歌").unwrap().unwrap().shown_title(), "另一首歌");
    }

    #[test]
    fn broken_sheet_is_reported_not_overwritten() {
        let d = tempfile::tempdir().unwrap();
        let lib = lib_with(d.path(), &["甲 - 伴奏.wav"]);
        fs::write(path(d.path(), "甲"), b"{oops").unwrap();
        let rows = check(d.path(), &lib, &Value::Null, &d.path().join("tv"));
        assert_eq!(rows[0].sheet, "broken");
        assert!(save_fields(d.path(), &lib.songs[0], &Value::Null, &Map::new(), USER).is_err());
        assert_eq!(fs::read(path(d.path(), "甲")).unwrap(), b"{oops");
    }

    #[test]
    fn sheet_file_is_not_unassigned() {
        let d = tempfile::tempdir().unwrap();
        let lib = lib_with(d.path(), &["甲 - 伴奏.wav", "甲.song.json"]);
        assert!(lib.unassigned.is_empty());
    }
}
