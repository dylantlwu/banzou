//! 直播叠加层：本机小网页服务（只监听 127.0.0.1），给 OBS「浏览器源」用。
//!
//! - `GET /overlay`  叠加层页面（透明背景，跟着播放显示歌词）
//! - `GET /events`   Server-Sent Events，推送歌词和播放状态
//! - `GET /state`    当前状态（调试用）
//! - `POST /update`  应用把状态推上来（JSON：type = "full" 歌词和样式 / "pos" 播放位置）
//! - `POST /audio`   应用推上来的直播混音（16 位立体声 PCM 片段）
//! - `GET /audio-stream`  叠加层页面拉取直播混音（分块传输的原始 PCM）
//!
//! 只用标准库，不引入 HTTP 框架；一个连接一个线程，连接数很少（OBS + 歌词窗口）。

use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub const DEFAULT_PORT: u16 = 17890;
const OVERLAY_HTML: &str = include_str!("../overlay/overlay.html");

#[derive(Default)]
struct Shared {
    full: Option<String>,
    pos: Option<String>,
    clients: Vec<TcpStream>,
    audio_clients: Vec<TcpStream>,
}

#[derive(Clone)]
pub struct LiveServer {
    shared: Arc<Mutex<Shared>>,
    pub port: u16,
}

impl LiveServer {
    /// 启动服务；端口被占用时依次试后面 10 个
    pub fn start(preferred: u16) -> std::io::Result<Self> {
        let mut last_err = None;
        for port in preferred..preferred + 10 {
            match TcpListener::bind(("127.0.0.1", port)) {
                Ok(listener) => {
                    let server = LiveServer { shared: Arc::new(Mutex::new(Shared::default())), port };
                    let s = server.clone();
                    thread::spawn(move || {
                        for stream in listener.incoming().flatten() {
                            let s = s.clone();
                            thread::spawn(move || {
                                let _ = s.handle(stream);
                            });
                        }
                    });
                    return Ok(server);
                }
                Err(e) => last_err = Some(e),
            }
        }
        Err(last_err.unwrap())
    }

    /// 收到应用推来的状态：存下来并广播给所有叠加层
    pub fn update(&self, body: &str) -> Result<(), String> {
        let value: Value = serde_json::from_str(body).map_err(|e| format!("状态格式不对：{e}"))?;
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let mut shared = self.shared.lock().unwrap();
        match kind {
            "full" => shared.full = Some(body.to_string()),
            "pos" => shared.pos = Some(body.to_string()),
            _ => return Err("状态缺少 type".into()),
        }
        let msg = format!("data: {body}\n\n");
        shared.clients.retain_mut(|c| c.write_all(msg.as_bytes()).and_then(|_| c.flush()).is_ok());
        Ok(())
    }

    /// 直播混音片段：转发给所有在听的叠加层（HTTP 分块）
    pub fn push_audio(&self, pcm: &[u8]) {
        if pcm.is_empty() {
            return;
        }
        let mut frame = format!("{:X}\r\n", pcm.len()).into_bytes();
        frame.extend_from_slice(pcm);
        frame.extend_from_slice(b"\r\n");
        let mut shared = self.shared.lock().unwrap();
        shared.audio_clients.retain_mut(|c| c.write_all(&frame).and_then(|_| c.flush()).is_ok());
    }

    pub fn audio_listeners(&self) -> usize {
        self.shared.lock().unwrap().audio_clients.len()
    }

    pub fn client_count(&self) -> usize {
        self.shared.lock().unwrap().clients.len()
    }

