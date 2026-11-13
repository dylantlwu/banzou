/**
 * 录音 Take 的数据模型（PRD 4.4 / 7.2），存在 `录音/<歌名>/takes.json`。
 *
 * 一个 Take 由一段或几段录音（Clip）拼成：整首录是一段；在某一遍上补录 A-B，
 * 就生成一个新 Take = 原来那遍挖掉 A-B + 新录的 A-B（原来那遍保留，可以随时切回去）。
 */
import { invoke } from "@tauri-apps/api/core";
import type { PlayerTrack } from "../player/usePlayer";

export interface Clip {
  /** 录音文件名（在这首歌的录音文件夹里） */
  file: string;
  /** 文件第 0 个采样对应的歌曲时间（秒），已扣延迟、已加自动对齐 */
  start: number;
  /** 这段只负责歌曲时间 [from, to] */
  from: number;
  to: number;
  /** 自动对齐挪了多少毫秒（只是记录，已经算进 start） */
  autoAlignMs: number;
}

export interface Take {
  id: string;
  name: string;
  createdAt: string;
  starred: boolean;
  clips: Clip[];
  /** 录音时用的往返延迟（毫秒） */
  latencyMs: number;
  /** 手动微调（毫秒，正数 = 往后挪），作用于整遍 */
  adjustMs: number;
  /** 录音前的环境底噪（文件内时间，秒），修音降噪用 */
  noise?: { file: string; from: number; to: number };
  /** 补录生成的 Take：基于哪一遍、补的区间 */
  parentId?: string;
  range?: [number, number];
  deviceLabel?: string;
  /** 录这遍时伴奏升降了几个半音（修音时原唱参考也要跟着移） */
  transpose?: number;
}

export interface TakeList {
  dir: string;
  takes: Take[];
  /** 上次没录完就退出、刚被恢复的录音 */
  recovered: { file: string; seconds: number }[];
  /** 比歌长很多、没有自动恢复的异常录音（资料检查里可以移到废纸篓） */
  abnormal: { file: string; bytes: number; seconds: number }[];
}

export async function loadTakes(title: string): Promise<TakeList> {
  const res = await invoke<{ dir: string; takes: unknown; recovered?: TakeList["recovered"]; abnormal?: TakeList["abnormal"] }>("load_takes", { title });
  return { dir: res.dir, takes: Array.isArray(res.takes) ? (res.takes as Take[]) : [], recovered: res.recovered ?? [], abnormal: res.abnormal ?? [] };
}

/** 恢复的录音：不知道当时伴奏放到哪了，先从歌曲开头放，需要的话手动微调 */
export function recoveredTake(file: string, seconds: number): Take {
  return {
    id: newTakeId(),
    name: `恢复的录音（${file}）`,
    createdAt: new Date().toISOString(),
    starred: false,
    clips: [{ file, start: 0, from: 0, to: seconds, autoAlignMs: 0 }],
    latencyMs: 0,
    adjustMs: 0,
  };
}

export async function saveTakes(title: string, takes: Take[]): Promise<void> {
  await invoke("save_takes", { title, takes });
}

/** 删掉 Take：没有别的 Take 再用到的录音文件移到废纸篓 */
export async function deleteTake(title: string, takes: Take[], id: string): Promise<Take[]> {
  const rest = takes.filter((t) => t.id !== id);
  const victim = takes.find((t) => t.id === id);
  if (!victim) return takes;
  const used = new Set(rest.flatMap((t) => [...t.clips.map((c) => c.file), ...(t.noise ? [t.noise.file] : [])]));
  // 拼接、修音生成的中间文件也一起清掉
  const files = [...new Set([...victim.clips.map((c) => c.file), `${victim.id}.comp.wav`, `${victim.id}.comp.clean.wav`, `${victim.id}.tuned.wav`])].filter((f) => !used.has(f));
  await saveTakes(title, rest);
  if (files.length) await invoke("trash_takes", { title, files });
  return rest;
}

