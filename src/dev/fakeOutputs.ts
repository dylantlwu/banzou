/**
 * 测试模式的假出声设备：不碰真机的系统设置。
 * 在浏览器控制台里模拟用户在控制中心切设备：
 *   __banzouOutputs.systemSwitch("pd")          // 切到 PD200X
 *   __banzouOutputs.systemSwitch("mac", true)   // 切到 Mac mini，同时把正在用的 AudioContext 关掉，模拟哑掉、要重建
 *   __banzouOutputs.unplug("airpods") / plug("airpods")
 *   __banzouOutputs.unplugInput("pd") / plugInput("pd")   // 拔掉 / 插上 PD200X 麦克风（配合 &fakemic）
 *   __banzouOutputs.route() / sinks()        // 「出声设备」现在送去哪、每个 <audio> 被送到哪个假设备
 * 地址参数：?test&out=mac（开应用时系统默认是哪个，不写是 PD200X）
 */
import type { OutputDevice, OutputsSnapshot } from "../audio/outputDevice";
import { TEST_OUTPUT_EVENT } from "../audio/useFollowOutput";
import { outputRouter } from "../audio/outputRoute";

const ALL: OutputDevice[] = [
  { uid: "pd", name: "PD200X Podcast Microphone", kind: "usb" },
  { uid: "mac", name: "Mac mini扬声器", kind: "speaker" },
  { uid: "dell", name: "DELL S2721DGF", kind: "hdmi" },
  { uid: "airpods", name: "AirPods", kind: "bluetooth" },
];

/** 假麦克风（&fakemic 时 enumerateDevices / getUserMedia 用这份）；系统默认输入是第一个插着的 */
const INPUTS: (OutputDevice & { present: boolean })[] = [
  { uid: "fake", name: "假麦克风（测试）", kind: "usb", present: true },
  { uid: "pd", name: "PD200X Podcast Microphone", kind: "usb", present: true },
  { uid: "airpods", name: "小明的AirPods Pro", kind: "bluetooth", present: true },
];
export const fakeInputs = () => INPUTS.filter((d) => d.present);

export function installFakeOutputs(): (cmd: string, args: Record<string, unknown>) => Promise<unknown> | null {
  let present = new Set(["pd", "mac", "dell"]);
  let defaultUid = new URLSearchParams(location.search).get("out") ?? "pd";
  let engineCtx: (() => AudioContext) | null = null;
  window.addEventListener("banzou-play", (e) => {
    const engine = (e as CustomEvent).detail.engine as { context: AudioContext };
    engineCtx = () => engine.context;
  });

  // 「出声设备」用假的 setSinkId：记下送到哪个假设备，声音照样从浏览器默认的出来
  const sinks = new Map<HTMLMediaElement, string>();
  outputRouter.useDriver({
    list: () => Promise.resolve(ALL.filter((d) => present.has(d.uid)).map((d) => ({ id: `fake-${d.uid}`, label: d.name }))),
    setSink: (el, id) => (sinks.set(el, id), Promise.resolve()),
  });

  const snapshot = (): OutputsSnapshot => ({ devices: ALL.filter((d) => present.has(d.uid)), defaultUid: present.has(defaultUid) ? defaultUid : null });
  const announce = () => setTimeout(() => window.dispatchEvent(new CustomEvent(TEST_OUTPUT_EVENT, { detail: snapshot() })), 50);

  const api = {
    snapshot,
    route: () => outputRouter.current,
    sinks: () => [...sinks].map(([el, id]) => ({ id, playing: !el.paused, src: el.srcObject ? "总线" : el.currentSrc.slice(0, 30) })),
    /** 当前引擎用的 AudioContext（测试时看有没有重建） */
    context: () => engineCtx?.() ?? null,
    systemSwitch(uid: string, breakEngine = false) {
      defaultUid = uid;
      if (breakEngine) void engineCtx?.().close();
      announce();
    },
    plug(uid: string) {
      present = new Set([...present, uid]);
      announce();
    },
    unplugInput(uid: string) {
      const d = INPUTS.find((x) => x.uid === uid);
      if (d) d.present = false;
      announce();
    },
    plugInput(uid: string) {
      const d = INPUTS.find((x) => x.uid === uid);
      if (d) d.present = true;
      announce();
    },
    unplug(uid: string) {
      present.delete(uid);
      if (defaultUid === uid) defaultUid = "mac";
      announce();
    },
  };
  (window as unknown as { __banzouOutputs: typeof api }).__banzouOutputs = api;

  return (cmd) => {
    if (cmd === "audio_outputs") return Promise.resolve(snapshot());
    if (cmd === "audio_inputs") return Promise.resolve({ devices: fakeInputs().map(({ uid, name, kind }) => ({ uid, name, kind })), defaultUid: fakeInputs()[0]?.uid ?? null });
    return null;
  };
}
