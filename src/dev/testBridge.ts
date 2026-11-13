/**
 * 浏览器测试模式（开发服务器 + 地址带 ?test）。
 * 模拟 Tauri 的 invoke / convertFileSrc：命令交给真实的 Rust 后端逻辑（devbridge），
 * 音频直接读 .testlib 里的真文件。正式 app 里不会加载这个文件。
 */
export function installTestBridge() {
  const w = window as unknown as Record<string, unknown>;
  let cb = 0;
  // ?test&nolib：模拟第一次打开（还没选素材文件夹），点「选择文件夹」后才有曲库
  let noLibrary = new URLSearchParams(location.search).has("nolib");
  w.__TAURI_INTERNALS__ = {
    transformCallback: () => ++cb,
    convertFileSrc: (p: string) => "/@fs" + p.split("/").map(encodeURIComponent).join("/"),
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      if (noLibrary && cmd === "choose_library_dir") noLibrary = false;
      else if (noLibrary && cmd !== "load_settings" && cmd !== "load_store" && cmd !== "live_info") throw "NO_LIBRARY";
      const res = await fetch(`/__bridge/${cmd}`, { method: "POST", body: JSON.stringify(args) });
      const data = (await res.json()) as { ok?: unknown; err?: string };
      if (data.err !== undefined) throw data.err;
      return data.ok;
    },
  };
  document.title = "波点（测试模式）";
  (window as unknown as { __BANZOU_TEST__: boolean }).__BANZOU_TEST__ = true;
}

/**
 * 假麦克风（地址带 ?test&fakemic）：拿到的「麦克风」是原唱人声，晚 FAKE_DELAY 秒、跟着伴奏唱，
 * 和真实录音一样走同一个 AudioContext。用来端到端验证录音存盘、延迟扣除和按原唱自动对齐。
 */
export const FAKE_DELAY = 0.09;

export function installFakeMic() {
  const Native = window.AudioContext;
  let appCtx: AudioContext | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;
  // 记下应用最近创建的 AudioContext（开发模式 StrictMode 会先建一个又马上关掉，所以取最新的）
  window.AudioContext = class extends Native {
    constructor(opts?: AudioContextOptions) {
      super(opts);
      appCtx = this;
      dest = null;
    }
  } as typeof AudioContext;

  let singer: AudioBufferSourceNode | null = null;
  const md = navigator.mediaDevices;
  md.getUserMedia = async () => {
    if (!appCtx) throw new Error("fake mic: 还没有 AudioContext");
    dest ??= appCtx.createMediaStreamDestination();
    const track = dest.stream.getAudioTracks()[0];
    Object.defineProperty(track, "label", { value: "假麦克风（测试）" });
    return dest.stream;
  };
  md.enumerateDevices = async () =>
    [
      { deviceId: "fake", kind: "audioinput", label: "假麦克风（测试）", groupId: "g", toJSON() {} },
      { deviceId: "airpods", kind: "audioinput", label: "小明的AirPods Pro", groupId: "h", toJSON() {} },
    ] as MediaDeviceInfo[];

  // 练声：按引擎给的提示「唱」——音阶 / 长音 / 听音唱一个偏高 15 音分的音，气息发一段噪声
  window.addEventListener("banzou-practice-expect", (e) => {
    const { ctx, midi, at, dur } = (e as CustomEvent).detail as { ctx: AudioContext; midi: number | null; at: number; dur: number };
    if (!dest || ctx !== appCtx) return;
    const start = at + FAKE_DELAY;
    if (midi === null) {
      const len = Math.round(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.08;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.start(start);
      return;
    }
    const osc = ctx.createOscillator();
    osc.frequency.value = 440 * 2 ** ((midi + 0.15 - 69) / 12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.3, start + 0.03);
    g.gain.setValueAtTime(0.3, start + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, start + dur);
    osc.connect(g).connect(dest);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  });

  window.addEventListener("banzou-play", (e) => {
    const { at, offset, engine } = (e as CustomEvent).detail as { at: number; offset: number; engine: { getBuffer(id: string): AudioBuffer | null } };
    const vocal = engine.getBuffer("vocal");
    if (!dest || !appCtx || !vocal) return;
    singer?.stop();
    singer = appCtx.createBufferSource();
    singer.buffer = vocal;
    singer.connect(dest);
    singer.start(at + FAKE_DELAY, offset);
  });
  window.addEventListener("banzou-stop", () => {
    singer?.stop();
    singer = null;
  });
}
