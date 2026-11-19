//! 绕开被污染的 DNS（PRD 5.4「网络路线」）。
//!
//! 国内路由器的 DNS 常把 YouTube 等国外域名解析成假地址；VPN 隧道本身是通的，坏的只是地址。
//! Chrome 不受影响是因为它自己用加密 DNS（DoH）。应用这里也一样：
//!
//! - 判断：先按系统 DNS 连一下；连不上就用 DoH 查真地址再连。真地址能通 = DNS 被污染，
//!   真地址也不通 = 网络不通。结论按服务记一阵子（见 `verdict`）。
//! - 绕开：本机起一个只给应用自己用的 HTTP 代理（只监听 127.0.0.1，带随机口令），
//!   它收到 `CONNECT 主机:443` 后用 DoH 查真地址再连过去。curl 和 yt-dlp 都用 `--proxy` 接上，
//!   这样重定向到的、yt-dlp 临时拿到的 googlevideo.com 动态域名也都能解析对。
//! - DoH 服务器用 IP 直接连（1.1.1.1、8.8.8.8 的证书里带 IP），不再依赖 DNS。

use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 用 IP 直接连的 DoH 服务（JSON 格式），按顺序试
const DOH: &[&str] = &["https://1.1.1.1/dns-query", "https://8.8.8.8/resolve", "https://1.0.0.1/dns-query"];
/// 查到的真地址缓存多久
const ANSWER_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    /// 系统 DNS 没问题，照常连
    Ok,
    /// 系统 DNS 给了假地址（或查不到），用 DoH 的真地址能连上
    Poisoned,
    /// 真地址也连不上：网络不通（VPN 没开、断网）
    Down,
}

impl Verdict {
    /// 结论记多久：没问题和被污染都比较稳定；不通的很快重测（可能马上就开了 VPN）
    fn keep_for(self) -> Duration {
        match self {
            Verdict::Ok => Duration::from_secs(10 * 60),
            Verdict::Poisoned => Duration::from_secs(30 * 60),
            Verdict::Down => Duration::from_secs(20),
        }
    }
}

type Cache<T> = Mutex<Option<HashMap<String, (T, Instant)>>>;
static ANSWERS: Cache<Vec<IpAddr>> = Mutex::new(None);
static VERDICTS: Cache<Verdict> = Mutex::new(None);

fn cache_get<T: Clone>(cache: &Cache<T>, key: &str, ttl: impl Fn(&T) -> Duration) -> Option<T> {
    let map = cache.lock().unwrap_or_else(|e| e.into_inner());
    map.as_ref()?.get(key).filter(|(v, at)| at.elapsed() < ttl(v)).map(|(v, _)| v.clone())
}

fn cache_put<T>(cache: &Cache<T>, key: &str, value: T) {
    let mut map = cache.lock().unwrap_or_else(|e| e.into_inner());
    map.get_or_insert_with(HashMap::new).insert(key.to_string(), (value, Instant::now()));
}

