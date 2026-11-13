/**
 * 诊断自检：启动时带 BANZOU_SELFTEST=1 才运行，结果写到应用日志目录的 selftest.log。
 * 用来在真实 app（WKWebView）里确认麦克风、AudioWorklet 等能力，开发者看不到窗口时也能验证。
 */
import { invoke } from "@tauri-apps/api/core";

const log = (m: string) => invoke("debug_log", { message: `${new Date().toISOString()} ${m}` }).catch(() => {});

export async function runSelftestIfEnabled() {
  const mode = await invoke<string>("selftest_mode").catch(() => "");
  if (mode === "output") {
    const { runOutputSelftest } = await import("./audio/outputSelftest");
    return runOutputSelftest(log);
  }
  if (!(await invoke<boolean>("selftest_enabled").catch(() => false))) return;
  await log("selftest start, ua=" + navigator.userAgent);
  await log("mediaDevices=" + Boolean(navigator.mediaDevices) + " getUserMedia=" + Boolean(navigator.mediaDevices?.getUserMedia));
  try {
    const ctx = new AudioContext();
    await log(`AudioContext sampleRate=${ctx.sampleRate} baseLatency=${ctx.baseLatency} outputLatency=${(ctx as AudioContext & { outputLatency?: number }).outputLatency}`);
    await log("audioWorklet=" + Boolean(ctx.audioWorklet));
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const track = stream.getAudioTracks()[0];
    await log("getUserMedia ok: " + track.label + " " + JSON.stringify(track.getSettings()));
    const devices = await navigator.mediaDevices.enumerateDevices();
    await log("devices: " + JSON.stringify(devices.filter((d) => d.kind === "audioinput").map((d) => d.label)));
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    src.connect(an);
    await new Promise((r) => setTimeout(r, 1500));
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
    await log("mic rms=" + rms.toFixed(5) + " ctxState=" + ctx.state);
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
  } catch (e) {
    await log("ERROR " + (e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
  }
  await log("selftest end");
}
