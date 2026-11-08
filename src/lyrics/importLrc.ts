/**
 * 导入外部 LRC（网上下载的、别的软件导出的）。
 *
 * - 编码：UTF-8 / UTF-16（带 BOM）/ GBK（国内歌词站常见）自动识别
 * - 去掉逐字时间标签 <00:12.34>，只保留逐行
 * - [offset:] 直接折算进每行时间，导入后 offset 归零
 */
import { type LrcDoc, parseLrc, sortLines } from "./lrc";

export function decodeLyricsBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
const TIME_TAG = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/;

/** 文本里有没有 LRC 时间标签 */
export function looksLikeLrc(text: string): boolean {
  return TIME_TAG.test(text);
}

export function importLrc(text: string): LrcDoc {
  const doc = parseLrc(text);
  const shift = doc.offsetMs / 1000;
  const lines = doc.lines.map((l) => ({
    text: l.text.replace(WORD_TAG, "").replace(/\s+/g, " ").trim(),
    time: l.time === null ? null : Math.max(0, Math.round((l.time - shift) * 1000) / 1000),
  }));
  // 开头连续的空行（纯时间标签）没有意义，去掉
  const sorted = sortLines(lines);
  while (sorted.length > 0 && sorted[0].text === "") sorted.shift();
  return { meta: doc.meta, offsetMs: 0, lines: sorted };
}
