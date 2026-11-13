//! 网络路线（PRD 5.4）：应用要连的外部服务列成一张表，每个服务走哪条路由这张表说了算。
//!
//! - 直连：从 Wi-Fi / 网线直接出去，不进 VPN 隧道（国内服务，比如豆包语音）
//! - 跟系统走：开着 VPN 就走 VPN（国外服务）
//! - 不靠 VPN 自己的「国内直连」：实测 Astrill 的 Smart Mode 和排除列表不一定生效
//! - 用户改过的路线存在配置目录 network.json，只记改过的

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Instant;

const FILE: &str = "network.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Route {
    /// 从 Wi-Fi / 网线直接出去，不进 VPN 隧道
    Direct,
    /// 跟系统走（开着 VPN 就走 VPN）
    System,
}

/// 默认表：一个服务一行。以后加国内服务，在这里加一行
struct Def {
    id: &'static str,
    name: &'static str,
    used_for: &'static str,
    /// 测连用的地址
    url: &'static str,
    /// 归这个服务管的域名（含子域名）
    hosts: &'static [&'static str],
    route: Route,
}

const SERVICES: &[Def] = &[
    Def { id: "doubao", name: "豆包语音", used_for: "老师念出来", url: "https://openspeech.bytedance.com", hosts: &["bytedance.com", "volcengine.com", "volces.com"], route: Route::Direct },
    Def { id: "claude", name: "Claude", used_for: "AI 老师、AI 打标签", url: "https://api.anthropic.com", hosts: &["anthropic.com"], route: Route::System },
    Def { id: "youtube", name: "YouTube", used_for: "下载视频", url: "https://www.youtube.com", hosts: &["youtube.com", "youtu.be", "googlevideo.com", "ytimg.com"], route: Route::System },
    Def { id: "github", name: "GitHub", used_for: "自动更新、下载 yt-dlp 等工具", url: "https://github.com", hosts: &["github.com", "githubusercontent.com"], route: Route::System },
    Def { id: "lrclib", name: "LRCLIB", used_for: "搜歌词", url: "https://lrclib.net", hosts: &["lrclib.net"], route: Route::System },
    Def { id: "pypi", name: "PyPI", used_for: "安装 Demucs", url: "https://pypi.org", hosts: &["pypi.org", "pythonhosted.org", "fbaipublicfiles.com"], route: Route::System },
    Def { id: "google", name: "Google 下载", used_for: "电视用的 adb 工具", url: "https://dl.google.com", hosts: &["dl.google.com"], route: Route::System },
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: String,
    pub name: String,
    pub used_for: String,
    pub url: String,
    pub route: Route,
    pub default_route: Route,
}

