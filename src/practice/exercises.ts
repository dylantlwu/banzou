/**
 * 练声项目（PRD 4.8）：音型、按音域排轮次、给每个音打分、长音 / 气息统计、音域测试。纯计算，便于测试。
 */
import type { PitchFrame } from "./pitchTracker";

export type ExerciseId = "range" | "hum" | "breath" | "sustain" | "scale" | "arpeggio" | "octave" | "match";

export interface ExerciseDef {
  id: ExerciseId;
  name: string;
  hint: string;
  /** 音型（相对根音的半音数）；没有的是非音阶类 */
  pattern?: number[];
  /** 每日练习里大约多少秒 */
  routineSeconds: number;
}

export const EXERCISES: ExerciseDef[] = [
  { id: "range", name: "音域测试", hint: "唱一个舒服的最低音、再唱最高音，各稳住 1.5 秒", routineSeconds: 0 },
  { id: "hum", name: "哼鸣热身", hint: "闭嘴哼「嗯——」，跟着钢琴五度音阶，每轮升半音", pattern: [0, 2, 4, 5, 7, 5, 4, 2, 0], routineSeconds: 120 },
  { id: "breath", name: "气息", hint: "吸满气，发长长的「嘶——」，越久越稳越好", routineSeconds: 90 },
  { id: "sustain", name: "长音", hint: "听到给的音后稳住唱 8 秒，别抖别跑", routineSeconds: 90 },
  { id: "scale", name: "五度音阶", hint: "用「啊」唱 1-2-3-4-5-4-3-2-1", pattern: [0, 2, 4, 5, 7, 5, 4, 2, 0], routineSeconds: 150 },
  { id: "arpeggio", name: "琶音", hint: "用「哦」唱 1-3-5-8-5-3-1", pattern: [0, 4, 7, 12, 7, 4, 0], routineSeconds: 150 },
  { id: "octave", name: "八度跳", hint: "1-8-1，跳上去别挤，落下来要准", pattern: [0, 12, 0], routineSeconds: 90 },
  { id: "match", name: "听音模唱", hint: "听钢琴弹一个音，唱出同一个音，10 题", routineSeconds: 90 },
];

export const ROUTINE: ExerciseId[] = ["hum", "breath", "sustain", "scale", "arpeggio", "match"];

export interface Range {
  low: number;
  high: number;
}

/** 没测过音域时的默认（一般人都舒服的 A3–D5 中间段） */
export const DEFAULT_RANGE: Range = { low: 55, high: 70 };

/** 轮次的根音：从音域底部开始每轮升半音，音型最高音到顶后再一路降回来 */
export function roundRoots(pattern: number[], range: Range, maxUp = 8): number[] {
  const span = Math.max(...pattern);
  const up: number[] = [];
  for (let r = range.low; r + span <= range.high && up.length < maxUp; r++) up.push(r);
  if (up.length === 0) return [Math.round((range.low + range.high - span) / 2)];
  return [...up, ...up.slice(0, -1).reverse()];
}

export interface TargetNote {
  midi: number;
  start: number;
  end: number;
}

/** 一轮的目标音：先弹一下根音和弦做准备（prep 秒），然后逐个音 */
export function roundNotes(root: number, pattern: number[], start: number, noteDur: number): TargetNote[] {
  return pattern.map((d, i) => ({ midi: root + d, start: start + i * noteDur, end: start + (i + 1) * noteDur }));
}

export type Grade = "good" | "ok" | "bad" | "miss";

