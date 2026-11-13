import type { Song } from "../types";
import { songName } from "../songs/meta";
import { type SongTags, type TagStore, LANGS, displayArtist } from "../tags";

export interface LibFilter {
  query: string;
  /** 语种牌子；null = 全部 */
  lang: string | null;
  /** 歌单编号；null = 不按歌单 */
  playlist: string | null;
}

export const NO_FILTER: LibFilter = { query: "", lang: null, playlist: null };

/**
 * 曲库栏要显示的歌：搜索（歌名 / 显示名 / 原唱）+ 语种 + 歌单。
 * 选了歌单就按歌单里的顺序排
 */
export function filterSongs(songs: Song[], f: LibFilter, tagsOf: (s: Song) => SongTags | undefined, idOf: (s: Song) => string, store: TagStore): Song[] {
  const q = f.query.trim().toLowerCase();
  let list = songs.filter((s) => {
    if (f.lang && tagsOf(s)?.lang !== f.lang) return false;
    if (!q) return true;
    return s.title.toLowerCase().includes(q) || songName(s).toLowerCase().includes(q) || (displayArtist(tagsOf(s), s.artist) ?? "").toLowerCase().includes(q);
  });
  const pl = f.playlist ? store.playlists.find((p) => p.id === f.playlist) : null;
  if (pl) {
    const order = new Map(pl.songs.map((id, i) => [id, i]));
    list = list.filter((s) => order.has(idOf(s))).sort((a, b) => order.get(idOf(a))! - order.get(idOf(b))!);
  }
  return list;
}

/** 曲库里真有的语种（按固定顺序），用来出筛选牌子 */
export function langsInUse(songs: Song[], tagsOf: (s: Song) => SongTags | undefined): string[] {
  const used = new Set(songs.map((s) => tagsOf(s)?.lang).filter(Boolean));
  return LANGS.filter((l) => used.has(l));
}

/** 五颗珠子：伴奏、人声、歌词、原曲、录音 */
export function songBeads(song: Song): { label: string; on: boolean }[] {
  return [
    { label: song.accompaniments[0] ? `伴奏（${song.accompaniments[0].format}）` : "伴奏", on: song.accompaniments.length > 0 },
    { label: "人声", on: song.vocals.length > 0 },
    { label: "歌词", on: song.lyrics !== null },
    { label: "原曲", on: song.originals.length > 0 },
    { label: "录音", on: song.externalRecordings.length > 0 },
  ];
}

export function beadsTitle(song: Song): string {
  const b = songBeads(song);
  const have = b.filter((x) => x.on).map((x) => x.label);
  const miss = b.filter((x) => !x.on).map((x) => x.label);
  return [have.length ? `有：${have.join("、")}` : "", miss.length ? `没有：${miss.join("、")}` : ""].filter(Boolean).join("\n");
}
