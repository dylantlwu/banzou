/** 我的测试集（PRD 4.12）：题目、状态、把录音编成 wav。题目和录音只在本机的「测试集」文件夹，不进仓库 */
import { invoke } from "@tauri-apps/api/core";

export type ItemKind = "ask" | "read" | "sing";

export interface Mistake {
  word: string;
  correct: string;
  wrong: string;
}

export interface TestItem {
  id: string;
  kind: ItemKind;
  /** 要念的内容；问老师的题里日语词写成 原文{读音} */
  text: string;
  /** 问老师：理想的识别结果 */
  expect?: string;
  /** 念歌词 / 清唱：正确读音 */
  reading?: string;
  /** 实际要念的（故意念错时和 reading 不同） */
  say?: string;
  mistake?: Mistake;
}

export interface TakeRecord {
  status: "done" | "skipped";
  seconds: number;
  takes: number;
  at: number;
}

export interface TestSet {
  dir: string;
  song: string | null;
  items: TestItem[];
  records: Record<string, TakeRecord>;
}

export const KIND_LABEL: Record<ItemKind, string> = { ask: "问老师", read: "念歌词", sing: "清唱" };

export const KIND_HINT: Record<ItemKind, string> = {
  ask: "照平时问老师的样子说，日语词按上面的注音念。",
  read: "照下面这行假名念，不用唱。",
  sing: "清唱，不放伴奏，照原曲的调唱这两句。",
};

/** 从 from 往后（含 from）第一道还没录也没跳过的题；都处理过了就回到 from */
export function nextOpen(items: TestItem[], records: Record<string, TakeRecord>, from: number): number {
  for (let k = 0; k < items.length; k++) {
    const i = (from + k) % items.length;
    if (!records[items[i].id]) return i;
  }
  return Math.min(from, Math.max(items.length - 1, 0));
}

export function progress(items: TestItem[], records: Record<string, TakeRecord>) {
  let done = 0;
  let skipped = 0;
  let seconds = 0;
  for (const it of items) {
    const r = records[it.id];
    if (r?.status === "done") {
      done++;
      seconds += r.seconds;
    } else if (r?.status === "skipped") skipped++;
  }
  return { done, skipped, left: items.length - done - skipped, seconds };
}

/** 故意念错的那句：把 say 切成「前 / 念错的部分 / 后」，好把念错的地方标出来 */
export function splitMistake(say: string, m: Mistake | undefined): [string, string, string] {
  const at = m ? say.indexOf(m.wrong) : -1;
  if (!m || at < 0) return [say, "", ""];
  return [say.slice(0, at), m.wrong, say.slice(at + m.wrong.length)];
}

/** 把几段 Float32 采样编成 16 位单声道 wav */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Uint8Array {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 单声道
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (const x of c) {
      const s = Math.max(-1, Math.min(1, x));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const loadTestSet = () => invoke<TestSet>("testset_load");

export const saveTake = (id: string, wav: Uint8Array, info: { seconds: number; sampleRate: number; device: string }) =>
  // info 放前面：测试桥按块收数据，中文的麦克风名放在开头不会被切坏
  invoke<TakeRecord>("testset_save", { info, id, wav: toBase64(wav) });

export const skipItem = (id: string, skip: boolean) => invoke<TakeRecord | null>("testset_skip", { id, skip });

export const takeAudio = (id: string) => invoke<string>("testset_audio", { id }).then(fromBase64);
