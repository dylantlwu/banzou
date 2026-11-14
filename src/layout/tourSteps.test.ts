import { expect, it } from "vitest";
import { placeCard, spotBox, tourSteps } from "./tourSteps";

const view = { w: 1024, h: 680 };
const card = { w: 300, h: 160 };

it("有歌时 8 步；没文件夹 / 空曲库不指着空列表，只剩 3 步", () => {
  expect(tourSteps("full").map((s) => s.id)).toEqual(["lib", "plus", "lyrics", "bar", "modes", "learn", "tv", "settings"]);
  expect(tourSteps("nolib")[0].target).toBe(".welcome .primary");
  expect(tourSteps("empty")[0].target).toBe(".lib-head .plus");
  expect(tourSteps("empty").some((s) => s.target === ".lib")).toBe(false);
  expect(tourSteps("nolib")).toHaveLength(3);
});

it("学唱的说明不提还没做的功能", () => {
  const all = [...tourSteps("full"), ...tourSteps("empty"), ...tourSteps("nolib")].map((s) => s.title + s.text).join("");
  for (const word of ["语音提问", "按住说话", "念得对不对", "打分", "点评"]) expect(all).not.toContain(word);
});

it("框比元素大一圈，但不出窗口", () => {
  expect(spotBox({ left: 0, top: 0, width: 64, height: 680 }, view)).toEqual({ left: 2, top: 2, width: 68, height: 676 });
  expect(spotBox({ left: 100, top: 100, width: 30, height: 30 }, view)).toEqual({ left: 94, top: 94, width: 42, height: 42 });
});

it("卡片放在放得下的一边，永远在窗口里", () => {
  // 小按钮在上面：放下面
  expect(placeCard({ left: 200, top: 10, width: 30, height: 30 }, card, view).side).toBe("below");
  // 播放栏在最下面、横满：放上面
  expect(placeCard({ left: 300, top: 580, width: 720, height: 96 }, card, view).side).toBe("above");
  // 曲库栏竖满左边：放右边
  const lib = placeCard({ left: 62, top: 2, width: 280, height: 676 }, card, view);
  expect(lib.side).toBe("right");
  expect(lib.left).toBe(62 + 280 + 14);
  // 左栏最下面的设置：放右边或上面，都不出窗口
  const s = placeCard({ left: 4, top: 600, width: 56, height: 50 }, card, view);
  expect(s.top + card.h).toBeLessThanOrEqual(view.h - 12);
  expect(s.left).toBeGreaterThanOrEqual(12);
  // 框太大哪边都放不下：放在框里靠下
  const big = placeCard({ left: 0, top: 0, width: 1024, height: 680 }, card, view);
  expect(big.side).toBe("inside");
  expect(big.top + card.h).toBeLessThanOrEqual(view.h - 12);
  // 没有目标：窗口正中
  expect(placeCard(null, card, view)).toEqual({ left: 362, top: 260, side: "center" });
});

it("窗口很窄时卡片也不出左右边", () => {
  const narrow = { w: 320, h: 500 };
  const p = placeCard({ left: 250, top: 20, width: 60, height: 30 }, { w: 296, h: 150 }, narrow);
  expect(p.left).toBeGreaterThanOrEqual(12);
  expect(p.left + 296).toBeLessThanOrEqual(narrow.w - 12 + 0.001);
});
