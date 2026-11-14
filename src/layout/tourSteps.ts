/**
 * 第一次使用的导航（PRD 4.0.1）：步骤、和说明卡片放在哪。
 * 每一步用 CSS 选择器找真实的界面元素，框按它当前的位置画，所以拖过分界线、窗口变窄都不会指歪。
 */
export interface TourStep {
  id: string;
  /** 要框住的元素；null = 说明放在窗口中间 */
  target: string | null;
  title: string;
  text: string;
  /** 这一步要先准备好界面：lib = 曲库栏开着；song = 选上一首歌、在唱歌模式 */
  needs?: "lib" | "song";
}

export type TourKind = "full" | "nolib" | "empty";

const STEPS: Record<string, TourStep> = {
  lib: { id: "lib", target: ".lib", needs: "lib", title: "你的歌都在这", text: "后面五颗小珠子是伴奏、人声、歌词、原曲、录音，实心就是有。上面的牌子按语种、歌单筛。" },
  plus: { id: "plus", target: ".lib-head .plus", needs: "lib", title: "加歌", text: "点「＋」粘贴 YouTube 链接下载视频，再「做成伴奏」，伴奏和人声就分开了。" },
  lyrics: { id: "lyrics", target: ".lyrics-area .lyrics-col", needs: "song", title: "唱歌", text: "歌词跟着播放走，点哪一句就跳到哪。右上角是全屏和音高窗口。" },
  bar: { id: "bar", target: ".tbar", needs: "song", title: "播放栏", text: "「人声 带唱」开关原唱；喇叭是总音量；「声音 ▾」里伴奏、人声分开调，还能升降调。" },
  modes: { id: "modes", target: ".mode-seg", needs: "song", title: "录音和修音", text: "切到「录音」录几遍，挑最好的；「修音」选一遍，把音准修好再导出。" },
  learn: { id: "learn", target: '.mode-seg [data-mode="learn"]', needs: "song", title: "学唱外语歌", text: "一句一句放慢听，看不懂就打字问老师。这块还在做，会越来越好用。" },
  tv: { id: "tv", target: '.rail [data-place="tv"]', title: "电视 KTV", text: "把歌传到电视上的「波点」，像 KTV 一样唱。" },
  settings: {
    id: "settings",
    target: '.rail [data-place="settings"]',
    title: "设置，还有能拉的边",
    text: "耳机延迟、AI 老师在设置里。区块之间的线都能拖，双击恢复原样。这个导航也能在设置 → 关于里再看一次。",
  },
  nolib: { id: "nolib", target: ".welcome .primary", title: "先选个文件夹", text: "选一个放歌的文件夹。伴奏、人声、歌词放在里面，就会自动配成一首歌。" },
  empty: { id: "empty", target: ".lib-head .plus", needs: "lib", title: "曲库还是空的", text: "点「＋」粘贴一条 YouTube 链接，下载后「做成伴奏」，就有第一首歌了。" },
  emptySettings: {
    id: "settings",
    target: '.rail [data-place="settings"]',
    title: "设置，还有能拉的边",
    text: "耳机延迟、AI 老师在设置里。区块之间的线都能拖。加了歌以后，在设置 → 关于里能再看完整的导航。",
  },
};

export function tourSteps(kind: TourKind): TourStep[] {
  if (kind === "nolib") return [STEPS.nolib, STEPS.tv, STEPS.emptySettings];
  if (kind === "empty") return [STEPS.empty, STEPS.tv, STEPS.emptySettings];
  return [STEPS.lib, STEPS.plus, STEPS.lyrics, STEPS.bar, STEPS.modes, STEPS.learn, STEPS.tv, STEPS.settings];
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 框比元素大一圈，但不出窗口 */
export function spotBox(r: Box, view: { w: number; h: number }, pad = 6): Box {
  const left = Math.max(2, r.left - pad);
  const top = Math.max(2, r.top - pad);
  const right = Math.min(view.w - 2, r.left + r.width + pad);
  const bottom = Math.min(view.h - 2, r.top + r.height + pad);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * 说明卡片放哪：框的下面、上面、右边、左边，哪边放得下放哪边；都放不下（框太大）就放在框里靠下的地方。
 * 一定在窗口里。
 */
export function placeCard(spot: Box | null, card: { w: number; h: number }, view: { w: number; h: number }, gap = 14, margin = 12): { left: number; top: number; side: "below" | "above" | "right" | "left" | "inside" | "center" } {
  const maxLeft = view.w - card.w - margin;
  const maxTop = view.h - card.h - margin;
  if (!spot) return { left: clamp((view.w - card.w) / 2, margin, maxLeft), top: clamp((view.h - card.h) / 2, margin, maxTop), side: "center" };
  const cx = clamp(spot.left + spot.width / 2 - card.w / 2, margin, maxLeft);
  const cy = clamp(spot.top + spot.height / 2 - card.h / 2, margin, maxTop);
  const bottom = spot.top + spot.height;
  const right = spot.left + spot.width;
  if (bottom + gap + card.h <= view.h - margin) return { left: cx, top: bottom + gap, side: "below" };
  if (spot.top - gap - card.h >= margin) return { left: cx, top: spot.top - gap - card.h, side: "above" };
  if (right + gap + card.w <= view.w - margin) return { left: right + gap, top: cy, side: "right" };
  if (spot.left - gap - card.w >= margin) return { left: spot.left - gap - card.w, top: cy, side: "left" };
  return { left: cx, top: clamp(bottom - card.h - gap, margin, maxTop), side: "inside" };
}
