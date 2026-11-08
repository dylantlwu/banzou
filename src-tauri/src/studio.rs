//! 修音 / 导出相关的命令实现（正式 app 的 Tauri 命令和测试模式的 devbridge 共用）。

use crate::dsp::{pitch::PitchTrack, process, wav};
use crate::lyrics_store::sanitize_file_stem;
use crate::recording::{self, song_dir};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn inside_root(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| format!("曲库文件夹不可用：{e}"))?;
    let path = path.canonicalize().map_err(|e| format!("找不到文件：{e}"))?;
    if !path.starts_with(&root) {
        return Err("只能处理曲库文件夹里的文件".into());
    }
    Ok(path)
}

fn take_file(root: &Path, title: &str, take_id: &str, suffix: &str) -> Result<PathBuf, String> {
    let id = sanitize_file_stem(take_id);
    let dir = song_dir(root, title);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{id}{suffix}")))
}

/// 音高曲线（有缓存）
pub fn analyze_pitch(root: &Path, cache: &Path, path: &str) -> Result<PitchTrack, String> {
    let path = inside_root(root, Path::new(path))?;
    process::analyze(&path, cache).map_err(|e| format!("音高分析失败：{e}"))
}

/// 把一遍 Take 拼成连续音频 `<id>.comp.wav`
pub fn render_take(root: &Path, title: &str, take_id: &str, clips: Value, adjust_ms: f64) -> Result<process::Rendered, String> {
    let clips: Vec<process::Clip> = serde_json::from_value(clips).map_err(|e| format!("录音段格式不对：{e}"))?;
    let out = take_file(root, title, take_id, ".comp.wav")?;
    process::render_comp(&song_dir(root, title), &clips, adjust_ms / 1000.0, &out).map_err(|e| format!("拼接录音失败：{e}"))
}

/// 按修音曲线渲染 `<id>.tuned.wav`（range = 只重渲这一段，秒，相对拼接后的录音），返回路径
pub fn render_tuned(root: &Path, cache: &Path, title: &str, take_id: &str, job: Value, range: Option<(f64, f64)>) -> Result<String, String> {
    let job: process::TuneRender = serde_json::from_value(job).map_err(|e| format!("修音参数格式不对：{e}"))?;
    let input = take_file(root, title, take_id, ".comp.wav")?;
    if !input.exists() {
        return Err("还没有拼好的录音，请先打开修音页".into());
    }
    let noise_audio = match (&job.noise, &job.noise_file) {
        (Some((from, to)), file) => {
            let src = match file {
                Some(f) => recording::checked_path(root, &song_dir(root, title).join(f), ".wav").map_err(|e| e.to_string())?,
                None => input.clone(),
            };
            let (x, sr) = wav::read_mono(&src).map_err(|e| e.to_string())?;
            let a = ((from * sr as f64) as usize).min(x.len());
            let b = ((to * sr as f64) as usize).min(x.len());
            Some(x[a..b].to_vec())
        }
        _ => None,
    };
    let out = take_file(root, title, take_id, ".tuned.wav")?;
    match range {
        Some((a, b)) => process::render_tuned_range(&input, &job, noise_audio.as_deref(), &out, cache, a, b),
        None => process::render_tuned(&input, &job, noise_audio.as_deref(), &out, cache),
    }
    .map_err(|e| format!("修音失败：{e}"))?;
    Ok(out.to_string_lossy().into_owned())
}

pub fn load_tune(root: &Path, title: &str, take_id: &str) -> Result<Value, String> {
    let path = take_file(root, title, take_id, ".tune.json")?;
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("修音记录损坏：{e}")),
        Err(_) => Ok(Value::Null),
    }
}

pub fn save_tune(root: &Path, title: &str, take_id: &str, value: &Value) -> Result<(), String> {
    let path = take_file(root, title, take_id, ".tune.json")?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value).unwrap()).map_err(|e| e.to_string())?;
    fs::rename(tmp, path).map_err(|e| e.to_string())
}

pub fn export_begin(root: &Path, title: &str, name: &str, sample_rate: u32, channels: u16) -> Result<String, String> {
    recording::begin_export(root, title, name, sample_rate, channels)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("导出失败：{e}"))
}

pub fn export_append(root: &Path, path: &str, data: &str) -> Result<(), String> {
    recording::append(root, Path::new(path), data).map_err(|e| format!("导出失败：{e}"))
}

