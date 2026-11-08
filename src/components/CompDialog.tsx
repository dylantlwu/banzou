import { useMemo, useState } from "react";
import { type LrcDoc, effectiveTime } from "../lyrics/lrc";
import { type Take, compTake, lineSegments, takeSpan } from "../takes/takes";
import type { TakesApi } from "../takes/useTakes";
import { formatTime } from "../utils/time";
import { Btn } from "./Btn";

interface Props {
  takes: TakesApi;
  lyricsDoc: LrcDoc | null;
  onSeek: (t: number) => void;
  onClose: () => void;
}

/** 多遍拼接（PRD P2）：每句挑唱得最好的一遍，拼成新的一遍 */
export function CompDialog({ takes, lyricsDoc, onSeek, onClose }: Props) {
  const list = takes.takes;
  const span = useMemo<[number, number]>(() => {
    const spans = list.filter((t) => t.clips.length).map(takeSpan);
    return [Math.min(...spans.map((s) => s[0])), Math.max(...spans.map((s) => s[1]))];
  }, [list]);

  const lines = useMemo(() => {
    const timed = lyricsDoc ? lyricsDoc.lines.filter((l) => l.time !== null && l.text !== "") : [];
    const starts = timed.map((l) => effectiveTime(lyricsDoc!, l)!).filter((t) => t < span[1] && t >= span[0] - 5);
    const segs = lineSegments(starts.length ? starts : [], span);
    return segs.map(([from, to], i) => ({
      from,
      to,
      text: starts.length ? timed.find((l) => Math.abs(effectiveTime(lyricsDoc!, l)! - starts[i]) < 1e-6)?.text ?? "" : "整首",
    }));
  }, [lyricsDoc, span]);

  /** 覆盖这一句的那几遍 */
  const covering = (from: number, to: number): Take[] => {
    const mid = (from + Math.min(to, from + 4)) / 2;
    return list.filter((t) => t.clips.some((c) => c.from <= mid && c.to >= mid));
  };

  const [choice, setChoice] = useState<string[]>(() =>
    lines.map(({ from, to }) => {
      const c = covering(from, to);
      return (c.find((t) => t.starred) ?? c[c.length - 1])?.id ?? "";
    }),
  );
  const [name, setName] = useState("拼接版");
  const [error, setError] = useState<string | null>(null);

  const transposes = new Set(choice.filter(Boolean).map((id) => list.find((t) => t.id === id)?.transpose ?? 0));

  const create = async () => {
    const t = compTake(
      list,
      lines.map((l, i) => ({ from: l.from, to: l.to, takeId: choice[i] })).filter((c) => c.takeId),
      name.trim() || "拼接版",
    );
    if (!t) {
      setError("选的这几遍都没有覆盖到这些句子");
      return;
    }
    await takes.add(t);
    onClose();
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog comp-dialog" role="dialog" aria-label="多遍拼接">
        <h2>多遍拼接</h2>
        <p className="muted small">每句选唱得最好的那一遍，拼成新的一遍（原来的几遍都保留）。点「听」切到那一遍从这句开始播放。</p>
        <ol className="comp-lines">
          {lines.map((l, i) => {
            const c = covering(l.from, l.to);
            return (
              <li key={i}>
                <span className="muted small comp-time">{formatTime(l.from)}</span>
                <span className="comp-text">{l.text}</span>
                <select
                  value={choice[i]}
                  onChange={(e) => setChoice((old) => old.map((v, j) => (j === i ? e.target.value : v)))}
                  disabled={c.length === 0}
                >
                  {c.length === 0 && <option value="">（没有录到）</option>}
                  {c.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.starred ? "★ " : ""}
                      {t.name}
                    </option>
                  ))}
                </select>
                <Btn
                  className="ghost tiny"
                  disabled={!choice[i]}
                  onClick={() => {
                    takes.select(choice[i]);
                    onSeek(Math.max(0, l.from - 0.5));
                  }}
                >
                  听
                </Btn>
              </li>
            );
          })}
        </ol>
        {transposes.size > 1 && <p className="error-text small">选的几遍升降调不一样，拼出来会忽高忽低</p>}
        {error && <p className="error-text small">{error}</p>}
        <div className="dialog-actions">
          <input className="url-input comp-name" value={name} onChange={(e) => setName(e.target.value)} />
          <Btn className="ghost" onClick={onClose}>
            取消
          </Btn>
          <Btn className="primary" onClick={() => void create()}>
            生成拼接版
          </Btn>
        </div>
      </div>
    </div>
  );
}
