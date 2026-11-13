import { type ReactNode, useState } from "react";
import { Btn } from "../components/Btn";
import { formatTime } from "../utils/time";
import { Popover } from "./Popover";

const SKIP_SECONDS = 5;
export const SPEEDS = [0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5];

function PlayIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
    </svg>
  );
}

interface Slider {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}

export interface SoundProps {
  /** 放哪个：伴奏 / 原曲 / 外部录音（只有一个时不显示） */
  sources: { label: string; title: string }[];
  sourceIndex: number;
  onSource: (i: number) => void;
  acc: Slider | null;
  vocal: (Slider & { title?: string }) | null;
  transpose: { value: number; onChange: (st: number) => void; disabled?: boolean } | null;
}

interface Props {
  ready: boolean;
  playing: boolean;
  onPlay: () => void;
  onSkip: (sec: number) => void;
  /** 录音按钮；不该出现时是 null */
  rec: { on: boolean; disabled: boolean; title: string; onClick: () => void } | null;
  position: number;
  duration: number;
  seekDisabled: boolean;
  onSeek: (t: number) => void;
  loop: { a: number; b: number } | null;
  /** A-B；不该出现时是 null */
  ab: { onA: () => void; onB: () => void; onClear: () => void; disabled: boolean } | null;
  /** 「人声 带唱」开关 */
  vocal: { on: boolean; disabled: boolean; label: string; title: string; onToggle: () => void } | null;
  speed: { value: number; disabled: boolean; onChange: (v: number) => void } | null;
  sound: SoundProps | null;
  /** 播放栏下面一行小字（加载中、出错、文件名……） */
  status?: ReactNode;
}

/** 播放栏：−5 / ▶ / +5、录音、进度和 A-B、人声带唱、速度、「声音 ▾」 */
export function TransportBar(p: Props) {
  const [scrub, setScrub] = useState<number | null>(null);
  const shown = scrub ?? p.position;
  const { duration, loop } = p;
  return (
    <footer className="tbar">
      <div className="tbar-row">
        <div className="tbar-transport">
          <Btn className="icon" onClick={() => p.onSkip(-SKIP_SECONDS)} disabled={!p.ready} title="后退 5 秒（←）">
            −5
          </Btn>
          <Btn className="icon play" onClick={p.onPlay} disabled={!p.ready} title="播放 / 暂停（空格）" aria-label={p.playing ? "暂停" : "播放"}>
            <PlayIcon playing={p.playing} />
          </Btn>
          <Btn className="icon" onClick={() => p.onSkip(SKIP_SECONDS)} disabled={!p.ready} title="前进 5 秒（→）">
            +5
          </Btn>
          {p.rec && (
            <Btn className={p.rec.on ? "rec-btn on" : "rec-btn"} onClick={p.rec.onClick} disabled={p.rec.disabled} title={p.rec.title}>
              ● 录音
            </Btn>
          )}
        </div>

        <div className="timeline tbar-timeline">
          <span className="time">{formatTime(shown)}</span>
          <div className="track-wrap">
            {loop && duration > 0 && (
              <div
                className="loop-region"
                style={{ left: `${(loop.a / duration) * 100}%`, width: `${((loop.b - loop.a) / duration) * 100}%` }}
                title={`A-B 循环 ${formatTime(loop.a)}–${formatTime(loop.b)}`}
              />
            )}
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.1}
              value={Math.min(shown, duration || 1)}
              disabled={p.seekDisabled}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={(e) => {
                p.onSeek(Number(e.currentTarget.value));
                setScrub(null);
              }}
              aria-label="播放进度"
            />
          </div>
          <span className="time">{formatTime(duration)}</span>
          {p.ab && (
            <div className="ab" aria-label="A-B 循环">
              <Btn className={loop ? "ab-dot on" : "ab-dot"} onClick={p.ab.onA} disabled={p.ab.disabled} title="把当前位置设为 A（[）">
                A
              </Btn>
              <Btn className={loop ? "ab-dot on" : "ab-dot"} onClick={p.ab.onB} disabled={p.ab.disabled} title="把当前位置设为 B（]）">
                B
              </Btn>
              {loop && (
                <Btn className="ab-dot" onClick={p.ab.onClear} title="取消循环（\）">
                  ×
                </Btn>
              )}
            </div>
          )}
        </div>

        <div className="tbar-knobs">
          {p.vocal && (
            <Btn className={p.vocal.on ? "pill on" : "pill"} onClick={p.vocal.onToggle} disabled={p.vocal.disabled} title={p.vocal.title}>
              {p.vocal.label}
            </Btn>
          )}
          {p.speed && (
            <label className="pill pill-select" title="变速不变调：练快歌时放慢，音调不变">
              <select value={p.speed.value} onChange={(e) => p.speed!.onChange(Number(e.target.value))} disabled={p.speed.disabled} aria-label="速度">
                {SPEEDS.map((v) => (
                  <option key={v} value={v}>
                    {v}x
                  </option>
                ))}
              </select>
            </label>
          )}
          {p.sound && <SoundMenu {...p.sound} />}
        </div>
      </div>
      {p.status && <p className="status muted tbar-status">{p.status}</p>}
    </footer>
  );
}

function SoundMenu(s: SoundProps) {
  const shifted = s.transpose && s.transpose.value !== 0;
  return (
    <Popover label={shifted ? `声音 ${s.transpose!.value > 0 ? "+" : ""}${s.transpose!.value} ▾` : "声音 ▾"} className={shifted ? "pill soft on" : "pill soft"} up title="放哪个、音量、升降调" menuClass="sound-menu">
      {() => (
        <>
          {s.sources.length > 1 && (
            <div className="segmented sound-sources" role="tablist" aria-label="播放音源">
              {s.sources.map((src, i) => (
                <Btn key={src.title} role="tab" aria-selected={i === s.sourceIndex} className={i === s.sourceIndex ? "seg active" : "seg"} onClick={() => s.onSource(i)} title={src.title}>
                  {src.label}
                </Btn>
              ))}
            </div>
          )}
          {s.acc && (
            <label className="sound-row">
              <span>伴奏</span>
              <input type="range" min={0} max={1} step={0.01} value={s.acc.value} disabled={s.acc.disabled} onChange={(e) => s.acc!.onChange(Number(e.target.value))} aria-label="伴奏音量" />
            </label>
          )}
          {s.vocal && (
            <label className="sound-row" title={s.vocal.title}>
              <span>人声</span>
              <input type="range" min={0} max={1} step={0.01} value={s.vocal.value} disabled={s.vocal.disabled} onChange={(e) => s.vocal!.onChange(Number(e.target.value))} aria-label="引导人声音量" />
            </label>
          )}
          {s.transpose && (
            <div className="sound-row" title="升降调（不变速），伴奏和引导人声一起移">
              <span>升降调</span>
              <span className="sound-step">
                <Btn className="ghost tiny" onClick={() => s.transpose!.onChange(Math.max(-6, s.transpose!.value - 1))} disabled={s.transpose.disabled || s.transpose.value <= -6}>
                  −
                </Btn>
                <span className="small offset-value">{s.transpose.value > 0 ? `+${s.transpose.value}` : s.transpose.value}</span>
                <Btn className="ghost tiny" onClick={() => s.transpose!.onChange(Math.min(6, s.transpose!.value + 1))} disabled={s.transpose.disabled || s.transpose.value >= 6}>
                  +
                </Btn>
              </span>
            </div>
          )}
          {!s.acc && !s.vocal && !s.transpose && s.sources.length <= 1 && <p className="pop-note muted small">这个音源没有可调的</p>}
        </>
      )}
    </Popover>
  );
}
