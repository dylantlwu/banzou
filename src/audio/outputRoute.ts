/**
 * 「声音从哪里出」（PRD 4.0「麦克风和出声设备」）：在波点里选定出声设备，不跟着系统切。
 *
 * WKWebView 的 AudioContext 不能指定设备，只会跟系统默认输出走；<audio> 元素可以（setSinkId）。
 * 所以每个 AudioContext 的声音先汇到一条「出声总线」（outputFor），再按设置走两条路之一：
 *   跟系统设置：总线 → ctx.destination（和以前一样，没有额外延迟）
 *   选定设备：  总线 → MediaStreamDestination → <audio>.setSinkId(设备)（实测多约 75ms）
 * 老师说话这类 <audio> 用 routeElement 送到同一个设备。
 * setSinkId 要用户手势：交给 Rust 用原生 evaluateJavaScript 调回来（算手势，`audio_sink_gesture`）。
 *
 * 设置项 `outputDevice`：""（没选过）或 "@system" = 跟系统设置；其它 = 设备名（按名字记住）。
 * 选定的设备没插上：从系统默认的设备出声，并明确提示；插回来自动换回去。
 */
import { invoke } from "@tauri-apps/api/core";
import { FOLLOW_SYSTEM, sameDevice } from "./micChoice";
import type { OutputsSnapshot } from "./outputDevice";

/** 走 <audio> 这条路比直连多出来的延迟（BlackHole 回环四次实测 45–98ms，取中间） */
export const ROUTE_EXTRA_MS = 75;

export interface RouteState {
  /** 设置里的值 */
  choice: string;
  /** 现在声音送去的设备名；null = 跟系统设置 */
  device: string | null;
  /** 选定了但没插上的设备名 */
  missing: string | null;
  /** 换设备失败的原因 */
  error: string | null;
  /** 比直连多出来的延迟（ms），歌词同步、打轴、录音对齐要补上 */
  extraMs: number;
  /** 系统默认的出声设备名（提示里用） */
  system: string | null;
}

/** WebKit 那边的出声设备和换设备的方法；测试模式换成假的 */
export interface SinkDriver {
  list(): Promise<{ id: string; label: string }[]>;
  setSink(el: HTMLMediaElement, id: string): Promise<void>;
}

type SinkEl = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };

// ---------- 用户手势：原生 evaluateJavaScript 调回来时一起执行 ----------
const pending: (() => void)[] = [];
function withGesture<T>(fn: () => Promise<T>): Promise<T> {
  const w = window as unknown as { __banzouApplySink?: () => void };
  w.__banzouApplySink ??= () => pending.splice(0).forEach((f) => f());
  return new Promise<T>((resolve, reject) => {
    const job = () => void fn().then(resolve, reject);
    pending.push(job);
    invoke("audio_sink_gesture").catch((e) => {
      const i = pending.indexOf(job);
      if (i >= 0) pending.splice(i, 1);
      reject(e);
    });
  });
}

const webkitDriver: SinkDriver = {
  async list() {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return [];
    const outs = async () =>
      (await md.enumerateDevices()).filter((d) => d.kind === "audiooutput" && d.deviceId && d.deviceId !== "default").map((d) => ({ id: d.deviceId, label: d.label }));
    let list = await outs();
    if (!list.some((d) => d.label)) {
      // WebKit 在这个页面拿过麦克风之后才列出声设备：开一下系统默认的麦克风马上关掉
      const s = await md.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      list = await outs();
    }
    return list;
  },
  async setSink(el, id) {
    const e = el as SinkEl;
    if (!e.setSinkId) throw new Error("这个系统版本不支持指定出声设备");
    try {
      await e.setSinkId(id);
    } catch (err) {
      if (!/gesture|NotAllowed/i.test(String(err))) throw err;
      await withGesture(() => e.setSinkId!(id));
    }
  },
};

/** 一个 AudioContext 的出声总线 */
class Bus {
  readonly input: GainNode;
  private msd: MediaStreamAudioDestinationNode | null = null;
  private el: HTMLAudioElement | null = null;
  /** 现在接在哪：null = 还没接，"" = ctx.destination，其它 = 设备 id */
  private target: string | null = null;
  private token = 0;

  constructor(readonly ctx: AudioContext) {
    this.input = ctx.createGain();
  }

  private detach(from: AudioNode | null) {
    if (!from) return;
    try {
      this.input.disconnect(from);
    } catch {
      // 本来就没接
    }
  }

  /** sinkId：null = 跟系统（ctx.destination），否则送到这个设备 */
  async route(sinkId: string | null, driver: SinkDriver): Promise<void> {
    const want = sinkId ?? "";
    if (this.target === want) return;
    const token = ++this.token;
    if (!sinkId) {
      this.input.connect(this.ctx.destination);
      this.detach(this.msd);
      this.el?.pause();
      this.target = "";
      return;
    }
    this.msd ??= this.ctx.createMediaStreamDestination();
    if (!this.el) {
      this.el = new Audio();
      this.el.srcObject = this.msd.stream;
    }
    await driver.setSink(this.el, sinkId);
    if (token !== this.token || this.ctx.state === "closed") return;
    await this.el.play().catch(() => {});
    if (token !== this.token) return;
    this.input.connect(this.msd);
    if (this.target === "") this.detach(this.ctx.destination);
    this.target = sinkId;
  }

