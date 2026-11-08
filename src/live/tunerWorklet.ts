/**
 * AudioWorklet 壳：麦克风 → RealtimeTuner → 输出。主线程通过 port 传参数、原唱音高和播放时钟。
 */
import { RealtimeTuner } from "./rtTuner";

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class TunerProcessor extends AudioWorkletProcessor {
  private tuner = new RealtimeTuner(sampleRate);
  private sinceInfo = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "params") this.tuner.setParams(m.params);
      else if (m.type === "ref") this.tuner.setReference(m.ref, m.hop);
      else if (m.type === "clock") this.tuner.setClock(m.clock);
    };
    this.port.postMessage({ type: "latency", samples: this.tuner.latency });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (input) this.tuner.process(input, output, currentTime);
    else output.fill(0);
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(output);
    this.sinceInfo += output.length;
    if (this.sinceInfo >= sampleRate / 10) {
      this.sinceInfo = 0;
      this.port.postMessage({ type: "info", info: this.tuner.info });
    }
    return true;
  }
}

registerProcessor("banzou-tuner", TunerProcessor);
