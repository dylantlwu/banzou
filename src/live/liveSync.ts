/**
 * 把歌词和播放状态推给直播叠加层（PRD 4.7）。
 * 歌词 / 样式变了推一次 full；播放位置每 250ms 推一次 pos，播放、暂停、跳转时立即推。
 * 叠加层按真实播放位置走，不扣耳机延迟（直播声音是 OBS 直接从应用采集的）。
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { type LrcDoc, effectiveTime } from "../lyrics/lrc";
import type { Settings } from "../settings";

export interface LiveInfo {
  port: number;
  url: string;
}

export function getLiveInfo(): Promise<LiveInfo> {
  return invoke<LiveInfo>("live_info");
}

export function openLiveWindow(bg: "green" | "black"): Promise<void> {
  return invoke("open_live_window", { bg });
}

function push(msg: object) {
  return invoke("live_update", { body: JSON.stringify(msg) }).catch(() => {});
}

/** 叠加层要的歌词：只要已打轴的行，时间已扣 offset */
export function overlayLines(doc: LrcDoc | null): { t: number; text: string }[] {
  if (!doc) return [];
  return doc.lines
    .filter((l) => l.time !== null)
    .map((l) => ({ t: Math.round(effectiveTime(doc, l)! * 1000) / 1000, text: l.text }));
}

interface Options {
  settings: Settings;
  title: string | null;
  artist: string | null;
  doc: LrcDoc | null;
  playing: boolean;
  rate: number;
  /** 当前播放位置（state，播放中每帧更新，跳转时也会变） */
  position: number;
  getPosition: () => number;
  /** 直播混音的采样率（叠加层页面按这个播放） */
  audioRate?: number | null;
}

export function useLiveSync({ settings, title, artist, doc, playing, rate, position, getPosition, audioRate }: Options) {
  const enabled = settings.liveEnabled;
  const getPos = useRef(getPosition);
  getPos.current = getPosition;

  // 歌词、歌名、样式
  useEffect(() => {
    if (!enabled) return;
    void push({
      type: "full",
      title,
      artist,
      lines: overlayLines(doc),
      audioRate: audioRate ?? null,
      style: {
        fontSize: settings.liveFontSize,
        color: settings.liveColor,
        showNext: settings.liveShowNext,
        position: settings.livePosition,
      },
    });
  }, [enabled, title, artist, doc, settings.liveFontSize, settings.liveColor, settings.liveShowNext, settings.livePosition, audioRate]);

  // 播放位置：播放中每 250ms 推一次；暂停、播放、变速时立即推
  const lastSent = useRef({ position: 0, sentAt: 0, playing: false, rate: 1 });
  const sendPos = useRef(() => {});
  sendPos.current = () => {
    const msg = { type: "pos", playing, position: getPos.current(), rate, sentAt: Date.now() };
    lastSent.current = msg;
    void push(msg);
  };
  useEffect(() => {
    if (!enabled) return;
    sendPos.current();
    if (!playing) return;
    const id = window.setInterval(() => sendPos.current(), 250);
    return () => window.clearInterval(id);
  }, [enabled, playing, rate]);

  // 跳转：位置和预期差太多就立即推（暂停时任何变化都推）
  useEffect(() => {
    if (!enabled) return;
    const last = lastSent.current;
    const expected = last.playing ? last.position + ((Date.now() - last.sentAt) / 1000) * last.rate : last.position;
    if (Math.abs(position - expected) > 0.3) sendPos.current();
  }, [enabled, position]);

  // 关掉直播时清空叠加层
  useEffect(() => {
    if (enabled) return;
    void push({ type: "full", title: null, artist: null, lines: [], style: null });
    void push({ type: "pos", playing: false, position: 0, rate: 1, sentAt: Date.now() });
  }, [enabled]);
}
