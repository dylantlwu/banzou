//! 外语学唱用的 AI 和语音（PRD 4.12）：Claude 当老师，豆包语音合成让老师开口说话。
//!
//! - Claude API key 和标签功能共用配置目录的 ai.json（由 `tags::save_key` 写入，这里只读）
//! - 豆包的 APP ID / Access Token / 音色 / 语速存在 tts.json（只有本人可读）
//! - key 不回传界面，只给末四位；请求用系统 curl，key 和内容通过标准输入的配置传，不出现在进程列表里
//! - 发出去的只有文字：给 Claude 的问题、给豆包要念的话；录音和歌曲音频不离开电脑

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

pub const CLAUDE_MODEL: &str = "claude-sonnet-5-5";
const CLAUDE_URL: &str = "https://api.anthropic.com/v1/messages";
const KEY_FILE: &str = "ai.json";
const TTS_FILE: &str = "tts.json";
const TTS_URL: &str = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
/// 豆包语音合成 2.0 的女声「小何」
pub const DEFAULT_SPEAKER: &str = "zh_female_xiaohe_uranus_bigtts";
/// 豆包流式返回里表示「合成结束」的 code
const TTS_DONE: i64 = 20_000_000;
/// curl 连不上服务器（不是服务器报错）
const NO_CONNECTION: &str = "连不上服务器";

fn read_json(path: &Path) -> Value {
    fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

fn str_field(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Claude API key（和标签功能同一个 ai.json）
pub fn claude_key(dir: &Path) -> Option<String> {
    str_field(&read_json(&dir.join(KEY_FILE)), "apiKey")
}

/// 只给界面看末四位
fn tail(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    chars[chars.len().saturating_sub(4)..].iter().collect()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    /// Claude key 的末四位，没填是 None
    pub claude_tail: Option<String>,
    /// 豆包新版控制台的 API Key 末四位
    pub doubao_key_tail: Option<String>,
    /// 旧版控制台：APP ID 和 Access Token 末四位
    pub doubao_app_id: Option<String>,
    pub doubao_token_tail: Option<String>,
    pub speaker: String,
    /// 豆包语速，-50（慢）到 100（快），0 是正常
    pub speech_rate: i64,
}

/// 豆包怎么鉴权：新版控制台一个 API Key（X-Api-Key），旧版是 APP ID + Access Token
#[derive(Debug, Clone, PartialEq)]
enum DoubaoAuth {
    ApiKey(String),
    AppToken(String, String),
}

struct Tts {
    api_key: Option<String>,
    app_id: Option<String>,
    token: Option<String>,
    speaker: String,
    speech_rate: i64,
}

impl Tts {
    fn auth(&self) -> Option<DoubaoAuth> {
        if let Some(k) = &self.api_key {
            return Some(DoubaoAuth::ApiKey(k.clone()));
        }
        match (&self.app_id, &self.token) {
            // 旧版的 APP ID 是一串数字
            (Some(id), Some(t)) if id.chars().all(|c| c.is_ascii_digit()) => Some(DoubaoAuth::AppToken(id.clone(), t.clone())),
            // 把新版的 API Key（8-4-4-4-12 的 UUID）填进了 Token 那格：当 API Key 用
            (_, Some(t)) if is_uuid(t) => Some(DoubaoAuth::ApiKey(t.clone())),
            _ => None,
        }
    }
}

fn is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.iter().map(|p| p.len()).eq([8, 4, 4, 4, 12]) && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_hexdigit()))
}

fn read_tts(dir: &Path) -> Tts {
    let v = read_json(&dir.join(TTS_FILE));
    Tts {
        api_key: str_field(&v, "apiKey"),
        app_id: str_field(&v, "appId"),
        token: str_field(&v, "token"),
        speaker: str_field(&v, "speaker").unwrap_or_else(|| DEFAULT_SPEAKER.to_string()),
        speech_rate: v.get("speechRate").and_then(Value::as_i64).unwrap_or(0).clamp(-50, 100),
    }
}

