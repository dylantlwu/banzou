/**
 * 练声的流程引擎（PRD 4.8）：给音、等你唱、打分、记成绩。
 * 用自己的 AudioContext 和麦克风（和播放歌曲分开），麦克风帧来自 practiceWorklet。
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { isBluetoothLabel, listInputs, pickDefaultInput } from "../audio/recorder";
import type { Settings } from "../settings";
import {
  type ExerciseId,
  type Grade,
  type Range,
  EXERCISES,
  ROUTINE,
  breathStats,
  foldToTarget,
  grade,
  matchQuestions,
  noteName,
  roundNotes,
  roundRoots,
  scoreNote,
  stableNote,
  sustainStats,
} from "./exercises";
import type { PitchFrame } from "./pitchTracker";
import type { ExerciseResult } from "./practiceLog";
import practiceUrl from "./practiceWorklet.ts?worker&url";
import { playChord, playNote } from "./tones";

export interface Target {
  midi: number;
  start: number;
  end: number;
  grade?: Grade;
  cents?: number | null;
}

export interface Status {
  exercise: ExerciseId | null;
  /** 大字提示：现在要做什么 */
  step: string;
  detail?: string;
  /** 每日练习进度：第几项 / 共几项 */
  routine?: { index: number; total: number };
}

const NOTE_DUR = 0.6;
const IDLE: Status = { exercise: null, step: "选一个练习，或者直接开始今日练习" };

class Cancelled extends Error {}

interface Options {
  settings: Settings;
  range: Range;
  onResult: (id: ExerciseId, r: ExerciseResult, minutes: number) => void;
  onRange: (r: Range) => void;
}

