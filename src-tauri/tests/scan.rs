//! 集成测试：真实文件系统上的扫描

use banzou_lib::library::scan_dir;
use std::fs;

#[test]
fn scans_temp_folder_and_ignores_subdirs() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for name in ["夜曲 - 伴奏.mp3", "夜曲 - 伴奏.wav", "夜曲 - 人声.wav", "夜曲.lrc", ".DS_Store", "随手录.m4a"] {
        fs::write(root.join(name), b"x").unwrap();
    }
    fs::create_dir(root.join("子文件夹")).unwrap();
    fs::write(root.join("子文件夹").join("别的歌 - 伴奏.mp3"), b"x").unwrap();

    let lib = scan_dir(root).unwrap();
    assert_eq!(lib.songs.len(), 1);
    let song = &lib.songs[0];
    assert_eq!(song.title, "夜曲");
    assert_eq!(song.accompaniments[0].format, "wav");
    assert!(song.lyrics.is_some());
    assert_eq!(lib.unassigned.len(), 1);

    // 新增文件后重新扫描能发现
    fs::write(root.join("晴天 - 伴奏.flac"), b"x").unwrap();
    assert_eq!(scan_dir(root).unwrap().songs.len(), 2);
}

#[test]
fn missing_folder_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    assert!(scan_dir(&dir.path().join("不存在")).is_err());
}
