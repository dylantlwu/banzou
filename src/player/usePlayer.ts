import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AudioEngine, type TimelineEvent, type TrackRegion } from "../audio/engine";

export interface PlayerTrack {
  id: string;
  path: string;
  gain: number;
  /** 同组共用音量（Take 的多段录音） */
  group?: string;
  /** 在歌曲时间线上的位置（录音 Take） */
  region?: TrackRegion;
}

/** A-B 循环区间（秒） */
export interface LoopRange {
  a: number;
  b: number;
}

export type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export interface Player {
  load: LoadState;
  ready: boolean;
  playing: boolean;
  /** 当前歌曲位置（秒），播放中逐帧更新 */
  position: number;
  duration: number;
  rate: number;
  /** 直接读引擎的精确位置（按键打轴时用，不等下一帧） */
  getPosition: () => number;
  play: () => Promise<void>;
  pause: () => void;
  togglePlay: () => Promise<void>;
  seekTo: (t: number) => void;
  skip: (delta: number) => void;
  setRate: (rate: number) => void;
  setGain: (id: string, value: number) => void;
  hasTrack: (id: string) => boolean;
  getBuffer: (id: string) => AudioBuffer | null;
  /** 录音用：共用的 AudioContext 和时钟换算 */
  context: () => AudioContext;
  output: () => AudioNode;
  positionAt: (clock: number) => number;
  /** 开始播放并返回发声时刻（录音对时） */
  playWithClock: () => Promise<{ at: number; offset: number } | null>;
  /** 录音用：订阅播放中的开始 / 暂停 / 跳转，返回取消订阅的函数 */
  onTimeline: (fn: (e: TimelineEvent) => void) => () => void;
  loop: LoopRange | null;
  setLoop: (loop: LoopRange | null) => void;
  setGroupChain: (group: string, factory: ((ctx: BaseAudioContext) => { input: AudioNode; output: AudioNode }) | null) => void;
  /** 某个文件重新生成了：丢掉缓存，下次加载重新读 */
  evict: (path: string) => void;
}

/**
 * 播放器 hook：tracks 的文件路径变化时重新加载；音量变化不重新加载，用 setGain 调。
 * tracks 为 null 表示没有选歌；空数组表示这首歌没有可播放的音频。
 */
export function usePlayer(tracks: PlayerTrack[] | null, emptyMessage = "这首歌没有伴奏文件"): Player {
  const engineRef = useRef<AudioEngine | null>(null);
  const engine = useCallback(() => (engineRef.current ??= new AudioEngine()), []);
  useEffect(
    () => () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    },
    [],
  );

  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRateState] = useState(1);

  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const key =
    tracks === null
      ? null
      : tracks.map((t) => `${t.id}:${t.path}:${t.group ?? ""}:${t.region ? JSON.stringify(t.region) : ""}`).join("|");
  const [loop, setLoop] = useState<LoopRange | null>(null);
  const loopRef = useRef(loop);
  loopRef.current = loop;

  // 同一首歌只是换了 Take：保留播放位置和 A-B 循环；换歌才回到开头
  const mainPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    const list = tracksRef.current ?? [];
    const mainPath = list[0]?.path ?? null;
    const sameSong = mainPath !== null && mainPath === mainPathRef.current;
    mainPathRef.current = mainPath;
    const resumeAt = sameSong ? engine().transport.position() : 0;
    if (engine().transport.playing) engine().pause();
    setPlaying(false);
    setPosition(resumeAt);
    if (!sameSong) {
      setDuration(0);
      setLoop(null);
    }
    if (list.length === 0) {
      void engine().load([]);
      setLoad({ kind: "error", message: emptyMessage });
      return;
    }
    let cancelled = false;
    setLoad({ kind: "loading" });
    engine()
      .load(list.map((t) => ({ id: t.id, url: convertFileSrc(t.path), gain: t.gain, group: t.group, region: t.region })))
      .then((ok) => {
        if (!ok || cancelled) return;
        // 加载期间音量可能被改过，按最新的设置
        for (const t of tracksRef.current ?? []) engine().setGain(t.id, t.gain);
        if (resumeAt > 0) engine().seek(resumeAt);
        setDuration(engine().duration);
        setLoad({ kind: "ready" });
      })
      .catch((e) => {
        if (!cancelled) setLoad({ kind: "error", message: `音频加载失败：${String(e)}` });
      });
    return () => {
      cancelled = true;
    };
  }, [key, engine, emptyMessage]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const e = engine();
      if (e.transport.atEnd()) {
        e.pause();
        e.seek(0);
        setPlaying(false);
        setPosition(0);
        return;
      }
      const lp = loopRef.current;
      if (lp && e.transport.position() >= lp.b) e.seek(lp.a);
      setPosition(e.transport.position());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, engine]);

  const ready = load.kind === "ready";

  const play = useCallback(async () => {
    if (!ready) return;
    await engine().play();
    setPlaying(true);
  }, [ready, engine]);

  const pause = useCallback(() => {
    const e = engine();
    e.pause();
    setPlaying(false);
    setPosition(e.transport.position());
  }, [engine]);

  const togglePlay = useCallback(async () => {
    if (engine().transport.playing) pause();
    else await play();
  }, [engine, play, pause]);

  const seekTo = useCallback(
    (t: number) => {
      if (!ready) return;
      const e = engine();
      e.seek(t);
      setPosition(e.transport.position());
    },
    [ready, engine],
  );

  const skip = useCallback((delta: number) => seekTo(engine().transport.position() + delta), [seekTo, engine]);

  const setRate = useCallback(
    (r: number) => {
      engine().setRate(r);
      setRateState(r);
    },
    [engine],
  );

  return {
    load,
    ready,
    playing,
    position,
    duration,
    rate,
    getPosition: useCallback(() => engine().transport.position(), [engine]),
    play,
    pause,
    togglePlay,
    seekTo,
    skip,
    setRate,
    setGain: useCallback((id: string, v: number) => engine().setGain(id, v), [engine]),
    hasTrack: useCallback((id: string) => engine().hasTrack(id), [engine]),
    getBuffer: useCallback((id: string) => engine().getBuffer(id), [engine]),
    context: useCallback(() => engine().context, [engine]),
    output: useCallback(() => engine().output, [engine]),
    positionAt: useCallback((clock: number) => engine().positionAt(clock), [engine]),
    playWithClock: useCallback(async () => {
      const info = await engine().play();
      if (info) setPlaying(true);
      return info;
    }, [engine]),
    onTimeline: useCallback((fn: (e: TimelineEvent) => void) => engine().onTimeline(fn), [engine]),
    loop,
    setLoop,
    setGroupChain: useCallback((g, f) => engine().setGroupChain(g, f), [engine]),
    evict: useCallback((path: string) => engine().evict(convertFileSrc(path)), [engine]),
  };
}
