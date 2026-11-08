/**
 * 导出成品（PRD 4.5）：伴奏 + 修后人声（带效果链）离线混音 → 32 位浮点立体声 wav（+ m4a），
 * 存到 `<素材文件夹>/录音/<歌名>/导出/`。混音用 OfflineAudioContext，和试听的效果链完全一样。
 */
import { invoke } from "@tauri-apps/api/core";
import { floatsToBase64 } from "../audio/recorder";
import { type FxSettings, buildChain } from "./effects";

export interface MixInput {
  accompaniment: AudioBuffer;
  voice: AudioBuffer;
  /** 人声第 0 个采样对应的歌曲时间 */
  voiceStart: number;
  fx: FxSettings;
}

export async function renderMix({ accompaniment, voice, voiceStart, fx }: MixInput, sampleRate = 48000): Promise<AudioBuffer> {
  const length = Math.ceil(Math.max(accompaniment.duration, voiceStart + voice.duration) * sampleRate);
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  const acc = ctx.createBufferSource();
  acc.buffer = accompaniment;
  const accGain = ctx.createGain();
  accGain.gain.value = fx.accGain;
  acc.connect(accGain).connect(ctx.destination);
  acc.start(0);

  const chain = buildChain(ctx, fx);
  chain.output.connect(ctx.destination);
  const v = ctx.createBufferSource();
  v.buffer = voice;
  v.connect(chain.input);
  if (voiceStart >= 0) v.start(voiceStart);
  else v.start(0, -voiceStart);
  const out = await ctx.startRendering();
  // 防爆音：峰值超过 0.99 就整体压下来
  let peak = 0;
  for (let c = 0; c < out.numberOfChannels; c++) for (const s of out.getChannelData(c)) peak = Math.max(peak, Math.abs(s));
  if (peak > 0.99) {
    const g = 0.99 / peak;
    for (let c = 0; c < out.numberOfChannels; c++) {
      const d = out.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
  }
  return out;
}

/** 把渲染好的立体声写盘，返回生成的文件（wav，以及 m4a） */
export async function writeMix(
  title: string,
  name: string,
  buffer: AudioBuffer,
  m4a: boolean,
  onProgress?: (p: number) => void,
): Promise<string[]> {
  const path = await invoke<string>("export_begin", { title, name, sampleRate: buffer.sampleRate, channels: 2 });
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const chunk = buffer.sampleRate; // 一秒一段
  for (let i = 0; i < L.length; i += chunk) {
    const n = Math.min(chunk, L.length - i);
    const inter = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      inter[2 * k] = L[i + k];
      inter[2 * k + 1] = R[i + k];
    }
    await invoke("export_append", { path, data: floatsToBase64(inter) });
    onProgress?.(Math.min(1, (i + n) / L.length));
  }
  return invoke<string[]>("export_finish", { path, m4a });
}
