import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";

/**
 * 区块分界可以拖（PRD 4.0）：每条分界线管一个尺寸，存成 CSS 变量 `--<id>`，
 * 样式里用 `var(--<id>, 默认值)` 加 min / max 兜住，窗口缩小时也不变形。
 * 拖完的尺寸存在本机（localStorage），双击分界线删掉这一项 = 回到默认。
 */
export type SizeId =
  | "lib-w"
  | "takes-w"
  | "takes-bottom-h"
  | "pitch-h"
  | "learn-lines-w"
  | "teacher-w"
  | "learn-notes-h"
  | "wave-h"
  | "tune-ctrl-h"
  | "practice-list-w";

export type Sizes = Partial<Record<SizeId, number>>;

const KEY = "banzou.layoutSizes.v1";

export function loadSizes(): Sizes {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    const out: Sizes = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k as SizeId] = Math.round(v);
    return out;
  } catch {
    return {};
  }
}

function saveSizes(s: Sizes) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 存不了就只在这次打开里有效
  }
}

/** 拖动后的新尺寸：起始尺寸 + 位移（分界线在目标块后面时往右 / 下拖变大，在前面时相反），夹在 [min, max] */
export function dragSize(start: number, delta: number, side: "prev" | "next", min: number, max: number): number {
  const v = start + (side === "prev" ? delta : -delta);
  return Math.round(Math.min(Math.max(v, min), Math.max(min, max)));
}

interface Ctx {
  set: (id: SizeId, v: number) => void;
  reset: (id: SizeId) => void;
}
const SizesContext = createContext<Ctx>({ set: () => {}, reset: () => {} });

/** 放在应用最外层：读存档、把尺寸写成根元素上的 CSS 变量 */
export function SizesProvider({ children }: { children: ReactNode }) {
  const [sizes, setSizes] = useState<Sizes>(loadSizes);
  const applied = useRef<Set<string>>(new Set());
  // 先于子组件的绘制 effect 写好变量，画布按新尺寸画
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    for (const id of applied.current) if (!(id in sizes)) root.removeProperty(`--${id}`);
    applied.current = new Set(Object.keys(sizes));
    for (const [id, v] of Object.entries(sizes)) root.setProperty(`--${id}`, `${v}px`);
  }, [sizes]);
  const set = useCallback((id: SizeId, v: number) => {
    setSizes((s) => {
      if (s[id] === v) return s;
      const next = { ...s, [id]: v };
      saveSizes(next);
      return next;
    });
  }, []);
  const reset = useCallback((id: SizeId) => {
    setSizes((s) => {
      if (!(id in s)) return s;
      const next = { ...s };
      delete next[id];
      saveSizes(next);
      return next;
    });
  }, []);
  const ctx = useMemo(() => ({ set, reset }), [set, reset]);
  return <SizesContext.Provider value={ctx}>{children}</SizesContext.Provider>;
}

interface SplitterProps {
  id: SizeId;
  /** x = 左右拖（改宽度），y = 上下拖（改高度） */
  axis: "x" | "y";
  /** 改哪一块：分界线前面那块、后面那块，或父元素里的选择器 */
  target: "prev" | "next" | { selector: string; side: "prev" | "next" };
  min: number;
  /** 最大：像素；或父元素尺寸的比例（0–1） */
  max: number;
  title?: string;
}

/** 两块之间的分界线：平时看不出来，鼠标放上去光标变成 ↔ / ↕；双击回到默认 */
export function Splitter({ id, axis, target, min, max, title }: SplitterProps) {
  const { set, reset } = useContext(SizesContext);
  const drag = useRef<{ start: number; pos: number; max: number; side: "prev" | "next" } | null>(null);

  const targetEl = (el: HTMLElement): { node: HTMLElement | null; side: "prev" | "next" } => {
    if (target === "prev") return { node: el.previousElementSibling as HTMLElement | null, side: "prev" };
    if (target === "next") return { node: el.nextElementSibling as HTMLElement | null, side: "next" };
    return { node: el.parentElement?.querySelector<HTMLElement>(target.selector) ?? null, side: target.side };
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const { node, side } = targetEl(el);
    if (!node || !el.parentElement) return;
    e.preventDefault();
    const r = node.getBoundingClientRect();
    const pr = el.parentElement.getBoundingClientRect();
    const parentSize = axis === "x" ? pr.width : pr.height;
    drag.current = {
      start: axis === "x" ? r.width : r.height,
      pos: axis === "x" ? e.clientX : e.clientY,
      max: max <= 1 ? parentSize * max : max,
      side,
    };
    el.setPointerCapture(e.pointerId);
    document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const delta = (axis === "x" ? e.clientX : e.clientY) - d.pos;
    set(id, dragSize(d.start, delta, d.side, min, d.max));
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("resizing-x", "resizing-y");
  };

  return (
    <div
      className={`split split-${axis}`}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      title={title}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => reset(id)}
      onMouseDown={(e) => e.preventDefault()}
    />
  );
}
