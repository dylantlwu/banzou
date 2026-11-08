import { useEffect, useRef, useState } from "react";
import {
  CALIBRATION_BEATS,
  CALIBRATION_INTERVAL,
  estimateLatencyMs,
} from "../audio/calibration";
import type { Settings } from "../settings";
import { Btn } from "./Btn";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
  libraryRoot: string | null;
  onChooseLibrary: () => void;
}

export function SettingsDialog({ settings, onChange, onClose, libraryRoot, onChooseLibrary }: Props) {
  const [calibrating, setCalibrating] = useState(false);

  useEffect(() => {
    if (calibrating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [calibrating, onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !calibrating && onClose()}>
      <div className="dialog" role="dialog" aria-label="设置">
        <h2>设置</h2>

        {calibrating ? (
          <Calibration
            onDone={(ms) => {
              onChange({ outputLatencyMs: ms });
              setCalibrating(false);
            }}
            onCancel={() => setCalibrating(false)}
          />
        ) : (
          <>
            <div className="field">
              <label>素材文件夹</label>
              <div className="field-row">
                <span className="path-full" title={libraryRoot ?? ""}>
                  {libraryRoot ?? "还没选"}
                </span>
                <Btn className="ghost" onClick={onChooseLibrary}>
                  换一个…
                </Btn>
              </div>
            </div>

            <div className="field">
              <label htmlFor="latency">耳机延迟</label>
              <div className="field-row">
                <input
                  id="latency"
                  type="number"
                  min={0}
                  max={600}
                  step={10}
                  value={settings.outputLatencyMs}
                  onChange={(e) => onChange({ outputLatencyMs: Number(e.target.value) || 0 })}
                />
                <span className="muted">ms</span>
                <Btn className="ghost" onClick={() => setCalibrating(true)}>
                  跟拍校准
                </Btn>
              </div>
              <p className="muted small">
                AirPods 一般 150–250ms，外放或有线耳机填 0。用来让歌词和耳朵听到的声音同步，打轴时也会自动扣掉。换耳机后重新校准。
              </p>
            </div>

            <div className="field">
              <label htmlFor="reaction">打轴反应时间</label>
              <div className="field-row">
                <input
                  id="reaction"
                  type="number"
                  min={0}
                  max={400}
                  step={10}
                  value={settings.reactionMs}
                  onChange={(e) => onChange({ reactionMs: Number(e.target.value) || 0 })}
                />
                <span className="muted">ms</span>
              </div>
              <p className="muted small">按空格通常比真正开唱晚一点。打出来整体偏晚就调大，偏早就调小。</p>
            </div>

            <div className="dialog-actions">
              <Btn className="primary" onClick={onClose}>
                完成
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

type CalPhase = "ready" | "running" | "result";

/** 跟拍校准：耳机里响 10 下节拍，跟着按空格（PRD 4.4，不需要麦克风） */
function Calibration({ onDone, onCancel }: { onDone: (ms: number) => void; onCancel: () => void }) {
  const [phase, setPhase] = useState<CalPhase>("ready");
  const [tapCount, setTapCount] = useState(0);
  const [result, setResult] = useState<number | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const clicksRef = useRef<number[]>([]);
  const tapsRef = useRef<number[]>([]);
  const timerRef = useRef<number | undefined>(undefined);

  const cleanup = () => {
    window.clearTimeout(timerRef.current);
    void ctxRef.current?.close();
    ctxRef.current = null;
  };
  useEffect(() => cleanup, []);

  const start = async () => {
    cleanup();
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    await ctx.resume();
    const t0 = ctx.currentTime + 0.8;
    const clicks = Array.from({ length: CALIBRATION_BEATS }, (_, i) => t0 + i * CALIBRATION_INTERVAL);
    for (const [i, t] of clicks.entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = i === 0 ? 1500 : 1000;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.5, t + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.08);
    }
    clicksRef.current = clicks;
    tapsRef.current = [];
    setTapCount(0);
    setPhase("running");
    const endIn = (clicks[clicks.length - 1] + CALIBRATION_INTERVAL - ctx.currentTime) * 1000;
    timerRef.current = window.setTimeout(() => {
      setResult(estimateLatencyMs(clicksRef.current, tapsRef.current));
      setPhase("result");
      cleanup();
    }, endIn);
  };

  useEffect(() => {
    if (phase !== "running") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.code !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        cleanup();
        setPhase("ready");
        return;
      }
      if (e.repeat || !ctxRef.current) return;
      tapsRef.current.push(ctxRef.current.currentTime);
      setTapCount(tapsRef.current.length);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase]);

  return (
    <div className="calibration">
      {phase === "ready" && (
        <>
          <p>戴上平时用的耳机（比如 AirPods）。点开始后耳机里会响 {CALIBRATION_BEATS} 下节拍，每听到一下就按一次空格。</p>
          <p className="muted small">闭上眼睛跟着声音按，别看屏幕。前两下用来找节奏，不计入。</p>
          <div className="dialog-actions">
            <Btn className="ghost" onClick={onCancel}>
              取消
            </Btn>
            <Btn className="primary" onClick={() => void start()}>
              开始
            </Btn>
          </div>
        </>
      )}
      {phase === "running" && (
        <>
          <p>跟着节拍按空格…</p>
          <p className="muted small">已按 {tapCount} 下 · Esc 取消</p>
        </>
      )}
      {phase === "result" && (
        <>
          {result === null ? (
            <p>有效按键太少，没测出来，再试一次。</p>
          ) : (
            <p>
              测得耳机延迟约 <strong>{result} ms</strong>
            </p>
          )}
          <div className="dialog-actions">
            <Btn className="ghost" onClick={onCancel}>
              取消
            </Btn>
            <Btn className="ghost" onClick={() => void start()}>
              重测
            </Btn>
            {result !== null && (
              <Btn className="primary" onClick={() => onDone(result)}>
                使用这个结果
              </Btn>
            )}
          </div>
        </>
      )}
    </div>
  );
}