/// 结束导出；`m4a` 为真时再编一份 m4a（保留 wav），返回所有生成的文件
pub fn export_finish(root: &Path, path: &str, m4a: bool) -> Result<Vec<String>, String> {
    let wav = recording::finish(root, Path::new(path)).map_err(|e| format!("导出失败：{e}"))?;
    let mut out = vec![wav.to_string_lossy().into_owned()];
    if m4a {
        let target = wav.with_extension("m4a");
        process::encode_m4a(&wav, &target).map_err(|e| format!("编码 m4a 失败：{e}"))?;
        out.push(target.to_string_lossy().into_owned());
    }
    Ok(out)
}

/// 把修后干声复制到导出文件夹
pub fn export_dry(root: &Path, title: &str, take_id: &str, name: &str) -> Result<String, String> {
    let tuned = take_file(root, title, take_id, ".tuned.wav")?;
    let src = if tuned.exists() { tuned } else { take_file(root, title, take_id, ".comp.wav")? };
    let dir = song_dir(root, title).join(recording::EXPORT_DIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = sanitize_file_stem(name);
    let mut n = 1;
    let target = loop {
        let p = dir.join(if n == 1 { format!("{stem}.wav") } else { format!("{stem} ({n}).wav") });
        if !p.exists() {
            break p;
        }
        n += 1;
    };
    fs::copy(&src, &target).map_err(|e| format!("导出失败：{e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// 在访达里显示
pub fn reveal(root: &Path, path: &str) -> Result<(), String> {
    let p = inside_root(root, Path::new(path))?;
    std::process::Command::new("/usr/bin/open").arg("-R").arg(p).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// 升降调后的音频（不变速），缓存在 `<曲库>/录音/升降调缓存/`（不能用 . 开头的隐藏文件夹：应用的文件访问规则会跳过它）
pub fn transpose_file(root: &Path, path: &str, semitones: f64) -> Result<String, String> {
    use crate::dsp::transpose::pitch_shift;
    let src = inside_root(root, Path::new(path))?;
    // 精度到 1 音分就够（变速补偿会算出小数半音）
    let semitones = (semitones * 100.0).round() / 100.0;
    if semitones.abs() < 0.005 {
        return Ok(src.to_string_lossy().into_owned());
    }
    if !src.extension().is_some_and(|e| e.eq_ignore_ascii_case("wav")) {
        return Err("升降调目前只支持 wav 格式的伴奏 / 人声".into());
    }
    let meta = fs::metadata(&src).map_err(|e| e.to_string())?;
    let stem = src.file_stem().unwrap_or_default().to_string_lossy();
    let dir = root.join(recording::RECORDINGS_DIR).join("升降调缓存");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 文件名里别用「+」：有的 URL 解码不会把 %2B 还原，会找不到文件
    let label = if semitones > 0.0 { format!("升{semitones}") } else { format!("降{}", -semitones) };
    let out = dir.join(format!("{stem} ({label}) {}.wav", meta.len()));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    let (channels, sr) = wav::read_channels(&src).map_err(|e| format!("读取音频失败：{e}"))?;
    let shifted: Vec<Vec<f32>> = std::thread::scope(|scope| {
        let handles: Vec<_> = channels.iter().map(|c| scope.spawn(move || pitch_shift(c, semitones))).collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let n = shifted.iter().map(Vec::len).min().unwrap_or(0);
    let ch = shifted.len();
    let mut inter = Vec::with_capacity(n * ch);
    for i in 0..n {
        for c in &shifted {
            inter.push(c[i]);
        }
    }
    wav::write_f32(&out, ch as u16, sr, &inter).map_err(|e| format!("保存失败：{e}"))?;
    Ok(out.to_string_lossy().into_owned())
}

/// 从原曲视频里抽出音频，存成 `<歌名> - 原曲.wav` 放在曲库里（扫描后作为可试听的音源出现）
pub fn extract_audio(root: &Path, video: &str, title: &str) -> Result<String, String> {
    let src = inside_root(root, Path::new(video))?;
    let out = root.join(format!("{} - 原曲.m4a", sanitize_file_stem(title)));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    // 视频里的音轨一般就是 AAC，直接转封装成 m4a，不重新编码
    let status = std::process::Command::new("/usr/bin/afconvert")
        .args(["-f", "m4af", "-d", "aac", "-b", "256000"])
        .arg(&src)
        .arg(&out)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() || !out.exists() {
        let _ = fs::remove_file(&out);
        return Err("抽取音频失败：这个视频的音轨格式系统不支持".into());
    }
    Ok(out.to_string_lossy().into_owned())
}

/// 用系统默认程序打开（原曲视频用 QuickTime 之类）
pub fn open_file(root: &Path, path: &str) -> Result<(), String> {
    let p = inside_root(root, Path::new(path))?;
    std::process::Command::new("/usr/bin/open").arg(p).status().map_err(|e| e.to_string())?;
    Ok(())
}
