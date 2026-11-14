import { expect, it } from "vitest";
import { INITIAL_SWITCH, type SongSwitchState, noteLoad, noteSong } from "./songSwitch";

/** 按 App 的顺序走一遍：先告诉播放器是哪首歌，音轨好了（不是 null）再加载 */
function run(steps: { song: string | null; path: string | null }[]) {
  let s: SongSwitchState = INITIAL_SWITCH;
  return steps.map(({ song, path }) => {
    const a = noteSong(s, song);
    s = a.state;
    if (path === null) return { reset: a.reset, sameSong: null };
    const b = noteLoad(s, path);
    s = b.state;
    return { reset: a.reset, sameSong: b.sameSong };
  });
}

it("变速还没处理完就切歌：马上清位置和 A-B，新歌加载好也从头开始", () => {
  const r = run([
    { song: "A", path: "A伴奏.0.75x.wav" }, // A 在 0.75x 放着、设了 A-B
    { song: "B", path: null }, // 切到 B，B 的变速还在处理（音轨是 null）
    { song: "B", path: "B伴奏.0.75x.wav" }, // B 处理好了
  ]);
  expect(r[1].reset).toBe(true); // 以前这里什么都不做，A 的位置和 A-B 留着
  expect(r[2].sameSong).toBe(false);
});

it("同一首歌改速度：处理好的文件路径变了，位置和 A-B 照留", () => {
  const r = run([
    { song: "A", path: "A伴奏.wav" },
    { song: "A", path: null }, // 改成 0.75x，处理中
    { song: "A", path: "A伴奏.0.75x.wav" },
  ]);
  expect(r[1].reset).toBe(false);
  expect(r[2].sameSong).toBe(true); // 以前按路径判断，这里被当成换歌
});

it("A-B 循环中切歌（不用等处理）：清掉，新歌从头", () => {
  const r = run([
    { song: "A", path: "A伴奏.wav" },
    { song: "B", path: "B伴奏.wav" },
  ]);
  expect(r[1]).toEqual({ reset: true, sameSong: false });
});

it("切过去又马上切回来：仍按换歌处理（位置不会从 B 那里接着放）", () => {
  const r = run([
    { song: "A", path: "A伴奏.wav" },
    { song: "B", path: null },
    { song: "A", path: "A伴奏.wav" },
  ]);
  expect(r[1].reset).toBe(true);
  expect(r[2]).toEqual({ reset: true, sameSong: false });
});

it("第一次打开、没选歌到选歌不算换歌；没给 songKey 时按路径判断", () => {
  expect(noteSong(INITIAL_SWITCH, "A").reset).toBe(false);
  let s = noteLoad(INITIAL_SWITCH, "x.wav").state;
  expect(noteLoad(s, "x.wav").sameSong).toBe(true);
  s = noteLoad(s, "x.wav").state;
  expect(noteLoad(s, "y.wav").sameSong).toBe(false);
});
