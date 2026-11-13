//! 一键开播：通过 OBS 自带的 obs-websocket（v5 协议）控制 OBS。
//!
//! 开始直播 = 打开 OBS（第一次会先写好 websocket 配置，带随机密码）→ 连上 →
//! 建「波点」场景，放一个浏览器源（叠加层地址 ?audio=1，声音交给 OBS 混音）→
//! 静音 OBS 自己的麦克风输入（人声已经由 app 修好后从浏览器源送进来）→ 填推流地址和推流码 → 开始推流。

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tungstenite::{stream::MaybeTlsStream, Message, WebSocket};

pub const PORT: u16 = 4455;
pub const SCENE: &str = "波点";
pub const SOURCE: &str = "波点（歌词 + 声音）";
/// 改名前（应用叫「伴奏歌词」时）建的场景和浏览器源：还在的话原地改名，不再多建一套
const OLD_SCENE: &str = "伴奏歌词";
const OLD_SOURCE: &str = "伴奏歌词（歌词 + 声音）";

fn obs_support_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join("Library/Application Support/obs-studio"))
}

pub fn installed() -> bool {
    std::path::Path::new("/Applications/OBS.app").exists()
}

pub fn running() -> bool {
    std::process::Command::new("/usr/bin/pgrep").args(["-x", "OBS"]).output().is_ok_and(|o| o.status.success())
}

