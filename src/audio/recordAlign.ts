/**
 * 录音对齐的纯计算（PRD 7.4）：
 * - 自动对齐：录音和原唱人声各算「起音强度曲线」，在 ±150ms 内做互相关，找出最佳偏移，
 *   兜底蓝牙延迟每次连接都略有不同
 * - 麦克风跟拍校准：耳机里放节拍，对着麦克风说「嗒」，从录音里找出每声「嗒」，算出往返延迟
 */
import { estimateLatencyMs } from "./calibration";
import { loudness } from "../lyrics/vocalOnsets";

export const HOP = 0.01;

/** 起音强度曲线：响度（dB）30ms 内的上升量，只取正值 */
export function onsetEnvelope(db: Float32Array): Float32Array {
  const out = new Float32Array(db.length);
  for (let f = 3; f < db.length; f++) out[f] = Math.min(30, Math.max(0, db[f] - db[f - 3]));
  return out;
}

export interface LagResult {
  /** 录音要整体挪动多少秒（负数 = 往前挪） */
  shift: number;
  /** 峰值相对平均水平的倍数，越大越可信 */
  confidence: number;
}

/**
 * 估计录音相对原唱的偏移。
 * @param rec 录音的起音曲线，第 0 帧对应歌曲时间 recStart
 * @param ref 原唱人声的起音曲线，第 0 帧对应歌曲 0 秒
 * @param window 只用歌曲时间 [from, to] 这一段（录音真正在唱的部分）
 */
export function estimateLag(
  rec: Float32Array,
  recStart: number,
  ref: Float32Array,
  window: { from: number; to: number },
  maxLag = 0.15,
): LagResult | null {
  return estimateLagSpans(rec, ref, [{ recStart, from: window.from, to: window.to }], maxLag);
}

/**
 * 同上，但录音分成几段（录音中途跳转过）：每段在录音曲线里的起点对应歌曲时间 recStart，
 * 只用歌曲时间 [from, to]。几段一起算一个偏移（延迟是同一个）。
 */
export function estimateLagSpans(
  rec: Float32Array,
  ref: Float32Array,
  spans: { recStart: number; from: number; to: number }[],
  maxLag = 0.15,
): LagResult | null {
  const L = Math.round(maxLag / HOP);
  const parts = spans.map((p) => ({
    base: Math.round(p.recStart / HOP),
    k0: Math.max(0, Math.ceil((p.from - p.recStart) / HOP)),
    k1: Math.min(rec.length, Math.floor((p.to - p.recStart) / HOP)),
  }));
  const frames = parts.reduce((n, p) => n + Math.max(0, p.k1 - p.k0), 0);
  if (frames < 200) return null; // 少于 2 秒没法判断
  const corr: number[] = [];
  for (let lag = -L; lag <= L; lag++) {
    let s = 0;
    for (const { base, k0, k1 } of parts) {
      for (let k = k0; k < k1; k++) {
        const j = base + k + lag;
        if (j >= 0 && j < ref.length) s += rec[k] * ref[j];
      }
    }
    corr.push(s);
  }
  let best = 0;
  for (let i = 1; i < corr.length; i++) if (corr[i] > corr[best]) best = i;
  const mean = corr.reduce((a, b) => a + b, 0) / corr.length;
  if (corr[best] <= 0 || mean <= 0) return null;
  // 抛物线插值到亚帧精度
  let frac = 0;
  if (best > 0 && best < corr.length - 1) {
    const a = corr[best - 1];
    const b = corr[best];
    const c = corr[best + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
  }
  return { shift: (best - L + frac) * HOP, confidence: corr[best] / mean };
}

/** 从一段单声道采样直接算起音曲线 */
export function envelopeOf(samples: Float32Array, sampleRate: number): Float32Array {
  return onsetEnvelope(loudness([samples], sampleRate));
}

/**
 * 麦克风跟拍校准：从录音里找出每一拍之后的第一声「嗒」。
 * @param samples 录音采样，第 0 个采样的时钟时刻是 t0
 * @param clicks 每一拍的发声时钟时刻
 * @returns 往返延迟（毫秒，= 耳机输出延迟 + 麦克风输入延迟），有效拍数太少返回 null
 */
export function measureRoundTrip(samples: Float32Array, sampleRate: number, t0: number, clicks: number[]): number | null {
  // 用 2ms 一帧、不平滑的响度，起音位置才准
  const FINE = 0.002;
  const hop = Math.max(1, Math.round(sampleRate * FINE));
  const frames = Math.floor(samples.length / hop);
  if (frames === 0) return null;
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) sum += samples[i] * samples[i];
    db[f] = 10 * Math.log10(sum / hop + 1e-10);
  }
  // 底噪：第一拍之前那段的中位数
  const pre = Math.max(25, Math.floor((clicks[0] - t0) / FINE) - 25);
  const head = Array.from(db.slice(0, pre)).sort((a, b) => a - b);
  const floor = head[Math.floor(head.length / 2)] ?? -80;
  const threshold = floor + 15;
  const hits: number[] = [];
  for (const c of clicks) {
    const f0 = Math.max(0, Math.round((c - t0) / FINE));
    const f1 = Math.min(frames, Math.round((c + 0.6 - t0) / FINE));
    for (let f = f0; f < f1; f++) {
      if (db[f] >= threshold) {
        // 往回找到开始变响的地方
        let s = f;
        while (s > f0 && db[s - 1] > floor + 6) s--;
        hits.push(t0 + s * FINE);
        break;
      }
    }
  }
  return estimateLatencyMs(clicks, hits);
}
