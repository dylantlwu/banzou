import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../audio/engine";
import { clipsFromSpans, coveredSeconds, overlay, spansFromEvents } from "./recordSpans";
import type { Clip } from "./takes";

const play = (at: number, offset: number): TimelineEvent => ({ kind: "play", at, offset, prev: offset });
const seek = (at: number, offset: number, prev: number): TimelineEvent => ({ kind: "seek", at, offset, prev });
const pause = (at: number, pos: number): TimelineEvent => ({ kind: "pause", at, offset: pos, prev: pos });
const clip = (file: string, start: number, from: number, to: number): Clip => ({ file, start, from, to, autoAlignMs: 0 });
const round = (clips: Clip[]) => clips.map((c) => ({ ...c, start: +c.start.toFixed(6), from: +c.from.toFixed(6), to: +c.to.toFixed(6) }));

describe("录音中途跳转切段", () => {
  it("没跳转：一段，和以前算法一样", () => {
    // 文件第 0 个采样在时钟 10，伴奏在时钟 15 从 0 开始放
    const spans = spansFromEvents([play(15, 0)], 200);
    expect(spans).toEqual([{ at: 15, offset: 0, end: 200 }]);
    expect(round(clipsFromSpans(spans, { file: "t.wav", t0: 10, latency: 0.03 }))).toEqual([clip("t.wav", -5.03, 0, 200)]);
  });

  it("快进前奏：跳转点前后各一段，后一段按新位置对上", () => {
    // 放到歌曲 15 秒（时钟 30）时跳到 59.6 秒，新位置在时钟 30.05 发声
    const spans = spansFromEvents([play(15, 0), seek(30.05, 59.6, 15)], 300);
    expect(spans).toEqual([
      { at: 15, offset: 0, end: 15 },
      { at: 30.05, offset: 59.6, end: 300 },
    ]);
    const clips = clipsFromSpans(spans, { file: "t.wav", t0: 10, latency: 0 });
    expect(round(clips)).toEqual([clip("t.wav", -5, 0, 15), clip("t.wav", 39.55, 59.6, 300)]);
    // 跳转后：文件第 20.05 秒（时钟 30.05）应该对上歌曲 59.6 秒
    expect(clips[1].start + (30.05 - 10)).toBeCloseTo(59.6);
  });

  it("连按几下 +5：中间很短的段丢掉", () => {
    const spans = spansFromEvents([play(1, 0), seek(11.05, 15, 10), seek(11.09, 20, 15.0), seek(11.13, 25, 20.02)], 100);
    expect(spans.map((s) => [s.offset, s.end])).toEqual([
      [0, 10],
      [25, 100],
    ]);
  });

  it("往回跳重唱：重叠的部分以后录的为准", () => {
    // 放到 60 秒跳回 40 秒重唱，唱到 90 秒停
    const spans = spansFromEvents([play(5, 0), seek(65.05, 40, 60)], 90);
    const clips = clipsFromSpans(spans, { file: "t.wav", t0: 0, latency: 0 });
    expect(round(clips)).toEqual([clip("t.wav", -5, 0, 40), clip("t.wav", -25.05, 40, 90)]);
  });

  it("暂停再继续：暂停那段录音不用", () => {
    const spans = spansFromEvents([play(5, 0), pause(35, 30), play(50.05, 30)], 80);
    const clips = clipsFromSpans(spans, { file: "t.wav", t0: 0, latency: 0 });
    expect(round(clips)).toEqual([clip("t.wav", -5, 0, 30), clip("t.wav", -20.05, 30, 80)]);
  });

  it("播到结尾自动暂停：最后一段以暂停位置收尾", () => {
    const spans = spansFromEvents([play(5, 0), pause(205, 200)], 0);
    expect(spans).toEqual([{ at: 5, offset: 0, end: 200 }]);
  });

  it("自动对齐挪的量和补录区间", () => {
    const spans = spansFromEvents([play(5, 38), seek(20.05, 70, 53)], 90);
    const clips = clipsFromSpans(spans, { file: "t.wav", t0: 0, latency: 0.1, shift: 0.02, autoAlignMs: 20, window: [40, 80] });
    expect(round(clips)).toEqual([
      { ...clip("t.wav", 32.92, 40, 53), autoAlignMs: 20 },
      { ...clip("t.wav", 49.87, 70, 80), autoAlignMs: 20 },
    ]);
    expect(coveredSeconds(clips)).toBeCloseTo(23);
  });

  it("叠加：上层覆盖到的地方换掉，其余保留", () => {
    const base = [clip("a.wav", 0, 0, 100)];
    expect(overlay(base, [clip("b.wav", 40, 40, 50), clip("b.wav", 60, 70, 80)])).toEqual([
      clip("a.wav", 0, 0, 40),
      clip("b.wav", 40, 40, 50),
      clip("a.wav", 0, 50, 70),
      clip("b.wav", 60, 70, 80),
      clip("a.wav", 0, 80, 100),
    ]);
  });
});
