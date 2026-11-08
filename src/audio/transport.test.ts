import { describe, expect, it } from "vitest";
import { Transport } from "./transport";

function setup(duration = 100) {
  let clock = 0;
  const t = new Transport(() => clock, duration);
  return { t, tick: (s: number) => (clock += s), at: () => clock };
}

describe("Transport", () => {
  it("暂停时位置不动，播放时随时钟前进", () => {
    const { t, tick } = setup();
    tick(5);
    expect(t.position()).toBe(0);
    t.play();
    tick(3);
    expect(t.position()).toBeCloseTo(3);
    t.pause();
    tick(10);
    expect(t.position()).toBeCloseTo(3);
  });

  it("继续播放从暂停处接着走", () => {
    const { t, tick } = setup();
    t.play();
    tick(4);
    t.pause();
    tick(2);
    expect(t.play()).toBeCloseTo(4);
    tick(1);
    expect(t.position()).toBeCloseTo(5);
  });

  it("带提前量启动时，启动前位置不会超前", () => {
    const { t, tick, at } = setup();
    t.play(at() + 0.03);
    tick(0.01);
    expect(t.position()).toBe(0);
    tick(1.02);
    expect(t.position()).toBeCloseTo(1);
  });

  it("播放中跳转后从新位置继续", () => {
    const { t, tick } = setup();
    t.play();
    tick(10);
    t.seek(50);
    tick(2);
    expect(t.position()).toBeCloseTo(52);
  });

  it("跳转位置被限制在 0 到时长之间", () => {
    const { t } = setup(60);
    expect(t.seek(-5)).toBe(0);
    expect(t.seek(999)).toBe(60);
  });

  it("播到结尾后位置停在时长，再播放从头开始", () => {
    const { t, tick } = setup(10);
    t.play();
    tick(15);
    expect(t.position()).toBe(10);
    expect(t.atEnd()).toBe(true);
    t.pause();
    expect(t.play()).toBe(0);
  });

  it("reset 清空状态", () => {
    const { t, tick } = setup();
    t.play();
    tick(5);
    t.reset(30);
    expect(t.playing).toBe(false);
    expect(t.position()).toBe(0);
    expect(t.duration).toBe(30);
  });

  it("放慢播放时位置按速度推进", () => {
    const { t, tick } = setup();
    t.setRate(0.5);
    t.play();
    tick(4);
    expect(t.position()).toBeCloseTo(2);
  });

  it("播放中改速度不跳位置", () => {
    const { t, tick } = setup();
    t.play();
    tick(10);
    t.setRate(0.75);
    expect(t.position()).toBeCloseTo(10);
    tick(4);
    expect(t.position()).toBeCloseTo(13);
    t.setRate(1);
    tick(1);
    expect(t.position()).toBeCloseTo(14);
  });
});
