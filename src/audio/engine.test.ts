import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "./engine";

// 最小的假 Web Audio：只记录连接和启动参数，时钟手动拨或跟着真实时间走
class FakeParam {
  value = 1;
  setTargetAtTime(v: number) {
    this.value = v;
  }
  setValueAtTime() {}
  linearRampToValueAtTime() {}
}
class FakeNode {
  out: unknown[] = [];
  connect<T>(n: T): T {
    this.out.push(n);
    return n;
  }
  disconnect() {
    this.out = [];
  }
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakeSource extends FakeNode {
  buffer: unknown = null;
  playbackRate = new FakeParam();
  onended = null;
  started: { when: number; offset: number } | null = null;
  start(when: number, offset: number) {
    this.started = { when, offset };
  }
  stop() {}
}
class FakeCtx {
  static all: FakeCtx[] = [];
  /** true：时钟跟着真实时间走；false：手动拨 */
  static live = false;
  private born = performance.now();
  manual = 0;
  state: AudioContextState = "running";
  destination = new FakeNode();
  sources: FakeSource[] = [];
  constructor() {
    FakeCtx.all.push(this);
  }
  get currentTime() {
    return FakeCtx.live && this.state === "running" ? (performance.now() - this.born) / 1000 : this.manual;
  }
  createGain() {
    return new FakeGain();
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  resume() {
    if (this.state !== "closed") this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 100 });
  }
}


async function loaded() {
  const e = new AudioEngine();
  await e.load([
    { id: "acc", url: "a.wav", gain: 1 },
    { id: "vocal", url: "v.wav", gain: 0, group: "voice" },
  ]);
  return e;
}

beforeEach(() => {
  FakeCtx.all = [];
  FakeCtx.live = false;
  vi.stubGlobal("AudioContext", FakeCtx);
  vi.stubGlobal("fetch", async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
});
afterEach(() => vi.unstubAllGlobals());

describe("出声设备变了以后", () => {
  it("AudioContext 被关掉了：重建，并从原位置接着放，音量和效果链都还在", async () => {
    const e = await loaded();
    const factory = vi.fn((ctx: BaseAudioContext) => {
      const n = (ctx as unknown as FakeCtx).createGain() as unknown as AudioNode;
      return { input: n, output: n };
    });
    e.setGroupChain("voice", factory);
    e.setGain("acc", 0.4);
    await e.play();
    const first = FakeCtx.all[0];
    first.manual = 10.03; // 放了 10 秒
    await first.close();

    expect(await e.ensureOutput(true)).toBe("rebuilt");
    expect(FakeCtx.all).toHaveLength(2);
    const second = FakeCtx.all[1];
    expect(e.context).toBe(second);
    expect(e.transport.playing).toBe(true);
    const offsets = second.sources.map((s) => s.started?.offset);
    expect(offsets).toHaveLength(2);
    for (const o of offsets) expect(o).toBeCloseTo(10, 5);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[1][0]).toBe(second);
    // 新的音轨音量节点沿用原来的音量
    const gains = (second.sources.map((s) => s.out[0]) as FakeGain[]).map((g) => g.gain.value).sort();
    expect(gains).toEqual([0, 0.4]);
  });

  it("录音或直播中（不许重建）就只报告卡住了", async () => {
    const e = await loaded();
    await e.play();
    await FakeCtx.all[0].close();
    expect(await e.ensureOutput(false)).toBe("stalled");
    expect(FakeCtx.all).toHaveLength(1);
  });

  it("没在放：什么都不用做", async () => {
    const e = await loaded();
    expect(await e.ensureOutput(true)).toBe("ok");
    expect(FakeCtx.all).toHaveLength(1);
  });

  it("时钟正常在走：不重建", async () => {
    FakeCtx.live = true;
    const e = await loaded();
    await e.play();
    expect(await e.ensureOutput(true, 150)).toBe("ok");
    expect(FakeCtx.all).toHaveLength(1);
  });

  it("被挂起了：resume 之后在走，就不重建", async () => {
    FakeCtx.live = true;
    const e = await loaded();
    await e.play();
    FakeCtx.all[0].state = "suspended";
    expect(await e.ensureOutput(true, 150)).toBe("resumed");
    expect(FakeCtx.all).toHaveLength(1);
  });

  it("时钟停住不走：重建", async () => {
    const e = await loaded();
    await e.play();
    FakeCtx.all[0].manual = 5;
    expect(await e.ensureOutput(true, 150)).toBe("rebuilt");
    expect(FakeCtx.all).toHaveLength(2);
    expect(FakeCtx.all[0].state).toBe("closed");
  });
});
