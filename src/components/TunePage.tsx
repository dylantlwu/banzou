import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type LrcDoc, effectiveTime } from "../lyrics/lrc";
import type { Player } from "../player/usePlayer";
import type { Take } from "../takes/takes";
import type { Song } from "../types";
import { type Key, type PitchTrack, type TuneParams, computeTune, detectKey, hzToMidi, keyName } from "../tune/autotune";
import { type FxSettings, PRESET_NAMES, type Preset, buildChain } from "../tune/effects";
import { renderMix, writeMix } from "../tune/exportMix";
import { type Note, applyNotes, segmentNotes } from "../tune/notes";
import { type TuneDoc, applyHash, defaultDoc, loadTuneDoc, saveTuneDoc } from "../tune/tuneDoc";
import { type SnapMode, useNoteEditor } from "../tune/useNoteEditor";
import { formatTime } from "../utils/time";
import { Btn } from "./Btn";
import { PitchRoll, type RollView } from "./PitchRoll";

interface Rendered {
  path: string;
  start: number;
  sampleRate: number;
  seconds: number;
}

interface Props {
  song: Song;
  take: Take;
  dir: string;
  lyricsDoc: LrcDoc | null;
  player: Player;
  compare: boolean;
  onToggleCompare: () => void;
  /** 告诉 App 现在该放哪个人声文件（修前 = 拼接的原始录音，修后 = 修音结果） */
  onVoice: (v: { path: string; start: number } | null) => void;
  onExit: () => void;
}

const KEYS: Key[] = [
  ...Array.from({ length: 12 }, (_, t) => ({ tonic: t, mode: "major" as const })),
  ...Array.from({ length: 12 }, (_, t) => ({ tonic: t, mode: "minor" as const })),
  { tonic: 0, mode: "chromatic" as const },
];

