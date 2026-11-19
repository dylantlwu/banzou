/**
 * 真机自检「出声设备」（BANZOU_SELFTEST=route 启动才运行，结果写到 selftest.log，不在界面上出现）。
 * 走的是正式的 outputRouter：
 * 1. 跟系统 → 选定名字里有「扬声器」的设备 → 老师说话那样的 <audio>，各放 3 秒轻音（外面看哪个设备在出声）；
 * 2. 有 BlackHole 2ch 时量延迟：日志写 READY 后外面把系统默认切到 BlackHole，
 *    交替「跟系统」（直连）和「选定 BlackHole」两条路放「嗒」，从 BlackHole 录回来比较；
 * 最后换回「跟系统」。
 */
import { invoke } from "@tauri-apps/api/core";
import { Recorder, type Chunk } from "./recorder";
import { FOLLOW_SYSTEM } from "./micChoice";
import type { OutputsSnapshot } from "./outputDevice";
import { outputFor, outputRouter, routeElement } from "./outputRoute";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tone(ctx: AudioContext, dest: AudioNode, hz: number, seconds: number) {
  const o = ctx.createOscillator();
  o.frequency.value = hz;
  const g = ctx.createGain();
  g.gain.value = 0.03;
  o.connect(g).connect(dest);
  o.start();
  o.stop(ctx.currentTime + seconds);
}

function click(ctx: AudioContext, dest: AudioNode, when: number) {
  const o = ctx.createOscillator();
  o.frequency.value = 2000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(0.6, when + 0.001);
  g.gain.setValueAtTime(0.6, when + 0.006);
  g.gain.linearRampToValueAtTime(0, when + 0.008);
  o.connect(g).connect(dest);
  o.start(when);
  o.stop(when + 0.02);
}

/** 一秒 330Hz 轻音的 wav（模拟老师说话的 <audio>） */
function toneWav(rate = 44100): string {
  const n = rate * 3;
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  buf.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true);
  buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true);
  buf.setUint32(28, rate * 2, true);
  buf.setUint16(32, 2, true);
  buf.setUint16(34, 16, true);
  str(36, "data");
  buf.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) buf.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 330 * i) / rate) * 1000, true);
  return URL.createObjectURL(new Blob([buf.buffer], { type: "audio/wav" }));
}

/** 每一下「嗒」的起点相对排程时刻晚了多少秒（窗口内过半峰值的第一个采样） */
function findLags(chunks: Chunk[], rate: number, clicks: number[]): (number | null)[] {
  const first = chunks[0]?.time ?? 0;
  const all = new Float32Array(chunks.reduce((n, c) => n + c.data.length, 0));
  let o = 0;
  for (const c of chunks) {
    all.set(c.data, o);
    o += c.data.length;
  }
  const at = (t: number) => Math.round((t - first) * rate);
  return clicks.map((t) => {
    const s = Math.max(0, at(t - 0.1));
    const e = Math.min(all.length, at(t + 0.5));
    let peak = 0;
    for (let i = s; i < e; i++) peak = Math.max(peak, Math.abs(all[i]));
    if (peak < 0.01) return null;
    for (let i = s; i < e; i++) if (Math.abs(all[i]) > peak / 2) return i / rate + first - t;
    return null;
  });
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

export async function runRouteSelftest(log: (m: string) => Promise<unknown>) {
  await log("route selftest start");
  try {
    const outs = await invoke<OutputsSnapshot>("audio_outputs");
    const speaker = outs.devices.find((d) => d.name.includes("扬声器"))?.name;
    const loop = outs.devices.find((d) => d.name.toLowerCase().includes("blackhole 2ch"))?.name;
    await log(`system=${outs.devices.find((d) => d.uid === outs.defaultUid)?.name} speaker=${speaker} loop=${loop}`);
    const ctx = new AudioContext({ latencyHint: "interactive" });
    await ctx.resume();
    const out = outputFor(ctx);

    await outputRouter.setChoice(FOLLOW_SYSTEM);
    await log("ROUTE_SYSTEM " + JSON.stringify(outputRouter.current));
    tone(ctx, out, 220, 3);
    await sleep(3200);

    if (speaker) {
      await outputRouter.setChoice(speaker);
      await sleep(300);
      await log("ROUTE_SPEAKER " + JSON.stringify(outputRouter.current));
      tone(ctx, out, 220, 3);
      await sleep(3200);
      const el = new Audio(toneWav());
      await routeElement(el);
      await log("ROUTE_ELEMENT sinkId=" + (el as HTMLAudioElement & { sinkId?: string }).sinkId);
      await el.play();
      await sleep(3200);
    }

    await outputRouter.setChoice("不存在的设备");
    await log("ROUTE_MISSING " + JSON.stringify(outputRouter.current));

    if (loop) {
      const rec = new Recorder(ctx);
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
      await rec.open(list.find((d) => d.label.toLowerCase().includes("blackhole 2ch"))?.deviceId);
      await log("READY（把系统默认输出切到 BlackHole 2ch）mic=" + rec.label);
      for (let i = 0; i < 60; i++) {
        const s = await invoke<OutputsSnapshot>("audio_outputs");
        if (s.devices.find((d) => d.uid === s.defaultUid)?.name.toLowerCase().includes("blackhole 2ch")) break;
        await sleep(250);
      }
      await sleep(1000);
      const res: Record<string, number[]> = { A: [], B: [] };
      for (let round = 0; round < 6; round++) {
        const path = round % 2 ? "B" : "A";
        await outputRouter.setChoice(path === "A" ? FOLLOW_SYSTEM : loop);
        await sleep(600);
        const chunks: Chunk[] = [];
        rec.start((c) => chunks.push(c));
        await sleep(300);
        const t0 = ctx.currentTime + 0.3;
        const clicks = Array.from({ length: 4 }, (_, i) => t0 + i * 0.7);
        for (const t of clicks) click(ctx, out, t);
        await sleep((clicks[3] - ctx.currentTime + 0.8) * 1000);
        await rec.stop();
        const lags = findLags(chunks, rec.sampleRate, clicks);
        lags.forEach((l) => l !== null && res[path].push(l));
        await log(`round ${round} ${path}: ` + lags.map((l) => (l === null ? "-" : Math.round(l * 1000))).join(" "));
      }
      const a = median(res.A);
      const b = median(res.B);
      await log(`DONE 跟系统=${Math.round(a * 1000)}ms 选定=${Math.round(b * 1000)}ms → 多 ${Math.round((b - a) * 1000)}ms（${res.A.length}/${res.B.length} 下）`);
      rec.close();
    }
    await outputRouter.setChoice(FOLLOW_SYSTEM);
    await ctx.close();
  } catch (e) {
    await log("ERROR " + String(e));
  }
  await log("route selftest end");
}
