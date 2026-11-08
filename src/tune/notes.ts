/**
 * 手动修音的音符模型（PRD 4.6 / 7.5）。
 *
 * 录音分析完自动切成一个个音符块；每个音符只存参数（音高偏移、拉直、颤音比例、过渡时长），
 * 目标音高 = 原始音高按参数算出来。手动改过的音符加锁，之后再跑自动修音不会覆盖它。
 */
import { hzToMidi, type PitchTrack } from "./autotune";

export interface Note {
  id: string;
  /** 歌曲时间（秒） */
  start: number;
  end: number;
  /** 整体移多少音分 */
  offset: number;
  /** 拉直：0 = 原样，1 = 音高漂移完全拉平（颤音单独控制） */
  straighten: number;
  /** 颤音幅度比例：0 = 去掉，1 = 原样，2 = 加倍 */
  vibrato: number;
  /** 从上一个音滑过来用多少毫秒（0 = 自动修音的默认过渡） */
  transition: number;
  /** 手动改过：自动修音不再覆盖 */
  edited: boolean;
}

let seq = 0;
const newId = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

/** 切音符：发声段里音高持续跳变超过 70 音分就切开；短于 80ms 的并到相邻音 */
export function segmentNotes(track: PitchTrack, start: number): Note[] {
  const hop = track.hop;
  const m = track.f0.map((f) => (f > 0 ? hzToMidi(f) : NaN));
  const notes: Note[] = [];
  const minLen = Math.round(0.08 / hop);
  let i = 0;
  while (i < m.length) {
    if (Number.isNaN(m[i])) {
      i++;
      continue;
    }
    const runStart = i;
    while (i < m.length && !Number.isNaN(m[i])) i++;
    const runEnd = i;
    // 在发声段内找切点：前后 60ms 的中位数相差 > 0.7 半音
    const cuts = [runStart];
    const W = 6;
    for (let k = runStart + W; k < runEnd - W; k++) {
      const before = median(m.slice(k - W, k));
      const after = median(m.slice(k, k + W));
      if (Math.abs(after - before) > 0.7 && k - cuts[cuts.length - 1] >= minLen) {
        // 在跳变最陡的地方切
        let best = k;
        let bestJump = 0;
        for (let j = k; j < Math.min(runEnd - 1, k + W); j++) {
          const jump = Math.abs(m[j + 1] - m[j]);
          if (jump > bestJump) {
            bestJump = jump;
            best = j + 1;
          }
        }
        if (best - cuts[cuts.length - 1] >= minLen && runEnd - best >= minLen) cuts.push(best);
        k = best + W;
      }
    }
    cuts.push(runEnd);
    for (let c = 0; c + 1 < cuts.length; c++) {
      const a = cuts[c];
      const b = cuts[c + 1];
      if (b - a < minLen && notes.length && Math.abs(notes[notes.length - 1].end - (start + a * hop)) < 1e-6) {
        notes[notes.length - 1].end = start + b * hop;
        continue;
      }
      if (b - a < minLen) continue;
      notes.push(blank(start + a * hop, start + b * hop));
    }
  }
  return notes;
}

function blank(start: number, end: number): Note {
  return { id: newId(), start, end, offset: 0, straighten: 0, vibrato: 1, transition: 0, edited: false };
}

function median(v: number[]): number {
  const s = v.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

/** 音符在我的音高曲线里覆盖的帧 */
export function noteFrames(note: Note, start: number, hop: number, n: number): [number, number] {
  return [Math.max(0, Math.round((note.start - start) / hop)), Math.min(n, Math.round((note.end - start) / hop))];
}

/** 音符的平均音高（中位数，MIDI） */
export function noteMidi(note: Note, mine: Float64Array, start: number, hop: number): number {
  const [a, b] = noteFrames(note, start, hop, mine.length);
  return median(Array.from(mine.slice(a, b)));
}

/**
 * 把手动编辑合成到修正曲线里：改过的音符用手动参数，其余保持自动修音的结果。
 * 音高分解：原始 = 平均 + 漂移（120ms 平滑后的起伏）+ 颤音（剩下的快速起伏）。
 * 目标 = 平均 + 偏移 + 漂移 ×（1 − 拉直）+ 颤音 × 颤音比例。
 */
export function applyNotes(mine: Float64Array, start: number, hop: number, autoCents: Float32Array, notes: Note[]): Float32Array {
  const out = Float32Array.from(autoCents);
  const n = mine.length;
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  for (let k = 0; k < sorted.length; k++) {
    const note = sorted[k];
    if (!note.edited) continue;
    const [a, b] = noteFrames(note, start, hop, n);
    if (b - a < 2) continue;
    const seg = Array.from(mine.slice(a, b));
    const mean = median(seg);
    if (Number.isNaN(mean)) continue;
    // 漂移 = 120ms 滑动平均
    const half = Math.max(1, Math.round(0.06 / hop));
    const drift = seg.map((_, i) => {
      let s = 0;
      let c = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(seg.length - 1, i + half); j++) {
        if (!Number.isNaN(seg[j])) {
          s += seg[j];
          c++;
        }
      }
      return c ? s / c - mean : 0;
    });
    const target = seg.map((v, i) => {
      if (Number.isNaN(v)) return NaN;
      const vib = v - mean - drift[i];
      return mean + note.offset / 100 + drift[i] * (1 - note.straighten) + vib * note.vibrato;
    });
    // 过渡：音符开头 transition 毫秒内，从进入时的修正量平滑过渡到目标
    const trans = Math.round(note.transition / 1000 / hop);
    const entry = a > 0 ? out[a - 1] : 0;
    for (let i = 0; i < seg.length; i++) {
      if (Number.isNaN(target[i])) continue;
      let c = (target[i] - seg[i]) * 100;
      if (trans > 0 && i < trans) {
        const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / trans);
        c = entry * (1 - w) + c * w;
      }
      out[a + i] = c;
    }
  }
  return out;
}

/** 在 t 处把音符切成两个（编辑参数两边都保留） */
export function splitNote(notes: Note[], id: string, t: number): Note[] {
  return notes.flatMap((n) => {
    if (n.id !== id || t <= n.start + 0.04 || t >= n.end - 0.04) return [n];
    return [
      { ...n, end: t },
      { ...n, id: newId(), start: t },
    ];
  });
}

/** 合并相邻的两个或多个音符（取第一个的编辑参数） */
export function mergeNotes(notes: Note[], ids: string[]): Note[] {
  const sel = notes.filter((n) => ids.includes(n.id)).sort((a, b) => a.start - b.start);
  if (sel.length < 2) return notes;
  const merged: Note = { ...sel[0], end: Math.max(...sel.map((n) => n.end)), edited: sel.some((n) => n.edited) };
  return [...notes.filter((n) => !ids.includes(n.id)), merged].sort((a, b) => a.start - b.start);
}

export function resetNote(note: Note): Note {
  return { ...note, offset: 0, straighten: 0, vibrato: 1, transition: 0, edited: false };
}

/** 撤销 / 重做：每一步存整份音符列表（音符不多，简单可靠） */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(public present: T) {}

  push(next: T): T {
    this.past.push(this.present);
    if (this.past.length > 200) this.past.shift();
    this.present = next;
    this.future = [];
    return next;
  }

  undo(): T {
    const prev = this.past.pop();
    if (prev === undefined) return this.present;
    this.future.push(this.present);
    this.present = prev;
    return prev;
  }

  redo(): T {
    const next = this.future.pop();
    if (next === undefined) return this.present;
    this.past.push(this.present);
    this.present = next;
    return next;
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}
