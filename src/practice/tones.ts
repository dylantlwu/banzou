/**
 * 合成钢琴给音：基音 + 几个泛音，快起慢落的包络。不用任何音频素材。
 */
export function midiToHz(m: number) {
  return 440 * 2 ** ((m - 69) / 12);
}

export function playNote(ctx: BaseAudioContext, dest: AudioNode, midi: number, when: number, dur: number, velocity = 0.5) {
  const hz = midiToHz(midi);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(velocity, when + 0.006);
  env.gain.exponentialRampToValueAtTime(velocity * 0.35, when + 0.35);
  env.gain.setTargetAtTime(velocity * 0.2, when + 0.35, 0.8);
  env.gain.setTargetAtTime(0.0001, when + dur, 0.08);
  env.connect(dest);
  const partials: [number, number, OscillatorType][] = [
    [1, 1, "sine"],
    [2, 0.35, "sine"],
    [3, 0.12, "triangle"],
    [4, 0.05, "sine"],
  ];
  for (const [mul, amp, type] of partials) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = hz * mul;
    const g = ctx.createGain();
    g.gain.value = amp / 1.5;
    osc.connect(g).connect(env);
    osc.start(when);
    osc.stop(when + dur + 0.6);
  }
}

/** 和弦（准备音）：根音大三和弦 */
export function playChord(ctx: BaseAudioContext, dest: AudioNode, root: number, when: number, dur: number) {
  for (const d of [0, 4, 7]) playNote(ctx, dest, root + d, when, dur, 0.28);
}