/// 写 obs-websocket 配置（启用、端口 4455、要密码）。OBS 运行中改了不生效，所以只在没运行时写。返回是否改动
pub fn ensure_ws_config(password: &str) -> Result<bool, String> {
    let dir = obs_support_dir().ok_or("找不到用户目录")?.join("plugin_config/obs-websocket");
    let path = dir.join("config.json");
    let current: Value = fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
    let ok = current["server_enabled"] == json!(true)
        && current["auth_required"] == json!(true)
        && current["server_password"] == json!(password)
        && current["server_port"] == json!(PORT);
    if ok {
        return Ok(false);
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut cfg = if current.is_object() { current } else { json!({}) };
    cfg["server_enabled"] = json!(true);
    cfg["server_port"] = json!(PORT);
    cfg["auth_required"] = json!(true);
    cfg["server_password"] = json!(password);
    cfg["alerts_enabled"] = json!(false);
    cfg["first_load"] = json!(false);
    fs::write(&path, serde_json::to_vec_pretty(&cfg).unwrap()).map_err(|e| e.to_string())?;
    Ok(true)
}

/// 第一次打开 OBS 时它会先弹「macOS 权限说明」窗口和「自动配置向导」，点掉之前插件不加载、连不上。
/// 预先在配置里标记「看过了」。（真正需要摄像头等权限时系统仍会单独询问）
pub fn skip_first_run_dialogs() -> Result<(), String> {
    let dir = obs_support_dir().ok_or("找不到用户目录")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for name in ["user.ini", "global.ini"] {
        let path = dir.join(name);
        let text = fs::read_to_string(&path).unwrap_or_default();
        let updated = set_ini(&set_ini(&text, "General", "FirstRun", "true"), "General", "MacOSPermissionsDialogLastShown", "99");
        if updated != text {
            fs::write(&path, updated).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 在 INI 文本的某一节里设置 key=value（没有就加上）
pub fn set_ini(text: &str, section: &str, key: &str, value: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut in_section = false;
    let mut found_section = false;
    let mut done = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if in_section && !done {
                out.push(format!("{key}={value}"));
                done = true;
            }
            in_section = trimmed == format!("[{section}]");
            found_section |= in_section;
        } else if in_section && trimmed.split_once('=').is_some_and(|(k, _)| k.trim() == key) {
            out.push(format!("{key}={value}"));
            done = true;
            continue;
        }
        out.push(line.to_string());
    }
    if in_section && !done {
        out.push(format!("{key}={value}"));
        done = true;
    }
    if !found_section {
        if !out.is_empty() && !out.last().unwrap().is_empty() {
            out.push(String::new());
        }
        out.push(format!("[{section}]"));
        out.push(format!("{key}={value}"));
    } else {
        let _ = done;
    }
    out.join("\n") + "\n"
}

pub fn launch() -> Result<(), String> {
    // 上次 OBS 没正常退出会留下 .sentinel/run_* 标记，启动时弹「要不要进安全模式」（安全模式会关掉 websocket）。
    // OBS 没在运行时这些标记都是过期的，清掉
    if !running() {
        if let Some(dir) = obs_support_dir().map(|d| d.join(".sentinel")) {
            if let Ok(entries) = fs::read_dir(&dir) {
                for e in entries.flatten() {
                    if e.file_name().to_string_lossy().starts_with("run_") {
                        let _ = fs::remove_file(e.path());
                    }
                }
            }
        }
    }
    let status = std::process::Command::new("/usr/bin/open")
        .args(["-a", "OBS"])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err("打不开 OBS".into()) }
}

pub fn auth_string(password: &str, salt: &str, challenge: &str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    let secret = b64.encode(Sha256::digest(format!("{password}{salt}").as_bytes()));
    b64.encode(Sha256::digest(format!("{secret}{challenge}").as_bytes()))
}

pub struct Obs {
    ws: WebSocket<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

impl Obs {
    pub fn connect(password: &str) -> Result<Obs, String> {
        let (mut ws, _) = tungstenite::connect(format!("ws://127.0.0.1:{PORT}")).map_err(|e| format!("连不上 OBS：{e}"))?;
        if let MaybeTlsStream::Plain(s) = ws.get_ref() {
            let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        }
        let hello = read_json(&mut ws)?;
        let mut identify = json!({ "op": 1, "d": { "rpcVersion": 1, "eventSubscriptions": 0 } });
        if let Some(auth) = hello["d"]["authentication"].as_object() {
            let s = auth_string(password, auth["salt"].as_str().unwrap_or(""), auth["challenge"].as_str().unwrap_or(""));
            identify["d"]["authentication"] = json!(s);
        }
        ws.send(Message::Text(identify.to_string().into())).map_err(|e| e.to_string())?;
        let identified = read_json(&mut ws).map_err(|_| "OBS 拒绝连接：密码不对（在 OBS 的「工具 → WebSocket 服务器设置」里改过密码？）".to_string())?;
        if identified["op"] != json!(2) {
            return Err("OBS 握手失败".into());
        }
        Ok(Obs { ws, next_id: 1 })
    }

    pub fn request(&mut self, kind: &str, data: Value) -> Result<Value, String> {
        let id = self.next_id.to_string();
        self.next_id += 1;
        let msg = json!({ "op": 6, "d": { "requestType": kind, "requestId": id, "requestData": data } });
        self.ws.send(Message::Text(msg.to_string().into())).map_err(|e| e.to_string())?;
        loop {
            let v = read_json(&mut self.ws)?;
            if v["op"] == json!(7) && v["d"]["requestId"] == json!(id) {
                let status = &v["d"]["requestStatus"];
                if status["result"] == json!(true) {
                    return Ok(v["d"]["responseData"].clone());
                }
                return Err(format!("OBS {kind} 失败：{}", status["comment"].as_str().unwrap_or("")));
            }
        }
    }
}

fn read_json(ws: &mut WebSocket<MaybeTlsStream<TcpStream>>) -> Result<Value, String> {
    loop {
        match ws.read().map_err(|e| format!("OBS 连接断了：{e}"))? {
            Message::Text(t) => return serde_json::from_str(&t).map_err(|e| e.to_string()),
            Message::Close(_) => return Err("OBS 关闭了连接".into()),
            _ => continue,
        }
    }
}

/// 打开 OBS（需要的话）并连上，最多等 20 秒
pub fn open_and_connect(password: &str) -> Result<Obs, String> {
    if !installed() {
        return Err("没有安装 OBS（应用程序里找不到 OBS.app）".into());
    }
    if !running() {
        ensure_ws_config(password)?;
        skip_first_run_dialogs()?;
        launch()?;
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut last = String::new();
    while Instant::now() < deadline {
        match Obs::connect(password) {
            Ok(obs) => return Ok(obs),
            Err(e) if e.contains("密码") => return Err(e),
            Err(e) => last = e,
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    if running() && ensure_ws_config(password).unwrap_or(false) {
        return Err("OBS 已经开着，但还没启用 app 的连接设置：请退出 OBS 再点一次「开始直播」".into());
    }
    Err(format!("等 OBS 启动超时：{last}"))
}

/// 建好场景和浏览器源，静音 OBS 自己的麦克风；返回做了哪些事
pub fn setup_scene(obs: &mut Obs, overlay_url: &str) -> Result<Vec<String>, String> {
    let mut done = Vec::new();
    let scenes = obs.request("GetSceneList", json!({}))?;
    let has_scene = |name: &str| scenes["scenes"].as_array().is_some_and(|a| a.iter().any(|s| s["sceneName"] == json!(name)));
    let mut exists = has_scene(SCENE);
    if !exists && has_scene(OLD_SCENE) {
        obs.request("SetSceneName", json!({ "sceneName": OLD_SCENE, "newSceneName": SCENE }))?;
        done.push(format!("场景「{OLD_SCENE}」改名为「{SCENE}」"));
        exists = true;
    }
    if !exists {
        obs.request("CreateScene", json!({ "sceneName": SCENE }))?;
        done.push(format!("新建场景「{SCENE}」"));
    }
    obs.request("SetCurrentProgramScene", json!({ "sceneName": SCENE }))?;

    let settings = json!({
        "url": overlay_url,
        "width": 1920,
        "height": 1080,
        "reroute_audio": true,
        "shutdown": false,
        "restart_when_active": false,
    });
    let inputs = obs.request("GetInputList", json!({}))?;
    let list = inputs["inputs"].as_array().cloned().unwrap_or_default();
    let has_input = |name: &str| list.iter().any(|i| i["inputName"] == json!(name));
    let mut source_exists = has_input(SOURCE);
    if !source_exists && has_input(OLD_SOURCE) {
        obs.request("SetInputName", json!({ "inputName": OLD_SOURCE, "newInputName": SOURCE }))?;
        source_exists = true;
    }
    if source_exists {
        obs.request("SetInputSettings", json!({ "inputName": SOURCE, "inputSettings": settings, "overlay": true }))?;
        // 地址没变时 OBS 不会重新加载；强制刷新，保证用的是这个版本 app 的叠加层页面
        let _ = obs.request("PressInputPropertiesButton", json!({ "inputName": SOURCE, "propertyName": "refreshnocache" }));
    } else {
        obs.request("CreateInput", json!({ "sceneName": SCENE, "inputName": SOURCE, "inputKind": "browser_source", "inputSettings": settings }))?;
        done.push(format!("加了浏览器源「{SOURCE}」"));
        // 铺满画面
        let video = obs.request("GetVideoSettings", json!({}))?;
        let item = obs.request("GetSceneItemId", json!({ "sceneName": SCENE, "sourceName": SOURCE }))?;
        obs.request(
            "SetSceneItemTransform",
            json!({
                "sceneName": SCENE,
                "sceneItemId": item["sceneItemId"],
                "sceneItemTransform": {
                    "boundsType": "OBS_BOUNDS_SCALE_INNER",
                    "boundsWidth": video["baseWidth"],
                    "boundsHeight": video["baseHeight"],
                    "positionX": 0,
                    "positionY": 0
                }
            }),
        )?;
    }
    // 人声已经由 app 修好从浏览器源送进来，OBS 自己的麦克风再采一遍就重复了
    for i in &list {
        if i["inputKind"] == json!("coreaudio_input_capture") {
            if let Some(name) = i["inputName"].as_str() {
                obs.request("SetInputMute", json!({ "inputName": name, "inputMuted": true }))?;
                done.push(format!("静音了 OBS 的麦克风「{name}」"));
            }
        }
    }
    Ok(done)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsStatus {
    pub installed: bool,
    pub running: bool,
    pub connected: bool,
    pub streaming: bool,
    pub duration_ms: u64,
    pub congestion: f64,
    pub error: Option<String>,
}

pub fn status(password: &str) -> ObsStatus {
    let mut s = ObsStatus { installed: installed(), running: running(), connected: false, streaming: false, duration_ms: 0, congestion: 0.0, error: None };
    if !s.running {
        return s;
    }
    match Obs::connect(password).and_then(|mut o| o.request("GetStreamStatus", json!({}))) {
        Ok(v) => {
            s.connected = true;
            s.streaming = v["outputActive"].as_bool().unwrap_or(false);
            s.duration_ms = v["outputDuration"].as_u64().unwrap_or(0);
            s.congestion = v["outputCongestion"].as_f64().unwrap_or(0.0);
        }
        Err(e) => s.error = Some(e),
    }
    s
}

/// 一键开播。stream_key 为空时只准备好场景不推流
pub fn go_live(password: &str, overlay_url: &str, server: &str, key: &str) -> Result<Vec<String>, String> {
    let mut obs = open_and_connect(password)?;
    let mut done = setup_scene(&mut obs, overlay_url)?;
    if server.trim().is_empty() || key.trim().is_empty() {
        done.push("还没填推流地址 / 推流码：场景准备好了，暂不推流".into());
        return Ok(done);
    }
    obs.request(
        "SetStreamServiceSettings",
        json!({ "streamServiceType": "rtmp_custom", "streamServiceSettings": { "server": server.trim(), "key": key.trim(), "use_auth": false } }),
    )?;
    let st = obs.request("GetStreamStatus", json!({}))?;
    if st["outputActive"] != json!(true) {
        obs.request("StartStream", json!({}))?;
        done.push("开始推流".into());
    } else {
        done.push("已经在推流".into());
    }
    Ok(done)
}

pub fn stop(password: &str) -> Result<(), String> {
    let mut obs = Obs::connect(password)?;
    let st = obs.request("GetStreamStatus", json!({}))?;
    if st["outputActive"] == json!(true) {
        obs.request("StopStream", json!({}))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ini_keys_are_set_or_added() {
        let t = "[General]\nPre19Defaults=false\nFirstRun=false\n[Other]\nx=1\n";
        let u = set_ini(&set_ini(t, "General", "FirstRun", "true"), "General", "MacOSPermissionsDialogLastShown", "99");
        assert_eq!(u, "[General]\nPre19Defaults=false\nFirstRun=true\nMacOSPermissionsDialogLastShown=99\n[Other]\nx=1\n");
        assert_eq!(set_ini("", "General", "FirstRun", "true"), "[General]\nFirstRun=true\n");
    }

    #[test]
    fn auth_matches_protocol_example() {
        // obs-websocket 文档里的例子：密码 supersecretpassword
        let a = auth_string("supersecretpassword", "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=", "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=");
        assert_eq!(a, "1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=");
    }
}
