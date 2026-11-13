import { type RefObject, useEffect, useReducer } from "react";

/**
 * 画布大小变了（拖分界线、改窗口）就返回一个新的数。
 * 给不是每帧都画的画布用（波形、修音的音高图）：把它放进绘制 effect 的依赖里，大小一变就重画
 */
export function useRedrawOnResize(ref: RefObject<HTMLElement | null>): number {
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let w = el.clientWidth;
    let h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w && el.clientHeight === h) return;
      w = el.clientWidth;
      h = el.clientHeight;
      bump();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return tick;
}
