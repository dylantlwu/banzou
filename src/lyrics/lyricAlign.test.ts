import { describe, expect, it } from "vitest";
import type { LrcLine } from "./lrc";
import { type Token, alignSequences, alignToTranscript, isCreditText, normalizeUnit, splitUnits } from "./lyricAlign";

/** 按字生成识别结果：从 start 开始每字 0.3 秒 */
function sing(text: string, start: number, perChar = 0.3): Token[] {
  return splitUnits(text).map((u, i) => ({ start: start + i * perChar, end: start + (i + 1) * perChar, text: u }));
}

const line = (text: string, time: number | null): LrcLine => ({ text, time });

describe("拆字与归一", () => {
  it("汉字逐字、英文按词", () => {
    expect(splitUnits("So 我的月亮?")).toEqual(["So", "我", "的", "月", "亮"]);
  });
  it("繁简、他她、的地得统一", () => {
    expect(normalizeUnit("麽")).toBe("么");
    expect(normalizeUnit("她")).toBe("他");
    expect(normalizeUnit("得")).toBe("的");
    expect(normalizeUnit("Baby")).toBe("baby");
  });
  it("信息行", () => {
    expect(isCreditText("词 : Lumi/某某")).toBe(true);
    expect(isCreditText("作曲：张三")).toBe(true);
    expect(isCreditText("张三 - 月光")).toBe(true);
    expect(isCreditText("风吹过 窗外的晚霞")).toBe(false);
  });
  it("序列比对允许错字和多字", () => {
    const pairs = alignSequences(["a", "b", "c", "d"], ["x", "a", "b", "z", "d", "y"]);
    expect(pairs.filter((p) => p.equal).map((p) => [p.lyric, p.heard])).toEqual([
      [0, 1],
      [1, 2],
      [3, 4],
    ]);
  });
});

describe("alignToTranscript", () => {
  it("LRC 时间整体偏了：按识别结果改正，信息行不动", () => {
    const lines = [line("作词：某人", 0), line("风吹过窗外的晚霞", 16.68), line("我数着路灯慢慢回家", 22.71), line("慢一点吧", 26.43)];
    const tokens = [...sing("风吹过窗外的晚霞", 18.2), ...sing("我数着路灯慢慢回家", 24.8), ...sing("慢一点吧", 28.2)];
    const res = alignToTranscript(lines, tokens)!;
    expect(res.lines.map((l) => l.time)).toEqual([0, 18.2, 24.8, 28.2]);
    expect(res.aligned).toBe(3);
    expect(res.sung).toBe(3);
  });

  it("有错字、漏字、即兴也能对上，繁体歌词也行", () => {
    const lines = [line("不知道該跟你說些什麽", 10), line("寫了這首歌送給你", 15)];
    const tokens = [
      ...sing("嗯嗯", 0),
      ...sing("不知道该跟你说些什么", 12), // 简体
      ...sing("写了这首个送给你", 18), // 「歌」听成「个」
    ];
    const res = alignToTranscript(lines, tokens)!;
    expect(res.lines.map((l) => l.time)).toEqual([12, 18]);
  });

  it("句首字被拉长（吞了前面的停顿）时用开口点定位", () => {
    const lines = [line("我不想要", 20), line("听了一千年", 24)];
    const tokens: Token[] = [
      ...sing("我不想要", 19.4),
      { start: 20.6, end: 24.9, text: "听" },
      ...sing("了一千年", 24.9),
    ];
    const onsets = [
      { time: 19.4, strength: 1, quiet: 1 },
      { time: 24.55, strength: 0.9, quiet: 1.5 },
    ];
    const res = alignToTranscript(lines, tokens, onsets)!;
    expect(res.lines[1].time).toBe(24.55);
  });

  it("没对上的句子按原 LRC 的时间比例插值", () => {
    const lines = [line("第一句歌词在这里", 10), line("完全听不清的一句", 14), line("第三句歌词在这里", 20)];
    const tokens = [...sing("第一句歌词在这里", 11), ...sing("乱七八糟", 15), ...sing("第三句歌词在这里", 23)];
    const res = alignToTranscript(lines, tokens)!;
    expect(res.lines[0].time).toBe(11);
    expect(res.lines[2].time).toBe(23);
    expect(res.lines[1].time).toBeCloseTo(11 + 0.4 * 12, 1);
  });

  it("纯文本歌词：直接定出时间（自动打轴），头尾没对上的往外推", () => {
    const lines = [line("听不清的开头", null), line("第二句歌词", null), line("第三句歌词", null)];
    const tokens = [...sing("第二句歌词", 10), ...sing("第三句歌词", 14)];
    const res = alignToTranscript(lines, tokens)!;
    expect(res.lines[1].time).toBe(10);
    expect(res.lines[2].time).toBe(14);
    expect(res.lines[0].time).toBeCloseTo(10 - 6 * 0.35, 2);
  });

  it("找出错字和漏句", () => {
    const lines = [line("脆弱的心被你一击就碎", 10), line("能不能再给个机会", 20)];
    const tokens = [
      ...sing("脆弱的心被你一击就醉", 10),
      ...sing("歌词里没有的这一句话", 14),
      ...sing("能不能再给个机会", 20),
    ];
    const res = alignToTranscript(lines, tokens)!;
    expect(res.suggestions).toContainEqual(expect.objectContaining({ kind: "fix", line: 0, heard: "脆弱的心被你一击就醉" }));
    expect(res.suggestions).toContainEqual(expect.objectContaining({ kind: "missing", line: 1, heard: "歌词里没有的这一句话", time: 14 }));
  });

  it("一句都对不上返回 null", () => {
    expect(alignToTranscript([line("完全不同的歌词", 1)], sing("毫无关系", 1))).toBeNull();
    expect(alignToTranscript([line("歌词", 1)], [])).toBeNull();
  });
});
