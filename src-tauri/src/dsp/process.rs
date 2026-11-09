//! 修音流程里的文件级处理：Take 拼接、降噪、按修音曲线渲染、音高分析缓存、导出编码。

use super::{pitch, psola, wav};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};

/// 和前端 takes.ts 的 Clip 一致（只用到这几个字段）
#[derive(Debug, Clone, Deserialize)]
pub struct Clip {
    pub file: String,
    pub start: f64,
    pub from: f64,
    pub to: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendered {
    pub path: String,
    /// 输出文件第 0 个采样对应的歌曲时间
    pub start: f64,
    pub sample_rate: u32,
    pub seconds: f64,
}

const FADE: f64 = 0.015;

/// 把一遍 Take 的各段录音拼成一条连续的音频（歌曲时间 [min from, max to]）
pub fn render_comp(dir: &Path, clips: &[Clip], adjust: f64, out: &Path) -> io::Result<Rendered> {
    if clips.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "这一遍没有录音"));
    }
    let t0 = clips.iter().map(|c| c.from).fold(f64::INFINITY, f64::min);
    let t1 = clips.iter().map(|c| c.to).fold(f64::NEG_INFINITY, f64::max);
    let mut cache: Vec<(String, Vec<f32>, u32)> = Vec::new();
    let mut sr_out = 0u32;
    for c in clips {
        if !cache.iter().any(|(f, _, _)| f == &c.file) {
            let (s, sr) = wav::read_mono(&dir.join(&c.file))?;
            sr_out = sr_out.max(sr);
            cache.push((c.file.clone(), s, sr));
        }
    }
    let sr = sr_out as f64;
    let n = ((t1 - t0) * sr).ceil() as usize;
    let mut buf = vec![0.0f32; n];
    for c in clips {
        let (_, src, src_sr) = cache.iter().find(|(f, _, _)| f == &c.file).unwrap();
        let src = if *src_sr == sr_out { src.clone() } else { wav::resample(src, *src_sr, sr_out) };
        let start = c.start + adjust;
        let i0 = ((c.from - t0) * sr).round() as usize;
        let i1 = (((c.to - t0) * sr).round() as usize).min(n);
        let fade = (FADE * sr) as usize;
        for i in i0..i1 {
            let t = t0 + i as f64 / sr;
            let j = ((t - start) * sr).round();
            if j < 0.0 || j as usize >= src.len() {
                continue;
            }
            let edge = (i - i0).min(i1 - 1 - i);
            let g = if edge < fade { edge as f32 / fade as f32 } else { 1.0 };
            buf[i] += src[j as usize] * g;
        }
    }
    wav::write_f32(out, 1, sr_out, &buf)?;
    Ok(Rendered { path: out.to_string_lossy().into_owned(), start: t0, sample_rate: sr_out, seconds: n as f64 / sr })
}

/// RNNoise 降噪（内部按 48kHz 处理）
pub fn denoise(samples: &[f32], sr: u32) -> Vec<f32> {
    use nnnoiseless::DenoiseState;
    let x = wav::resample(samples, sr, 48000);
    let mut state = DenoiseState::new();
    let frame = DenoiseState::FRAME_SIZE;
    let mut out = Vec::with_capacity(x.len() + frame);
    let mut inbuf = vec![0.0f32; frame];
    let mut outbuf = vec![0.0f32; frame];
    let mut first = true;
    for chunk in x.chunks(frame) {
        inbuf.fill(0.0);
        for (i, &v) in chunk.iter().enumerate() {
            inbuf[i] = v * 32768.0;
        }
        state.process_frame(&mut outbuf, &inbuf);
        // 第一帧有淡入伪影，按官方示例丢掉
        if first {
            first = false;
            out.extend(std::iter::repeat_n(0.0, frame));
        } else {
            out.extend(outbuf.iter().map(|v| v / 32768.0));
        }
    }
    out.truncate(x.len());
    wav::resample(&out, 48000, sr)
}

