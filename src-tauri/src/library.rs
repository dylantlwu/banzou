//! 曲库扫描与文件配对（PRD 5.2）
//!
//! 规则：
//! - `<歌名> - 伴奏.<音频>` → 伴奏；`<歌名> - 人声.<音频>` → 引导人声
//! - `<歌名>.lrc` → 歌词
//! - 视频文件按模糊匹配挂到歌曲上作为原曲参考，并从「（原唱：xx）」提取原唱
//! - 其余文件进入「未归类」

use serde::Serialize;
use std::collections::BTreeMap;
use std::io;
use std::path::Path;

const AUDIO_EXTS: &[&str] = &["wav", "aiff", "aif", "flac", "m4a", "aac", "mp3", "ogg"];
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "m4v", "mkv"];
const ACCOMPANIMENT_WORDS: &[&str] = &["伴奏"];
const VOCAL_WORDS: &[&str] = &["人声", "人聲"];
const SEPARATORS: &[char] = &[' ', '\u{3000}', '-', '_', '－', '—', '–', '·'];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    Accompaniment,
    Vocal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileRole {
    Track { kind: TrackKind, title: String },
    Lyrics { title: String },
    Video,
    OtherAudio,
    Ignored,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub path: String,
    pub file_name: String,
    pub format: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    /// 规范化后的歌名，作为配对键和 ID
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    /// 按格式优先级排序（wav 优先），第一个是默认使用的
    pub accompaniments: Vec<MediaFile>,
    pub vocals: Vec<MediaFile>,
    pub lyrics: Option<MediaFile>,
    pub originals: Vec<MediaFile>,
    /// 应用外录的音频（如 iPhone 同时录下人声和外放伴奏的 m4a）
    pub external_recordings: Vec<MediaFile>,
    /// 稳定编号（资料表里的 id；没有资料表就是 tv::song_id(歌名)），扫描文件夹时填
    pub song_id: String,
    /// 资料表 `<歌名>.song.json` 的内容（没有或读不懂是 None）
    pub meta: Option<crate::songmeta::SongMeta>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub root: String,
    pub songs: Vec<Song>,
    pub unassigned: Vec<MediaFile>,
}

fn split_ext(file_name: &str) -> (&str, String) {
    match file_name.rfind('.') {
        Some(i) if i > 0 => (&file_name[..i], file_name[i + 1..].to_lowercase()),
        _ => (file_name, String::new()),
    }
}

