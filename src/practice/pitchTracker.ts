/**
 * 练声用的流式音高跟踪：每 256 个采样（约 5ms）出一帧 { 我的音高（MIDI，NaN = 没唱）, 响度 }。
 * 和直播修音同一套 YIN（降采样到 12kHz），纯 TS，方便测试；worklet 只是壳。
 */

export interface PitchFrame {
  /** 这一帧结束时的音频时钟时刻（秒） */
  t: number;
  midi: number;
  rms: number;
}

const DECIM = 4;
const HOP = 256;
const RING = 1 << 14;
const MASK = RING - 1;

export class PitchTracker {
  readonly sr: number;
  private buf = new Float32Array(RING);
  private n = 0;
  private since = 0;
  private readonly tauMax: number;
  private readonly tauMin: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.tauMax = Math.ceil(sampleRate / 70 / DECIM);
    this.tauMin = Math.max(2, Math.floor(sampleRate / 1100 / DECIM));
  }

  /** 送入一块采样（blockEnd = 这块最后一个采样的时钟时刻），返回这期间产生的帧 */
  push(input: Float32Array, blockEnd: number): PitchFrame[] {
    const out: PitchFrame[] = [];
    for (let i = 0; i < input.length; i++) {
      this.buf[this.n & MASK] = input[i];
      this.n++;
      if (++this.since >= HOP) {
        this.since = 0;
        const t = blockEnd - (input.length - 1 - i) / this.sr;
        out.push({ t, ...this.analyze() });
      }
    }
    return out;
  }

  private analyze(): { midi: number; rms: number } {
    const W = 256;
    const len = W + this.tauMax;
    if (this.n < len * DECIM) return { midi: NaN, rms: 0 };
    const x = new Float32Array(len);
    const base = this.n - len * DECIM;
    let energy = 0;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let k = 0; k < DECIM; k++) s += this.buf[(base + i * DECIM + k) & MASK];
      x[i] = s / DECIM;
    }
    // 响度用最近 20ms 的原始采样
    const recent = Math.round(this.sr * 0.02);
    for (let i = this.n - recent; i < this.n; i++) energy += this.buf[i & MASK] ** 2;
    const rms = Math.sqrt(energy / recent);
    if (rms < 3e-3) return { midi: NaN, rms };
    const cmndf = new Float32Array(this.tauMax + 1);
    let running = 0;
    cmndf[0] = 1;
    for (let tau = 1; tau <= this.tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const d = x[j] - x[j + tau];
        s += d * d;
      }
      running += s;
      cmndf[tau] = running > 0 ? (s * tau) / running : 1;
    }
    let best = -1;
    for (let tau = this.tauMin; tau < this.tauMax; tau++) {
      if (cmndf[tau] < 0.15) {
        while (tau + 1 < this.tauMax && cmndf[tau + 1] < cmndf[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      let v = 1;
      for (let tau = this.tauMin; tau < this.tauMax; tau++) {
        if (cmndf[tau] < v) {
          v = cmndf[tau];
          best = tau;
        }
      }
    }
    if (best < 1 || cmndf[best] > 0.3) return { midi: NaN, rms };
    const y0 = cmndf[best - 1];
    const y1 = cmndf[best];
    const y2 = cmndf[best + 1];
    const den = y0 - 2 * y1 + y2;
    const shift = Math.abs(den) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    const hz = this.sr / ((best + shift) * DECIM);
    return { midi: 69 + 12 * Math.log2(hz / 440), rms };
  }
}
