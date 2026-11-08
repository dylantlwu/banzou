/**
 * 耳机延迟校准（不需要麦克风）：耳机里播放一串节拍，跟着节拍按空格。
 * 按键时间减去节拍的发声时间 ≈ 输出延迟（规律节拍下人会预判，反应时间基本抵消）。
 */

export const CALIBRATION_BEATS = 10;
export const CALIBRATION_INTERVAL = 0.75;
/** 前几拍用来找节奏，不计入 */
export const CALIBRATION_SKIP = 2;
export const MAX_LATENCY_MS = 600;

/**
 * @param clicks 每一拍的发声时刻（音频时钟，秒）
 * @param taps 每次按键的时刻（同一时钟，秒）
 * @returns 估计的延迟（毫秒），有效按键太少时返回 null
 */
export function estimateLatencyMs(
  clicks: number[],
  taps: number[],
  interval = CALIBRATION_INTERVAL,
  skip = CALIBRATION_SKIP,
): number | null {
  const early = 0.1; // 允许最多抢拍 100ms
  const offsets: number[] = [];
  const used = new Set<number>();
  for (const tap of taps) {
    // 找按键前（含抢拍余量）最近的一拍
    let idx = -1;
    for (let i = 0; i < clicks.length; i++) if (clicks[i] <= tap + early) idx = i;
    if (idx < skip || used.has(idx)) continue;
    const d = tap - clicks[idx];
    if (d < -early || d > interval - early) continue;
    used.add(idx);
    offsets.push(d);
  }
  if (offsets.length < 4) return null;
  offsets.sort((a, b) => a - b);
  const mid = offsets.length >> 1;
  const median = offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
  return Math.round(Math.min(MAX_LATENCY_MS, Math.max(0, median * 1000)));
}
