//! 歌曲标签（歌手 / 语种 / 年代）和自建歌单。
//!
//! - 标签和歌单存在应用配置目录的 tags.json（前端用 load_store / save_store 读写）：
//!   { "songs": { "<歌名编号>": { "artist", "lang", "era", "manual": ["lang", ...] } },
//!     "playlists": [ { "id", "name", "songs": ["<歌名编号>", ...] } ] }
//!   手动改过的字段记在 manual 里，AI 重跑不会覆盖。
//! - 「常点」不是 AI 猜的：电视每点一首记一次，存在 plays.json（{ "<歌名编号>": 次数 }）。
//! - AI 用 Claude Haiku 批量猜。API key 单独存在配置目录的 ai.json（只有本人可读），
//!   不进设置、不进日志、不回传给界面；发给 API 的只有歌名、已有的歌手名、歌词前几句。

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};

const MODEL: &str = "claude-sonnet-5-5";
const KEY_FILE: &str = "ai.json";
const BATCH: usize = 6;

pub const LANGS: &[&str] = &["国语", "粤语", "英文", "日语", "韩语", "其他"];
pub const ERAS: &[&str] = &["更早", "70s", "80s", "90s", "00s", "10s", "20s"];

pub fn has_key(dir: &Path) -> bool {
    read_key(dir).is_some()
}

fn read_key(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join(KEY_FILE)).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("apiKey")?.as_str().map(str::trim).filter(|k| !k.is_empty()).map(str::to_string)
}

