import { useEffect, useRef } from "react";
import { NOTE_NAMES, OFF_CENTS } from "../tune/autotune";

export interface RollData {
  hop: number;
  /** 我的音高第 0 帧的歌曲时间 */
  start: number;
  mine: Float64Array;
  /** 判断跑调用的音高中心 */
  center: Float64Array;
  target: Float64Array;
  tuned: Float64Array | null;
  /** 原唱音高（MIDI），第 0 帧 = 歌曲 0 秒 */
  ref: Float64Array | null;
  refHop: number;
  /** 哪些时间段在修音范围内（null = 全部） */
  ranges: [number, number][] | null;
}

export interface RollView {
  start: number;
  len: number;
  lo: number;
  hi: number;
}

interface Props {
  data: RollData | null;
  view: RollView;
  time: number;
  onSeek: (t: number) => void;
  onView: (v: RollView) => void;
  /** 叠加在上面画的东西（M4 音符块） */
  overlay?: (ctx: CanvasRenderingContext2D, xOf: (t: number) => number, yOf: (m: number) => number) => void;
  onPointer?: (e: React.PointerEvent<HTMLCanvasElement>, at: { t: number; m: number }) => boolean;
  onDoubleClick?: (at: { t: number; m: number }) => void;
  onContextMenu?: (at: { t: number; m: number }) => void;
  cursor?: string;
}

