import { useCallback, useEffect, useRef, useState } from "react";
import { type InputDevice, listInputs, pickDefaultInput, Recorder } from "../audio/recorder";
import { Btn, isTyping } from "../components/Btn";
import { MarkedText } from "../learn/MarkedText";
import "../App.css";
import "./testset.css";
import { encodeWav, KIND_HINT, KIND_LABEL, loadTestSet, nextOpen, progress, saveTake, skipItem, splitMistake, takeAudio, type TestSet } from "./testset";

/** 一句最长录多久（秒），忘了停也不会一直录 */
const MAX_SECONDS = 60;

type Phase = "idle" | "recording" | "saving";

/**
 * 录我的测试集（PRD 4.12）：一页一句，空格录 / 停，录完存成 wav + json；能重录、跳过、回听。
 * 只在测试模式里用：地址 ?test&testset
 */
export function TestSetRecorder() {
  const [set, setSet] = useState<TestSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [note, setNote] = useState<string | null>(null);
  const rec = useRef<Recorder | null>(null);
  const chunks = useRef<Float32Array[]>([]);
  const started = useRef(0);
  const player = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    loadTestSet()
      .then((s) => {
        setSet(s);
        setIndex(nextOpen(s.items, s.records, 0));
      })
      .catch((e) => setError(String(e)));
    return () => rec.current?.close();
  }, []);

  // 电平表和计时
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (rec.current?.isOpen) setLevel(rec.current.level());
      if (started.current) setElapsed((performance.now() - started.current) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const item = set?.items[index];
  const record = item ? set?.records[item.id] : undefined;

  const openMic = async (id?: string) => {
    if (!rec.current) rec.current = new Recorder(new AudioContext());
    await rec.current.open(id || undefined);
    const list = await listInputs();
    setDevices(list);
    if (!id) setDeviceId(list.find((d) => d.label === rec.current?.label)?.deviceId ?? pickDefaultInput(list)?.deviceId ?? "");
  };

  const stop = useCallback(async () => {
    const r = rec.current;
    if (!r || !set || !item) return;
    await r.stop();
    started.current = 0;
    // 时长按实际采样算（比按钮计时准）
    const seconds = chunks.current.reduce((s, c) => s + c.length, 0) / r.sampleRate;
    setPhase("saving");
    try {
      const wav = encodeWav(chunks.current, r.sampleRate);
      const saved = await saveTake(item.id, wav, { seconds, sampleRate: r.sampleRate, device: r.label });
      setSet((s) => (s ? { ...s, records: { ...s.records, [item.id]: saved } } : s));
      setNote(`存好了：${item.id}.wav，${seconds.toFixed(1)} 秒${saved.takes > 1 ? `（第 ${saved.takes} 次）` : ""}`);
    } catch (e) {
      setNote(`没存上：${String(e)}`);
    } finally {
      chunks.current = [];
      setPhase("idle");
    }
  }, [set, item]);

  const start = async () => {
    if (!item) return;
    setNote(null);
    player.current?.pause();
    try {
      if (!rec.current?.isOpen) await openMic(deviceId);
    } catch (e) {
      setNote(`打不开麦克风：${String(e)}`);
      return;
    }
    const r = rec.current!;
    chunks.current = [];
    r.start((c) => chunks.current.push(c.data));
    started.current = performance.now();
    setElapsed(0);
    setPhase("recording");
    // 测试模式的假麦克风（?fakemic）：录音时「唱」一个音，好检查存下来的文件
    if (new URLSearchParams(location.search).has("fakemic")) {
      window.dispatchEvent(new CustomEvent("banzou-practice-expect", { detail: { ctx: r.ctx, midi: 60, at: r.ctx.currentTime, dur: 1.2 } }));
    }
  };

  useEffect(() => {
    if (phase === "recording" && elapsed > MAX_SECONDS) void stop();
  }, [phase, elapsed, stop]);

  const go = (i: number) => {
    if (!set || phase !== "idle") return;
    player.current?.pause();
    setNote(null);
    setIndex(Math.max(0, Math.min(set.items.length - 1, i)));
  };

  const skip = async () => {
    if (!set || !item || phase !== "idle") return;
    const undo = record?.status === "skipped";
    try {
      const r = await skipItem(item.id, !undo);
      const records = { ...set.records };
      if (r) records[item.id] = r;
      else delete records[item.id];
      setSet({ ...set, records });
      if (!undo) setIndex(nextOpen(set.items, records, index));
      setNote(undo ? "取消跳过了" : `跳过了 ${item.id}`);
    } catch (e) {
      setNote(String(e));
    }
  };

  const listen = async () => {
    if (!item) return;
    try {
      const wav = await takeAudio(item.id);
      player.current?.pause();
      const url = URL.createObjectURL(new Blob([wav.slice().buffer], { type: "audio/wav" }));
      player.current = new Audio(url);
      player.current.onended = () => URL.revokeObjectURL(url);
      await player.current.play();
    } catch (e) {
      setNote(String(e));
    }
  };

  const toggle = () => {
    if (phase === "recording") void stop();
    else if (phase === "idle") void start();
  };

  // 快捷键：空格 录 / 停，→ 或回车 下一句，← 上一句
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey) return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowRight" || e.key === "Enter") go(index + 1);
      else if (e.key === "ArrowLeft") go(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (error)
    return (
      <div className="ts-page">
        <h2>我的测试集</h2>
        <p className="error-text">{error}</p>
        <p className="muted small">题目在「测试集」文件夹的 题目.json（和 app 文件夹同级），先用 做题目.py 生成。</p>
      </div>
    );
  if (!set || !item) return <div className="ts-page muted">正在读题目…</div>;

  const p = progress(set.items, set.records);
  const kindItems = set.items.filter((it) => it.kind === item.kind);
  const kindNo = kindItems.findIndex((it) => it.id === item.id) + 1;
  const [before, wrong, after] = splitMistake(item.say ?? "", item.mistake);

  return (
    <div className="ts-page">
      <header className="ts-head">
        <b>我的测试集{set.song ? ` ·《${set.song}》` : ""}</b>
        <span className="muted small">
          录好 {p.done} · 跳过 {p.skipped} · 还剩 {p.left} · 共 {Math.round(p.seconds)} 秒
        </span>
        <select className="ts-jump" value={index} onChange={(e) => go(Number(e.target.value))} disabled={phase !== "idle"} aria-label="跳到哪一题">
          {set.items.map((it, i) => (
            <option key={it.id} value={i}>
              {set.records[it.id]?.status === "done" ? "● " : set.records[it.id]?.status === "skipped" ? "– " : "○ "}
              {it.id}
            </option>
          ))}
        </select>
      </header>
      <div className="ts-bar" aria-hidden>
        {set.items.map((it, i) => (
          <span key={it.id} className={`ts-bar-seg ${set.records[it.id]?.status ?? ""} ${i === index ? "here" : ""}`} />
        ))}
      </div>

      <main className="ts-card">
        <div className="ts-kind">
          {KIND_LABEL[item.kind]} {kindNo} / {kindItems.length}
          <span className="muted"> · {item.id}</span>
        </div>
        <div className="ts-text">{item.kind === "ask" ? <MarkedText text={item.text} /> : item.text.split("\n").map((l, i) => <div key={i}>{l}</div>)}</div>
        {item.kind !== "ask" && item.say && (
          <div className="ts-say">
            {item.say.split("\n").length > 1
              ? item.say.split("\n").map((l, i) => <div key={i}>{l}</div>)
              : (
                <>
                  {before}
                  {wrong && <mark className="ts-wrong">{wrong}</mark>}
                  {after}
                </>
              )}
          </div>
        )}
        {item.mistake && (
          <div className="ts-mistake">
            这句故意念错：把「{item.mistake.word}」念成 <b>{item.mistake.wrong}</b>（正确是 {item.mistake.correct}）
          </div>
        )}
        <p className="muted small">{KIND_HINT[item.kind]}</p>

        <div className="ts-controls">
          <Btn className={phase === "recording" ? "primary ts-rec on" : "primary ts-rec"} onClick={toggle} disabled={phase === "saving"}>
            {phase === "recording" ? `停（${elapsed.toFixed(1)} 秒）` : phase === "saving" ? "正在存…" : record?.status === "done" ? "重录" : "录"}
          </Btn>
          <Btn className="ghost" onClick={() => void listen()} disabled={phase !== "idle" || record?.status !== "done"}>
            听一下
          </Btn>
          <Btn className="ghost" onClick={() => void skip()} disabled={phase !== "idle"}>
            {record?.status === "skipped" ? "取消跳过" : "跳过"}
          </Btn>
          <span className="ts-spacer" />
          <Btn className="ghost" onClick={() => go(index - 1)} disabled={phase !== "idle" || index === 0}>
            上一句
          </Btn>
          <Btn className="ghost" onClick={() => go(index + 1)} disabled={phase !== "idle" || index >= set.items.length - 1}>
            下一句
          </Btn>
        </div>
        <div className="ts-status small">
          {record?.status === "done" && phase === "idle" && !note && (
            <span className="muted">
              已录 {record.seconds.toFixed(1)} 秒（录了 {record.takes} 次），按「重录」会覆盖
            </span>
          )}
          {record?.status === "skipped" && phase === "idle" && !note && <span className="muted">跳过了</span>}
          {note && <span className={note.startsWith("没存上") || note.startsWith("打不开") ? "error-text" : "muted"}>{note}</span>}
        </div>
      </main>

      <footer className="ts-foot small muted">
        <span>
          麦克风：
          <select
            value={deviceId}
            onChange={(e) => {
              setDeviceId(e.target.value);
              void openMic(e.target.value).catch((err) => setNote(`打不开麦克风：${String(err)}`));
            }}
            disabled={phase !== "idle"}
          >
            {devices.length === 0 && <option value="">第一次录音时打开</option>}
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId} disabled={d.bluetooth}>
                {d.label}
                {d.bluetooth ? "（蓝牙，不能用）" : ""}
              </option>
            ))}
          </select>
        </span>
        <span className="ts-level" aria-label="输入电平">
          <span style={{ width: `${Math.min(100, Math.round(level * 140))}%` }} />
        </span>
        <span>空格 录 / 停 · → 下一句 · ← 上一句 · 存在 {set.dir}/录音</span>
      </footer>
    </div>
  );
}
