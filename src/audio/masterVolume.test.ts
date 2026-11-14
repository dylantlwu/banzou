import { expect, it } from "vitest";
import { followMasterVolume, masterGain, setMasterGain, volumeGain } from "./masterVolume";

it("滑杆位置按听感换成增益，静音是 0", () => {
  expect(volumeGain(1, false)).toBe(1);
  expect(volumeGain(0.5, false)).toBe(0.25);
  expect(volumeGain(0, false)).toBe(0);
  expect(volumeGain(0.8, true)).toBe(0);
  expect(volumeGain(2, false)).toBe(1);
  expect(volumeGain(Number.NaN, false)).toBe(0);
});

it("老师的声音跟着总音量，放完就不再跟", () => {
  const listeners: Record<string, () => void> = {};
  const el = { volume: 1, addEventListener: (t: string, f: () => void) => (listeners[t] = f) } as unknown as HTMLMediaElement;
  setMasterGain(0.4);
  followMasterVolume(el);
  expect(el.volume).toBe(0.4);
  setMasterGain(0.1);
  expect(el.volume).toBe(0.1);
  listeners.ended();
  setMasterGain(0.9);
  expect(el.volume).toBe(0.1);
  expect(masterGain()).toBe(0.9);
});
