/**
 * 直播实时修音（PRD 4.7）：在 AudioWorklet 里一块一块处理麦克风，延迟约 32ms。
 *
 * - 每 256 个采样（约 5ms）检测一次我的音高（降采样到 12kHz 做 YIN）
 * - 目标音高：此刻原唱的音高（按伴奏播放位置查，扣掉耳机 + 麦克风往返延迟，自动折到我唱的八度）；
 *   原唱没在唱的地方吸到最近的调内音
 * - 移调：流式 TD-PSOLA（按基音周期切颗粒、按目标周期重排、重叠相加），只改音高不改时长
 *
 * 纯 TS、不依赖 AudioWorklet 全局，方便单元测试；worklet 只是个壳。
 */

export interface TunerParams {
  enabled: boolean;
  /** 0–1 */
  strength: number;
  /** 0 = 自然（慢），1 = 电音（快） */
  speed: number;
  /** 调内音（0–11），原唱没在唱时用 */
  scale: number[];
  /** 测试用：固定移多少音分（不看目标） */
  fixedCents?: number;
}

export interface TunerClock {
  playing: boolean;
  /** 音频时钟 t0 时伴奏放到歌曲的 pos0 秒 */
  pos0: number;
  t0: number;
  rate: number;
  /** 往返延迟（秒）：我听到伴奏 + 我的声音进麦克风，唱的时候对应的歌曲时间要往前推这么多 */
  roundTrip: number;
}

export interface TunerInfo {
  /** 我的音高（MIDI），NaN = 没在唱 */
  midi: number;
  /** 目标音高 */
  target: number;
  /** 当前修正（音分） */
  cents: number;
}

const DECIM = 4;
const DET_HOP = 256;
const UNVOICED_STEP = 240;
const RING = 1 << 15;
const MASK = RING - 1;

export class RealtimeTuner {
  readonly sr: number;
  /** 输出比输入晚多少个采样 */
  readonly latency: number;
  private readonly maxPeriod: number;
  private readonly minPeriod: number;
  private inBuf = new Float32Array(RING);
  private outBuf = new Float32Array(RING);
  private outW = new Float32Array(RING);
  /** 已写入的输入采样数（绝对序号） */
  private n = 0;
  /** 已输出的采样数 */
  private r = 0;
  private sinceDet = 0;
  private period = 0; // 当前检测到的周期（采样），0 = 不发声
  private midi = NaN;
  private center = NaN;
  private cents = 0;
  private target = NaN;
  private nextAnalysis = 0;
  private nextSynth = 0;
  private marks: { pos: number; period: number; voiced: boolean }[] = [];
  private params: TunerParams = { enabled: true, strength: 0.8, speed: 0.3, scale: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
  private clock: TunerClock | null = null;
  private ref: Float32Array | null = null;
  private refHop = 0.01;
  private gate = 1e-4;
  private loud = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.maxPeriod = Math.ceil(sampleRate / 70);
    this.minPeriod = Math.floor(sampleRate / 900);
    this.latency = 2 * this.maxPeriod + 2 * DET_HOP;
  }

  setParams(p: Partial<TunerParams>) {
    this.params = { ...this.params, ...p };
  }

  setClock(c: TunerClock | null) {
    this.clock = c;
  }

  /** 原唱音高（MIDI，已含升降调；NaN = 不在唱），第 0 帧 = 歌曲 0 秒 */
  setReference(ref: Float32Array | null, hop = 0.01) {
    this.ref = ref;
    this.refHop = hop;
  }

  get info(): TunerInfo {
    return { midi: this.midi, target: this.target, cents: this.cents };
  }

