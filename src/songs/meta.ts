// 每首歌的资料表 `<歌名>.song.json`（后端 src-tauri/src/songmeta.rs，规则见 docs/资料清单.md §6）。
import { invoke } from "@tauri-apps/api/core";
import type { Song } from "../types";

/** 谁填的：user 锁定（AI 不覆盖）；ai 联网查的；scan 扫描文件名得到；tool 应用里的功能写的 */
export type FilledBy = "user" | "ai" | "scan" | "tool";

export interface SongMeta {
  schema: number;
  id: string;
  /** 现在对应的文件名键 */
  key: string;
  by?: Record<string, FilledBy>;
  title?: string;
  titleReading?: string;
  artist?: string;
  performer?: string;
  lyricist?: string;
  composer?: string;
  lang?: string;
  era?: string;
  version?: string;
  note?: string;
  track?: string;
  source?: { url?: string; videoTitle?: string; channel?: string };
  [field: string]: unknown;
}

/** 资料检查用的每首歌状态（songmeta::CheckRow） */
export interface CheckRow {
  key: string;
  songId: string;
  sheet: "ok" | "none" | "broken";
  sheetError: string | null;
  /** 有资料表读资料表，没有就是从 tags.json 和扫描拼出来的 */
  meta: SongMeta;
  lyricsTimed: boolean;
  tvPreview: "video" | "audio" | null;
  tvSynced: boolean;
  tvStale: boolean;
}

export interface PlanItem {
  key: string;
  id: string;
  action: "create" | "update" | "same" | "broken";
  file: string;
  fields: Record<string, [unknown, FilledBy | ""]>;
  error: string | null;
}

export interface RenameStep {
  from: string;
  to: string;
}

/** 资料表命令都走后端的 song_meta 一个入口 */
export const songMeta = <T>(cmd: string, args?: Record<string, unknown>) => invoke<T>("song_meta", { cmd, args: args ?? {} });

/** 显示用的歌名：资料表里的 title，没有就是文件名 */
export const songName = (song: Pick<Song, "title" | "meta">): string => (typeof song.meta?.title === "string" && song.meta.title.trim()) || song.title;

export const BY_LABEL: Record<FilledBy, string> = { user: "你填的", ai: "AI 查的", scan: "扫描", tool: "工具" };

/** 资料里一个字段的文字值（空白算没有） */
export function textOf(meta: SongMeta | null | undefined, key: string): string {
  const v = meta?.[key];
  return typeof v === "string" ? v.trim() : "";
}
