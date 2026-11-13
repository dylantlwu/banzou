import { afterEach, expect, it, vi } from "vitest";
import { dragSize, loadSizes } from "./split";

it("拖分界线：在目标块后面往右 / 下变大，在前面相反", () => {
  expect(dragSize(250, 40, "prev", 180, 500)).toBe(290);
  expect(dragSize(250, 40, "next", 180, 500)).toBe(210);
});

it("拖到底就停住：不小于最小、不大于最大", () => {
  expect(dragSize(250, -500, "prev", 180, 500)).toBe(180);
  expect(dragSize(250, 900, "prev", 180, 500)).toBe(500);
  // 父元素太小、最大比最小还小时按最小
  expect(dragSize(250, 10, "prev", 180, 100)).toBe(180);
});

afterEach(() => vi.unstubAllGlobals());

it("读存档：只要正数，坏数据不出错", () => {
  const store: Record<string, string> = { "banzou.layoutSizes.v1": JSON.stringify({ "lib-w": 301.6, "pitch-h": -3, "takes-w": "x" }) };
  vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: () => {} });
  expect(loadSizes()).toEqual({ "lib-w": 302 });
  store["banzou.layoutSizes.v1"] = "{坏的";
  expect(loadSizes()).toEqual({});
});

it("没有 localStorage（隐私模式等）也不出错", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
  });
  expect(loadSizes()).toEqual({});
});