/// 歌名规范化：全角空格转半角、合并空白、ASCII 小写
pub fn normalize_title(s: &str) -> String {
    s.split(|c: char| c.is_whitespace() || c == '\u{3000}')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// 去掉结尾的「伴奏 / 人声」标记，支持 ` - 伴奏`、`_伴奏`、`（伴奏）`、`(伴奏)` 等写法
fn strip_track_marker(stem: &str) -> Option<(TrackKind, String)> {
    let s = stem.trim();
    let candidates = ACCOMPANIMENT_WORDS
        .iter()
        .map(|w| (TrackKind::Accompaniment, *w))
        .chain(VOCAL_WORDS.iter().map(|w| (TrackKind::Vocal, *w)));

    for (kind, word) in candidates {
        let mut rest: Option<&str> = None;
        for (open, close) in [("（", "）"), ("(", ")"), ("[", "]"), ("【", "】")] {
            let wrapped = format!("{open}{word}{close}");
            if let Some(r) = s.strip_suffix(wrapped.as_str()) {
                rest = Some(r);
                break;
            }
        }
        let rest = rest.or_else(|| s.strip_suffix(word));
        if let Some(r) = rest {
            let title = r.trim_end_matches(SEPARATORS).trim();
            if !title.is_empty() {
                return Some((kind, title.to_string()));
            }
        }
    }
    None
}

pub fn classify(file_name: &str) -> FileRole {
    if file_name.starts_with('.') {
        return FileRole::Ignored;
    }
    let (stem, ext) = split_ext(file_name);
    if ext == "lrc" {
        return FileRole::Lyrics { title: stem.trim().to_string() };
    }
    if VIDEO_EXTS.contains(&ext.as_str()) {
        return FileRole::Video;
    }
    if AUDIO_EXTS.contains(&ext.as_str()) {
        return match strip_track_marker(stem) {
            Some((kind, title)) => FileRole::Track { kind, title },
            None => FileRole::OtherAudio,
        };
    }
    FileRole::Ignored
}

fn format_rank(format: &str) -> usize {
    AUDIO_EXTS.iter().position(|e| *e == format).unwrap_or(usize::MAX)
}

/// 删除成对括号及其内容，例如 `[🪷]`、`（原唱：张三）`、`(兼容版)`
fn remove_bracketed(s: &str, pairs: &[(char, char)]) -> String {
    let mut out = String::new();
    let mut depth: Vec<char> = Vec::new();
    for c in s.chars() {
        if let Some(&(_, close)) = pairs.iter().find(|(o, _)| *o == c) {
            depth.push(close);
            continue;
        }
        if depth.last() == Some(&c) {
            depth.pop();
            out.push(' ');
            continue;
        }
        if depth.is_empty() {
            out.push(c);
        }
    }
    out
}

/// 用于原曲模糊匹配的宽松键
pub fn fuzzy_key(s: &str) -> String {
    let s = remove_bracketed(s, &[('[', ']'), ('【', '】'), ('（', '）'), ('(', ')')]);
    let s: String = s
        .chars()
        .map(|c| if "《》〈〉「」『』.。·・_-—–－,，!！".contains(c) { ' ' } else { c })
        .collect();
    normalize_title(&s)
}

/// 从「（原唱：张三）」「(原唱:xx)」提取原唱名
pub fn extract_artist(s: &str) -> Option<String> {
    let idx = s.find("原唱")?;
    let rest = s[idx + "原唱".len()..].trim_start();
    // 必须有冒号，避免「没有原唱信息」这类误判
    let rest = rest.strip_prefix(':').or_else(|| rest.strip_prefix('：'))?.trim_start();
    let end = rest.find(['）', ')', ']', '】']).unwrap_or(rest.len());
    let name = rest[..end].trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// 逐词匹配用的键：繁体转简体、小写，括号和标点都当空格（括号里的内容保留，
/// YouTube 标题常把歌名放在【】里）
fn word_key(s: &str) -> String {
    let s: String = fast2s::convert(s)
        .chars()
        .map(|c| if "[]【】（）()《》〈〉「」『』.。·・_-—–－,，!！&|/:：".contains(c) { ' ' } else { c })
        .collect();
    normalize_title(&s)
}

/// 歌名里的每个词都出现在文件名里：中文词按子串找，英文词要整词出现
/// （「寂寞先生 曹格」配「曹格 Gary Chaw【寂寞先生】Official Music Video」）
fn all_words_in(song_key: &str, file_key: &str) -> bool {
    let file_words: Vec<&str> = file_key.split(' ').collect();
    let words: Vec<&str> = song_key.split(' ').filter(|w| !w.is_empty()).collect();
    !words.is_empty()
        && words.iter().all(|w| {
            if w.is_ascii() { file_words.contains(w) } else { file_key.contains(w) }
        })
}

/// 按模糊歌名找最匹配的歌曲：一方包含另一方，或歌名每个词都在文件名里，都算匹配；
/// 取歌名最长的，避免「月光 Lo-fi」的视频误配到「月光」
fn best_song_match(songs: &BTreeMap<String, Song>, stem: &str) -> Option<String> {
    let key = fuzzy_key(stem);
    let words = word_key(stem);
    if key.chars().count() < 2 && words.chars().count() < 2 {
        return None;
    }
    songs
        .values()
        .filter_map(|s| {
            let skey = fuzzy_key(&s.title);
            let contains = !skey.is_empty() && key.chars().count() >= 2 && (key.contains(skey.as_str()) || skey.contains(key.as_str()));
            let swords = word_key(&s.title);
            (contains || all_words_in(&swords, &words)).then(|| (s.id.clone(), swords.chars().count()))
        })
        .max_by_key(|(_, len)| *len)
        .map(|(id, _)| id)
}

/// 纯函数：根据文件名列表构建曲库，便于测试
pub fn build_library(root: &Path, file_names: &[String]) -> Library {
    let mut songs: BTreeMap<String, Song> = BTreeMap::new();
    let mut lyrics: Vec<(String, MediaFile)> = Vec::new();
    let mut videos: Vec<MediaFile> = Vec::new();
    let mut other_audio: Vec<MediaFile> = Vec::new();
    let mut unassigned: Vec<MediaFile> = Vec::new();

    for name in file_names {
        let (_, format) = split_ext(name);
        let file = MediaFile {
            path: root.join(name).to_string_lossy().into_owned(),
            file_name: name.clone(),
            format,
        };
        match classify(name) {
            FileRole::Track { kind, title } => {
                let id = normalize_title(&title);
                let song = songs.entry(id.clone()).or_insert_with(|| Song {
                    id,
                    title: title.clone(),
                    artist: None,
                    accompaniments: vec![],
                    vocals: vec![],
                    lyrics: None,
                    originals: vec![],
                    external_recordings: vec![],
                    song_id: String::new(),
                    meta: None,
                });
                match kind {
                    TrackKind::Accompaniment => song.accompaniments.push(file),
                    TrackKind::Vocal => song.vocals.push(file),
                }
            }
            FileRole::Lyrics { title } => lyrics.push((normalize_title(&title), file)),
            FileRole::Video => videos.push(file),
            FileRole::OtherAudio => other_audio.push(file),
            FileRole::Ignored => {}
        }
    }

    for (id, file) in lyrics {
        match songs.get_mut(&id) {
            Some(song) => song.lyrics = Some(file),
            None => unassigned.push(file),
        }
    }

    // 原曲视频
    for video in videos {
        let (stem, _) = split_ext(&video.file_name);
        match best_song_match(&songs, stem) {
            Some(id) => {
                let song = songs.get_mut(&id).expect("song exists");
                if song.artist.is_none() {
                    song.artist = extract_artist(stem);
                }
                song.originals.push(video);
            }
            None => unassigned.push(video),
        }
    }

    // 没有伴奏/人声标记的音频：按歌名挂为外部录音（如 `月光.m4a`）
    for audio in other_audio {
        let (stem, _) = split_ext(&audio.file_name);
        match best_song_match(&songs, stem) {
            Some(id) => songs.get_mut(&id).expect("song exists").external_recordings.push(audio),
            None => unassigned.push(audio),
        }
    }

    let mut songs: Vec<Song> = songs.into_values().collect();
    for song in &mut songs {
        song.accompaniments.sort_by_key(|f| format_rank(&f.format));
        song.vocals.sort_by_key(|f| format_rank(&f.format));
        song.originals.sort_by_key(|f| f.file_name.chars().count());
    }
    songs.sort_by(|a, b| a.title.cmp(&b.title));
    unassigned.sort_by(|a, b| a.file_name.cmp(&b.file_name));

    Library {
        root: root.to_string_lossy().into_owned(),
        songs,
        unassigned,
    }
}

/// 扫描目录（只看第一层，不进子文件夹）
pub fn scan_dir(root: &Path) -> io::Result<Library> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            if let Some(name) = entry.file_name().to_str() {
                names.push(name.to_string());
            }
        }
    }
    let mut lib = build_library(root, &names);
    for song in &mut lib.songs {
        song.meta = crate::songmeta::read(root, &song.title).ok().flatten();
        song.song_id = song.meta.as_ref().map(|m| m.id.clone()).unwrap_or_else(|| crate::tv::song_id(&song.title));
    }
    Ok(lib)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个典型素材文件夹里的文件名（虚构的歌）
    fn real_files() -> Vec<String> {
        [
            ".DS_Store",
            "[🪷] 月光 Lo-fi Remix （原唱：张三）.mp4",
            "[🪷] 月光 Lo-fi Remix （原唱：张三）（兼容版）.mp4",
            "[🪷] 海边的风 Acoustic Remix （原唱：Lumi）.mp4",
            "《燈塔與鯨》.阿木  《灯塔与鲸》.阿木.mp4",
            "月光 Lo-fi Remix - 人声.wav",
            "月光 Lo-fi Remix - 伴奏.mp3",
            "月光 Lo-fi Remix - 伴奏.wav",
            "月光.m4a",
            "海边的风 Acoustic Remix - 人声.wav",
            "海边的风 Acoustic Remix - 伴奏.mp3",
            "海边的风 Acoustic Remix - 伴奏.wav",
            "灯塔与鲸 阿木 - 人声.wav",
            "灯塔与鲸 阿木 - 伴奏.mp3",
            "灯塔与鲸 阿木 - 伴奏.wav",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    fn song<'a>(lib: &'a Library, title: &str) -> &'a Song {
        lib.songs.iter().find(|s| s.title == title).unwrap_or_else(|| panic!("缺少歌曲 {title}"))
    }

    #[test]
    fn classifies_track_markers() {
        assert_eq!(
            classify("月光 Lo-fi Remix - 伴奏.wav"),
            FileRole::Track { kind: TrackKind::Accompaniment, title: "月光 Lo-fi Remix".into() }
        );
        assert_eq!(
            classify("灯塔与鲸 阿木 - 人声.wav"),
            FileRole::Track { kind: TrackKind::Vocal, title: "灯塔与鲸 阿木".into() }
        );
        for name in ["歌_伴奏.mp3", "歌（伴奏）.mp3", "歌(伴奏).flac", "歌伴奏.m4a", "歌 －伴奏.wav"] {
            assert_eq!(
                classify(name),
                FileRole::Track { kind: TrackKind::Accompaniment, title: "歌".into() },
                "{name}"
            );
        }
        assert_eq!(classify("歌 - 人聲.WAV"), FileRole::Track { kind: TrackKind::Vocal, title: "歌".into() });
    }

    #[test]
    fn classifies_other_files() {
        assert_eq!(classify("月光.m4a"), FileRole::OtherAudio);
        assert_eq!(classify("伴奏.mp3"), FileRole::OtherAudio, "只有标记没有歌名");
        assert_eq!(classify("月光.lrc"), FileRole::Lyrics { title: "月光".into() });
        assert_eq!(classify("x.MP4"), FileRole::Video);
        assert_eq!(classify(".DS_Store"), FileRole::Ignored);
        assert_eq!(classify("notes.txt"), FileRole::Ignored);
    }

    #[test]
    fn extracts_artist() {
        assert_eq!(extract_artist("[🪷] 月光 Lo-fi Remix （原唱：张三）（兼容版）").as_deref(), Some("张三"));
        assert_eq!(extract_artist("x (原唱:Lumi)").as_deref(), Some("Lumi"));
        assert_eq!(extract_artist("没有原唱信息"), None);
        assert_eq!(extract_artist("（原唱：）"), None);
    }

    #[test]
    fn fuzzy_key_strips_decorations() {
        assert_eq!(fuzzy_key("[🪷] 月光 Lo-fi Remix （原唱：张三）"), "月光 lo fi remix");
        assert_eq!(fuzzy_key("《燈塔與鯨》.阿木  《灯塔与鲸》.阿木"), "燈塔與鯨 阿木 灯塔与鲸 阿木");
    }

    #[test]
    fn builds_library_from_real_folder() {
        let lib = build_library(Path::new("/Users/me/songs"), &real_files());
        assert_eq!(lib.songs.len(), 3);

        let moon = song(&lib, "月光 Lo-fi Remix");
        assert_eq!(moon.artist.as_deref(), Some("张三"));
        assert_eq!(moon.accompaniments.iter().map(|f| f.format.as_str()).collect::<Vec<_>>(), ["wav", "mp3"]);
        assert_eq!(moon.vocals.len(), 1);
        assert_eq!(moon.originals.len(), 2);
        assert!(!moon.originals[0].file_name.contains("兼容版"), "非兼容版排前面");
        assert_eq!(moon.accompaniments[0].path, "/Users/me/songs/月光 Lo-fi Remix - 伴奏.wav");

        let sea = song(&lib, "海边的风 Acoustic Remix");
        assert_eq!(sea.artist.as_deref(), Some("Lumi"));
        assert_eq!(sea.originals.len(), 1);

        let whale = song(&lib, "灯塔与鲸 阿木");
        assert_eq!(whale.artist, None);
        assert_eq!(whale.originals.len(), 1, "简繁混写的视频也能配上");
        assert_eq!(whale.accompaniments[0].format, "wav");

        let recordings: Vec<_> = moon.external_recordings.iter().map(|f| f.file_name.as_str()).collect();
        assert_eq!(recordings, ["月光.m4a"], "iPhone 外录的混录挂到月光上");
        assert!(sea.external_recordings.is_empty());
        assert!(lib.unassigned.is_empty());
    }

    #[test]
    fn unmatched_audio_stays_unassigned() {
        let files: Vec<String> = ["夜曲 - 伴奏.wav", "随手哼的.m4a", "a.m4a"].iter().map(|s| s.to_string()).collect();
        let lib = build_library(Path::new("/x"), &files);
        assert!(lib.songs[0].external_recordings.is_empty());
        assert_eq!(lib.unassigned.len(), 2, "单字歌名太短不做模糊匹配");
    }

    #[test]
    fn attaches_lyrics_and_keeps_orphans() {
        let files: Vec<String> = ["歌 A - 伴奏.mp3", "歌  A.lrc", "没有伴奏的歌.lrc"].iter().map(|s| s.to_string()).collect();
        let lib = build_library(Path::new("/x"), &files);
        assert_eq!(lib.songs.len(), 1);
        assert_eq!(lib.songs[0].lyrics.as_ref().map(|f| f.file_name.as_str()), Some("歌  A.lrc"));
        assert_eq!(lib.unassigned.len(), 1);
    }

    #[test]
    fn video_prefers_longest_title_match() {
        let files: Vec<String> = ["月光 - 伴奏.wav", "月光 Lo-fi - 伴奏.wav", "月光 Lo-fi （原唱：张三）.mp4"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let lib = build_library(Path::new("/x"), &files);
        assert_eq!(song(&lib, "月光 Lo-fi").originals.len(), 1);
        assert_eq!(song(&lib, "月光").originals.len(), 0);
    }

    #[test]
    fn youtube_titles_match_song_words() {
        let files: Vec<String> = [
            "寂寞先生 曹格 - 伴奏.wav",
            "几分之几 卢广仲 - 伴奏.wav",
            "刻在我心底的名字 卢广仲 - 伴奏.wav",
            "太阳与地球 卢广仲 - 伴奏.wav",
            "Lose Control Teddy Swims - 伴奏.wav",
            "The Door Teddy Swims - 伴奏.wav",
            "曹格 Gary Chaw【寂寞先生】Official Music Video.mp4",
            "盧廣仲 Crowd Lu 【刻在我心底的名字 Your Name Engraved Herein】 Official Music Video  （刻在你心底的名字電影主題曲）.mp4",
            "盧廣仲 Crowd Lu 【幾分之幾 You Complete Me】 Official Music Video （花甲大人轉男孩電影主題曲）.mp4",
            "盧廣仲 Crowd Lu【太陽與地球 Sun & Earth】Official Video.mp4",
            "Teddy Swims - Lose Control (Lyric Video).mp4",
            "Teddy Swims - The Door (Official Music Video).mp4",
            "Other Swims - Another Door.mp4",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let lib = build_library(Path::new("/lib"), &files);
        let originals = |title: &str| -> Vec<String> {
            lib.songs.iter().find(|s| s.title == title).unwrap().originals.iter().map(|o| o.file_name.clone()).collect()
        };
        assert_eq!(originals("寂寞先生 曹格"), ["曹格 Gary Chaw【寂寞先生】Official Music Video.mp4"]);
        assert!(originals("几分之几 卢广仲")[0].contains("幾分之幾"));
        assert!(originals("刻在我心底的名字 卢广仲")[0].contains("刻在我心底的名字"));
        assert!(originals("太阳与地球 卢广仲")[0].contains("太陽與地球"));
        assert_eq!(originals("Lose Control Teddy Swims"), ["Teddy Swims - Lose Control (Lyric Video).mp4"]);
        assert_eq!(originals("The Door Teddy Swims"), ["Teddy Swims - The Door (Official Music Video).mp4"]);
        // 英文词要整词出现：Another 里有 the，也不算
        assert_eq!(lib.unassigned.iter().map(|f| f.file_name.as_str()).collect::<Vec<_>>(), ["Other Swims - Another Door.mp4"]);
    }
}