pub fn status(dir: &Path) -> AiStatus {
    let t = read_tts(dir);
    let (key, pair) = match t.auth() {
        Some(DoubaoAuth::ApiKey(k)) => (Some(tail(&k)), None),
        Some(DoubaoAuth::AppToken(id, tok)) => (None, Some((id, tail(&tok)))),
        None => (None, None),
    };
    AiStatus {
        claude_tail: claude_key(dir).map(|k| tail(&k)),
        doubao_key_tail: key,
        doubao_app_id: pair.as_ref().map(|p| p.0.clone()),
        doubao_token_tail: pair.map(|p| p.1),
        speaker: t.speaker,
        speech_rate: t.speech_rate,
    }
}

/// 设置里改豆包语音：没传的字段不动，传空字符串就删掉
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsPatch {
    pub api_key: Option<String>,
    pub app_id: Option<String>,
    pub token: Option<String>,
    pub speaker: Option<String>,
    pub speech_rate: Option<i64>,
}

/// 复制粘贴进来的 key / ID：去掉首尾空白，里面不能有空白、引号、反斜杠和控制字符
fn clean(value: &str, what: &str) -> Result<String, String> {
    let v = value.trim();
    if v.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '\\') {
        return Err(format!("{what}里有不该有的字符，请重新复制"));
    }
    Ok(v.to_string())
}

pub fn save_tts(dir: &Path, patch: &TtsPatch) -> Result<(), String> {
    let path = dir.join(TTS_FILE);
    let mut v = read_json(&path);
    if !v.is_object() {
        v = json!({});
    }
    let obj = v.as_object_mut().ok_or("tts.json 格式不对")?;
    // 填了新版 API Key 就清掉旧版的两项，反过来也一样，免得两套混在一起
    if patch.api_key.as_deref().is_some_and(|k| !k.trim().is_empty()) {
        obj.remove("appId");
        obj.remove("token");
    }
    if patch.app_id.as_deref().is_some_and(|k| !k.trim().is_empty()) {
        obj.remove("apiKey");
    }
    for (key, value, what) in [
        ("apiKey", &patch.api_key, "API Key "),
        ("appId", &patch.app_id, "APP ID "),
        ("token", &patch.token, "Access Token "),
        ("speaker", &patch.speaker, "音色 ID "),
    ] {
        if let Some(value) = value {
            let value = clean(value, what)?;
            if value.is_empty() {
                obj.remove(key);
            } else {
                obj.insert(key.into(), Value::String(value));
            }
        }
    }
    if let Some(rate) = patch.speech_rate {
        obj.insert("speechRate".into(), json!(rate.clamp(-50, 100)));
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(&path, serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())
}

/// curl 配置文件里双引号字符串的转义
fn curl_quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t")
}

/// 用系统自带的 curl 发 POST，返回（HTTP 状态码，回复内容）。
/// 走哪条路按网络路线表（net.rs）：要直连的从 Wi-Fi / 网线出去，连不上再按系统路由试一次
fn curl_post(dir: &Path, url: &str, headers: &[(&str, &str)], body: &str, timeout_s: u32) -> Result<(u16, Vec<u8>), String> {
    let direct = crate::net::direct_interface(dir, url);
    let first = curl_post_via(url, headers, body, timeout_s, direct.as_deref());
    match (&first, &direct) {
        (Err(e), Some(_)) if e == NO_CONNECTION => curl_post_via(url, headers, body, timeout_s, None),
        _ => first,
    }
}

/// 同 curl_post，`interface` 指定从哪块网卡出去（绕开 VPN 隧道）
fn curl_post_via(url: &str, headers: &[(&str, &str)], body: &str, timeout_s: u32, interface: Option<&str>) -> Result<(u16, Vec<u8>), String> {
    let mut config = format!("url = \"{}\"\n", curl_quote(url));
    for (k, v) in headers {
        config += &format!("header = \"{}: {}\"\n", curl_quote(k), curl_quote(v));
    }
    config += &format!("data-binary = \"{}\"\n", curl_quote(body));
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "--connect-timeout", "8", "--max-time", &timeout_s.to_string(), "-w", "\n%{http_code}", "-K", "-"])
        .args(interface.map(|i| vec!["--interface", i]).unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("没法联网：{e}"))?;
    child.stdin.take().ok_or("没法联网")?.write_all(config.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let unreachable = ["Connection timed out", "SSL connection timeout", "Could not resolve", "Failed to connect"];
        return Err(if unreachable.iter().any(|m| err.contains(m)) {
            NO_CONNECTION.into()
        } else if err.contains("timed out") {
            "等太久没回应，请检查网络".into()
        } else {
            "连不上服务，请检查网络".into()
        });
    }
    let mut body = out.stdout;
    let cut = body.iter().rposition(|&b| b == b'\n').ok_or("服务的回复看不懂")?;
    let code = String::from_utf8_lossy(&body[cut + 1..]).trim().parse::<u16>().unwrap_or(0);
    body.truncate(cut);
    Ok((code, body))
}

