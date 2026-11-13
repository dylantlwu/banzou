import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { computePeaks } from "../audio/peaks";
import { type LrcDoc, formatLrcTime, serializeLrc, sortLines } from "../lyrics/lrc";
import { type Suggestion, alignLines } from "../lyrics/smartAlign";
import { formatTime } from "../utils/time";
import { Splitter } from "../layout/split";
import {
  NUDGE_SECONDS,
  type TapState,
  fromDoc,
  fromText,
  insertBreak,
  insertLine,
  nudge,
  progress,
  select,
  setCursor,
  setText,
  setTime,
  tap,
  tapTime,
  toDoc,
  toText,
  undo,
  withLines,
} from "../lyrics/tapState";
import { importLrc, looksLikeLrc } from "../lyrics/importLrc";
import type { Player } from "../player/usePlayer";
import type { Settings } from "../settings";
import type { Song } from "../types";
import { Btn, isTyping } from "./Btn";
import { LyricsView } from "./LyricsView";
import { Waveform } from "./Waveform";
import { songName } from "../songs/meta";

type Phase = "text" | "tap" | "preview";
type Listen = "vocal" | "accompaniment" | "both";

const RATES = [0.5, 0.75, 1];
const SKIP = 5;

interface Props {
  song: Song;
  doc: LrcDoc | null;
  player: Player;
  settings: Settings;
  onSaved: (doc: LrcDoc) => void;
  onExit: () => void;
  onOpenSettings: () => void;
  /** 有弹窗时暂停快捷键 */
  keysDisabled: boolean;
}