pub fn save_key(dir: &Path, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        let _ = fs::remove_file(dir.join(KEY_FILE));
        return Ok(());
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '\\') {
        return Err("API key 里有不该有的字符，请重新复制".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(KEY_FILE);
    fs::write(&path, serde_json::to_vec(&json!({ "apiKey": key })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Deserialize)]
pub struct AskSong {
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    /// 歌词前几句（已去掉时间标记）
    pub lyrics: Option<String>,
    /// 视频来源（YouTube 标题、频道名），下载视频后自动打标签时带上
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Guess {
    pub id: String,
    pub artist: Option<String>,
    pub lang: Option<String>,
    pub era: Option<String>,
    /// 一句话背景：原唱是谁、哪张专辑 / 哪部影视、哪年发行
    pub note: Option<String>,
    /// 原曲名（去掉歌名里的歌手名和版本说明），搜歌词用
    pub track: Option<String>,
    /// 歌手的其他写法（英文名、拼音、本名），逗号隔开；歌词库常用英文名登记中文歌手
    pub aliases: Option<String>,
}

/// 用户手动改过的歌，当范例给 AI 看（AI 照着用户的口味判断）
#[derive(Debug, Clone, Serialize)]
pub struct Example {
    pub title: String,
    pub artist: Option<String>,
    pub lang: Option<String>,
    pub era: Option<String>,
}

/// LRC 歌词取前几句（去时间标记和空行），最多 max 句、每句最多 40 字
pub fn lyrics_snippet(lrc: &str, max: usize) -> String {
    crate::tv::lrc_lines(lrc).into_iter().map(|(_, t)| t.chars().take(40).collect::<String>()).take(max).collect::<Vec<_>>().join(" / ")
}

fn prompt(songs: &[AskSong], examples: &[Example]) -> String {
    let list: Vec<Value> = songs.iter().map(|s| json!({ "id": s.id, "歌名": s.title, "已知歌手": s.artist, "歌词开头": s.lyrics, "视频来源": s.hint })).collect();
    let ex = if examples.is_empty() {
        String::new()
    } else {
        format!("\n下面是用户亲手确认过的标签，请照着他的口味和写法判断（歌手的写法、年代怎么分）：\n{}\n", serde_json::to_string(examples).unwrap_or_default())
    };
    format!(
        "下面是家庭 KTV 曲库里的歌。歌名里常常带着歌手名（例如「几分之几 卢广仲」「The Door Teddy Swims」）。\n\
         必须对每一首歌都用 web_search 工具联网搜索（歌名 + 歌手），不许凭记忆回答；查清楚它的来龙去脉，再判断：\n\
         - artist：原唱歌手（用常见的中文或英文名；查不到就留空字符串）\n\
         - lang：演唱语种，只能是 {}\n\
         - era：这首歌首次发行的年代，只能是 {} 或「未知」（以查到的发行年份为准，不要凭感觉）\n\
         - note：一句话背景（60 字以内）：原唱、所属专辑或影视作品、发行年份、有没有翻唱版本；查不到就写空字符串\n\
         - track：原曲名，去掉歌名里的歌手名和版本说明（如 Neo Soul Reimagined、伴奏、Official MV），用来搜歌词；拿不准就留空字符串\n\
         - aliases：歌手的其他写法（官方英文名、拼音、本名），用逗号隔开，用来在国外歌词库里找歌；没有就留空字符串\n\
         如果同名歌曲有多个版本，以歌名里的歌手 / 已知歌手为准。{ex}\n\
         最后只输出一个 JSON，不要任何别的文字：{{\"songs\":[{{\"id\":\"原样返回\",\"artist\":\"\",\"lang\":\"\",\"era\":\"\",\"note\":\"\"}}]}}\n\n{}",
        LANGS.join("、"),
        ERAS.join("、"),
        serde_json::to_string(&list).unwrap_or_default()
    )
}

/// 回复里取最后一个 text 块，再从里面抠出 JSON（模型有时会包一层 ```）
fn reply_json(reply: &Value) -> Result<Value, String> {
    if reply.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        return Err("AI 这次没有回答".into());
    }
    // 联网搜索的回答会被切成好几个 text 块（带引用），要拼起来；JSON 是最后出现的那段
    let text: String = reply
        .get("content")
        .and_then(Value::as_array)
        .ok_or("AI 的回复里没有内容")?
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    if text.is_empty() {
        return Err("AI 的回复里没有内容".into());
    }
    let start = text.rfind("\"songs\"").and_then(|i| text[..i].rfind('{'));
    let (a, b) = (start, text.rfind('}'));
    match (a, b) {
        (Some(a), Some(b)) if a < b => serde_json::from_str(&text[a..=b]).map_err(|_| "AI 的回复格式不对".to_string()),
        _ => Err("AI 的回复格式不对".into()),
    }
}

/// 解析 Messages API 的回复，只保留合法的取值
pub fn parse_reply(reply: &Value, asked: &[AskSong]) -> Result<Vec<Guess>, String> {
    let parsed = reply_json(reply)?;
    let items = parsed.get("songs").and_then(Value::as_array).ok_or("AI 的回复格式不对")?;
    let mut out = Vec::new();
    for item in items {
        let id = item.get("id").and_then(Value::as_str).unwrap_or_default();
        if !asked.iter().any(|s| s.id == id) {
            continue;
        }
        let pick = |k: &str, allowed: &[&str]| item.get(k).and_then(Value::as_str).filter(|v| allowed.contains(v)).map(str::to_string);
        let text = |k: &str, n: usize| item.get(k).and_then(Value::as_str).map(|a| a.trim().chars().take(n).collect::<String>()).filter(|a| !a.is_empty());
        out.push(Guess { id: id.to_string(), artist: text("artist", 40), lang: pick("lang", LANGS), era: pick("era", ERAS), note: text("note", 120), track: text("track", 80), aliases: text("aliases", 80) });
    }
    Ok(out)
}

/// curl 配置文件里双引号字符串的转义
fn curl_quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t")
}

/// 问一批（最多 BATCH 首）。用系统自带的 curl，key 和内容都通过标准输入的配置传，不会出现在进程列表里
fn ask_batch(key: &str, songs: &[AskSong], examples: &[Example]) -> Result<Vec<Guess>, String> {
    let mut messages = vec![json!({ "role": "user", "content": prompt(songs, examples) })];
    // 联网搜索在服务器那边跑；搜索太久服务器会先停一下（pause_turn），把已有内容原样回传让它接着查
    for _ in 0..5 {
        let body = json!({
            "model": MODEL,
            "max_tokens": 16000,
            "output_config": { "effort": "medium" },
            "tools": [{ "type": "web_search_20260209", "name": "web_search", "max_uses": songs.len() * 2 + 2 }],
            "messages": messages,
        });
        let reply = call(key, &body)?;
        let searched = reply.pointer("/usage/server_tool_use/web_search_requests").and_then(Value::as_u64).unwrap_or(0);
        if reply.get("stop_reason").and_then(Value::as_str) == Some("end_turn") && searched == 0 {
            return Err("AI 这次没有联网查资料，结果不可靠，没有保存，请再试一次".into());
        }
        if reply.get("stop_reason").and_then(Value::as_str) == Some("pause_turn") {
            messages.push(json!({ "role": "assistant", "content": reply.get("content").cloned().unwrap_or(Value::Null) }));
            continue;
        }
        return parse_reply(&reply, songs);
    }
    Err("查得太久了，稍后再试".into())
}

fn call(key: &str, body: &Value) -> Result<Value, String> {
    let body = serde_json::to_string(body).map_err(|e| e.to_string())?;
    let config = format!(
        "url = \"https://api.anthropic.com/v1/messages\"\nheader = \"x-api-key: {}\"\nheader = \"anthropic-version: 2023-06-01\"\nheader = \"content-type: application/json\"\ndata = \"{}\"\n",
        curl_quote(key),
        curl_quote(&body)
    );
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "--max-time", "300", "-K", "-"])
        .args(crate::net::dns_curl_args("https://api.anthropic.com"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("没法联网：{e}"))?;
    child.stdin.take().ok_or("没法联网")?.write_all(config.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("连不上 Claude 服务，请检查网络".into());
    }
    let reply: Value = serde_json::from_slice(&out.stdout).map_err(|_| "Claude 服务的回复看不懂".to_string())?;
    if let Some(err) = reply.get("error") {
        let kind = err.get("type").and_then(Value::as_str).unwrap_or("");
        let msg = err.get("message").and_then(Value::as_str).unwrap_or("");
        return Err(match kind {
            "authentication_error" | "permission_error" => "API key 不对或没有权限，请重新填写".into(),
            "rate_limit_error" => "请求太频繁了，等一会儿再试".into(),
            "overloaded_error" => "Claude 服务现在很忙，稍后再试".into(),
            _ if msg.contains("credit") => "API 账户余额不足".into(),
            _ if msg.contains("web_search") || msg.contains("web search") => "这个账号没开联网搜索，请到 Anthropic 控制台的设置里打开".into(),
            _ => format!("Claude 服务出错（{kind}）"),
        });
    }
    Ok(reply)
}

