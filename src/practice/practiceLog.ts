/**
 * 练声记录（app 配置目录 practice.json）：音域、每天每项的成绩、练了多少分钟。
 */
import { invoke } from "@tauri-apps/api/core";
import type { ExerciseId, Range } from "./exercises";

export interface ExerciseResult {
  at: string;
  /** 音阶类：准（绿）的比例 0–1，黄算一半 */
  accuracy?: number;
  /** 平均偏差（音分，取绝对值后平均） */
  avgCents?: number;
  /** 长音：抖动（音分标准差） */
  wobble?: number;
  /** 气息：秒数、稳定度 */
  breathSec?: number;
  steadiness?: number;
}

export interface DayLog {
  minutes: number;
  results: Partial<Record<ExerciseId, ExerciseResult>>;
}

export interface PracticeLog {
  version: 1;
  range: Range | null;
  days: Record<string, DayLog>;
}

export const emptyLog = (): PracticeLog => ({ version: 1, range: null, days: {} });

export function dayKey(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function loadLog(): Promise<PracticeLog> {
  const v = await invoke<Partial<PracticeLog>>("load_store", { name: "practice" }).catch(() => null);
  if (!v || v.version !== 1) return emptyLog();
  return { version: 1, range: v.range ?? null, days: v.days ?? {} };
}

export function saveLog(log: PracticeLog): Promise<void> {
  return invoke("save_store", { name: "practice", value: log });
}

/** 记一项成绩：同一天同一项保留更好的那次（音阶看准确率、气息看秒数、长音看抖动） */
export function record(log: PracticeLog, id: ExerciseId, r: ExerciseResult, minutes: number, today = dayKey()): PracticeLog {
  const day = log.days[today] ?? { minutes: 0, results: {} };
  const old = day.results[id];
  const better =
    !old ||
    (r.accuracy !== undefined && (old.accuracy ?? -1) < r.accuracy) ||
    (r.breathSec !== undefined && (old.breathSec ?? -1) < r.breathSec) ||
    (r.wobble !== undefined && (old.wobble ?? Infinity) > r.wobble) ||
    (r.avgCents !== undefined && r.accuracy === undefined && r.wobble === undefined && (old.avgCents ?? Infinity) > r.avgCents);
  return {
    ...log,
    days: { ...log.days, [today]: { minutes: Math.round((day.minutes + minutes) * 10) / 10, results: { ...day.results, ...(better ? { [id]: r } : {}) } } },
  };
}

/** 连续练习天数（今天没练但昨天练了也算连着） */
export function streak(log: PracticeLog, today = new Date()): number {
  const has = (d: Date) => Object.keys(log.days[dayKey(d)]?.results ?? {}).length > 0;
  const d = new Date(today);
  if (!has(d)) d.setDate(d.getDate() - 1);
  let n = 0;
  while (has(d)) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/** 最近 n 天（旧 → 新）：日期、练了几项 */
export function recentDays(log: PracticeLog, n = 30, today = new Date()): { date: string; count: number }[] {
  const out: { date: string; count: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const k = dayKey(d);
    out.push({ date: k, count: Object.keys(log.days[k]?.results ?? {}).length });
  }
  return out;
}

/** 某一项某个指标最近 n 天的值（没练的天为 null），画趋势用 */
export function trend(log: PracticeLog, id: ExerciseId, key: keyof ExerciseResult, n = 30, today = new Date()): (number | null)[] {
  return recentDays(log, n, today).map(({ date }) => {
    const v = log.days[date]?.results[id]?.[key];
    return typeof v === "number" ? v : null;
  });
}