fn request_id() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("banzou-{:x}-{:x}", std::process::id(), nanos)
}

// ---------------------------------------------------------------- Claude

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeReply {
    pub text: String,
    pub model: String,
    pub ms: u64,
}

/// 把 Messages API 的回复变成文字；出错时换成能看懂的话
pub fn parse_claude(reply: &Value) -> Result<(String, String), String> {
    if let Some(err) = reply.get("error") {
        let kind = err.get("type").and_then(Value::as_str).unwrap_or("");
        let msg = err.get("message").and_then(Value::as_str).unwrap_or("");
        return Err(match kind {
            "authentication_error" => "Claude API key 不对，请重新复制".into(),
            "permission_error" => "这个 API key 没有权限".into(),
            "rate_limit_error" => "请求太频繁了，等一会儿再试".into(),
            "overloaded_error" => "Claude 服务现在很忙，稍后再试".into(),
            "invalid_request_error" if msg.contains("credit") => "API 账户余额不足，去 console.anthropic.com 的 Billing 充值".into(),
            _ => format!("Claude 服务出错（{kind}）"),
        });
    }
    if reply.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        return Err("AI 这次没有回答".into());
    }
    let text: String = reply
        .get("content")
        .and_then(Value::as_array)
        .map(|c| {
            c.iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err("AI 的回复里没有内容".into());
    }
    let model = reply.get("model").and_then(Value::as_str).unwrap_or(CLAUDE_MODEL).to_string();
    Ok((text.trim().to_string(), model))
}

/// 发一次 Messages API 请求，返回回复的 JSON（出错时换成能看懂的话）。
/// 带上服务端兜底：Sonnet 5.5 偶尔误拒时，由服务端换一个模型接着答
pub(crate) fn claude_post(dir: &Path, body: &Value, timeout_s: u32) -> Result<Value, String> {
    let key = claude_key(dir).ok_or("还没有填 Claude API key")?;
    let mut body = body.clone();
    body["fallbacks"] = json!("default");
    let (_, out) = curl_post(
        dir,
        CLAUDE_URL,
        &[
            ("x-api-key", &key),
            ("anthropic-version", "2023-06-01"),
            ("anthropic-beta", "server-side-fallback-2026-07-01"),
            ("content-type", "application/json"),
        ],
        &body.to_string(),
        timeout_s,
    )
    .map_err(|e| if e == NO_CONNECTION { "连不上 Claude 的服务器，请检查网络".to_string() } else { e })?;
    let reply: Value = serde_json::from_slice(&out).map_err(|_| "Claude 服务的回复看不懂".to_string())?;
    if reply.get("error").is_some() {
        return Err(parse_claude(&reply).err().unwrap_or_else(|| "Claude 服务出错".into()));
    }
    Ok(reply)
}

/// 设置里的「测试」：问一句，确认 key、余额、网络都没问题
pub fn test_claude(dir: &Path) -> Result<ClaudeReply, String> {
    let body = json!({
        "model": CLAUDE_MODEL,
        "max_tokens": 1024,
        "output_config": { "effort": "low" },
        "messages": [{ "role": "user", "content": "这是连接测试。请只回复三个字：连上了" }],
    });
    let started = Instant::now();
    let reply = claude_post(dir, &body, 60)?;
    let (text, model) = parse_claude(&reply)?;
    Ok(ClaudeReply { text, model, ms: started.elapsed().as_millis() as u64 })
}

// ---------------------------------------------------------------- 豆包语音合成

