/**
 * LRC 歌词解析与生成。
 *
 * - 支持一行多个时间标签、两位/三位毫秒、无毫秒
 * - 支持 [ti:] [ar:] [offset:] 等元数据
 * - 没有时间标签的文字行保留为「未打轴」行（time = null），放在最后，方便打轴中途保存再继续
 * - offset 按 LRC 惯例：正数 = 歌词提前出现
 */

export interface LrcLine {
  /** 秒；null 表示还没打轴 */
  time: number | null;
  /** 空字符串表示间奏（清屏） */
  text: string;
}

export interface LrcDoc {
  meta: Record<string, string>;
  offsetMs: number;
  lines: LrcLine[];
}

const LEADING_TIME_TAGS = /^(\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/;
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG = /^\[([a-zA-Z#]+)\s*:(.*)\]$/;

export function emptyDoc(): LrcDoc {
  return { meta: {}, offsetMs: 0, lines: [] };
}

/** 已打轴的行按时间排序在前，未打轴的保持原顺序在后 */
export function sortLines(lines: LrcLine[]): LrcLine[] {
  const timed = lines
    .map((line, i) => ({ line, i }))
    .filter((x) => x.line.time !== null)
    .sort((a, b) => a.line.time! - b.line.time! || a.i - b.i)
    .map((x) => x.line);
  const untimed = lines.filter((l) => l.time === null);
  return [...timed, ...untimed];
}

export function parseLrc(text: string): LrcDoc {
  const doc = emptyDoc();
  const lines: LrcLine[] = [];

  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const tagsMatch = line.match(LEADING_TIME_TAGS);
    if (tagsMatch) {
      const body = line.slice(tagsMatch[0].length).trim();
      for (const m of tagsMatch[0].matchAll(TIME_TAG)) {
        const frac = m[3] ? Number(`0.${m[3]}`) : 0;
        lines.push({ time: Number(m[1]) * 60 + Number(m[2]) + frac, text: body });
      }
      continue;
    }

    const meta = line.match(META_TAG);
    if (meta) {
      const key = meta[1].toLowerCase();
      const value = meta[2].trim();
      if (key === "offset") {
        const n = Number.parseInt(value, 10);
        doc.offsetMs = Number.isFinite(n) ? n : 0;
      } else {
        doc.meta[key] = value;
      }
      continue;
    }

    lines.push({ time: null, text: line });
  }

  doc.lines = sortLines(lines);
  return doc;
}

/** 秒 → mm:ss.cc */
export function formatLrcTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(m)}:${pad(s)}.${pad(c)}`;
}

export function serializeLrc(doc: LrcDoc): string {
  const out: string[] = [];
  const meta = { ...doc.meta };
  for (const key of ["ti", "ar"]) {
    if (meta[key]) out.push(`[${key}:${meta[key]}]`);
    delete meta[key];
  }
  for (const [key, value] of Object.entries(meta)) out.push(`[${key}:${value}]`);
  if (doc.offsetMs) out.push(`[offset:${Math.round(doc.offsetMs)}]`);

  for (const line of sortLines(doc.lines)) {
    out.push(line.time === null ? line.text : `[${formatLrcTime(line.time)}]${line.text}`);
  }
  return out.join("\n") + "\n";
}

/** 考虑 offset 后，某行实际出现的时间 */
export function effectiveTime(doc: LrcDoc, line: LrcLine): number | null {
  return line.time === null ? null : line.time - doc.offsetMs / 1000;
}

/**
 * 找到时刻 t 正在唱的行（最后一个出现时间 ≤ t 的已打轴行），没有则返回 -1。
 * 要求 doc.lines 已经 sortLines 过。
 */
export function findLineIndex(doc: LrcDoc, t: number): number {
  let lo = 0;
  let hi = doc.lines.findIndex((l) => l.time === null);
  if (hi === -1) hi = doc.lines.length;
  let found = -1;
  hi -= 1;
  const shift = doc.offsetMs / 1000;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (doc.lines[mid].time! - shift <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function hasTimedLines(doc: LrcDoc | null): boolean {
  return !!doc && doc.lines.some((l) => l.time !== null && l.text !== "");
}
