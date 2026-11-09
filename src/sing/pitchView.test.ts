import { describe, expect, it } from "vitest";
import { bufferPitch, foldNear, refAt, refDistance, viewRange } from "./pitchView";

const ref = (values: number[], hop = 0.01) => ({ midi: Float64Array.from(values), hop });

describe("音高窗口", () => {
  it("找附近的原唱音高", () => {
    const r = ref([NaN, NaN, 60, 60, NaN, NaN, NaN, 64]);
    expect(refAt(r, 0.03)).toBe(60);
    expect(refAt(r, 0.0, 0.01)).toBeNaN();
    expect(refAt(r, 0.06)).toBe(64);
  });

  it("折到最近的八度", () => {
    expect(foldNear(48.3, 60)).toBeCloseTo(60.3);
    expect(foldNear(73, 62)).toBe(61);
    expect(foldNear(66, 60)).toBe(66);
  });

  it("音准只看音高，前后 0.1 秒内对上就算准", () => {
    const r = ref(Array.from({ length: 100 }, (_, i) => (i < 50 ? 60 : 64)));
    expect(refDistance(r, 0.52, 60)).toBe(0); // 晚了 20ms 还唱着上一个音
    expect(refDistance(r, 0.8, 60)).toBe(4);
    expect(refDistance(r, 0.8, 52.2)).toBeCloseTo(0.2); // 低八度
    expect(refDistance(ref([NaN, NaN]), 0, 60)).toBeNaN();
  });

  it("显示范围按原唱音域，至少 14 个半音", () => {
    const r = ref(Array.from({ length: 200 }, (_, i) => 60 + (i % 5)));
    const v = viewRange(r, 0, 2)!;
    expect(v.hi - v.lo).toBeGreaterThanOrEqual(14);
    expect(v.lo).toBeLessThan(60);
    expect(v.hi).toBeGreaterThan(64);
    expect(viewRange(ref([NaN, NaN, NaN]), 0, 1)).toBeNull();
    // 屏幕上的高音即使是离群点也要放得下
    const spike = ref(Array.from({ length: 200 }, (_, i) => (i === 100 ? 80 : 60)));
    expect(viewRange(spike, 0, 2)!.hi).toBeLessThan(70);
    expect(viewRange(spike, 0, 2, [0.9, 1.1])!.hi).toBeGreaterThanOrEqual(81.5);
  });

  it("从一段麦克风采样里测出音高", () => {
    const sr = 48000;
    const buf = new Float32Array(2048);
    const hz = 220;
    for (let i = 0; i < buf.length; i++) buf[i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / sr) + 0.1 * Math.sin((4 * Math.PI * hz * i) / sr);
    expect(bufferPitch(buf, sr)).toBeCloseTo(57, 0);
    expect(bufferPitch(new Float32Array(2048), sr)).toBeNaN();
  });
});
