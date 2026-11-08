import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type LrcDoc, effectiveTime, findLineIndex } from "../lyrics/lrc";

interface Props {
  doc: LrcDoc;
  /** 耳朵当前听到的歌曲时间（已扣除耳机延迟） */
  time: number;
  /** 播放中：手动翻看歌词后停手几秒会自动回到当前句 */
  playing?: boolean;
  onSeek?: (t: number) => void;
  large?: boolean;
}

/** 播放中停手多久后回到当前句 */
export const BROWSE_RESUME_MS = 3000;
/** 移动超过这个距离算拖动，不算点击 */
const DRAG_THRESHOLD = 5;

/**
 * 逐行滚动歌词：当前行居中高亮，点击任意行跳转（PRD 4.2）。
 * 滚轮/触控板或按住拖动可以上下翻看；暂停时停在翻到的位置，播放中停手 3 秒回到当前句。
 */
export function LyricsView({ doc, time, playing = false, onSeek, large }: Props) {
  const timed = doc.lines.filter((l) => l.time !== null);
  const active = findLineIndex(doc, time);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [autoOffset, setAutoOffset] = useState(0);
  /** 手动翻看时的位置；null 表示跟随当前句 */
  const [manual, setManual] = useState<number | null>(null);
  /** 每次手动操作 +1，用来重置「回到当前句」的计时 */
  const [touch, setTouch] = useState(0);
  const browsing = manual !== null;
  const dragRef = useRef<{ y: number; start: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  // 当前行居中；容器尺寸变化（窗口缩放、底部控制栏高度变化）时也要重新算
  useLayoutEffect(() => {
    const container = containerRef.current;
    const list = listRef.current;
    if (!container || !list) return;
    const update = () => {
      const el = list.children[Math.max(active, 0)] as HTMLElement | undefined;
      if (el) setAutoOffset(container.clientHeight / 2 - (el.offsetTop + el.offsetHeight / 2));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    return () => ro.disconnect();
  }, [active, timed.length, large]);

  // 换歌时回到跟随模式
  useEffect(() => setManual(null), [doc]);

  // 播放中停手一会儿自动回到当前句
  useEffect(() => {
    if (!browsing || !playing) return;
    const id = window.setTimeout(() => setManual(null), BROWSE_RESUME_MS);
    return () => window.clearTimeout(id);
  }, [browsing, playing, touch]);

  /** 限制范围：第一句最多到中间，最后一句最多到中间 */
  const clamp = useCallback((v: number) => {
    const container = containerRef.current;
    const list = listRef.current;
    if (!container || !list) return v;
    const half = container.clientHeight / 2;
    const last = list.lastElementChild as HTMLElement | null;
    const min = last ? half - (last.offsetTop + last.offsetHeight / 2) : half;
    return Math.min(half, Math.max(min, v));
  }, []);

  const browseTo = (v: number) => {
    setManual(clamp(v));
    setTouch((n) => n + 1);
  };

  const offset = manual ?? autoOffset;

  return (
    <div className="lyrics-wrap">
      <div
        className={["lyrics", large ? "large" : "", browsing ? "browsing" : ""].filter(Boolean).join(" ")}
        ref={containerRef}
        onWheel={(e) => {
          const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
          if (dy !== 0) browseTo(offset - dy);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragRef.current = { y: e.clientY, start: offset, moved: false };
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (!drag) return;
          const dy = e.clientY - drag.y;
          if (!drag.moved && Math.abs(dy) < DRAG_THRESHOLD) return;
          if (!drag.moved) {
            drag.moved = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          browseTo(drag.start + dy);
        }}
        onPointerUp={() => {
          suppressClickRef.current = !!dragRef.current?.moved;
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <ol ref={listRef} style={{ transform: `translateY(${offset}px)` }}>
          {timed.map((line, i) => {
            const distance = Math.abs(i - active);
            const cls = [
              "lyric-line",
              i === active ? "active" : "",
              line.text === "" ? "break" : "",
              !browsing && distance > 3 ? "far" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <li
                key={`${i}-${line.time}`}
                className={cls}
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  const t = effectiveTime(doc, line);
                  if (t !== null) onSeek?.(Math.max(0, t));
                  setManual(null);
                }}
              >
                {line.text === "" ? "· · ·" : line.text}
              </li>
            );
          })}
        </ol>
      </div>
      {browsing && (
        <button
          type="button"
          className="lyrics-resume"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setManual(null)}
        >
          回到当前句
        </button>
      )}
    </div>
  );
}
