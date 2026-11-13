// 与后端 src-tauri/src/library.rs 的序列化结构保持一致
import type { SongMeta } from "./songs/meta";

export interface MediaFile {
  path: string;
  fileName: string;
  format: string;
}

export interface Song {
  id: string;
  title: string;
  artist: string | null;
  /** 按格式优先级排好序，第一个是默认使用的 */
  accompaniments: MediaFile[];
  vocals: MediaFile[];
  lyrics: MediaFile | null;
  originals: MediaFile[];
  /** 应用外录的音频，如 iPhone 同时录下人声和外放伴奏的 m4a */
  externalRecordings: MediaFile[];
  /** 稳定编号（资料表里的 id；没有资料表就是歌名的编号），标签、歌单、电视都用它 */
  songId: string;
  /** 资料表 `<歌名>.song.json`（没有就是 null），见 src/songs/meta.ts */
  meta: SongMeta | null;
}

export interface Library {
  root: string;
  songs: Song[];
  unassigned: MediaFile[];
}
