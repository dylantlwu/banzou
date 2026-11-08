import { describe, expect, it } from "vitest";
import { findLineIndex, formatLrcTime, hasTimedLines, parseLrc, serializeLrc } from "./lrc";

// 测试用的歌词都是编的
describe("parseLrc", () => {
  it("解析基本时间标签和元数据", () => {
    const doc = parseLrc("[ti:测试歌]\n[ar:某人]\n[00:01.50]第一句\n[00:04.20]第二句");
    expect(doc.meta).toEqual({ ti: "测试歌", ar: "某人" });
    expect(doc.lines).toEqual([
      { time: 1.5, text: "第一句" },
      { time: 4.2, text: "第二句" },
    ]);
  });

  it("支持两位、三位毫秒和无毫秒", () => {
    const doc = parseLrc("[00:01]a\n[00:02.5]b\n[00:03.25]c\n[00:04.125]d\n[01:05:30]e");
    expect(doc.lines.map((l) => l.time)).toEqual([1, 2.5, 3.25, 4.125, 65.3]);
  });

  it("一行多个时间标签展开成多行并排序", () => {
    const doc = parseLrc("[00:10.00][00:30.00]副歌\n[00:20.00]主歌");
    expect(doc.lines).toEqual([
      { time: 10, text: "副歌" },
      { time: 20, text: "主歌" },
      { time: 30, text: "副歌" },
    ]);
  });

  it("空文字的时间行是间奏，空行被忽略", () => {
    const doc = parseLrc("[00:01.00]a\n\n   \n[00:05.00]\n[00:09.00]b");
    expect(doc.lines).toEqual([
      { time: 1, text: "a" },
      { time: 5, text: "" },
      { time: 9, text: "b" },
    ]);
  });

  it("读取 offset，非法值当 0", () => {
    expect(parseLrc("[offset:-250]").offsetMs).toBe(-250);
    expect(parseLrc("[offset:+120]").offsetMs).toBe(120);
    expect(parseLrc("[offset:abc]").offsetMs).toBe(0);
  });

  it("没有时间标签的文字行保留为未打轴，排在最后", () => {
    const doc = parseLrc("还没打的一句\n[00:02.00]已打的\n另一句");
    expect(doc.lines).toEqual([
      { time: 2, text: "已打的" },
      { time: null, text: "还没打的一句" },
      { time: null, text: "另一句" },
    ]);
  });

  it("兼容 BOM 和 Windows 换行", () => {
    const doc = parseLrc("﻿[ti:x]\r\n[00:01.00]a\r\n");
    expect(doc.meta.ti).toBe("x");
    expect(doc.lines).toHaveLength(1);
  });
});

describe("serializeLrc", () => {
  it("格式化时间，处理进位", () => {
    expect(formatLrcTime(0)).toBe("00:00.00");
    expect(formatLrcTime(65.304)).toBe("01:05.30");
    expect(formatLrcTime(59.999)).toBe("01:00.00");
    expect(formatLrcTime(-1)).toBe("00:00.00");
  });

  it("生成后再解析结果一致", () => {
    const text = "[ti:测试歌]\n[ar:某人]\n[offset:150]\n[00:01.50]第一句\n[00:05.00]\n[00:09.25]第二句\n没打的\n";
    const doc = parseLrc(text);
    expect(serializeLrc(doc)).toBe(text);
    expect(parseLrc(serializeLrc(doc))).toEqual(doc);
  });

  it("offset 为 0 时不写", () => {
    expect(serializeLrc({ meta: {}, offsetMs: 0, lines: [{ time: 1, text: "a" }] })).toBe("[00:01.00]a\n");
  });
});

describe("findLineIndex", () => {
  const doc = parseLrc("[00:02.00]a\n[00:05.00]b\n[00:09.00]c\n没打的");

  it("找到当前行", () => {
    expect(findLineIndex(doc, 0)).toBe(-1);
    expect(findLineIndex(doc, 2)).toBe(0);
    expect(findLineIndex(doc, 4.99)).toBe(0);
    expect(findLineIndex(doc, 5)).toBe(1);
    expect(findLineIndex(doc, 100)).toBe(2);
  });

  it("offset 正数让歌词提前", () => {
    const shifted = { ...doc, offsetMs: 500 };
    expect(findLineIndex(shifted, 4.6)).toBe(1);
    expect(findLineIndex({ ...doc, offsetMs: -500 }, 5.2)).toBe(0);
  });

  it("空文档", () => {
    expect(findLineIndex(parseLrc(""), 10)).toBe(-1);
    expect(hasTimedLines(parseLrc("只有文字"))).toBe(false);
    expect(hasTimedLines(doc)).toBe(true);
  });
});
