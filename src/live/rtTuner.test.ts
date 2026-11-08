import { describe, expect, it } from "vitest";
import { RealtimeTuner } from "./rtTuner";

const SR = 48000;

function tone(hz: number, secs: number): Float32Array {
  const out = new Float32Array(Math.round(secs * SR));
  for (let i = 0; i < out.length; i++) {
    const p = (2 * Math.PI * hz * i) / SR;
    out[i] = 0.4 * Math.sin(p) + 0.15 * Math.sin(2 * p) + 0.08 * Math.sin(3 * p);
  }
  return out;
}

/** 像浏览器一样每 128 个采样处理一块 */
function run(tuner: RealtimeTuner, input: Float32Array): Float32Array {
  const out = new Float32Array(input.length);
  const block = new Float32Array(128);
  for (let i = 0; i + 128 <= input.length; i += 128) {
    tuner.process(input.subarray(i, i + 128), block, i / SR);
    out.set(block, i);
  }
  return out;
}

/** 自相关估计基频 */
function estimateHz(x: Float32Array): number {
  let best = 0;
  let bestLag = 0;
  for (let lag = Math.floor(SR / 900); lag < SR / 70; lag++) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  // 抛物线插值
  const ac = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
    return s;
  };
  const a = ac(bestLag - 1);
  const b = ac(bestLag);
  const c = ac(bestLag + 1);
  const shift = (0.5 * (a - c)) / (a - 2 * b + c);
  return SR / (bestLag + shift);
}

const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

describe("实时修音", () => {
  it("延迟约 30ms 以内", () => {
    const t = new RealtimeTuner(SR);
    expect(t.latency / SR).toBeLessThan(0.04);
  });

  it("固定升 100 音分：输出音高准确", () => {
    const t = new RealtimeTuner(SR);
    t.setParams({ fixedCents: 100, speed: 1 });
    const out = run(t, tone(220, 1.5));
    const hz = estimateHz(out.subarray(SR * 0.6, SR * 1.1));
    expect(Math.abs(cents(hz, 220 * 2 ** (100 / 1200)))).toBeLessThan(10);
  });

  it("不修时基本还原（只晚了 latency）", () => {
    const t = new RealtimeTuner(SR);
    t.setParams({ enabled: false });
    const x = tone(196, 1.2);
    const y = run(t, x);
    const L = t.latency;
    let sig = 0;
    let err = 0;
    for (let i = SR * 0.4; i < SR * 1.0; i++) {
      sig += x[i - L] ** 2;
      err += (x[i - L] - y[i]) ** 2;
    }
    expect(10 * Math.log10(sig / err)).toBeGreaterThan(12);
  });

  it("跟原唱：偏高 40 音分修回目标", () => {
    const t = new RealtimeTuner(SR);
    t.setParams({ strength: 1, speed: 1 });
    // 原唱整首都是 A3（MIDI 57）
    t.setReference(new Float32Array(1000).fill(57));
    t.setClock({ playing: true, pos0: 0, t0: 0, rate: 1, roundTrip: 0.2 });
    const sharp = 220 * 2 ** (40 / 1200);
    const out = run(t, tone(sharp, 1.5));
    const hz = estimateHz(out.subarray(SR * 0.7, SR * 1.2));
    expect(Math.abs(cents(hz, 220))).toBeLessThan(12);
    expect(Math.round(t.info.target)).toBe(57);
  });

  it("没在唱（静音）时不出怪声", () => {
    const t = new RealtimeTuner(SR);
    const out = run(t, new Float32Array(SR / 2));
    expect(Math.max(...out.map(Math.abs))).toBeLessThan(1e-6);
  });
});
