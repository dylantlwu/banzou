/**
 * 直播声音（PRD 4.7 直播修音）：
 *   麦克风 → 实时修音 → 人声效果 ┐
 *   伴奏（延迟对齐）────────────┴→ 直播混音 → 发给直播服务 → OBS 里的叠加层页面播放
 *
 * 你耳机里听到的还是 app 正常放的伴奏（+ 麦克风耳机孔的原声监听），录音也照旧录原声；
 * 修过的人声只进直播混音，互不影响。
 */
import { invoke } from "@tauri-apps/api/core";
import { isBluetoothLabel } from "../audio/recorder";
import { type FxSettings, buildChain } from "../tune/effects";
import type { TunerClock, TunerInfo, TunerParams } from "./rtTuner";
import streamUrl from "./streamWorklet.ts?worker&url";
import tunerUrl from "./tunerWorklet.ts?worker&url";

const loaded = new WeakSet<AudioContext>();

async function loadWorklets(ctx: AudioContext) {
  if (loaded.has(ctx)) return;
  await ctx.audioWorklet.addModule(tunerUrl);
  await ctx.audioWorklet.addModule(streamUrl);
  loaded.add(ctx);
}

/** 把一段直播混音交给直播服务（正式 app 走 IPC，测试模式直接发给本机的测试服务） */
export function sendLiveAudio(pcm: ArrayBuffer) {
  if ((window as unknown as { __BANZOU_TEST__?: boolean }).__BANZOU_TEST__) {
    void fetch("http://127.0.0.1:17890/audio", { method: "POST", body: pcm, headers: { "content-type": "text/plain" } }).catch(() => {});
  } else {
    void invoke("live_audio", new Uint8Array(pcm)).catch(() => {});
  }
}

export interface LiveVoiceOptions {
  ctx: AudioContext;
  /** app 正在播放的伴奏（播放引擎总出口） */
  accompaniment: AudioNode;
  deviceId?: string;
  /** 耳机 + 麦克风往返延迟（秒） */
  roundTrip: number;
  params: TunerParams;
  fx: FxSettings | null;
  voiceGain: number;
  accGain: number;
}

export class LiveVoice {
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private tuner: AudioWorkletNode | null = null;
  private voice: GainNode | null = null;
  private acc: GainNode | null = null;
  private delay: DelayNode | null = null;
  private source: AudioNode | null = null;
  private fxOut: AudioNode | null = null;
  private tunerLatency = 0;
  private ctx: AudioContext | null = null;
  private roundTrip = 0;
  label = "";
  /** 麦克风打不开时的原因（这时只推伴奏） */
  micError: string | null = null;
  onInfo: ((info: TunerInfo) => void) | null = null;
  onPeak: ((peak: number) => void) | null = null;

  async start(o: LiveVoiceOptions) {
    this.stop();
    const ctx = o.ctx;
    this.ctx = ctx;
    this.roundTrip = o.roundTrip;
    await loadWorklets(ctx);
    // 麦克风打不开（没接、没权限、只有蓝牙麦）就只推伴奏和歌词
    this.micError = null;
    let stream: MediaStream | null = null;
    try {
      if (!o.deviceId) throw new Error("没有找到可用的麦克风（蓝牙耳机的麦克风不能用）");
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: o.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      this.label = stream.getAudioTracks()[0]?.label ?? "";
      if (isBluetoothLabel(this.label)) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
        throw new Error("不能用蓝牙耳机（AirPods）的麦克风：会让耳机切到通话模式。请换外接麦克风。");
      }
    } catch (e) {
      this.micError = e instanceof Error ? e.message : String(e);
    }
    this.stream = stream;
    await ctx.resume();

    const mic = stream ? ctx.createMediaStreamSource(stream) : ctx.createGain();
    const tuner = new AudioWorkletNode(ctx, "banzou-tuner", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    tuner.port.onmessage = (e) => {
      if (e.data.type === "latency") {
        this.tunerLatency = e.data.samples / ctx.sampleRate;
        this.updateDelay();
      } else if (e.data.type === "info") this.onInfo?.(e.data.info);
    };
    tuner.port.postMessage({ type: "params", params: o.params });
    this.tuner = tuner;

    const voice = ctx.createGain();
    voice.gain.value = o.voiceGain;
    this.voice = voice;
    const mix = ctx.createGain();
    mic.connect(tuner);
    this.fxOut = tuner;
    this.applyFx(o.fx, voice);
    voice.connect(mix);

    // 伴奏晚一点进混音：你是跟着耳朵听到的伴奏唱的，人声到这里已经晚了「往返延迟 + 修音延迟」
    const delay = ctx.createDelay(2);
    const acc = ctx.createGain();
    acc.gain.value = o.accGain;
    o.accompaniment.connect(delay).connect(acc).connect(mix);
    this.source = o.accompaniment;
    this.delay = delay;
    this.acc = acc;
    this.updateDelay();

    // 留余量 + 限幅：伴奏和人声叠在一起很容易超过 0dB 爆音
    mix.gain.value = 0.6;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    const capture = new AudioWorkletNode(ctx, "banzou-stream", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: "explicit" });
    capture.port.onmessage = (e) => {
      sendLiveAudio(e.data.pcm);
      this.onPeak?.(e.data.peak);
    };
    mix.connect(limiter).connect(capture);
    this.nodes = [mic, tuner, voice, mix, delay, acc, limiter, capture];
  }

  private applyFx(fx: FxSettings | null, voice: GainNode) {
    if (!this.tuner || !this.ctx) return;
    this.tuner.disconnect();
    if (this.fxOut && this.fxOut !== this.tuner) this.fxOut.disconnect();
    if (fx) {
      const chain = buildChain(this.ctx, { ...fx, voiceGain: 1 });
      this.tuner.connect(chain.input);
      chain.output.connect(voice);
      this.fxOut = chain.output;
    } else {
      this.tuner.connect(voice);
      this.fxOut = this.tuner;
    }
  }

  private updateDelay() {
    if (this.delay && this.ctx) this.delay.delayTime.setValueAtTime(Math.min(1.9, this.roundTrip + this.tunerLatency), this.ctx.currentTime);
  }

  get latencySeconds() {
    return this.tunerLatency;
  }

  get running() {
    return this.nodes.length > 0;
  }

  setParams(p: Partial<TunerParams>) {
    this.tuner?.port.postMessage({ type: "params", params: p });
  }

  setReference(ref: Float32Array | null, hop = 0.01) {
    this.tuner?.port.postMessage({ type: "ref", ref, hop });
  }

  setClock(clock: TunerClock | null) {
    this.tuner?.port.postMessage({ type: "clock", clock });
  }

  setFx(fx: FxSettings | null) {
    if (this.voice) this.applyFx(fx, this.voice);
  }

  setGains(voice: number, acc: number) {
    if (!this.ctx) return;
    this.voice?.gain.setTargetAtTime(voice, this.ctx.currentTime, 0.02);
    this.acc?.gain.setTargetAtTime(acc, this.ctx.currentTime, 0.02);
  }

  stop() {
    if (this.source && this.delay) {
      try {
        this.source.disconnect(this.delay);
      } catch {
        // 已经断开
      }
    }
    this.source = null;
    for (const n of this.nodes) n.disconnect();
    if (this.fxOut && this.fxOut !== this.tuner) this.fxOut.disconnect();
    this.nodes = [];
    this.tuner = null;
    this.voice = null;
    this.acc = null;
    this.delay = null;
    this.fxOut = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
