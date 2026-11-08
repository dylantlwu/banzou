// 与后端 src-tauri/src/library.rs 的序列化结构保持一致

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
}

export interface Library {
  root: string;
  songs: Song[];
  unassigned: MediaFile[];
}
