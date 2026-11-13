/**
 * 录音中途跳转、暂停时，把一次录音切成几段：每段连续播放对应一个 Clip。
 *
 * 录音文件是一条不断的时间线（麦克风一直在录），伴奏却可能被跳转 / 暂停打断。
 * 每段连续播放记下：时钟 `at` 起从歌曲 `offset` 放到 `end`，就能算出这段录音在文件里从哪开始。
 * 往回跳重唱的部分以后录的为准（和补录一样）。
 */
import type { TimelineEvent } from "../audio/engine";
import type { Clip } from "./takes";

/** 一段连续播放：时钟 `at` 起从歌曲 `offset` 放到 `end` */
export interface PlaySpan {
  at: number;
  offset: number;
  end: number;
}

/** 太短的段丢掉（比如连按几下 +5 中间那几段） */
const MIN_SPAN = 0.05;

/**
 * 时间线事件 → 连续播放的段。`stopPos` 是按停止时伴奏放到的位置（最后一段还在放时用它收尾）。
 */
export function spansFromEvents(events: TimelineEvent[], stopPos: number): PlaySpan[] {
  const spans: PlaySpan[] = [];
  let open: { at: number; offset: number } | null = null;
  const close = (end: number) => {
    if (open && end - open.offset > MIN_SPAN) spans.push({ ...open, end });
    open = null;
  };
  for (const e of events) {
    if (e.kind === "pause") close(e.prev);
    else {
      if (e.kind === "seek") close(e.prev);
      else if (open) continue; // 已经在放，重复的 play 不算
      open = { at: e.at, offset: e.offset };
    }
  }
  close(stopPos);
  return spans;
}

/** 叠上去：top 覆盖到的歌曲时间用 top，其余保留 base */
export function overlay(base: Clip[], top: Clip[]): Clip[] {
  let out = base;
  for (const t of top) {
    const next: Clip[] = [];
    for (const c of out) {
      if (c.to <= t.from || c.from >= t.to) next.push(c);
      else {
        if (c.from < t.from) next.push({ ...c, to: t.from });
        if (c.to > t.to) next.push({ ...c, from: t.to });
      }
    }
    next.push(t);
    out = next;
  }
  return out.filter((c) => c.to - c.from > 0.01).sort((x, y) => x.from - y.from);
}

/**
 * 段 → Clip。`t0` 是录音文件第 0 个采样的时钟时刻，`latency` 是往返延迟（秒），
 * `shift` 是自动对齐挪的量（秒）。`window` 给了就只保留这个歌曲时间范围（补录 A-B）。
 */
export function clipsFromSpans(
  spans: PlaySpan[],
  o: { file: string; t0: number; latency: number; shift?: number; autoAlignMs?: number; window?: [number, number] },
): Clip[] {
  const shift = o.shift ?? 0;
  const clips = spans
    .map((s) => ({
      file: o.file,
      start: s.offset + (o.t0 - s.at) - o.latency + shift,
      from: o.window ? Math.max(o.window[0], s.offset) : s.offset,
      to: o.window ? Math.min(o.window[1], s.end) : s.end,
      autoAlignMs: o.autoAlignMs ?? 0,
    }))
    .filter((c) => c.to - c.from > 0.01);
  return overlay([], clips);
}

/** 这几段一共覆盖了多少秒歌曲时间 */
export function coveredSeconds(clips: Clip[]): number {
  return clips.reduce((n, c) => n + Math.max(0, c.to - c.from), 0);
}
