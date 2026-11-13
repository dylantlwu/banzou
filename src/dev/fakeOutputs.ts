/**
 * 测试模式的假出声设备：不碰真机的系统设置。
 * 在浏览器控制台里模拟用户在控制中心切设备：
 *   __banzouOutputs.systemSwitch("pd")          // 切到 PD200X
 *   __banzouOutputs.systemSwitch("mac", true)   // 切到 Mac mini，同时把正在用的 AudioContext 关掉，模拟哑掉、要重建
 *   __banzouOutputs.unplug("airpods") / plug("airpods")
 * 地址参数：?test&out=mac（开应用时系统默认是哪个，不写是 PD200X）
 */
import type { OutputDevice, OutputsSnapshot } from "../audio/outputDevice";
import { TEST_OUTPUT_EVENT } from "../audio/useFollowOutput";

const ALL: OutputDevice[] = [
  { uid: "pd", name: "PD200X Podcast Microphone", kind: "usb" },
  { uid: "mac", name: "Mac mini扬声器", kind: "speaker" },
  { uid: "dell", name: "DELL S2721DGF", kind: "hdmi" },
  { uid: "airpods", name: "AirPods", kind: "bluetooth" },
];

export function installFakeOutputs(): (cmd: string, args: Record<string, unknown>) => Promise<unknown> | null {
  let present = new Set(["pd", "mac", "dell"]);
  let defaultUid = new URLSearchParams(location.search).get("out") ?? "pd";
  let engineCtx: (() => AudioContext) | null = null;
  window.addEventListener("banzou-play", (e) => {
    const engine = (e as CustomEvent).detail.engine as { context: AudioContext };
    engineCtx = () => engine.context;
  });

  const snapshot = (): OutputsSnapshot => ({ devices: ALL.filter((d) => present.has(d.uid)), defaultUid: present.has(defaultUid) ? defaultUid : null });
  const announce = () => setTimeout(() => window.dispatchEvent(new CustomEvent(TEST_OUTPUT_EVENT, { detail: snapshot() })), 50);

  const api = {
    snapshot,
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
    unplug(uid: string) {
      present.delete(uid);
      if (defaultUid === uid) defaultUid = "mac";
      announce();
    },
  };
  (window as unknown as { __banzouOutputs: typeof api }).__banzouOutputs = api;

  return (cmd) => (cmd === "audio_outputs" ? Promise.resolve(snapshot()) : null);
}
