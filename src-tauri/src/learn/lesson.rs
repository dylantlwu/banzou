//! 备课（PRD 4.12「备课」）：先由本机读音流水线把读音表填好，再把歌词和读音表发给 Claude 生成课程。
//!
//! - 课程存在歌旁边的 `<歌名>.lesson.json`
//! - Claude 不单独决定读音：它给的读音只当最低一级来源，一律待确认；
//!   课程里写的读音（「夏実（なつみ）」这种）和读音表不一致的，按表改，并记在 `fixes` 里告诉用户
//! - 只发文字：歌词、读音表、笔记、文件名

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

use super::notes::{self, Scope};
use super::reading::{self, Table};
use super::teacher::{self, SongInfo};
use crate::{ai, library, lyrics_store::sanitize_file_stem, songmeta};

pub const LESSON_SUFFIX: &str = ".lesson.json";
/// 备课拿到空课程时，Claude 的原始回复存在配置目录这个文件里（查原因用）
pub const LAST_EMPTY_REPLY: &str = "lesson-empty-reply.json";

// ---------------------------------------------------------------- 找歌

/// 按稳定编号找歌（找不到再按歌名键找），返回歌名键
pub fn song_key(root: &Path, song_id: &str) -> Result<String, String> {
    let lib = library::scan_dir(root).map_err(|e| format!("扫描曲库失败：{e}"))?;
    lib.songs
        .iter()
        .find(|s| s.song_id == song_id)
        .or_else(|| lib.songs.iter().find(|s| s.title == song_id))
        .map(|s| s.title.clone())
        .ok_or_else(|| "曲库里没有这首歌".to_string())
}

/// 歌词按行（去掉时间和空行），备课、注音、读音表都按这个编号
pub fn lyric_lines(info: &SongInfo) -> Vec<String> {
    info.lyrics.as_deref().unwrap_or("").lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
}

/// 歌曲自带标注：原视频文件名 + 资料表里的视频标题
pub fn annotations(info: &SongInfo) -> Vec<String> {
    let mut out = info.annotations.clone();
    if let Some(v) = info.video_title.as_ref().filter(|v| !out.contains(v)) {
        out.push(v.clone());
    }
    out
}

// ---------------------------------------------------------------- 读音表

/// 按现在的歌词、笔记、标注重新算读音表并存下来；以前 Claude 给过的候选保留
pub fn refresh_table(config: &Path, root: &Path, key: &str) -> Result<Table, String> {
    let info = teacher::song_info(root, key);
    refresh_with(config, root, key, &info, &[])
}

/// 这首歌要不要标日语读音：资料表写了语种就按语种（日语才标）；没写就看歌词里有没有假名
pub fn wants_japanese(info: &SongInfo) -> bool {
    match info.lang.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        Some(lang) => lang.contains('日') || lang.to_lowercase().starts_with("ja"),
        None => info.lyrics.as_deref().unwrap_or("").chars().any(crate::ai::is_kana),
    }
}

fn refresh_with(config: &Path, root: &Path, key: &str, info: &SongInfo, new_claude: &[(String, String)]) -> Result<Table, String> {
    // 国语、粤语、英文歌不标日语读音（不然中文词会被当成日语读音列进「待确认」）
    if !wants_japanese(info) {
        return Ok(reading::build(None, &reading::Inputs::default()));
    }
    let tools = reading::tools_dir(config);
    let an = reading::analyzers(&tools);
    let song_notes = notes::load(&notes::song_path(root, key));
    let mut claude: Vec<(String, String)> = reading::load_table(root, key)
        .map(|t| t.words.iter().filter_map(|w| w.candidates.claude.clone().map(|c| (w.word.clone(), c))).collect())
        .unwrap_or_default();
    for (w, r) in new_claude {
        claude.retain(|(x, _)| x != w);
        claude.push((w.clone(), r.clone()));
    }
    let shown = info.shown_title.clone().unwrap_or_else(|| key.to_string());
    let mut titles = vec![shown.clone()];
    if key != shown {
        titles.push(key.to_string());
    }
    let input = reading::Inputs {
        lines: lyric_lines(info),
        song_notes: &song_notes,
        title_reading: info.title_reading.clone().map(|r| (shown, r)),
        titles,
        annotations: annotations(info),
        claude,
    };
    let table = reading::build(an.as_deref(), &input);
    reading::save_table(root, key, &table)?;
    Ok(table)
}

