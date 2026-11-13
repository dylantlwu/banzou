/**
 * 跟着系统的出声设备走（PRD 4.0「出声设备」）。
 * 波点不选设备、不改系统设置：用户在系统设置 / 控制中心里切，网页里的声音本来就跟着系统默认输出走
 * （WKWebView 没有 AudioContext.setSinkId）。Rust 端（`audio_out.rs`）在默认输出变了时发
 * `audio-output-changed`，播放器借这个机会确认声音真的跟过去了（`AudioEngine.ensureOutput`）。
 */

export interface OutputDevice {
  uid: string;
  name: string;
  kind: string;
}

export interface OutputsSnapshot {
  devices: OutputDevice[];
  defaultUid: string | null;
}

/** 系统默认输出换了（第一次拿到不算；只是插拔了别的设备也不算） */
export function defaultChanged(prev: OutputsSnapshot | null, next: OutputsSnapshot): boolean {
  return prev !== null && prev.defaultUid !== next.defaultUid;
}

/**
 * 换了设备之后检查声音是不是还在走：`elapsedMs` 里音频时钟至少要走过四分之一，
 * 否则当作卡住了（需要 resume，甚至重建 AudioContext）。
 */
export function clockStalled(t0: number, t1: number, elapsedMs: number): boolean {
  if (elapsedMs < 100) return false;
  return t1 - t0 < (elapsedMs / 1000) * 0.25;
}
