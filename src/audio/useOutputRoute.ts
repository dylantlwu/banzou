/**
 * 「出声设备」在 React 里用：useOutputRoute 读现在的状态（歌词补延迟、提示）；
 * useOutputRouting 只在 App 里调一次，把设置交给 outputRouter，设备插拔、窗口回到前台时重新决定。
 */
import { useEffect, useState } from "react";
import { outputRouter, type RouteState } from "./outputRoute";
import { TEST_OUTPUT_EVENT } from "./useFollowOutput";

export function useOutputRoute(): RouteState {
  const [s, setS] = useState(outputRouter.current);
  useEffect(() => {
    setS(outputRouter.current);
    return outputRouter.subscribe(setS);
  }, []);
  return s;
}

export function useOutputRouting(choice: string): RouteState {
  useEffect(() => {
    const apply = () => void outputRouter.setChoice(choice);
    apply();
    window.addEventListener("focus", apply);
    window.addEventListener(TEST_OUTPUT_EVENT, apply);
    let off: (() => void) | null = null;
    let alive = true;
    if (!(window as unknown as { __BANZOU_TEST__?: boolean }).__BANZOU_TEST__) {
      void import("@tauri-apps/api/event")
        .then(({ listen }) => listen("audio-output-changed", apply))
        .then((u) => (alive ? (off = u) : u()))
        .catch(() => {});
    }
    return () => {
      alive = false;
      off?.();
      window.removeEventListener("focus", apply);
      window.removeEventListener(TEST_OUTPUT_EVENT, apply);
    };
  }, [choice]);
  return useOutputRoute();
}
