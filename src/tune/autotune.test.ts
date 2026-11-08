import { describe, expect, it } from "vitest";
import { type PitchTrack, computeTune, detectKey, hzToMidi, midiToHz, nearestScaleNote, DEFAULT_PARAMS } from "./autotune";

const HOP = 0.01;
const track = (fn: (t: number) => number, secs: number): PitchTrack => ({
  hop: HOP,
  f0: Array.from({ length: Math.round(secs / HOP) }, (_, i) => midiToHz(fn(i * HOP))),
});

const mid = (r: { tuned: Float64Array }) => r.tuned[Math.floor(r.tuned.length / 2)];

describe("autotune", () => {
  it("偏高 40 音分：强度 100% 修到目标 ±5 音分，50% 正好修一半", () => {
    const mine = track(() => 60.4, 2);
    const ref = track(() => 60, 10);
    const full = computeTune(mine, 3, ref, { ...DEFAULT_PARAMS, strength: 1 });
    expect(Math.abs(mid(full) - 60) * 100).toBeLessThan(5);
    const half = computeTune(mine, 3, ref, { ...DEFAULT_PARAMS, strength: 0.5 });
    expect(Math.abs(mid(half) - 60.2) * 100).toBeLessThan(5);
    expect(full.inTuneBefore).toBe(0);
    expect(full.inTuneAfter).toBeGreaterThan(0.9);
  });

  it("降八度唱也按原唱修", () => {
    const r = computeTune(track(() => 48.3, 2), 0, track(() => 60, 3), { ...DEFAULT_PARAMS, strength: 1 });
    expect(Math.abs(mid(r) - 48) * 100).toBeLessThan(5);
  });

  it("原唱和我差太远（唱了别的音）不修", () => {
    const r = computeTune(track(() => 64, 2), 0, track(() => 60, 3), { ...DEFAULT_PARAMS, strength: 1 });
    expect(Math.abs(mid(r) - 64)).toBeLessThan(0.01);
  });

  it("慢速保留颤音，快速把颤音拉平", () => {
    const vib = track((t) => 60.2 + 0.3 * Math.sin(2 * Math.PI * 5.5 * t), 2);
    const ref = track(() => 60, 3);
    const depth = (arr: Float64Array) => {
      const v = Array.from(arr.slice(60, 140));
      return Math.max(...v) - Math.min(...v);
    };
    const slow = computeTune(vib, 0, ref, { ...DEFAULT_PARAMS, strength: 1, speed: 0 });
    const fast = computeTune(vib, 0, ref, { ...DEFAULT_PARAMS, strength: 1, speed: 1 });
    expect(depth(slow.tuned)).toBeGreaterThan(0.45); // 颤音还在（原来 0.6）
    expect(depth(fast.tuned)).toBeLessThan(0.3);
    // 慢速时整体中心修到 60
    const avg = Array.from(slow.tuned.slice(60, 140)).reduce((a, b) => a + b, 0) / 80;
    expect(Math.abs(avg - 60) * 100).toBeLessThan(8);
  });

  it("参考音阶：吸到最近的调内音；只修选中的时间段", () => {
    const mine = track(() => 61.6, 2); // C# 偏高 → C 大调里最近的是 D(62)
    const r = computeTune(mine, 0, null, { ...DEFAULT_PARAMS, reference: "scale", strength: 1, key: { tonic: 0, mode: "major" } });
    expect(Math.abs(mid(r) - 62) * 100).toBeLessThan(5);
    const partial = computeTune(mine, 0, null, { ...DEFAULT_PARAMS, reference: "scale", strength: 1, ranges: [[1.5, 2]] });
    expect(Math.abs(partial.tuned[50] - 61.6)).toBeLessThan(0.01);
    expect(Math.abs(partial.tuned[180] - 62) * 100).toBeLessThan(5);
  });

  it("调检测和最近调内音", () => {
    // A 小调音阶来回唱
    const notes = [57, 59, 60, 62, 64, 65, 67, 69, 69, 64, 57, 57, 60, 64];
    const f0 = notes.flatMap((n) => new Array(20).fill(midiToHz(n)));
    expect(detectKey(f0)).toMatchObject({ tonic: 9, mode: "minor" });
    expect(nearestScaleNote(66.4, { tonic: 0, mode: "major" })).toBe(67);
    expect(Math.round(hzToMidi(440))).toBe(69);
  });
});
