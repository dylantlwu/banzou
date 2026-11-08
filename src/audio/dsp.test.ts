import { describe, expect, it } from "vitest";
import { estimateLatencyMs } from "./calibration";
import { computePeaks } from "./peaks";

describe("computePeaks", () => {
  it("每个桶取多声道的最大绝对值", () => {
    const left = new Float32Array([0.1, -0.5, 0.2, 0.0, 0.3, -0.1]);
    const right = new Float32Array([0.0, 0.2, 0.9, 0.0, 0.0, 0.0]);
    const p = computePeaks([left, right], 6, 2);
    expect(Array.from(p.values).map((v) => +v.toFixed(2))).toEqual([0.9, 0.3]);
    expect(p.perSecond).toBe(2);
  });

  it("不能整除时最后一个桶也算", () => {
    expect(computePeaks([new Float32Array(7).fill(0.5)], 6, 2).values).toHaveLength(3);
  });

  it("空数据", () => {
    expect(computePeaks([], 44100).values).toHaveLength(0);
  });
});

describe("estimateLatencyMs", () => {
  const clicks = Array.from({ length: 10 }, (_, i) => 1 + i * 0.75);
  const jitter = [0.012, -0.008, 0.005, -0.015, 0.01, 0, -0.004, 0.009, -0.011, 0.006];

  it.each([30, 180, 250, 400])("测出 %ims 延迟，误差 < 10ms", (ms) => {
    const taps = clicks.map((c, i) => c + ms / 1000 + jitter[i]);
    expect(Math.abs(estimateLatencyMs(clicks, taps)! - ms)).toBeLessThan(10);
  });

  it("漏按几拍、多按一次也能算出来", () => {
    const taps = clicks.map((c) => c + 0.2).filter((_, i) => i !== 4 && i !== 7);
    taps.push(taps[3] + 0.05); // 同一拍按了两次，只算第一次
    expect(estimateLatencyMs(clicks, taps)).toBe(200);
  });

  it("前两拍不计入，有效按键太少返回 null", () => {
    expect(estimateLatencyMs(clicks, clicks.slice(0, 5).map((c) => c + 0.1))).toBeNull();
    expect(estimateLatencyMs(clicks, [])).toBeNull();
  });

  it("抢拍时结果不小于 0", () => {
    expect(estimateLatencyMs(clicks, clicks.map((c) => c - 0.05))).toBe(0);
  });
});