export function usePractice({ settings, range, onResult, onRange }: Options) {
  const [status, setStatus] = useState<Status>(IDLE);
  const [running, setRunning] = useState(false);
  const [targets, setTargets] = useState<Target[]>([]);
  const [summary, setSummaryState] = useState<string | null>(null);
  const summaryRef = useRef<string | null>(null);
  const setSummary = (text: string | null) => {
    summaryRef.current = text;
    setSummaryState(text);
  };
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<{ midi: number; rms: number }>({ midi: NaN, rms: 0 });
  const [micLabel, setMicLabel] = useState("");

  const ctxRef = useRef<AudioContext | null>(null);
  const outRef = useRef<GainNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const framesRef = useRef<PitchFrame[]>([]);
  const tokenRef = useRef(0);
  const latencyRef = useRef(0.15);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const now = useCallback(() => ctxRef.current?.currentTime ?? 0, []);
  // 测试模式：把分析帧暴露出来方便检查
  if ((window as unknown as { __BANZOU_TEST__?: boolean }).__BANZOU_TEST__) {
    (window as unknown as { __practice: unknown }).__practice = { frames: () => framesRef.current, now };
  }

  // ---------- 声音和麦克风 ----------
  const ensureAudio = useCallback(async () => {
    if (!ctxRef.current) {
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      await ctx.audioWorklet.addModule(practiceUrl);
    }
    const ctx = ctxRef.current;
    await ctx.resume();
    if (!outRef.current) {
      outRef.current = ctx.createGain();
      outRef.current.connect(ctx.destination);
    }
    if (!streamRef.current) {
      const inputs = await listInputs().catch(() => []);
      const mic = inputs.find((d) => d.deviceId === settings.liveMicId && !d.bluetooth) ?? pickDefaultInput(inputs);
      if (!mic) throw new Error("没有找到可用的麦克风（蓝牙耳机的麦克风不能用）。接好麦克风再来练。");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: mic.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      const label = stream.getAudioTracks()[0]?.label ?? "";
      if (isBluetoothLabel(label)) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error("不能用蓝牙耳机（AirPods）的麦克风练声，请换外接麦克风。");
      }
      streamRef.current = stream;
      setMicLabel(label);
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "banzou-practice", { numberOfInputs: 1, numberOfOutputs: 0 });
      node.port.onmessage = (e) => {
        const frames = e.data as PitchFrame[];
        const all = framesRef.current;
        all.push(...frames);
        // 只留最近 90 秒
        const cut = all.findIndex((f) => f.t > frames[frames.length - 1].t - 90);
        if (cut > 0) all.splice(0, cut);
        const last = frames[frames.length - 1];
        setLive({ midi: last.midi, rms: last.rms });
      };
      src.connect(node);
      nodeRef.current = node;
      // 往返延迟：和录音用同一个校准值
      const route = await invoke<{ output?: { name: string } }>("audio_route").catch(() => null);
      const name = route?.output?.name || "默认输出";
      latencyRef.current = (settings.recordLatency[name] ?? settings.outputLatencyMs + 10) / 1000;
    }
    return ctx;
  }, [settings.liveMicId, settings.recordLatency, settings.outputLatencyMs]);

  const closeAudio = useCallback(() => {
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    outRef.current = null;
    framesRef.current = [];
  }, []);
  useEffect(() => closeAudio, [closeAudio]);

  // ---------- 流程工具 ----------
  const check = (token: number) => {
    if (token !== tokenRef.current) throw new Cancelled();
  };
  const sleep = async (token: number, sec: number) => {
    const end = performance.now() + sec * 1000;
    while (performance.now() < end) {
      check(token);
      await new Promise((r) => setTimeout(r, Math.min(100, end - performance.now())));
    }
    check(token);
  };
  /** 等到音频时钟到 t */
  const until = async (token: number, t: number) => {
    while (now() < t) {
      check(token);
      await new Promise((r) => setTimeout(r, 30));
    }
    check(token);
  };
  /** 告诉测试模式的「假歌手」这段时间该唱什么（正式 app 里没人监听） */
  const expect = (midi: number | null, at: number, dur: number) =>
    globalThis.dispatchEvent?.(new CustomEvent("banzou-practice-expect", { detail: { ctx: ctxRef.current, midi, at, dur } }));
  const framesBetween = (a: number, b: number) => framesRef.current.filter((f) => f.t >= a && f.t <= b);

  // ---------- 各个练习 ----------
  const runPattern = async (token: number, id: ExerciseId, limitSec: number | null): Promise<ExerciseResult | null> => {
    const def = EXERCISES.find((e) => e.id === id)!;
    const pattern = def.pattern!;
    let roots = roundRoots(pattern, rangeRef.current);
    const roundDur = 1.2 + pattern.length * NOTE_DUR;
    if (limitSec) roots = roots.slice(0, Math.max(2, Math.floor(limitSec / roundDur)));
    const ctx = ctxRef.current!;
    const out = outRef.current!;
    const cents: number[] = [];
    const grades: Grade[] = [];
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      setStatus((s) => ({ ...s, step: def.hint, detail: `第 ${i + 1} / ${roots.length} 轮 · ${noteName(root)} 起` }));
      const t0 = now() + 0.25;
      playChord(ctx, out, root, t0, 0.8);
      const notes = roundNotes(root, pattern, t0 + 1.0, NOTE_DUR);
      for (const n of notes) {
        playNote(ctx, out, n.midi, n.start, NOTE_DUR * 0.92, 0.38);
        expect(n.midi, n.start, NOTE_DUR * 0.95);
      }
      // 上一轮打好分的音留在画面上（画面只显示最近几秒），新一轮接在后面
      setTargets((old) => [...old.filter((x) => x.end > now() - 8), ...notes]);
      await until(token, notes[notes.length - 1].end + latencyRef.current + 0.15);
      const scored = notes.map((n) => {
        const c = scoreNote(framesRef.current, n, latencyRef.current);
        return { ...n, cents: c, grade: grade(c) };
      });
      setTargets((old) => old.map((x) => scored.find((n) => n.start === x.start && n.midi === x.midi) ?? x));
      for (const n of scored) {
        grades.push(n.grade!);
        if (n.cents !== null && n.cents !== undefined) cents.push(Math.abs(n.cents));
      }
    }
    const total = grades.length;
    const accuracy = total ? (grades.filter((g) => g === "good").length + 0.5 * grades.filter((g) => g === "ok").length) / total : 0;
    const avgCents = cents.length ? Math.round(cents.reduce((a, b) => a + b, 0) / cents.length) : undefined;
    setSummary(`${def.name}：准 ${Math.round(accuracy * 100)}%${avgCents !== undefined ? ` · 平均偏差 ${avgCents} 音分` : ""}${grades.includes("miss") ? ` · 漏唱 ${grades.filter((g) => g === "miss").length} 个音` : ""}`);
    return { at: new Date().toISOString(), accuracy: Math.round(accuracy * 100) / 100, avgCents };
  };

  const runSustain = async (token: number): Promise<ExerciseResult | null> => {
    const r = rangeRef.current;
    const span = r.high - r.low;
    const notes = [Math.round(r.low + span * 0.3), Math.round(r.low + span * 0.5), Math.round(r.low + span * 0.7)];
    const ctx = ctxRef.current!;
    const stats = [];
    for (let i = 0; i < notes.length; i++) {
      const m = notes[i];
      setStatus((s) => ({ ...s, step: "听这个音，然后稳稳地唱 8 秒", detail: `第 ${i + 1} / 3 个 · ${noteName(m)}` }));
      const t0 = now() + 0.3;
      playNote(ctx, outRef.current!, m, t0, 1.0, 0.45);
      const hold = { midi: m, start: t0 + 1.2, end: t0 + 9.2 };
      expect(m, hold.start, 8);
      setTargets([hold]);
      await until(token, hold.end + latencyRef.current + 0.1);
      const s = sustainStats(framesRef.current, m, hold.start + latencyRef.current + 0.5, hold.end + latencyRef.current);
      setTargets([{ ...hold, cents: s?.meanCents ?? null, grade: grade(s ? s.meanCents : null) }]);
      if (s) stats.push(s);
      await sleep(token, 0.8);
    }
    if (!stats.length) {
      setSummary("长音：没听到你唱，检查麦克风再试一次");
      return null;
    }
    const wobble = Math.round(stats.reduce((a, s) => a + s.wobble, 0) / stats.length);
    const avgCents = Math.round(stats.reduce((a, s) => a + Math.abs(s.meanCents), 0) / stats.length);
    setSummary(`长音：平均偏差 ${avgCents} 音分 · 抖动 ${wobble} 音分（越小越稳，20 以内很好）`);
    return { at: new Date().toISOString(), avgCents, wobble };
  };

  const runBreath = async (token: number): Promise<ExerciseResult | null> => {
    let best: { seconds: number; steadiness: number } | null = null;
    setTargets([]);
    for (let attempt = 1; attempt <= 2; attempt++) {
      setStatus((s) => ({ ...s, step: "先保持安静 1 秒", detail: `第 ${attempt} / 2 次` }));
      const q0 = now();
      await sleep(token, 1.2);
      const quiet = framesBetween(q0, now()).map((f) => f.rms).sort((a, b) => a - b);
      const noise = quiet[Math.floor(quiet.length / 2)] ?? 0.001;
      setStatus((s) => ({ ...s, step: "慢慢吸满气……" }));
      await sleep(token, 2.5);
      setStatus((s) => ({ ...s, step: "嘶————（发不出来了就停）" }));
      const start = now();
      expect(null, start + 0.3, 12);
      // 开始出声后，安静超过 1.5 秒就结束；最多 60 秒
      let started = false;
      let lastLoud = start;
      while (now() - start < 60) {
        await sleep(token, 0.1);
        const recent = framesBetween(now() - 0.15, now());
        const loud = recent.some((f) => f.rms >= Math.max(0.006, noise * 3));
        if (loud) {
          started = true;
          lastLoud = now();
        }
        const st = breathStats(framesBetween(start, now()), noise);
        setStatus((s) => ({ ...s, detail: `第 ${attempt} / 2 次 · ${st.seconds.toFixed(1)} 秒` }));
        if ((started && now() - lastLoud > 1.5) || (!started && now() - start > 8)) break;
      }
      const st = breathStats(framesBetween(start, now()), noise);
      if (!best || st.seconds > best.seconds) best = st;
      setSummary(`这次 ${st.seconds} 秒 · 稳定度 ${Math.round(st.steadiness * 100)}%`);
      await sleep(token, 1.5);
    }
    if (!best || best.seconds < 1) {
      setSummary("气息：没听到嘶声，检查麦克风再试一次");
      return null;
    }
    setSummary(`气息：最长 ${best.seconds} 秒 · 稳定度 ${Math.round(best.steadiness * 100)}%（目标先到 20 秒，再到 30 秒）`);
    return { at: new Date().toISOString(), breathSec: best.seconds, steadiness: best.steadiness };
  };

  const runMatch = async (token: number): Promise<ExerciseResult | null> => {
    const qs = matchQuestions(rangeRef.current, 10);
    const ctx = ctxRef.current!;
    const results: (number | null)[] = [];
    for (let i = 0; i < qs.length; i++) {
      const m = qs[i];
      setStatus((s) => ({ ...s, step: "听音，然后唱出同一个音", detail: `第 ${i + 1} / ${qs.length} 题` }));
      const t0 = now() + 0.3;
      playNote(ctx, outRef.current!, m, t0, 1.0, 0.45);
      const answer = { midi: m, start: t0 + 1.3, end: t0 + 3.8 };
      expect(m, answer.start, 2.5);
      setTargets([{ ...answer }]);
      await until(token, answer.end + latencyRef.current + 0.1);
      const sung = framesBetween(answer.start + latencyRef.current + 0.4, answer.end + latencyRef.current)
        .filter((f) => Number.isFinite(f.midi))
        .map((f) => foldToTarget(f.midi, m))
        .sort((a, b) => a - b);
      const c = sung.length > 60 ? Math.round((sung[Math.floor(sung.length / 2)] - m) * 100) : null;
      results.push(c);
      setTargets([{ ...answer, cents: c, grade: grade(c) }]);
      await sleep(token, 0.6);
    }
    const answered = results.filter((c): c is number => c !== null);
    const accuracy = results.length ? (results.filter((c) => grade(c) === "good").length + 0.5 * results.filter((c) => grade(c) === "ok").length) / results.length : 0;
    const avgCents = answered.length ? Math.round(answered.reduce((a, c) => a + Math.abs(c), 0) / answered.length) : undefined;
    setSummary(`听音模唱：准 ${Math.round(accuracy * 100)}%${avgCents !== undefined ? ` · 平均偏差 ${avgCents} 音分` : ""}`);
    return { at: new Date().toISOString(), accuracy: Math.round(accuracy * 100) / 100, avgCents };
  };

  const runRange = async (token: number): Promise<ExerciseResult | null> => {
    setTargets([]);
    const find = async (label: string, midi: number) => {
      setStatus((s) => ({ ...s, step: `唱一个你舒服的${label}，稳住 1.5 秒`, detail: "用「啊」唱，别硬挤" }));
      const start = now();
      expect(midi, start + 0.5, 3);
      while (now() - start < 25) {
        await sleep(token, 0.2);
        const m = stableNote(framesBetween(start, now()));
        if (m !== null) return m;
      }
      return null;
    };
    const low = await find("最低音", 48);
    if (low === null) {
      setSummary("没测到稳定的低音，再试一次");
      return null;
    }
    setSummary(`最低音 ${noteName(low)}`);
    await sleep(token, 1);
    const high = await find("最高音", 72);
    if (high === null || high <= low + 4) {
      setSummary("没测到稳定的高音，再试一次");
      return null;
    }
    onRange({ low, high });
    setSummary(`你的音域：${noteName(low)} – ${noteName(high)}（${high - low} 个半音）。之后的练习都只在这个范围里走`);
    return { at: new Date().toISOString() };
  };

  const runOne = async (token: number, id: ExerciseId, limitSec: number | null) => {
    switch (id) {
      case "range":
        return runRange(token);
      case "breath":
        return runBreath(token);
      case "sustain":
        return runSustain(token);
      case "match":
        return runMatch(token);
      default:
        return runPattern(token, id, limitSec);
    }
  };

  // ---------- 对外 ----------
  const start = useCallback(
    async (which: ExerciseId | "routine") => {
      const token = ++tokenRef.current;
      setError(null);
      setSummary(null);
      setRunning(true);
      try {
        await ensureAudio();
        const list = which === "routine" ? ROUTINE : [which];
        const summaries: string[] = [];
        for (let i = 0; i < list.length; i++) {
          const id = list[i];
          const def = EXERCISES.find((e) => e.id === id)!;
          setStatus({ exercise: id, step: `准备：${def.name}`, detail: def.hint, routine: which === "routine" ? { index: i + 1, total: list.length } : undefined });
          if (which === "routine") await sleep(token, 2.5);
          const t0 = performance.now();
          const r = await runOne(token, id, which === "routine" ? def.routineSeconds : null);
          if (r && id !== "range") onResult(id, r, (performance.now() - t0) / 60000);
          if (which === "routine") {
            if (summaryRef.current) summaries.push(summaryRef.current);
            await sleep(token, 1.5);
          }
        }
        if (which === "routine") setSummary(`今日练习完成 🎉\n${summaries.join("\n")}`);
        setStatus(IDLE);
      } catch (e) {
        if (!(e instanceof Cancelled)) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus(IDLE);
        }
      } finally {
        if (token === tokenRef.current) {
          setRunning(false);
          setTargets([]);
        }
      }
    },
    [ensureAudio, onResult],
  );

  const stop = useCallback(() => {
    tokenRef.current++;
    // 停掉已经排好的钢琴音
    outRef.current?.disconnect();
    outRef.current = null;
    setRunning(false);
    setTargets([]);
    setStatus(IDLE);
  }, []);

  return {
    status,
    running,
    targets,
    summary,
    error,
    live,
    micLabel,
    now,
    latency: () => latencyRef.current,
    frames: () => framesRef.current,
    start,
    stop,
    close: closeAudio,
  };
}

export type PracticeApi = ReturnType<typeof usePractice>;
