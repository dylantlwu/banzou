/**
 * 自动修音的计算（PRD 4.5）：根据我的音高、原唱音高（或调式音阶），算出每一帧要改多少音分。
 * 真正改音高（PSOLA）在后端做；这里是纯计算，拖滑杆时曲线能实时更新。
 *
 * - 参考原唱：目标 = 同一时刻原唱的音高（自动折到我唱的那个八度，降八度唱也能修）
 * - 参考音阶：目标 = 离我最近的调内音
 * - 强度：修正偏差的多少比例
 * - 速度：慢 = 按「这个音的平均音高」修，颤音、滑音原样保留，自然；快 = 每一帧都拉到目标，电音感
 */

export interface PitchTrack {
  hop: number;
  f0: number[];
  conf?: number[];
}

export type Reference = "vocal" | "scale";

export interface Key {
  /** 0 = C … 11 = B */
  tonic: number;
  mode: "major" | "minor" | "chromatic";
}

export interface TuneParams {
  reference: Reference;
  key: Key;
  /** 0–1 */
  strength: number;
  /** 0–1：0 最自然，1 最电音 */
  speed: number;
  /** 只修这些歌曲时间段；null = 全部 */
  ranges: [number, number][] | null;
}

export const DEFAULT_PARAMS: TuneParams = {
  reference: "vocal",
  key: { tonic: 0, mode: "major" },
  strength: 0.8,
  speed: 0.3,
  ranges: null,
};

/** 偏差超过这么多半音就不修（多半是唱了别的音、和声或检测错了） */
const MAX_CORRECTION = 2.5;
/** 跑调判定：偏离目标超过 30 音分 */
export const OFF_CENTS = 30;

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(m: number): number {
  return 440 * 2 ** ((m - 69) / 12);
}