/// 频谱减法降噪：用录音前那 2 秒环境底噪的频谱做参考，把每个频段里低于底噪的部分压下去。
/// 比通用降噪更稳：只去掉这个房间、这支麦克风特有的底噪，人声基本不受影响。
pub fn denoise_with_profile(samples: &[f32], noise: &[f32]) -> Vec<f32> {
    use rustfft::{num_complex::Complex32, FftPlanner};
    const N: usize = 1024;
    const HOP: usize = 256;
    if noise.len() < N * 2 {
        return samples.to_vec();
    }
    let window: Vec<f32> = (0..N).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / N as f32).cos()).collect();
    let mut planner = FftPlanner::<f32>::new();
    let fwd = planner.plan_fft_forward(N);
    let inv = planner.plan_fft_inverse(N);
    let spectrum = |frame: &[f32], buf: &mut Vec<Complex32>| {
        for i in 0..N {
            buf[i] = Complex32::new(frame.get(i).copied().unwrap_or(0.0) * window[i], 0.0);
        }
        fwd.process(buf);
    };
    // 底噪平均幅度谱
    let mut profile = vec![0.0f32; N];
    let mut buf = vec![Complex32::new(0.0, 0.0); N];
    let mut count = 0;
    let mut i = 0;
    while i + N <= noise.len() {
        spectrum(&noise[i..i + N], &mut buf);
        for k in 0..N {
            profile[k] += buf[k].norm();
        }
        count += 1;
        i += HOP;
    }
    for p in profile.iter_mut() {
        *p /= count as f32;
    }
    // 逐帧：增益 = max(1 - 2 × 底噪 / 幅度, 0.1)，时间上平滑一下避免「水声」
    let mut out = vec![0.0f32; samples.len() + N];
    let mut norm = vec![0.0f32; samples.len() + N];
    let mut prev_gain = vec![1.0f32; N];
    let mut pos = 0;
    while pos < samples.len() {
        let end = (pos + N).min(samples.len());
        spectrum(&samples[pos..end], &mut buf);
        for k in 0..N {
            let mag = buf[k].norm().max(1e-9);
            let g = (1.0 - 2.0 * profile[k] / mag).max(0.1);
            let g = 0.6 * g + 0.4 * prev_gain[k];
            prev_gain[k] = g;
            buf[k] *= g;
        }
        inv.process(&mut buf);
        for i in 0..N {
            out[pos + i] += buf[i].re / N as f32 * window[i];
            norm[pos + i] += window[i] * window[i];
        }
        pos += HOP;
    }
    (0..samples.len()).map(|i| if norm[i] > 1e-6 { out[i] / norm[i] } else { 0.0 }).collect()
}

/// 修音渲染的参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuneRender {
    /// 每 hop 秒一个音分值
    pub cents: Vec<f32>,
    pub hop: f64,
    pub denoise: bool,
    /// 环境底噪在输入文件里的位置（秒），有就用频谱减法，没有就用 RNNoise
    pub noise: Option<(f64, f64)>,
    /// 底噪所在的文件（不给就是输入文件本身）
    pub noise_file: Option<String>,
}

/// 降噪后的录音（按降噪设置缓存成 `<输入>.clean.wav`；不降噪就是输入本身）
fn clean_input(input: &Path, job: &TuneRender, noise_audio: Option<&[f32]>) -> io::Result<PathBuf> {
    if !job.denoise {
        return Ok(input.to_path_buf());
    }
    let clean = input.with_extension("clean.wav");
    let key_file = input.with_extension("clean.key");
    let key = format!("{}|{:?}|{:?}|{}", cache_key(input, "clean-v1")?, job.noise, job.noise_file, noise_audio.map_or(0, <[f32]>::len));
    if clean.exists() && fs::read_to_string(&key_file).ok().as_deref() == Some(key.as_str()) {
        return Ok(clean);
    }
    let (x, sr) = wav::read_mono(input)?;
    let y = match noise_audio {
        Some(n) if n.len() > 2048 => denoise_with_profile(&x, n),
        _ => denoise(&x, sr),
    };
    wav::write_f32(&clean, 1, sr, &y)?;
    fs::write(&key_file, key)?;
    Ok(clean)
}

fn cents_for(track: &pitch::PitchTrack, job: &TuneRender) -> Vec<f32> {
    if (job.hop - track.hop).abs() < 1e-9 {
        return job.cents.clone();
    }
    (0..track.f0.len())
        .map(|i| job.cents.get(((i as f64 * track.hop) / job.hop) as usize).copied().unwrap_or(0.0))
        .collect()
}

/// 按修音曲线渲染整段；可选先降噪
pub fn render_tuned(input: &Path, job: &TuneRender, noise_audio: Option<&[f32]>, out: &Path, cache: &Path) -> io::Result<()> {
    let src = clean_input(input, job, noise_audio)?;
    let (x, sr) = wav::read_mono(&src)?;
    let track = analyze(&src, cache)?;
    let y = psola::shift(&x, sr, &track, &cents_for(&track, job));
    wav::write_f32(out, 1, sr, &y)
}

