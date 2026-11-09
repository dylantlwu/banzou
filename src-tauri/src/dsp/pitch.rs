//! 人声音高检测：YIN（差分函数用 FFT 互相关加速），10ms 一帧。
//! 输出每帧基频（Hz，0 = 不发声）和可信度；后处理去掉八度跳变、太短的发声段，
//! 以及和前后旋律差太远的短片段（分离出来的人声里常漏进伴奏的低音）。

use rustfft::{num_complex::Complex32, FftPlanner};
use serde::{Deserialize, Serialize};

pub const HOP_SECONDS: f64 = 0.01;
const ANALYSIS_SR: u32 = 16000;
const WINDOW: usize = 640; // 40ms
const TAU_MIN: usize = 16; // 1000Hz
const TAU_MAX: usize = 320; // 50Hz
const THRESHOLD: f32 = 0.15;
const UNVOICED: f32 = 0.35;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PitchTrack {
    pub hop: f64,
    pub f0: Vec<f32>,
    pub conf: Vec<f32>,
}

/// 简单低通后降采样到 16kHz（人声基频 < 1kHz，够用）
fn to_analysis_rate(samples: &[f32], sr: u32) -> Vec<f32> {
    if sr == ANALYSIS_SR {
        return samples.to_vec();
    }
    let factor = (sr as f32 / ANALYSIS_SR as f32).max(1.0).round() as usize;
    let smoothed: Vec<f32> = if factor > 1 {
        let mut acc = 0.0f32;
        let mut out = Vec::with_capacity(samples.len());
        for (i, &s) in samples.iter().enumerate() {
            acc += s;
            if i >= factor {
                acc -= samples[i - factor];
            }
            out.push(acc / factor as f32);
        }
        out
    } else {
        samples.to_vec()
    };
    super::wav::resample(&smoothed, sr, ANALYSIS_SR)
}

pub fn detect(samples: &[f32], sr: u32) -> PitchTrack {
    let x = to_analysis_rate(samples, sr);
    let hop = (ANALYSIS_SR as f64 * HOP_SECONDS) as usize;
    let frames = x.len() / hop;
    let span = WINDOW + TAU_MAX;
    let n_fft = (span * 2).next_power_of_two();
    let mut planner = FftPlanner::<f32>::new();
    let fwd = planner.plan_fft_forward(n_fft);
    let inv = planner.plan_fft_inverse(n_fft);

    // 能量门限：比全曲最响的帧低 45dB 以下算安静
    let rms: Vec<f32> = (0..frames)
        .map(|f| {
            let s = &x[f * hop..(f * hop + WINDOW).min(x.len())];
            (s.iter().map(|v| v * v).sum::<f32>() / s.len().max(1) as f32).sqrt()
        })
        .collect();
    let loud = rms.iter().cloned().fold(0.0f32, f32::max);
    let gate = (loud * 10f32.powf(-45.0 / 20.0)).max(1e-4);

    let mut f0 = vec![0.0f32; frames];
    let mut conf = vec![0.0f32; frames];
    let mut a = vec![Complex32::new(0.0, 0.0); n_fft];
    let mut b = vec![Complex32::new(0.0, 0.0); n_fft];
    let mut d = vec![0.0f32; TAU_MAX + 1];

    for f in 0..frames {
        let start = f * hop;
        if start + span > x.len() || rms[f] < gate {
            continue;
        }
        let frame = &x[start..start + span];
        for i in 0..n_fft {
            a[i] = Complex32::new(if i < WINDOW { frame[i] } else { 0.0 }, 0.0);
            b[i] = Complex32::new(if i < span { frame[i] } else { 0.0 }, 0.0);
        }
        fwd.process(&mut a);
        fwd.process(&mut b);
        for i in 0..n_fft {
            a[i] = a[i].conj() * b[i];
        }
        inv.process(&mut a);
        let norm = 1.0 / n_fft as f32;
        // 能量的前缀和
        let mut prefix = vec![0.0f32; span + 1];
        for i in 0..span {
            prefix[i + 1] = prefix[i] + frame[i] * frame[i];
        }
        let e0 = prefix[WINDOW];
        d[0] = 0.0;
        let mut running = 0.0f32;
        let mut cmndf = vec![1.0f32; TAU_MAX + 1];
        for tau in 1..=TAU_MAX {
            let et = prefix[tau + WINDOW] - prefix[tau];
            let r = a[tau].re * norm;
            d[tau] = (e0 + et - 2.0 * r).max(0.0);
            running += d[tau];
            cmndf[tau] = if running > 0.0 { d[tau] * tau as f32 / running } else { 1.0 };
        }
        // 第一个低于阈值的谷底；没有就取全局最小
        let mut best = None;
        let mut tau = TAU_MIN;
        while tau < TAU_MAX {
            if cmndf[tau] < THRESHOLD {
                while tau + 1 < TAU_MAX && cmndf[tau + 1] < cmndf[tau] {
                    tau += 1;
                }
                best = Some(tau);
                break;
            }
            tau += 1;
        }
        let tau = best.unwrap_or_else(|| (TAU_MIN..TAU_MAX).min_by(|&i, &j| cmndf[i].total_cmp(&cmndf[j])).unwrap());
        if cmndf[tau] > UNVOICED {
            continue;
        }
        // 抛物线插值
        let (y0, y1, y2) = (cmndf[tau - 1], cmndf[tau], cmndf[tau + 1]);
        let denom = y0 - 2.0 * y1 + y2;
        let shift = if denom.abs() > 1e-9 { (0.5 * (y0 - y2) / denom).clamp(-0.5, 0.5) } else { 0.0 };
        f0[f] = ANALYSIS_SR as f32 / (tau as f32 + shift);
        conf[f] = (1.0 - y1).clamp(0.0, 1.0);
    }

    cleanup(&mut f0, &mut conf);
    PitchTrack { hop: HOP_SECONDS, f0, conf }
}

