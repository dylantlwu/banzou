/**
 * 录音防呆（资料清单 §5-9）：录音比歌长太多就自动停；异常录音的大小、长度怎么显示。
 */

/** 录音比歌长多这么多秒就自动停（多半是暂停了伴奏、忘了停录音） */
export const AUTO_STOP_EXTRA_SECONDS = 30;

export const AUTO_STOP_NOTICE = `录音比歌长了 ${AUTO_STOP_EXTRA_SECONDS} 秒，已自动停止`;

/** 从开始录音到现在（墙上时间，秒）是不是已经超过 歌长 + 30 秒；不知道歌长时不自动停 */
export function overRecordLimit(elapsedSeconds: number, songSeconds: number): boolean {
  return songSeconds > 0 && elapsedSeconds > songSeconds + AUTO_STOP_EXTRA_SECONDS;
}

/** 异常录音：从后端拿到的一条 */
export interface AbnormalRecording {
  /** 歌名（调 trash_takes 用） */
  title: string;
  file: string;
  bytes: number;
  seconds: number;
}

/** 文件大小：1 GB 以上用 GB，否则 MB */
export function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** 大概多长：约 3.5 小时 / 约 12 分钟 / 约 40 秒 */
export function formatLength(seconds: number): string {
  if (seconds >= 3600) return `约 ${(seconds / 3600).toFixed(1).replace(/\.0$/, "")} 小时`;
  if (seconds >= 60) return `约 ${Math.round(seconds / 60)} 分钟`;
  return `约 ${Math.round(seconds)} 秒`;
}
