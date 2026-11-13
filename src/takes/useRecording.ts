/**
 * 录唱流程（PRD 4.4）：准备（选麦克风、电平、耳机检测、延迟校准）→ 录 2 秒环境底噪 → 倒数 →
 * 跟着伴奏录 → 存盘 → 按原唱自动对齐 → 存成新的 Take（补录时生成「原来那遍 + 新补的一段」）。
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TimelineEvent } from "../audio/engine";
import { estimateLagSpans, envelopeOf, measureRoundTrip } from "../audio/recordAlign";
import { type InputDevice, Recorder, floatsToBase64, listInputs, pickDefaultInput } from "../audio/recorder";
import type { Player } from "../player/usePlayer";
import type { Settings } from "../settings";
import type { Song } from "../types";
import { formatTime } from "../utils/time";
import { AUTO_STOP_NOTICE, overRecordLimit } from "./recordGuard";
import { clipsFromSpans, coveredSeconds, overlay, spansFromEvents } from "./recordSpans";
import { type Take, newTakeId, nextTakeName, punchIn } from "./takes";
import type { TakesApi } from "./useTakes";

export type RecPhase = "idle" | "opening" | "prep" | "noise" | "countdown" | "recording" | "saving" | "calibrating";
export type RecRange = "whole" | "here" | "punch";

export interface AudioRoute {
  output?: { name: string; kind: string };
  input?: { name: string; kind: string };
}

const NOISE_SECONDS = 2;
const COUNTDOWN = 3;
const PUNCH_PREROLL = 2;
/** 自动对齐的可信度门槛 */
const MIN_CONFIDENCE = 1.3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

interface Options {
  /** 当前伴奏升降了几个半音（记进 Take） */
  transpose: number;
  player: Player;
  song: Song | null;
  takes: TakesApi;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
}