/// 只重新渲染 [from, to]（秒，相对输入文件），前后多算一点再交叉淡化拼回去 —— 手动修音改一个音时用，几百毫秒内能听到
pub fn render_tuned_range(input: &Path, job: &TuneRender, noise_audio: Option<&[f32]>, out: &Path, cache: &Path, from: f64, to: f64) -> io::Result<()> {
    if !out.exists() {
        return render_tuned(input, job, noise_audio, out, cache);
    }
    let src = clean_input(input, job, noise_audio)?;
    let (x, sr) = wav::read_mono(&src)?;
    let (mut y, ysr) = wav::read_mono(out)?;
    if ysr != sr || y.len() != x.len() {
        return render_tuned(input, job, noise_audio, out, cache);
    }
    let track = analyze(&src, cache)?;
    let cents = cents_for(&track, job);
    let srf = sr as f64;
    const MARGIN: f64 = 0.3;
    const FADE: f64 = 0.02;
    let a = (((from - MARGIN).max(0.0)) * srf) as usize;
    let b = (((to + MARGIN) * srf) as usize).min(x.len());
    if b <= a {
        return Ok(());
    }
    // 截取这一段的音高和修正曲线
    let f0 = (a as f64 / srf / track.hop).floor() as usize;
    let f1 = ((b as f64 / srf / track.hop).ceil() as usize).min(track.f0.len());
    let offset = a as f64 / srf - f0 as f64 * track.hop;
    let sub = pitch::PitchTrack { hop: track.hop, f0: track.f0[f0..f1].to_vec(), conf: track.conf[f0..f1].to_vec() };
    // 截取的起点不在帧边界上：前面补 offset 长度的零，保证帧和采样对齐
    let pad = (offset * srf).round() as usize;
    let mut seg = vec![0.0f32; pad];
    seg.extend_from_slice(&x[a..b]);
    let shifted = psola::shift(&seg, sr, &sub, &cents[f0..f1]);
    let shifted = &shifted[pad..];
    // 拼回去：[from, to] 完全替换，前后各 20ms 交叉淡化
    let s0 = ((from * srf) as usize).max(a);
    let s1 = ((to * srf) as usize).min(b);
    let fade = (FADE * srf) as usize;
    for i in s0.saturating_sub(fade)..(s1 + fade).min(b) {
        let w = if i < s0 {
            (i + fade - s0) as f32 / fade as f32
        } else if i >= s1 {
            1.0 - (i - s1) as f32 / fade as f32
        } else {
            1.0
        };
        let j = i - a;
        if j < shifted.len() {
            y[i] = y[i] * (1.0 - w) + shifted[j] * w;
        }
    }
    wav::write_f32(out, 1, sr, &y)
}

fn cache_key(path: &Path, salt: &str) -> io::Result<String> {
    let meta = fs::metadata(path)?;
    let mut h = DefaultHasher::new();
    salt.hash(&mut h);
    path.hash(&mut h);
    meta.len().hash(&mut h);
    meta.modified()?.hash(&mut h);
    Ok(format!("{:016x}", h.finish()))
}

/// 音高分析（结果按文件缓存；原唱人声只算一次）
pub fn analyze(path: &Path, cache_dir: &Path) -> io::Result<pitch::PitchTrack> {
    let file = cache_dir.join("pitch").join(format!("{}.json", cache_key(path, "pitch-v2")?));
    if let Some(track) = fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
        return Ok(track);
    }
    let (x, sr) = wav::read_mono(path)?;
    let track = pitch::detect(&x, sr);
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(&file, serde_json::to_vec(&track).unwrap_or_default())?;
    Ok(track)
}