/** 打轴编辑器（PRD 4.3） */
export function TapEditor({ song, doc, player, settings, onSaved, onExit, onOpenSettings, keysDisabled }: Props) {
  const hasVocal = song.vocals.length > 0;
  const [state, setState] = useState<TapState>(() => (doc ? fromDoc(doc) : fromText("")));
  const [phase, setPhase] = useState<Phase>(() => (doc && doc.lines.length > 0 ? "tap" : "text"));
  const [draft, setDraft] = useState(() => (doc ? toText(fromDoc(doc)) : ""));
  const [listen, setListen] = useState<Listen>(hasVocal ? "vocal" : "accompaniment");
  const [rate, setRate] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  // 智能对齐
  const [aligning, setAligning] = useState(false);
  const [alignInfo, setAlignInfo] = useState<string | null>(null);
  const [beforeAlign, setBeforeAlign] = useState<TapState | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showDiffs, setShowDiffs] = useState(false);
  /** 建议是按这个行数算的；行数被别的操作改了（插间奏、删行）就作废 */
  const suggestionLenRef = useRef(0);
  useEffect(() => {
    if (state.lines.length !== suggestionLenRef.current) setSuggestions([]);
  }, [state.lines.length]);

  const stateRef = useRef(state);
  stateRef.current = state;

  const apply = useCallback((fn: (s: TapState) => TapState) => {
    const next = fn(stateRef.current);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
    setDirty(true);
    setMessage(null);
  }, []);

  const { setGain, setRate: setPlayerRate, ready } = player;

  // 听哪一轨
  useEffect(() => {
    setGain("vocal", listen === "accompaniment" ? 0 : 1);
    setGain("accompaniment", listen === "vocal" ? 0 : 1);
  }, [listen, setGain, ready]);

  // 变速，离开编辑器时恢复原速
  useEffect(() => setPlayerRate(rate), [rate, setPlayerRate]);
  useEffect(() => () => setPlayerRate(1), [setPlayerRate]);

  const latency = settings.outputLatencyMs;
  const heard = player.playing ? player.position - (latency / 1000) * player.rate : player.position;
  const stamp = useCallback(
    () => tapTime(player.getPosition(), player.rate, latency, settings.reactionMs),
    [player, latency, settings.reactionMs],
  );

  const baseDoc = useMemo(
    () => ({
      meta: { ...(doc?.meta ?? {}), ti: song.title, ...(song.artist ? { ar: song.artist } : {}) },
      offsetMs: doc?.offsetMs ?? 0,
    }),
    [doc, song.title, song.artist],
  );
  const previewDoc = useMemo(() => toDoc(state, baseDoc), [state, baseDoc]);

  const save = useCallback(async (): Promise<boolean> => {
    if (saving) return false;
    const newDoc = toDoc(stateRef.current, baseDoc);
    setSaving(true);
    try {
      await invoke("save_lyrics", {
        title: song.title,
        existingPath: song.lyrics?.path ?? null,
        content: serializeLrc(newDoc),
      });
      setDirty(false);
      setMessage("已保存");
      onSaved(newDoc);
      return true;
    } catch (e) {
      setMessage(`保存失败：${String(e)}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [saving, baseDoc, song.title, song.lyrics?.path, onSaved]);

  const requestExit = () => (dirty ? setConfirmExit(true) : onExit());

  /** 按人声识别结果对齐（LRC 修正时间；纯文本直接自动打轴） */
  const runAlign = async (base: TapState) => {
    const vocal = song.vocals[0];
    if (!vocal || aligning) return;
    setAligning(true);
    setMessage(null);
    setAlignInfo(null);
    try {
      const res = await alignLines(base.lines, vocal.path, player.getBuffer("vocal"), baseDoc.offsetMs);
      const sorted = sortLines(res.lines);
      const where = (i: number) => (i >= res.lines.length ? sorted.length : sorted.indexOf(res.lines[i]));
      setBeforeAlign(base);
      suggestionLenRef.current = sorted.length;
      apply(() => withLines(sorted));
      setSuggestions(res.suggestions.map((sg) => ({ ...sg, line: where(sg.line) })));
      setShowDiffs(false);
      const rest = res.sung - res.aligned;
      setAlignInfo(`已按人声对齐：${res.aligned}/${res.sung} 句直接对上${rest > 0 ? `，${rest} 句按前后推算（建议听一下）` : ""}`);
    } catch (e) {
      setMessage(`智能对齐失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAligning(false);
    }
  };

  const undoAlign = () => {
    if (!beforeAlign) return;
    const prev = beforeAlign;
    apply(() => prev);
    setBeforeAlign(null);
    setSuggestions([]);
    setAlignInfo(null);
  };

  const fixes = suggestions.filter((sg) => sg.kind === "fix");
  const acceptFix = (sg: Suggestion) => {
    apply((st) => setText(st, sg.line, sg.heard));
    setSuggestions((list) => list.filter((x) => x !== sg));
  };
  const acceptMissing = (sg: Suggestion) => {
    suggestionLenRef.current = stateRef.current.lines.length + 1;
    apply((st) => insertLine(st, sg.line, { text: sg.heard, time: sg.time }));
    // 插入后后面的行号都 +1
    setSuggestions((list) => list.filter((x) => x !== sg).map((x) => (x.line >= sg.line ? { ...x, line: x.line + 1 } : x)));
  };

  const nudgeAndReplay = useCallback(
    (delta: number) => {
      const sel = stateRef.current.selected;
      apply((s) => nudge(s, delta));
      const t = sel === null ? null : stateRef.current.lines[sel]?.time;
      if (t !== null && t !== undefined) {
        player.seekTo(Math.max(0, t - 2));
        if (!player.playing) void player.play();
      }
    },
    [apply, player],
  );

  // 每次渲染更新处理函数，监听只注册一次（播放中每帧都会重新渲染）
  const onKey = (ev: KeyboardEvent) => {
      if (isTyping(ev.target)) return;
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        void save();
        return;
      }
      if (mod || phase === "text") return;

      if (phase === "preview") {
        if (ev.code === "Space") void player.togglePlay();
        else if (ev.code === "ArrowLeft") player.skip(-SKIP);
        else if (ev.code === "ArrowRight") player.skip(SKIP);
        else if (ev.code === "Escape") setPhase("tap");
        else return;
        ev.preventDefault();
        return;
      }

      switch (ev.code) {
        case "Space":
          if (!player.playing) void player.play();
          else apply((s) => tap(s, stamp()));
          break;
        case "Enter":
          if (player.playing) apply((s) => insertBreak(s, stamp()));
          break;
        case "Backspace":
          apply(undo);
          if (player.playing) player.seekTo(Math.max(0, player.getPosition() - 3));
          break;
        case "Escape":
          player.pause();
          break;
        case "ArrowLeft":
          if (ev.altKey) nudgeAndReplay(-NUDGE_SECONDS);
          else player.skip(-SKIP);
          break;
        case "ArrowRight":
          if (ev.altKey) nudgeAndReplay(NUDGE_SECONDS);
          else player.skip(SKIP);
          break;
        case "ArrowUp":
        case "ArrowDown": {
          const s = stateRef.current;
          const cur = s.selected ?? (ev.code === "ArrowUp" ? s.lines.length : -1);
          const next = Math.max(0, Math.min(s.lines.length - 1, cur + (ev.code === "ArrowUp" ? -1 : 1)));
          setState(select(s, next));
          break;
        }
        default:
          return;
      }
      ev.preventDefault();
  };
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    if (keysDisabled || confirmExit) return;
    const handler = (ev: KeyboardEvent) => onKeyRef.current(ev);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [keysDisabled, confirmExit]);

  // 列表滚动：只滚动列表自己（scrollIntoView 会连带滚动外层页面，把整个界面顶出窗口）
  const listRef = useRef<HTMLOListElement>(null);
  const scrollToLine = useCallback((index: number) => {
    const list = listRef.current;
    const n = stateRef.current.lines.length;
    const el = list?.querySelector<HTMLElement>(`[data-line="${Math.max(0, Math.min(index, n - 1))}"]`) ?? undefined;
    if (list && el) list.scrollTo({ top: el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2, behavior: "smooth" });
  }, []);
  // 打轴时跟着「下一句」走；全部打完后（比如回来编辑）定位到正在播放的那句
  const { getPosition } = player;
  useEffect(() => {
    const s = stateRef.current;
    if (s.cursor < s.lines.length) return scrollToLine(s.cursor);
    const t = getPosition();
    let idx = 0;
    s.lines.forEach((l, i) => {
      if (l.time !== null && l.time <= t) idx = i;
    });
    scrollToLine(idx);
  }, [state.cursor, state.lines.length, phase, scrollToLine, getPosition]);
  // ↑/↓ 选行时，选中行要看得见
  useEffect(() => {
    const s = stateRef.current;
    // 刚打完的那句（cursor 前一句）由上面跟着「下一句」滚，避免两个滚动打架
    if (s.selected !== null && s.selected !== s.cursor - 1) scrollToLine(s.selected);
  }, [state.selected, scrollToLine]);

  const peaksSource = hasVocal ? "vocal" : "accompaniment";
  const { getBuffer } = player;
  const loaded = player.load.kind === "ready";
  const peaks = useMemo(() => {
    if (!loaded) return null;
    const buf = getBuffer(peaksSource);
    if (!buf) return null;
    const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    return computePeaks(channels, buf.sampleRate);
  }, [loaded, getBuffer, peaksSource]);

  const { done, total } = progress(state);

  if (phase === "text") {
    return (
      <section className="editor">
        <div className="editor-bar">
          <Btn className="ghost" onClick={requestExit}>
            ← 返回
          </Btn>
          <h2 className="editor-title">粘贴歌词 · {songName(song)}</h2>
        </div>
        <div className="tap-text">
          <p className="muted">把歌词粘贴进来，每行一句，空行会自动去掉。已经打过轴的行，文字不变的话时间会保留。也可以直接粘贴带时间的 LRC，时间会一起带进来。</p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            placeholder={"第一句歌词\n第二句歌词\n…"}
          />
          <div className="row">
            <Btn
              className="primary"
              disabled={!draft.trim()}
              onClick={() => {
                apply((s) => (looksLikeLrc(draft) ? fromDoc(importLrc(draft)) : fromText(draft, s.lines)));
                setPhase("tap");
              }}
            >
              开始打轴
            </Btn>
            {hasVocal && (
              <Btn
                className="ghost"
                disabled={!draft.trim() || aligning}
                title="按原唱人声自动给每句定时间，之后再听一遍微调"
                onClick={() => {
                  const base = looksLikeLrc(draft) ? fromDoc(importLrc(draft)) : fromText(draft, stateRef.current.lines);
                  apply(() => base);
                  setPhase("tap");
                  void runAlign(base);
                }}
              >
                自动打轴
              </Btn>
            )}
            {state.lines.length > 0 && (
              <Btn className="ghost" onClick={() => setPhase("tap")}>
                取消
              </Btn>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="editor">
      <div className="editor-bar">
        <Btn className="ghost" onClick={requestExit}>
          ← 返回
        </Btn>
        <h2 className="editor-title">{phase === "preview" ? "预览" : "打轴"}</h2>
        <div className="segmented" aria-label="听哪一轨">
          {(
            [
              ["vocal", "原唱人声"],
              ["accompaniment", "伴奏"],
              ["both", "两轨"],
            ] as [Listen, string][]
          ).map(([v, label]) => (
            <Btn
              key={v}
              className={listen === v ? "seg active" : "seg"}
              disabled={!hasVocal && v !== "accompaniment"}
              onClick={() => setListen(v)}
            >
              {label}
            </Btn>
          ))}
        </div>
        <div className="segmented" aria-label="播放速度">
          {RATES.map((r) => (
            <Btn key={r} className={rate === r ? "seg active" : "seg"} onClick={() => setRate(r)}>
              {r}x
            </Btn>
          ))}
        </div>
        <span className="spacer" />
        <span className="muted small">
          已打 {done}/{total} 句
        </span>
        <Btn
          className="ghost"
          disabled={!hasVocal || aligning || state.lines.length === 0}
          title={hasVocal ? "按原唱人声自动对齐每句的时间" : "这首歌没有人声分轨，没法智能对齐"}
          onClick={() => void runAlign(stateRef.current)}
        >
          {aligning ? "对齐中…" : "智能对齐"}
        </Btn>
        <Btn
          className="ghost"
          onClick={() => {
            setDraft(toText(state));
            setPhase("text");
          }}
        >
          编辑文本
        </Btn>
        <Btn className="ghost" onClick={() => setPhase(phase === "preview" ? "tap" : "preview")}>
          {phase === "preview" ? "继续打轴" : "预览"}
        </Btn>
        <Btn className="primary" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? "保存中…" : "保存"}
        </Btn>
      </div>

      {confirmExit && (
        <div className="confirm">
          <span>有未保存的修改</span>
          <Btn
            className="primary"
            onClick={async () => {
              if (await save()) onExit();
            }}
          >
            保存并返回
          </Btn>
          <Btn className="ghost" onClick={onExit}>
            不保存
          </Btn>
          <Btn className="ghost" onClick={() => setConfirmExit(false)}>
            取消
          </Btn>
        </div>
      )}

      {message && (
        <p className={/失败/.test(message) ? "editor-msg error-text" : "editor-msg muted"}>{message}</p>
      )}
      {aligning && <p className="editor-msg muted">正在识别人声里唱的字，第一次要几秒钟…</p>}
      {alignInfo && !aligning && (
        <p className="editor-msg align-info">
          <span>{alignInfo}</span>
          {fixes.length > 0 && (
            <Btn className="link" onClick={() => setShowDiffs((v) => !v)}>
              {showDiffs ? "隐藏对照" : `对照识别结果（${fixes.length} 处不同，仅供参考）`}
            </Btn>
          )}
          {beforeAlign && (
            <Btn className="link" onClick={undoAlign}>
              撤销对齐
            </Btn>
          )}
        </p>
      )}

      {phase === "preview" ? (
        <div className="editor-preview">
          <LyricsView doc={previewDoc} time={heard} playing={player.playing} onSeek={player.seekTo} large />
        </div>
      ) : (
        <ol className="tap-lines" ref={listRef}>
          {state.lines.map((line, i) => {
            const missing = suggestions.filter((sg) => sg.kind === "missing" && sg.line === i);
            const fix = showDiffs ? fixes.find((sg) => sg.line === i) : undefined;
            const cls = [
              "tap-line",
              i === state.cursor ? "cursor" : "",
              i === state.selected ? "selected" : "",
              line.text === "" ? "break" : "",
              line.time === null ? "untimed" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <Fragment key={i}>
              {missing.map((sg) => (
                <MissingRow key={`m${sg.time}`} suggestion={sg} onInsert={() => acceptMissing(sg)} />
              ))}
              <li
                data-line={i}
                className={cls}
                onClick={() => {
                  setState(select(stateRef.current, i));
                  if (line.time !== null) player.seekTo(Math.max(0, line.time - 1));
                }}
                onDoubleClick={() => setState(setCursor(stateRef.current, i))}
                title="单击选中并跳到这句，双击从这句开始重新打"
              >
                <span className="tap-time">{line.time === null ? "--:--.--" : formatLrcTime(line.time)}</span>
                <span className="tap-text-line">
                  {line.text === "" ? "（间奏）" : line.text}
                  {fix && (
                    <span className="heard" title={`识别听到的：${fix.changes ?? ""}。唱歌时识别常听错同音字，确认歌词真错了再改`}>
                      可能是：{fix.heard}（{fix.changes}）
                      <Btn
                        className="link"
                        onClick={(e) => {
                          e.stopPropagation();
                          acceptFix(fix);
                        }}
                      >
                        用这句
                      </Btn>
                    </span>
                  )}
                </span>
                {i === state.cursor && <span className="cursor-tag">下一句</span>}
              </li>
              </Fragment>
            );
          })}
          {suggestions
            .filter((sg) => sg.kind === "missing" && sg.line >= state.lines.length)
            .map((sg) => (
              <MissingRow key={`m${sg.time}`} suggestion={sg} onInsert={() => acceptMissing(sg)} />
            ))}
          {state.cursor >= state.lines.length && state.lines.length > 0 && (
            <li className="tap-done muted">全部打完了，点「预览」检查，没问题就保存</li>
          )}
        </ol>
      )}

      <Splitter id="wave-h" axis="y" target="next" min={40} max={0.6} />
      <Waveform
        peaks={peaks}
        time={Math.max(0, heard)}
        lines={state.lines}
        selected={state.selected}
        onMarkerChange={(i, t) => apply((s) => setTime(s, i, t))}
        onMarkerSelect={(i) => setState(select(stateRef.current, i))}
        onSeek={player.seekTo}
      />

      <p className="tap-hints muted">
        {phase === "preview" ? (
          "空格 播放/暂停 · ←/→ 快退/快进 · 点歌词跳转 · Esc 回到打轴"
        ) : (
          <>
            空格 开始 / 打下一句 · Enter 间奏 · ⌫ 撤销 · ⌥←/→ 微调选中行 50ms · ↑/↓ 选行 · Esc 暂停 · ⌘S 保存
            {latency === 0 && (
              <>
                {" · "}
                <Btn className="link" onClick={onOpenSettings}>
                  还没校准耳机延迟，戴 AirPods 打轴会偏晚
                </Btn>
              </>
            )}
          </>
        )}
      </p>
    </section>
  );
}

/** 识别出一段歌词里没有的内容：可能漏了一句 */
function MissingRow({ suggestion, onInsert }: { suggestion: Suggestion; onInsert: () => void }) {
  return (
    <li className="tap-missing">
      <span className="tap-time">{formatLrcTime(suggestion.time)}</span>
      <span className="tap-text-line">
        可能漏了一句（{formatTime(suggestion.time)} 听到）：{suggestion.heard}
      </span>
      <Btn className="ghost tiny" onClick={onInsert}>
        插入
      </Btn>
    </li>
  );
}
