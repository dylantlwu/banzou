import { Btn } from "../components/Btn";

export interface VolumeProps {
  /** 滑杆位置 0–1 */
  value: number;
  muted: boolean;
  onChange: (v: number) => void;
  onToggleMute: () => void;
}

function SpeakerIcon({ level }: { level: 0 | 1 | 2 }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      {level === 0 ? (
        <path d="M16 9.5l5 5M21 9.5l-5 5" />
      ) : (
        <>
          <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
          {level === 2 && <path d="M18.2 6.6a7.6 7.6 0 0 1 0 10.8" />}
        </>
      )}
    </svg>
  );
}

/** 播放栏上的总音量：喇叭（点一下静音 / 恢复）+ 滑杆。所有模式、所有音源都管用 */
export function VolumeControl({ value, muted, onChange, onToggleMute }: VolumeProps) {
  const silent = muted || value === 0;
  const pct = Math.round(value * 100);
  return (
    <div className="vol" title={muted ? "已静音" : `音量 ${pct}%`}>
      <Btn className={silent ? "vol-btn off" : "vol-btn"} onClick={onToggleMute} aria-label={muted ? "取消静音" : "静音"} title={muted ? "取消静音" : "静音"}>
        <SpeakerIcon level={silent ? 0 : value < 0.5 ? 1 : 2} />
      </Btn>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={muted ? 0 : value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="音量"
      />
    </div>
  );
}