  close() {
    this.token++;
    this.el?.pause();
    if (this.el) this.el.srcObject = null;
    this.el = null;
  }
}

class OutputRouter {
  private driver: SinkDriver = webkitDriver;
  private buses = new Map<AudioContext, Bus>();
  private sinkId: string | null = null;
  /** setChoice 调过之前一律跟系统（启动时设置还没读出来） */
  private ready = false;
  private token = 0;
  private state: RouteState = { choice: "", device: null, missing: null, error: null, extraMs: 0, system: null };
  private listeners = new Set<(s: RouteState) => void>();

  useDriver(d: SinkDriver) {
    this.driver = d;
  }

  get current(): RouteState {
    return this.state;
  }

  subscribe(fn: (s: RouteState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 这个 AudioContext 的声音接到这里（代替 ctx.destination） */
  outputFor(ctx: AudioContext): AudioNode {
    let bus = this.buses.get(ctx);
    if (!bus) {
      bus = new Bus(ctx);
      this.buses.set(ctx, bus);
      const b = bus;
      ctx.addEventListener?.("statechange", () => {
        if (ctx.state !== "closed") return;
        b.close();
        this.buses.delete(ctx);
      });
      void this.routeBus(bus);
    }
    return bus.input;
  }

  private async routeBus(bus: Bus) {
    const id = this.ready ? this.sinkId : null;
    try {
      await bus.route(id, this.driver);
    } catch (e) {
      // 送不过去就从系统默认出声，不能没声音
      await bus.route(null, this.driver);
      this.set({ ...this.state, device: null, extraMs: 0, error: `没能换到「${this.state.choice}」（${String(e)}），现在从系统设置的设备出声` });
      this.sinkId = null;
    }
  }

  /** 老师说话这类 <audio>：放之前调一下，送到同一个设备 */
  async routeElement(el: HTMLMediaElement): Promise<void> {
    if (!this.ready || !this.sinkId) return;
    await this.driver.setSink(el, this.sinkId).catch(() => {});
  }

  /** 设置变了、设备插拔了都调这个：重新决定声音往哪送 */
  async setChoice(choice: string): Promise<void> {
    const token = ++this.token;
    this.ready = true;
    const follow = !choice || choice === FOLLOW_SYSTEM;
    let sinkId: string | null = null;
    let missing: string | null = null;
    let error: string | null = null;
    const outs = await invoke<OutputsSnapshot>("audio_outputs").catch(() => null);
    const system = outs?.devices.find((d) => d.uid === outs.defaultUid)?.name ?? null;
    if (!follow) {
      try {
        const plugged = !outs || outs.devices.some((d) => sameDevice(d.name, choice));
        const hit = plugged ? (await this.driver.list()).find((d) => sameDevice(d.label, choice)) : undefined;
        if (hit) sinkId = hit.id;
        else missing = choice;
      } catch (e) {
        error = `没能列出出声设备（${String(e)}），现在从系统设置的设备出声`;
      }
    }
    if (token !== this.token) return;
    this.sinkId = sinkId;
    this.set({ choice, device: sinkId ? choice : null, missing, error, extraMs: sinkId ? ROUTE_EXTRA_MS : 0, system });
    await Promise.all([...this.buses.values()].map((b) => this.routeBus(b)));
  }

  private set(s: RouteState) {
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }
}

export const outputRouter = new OutputRouter();

/** 代替 ctx.destination：声音按「出声设备」的设置送出去 */
export const outputFor = (ctx: AudioContext): AudioNode => outputRouter.outputFor(ctx);

/** 老师说话这类 <audio>，play() 之前调 */
export const routeElement = (el: HTMLMediaElement): Promise<void> => outputRouter.routeElement(el);

/** 现在比直连多出来的延迟（ms） */
export const routeExtraMs = (): number => outputRouter.current.extraMs;

/**
 * 录音延迟按「耳机」分别记（`recordLatency`）：选定设备时多了一段延迟，和跟系统时分开记，
 * 换了设备录音栏就会显示「未校准」，提示重新校准。
 */
export function recordRouteName(systemOutput: string | null | undefined): string {
  const s = outputRouter.current;
  return s.device ? `${s.device}（波点选定）` : systemOutput || "默认输出";
}

/** 没插上 / 换不过去时给用户的一句话 */
export function routeNotice(s: RouteState): string | null {
  if (s.missing) return `选定的出声设备「${s.missing}」没插上，现在从系统设置的${s.system ? `「${s.system}」` : "设备"}出声。插回来会自动换回去。`;
  return s.error;
}

/** 「出声设备」下拉框的选项：每个设备一项 + 跟系统设置；选定的设备没插上也列出来 */
export function outputOptions(names: { name: string }[], choice: string, defaultName: string | null): { value: string; label: string }[] {
  const opts = names.map((d) => ({ value: d.name, label: d.name }));
  if (choice && choice !== FOLLOW_SYSTEM && !names.some((d) => sameDevice(d.name, choice))) opts.push({ value: choice, label: `${choice}（没插上）` });
  opts.push({ value: FOLLOW_SYSTEM, label: `跟系统设置${defaultName ? `（现在是 ${defaultName}）` : ""}` });
  return opts;
}
