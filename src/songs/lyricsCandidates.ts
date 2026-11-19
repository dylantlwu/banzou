// 歌词库只有时长对不上的版本（剪辑版 / 完整版）时：用「智能对齐」按这首的人声重新对时间，
// 对上了写成新的 .lrc 并标「待核对」；对不上就不写，把原因记进资料表（资料检查里看得到）。
// 后端只给候选、只在没有歌词时写（src-tauri/src/songmeta.rs 的 search_lyrics / lyrics_result）。
import { parseLrc, serializeLrc } from "../lyrics/lrc";
import type { AlignResult } from "../lyrics/lyricAlign";
import { alignDoc } from "../lyrics/smartAlign";
import type { Song } from "../types";
import { songMeta } from "./meta";

export interface LrcCandidate {
  lrc: string;
  /** 那份歌词的时长 - 这首的时长（秒）；不知道是 null */
  diff: number | null;
  /** 歌词库里登记的歌手 */
  artist: string;
  /** 是不是同一位歌手（含别名） */
  sameArtist: boolean;
}

export interface PendingLyrics {
  key: string;
  /** 第一份候选（兼容老格式） */
  lrc: string;
  diff: number;
  /** 全部候选（同一歌手优先）；逐份按人声对齐，取对得最好的 */
  candidates?: LrcCandidate[];
}

/** 至少这么多句靠识别对上，才算对齐成功（其余按前后插值） */
export const MIN_ALIGNED_RATIO = 0.5;

export type Aligner = (lrc: string, vocalPath: string) => Promise<{ content: string; result: AlignResult }>;

const defaultAligner: Aligner = async (lrc, vocalPath) => {
  const { doc, result } = await alignDoc(parseLrc(lrc), vocalPath, null);
  return { content: serializeLrc(doc), result };
};

export interface Outcome {
  key: string;
  ok: boolean;
  note: string;
}

const versionText = (c: LrcCandidate) => {
  const who = c.sameArtist ? "" : `「${c.artist || "别的歌手"}」登记的同名歌，`;
  const len = c.diff === null ? "不知道时长" : Math.abs(c.diff) <= 8 ? `时长差 ${Math.round(Math.abs(c.diff))} 秒` : `${c.diff > 0 ? "更长" : "更短"}的版本（差 ${Math.round(Math.abs(c.diff))} 秒）`;
  return `歌词库里是${who}${len}`;
};

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/**
 * 人声里唱了、歌词里没有的段落（改编版加的词、多出来的重复段）。
 * 对齐只会给出提示，不会自己加句子；这里把它们的时间段写进说明，免得在资料检查里看不出缺词。
 */
export function missingSpans(result: AlignResult): string[] {
  const spans: { from: number; to: number }[] = [];
  for (const s of result.suggestions) {
    if (s.kind !== "missing") continue;
    const to = result.lines[s.line]?.time ?? s.time + 5;
    const last = spans[spans.length - 1];
    if (last && s.time - last.to <= 6) last.to = Math.max(last.to, to);
    else spans.push({ from: s.time, to: Math.max(to, s.time + 1) });
  }
  return spans.map((x) => `${clock(x.from)}–${clock(x.to)}`);
}

/** 对齐一份候选，写结果。已经有歌词的歌跳过（后端也会拒绝覆盖） */
export async function finishPending(p: PendingLyrics, song: Song | undefined, align: Aligner = defaultAligner): Promise<Outcome | null> {
  if (!song || song.lyrics) return null;
  const write = async (content: string | null, note: string) => {
    await songMeta("lyrics_result", { key: p.key, content, note });
    return { key: p.key, ok: content !== null, note };
  };
  const cands: LrcCandidate[] = p.candidates?.length ? p.candidates : [{ lrc: p.lrc, diff: p.diff, artist: "", sameArtist: true }];
  const vocal = song.vocals[0];
  if (!vocal) return write(null, `${versionText(cands[0])}，这首没有人声分轨，没法按人声核对`);
  // 逐份对齐，取对上句数比例最高的；别的歌手登记的同名歌如果其实是另一首，这里会对不上而被淘汰
  let best: { c: LrcCandidate; content: string; result: AlignResult } | null = null;
  let lastError = "";
  for (const c of cands) {
    try {
      const r = await align(c.lrc, vocal.path);
      const ratio = r.result.sung ? r.result.aligned / r.result.sung : 0;
      const bestRatio = best && best.result.sung ? best.result.aligned / best.result.sung : -1;
      if (ratio > bestRatio) best = { c, ...r };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  if (!best) return write(null, `${versionText(cands[0])}，对齐没成功：${lastError}`);
  const { c, content, result } = best;
  const tried = cands.length > 1 ? `，试了 ${cands.length} 份` : "";
  if (result.sung === 0 || result.aligned / result.sung < MIN_ALIGNED_RATIO) {
    return write(null, `${versionText(c)}，按人声只对上 ${result.aligned}/${result.sung} 句${tried}，太少了没有用`);
  }
  const spans = missingSpans(result);
  const gap = spans.length ? `；人声在 ${spans.join("、")} 唱了歌词里没有的词（可能是改编版加的），去歌词编辑里补上` : "";
  return write(content, `${versionText(c)}，按人声重新对过时间（对上 ${result.aligned}/${result.sung} 句${tried}），唱一遍核对${gap}`);
}

/** AI 补资料 / 搜歌词之后：把所有候选都对齐、写好 */
export async function finishAllPending(pending: PendingLyrics[] | undefined, songs: Song[], align: Aligner = defaultAligner): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const p of pending ?? []) {
    const r = await finishPending(p, songs.find((s) => s.title === p.key), align).catch((e) => ({ key: p.key, ok: false, note: String(e) }));
    if (r) out.push(r);
  }
  return out;
}
