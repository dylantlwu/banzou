import { describe, expect, it } from "vitest";
import { PitchTracker, type PitchFrame } from "./pitchTracker";
import {
  breathStats,
  foldToTarget,
  grade,
  matchQuestions,
  noteName,
  roundNotes,
  roundRoots,
  scoreNote,
  stableNote,
  sustainStats,
} from "./exercises";

const SR = 48000;

/** 按目标音合成「唱」的声音（可整体偏一点 / 晚一点），送进 PitchTracker 得到帧 */
function sing(notes: { midi: number; start: number; end: number }[], opts: { cents?: number; delay?: number; total?: number; octave?: number } = {}): PitchFrame[] {
  const total = opts.total ?? Math.max(...notes.map((n) => n.end)) + 1;
  const x = new Float32Array(Math.round(total * SR));
  let phase = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR - (opts.delay ?? 0);
    const n = notes.find((k) => t >= k.start && t < k.end);
    if (!n) continue;
    const hz = 440 * 2 ** ((n.midi + 12 * (opts.octave ?? 0) + (opts.cents ?? 0) / 100 - 69) / 12);
    phase += (2 * Math.PI * hz) / SR;
    x[i] = 0.3 * Math.sin(phase) + 0.1 * Math.sin(2 * phase);
  }
  const tracker = new PitchTracker(SR);
  const frames: PitchFrame[] = [];
  for (let i = 0; i + 128 <= x.length; i += 128) frames.push(...tracker.push(x.subarray(i, i + 128), (i + 127) / SR));
  return frames;
}

describe("轮次和音型", () => {
  it("从音域底部升到顶再降回来", () => {
    expect(roundRoots([0, 2, 4, 5, 7, 5, 4, 2, 0], { low: 55, high: 65 })).toEqual([55, 56, 57, 58, 57, 56, 55]);
    expect(roundRoots([0, 12, 0], { low: 55, high: 60 })).toHaveLength(1); // 音域放不下八度时给一个中间的
  });

  it("一轮的目标音按时间排好", () => {
    expect(roundNotes(60, [0, 4, 7], 1, 0.5)).toEqual([
      { midi: 60, start: 1, end: 1.5 },
      { midi: 64, start: 1.5, end: 2 },
      { midi: 67, start: 2, end: 2.5 },
    ]);
  });
});

describe("打分", () => {
  const notes = roundNotes(57, [0, 2, 4, 5, 7], 0.5, 0.6);

  it("唱准：每个音偏差 < 10 音分；整体偏高 40 音分被测出来", () => {
    const ok = sing(notes, { delay: 0.15 });
    for (const n of notes) expect(Math.abs(scoreNote(ok, n, 0.15)!)).toBeLessThan(10);
    const sharp = sing(notes, { cents: 40, delay: 0.15 });
    const c = scoreNote(sharp, notes[2], 0.15)!;
    expect(Math.abs(c - 40)).toBeLessThan(10);
    expect(grade(c)).toBe("ok");
  });

  it("低八度唱也算对；没唱算 miss", () => {
    const low = sing(notes, { octave: -1 });
    expect(Math.abs(scoreNote(low, notes[1], 0)!)).toBeLessThan(10);
    expect(scoreNote(sing([notes[0]]), notes[3], 0)).toBeNull();
    expect(grade(null)).toBe("miss");
    expect(foldToTarget(48.2, 60)).toBeCloseTo(60.2);
  });

  it("长音：平均偏差和抖动", () => {
    const frames = sing([{ midi: 60, start: 0, end: 4 }], { cents: -20 });
    const s = sustainStats(frames, 60, 0.5, 3.5)!;
    expect(Math.abs(s.meanCents + 20)).toBeLessThan(6);
    expect(s.wobble).toBeLessThan(10);
    expect(s.held).toBeGreaterThan(2.5);
  });

  it("音域测试：稳住 1.5 秒的音才算", () => {
    expect(stableNote(sing([{ midi: 50, start: 0, end: 2 }]))).toBe(50);
    expect(stableNote(sing([{ midi: 50, start: 0, end: 0.8 }]))).toBeNull();
  });
});

describe("气息", () => {
  it("连续的嘶声算时长，短暂停顿不算断", () => {
    const frames: PitchFrame[] = [];
    for (let t = 0; t < 12; t += 0.005) {
      const on = (t > 1 && t < 6) || (t > 6.2 && t < 9);
      frames.push({ t, midi: NaN, rms: on ? 0.05 * (1 + 0.05 * Math.sin(t * 7)) : 0.001 });
    }
    const s = breathStats(frames, 0.001);
    expect(s.seconds).toBeCloseTo(8, 0);
    expect(s.steadiness).toBeGreaterThan(0.8);
  });
});

describe("杂项", () => {
  it("听音题目在音域里、不连着重复；音名", () => {
    const q = matchQuestions({ low: 55, high: 67 }, 10, 42);
    expect(q).toHaveLength(10);
    expect(q.every((m) => m >= 55 && m <= 67)).toBe(true);
    expect(q.every((m, i) => i === 0 || m !== q[i - 1])).toBe(true);
    expect(noteName(60)).toBe("C4");
    expect(noteName(57)).toBe("A3");
  });
});
