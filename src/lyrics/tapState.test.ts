import { describe, expect, it } from "vitest";
import { parseLrc } from "./lrc";
import {
  fromDoc,
  fromText,
  insertBreak,
  nudge,
  progress,
  select,
  setCursor,
  setTime,
  tap,
  tapTime,
  toDoc,
  toText,
  undo,
} from "./tapState";

const TEXT = "第一句\n\n  第二句  \n第三句\n";

describe("打轴状态", () => {
  it("从文本生成，去掉空行和首尾空格", () => {
    const s = fromText(TEXT);
    expect(s.lines.map((l) => l.text)).toEqual(["第一句", "第二句", "第三句"]);
    expect(s.cursor).toBe(0);
    expect(progress(s)).toEqual({ done: 0, total: 3 });
  });

  it("按空格依次打轴，打完后再按无效", () => {
    let s = fromText(TEXT);
    s = tap(s, 1);
    s = tap(s, 2);
    expect(s.cursor).toBe(2);
    expect(s.selected).toBe(1);
    s = tap(s, 3);
    expect(s.cursor).toBe(3);
    expect(tap(s, 4)).toBe(s);
    expect(progress(s)).toEqual({ done: 3, total: 3 });
  });

  it("撤销清掉上一句的时间", () => {
    let s = tap(tap(fromText(TEXT), 1), 2);
    s = undo(s);
    expect(s.cursor).toBe(1);
    expect(s.lines[1].time).toBeNull();
    expect(s.lines[0].time).toBe(1);
    expect(s.selected).toBe(0);
    s = undo(undo(s));
    expect(s.cursor).toBe(0);
    expect(s.selected).toBeNull();
  });

  it("间奏标记插在当前位置，撤销时整条删掉", () => {
    let s = tap(fromText(TEXT), 1);
    s = insertBreak(s, 5);
    expect(s.lines.map((l) => l.text)).toEqual(["第一句", "", "第二句", "第三句"]);
    expect(s.cursor).toBe(2);
    expect(progress(s).total).toBe(3);
    s = undo(s);
    expect(s.lines).toHaveLength(3);
    expect(s.cursor).toBe(1);
  });

  it("微调选中行，未打轴或未选中时不变", () => {
    let s = tap(fromText(TEXT), 1);
    s = nudge(s, 0.05);
    expect(s.lines[0].time).toBeCloseTo(1.05);
    s = nudge(nudge(s, -0.05), -0.05);
    expect(s.lines[0].time).toBeCloseTo(0.95);
    expect(nudge(select(s, 2), 0.05).lines[2].time).toBeNull();
    expect(nudge(select(s, null), 0.05)).toEqual(select(s, null));
    expect(setTime(s, 0, -3).lines[0].time).toBe(0);
  });

  it("从任意一行重新开始打", () => {
    let s = tap(tap(tap(fromText(TEXT), 1), 2), 3);
    s = setCursor(s, 1);
    s = tap(s, 2.5);
    expect(s.lines.map((l) => l.time)).toEqual([1, 2.5, 3]);
    expect(setCursor(s, 99).cursor).toBe(3);
  });

  it("修改文本时保留没变的行的时间", () => {
    const s = tap(tap(fromText(TEXT), 1), 2);
    const edited = fromText("第一句\n改过的第二句\n第三句", s.lines);
    expect(edited.lines.map((l) => l.time)).toEqual([1, null, null]);
    expect(edited.cursor).toBe(1);
  });

  it("和 LRC 文档互转，未打完的行保留", () => {
    const doc = parseLrc("[ti:x]\n[offset:100]\n[00:01.00]第一句\n第二句");
    const s = fromDoc(doc);
    expect(s.cursor).toBe(1);
    expect(toText(s)).toBe("第一句\n第二句");
    const back = toDoc(tap(s, 3), doc);
    expect(back.meta).toEqual({ ti: "x" });
    expect(back.offsetMs).toBe(100);
    expect(back.lines).toEqual([
      { time: 1, text: "第一句" },
      { time: 3, text: "第二句" },
    ]);
  });
});

describe("tapTime 扣除延迟", () => {
  it("扣掉耳机延迟和反应时间", () => {
    expect(tapTime(10, 1, 200, 100)).toBeCloseTo(9.7);
  });
  it("放慢播放时按歌曲时间换算", () => {
    expect(tapTime(10, 0.5, 200, 100)).toBeCloseTo(9.85);
  });
  it("不会小于 0", () => {
    expect(tapTime(0.1, 1, 200, 100)).toBe(0);
  });
});
