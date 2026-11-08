/**
 * 打轴编辑器的状态与操作（纯函数，便于测试）。PRD 4.3
 *
 * cursor：下一次按空格要打的行；等于 lines.length 表示全部打完
 * selected：当前选中、可用 ⌥←/→ 微调的行
 */
import { type LrcDoc, type LrcLine, sortLines } from "./lrc";

export interface TapState {
  lines: LrcLine[];
  cursor: number;
  selected: number | null;
}

export const NUDGE_SECONDS = 0.05;

function firstUntimed(lines: LrcLine[]): number {
  const i = lines.findIndex((l) => l.time === null);
  return i === -1 ? lines.length : i;
}

/** 从粘贴的纯文本生成；同一位置文字没变的行保留原来的时间 */
export function fromText(text: string, previous: LrcLine[] = []): TapState {
  const prevLyrics = previous.filter((l) => l.text !== "");
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((t, i) => ({ text: t, time: prevLyrics[i]?.text === t ? prevLyrics[i].time : null }));
  return { lines, cursor: firstUntimed(lines), selected: null };
}

export function fromDoc(doc: LrcDoc): TapState {
  const lines = sortLines(doc.lines).map((l) => ({ ...l }));
  return { lines, cursor: firstUntimed(lines), selected: null };
}

export function toText(state: TapState): string {
  return state.lines
    .filter((l) => l.text !== "")
    .map((l) => l.text)
    .join("\n");
}

/** 在 cursor 行记下时间 */
export function tap(state: TapState, time: number): TapState {
  if (state.cursor >= state.lines.length) return state;
  const lines = state.lines.slice();
  lines[state.cursor] = { ...lines[state.cursor], time };
  return { lines, cursor: state.cursor + 1, selected: state.cursor };
}

/** 撤销上一次打轴：清掉上一行的时间；如果上一行是间奏标记就删掉它 */
export function undo(state: TapState): TapState {
  if (state.cursor === 0) return state;
  const i = state.cursor - 1;
  let lines = state.lines.slice();
  if (lines[i].text === "") {
    lines = lines.filter((_, j) => j !== i);
  } else {
    lines[i] = { ...lines[i], time: null };
  }
  return { lines, cursor: i, selected: i > 0 ? i - 1 : null };
}

/** 在 cursor 前插入间奏标记（歌词清屏） */
export function insertBreak(state: TapState, time: number): TapState {
  const lines = state.lines.slice();
  lines.splice(state.cursor, 0, { text: "", time });
  return { lines, cursor: state.cursor + 1, selected: state.cursor };
}

export function setTime(state: TapState, index: number, time: number): TapState {
  if (index < 0 || index >= state.lines.length) return state;
  const lines = state.lines.slice();
  lines[index] = { ...lines[index], time: Math.max(0, time) };
  return { ...state, lines };
}

export function nudge(state: TapState, delta: number): TapState {
  const i = state.selected;
  if (i === null) return state;
  const t = state.lines[i]?.time;
  if (t === null || t === undefined) return state;
  return setTime(state, i, Math.round((t + delta) * 1000) / 1000);
}

export function select(state: TapState, index: number | null): TapState {
  if (index !== null && (index < 0 || index >= state.lines.length)) return state;
  return { ...state, selected: index };
}

/** 从某一行开始重新打 */
export function setCursor(state: TapState, index: number): TapState {
  return { ...state, cursor: Math.max(0, Math.min(index, state.lines.length)) };
}

/** 整体换成新的一组行（比如智能对齐的结果），按时间重新排好 */
export function withLines(lines: LrcLine[]): TapState {
  const sorted = sortLines(lines).map((l) => ({ ...l }));
  return { lines: sorted, cursor: firstUntimed(sorted), selected: null };
}

/** 改某一行的文字（比如采用识别到的歌词） */
export function setText(state: TapState, index: number, text: string): TapState {
  if (index < 0 || index >= state.lines.length || !text.trim()) return state;
  const lines = state.lines.slice();
  lines[index] = { ...lines[index], text: text.trim() };
  return { ...state, lines };
}

/** 插入一行（比如补上漏掉的一句），插在 index 前面 */
export function insertLine(state: TapState, index: number, line: LrcLine): TapState {
  const at = Math.max(0, Math.min(index, state.lines.length));
  const lines = state.lines.slice();
  lines.splice(at, 0, { ...line });
  const sorted = sortLines(lines);
  return { lines: sorted, cursor: firstUntimed(sorted), selected: sorted.indexOf(lines[at]) };
}

export function progress(state: TapState): { done: number; total: number } {
  const lyrics = state.lines.filter((l) => l.text !== "");
  return { done: lyrics.filter((l) => l.time !== null).length, total: lyrics.length };
}

export function toDoc(state: TapState, base: Pick<LrcDoc, "meta" | "offsetMs">): LrcDoc {
  return { meta: { ...base.meta }, offsetMs: base.offsetMs, lines: sortLines(state.lines) };
}

/**
 * 按下空格那一刻应记录的歌曲时间：
 * 扣掉耳机输出延迟和人的反应时间（都是现实时间，变速时要乘以播放速度）
 */
export function tapTime(position: number, rate: number, outputLatencyMs: number, reactionMs: number): number {
  return Math.max(0, position - ((outputLatencyMs + reactionMs) / 1000) * rate);
}
