//! 读音表（PRD 4.12「核心：读音表」）：一首歌一张，显示注音、老师开口、老师讲解都读它。
//!
//! - 存在歌旁边的 `<歌名>.readings.json`；每次打开学唱按歌词、笔记、标注重新算（很快），Claude 给过的候选保留
//! - 来源优先级：笔记里的 `读音：`、资料表的歌名读音 > 歌曲自带标注（YouTube 标题里的罗马字）
//!   > 两个分析器一致 > 词典（只有一个分析器认得 / 两边不一致） > Claude
//! - 日语用两个分析器交叉比对：Lindera（UniDic，选 BSD 许可）和 sudachi.rs（SudachiDict core，Apache-2.0）。
//!   两边读音不一致、未知词、Lindera 第二好的切法读音不同、专有名词 → 待确认
//! - 词典约 220 MB（装好约 380 MB），比应用本身大很多，所以和 Demucs 一样第一次用时下载、核对 SHA-256，放 `tools/reading/`
//! - 音高重音（jpreprocess）先只留接口：`pitch_accent` 现在都是 None

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use wana_kana::ConvertJapanese;

use super::notes::{self, Note};
use crate::lyrics_store::sanitize_file_stem;
use crate::video;

pub const TABLE_SUFFIX: &str = ".readings.json";
const SCHEMA: u32 = 1;

// ---------------------------------------------------------------- 词典

const UNIDIC_URL: &str = "https://Lindera.dev/unidic-mecab-2.1.2.tar.gz";
const UNIDIC_SHA256: &str = "24ac75fe4e44d973b55e65847c35fa4aec2db7a41a07b49ca125146db9fc1189";
const UNIDIC_BYTES: u64 = 140_515_741;
const UNIDIC_DIR: &str = "unidic-mecab-2.1.2";
const SUDACHI_URL: &str = "https://d2ej7fkh96fzlu.cloudfront.net/sudachidict/v1/sudachi-dictionary-20261015-core.zip";
const SUDACHI_SHA256: &str = "5cf5cb7f1ea943a988e2fb5d285a9a8b3538861faefa7a2604c2cd18c387f503";
const SUDACHI_BYTES: u64 = 76_937_904;
const SUDACHI_DIC: &str = "system_core.dic";
/// Lindera 编 UniDic 用的设定（来自 lindera-unidic 6.2.0，MIT）
const UNIDIC_METADATA: &str = include_str!("unidic_metadata.json");

pub const ANALYZER_NAMES: &str = "Lindera（UniDic 2.1.2）+ Sudachi（core 20261015）";

/// 工具目录：正式应用是配置目录下的 `tools/`（macOS 上和下载视频的工具同一个文件夹）；测试模式由 devbridge 改成测试曲库的 `.tools/`
static TOOLS: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub fn set_tools_dir(dir: PathBuf) {
    let _ = TOOLS.set(dir);
}

pub fn tools_dir(config: &Path) -> PathBuf {
    TOOLS.get().cloned().unwrap_or_else(|| config.join("tools"))
}

/// 词典装在哪：`<tools>/reading/lindera-unidic/`、`<tools>/reading/sudachi/system_core.dic`
pub fn dict_dir(tools: &Path) -> PathBuf {
    tools.join("reading")
}

fn lindera_dir(tools: &Path) -> PathBuf {
    dict_dir(tools).join("lindera-unidic")
}

