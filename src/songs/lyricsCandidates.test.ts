import { beforeEach, expect, it, vi } from "vitest";
import type { Song } from "../types";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
vi.mock("./meta", () => ({ songMeta: async (cmd: string, args: Record<string, unknown>) => void calls.push({ cmd, args }) }));
const { finishAllPending, finishPending } = await import("./lyricsCandidates");

const file = (n: string) => ({ path: `/x/${n}`, fileName: n, format: "wav" });
const song = (over: Partial<Song> = {}): Song => ({
  id: "a",
  title: "甲",
  artist: null,
  accompaniments: [file("甲 - 伴奏.wav")],
  vocals: [file("甲 - 人声.wav")],
  lyrics: null,
  originals: [],
  externalRecordings: [],
  songId: "1",
  meta: null,
  ...over,
});
const pending = { key: "甲", lrc: "[00:10.00]一\n[00:20.00]二", diff: 30 };
const result = (aligned: number, sung: number) => ({ lines: [], aligned, sung, suggestions: [] });

beforeEach(() => void (calls.length = 0));

it("对齐成功：写新歌词，标待核对", async () => {
  const o = await finishPending(pending, song(), async () => ({ content: "[00:08.00]一\n[00:18.00]二", result: result(2, 2) }));
  expect(o?.ok).toBe(true);
  expect(calls).toEqual([{ cmd: "lyrics_result", args: { key: "甲", content: "[00:08.00]一\n[00:18.00]二", note: expect.stringContaining("按人声重新对过时间") } }]);
  expect(String(calls[0].args.note)).toContain("更长的版本（差 30 秒）");
});

it("对齐失败或对上太少：不写歌词，只记原因", async () => {
  await finishPending(pending, song(), async () => {
    throw new Error("人声里没识别出字");
  });
  await finishPending(pending, song(), async () => ({ content: "x", result: result(1, 10) }));
  expect(calls.map((c) => c.args.content)).toEqual([null, null]);
  expect(String(calls[0].args.note)).toContain("人声里没识别出字");
  expect(String(calls[1].args.note)).toContain("1/10");
});

it("没有人声不对齐；已经有歌词的歌什么都不做", async () => {
  const aligner = vi.fn();
  await finishPending(pending, song({ vocals: [] }), aligner);
  expect(aligner).not.toHaveBeenCalled();
  expect(calls[0].args.content).toBeNull();
  calls.length = 0;
  expect(await finishPending(pending, song({ lyrics: file("甲.lrc") }), aligner)).toBeNull();
  expect(await finishAllPending([pending], [], aligner)).toEqual([]);
  expect(calls).toEqual([]);
});

it("几份候选：逐份按人声对齐，取对得最好的；别人登记的另一首歌被淘汰", async () => {
  const p = {
    key: "甲",
    lrc: "a",
    diff: -3,
    candidates: [
      { lrc: "另一首", diff: -3, artist: "别人", sameArtist: false },
      { lrc: "这一首", diff: 12, artist: "Some Name", sameArtist: false },
    ],
  };
  const aligner = async (lrc: string) => ({ content: `[00:01.00]${lrc}`, result: lrc === "这一首" ? result(30, 40) : result(2, 40) });
  const o = await finishPending(p, song(), aligner);
  expect(o?.ok).toBe(true);
  expect(calls[0].args.content).toBe("[00:01.00]这一首");
  expect(String(calls[0].args.note)).toContain("「Some Name」登记的同名歌");
  expect(String(calls[0].args.note)).toContain("试了 2 份");
});

it("人声里多唱了歌词里没有的词：照样写歌词，把那几段的时间写进说明", async () => {
  const res = {
    lines: [
      { text: "一", time: 10 },
      { text: "二", time: 188.2 },
    ],
    aligned: 2,
    sung: 2,
    suggestions: [
      { kind: "missing" as const, line: 1, heard: "多出来的", time: 162.7 },
      { kind: "missing" as const, line: 1, heard: "又一段", time: 169.2 },
    ],
  };
  const o = await finishPending(pending, song(), async () => ({ content: "[00:10.00]一\n[03:08.20]二", result: res }));
  expect(o?.ok).toBe(true);
  expect(o?.note).toContain("人声在 2:42–3:08 唱了歌词里没有的词");
});
