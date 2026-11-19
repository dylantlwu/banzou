import { outputOptions } from "../audio/outputRoute";
import { FOLLOW_SYSTEM } from "../audio/micChoice";
import { useAudioDevices } from "../audio/useAudioDevices";
import "./mic.css";

/**
 * 「出声设备」下拉框：播放、老师说话、耳返、练声、校准都从这里选的设备出声（设置里的 `outputDevice`）。
 * 放在「声音 ▾」和 设置 → 耳机与录音。
 */
export function OutputSelect({ value, onChange, disabled, className }: { value: string; onChange: (v: string) => void; disabled?: boolean; className?: string }) {
  const { outputs } = useAudioDevices();
  const names = outputs?.devices ?? [];
  const defaultName = names.find((d) => d.uid === outputs?.defaultUid)?.name ?? null;
  return (
    <select className={className ? `mic-select ${className}` : "mic-select"} value={value || FOLLOW_SYSTEM} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label="出声设备">
      {outputOptions(names, value, defaultName).map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** 选项旁边的一句说明 */
export const OUTPUT_HINT = "选定设备会多一点延迟（约 75ms），歌词会自动补上；在意耳返延迟可以选「跟系统设置」。";