/// 音色对应的资源：声音复刻（S_ 开头）、2.0 音色（uranus）、其他按 1.0
pub fn resource_for(speaker: &str) -> &'static str {
    if speaker.starts_with("S_") {
        "seed-icl-1.0"
    } else if speaker.contains("uranus") {
        "seed-tts-2.0"
    } else {
        "seed-tts-1.0"
    }
}

fn tts_error(code: i64, message: &str) -> String {
    let m = message.to_lowercase();
    if code == 40_300_001 || code == 45_000_010 || m.contains("auth") || m.contains("grant") || m.contains("access key") || m.contains("appid") {
        "豆包语音的 key 不对，或者还没开通语音合成，请检查后重新复制".into()
    } else if m.contains("quota") || m.contains("balance") || m.contains("exceed") {
        "豆包语音的额度用完了，去火山引擎控制台看看".into()
    } else if code == 40_000_001 || m.contains("speaker") || m.contains("resource") {
        "音色 ID 不对，或者这个音色还没开通".into()
    } else if code == 40_402_003 {
        "要念的文字太长了".into()
    } else {
        format!("豆包语音出错（{code}）：{message}")
    }
}

/// 解析豆包流式接口的回复：每行一个 JSON，code 0 带一段 base64 音频，20000000 表示结束
pub fn parse_tts_stream(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut audio = Vec::new();
    let mut done = false;
    for line in String::from_utf8_lossy(body).lines().map(str::trim).filter(|l| !l.is_empty()) {
        let v: Value = serde_json::from_str(line).map_err(|_| "豆包语音的回复看不懂".to_string())?;
        // 出错时 code / message 有时包在 header 里：{"header":{"code":45000010,"message":"..."}}
        let v = match v.get("header") {
            Some(h) if v.get("code").is_none() => h.clone(),
            _ => v,
        };
        let code = v.get("code").and_then(Value::as_i64).unwrap_or(0);
        if code == TTS_DONE {
            done = true;
            break;
        }
        if code != 0 {
            return Err(tts_error(code, v.get("message").and_then(Value::as_str).unwrap_or("")));
        }
        if let Some(data) = v.get("data").and_then(Value::as_str).filter(|d| !d.is_empty()) {
            audio.extend(base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "豆包语音返回的声音坏了".to_string())?);
        }
    }
    if audio.is_empty() {
        return Err(if done { "豆包语音没有返回声音".into() } else { "豆包语音没说完就断了，请再试一次".into() });
    }
    Ok(audio)
}

/// 当前音色和语速：合成缓存按它区分，换了音色不会放旧声音
pub(crate) fn voice_key(dir: &Path) -> String {
    let t = read_tts(dir);
    format!("{}|{}", t.speaker, t.speech_rate)
}

/// 用豆包把一段话合成 mp3。
///
/// 中文音色遇到假名多的短句会回「说完了」却一点声音都不给（实测「《かじつ》」「这首歌叫《かじつ》。」都是空的），
/// 告诉它这段是日语（explicit_language = ja）就正常。所以有假名时按句读切成中文段和日文段，
/// 日文段标上日语，各自合成后按顺序拼成一个 mp3。
pub fn speak(dir: &Path, text: &str) -> Result<Vec<u8>, String> {
    let t = read_tts(dir);
    let auth = t.auth().ok_or("还没有填豆包语音的 API Key")?;
    let parts = language_parts(text);
    let mut clips = Vec::with_capacity(parts.len());
    // 一次最多并发 4 段，免得撞上豆包的并发上限
    for group in parts.chunks(4) {
        let results: Vec<Result<Vec<u8>, String>> = std::thread::scope(|s| {
            let jobs: Vec<_> = group
                .iter()
                .map(|(part, ja)| {
                    let (t, auth) = (&t, &auth);
                    s.spawn(move || speak_once(dir, t, auth, part, ja.then_some("ja")))
                })
                .collect();
            jobs.into_iter().map(|j| j.join().unwrap_or_else(|_| Err("豆包语音出错了，请再试一次".into()))).collect()
        });
        for r in results {
            clips.push(r?);
        }
    }
    Ok(join_mp3(clips))
}

