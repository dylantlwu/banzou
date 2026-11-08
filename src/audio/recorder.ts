/**
 * 麦克风录音（PRD 4.4 / 7.4）。
 *
 * 和伴奏播放共用同一个 AudioContext：AudioWorklet 每块采样都带着它的时钟时刻，
 * 所以「录音第几帧 ↔ 伴奏放到哪」能精确算出来，再扣掉校准过的往返延迟就对齐了。
 *
 * - 按设备 ID 打开麦克风，关掉回声消除 / 降噪 / 自动增益（否则人声会被处理得发闷）
 * - 绝不用 AirPods 等蓝牙麦克风：一打开蓝牙就切到通话模式，耳机里的伴奏会突然变差
 */

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.t0 = 0;
    this.port.onmessage = (e) => {
      if (e.data === "start") { this.on = true; this.n = 0; }
      if (e.data === "stop") { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (this.n > 0) this.port.postMessage({ t: this.t0, d: this.buf.slice(0, this.n) });
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.on && ch) {
      if (this.n === 0) this.t0 = currentTime;
      if (this.n + ch.length > this.buf.length) { this.flush(); this.t0 = currentTime; }
      this.buf.set(ch, this.n);
      this.n += ch.length;
      if (this.n >= 4096 - 128) this.flush();
    }
    return true;
  }
}
registerProcessor("banzou-capture", Capture);
`;

/** 每个 AudioContext 只能注册一次 worklet */
const workletReady = new WeakSet<AudioContext>();

export interface InputDevice {
  deviceId: string;
  label: string;
  /** 蓝牙耳机麦克风（AirPods 等），不允许用来录 */
  bluetooth: boolean;
}

const BLUETOOTH_HINT = /airpods|bluetooth|蓝牙|beats|buds|headset|hands-free|免提/i;
const PREFERRED_HINT = /macbook|内建|内置|built-?in|internal/i;

export function isBluetoothLabel(label: string): boolean {
  return BLUETOOTH_HINT.test(label);
}

/** 默认选哪个麦克风：优先电脑内置的，其次任何非蓝牙的，绝不默认选蓝牙 */
export function pickDefaultInput(devices: InputDevice[]): InputDevice | null {
  return devices.find((d) => !d.bluetooth && PREFERRED_HINT.test(d.label)) ?? devices.find((d) => !d.bluetooth) ?? null;
}

export async function listInputs(): Promise<InputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d) => ({ deviceId: d.deviceId, label: d.label || "麦克风", bluetooth: isBluetoothLabel(d.label) }));
}

export interface Chunk {
  /** 这块第一帧的时钟时刻（AudioContext 时间） */
  time: number;
  data: Float32Array;
}

export class Recorder {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private monitorGain: GainNode | null = null;
  private sink: GainNode | null = null;
  private onChunk: ((c: Chunk) => void) | null = null;
  private stopped: (() => void) | null = null;
  private levelBuf = new Float32Array(2048);
  label = "";

  constructor(private readonly ctx: AudioContext) {}

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  /** 打开麦克风（会触发系统授权弹窗） */
  async open(deviceId?: string): Promise<void> {
    this.close();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("这个环境不支持录音（拿不到麦克风）");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.stream = stream;
    this.label = stream.getAudioTracks()[0]?.label ?? "";
    if (isBluetoothLabel(this.label)) {
      this.close();
      throw new Error("不能用蓝牙耳机（AirPods）的麦克风录音：会让耳机切到通话模式，伴奏音质变差。请换电脑或外接麦克风。");
    }
    if (!workletReady.has(this.ctx)) {
      await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
      workletReady.add(this.ctx);
    }
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.node = new AudioWorkletNode(this.ctx, "banzou-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
    // worklet 要接到输出才会持续运行；接一个静音的增益
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.analyser);
    this.source.connect(this.node).connect(this.sink).connect(this.ctx.destination);
    this.node.port.onmessage = (e) => {
      const msg = e.data as { t?: number; d?: Float32Array; done?: boolean };
      if (msg.done) {
        this.stopped?.();
        this.stopped = null;
      } else if (msg.d && msg.t !== undefined) {
        this.onChunk?.({ time: msg.t, data: msg.d });
      }
    };
    await this.ctx.resume();
  }

  get isOpen(): boolean {
    return this.stream !== null;
  }

  /** 输入电平（0–1 的峰值），给电平表用 */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let peak = 0;
    for (const v of this.levelBuf) peak = Math.max(peak, Math.abs(v));
    return peak;
  }

  /** 耳返：把麦克风直接送到耳机（只适合有线耳机，蓝牙延迟太大） */
  setMonitor(on: boolean, volume = 0.8): void {
    if (!this.source) return;
    if (on && !this.monitorGain) {
      this.monitorGain = this.ctx.createGain();
      this.monitorGain.gain.value = volume;
      this.source.connect(this.monitorGain).connect(this.ctx.destination);
    } else if (!on && this.monitorGain) {
      this.monitorGain.disconnect();
      this.monitorGain = null;
    }
  }

  start(onChunk: (c: Chunk) => void): void {
    if (!this.node) throw new Error("麦克风还没打开");
    this.onChunk = onChunk;
    this.node.port.postMessage("start");
  }

  /** 停止采集；所有剩余数据都交给 onChunk 之后才 resolve */
  stop(): Promise<void> {
    if (!this.node) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        this.stopped = null;
        resolve();
      }, 1000);
      this.stopped = () => {
        window.clearTimeout(timer);
        resolve();
      };
      this.node!.port.postMessage("stop");
    }).then(() => {
      this.onChunk = null;
    });
  }

  close(): void {
    this.setMonitor(false);
    this.node?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node = null;
    this.source = null;
    this.sink = null;
    this.analyser = null;
    this.stream = null;
    this.onChunk = null;
  }
}

/** Float32 采样 → base64（小端），每秒一段交给后端追加写盘 */
export function floatsToBase64(data: Float32Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin);
}
