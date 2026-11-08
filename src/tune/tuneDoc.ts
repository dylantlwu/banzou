/**
 * 修音记录 `<takeId>.tune.json`（PRD 7.5）：参数、效果、选中的句子、上次应用时的指纹。
 * 原始录音永远不动，修音结果是按这份记录渲染出来的 `<takeId>.tuned.wav`。
 */
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_PARAMS, type TuneParams } from "./autotune";
import { DEFAULT_FX, type FxSettings } from "./effects";

export interface TuneDoc {
  version: 1;
  params: TuneParams;
  fx: FxSettings;
  denoise: boolean;
  /** 只修这些句（歌词已打轴行的下标）；空 = 整首 */
  lines: number[];
  /** 上次「应用修音」时的指纹，和当前不一样说明参数改过、修后音频过期了 */
  appliedHash?: string;
  /** 上次应用时自动修音部分（不含手动编辑）的指纹：相同才能只局部重渲改过的音符 */
  appliedAutoHash?: string;
  /** M4 手动修音的音符编辑 */
  notes?: unknown;
}

export function defaultDoc(params?: Partial<TuneParams>): TuneDoc {
  return { version: 1, params: { ...DEFAULT_PARAMS, ...params }, fx: { ...DEFAULT_FX }, denoise: true, lines: [] };
}

export async function loadTuneDoc(title: string, takeId: string): Promise<TuneDoc | null> {
  const v = await invoke<TuneDoc | null>("load_tune", { title, takeId });
  if (!v || typeof v !== "object" || v.version !== 1) return null;
  return { ...defaultDoc(), ...v, params: { ...DEFAULT_PARAMS, ...v.params }, fx: { ...DEFAULT_FX, ...v.fx } };
}

export function saveTuneDoc(title: string, takeId: string, doc: TuneDoc): Promise<void> {
  return invoke("save_tune", { title, takeId, value: doc });
}

/** 影响修后音频的东西：参数、降噪、范围、手动编辑、录音本身 */
export function applyHash(doc: TuneDoc, takeKey: string): string {
  return JSON.stringify([doc.params, doc.denoise, doc.notes ?? null, takeKey]);
}
