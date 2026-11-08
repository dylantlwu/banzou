/**
 * 人声分轨的响度分析：找出每句「开口」的精确位置。
 * 智能对齐用语音识别定出大致时间后，再用这里的开口点把句首微调到声音真正出来的那一刻。
 * 纯计算，不依赖浏览器 API，便于测试。
 */

export interface Onset {
  /** 秒 */
  time: number;
  /** 0–1，越大越像一句的开头 */
  strength: number;
  /** 开口前安静了多少秒 */
  quiet: number;
}

const HOP = 0.01;

/** 10ms 一帧的响度（dB），已做 50ms 平滑 */
export function loudness(channels: Float32Array[], sampleRate: number): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate * HOP));
  const len = channels[0]?.length ?? 0;
  const frames = Math.floor(len / hop);
  const raw = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (const ch of channels) {
      for (let i = f * hop; i < (f + 1) * hop; i++) sum += ch[i] * ch[i];
    }
    raw[f] = 10 * Math.log10(sum / (hop * channels.length) + 1e-10);
  }
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    let n = 0;
    for (let k = Math.max(0, f - 2); k <= Math.min(frames - 1, f + 2); k++) {
      s += raw[k];
      n++;
    }
    out[f] = s / n;
  }
  return out;
}

function percentile(values: Float32Array, q: number): number {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] ?? -100;
}

/** 找出人声里所有可能是「一句开头」的位置 */
export function detectOnsets(db: Float32Array): Onset[] {
  if (db.length === 0) return [];
  // 「在唱」的门限：比响的部分低 14dB 以内
  const voiced = percentile(db, 0.9) - 14;
  const LOOKBACK = 25; // 250ms 内的最低点
  const rise = new Float32Array(db.length);
  for (let f = 1; f < db.length; f++) {
    let ahead = 0;
    let n = 0;
    for (let k = f; k < Math.min(db.length, f + 5); k++) {
      ahead += db[k];
      n++;
    }
    ahead /= n;
    if (ahead < voiced) continue;
    let low = Infinity;
    for (let k = Math.max(0, f - LOOKBACK); k < f; k++) low = Math.min(low, db[k]);
    rise[f] = ahead - low;
  }
  // 局部最大的上升点（前后 150ms 内最大），至少上升 6dB
  const onsets: Onset[] = [];
  const W = 15;
  for (let f = 1; f < db.length; f++) {
    const r = rise[f];
    if (r < 6) continue;
    let isPeak = true;
    for (let k = Math.max(0, f - W); k <= Math.min(db.length - 1, f + W); k++) {
      if (rise[k] > r || (rise[k] === r && k < f)) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;
    // 精确到「开始变响」的那一帧：从峰值往前找到低于（低点 + 上升一半）的位置
    const low = db[f] - r;
    let start = f;
    while (start > 0 && f - start < LOOKBACK && db[start - 1] > low + r / 2) start--;
    // 前面安静了多久（中间夹着不到 150ms 的小杂音也算安静）
    let quiet = 0;
    let blip = 0;
    for (let k = start - 1; k >= 0 && quiet < 1000; k--) {
      if (db[k] < voiced) {
        quiet += 1 + blip;
        blip = 0;
      } else if (++blip > 15) break;
    }
    const strength = Math.min(1, 0.5 * Math.min(1, (r - 6) / 24) + 0.5 * Math.min(1, quiet / 40));
    onsets.push({ time: start * HOP, strength, quiet: quiet * HOP });
  }
  return onsets;
}

