//! TD-PSOLA 移调：按基音周期切出一个个「颗粒」（两个周期长、加汉宁窗），
//! 按目标周期重新排列、重叠相加。只改音高、不改时长，共振峰（音色）保留，半音以内很自然。

use super::pitch::PitchTrack;

/// 不发声的地方按 5ms 一格原样搬过去
const UNVOICED_STEP: f64 = 0.005;

struct Mark {
    pos: usize,
    /// 这个位置的基音周期（采样数）；不发声时是固定步长
    period: f64,
    voiced: bool,
}

fn frame_value(values: &[f32], hop: f64, t: f64) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let x = t / hop;
    let i = (x.floor() as usize).min(values.len() - 1);
    let j = (i + 1).min(values.len() - 1);
    let f = (x - i as f64).clamp(0.0, 1.0) as f32;
    values[i] + (values[j] - values[i]) * f
}

fn f0_at(track: &PitchTrack, t: f64) -> f32 {
    let i = ((t / track.hop).floor() as usize).min(track.f0.len().saturating_sub(1));
    track.f0.get(i).copied().unwrap_or(0.0)
}

/// 分析标记：发声段按周期放在波形峰值上，不发声段等间隔
fn analysis_marks(input: &[f32], sr: f64, track: &PitchTrack) -> Vec<Mark> {
    let mut marks = Vec::new();
    let unvoiced = (UNVOICED_STEP * sr).round();
    let mut t = 0usize;
    let mut prev_voiced = false;
    while t < input.len() {
        let f0 = f0_at(track, t as f64 / sr);
        if f0 > 0.0 {
            let period = sr / f0 as f64;
            // 刚进入发声段：在一个周期内找峰值；之后在预期位置 ±1/4 周期内找峰值
            let (lo, hi) = if prev_voiced {
                (t.saturating_sub((period / 4.0) as usize), (t + (period / 4.0) as usize).min(input.len() - 1))
            } else {
                (t, (t + period as usize).min(input.len() - 1))
            };
            let peak = (lo..=hi).max_by(|&a, &b| input[a].total_cmp(&input[b])).unwrap_or(t);
            let pos = if marks.last().is_some_and(|m: &Mark| peak <= m.pos) { t } else { peak };
            marks.push(Mark { pos, period, voiced: true });
            t = pos + period.max(1.0) as usize;
            prev_voiced = true;
        } else {
            marks.push(Mark { pos: t, period: unvoiced, voiced: false });
            t += unvoiced as usize;
            prev_voiced = false;
        }
    }
    marks
}

/// 按每帧（track.hop）的音高变化 `cents` 移调，输出和输入一样长
pub fn shift(input: &[f32], sample_rate: u32, track: &PitchTrack, cents: &[f32]) -> Vec<f32> {
    let sr = sample_rate as f64;
    let n = input.len();
    let mut out = vec![0.0f32; n];
    let mut weight = vec![0.0f32; n];
    let marks = analysis_marks(input, sr, track);
    if marks.is_empty() {
        return input.to_vec();
    }

    let mut s = marks[0].pos as f64;
    let mut k = 0usize;
    while s < n as f64 {
        // 离合成位置最近的分析标记（单调前进）
        while k + 1 < marks.len() && (marks[k + 1].pos as f64 - s).abs() <= (marks[k].pos as f64 - s).abs() {
            k += 1;
        }
        let m = &marks[k];
        let half = m.period.max(2.0);
        let len = (2.0 * half) as usize;
        let center = s.round() as isize;
        for i in 0..len {
            let src = m.pos as isize - half as isize + i as isize;
            let dst = center - half as isize + i as isize;
            if src < 0 || dst < 0 || src as usize >= n || dst as usize >= n {
                continue;
            }
            let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / len as f64).cos();
            out[dst as usize] += input[src as usize] * w as f32;
            weight[dst as usize] += w as f32;
        }
        let ratio = if m.voiced { 2f64.powf(frame_value(cents, track.hop, s / sr) as f64 / 1200.0) } else { 1.0 };
        s += (m.period / ratio).max(1.0);
    }
    for i in 0..n {
        out[i] = if weight[i] > 1e-3 { out[i] / weight[i].max(0.25) } else { 0.0 };
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::pitch::detect;
    use super::*;

    fn tone(hz: f32, secs: f32, sr: u32) -> Vec<f32> {
        (0..(secs * sr as f32) as usize)
            .map(|i| {
                let p = 2.0 * std::f32::consts::PI * hz * i as f32 / sr as f32;
                0.4 * p.sin() + 0.15 * (2.0 * p).sin() + 0.08 * (3.0 * p).sin()
            })
            .collect()
    }

    fn median_voiced(track: &PitchTrack) -> f32 {
        let mut v: Vec<f32> = track.f0.iter().cloned().filter(|&f| f > 0.0).collect();
        v.sort_by(f32::total_cmp);
        v[v.len() / 2]
    }

    #[test]
    fn shifts_up_100_cents_and_down_40() {
        let sr = 48000;
        let x = tone(220.0, 1.5, sr);
        let track = detect(&x, sr);
        for &c in &[100.0f32, -40.0] {
            let y = shift(&x, sr, &track, &vec![c; track.f0.len()]);
            assert_eq!(y.len(), x.len());
            let got = median_voiced(&detect(&y, sr));
            let expect = 220.0 * 2f32.powf(c / 1200.0);
            assert!((1200.0 * (got / expect).log2()).abs() < 5.0, "{c} 音分：得到 {got}，应为 {expect}");
        }
    }

    #[test]
    fn zero_shift_keeps_signal() {
        let sr = 44100;
        let x = tone(196.0, 1.0, sr);
        let track = detect(&x, sr);
        let y = shift(&x, sr, &track, &vec![0.0; track.f0.len()]);
        let (mut sig, mut err) = (0.0f64, 0.0f64);
        for i in sr as usize / 5..x.len() - sr as usize / 5 {
            sig += (x[i] as f64).powi(2);
            err += (x[i] as f64 - y[i] as f64).powi(2);
        }
        let snr = 10.0 * (sig / err).log10();
        assert!(snr > 15.0, "SNR {snr:.1}dB");
    }
}