/// 只认普通域名（字母数字、点、横线），免得拼进 URL 出事
pub fn valid_host(host: &str) -> bool {
    !host.is_empty() && host.len() <= 253 && !host.starts_with(['-', '.']) && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// DoH JSON 回复里的 A 记录
pub fn parse_answer(json: &[u8]) -> Vec<IpAddr> {
    let v: serde_json::Value = serde_json::from_slice(json).unwrap_or_default();
    v["Answer"]
        .as_array()
        .map(|a| a.iter().filter(|r| r["type"] == 1).filter_map(|r| r["data"].as_str()?.parse().ok()).collect())
        .unwrap_or_default()
}

fn doh_query(endpoint: &str, host: &str) -> Result<Vec<IpAddr>, String> {
    let out = Command::new("/usr/bin/curl")
        .args(["-sS", "--connect-timeout", "4", "--max-time", "8", "--noproxy", "*", "-H", "accept: application/dns-json"])
        .arg(format!("{endpoint}?name={host}&type=A"))
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(parse_answer(&out.stdout))
}

/// 用 DoH 查真地址（只要 IPv4，VPN 隧道不一定通 IPv6）
pub fn doh_lookup(host: &str) -> Result<Vec<IpAddr>, String> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![ip]);
    }
    let host = host.to_ascii_lowercase();
    if !valid_host(&host) {
        return Err("域名不对".into());
    }
    if let Some(ips) = cache_get(&ANSWERS, &host, |_| ANSWER_TTL) {
        return Ok(ips);
    }
    let mut last = String::new();
    for ep in DOH {
        match doh_query(ep, &host) {
            Ok(ips) if !ips.is_empty() => {
                cache_put(&ANSWERS, &host, ips.clone());
                return Ok(ips);
            }
            Ok(_) => last = "查不到这个域名".into(),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// 按系统 DNS 查（getaddrinfo），只取 IPv4
pub fn system_lookup(host: &str) -> Vec<IpAddr> {
    (host, 443).to_socket_addrs().map(|a| a.map(|s| s.ip()).filter(IpAddr::is_ipv4).collect()).unwrap_or_default()
}

/// 用 https 连一下：只要服务器有回应就算通。`ip` 给了就不查 DNS，直接连这个地址
fn https_ok(url: &str, ip: Option<IpAddr>) -> bool {
    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args(["-sS", "-I", "-o", "/dev/null", "-w", "%{http_code}", "--connect-timeout", "4", "--max-time", "8", "--noproxy", "*"]);
    if let Some(ip) = ip {
        cmd.arg("--resolve").arg(format!("{}:443:{ip}", crate::net::host_of(url)));
    }
    cmd.arg(url).output().is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u16>().is_ok_and(|c| c > 0))
}

/// 系统 DNS 那条路已经连不上了，再查一步：是 DNS 被污染，还是网络不通。返回结论和一句给用户看的话
pub fn check_after_fail(url: &str) -> (Verdict, String) {
    let host = crate::net::host_of(url);
    let real = match doh_lookup(host) {
        Ok(ips) => ips,
        Err(_) => return (Verdict::Down, "网络不通：连加密 DNS 都连不上，看看 VPN 开着没有".into()),
    };
    if real.iter().take(2).any(|ip| https_ok(url, Some(*ip))) {
        let sys = system_lookup(host);
        let said = sys.first().map(|ip| format!("（给了 {ip}）")).unwrap_or_default();
        return (Verdict::Poisoned, format!("路由器 DNS 被污染{said}，已改用加密 DNS 绕开"));
    }
    (Verdict::Down, "网络不通：查到了真地址也连不上，看看 VPN 开着没有".into())
}

/// 记下一个服务的结论（设置里「测一下」测完也记）
pub fn remember(key: &str, verdict: Verdict) {
    cache_put(&VERDICTS, key, verdict);
}

/// 一个服务现在的结论；没测过或过期了就测一次（`url` 是这个服务的测连地址）
pub fn verdict(key: &str, url: &str) -> Verdict {
    if let Some(v) = cache_get(&VERDICTS, key, |v: &Verdict| v.keep_for()) {
        return v;
    }
    let v = if https_ok(url, None) { Verdict::Ok } else { check_after_fail(url).0 };
    remember(key, v);
    v
}

// ---------- 本机解析代理 ----------

struct Proxy {
    port: u16,
    /// 写进代理地址的「用户名:口令」
    user_pass: String,
}

static PROXY: OnceLock<Result<Proxy, String>> = OnceLock::new();

fn random_token() -> String {
    let mut buf = [0u8; 16];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).is_err() {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        buf = (t ^ (std::process::id() as u128) << 64).to_le_bytes();
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn start_proxy() -> Result<Proxy, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("开不了本机代理：{e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let user_pass = format!("bz:{}", random_token());
    let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(&user_pass));
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let auth = auth.clone();
            std::thread::spawn(move || {
                let _ = serve(conn, &auth);
            });
        }
    });
    Ok(Proxy { port, user_pass })
}

/// 本机解析代理的地址（第一次用时启动，之后一直开着，跟着应用进程走）
pub fn proxy_url() -> Result<String, String> {
    let p = PROXY.get_or_init(start_proxy).as_ref().map_err(Clone::clone)?;
    Ok(format!("http://{}@127.0.0.1:{}", p.user_pass, p.port))
}

/// 解析代理收到的请求头 → 要连的（主机, 端口）。不对的返回要回的 HTTP 状态
pub fn parse_connect(head: &str, auth: &str) -> Result<(String, u16), &'static str> {
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let authed = lines.any(|l| l.split_once(':').is_some_and(|(k, v)| k.trim().eq_ignore_ascii_case("proxy-authorization") && v.trim() == auth));
    if !authed {
        return Err("407 Proxy Authentication Required");
    }
    if method != "CONNECT" {
        return Err("405 Method Not Allowed");
    }
    let (host, port) = target.rsplit_once(':').ok_or("400 Bad Request")?;
    let port: u16 = port.parse().map_err(|_| "400 Bad Request")?;
    if port != 443 && port != 80 {
        return Err("403 Forbidden");
    }
    if !valid_host(host) {
        return Err("400 Bad Request");
    }
    Ok((host.to_ascii_lowercase(), port))
}

