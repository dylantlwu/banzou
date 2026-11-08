//! 测试模式用：单独运行直播叠加层服务（17890 端口），浏览器测试模式通过 devbridge 往这里推状态。
fn main() {
    let server = banzou_lib::live::LiveServer::start(17890).expect("启动失败");
    println!("直播叠加层：http://127.0.0.1:{}/overlay", server.port);
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
