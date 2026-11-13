// 字段登记表：每首歌有哪些资料、谁来填、哪些功能要用、缺了怎么补（docs/资料清单.md §6.2）。
// 新功能要用新资料：先登记进资料清单，再在这里加一行；资料检查页和编辑窗口会自动多出这一项。
import type { Song } from "../types";
import { type CheckRow, textOf } from "./meta";

export type Feature = "sing" | "record" | "live" | "tv" | "learn" | "tags";
export const FEATURES: { key: Feature; label: string }[] = [
  { key: "sing", label: "唱歌" },
  { key: "record", label: "录音修音" },
  { key: "live", label: "直播" },
  { key: "tv", label: "电视 KTV" },
  { key: "learn", label: "学唱" },
  { key: "tags", label: "标签歌单" },
];
export const featureLabel = (f: Feature) => FEATURES.find((x) => x.key === f)?.label ?? f;

/** 缺了怎么补（资料检查页的按钮） */
export type Fix =
  | "edit" // 在资料窗口里填
  | "ai" // AI 联网查（歌手、语种、年代、背景、原曲名）
  | "lyricsSearch" // AI 查原曲名后去歌词库搜
  | "tap" // 去打轴（粘贴歌词）
  | "align" // 智能对齐（按原唱人声自动打时间）
  | "separate" // 从视频做成伴奏 / 人声
  | "video" // 下载视频
  | "tvSync"; // 同步电视歌单（做副歌小 MV）

export const FIX_LABEL: Record<Fix, string> = {
  edit: "填写",
  ai: "AI 查",
  lyricsSearch: "AI 搜歌词",
  tap: "打轴",
  align: "智能对齐",
  separate: "做成伴奏",
  video: "下载视频",
  tvSync: "同步电视",
};

/** 一首歌在检查时能看到的全部东西 */
export interface SongState {
  song: Song;
  row: CheckRow;
}

export interface FieldDef {
  key: string;
  label: string;
  /** sheet = 存在资料表里，能在资料窗口编辑；file = 歌旁边的文件；tv = 电视那边的派生资料 */
  where: "sheet" | "file" | "tv";
  /** 资料窗口里用什么输入 */
  input?: "text" | "longtext" | "lang" | "era";
  /** 谁来填 */
  filledBy: ("user" | "ai" | "scan" | "tool")[];
  /** 缺了这些功能用不了 */
  required: Feature[];
  /** 缺了能用，但体验差 */
  helps: Feature[];
  fix: Fix[];
  /** 资料窗口里的提示 */
  hint?: string;
  /** 只在这些情况下才算「缺」（例如读音只有外语歌名才要） */
  neededWhen?: (s: SongState) => boolean;
  /** 有没有。sheet 字段默认看资料里有没有文字 */
  has?: (s: SongState) => boolean;
  /** 可选资料：能填，但不进缺口列表 */
  optional?: boolean;
  /** 缺的时候怎么说（默认「缺<label>」） */
  missing?: string | ((s: SongState) => string);
}

const foreign = (s: SongState) => ["日语", "韩语"].includes(textOf(s.row.meta, "lang"));

