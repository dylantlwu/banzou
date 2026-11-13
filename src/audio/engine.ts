import { Transport } from "./transport";
import { clockStalled } from "./outputDevice";

/** 音轨在歌曲时间线上的位置（录音 Take 用）；不给就是从歌曲 0 秒开始、整段播放 */
export interface TrackRegion {
  /** 这段音频的第 0 个采样对应的歌曲时间（秒），可以是负数 */
  start: number;
  /** 只播放歌曲时间 [from, to] 这一段（补录拼接用） */
  from?: number;
  to?: number;
  /** 段落边缘淡入淡出（秒），拼接处避免咔哒声 */
  fade?: number;
}

export interface TrackSource {
  id: string;
  url: string;
  gain?: number;
  /** 同组音轨共用音量（一个 Take 可能由多段录音拼成） */
  group?: string;
  region?: TrackRegion;
}

interface LoadedTrack {
  id: string;
  group?: string;
  buffer: AudioBuffer;
  region?: TrackRegion;
  gain: GainNode;
  sources: AudioScheduledSourceNode[];
}

/** 音源启动前留的提前量，保证多轨在同一时刻开始 */
const START_LEAD = 0.03;

/**
 * 多轨音频引擎（PRD 第 6 节）。
 * 所有音轨共用一个 AudioContext，并在同一时钟时刻启动，保证零漂移。
 * 典型用法：伴奏 + 引导人声 + 录音 Take，各自用 GainNode 调音量；录音也在同一个时钟上采集。
 */
/**
 * 时钟 → 歌曲位置的对应关系变了：`at` 时钟时刻起从歌曲 `offset` 开始放，`prev` 是变之前放到的位置。
 * 暂停时 `offset` = `prev` = 停下的位置。
 */
export interface TimelineEvent {
  kind: "play" | "pause" | "seek";
  at: number;
  offset: number;
  prev: number;
}

export class AudioEngine {
  private ctx = new AudioContext();
  private readonly tracks = new Map<string, LoadedTrack>();
  readonly transport = new Transport(() => this.ctx.currentTime);
  private loadToken = 0;
  /** 解码缓存：切换 Take 时伴奏不用重新解码；只保留最近两次加载用到的 */
  private readonly cache = new Map<string, AudioBuffer>();
  private recentUrls: string[][] = [];
  private master: GainNode;
  /** 分组效果链（修音页给人声加效果）：组名 → 搭链函数 */
  private readonly chainFactories = new Map<string, (ctx: BaseAudioContext) => { input: AudioNode; output: AudioNode }>();
  private readonly chains = new Map<string, { input: AudioNode; output: AudioNode }>();
  /** 播放中的时间线变化（开始、暂停、跳转），录音用它把录音切成一段段 */
  private readonly timelineListeners = new Set<(e: TimelineEvent) => void>();

  constructor() {
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
  }

  get context(): AudioContext {
    return this.ctx;
  }

  /** 所有播放音轨的总出口（录音时可以接到别处做监听） */
  get output(): AudioNode {
    return this.master;
  }

  get duration(): number {
    return this.transport.duration;
  }

