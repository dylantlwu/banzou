import { useEffect, useRef } from "react";

/**
 * 窗口回到前台时重新扫描曲库（v10 去掉了「重新扫描」按钮，「＋」菜单里留手动刷新）。
 * 两次之间至少隔 3 秒；paused 时不扫（录音、打轴中）
 */
export function useAutoRescan(scan: () => Promise<unknown> | void, paused: boolean) {
  const last = useRef(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const scanRef = useRef(scan);
  scanRef.current = scan;
  useEffect(() => {
    const run = () => {
      if (pausedRef.current || document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - last.current < 3000) return;
      last.current = now;
      void scanRef.current();
    };
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, []);
}
