/**
 * 一键开播（PRD 4.7）：
 * 1. 打开歌词同步
 * 2. 开直播声音：麦克风 → 实时修音（往原唱旋律上修）→ 效果，和伴奏混好送给叠加层
 * 3. 让 OBS 打开、建场景、填推流码、开始推流
 * 直播中改修音强度、效果、音量都实时生效；换歌自动换原唱参考。
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { listInputs, pickDefaultInput } from "../audio/recorder";
import type { Player } from "../player/usePlayer";
import type { Settings } from "../settings";
import { type PitchTrack, detectKey, hzToMidi, scalePitchClasses } from "../tune/autotune";
import { DEFAULT_FX } from "../tune/effects";
import type { Song } from "../types";
import { getLiveInfo } from "./liveSync";
import type { TunerInfo, TunerParams } from "./rtTuner";
import { LiveVoice } from "./liveVoice";

export type LivePhase = "idle" | "starting" | "ready" | "live" | "stopping";

export interface ObsStatus {
  installed: boolean;
  running: boolean;
  connected: boolean;
  streaming: boolean;
  durationMs: number;
  congestion: number;
  error: string | null;
}

interface Options {
  player: Player;
  song: Song | null;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  /** 当前升降调（原唱参考要跟着移） */
  transpose: number;
}

function randomPassword() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function useGoLive({ player, song, settings, updateSettings, transpose }: Options) {
  const [phase, setPhase] = useState<LivePhase>("idle");
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [obs, setObs] = useState<ObsStatus | null>(null);
  const [info, setInfo] = useState<TunerInfo | null>(null);
  const [peak, setPeak] = useState(0);
  const voiceRef = useRef<LiveVoice | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const params = useCallback(
    (s: Settings, scale: number[]): TunerParams => ({ enabled: s.liveTune, strength: s.liveTuneStrength, speed: s.liveTuneSpeed, scale }),
    [],
  );
  const fxOf = (s: Settings) => (s.liveFx ? { ...DEFAULT_FX, preset: s.liveFx } : null);

  // ---------- 原唱参考（换歌、升降调时更新） ----------
  const scaleRef = useRef<number[]>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const loadReference = useCallback(async () => {
    const v = voiceRef.current;
    if (!v) return;
    const vocal = song?.vocals[0];
    if (!vocal) {
      v.setReference(null);
      return;
    }
    try {
      const track = await invoke<PitchTrack>("analyze_pitch", { path: vocal.path });
      const ref = Float32Array.from(track.f0, (f) => (f > 0 ? hzToMidi(f) + transpose : NaN));
      const key = detectKey(track.f0);
      scaleRef.current = scalePitchClasses({ ...key, tonic: (((key.tonic + transpose) % 12) + 12) % 12 });
      v.setReference(ref, track.hop);
      v.setParams(params(settingsRef.current, scaleRef.current));
    } catch {
      v.setReference(null);
    }
  }, [song?.vocals, transpose, params]);
  useEffect(() => {
    if (phase !== "idle") void loadReference();
  }, [loadReference, phase]);

  // ---------- 播放时钟：每 100ms 告诉修音器伴奏放到哪了 ----------
  const roundTripRef = useRef(0.2);
  useEffect(() => {
    if (phase === "idle") return;
    const id = window.setInterval(() => {
      const ctx = player.context();
      voiceRef.current?.setClock({
        playing: player.playing,
        pos0: player.getPosition(),
        t0: ctx.currentTime,
        rate: player.rate,
        roundTrip: roundTripRef.current,
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [phase, player]);

  // ---------- 直播中实时调参数 ----------
  useEffect(() => {
    voiceRef.current?.setParams(params(settings, scaleRef.current));
  }, [settings.liveTune, settings.liveTuneStrength, settings.liveTuneSpeed, params]);
  useEffect(() => {
    voiceRef.current?.setFx(fxOf(settings));
  }, [settings.liveFx]);
  useEffect(() => {
    voiceRef.current?.setGains(settings.liveVoiceGain, settings.liveAccGain);
  }, [settings.liveVoiceGain, settings.liveAccGain]);

  // ---------- OBS 状态（开播期间每 2 秒查一次） ----------
  useEffect(() => {
    if (phase === "idle" || !settings.obsPassword) return;
    let stop = false;
    const poll = async () => {
      const s = await invoke<ObsStatus>("obs_status", { password: settingsRef.current.obsPassword }).catch(() => null);
      if (stop) return;
      setObs(s);
      if (s && phase === "ready" && s.streaming) setPhase("live");
      if (s && phase === "live" && !s.streaming && !s.running) setPhase("ready");
    };
    void poll();
    const id = window.setInterval(poll, 2000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [phase, settings.obsPassword]);

  // ---------- 开始 / 结束 ----------
  const startVoice = useCallback(async () => {
    const s = settingsRef.current;
    let voice = voiceRef.current;
    if (!voice) {
      voice = new LiveVoice();
      voice.onInfo = setInfo;
      voice.onPeak = setPeak;
      voiceRef.current = voice;
    }
    const inputs = await listInputs().catch(() => []);
    const mic = inputs.find((d) => d.deviceId === s.liveMicId && !d.bluetooth) ?? pickDefaultInput(inputs);
    const route = await invoke<{ output?: { name: string } }>("audio_route").catch(() => null);
    const name = route?.output?.name || "默认输出";
    roundTripRef.current = (s.recordLatency[name] ?? s.outputLatencyMs + 10) / 1000;
    await voice.start({
      ctx: player.context(),
      accompaniment: player.output(),
      deviceId: mic?.deviceId,
      roundTrip: roundTripRef.current,
      params: params(s, scaleRef.current),
      fx: fxOf(s),
      voiceGain: s.liveVoiceGain,
      accGain: s.liveAccGain,
    });
    setMicError(voice.micError);
    await loadReference();
  }, [player, params, loadReference]);

  const start = useCallback(async () => {
    if (phase !== "idle" && phase !== "ready") return;
    setPhase("starting");
    setError(null);
    setSteps([]);
    try {
      let pw = settingsRef.current.obsPassword;
      if (!pw) {
        pw = randomPassword();
        updateSettings({ obsPassword: pw });
      }
      updateSettings({ liveEnabled: true });
      if (!voiceRef.current?.running) await startVoice();
      const live = await getLiveInfo();
      const s = settingsRef.current;
      const done = await invoke<string[]>("obs_go_live", { password: pw, overlayUrl: `${live.url}?audio=1`, server: s.streamServer, key: s.streamKey });
      setSteps(done);
      setPhase(s.streamServer.trim() && s.streamKey.trim() ? "live" : "ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase(voiceRef.current?.running ? "ready" : "idle");
    }
  }, [phase, startVoice, updateSettings]);

  const stop = useCallback(async () => {
    setPhase("stopping");
    try {
      if (settingsRef.current.obsPassword) await invoke("obs_stop", { password: settingsRef.current.obsPassword }).catch(() => {});
    } finally {
      voiceRef.current?.stop();
      setPhase("idle");
      setInfo(null);
      setPeak(0);
    }
  }, []);

  useEffect(() => () => voiceRef.current?.stop(), []);

  return { phase, steps, error, micError, obs, info, peak, start, stop, restartVoice: startVoice };
}

export type GoLiveApi = ReturnType<typeof useGoLive>;
