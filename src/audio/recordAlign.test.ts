import { describe, expect, it } from "vitest";
import { envelopeOf, estimateLag, measureRoundTrip } from "./recordAlign";

const SR = 16000;

/** 合成「人声」：一串不规则间隔的音节（带包络的正弦），返回 durSec 秒 */
function syllables(durSec: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(durSec * SR));
  let rnd = seed;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  let t = 0.3;
  while (t < durSec - 0.5) {
    const len = 0.15 + rand() * 0.35;
    const f = 180 + rand() * 300;
    const s0 = Math.round(t * SR);
    for (let i = 0; i < len * SR && s0 + i < out.length; i++) {
      const env = Math.min(1, i / (0.01 * SR)) * Math.exp(-i / (0.3 * SR));
      out[s0 + i] += 0.5 * env * Math.sin((2 * Math.PI * f * i) / SR);
    }
    t += len + 0.05 + rand() * 0.4;
  }
  return out;
}

/** 整体平移 d 秒（正数 = 变晚） */
function shifted(src: Float32Array, d: number, noise = 0): Float32Array {
  const out = new Float32Array(src.length);
  const n = Math.round(d * SR);
  let rnd = 7;
  for (let i = 0; i < out.length; i++) {
    const j = i - n;
    out[i] = (j >= 0 && j < src.length ? src[j] : 0) + (noise ? noise * (((rnd = (rnd * 16807) % 2147483647) / 2147483647) - 0.5) : 0);
  }
  return out;
}

describe("estimateLag", () => {
  const voice = syllables(30);
  const ref = envelopeOf(voice, SR);

  for (const d of [0.08, -0.04, 0.12]) {
    it(`录音晚了 ${d * 1000}ms → 往回挪 ${d * 1000}ms`, () => {
      const rec = envelopeOf(shifted(voice, d), SR);
      const r = estimateLag(rec, 0, ref, { from: 0, to: 30 })!;
      expect(Math.abs(r.shift + d)).toBeLessThan(0.01);
      expect(r.confidence).toBeGreaterThan(1.5);
    });
  }

  it("加了噪声和不同音高仍在 20ms 内", () => {
    const sung = syllables(30, 1).map((v, i) => v * (1 + 0.3 * Math.sin(i / 5000)));
    const rec = envelopeOf(shifted(sung, 0.06, 0.02), SR);
    const r = estimateLag(rec, 0, ref, { from: 0, to: 30 })!;
    expect(Math.abs(r.shift + 0.06)).toBeLessThan(0.02);
  });

  it("录音从歌曲中途开始（第 0 帧对应 10 秒）", () => {
    const part = voice.slice(10 * SR);
    const rec = envelopeOf(shifted(part, 0.05), SR);
    const r = estimateLag(rec, 10, ref, { from: 10, to: 30 })!;
    expect(Math.abs(r.shift + 0.05)).toBeLessThan(0.01);
  });

  it("太短返回 null", () => {
    expect(estimateLag(ref.slice(0, 100), 0, ref, { from: 0, to: 1 })).toBeNull();
  });
});

describe("measureRoundTrip", () => {
  function clickTrack(latency: number, jitter: number, missing: number[] = []) {
    const t0 = 0;
    const clicks = Array.from({ length: 8 }, (_, i) => 1 + i * 0.75);
    const out = new Float32Array(8 * SR);
    let rnd = 3;
    for (let i = 0; i < out.length; i++) out[i] = 0.002 * ((((rnd = (rnd * 16807) % 2147483647) / 2147483647)) - 0.5);
    clicks.forEach((c, i) => {
      if (missing.includes(i)) return;
      const j = jitter * Math.sin(i * 2.1);
      const s0 = Math.round((c + latency + j) * SR);
      for (let k = 0; k < 0.08 * SR; k++) out[s0 + k] += 0.4 * Math.exp(-k / (0.02 * SR)) * Math.sin((2 * Math.PI * 900 * k) / SR);
    });
    return { samples: out, t0, clicks };
  }

  it("有线耳机 30ms", () => {
    const { samples, t0, clicks } = clickTrack(0.03, 0.003);
    expect(Math.abs(measureRoundTrip(samples, SR, t0, clicks)! - 30)).toBeLessThan(6);
  });

  it("AirPods 200ms，有一拍没跟上", () => {
    const { samples, t0, clicks } = clickTrack(0.2, 0.004, [4]);
    expect(Math.abs(measureRoundTrip(samples, SR, t0, clicks)! - 200)).toBeLessThan(6);
  });

  it("全程没出声返回 null", () => {
    const { samples, t0, clicks } = clickTrack(0.1, 0, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(measureRoundTrip(samples, SR, t0, clicks)).toBeNull();
  });
});