/// 给一批歌打标签，每 BATCH 首问一次；`on_progress(已完成, 总数)`
pub fn guess_all(dir: &Path, songs: &[AskSong], examples: &[Example], mut on_progress: impl FnMut(usize, usize)) -> Result<Vec<Guess>, String> {
    let key = read_key(dir).ok_or("还没有填 Claude API key")?;
    let mut all = Vec::new();
    for (n, chunk) in songs.chunks(BATCH).enumerate() {
        on_progress(n * BATCH, songs.len());
        all.extend(ask_batch(&key, chunk, examples)?);
    }
    on_progress(songs.len(), songs.len());
    Ok(all)
}

// ---------- 歌词（LRCLIB：开放的带时间轴歌词库）----------

/// 比对用：去掉标点和空白，英文转小写，繁体转简体
fn norm(s: &str) -> String {
    fast2s::convert(s).chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

/// 搜索结果里歌名、歌手都对得上、带时间轴的歌词：(歌词, 时长, 登记的歌手)。artist 为空 = 不看歌手
fn matching(results: &Value, track: &str, artist: &str) -> Vec<(String, Option<f64>, String)> {
    let want_track = norm(track);
    let want_artist = norm(artist);
    if want_track.chars().count() < 2 {
        return Vec::new();
    }
    results
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let lrc = r.get("syncedLyrics").and_then(Value::as_str).map(str::trim).filter(|l| !l.is_empty())?;
            if r.get("instrumental").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            let t = norm(r.get("trackName").and_then(Value::as_str)?);
            if t != want_track && !(t.chars().count() >= 3 && (t.contains(&want_track) || want_track.contains(&t))) {
                return None;
            }
            let a = norm(r.get("artistName").and_then(Value::as_str).unwrap_or_default());
            if !want_artist.is_empty() && !a.is_empty() && !a.contains(&want_artist) && !want_artist.contains(&a) {
                return None;
            }
            Some((lrc.to_string(), r.get("duration").and_then(Value::as_f64), r.get("artistName").and_then(Value::as_str).unwrap_or_default().to_string()))
        })
        .collect()
}

/// 从搜索结果里挑一个合适的：要有带时间轴的歌词、歌名对得上、（知道的话）歌手对得上、时长差不超过 8 秒。
/// 一个都不合适就返回 None（宁可空着，也不要配错歌词）
pub fn pick_lrc(results: &Value, track: &str, artist: &str, duration: Option<f64>) -> Option<String> {
    let all = matching(results, track, artist);
    let Some(want) = duration.filter(|d| *d > 0.0) else { return all.into_iter().next().map(|(l, ..)| l) };
    // 时长差 8 秒以内的里面挑最接近的；不知道时长的排在最后
    all.into_iter()
        .filter(|(_, got, _)| got.is_none_or(|g| (want - g).abs() <= 8.0))
        .min_by(|a, b| {
            let d = |x: &Option<f64>| x.map_or(f64::MAX, |g| (want - g).abs());
            d(&a.1).total_cmp(&d(&b.1))
        })
        .map(|(l, ..)| l)
}

