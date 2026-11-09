/**
 * 演唱页的音高窗口（PRD 4.2）：原唱音高曲线跟着播放滚动，打开录音栏时叠加我实时唱的音高。
 * 这里是纯计算，画图在 components/SingPitch.tsx。
 */
import { PitchTracker } from "../practice/pitchTracker";

/** 原唱音高：MIDI，NaN = 不发声；第 0 帧 = 歌曲 0 秒 */
export interface RefPitch {
  midi: Float64Array;
  hop: number;
}

/** t 秒附近（±radius）最近的原唱音高；没有就 NaN */
export function refAt(ref: RefPitch, t: number, radius = 0.3): number {
  const i = Math.round(t / ref.hop);
  const r = Math.round(radius / ref.hop);
  for (let d = 0; d <= r; d++) {
    for (const j of d === 0 ? [i] : [i - d, i + d]) {
      if (j >= 0 && j < ref.midi.length && !Number.isNaN(ref.midi[j])) return ref.midi[j];
    }
  }
  return NaN;
}

/** 把我唱的音折到离目标最近的八度（男生唱女生的歌也能对上） */
export function foldNear(midi: number, target: number): number {
  return midi + 12 * Math.round((target - midi) / 12);
}

/**
 * 显示范围：前后一大段原唱的音域（去掉两头 5% 的离群点）上下各留 3 个半音，
 * 再保证屏幕上正在显示的这一段（visible）完整放得下；至少 14 个半音高
 */
export function viewRange(ref: RefPitch, from: number, to: number, visible?: [number, number]): { lo: number; hi: number } | null {
  const a = Math.max(0, Math.floor(from / ref.hop));
  const b = Math.min(ref.midi.length, Math.ceil(to / ref.hop));
  const v: number[] = [];
  for (let i = a; i < b; i++) if (!Number.isNaN(ref.midi[i])) v.push(ref.midi[i]);
  if (v.length < 10) return null;
  v.sort((x, y) => x - y);
  let lo = v[Math.floor(v.length * 0.05)] - 3;
  let hi = v[Math.floor(v.length * 0.95)] + 3;
  if (visible) {
    const va = Math.max(0, Math.floor(visible[0] / ref.hop));
    const vb = Math.min(ref.midi.length, Math.ceil(visible[1] / ref.hop));
    for (let i = va; i < vb; i++) {
      const m = ref.midi[i];
      if (Number.isNaN(m)) continue;
      lo = Math.min(lo, m - 1.5);
      hi = Math.max(hi, m + 1.5);
    }
  }
  const span = 14;
  if (hi - lo < span) {
    const mid = (hi + lo) / 2;
    lo = mid - span / 2;
    hi = mid + span / 2;
  }
  return { lo, hi };
}

/** 一段麦克风采样（最近 ~40ms）的音高，MIDI；没唱 / 听不清时 NaN */
export function bufferPitch(buf: Float32Array, sampleRate: number): number {
  const frames = new PitchTracker(sampleRate).push(buf, 0);
  return frames.length ? frames[frames.length - 1].midi : NaN;
}

/**
 * 我唱的音和原唱差多少半音：在 t 前后 radius 秒内找最接近的原唱音（各自折八度），
 * 人唱歌前后差个零点几秒很正常，这里只看音准不看节奏。没有原唱时返回 NaN
 */
export function refDistance(ref: RefPitch, t: number, midi: number, shift = 0, radius = 0.1): number {
  const a = Math.max(0, Math.floor((t - radius) / ref.hop));
  const b = Math.min(ref.midi.length - 1, Math.ceil((t + radius) / ref.hop));
  let best = NaN;
  for (let i = a; i <= b; i++) {
    const r = ref.midi[i] + shift;
    if (Number.isNaN(r)) continue;
    const d = Math.abs(foldNear(midi, r) - r);
    if (!(d >= best)) best = d;
  }
  return best;
}

/** 唱得准不准：和原唱差 50 音分以内算准（原唱带颤音，放宽一点） */
export const LIVE_OFF_SEMITONES = 0.5;