/** 钢琴卷帘：灰 = 原唱、蓝 = 我的（跑调 > 30 音分标橙、加粗）、黑/白 = 修后（PRD 4.5） */
export function PitchRoll({ data, view, time, onSeek, onView, overlay, onPointer, onDoubleClick, onContextMenu, cursor }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(canvas);
    const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    const line = color("--line", "#ddd");
    const muted = color("--muted", "#888");
    const accent = color("--accent", "#c2410c");

    const xOf = (t: number) => ((t - view.start) / view.len) * w;
    const yOf = (m: number) => h - ((m - view.lo) / (view.hi - view.lo)) * h;

    // 半音网格，C 标出来
    ctx.font = "10px -apple-system, sans-serif";
    for (let m = Math.ceil(view.lo); m <= view.hi; m++) {
      const y = yOf(m);
      const pc = ((m % 12) + 12) % 12;
      ctx.fillStyle = [1, 3, 6, 8, 10].includes(pc) ? "rgba(127,127,127,0.07)" : "transparent";
      ctx.fillRect(0, y - (h / (view.hi - view.lo)) / 2, w, h / (view.hi - view.lo));
      ctx.strokeStyle = pc === 0 ? muted : line;
      ctx.globalAlpha = pc === 0 ? 0.6 : 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (pc === 0 || pc === 5 || pc === 9) {
        ctx.fillStyle = muted;
        ctx.fillText(`${NOTE_NAMES[pc]}${Math.floor(m / 12) - 1}`, 4, y - 2);
      }
    }

    if (data) {
      // 不在修音范围内的时间段压暗
      if (data.ranges) {
        ctx.fillStyle = "rgba(127,127,127,0.12)";
        let cursor = view.start;
        const sorted = [...data.ranges].sort((a, b) => a[0] - b[0]);
        for (const [a, b] of sorted) {
          if (a > cursor) ctx.fillRect(xOf(cursor), 0, xOf(a) - xOf(cursor), h);
          cursor = Math.max(cursor, b);
        }
        if (cursor < view.start + view.len) ctx.fillRect(xOf(cursor), 0, w - xOf(cursor), h);
      }

      const drawCurve = (values: Float64Array, t0: number, hop: number, stroke: (i: number) => string, width: (i: number) => number) => {
        const i0 = Math.max(0, Math.floor((view.start - t0) / hop) - 1);
        const i1 = Math.min(values.length, Math.ceil((view.start + view.len - t0) / hop) + 1);
        ctx.lineCap = "round";
        let prevColor = "";
        let prevWidth = 0;
        let prevV = NaN;
        let open = false;
        for (let i = i0; i < i1; i++) {
          const v = values[i];
          // 不发声断开；相邻两帧跳超过 5 个半音（检测跳变）也断开，不画竖线
          if (Number.isNaN(v) || (open && Math.abs(v - prevV) > 5)) {
            if (open) ctx.stroke();
            open = false;
            if (Number.isNaN(v)) continue;
          }
          prevV = v;
          const c = stroke(i);
          const lw = width(i);
          const x = xOf(t0 + i * hop);
          const y = yOf(v);
          if (!open || c !== prevColor || lw !== prevWidth) {
            if (open) {
              ctx.lineTo(x, y);
              ctx.stroke();
            }
            ctx.strokeStyle = c;
            ctx.lineWidth = lw;
            prevWidth = lw;
            ctx.beginPath();
            ctx.moveTo(x, y);
            open = true;
            prevColor = c;
          } else {
            ctx.lineTo(x, y);
          }
        }
        if (open) ctx.stroke();
      };

      // 颜色见 App.css 的 --pitch-*：红绿色弱也分得清（跑调橙色且更粗，修后用文字色）
      const refColor = color("--pitch-ref", "rgba(128,128,128,0.55)");
      const mineColor = color("--pitch-mine", "#2563eb");
      const offColor = color("--pitch-off", "#e69f00");
      const tunedColor = color("--pitch-tuned", "#1c1b19");
      const isOff = (i: number) => !Number.isNaN(data.target[i]) && Math.abs(data.center[i] - data.target[i]) * 100 > OFF_CENTS;
      if (data.ref) drawCurve(data.ref, 0, data.refHop, () => refColor, () => 3);
      const mineWidth = data.tuned ? 1.5 : 2;
      drawCurve(
        data.mine,
        data.start,
        data.hop,
        (i) => (isOff(i) ? offColor : mineColor),
        (i) => (isOff(i) ? mineWidth + 1.5 : mineWidth),
      );
      if (data.tuned) drawCurve(data.tuned, data.start, data.hop, () => tunedColor, () => 2);
    }

    overlay?.(ctx, xOf, yOf);

    // 播放头
    const px = xOf(time);
    ctx.fillStyle = accent;
    ctx.fillRect(px - 0.75, 0, 1.5, h);
  }, [data, view, time, overlay]);

  const at = (e: { clientX: number; clientY: number }) => {
    const rect = ref.current!.getBoundingClientRect();
    return {
      t: view.start + ((e.clientX - rect.left) / rect.width) * view.len,
      m: view.lo + (1 - (e.clientY - rect.top) / rect.height) * (view.hi - view.lo),
    };
  };

  return (
    <canvas
      ref={ref}
      className="pitch-roll"
      style={cursor ? { cursor } : undefined}
      onDoubleClick={(e) => onDoubleClick?.(at(e))}
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        onContextMenu(at(e));
      }}
      onPointerDown={(e) => {
        if (onPointer?.(e, at(e))) return;
        onSeek(Math.max(0, at(e).t));
      }}
      onPointerMove={(e) => onPointer?.(e, at(e))}
      onPointerUp={(e) => onPointer?.(e, at(e))}
      onWheel={(e) => {
        if (e.ctrlKey || e.metaKey) {
          // 捏合 / ⌘ 滚轮：横向缩放（⌥ 纵向）
          const factor = Math.exp(e.deltaY * 0.01);
          if (e.altKey) {
            const mid = (view.lo + view.hi) / 2;
            const half = Math.min(30, Math.max(4, ((view.hi - view.lo) / 2) * factor));
            onView({ ...view, lo: mid - half, hi: mid + half });
          } else {
            const t = at(e).t;
            const len = Math.min(120, Math.max(2, view.len * factor));
            onView({ ...view, start: Math.max(0, t - ((t - view.start) / view.len) * len), len });
          }
        } else if (e.shiftKey || Math.abs(e.deltaX) < Math.abs(e.deltaY) * 0.5) {
          // 竖向滚动：上下移动音高
          const d = (e.deltaY / ref.current!.clientHeight) * (view.hi - view.lo);
          onView({ ...view, lo: view.lo - d, hi: view.hi - d });
        } else {
          const d = (e.deltaX / ref.current!.clientWidth) * view.len;
          onView({ ...view, start: Math.max(0, view.start + d) });
        }
      }}
    />
  );
}