/// 一份候选歌词：要按这首的人声用智能对齐核对过才能用
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LrcCandidate {
    pub lrc: String,
    /// 那份歌词的时长 - 这首的时长（秒）；不知道就是 None
    pub diff: Option<f64>,
    /// 歌词库里登记的歌手
    pub artist: String,
    /// 是不是同一位歌手（含别名）
    pub same_artist: bool,
}

/// 搜到的歌词：同一位歌手（含别名）、时长差 ≤ 8 秒的直接用；
/// 其余的（时长对不上的剪辑版 / 改编版，或者别的歌手登记的同名歌）都只是候选，要按人声对齐核对
#[derive(Debug, Clone, PartialEq)]
pub enum LrcPick {
    Exact(String),
    /// 最多 3 份，同一歌手的排前面，再按时长接近排
    Verify(Vec<LrcCandidate>),
}

const MAX_CANDIDATES: usize = 3;

/// 歌手对不对得上：歌手或任一别名（去标点、繁简、大小写后）互相包含
pub fn artist_matches(name: &str, artist: &str, aliases: &[String]) -> bool {
    let n = norm(name);
    !n.is_empty()
        && std::iter::once(artist).chain(aliases.iter().map(String::as_str)).map(norm).filter(|a| !a.is_empty()).any(|a| n.contains(&a) || a.contains(&n))
}

/// 从（可能是几次搜索拼起来的）结果里挑：歌名对得上的才算；同一歌手 + 时长 ≤ 8 秒 → 直接用；否则给候选
pub fn choose_lrc(results: &[Value], track: &str, artist: &str, aliases: &[String], duration: Option<f64>) -> Option<LrcPick> {
    let want = duration.filter(|d| *d > 0.0);
    let mut seen = std::collections::HashSet::new();
    let mut all: Vec<(String, Option<f64>, String, bool)> = Vec::new();
    for r in results {
        for (lrc, dur, name) in matching(r, track, "") {
            if seen.insert(lrc.clone()) {
                let same = artist_matches(&name, artist, aliases);
                all.push((lrc, dur, name, same));
            }
        }
    }
    if all.is_empty() {
        return None;
    }
    // 同一歌手、时长对得上：直接用（时长最接近的那份；不知道这首多长就用第一份）
    let exact = match want {
        Some(w) => all.iter().filter(|(_, d, _, same)| *same && d.is_some_and(|d| (w - d).abs() <= 8.0)).min_by(|a, b| (w - a.1.unwrap()).abs().total_cmp(&(w - b.1.unwrap()).abs())),
        None => all.iter().find(|(_, _, _, same)| *same),
    };
    if let Some((lrc, ..)) = exact {
        return Some(LrcPick::Exact(lrc.clone()));
    }
    // 候选：时长写错（最后一句比自己说的时长还晚）的不要；同一歌手优先，再按时长接近
    let mut cands: Vec<LrcCandidate> = all
        .into_iter()
        .filter(|(lrc, d, ..)| d.is_none_or(|g| crate::tv::lrc_lines(lrc).last().is_none_or(|(l, _)| *l <= g + 5.0)))
        .map(|(lrc, d, name, same)| LrcCandidate { diff: match (d, want) {
            (Some(d), Some(w)) => Some(d - w),
            _ => None,
        }, lrc, artist: name, same_artist: same })
        .collect();
    cands.sort_by(|a, b| b.same_artist.cmp(&a.same_artist).then(a.diff.map_or(f64::MAX, f64::abs).total_cmp(&b.diff.map_or(f64::MAX, f64::abs))));
    cands.truncate(MAX_CANDIDATES);
    (!cands.is_empty()).then_some(LrcPick::Verify(cands))
}

