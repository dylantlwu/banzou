import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_RANGE, EXERCISES, type ExerciseId, ROUTINE, type Range, foldToTarget, noteName } from "../practice/exercises";
import { type PracticeLog, dayKey, emptyLog, loadLog, recentDays, record, saveLog, streak, trend } from "../practice/practiceLog";
import { type PracticeApi, type Target, usePractice } from "../practice/usePractice";
import type { Settings } from "../settings";
import { Splitter } from "../layout/split";
import { Btn } from "./Btn";

interface Props {
  settings: Settings;
  onExit: () => void;
}

/** 打分颜色读 App.css 的 --good / --ok / --bad（蓝 / 黄 / 红，红绿色弱也分得清） */
const GRADE_VAR: Record<string, [string, string]> = { good: ["--good", "#2563eb"], ok: ["--ok", "#e69f00"], bad: ["--bad", "#ef4444"], miss: ["--muted", "#adb5bd"] };

/** 实时画面：目标音（灰条，打分后变蓝 / 黄 / 红）+ 我唱的音高（文字色的线） */
function PracticeView({ api, range }: { api: PracticeApi; range: Range }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const targetsRef = useRef<Target[]>(api.targets);
  targetsRef.current = api.targets;

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = ref.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const style = getComputedStyle(canvas);
      const line = style.getPropertyValue("--line").trim() || "#ddd";
      const muted = style.getPropertyValue("--muted").trim() || "#888";
      const text = style.getPropertyValue("--text").trim() || "#1c1b19";
      const gradeColor = (g: string) => style.getPropertyValue(GRADE_VAR[g][0]).trim() || GRADE_VAR[g][1];
      const t = api.now();
      const lat = api.latency();
      const t0 = t - 5;
      const t1 = t + 2.5;
      const targets = targetsRef.current;
      const mids = targets.map((x) => x.midi);
      const lo = Math.min(range.low, ...mids) - 3;
      const hi = Math.max(range.high, ...mids) + 3;
      const x = (tt: number) => ((tt - t0) / (t1 - t0)) * w;
      const y = (m: number) => h - ((m - lo) / (hi - lo)) * h;
      ctx.font = "10px -apple-system, sans-serif";
      for (let m = Math.ceil(lo); m <= hi; m++) {
        if (m % 12 !== 0 && m % 12 !== 7) continue;
        ctx.strokeStyle = line;
        ctx.beginPath();
        ctx.moveTo(0, y(m));
        ctx.lineTo(w, y(m));
        ctx.stroke();
        ctx.fillStyle = muted;
        ctx.fillText(noteName(m), 4, y(m) - 2);
      }
      // 目标音
      const unit = h / (hi - lo);
      for (const tg of targets) {
        ctx.fillStyle = tg.grade ? gradeColor(tg.grade) : "rgba(128,128,128,0.35)";
        ctx.globalAlpha = tg.grade ? 0.55 : 1;
        ctx.beginPath();
        ctx.roundRect(x(tg.start), y(tg.midi) - unit * 0.4, Math.max(3, x(tg.end) - x(tg.start) - 2), unit * 0.8, 4);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (tg.grade && tg.grade !== "miss" && tg.cents !== null && tg.cents !== undefined && x(tg.end) - x(tg.start) > 28) {
          ctx.fillStyle = gradeColor(tg.grade);
          ctx.fillText(`${tg.cents > 0 ? "+" : ""}${tg.cents}`, x(tg.start) + 2, y(tg.midi) - unit * 0.5 - 2);
        }
      }
      // 我唱的（扣掉延迟，和目标对齐；按最近的目标折八度）
      const frames = api.frames();
      ctx.strokeStyle = text;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      let open = false;
      ctx.beginPath();
      for (const f of frames) {
        const ft = f.t - lat;
        if (ft < t0 || !Number.isFinite(f.midi)) {
          open = false;
          continue;
        }
        const near = targets.find((tg) => ft >= tg.start - 0.3 && ft <= tg.end + 0.3);
        const m = near ? foldToTarget(f.midi, near.midi) : f.midi;
        if (m < lo - 1 || m > hi + 1) {
          open = false;
          continue;
        }
        if (open) ctx.lineTo(x(ft), y(m));
        else ctx.moveTo(x(ft), y(m));
        open = true;
      }
      ctx.stroke();
      // 现在
      ctx.fillStyle = "rgba(194,65,12,0.6)";
      ctx.fillRect(x(t - lat), 0, 1.5, h);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [api, range]);

  return <canvas ref={ref} className="practice-canvas" />;
}

/** 迷你趋势线 */
function Spark({ values, max, label, unit }: { values: (number | null)[]; max: number; label: string; unit: string }) {
  const pts = values.map((v, i) => (v === null ? null : [(i / (values.length - 1)) * 100, 30 - (Math.min(v, max) / max) * 28])).filter(Boolean) as number[][];
  const last = [...values].reverse().find((v) => v !== null);
  return (
    <div className="spark">
      <span className="muted small">{label}</span>
      <svg viewBox="0 0 100 32" preserveAspectRatio="none">
        <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => (
          <circle key={i} cx={p[0]} cy={p[1]} r="1.2" fill="var(--accent)" />
        ))}
      </svg>
      <span className="small">{last !== undefined && last !== null ? `${unit === "%" ? Math.round(last * 100) : last}${unit}` : "—"}</span>
    </div>
  );
}

