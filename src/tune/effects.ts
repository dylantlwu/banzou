/**
 * 人声效果链（PRD 4.5）：EQ → 压缩 → 混响，3 个预设，每项可单独开关。
 * 试听（AudioContext）和导出（OfflineAudioContext）用同一套，听到的就是导出的。
 * 降噪在后端渲染修音时做（需要整段处理）。
 */

export type Preset = "clean" | "pop" | "warm";

export interface FxSettings {
  preset: Preset;
  eq: boolean;
  comp: boolean;
  reverb: boolean;
  /** 人声 / 伴奏音量 0–1.5 */
  voiceGain: number;
  accGain: number;
}

export const DEFAULT_FX: FxSettings = { preset: "pop", eq: true, comp: true, reverb: true, voiceGain: 1, accGain: 0.8 };

export const PRESET_NAMES: Record<Preset, string> = { clean: "干净", pop: "流行", warm: "温暖" };

interface PresetDef {
  /** [类型, 频率, 增益 dB, Q] */
  eq: [BiquadFilterType, number, number, number][];
  comp: { threshold: number; ratio: number; attack: number; release: number; makeup: number };
  reverb: { seconds: number; wet: number; predelay: number };
}

const PRESETS: Record<Preset, PresetDef> = {
  clean: {
    eq: [["highpass", 100, 0, 0.7]],
    comp: { threshold: -20, ratio: 2.5, attack: 0.01, release: 0.2, makeup: 2 },
    reverb: { seconds: 0.9, wet: 0.12, predelay: 0.01 },
  },
  pop: {
    eq: [
      ["highpass", 100, 0, 0.7],
      ["peaking", 300, -2, 1],
      ["peaking", 3200, 3, 0.9],
      ["highshelf", 10000, 2, 0.7],
    ],
    comp: { threshold: -22, ratio: 4, attack: 0.005, release: 0.15, makeup: 4 },
    reverb: { seconds: 1.8, wet: 0.22, predelay: 0.025 },
  },
  warm: {
    eq: [
      ["highpass", 90, 0, 0.7],
      ["lowshelf", 250, 2.5, 0.7],
      ["highshelf", 8000, -2, 0.7],
    ],
    comp: { threshold: -20, ratio: 3, attack: 0.015, release: 0.25, makeup: 3 },
    reverb: { seconds: 2.4, wet: 0.25, predelay: 0.03 },
  },
};

/** 合成混响冲激响应：指数衰减的立体声噪声（不同上下文各自生成） */
function impulse(ctx: BaseAudioContext, seconds: number, predelay: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.round((seconds + predelay) * sr);
  const buf = ctx.createBuffer(2, len, sr);
  let seed = 12345;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = Math.round(predelay * sr); i < len; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const t = i / sr - predelay;
      d[i] = ((seed / 0x7fffffff) * 2 - 1) * Math.exp((-6.9 * t) / seconds);
    }
  }
  return buf;
}

export interface Chain {
  input: AudioNode;
  output: AudioNode;
}

/** 搭一条效果链 */
export function buildChain(ctx: BaseAudioContext, fx: FxSettings): Chain {
  const def = PRESETS[fx.preset];
  const input = ctx.createGain();
  input.gain.value = fx.voiceGain;
  let node: AudioNode = input;
  if (fx.eq) {
    for (const [type, freq, gain, q] of def.eq) {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.gain.value = gain;
      f.Q.value = q;
      node.connect(f);
      node = f;
    }
  }
  if (fx.comp) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = def.comp.threshold;
    c.ratio.value = def.comp.ratio;
    c.attack.value = def.comp.attack;
    c.release.value = def.comp.release;
    c.knee.value = 6;
    const makeup = ctx.createGain();
    makeup.gain.value = 10 ** (def.comp.makeup / 20);
    node.connect(c).connect(makeup);
    node = makeup;
  }
  const output = ctx.createGain();
  node.connect(output);
  if (fx.reverb) {
    const conv = ctx.createConvolver();
    conv.buffer = impulse(ctx, def.reverb.seconds, def.reverb.predelay);
    const wet = ctx.createGain();
    wet.gain.value = def.reverb.wet;
    node.connect(conv).connect(wet).connect(output);
  }
  return { input, output };
}