export function newTakeId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 下一个默认名字：第 N 遍 */
export function nextTakeName(takes: Take[]): string {
  const nums = takes.map((t) => /^第 (\d+) 遍$/.exec(t.name)?.[1]).filter(Boolean).map(Number);
  return `第 ${Math.max(0, ...nums) + 1} 遍`;
}

/** 补录：在 parent 上把 [a, b] 换成新录的那段 */
export function punchIn(parent: Take, clip: Clip, range: [number, number]): Clip[] {
  const [a, b] = range;
  const out: Clip[] = [];
  for (const c of parent.clips) {
    if (c.from < a) out.push({ ...c, to: Math.min(c.to, a) });
    if (c.to > b) out.push({ ...c, from: Math.max(c.from, b) });
  }
  out.push({ ...clip, from: a, to: b });
  return out.filter((c) => c.to - c.from > 0.01).sort((x, y) => x.from - y.from);
}

/** 这一遍覆盖的歌曲时间范围 */
export function takeSpan(take: Take): [number, number] {
  return [Math.min(...take.clips.map((c) => c.from)), Math.max(...take.clips.map((c) => c.to))];
}

/** 播放用的音轨：每段一条，同组共用音量，边缘 15ms 淡入淡出 */
export function takeTracks(take: Take, dir: string, gain: number): PlayerTrack[] {
  const adjust = take.adjustMs / 1000;
  return take.clips.map((c, i) => ({
    id: `take-${i}`,
    group: "take",
    path: `${dir}/${c.file}`,
    gain,
    region: { start: c.start + adjust, from: c.from, to: c.to, fade: 0.015 },
  }));
}

/** 多遍拼接：每一段歌曲时间用哪一遍 */
export interface CompChoice {
  from: number;
  to: number;
  takeId: string;
}

/**
 * 把几遍拼成新的一遍（PRD P2 多遍拼接）：每段时间取指定那遍里覆盖这段的录音。
 * 各遍的手动微调直接算进新录音段的起点，新的一遍微调归零。
 */
export function compTake(takes: Take[], choices: CompChoice[], name: string): Take | null {
  const clips: Clip[] = [];
  for (const ch of choices) {
    const t = takes.find((x) => x.id === ch.takeId);
    if (!t || ch.to - ch.from < 0.01) continue;
    for (const c of t.clips) {
      const from = Math.max(c.from, ch.from);
      const to = Math.min(c.to, ch.to);
      if (to - from > 0.01) clips.push({ ...c, start: c.start + t.adjustMs / 1000, from, to });
    }
  }
  if (!clips.length) return null;
  clips.sort((a, b) => a.from - b.from);
  // 同一个文件、首尾相接的段合并，免得每句交界处都淡入淡出一下
  const merged: Clip[] = [];
  for (const c of clips) {
    const last = merged[merged.length - 1];
    if (last && last.file === c.file && Math.abs(last.start - c.start) < 1e-9 && Math.abs(last.to - c.from) < 1e-6) last.to = c.to;
    else merged.push({ ...c });
  }
  clips.splice(0, clips.length, ...merged);
  const used = takes.filter((t) => choices.some((c) => c.takeId === t.id));
  return {
    id: newTakeId(),
    name,
    createdAt: new Date().toISOString(),
    starred: false,
    clips,
    latencyMs: used[0]?.latencyMs ?? 0,
    adjustMs: 0,
    noise: used.find((t) => t.noise)?.noise,
    transpose: used[0]?.transpose,
    deviceLabel: used[0]?.deviceLabel,
  };
}

/** 按歌词句子分段：第 i 句 = [第 i 句开始, 第 i+1 句开始)，头尾延伸到录音的覆盖范围 */
export function lineSegments(lineStarts: number[], span: [number, number]): [number, number][] {
  if (!lineStarts.length) return [span];
  return lineStarts.map((t, i) => [i === 0 ? Math.min(span[0], t) : t, i + 1 < lineStarts.length ? lineStarts[i + 1] : Math.max(span[1], t + 1)]);
}
