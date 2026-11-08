//! 伴奏升降调（不变速）：相位声码器把时长拉长 r 倍（带相位锁定，减少「金属声」），
//! 再按 1/r 重采样回原来的长度，音调就变了 r 倍。离线处理，结果缓存。

use rustfft::{num_complex::Complex32, FftPlanner};
use std::f32::consts::PI;

const N: usize = 2048;
const HA: usize = 512;

fn wrap(p: f32) -> f32 {
    let mut x = (p + PI) % (2.0 * PI);
    if x < 0.0 {
        x += 2.0 * PI;
    }
    x - PI
}

/// 时间拉伸（单声道），输出长度约为 input.len() × ratio
pub fn stretch(input: &[f32], ratio: f64) -> Vec<f32> {
    let hs = ((HA as f64) * ratio).round().max(1.0) as usize;
    let window: Vec<f32> = (0..N).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / N as f32).cos()).collect();
    let mut planner = FftPlanner::<f32>::new();
    let fwd = planner.plan_fft_forward(N);
    let inv = planner.plan_fft_inverse(N);
    let frames = input.len().saturating_sub(N) / HA + 1;
    let out_len = frames * hs + N;
    let mut out = vec![0.0f32; out_len];
    let mut norm = vec![0.0f32; out_len];
    let half = N / 2 + 1;
    let mut prev_phase = vec![0.0f32; half];
    let mut synth_phase = vec![0.0f32; half];
    let mut buf = vec![Complex32::new(0.0, 0.0); N];
    let mut mag = vec![0.0f32; half];
    let mut phase = vec![0.0f32; half];
    let mut inst = vec![0.0f32; half];

    for f in 0..frames {
        let pos = f * HA;
        for i in 0..N {
            buf[i] = Complex32::new(input.get(pos + i).copied().unwrap_or(0.0) * window[i], 0.0);
        }
        fwd.process(&mut buf);
        for k in 0..half {
            mag[k] = buf[k].norm();
            phase[k] = buf[k].arg();
            let omega = 2.0 * PI * k as f32 / N as f32;
            let delta = wrap(phase[k] - prev_phase[k] - omega * HA as f32);
            inst[k] = omega + delta / HA as f32;
            prev_phase[k] = phase[k];
        }
        // 相位锁定：峰值频点按真实频率推进，周围的频点跟着峰值保持相对相位
        let peaks: Vec<usize> = (0..half).filter(|&k| (k == 0 || mag[k] >= mag[k - 1]) && (k + 1 == half || mag[k] > mag[k + 1])).collect();
        // 每个频点最近的峰（峰按频率排好序，双指针一遍扫完）
        let mut peak_of = vec![0usize; half];
        let mut j = 0usize;
        for k in 0..half {
            while j + 1 < peaks.len() && (peaks[j + 1] as isize - k as isize).abs() <= (peaks[j] as isize - k as isize).abs() {
                j += 1;
            }
            peak_of[k] = peaks.get(j).copied().unwrap_or(k);
        }
        for &p in &peaks {
            synth_phase[p] = if f == 0 { phase[p] } else { synth_phase[p] + inst[p] * hs as f32 };
        }
        for k in 0..half {
            let p = peak_of[k];
            let ph = if k == p { synth_phase[p] } else { synth_phase[p] + (phase[k] - phase[p]) };
            buf[k] = Complex32::from_polar(mag[k], ph);
            if k > 0 && k < N / 2 {
                buf[N - k] = buf[k].conj();
            }
        }
        inv.process(&mut buf);
        let o = f * hs;
        for i in 0..N {
            out[o + i] += buf[i].re / N as f32 * window[i];
            norm[o + i] += window[i] * window[i];
        }
    }
    for i in 0..out_len {
        if norm[i] > 1e-3 {
            out[i] /= norm[i];
        }
    }
    out.truncate((input.len() as f64 * ratio) as usize);
    out
}

/// Catmull-Rom 插值重采样到指定长度
fn resample_to(input: &[f32], len: usize) -> Vec<f32> {
    if input.is_empty() || len == 0 {
        return vec![0.0; len];
    }
    let step = input.len() as f64 / len as f64;
    let at = |i: isize| input[i.clamp(0, input.len() as isize - 1) as usize];
    (0..len)
        .map(|j| {
            let x = j as f64 * step;
            let i = x.floor() as isize;
            let t = (x - i as f64) as f32;
            let (p0, p1, p2, p3) = (at(i - 1), at(i), at(i + 1), at(i + 2));
            0.5 * ((2.0 * p1) + (-p0 + p2) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t * t * t)
        })
        .collect()
}

/// 移调 semitones 个半音，长度不变（单声道）
pub fn pitch_shift(input: &[f32], semitones: f64) -> Vec<f32> {
    if semitones.abs() < 1e-6 {
        return input.to_vec();
    }
    let ratio = 2f64.powf(semitones / 12.0);
    let stretched = stretch(input, ratio);
    resample_to(&stretched, input.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::pitch::detect;

    #[test]
    fn shifts_a_tone_by_semitones_and_keeps_length() {
        let sr = 44100;
        let x: Vec<f32> = (0..sr * 2)
            .map(|i| {
                let p = 2.0 * PI * 220.0 * i as f32 / sr as f32;
                0.4 * p.sin() + 0.1 * (2.0 * p).sin()
            })
            .collect();
        for st in [2.0f64, -3.0] {
            let y = pitch_shift(&x, st);
            assert_eq!(y.len(), x.len());
            let mut f: Vec<f32> = detect(&y[4410..y.len() - 4410], sr as u32).f0.into_iter().filter(|&v| v > 0.0).collect();
            f.sort_by(f32::total_cmp);
            let got = f[f.len() / 2];
            let expect = 220.0 * 2f32.powf(st as f32 / 12.0);
            assert!((1200.0 * (got / expect).log2()).abs() < 10.0, "{st} 半音：得到 {got}，应为 {expect}");
        }
    }
}