/** 修音页（PRD 4.5） */
export function TunePage({ song, take, dir, lyricsDoc, player, compare, onToggleCompare, onVoice, onExit }: Props) {
  const title = song.title;
  const [status, setStatus] = useState<string | null>("正在拼接录音…");
  const [error, setError] = useState<string | null>(null);
  const [comp, setComp] = useState<Rendered | null>(null);
  const [mine, setMine] = useState<PitchTrack | null>(null);
  const [ref, setRef] = useState<PitchTrack | null>(null);
  const [doc, setDoc] = useState<TuneDoc | null>(null);
  const [tunedPath, setTunedPath] = useState<string | null>(null);
  const [after, setAfter] = useState(true);
  const [applying, setApplying] = useState(false);
  const [view, setView] = useState<RollView>({ start: 0, len: 12, lo: 48, hi: 72 });
  const [exporting, setExporting] = useState(false);
  const [viewMode, setViewMode] = useState<"curve" | "notes">("curve");
  const [snap, setSnap] = useState<SnapMode>("ref");
  const [initialNotes, setInitialNotes] = useState<Note[]>([]);

  const takeKey = JSON.stringify([take.clips, take.adjustMs]);

  // ---------- 打开：拼接录音 → 分析音高 → 读修音记录 ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setStatus("正在拼接录音…");
        const r = await invoke<Rendered>("render_take", { title, takeId: take.id, clips: take.clips, adjustMs: take.adjustMs });
        if (cancelled) return;
        setComp(r);
        setStatus("正在分析音高…");
        const [m, rf] = await Promise.all([
          invoke<PitchTrack>("analyze_pitch", { path: r.path }),
          song.vocals[0] ? invoke<PitchTrack>("analyze_pitch", { path: song.vocals[0].path }).catch(() => null) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setMine(m);
        setRef(rf);
        const saved = await loadTuneDoc(title, take.id).catch(() => null);
        // 用原唱检测调时要加上这遍录音的升降调
        const detected = detectKey((rf ?? m).f0);
        const shift = rf ? (take.transpose ?? 0) : 0;
        const key = { ...detected, tonic: (((detected.tonic + shift) % 12) + 12) % 12 };
        const d = saved ?? defaultDoc({ key, reference: rf ? "vocal" : "scale" });
        setDoc(d);
        // 音符：用保存过的（同一份录音），否则自动切分
        const savedNotes = d.notes as { takeKey?: string; list?: Note[] } | undefined;
        setInitialNotes(savedNotes?.takeKey === takeKey && Array.isArray(savedNotes.list) ? savedNotes.list : segmentNotes(m, r.start));
        if (!rf) setSnap("semitone");
        // 上次修过而且参数没变：直接用修后音频
        const tuned = `${dir}/${take.id}.tuned.wav`;
        if (saved?.appliedHash && saved.appliedHash === applyHash(saved, takeKey)) setTunedPath(tuned);
        // 视图对准我唱的范围
        const voiced = m.f0.filter((f) => f > 0).map(hzToMidi).sort((a, b) => a - b);
        if (voiced.length) {
          const med = voiced[Math.floor(voiced.length / 2)];
          setView({ start: Math.max(0, r.start - 1), len: 12, lo: Math.floor(med - 11), hi: Math.ceil(med + 11) });
        }
        setStatus(null);
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setStatus(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [title, take.id, takeKey, dir, song.vocals, take.transpose]);

  // ---------- 播放哪个人声 ----------
  useEffect(() => {
    if (!comp) return onVoice(null);
    onVoice({ path: after && tunedPath ? tunedPath : comp.path, start: comp.start });
  }, [comp, after, tunedPath, onVoice]);
  useEffect(() => () => onVoice(null), [onVoice]);

  // 效果链实时试听
  const { setGroupChain } = player;
  useEffect(() => {
    if (!doc) return;
    const fx = doc.fx;
    setGroupChain("voice", (ctx) => buildChain(ctx, fx));
    return () => setGroupChain("voice", null);
  }, [doc?.fx, setGroupChain, player.ready]);
  useEffect(() => {
    if (doc) player.setGain("accompaniment", doc.fx.accGain);
  }, [doc?.fx.accGain, player.ready]);

  // ---------- 修改记录（自动保存） ----------
  const saveTimer = useRef<number | undefined>(undefined);
  const update = useCallback(
    (patch: Partial<TuneDoc> | ((d: TuneDoc) => Partial<TuneDoc>)) => {
      setDoc((d) => {
        if (!d) return d;
        const next = { ...d, ...(typeof patch === "function" ? patch(d) : patch) };
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => void saveTuneDoc(title, take.id, next).catch((e) => setError(String(e))), 400);
        return next;
      });
    },
    [title, take.id],
  );
  // 用最新状态合并，连续几下修改不会互相覆盖
  const setParams = (p: Partial<TuneParams>) => update((d) => ({ params: { ...d.params, ...p } }));
  const setFx = (p: Partial<FxSettings>) => update((d) => ({ fx: { ...d.fx, ...p } }));

  // ---------- 歌词句子 → 修音范围 ----------
  const lyricLines = useMemo(() => {
    if (!lyricsDoc) return [];
    const timed = lyricsDoc.lines.filter((l) => l.time !== null);
    return timed.map((l, i) => {
      const t = effectiveTime(lyricsDoc, l)!;
      const next = timed[i + 1];
      return { text: l.text, from: t, to: next ? effectiveTime(lyricsDoc, next)! : t + 8 };
    });
  }, [lyricsDoc]);
  const ranges = useMemo<[number, number][] | null>(
    () => (doc && doc.lines.length ? doc.lines.filter((i) => lyricLines[i]).map((i) => [lyricLines[i].from, lyricLines[i].to]) : null),
    [doc, lyricLines],
  );

  const refTranspose = take.transpose ?? 0;
  const result = useMemo(
    () => (doc && mine && comp ? computeTune(mine, comp.start, ref, { ...doc.params, ranges }, refTranspose) : null),
    [doc, mine, comp, ref, ranges, refTranspose],
  );
  const refMidi = useMemo(() => (ref ? Float64Array.from(ref.f0, (f) => (f > 0 ? hzToMidi(f) + refTranspose : NaN)) : null), [ref, refTranspose]);

  // ---------- 手动修音（音符） ----------
  const renderQueue = useRef<{ busy: boolean; pending: [number, number] | null }>({ busy: false, pending: null });
  const quickRenderRef = useRef<(range: [number, number]) => void>(() => {});
  const editor = useNoteEditor({
    enabled: viewMode === "notes",
    initial: initialNotes,
    mine: result?.mine ?? null,
    start: comp?.start ?? 0,
    hop: mine?.hop ?? 0.01,
    ref: refMidi,
    refHop: ref?.hop ?? 0.01,
    snap,
    onChange: useCallback((list: Note[]) => update({ notes: { takeKey, list } }), [update, takeKey]),
    onCommit: useCallback((range: [number, number]) => quickRenderRef.current(range), []),
  });
  const finalCents = useMemo(
    () => (result && comp && mine ? applyNotes(result.mine, comp.start, mine.hop, result.cents, editor.notes) : null),
    [result, comp, mine, editor.notes],
  );
  const finalTuned = useMemo(
    () => (result && finalCents ? Float64Array.from(result.mine, (v, i) => v + finalCents[i] / 100) : null),
    [result, finalCents],
  );
  const stale = doc && tunedPath ? doc.appliedHash !== applyHash({ ...doc }, takeKey) : false;
  /** 不含手动编辑的指纹：只有它没变时才能做局部渲染 */
  const autoHash = (d: TuneDoc) => applyHash({ ...d, notes: undefined }, takeKey);

  // ---------- 应用修音 ----------
  const jobFor = (d: TuneDoc, cents: Float32Array) => ({
    cents: Array.from(cents, (c) => Math.round(c * 10) / 10),
    hop: mine!.hop,
    denoise: d.denoise,
    noise: take.noise ? [take.noise.from, take.noise.to] : null,
    noiseFile: take.noise?.file ?? null,
  });
  const reloadTuned = (path: string) => {
    player.evict(path);
    setTunedPath(null);
    setTimeout(() => setTunedPath(path), 0);
  };

  // 改了音符：只重渲改动的那一段（前提是自动修音参数和上次应用时一样），否则整段重渲
  const docRef = useRef(doc);
  docRef.current = doc;
  const centsRef = useRef(finalCents);
  centsRef.current = finalCents;
  quickRenderRef.current = (range: [number, number]) => {
    const q = renderQueue.current;
    if (q.busy) {
      q.pending = q.pending ? [Math.min(q.pending[0], range[0]), Math.max(q.pending[1], range[1])] : range;
      return;
    }
    // 等这一帧的状态（新的修正曲线）算好再渲染
    setTimeout(async () => {
      const d = docRef.current;
      const cents = centsRef.current;
      if (!d || !cents || !comp) return;
      const canPartial = !!tunedPath && d.appliedAutoHash === autoHash(d);
      if (!canPartial) {
        void apply();
        return;
      }
      q.busy = true;
      try {
        const path = await invoke<string>("render_tuned", {
          title,
          takeId: take.id,
          job: jobFor(d, cents),
          range: [Math.max(0, range[0] - comp.start), Math.max(0, range[1] - comp.start)],
        });
        reloadTuned(path);
        update({ appliedHash: applyHash(d, takeKey) });
      } catch (e) {
        setError(String(e));
      } finally {
        q.busy = false;
        const next = q.pending;
        q.pending = null;
        if (next) quickRenderRef.current(next);
      }
    }, 30);
  };

  const apply = async () => {
    const d0 = docRef.current;
    const cents = centsRef.current;
    if (!d0 || !cents || !comp) return;
    setApplying(true);
    setError(null);
    try {
      const path = await invoke<string>("render_tuned", {
        title,
        takeId: take.id,
        job: {
          cents: Array.from(cents, (c) => Math.round(c * 10) / 10),
          hop: mine!.hop,
          denoise: d0.denoise,
          noise: take.noise ? [take.noise.from, take.noise.to] : null,
          noiseFile: take.noise?.file ?? null,
        },
      });
      reloadTuned(path);
      setAfter(true);
      const d = docRef.current ?? d0;
      update({ appliedHash: applyHash(d, takeKey), appliedAutoHash: autoHash(d) });
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  };

  // ---------- 导出 ----------
  const [exportName, setExportName] = useState(`${title} - ${take.name}`);
  const [exportMix, setExportMix] = useState(true);
  const [exportDry, setExportDry] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [exported, setExported] = useState<string[]>([]);
  const runExport = async () => {
    if (!doc || !comp) return;
    setProgress(0);
    setExported([]);
    setError(null);
    try {
      const files: string[] = [];
      if (exportMix) {
        const acc = player.getBuffer("accompaniment");
        if (!acc) throw new Error("伴奏还没加载好");
        const voicePath = tunedPath ?? comp.path;
        const res = await fetch(convertFileSrc(voicePath));
        const voice = await player.context().decodeAudioData(await res.arrayBuffer());
        const mix = await renderMix({ accompaniment: acc, voice, voiceStart: comp.start, fx: doc.fx });
        files.push(...(await writeMix(title, exportName, mix, true, (p) => setProgress(p * 0.95))));
      }
      if (exportDry) files.push(await invoke<string>("export_dry", { title, takeId: take.id, name: `${exportName}（干声）` }));
      setProgress(1);
      setExported(files);
    } catch (e) {
      setError(`导出失败：${e instanceof Error ? e.message : String(e)}`);
      setProgress(null);
    }
  };

  // 播放时视图跟着走
  const time = player.position;
  useEffect(() => {
    if (!player.playing) return;
    if (time < view.start || time > view.start + view.len * 0.85) setView((v) => ({ ...v, start: Math.max(0, time - v.len * 0.15) }));
  }, [time, player.playing, view.start, view.len]);

  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <section className="editor tune">
      <div className="editor-bar">
        <Btn className="ghost" onClick={onExit}>
          ← 返回
        </Btn>
        <h2 className="editor-title">修音 · {take.name}</h2>
        <div className="segmented" aria-label="修前修后">
          <Btn className={!after ? "seg active" : "seg"} onClick={() => setAfter(false)}>
            修前
          </Btn>
          <Btn className={after ? "seg active" : "seg"} onClick={() => setAfter(true)} disabled={!tunedPath} title={tunedPath ? "" : "先点「应用修音」"}>
            修后
          </Btn>
        </div>
        <div className="segmented" aria-label="视图">
          <Btn className={viewMode === "curve" ? "seg active" : "seg"} onClick={() => setViewMode("curve")} title="自动修音：看曲线、调参数">
            曲线
          </Btn>
          <Btn className={viewMode === "notes" ? "seg active" : "seg"} onClick={() => setViewMode("notes")} title="手动修音：拖音符块">
            音符
          </Btn>
        </div>
        <Btn className={compare ? "toggle on" : "toggle"} onClick={onToggleCompare} disabled={!song.vocals[0]} title="切换听原唱（V）">
          {compare ? "正在听原唱" : "听原唱对比"}
        </Btn>
        <span className="spacer" />
        {result && (
          <span className="muted small" title="发声部分里，离目标 30 音分以内的比例">
            音准 {pct(result.inTuneBefore)} → <b>{pct(result.inTuneAfter)}</b>
          </span>
        )}
        <Btn className="primary" onClick={() => setExporting((v) => !v)} disabled={!comp}>
          导出
        </Btn>
      </div>

      {(status || error) && <p className={error ? "editor-msg error-text" : "editor-msg muted"}>{error ?? status}</p>}

      <div className="tune-lyrics" title="点句子选中 / 取消；选了句子就只修选中的，不选就修整首">
        {lyricLines.map((l, i) => {
          if (l.to < view.start || l.from > view.start + view.len || !l.text) return null;
          const left = ((l.from - view.start) / view.len) * 100;
          const width = ((Math.min(l.to, l.from + 30) - l.from) / view.len) * 100;
          const sel = doc?.lines.includes(i);
          return (
            <button
              key={i}
              type="button"
              className={sel ? "tune-line sel" : "tune-line"}
              style={{ left: `${left}%`, width: `${width}%` }}
              onClick={() => update((d) => ({ lines: d.lines.includes(i) ? d.lines.filter((x) => x !== i) : [...d.lines, i] }))}
            >
              {l.text}
            </button>
          );
        })}
      </div>

      <PitchRoll
        data={
          result && comp
            ? {
                hop: mine!.hop,
                start: comp.start,
                mine: result.mine,
                center: result.center,
                target: result.target,
                tuned: finalTuned,
                ref: doc?.params.reference === "vocal" || viewMode === "notes" ? refMidi : null,
                refHop: ref?.hop ?? 0.01,
                ranges: viewMode === "notes" ? null : ranges,
              }
            : null
        }
        view={view}
        time={time}
        onSeek={player.seekTo}
        onView={setView}
        overlay={viewMode === "notes" ? editor.overlay : undefined}
        onPointer={viewMode === "notes" ? editor.onPointer : undefined}
        onDoubleClick={viewMode === "notes" ? editor.onDoubleClick : undefined}
        onContextMenu={viewMode === "notes" ? editor.onContextMenu : undefined}
        cursor={viewMode === "notes" ? (editor.splitTool ? "col-resize" : "default") : undefined}
      />

      <div className="tune-legend muted small">
        <span className="lg ref" /> 原唱 <span className="lg mine" /> 我的 <span className="lg off" /> 跑调（&gt; 30 音分） <span className="lg tuned" /> 修后
        <span className="spacer" />
        滚轮上下移动 · 横向滑动翻页 · ⌘ + 滚轮缩放 · 点击跳转
      </div>

      {viewMode === "notes" && (
        <div className="tune-controls notes-bar">
          <div className="rec-row">
            <span className="muted small">吸附</span>
            <div className="segmented">
              {(
                [
                  ["ref", "原唱"],
                  ["semitone", "半音"],
                  ["free", "自由"],
                ] as [SnapMode, string][]
              ).map(([m, label]) => (
                <Btn key={m} className={snap === m ? "seg active" : "seg"} onClick={() => setSnap(m)} disabled={m === "ref" && !ref}>
                  {label}
                </Btn>
              ))}
            </div>
            <Btn className={editor.splitTool ? "toggle on" : "toggle"} onClick={() => editor.setSplitTool(!editor.splitTool)} title="点音符块切成两个（S）">
              ✂ 切分
            </Btn>
            <Btn className="ghost" onClick={editor.undo} disabled={!editor.canUndo} title="撤销（⌘Z）">
              ↶ 撤销
            </Btn>
            <Btn className="ghost" onClick={editor.redo} disabled={!editor.canRedo} title="重做（⇧⌘Z）">
              ↷ 重做
            </Btn>
            <Btn className="ghost" onClick={editor.resetAll} disabled={!editor.notes.some((n) => n.edited)}>
              全部还原
            </Btn>
            <span className="spacer" />
            <span className="muted small">
              上下拖音符改音高（⌥ 自由）· 双击吸附原唱 · ↑↓ 半音 · ⇧↑↓ 10 音分 · ⌘J 合并 · 右键还原
            </span>
          </div>
          {editor.selectedNotes.length > 0 ? (
            <div className="rec-row">
              <span className="small">
                已选 {editor.selectedNotes.length} 个音
                {editor.selectedNotes.length === 1 && ` · 音高 ${editor.selectedNotes[0].offset > 0 ? "+" : ""}${editor.selectedNotes[0].offset} 音分`}
              </span>
              {(
                [
                  ["straighten", "拉直", 0, 1, 0.05, (v: number) => `${Math.round(v * 100)}%`],
                  ["vibrato", "颤音", 0, 2, 0.05, (v: number) => `${Math.round(v * 100)}%`],
                  ["transition", "过渡", 0, 200, 5, (v: number) => `${v}ms`],
                ] as const
              ).map(([key, label, min, max, step, fmt]) => {
                const v = editor.selectedNotes[0][key];
                return (
                  <label key={key} className="rec-field">
                    <span className="muted small">{label}</span>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={v}
                      onChange={(e) => editor.setParam({ [key]: Number(e.target.value) }, true)}
                      onPointerUp={() => editor.commitCurrent()}
                      onKeyUp={() => editor.commitCurrent()}
                    />
                    <span className="small">{fmt(v)}</span>
                  </label>
                );
              })}
              <Btn className="ghost" onClick={editor.resetSelected}>
                还原
              </Btn>
            </div>
          ) : (
            <p className="rec-msg muted">点一个音符块选中（⇧ 多选），{tunedPath ? "改完会自动重新渲染这一段" : "第一次改动会先把整首修音渲染一遍"}。</p>
          )}
        </div>
      )}

      {doc && viewMode === "curve" && (
        <div className="tune-controls">
          <div className="rec-row">
            <span className="muted small">参考</span>
            <div className="segmented">
              <Btn className={doc.params.reference === "vocal" ? "seg active" : "seg"} onClick={() => setParams({ reference: "vocal" })} disabled={!ref}>
                原唱
              </Btn>
              <Btn className={doc.params.reference === "scale" ? "seg active" : "seg"} onClick={() => setParams({ reference: "scale" })}>
                音阶
              </Btn>
            </div>
            <label className="rec-field">
              <span className="muted small">调</span>
              <select value={KEYS.findIndex((k) => k.tonic === doc.params.key.tonic && k.mode === doc.params.key.mode)} onChange={(e) => setParams({ key: KEYS[Number(e.target.value)] })}>
                {KEYS.map((k, i) => (
                  <option key={i} value={i}>
                    {keyName(k)}
                  </option>
                ))}
              </select>
            </label>
            <label className="rec-field" title="修正偏差的多少">
              <span className="muted small">强度</span>
              <input type="range" min={0} max={1} step={0.05} value={doc.params.strength} onChange={(e) => setParams({ strength: Number(e.target.value) })} />
              <span className="small">{pct(doc.params.strength)}</span>
            </label>
            <label className="rec-field" title="慢 = 保留颤音和滑音，自然；快 = 电音感">
              <span className="muted small">自然</span>
              <input type="range" min={0} max={1} step={0.05} value={doc.params.speed} onChange={(e) => setParams({ speed: Number(e.target.value) })} />
              <span className="muted small">电音</span>
            </label>
            <label className="small check" title="用录音前那 2 秒环境底噪做参考去掉底噪">
              <input type="checkbox" checked={doc.denoise} onChange={(e) => update({ denoise: e.target.checked })} />
              降噪
            </label>
            <span className="spacer" />
            {doc.lines.length > 0 && <span className="muted small">只修选中的 {doc.lines.length} 句</span>}
            <Btn className="primary" onClick={() => void apply()} disabled={applying || !result}>
              {applying ? "修音中…" : tunedPath && !stale ? "重新应用" : "应用修音"}
            </Btn>
          </div>
          <div className="rec-row">
            <span className="muted small">效果</span>
            <div className="segmented">
              {(Object.keys(PRESET_NAMES) as Preset[]).map((p) => (
                <Btn key={p} className={doc.fx.preset === p ? "seg active" : "seg"} onClick={() => setFx({ preset: p })}>
                  {PRESET_NAMES[p]}
                </Btn>
              ))}
            </div>
            {(["eq", "comp", "reverb"] as const).map((k) => (
              <label key={k} className="small check">
                <input type="checkbox" checked={doc.fx[k]} onChange={(e) => setFx({ [k]: e.target.checked })} />
                {k === "eq" ? "均衡" : k === "comp" ? "压缩" : "混响"}
              </label>
            ))}
            <label className="rec-field">
              <span className="muted small">人声</span>
              <input type="range" min={0} max={1.5} step={0.05} value={doc.fx.voiceGain} onChange={(e) => setFx({ voiceGain: Number(e.target.value) })} />
            </label>
            <label className="rec-field">
              <span className="muted small">伴奏</span>
              <input type="range" min={0} max={1.5} step={0.05} value={doc.fx.accGain} onChange={(e) => setFx({ accGain: Number(e.target.value) })} />
            </label>
          </div>
          {stale && <p className="rec-msg muted">参数改过了，现在听到的「修后」还是上次的结果，点「应用修音」更新。</p>}
          {result && result.inTuneBefore < 0.4 && doc.params.reference === "vocal" && (
            <p className="rec-msg muted">跑调的地方比较多：修完会有明显机器感，严重的句子建议用补录重唱一遍。</p>
          )}
        </div>
      )}

      {exporting && (
        <div className="export-panel">
          <label className="rec-field">
            <span className="muted small">文件名</span>
            <input className="url-input" value={exportName} onChange={(e) => setExportName(e.target.value)} />
          </label>
          <label className="small check">
            <input type="checkbox" checked={exportMix} onChange={(e) => setExportMix(e.target.checked)} />
            成品（伴奏 + 人声，带效果）wav + m4a
          </label>
          <label className="small check">
            <input type="checkbox" checked={exportDry} onChange={(e) => setExportDry(e.target.checked)} />
            修后干声 wav（拿去别的软件继续做）
          </label>
          <div className="rec-row">
            <Btn className="primary" onClick={() => void runExport()} disabled={progress !== null && progress < 1 || (!exportMix && !exportDry)}>
              {progress !== null && progress < 1 ? `导出中 ${Math.round(progress * 100)}%` : "开始导出"}
            </Btn>
            {!tunedPath && <span className="muted small">还没应用修音，会导出原始录音</span>}
          </div>
          {exported.length > 0 && (
            <ul className="export-files">
              {exported.map((f) => (
                <li key={f}>
                  <span className="small">{f.split("/").pop()}</span>
                  <Btn className="link" onClick={() => void invoke("reveal_file", { path: f })}>
                    在访达中显示
                  </Btn>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {comp && <p className="muted small tune-foot">录音覆盖 {formatTime(comp.start)}–{formatTime(comp.start + comp.seconds)}</p>}
    </section>
  );
}
