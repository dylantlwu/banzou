/**
 * 手动修音的交互（PRD 4.6）：选中、上下拖动改音高（吸附半音 / 原唱 / 自由，按住 ⌥ 自由）、
 * 双击吸附原唱、切分（S）、合并（⌘J）、↑↓ 半音 / ⇧↑↓ 10 音分、⌘Z / ⇧⌘Z、右键还原。
 * 每次改完回调 onCommit(改动的歌曲时间范围)，由页面去做局部重新渲染。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { OFF_CENTS } from "./autotune";
import { History, type Note, mergeNotes, noteMidi, resetNote, splitNote } from "./notes";

export type SnapMode = "ref" | "semitone" | "free";

interface Options {
  enabled: boolean;
  initial: Note[];
  mine: Float64Array | null;
  start: number;
  hop: number;
  /** 原唱音高（MIDI，第 0 帧 = 歌曲 0 秒） */
  ref: Float64Array | null;
  refHop: number;
  snap: SnapMode;
  onChange: (notes: Note[]) => void;
  onCommit: (range: [number, number]) => void;
}

function median(v: number[]): number {
  const s = v.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

export function useNoteEditor({ enabled, initial, mine, start, hop, ref, refHop, snap, onChange, onCommit }: Options) {
  const historyRef = useRef(new History<Note[]>(initial));
  const [notes, setNotesState] = useState<Note[]>(initial);
  const [selected, setSelected] = useState<string[]>([]);
  const [splitTool, setSplitTool] = useState(false);
  const dragRef = useRef<{ id: string; m0: number; offset0: number; moved: boolean } | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;

  // 换 Take / 重新切分时重置
  useEffect(() => {
    historyRef.current = new History(initial);
    setNotesState(initial);
    setSelected([]);
  }, [initial]);

  const baseMidi = useCallback((n: Note) => (mine ? noteMidi(n, mine, start, hop) : NaN), [mine, start, hop]);
  const refMidi = useCallback(
    (n: Note) => {
      if (!ref) return NaN;
      const a = Math.max(0, Math.round(n.start / refHop));
      const b = Math.min(ref.length, Math.round(n.end / refHop));
      return median(Array.from(ref.slice(a, b)));
    },
    [ref, refHop],
  );

  const rangeOf = (ids: string[], list: Note[]): [number, number] => {
    const sel = list.filter((n) => ids.includes(n.id));
    if (!sel.length) return [0, 0];
    return [Math.min(...sel.map((n) => n.start)) - 0.05, Math.max(...sel.map((n) => n.end)) + 0.05];
  };

  /** 提交一次修改（进撤销历史、保存、局部渲染） */
  const commit = useCallback(
    (next: Note[], changed: string[]) => {
      const before = notesRef.current;
      historyRef.current.push(next);
      setNotesState(next);
      onChange(next);
      const r1 = rangeOf(changed, before);
      const r2 = rangeOf(changed, next);
      onCommit([Math.min(r1[0] || r2[0], r2[0]), Math.max(r1[1], r2[1])]);
    },
    [onChange, onCommit],
  );

  const update = useCallback(
    (ids: string[], fn: (n: Note) => Note) => {
      const next = notesRef.current.map((n) => (ids.includes(n.id) ? { ...fn(n), edited: true } : n));
      commit(next, ids);
    },
    [commit],
  );

  /** 把音高吸附到目标：返回新的 offset（音分） */
  const snapOffset = useCallback(
    (n: Note, offset: number, free: boolean) => {
      const base = baseMidi(n);
      if (Number.isNaN(base) || free || snap === "free") return Math.round(offset);
      const want = base + offset / 100;
      if (snap === "ref") {
        const r = refMidi(n);
        if (!Number.isNaN(r)) {
          const folded = r + 12 * Math.round((want - r) / 12);
          if (Math.abs(folded - want) < 0.75) return Math.round((folded - base) * 100);
        }
      }
      return Math.round((Math.round(want) - base) * 100);
    },
    [baseMidi, refMidi, snap],
  );

  const hit = useCallback(
    (t: number, m: number) =>
      notesRef.current.find((n) => {
        if (t < n.start || t > n.end) return false;
        const p = baseMidi(n) + n.offset / 100;
        return Math.abs(p - m) < 0.7;
      }) ?? null,
    [baseMidi],
  );

  const onPointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>, at: { t: number; m: number }): boolean => {
      if (!enabled) return false;
      if (e.type === "pointerdown") {
        const n = hit(at.t, at.m);
        if (!n) {
          if (!e.shiftKey) setSelected([]);
          return false; // 点空白处照常跳转
        }
        if (splitTool) {
          commit(splitNote(notesRef.current, n.id, at.t), [n.id]);
          return true;
        }
        setSelected((s) => (e.shiftKey ? (s.includes(n.id) ? s.filter((x) => x !== n.id) : [...s, n.id]) : [n.id]));
        dragRef.current = { id: n.id, m0: at.m, offset0: n.offset, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
        return true;
      }
      const drag = dragRef.current;
      if (!drag) return false;
      if (e.type === "pointermove") {
        const n = notesRef.current.find((x) => x.id === drag.id);
        if (!n) return true;
        const raw = drag.offset0 + (at.m - drag.m0) * 100;
        const offset = snapOffset(n, raw, e.altKey);
        if (offset !== n.offset || drag.moved) {
          drag.moved = true;
          // 拖动中只更新显示，松手再提交
          setNotesState(notesRef.current.map((x) => (x.id === drag.id ? { ...x, offset, edited: true } : x)));
        }
        return true;
      }
      if (e.type === "pointerup") {
        dragRef.current = null;
        if (drag.moved) commit(notesRef.current, [drag.id]);
        return true;
      }
      return false;
    },
    [enabled, hit, splitTool, commit, snapOffset],
  );

  const onDoubleClick = useCallback(
    (at: { t: number; m: number }) => {
      if (!enabled) return;
      const n = hit(at.t, at.m);
      if (!n) return;
      const base = baseMidi(n);
      const r = refMidi(n);
      if (Number.isNaN(base) || Number.isNaN(r)) return;
      const folded = r + 12 * Math.round((base - r) / 12);
      update([n.id], (x) => ({ ...x, offset: Math.round((folded - base) * 100) }));
    },
    [enabled, hit, baseMidi, refMidi, update],
  );

  const onContextMenu = useCallback(
    (at: { t: number; m: number }) => {
      if (!enabled) return;
      const n = hit(at.t, at.m);
      if (!n) return;
      const next = notesRef.current.map((x) => (x.id === n.id ? resetNote(x) : x));
      commit(next, [n.id]);
    },
    [enabled, hit, commit],
  );

  /** 撤销 / 重做后，前后不同的音符覆盖的时间范围 */
  const diffRange = (before: Note[], after: Note[]): [number, number] | null => {
    const key = (n: Note) => JSON.stringify(n);
    const a = new Set(before.map(key));
    const b = new Set(after.map(key));
    const changed = [...before.filter((n) => !b.has(key(n))), ...after.filter((n) => !a.has(key(n)))];
    if (!changed.length) return null;
    return [Math.min(...changed.map((n) => n.start)) - 0.05, Math.max(...changed.map((n) => n.end)) + 0.05];
  };

  const step = useCallback(
    (dir: "undo" | "redo") => {
      const before = notesRef.current;
      const next = dir === "undo" ? historyRef.current.undo() : historyRef.current.redo();
      if (next === before) return;
      setNotesState(next);
      onChange(next);
      const r = diffRange(before, next);
      if (r) onCommit(r);
    },
    [onChange, onCommit],
  );
  const undo = useCallback(() => step("undo"), [step]);
  const redo = useCallback(() => step("redo"), [step]);

  // 快捷键
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.code === "KeyZ") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.code === "KeyJ") {
        e.preventDefault();
        if (selected.length >= 2) {
          const next = mergeNotes(notesRef.current, selected);
          commit(next, selected);
          setSelected([next.find((n) => n.start <= Math.min(...notesRef.current.filter((x) => selected.includes(x.id)).map((x) => x.start)) + 1e-6)?.id ?? ""]);
        }
        return;
      }
      if (mod) return;
      if (e.code === "KeyS") {
        setSplitTool((v) => !v);
        e.preventDefault();
      } else if ((e.code === "ArrowUp" || e.code === "ArrowDown") && selected.length) {
        const step = (e.shiftKey ? 10 : 100) * (e.code === "ArrowUp" ? 1 : -1);
        update(selected, (n) => ({ ...n, offset: n.offset + step }));
        e.preventDefault();
        e.stopPropagation();
      } else if ((e.code === "Backspace" || e.code === "Delete") && selected.length) {
        commit(
          notesRef.current.map((n) => (selected.includes(n.id) ? resetNote(n) : n)),
          selected,
        );
        e.preventDefault();
      } else if (e.code === "Escape") {
        if (splitTool) setSplitTool(false);
        else setSelected([]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled, selected, splitTool, undo, redo, update, commit]);

  /** 画音符块（PitchRoll 的 overlay） */
  const overlay = useCallback(
    (ctx: CanvasRenderingContext2D, xOf: (t: number) => number, yOf: (m: number) => number) => {
      if (!enabled || !mine) return;
      const unit = Math.abs(yOf(0) - yOf(1));
      // 红绿色弱也分得清：普通 = 蓝，改过 = 文字色描边（和「修后」曲线一样），跑调 = 橙色虚线框
      const style = getComputedStyle(ctx.canvas);
      const css = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
      const editedColor = css("--pitch-tuned", "#1c1b19");
      const offColor = css("--pitch-off", "#e69f00");
      const accent = css("--accent", "#c2410c");
      for (const n of notesRef.current) {
        const x0 = xOf(n.start);
        const x1 = xOf(n.end);
        if (x1 < 0 || x0 > ctx.canvas.clientWidth) continue;
        const base = baseMidi(n);
        if (Number.isNaN(base)) continue;
        const p = base + n.offset / 100;
        const r = refMidi(n);
        const off = !Number.isNaN(r) && Math.abs(r + 12 * Math.round((p - r) / 12) - p) * 100 > OFF_CENTS;
        const sel = selected.includes(n.id);
        const h = Math.max(6, unit * 0.8);
        ctx.fillStyle = sel ? "rgba(194,65,12,0.35)" : "rgba(59,130,246,0.22)";
        ctx.strokeStyle = sel ? accent : n.edited ? editedColor : "rgba(59,130,246,0.7)";
        ctx.lineWidth = sel || n.edited ? 2 : 1;
        const y = yOf(p) - h / 2;
        const wBox = Math.max(2, x1 - x0);
        ctx.beginPath();
        ctx.roundRect(x0, y, wBox, h, 3);
        ctx.fill();
        ctx.stroke();
        if (off) {
          ctx.save();
          ctx.strokeStyle = offColor;
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.roundRect(x0 - 3, y - 3, wBox + 6, h + 6, 5);
          ctx.stroke();
          ctx.restore();
        }
        if (n.edited && x1 - x0 > 30) {
          ctx.fillStyle = editedColor;
          ctx.font = "10px -apple-system, sans-serif";
          const label = n.offset ? `${n.offset > 0 ? "+" : ""}${n.offset}` : "✎";
          ctx.fillText(label, x0 + 3, y - 2);
        }
      }
    },
    [enabled, mine, baseMidi, refMidi, selected],
  );

  const selectedNotes = notes.filter((n) => selected.includes(n.id));

  return {
    notes,
    selected,
    selectedNotes,
    splitTool,
    setSplitTool,
    onPointer,
    onDoubleClick,
    onContextMenu,
    overlay,
    undo,
    redo,
    canUndo: historyRef.current.canUndo,
    canRedo: historyRef.current.canRedo,
    /** 改选中音符的参数（滑杆拖动中 live = true 只更新显示，松手再提交） */
    setParam: (patch: Partial<Note>, live: boolean) => {
      if (!selected.length) return;
      const next = notesRef.current.map((n) => (selected.includes(n.id) ? { ...n, ...patch, edited: true } : n));
      if (live) setNotesState(next);
      else commit(next, selected);
    },
    commitCurrent: () => commit(notesRef.current, selected),
    resetSelected: () => commit(notesRef.current.map((n) => (selected.includes(n.id) ? resetNote(n) : n)), selected),
    resetAll: () => {
      const ids = notesRef.current.filter((n) => n.edited).map((n) => n.id);
      commit(notesRef.current.map(resetNote), ids);
    },
  };
}