/// 用系统自带的 afconvert 编成 m4a（AAC 256kbps）
pub fn encode_m4a(wav_path: &Path, out: &Path) -> io::Result<PathBuf> {
    let status = std::process::Command::new("/usr/bin/afconvert")
        .args(["-f", "m4af", "-d", "aac", "-b", "256000"])
        .arg(wav_path)
        .arg(out)
        .status()?;
    if !status.success() {
        return Err(io::Error::other("afconvert 编码失败"));
    }
    Ok(out.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comp_places_clips_on_song_time() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        // a.wav：1 秒常数 0.5；b.wav：1 秒常数 -0.5
        wav::write_f32(&d.join("a.wav"), 1, 1000, &vec![0.5; 1000]).unwrap();
        wav::write_f32(&d.join("b.wav"), 1, 1000, &vec![-0.5; 1000]).unwrap();
        let clips = vec![
            Clip { file: "a.wav".into(), start: 10.0, from: 10.0, to: 10.5 },
            Clip { file: "b.wav".into(), start: 10.4, from: 10.5, to: 11.0 },
        ];
        let r = render_comp(d, &clips, 0.0, &d.join("comp.wav")).unwrap();
        assert_eq!(r.start, 10.0);
        let (s, sr) = wav::read_mono(Path::new(&r.path)).unwrap();
        assert_eq!(sr, 1000);
        assert_eq!(s.len(), 1000);
        assert!((s[250] - 0.5).abs() < 1e-6);
        assert!((s[750] + 0.5).abs() < 1e-6);
        assert!(s[499].abs() < 0.1); // 拼接处淡出
    }

    #[test]
    fn profile_denoise_removes_room_noise_keeps_tone() {
        let mut seed = 11u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            ((seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.02
        };
        let noise: Vec<f32> = (0..96000).map(|_| rnd()).collect();
        let tone: Vec<f32> = (0..96000).map(|i| 0.3 * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 48000.0).sin()).collect();
        let mix: Vec<f32> = tone.iter().map(|t| t + rnd()).collect();
        let y = denoise_with_profile(&mix, &noise);
        let e = |v: &[f32]| v.iter().map(|x| x * x).sum::<f32>();
        let residual: Vec<f32> = y.iter().zip(&tone).map(|(a, b)| a - b).collect();
        let before: Vec<f32> = mix.iter().zip(&tone).map(|(a, b)| a - b).collect();
        // 噪声至少压掉一半，同时人声能量基本不变
        assert!(e(&residual[4800..90000]) < e(&before[4800..90000]) * 0.5);
        assert!((e(&y[4800..90000]) / e(&tone[4800..90000]) - 1.0).abs() < 0.15);
    }

    #[test]
    fn range_render_only_changes_that_part() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let sr = 48000u32;
        let x: Vec<f32> = (0..sr as usize * 3)
            .map(|i| {
                let p = 2.0 * std::f32::consts::PI * 220.0 * i as f32 / sr as f32;
                0.4 * p.sin() + 0.1 * (2.0 * p).sin()
            })
            .collect();
        let input = d.join("x.comp.wav");
        wav::write_f32(&input, 1, sr, &x).unwrap();
        let out = d.join("x.tuned.wav");
        let cache = d.join("cache");
        let frames = 300;
        let zero = TuneRender { cents: vec![0.0; frames], hop: 0.01, denoise: false, noise: None, noise_file: None };
        render_tuned(&input, &zero, None, &out, &cache).unwrap();
        let before = wav::read_mono(&out).unwrap().0;
        // 只把 1.0–2.0 秒升 100 音分
        let mut cents = vec![0.0; frames];
        for c in cents.iter_mut().take(200).skip(100) {
            *c = 100.0;
        }
        let job = TuneRender { cents, ..zero };
        let t0 = std::time::Instant::now();
        render_tuned_range(&input, &job, None, &out, &cache, 1.0, 2.0).unwrap();
        assert!(t0.elapsed().as_millis() < 500, "局部渲染太慢：{:?}", t0.elapsed());
        let after = wav::read_mono(&out).unwrap().0;
        // 范围外不变
        for i in (0..(0.6 * sr as f64) as usize).chain((2.4 * sr as f64) as usize..after.len()) {
            assert!((after[i] - before[i]).abs() < 1e-6, "第 {i} 个采样变了");
        }
        // 范围内音高升了 100 音分
        let mid = &after[(1.2 * sr as f64) as usize..(1.8 * sr as f64) as usize];
        let mut f: Vec<f32> = pitch::detect(mid, sr).f0.into_iter().filter(|&v| v > 0.0).collect();
        f.sort_by(f32::total_cmp);
        let got = f[f.len() / 2];
        assert!((1200.0 * (got / 233.08).log2()).abs() < 8.0, "得到 {got}");
    }

    #[test]
    fn denoise_keeps_length_and_reduces_noise() {
        let mut seed = 7u32;
        let noise: Vec<f32> = (0..48000)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                ((seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.02
            })
            .collect();
        let y = denoise(&noise, 48000);
        assert_eq!(y.len(), noise.len());
        let e = |v: &[f32]| v.iter().map(|x| x * x).sum::<f32>();
        let ratio = e(&y[4800..]) / e(&noise[4800..]);
        // RNNoise 对白噪声压得不多，只要不放大就行
        assert!(ratio < 1.0, "降噪后能量比 {ratio}");
    }
}