fn speak_once(dir: &Path, t: &Tts, auth: &DoubaoAuth, text: &str, language: Option<&str>) -> Result<Vec<u8>, String> {
    let mut req = json!({
        "text": text,
        "speaker": t.speaker,
        "audio_params": { "format": "mp3", "sample_rate": 24000, "speech_rate": t.speech_rate },
    });
    if let Some(lang) = language {
        req["additions"] = Value::from(json!({ "explicit_language": lang }).to_string());
    }
    let body = json!({ "user": { "uid": "banzou" }, "req_params": req });
    let rid = request_id();
    let mut headers: Vec<(&str, &str)> = match auth {
        DoubaoAuth::ApiKey(k) => vec![("X-Api-Key", k.as_str())],
        DoubaoAuth::AppToken(id, tok) => vec![("X-Api-App-Id", id.as_str()), ("X-Api-Access-Key", tok.as_str())],
    };
    headers.extend([
        ("X-Api-Resource-Id", resource_for(&t.speaker)),
        ("X-Api-Request-Id", rid.as_str()),
        ("Content-Type", "application/json"),
    ]);
    let (code, out) = curl_post(dir, TTS_URL, &headers, &body.to_string(), 60).map_err(|e| {
        if e == NO_CONNECTION {
            "连不上豆包语音的服务器（在国内），去设置 →「网络」测一下".to_string()
        } else {
            e
        }
    })?;
    if code == 401 || code == 403 {
        return Err(tts_error(40_300_001, ""));
    }
    parse_tts_stream(&out)
}

fn is_kana(c: char) -> bool {
    // 平假名、片假名（不算中点・和长音ー）、片假名扩展、半角片假名
    matches!(c, '\u{3041}'..='\u{309F}' | '\u{30A0}'..='\u{30FA}' | '\u{30FD}'..='\u{30FF}' | '\u{31F0}'..='\u{31FF}' | '\u{FF66}'..='\u{FF9F}')
}

