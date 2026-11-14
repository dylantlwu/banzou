/**
 * 播放器判断「是不是还是同一首歌」。
 *
 * 以前按第一条音轨的文件路径判断，有两个毛病：
 * - 变速 / 升降调还在处理时 App 给的音轨是 null，播放器什么都不做：这时切歌，旧歌的位置、A-B 循环
 *   （甚至声音）会一直留到新歌处理完；
 * - 同一首歌改速度，处理好的文件路径变了，被当成换歌，位置和 A-B 被清掉。
 * 现在 App 直接告诉播放器这是哪首歌（songKey）：一变就马上清位置和 A-B，不等音频；
 * 同一首歌换文件（变速、升降调、换 Take）保留位置和 A-B。没给 songKey 时退回按路径判断。
 */
export interface SongSwitchState {
  /** 当前是哪首歌（undefined = 调用方没给，按路径判断） */
  song: string | null | undefined;
  /** 上次加载的第一条音轨 */
  path: string | null;
  /** 换歌后还没加载过新歌的音频 */
  pendingNew: boolean;
}

export const INITIAL_SWITCH: SongSwitchState = { song: undefined, path: null, pendingNew: false };

/** 每次渲染时调：歌变了就要马上把位置、A-B、时长清零（reset = true） */
export function noteSong(state: SongSwitchState, song: string | null | undefined): { state: SongSwitchState; reset: boolean } {
  if (song === undefined || song === state.song) return { state, reset: false };
  // 第一次拿到 songKey 不算换歌（刚打开、还没放过东西）
  const reset = state.song !== undefined;
  return { state: { ...state, song, pendingNew: reset || state.pendingNew }, reset };
}

/** 要加载一组新音轨时调：sameSong = 接着原来的位置和 A-B */
export function noteLoad(state: SongSwitchState, mainPath: string | null): { state: SongSwitchState; sameSong: boolean } {
  const sameSong = state.song === undefined ? mainPath !== null && mainPath === state.path : !state.pendingNew && state.path !== null;
  return { state: { ...state, path: mainPath, pendingNew: false }, sameSong };
}
