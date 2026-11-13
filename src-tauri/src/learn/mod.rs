//! 外语学唱（PRD 4.12）：老师笔记、问老师。备课、一句一循环、语音识别以后加在这里
pub mod notes;
pub mod teacher;

use serde::Serialize;
use std::path::Path;

use notes::{Note, Scope};

/// 界面上看的两本笔记
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesView {
    pub global: Vec<Note>,
    pub song: Vec<Note>,
    pub global_path: String,
    pub song_path: Option<String>,
}

pub fn notes_view(config: &Path, root: Option<&Path>, title: Option<&str>) -> NotesView {
    let song_path = root.zip(title).map(|(r, t)| notes::song_path(r, t));
    NotesView {
        global: notes::load_global(config),
        song: song_path.as_deref().map(notes::load).unwrap_or_default(),
        global_path: notes::global_path(config).to_string_lossy().into_owned(),
        song_path: song_path.map(|p| p.to_string_lossy().into_owned()),
    }
}

/// 在应用里改笔记：index 为空 = 加一条；text 为空 = 删掉
pub fn note_set(config: &Path, root: &Path, scope: Scope, title: Option<&str>, index: Option<usize>, text: &str) -> Result<(), String> {
    let path = match (scope, title) {
        (Scope::Global, _) => notes::global_path(config),
        (Scope::Song, Some(t)) => notes::song_path(root, t),
        (Scope::Song, None) => return Err("没有选歌".into()),
    };
    match index {
        Some(i) => notes::set(&path, i, text),
        None => notes::add(&path, scope, title.unwrap_or(""), text, "你加的", None).map(|_| ()),
    }
}
