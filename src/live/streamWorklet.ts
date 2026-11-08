/**
 * AudioWorklet：把直播混音（伴奏 + 修过的人声）转成 16 位立体声，每 40ms 交给主线程发给直播服务。
 */
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class StreamCapture extends AudioWorkletProcessor {
  private frames = Math.round(sampleRate * 0.04);
  private buf = new Int16Array(this.frames * 2);
  private n = 0;
  private peak = 0;

  process(inputs: Float32Array[][]) {
    const L = inputs[0]?.[0];
    const R = inputs[0]?.[1] ?? L;
    if (!L) return true;
    for (let i = 0; i < L.length; i++) {
      const l = Math.max(-1, Math.min(1, L[i]));
      const r = Math.max(-1, Math.min(1, R![i]));
      this.peak = Math.max(this.peak, Math.abs(l), Math.abs(r));
      this.buf[2 * this.n] = l * 32767;
      this.buf[2 * this.n + 1] = r * 32767;
      if (++this.n === this.frames) {
        this.port.postMessage({ pcm: this.buf.buffer, peak: this.peak }, [this.buf.buffer]);
        this.buf = new Int16Array(this.frames * 2);
        this.n = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

registerProcessor("banzou-stream", StreamCapture);
