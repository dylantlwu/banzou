import { describe, expect, it } from "vitest";
import { encodeWav, fromBase64, nextOpen, progress, splitMistake, type TakeRecord, type TestItem, toBase64 } from "./testset";

const items: TestItem[] = [
  { id: "ask-01", kind: "ask", text: "a" },
  { id: "read-01", kind: "read", text: "b" },
  { id: "sing-01", kind: "sing", text: "c" },
];
const rec = (status: TakeRecord["status"], seconds = 0): TakeRecord => ({ status, seconds, takes: 1, at: 0 });

describe("测试集", () => {
  it("接着上次：跳过录好的和跳过的", () => {
    expect(nextOpen(items, {}, 0)).toBe(0);
    expect(nextOpen(items, { "ask-01": rec("done") }, 0)).toBe(1);
    expect(nextOpen(items, { "read-01": rec("skipped") }, 1)).toBe(2);
    // 从最后往后找会绕回开头
    expect(nextOpen(items, { "sing-01": rec("done") }, 2)).toBe(0);
    // 全部处理过了就停在原地
    const all = { "ask-01": rec("done"), "read-01": rec("done"), "sing-01": rec("skipped") };
    expect(nextOpen(items, all, 1)).toBe(1);
    expect(progress(items, { "ask-01": rec("done", 2.5), "read-01": rec("skipped") })).toEqual({ done: 1, skipped: 1, left: 1, seconds: 2.5 });
  });

  it("标出故意念错的部分", () => {
    const m = { word: "一月", correct: "いちがつ", wrong: "いちげつ" };
    expect(splitMistake("らいねんの いちげつに いく", m)).toEqual(["らいねんの ", "いちげつ", "に いく"]);
    expect(splitMistake("きょうは はれ", undefined)).toEqual(["きょうは はれ", "", ""]);
  });

  it("wav：头 44 字节、16 位、削掉超过 ±1 的", () => {
    const wav = encodeWav([new Float32Array([0, 0.5]), new Float32Array([-1, 2])], 48000);
    expect(wav.length).toBe(44 + 8);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(40, true)).toBe(8);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)]).toEqual([0, 16383, -32768, 32767]);
    expect(fromBase64(toBase64(wav))).toEqual(wav);
  });
});
