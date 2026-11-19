import { beforeEach, describe, expect, it, vi } from "vitest";

// Rust 端的设备名单（CoreAudio）
let rustDevices = [
  { uid: "pd", name: "PD200X Podcast Microphone", kind: "usb" },
  { uid: "mac", name: "Mac mini扬声器", kind: "speaker" },
];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => (cmd === "audio_outputs" ? Promise.resolve({ devices: rustDevices, defaultUid: "pd" }) : Promise.reject(new Error(cmd))),
}));

class FakeNode {
  out = new Set<unknown>();
  connect<T>(n: T): T {
    this.out.add(n);
    return n;
  }
  disconnect(n?: unknown) {
    if (n === undefined) this.out.clear();
    else if (!this.out.delete(n)) throw new Error("not connected");
  }
}
class FakeCtx {
  state = "running";
  destination = new FakeNode();
  msd: (FakeNode & { stream: object }) | null = null;
  private onState: (() => void) | null = null;
  createGain() {
    return new FakeNode();
  }
  createMediaStreamDestination() {
    this.msd = Object.assign(new FakeNode(), { stream: {} });
    return this.msd;
  }
  addEventListener(_: string, fn: () => void) {
    this.onState = fn;
  }
  close() {
    this.state = "closed";
    this.onState?.();
  }
}
class FakeAudio {
  static all: FakeAudio[] = [];
  srcObject: unknown = null;
  sink = "";
  playing = false;
  constructor() {
    FakeAudio.all.push(this);
  }
  play() {
    this.playing = true;
    return Promise.resolve();
  }
  pause() {
    this.playing = false;
  }
}
vi.stubGlobal("Audio", FakeAudio);

const { outputRouter, outputFor, routeElement, recordRouteName, routeNotice, outputOptions, ROUTE_EXTRA_MS } = await import("./outputRoute");

let failSink = false;
outputRouter.useDriver({
  list: () =>
    Promise.resolve([
      { id: "id-pd", label: "PD200X Podcast Microphone" },
      { id: "id-mac", label: "Mac mini扬声器" },
    ]),
  setSink: (el, id) => (failSink ? Promise.reject(new Error("坏了")) : (((el as unknown as FakeAudio).sink = id), Promise.resolve())),
});

const ctxOf = () => new FakeCtx() as unknown as AudioContext & FakeCtx;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("出声设备", () => {
  beforeEach(async () => {
    rustDevices = [
      { uid: "pd", name: "PD200X Podcast Microphone", kind: "usb" },
      { uid: "mac", name: "Mac mini扬声器", kind: "speaker" },
    ];
    failSink = false;
    await outputRouter.setChoice("");
  });

  it("没选过 / 跟系统：直接接 ctx.destination，没有额外延迟", async () => {
    const ctx = ctxOf();
    const bus = outputFor(ctx) as unknown as FakeNode;
    await flush();
    expect(bus.out.has(ctx.destination)).toBe(true);
    expect(outputRouter.current.extraMs).toBe(0);
    expect(recordRouteName("PD200X Podcast Microphone")).toBe("PD200X Podcast Microphone");
  });

  it("选定设备：经 <audio> 送到这个设备，不再接 destination；换回跟系统再接回去", async () => {
    const ctx = ctxOf();
    const bus = outputFor(ctx) as unknown as FakeNode;
    await outputRouter.setChoice("Mac mini扬声器");
    expect(bus.out.has(ctx.destination)).toBe(false);
    expect(bus.out.has(ctx.msd)).toBe(true);
    const el = FakeAudio.all.find((a) => a.srcObject === ctx.msd!.stream)!;
    expect(el.sink).toBe("id-mac");
    expect(el.playing).toBe(true);
    expect(outputRouter.current).toMatchObject({ device: "Mac mini扬声器", missing: null, extraMs: ROUTE_EXTRA_MS });
    expect(recordRouteName("PD200X Podcast Microphone")).toBe("Mac mini扬声器（波点选定）");

    await outputRouter.setChoice("@system");
    expect(bus.out.has(ctx.destination)).toBe(true);
    expect(bus.out.has(ctx.msd)).toBe(false);
    expect(el.playing).toBe(false);
  });

  it("选定之后新开的 AudioContext（练声、校准）也送到这个设备", async () => {
    await outputRouter.setChoice("Mac mini扬声器");
    const ctx = ctxOf();
    const bus = outputFor(ctx) as unknown as FakeNode;
    expect(bus.out.size).toBe(0); // 换好之前不出声，不会先从别的设备响一下
    await flush();
    await flush();
    expect(bus.out.has(ctx.msd)).toBe(true);
  });

  it("老师说话的 <audio> 送到同一个设备；跟系统时不动它", async () => {
    const el = new FakeAudio();
    await routeElement(el as unknown as HTMLMediaElement);
    expect(el.sink).toBe("");
    await outputRouter.setChoice("Mac mini扬声器");
    await routeElement(el as unknown as HTMLMediaElement);
    expect(el.sink).toBe("id-mac");
  });

  it("选定的没插上：从系统默认出声并提示；插回来自动换回去", async () => {
    const ctx = ctxOf();
    const bus = outputFor(ctx) as unknown as FakeNode;
    rustDevices = rustDevices.filter((d) => d.uid !== "mac");
    await outputRouter.setChoice("Mac mini扬声器");
    expect(bus.out.has(ctx.destination)).toBe(true);
    expect(outputRouter.current).toMatchObject({ device: null, missing: "Mac mini扬声器", extraMs: 0 });
    expect(routeNotice(outputRouter.current)).toContain("「Mac mini扬声器」没插上，现在从系统设置的「PD200X Podcast Microphone」出声");

    rustDevices = [...rustDevices, { uid: "mac", name: "Mac mini扬声器", kind: "speaker" }];
    await outputRouter.setChoice("Mac mini扬声器");
    expect(bus.out.has(ctx.msd)).toBe(true);
    expect(routeNotice(outputRouter.current)).toBeNull();
  });

  it("换不过去：退回系统默认出声，说出原因", async () => {
    const ctx = ctxOf();
    const bus = outputFor(ctx) as unknown as FakeNode;
    await flush();
    failSink = true;
    await outputRouter.setChoice("Mac mini扬声器");
    expect(bus.out.has(ctx.destination)).toBe(true);
    expect(routeNotice(outputRouter.current)).toContain("没能换到「Mac mini扬声器」");
  });

  it("AudioContext 关掉后停掉它的 <audio>", async () => {
    await outputRouter.setChoice("Mac mini扬声器");
    const ctx = ctxOf();
    outputFor(ctx);
    await flush();
    await flush();
    const el = FakeAudio.all.find((a) => a.srcObject === ctx.msd!.stream)!;
    ctx.close();
    expect(el.playing).toBe(false);
  });

  it("下拉框：每个设备一项 + 跟系统设置；选定的没插上也列出来", () => {
    const names = [{ name: "Mac mini扬声器" }];
    expect(outputOptions(names, "", "Mac mini扬声器").map((o) => o.label)).toEqual(["Mac mini扬声器", "跟系统设置（现在是 Mac mini扬声器）"]);
    expect(outputOptions(names, "AirPods", null).map((o) => o.label)).toEqual(["Mac mini扬声器", "AirPods（没插上）", "跟系统设置"]);
  });
});
