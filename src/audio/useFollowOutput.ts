/**
 * 跟着系统的出声设备走：用户在系统设置 / 控制中心里切了设备，就让播放器确认声音跟过去了
 * （正在放的从原位置接着放，不用重开应用）。不选设备、不改系统设置、不提示。
 */
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { defaultChanged, type OutputsSnapshot } from "./outputDevice";

/** 测试模式（假设备）发的事件名 */
export const TEST_OUTPUT_EVENT = "banzou-output-changed";

function subscribe(fn: (s: OutputsSnapshot) => void): () => void {
  if ((window as unknown as { __BANZOU_TEST__?: boolean }).__BANZOU_TEST__) {
    const h = (e: Event) => fn((e as CustomEvent<OutputsSnapshot>).detail);
    window.addEventListener(TEST_OUTPUT_EVENT, h);
    return () => window.removeEventListener(TEST_OUTPUT_EVENT, h);
  }
  let off: (() => void) | null = null;
  let gone = false;
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen<OutputsSnapshot>("audio-output-changed", (e) => fn(e.payload)))
    .then((u) => (gone ? u() : (off = u)))
    .catch(() => {});
  return () => {
    gone = true;
    off?.();
  };
}

/** `onChanged`：系统默认输出换了之后调（一般是 `player.ensureOutput`） */
export function useFollowOutput(onChanged: () => void): void {
  const last = useRef<OutputsSnapshot | null>(null);
  const cb = useRef(onChanged);
  cb.current = onChanged;

  useEffect(() => {
    const apply = (s: OutputsSnapshot) => {
      const changed = defaultChanged(last.current, s);
      last.current = s;
      if (changed) cb.current();
    };
    const refresh = () =>
      void invoke<OutputsSnapshot>("audio_outputs")
        .then(apply)
        .catch(() => {});
    refresh();
    const off = subscribe(apply);
    // 睡眠唤醒、窗口回到前台时再读一次，以防错过事件
    window.addEventListener("focus", refresh);
    return () => {
      off();
      window.removeEventListener("focus", refresh);
    };
  }, []);
}