fn connect_real(host: &str, port: u16) -> Option<TcpStream> {
    let ips = doh_lookup(host).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| system_lookup(host));
    ips.iter().take(4).find_map(|ip| TcpStream::connect_timeout(&SocketAddr::new(*ip, port), Duration::from_secs(8)).ok())
}

fn serve(mut client: TcpStream, auth: &str) -> std::io::Result<()> {
    client.set_read_timeout(Some(Duration::from_secs(15)))?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = client.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > 16 * 1024 {
            return client.write_all(b"HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n");
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let (host, port) = match parse_connect(&head, auth) {
        Ok(t) => t,
        Err(status) => {
            let extra = if status.starts_with("407") { "Proxy-Authenticate: Basic realm=\"banzou\"\r\n" } else { "" };
            return client.write_all(format!("HTTP/1.1 {status}\r\n{extra}Content-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
        }
    };
    let Some(mut upstream) = connect_real(&host, port) else {
        return client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")?;
    client.set_read_timeout(None)?;
    if head_end < buf.len() {
        upstream.write_all(&buf[head_end..])?;
    }
    let (mut c2, mut u2) = (client.try_clone()?, upstream.try_clone()?);
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut c2, &mut u2);
        let _ = u2.shutdown(Shutdown::Write);
    });
    let _ = std::io::copy(&mut upstream, &mut client);
    let _ = client.shutdown(Shutdown::Write);
    let _ = up.join();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_doh_answers() {
        let json = br#"{"Status":0,"Answer":[{"name":"www.youtube.com.","type":5,"data":"youtube-ui.l.google.com."},{"name":"x","type":1,"data":"142.251.157.4"},{"name":"x","type":1,"data":"142.251.156.4"}]}"#;
        assert_eq!(parse_answer(json), vec!["142.251.157.4".parse::<IpAddr>().unwrap(), "142.251.156.4".parse().unwrap()]);
        assert!(parse_answer(b"{\"Status\":3}").is_empty());
        assert!(parse_answer(b"not json").is_empty());
    }

    #[test]
    fn hosts_are_checked() {
        assert!(valid_host("rr3---sn-a5mekn6d.googlevideo.com"));
        assert!(!valid_host("a.com&type=AAAA"));
        assert!(!valid_host("-x.com"));
        assert!(!valid_host(""));
        assert_eq!(doh_lookup("1.2.3.4").unwrap(), vec!["1.2.3.4".parse::<IpAddr>().unwrap()]);
        assert!(doh_lookup("a b.com").is_err());
    }

    #[test]
    fn connect_requests() {
        let auth = "Basic YnM6eA==";
        let ok = "CONNECT www.YouTube.com:443 HTTP/1.1\r\nHost: www.youtube.com:443\r\nProxy-Authorization: Basic YnM6eA==\r\n\r\n";
        assert_eq!(parse_connect(ok, auth), Ok(("www.youtube.com".into(), 443)));
        assert_eq!(parse_connect("CONNECT a.com:443 HTTP/1.1\r\n\r\n", auth), Err("407 Proxy Authentication Required"));
        assert_eq!(parse_connect("CONNECT a.com:443 HTTP/1.1\r\nproxy-authorization: Basic nope\r\n\r\n", auth), Err("407 Proxy Authentication Required"));
        assert_eq!(parse_connect("GET http://a.com/ HTTP/1.1\r\nProxy-Authorization: Basic YnM6eA==\r\n\r\n", auth), Err("405 Method Not Allowed"));
        assert_eq!(parse_connect("CONNECT a.com:22 HTTP/1.1\r\nProxy-Authorization: Basic YnM6eA==\r\n\r\n", auth), Err("403 Forbidden"));
    }

    #[test]
    fn proxy_rejects_strangers() {
        let url = proxy_url().unwrap();
        let port: u16 = url.rsplit(':').next().unwrap().parse().unwrap();
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n").unwrap();
        let mut reply = String::new();
        s.read_to_string(&mut reply).unwrap();
        assert!(reply.starts_with("HTTP/1.1 407"), "{reply}");
    }
}
