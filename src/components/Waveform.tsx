import { useEffect, useRef } from "react";
import type { Peaks } from "../audio/peaks";
import type { LrcLine } from "../lyrics/lrc";

interface Props {
  peaks: Peaks | null;
  /** 播放头位置（耳朵听到的歌曲时间） */
  time: number;
  lines: LrcLine[];
  selected: number | null;
  /** 可见窗口长度（秒） */
  windowSeconds?: number;
  onMarkerChange: (index: number, time: number) => void;
  onMarkerSelect: (index: number) => void;
  onSeek: (time: number) => void;
}

const HIT_PX = 6;

/** 人声波形 + 打轴时间点，时间点可拖动（PRD 4.3） */
export function Waveform({
  peaks,
  time,
  lines,
  selected,
  windowSeconds = 8,
  onMarkerChange,
  onMarkerSelect,
  onSeek,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ index: number; start: number } | null>(null);
  const viewStartRef = useRef(0);

  // 拖动时窗口固定不动，否则播放中拖不准
  const viewStart = dragRef.current ? viewStartRef.current : Math.max(0, time - windowSeconds / 2);
  viewStartRef.current = viewStart;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const style = getComputedStyle(canvas);
    const wave = style.getPropertyValue("--wave").trim() || "#999";
    const accent = style.getPropertyValue("--accent").trim() || "#c2410c";
    const text = style.getPropertyValue("--muted").trim() || "#777";
    const xOf = (t: number) => ((t - viewStart) / windowSeconds) * w;

    if (peaks) {
      ctx.fillStyle = wave;
      const mid = h / 2;
      for (let x = 0; x < w; x += 2) {
        const t = viewStart + (x / w) * windowSeconds;
        const v = peaks.values[Math.floor(t * peaks.perSecond)] ?? 0;
        const bar = Math.max(1, Math.min(1, v * 1.6) * (h / 2 - 4));
        ctx.fillRect(x, mid - bar, 1.2, bar * 2);
      }
    }

    ctx.font = "10px -apple-system, sans-serif";
    lines.forEach((line, i) => {
      if (line.time === null) return;
      const x = xOf(line.time);
      if (x < -20 || x > w + 20) return;
      const isSel = i === selected;
      ctx.fillStyle = isSel ? accent : text;
      ctx.fillRect(x - (isSel ? 1 : 0.5), 0, isSel ? 2 : 1, h);
      ctx.fillText(line.text === "" ? "间奏" : String(lines.slice(0, i + 1).filter((l) => l.text !== "").length), x + 3, 11);
    });

    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(xOf(time) - 0.5, 0, 1, h);
    ctx.globalAlpha = 1;
  }, [peaks, time, lines, selected, viewStart, windowSeconds]);

  const timeAt = (clientX: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return viewStartRef.current + ((clientX - rect.left) / rect.width) * windowSeconds;
  };

  const markerAt = (clientX: number): number | null => {
    const rect = canvasRef.current!.getBoundingClientRect();
    let best: number | null = null;
    let bestDist = HIT_PX;
    lines.forEach((line, i) => {
      if (line.time === null) return;
      const x = ((line.time - viewStartRef.current) / windowSeconds) * rect.width + rect.left;
      const d = Math.abs(x - clientX);
      if (d <= bestDist) {
        best = i;
        bestDist = d;
      }
    });
    return best;
  };

  return (
    <canvas
      ref={canvasRef}
      className="waveform"
      onPointerDown={(e) => {
        const idx = markerAt(e.clientX);
        if (idx === null) {
          onSeek(Math.max(0, timeAt(e.clientX)));
          return;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { index: idx, start: e.clientX };
        onMarkerSelect(idx);
      }}
      onPointerMove={(e) => {
        const drag = dragRef.current;
        if (!drag) {
          e.currentTarget.style.cursor = markerAt(e.clientX) === null ? "pointer" : "ew-resize";
          return;
        }
        onMarkerChange(drag.index, Math.max(0, timeAt(e.clientX)));
      }}
      onPointerUp={() => {
        dragRef.current = null;
      }}
    />
  );
}
