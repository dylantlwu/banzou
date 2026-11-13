import { expect, it } from "vitest";
import type { Song } from "../types";
import { FIELDS, gaps, ready } from "./fields";
import type { CheckRow } from "./meta";
import { songName } from "./meta";

const file = (n: string) => ({ path: `/x/${n}`, fileName: n, format: n.split(".").pop() ?? "" });

function state(over: Partial<Song> = {}, row: Partial<CheckRow> = {}) {
  const song: Song = {
    id: "a",
    title: "甲",
    artist: null,
    accompaniments: [file("甲 - 伴奏.wav")],
    vocals: [file("甲 - 人声.wav")],
    lyrics: file("甲.lrc"),
    originals: [file("甲.mp4")],
    externalRecordings: [],
    songId: "000000000001",
    meta: null,
    ...over,
  };
  const r: CheckRow = {
    key: "甲",
    songId: "000000000001",
    sheet: "ok",
    sheetError: null,
    meta: { schema: 1, id: "000000000001", key: "甲", artist: "乙", lang: "国语", era: "10s", note: "背景", track: "甲" },
    lyricsTimed: true,
    tvPreview: "video",
    tvSynced: true,
    tvStale: false,
    ...row,
  };
  return { song, row: r };
}

it("资料齐全的歌没有缺口，所有功能都能用", () => {
  const s = state();
  expect(gaps(s)).toEqual([]);
  expect(ready(s, "tv") && ready(s, "learn") && ready(s, "live")).toBe(true);
});

it("缺歌词：电视、学唱、直播用不了，补法是搜歌词或打轴", () => {
  const s = state({ lyrics: null }, { lyricsTimed: false });
  const g = gaps(s).find((x) => x.def.key === "lyrics")!;
  expect(g.blocks.sort()).toEqual(["learn", "live", "tv"]);
  expect(g.fix).toEqual(["lyricsSearch", "tap"]);
  // 没歌词时不再另报「没时间轴」
  expect(gaps(s).some((x) => x.def.key === "lyricsTimed")).toBe(false);
  expect(ready(s, "sing")).toBe(true);
  expect(ready(s, "tv")).toBe(false);
});

it("学唱要语种和人声；电视要小 MV（只有声音时补法是先下视频）", () => {
  const s = state({ vocals: [] }, { meta: { schema: 1, id: "1", key: "甲" }, tvPreview: "audio" });
  const keys = gaps(s).map((g) => g.def.key);
  expect(keys).toEqual(expect.arrayContaining(["lang", "vocal", "tvPreview", "artist"]));
  expect(ready(s, "learn")).toBe(false);
  expect(gaps(s).find((g) => g.def.key === "tvPreview")!.fix).toEqual(["video", "tvSync"]);
});

it("用户特意清空的字段不算缺；日语歌才要读音", () => {
  const meta = { schema: 1, id: "1", key: "甲", artist: "乙", lang: "日语", era: "20s", note: "x", track: "y", by: { artist: "user" as const } };
  const s = state({}, { meta: { ...meta, artist: undefined } });
  const keys = gaps(s).map((g) => g.def.key);
  expect(keys).not.toContain("artist");
  expect(keys).toContain("titleReading");
  expect(gaps(state()).map((g) => g.def.key)).not.toContain("titleReading");
});

it("电视歌单旧了要同步", () => {
  expect(gaps(state({}, { tvStale: true })).map((g) => g.def.key)).toEqual(["tvFresh"]);
});

it("登记表的键不重复", () => {
  const keys = FIELDS.map((f) => f.key);
  expect(new Set(keys).size).toBe(keys.length);
});

it("显示名：资料表的 title 优先，没有用文件名", () => {
  expect(songName({ title: "AB", meta: null })).toBe("AB");
  expect(songName({ title: "AB", meta: { schema: 1, id: "1", key: "AB", title: " 夏天 " } })).toBe("夏天");
  expect(songName({ title: "AB", meta: { schema: 1, id: "1", key: "AB", title: " " } })).toBe("AB");
});
