import { expect, it } from "vitest";
import type { Song } from "../types";
import { beadsTitle, filterSongs, langsInUse, songBeads } from "./filter";
import { type TagStore, normalizeStore } from "../tags";

const song = (title: string, extra: Partial<Song> = {}): Song => ({
  id: title,
  title,
  artist: null,
  accompaniments: [],
  vocals: [],
  lyrics: null,
  originals: [],
  externalRecordings: [],
  songId: `id-${title}`,
  meta: null,
  ...extra,
});

const songs = [song("夏実", { artist: "AKASAKI" }), song("Lose Control"), song("几分之几")];
const store: TagStore = {
  ...normalizeStore(null),
  songs: { "id-夏実": { lang: "日语" }, "id-Lose Control": { lang: "英文", artist: "Teddy Swims" }, "id-几分之几": { lang: "国语" } },
  playlists: [{ id: "p1", name: "聚会", songs: ["id-几分之几", "id-夏実"] }],
};
const tagsOf = (s: Song) => store.songs[s.songId];
const idOf = (s: Song) => s.songId;

it("搜索认歌名和原唱（标签里的优先）", () => {
  expect(filterSongs(songs, { query: "teddy", lang: null, playlist: null }, tagsOf, idOf, store).map((s) => s.title)).toEqual(["Lose Control"]);
  expect(filterSongs(songs, { query: "akasaki", lang: null, playlist: null }, tagsOf, idOf, store).map((s) => s.title)).toEqual(["夏実"]);
});

it("语种牌子只留这一种", () => {
  expect(filterSongs(songs, { query: "", lang: "国语", playlist: null }, tagsOf, idOf, store).map((s) => s.title)).toEqual(["几分之几"]);
});

it("选了歌单按歌单顺序排，和语种一起筛", () => {
  expect(filterSongs(songs, { query: "", lang: null, playlist: "p1" }, tagsOf, idOf, store).map((s) => s.title)).toEqual(["几分之几", "夏実"]);
  expect(filterSongs(songs, { query: "", lang: "日语", playlist: "p1" }, tagsOf, idOf, store).map((s) => s.title)).toEqual(["夏実"]);
  // 歌单被删了就当没选
  expect(filterSongs(songs, { query: "", lang: null, playlist: "gone" }, tagsOf, idOf, store)).toHaveLength(3);
});

it("语种牌子按固定顺序，只出曲库里有的", () => {
  expect(langsInUse(songs, tagsOf)).toEqual(["国语", "英文", "日语"]);
});

it("五颗珠子：有的实心，提示里写伴奏格式", () => {
  const s = song("x", { accompaniments: [{ path: "a", fileName: "a", format: "wav" }], lyrics: { path: "l", fileName: "l", format: "lrc" } });
  expect(songBeads(s).map((b) => b.on)).toEqual([true, false, true, false, false]);
  expect(beadsTitle(s)).toBe("有：伴奏（wav）、歌词\n没有：人声、原曲、录音");
});

it("学唱：按空行分段，每句带起止时间", async () => {
  const { learnSections } = await import("./LearnMode");
  const { parseLrc } = await import("../lyrics/lrc");
  const doc = parseLrc("[00:01.00]一\n[00:03.00]二\n[00:05.00]\n[00:06.00]三\n");
  const s = learnSections(doc);
  expect(s.map((sec) => sec.map((l) => l.text))).toEqual([["一", "二"], ["三"]]);
  expect(s[0][0]).toMatchObject({ start: 1, end: 3 });
  expect(s[0][1]).toMatchObject({ start: 3, end: 6 });
  expect(s[1][0]).toMatchObject({ start: 6, end: 14 });
});

it("学唱：没有空行就每 4 句一段", async () => {
  const { learnSections } = await import("./LearnMode");
  const { parseLrc } = await import("../lyrics/lrc");
  const doc = parseLrc(Array.from({ length: 6 }, (_, i) => `[00:0${i}.00]句${i}`).join("\n"));
  expect(learnSections(doc).map((sec) => sec.length)).toEqual([4, 2]);
});