export function grade(cents: number | null): Grade {
  if (cents === null) return "miss";
  const a = Math.abs(cents);
  return a <= 25 ? "good" : a <= 50 ? "ok" : "bad";
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

/** 唱的音折到目标所在的八度（男女声、换声区都按音名判） */
export function foldToTarget(m: number, target: number): number {
  return m + 12 * Math.round((target - m) / 12);
}

/**
 * 一个音的得分：这个音时间段后 80%（扣掉起音）里唱的音高中位数和目标差多少音分；没唱返回 null。
 * latency = 耳机 + 麦克风往返延迟（秒）：你听到钢琴才跟着唱，声音到这里晚这么多
 */
export function scoreNote(frames: PitchFrame[], note: TargetNote, latency: number): number | null {
  const a = note.start + latency + 0.2 * (note.end - note.start);
  const b = note.end + latency;
  const sung = frames.filter((f) => f.t >= a && f.t <= b && Number.isFinite(f.midi)).map((f) => foldToTarget(f.midi, note.midi));
  // 唱的时间不到一半算没唱
  const expected = Math.max(1, Math.round(((b - a) * 1000) / 5.33));
  if (sung.length < expected * 0.4) return null;
  return Math.round((median(sung) - note.midi) * 100);
}

export interface SustainStats {
  /** 平均偏差（音分，带符号：正 = 偏高） */
  meanCents: number;
  /** 抖动：音分标准差（扣掉平均偏差后） */
  wobble: number;
  /** 稳住唱了多少秒 */
  held: number;
}

export function sustainStats(frames: PitchFrame[], target: number, from: number, to: number): SustainStats | null {
  const sung = frames.filter((f) => f.t >= from && f.t <= to && Number.isFinite(f.midi)).map((f) => (foldToTarget(f.midi, target) - target) * 100);
  if (sung.length < 20) return null;
  const mean = sung.reduce((s, v) => s + v, 0) / sung.length;
  const sd = Math.sqrt(sung.reduce((s, v) => s + (v - mean) ** 2, 0) / sung.length);
  return { meanCents: Math.round(mean), wobble: Math.round(sd), held: Math.round(sung.length * 0.00533 * 10) / 10 };
}

export interface BreathStats {
  /** 「嘶」持续了多少秒 */
  seconds: number;
  /** 稳定度 0–1：响度越平稳越高 */
  steadiness: number;
}

/**
 * 气息：最长一段连续出声（响度高于底噪 3 倍；中间断开不到 0.3 秒不算断）的时长和平稳度。
 * noise = 开始前测到的底噪响度
 */
export function breathStats(frames: PitchFrame[], noise: number): BreathStats {
  const thr = Math.max(0.006, noise * 3);
  let best = { start: 0, end: 0 };
  let cur: { start: number; end: number } | null = null;
  for (const f of frames) {
    if (f.rms >= thr) {
      if (!cur) cur = { start: f.t, end: f.t };
      else if (f.t - cur.end > 0.3) {
        if (cur.end - cur.start > best.end - best.start) best = cur;
        cur = { start: f.t, end: f.t };
      } else cur.end = f.t;
    }
  }
  if (cur && cur.end - cur.start > best.end - best.start) best = cur;
  const seg = frames.filter((f) => f.t >= best.start && f.t <= best.end && f.rms >= thr).map((f) => 20 * Math.log10(f.rms));
  let steadiness = 0;
  if (seg.length > 10) {
    const mean = seg.reduce((s, v) => s + v, 0) / seg.length;
    const sd = Math.sqrt(seg.reduce((s, v) => s + (v - mean) ** 2, 0) / seg.length);
    // 响度波动 1dB 以内算很稳，6dB 以上算不稳
    steadiness = Math.max(0, Math.min(1, 1 - (sd - 1) / 5));
  }
  return { seconds: Math.round((best.end - best.start) * 10) / 10, steadiness: Math.round(steadiness * 100) / 100 };
}

/** 音域测试：最近一段稳住 holdSec 秒（音高波动 < 40 音分）的音；没有返回 null */
export function stableNote(frames: PitchFrame[], holdSec = 1.5): number | null {
  const voiced = frames.filter((f) => Number.isFinite(f.midi));
  if (voiced.length === 0) return null;
  const end = voiced[voiced.length - 1].t;
  const win = voiced.filter((f) => f.t >= end - holdSec);
  if (win.length < holdSec * 150 || win[0].t > end - holdSec + 0.1) return null;
  const m = median(win.map((f) => f.midi));
  const spread = win.filter((f) => Math.abs(f.midi - m) > 0.4).length / win.length;
  return spread < 0.15 ? Math.round(m) : null;
}

/** 听音模唱的题目：音域里随机，避免和上一题相同 */
export function matchQuestions(range: Range, count: number, seed = Date.now()): number[] {
  let s = seed % 2147483647;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    let m: number;
    do m = range.low + Math.floor(rand() * (range.high - range.low + 1));
    while (out.length && m === out[out.length - 1] && range.high > range.low);
    out.push(m);
  }
  return out;
}

const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export function noteName(m: number): string {
  if (!Number.isFinite(m)) return "—";
  const r = Math.round(m);
  return `${NOTE[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
}