export const FIELDS: FieldDef[] = [
  // ---- 文字资料（资料表）----
  { key: "title", label: "歌名", where: "sheet", input: "text", filledBy: ["user"], required: [], helps: ["tv", "learn"], fix: ["edit"], hint: "显示用的名字，改了不动文件；空着就用文件名", optional: true },
  { key: "titleReading", label: "读音", where: "sheet", input: "text", filledBy: ["user", "ai"], required: [], helps: ["tv", "learn"], fix: ["edit"], hint: "假名 / 拼音 / 罗马音，例如「さくら (Sakura)」；电视点歌首字母按里面的罗马音算", neededWhen: foreign },
  { key: "artist", label: "歌手", where: "sheet", input: "text", filledBy: ["user", "ai", "scan"], required: [], helps: ["tv", "tags", "learn"], fix: ["ai", "edit"], hint: "显示用的歌手（一般是创作者）" },
  { key: "performer", label: "演唱者", where: "sheet", input: "text", filledBy: ["user", "ai"], required: [], helps: [], fix: ["edit"], hint: "和歌手不同时才填（虚拟歌手、翻唱），只作附注", optional: true },
  { key: "lang", label: "语种", where: "sheet", input: "lang", filledBy: ["user", "ai"], required: ["learn"], helps: ["tv", "tags"], fix: ["ai", "edit"] },
  { key: "era", label: "年代", where: "sheet", input: "era", filledBy: ["user", "ai"], required: [], helps: ["tv", "tags"], fix: ["ai", "edit"] },
  { key: "note", label: "背景", where: "sheet", input: "longtext", filledBy: ["ai", "user"], required: [], helps: ["learn", "tags"], fix: ["ai", "edit"], hint: "一句话：原唱、专辑或影视、发行年份" },
  { key: "track", label: "原曲名", where: "sheet", input: "text", filledBy: ["ai", "user"], required: [], helps: ["tags"], fix: ["ai", "edit"], hint: "去掉歌手名和版本说明的歌名，搜歌词用" },
  { key: "lyricist", label: "作词", where: "sheet", input: "text", filledBy: ["ai", "user"], required: [], helps: ["learn"], fix: ["edit"], optional: true },
  { key: "composer", label: "作曲", where: "sheet", input: "text", filledBy: ["ai", "user"], required: [], helps: ["learn"], fix: ["edit"], optional: true },
  { key: "version", label: "版本", where: "sheet", input: "text", filledBy: ["user"], required: [], helps: [], fix: ["edit"], hint: "Remix / Live / Acoustic……", optional: true },

  // ---- 文件（扫描得到）----
  { key: "accompaniment", label: "伴奏", where: "file", filledBy: ["tool", "user"], required: ["sing", "record", "live", "tv"], helps: [], fix: ["separate", "video"], has: (s) => s.song.accompaniments.length > 0 },
  { key: "vocal", label: "人声", where: "file", filledBy: ["tool", "user"], required: ["learn"], helps: ["sing", "record", "tv"], fix: ["separate", "video"], has: (s) => s.song.vocals.length > 0 },
  { key: "lyrics", label: "歌词", where: "file", filledBy: ["user", "tool", "ai"], required: ["tv", "learn", "live"], helps: ["sing", "record"], fix: ["lyricsSearch", "tap"], has: (s) => s.song.lyrics !== null },
  {
    key: "lyricsTimed",
    label: "歌词时间轴",
    missing: "歌词没有时间",
    where: "file",
    filledBy: ["user", "tool"],
    required: ["tv", "live"],
    helps: ["sing", "learn"],
    fix: ["align", "tap"],
    has: (s) => s.row.lyricsTimed,
    neededWhen: (s) => s.song.lyrics !== null,
  },
  { key: "video", label: "原曲视频", where: "file", filledBy: ["tool", "user"], required: [], helps: ["tv"], fix: ["video"], has: (s) => s.song.originals.length > 0 },

  // ---- 电视（派生）----
  {
    key: "tvPreview",
    label: "电视小 MV",
    where: "tv",
    filledBy: ["tool"],
    required: ["tv"],
    helps: [],
    fix: ["tvSync"],
    hint: "同步电视歌单时用原曲视频做 20 秒副歌预览；没有合格视频就只有声音",
    has: (s) => s.row.tvPreview === "video",
    neededWhen: (s) => s.song.accompaniments.length > 0,
  },
  {
    key: "tvFresh",
    label: "电视歌单",
    missing: (s) => (s.row.tvSynced ? "电视上是旧的" : "电视歌单里没有"),
    where: "tv",
    filledBy: ["tool"],
    required: [],
    helps: ["tv"],
    fix: ["tvSync"],
    has: (s) => s.row.tvSynced && !s.row.tvStale,
    neededWhen: (s) => s.song.accompaniments.length > 0,
  },
];

export const SHEET_FIELDS = FIELDS.filter((f) => f.where === "sheet");

export function has(def: FieldDef, s: SongState): boolean {
  return def.has ? def.has(s) : textOf(s.row.meta, def.key) !== "";
}

export interface Gap {
  def: FieldDef;
  /** 缺了用不了的功能 */
  blocks: Feature[];
  /** 「电视小 MV」缺的时候，补法要看有没有原曲视频 */
  fix: Fix[];
}

/** 这首歌缺什么（可选资料不算；用户特意清空的不算） */
export function gaps(s: SongState): Gap[] {
  const out: Gap[] = [];
  for (const def of FIELDS) {
    if (def.optional) continue;
    if (def.neededWhen && !def.neededWhen(s)) continue;
    if (has(def, s)) continue;
    if (def.where === "sheet" && s.row.meta.by?.[def.key] === "user") continue;
    let fix = def.fix;
    if (def.key === "tvPreview" && s.row.tvPreview === "audio") fix = ["video", "tvSync"];
    if ((def.key === "accompaniment" || def.key === "vocal") && s.song.originals.length === 0) fix = ["video"];
    if (def.key === "lyricsTimed" && s.song.vocals.length === 0) fix = ["tap"];
    out.push({ def, blocks: def.required, fix });
  }
  return out;
}

/** 这首歌能不能用某个功能 */
export const ready = (s: SongState, f: Feature) => !gaps(s).some((g) => g.blocks.includes(f));