/// 问一次 LRCLIB 搜索接口。params 例如 [("track_name", "年轮"), ("artist_name", "汪苏泷")] 或 [("q", "年轮")]
fn lrclib_search(params: &[(&str, &str)]) -> Result<Value, String> {
    let mut args: Vec<String> = ["-sS", "-G", "--max-time", "20", "-A", "BanzouLyrics/0.3"].map(String::from).to_vec();
    for (k, v) in params {
        args.push("--data-urlencode".into());
        args.push(format!("{k}={v}"));
    }
    args.push("https://lrclib.net/api/search".into());
    args.extend(crate::net::dns_curl_args("https://lrclib.net"));
    let out = Command::new("/usr/bin/curl").args(&args).output().map_err(|e| format!("没法联网：{e}"))?;
    if !out.status.success() {
        return Err("连不上歌词库".into());
    }
    serde_json::from_slice(&out.stdout).map_err(|_| "歌词库的回复看不懂".to_string())
}

/// 搜歌词（资料检查「AI 搜歌词」和 AI 补资料用）：
/// 1. 歌名 + 歌手、歌名 + 每个别名（歌词库常把中文歌手登记成英文名）
/// 2. 同一歌手里有时长对得上的就直接用；没有就再只用歌名搜（q=歌名），把候选交给前端按人声核对
pub fn fetch_lrc_any(artist: &str, aliases: &[String], track: &str, duration: Option<f64>) -> Result<Option<LrcPick>, String> {
    let mut results = Vec::new();
    for name in std::iter::once(artist).chain(aliases.iter().map(String::as_str).take(2)).filter(|a| !a.trim().is_empty()) {
        results.push(lrclib_search(&[("track_name", track), ("artist_name", name)])?);
    }
    if let Some(LrcPick::Exact(l)) = choose_lrc(&results, track, artist, aliases, duration) {
        return Ok(Some(LrcPick::Exact(l)));
    }
    results.push(lrclib_search(&[("q", track)])?);
    Ok(choose_lrc(&results, track, artist, aliases, duration))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asked() -> Vec<AskSong> {
        vec![AskSong { id: "a1".into(), title: "几分之几 卢广仲".into(), artist: None, lyrics: None, hint: None }]
    }

    #[test]
    fn parses_valid_reply_and_drops_bad_values() {
        let text = r#"{"songs":[{"id":"a1","artist":"卢广仲","lang":"国语","era":"10s"},{"id":"zz","artist":"x","lang":"国语","era":"10s"}]}"#;
        let reply = json!({ "content": [{ "type": "thinking", "thinking": "" }, { "type": "text", "text": text }] });
        let g = parse_reply(&reply, &asked()).unwrap();
        assert_eq!(g, vec![Guess { id: "a1".into(), artist: Some("卢广仲".into()), lang: Some("国语".into()), era: Some("10s".into()), note: None, track: None, aliases: None }]);
        let weird = json!({ "content": [{ "type": "text", "text": r#"{"songs":[{"id":"a1","artist":"","lang":"火星语","era":"未知"}]}"# }] });
        assert_eq!(parse_reply(&weird, &asked()).unwrap(), vec![Guess { id: "a1".into(), artist: None, lang: None, era: None, note: None, track: None, aliases: None }]);
    }

    #[test]
    fn json_inside_code_fence_and_after_search_blocks() {
        let text = "查到了。\n```json\n{\"songs\":[{\"id\":\"a1\",\"artist\":\"卢广仲\",\"lang\":\"国语\",\"era\":\"10s\",\"note\":\"2014 年专辑《100 种生活》\"}]}\n```";
        let reply = json!({ "content": [{ "type": "server_tool_use" }, { "type": "web_search_tool_result", "content": [] }, { "type": "text", "text": text }] });
        let g = parse_reply(&reply, &asked()).unwrap();
        assert_eq!(g[0].note.as_deref(), Some("2014 年专辑《100 种生活》"));
        assert_eq!(g[0].era.as_deref(), Some("10s"));
    }

    #[test]
    fn lyrics_only_when_it_really_matches() {
        let r = json!([
            { "trackName": "几分之几", "artistName": "别人", "duration": 200.0, "syncedLyrics": "[00:01.00]错歌手" },
            { "trackName": "Other Song", "artistName": "卢广仲", "duration": 200.0, "syncedLyrics": "[00:01.00]错歌名" },
            { "trackName": "几分之几", "artistName": "盧廣仲", "duration": 300.0, "syncedLyrics": "[00:01.00]错时长" },
            { "trackName": "几分之几", "artistName": "盧廣仲", "duration": 203.0, "syncedLyrics": null },
            { "trackName": "几分之几", "artistName": "盧廣仲", "duration": 203.0, "syncedLyrics": "[00:01.00]对了" }
        ]);
        assert_eq!(pick_lrc(&r, "几分之几", "卢广仲", Some(200.0)).as_deref(), Some("[00:01.00]对了"));
        assert_eq!(pick_lrc(&r, "几分之几", "卢广仲", Some(100.0)), None);
        assert_eq!(pick_lrc(&r, "我", "", None), None);
        assert_eq!(pick_lrc(&json!([]), "几分之几", "卢广仲", None), None);
    }

    fn entry(track: &str, artist: &str, dur: f64, lrc: &str) -> Value {
        json!({ "trackName": track, "artistName": artist, "duration": dur, "syncedLyrics": lrc })
    }

    #[test]
    fn same_artist_within_8s_is_used_directly_closest_wins() {
        let r = json!([entry("Abc Song", "X", 295.0, "[00:01.00]远"), entry("Abc Song", "X", 289.0, "[00:01.00]近"), entry("Abc Song", "Y", 288.0, "[00:01.00]别人")]);
        assert_eq!(pick_lrc(&r, "Abc Song", "X", Some(288.0)).as_deref(), Some("[00:01.00]近"));
        assert_eq!(choose_lrc(&[r], "Abc Song", "X", &[], Some(288.0)), Some(LrcPick::Exact("[00:01.00]近".into())));
    }

    #[test]
    fn other_artist_or_length_mismatch_only_as_candidates() {
        // 歌词库把中文歌手登记成英文名；还有别的歌手唱的同名歌、时长写错的
        let by_title = json!([
            entry("年轮", "黄雅莉", 229.8, "[00:01.00]黄"),
            entry("年轮", "Silence Wang", 245.0, "[00:01.00]汪"),
            entry("年轮", "张碧晨", 274.0, "[00:01.00]张"),
            entry("年轮", "某人", 200.0, "[00:01.00]a\n[05:00.00]写错时长"),
            entry("别的歌", "Silence Wang", 232.0, "[00:01.00]不是这首")
        ]);
        // 没有别名：同名的别人唱的哪怕时长对得上也不直接用，只给候选（按时长接近排，最多 3 份）
        let Some(LrcPick::Verify(c)) = choose_lrc(std::slice::from_ref(&by_title), "年轮", "汪苏泷", &[], Some(232.6)) else { panic!() };
        assert_eq!(c.iter().map(|x| x.artist.as_str()).collect::<Vec<_>>(), ["黄雅莉", "Silence Wang", "张碧晨"]);
        assert!(c.iter().all(|x| !x.same_artist));
        assert_eq!(c[0].diff.map(|d| (d * 10.0).round() / 10.0), Some(-2.8));
        // 有别名：同一歌手排第一；时长差 12 秒，所以还是候选
        let Some(LrcPick::Verify(c)) = choose_lrc(&[json!([]), by_title.clone()], "年轮", "汪苏泷", &["Silence Wang".into()], Some(232.6)) else { panic!() };
        assert_eq!((c[0].artist.as_str(), c[0].same_artist), ("Silence Wang", true));
        // 别名 + 时长对得上：直接用
        assert_eq!(choose_lrc(&[by_title], "年轮", "汪苏泷", &["silence wang".into()], Some(247.0)), Some(LrcPick::Exact("[00:01.00]汪".into())));
        assert_eq!(choose_lrc(&[json!([])], "年轮", "汪苏泷", &[], Some(232.6)), None);
    }

    #[test]
    fn artist_alias_matching() {
        assert!(artist_matches("盧廣仲", "卢广仲", &[]));
        assert!(artist_matches("Silence Wang", "汪苏泷", &["Silence Wang".into()]));
        assert!(!artist_matches("Silence Wang", "汪苏泷", &[]));
        assert!(!artist_matches("", "汪苏泷", &[]));
    }

    #[test]
    fn refusal_and_garbage_are_errors() {
        assert!(parse_reply(&json!({ "stop_reason": "refusal", "content": [] }), &asked()).is_err());
        assert!(parse_reply(&json!({ "content": [{ "type": "text", "text": "hi" }] }), &asked()).is_err());
    }

    #[test]
    fn curl_quote_escapes() {
        assert_eq!(curl_quote("a\"b\\c\n"), "a\\\"b\\\\c\\n");
    }

    #[test]
    fn snippet_is_short() {
        assert_eq!(lyrics_snippet("[00:01.0]第一句\n[00:05.0]第二句\n[00:09.0]第三句", 2), "第一句 / 第二句");
    }
}
