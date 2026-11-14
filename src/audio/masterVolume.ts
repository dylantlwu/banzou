/**
 * 总音量（PRD 4.0 播放栏的喇叭）。
 * 滑杆是 0–1 的位置，按听感换成增益（平方：中间那格听起来大约一半响）；静音 = 0。
 * 歌曲走播放引擎的总音量节点；老师说话这类 <audio> 用 followMasterVolume 跟着它。
 */
export function volumeGain(position: number, muted: boolean): number {
  if (muted || !Number.isFinite(position)) return 0;
  const p = Math.min(1, Math.max(0, position));
  return Math.round(p * p * 1000) / 1000;
}

let current = 1;
const elements = new Set<HTMLMediaElement>();

/** 应用里改了总音量时调：正在放的老师声音马上跟着变 */
export function setMasterGain(gain: number): void {
  current = Math.min(1, Math.max(0, gain));
  for (const el of elements) el.volume = current;
}

export function masterGain(): number {
  return current;
}

/** 让一个 <audio> 跟着总音量：现在就设好，放完或出错后不再跟 */
export function followMasterVolume(el: HTMLMediaElement): HTMLMediaElement {
  el.volume = current;
  elements.add(el);
  const done = () => elements.delete(el);
  el.addEventListener("ended", done, { once: true });
  el.addEventListener("error", done, { once: true });
  el.addEventListener("pause", done, { once: true });
  return el;
}
