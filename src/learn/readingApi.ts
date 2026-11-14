import { invoke } from "@tauri-apps/api/core";

/** 读音表和备课（PRD 4.12「核心：读音表」「备课」）。后端 learn::reading / learn::lesson */

export type ReadingSource = "note" | "title" | "annotation" | "analyzer" | "dictionary" | "claude";

export interface Reading {
  word: string;
  /** 平假名 */
  reading: string;
  romaji: string;
  source: ReadingSource;
  /** 两个分析器一致吗；没分析过是 null */
  consistent: boolean | null;
  needsReview: boolean;
  reasons: string[];
  proper: boolean;
  candidates: { sudachi?: string; unidic?: string; annotation?: string; claude?: string };
  /** 出现在第几句（从 0 数，只数有字的句子） */
  lines: number[];
  pitchAccent: string | null;
}

export interface ReadingTable {
  schema: number;
  /** 用了哪两个分析器；词典没装是 null */
  analyzers: string | null;
  words: Reading[];
}

export interface LessonLine {
  index: number;
  text: string;
  meaning: string;
  tips: string[];
}

export interface Lesson {
  created: string;
  summary: string;
  sections: { name: string; lines: number[] }[];
  lines: LessonLine[];
  hardest: number[];
  review: { word: string; reason: string }[];
  /** 程序按读音表改掉的地方 */
  fixes: { place: string; word: string; from: string; to: string }[];
}

export interface DictStatus {
  installed: boolean;
  downloadMb: number;
  diskMb: number;
  analyzers: string;
}

export interface LearnView {
  key: string;
  /** 有字的歌词，按句（备课和读音表都按这个编号） */
  lines: string[];
  table: ReadingTable;
  lesson: Lesson | null;
  /** 课程是按旧歌词备的 */
  lessonStale: boolean;
  dict: DictStatus;
  /** 要不要标日语读音（不是日语歌就不提示装词典、不列待确认） */
  japanese: boolean;
}

export const SOURCE_LABEL: Record<ReadingSource, string> = {
  note: "你确认的",
  title: "资料表里的歌名读音",
  annotation: "歌曲自带标注",
  analyzer: "两个分析器一致",
  dictionary: "词典",
  claude: "Claude 给的",
};

export const CANDIDATE_LABEL: Record<keyof Reading["candidates"], string> = {
  annotation: "标注",
  sudachi: "Sudachi",
  unidic: "UniDic",
  claude: "Claude",
};

export const loadLearnView = (songId: string) => invoke<LearnView>("learn_view", { songId });

export const saveReading = (songId: string, word: string, reading: string) => invoke<ReadingTable>("learn_save_reading", { songId, word, reading });

export const prepareLesson = (songId: string) => invoke<Lesson>("learn_prepare", { songId });

/** 取消正在进行的备课：回来的结果不存，原来的课程保留 */
export const cancelPrepare = (songId: string) => invoke<null>("learn_prepare_cancel", { songId });

export const installReadingDict = () => invoke<DictStatus>("learn_reading_install");

/** 按读音表把一行切成「普通文字 / 有读音的词」，长的词优先 */
export function splitByTable(text: string, table: ReadingTable | null | undefined): (string | Reading)[] {
  if (!table || table.words.length === 0) return [text];
  const words = [...table.words].sort((a, b) => b.word.length - a.word.length);
  const out: (string | Reading)[] = [];
  let plain = "";
  let i = 0;
  while (i < text.length) {
    const hit = words.find((w) => w.word && text.startsWith(w.word, i));
    if (hit) {
      if (plain) out.push(plain);
      plain = "";
      out.push(hit);
      i += hit.word.length;
    } else {
      plain += text[i];
      i += 1;
    }
  }
  if (plain) out.push(plain);
  return out;
}

/** 一行的读音（词换成平假名，待确认的后面加 ?） */
export function readingLine(text: string, table: ReadingTable | null | undefined): string {
  return splitByTable(text, table)
    .map((p) => (typeof p === "string" ? p : p.needsReview ? `${p.reading}?` : p.reading))
    .join("");
}
