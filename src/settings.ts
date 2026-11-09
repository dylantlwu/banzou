import { invoke } from "@tauri-apps/api/core";

export interface Settings {
  /** 耳机输出延迟（毫秒），AirPods 一般 150–250 */
  outputLatencyMs: number;
  /** 打轴时人的反应时间（毫秒） */
  reactionMs: number;
  /** 引导人声打开时的音量 0–1 */
  vocalGuideVolume: number;
  /** 伴奏音量 0–1 */
  accompanimentVolume: number;
  /** 直播：是否把歌词和播放状态推给叠加层 */
  liveEnabled: boolean;
  /** 直播叠加层字号（px） */
  liveFontSize: number;
  liveColor: string;
  liveShowNext: boolean;
  livePosition: LivePosition;
  /** 回放录音时「我的声音」音量 0–1 */
  myVoiceVolume: number;
  /** 录音往返延迟（毫秒），按输出设备名记住：AirPods 和有线耳机差很多 */
  recordLatency: Record<string, number>;
  /** 每首歌的升降调（半音，-6 到 +6） */
  transposeBySong: Record<string, number>;
  /** 一键开播：控制 OBS 用的随机密码（第一次开播时生成） */
  obsPassword: string;
  /** 推流地址 / 推流码（TikTok 直播设置里给的，只存在本机设置文件里） */
  streamServer: string;
  streamKey: string;
  /** 直播实时修音 */
  liveTune: boolean;
  liveTuneStrength: number;
  liveTuneSpeed: number;
  /** 直播人声效果：null = 不加 */
  liveFx: "clean" | "pop" | "warm" | null;
  liveVoiceGain: number;
  liveAccGain: number;
  liveMicId: string;
  /** 演唱页显示音高窗口（原唱音高 + 我唱的） */
  showPitch: boolean;
}

export type LivePosition = "bottom" | "center" | "top";
const LIVE_POSITIONS: LivePosition[] = ["bottom", "center", "top"];

export const DEFAULT_SETTINGS: Settings = {
  outputLatencyMs: 0,
  reactionMs: 100,
  vocalGuideVolume: 0.6,
  accompanimentVolume: 1,
  liveEnabled: false,
  liveFontSize: 56,
  liveColor: "#ffffff",
  liveShowNext: true,
  livePosition: "bottom",
  myVoiceVolume: 1,
  recordLatency: {},
  transposeBySong: {},
  obsPassword: "",
  streamServer: "",
  streamKey: "",
  liveTune: true,
  liveTuneStrength: 0.7,
  liveTuneSpeed: 0.3,
  liveFx: "pop",
  liveVoiceGain: 1,
  liveAccGain: 0.8,
  liveMicId: "",
  showPitch: true,
}

type NumericKey =
  | "outputLatencyMs"
  | "reactionMs"
  | "vocalGuideVolume"
  | "accompanimentVolume"
  | "liveFontSize"
  | "myVoiceVolume"
  | "liveTuneStrength"
  | "liveTuneSpeed"
  | "liveVoiceGain"
  | "liveAccGain";
const RANGES: Record<NumericKey, [number, number]> = {
  outputLatencyMs: [0, 600],
  reactionMs: [0, 400],
  vocalGuideVolume: [0, 1],
  accompanimentVolume: [0, 1],
  liveFontSize: [24, 140],
  myVoiceVolume: [0, 1],
  liveTuneStrength: [0, 1],
  liveTuneSpeed: [0, 1],
  liveVoiceGain: [0, 1.5],
  liveAccGain: [0, 1.5],
};

/** 把读到的任意 JSON 规整成合法设置：缺的用默认值，超范围的截断 */
export function normalizeSettings(raw: unknown): Settings {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(RANGES) as NumericKey[]) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      const [lo, hi] = RANGES[key];
      out[key] = Math.min(hi, Math.max(lo, v));
    }
  }
  if (typeof obj.liveEnabled === "boolean") out.liveEnabled = obj.liveEnabled;
  if (typeof obj.liveShowNext === "boolean") out.liveShowNext = obj.liveShowNext;
  if (typeof obj.liveTune === "boolean") out.liveTune = obj.liveTune;
  if (typeof obj.showPitch === "boolean") out.showPitch = obj.showPitch;
  for (const k of ["obsPassword", "streamServer", "streamKey", "liveMicId"] as const) {
    if (typeof obj[k] === "string") out[k] = (obj[k] as string).slice(0, 500);
  }
  if (obj.liveFx === null || ["clean", "pop", "warm"].includes(obj.liveFx as string)) out.liveFx = obj.liveFx as Settings["liveFx"];
  if (typeof obj.liveColor === "string" && /^#[0-9a-f]{6}$/i.test(obj.liveColor)) out.liveColor = obj.liveColor;
  if (LIVE_POSITIONS.includes(obj.livePosition as LivePosition)) out.livePosition = obj.livePosition as LivePosition;
  if (obj.recordLatency && typeof obj.recordLatency === "object") {
    const map: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj.recordLatency as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) map[k] = Math.min(800, Math.max(0, Math.round(v)));
    }
    out.recordLatency = map;
  }
  if (obj.transposeBySong && typeof obj.transposeBySong === "object") {
    const map: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj.transposeBySong as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && Math.round(v) !== 0) map[k] = Math.min(6, Math.max(-6, Math.round(v)));
    }
    out.transposeBySong = map;
  }
  return out;
}

export async function loadSettings(): Promise<Settings> {
  return normalizeSettings(await invoke("load_settings"));
}

export async function saveSettings(settings: Settings): Promise<void> {
  await invoke("save_settings", { value: settings });
}