/// 把要念的话切成（文字, 是不是日语）的几段：按标点和空格切句，有假名的句子算日语，相邻同语言的再并回去。
/// 开引号、书名号跟着后面的字，句末标点跟着前面的字。没有假名就原样一段。
pub(crate) fn language_parts(text: &str) -> Vec<(String, bool)> {
    const OPEN: &[char] = &['《', '「', '『', '（', '(', '【', '〈', '“', '‘', '['];
    let mut pieces: Vec<String> = Vec::new();
    let mut cur = String::new();
    let has_word = |s: &str| s.chars().any(char::is_alphanumeric);
    for c in text.chars() {
        let ends_in_mark = cur.chars().last().is_some_and(|l| !l.is_alphanumeric());
        let starts_new = if OPEN.contains(&c) { has_word(&cur) } else { c.is_alphanumeric() && has_word(&cur) && ends_in_mark };
        if starts_new {
            pieces.push(std::mem::take(&mut cur));
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        pieces.push(cur);
    }
    let mut parts: Vec<(String, bool)> = Vec::new();
    for p in pieces {
        let ja = if has_word(&p) { p.chars().any(is_kana) } else { parts.last().is_some_and(|l| l.1) };
        match parts.last_mut() {
            Some(last) if last.1 == ja || !has_word(&last.0) => {
                last.0.push_str(&p);
                last.1 = ja;
            }
            _ => parts.push((p, ja)),
        }
    }
    if parts.is_empty() {
        parts.push((text.to_string(), false));
    }
    parts
}

/// 豆包返回的是不带总长信息的流式 mp3，可以直接首尾相接；只要去掉后面几段开头的 ID3 标签
fn join_mp3(clips: Vec<Vec<u8>>) -> Vec<u8> {
    let mut out = Vec::new();
    for (i, clip) in clips.into_iter().enumerate() {
        let skip = match clip.get(..10) {
            Some(h) if i > 0 && h.starts_with(b"ID3") => {
                let size = h[6..10].iter().fold(0usize, |n, &b| (n << 7) | (b & 0x7f) as usize);
                let footer = if h[5] & 0x10 != 0 { 10 } else { 0 };
                (10 + size + footer).min(clip.len())
            }
            _ => 0,
        };
        out.extend_from_slice(&clip[skip..]);
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpokenTest {
    /// mp3 的 base64，界面直接播放
    pub audio: String,
    pub bytes: usize,
    pub ms: u64,
}

/// 设置里的「试听」
pub fn test_tts(dir: &Path, text: &str) -> Result<SpokenTest, String> {
    let started = Instant::now();
    let mp3 = speak(dir, text)?;
    Ok(SpokenTest {
        bytes: mp3.len(),
        audio: base64::engine::general_purpose::STANDARD.encode(&mp3),
        ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_shows_only_key_tails() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            status(dir.path()),
            AiStatus { claude_tail: None, doubao_key_tail: None, doubao_app_id: None, doubao_token_tail: None, speaker: DEFAULT_SPEAKER.into(), speech_rate: 0 }
        );
        fs::write(dir.path().join(KEY_FILE), r#"{"apiKey":"sk-ant-secret-WXYZ"}"#).unwrap();
        save_tts(dir.path(), &TtsPatch { app_id: Some(" 123456 ".into()), token: Some("tok-secret-9876".into()), ..Default::default() }).unwrap();
        let s = status(dir.path());
        assert_eq!(s.claude_tail.as_deref(), Some("WXYZ"));
        assert_eq!(s.doubao_app_id.as_deref(), Some("123456"));
        assert_eq!(s.doubao_token_tail.as_deref(), Some("9876"));
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("secret"));
        // 填了新版 API Key：旧版两项清掉，只显示 key 的末四位
        save_tts(dir.path(), &TtsPatch { api_key: Some("ak-secret-5555".into()), ..Default::default() }).unwrap();
        let s = status(dir.path());
        assert_eq!((s.doubao_key_tail.as_deref(), s.doubao_app_id), (Some("5555"), None));
    }

    #[test]
    fn doubao_auth_new_old_and_mixed_up() {
        let tts = |api_key: Option<&str>, app_id: Option<&str>, token: Option<&str>| Tts {
            api_key: api_key.map(Into::into),
            app_id: app_id.map(Into::into),
            token: token.map(Into::into),
            speaker: DEFAULT_SPEAKER.into(),
            speech_rate: 0,
        };
        let uuid = "1234abcd-ab12-4cd3-9abc-12ab34cd56ef";
        assert_eq!(tts(Some("k"), None, None).auth(), Some(DoubaoAuth::ApiKey("k".into())));
        assert_eq!(tts(None, Some("1234567890"), Some("tok")).auth(), Some(DoubaoAuth::AppToken("1234567890".into(), "tok".into())));
        // 新版控制台的 API Key 被填进了 Token 那格、APP ID 那格填了别的：当 API Key 用
        assert_eq!(tts(None, Some("abc-def-20251113000000"), Some(uuid)).auth(), Some(DoubaoAuth::ApiKey(uuid.into())));
        assert_eq!(tts(None, Some("abc"), Some("not-a-key")).auth(), None);
        assert!(is_uuid(uuid) && !is_uuid("1234abcd-ab12-4cd3-9abc-12ab34cd56e"));
    }

    #[test]
    fn save_tts_merges_removes_and_is_private() {
        let dir = tempfile::tempdir().unwrap();
        save_tts(dir.path(), &TtsPatch { app_id: Some("1".into()), token: Some("t".into()), ..Default::default() }).unwrap();
        save_tts(dir.path(), &TtsPatch { speech_rate: Some(500), speaker: Some("S_abc".into()), ..Default::default() }).unwrap();
        let t = read_tts(dir.path());
        assert_eq!((t.app_id.as_deref(), t.token.as_deref(), t.speaker.as_str(), t.speech_rate), (Some("1"), Some("t"), "S_abc", 100));
        save_tts(dir.path(), &TtsPatch { token: Some("".into()), speaker: Some("".into()), ..Default::default() }).unwrap();
        let t = read_tts(dir.path());
        assert_eq!((t.token, t.speaker.as_str()), (None, DEFAULT_SPEAKER));
        let mode = fs::metadata(dir.path().join(TTS_FILE)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert!(save_tts(dir.path(), &TtsPatch { token: Some("a b".into()), ..Default::default() }).is_err());
    }

    #[test]
    fn claude_replies_and_errors() {
        let ok = json!({ "model": "claude-sonnet-5-5", "content": [{ "type": "thinking", "thinking": "" }, { "type": "text", "text": " 连上了 " }] });
        assert_eq!(parse_claude(&ok).unwrap(), ("连上了".into(), "claude-sonnet-5-5".into()));
        let bad_key = json!({ "type": "error", "error": { "type": "authentication_error", "message": "invalid x-api-key" } });
        assert!(parse_claude(&bad_key).unwrap_err().contains("key 不对"));
        let broke = json!({ "type": "error", "error": { "type": "invalid_request_error", "message": "Your credit balance is too low" } });
        assert!(parse_claude(&broke).unwrap_err().contains("余额"));
        assert!(parse_claude(&json!({ "stop_reason": "refusal", "content": [] })).is_err());
    }

    #[test]
    fn tts_stream_joins_chunks_and_maps_errors() {
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let body = format!(
            "{{\"code\":0,\"message\":\"\",\"data\":\"{}\"}}\n{{\"code\":0,\"message\":\"\",\"data\":null,\"sentence\":{{}}}}\n{{\"code\":0,\"data\":\"{}\"}}\n{{\"code\":20000000,\"message\":\"ok\",\"data\":null}}\n",
            b64(b"ID3a"),
            b64(b"bc")
        );
        assert_eq!(parse_tts_stream(body.as_bytes()).unwrap(), b"ID3abc");
        let auth = br#"{"code":40300001,"message":"auth failed"}"#;
        assert!(parse_tts_stream(auth).unwrap_err().contains("key 不对"));
        // 真服务器对错误 key 的回复（HTTP 401）
        let real = br#"{"header":{"reqid":"banzou-test-2","code":45000010,"message":"load grant: requested grant not found in SaaS storage"}}"#;
        assert!(parse_tts_stream(real).unwrap_err().contains("key 不对"));
        let wrapped = br#"{"header":{"code":40000001,"message":"resource ID is mismatched with speaker"}}"#;
        assert!(parse_tts_stream(wrapped).unwrap_err().contains("音色"));
        let speaker = br#"{"code":40000001,"message":"resource ID is mismatched with speaker related resource"}"#;
        assert!(parse_tts_stream(speaker).unwrap_err().contains("音色"));
        assert!(parse_tts_stream(b"").is_err());
    }

    #[test]
    fn kana_goes_to_its_own_japanese_part() {
        let parts = |t: &str| language_parts(t);
        assert_eq!(parts("你好，我们开始吧。"), vec![("你好，我们开始吧。".to_string(), false)]);
        assert_eq!(parts("《かじつ》"), vec![("《かじつ》".to_string(), true)]);
        assert_eq!(parts("这首歌叫《かじつ》。"), vec![("这首歌叫".to_string(), false), ("《かじつ》。".to_string(), true)]);
        assert_eq!(
            parts("这句「気付いて、そして」要轻一点。Kajitsu 也行"),
            vec![("这句".to_string(), false), ("「気付いて、そして」".to_string(), true), ("要轻一点。Kajitsu 也行".to_string(), false)]
        );
        assert_eq!(parts("夏の実"), vec![("夏の実".to_string(), true)]);
        assert_eq!(parts("……"), vec![("……".to_string(), false)]);
    }

    #[test]
    fn mp3_parts_join_without_inner_id3() {
        let tag = |body: &[u8]| [b"ID3\x04\x00\x00\x00\x00\x00\x02".as_slice(), b"xx", body].concat();
        assert_eq!(join_mp3(vec![tag(b"AA"), tag(b"BB"), b"CC".to_vec()]), [tag(b"AA"), b"BBCC".to_vec()].concat());
    }

    #[test]
    fn resource_follows_speaker() {
        assert_eq!(resource_for(DEFAULT_SPEAKER), "seed-tts-2.0");
        assert_eq!(resource_for("S_9W2ToNVW1"), "seed-icl-1.0");
        assert_eq!(resource_for("zh_female_shuangkuaisisi_moon_bigtts"), "seed-tts-1.0");
    }
}