  private async decode(url: string): Promise<AudioBuffer> {
    const hit = this.cache.get(url);
    if (hit) return hit;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`读取音频失败（${res.status}）：${url}`);
    const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
    this.cache.set(url, buffer);
    return buffer;
  }

  /** 加载一组音轨；新的加载会让旧的作废 */
  async load(sources: TrackSource[]): Promise<boolean> {
    const token = ++this.loadToken;

    const decoded = await Promise.all(sources.map(async (s) => ({ ...s, buffer: await this.decode(s.url) })));
    if (token !== this.loadToken) return false;

    this.unload();
    this.recentUrls = [sources.map((s) => s.url), ...this.recentUrls].slice(0, 2);
    const keep = new Set(this.recentUrls.flat());
    for (const url of this.cache.keys()) if (!keep.has(url)) this.cache.delete(url);

    for (const t of decoded) {
      const gain = this.ctx.createGain();
      gain.gain.value = t.gain ?? 1;
      gain.connect(this.destinationFor(t.group));
      this.tracks.set(t.id, { id: t.id, group: t.group, buffer: t.buffer, region: t.region, gain, sources: [] });
    }
    const main = decoded.filter((t) => !t.region);
    const lengths = (main.length ? main : decoded).map((t) => (t.region ? (t.region.to ?? t.region.start + t.buffer.duration) : t.buffer.duration));
    this.transport.reset(Math.max(0, ...lengths));
    return true;
  }

  private destinationFor(group?: string): AudioNode {
    return (group && this.chains.get(group)?.input) || this.master;
  }

  /** 给一组音轨挂效果链（null = 去掉），播放中也能换 */
  setGroupChain(group: string, factory: ((ctx: BaseAudioContext) => { input: AudioNode; output: AudioNode }) | null): void {
    const old = this.chains.get(group);
    if (factory) {
      const chain = factory(this.ctx);
      chain.output.connect(this.master);
      this.chains.set(group, chain);
      this.chainFactories.set(group, factory);
    } else {
      this.chains.delete(group);
      this.chainFactories.delete(group);
    }
    for (const track of this.tracks.values()) {
      if (track.group !== group) continue;
      track.gain.disconnect();
      track.gain.connect(this.destinationFor(group));
    }
    if (old) {
      old.output.disconnect();
      old.input.disconnect();
    }
  }

  /** 文件内容变了（比如重新渲染了修音），丢掉旧的解码缓存 */
  evict(url: string): void {
    this.cache.delete(url);
  }

  /** 每条音轨在歌曲时间线上要播放的窗口 */
  private windowOf(track: LoadedTrack): { start: number; from: number; to: number } {
    const start = track.region?.start ?? 0;
    const from = Math.max(start, track.region?.from ?? start);
    const to = Math.min(start + track.buffer.duration, track.region?.to ?? Infinity);
    return { start, from, to };
  }

  private startSources(offset: number, at: number): void {
    const rate = this.transport.rate;
    // 测试模式的假麦克风靠这个事件跟上播放（正式 app 里没人监听）
    globalThis.dispatchEvent?.(new CustomEvent("banzou-play", { detail: { at, offset, rate, engine: this } }));
    for (const track of this.tracks.values()) {
      const { start, from, to } = this.windowOf(track);
      if (offset >= to || to <= from) continue;
      const songBegin = Math.max(offset, from);
      const when = at + (songBegin - offset) / rate;
      const source = this.ctx.createBufferSource();
      source.buffer = track.buffer;
      source.playbackRate.value = rate;
      const fade = track.region?.fade ?? 0;
      if (fade > 0) {
        // 每段单独一个包络：段落边缘淡入淡出
        const env = this.ctx.createGain();
        const realFade = fade / rate;
        const endWhen = when + (to - songBegin) / rate;
        env.gain.setValueAtTime(songBegin > from ? 1 : 0, when);
        if (songBegin <= from) env.gain.linearRampToValueAtTime(1, when + realFade);
        env.gain.setValueAtTime(1, Math.max(when + realFade, endWhen - realFade));
        env.gain.linearRampToValueAtTime(0, endWhen);
        source.connect(env).connect(track.gain);
      } else {
        source.connect(track.gain);
      }
      source.start(when, songBegin - start, to - songBegin);
      track.sources.push(source);
    }
  }

  private stopSources(): void {
    globalThis.dispatchEvent?.(new CustomEvent("banzou-stop"));
    for (const track of this.tracks.values()) {
      for (const source of track.sources) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // 已经停止
        }
        source.disconnect();
      }
      track.sources = [];
    }
  }

  /** 开始播放，返回实际发声的时钟时刻和起始位置（录音对时用） */
  async play(): Promise<{ at: number; offset: number } | null> {
    if (this.transport.playing || this.tracks.size === 0) return null;
    await this.ctx.resume();
    const at = this.ctx.currentTime + START_LEAD;
    const offset = this.transport.play(at);
    this.startSources(offset, at);
    this.emitTimeline({ kind: "play", at, offset, prev: offset });
    return { at, offset };
  }

  pause(): void {
    const wasPlaying = this.transport.playing;
    this.stopSources();
    this.transport.pause();
    if (wasPlaying) {
      const pos = this.transport.position();
      this.emitTimeline({ kind: "pause", at: this.ctx.currentTime, offset: pos, prev: pos });
    }
  }

  /** 订阅播放中的时间线变化，返回取消订阅的函数 */
  onTimeline(fn: (e: TimelineEvent) => void): () => void {
    this.timelineListeners.add(fn);
    return () => this.timelineListeners.delete(fn);
  }

  private emitTimeline(e: TimelineEvent): void {
    for (const fn of this.timelineListeners) fn(e);
  }

  seek(t: number): void {
    if (this.transport.playing) {
      const prev = this.transport.position();
      this.stopSources();
      const at = this.ctx.currentTime + START_LEAD;
      const offset = this.transport.seek(t, at);
      this.startSources(offset, at);
      this.emitTimeline({ kind: "seek", at, offset, prev });
    } else {
      this.transport.seek(t);
    }
  }

  /** 变速（音调会跟着变，打轴用足够了）；播放中重新排程，保证分段音轨位置正确 */
  setRate(rate: number): void {
    if (this.transport.playing) {
      const pos = this.transport.position();
      this.stopSources();
      this.transport.setRate(rate, this.ctx.currentTime);
      const at = this.ctx.currentTime + START_LEAD;
      const offset = this.transport.seek(pos, at);
      this.startSources(offset, at);
    } else {
      this.transport.setRate(rate, this.ctx.currentTime);
    }
  }

  get rate(): number {
    return this.transport.rate;
  }

  /** 某个时钟时刻对应的歌曲位置（录音对时用） */
  positionAt(clock: number): number {
    return this.transport.positionAtClock(clock);
  }

  hasTrack(id: string): boolean {
    return this.tracks.has(id);
  }

  getBuffer(id: string): AudioBuffer | null {
    return this.tracks.get(id)?.buffer ?? null;
  }

  /** 按音轨 id 或分组调音量 */
  setGain(id: string, value: number): void {
    for (const track of this.tracks.values()) {
      if (track.id === id || track.group === id) track.gain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
    }
  }

  private unload(): void {
    this.stopSources();
    for (const track of this.tracks.values()) track.gain.disconnect();
    this.tracks.clear();
    this.transport.reset(0);
  }

  /**
   * 出声设备变了之后调用：确认声音还在走。
   * WKWebView 的 AudioContext 一般会自己跟到新的系统默认输出（实测时钟不断），这里是兜底：
   * 没在走就先 resume；还不走（或者已经被关掉）且 `canRebuild` 时重建 AudioContext，从原位置接着放。
   */
  async ensureOutput(canRebuild: boolean, waitMs = 500): Promise<"ok" | "resumed" | "rebuilt" | "stalled"> {
    if (this.ctx.state === "closed") return canRebuild ? (await this.rebuild(), "rebuilt") : "stalled";
    if (!this.transport.playing) return "ok";
    let resumed = false;
    if (this.ctx.state !== "running") {
      await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, waitMs))]);
      resumed = true;
    }
    const t0 = this.ctx.currentTime;
    const p0 = performance.now();
    await new Promise((r) => setTimeout(r, waitMs));
    if (!this.transport.playing) return resumed ? "resumed" : "ok";
    if (!clockStalled(t0, this.ctx.currentTime, performance.now() - p0)) return resumed ? "resumed" : "ok";
    if (!canRebuild) return "stalled";
    await this.rebuild();
    return "rebuilt";
  }

  /** 换一个新的 AudioContext：音轨、音量、效果链照旧，正在放就从原位置接着放 */
  async rebuild(): Promise<void> {
    const wasPlaying = this.transport.playing;
    if (wasPlaying) this.pause();
    const old = this.ctx;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.chains.clear();
    for (const [group, factory] of this.chainFactories) {
      const chain = factory(this.ctx);
      chain.output.connect(this.master);
      this.chains.set(group, chain);
    }
    for (const track of this.tracks.values()) {
      const gain = this.ctx.createGain();
      gain.gain.value = track.gain.gain.value;
      track.gain.disconnect();
      track.gain = gain;
      gain.connect(this.destinationFor(track.group));
    }
    if (old.state !== "closed") void old.close().catch(() => {});
    if (wasPlaying) await this.play();
  }

  dispose(): void {
    this.loadToken++;
    this.unload();
    this.cache.clear();
    void this.ctx.close();
  }
}
