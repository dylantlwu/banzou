export interface Peaks {
  /** 每个桶的最大振幅（0–1） */
  values: Float32Array;
  perSecond: number;
}

/** 把多声道采样压缩成波形峰值，用于画人声波形 */
export function computePeaks(channels: Float32Array[], sampleRate: number, perSecond = 100): Peaks {
  const length = channels[0]?.length ?? 0;
  const bucket = Math.max(1, Math.round(sampleRate / perSecond));
  const count = Math.ceil(length / bucket);
  const values = new Float32Array(count);
  for (const data of channels) {
    for (let b = 0; b < count; b++) {
      const end = Math.min(length, (b + 1) * bucket);
      let max = values[b];
      for (let i = b * bucket; i < end; i++) {
        const v = Math.abs(data[i]);
        if (v > max) max = v;
      }
      values[b] = max;
    }
  }
  return { values, perSecond: sampleRate / bucket };
}
