import { invoke } from "@tauri-apps/api/core";

// 歌曲标签（歌手 / 语种 / 年代）和自建歌单的数据。存在 tags.json（见 src-tauri/src/tags.rs）。
// 手动改过的字段记在 manual 里，AI 重新打标签不会覆盖。

export const LANGS = ["国语", "粤语", "英文", "日语", "韩语", "其他"] as const;
export const ERAS = ["更早", "70s", "80s", "90s", "00s", "10s", "20s"] as const;
export type TagField = "artist" | "lang" | "era";

export interface SongTags {
  artist?: string;
  lang?: string;
  era?: string;
  manual?: TagField[];
  /** 一句话背景（原唱、专辑/影视、年份），AI 联网查到的，只是附带资料 */
  note?: string;
  /** 原曲名（搜歌词用），AI 联网查到的 */
  track?: string;
}
export interface Playlist {
  id: string;
  name: string;
  songs: string[];
}
export interface TagStore {
  songs: Record<string, SongTags>;
  playlists: Playlist[];
}

/** 读标签：每首歌的字段来自资料表（`<歌名>.song.json`，没有就是 tags.json 里的旧值），歌单来自 tags.json */
export const loadTags = async (): Promise<TagStore> => normalizeStore(await invoke("song_meta", { cmd: "tags_load", args: {} }));

/** 存标签：改了的字段写进资料表，歌单写回 tags.json（见 src-tauri/src/songmeta.rs tags_save） */
export const saveTags = (store: TagStore) => invoke("song_meta", { cmd: "tags_save", args: { value: store } });

/** 没有资料表的歌的编号：歌名去首尾空白后 SHA-256 的前 6 个字节（和电脑、电视两边一致）。
 *  有资料表的歌编号存在资料表里，改名也不变——用扫描结果里的 song.songId，不要自己算 */
export async function songId(title: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(title.trim()));
  return [...new Uint8Array(buf).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** 读出来的东西不可信：规整成合法的 TagStore */
export function normalizeStore(raw: unknown): TagStore {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const songs: Record<string, SongTags> = {};
  for (const [id, v] of Object.entries((r.songs && typeof r.songs === "object" ? r.songs : {}) as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const manual = (Array.isArray(o.manual) ? o.manual : []).filter((m): m is TagField => m === "artist" || m === "lang" || m === "era");
    songs[id] = { artist: str(o.artist), lang: str(o.lang), era: str(o.era), manual, ...(str(o.note) ? { note: str(o.note) } : {}), ...(str(o.track) ? { track: str(o.track) } : {}) };
  }
  const playlists: Playlist[] = [];
  for (const p of Array.isArray(r.playlists) ? r.playlists : []) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const name = str(o.name)?.trim();
    if (!name) continue;
    playlists.push({ id: str(o.id) || name, name, songs: (Array.isArray(o.songs) ? o.songs : []).filter((s): s is string => typeof s === "string") });
  }
  return { songs, playlists };
}

/** 手动改一个标签：记为「手动」；改成空等于清掉（也算手动，AI 不再填） */
export function setTag(store: TagStore, id: string, field: TagField, value: string): TagStore {
  const cur = store.songs[id] ?? {};
  const manual = [...new Set([...(cur.manual ?? []), field])];
  return { ...store, songs: { ...store.songs, [id]: { ...cur, [field]: value.trim() || undefined, manual } } };
}

export const isManual = (store: TagStore, id: string, field: TagField) => store.songs[id]?.manual?.includes(field) ?? false;

export function addPlaylist(store: TagStore, name: string, id = `p${Date.now().toString(36)}`): TagStore {
  const n = name.trim();
  if (!n) return store;
  return { ...store, playlists: [...store.playlists, { id, name: n, songs: [] }] };
}

export const renamePlaylist = (store: TagStore, id: string, name: string): TagStore =>
  name.trim() ? { ...store, playlists: store.playlists.map((p) => (p.id === id ? { ...p, name: name.trim() } : p)) } : store;

export const removePlaylist = (store: TagStore, id: string): TagStore => ({ ...store, playlists: store.playlists.filter((p) => p.id !== id) });

export const addToPlaylist = (store: TagStore, id: string, songId: string): TagStore => ({
  ...store,
  playlists: store.playlists.map((p) => (p.id === id && !p.songs.includes(songId) ? { ...p, songs: [...p.songs, songId] } : p)),
});

export const removeFromPlaylist = (store: TagStore, id: string, songId: string): TagStore => ({
  ...store,
  playlists: store.playlists.map((p) => (p.id === id ? { ...p, songs: p.songs.filter((s) => s !== songId) } : p)),
});

/** 把歌单里第 from 首挪到第 to 的位置 */
export function moveInPlaylist(store: TagStore, id: string, from: number, to: number): TagStore {
  return {
    ...store,
    playlists: store.playlists.map((p) => {
      if (p.id !== id || from < 0 || from >= p.songs.length || to < 0 || to >= p.songs.length) return p;
      const songs = [...p.songs];
      const [x] = songs.splice(from, 1);
      songs.splice(to, 0, x);
      return { ...p, songs };
    }),
  };
}

/** AI 打完标签后：标签以磁盘上的（AI 刚写的）为准，但打标签期间在窗口里手动改的字段和歌单以本地为准 */
export function mergeAfterAi(disk: TagStore, local: TagStore): TagStore {
  const songs: Record<string, SongTags> = { ...disk.songs };
  for (const [id, t] of Object.entries(local.songs)) {
    const manual = t.manual ?? [];
    if (!manual.length) continue;
    const cur = { ...(songs[id] ?? {}) };
    for (const f of manual) cur[f] = t[f];
    cur.manual = [...new Set([...(cur.manual ?? []), ...manual])];
    songs[id] = cur;
  }
  return { songs, playlists: local.playlists };
}

/** 歌手：标签里有就用标签的，没有再用扫描出来的 */
export const displayArtist = (tags: SongTags | undefined, scanned: string | null | undefined): string | null => tags?.artist?.trim() || scanned || null;

/** 「国语 · 00s」；都没有就是 null */
export const langEraLine = (tags: SongTags | undefined): string | null => [tags?.lang, tags?.era].filter(Boolean).join(" · ") || null;

/** 还没有标签：歌手 / 语种 / 年代缺任一个（note 只是附带资料，不算） */
export const needsTags = (store: TagStore, id: string): boolean => {
  const t = store.songs[id];
  return !t?.artist || !t?.lang || !t?.era;
};
