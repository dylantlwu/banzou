import { describe, expect, it } from "vitest";
import { type PitchTrack, midiToHz } from "./autotune";
import { History, applyNotes, mergeNotes, noteMidi, resetNote, segmentNotes, splitNote } from "./notes";

const HOP = 0.01;
/** 一串音符：[midi, 秒]，中间留 gap 秒静音 */
function melody(notes: [number, number][], gap = 0): PitchTrack {
  const f0: number[] = [];
  for (const [m, d] of notes) {
    for (let i = 0; i < Math.round(d / HOP); i++) f0.push(midiToHz(m));
    for (let i = 0; i < Math.round(gap / HOP); i++) f0.push(0);
  }
  return { hop: HOP, f0 };
}
const midi = (t: PitchTrack) => Float64Array.from(t.f0, (f) => (f > 0 ? 69 + 12 * Math.log2(f / 440) : NaN));

describe("切音符", () => {
  it("连着唱的三个音切成三块，边界误差 < 20ms", () => {
    const notes = segmentNotes(melody([[60, 0.5], [62, 0.4], [64, 0.6]]), 10);
    expect(notes).toHaveLength(3);
    expect(Math.abs(notes[0].start - 10)).toBeLessThan(0.02);
    expect(Math.abs(notes[1].start - 10.5)).toBeLessThan(0.02);
    expect(Math.abs(notes[2].start - 10.9)).toBeLessThan(0.02);
    expect(Math.abs(notes[2].end - 11.5)).toBeLessThan(0.02);
  });

  it("静音分开的音、颤音不会被切碎", () => {
    const vib: PitchTrack = { hop: HOP, f0: Array.from({ length: 100 }, (_, i) => midiToHz(60 + 0.4 * Math.sin(2 * Math.PI * 5.5 * i * HOP))) };
    expect(segmentNotes(vib, 0)).toHaveLength(1);
    expect(segmentNotes(melody([[60, 0.3], [60, 0.3]], 0.2), 0)).toHaveLength(2);
  });
});

describe("手动编辑合成", () => {
  const track = melody([[60, 0.5], [62, 0.5]]);
  const m = midi(track);
  const auto = new Float32Array(m.length).fill(5);
  const notes = segmentNotes(track, 0);

  it("没改过的音符保持自动修音结果；改过的按参数：+100 音分", () => {
    const edited = notes.map((n, i) => (i === 1 ? { ...n, offset: 100, edited: true } : n));
    const out = applyNotes(m, 0, HOP, auto, edited);
    expect(out[20]).toBe(5);
    expect(Math.abs(out[75] - 100)).toBeLessThan(1);
  });

  it("颤音比例 0 把颤音去掉，拉直把漂移拉平", () => {
    const f0 = Array.from({ length: 100 }, (_, i) => midiToHz(60 + 0.3 * Math.sin(2 * Math.PI * 6 * i * HOP) + (i / 100) * 0.5));
    const t: PitchTrack = { hop: HOP, f0 };
    const mm = midi(t);
    const [n] = segmentNotes(t, 0);
    const out = applyNotes(mm, 0, HOP, new Float32Array(100), [{ ...n, vibrato: 0, straighten: 1, edited: true }]);
    const result = Array.from(mm).map((v, i) => v + out[i] / 100).slice(15, 85);
    expect(Math.max(...result) - Math.min(...result)).toBeLessThan(0.12);
    expect(noteMidi(n, mm, 0, HOP)).toBeCloseTo(60.25, 1);
  });
});

describe("切分、合并、还原、撤销", () => {
  it("切分后再合并回来；还原清掉编辑", () => {
    const notes = segmentNotes(melody([[60, 1]]), 0);
    const split = splitNote(notes, notes[0].id, 0.4);
    expect(split).toHaveLength(2);
    expect(split[0].end).toBe(0.4);
    const merged = mergeNotes(split, split.map((n) => n.id));
    expect(merged).toHaveLength(1);
    expect(merged[0].end).toBeCloseTo(1);
    expect(resetNote({ ...merged[0], offset: 50, edited: true })).toMatchObject({ offset: 0, edited: false });
  });

  it("撤销 / 重做", () => {
    const h = new History([1]);
    h.push([1, 2]);
    h.push([1, 2, 3]);
    expect(h.undo()).toEqual([1, 2]);
    expect(h.undo()).toEqual([1]);
    expect(h.canUndo).toBe(false);
    expect(h.redo()).toEqual([1, 2]);
    h.push([9]);
    expect(h.canRedo).toBe(false);
  });
});