fn overrides(dir: &Path) -> serde_json::Map<String, Value> {
    fs::read_to_string(dir.join(FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("routes").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

fn route_of(dir: &Path, def: &Def) -> Route {
    overrides(dir).get(def.id).and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or(def.route)
}

pub fn services(dir: &Path) -> Vec<Service> {
    SERVICES
        .iter()
        .map(|d| Service {
            id: d.id.into(),
            name: d.name.into(),
            used_for: d.used_for.into(),
            url: d.url.into(),
            route: route_of(dir, d),
            default_route: d.route,
        })
        .collect()
}

/// 改一个服务的路线；None 或者和默认一样 = 恢复默认（不再记）
pub fn set_route(dir: &Path, id: &str, route: Option<Route>) -> Result<(), String> {
    let def = SERVICES.iter().find(|d| d.id == id).ok_or("没有这个服务")?;
    let mut routes = overrides(dir);
    match route.filter(|r| *r != def.route) {
        Some(r) => {
            routes.insert(id.into(), json!(r));
        }
        None => {
            routes.remove(id);
        }
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_vec_pretty(&json!({ "routes": routes })).map_err(|e| e.to_string())?;
    fs::write(dir.join(FILE), text).map_err(|e| format!("保存网络设置失败：{e}"))
}

/// https://a.b.com:443/x → a.b.com
pub fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host);
    host.split(':').next().unwrap_or("")
}

fn def_for(url: &str) -> Option<&'static Def> {
    let host = host_of(url).to_ascii_lowercase();
    SERVICES.iter().find(|d| d.hosts.iter().any(|h| host == *h || host.ends_with(&format!(".{h}"))))
}

/// 这个地址该走哪条路（不在表里的跟系统走）
pub fn route_for(dir: &Path, url: &str) -> Route {
    def_for(url).map(|d| route_of(dir, d)).unwrap_or(Route::System)
}

/// 本机真正联网的网卡（Wi-Fi / 网线，如 en0、en1）。VPN 把流量全拉进隧道（utunN）时，
/// 系统的 default 路由仍指向它
pub fn physical_interface() -> Option<String> {
    let out = Command::new("/sbin/route").args(["-n", "get", "default"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let iface = text.lines().find_map(|l| l.trim().strip_prefix("interface:"))?.trim().to_string();
    (!iface.is_empty() && !iface.starts_with("utun") && iface.chars().all(|c| c.is_ascii_alphanumeric())).then_some(iface)
}

/// 要直连时返回网卡名，交给 curl 的 --interface；跟系统走返回 None
pub fn direct_interface(dir: &Path, url: &str) -> Option<String> {
    (route_for(dir, url) == Route::Direct).then(physical_interface).flatten()
}

/// curl 要加的参数（直连时 `--interface en1`），给其他用 curl 的地方用
pub fn curl_args(dir: &Path, url: &str) -> Vec<String> {
    direct_interface(dir, url).map(|i| vec!["--interface".to_string(), i]).unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub id: String,
    pub ok: bool,
    /// 实际走的路
    pub via: Route,
    pub ms: u64,
    /// 直连不通、改走系统路由才通
    pub fell_back: bool,
    pub error: Option<String>,
}

/// 连一下（只要服务器有回应就算通，不管返回什么状态码）
fn probe(url: &str, interface: Option<&str>) -> (bool, u64, Option<String>) {
    let started = Instant::now();
    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args(["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--connect-timeout", "8", "--max-time", "15"]);
    if let Some(i) = interface {
        cmd.args(["--interface", i]);
    }
    let out = cmd.arg(url).output();
    let ms = started.elapsed().as_millis() as u64;
    match out {
        Ok(o) => {
            let code: u16 = String::from_utf8_lossy(&o.stdout).trim().parse().unwrap_or(0);
            if code > 0 {
                (true, ms, None)
            } else {
                let err = String::from_utf8_lossy(&o.stderr);
                let why = if err.contains("timed out") || err.contains("timeout") {
                    "等了 8 秒没回应"
                } else if err.contains("resolve") {
                    "找不到服务器（DNS）"
                } else {
                    "连不上"
                };
                (false, ms, Some(why.into()))
            }
        }
        Err(e) => (false, ms, Some(format!("没法联网：{e}"))),
    }
}

/// 设置里的「测一下」：按现在的路线连；直连不通再按系统路由试一次（和真正发请求时一样）
pub fn test(dir: &Path, id: &str) -> Result<TestResult, String> {
    let def = SERVICES.iter().find(|d| d.id == id).ok_or("没有这个服务")?;
    let route = route_of(dir, def);
    let iface = (route == Route::Direct).then(physical_interface).flatten();
    if route == Route::Direct && iface.is_none() {
        let (ok, ms, error) = probe(def.url, None);
        return Ok(TestResult { id: id.into(), ok, via: Route::System, ms, fell_back: true, error: error.or(Some("找不到 Wi-Fi / 网线网卡".into())) });
    }
    let (ok, ms, error) = probe(def.url, iface.as_deref());
    if ok || iface.is_none() {
        return Ok(TestResult { id: id.into(), ok, via: route, ms, fell_back: false, error });
    }
    let (ok2, ms2, error2) = probe(def.url, None);
    Ok(TestResult { id: id.into(), ok: ok2, via: Route::System, ms: ms + ms2, fell_back: true, error: if ok2 { None } else { error2.or(error) } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_match_with_subdomains() {
        assert_eq!(host_of("https://openspeech.bytedance.com/api/v3/tts"), "openspeech.bytedance.com");
        assert_eq!(host_of("https://u:p@lrclib.net:443/api?x=1"), "lrclib.net");
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(route_for(dir.path(), "https://openspeech.bytedance.com/api/v3/tts/unidirectional"), Route::Direct);
        assert_eq!(route_for(dir.path(), "https://api.anthropic.com/v1/messages"), Route::System);
        // 不在表里的、长得像的都跟系统走
        assert_eq!(route_for(dir.path(), "https://notbytedance.com"), Route::System);
        assert_eq!(route_for(dir.path(), "https://example.org"), Route::System);
    }

    #[test]
    fn overrides_only_store_changes() {
        let dir = tempfile::tempdir().unwrap();
        set_route(dir.path(), "claude", Some(Route::Direct)).unwrap();
        set_route(dir.path(), "doubao", Some(Route::Direct)).unwrap(); // 和默认一样，不记
        let saved: Value = serde_json::from_str(&fs::read_to_string(dir.path().join(FILE)).unwrap()).unwrap();
        assert_eq!(saved, json!({ "routes": { "claude": "direct" } }));
        assert_eq!(route_for(dir.path(), "https://api.anthropic.com/v1/messages"), Route::Direct);
        let s = services(dir.path());
        let c = s.iter().find(|x| x.id == "claude").unwrap();
        assert_eq!((c.route, c.default_route), (Route::Direct, Route::System));
        set_route(dir.path(), "claude", None).unwrap();
        assert_eq!(route_for(dir.path(), "https://api.anthropic.com"), Route::System);
        assert!(set_route(dir.path(), "nope", None).is_err());
    }

    #[test]
    fn every_service_url_is_its_own() {
        for d in SERVICES {
            assert_eq!(def_for(d.url).map(|x| x.id), Some(d.id), "{}", d.id);
        }
    }
}
