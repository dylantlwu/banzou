// 建测试曲库 app/.testlib，测试模式里的保存只改这里。
//
// 用法：
//   node scripts/make-testlib.mjs                  生成一首示例歌曲（合成的伴奏 + 人声 + 原创歌词）
//   node scripts/make-testlib.mjs --from <文件夹>   用你自己的素材：音频硬链接（不占空间），歌词复制一份
//   加 --empty 表示不带歌词，从零开始测打轴
// 也可以用环境变量 BANZOU_LIBRARY 代替 --from。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(app, ".testlib");
const args = process.argv.slice(2);
const empty = args.includes("--empty");
const fromIdx = args.indexOf("--from");
const source = fromIdx >= 0 ? args[fromIdx + 1] : process.env.BANZOU_LIBRARY;

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target);

if (source) {
  const dir = path.resolve(source.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const from = path.join(dir, entry.name);
    const to = path.join(target, entry.name);
    if (entry.name.toLowerCase().endsWith(".lrc")) {
      if (!empty) fs.copyFileSync(from, to);
    } else {
      fs.linkSync(from, to);
    }
    n++;
  }
  console.log(`测试曲库：${target}（从 ${dir} 取了 ${n} 个文件${empty ? "，不带歌词" : ""}）`);
} else {
  makeDemo(target, !empty);
  console.log(`测试曲库：${target}（示例歌曲${empty ? "，不带歌词" : ""}）`);
}

// ---------------- 示例歌曲 ----------------

/** 示例歌曲：90 BPM，C – Am – F – G，两小节前奏，四句歌词（原创） */
function makeDemo(dir, withLyrics) {
  const SR = 44100;
  const BPM = 90;
  const beat = 60 / BPM;
  const bar = beat * 4;
  const intro = bar * 2;
  const lines = [
    { text: "早晨的光 落在窗台", notes: [64, 64, 67, 69, 67, 64, 62, 60] },
    { text: "我把歌声 轻轻打开", notes: [60, 62, 64, 67, 64, 62, 60, 62] },
    { text: "跟着节拍 慢慢地唱", notes: [69, 69, 67, 64, 65, 64, 62, 64] },
    { text: "明天还会 再回来", notes: [62, 64, 67, 64, 62, 60, 59, 60] },
  ];
  const chords = [
    [48, 52, 55], // C
    [45, 48, 52], // Am
    [41, 45, 48], // F
    [43, 47, 50], // G
  ];
  const total = intro + lines.length * bar * 2 + bar * 2;
  const n = Math.round(total * SR);
  const acc = new Float32Array(n);
  const voc = new Float32Array(n);
  const hz = (m) => 440 * 2 ** ((m - 69) / 12);

  // 伴奏：每拍一个钢琴感的和弦 + 低音 + 简单鼓
  const bars = Math.floor(total / bar);
  for (let b = 0; b < bars; b++) {
    const ch = chords[b % 4];
    for (let k = 0; k < 4; k++) {
      const t0 = b * bar + k * beat;
      for (const m of ch) tone(acc, SR, t0, beat * 0.95, hz(m + 12), 0.07, 1.8);
      if (k === 0 || k === 2) tone(acc, SR, t0, beat * 1.9, hz(ch[0] - 12), 0.18, 1.2);
      drum(acc, SR, t0, k);
    }
  }

  // 人声：每拍一个音，带一点颤音和泛音；句尾最后一个音拖两拍
  const lrc = ["[ti:示例歌曲]", "[ar:伴奏歌词]", ""];
  lines.forEach((line, i) => {
    const start = intro + i * bar * 2;
    lrc.push(`[${stamp(start)}]${line.text}`);
    line.notes.forEach((m, j) => {
      const dur = j === line.notes.length - 1 ? beat * 1.9 : beat * 0.92;
      sing(voc, SR, start + j * beat, dur, hz(m));
    });
  });
  lrc.push(`[${stamp(intro + lines.length * bar * 2)}]`);

  writeWav(path.join(dir, "示例歌曲 - 伴奏.wav"), acc, SR);
  writeWav(path.join(dir, "示例歌曲 - 人声.wav"), voc, SR);
  if (withLyrics) fs.writeFileSync(path.join(dir, "示例歌曲.lrc"), lrc.join("\n") + "\n");
}

function tone(out, sr, t0, dur, f, amp, decay) {
  const i0 = Math.round(t0 * sr);
  const len = Math.round(dur * sr);
  for (let i = 0; i < len && i0 + i < out.length; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.005) * Math.exp(-t * decay) * Math.min(1, (len - i) / (0.02 * sr));
    const p = 2 * Math.PI * f * t;
    out[i0 + i] += amp * env * (Math.sin(p) + 0.4 * Math.sin(2 * p) + 0.15 * Math.sin(3 * p));
  }
}

function drum(out, sr, t0, k) {
  const i0 = Math.round(t0 * sr);
  // 底鼓在 1、3 拍，军鼓在 2、4 拍，每拍都有踩镲
  let seed = 12345 + k;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;
  for (let i = 0; i < sr * 0.25 && i0 + i < out.length; i++) {
    const t = i / sr;
    let v = 0;
    if (k % 2 === 0) v += 0.35 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 14);
    else v += 0.12 * noise() * Math.exp(-t * 22);
    v += 0.03 * noise() * Math.exp(-t * 60);
    out[i0 + i] += v;
  }
}

function sing(out, sr, t0, dur, f) {
  const i0 = Math.round(t0 * sr);
  const len = Math.round(dur * sr);
  let phase = 0;
  for (let i = 0; i < len && i0 + i < out.length; i++) {
    const t = i / sr;
    const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.3);
    phase += (2 * Math.PI * f * vib) / sr;
    const env = Math.min(1, t / 0.04) * Math.min(1, (len - i) / (0.06 * sr));
    out[i0 + i] += 0.25 * env * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase) + 0.1 * Math.sin(4 * phase));
  }
}

function stamp(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

/** 16 位单声道 WAV；先按峰值归一到 -1 dBFS */
function writeWav(file, data, sr) {
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 0.89 / peak : 1;
  const buf = Buffer.alloc(44 + data.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + data.length * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, data[i] * g)) * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
}
