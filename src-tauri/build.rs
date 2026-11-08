use std::path::Path;
use std::process::Command;

/// 编译系统能力小助手（Swift：语音识别、音频设备检测），作为 Tauri sidecar 打进 app。
fn build_helper() {
    let src = Path::new("helpers/helper.swift");
    println!("cargo:rerun-if-changed={}", src.display());
    let target = std::env::var("TARGET").unwrap_or_else(|_| "aarch64-apple-darwin".into());
    let out = Path::new("binaries").join(format!("banzou-helper-{target}"));
    let fresh = match (src.metadata().and_then(|m| m.modified()), out.metadata().and_then(|m| m.modified())) {
        (Ok(s), Ok(o)) => o >= s,
        _ => false,
    };
    if fresh {
        return;
    }
    std::fs::create_dir_all("binaries").expect("创建 binaries 目录失败");
    let status = Command::new("swiftc")
        .args(["-O", "-o"])
        .arg(&out)
        .arg(src)
        .status()
        .expect("找不到 swiftc（需要 Xcode 命令行工具）");
    assert!(status.success(), "编译 helpers/helper.swift 失败");
}

fn main() {
    build_helper();
    tauri_build::build()
}