/// 我在学唱页改了 / 确认了一个读音：记进这首歌的笔记（同一个词只留一条），是歌名就同步资料表，再重算读音表
pub fn save_reading(config: &Path, root: &Path, key: &str, word: &str, reading_text: &str) -> Result<Table, String> {
    let word = word.trim();
    let say = reading::to_hiragana(reading_text.trim());
    if word.is_empty() || say.is_empty() {
        return Err("词和读音都要填".into());
    }
    if !say.chars().all(|c| matches!(c, '\u{3041}'..='\u{309F}' | '\u{30A0}'..='\u{30FF}')) {
        return Err("读音只能写假名（ひらがな / カタカナ）或罗马字".into());
    }
    let romaji = reading::romaji(&say);
    let text = format!("读音：{word} = {say}（{}）", capitalize(&romaji));
    let path = notes::song_path(root, key);
    let existing = notes::load(&path).iter().position(|n| notes::reading_entry(&n.text).is_some_and(|(w, _)| w == word));
    let tag = format!("{} · 你在读音表里确认的", teacher::today()).trim_start_matches(" · ").to_string();
    match existing {
        Some(i) => notes::set(&path, i, &text)?,
        None => {
            notes::add(&path, Scope::Song, key, &text, &tag, None)?;
        }
    }
    teacher::sync_title_reading(config, root, key, word, &format!("{say}（{}）", capitalize(&romaji)))?;
    refresh_table(config, root, key)
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

// ---------------------------------------------------------------- 课程

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub name: String,
    pub lines: Vec<usize>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonLine {
    pub index: usize,
    pub text: String,
    pub meaning: String,
    pub tips: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub word: String,
    pub reason: String,
}

/// 程序按读音表改掉的地方
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    /// 在哪：「第 3 句难点」「总述」
    pub place: String,
    pub word: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lesson {
    pub schema: u32,
    pub created: String,
    /// 歌词变了要提示重新备课
    pub lyrics_hash: String,
    pub summary: String,
    pub sections: Vec<Section>,
    pub lines: Vec<LessonLine>,
    pub hardest: Vec<usize>,
    pub review: Vec<Review>,
    pub fixes: Vec<Fix>,
}

pub fn lesson_path(root: &Path, key: &str) -> PathBuf {
    root.join(format!("{}{LESSON_SUFFIX}", sanitize_file_stem(key)))
}

pub fn load_lesson(root: &Path, key: &str) -> Option<Lesson> {
    fs::read(lesson_path(root, key)).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

pub fn lyrics_hash(lines: &[String]) -> String {
    let h = Sha256::digest(lines.join("\n").as_bytes());
    h.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Claude 的回答格式（结构化输出）
fn lesson_schema() -> Value {
    let obj = |props: Value, req: &[&str]| json!({ "type": "object", "additionalProperties": false, "properties": props, "required": req });
    json!(obj(
        json!({
            "summary": { "type": "string", "description": "两三句话：这首歌讲什么、学的时候最该注意什么" },
            "sections": { "type": "array", "items": obj(json!({
                "name": { "type": "string" },
                "lines": { "type": "array", "items": { "type": "integer" } }
            }), &["name", "lines"]) },
            "lines": { "type": "array", "items": obj(json!({
                "index": { "type": "integer" },
                "meaning": { "type": "string", "description": "这句的意思，用我的语言" },
                "tips": { "type": "array", "items": { "type": "string" }, "description": "难点：连读、长音、促音、吞音、气口；最多三条，没有就空" }
            }), &["index", "meaning", "tips"]) },
            "hardest": { "type": "array", "items": { "type": "integer" } },
            "review": { "type": "array", "items": obj(json!({
                "word": { "type": "string" },
                "reason": { "type": "string" }
            }), &["word", "reason"]) },
            "readings": { "type": "array", "items": obj(json!({
                "word": { "type": "string" },
                "reading": { "type": "string", "description": "平假名" }
            }), &["word", "reading"]) }
        }),
        &["summary", "sections", "lines", "hardest", "review", "readings"]
    ))
}

fn ask_text(lines: &[String], table: &Table) -> String {
    let mut out = String::from("请给这首歌备课。歌词按句编号（从 0 开始）：\n");
    for (i, l) in lines.iter().enumerate() {
        out += &format!("{i}. {l}\n");
    }
    let unknown: Vec<&str> = table.words.iter().filter(|w| w.needs_review).map(|w| w.word.as_str()).collect();
    out += "\n要求：
- 把歌分成几段（每段 2–4 句），每句给意思和难点（连读、长音、促音、吞音、气口），标出最难的几句。
- 讲解里提到歌词的词或短语时写成「原文{读音}」，比如 夏実{かじつ}、花火{はなび}，原文前后用空格或标点和中文隔开；读音一律照系统提示里的读音表，表里标待确认的写成 原文{?}，不要自己定读音。不要再另外用括号注读音。
- readings：只列读音表里没有、又带汉字的词，给你认为的平假名读音（这些会标成待确认，由我确认）；表里有的不要列。
- review：哪些词的读音要我确认，每个给理由（表里待确认的都要列上）。
- 不要编造歌曲的发行、背景等资料里没有的事实。\n";
    if !unknown.is_empty() {
        out += &format!("\n读音表里待确认的词：{}\n", unknown.join("、"));
    }
    out
}

/// 把课程文字里旧写法「词（读音）」「词(读音)」的读音按读音表改正，返回改了哪些（`词{读音}` 归 marked::check 管）
pub fn fix_readings(text: &mut String, table: &Table, place: &str) -> Vec<Fix> {
    let mut fixes = Vec::new();
    for w in &table.words {
        for (open, close) in [('（', '）'), ('(', ')')] {
            let pat = format!("{}{open}", w.word);
            let mut from = 0;
            while let Some(i) = text[from..].find(&pat).map(|i| i + from) {
                let inner_start = i + pat.len();
                let Some(len) = text[inner_start..].find(close) else { break };
                let inner = text[inner_start..inner_start + len].to_string();
                let kana: String = inner.chars().take_while(|c| matches!(c, '\u{3041}'..='\u{309F}' | '\u{30A0}'..='\u{30FF}')).collect();
                let replacement = if w.needs_review { "读音待确认".to_string() } else { w.reading.clone() };
                // 表里待确认的词：课程不能替我定读音，一律改成「读音待确认」
                if !kana.is_empty() && (w.needs_review || reading::normalize(&kana) != reading::normalize(&w.reading)) {
                    let new_inner = inner.replacen(&kana, &replacement, 1);
                    text.replace_range(inner_start..inner_start + len, &new_inner);
                    fixes.push(Fix { place: place.to_string(), word: w.word.clone(), from: kana, to: replacement });
                }
                from = inner_start;
            }
        }
    }
    fixes
}

/// 日文新字体里和简体不一样、繁简转换又管不到的常见字
const SHINJITAI: &[(char, char)] = &[
    ('実', '实'), ('気', '气'), ('楽', '乐'), ('桜', '樱'), ('歩', '步'), ('浜', '滨'), ('涙', '泪'), ('広', '广'), ('戦', '战'),
    ('歳', '岁'), ('図', '图'), ('単', '单'), ('売', '卖'), ('読', '读'), ('鉄', '铁'), ('辺', '边'), ('変', '变'), ('様', '样'),
    ('関', '关'), ('駅', '驿'), ('黒', '黑'), ('険', '险'), ('験', '验'), ('転', '转'), ('伝', '传'), ('円', '圆'), ('応', '应'),
    ('価', '价'), ('処', '处'), ('済', '济'), ('児', '儿'), ('対', '对'), ('徳', '德'), ('発', '发'), ('払', '払'), ('仏', '佛'),
    ('満', '满'), ('薬', '药'), ('来', '来'), ('塁', '垒'), ('恋', '恋'), ('悪', '恶'), ('圧', '压'), ('囲', '围'), ('営', '营'),
];

fn simplified_like(s: &str) -> String {
    let mapped: String = s.chars().map(|c| SHINJITAI.iter().find(|(j, _)| *j == c).map_or(c, |(_, z)| *z)).collect();
    fast2s::convert(&mapped)
}

/// 歌名一律叫原文（通用笔记的第一条）：课程里把歌名写成简体的（夏実 → 夏实），改回原文
pub fn fix_title_spelling(text: &mut String, titles: &[String], place: &str) -> Vec<Fix> {
    let mut fixes = Vec::new();
    for t in titles {
        let simplified = simplified_like(t);
        if simplified != *t && text.contains(&simplified) {
            *text = text.replace(&simplified, t);
            fixes.push(Fix { place: place.to_string(), word: t.clone(), from: simplified, to: t.clone() });
        }
    }
    fixes
}

/// 备课被取消时 prepare 返回的错误（界面不显示它）
pub const PREPARE_CANCELLED: &str = "已取消备课";

/// 正在备课的记号：`<配置>/preparing/<歌名>.token`，里面是这一次备课的编号。
/// 取消 = 删掉它；Claude 回来时编号对不上（取消了，或已经重新开始了一次）就什么都不存。
/// 用文件不用内存：测试模式每个命令是一个单独的进程
fn prep_token_path(config: &Path, key: &str) -> PathBuf {
    config.join("preparing").join(format!("{}.token", crate::lyrics_store::sanitize_file_stem(key)))
}

struct PrepToken {
    path: PathBuf,
    id: String,
}

impl PrepToken {
    fn start(config: &Path, key: &str) -> PrepToken {
        let path = prep_token_path(config, key);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let id = format!("{}-{nanos}", std::process::id());
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(&path, &id);
        PrepToken { path, id }
    }

    fn current(&self) -> bool {
        fs::read_to_string(&self.path).is_ok_and(|s| s == self.id)
    }
}

impl Drop for PrepToken {
    fn drop(&mut self) {
        if self.current() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// 取消这首歌正在进行的备课：不再等，回来的结果不存，原来的课程保留
pub fn cancel_prepare(config: &Path, key: &str) {
    let _ = fs::remove_file(prep_token_path(config, key));
}

/// 备课：读音表 → Claude → 按表核对 → 存 `<歌名>.lesson.json`
pub fn prepare(config: &Path, root: &Path, key: &str, language: &str) -> Result<Lesson, String> {
    let token = PrepToken::start(config, key);
    let info = teacher::song_info(root, key);
    let lines = lyric_lines(&info);
    if lines.is_empty() {
        return Err("这首歌还没有歌词，先导入或粘贴歌词再备课".into());
    }
    let table = refresh_with(config, root, key, &info, &[])?;
    let system = teacher::system_blocks(language, &notes::load_global(config), &info, &notes::load(&notes::song_path(root, key)), &table);
    let body = json!({
        "model": ai::CLAUDE_MODEL,
        "max_tokens": 16000,
        "output_config": { "effort": "medium", "format": { "type": "json_schema", "schema": lesson_schema() } },
        "system": system,
        "messages": [{ "role": "user", "content": ask_text(&lines, &table) }],
    });
    let reply = ai::claude_post(config, &body, 300)?;
    if !token.current() {
        return Err(PREPARE_CANCELLED.into());
    }
    if reply.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        return Err("老师这次没有备课，换个时间再试".into());
    }
    let (text, _) = ai::parse_claude(&reply)?;
    let raw: Value = serde_json::from_str(&text).map_err(|_| "老师给的课程格式不对，再备一次".to_string())?;

    // Claude 给的读音：只补进表里（最低一级，一律待确认）
    let claude: Vec<(String, String)> = raw["readings"]
        .as_array()
        .map(|a| a.iter().filter_map(|r| Some((r["word"].as_str()?.trim().to_string(), r["reading"].as_str()?.trim().to_string()))).collect())
        .unwrap_or_default();
    let table = refresh_with(config, root, key, &info, &claude)?;

    let mut lesson = Lesson {
        schema: 1,
        created: teacher::today(),
        lyrics_hash: lyrics_hash(&lines),
        summary: raw["summary"].as_str().unwrap_or("").to_string(),
        ..Default::default()
    };
    let ints = |v: &Value| -> Vec<usize> { v.as_array().map(|a| a.iter().filter_map(Value::as_u64).map(|n| n as usize).filter(|n| *n < lines.len()).collect()).unwrap_or_default() };
    lesson.sections = raw["sections"]
        .as_array()
        .map(|a| a.iter().map(|s| Section { name: s["name"].as_str().unwrap_or("").to_string(), lines: ints(&s["lines"]) }).collect())
        .unwrap_or_default();
    lesson.hardest = ints(&raw["hardest"]);
    lesson.lines = raw["lines"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| {
                    let index = l["index"].as_u64()? as usize;
                    let text = lines.get(index)?.clone();
                    let tips = l["tips"].as_array().map(|t| t.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
                    Some(LessonLine { index, text, meaning: l["meaning"].as_str().unwrap_or("").to_string(), tips })
                })
                .collect()
        })
        .unwrap_or_default();
    lesson.review = raw["review"]
        .as_array()
        .map(|a| a.iter().filter_map(|r| Some(Review { word: r["word"].as_str()?.to_string(), reason: r["reason"].as_str().unwrap_or("").to_string() })).collect())
        .unwrap_or_default();
    // 表里待确认、Claude 却没列的，补上
    for w in table.words.iter().filter(|w| w.needs_review) {
        if !lesson.review.iter().any(|r| r.word == w.word) {
            lesson.review.push(Review { word: w.word.clone(), reason: w.reasons.join("；") });
        }
    }

    // 按读音表核对课程里写的读音；歌名写成简体的改回原文
    // 只管歌名（通用笔记「歌名一律叫原文」）；歌词里的地名人名翻成中文照常
    let titles = vec![info.shown_title.clone().unwrap_or_else(|| key.to_string())];
    let an = reading::analyzers(&reading::tools_dir(config));
    let check = |text: &mut String, place: &str| {
        let (marked, mut f) = super::marked::check(text, &table, an.as_deref(), place);
        *text = marked;
        f.extend(fix_readings(text, &table, place));
        f.extend(fix_title_spelling(text, &titles, place));
        f
    };
    let mut fixes = check(&mut lesson.summary, "总述");
    for l in &mut lesson.lines {
        fixes.extend(check(&mut l.meaning, &format!("第 {} 句意思", l.index + 1)));
        for t in &mut l.tips {
            fixes.extend(check(t, &format!("第 {} 句难点", l.index + 1)));
        }
    }
    for r in &mut lesson.review {
        let place = format!("「{}」的说明", r.word);
        fixes.extend(check(&mut r.reason, &place));
    }
    lesson.fixes = fixes;
    // 偶尔拿到空课程（没有总述也没有逐句）：当失败，不覆盖原来的课程；原始回复留一份，好查原因（里面没有 key）
    if lesson.summary.trim().is_empty() && lesson.lines.is_empty() {
        let _ = fs::write(config.join(LAST_EMPTY_REPLY), serde_json::to_vec_pretty(&reply).unwrap_or_default());
        return Err("老师这次给的课程是空的，没有保存，原来的课程还在。再点一次「备课」".into());
    }
    if !token.current() {
        return Err(PREPARE_CANCELLED.into());
    }
    fs::write(lesson_path(root, key), serde_json::to_vec_pretty(&lesson).map_err(|e| e.to_string())?).map_err(|e| format!("保存课程失败：{e}"))?;
    Ok(lesson)
}

/// 学唱页要的：读音表、课程、词典装没装、歌词（按句）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnView {
    pub key: String,
    pub lines: Vec<String>,
    pub table: Table,
    pub lesson: Option<Lesson>,
    /// 课程是按旧歌词备的
    pub lesson_stale: bool,
    pub dict: reading::DictStatus,
    /// 这首歌要不要标日语读音（不是日语歌就不提示装词典、不列待确认）
    pub japanese: bool,
}

pub fn view(config: &Path, root: &Path, key: &str) -> Result<LearnView, String> {
    let info = teacher::song_info(root, key);
    let lines = lyric_lines(&info);
    let table = refresh_with(config, root, key, &info, &[])?;
    let lesson = load_lesson(root, key);
    let lesson_stale = lesson.as_ref().is_some_and(|l| l.lyrics_hash != lyrics_hash(&lines));
    Ok(LearnView { key: key.to_string(), lines, table, lesson, lesson_stale, dict: reading::dict_status(&reading::tools_dir(config)), japanese: wants_japanese(&info) })
}

/// 资料表里的视频标题（下载视频时写的 `source.videoTitle`）
pub fn video_title(meta: &songmeta::SongMeta) -> Option<String> {
    meta.fields.get("source").and_then(|s| s.get("videoTitle")).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reading::{Reading, Source};

    #[test]
    fn cancel_and_restart_prepare() {
        let d = tempfile::tempdir().unwrap();
        let a = PrepToken::start(d.path(), "夏実");
        assert!(a.current());
        cancel_prepare(d.path(), "夏実");
        assert!(!a.current(), "取消后这一次不能存");
        // 取消后马上重新备课：旧的那次回来也不能存，新的可以
        let a = PrepToken::start(d.path(), "夏実");
        let b = PrepToken::start(d.path(), "夏実");
        assert!(!a.current() && b.current());
        drop(a);
        assert!(b.current(), "旧的那次结束时不能删掉新的记号");
        drop(b);
        assert!(!prep_token_path(d.path(), "夏実").exists());
    }

    #[test]
    fn only_japanese_songs_get_readings() {
        let song = |lang: Option<&str>, lyrics: &str| SongInfo { lang: lang.map(str::to_string), lyrics: Some(lyrics.into()), ..Default::default() };
        assert!(wants_japanese(&song(Some("日语"), "夏実")));
        assert!(!wants_japanese(&song(Some("国语"), "寂寞先生")));
        assert!(!wants_japanese(&song(Some("粤语"), "")));
        // 没写语种：看歌词里有没有假名
        assert!(wants_japanese(&song(None, "夏の終わりに")));
        assert!(!wants_japanese(&song(None, "今天下雨了没带伞")));
    }

    fn word(w: &str, r: &str, review: bool) -> Reading {
        let mut t = reading::build(None, &reading::Inputs { claude: vec![(w.into(), r.into())], ..Default::default() }).words.remove(0);
        t.needs_review = review;
        t.source = if review { Source::Claude } else { Source::Note };
        t
    }

    #[test]
    fn lesson_readings_follow_the_table() {
        let table = Table { schema: 1, analyzers: None, words: vec![word("夏実", "かじつ", false), word("花火", "はなび", false), word("君影", "きみかげ", true)] };
        let mut s = "「夏実（なつみ）」是歌名，花火(はなび)照常，君影（きみかげ）不确定，夏実{かじつ}已对。".to_string();
        let fixes = fix_readings(&mut s, &table, "总述");
        assert_eq!(s, "「夏実（かじつ）」是歌名，花火(はなび)照常，君影（读音待确认）不确定，夏実{かじつ}已对。");
        assert_eq!(fixes.len(), 2);
        assert_eq!((fixes[0].word.as_str(), fixes[0].from.as_str(), fixes[0].to.as_str()), ("夏実", "なつみ", "かじつ"));
    }

    #[test]
    fn title_stays_in_original_spelling() {
        let mut s = "夏实的烟花在天空中绽放。".to_string();
        let fixes = fix_title_spelling(&mut s, &["夏実".to_string(), "花火".to_string()], "第 1 句意思");
        assert_eq!(s, "夏実的烟花在天空中绽放。");
        assert_eq!((fixes.len(), fixes[0].from.as_str(), fixes[0].to.as_str()), (1, "夏实", "夏実"));
    }

    #[test]
    fn save_reading_writes_note_and_table() {
        let config = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let (c, r) = (config.path(), root.path());
        reading::set_tools_dir(c.join("no-tools"));
        fs::write(r.join("夏実 - 伴奏.wav"), b"").unwrap();
        fs::write(r.join("夏実.lrc"), "[00:01.00]夏実の花火\n").unwrap();
        let t = save_reading(c, r, "夏実", "夏実", "kajitsu").unwrap();
        assert_eq!(t.get("夏実").map(|w| (w.reading.as_str(), w.source)), Some(("かじつ", Source::Note)));
        let n = notes::load(&notes::song_path(r, "夏実"));
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].text, "读音：夏実 = かじつ（Kajitsu）");
        // 再改一次：同一个词只留一条
        save_reading(c, r, "夏実", "夏実", "なつみ").unwrap();
        assert_eq!(notes::load(&notes::song_path(r, "夏実")).len(), 1);
        assert_eq!(songmeta::read(r, "夏実").unwrap().unwrap().text("titleReading"), Some("なつみ（Natsumi）"));
        assert!(save_reading(c, r, "夏実", "夏実", "夏").is_err());
        assert!(table_has_file(r));
    }

    fn table_has_file(r: &Path) -> bool {
        reading::table_path(r, "夏実").is_file()
    }
}
