import { describe, expect, it } from "vitest";
import { type Clip, type Take, compTake, lineSegments, nextTakeName, punchIn, takeSpan, takeTracks } from "./takes";

const clip = (file: string, start: number, from: number, to: number): Clip => ({ file, start, from, to, autoAlignMs: 0 });
const take = (clips: Clip[], extra: Partial<Take> = {}): Take => ({
  id: "a",
  name: "第 1 遍",
  createdAt: "",
  starred: false,
  clips,
  latencyMs: 200,
  adjustMs: 0,
  ...extra,
});

describe("takes", () => {
  it("默认名字递增", () => {
    expect(nextTakeName([])).toBe("第 1 遍");
    expect(nextTakeName([take([]), take([], { name: "第 3 遍" }), take([], { name: "最好的" })])).toBe("第 4 遍");
  });

  it("补录把中间一段换掉，前后保留", () => {
    const parent = take([clip("take-01.wav", -2.1, 0, 200)]);
    const clips = punchIn(parent, clip("take-02.wav", 40, 40, 70), [45, 58]);
    expect(clips).toEqual([clip("take-01.wav", -2.1, 0, 45), clip("take-02.wav", 40, 45, 58), clip("take-01.wav", -2.1, 58, 200)]);
  });

  it("在补录过的那遍上再补录（区间重叠）", () => {
    const parent = take([clip("a.wav", 0, 0, 45), clip("b.wav", 40, 45, 58), clip("a.wav", 0, 58, 200)]);
    const clips = punchIn(parent, clip("c.wav", 50, 50, 80), [52, 60]);
    expect(clips.map((c) => [c.file, c.from, c.to])).toEqual([
      ["a.wav", 0, 45],
      ["b.wav", 45, 52],
      ["c.wav", 52, 60],
      ["a.wav", 60, 200],
    ]);
  });

  it("覆盖范围和播放音轨（含手动微调）", () => {
    const t = take([clip("a.wav", -1, 0, 45), clip("b.wav", 40, 45, 58)], { adjustMs: 30 });
    expect(takeSpan(t)).toEqual([0, 58]);
    const tracks = takeTracks(t, "/x/录音/歌", 0.8);
    expect(tracks).toHaveLength(2);
    expect(tracks[1]).toMatchObject({ id: "take-1", group: "take", path: "/x/录音/歌/b.wav", gain: 0.8 });
    expect(tracks[0].region!.start).toBeCloseTo(-0.97);
    expect(tracks[1].region).toMatchObject({ from: 45, to: 58, fade: 0.015 });
  });
});

describe("多遍拼接", () => {
  it("每句挑一遍，微调算进起点", () => {
    const a = take([clip("a.wav", -1, 0, 60)], { id: "A", adjustMs: 20 });
    const b = take([clip("b.wav", -2, 0, 60)], { id: "B" });
    const segs = lineSegments([10, 20, 30], [0, 60]);
    expect(segs).toEqual([
      [0, 20],
      [20, 30],
      [30, 60],
    ]);
    const t = compTake([a, b], [
      { from: 0, to: 20, takeId: "A" },
      { from: 20, to: 30, takeId: "B" },
      { from: 30, to: 60, takeId: "A" },
    ], "拼接版")!;
    expect(t.clips.map((c) => [c.file, c.from, c.to])).toEqual([
      ["a.wav", 0, 20],
      ["b.wav", 20, 30],
      ["a.wav", 30, 60],
    ]);
    expect(t.clips[0].start).toBeCloseTo(-0.98);
    expect(t.adjustMs).toBe(0);
  });

  it("同一遍相邻的几句合成一段", () => {
    const a = take([clip("a.wav", 0, 0, 60)], { id: "A" });
    const t = compTake([a], [
      { from: 0, to: 20, takeId: "A" },
      { from: 20, to: 40, takeId: "A" },
    ], "x")!;
    expect(t.clips.map((c) => [c.from, c.to])).toEqual([[0, 40]]);
  });

  it("选的那遍不覆盖这段就跳过", () => {
    const a = take([clip("a.wav", 40, 40, 50)], { id: "A" });
    expect(compTake([a], [{ from: 0, to: 30, takeId: "A" }], "x")).toBeNull();
  });
});