    fn handle(&self, mut stream: TcpStream) -> std::io::Result<()> {
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut request_line = String::new();
        reader.read_line(&mut request_line)?;
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let path = parts.next().unwrap_or("/").split('?').next().unwrap_or("/").to_string();

        let mut content_length = 0usize;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
                break;
            }
            if let Some((k, v)) = line.split_once(':') {
                if k.trim().eq_ignore_ascii_case("content-length") {
                    content_length = v.trim().parse().unwrap_or(0);
                }
            }
        }

        match (method.as_str(), path.as_str()) {
            ("OPTIONS", _) => respond(&mut stream, "204 No Content", "text/plain", b""),
            ("GET", "/" | "/overlay") => respond(&mut stream, "200 OK", "text/html; charset=utf-8", OVERLAY_HTML.as_bytes()),
            ("GET", "/state") => {
                let shared = self.shared.lock().unwrap();
                let body = format!(
                    "{{\"full\":{},\"pos\":{},\"clients\":{},\"audioListeners\":{}}}",
                    shared.full.as_deref().unwrap_or("null"),
                    shared.pos.as_deref().unwrap_or("null"),
                    shared.clients.len(),
                    shared.audio_clients.len()
                );
                drop(shared);
                respond(&mut stream, "200 OK", "application/json", body.as_bytes())
            }
            ("GET", "/events") => {
                stream.set_read_timeout(None)?;
                stream.set_write_timeout(Some(Duration::from_secs(2)))?;
                stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: *\r\n\r\nretry: 1000\n\n",
                )?;
                let mut shared = self.shared.lock().unwrap();
                for msg in [shared.full.clone(), shared.pos.clone()].into_iter().flatten() {
                    stream.write_all(format!("data: {msg}\n\n").as_bytes())?;
                }
                stream.flush()?;
                shared.clients.push(stream);
                Ok(())
            }
            ("GET", "/audio-stream") => {
                stream.set_read_timeout(None)?;
                stream.set_write_timeout(Some(Duration::from_millis(500)))?;
                stream.set_nodelay(true)?;
                stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\nCache-Control: no-cache\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
                )?;
                stream.flush()?;
                self.shared.lock().unwrap().audio_clients.push(stream);
                Ok(())
            }
            ("POST", "/audio") => {
                let mut body = vec![0u8; content_length.min(1024 * 1024)];
                reader.read_exact(&mut body)?;
                self.push_audio(&body);
                respond(&mut stream, "204 No Content", "text/plain", b"")
            }
            ("POST", "/update") => {
                let mut body = vec![0u8; content_length.min(4 * 1024 * 1024)];
                reader.read_exact(&mut body)?;
                match self.update(&String::from_utf8_lossy(&body)) {
                    Ok(()) => respond(&mut stream, "204 No Content", "text/plain", b""),
                    Err(e) => respond(&mut stream, "400 Bad Request", "text/plain; charset=utf-8", e.as_bytes()),
                }
            }
            _ => respond(&mut stream, "404 Not Found", "text/plain", b"not found"),
        }
    }
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http(port: u16, req: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn serves_overlay_and_broadcasts_updates() {
        let server = LiveServer::start(18890).unwrap();
        let port = server.port;
        assert!(http(port, "GET /overlay HTTP/1.1\r\n\r\n").contains("<html"));

        // 订阅事件
        let mut events = TcpStream::connect(("127.0.0.1", port)).unwrap();
        events.write_all(b"GET /events HTTP/1.1\r\n\r\n").unwrap();
        events.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        thread::sleep(Duration::from_millis(100));

        let body = r#"{"type":"pos","position":12.5,"playing":true}"#;
        let resp = http(port, &format!("POST /update HTTP/1.1\r\nContent-Length: {}\r\n\r\n{body}", body.len()));
        assert!(resp.starts_with("HTTP/1.1 204"));

        let mut buf = [0u8; 2048];
        let mut got = String::new();
        while !got.contains("12.5") {
            let n = events.read(&mut buf).unwrap();
            assert!(n > 0);
            got.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        assert_eq!(server.client_count(), 1);
        assert!(http(port, "GET /state HTTP/1.1\r\n\r\n").contains("\"position\":12.5"));

        let bad = http(port, "POST /update HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}");
        assert!(bad.starts_with("HTTP/1.1 400"));

        // 直播音频：推上来的 PCM 原样转给在听的页面
        let mut listener = TcpStream::connect(("127.0.0.1", port)).unwrap();
        listener.write_all(b"GET /audio-stream HTTP/1.1\r\n\r\n").unwrap();
        listener.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        thread::sleep(Duration::from_millis(100));
        assert_eq!(server.audio_listeners(), 1);
        let pcm = [1u8, 2, 3, 4, 5, 6, 7, 8];
        let mut req = format!("POST /audio HTTP/1.1\r\nContent-Length: {}\r\n\r\n", pcm.len()).into_bytes();
        req.extend_from_slice(&pcm);
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(&req).unwrap();
        let mut got = Vec::new();
        let mut buf = [0u8; 1024];
        while !got.windows(4).any(|w| w == b"8\r\n\x01") {
            let n = listener.read(&mut buf).unwrap();
            assert!(n > 0);
            got.extend_from_slice(&buf[..n]);
        }
    }
}