fn sudachi_dic(tools: &Path) -> PathBuf {
    dict_dir(tools).join("sudachi").join(SUDACHI_DIC)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictStatus {
    pub installed: bool,
    /// 要下载多少 MB
    pub download_mb: u64,
    /// 装好占多少 MB
    pub disk_mb: u64,
    pub analyzers: &'static str,
}

pub fn dict_status(tools: &Path) -> DictStatus {
    DictStatus {
        installed: lindera_dir(tools).join("metadata.json").is_file() && sudachi_dic(tools).is_file(),
        download_mb: (UNIDIC_BYTES + SUDACHI_BYTES) / 1_000_000,
        disk_mb: 385,
        analyzers: ANALYZER_NAMES,
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn run(cmd: &mut Command, what: &str) -> Result<(), String> {
    let out = cmd.output().map_err(|e| format!("{what}失败：{e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("{what}失败：{}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// 安装读音词典：下载两个词典 → 核对 SHA-256 → 解开 → 编 Lindera 词典。进度写在任务状态里（和下载视频同一套）
pub fn install(dirs: &video::Dirs) -> Result<DictStatus, String> {
    let tools = &dirs.tools;
    if dict_status(tools).installed {
        return Ok(dict_status(tools));
    }
    let mut job = video::begin(dirs, "install-reading", "准备下载读音词典")?;
    let tmp = dirs.work.join(format!("reading-{}", job.started));
    let result = (|| -> Result<(), String> {
        fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let base = dict_dir(tools);
        fs::create_dir_all(&base).map_err(|e| e.to_string())?;

        if !sudachi_dic(tools).is_file() {
            let zip = tmp.join("sudachi.zip");
            video::curl_file(dirs, &mut job, SUDACHI_URL, &zip, Some(SUDACHI_BYTES), "下载 Sudachi 词典（约 77 MB）")?;
            job.text = "核对 Sudachi 词典".into();
            job.percent = None;
            video::write_job(dirs, &job);
            if sha256_file(&zip)? != SUDACHI_SHA256 {
                return Err("Sudachi 词典下载得不完整（校验不对），请再试一次".into());
            }
            run(Command::new("/usr/bin/ditto").args(["-x", "-k"]).arg(&zip).arg(&tmp), "解开 Sudachi 词典")?;
            let found = fs::read_dir(&tmp)
                .map_err(|e| e.to_string())?
                .flatten()
                .map(|e| e.path().join(SUDACHI_DIC))
                .find(|p| p.is_file())
                .ok_or("Sudachi 词典包里没有 system_core.dic")?;
            fs::create_dir_all(sudachi_dic(tools).parent().unwrap()).map_err(|e| e.to_string())?;
            fs::rename(&found, sudachi_dic(tools)).map_err(|e| e.to_string())?;
        }

        if !lindera_dir(tools).join("metadata.json").is_file() {
            let tgz = tmp.join("unidic.tar.gz");
            video::curl_file(dirs, &mut job, UNIDIC_URL, &tgz, Some(UNIDIC_BYTES), "下载 UniDic 词典（约 140 MB）")?;
            job.text = "核对 UniDic 词典".into();
            job.percent = None;
            video::write_job(dirs, &job);
            if sha256_file(&tgz)? != UNIDIC_SHA256 {
                return Err("UniDic 词典下载得不完整（校验不对），请再试一次".into());
            }
            job.text = "解开 UniDic 词典".into();
            video::write_job(dirs, &job);
            run(Command::new("/usr/bin/tar").arg("-xzf").arg(&tgz).arg("-C").arg(&tmp), "解开 UniDic 词典")?;
            let _ = fs::remove_file(&tgz);
            job.text = "整理 UniDic 词典（几秒钟）".into();
            video::write_job(dirs, &job);
            let out = base.join("lindera-unidic.part");
            let _ = fs::remove_dir_all(&out);
            let meta: lindera_dictionary::dictionary::metadata::Metadata = serde_json::from_str(UNIDIC_METADATA).map_err(|e| e.to_string())?;
            lindera_dictionary::builder::DictionaryBuilder::new(meta)
                .build_dictionary(&tmp.join(UNIDIC_DIR), &out)
                .map_err(|e| format!("整理 UniDic 词典失败：{e}"))?;
            let _ = fs::remove_dir_all(lindera_dir(tools));
            fs::rename(&out, lindera_dir(tools)).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&tmp);
    video::finish(dirs, &mut job);
    result?;
    *ANALYZERS.lock().unwrap_or_else(|e| e.into_inner()) = None;
    Ok(dict_status(tools))
}

// ---------------------------------------------------------------- 分析器

/// 分析器给的一个词
#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub surface: String,
    /// 在这一行里的字节位置
    pub start: usize,
    pub end: usize,
    /// 片假名读音
    pub reading: String,
    pub proper: bool,
    pub unknown: bool,
}

pub struct Analyzers {
    lindera: lindera::segmenter::Segmenter,
    sudachi: sudachi::dic::dictionary::JapaneseDictionary,
}

/// 第二好的切法比最好的贵不到这么多，才算「差不多」，读音不同就待确认（MeCab 系的成本单位；
/// 实测「夏実の花火が…」差 3537 → 算，「東京」差 14373 → 不算）
const NBEST_CLOSE: i64 = 5000;

impl Analyzers {
    pub fn load(tools: &Path) -> Result<Analyzers, String> {
        let dict = lindera::dictionary::load_fs_dictionary(&lindera_dir(tools)).map_err(|e| format!("读不了 UniDic 词典：{e}"))?;
        let lindera = lindera::segmenter::Segmenter::new(lindera::mode::Mode::Normal, dict, None);
        let cfg = sudachi::config::Config::new(None, None, Some(sudachi_dic(tools))).map_err(|e| format!("Sudachi 设定不对：{e}"))?;
        let sudachi = sudachi::dic::dictionary::JapaneseDictionary::from_cfg(&cfg).map_err(|e| format!("读不了 Sudachi 词典：{e}"))?;
        Ok(Analyzers { lindera, sudachi })
    }

    fn lindera_tokens(tokens: Vec<lindera::token::Token<'_>>) -> Vec<Token> {
        tokens
            .into_iter()
            .map(|mut t| {
                let unknown = t.word_id.is_unknown();
                let surface = t.surface.to_string();
                let (start, end) = (t.byte_start, t.byte_end);
                let proper = t.get_detail(1) == Some("固有名詞");
                // 9 = 发音形（phonological_surface_form）：这个词在句子里的念法；未知词没有就用原文
                let reading = t.get_detail(9).filter(|r| *r != "*" && !r.is_empty()).map(str::to_string).unwrap_or_else(|| surface.clone());
                Token { surface, start, end, reading, proper, unknown }
            })
            .collect()
    }

    pub fn lindera(&self, line: &str) -> Vec<Token> {
        self.lindera.segment(Cow::Borrowed(line)).map(Self::lindera_tokens).unwrap_or_default()
    }

    /// 第二好的切法（和最好的差不多时才有）
    pub fn lindera_second(&self, line: &str) -> Option<Vec<Token>> {
        let mut best = self.lindera.segment_nbest(Cow::Borrowed(line), 2, true, Some(NBEST_CLOSE)).ok()?;
        (best.len() >= 2).then(|| Self::lindera_tokens(best.swap_remove(1).0))
    }

    pub fn sudachi(&self, line: &str) -> Vec<Token> {
        use sudachi::analysis::Tokenize;
        let tok = sudachi::analysis::stateless_tokenizer::StatelessTokenizer::new(&self.sudachi);
        let Ok(list) = tok.tokenize(line, sudachi::analysis::Mode::C, false) else { return Vec::new() };
        list.iter()
            .map(|m| {
                let pos = m.part_of_speech();
                Token {
                    surface: m.surface().to_string(),
                    start: m.begin(),
                    end: m.end(),
                    reading: m.reading_form().to_string(),
                    proper: pos.get(1).is_some_and(|p| p == "固有名詞"),
                    unknown: m.is_oov(),
                }
            })
            .collect()
    }
}

/// 读进内存的分析器，按词典目录缓存（Lindera 是 mmap，Sudachi 约 0.1 秒）
static ANALYZERS: Mutex<Option<(PathBuf, Arc<Analyzers>)>> = Mutex::new(None);

/// 词典装好了就给分析器，没装返回 None
pub fn analyzers(tools: &Path) -> Option<Arc<Analyzers>> {
    if !dict_status(tools).installed {
        return None;
    }
    let mut slot = ANALYZERS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((p, a)) = slot.as_ref() {
        if p == tools {
            return Some(a.clone());
        }
    }
    let a = Arc::new(Analyzers::load(tools).ok()?);
    *slot = Some((tools.to_path_buf(), a.clone()));
    Some(a)
}

// ---------------------------------------------------------------- 比对

pub fn has_kanji(s: &str) -> bool {
    s.chars().any(|c| matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}' | '\u{F900}'..='\u{FAFF}' | '々' | '〆' | 'ヶ'))
}

fn vowel_of(c: char) -> Option<char> {
    const ROWS: [(&str, char); 5] = [
        ("アカサタナハマヤラワガザダバパァャヮカ゚", 'ア'),
        ("イキシチニヒミリギジヂビピィ", 'イ'),
        ("ウクスツヌフムユルグズヅブプゥュヴ", 'ウ'),
        ("エケセテネヘメレゲゼデベペェ", 'エ'),
        ("オコソトノホモヨロヲゴゾドボポォョ", 'オ'),
    ];
    ROWS.iter().find(|(row, _)| row.contains(c)).map(|(_, v)| *v)
}

/// 比对用的读音：片假名，长音、ヅヂヲ、オウ / エイ 都统一（两个词典写法不同但念法一样）
pub fn normalize(reading: &str) -> String {
    let kata = reading.to_katakana();
    let mut out: Vec<char> = Vec::new();
    for c in kata.chars() {
        let c = match c {
            'ヅ' => 'ズ',
            'ヂ' => 'ジ',
            'ヲ' => 'オ',
            other => other,
        };
        let prev_vowel = out.last().copied().and_then(vowel_of);
        let c = match (c, prev_vowel) {
            ('ー', Some(v)) => v,
            ('ウ', Some('オ')) => 'オ',
            ('ウ', Some('ウ')) => 'ウ',
            ('イ', Some('エ')) => 'エ',
            (c, _) => c,
        };
        out.push(c);
    }
    out.into_iter().filter(|c| !c.is_whitespace()).collect()
}

/// 两边切法对齐后的一段（两边在这里都有切分点）
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub surface: String,
    pub sudachi: String,
    pub unidic: String,
    pub proper: bool,
    pub unknown: bool,
    /// Lindera 第二好的切法在这段读音不同
    pub nbest_differs: bool,
}

fn reading_in(tokens: &[Token], start: usize, end: usize) -> Option<String> {
    let inside: Vec<&Token> = tokens.iter().filter(|t| t.start >= start && t.end <= end).collect();
    let covered: usize = inside.iter().map(|t| t.end - t.start).sum();
    (covered == end - start).then(|| inside.iter().map(|t| t.reading.as_str()).collect())
}

/// 一行歌词：两个分析器的切法对齐成几段，只留有汉字的段
pub fn segments(line: &str, sud: &[Token], lin: &[Token], second: Option<&[Token]>) -> Vec<Segment> {
    let ends_s: Vec<usize> = sud.iter().map(|t| t.end).collect();
    let ends_l: Vec<usize> = lin.iter().map(|t| t.end).collect();
    let mut out = Vec::new();
    let mut start = 0;
    for &e in &ends_s {
        if !ends_l.contains(&e) || e <= start {
            continue;
        }
        let surface = &line[start..e];
        let piece_s: Vec<&Token> = sud.iter().filter(|t| t.start >= start && t.end <= e).collect();
        let piece_l: Vec<&Token> = lin.iter().filter(|t| t.start >= start && t.end <= e).collect();
        // 段首段尾的纯假名词（助词等）去掉，只留中间有汉字的部分
        let lo = piece_s.iter().chain(&piece_l).filter(|t| has_kanji(&t.surface)).map(|t| t.start).min();
        let hi = piece_s.iter().chain(&piece_l).filter(|t| has_kanji(&t.surface)).map(|t| t.end).max();
        if let (Some(lo), Some(hi)) = (lo, hi) {
            if let (Some(rs), Some(rl)) = (reading_in(sud, lo, hi), reading_in(lin, lo, hi)) {
                let nbest_differs = second.and_then(|t| reading_in(t, lo, hi)).is_some_and(|r2| normalize(&r2) != normalize(&rl));
                out.push(Segment {
                    surface: line[lo..hi].to_string(),
                    sudachi: rs,
                    unidic: rl,
                    proper: piece_s.iter().chain(&piece_l).any(|t| t.proper && t.start < hi && t.end > lo),
                    unknown: piece_s.iter().chain(&piece_l).any(|t| t.unknown && t.start < hi && t.end > lo),
                    nbest_differs,
                });
            } else if has_kanji(surface) {
                // 去掉假名后两边对不齐：整段一起比
                let rs: String = piece_s.iter().map(|t| t.reading.as_str()).collect();
                let rl: String = piece_l.iter().map(|t| t.reading.as_str()).collect();
                out.push(Segment {
                    surface: surface.to_string(),
                    sudachi: rs,
                    unidic: rl,
                    proper: piece_s.iter().chain(&piece_l).any(|t| t.proper),
                    unknown: piece_s.iter().chain(&piece_l).any(|t| t.unknown),
                    nbest_differs: false,
                });
            }
        }
        start = e;
    }
    out
}

// ---------------------------------------------------------------- 读音表

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// 我确认过的：这首歌笔记里的 `读音：`
    Note,
    /// 资料表里的歌名读音
    Title,
    /// 歌曲自带标注（YouTube 标题里的罗马字等）
    Annotation,
    /// 两个分析器一致
    Analyzer,
    /// 只有词典给的（两个分析器不一致、有未知词等）
    Dictionary,
    /// Claude 给的
    Claude,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Note => "你确认的",
            Source::Title => "资料表里的歌名读音",
            Source::Annotation => "歌曲自带标注",
            Source::Analyzer => "两个分析器一致",
            Source::Dictionary => "词典",
            Source::Claude => "Claude 给的",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidates {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sudachi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unidic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub word: String,
    /// 平假名
    pub reading: String,
    pub romaji: String,
    pub source: Source,
    /// 两个分析器一致吗（没分析过是 None）
    #[serde(default)]
    pub consistent: Option<bool>,
    pub needs_review: bool,
    /// 为什么待确认
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default)]
    pub proper: bool,
    #[serde(default)]
    pub candidates: Candidates,
    /// 出现在第几句（从 0 数）
    #[serde(default)]
    pub lines: Vec<usize>,
    /// 音高重音（以后由 jpreprocess 补），现在都是 None
    #[serde(default)]
    pub pitch_accent: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub schema: u32,
    /// 用了哪两个分析器；没装词典是 None
    #[serde(default)]
    pub analyzers: Option<String>,
    pub words: Vec<Reading>,
}

impl Table {
    pub fn get(&self, word: &str) -> Option<&Reading> {
        self.words.iter().find(|w| w.word == word)
    }

    /// 给老师查：完全一样的优先，其次互相包含的
    pub fn lookup(&self, word: &str) -> Vec<&Reading> {
        let word = word.trim().trim_matches(['「', '」', '《', '》', '『', '』']);
        if let Some(w) = self.get(word) {
            return vec![w];
        }
        self.words.iter().filter(|w| !word.is_empty() && (word.contains(&w.word) || w.word.contains(word))).collect()
    }
}

pub fn table_path(root: &Path, key: &str) -> PathBuf {
    root.join(format!("{}{TABLE_SUFFIX}", sanitize_file_stem(key)))
}

pub fn load_table(root: &Path, key: &str) -> Option<Table> {
    fs::read(table_path(root, key)).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

pub fn save_table(root: &Path, key: &str, t: &Table) -> Result<(), String> {
    fs::write(table_path(root, key), serde_json::to_vec_pretty(t).map_err(|e| e.to_string())?).map_err(|e| format!("保存读音表失败：{e}"))
}

pub fn to_hiragana(kana: &str) -> String {
    kana.to_hiragana()
}

pub fn romaji(kana: &str) -> String {
    kana.to_hiragana().to_romaji()
}

fn is_kana_text(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| matches!(c, '\u{3041}'..='\u{309F}' | '\u{30A0}'..='\u{30FF}'))
}

const SEPARATORS: &[char] = &['⧸', '/', '／', '|', '｜', '(', '（', ')', '）', '-', '–', '—', ':', '：', '「', '」', '『', '』', '[', ']', '【', '】', '〜', '~', ' ', '　', '・', '「'];

fn romaji_run(s: &str) -> Option<&str> {
    let end = s.find(|c: char| !(c.is_ascii_alphabetic() || c == ' ' || c == '\'' || c == '-')).unwrap_or(s.len());
    let run = s[..end].trim().trim_end_matches('-').trim();
    (run.chars().filter(|c| c.is_ascii_alphabetic()).count() >= 2).then_some(run)
}

/// 歌曲自带标注里找这个词的罗马字：「夏実 ⧸ Kajitsu」「夏実 (Kajitsu)」「Kajitsu / 夏実」→ かじつ
pub fn annotation_reading(annotation: &str, word: &str) -> Option<String> {
    let to_kana = |r: &str| {
        let k = r.to_lowercase().replace([' ', '\'', '-'], "").to_hiragana();
        is_kana_text(&k).then_some(k)
    };
    for (i, _) in annotation.match_indices(word) {
        // 词要在标注里单独出现（前后是分隔符或开头结尾），「夏」不能借「夏実」的标注
        let prev = annotation[..i].chars().next_back();
        let next = annotation[i + word.len()..].chars().next();
        let edge = |c: Option<char>| c.is_none_or(|c| SEPARATORS.contains(&c) || c.is_whitespace() || c.is_ascii());
        if !edge(prev) || !edge(next) {
            continue;
        }
        let after = annotation[i + word.len()..].trim_start_matches(SEPARATORS);
        if let Some(k) = romaji_run(after).and_then(to_kana) {
            return Some(k);
        }
        let before = annotation[..i].trim_end_matches(SEPARATORS);
        let start = before.rfind(|c: char| !(c.is_ascii_alphabetic() || c == ' ' || c == '\'' || c == '-')).map(|p| p + before[p..].chars().next().map_or(1, char::len_utf8)).unwrap_or(0);
        if let Some(k) = romaji_run(&before[start..]).and_then(to_kana) {
            return Some(k);
        }
    }
    None
}

/// 建读音表要的材料
#[derive(Debug, Default, Clone)]
pub struct Inputs<'a> {
    pub lines: Vec<String>,
    /// 这首歌的笔记（`读音：` 条目是第 1 级来源）
    pub song_notes: &'a [Note],
    /// 资料表的（显示名, 歌名读音）
    pub title_reading: Option<(String, String)>,
    /// 歌名（显示名、文件名键），没歌词也要给它查标注
    pub titles: Vec<String>,
    /// 歌曲自带标注：资料表的视频标题、原视频文件名
    pub annotations: Vec<String>,
    /// 以前 Claude 给过的（词, 读音）
    pub claude: Vec<(String, String)>,
}

fn entry(word: &str, reading: &str, source: Source) -> Reading {
    let reading = to_hiragana(reading);
    Reading {
        word: word.to_string(),
        romaji: romaji(&reading),
        reading,
        source,
        consistent: None,
        needs_review: false,
        reasons: Vec::new(),
        proper: false,
        candidates: Candidates::default(),
        lines: Vec::new(),
        pitch_accent: None,
    }
}

/// 读音只取到第一个括号前（`かじつ（Kajitsu）` → かじつ）；罗马字的话转成假名
fn plain_reading(say: &str) -> String {
    let r = say.split(['（', '(']).next().unwrap_or("").trim();
    if r.chars().all(|c| c.is_ascii_alphabetic() || c == ' ') {
        r.to_lowercase().replace(' ', "").to_hiragana()
    } else {
        r.to_string()
    }
}

/// 建一张读音表。`an` 为空（词典没装）时只有笔记、标注、Claude 三种来源
pub fn build(an: Option<&Analyzers>, input: &Inputs) -> Table {
    let mut words: BTreeMap<String, Reading> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    fn put(r: Reading, words: &mut BTreeMap<String, Reading>, order: &mut Vec<String>) {
        if !words.contains_key(&r.word) {
            order.push(r.word.clone());
        }
        words.insert(r.word.clone(), r);
    }

    // 3–4 级：分析器
    if let Some(an) = an {
        for (i, line) in input.lines.iter().enumerate() {
            if !has_kanji(line) {
                continue;
            }
            let (sud, lin) = (an.sudachi(line), an.lindera(line));
            let second = an.lindera_second(line);
            for seg in segments(line, &sud, &lin, second.as_deref()) {
                let agree = normalize(&seg.sudachi) == normalize(&seg.unidic);
                let mut reasons = Vec::new();
                if !agree {
                    reasons.push(format!("两个分析器不一致：Sudachi {}，UniDic {}", to_hiragana(&seg.sudachi), to_hiragana(&seg.unidic)));
                }
                if seg.unknown {
                    reasons.push("词典里没有（未知词）".to_string());
                }
                if seg.nbest_differs {
                    reasons.push("换一种切法读音就不同".to_string());
                }
                if seg.proper {
                    reasons.push("专有名词（人名、地名、歌名），读法常常特别".to_string());
                }
                match words.get_mut(&seg.surface) {
                    Some(prev) => {
                        if !prev.lines.contains(&i) {
                            prev.lines.push(i);
                        }
                        if normalize(&prev.candidates.sudachi.clone().unwrap_or_default()) != normalize(&seg.sudachi) {
                            prev.consistent = Some(false);
                            prev.needs_review = true;
                            prev.source = Source::Dictionary;
                            prev.reasons.push(format!("不同句子里读法不同：{}", to_hiragana(&seg.sudachi)));
                        }
                    }
                    None => {
                        let mut r = entry(&seg.surface, &seg.sudachi, if reasons.is_empty() { Source::Analyzer } else { Source::Dictionary });
                        r.consistent = Some(agree);
                        r.needs_review = !reasons.is_empty();
                        r.reasons = reasons;
                        r.proper = seg.proper;
                        r.candidates.sudachi = Some(to_hiragana(&seg.sudachi));
                        r.candidates.unidic = Some(to_hiragana(&seg.unidic));
                        r.lines = vec![i];
                        put(r, &mut words, &mut order);
                    }
                }
            }
        }
    }

    // 5 级：Claude（只补表里没有的，一律待确认；表里有又不一样的，记成候选并待确认）
    for (w, say) in &input.claude {
        let say = to_hiragana(&plain_reading(say));
        if w.is_empty() || !is_kana_text(&say) {
            continue;
        }
        match words.get_mut(w) {
            Some(r) => {
                r.candidates.claude = Some(say.clone());
                if r.source >= Source::Analyzer && normalize(&say) != normalize(&r.reading) && !r.needs_review {
                    r.needs_review = true;
                    r.reasons.push(format!("Claude 读成 {say}"));
                }
            }
            None => {
                let mut r = entry(w, &say, Source::Claude);
                r.candidates.claude = Some(say.clone());
                r.lines = line_hits(&input.lines, w);
                // 分析器在歌词里把它切开了（八月 → 八 / 月），单独分析这个词两边一致、又和 Claude 一样，就不用等我确认
                match an.and_then(|an| agreed_reading(an, w)) {
                    Some(a) if normalize(&a) == normalize(&say) => {
                        r.source = Source::Analyzer;
                        r.consistent = Some(true);
                    }
                    _ => {
                        r.needs_review = true;
                        r.reasons.push("只有 Claude 给了读音".into());
                    }
                }
                put(r, &mut words, &mut order);
            }
        }
    }

    // 2 级：歌曲自带标注
    let mut checks: Vec<String> = order.clone();
    for t in &input.titles {
        if !checks.contains(t) && has_kanji(t) {
            checks.push(t.clone());
        }
    }
    for w in checks {
        if let Some(k) = input.annotations.iter().find_map(|a| annotation_reading(a, &w)) {
            let mut r = words.get(&w).cloned().unwrap_or_else(|| {
                let mut r = entry(&w, &k, Source::Annotation);
                r.lines = line_hits(&input.lines, &w);
                r
            });
            r.candidates.annotation = Some(k.clone());
            set_confirmed(&mut r, &k, Source::Annotation);
            put(r, &mut words, &mut order);
        }
    }

    // 1 级：资料表歌名读音、这首歌笔记里的 `读音：`
    let mut confirmed: Vec<(String, String, Source)> = Vec::new();
    if let Some((t, r)) = &input.title_reading {
        confirmed.push((t.clone(), plain_reading(r), Source::Title));
    }
    for n in input.song_notes {
        if let Some((w, say)) = notes::reading_entry(&n.text) {
            confirmed.push((w, plain_reading(&say), Source::Note));
        }
    }
    for (w, say, src) in confirmed {
        let say = to_hiragana(&say);
        if w.is_empty() || !is_kana_text(&say) {
            continue;
        }
        let mut r = words.get(&w).cloned().unwrap_or_else(|| {
            let mut r = entry(&w, &say, src);
            r.lines = line_hits(&input.lines, &w);
            r
        });
        set_confirmed(&mut r, &say, src);
        put(r, &mut words, &mut order);
    }

    // 分析器切出来的碎片（八月 里的「八」）：歌词里每次出现都在一个更长的、已经定了读音的词里面，就不列出来等我确认
    let settled: Vec<String> = words.values().filter(|r| !r.needs_review).map(|r| r.word.clone()).collect();
    order.retain(|w| {
        let r = &words[w];
        let fragment = r.needs_review && matches!(r.source, Source::Analyzer | Source::Dictionary) && !r.proper && covered_everywhere(&input.lines, w, &settled);
        !fragment
    });

    let words = order.into_iter().filter_map(|w| words.remove(&w)).collect();
    Table { schema: SCHEMA, analyzers: an.map(|_| ANALYZER_NAMES.to_string()), words }
}

/// 单独分析一个词：两个分析器都认得、读音一致才给
fn agreed_reading(an: &Analyzers, word: &str) -> Option<String> {
    // Sudachi 把「八」「二」这类数字当未知词，但读音照样给；只要每段都给了假名读音就算
    let join = |t: Vec<Token>| -> Option<String> { (!t.is_empty() && t.iter().all(|t| !has_kanji(&t.reading))).then(|| t.iter().map(|t| to_hiragana(&t.reading)).collect()) };
    let (a, b) = (join(an.sudachi(word))?, join(an.lindera(word))?);
    (normalize(&a) == normalize(&b)).then_some(a)
}

/// w 在歌词里每次出现，都落在某个更长的词（longer 里的）里面
fn covered_everywhere(lines: &[String], w: &str, longer: &[String]) -> bool {
    let mut seen = false;
    for line in lines {
        for (p, _) in line.match_indices(w) {
            seen = true;
            let inside = longer.iter().filter(|x| x.len() > w.len() && x.contains(w)).any(|x| line.match_indices(x.as_str()).any(|(q, _)| q <= p && p + w.len() <= q + x.len()));
            if !inside {
                return false;
            }
        }
    }
    seen
}

fn line_hits(lines: &[String], w: &str) -> Vec<usize> {
    lines.iter().enumerate().filter(|(_, l)| l.contains(w)).map(|(i, _)| i).collect()
}

/// 高一级的来源定了读音：覆盖，原来的读音留在候选里，不再待确认
fn set_confirmed(r: &mut Reading, reading: &str, source: Source) {
    let reading = to_hiragana(reading);
    if r.source < source {
        return;
    }
    r.romaji = romaji(&reading);
    r.reading = reading;
    r.source = source;
    r.needs_review = false;
    r.reasons.clear();
}

/// 给老师查读音：先查表；表里没有又装了词典，就现场分析（来源最多到「分析器一致」，专有名词照样待确认）
pub fn lookup(table: &Table, an: Option<&Analyzers>, word: &str) -> Value {
    let hits = table.lookup(word);
    if !hits.is_empty() {
        return serde_json::json!({ "inTable": true, "words": hits.iter().map(|r| describe(r)).collect::<Vec<_>>() });
    }
    if let Some(an) = an.filter(|_| has_kanji(word)) {
        let t = build(Some(an), &Inputs { lines: vec![word.to_string()], ..Default::default() });
        if !t.words.is_empty() {
            return serde_json::json!({ "inTable": false, "note": "表里没有，这是现场分析的，没有经过确认", "words": t.words.iter().map(describe).collect::<Vec<_>>() });
        }
    }
    serde_json::json!({ "inTable": false, "words": [], "note": "读音表里没有这个词，读音待确认，问我" })
}

fn describe(r: &Reading) -> Value {
    serde_json::json!({
        "word": r.word,
        "reading": r.reading,
        "romaji": r.romaji,
        "source": r.source.label(),
        "needsReview": r.needs_review,
        "reasons": r.reasons,
    })
}

/// 发给老师的读音表（放在系统提示里）
pub fn prompt_block(t: &Table) -> String {
    let mut out = String::from("## 读音表（读音以这里为准；标了「待确认」的不要自己定读音）\n");
    if t.words.is_empty() {
        out += "（还没有）\n";
    }
    for r in &t.words {
        out += &format!("- {} = {}（{}，{}）", r.word, r.reading, r.romaji, r.source.label());
        if r.needs_review {
            out += &format!(" 待确认：{}", r.reasons.join("；"));
        }
        out += "\n";
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 开发机上装好的词典：先看 BANZOU_READING_TOOLS，再看测试曲库 app/.testlib/.tools
    fn dev_analyzers() -> Option<Arc<Analyzers>> {
        let tools = std::env::var_os("BANZOU_READING_TOOLS")
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../.testlib/.tools"));
        let a = analyzers(&tools);
        if a.is_none() {
            eprintln!("读音词典没装（{}），跳过分析器测试", dict_dir(&tools).display());
        }
        a
    }

    fn note(t: &str) -> Note {
        Note { text: t.into(), tag: None }
    }

    #[test]
    fn fragments_inside_settled_words() {
        let lines = vec!["あの八月に".to_string(), "もう二度と".to_string()];
        let settled = vec!["八月".to_string()];
        assert!(covered_everywhere(&lines, "八", &settled));
        assert!(!covered_everywhere(&lines, "二", &settled));
        // 别处单独出现一次就不算碎片
        let more = vec!["あの八月に".to_string(), "八つ".to_string()];
        assert!(!covered_everywhere(&more, "八", &settled));
        assert!(!covered_everywhere(&lines, "九", &settled));
    }

    #[test]
    fn claude_reading_confirmed_when_analyzers_agree_alone() {
        let Some(an) = dev_analyzers() else { return };
        let input = Inputs { lines: vec!["八月の空を見上げていた".into()], claude: vec![("八月".into(), "はちがつ".into())], ..Default::default() };
        let t = build(Some(&an), &input);
        let w = t.get("八月").expect("八月 在表里");
        assert!(!w.needs_review, "{:?}", w.reasons);
        // 碎片「八」不再列出来等确认
        assert!(t.words.iter().all(|r| !(r.word == "八" && r.needs_review)));
        // Claude 读错了照样待确认
        let wrong = build(Some(&an), &Inputs { claude: vec![("八月".into(), "はちげつ".into())], ..input });
        assert!(wrong.get("八月").unwrap().needs_review);
    }

    #[test]
    fn normalize_merges_spelling_variants() {
        assert_eq!(normalize("トウキョウ"), normalize("トーキョー"));
        assert_eq!(normalize("キヅイ"), normalize("キズイ"));
        assert_eq!(normalize("せんせい"), normalize("センセー"));
        assert_ne!(normalize("ナツミ"), normalize("カジツ"));
    }

    #[test]
    fn annotation_romaji() {
        assert_eq!(annotation_reading("【AKASAKI】夏実 ⧸ Kajitsu（Lyric Video）", "夏実").as_deref(), Some("かじつ"));
        assert_eq!(annotation_reading("夏実 (Kajitsu) - Official", "夏実").as_deref(), Some("かじつ"));
        assert_eq!(annotation_reading("Kajitsu / 夏実", "夏実").as_deref(), Some("かじつ"));
        assert_eq!(annotation_reading("夏実（Lyric Video）", "夏実"), None);
        assert_eq!(annotation_reading("花火", "夏実"), None);
        // 「夏」只是「夏実」的一部分，不能拿 AKASAKI 当它的读音
        assert_eq!(annotation_reading("【AKASAKI】夏実 ⧸ Kajitsu（Lyric Video）", "夏"), None);
    }

    #[test]
    fn kajitsu_from_note_or_title_annotation() {
        // 没装词典也成立：笔记、标注是最高的两级
        let notes = [note("读音：夏実 = かじつ（Kajitsu），不是なつみ")];
        let t = build(None, &Inputs { lines: vec!["夏実の花火".into()], song_notes: &notes, ..Default::default() });
        let r = t.get("夏実").unwrap();
        assert_eq!((r.reading.as_str(), r.romaji.as_str(), r.source, r.needs_review), ("かじつ", "kajitsu", Source::Note, false));
        assert_eq!(r.lines, vec![0]);

        let t = build(None, &Inputs { titles: vec!["夏実".into()], annotations: vec!["【AKASAKI】夏実 ⧸ Kajitsu（Lyric Video）".into()], ..Default::default() });
        let r = t.get("夏実").unwrap();
        assert_eq!((r.reading.as_str(), r.source, r.needs_review), ("かじつ", Source::Annotation, false));

        // 资料表歌名读音也是第 1 级
        let t = build(None, &Inputs { title_reading: Some(("夏実".into(), "かじつ（Kajitsu）".into())), ..Default::default() });
        assert_eq!(t.get("夏実").map(|r| (r.reading.as_str(), r.source)), Some(("かじつ", Source::Title)));
    }

    #[test]
    fn claude_only_is_always_review() {
        let t = build(None, &Inputs { lines: vec!["夏実".into()], claude: vec![("夏実".into(), "なつみ".into())], ..Default::default() });
        let r = t.get("夏実").unwrap();
        assert_eq!((r.source, r.needs_review), (Source::Claude, true));
        // 有笔记时 Claude 只是候选
        let notes = [note("读音：夏実 = かじつ")];
        let t = build(None, &Inputs { lines: vec!["夏実".into()], song_notes: &notes, claude: vec![("夏実".into(), "なつみ".into())], ..Default::default() });
        let r = t.get("夏実").unwrap();
        assert_eq!((r.reading.as_str(), r.source, r.needs_review, r.candidates.claude.as_deref()), ("かじつ", Source::Note, false, Some("なつみ")));
    }

    #[test]
    fn kajitsu_without_any_annotation_is_review_not_natsumi() {
        let Some(an) = dev_analyzers() else { return };
        let t = build(Some(&an), &Inputs { lines: vec!["夏実の花火が空に咲く".into()], ..Default::default() });
        let r = t.get("夏実").expect("夏実 要在表里");
        assert!(r.needs_review, "{r:?}");
        assert_ne!(r.source, Source::Analyzer);
        assert!(r.proper);
        // 有标注就是かじつ，来源是标注
        let t = build(Some(&an), &Inputs { lines: vec!["夏実の花火が空に咲く".into()], annotations: vec!["夏実 ⧸ Kajitsu".into()], ..Default::default() });
        let r = t.get("夏実").unwrap();
        assert_eq!((r.reading.as_str(), r.source, r.needs_review), ("かじつ", Source::Annotation, false));
        assert_eq!(r.candidates.sudachi.as_deref(), Some("なつみ"));
    }

    #[test]
    fn common_words_agree() {
        let Some(an) = dev_analyzers() else { return };
        let t = build(Some(&an), &Inputs { lines: vec!["夏実の花火が空に咲く".into(), "心の中で君を呼ぶ".into(), "東京へ行った".into(), "気付いて 夏の終わりに".into()], ..Default::default() });
        for (w, k) in [("花火", "はなび"), ("心", "こころ"), ("東京", "とうきょう"), ("気付い", "きづい"), ("終わり", "おわり")] {
            let r = t.get(w).unwrap_or_else(|| panic!("{w} 不在表里：{:?}", t.words));
            assert_eq!(r.reading, k, "{w}");
            if w != "東京" {
                assert_eq!((r.source, r.needs_review, r.consistent), (Source::Analyzer, false, Some(true)), "{w}: {r:?}");
            }
        }
        // 東京是地名：读音一致，但专有名词照样待确认
        let tokyo = t.get("東京").unwrap();
        assert_eq!((tokyo.consistent, tokyo.needs_review), (Some(true), true));
        assert_eq!(t.get("花火").unwrap().lines, vec![0]);
    }
}