export function keyName(key: Key): string {
  if (key.mode === "chromatic") return "半音阶";
  return `${NOTE_NAMES[key.tonic]} ${key.mode === "major" ? "大调" : "小调"}`;
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

export function scalePitchClasses(key: Key): number[] {
  if (key.mode === "chromatic") return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  return (key.mode === "major" ? MAJOR : MINOR).map((d) => (d + key.tonic) % 12);
}

/** 离 m 最近的调内音 */
export function nearestScaleNote(m: number, key: Key): number {
  const pcs = scalePitchClasses(key);
  const base = Math.floor(m);
  let best = base;
  let bestDist = Infinity;
  for (let c = base - 2; c <= base + 2; c++) {
    if (!pcs.includes(((c % 12) + 12) % 12)) continue;
    const d = Math.abs(c - m);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

// Krumhansl-Kessler 调性轮廓
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a: number[], b: number[]): number {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

/** 从音高曲线检测调：音级直方图 × 调性轮廓，取相关最高的 */
export function detectKey(f0: number[]): Key {
  const hist = new Array(12).fill(0);
  for (const hz of f0) {
    if (hz > 0) hist[((Math.round(hzToMidi(hz)) % 12) + 12) % 12]++;
  }
  let best: Key = { tonic: 0, mode: "major" };
  let bestR = -Infinity;
  for (let t = 0; t < 12; t++) {
    for (const [mode, profile] of [
      ["major", MAJOR_PROFILE],
      ["minor", MINOR_PROFILE],
    ] as const) {
      const rotated = profile.map((_, i) => profile[(i - t + 12) % 12]);
      const r = correlation(hist, rotated);
      if (r > bestR) {
        bestR = r;
        best = { tonic: t, mode };
      }
    }
  }
  return best;
}

/** 同一个发声段里做滑动平均（不跨过不发声的地方） */
function smoothWithinRuns(values: Float64Array, half: number): Float64Array {
  const out = new Float64Array(values.length).fill(NaN);
  let i = 0;
  while (i < values.length) {
    if (Number.isNaN(values[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < values.length && !Number.isNaN(values[i])) i++;
    const end = i;
    // 前缀和
    const prefix = new Float64Array(end - start + 1);
    for (let k = start; k < end; k++) prefix[k - start + 1] = prefix[k - start] + values[k];
    for (let k = start; k < end; k++) {
      const a = Math.max(start, k - half);
      const b = Math.min(end - 1, k + half);
      out[k] = (prefix[b - start + 1] - prefix[a - start]) / (b - a + 1);
    }
  }
  return out;
}

export interface TuneResult {
  /** 每帧要改的音分（我的音高曲线的帧） */
  cents: Float32Array;
  /** 每帧目标音高（MIDI，NaN = 没有目标） */
  target: Float64Array;
  /** 我的音高（MIDI，NaN = 不发声） */
  mine: Float64Array;
  /** 我的音高中心（按速度平滑过，判断跑调用这个，颤音不算跑调） */
  center: Float64Array;
  /** 修后音高（MIDI） */
  tuned: Float64Array;
  /** 修前 / 修后在 30 音分以内的发声帧比例 */
  inTuneBefore: number;
  inTuneAfter: number;
}

/**
 * @param mine 我的音高，第 0 帧对应歌曲时间 mineStart
 * @param ref 原唱音高，第 0 帧对应歌曲 0 秒（参考原唱时用）
 * @param refTranspose 原唱要整体移多少半音（升降调录的 Take）
 */
export function computeTune(
  mine: PitchTrack,
  mineStart: number,
  ref: PitchTrack | null,
  params: TuneParams,
  refTranspose = 0,
): TuneResult {
  const n = mine.f0.length;
  const hop = mine.hop;
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) m[i] = mine.f0[i] > 0 ? hzToMidi(mine.f0[i]) : NaN;

  // 速度：慢 = 用 250ms 内的平均音高（保留颤音），快 = 用每一帧
  const half = Math.round((1 - params.speed) * 12);
  const center = smoothWithinRuns(m, half);

  // 原唱音高用和我一样的窗口平滑：两边比的都是「这个音的中心」，颤音不会被叠加或照抄
  let refMidi: Float64Array | null = null;
  if (params.reference === "vocal" && ref) {
    const r = new Float64Array(ref.f0.length);
    for (let j = 0; j < r.length; j++) r[j] = ref.f0[j] > 0 ? hzToMidi(ref.f0[j]) + refTranspose : NaN;
    refMidi = smoothWithinRuns(r, Math.max(2, half));
  }

  const inRange = (t: number) => !params.ranges || params.ranges.some(([a, b]) => t >= a && t < b);
  const target = new Float64Array(n).fill(NaN);
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = center[i];
    if (Number.isNaN(c)) continue;
    const t = mineStart + i * hop;
    let tgt = NaN;
    if (refMidi) {
      const j = Math.round(t / ref!.hop);
      const r = j >= 0 && j < refMidi.length ? refMidi[j] : NaN;
      if (!Number.isNaN(r)) tgt = r + 12 * Math.round((c - r) / 12);
    }
    if (Number.isNaN(tgt)) tgt = nearestScaleNote(c, params.key);
    target[i] = tgt;
    const delta = tgt - c;
    if (Math.abs(delta) <= MAX_CORRECTION && inRange(t)) raw[i] = delta * params.strength * 100;
  }

  // 修正量本身再平滑一点，避免音高突跳（快速度时更短）
  const tau = 0.01 + (1 - params.speed) * 0.05;
  const alpha = 1 - Math.exp(-hop / tau);
  const cents = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(m[i])) {
      prev = 0;
      continue;
    }
    prev += alpha * (raw[i] - prev);
    cents[i] = prev;
  }
  // 反向再来一次，消掉一阶滤波的滞后
  prev = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (Number.isNaN(m[i])) {
      prev = 0;
      continue;
    }
    prev += alpha * (cents[i] - prev);
    cents[i] = prev;
  }

  const tuned = new Float64Array(n);
  let voiced = 0;
  let okBefore = 0;
  let okAfter = 0;
  for (let i = 0; i < n; i++) {
    tuned[i] = m[i] + cents[i] / 100;
    if (!Number.isNaN(center[i]) && !Number.isNaN(target[i])) {
      voiced++;
      if (Math.abs(center[i] - target[i]) * 100 <= OFF_CENTS) okBefore++;
      if (Math.abs(center[i] + cents[i] / 100 - target[i]) * 100 <= OFF_CENTS) okAfter++;
    }
  }
  return {
    cents,
    target,
    mine: m,
    center,
    tuned,
    inTuneBefore: voiced ? okBefore / voiced : 1,
    inTuneAfter: voiced ? okAfter / voiced : 1,
  };
}
