/**
 * 本机的声音设备名单（Rust 端 CoreAudio 读的，没拿麦克风权限也有名字）：
 * 「麦克风」下拉框用。窗口回到前台、设备插拔时重新读。
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OutputsSnapshot } from "./outputDevice";
import { TEST_OUTPUT_EVENT } from "./useFollowOutput";

export interface AudioDevices {
  inputs: OutputsSnapshot | null;
  outputs: OutputsSnapshot | null;
}

export function useAudioDevices(): AudioDevices {
  const [state, setState] = useState<AudioDevices>({ inputs: null, outputs: null });
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void Promise.all([invoke<OutputsSnapshot>("audio_inputs").catch(() => null), invoke<OutputsSnapshot>("audio_outputs").catch(() => null)]).then(([inputs, outputs]) => {
        if (alive) setState({ inputs, outputs });
      });
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(TEST_OUTPUT_EVENT, refresh);
    let off: (() => void) | null = null;
    if (!(window as unknown as { __BANZOU_TEST__?: boolean }).__BANZOU_TEST__) {
      void import("@tauri-apps/api/event")
        .then(({ listen }) => listen("audio-output-changed", refresh))
        .then((u) => (alive ? (off = u) : u()))
        .catch(() => {});
    }
    return () => {
      alive = false;
      off?.();
      window.removeEventListener("focus", refresh);
      window.removeEventListener(TEST_OUTPUT_EVENT, refresh);
    };
  }, []);
  return state;
}