export function useRecording({ player, song, takes, settings, updateSettings, transpose }: Options) {
  const [phase, setPhase] = useState<RecPhase>("idle");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inputs, setInputs] = useState<InputDevice[]>([]);
  const [deviceId, setDeviceIdState] = useState<string | null>(null);
  const [route, setRoute] = useState<AudioRoute | null>(null);
  const [range, setRange] = useState<RecRange>("whole");
  const [countdown, setCountdown] = useState(0);
  const [level, setLevel] = useState(0);
  const [inputWarning, setInputWarning] = useState<string | null>(null);
  const [monitor, setMonitorState] = useState(false);

  const recorderRef = useRef<Recorder | null>(null);
  const recorder = useCallback(() => (recorderRef.current ??= new Recorder(player.context())), [player]);
  const cancelRef = useRef(false);
  const stopRef = useRef<(() => void) | null>(null);

  const routeName = route?.output?.name || "默认输出";
  const calibrated = routeName in settings.recordLatency;
  const latencyMs = settings.recordLatency[routeName] ?? settings.outputLatencyMs + 10;
  const outputKind = route?.output?.kind ?? "unknown";

  // ---------- 准备 ----------
  const refreshRoute = useCallback(async () => {
    const r = await invoke<AudioRoute>("audio_route").catch(() => null);
    setRoute(r);
    return r;
  }, []);

  const openDevice = useCallback(
    async (id: string | null) => {
      setPhase("opening");
      setError(null);
      try {
        await recorder().open(id ?? undefined);
        const list = await listInputs();
        setInputs(list);
        // 第一次打开时系统可能给的是蓝牙或别的设备：换成推荐的那个
        const current = list.find((d) => d.label === recorder().label);
        const preferred = pickDefaultInput(list);
        if (!id && preferred && current?.deviceId !== preferred.deviceId) {
          await recorder().open(preferred.deviceId);
          setDeviceIdState(preferred.deviceId);
        } else {
          setDeviceIdState(current?.deviceId ?? id);
        }
        setPhase("prep");
      } catch (e) {
        const msg = e instanceof Error ? `${e.message}` : String(e);
        setError(/NotAllowed|denied|Permission/i.test(msg) ? "没有麦克风权限：请到「系统设置 → 隐私与安全性 → 麦克风」里打开「波点」" : msg);
        setPhase("prep");
      }
    },
    [recorder],
  );

  const openPrep = useCallback(async () => {
    setNotice(null);
    void refreshRoute();
    await openDevice(deviceId);
  }, [refreshRoute, openDevice, deviceId]);

  const setDeviceId = useCallback((id: string) => void openDevice(id), [openDevice]);

  const close = useCallback(() => {
    cancelRef.current = true;
    recorderRef.current?.close();
    setMonitorState(false);
    setPhase("idle");
    setError(null);
    setInputWarning(null);
  }, []);

  // 换歌、卸载时关掉麦克风
  useEffect(() => close, [song?.id, close]);
  useEffect(() => () => recorderRef.current?.close(), []);

  // 电平表 + 输入异常检测
  useEffect(() => {
    if (phase === "idle" || phase === "opening") return;
    let raf = 0;
    let pinnedSince = 0;
    let silentSince = 0;
    const tick = () => {
      const v = recorderRef.current?.level() ?? 0;
      setLevel(v);
      const now = performance.now();
      pinnedSince = v > 0.99 ? pinnedSince || now : 0;
      silentSince = v < 0.0005 ? silentSince || now : 0;
      setInputWarning(
        pinnedSince && now - pinnedSince > 1500
          ? "输入一直满格：这个输入可能没接麦克风（比如扩展坞的音频口），请换一个输入"
          : silentSince && now - silentSince > 3000
            ? "麦克风没有声音：检查是否选对了输入、麦克风有没有静音"
            : null,
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  const setMonitor = useCallback((on: boolean) => {
    recorderRef.current?.setMonitor(on);
    setMonitorState(on);
  }, []);

  // ---------- 原唱起音曲线（自动对齐用），每首歌算一次 ----------
  const refEnvRef = useRef<{ buffer: AudioBuffer; env: Float32Array } | null>(null);
  const refEnvelope = useCallback(() => {
    const buf = player.getBuffer("vocal");
    if (!buf) return null;
    if (refEnvRef.current?.buffer !== buf) {
      const ch = buf.getChannelData(0);
      refEnvRef.current = { buffer: buf, env: envelopeOf(ch, buf.sampleRate) };
    }
    return refEnvRef.current.env;
  }, [player]);

  // ---------- 录音 ----------
  const start = useCallback(async () => {
    if (!song || !player.ready || !recorderRef.current?.isOpen) return;
    const parent = takes.selected;
    const loop = player.loop;
    if (range === "punch" && (!loop || !parent)) {
      setError("补录要先选中一遍录音，并用 A / B 设好要补的区间");
      return;
    }
    cancelRef.current = false;
    setError(null);
    setNotice(null);
    const rec = recorderRef.current;
    const sampleRate = rec.sampleRate;
    const latency = latencyMs;

    player.pause();
    player.setRate(1);
    // 录音时不循环（补录区间照样用 loop 记着），录完恢复
    player.setLoop(null);
    const restoreLoop = () => player.setLoop(loop);
    const target = range === "whole" ? 0 : range === "here" ? player.getPosition() : Math.max(0, loop!.a - PUNCH_PREROLL);
    player.seekTo(target);
    player.setGain("take", 0);

    let part: string;
    try {
      part = await invoke<string>("rec_begin", { title: song.title, sampleRate });
    } catch (e) {
      setError(String(e));
      return;
    }

    const all: Float32Array[] = [];
    let pending: Float32Array[] = [];
    let pendingLen = 0;
    let firstTime: number | null = null;
    let writing: Promise<unknown> = Promise.resolve();
    const flush = () => {
      if (pendingLen === 0) return;
      const data = floatsToBase64(concat(pending));
      pending = [];
      pendingLen = 0;
      writing = writing.then(() => invoke("rec_append", { path: part, data }));
    };
    rec.start(({ time, data }) => {
      if (firstTime === null) firstTime = time;
      all.push(data);
      pending.push(data);
      pendingLen += data.length;
      if (pendingLen >= sampleRate) flush();
    });

    const abort = async (message: string | null) => {
      restoreLoop();
      await rec.stop();
      await writing.catch(() => {});
      await invoke("rec_discard", { path: part }).catch(() => {});
      player.setGain("take", settings.myVoiceVolume);
      setPhase(recorderRef.current?.isOpen ? "prep" : "idle");
      if (message) setError(message);
    };

    // 环境底噪
    setPhase("noise");
    await sleep(NOISE_SECONDS * 1000);
    if (cancelRef.current) return abort(null);
    // 倒数
    setPhase("countdown");
    for (let n = COUNTDOWN; n > 0; n--) {
      setCountdown(n);
      await sleep(1000);
      if (cancelRef.current) return abort(null);
    }
    // 录音中途跳转（±5 秒、点歌词）或暂停：记下来，存的时候切成几段，各自对齐
    const timeline: TimelineEvent[] = [];
    let reachedEnd = false;
    const unlisten = player.onTimeline((e) => {
      timeline.push(e);
      // 播到结尾时播放器会自己暂停、回到 0
      if (e.kind === "pause" && e.prev >= player.duration - 0.05) reachedEnd = true;
    });
    const info = await player.playWithClock();
    if (!info) {
      unlisten();
      return abort("伴奏没能开始播放");
    }
    setPhase("recording");

    // 等停止：手动停、播到结尾、补录播过 B 之后 0.5 秒；
    // 暂停了伴奏又忘了停：从开始录算起超过 歌长 + 30 秒自动停（照常保存）
    const recStartedAt = performance.now();
    let autoStopped = false;
    await new Promise<void>((resolve) => {
      const timer = window.setInterval(() => {
        const pos = player.getPosition();
        const ended = range === "punch" ? pos >= loop!.b + 0.5 : reachedEnd || pos >= player.duration - 0.05;
        if (!ended && overRecordLimit((performance.now() - recStartedAt) / 1000, player.duration)) autoStopped = true;
        if (ended || autoStopped || cancelRef.current) finish();
      }, 100);
      const finish = () => {
        window.clearInterval(timer);
        resolve();
      };
      stopRef.current = finish;
    });
    stopRef.current = null;
    unlisten();
    const stopPos = reachedEnd ? player.duration : Math.min(player.getPosition(), player.duration);
    player.pause();
    restoreLoop();
    setPhase("saving");
    await rec.stop();
    if (cancelRef.current) return abort(null);
    flush();

    try {
      await writing;
      const finalPath = await invoke<string>("rec_finish", { path: part });
      const file = finalPath.split("/").pop()!;
      const samples = concat(all);
      const t0 = firstTime ?? info.at;
      const spans = spansFromEvents(timeline.length ? timeline : [{ kind: "play" as const, ...info, prev: info.offset }], stopPos);
      const punchRange: [number, number] | undefined = range === "punch" ? [loop!.a, loop!.b] : undefined;
      const raw = clipsFromSpans(spans, { file, t0, latency: latency / 1000, window: punchRange });
      if (coveredSeconds(raw) < 1) {
        await invoke("trash_takes", { title: song.title, files: [file] }).catch(() => {});
        setPhase("prep");
        setError(autoStopped ? `${AUTO_STOP_NOTICE}。录到的太短了，没有保存` : "录得太短了，没有保存");
        player.setGain("take", settings.myVoiceVolume);
        return;
      }

      // 按原唱自动对齐
      let autoAlignMs = 0;
      let alignStatus: "none" | "ok" | "unsure" = "none";
      let shift = 0;
      const ref = refEnvelope();
      if (ref) {
        const lag = estimateLagSpans(
          envelopeOf(samples, sampleRate),
          ref,
          raw.map((c) => ({ recStart: c.start, from: c.from, to: c.to })),
        );
        alignStatus = "unsure";
        if (lag && lag.confidence >= MIN_CONFIDENCE) {
          shift = lag.shift;
          autoAlignMs = Math.round(lag.shift * 1000);
          alignStatus = "ok";
        }
      }
      const clips = clipsFromSpans(spans, { file, t0, latency: latency / 1000, shift, autoAlignMs, window: punchRange });
      const from = clips[0].from;

      const noiseEnd = Math.min(NOISE_SECONDS, info.at - t0 - COUNTDOWN) - 0.1;
      let take: Take;
      if (range === "punch" && parent) {
        const adjust = parent.adjustMs / 1000;
        const own = clips.map((c) => ({ ...c, start: c.start - adjust }));
        take = {
          id: newTakeId(),
          name: `${parent.name} · 补录 ${formatTime(loop!.a)}–${formatTime(loop!.b)}`,
          createdAt: new Date().toISOString(),
          starred: false,
          // 补录中途没跳转：和以前一样整段 A-B 换成新录的；跳转过：新录到的部分盖上去
          clips: own.length === 1 ? punchIn(parent, own[0], [loop!.a, loop!.b]) : overlay(parent.clips, own),
          latencyMs: latency,
          adjustMs: parent.adjustMs,
          noise: parent.noise ?? (noiseEnd > 0.5 ? { file, from: 0.1, to: noiseEnd } : undefined),
          parentId: parent.id,
          range: [loop!.a, loop!.b],
          deviceLabel: rec.label,
          transpose: parent.transpose ?? transpose,
        };
      } else {
        take = {
          id: newTakeId(),
          name: nextTakeName(takes.takes),
          createdAt: new Date().toISOString(),
          starred: false,
          clips,
          latencyMs: latency,
          adjustMs: 0,
          noise: noiseEnd > 0.5 ? { file, from: 0.1, to: noiseEnd } : undefined,
          deviceLabel: rec.label,
          transpose,
        };
      }
      await takes.add(take);
      player.setGain("take", settings.myVoiceVolume);
      setNotice(
        (autoStopped ? `${AUTO_STOP_NOTICE}。` : "") +
          `已保存「${take.name}」` +
          (alignStatus === "ok"
            ? autoAlignMs
              ? `，按原唱自动对齐 ${autoAlignMs > 0 ? "+" : ""}${autoAlignMs}ms`
              : "，和原唱对得很准"
            : alignStatus === "unsure"
              ? "。没能按原唱自动对齐（唱的部分太短，或和原唱差别太大），需要的话在录音列表里手动微调"
              : "") +
          (Math.abs(autoAlignMs) > 50 ? "。偏差有点大，可以在录音列表里微调；常这样的话重新校准一下延迟" : ""),
      );
      player.seekTo(from);
      setPhase("prep");
    } catch (e) {
      setError(`保存录音失败：${e instanceof Error ? e.message : String(e)}`);
      setPhase("prep");
    }
  }, [song, player, takes, range, latencyMs, settings.myVoiceVolume, refEnvelope, transpose]);

  const stop = useCallback(() => {
    if (phaseRef.current === "recording") stopRef.current?.();
    else if (phaseRef.current === "noise" || phaseRef.current === "countdown") cancelRef.current = true;
  }, []);

  // ---------- 麦克风跟拍校准 ----------
  const calibrate = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec?.isOpen) return;
    const r = (await refreshRoute()) ?? route;
    const name = r?.output?.name || "默认输出";
    player.pause();
    setError(null);
    setNotice(null);
    setPhase("calibrating");
    const ctx = player.context();
    await ctx.resume();
    const chunks: Float32Array[] = [];
    let t0: number | null = null;
    rec.start(({ time, data }) => {
      if (t0 === null) t0 = time;
      chunks.push(data);
    });
    const first = ctx.currentTime + 1.2;
    const clicks = Array.from({ length: 8 }, (_, i) => first + i * 0.75);
    for (const [i, t] of clicks.entries()) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = i === 0 ? 1500 : 1000;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.08);
    }
    await sleep((clicks[7] - ctx.currentTime + 0.9) * 1000);
    await rec.stop();
    const ms = t0 === null ? null : measureRoundTrip(concat(chunks), rec.sampleRate, t0, clicks);
    setPhase("prep");
    if (ms === null) {
      setError("没听清「嗒」声：戴好耳机，跟着节拍对麦克风清楚地说「嗒」，再试一次");
      return;
    }
    updateSettings({ recordLatency: { ...settings.recordLatency, [name]: ms } });
    setNotice(`校准好了：${name} 的往返延迟 ${ms}ms，之后用这个耳机录音会自动扣掉`);
  }, [player, refreshRoute, route, settings.recordLatency, updateSettings]);

  return {
    phase,
    error,
    notice,
    inputs,
    deviceId,
    setDeviceId,
    route,
    refreshRoute,
    outputKind,
    routeName,
    latencyMs,
    calibrated,
    range,
    setRange,
    countdown,
    level,
    inputWarning,
    monitor,
    setMonitor,
    openPrep,
    close,
    start,
    stop,
    calibrate,
    dismissNotice: () => setNotice(null),
    /** 读最近的麦克风采样（演唱页音高窗口用）；麦克风没开时返回 false */
    readInput: useCallback((out: Float32Array<ArrayBuffer>) => recorderRef.current?.timeDomain(out) ?? false, []),
    inputSampleRate: useCallback(() => recorderRef.current?.sampleRate ?? 48000, []),
  };
}

export type RecordingApi = ReturnType<typeof useRecording>;
