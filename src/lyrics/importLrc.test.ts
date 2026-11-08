import { describe, expect, it } from "vitest";
import { decodeLyricsBytes, importLrc, looksLikeLrc } from "./importLrc";

describe("decodeLyricsBytes", () => {
  it("UTF-8", () => {
    expect(decodeLyricsBytes(new TextEncoder().encode("[00:01.00]月光"))).toBe("[00:01.00]月光");
  });

  it("GBK", () => {
    // 「月光」的 GBK 编码
    const bytes = new Uint8Array([0x5b, 0x5d, 0xd4, 0xc2, 0xb9, 0xe2]);
    expect(decodeLyricsBytes(bytes)).toBe("[]月光");
  });

  it("UTF-16LE 带 BOM", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x08, 0x67, 0x49, 0x51]);
    expect(decodeLyricsBytes(bytes)).toBe("月光");
  });
});

describe("importLrc", () => {
  it("去掉逐字时间、保留多时间标签", () => {
    const doc = importLrc("[ti:月光]\n[00:10.00][01:10.00]<00:10.00>大<00:10.50>河\n[00:20.000]向东流");
    expect(doc.meta.ti).toBe("月光");
    expect(doc.lines).toEqual([
      { time: 10, text: "大河" },
      { time: 20, text: "向东流" },
      { time: 70, text: "大河" },
    ]);
  });

  it("offset 折算进时间", () => {
    const doc = importLrc("[offset:500]\n[00:10.00]第一句\n[00:00.20]开头");
    expect(doc.offsetMs).toBe(0);
    expect(doc.lines).toEqual([
      { time: 0, text: "开头" },
      { time: 9.5, text: "第一句" },
    ]);
  });

  it("去掉开头的空时间行", () => {
    const doc = importLrc("[00:00.00]\n[00:05.00]第一句\n[00:30.00]\n[00:35.00]第二句");
    expect(doc.lines.map((l) => l.text)).toEqual(["第一句", "", "第二句"]);
  });

  it("looksLikeLrc", () => {
    expect(looksLikeLrc("[00:01.00]a")).toBe(true);
    expect(looksLikeLrc("普通歌词\n第二行")).toBe(false);
  });
});