  /** 处理一块：input / output 长度相同；blockTime = 这块对应的音频时钟时刻 */
  process(input: Float32Array, output: Float32Array, blockTime: number) {
    for (let i = 0; i < input.length; i++) {
      this.inBuf[(this.n + i) & MASK] = input[i];
    }
    this.n += input.length;
    this.sinceDet += input.length;
    if (this.sinceDet >= DET_HOP) {
      this.sinceDet = 0;
      this.detect();
      this.updateCorrection(blockTime);
    }
    this.placeAnalysisMarks();
    this.synthesize();
    for (let i = 0; i < output.length; i++) {
      const k = this.r & MASK;
      const w = this.outW[k];
      output[i] = this.r < 0 ? 0 : w > 1e-3 ? this.outBuf[k] / Math.max(w, 0.25) : 0;
      this.outBuf[k] = 0;
      this.outW[k] = 0;
      this.r++;
    }
    // r 落后 n 的量就是延迟；起步阶段输出静音
    if (this.r > this.n - this.latency) this.r = this.n - this.latency;
  }

  // ---------- 音高检测（12kHz 上的 YIN） ----------
  private detect() {
    const W = 256;
    const tauMax = Math.ceil(this.maxPeriod / DECIM);
    const tauMin = Math.max(2, Math.floor(this.minPeriod / DECIM));
    const len = W + tauMax;
    if (this.n < len * DECIM + DECIM) return;
    const x = new Float32Array(len);
    const base = this.n - len * DECIM;
    let energy = 0;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let k = 0; k < DECIM; k++) s += this.inBuf[(base + i * DECIM + k) & MASK];
      x[i] = s / DECIM;
      energy += x[i] * x[i];
    }
    const rms = Math.sqrt(energy / len);
    this.loud = Math.max(this.loud * 0.9995, rms);
    this.gate = Math.max(2e-3, this.loud * 0.03);
    if (rms < this.gate) {
      this.setUnvoiced();
      return;
    }
    const d = new Float32Array(tauMax + 1);
    let running = 0;
    let best = -1;
    let bestVal = 1;
    const cmndf = new Float32Array(tauMax + 1);
    cmndf[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const diff = x[j] - x[j + tau];
        s += diff * diff;
      }
      d[tau] = s;
      running += s;
      cmndf[tau] = running > 0 ? (s * tau) / running : 1;
    }
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (cmndf[tau] < 0.15) {
        while (tau + 1 < tauMax && cmndf[tau + 1] < cmndf[tau]) tau++;
        best = tau;
        bestVal = cmndf[tau];
        break;
      }
    }
    if (best < 0) {
      for (let tau = tauMin; tau < tauMax; tau++) {
        if (cmndf[tau] < bestVal) {
          bestVal = cmndf[tau];
          best = tau;
        }
      }
    }
    if (best < 0 || bestVal > 0.3) {
      this.setUnvoiced();
      return;
    }
    const y0 = cmndf[best - 1];
    const y1 = cmndf[best];
    const y2 = cmndf[best + 1];
    const den = y0 - 2 * y1 + y2;
    const shift = Math.abs(den) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    const tauExact = best + shift;
    this.period = tauExact * DECIM;
    const hz = this.sr / this.period;
    this.midi = 69 + 12 * Math.log2(hz / 440);
  }

  private setUnvoiced() {
    this.period = 0;
    this.midi = NaN;
    this.center = NaN;
  }

  // ---------- 目标与修正量 ----------
  private updateCorrection(blockTime: number) {
    const p = this.params;
    const hopSec = DET_HOP / this.sr;
    if (!p.enabled || Number.isNaN(this.midi)) {
      this.target = NaN;
      this.cents += (0 - this.cents) * 0.5;
      return;
    }
    // 音高中心：慢 = 150ms 平滑（保留颤音），快 = 跟着每一帧
    const tauCenter = 0.005 + (1 - p.speed) * 0.15;
    const a = 1 - Math.exp(-hopSec / tauCenter);
    this.center = Number.isNaN(this.center) ? this.midi : this.center + a * (this.midi - this.center);
    let desired: number;
    if (p.fixedCents !== undefined) {
      desired = p.fixedCents;
      this.target = this.midi + p.fixedCents / 100;
    } else {
      let tgt = NaN;
      const c = this.clock;
      if (this.ref && c?.playing) {
        // 这个采样是我在听到 (此刻 − 往返延迟) 的伴奏时唱的
        const t = c.pos0 + (blockTime - c.t0 - c.roundTrip - this.latency / this.sr) * c.rate;
        const j = Math.round(t / this.refHop);
        const r = j >= 0 && j < this.ref.length ? this.ref[j] : NaN;
        if (!Number.isNaN(r)) tgt = r + 12 * Math.round((this.center - r) / 12);
      }
      if (Number.isNaN(tgt)) tgt = nearestInScale(this.center, p.scale);
      this.target = tgt;
      const delta = tgt - this.center;
      desired = Math.abs(delta) <= 2.5 ? delta * p.strength * 100 : 0;
    }
    const tauFix = 0.01 + (1 - p.speed) * 0.05;
    const b = 1 - Math.exp(-hopSec / tauFix);
    this.cents += b * (desired - this.cents);
  }

  // ---------- 流式 PSOLA ----------
  private placeAnalysisMarks() {
    // 分析标记要等右边一个周期的数据到齐
    while (true) {
      const voiced = this.period > 0;
      const P = voiced ? this.period : UNVOICED_STEP;
      let pos = Math.max(this.nextAnalysis, this.n - RING / 2);
      if (pos + P + P / 4 >= this.n) break;
      if (voiced) {
        // 对齐到附近的波形峰值，颗粒之间相位更连贯
        let best = pos;
        let bestVal = -Infinity;
        const q = Math.floor(P / 4);
        for (let k = pos - q; k <= pos + q; k++) {
          const v = this.inBuf[k & MASK];
          if (v > bestVal && k > (this.marks.length ? this.marks[this.marks.length - 1].pos : -Infinity)) {
            bestVal = v;
            best = k;
          }
        }
        pos = best;
      }
      this.marks.push({ pos, period: P, voiced });
      this.nextAnalysis = pos + Math.max(1, Math.round(P));
      if (this.marks.length > 512) this.marks.splice(0, 256);
    }
  }

  private synthesize() {
    // 合成到能覆盖接下来要输出的采样为止
    const until = this.r + 128 + this.maxPeriod;
    if (this.nextSynth < this.r) {
      // 起步或跟丢了：对齐到 r 之后的第一个分析标记
      const m = this.marks.find((x) => x.pos >= this.r);
      this.nextSynth = m ? m.pos : this.r;
    }
    while (this.nextSynth <= until && this.marks.length) {
      const s = this.nextSynth;
      // 离 s 最近的分析标记（它右边一个周期的数据必须已经到了）
      let k = 0;
      while (k + 1 < this.marks.length && Math.abs(this.marks[k + 1].pos - s) <= Math.abs(this.marks[k].pos - s)) k++;
      const m = this.marks[k];
      if (m.pos + m.period >= this.n) break;
      const half = Math.max(2, Math.round(m.period));
      const len = 2 * half;
      for (let i = 0; i < len; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len);
        const src = m.pos - half + i;
        const dst = s - half + i;
        if (dst < this.r) continue;
        this.outBuf[dst & MASK] += this.inBuf[src & MASK] * w;
        this.outW[dst & MASK] += w;
      }
      const ratio = m.voiced && this.params.enabled ? 2 ** (this.cents / 1200) : 1;
      // 不用修的时候颗粒放回原位（下一个分析标记），保证原样还原；要修时按目标周期排
      const next = this.marks[k + 1];
      this.nextSynth = Math.abs(ratio - 1) < 3e-4 && next ? Math.max(s + 1, next.pos) : s + Math.max(1, Math.round(m.period / ratio));
      // 用过的、离得远的标记丢掉
      while (this.marks.length > 2 && this.marks[1].pos < s - 2 * this.maxPeriod) this.marks.shift();
    }
  }
}

export function nearestInScale(m: number, scale: number[]): number {
  const base = Math.floor(m);
  let best = base;
  let bestDist = Infinity;
  for (let c = base - 2; c <= base + 2; c++) {
    if (!scale.includes(((c % 12) + 12) % 12)) continue;
    const d = Math.abs(c - m);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}