/** 练声页（PRD 4.8） */
export function PracticePage({ settings, onExit }: Props) {
  const [log, setLog] = useState<PracticeLog>(emptyLog());
  useEffect(() => {
    void loadLog().then(setLog);
  }, []);
  const range = log.range ?? DEFAULT_RANGE;

  const onResult = useCallback((id: ExerciseId, r: Parameters<typeof record>[2], minutes: number) => {
    setLog((old) => {
      const next = record(old, id, r, minutes);
      void saveLog(next);
      return next;
    });
  }, []);
  const onRange = useCallback((r: Range) => {
    setLog((old) => {
      const next = { ...old, range: r };
      void saveLog(next);
      return next;
    });
  }, []);

  const api = usePractice({ settings, range, onResult, onRange });
  const today = log.days[dayKey()]?.results ?? {};
  const days = useMemo(() => recentDays(log, 30), [log]);
  const st = streak(log);

  const exit = () => {
    api.stop();
    api.close();
    onExit();
  };

  const liveTarget = api.targets.find((tg) => {
    const t = api.now() - api.latency();
    return t >= tg.start && t <= tg.end;
  });
  const liveCents = liveTarget && Number.isFinite(api.live.midi) ? Math.round((foldToTarget(api.live.midi, liveTarget.midi) - liveTarget.midi) * 100) : null;

  const resultText = (id: ExerciseId) => {
    const r = today[id];
    if (!r) return null;
    if (r.breathSec !== undefined) return `${r.breathSec} 秒`;
    if (r.wobble !== undefined) return `抖动 ${r.wobble}`;
    if (r.accuracy !== undefined) return `准 ${Math.round(r.accuracy * 100)}%`;
    return "✓";
  };

  return (
    <section className="editor practice">
      <div className="editor-bar">
        <Btn className="ghost" onClick={exit}>
          ← 返回
        </Btn>
        <h2 className="editor-title">练声</h2>
        <span className="muted small">
          音域 {noteName(range.low)} – {noteName(range.high)}
          {!log.range && "（默认，建议先测）"}
        </span>
        <span className="spacer" />
        {st > 0 && <span className="small streak">🔥 连续 {st} 天</span>}
        <span className="muted small">{api.micLabel && `麦克风：${api.micLabel}`}</span>
      </div>

      <div className="practice-body">
        <aside className="practice-list">
          <Btn className="primary routine-btn" onClick={() => void api.start("routine")} disabled={api.running}>
            ▶ 今日练习（约 12 分钟）
          </Btn>
          <p className="muted small">{ROUTINE.map((id) => EXERCISES.find((e) => e.id === id)!.name).join(" → ")}</p>
          <ul>
            {EXERCISES.map((e) => (
              <li key={e.id}>
                <Btn className={api.status.exercise === e.id ? "ex active" : "ex"} onClick={() => void api.start(e.id)} disabled={api.running} title={e.hint}>
                  <span>{e.name}</span>
                  <span className="muted small">{resultText(e.id) ?? (e.id === "range" && log.range ? `${noteName(log.range.low)}–${noteName(log.range.high)}` : "")}</span>
                </Btn>
              </li>
            ))}
          </ul>
        </aside>
        <Splitter id="practice-list-w" axis="x" target="prev" min={150} max={0.45} />

        <div className="practice-main">
          <div className="practice-step">
            <div className="step-big">{api.status.step}</div>
            <div className="muted small">
              {api.status.routine && `今日练习 ${api.status.routine.index} / ${api.status.routine.total} · `}
              {api.status.detail}
            </div>
          </div>
          <PracticeView api={api} range={range} />
          <div className="practice-readout">
            <span className="now-note">{Number.isFinite(api.live.midi) ? noteName(api.live.midi) : "—"}</span>
            {liveTarget && <span className="muted">目标 {noteName(liveTarget.midi)}</span>}
            {liveCents !== null && (
              <span className={Math.abs(liveCents) <= 25 ? "cents good" : Math.abs(liveCents) <= 50 ? "cents ok" : "cents bad"}>
                {liveCents > 0 ? "偏高" : liveCents < 0 ? "偏低" : "正好"} {Math.abs(liveCents)} 音分
              </span>
            )}
            <span className="spacer" />
            {api.running ? (
              <Btn className="ghost" onClick={api.stop}>
                停止
              </Btn>
            ) : null}
          </div>
          {api.error && <p className="error-text small">{api.error}</p>}
          {api.summary && <pre className="practice-summary">{api.summary}</pre>}
          <p className="muted small">戴耳机练：不然麦克风会把钢琴声也收进去。音名差八度也算对。</p>
        </div>
      </div>

      <div className="practice-progress">
        <div className="calendar" title="最近 30 天">
          {days.map((d) => (
            <span key={d.date} className={d.count >= 4 ? "day full" : d.count > 0 ? "day some" : "day"} title={`${d.date}：${d.count} 项`} />
          ))}
        </div>
        <Spark values={trend(log, "scale", "accuracy")} max={1} label="音阶准确率" unit="%" />
        <Spark values={trend(log, "breath", "breathSec")} max={60} label="气息" unit=" 秒" />
        <Spark values={trend(log, "sustain", "wobble")} max={80} label="长音抖动" unit="" />
      </div>
    </section>
  );
}
