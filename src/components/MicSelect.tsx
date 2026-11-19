import { micOptions } from "../audio/micChoice";
import { useAudioDevices } from "../audio/useAudioDevices";
import "./mic.css";

/**
 * 「麦克风」下拉框：所有录音的地方共用设置里的同一个（`inputDevice`）。
 * 放在「声音 ▾」、设置 → 耳机与录音、练声页、直播面板。
 */
export function MicSelect({ value, onChange, disabled, className }: { value: string; onChange: (v: string) => void; disabled?: boolean; className?: string }) {
  const { inputs } = useAudioDevices();
  const names = inputs?.devices ?? [];
  const defaultName = names.find((d) => d.uid === inputs?.defaultUid)?.name ?? null;
  return (
    <select className={className ? `mic-select ${className}` : "mic-select"} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label="麦克风">
      {micOptions(names, value, defaultName).map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
