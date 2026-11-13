/**
 * 真机诊断：启动时带 BANZOU_SELFTEST=output 才运行，结果写到 selftest.log。
 * 用真的播放引擎放一段很轻的正弦音：先放 16 秒、停 6 秒、再放 8 秒。这期间在控制中心（或用 CoreAudio）切出声设备，
 * 日志每秒记一次系统默认设备、音频时钟和播放位置，收到切换事件时记下引擎兜底检查的结果。
 * 时钟、位置一直在走（暂停时位置不动），每次切换后 ensureOutput=ok，就是声音跟过去了。应用本身不改系统设置。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AudioEngine } from "./engine";
import type { OutputsSnapshot } from "./outputDevice";

/** 很轻的 220Hz 正弦音（16 位单声道 wav） */
function toneWav(seconds: number, rate = 44100, amp = 0.03): Blob {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * amp * 32767), true);
  return new Blob([buf], { type: "audio/wav" });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runOutputSelftest(log: (m: string) => Promise<unknown>) {
  await log("output selftest start");
  const engine = new AudioEngine();
  const t0 = performance.now();
  const sec = () => ((performance.now() - t0) / 1000).toFixed(1);
  const unlisten = await listen<OutputsSnapshot>("audio-output-changed", async (e) => {
    const name = e.payload.devices.find((d) => d.uid === e.payload.defaultUid)?.name ?? "?";
    const r = await engine.ensureOutput(true);
    await log(`[${sec()}s] 系统默认换成 ${name} → ensureOutput=${r}`);
  });
  try {
    await engine.load([{ id: "tone", url: URL.createObjectURL(toneWav(60)) }]);
    const tick = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const c0 = engine.context.currentTime;
        await sleep(1000);
        const s = await invoke<OutputsSnapshot>("audio_outputs");
        const name = s.devices.find((d) => d.uid === s.defaultUid)?.name ?? "?";
        await log(`[${sec()}s] ${name} ctx=${engine.context.state} clock+${(engine.context.currentTime - c0).toFixed(2)} pos=${engine.transport.position().toFixed(2)} ${engine.transport.playing ? "playing" : "paused"}`);
      }
    };
    await engine.play();
    await tick(16);
    engine.pause();
    await tick(6);
    await engine.play();
    await tick(8);
  } catch (e) {
    await log("ERROR " + String(e));
  } finally {
    unlisten();
    engine.dispose();
    await log("output selftest end");
  }
}