/// 后处理：八度跳变折回、3 帧中值、去掉短于 40ms 的发声段，最后按上下文检查短片段
fn cleanup(f0: &mut [f32], conf: &mut [f32]) {
    basic_cleanup(f0, conf);
    context_fix(f0, conf);
}

fn midi(f: f32) -> f32 {
    69.0 + 12.0 * (f / 440.0).log2()
}

fn median(mut v: Vec<f32>) -> f32 {
    v.sort_by(f32::total_cmp);
    v[v.len() / 2]
}

/// 短于这个长度的片段要过上下文检查（帧，10ms 一帧）
const SHORT_SEGMENT: usize = 35;
/// 上下文：前后各 1.5 秒
const CONTEXT: usize = 150;

/// 上下文检查：短片段（< 350ms）的音高和前后 1.5 秒的旋律差超过 7 个半音时，
/// 差一个八度左右就折回来（八度误判），差得更远就丢掉（多半是伴奏低音、呼吸声）。
/// 片段在不发声处或相邻两帧跳超过 4 个半音处断开。
fn context_fix(f0: &mut [f32], conf: &mut [f32]) {
    let n = f0.len();
    let mut segs = Vec::new();
    let mut i = 0;
    while i < n {
        if f0[i] <= 0.0 {
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        while i < n && f0[i] > 0.0 && (midi(f0[i]) - midi(f0[i - 1])).abs() <= 4.0 {
            i += 1;
        }
        segs.push((start, i));
    }
    // 长片段可信，用它们当上下文；附近没有长片段时才退而用所有发声帧
    let mut trusted = vec![false; n];
    for &(s, e) in &segs {
        if e - s >= SHORT_SEGMENT {
            trusted[s..e].fill(true);
        }
    }
    let orig = f0.to_vec();
    for &(s, e) in &segs {
        if e - s >= SHORT_SEGMENT {
            continue;
        }
        let window = s.saturating_sub(CONTEXT)..(e + CONTEXT).min(n);
        let mut ctx: Vec<f32> = window.clone().filter(|&j| trusted[j]).map(|j| midi(orig[j])).collect();
        if ctx.len() < 20 {
            ctx = window.filter(|&j| (j < s || j >= e) && orig[j] > 0.0).map(|j| midi(orig[j])).collect();
        }
        if ctx.len() < 20 {
            continue;
        }
        let diff = median(orig[s..e].iter().map(|&f| midi(f)).collect()) - median(ctx);
        if diff.abs() <= 7.0 {
            continue;
        }
        let octaves = (diff / 12.0).round();
        if octaves.abs() == 1.0 && (diff - octaves * 12.0).abs() <= 1.5 {
            let k = 2f32.powf(-octaves);
            for j in s..e {
                f0[j] = orig[j] * k;
            }
        } else {
            for j in s..e {
                f0[j] = 0.0;
                conf[j] = 0.0;
            }
        }
    }
}

fn basic_cleanup(f0: &mut [f32], conf: &mut [f32]) {
    let n = f0.len();
    let orig = f0.to_vec();
    for i in 0..n {
        if orig[i] <= 0.0 {
            continue;
        }
        let mut near: Vec<f32> = (i.saturating_sub(6)..(i + 7).min(n)).filter(|&j| j != i && orig[j] > 0.0).map(|j| orig[j]).collect();
        if near.len() < 4 {
            continue;
        }
        near.sort_by(f32::total_cmp);
        let med = near[near.len() / 2];
        let ratio = orig[i] / med;
        if (ratio - 2.0).abs() < 0.2 {
            f0[i] = orig[i] / 2.0;
        } else if (ratio - 0.5).abs() < 0.05 {
            f0[i] = orig[i] * 2.0;
        }
    }
    let folded = f0.to_vec();
    for i in 1..n.saturating_sub(1) {
        if folded[i - 1] > 0.0 && folded[i] > 0.0 && folded[i + 1] > 0.0 {
            let mut w = [folded[i - 1], folded[i], folded[i + 1]];
            w.sort_by(f32::total_cmp);
            f0[i] = w[1];
        }
    }
    let mut i = 0;
    while i < n {
        if f0[i] > 0.0 {
            let start = i;
            while i < n && f0[i] > 0.0 {
                i += 1;
            }
            if i - start < 4 {
                for j in start..i {
                    f0[j] = 0.0;
                    conf[j] = 0.0;
                }
            }
        } else {
            i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: impl Fn(f32) -> f32, secs: f32, sr: u32) -> Vec<f32> {
        let mut phase = 0.0f32;
        (0..(secs * sr as f32) as usize)
            .map(|i| {
                let t = i as f32 / sr as f32;
                phase += 2.0 * std::f32::consts::PI * freq(t) / sr as f32;
                // 带一点泛音更像人声
                0.4 * phase.sin() + 0.15 * (2.0 * phase).sin() + 0.08 * (3.0 * phase).sin()
            })
            .collect()
    }

    fn cents(a: f32, b: f32) -> f32 {
        1200.0 * (a / b).log2()
    }

    #[test]
    fn steady_tone_within_10_cents() {
        for &hz in &[110.0f32, 220.0, 330.0, 523.25] {
            let track = detect(&sine(|_| hz, 1.0, 48000), 48000);
            let voiced: Vec<f32> = track.f0.iter().cloned().filter(|&f| f > 0.0).collect();
            assert!(voiced.len() > 80, "{hz}Hz 只有 {} 帧", voiced.len());
            for f in voiced {
                assert!(cents(f, hz).abs() < 10.0, "{hz}Hz 测成 {f}");
            }
        }
    }

    #[test]
    fn glide_is_tracked() {
        // 1 秒内从 200Hz 滑到 300Hz
        let track = detect(&sine(|t| 200.0 + 100.0 * t, 1.0, 44100), 44100);
        for (i, &f) in track.f0.iter().enumerate().skip(5).take(80) {
            let expect = 200.0 + 100.0 * (i as f32 * 0.01 + 0.02);
            assert!(cents(f, expect).abs() < 25.0, "帧 {i}: {f} vs {expect}");
        }
    }

    #[test]
    fn short_outliers_are_folded_or_dropped() {
        let hz = |m: f32| 440.0 * 2f32.powf((m - 69.0) / 12.0);
        // 3 秒的旋律在 64–66 之间；中间夹着漏进来的低音（37，150ms）、八度误判（高一个八度，100ms）
        let mut f0: Vec<f32> = (0..300).map(|i| hz(64.0 + (i / 50 % 3) as f32)).collect();
        for v in &mut f0[100..115] {
            *v = hz(37.0);
        }
        for v in &mut f0[200..210] {
            *v *= 2.0;
        }
        let melody_200 = f0[200] / 2.0;
        let mut conf = vec![0.9; 300];
        context_fix(&mut f0, &mut conf);
        assert!(f0[100..115].iter().all(|&f| f == 0.0), "低音没去掉");
        assert!((f0[205] - melody_200).abs() < 0.01, "八度误判没折回：{}", f0[205]);
        assert!((f0[50] - hz(65.0)).abs() < 0.01, "正常的音被改了");
    }

    #[test]
    fn long_low_phrase_is_kept() {
        // 真唱低音（持续 1 秒、比前面低 10 个半音）不能被当成漏音删掉
        let hz = |m: f32| 440.0 * 2f32.powf((m - 69.0) / 12.0);
        let mut f0: Vec<f32> = (0..300).map(|i| if i < 200 { hz(64.0) } else { hz(54.0) }).collect();
        let mut conf = vec![0.9; 300];
        context_fix(&mut f0, &mut conf);
        assert!(f0[200..].iter().all(|&f| (f - hz(54.0)).abs() < 0.01));
    }

    #[test]
    fn silence_and_noise_are_unvoiced() {
        let silent = vec![0.0f32; 48000];
        assert!(detect(&silent, 48000).f0.iter().all(|&f| f == 0.0));
        let mut seed = 1u32;
        let noise: Vec<f32> = (0..48000)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
            })
            .collect();
        let voiced = detect(&noise, 48000).f0.iter().filter(|&&f| f > 0.0).count();
        assert!(voiced < 10, "噪声里测出 {voiced} 帧有音高");
    }
}
