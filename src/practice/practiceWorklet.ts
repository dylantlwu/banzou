/** AudioWorklet 壳：麦克风 → PitchTracker，每 50ms 把音高帧发给主线程 */
import { type PitchFrame, PitchTracker } from "./pitchTracker";

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class PracticeProcessor extends AudioWorkletProcessor {
  private tracker = new PitchTracker(sampleRate);
  private pending: PitchFrame[] = [];
  private last = 0;

  process(inputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    if (input) {
      // currentTime 是这块第一个采样的时刻
      this.pending.push(...this.tracker.push(input, currentTime + (input.length - 1) / sampleRate));
      if (currentTime - this.last >= 0.05 && this.pending.length) {
        this.port.postMessage(this.pending);
        this.pending = [];
        this.last = currentTime;
      }
    }
    return true;
  }
}

registerProcessor("banzou-practice", PracticeProcessor);
