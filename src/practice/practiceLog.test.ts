import { describe, expect, it } from "vitest";
import { dayKey, emptyLog, recentDays, record, streak, trend } from "./practiceLog";

describe("练声记录", () => {
  it("同一天同一项保留更好的成绩，分钟累加", () => {
    let log = record(emptyLog(), "scale", { at: "", accuracy: 0.6 }, 2, "2026-11-08");
    log = record(log, "scale", { at: "", accuracy: 0.5 }, 2, "2026-11-08");
    expect(log.days["2026-11-08"].results.scale!.accuracy).toBe(0.6);
    log = record(log, "breath", { at: "", breathSec: 20 }, 1, "2026-11-08");
    log = record(log, "breath", { at: "", breathSec: 25 }, 1, "2026-11-08");
    expect(log.days["2026-11-08"].results.breath!.breathSec).toBe(25);
    expect(log.days["2026-11-08"].minutes).toBe(6);
  });

  it("连续天数、最近 30 天、趋势", () => {
    const today = new Date(2026, 10, 8);
    let log = emptyLog();
    for (const d of [8, 7, 6, 4]) log = record(log, "hum", { at: "", accuracy: d / 10 }, 1, dayKey(new Date(2026, 10, d)));
    expect(streak(log, today)).toBe(3);
    expect(streak(log, new Date(2026, 10, 9))).toBe(3); // 今天还没练，昨天练了
    expect(streak(log, new Date(2026, 10, 10))).toBe(0);
    const days = recentDays(log, 5, today);
    expect(days.map((d) => d.count)).toEqual([1, 0, 1, 1, 1]);
    expect(trend(log, "hum", "accuracy", 3, today)).toEqual([0.6, 0.7, 0.8]);
  });
});
