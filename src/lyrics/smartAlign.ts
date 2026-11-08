/**
 * 智能对齐的入口：识别人声 → 找开口点 → 对齐歌词。
 * 识别在后端做（macOS 离线语音识别，结果有缓存），对齐在前端做。
 */
import { invoke } from "@tauri-apps/api/core";
import { type LrcDoc, type LrcLine, sortLines } from "./lrc";
import { type AlignResult, type Token, alignToTranscript } from "./lyricAlign";
import { detectOnsets, loudness } from "./vocalOnsets";

export type { Suggestion } from "./lyricAlign";

export async function transcribeVocals(path: string): Promise<Token[]> {
  return invoke<Token[]>("transcribe_vocals", { path });
}

function onsetsOf(buffer: AudioBuffer | null) {
  if (!buffer) return [];
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  return detectOnsets(loudness(channels, buffer.sampleRate));
}

/**
 * 对齐一组行（按歌词顺序）。offsetMs 是这些行所在文档的 [offset:]：
 * 识别出的是实际听到的时间，写回时要加上 offset，这样文档原有的 offset 不受影响。
 */
export async function alignLines(
  lines: LrcLine[],
  vocalPath: string,
  vocalBuffer: AudioBuffer | null,
  offsetMs = 0,
): Promise<AlignResult> {
  const shift = offsetMs / 1000;
  const input = lines.map((l) => ({ ...l, time: l.time === null ? null : l.time - shift }));
  const tokens = await transcribeVocals(vocalPath);
  const result = alignToTranscript(input, tokens, onsetsOf(vocalBuffer));
  if (!result) throw new Error(tokens.length === 0 ? "人声里没识别出字" : "歌词和人声对不上，可能不是这首歌的歌词");
  return {
    ...result,
    lines: result.lines.map((l) => ({ ...l, time: l.time === null ? null : Math.round((l.time + shift) * 100) / 100 })),
  };
}

/** 对齐整份文档，返回 offset 归零的新文档 */
export async function alignDoc(
  doc: LrcDoc,
  vocalPath: string,
  vocalBuffer: AudioBuffer | null,
): Promise<{ doc: LrcDoc; result: AlignResult }> {
  const shift = doc.offsetMs / 1000;
  const lines = sortLines(doc.lines).map((l) => ({ ...l, time: l.time === null ? null : l.time - shift }));
  const result = await alignLines(lines, vocalPath, vocalBuffer, 0);
  return { doc: { meta: doc.meta, offsetMs: 0, lines: sortLines(result.lines) }, result };
}
