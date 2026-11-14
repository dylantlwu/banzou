import { describe, expect, it } from "vitest";
import { parseMarked, plainMarked } from "./marked";

const w = (orig: string, reading: string | null) => ({ orig, reading });

describe("原文{读音}", () => {
  it("嵌在中文句子里", () => {
    expect(parseMarked("这首歌叫 夏実{かじつ}，很好听")).toEqual(["这首歌叫 ", w("夏実", "かじつ"), "，很好听"]);
  });

  it("一句里好几个", () => {
    expect(parseMarked("「夏実{かじつ}」和 花火{はなび} 、心{こころ}")).toEqual(["「", w("夏実", "かじつ"), "」和 ", w("花火", "はなび"), " 、", w("心", "こころ")]);
    expect(parseMarked("夏実{かじつ}の 花火{はなび}")).toEqual([w("夏実", "かじつ"), "の ", w("花火", "はなび")]);
  });

  it("原文前头的平假名留在外面", () => {
    expect(parseMarked("夏実{かじつ}の花火{はなび}")).toEqual([w("夏実", "かじつ"), "の", w("花火", "はなび")]);
    expect(parseMarked("君{きみ}を呼{よ}ぶ")).toEqual([w("君", "きみ"), "を", w("呼", "よ"), "ぶ"]);
    expect(parseMarked("この花火{このはなび}")).toEqual([w("この花火", "このはなび")]);
    expect(parseMarked("きみ{きみ}")).toEqual([w("きみ", "きみ")]);
  });

  it("{?} 是待确认", () => {
    expect(parseMarked("美月{?} 读音待确认")).toEqual([w("美月", null), " 读音待确认"]);
    expect(parseMarked("美月{？}")).toEqual([w("美月", null)]);
  });

  it("没有花括号的旧文字原样", () => {
    expect(parseMarked("「夏実」念 かじつ（Kajitsu）")).toEqual(["「夏実」念 かじつ（Kajitsu）"]);
    expect(parseMarked("")).toEqual([]);
    expect(parseMarked("没有闭合 {かじつ")).toEqual(["没有闭合 {かじつ"]);
    expect(parseMarked("空的 夏実{} 照旧")).toEqual(["空的 夏実 照旧"]);
    // 前面没原文：只留读音，看不到花括号
    expect(parseMarked("念 {かじつ}")).toEqual(["念 かじつ"]);
  });

  it("纯文字版", () => {
    expect(plainMarked("叫 夏実{かじつ}，美月{?}")).toBe("叫 夏実（かじつ），美月（读音待确认）");
  });
});
