import { useEffect, useRef } from "react";
import { noteName } from "../practice/exercises";
import { LIVE_OFF_SEMITONES, type RefPitch, bufferPitch, foldNear, refAt, refDistance, viewRange } from "../sing/pitchView";

/** 麦克风实时音高的来源（录音栏打开时才有） */
export interface LiveInput {
  read: (out: Float32Array<ArrayBuffer>) => boolean;
  sampleRate: () => number;
  /** 现在麦克风收到的声音，对应歌曲的第几秒（已扣掉往返延迟） */
  songTimeNow: () => number;
  playing: () => boolean;
}

interface Props {
  refPitch: RefPitch | null;
  /** 升降调（半音），原唱曲线跟着移 */
  transpose: number;
  /** 正在加载 / 出错时显示的话 */
  status: string | null;
  /** 耳朵现在听到的是歌曲第几秒 */
  getHeard: () => number;
  live: LiveInput | null;
  big?: boolean;
}

const PAST = 4;
const FUTURE = 6;

/**
 * 演唱页的音高窗口（PRD 4.2）：灰线 = 原唱，跟着播放从右往左走，竖线是现在；
 * 打开录音栏时叠加我唱的音高（蓝 = 准，橙 = 差 50 音分以上），自动折到原唱的八度。
 */
export function SingPitch({ refPitch, transpose, status, getHeard, live, big }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const props = useRef({ refPitch, transpose, status, getHeard, live });
  props.current = { refPitch, transpose, status, getHeard, live };

  useEffect(() => {
    let raf = 0;
    let range: { lo: number; hi: number } | null = null;
    const trail: { t: number; midi: number }[] = [];
    const buf = new Float32Array(2048);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { refPitch: ref, transpose: shift, status: msg, getHeard: heardNow, live: mic } = props.current;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const style = getComputedStyle(canvas);
      const css = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
      const muted = css("--muted", "#888");
      const line = css("--line", "#ddd");

      const heard = heardNow();
      const t0 = heard - PAST;
      const t1 = heard + FUTURE;
      const xOf = (t: number) => ((t - t0) / (t1 - t0)) * w;

      // 显示范围跟着这一段原唱的音域慢慢移动
      const target = ref ? viewRange(ref, heard - 8, heard + 12, [t0, t1]) : null;
      const goal = target ? { lo: target.lo + shift, hi: target.hi + shift } : (range ?? { lo: 52, hi: 72 });
      range = range ? { lo: range.lo + (goal.lo - range.lo) * 0.08, hi: range.hi + (goal.hi - range.hi) * 0.08 } : goal;
      const { lo, hi } = range;
      const yOf = (m: number) => h - ((m - lo) / (hi - lo)) * h;
      const unit = h / (hi - lo);

      // 背景：黑键行加灰，C 画线并标音名；行够高时白键也标
      ctx.font = "10px -apple-system, sans-serif";
      for (let m = Math.floor(lo); m <= Math.ceil(hi); m++) {
        const pc = ((m % 12) + 12) % 12;
        if ([1, 3, 6, 8, 10].includes(pc)) {
          ctx.fillStyle = "rgba(127,127,127,0.07)";
          ctx.fillRect(0, yOf(m + 0.5), w, unit);
        }
        if (pc === 0) {
          ctx.fillStyle = line;
          ctx.fillRect(0, yOf(m - 0.5), w, 1);
        }
        if (pc === 0 || (unit >= 11 && ![1, 3, 6, 8, 10].includes(pc))) {
          ctx.fillStyle = muted;
          ctx.fillText(noteName(m), 4, yOf(m) + 3);
        }
      }

      // 原唱：现在之前的淡一点
      if (ref) {
        const a = Math.max(0, Math.floor(t0 / ref.hop));
        const b = Math.min(ref.midi.length, Math.ceil(t1 / ref.hop) + 1);
        ctx.lineWidth = big ? 6 : 5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = muted;
        for (const past of [true, false]) {
          ctx.globalAlpha = past ? 0.35 : 0.8;
          ctx.beginPath();
          let open = false;
          let prev = NaN;
          for (let i = a; i < b; i++) {
            const t = i * ref.hop;
            if (past ? t > heard : t < heard - ref.hop) continue;
            const v = ref.midi[i] + shift;
            if (Number.isNaN(v) || (open && Math.abs(v - prev) > 5)) {
              open = false;
              if (Number.isNaN(v)) continue;
            }
            if (open) ctx.lineTo(xOf(t), yOf(v));
            else ctx.moveTo(xOf(t), yOf(v));
            open = true;
            prev = v;
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // 我唱的：只在播放时留轨迹；暂停时只显示现在的音
      let current: { t: number; midi: number } | null = null;
      if (mic && mic.read(buf)) {
        const midi = bufferPitch(buf, mic.sampleRate());
        const t = mic.songTimeNow();
        if (trail.length && t < trail[trail.length - 1].t - 0.3) trail.length = 0; // 往回拖了
        if (Number.isFinite(midi)) {
          current = { t, midi };
          if (mic.playing()) trail.push(current);
        } else if (mic.playing()) trail.push({ t, midi: NaN });
      } else trail.length = 0;
      while (trail.length && trail[0].t < t0 - 1) trail.shift();

      const mine = css("--pitch-mine", "#2563eb");
      const off = css("--pitch-off", "#e69f00");
      const center = (lo + hi) / 2;
      const place = (p: { t: number; midi: number }) => {
        const r = ref ? refAt(ref, p.t, 0.15) + shift : NaN;
        const m = foldNear(p.midi, Number.isNaN(r) ? center : r);
        const d = ref ? refDistance(ref, p.t, p.midi, shift) : NaN;
        return { x: xOf(p.t), y: yOf(m), off: d > LIVE_OFF_SEMITONES };
      };
      ctx.lineCap = "round";
      for (let i = 1; i < trail.length; i++) {
        const p = trail[i - 1];
        const q = trail[i];
        if (!Number.isFinite(p.midi) || !Number.isFinite(q.midi) || q.t - p.t > 0.15) continue;
        const A = place(p);
        const B = place(q);
        if (Math.abs(A.y - B.y) > unit * 5) continue;
        ctx.strokeStyle = B.off ? off : mine;
        ctx.lineWidth = B.off ? 4 : 3;
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
      }
      if (current) {
        const c = place(current);
        ctx.fillStyle = c.off ? off : mine;
        ctx.beginPath();
        ctx.arc(c.x, c.y, big ? 7 : 6, 0, Math.PI * 2);
        ctx.fill();
      }

      // 现在
      ctx.fillStyle = css("--accent", "#c2410c");
      ctx.fillRect(xOf(heard) - 0.75, 0, 1.5, h);

      if (msg) {
        ctx.fillStyle = muted;
        ctx.font = "13px -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(msg, w / 2, h / 2 + 4);
        ctx.textAlign = "left";
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [big]);

  return (
    <div className={big ? "sing-pitch big" : "sing-pitch"}>
      <canvas ref={canvasRef} />
      <div className="sing-pitch-legend muted small">
        <span className="lg ref" /> 原唱
        {live ? (
          <>
            <span className="lg mine" /> 我（准）<span className="lg off" /> 差 50 音分以上 · 自动对到原唱的八度
          </>
        ) : (
          <span> · 打开录音栏（R）就能看到自己唱的音高</span>
        )}
      </div>
    </div>
  );
}
