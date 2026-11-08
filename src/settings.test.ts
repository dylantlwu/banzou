import { expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "./settings";

it("缺省值、非法值和超范围值被规整", () => {
  expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  expect(normalizeSettings({ outputLatencyMs: "200" })).toEqual(DEFAULT_SETTINGS);
  expect(normalizeSettings({ outputLatencyMs: 9999, reactionMs: -5, vocalGuideVolume: 0.3 })).toEqual({
    ...DEFAULT_SETTINGS,
    outputLatencyMs: 600,
    reactionMs: 0,
    vocalGuideVolume: 0.3,
  });
});

it("直播样式字段", () => {
  expect(
    normalizeSettings({ liveEnabled: true, liveColor: "#FFE066", livePosition: "top", liveFontSize: 999, liveShowNext: false }),
  ).toEqual({ ...DEFAULT_SETTINGS, liveEnabled: true, liveColor: "#FFE066", livePosition: "top", liveFontSize: 140, liveShowNext: false });
  expect(normalizeSettings({ liveColor: "red", livePosition: "left" })).toEqual(DEFAULT_SETTINGS);
});

it("录音延迟按设备记住，非法值丢掉", () => {
  expect(normalizeSettings({ recordLatency: { AirPods: 231.4, 有线: -5, 坏: "x" } }).recordLatency).toEqual({ AirPods: 231, 有线: 0 });
});
