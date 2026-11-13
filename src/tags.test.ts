import { expect, it } from "vitest";
import { addPlaylist, displayArtist, langEraLine, needsTags, addToPlaylist, isManual, mergeAfterAi, moveInPlaylist, normalizeStore, removeFromPlaylist, setTag, songId } from "./tags";

it("歌名编号和电脑、电视两边算法一致（SHA-256 前 6 字节）", async () => {
  expect(await songId("a")).toBe("ca978112ca1b");
  expect(await songId("  a ")).toBe("ca978112ca1b");
});

it("手动改过的标签记下来；空值清掉", () => {
  let s = normalizeStore(null);
  s = setTag(s, "x", "lang", "粤语");
  expect(s.songs.x).toMatchObject({ lang: "粤语", manual: ["lang"] });
  expect(isManual(s, "x", "lang")).toBe(true);
  expect(isManual(s, "x", "era")).toBe(false);
  s = setTag(s, "x", "lang", " ");
  expect(s.songs.x.lang).toBeUndefined();
  expect(s.songs.x.manual).toEqual(["lang"]);
});

it("读出来的脏数据被规整", () => {
  const s = normalizeStore({ songs: { a: { lang: 3, manual: ["lang", "bad"] }, b: 1 }, playlists: [{ name: " " }, { name: "聚会", songs: ["a", 2] }] });
  expect(s.songs).toEqual({ a: { artist: undefined, lang: undefined, era: undefined, manual: ["lang"] } });
  expect(s.playlists).toEqual([{ id: "聚会", name: "聚会", songs: ["a"] }]);
});

it("歌单：加、去重、移除、调整顺序", () => {
  let s = addPlaylist(normalizeStore(null), "家庭聚会", "p1");
  s = addToPlaylist(addToPlaylist(addToPlaylist(s, "p1", "a"), "p1", "b"), "p1", "a");
  s = addToPlaylist(s, "p1", "c");
  expect(s.playlists[0].songs).toEqual(["a", "b", "c"]);
  s = moveInPlaylist(s, "p1", 2, 0);
  expect(s.playlists[0].songs).toEqual(["c", "a", "b"]);
  s = removeFromPlaylist(s, "p1", "a");
  expect(s.playlists[0].songs).toEqual(["c", "b"]);
});

it("AI 打完后保留本地手动改的字段和歌单，其余用磁盘上的", () => {
    const disk = { songs: { a: { artist: "AI", lang: "国语", manual: [] }, b: { era: "90s", manual: [] } }, playlists: [] };
    const local = { songs: { a: { artist: "我改的", manual: ["artist" as const] } }, playlists: [{ id: "p", name: "x", songs: ["a"] }] };
    const m = mergeAfterAi(disk, local);
    expect(m.songs.a).toEqual({ artist: "我改的", lang: "国语", manual: ["artist"] });
    expect(m.songs.b.era).toBe("90s");
    expect(m.playlists).toEqual(local.playlists);
});

it("note 被保留；非字符串丢掉；缺 note 不算没标签", () => {
  const s = normalizeStore({ songs: { a: { artist: "x", lang: "国语", era: "00s", note: "原唱：某某" }, b: { note: 5 } } });
  expect(s.songs.a.note).toBe("原唱：某某");
  expect(s.songs.b.note).toBeUndefined();
  expect(needsTags(s, "a")).toBe(false);
  expect(needsTags(s, "b")).toBe(true);
});

it("主列表显示：标签歌手优先，语种 · 年代", () => {
  expect(displayArtist({ artist: " 周杰伦 " }, "扫描")).toBe("周杰伦");
  expect(displayArtist({}, "扫描")).toBe("扫描");
  expect(displayArtist(undefined, null)).toBeNull();
  expect(langEraLine({ lang: "国语", era: "00s" })).toBe("国语 · 00s");
  expect(langEraLine({ era: "90s" })).toBe("90s");
  expect(langEraLine({})).toBeNull();
});

it("原曲名 track 规整后保留（以前保存标签会把它丢掉）", () => {
  const s = normalizeStore({ songs: { a: { artist: "甲", track: "原曲", note: "背景" } } });
  expect(s.songs.a).toMatchObject({ artist: "甲", track: "原曲", note: "背景" });
});
