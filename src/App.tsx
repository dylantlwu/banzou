import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Btn, isTyping } from "./components/Btn";
import { LyricsView } from "./components/LyricsView";
import { CompDialog } from "./components/CompDialog";
import { LivePanel } from "./components/LivePanel";
import { PracticePage } from "./components/PracticePage";
import { RecordBar } from "./components/RecordBar";
import { TakesPanel } from "./components/TakesPanel";
import { type LiveInput, SingPitch } from "./components/SingPitch";
import type { RefPitch } from "./sing/pitchView";
import { type PitchTrack, hzToMidi } from "./tune/autotune";
import { TunePage } from "./components/TunePage";
import { takeTracks } from "./takes/takes";
import { useRecording } from "./takes/useRecording";
import { useTakes } from "./takes/useTakes";
import { UpdateCard } from "./components/UpdateCard";
import { type UpdateInfo, checkForUpdate, shouldAutoCheck } from "./update/updater";
import { SettingsDialog } from "./components/SettingsDialog";
import { TagsDialog } from "./components/TagsDialog";
import { CheckDialog } from "./songs/CheckDialog";
import { songName } from "./songs/meta";
import { SongInfoDialog } from "./songs/SongInfoDialog";
import { type TagStore, displayArtist, langEraLine, loadTags, normalizeStore, songId } from "./tags";
import { TvDialog } from "./components/TvDialog";
import { LearnDialog } from "./learn/LearnDialog";
import { type SepTarget, VideoDialog } from "./components/VideoDialog";
import { useLiveSync } from "./live/liveSync";
import { useGoLive } from "./live/useGoLive";
import { TapEditor } from "./components/TapEditor";
import { decodeLyricsBytes, importLrc } from "./lyrics/importLrc";
import { alignDoc } from "./lyrics/smartAlign";
import { type LrcDoc, effectiveTime, findLineIndex, hasTimedLines, parseLrc, serializeLrc } from "./lyrics/lrc";
import { type PlayerTrack, usePlayer } from "./player/usePlayer";
import { DEFAULT_SETTINGS, type Settings, loadSettings, saveSettings } from "./settings";
import type { Library, MediaFile, Song } from "./types";
import { formatTime } from "./utils/time";
import "./App.css";

const SKIP_SECONDS = 5;
const OFFSET_STEP_MS = 50;

type Mode = "sing" | "tap" | "tune" | "practice";
interface Source {
  kind: "accompaniment" | "external";
  label: string;
  file: MediaFile;
}

function PlayIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
    </svg>
  );
}

function SongBadges({ song }: { song: Song }) {
  const badges: [string, boolean][] = [
    [song.accompaniments[0] ? `伴奏 ${song.accompaniments[0].format}` : "伴奏", song.accompaniments.length > 0],
    ["人声", song.vocals.length > 0],
    ["歌词", song.lyrics !== null],
    ["原曲", song.originals.length > 0],
    ["录音", song.externalRecordings.length > 0],
  ];
  return (
    <div className="badges">
      {badges.map(([label, on]) => (
        <span key={label} className={on ? "badge on" : "badge"}>
          {label}
        </span>
      ))}
    </div>
  );
}

function formatOffset(ms: number): string {
  if (ms === 0) return "0";
  return `${ms > 0 ? "提前" : "推后"} ${(Math.abs(ms) / 1000).toFixed(2)}s`;
}

export default function App() {
  // ---------- 设置 ----------
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const settingsLoaded = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const [compOpen, setCompOpen] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  // 启动几秒后悄悄检查一次更新；没网或出错都不打扰
  useEffect(() => {
    if (!shouldAutoCheck()) return;
    const id = window.setTimeout(() => {
      checkForUpdate()
        .then((u) => u && setUpdate(u))
        .catch(() => {});
    }, 3000);
    return () => window.clearTimeout(id);
  }, []);
  const [tvOpen, setTvOpen] = useState(false);
  const [tvBusy, setTvBusy] = useState<string | null>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  /** 外语学唱（PRD 4.12）：问老师、老师笔记 */
  const [learnOpen, setLearnOpen] = useState(false);
  const [tagBusy, setTagBusy] = useState<string | null>(null);
  const dialogOpen = settingsOpen || liveOpen || compOpen || tvOpen;
  useEffect(() => {
    loadSettings()
      .then(setSettings)
      .catch((e) => console.error(e))
      .finally(() => {
        settingsLoaded.current = true;
      });
  }, []);
  useEffect(() => {
    if (!settingsLoaded.current) return;
    const id = window.setTimeout(() => void saveSettings(settings).catch((e) => console.error(e)), 400);
    return () => window.clearTimeout(id);
  }, [settings]);
  const updateSettings = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);

  // ---------- 曲库 ----------
  const [library, setLibrary] = useState<Library | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const [sourceIndex, setSourceIndex] = useState(0);
  const [mode, setMode] = useState<Mode>("sing");
  const [vocalOn, setVocalOn] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      const lib = await invoke<Library>("scan_library");
      setLibrary(lib);
      setSelectedId((id) => (id && lib.songs.some((s) => s.id === id) ? id : null));
    } catch (e) {
      if (String(e) === "NO_LIBRARY") {
        setLibrary(null);
        setNeedLibrary(true);
      } else setScanError(String(e));
    } finally {
      setScanning(false);
    }
  }, []);
  // 下载视频（PRD 4.10）：窗口关掉时下载在后台继续，按钮上显示进度
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoBusy, setVideoBusy] = useState<string | null>(null);
  // 下载完 / 做成伴奏后顺手给这首歌联网打标签（歌手、语种、年代、背景，没歌词顺手找）；没填 API key 就不做，出错也不打扰
  const autoTag = useCallback((title: string, hint: string) => {
    void (async () => {
      try {
        if (!(await invoke<boolean>("ai_key_status"))) return;
        setTagBusy("打标签中…");
        const r = await invoke<{ songs: number; lyrics: number }>("ai_tag_songs", { retag: false, titles: [title], hints: hint ? { [title]: hint } : null });
        setTags(await loadTags());
        if (r.lyrics > 0) setLibrary(await invoke<Library>("scan_library"));
      } catch (e) {
        console.warn("自动打标签没成功", e);
      } finally {
        setTagBusy(null);
      }
    })();
  }, []);
  const onVideoDownloaded = useCallback(async (path: string, meta?: { title: string; uploader: string | null }) => {
    const lib = await invoke<Library>("scan_library");
    setLibrary(lib);
    const title = lib.songs.find((s) => s.originals.some((o) => o.path === path))?.title ?? null;
    if (title) autoTag(title, meta ? [meta.title, meta.uploader].filter(Boolean).join(" · ") : "");
    return title;
  }, [autoTag]);
  // 做成伴奏（PRD 4.11）：从曲库里点进来时带上文件
  const [videoTarget, setVideoTarget] = useState<(SepTarget & { key: number }) | null>(null);
  const openSeparate = useCallback((file: { path: string; fileName: string }, song: string | null) => {
    setVideoTarget({ ...file, song, key: Date.now() });
    setVideoOpen(true);
  }, []);
  const onSeparated = useCallback(
    async (name: string, source?: string) => {
      setLibrary(await invoke<Library>("scan_library"));
      // 视频文件名一般就是 YouTube 标题，给 AI 当线索
      autoTag(name, source?.replace(/\.[^.]+$/, "") ?? "");
    },
    [autoTag],
  );
  const openSongByName = useCallback(
    (name: string) => {
      const key = name.trim().toLowerCase().replace(/\s+/g, " ");
      const song = library?.songs.find((s) => s.title.trim().toLowerCase().replace(/\s+/g, " ") === key);
      if (song) setSelectedId(song.id);
      setVideoOpen(false);
    },
    [library],
  );
  // 第一次打开：还没选素材文件夹
  const [needLibrary, setNeedLibrary] = useState(false);
  const chooseLibrary = useCallback(async () => {
    try {
      const dir = await invoke<string | null>("choose_library_dir");
      if (!dir) return;
      setNeedLibrary(false);
      setSelectedId(null);
      await scan();
    } catch (e) {
      setScanError(String(e));
    }
  }, [scan]);
  useEffect(() => {
    void scan();
  }, [scan]);

  // 歌曲资料（src/songs）：资料检查窗口、单首歌的资料窗口
  const [checkOpen, setCheckOpen] = useState(false);
  const [infoSong, setInfoSong] = useState<Song | null>(null);
  const onSongRenamed = useCallback(
    async (oldKey: string, newKey: string) => {
      setInfoSong(null);
      // 升降调记录按文件名记，跟着改
      const st = settings.transposeBySong[oldKey];
      if (st !== undefined) {
        const map = { ...settings.transposeBySong, [newKey]: st };
        delete map[oldKey];
        updateSettings({ transposeBySong: map });
      }
      const lib = await invoke<Library>("scan_library");
      setLibrary(lib);
      const moved = lib.songs.find((s) => s.title === newKey);
      if (moved) setSelectedId(moved.id);
      void loadTags()
        .then(setTags)
        .catch(() => {});
    },
    [settings.transposeBySong, updateSettings],
  );

  // 标签（歌手 / 语种 / 年代 / 背景）：主列表用它显示；标签窗口改了会通过 onTagsChanged 传回来
  const [tags, setTags] = useState<TagStore>(() => normalizeStore(null));
  useEffect(() => {
    void loadTags()
      .then(setTags)
      .catch(() => {});
  }, []);
  const [tagIds, setTagIds] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let stop = false;
    const songs = library?.songs ?? [];
    void Promise.all(songs.map(async (s) => [s.id, s.songId || (await songId(s.title))] as const)).then((pairs) => {
      if (!stop) setTagIds(new Map(pairs));
    });
    return () => {
      stop = true;
    };
  }, [library]);
  const tagsOf = useCallback((song: Song) => tags.songs[tagIds.get(song.id) ?? ""], [tags, tagIds]);

  const selected = useMemo(() => library?.songs.find((s) => s.id === selectedId) ?? null, [library, selectedId]);

  // ---------- 搜索 ----------
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const shownSongs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!library) return [];
    if (!q) return library.songs;
    return library.songs.filter((s) => s.title.toLowerCase().includes(q) || songName(s).toLowerCase().includes(q) || (displayArtist(tagsOf(s), s.artist) ?? "").toLowerCase().includes(q));
  }, [library, query, tagsOf]);

  // ---------- 全屏大字（F） ----------
  const [big, setBig] = useState(false);
  const toggleBig = useCallback(async () => {
    const next = !big;
    setBig(next);
    try {
      await getCurrentWindow().setFullscreen(next);
    } catch {
      // 浏览器测试模式没有 Tauri 窗口
      if (next) void document.documentElement.requestFullscreen?.().catch(() => {});
      else if (document.fullscreenElement) void document.exitFullscreen();
    }
  }, [big]);

  const sources = useMemo<Source[]>(() => {
    if (!selected) return [];
    const list: Source[] = [];
    if (selected.accompaniments[0]) list.push({ kind: "accompaniment", label: "伴奏", file: selected.accompaniments[0] });
    selected.externalRecordings.forEach((file, i) =>
      list.push({
        kind: "external",
        label: /原曲/.test(file.fileName) ? "原曲" : selected.externalRecordings.length > 1 ? `外部录音 ${i + 1}` : "外部录音",
        file,
      }),
    );
    return list;
  }, [selected]);
  const source = sources[sourceIndex] ?? sources[0] ?? null;
  const hasVocal = !!selected?.vocals[0] && source?.kind === "accompaniment";

  // ---------- 录音 Take ----------
  const takesApi = useTakes(selected?.title ?? null);
  /** 回放的录音（只在伴奏音源下叠加） */
  const playTake = source?.kind === "accompaniment" && mode === "sing" ? takesApi.selected : null;
  // 修音页：要修的那遍、现在放的人声文件（修前 / 修后）
  const [tuneTakeId, setTuneTakeId] = useState<string | null>(null);
  const tuneTake = mode === "tune" ? (takesApi.takes.find((t) => t.id === tuneTakeId) ?? null) : null;
  const [tuneVoice, setTuneVoiceState] = useState<{ path: string; start: number } | null>(null);
  const setTuneVoice = useCallback(
    (v: { path: string; start: number } | null) =>
      setTuneVoiceState((old) => (old?.path === v?.path && old?.start === v?.start ? old : v)),
    [],
  );

  // ---------- 升降调（不变速）：伴奏和引导人声一起移 ----------
  const transpose = mode === "tune" ? (tuneTake?.transpose ?? 0) : selected ? (settings.transposeBySong[selected.title] ?? 0) : 0;
  // 变速不变调：播放速度 × 把音频预先移调 −12·log2(速度) 个半音抵消音调变化
  const [speed, setSpeed] = useState(1);
  useEffect(() => setSpeed(1), [selectedId]);
  const playSpeed = mode === "sing" ? speed : 1;
  const semitones = Math.round((transpose - 12 * Math.log2(playSpeed)) * 100) / 100;
  const [transposed, setTransposed] = useState<{ key: string; acc: string; vocal: string | null } | null>(null);
  const [transposeError, setTransposeError] = useState<string | null>(null);
  const accPath = source?.kind === "accompaniment" ? source.file.path : null;
  const vocalPath = selected?.vocals[0]?.path ?? null;
  const transposeKey = accPath && Math.abs(semitones) > 0.005 ? `${accPath}|${vocalPath}|${semitones}` : null;
  useEffect(() => {
    setTransposeError(null);
    if (!transposeKey || !accPath) return;
    let cancelled = false;
    Promise.all([
      invoke<string>("transpose_file", { path: accPath, semitones }),
      vocalPath ? invoke<string>("transpose_file", { path: vocalPath, semitones }).catch(() => null) : Promise.resolve(null),
    ])
      .then(([acc, vocal]) => !cancelled && setTransposed({ key: transposeKey, acc, vocal }))
      .catch((e) => !cancelled && setTransposeError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [transposeKey, accPath, vocalPath, semitones]);
  const shifted = transposeKey && transposed?.key === transposeKey ? transposed : null;
  const transposing = !!transposeKey && !shifted && !transposeError;
  const setSongTranspose = (st: number) => {
    if (!selected) return;
    const map = { ...settings.transposeBySong };
    if (st) map[selected.title] = st;
    else delete map[selected.title];
    updateSettings({ transposeBySong: map });
  };

  // ---------- 播放 ----------
  // 选中录音时 V 的含义变成「我的声音 ↔ 原唱」对比；没选录音时是引导人声开关
  const vocalGain = playTake ? (vocalOn ? 1 : 0) : vocalOn ? settings.vocalGuideVolume : 0;
  const takeGain = playTake && !vocalOn ? settings.myVoiceVolume : 0;
  const tracks = useMemo<PlayerTrack[] | null>(() => {
    if (!selected) return null;
    if (!source) return [];
    if (source.kind === "external") return [{ id: "main", path: source.file.path, gain: 1 }];
    // 升降调还在处理时先不加载，免得先放一下原调
    if (transposing) return null;
    const list: PlayerTrack[] = [{ id: "accompaniment", path: shifted?.acc ?? source.file.path, gain: settings.accompanimentVolume }];
    if (selected.vocals[0]) list.push({ id: "vocal", path: shifted?.vocal ?? selected.vocals[0].path, gain: vocalGain });
    if (mode === "tune") {
      if (tuneVoice) list.push({ id: "voice", group: "voice", path: tuneVoice.path, gain: 1, region: { start: tuneVoice.start } });
    } else if (playTake && takesApi.dir) list.push(...takeTracks(playTake, takesApi.dir, takeGain));
    return list;
    // 音量变化不重新加载（由下面的 setGain 调），这里只关心文件和位置
  }, [selected, source, playTake, takesApi.dir, mode, tuneVoice, transposing, shifted]);

  const player = usePlayer(tracks);
  const { setGain, seekTo, skip, togglePlay, ready } = player;

  // 修音页：V 在「我的声音」和「原唱」之间切换
  useEffect(() => {
    if (mode !== "tune") return;
    setGain("vocal", vocalOn ? 1 : 0);
    setGain("voice", vocalOn ? 0 : 1);
  }, [mode, vocalOn, setGain, ready]);

  // 演唱模式下的混音；打轴模式由编辑器接管
  useEffect(() => {
    if (mode !== "sing") return;
    setGain("accompaniment", settings.accompanimentVolume);
    setGain("vocal", vocalGain);
    setGain("take", takeGain);
  }, [mode, settings.accompanimentVolume, vocalGain, takeGain, setGain, ready]);

  const rec = useRecording({ player, song: selected, takes: takesApi, settings, updateSettings, transpose });
  const recBusy = rec.phase !== "idle" && rec.phase !== "prep" && rec.phase !== "opening";

  // 演唱页按选的速度播放（打轴页、修音页各自管速度）
  const { setRate: setPlayerRate } = player;
  useEffect(() => {
    if (mode === "sing" && ready) setPlayerRate(speed);
  }, [mode, speed, ready, setPlayerRate]);
  const recordStartRef = useRef(0);
  if (rec.phase === "countdown") recordStartRef.current = player.position;

  // ---------- 歌词 ----------
  const [lyricsDoc, setLyricsDoc] = useState<LrcDoc | null>(null);
  const [lyricsError, setLyricsError] = useState<string | null>(null);
  const lyricsPath = selected?.lyrics?.path ?? null;
  const lyricsSongRef = useRef<string | null>(null);
  const [pendingImport, setPendingImport] = useState<LrcDoc | null>(null);
  useEffect(() => {
    if (lyricsSongRef.current !== selectedId) {
      lyricsSongRef.current = selectedId;
      setLyricsDoc(null);
      setPendingImport(null);
      setAlignNotice(null);
    }
    setLyricsError(null);
    if (!lyricsPath) return;
    let cancelled = false;
    invoke<string>("read_lyrics", { path: lyricsPath })
      .then((text) => !cancelled && setLyricsDoc(parseLrc(text)))
      .catch((e) => !cancelled && setLyricsError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [selectedId, lyricsPath]);

  // 歌词偏移：改完 0.6 秒后写回 .lrc 的 [offset:]
  const offsetTimer = useRef<number | undefined>(undefined);
  const changeOffset = (delta: number) => {
    if (!lyricsDoc || !selected) return;
    const next = { ...lyricsDoc, offsetMs: lyricsDoc.offsetMs + delta };
    setLyricsDoc(next);
    window.clearTimeout(offsetTimer.current);
    const title = selected.title;
    const existingPath = selected.lyrics?.path ?? null;
    offsetTimer.current = window.setTimeout(() => {
      invoke("save_lyrics", { title, existingPath, content: serializeLrc(next) }).catch((e) =>
        setLyricsError(String(e)),
      );
    }, 600);
  };

  // 导入 LRC 文件：存成「歌名.lrc」放进歌曲文件夹，已有歌词时先确认替换
  const importInputRef = useRef<HTMLInputElement>(null);
  const writeLyrics = async (song: Song, doc: LrcDoc) => {
    await invoke("save_lyrics", {
      title: song.title,
      existingPath: song.lyrics?.path ?? null,
      content: serializeLrc(doc),
    });
    if (selectedIdRef.current === song.id) setLyricsDoc(doc);
    void scan();
  };

  // 智能对齐：按人声识别结果修正歌词时间，存盘，可撤销
  const [aligning, setAligning] = useState(false);
  const [alignNotice, setAlignNotice] = useState<{ text: string; undo: LrcDoc | null; error?: boolean } | null>(null);
  const alignAndSave = async (doc: LrcDoc, undoDoc: LrcDoc | null) => {
    const song = selected;
    if (!song) return;
    setPendingImport(null);
    setLyricsError(null);
    const vocal = song.vocals[0];
    if (!vocal) {
      await writeLyrics(song, doc).catch((e) => setLyricsError(String(e)));
      return;
    }
    setAligning(true);
    setAlignNotice(null);
    try {
      const { doc: aligned, result } = await alignDoc(doc, vocal.path, player.getBuffer("vocal"));
      await writeLyrics(song, aligned);
      const rest = result.sung - result.aligned;
      const notes = result.suggestions.filter((sg) => sg.kind === "missing").length;
      setAlignNotice({
        text:
          `已按人声对齐：${result.aligned}/${result.sung} 句直接对上` +
          (rest > 0 ? `，${rest} 句按前后推算` : "") +
          (notes > 0 ? `；可能漏了 ${notes} 句，去「编辑歌词」点智能对齐查看` : ""),
        undo: undoDoc,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (undoDoc === doc) await writeLyrics(song, doc).catch(() => {});
      setAlignNotice({ text: `没能自动对齐：${reason}`, undo: null, error: true });
    } finally {
      setAligning(false);
    }
  };
  const undoAlign = async () => {
    const song = selected;
    if (!song || !alignNotice?.undo) return;
    const prev = alignNotice.undo;
    setAlignNotice(null);
    await writeLyrics(song, prev).catch((e) => setLyricsError(String(e)));
  };

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLyricsError(null);
    const doc = importLrc(decodeLyricsBytes(new Uint8Array(await file.arrayBuffer())));
    if (!doc.lines.some((l) => l.text !== "")) {
      setLyricsError(`「${file.name}」里没有读到歌词`);
      return;
    }
    // 导入的 LRC 是按原版录音打的轴，先按这首的人声对齐；撤销就回到导入的原样
    if (lyricsDoc && lyricsDoc.lines.length > 0) setPendingImport(doc);
    else await alignAndSave(doc, doc);
  };

  // 直播叠加层：真实播放位置（不扣耳机延迟）
  useLiveSync({
    settings,
    title: selected?.title ?? null,
    artist: selected ? displayArtist(tagsOf(selected), selected.artist) : null,
    doc: lyricsDoc,
    playing: player.playing,
    rate: player.rate,
    position: player.position,
    getPosition: player.getPosition,
    audioRate: ready ? player.context().sampleRate : null,
  });

  // 一键开播：直播修音 + OBS
  const goLive = useGoLive({ player, song: selected, settings, updateSettings, transpose });

  /** 耳朵当前听到的歌曲时间（只有播放中声音才在耳机路上，暂停时不扣延迟） */
  const heard = player.playing ? player.position - (settings.outputLatencyMs / 1000) * player.rate : player.position;

  // ---------- 音高窗口（原唱音高 + 我唱的） ----------
  const pitchVocal = settings.showPitch && mode === "sing" && hasVocal ? selected!.vocals[0].path : null;
  const [refPitch, setRefPitch] = useState<{ path: string; ref: RefPitch | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!pitchVocal || refPitch?.path === pitchVocal) return;
    let cancelled = false;
    setRefPitch({ path: pitchVocal, ref: null, error: null });
    invoke<PitchTrack>("analyze_pitch", { path: pitchVocal })
      .then((tr) => {
        if (!cancelled) setRefPitch({ path: pitchVocal, ref: { hop: tr.hop, midi: Float64Array.from(tr.f0, (f) => (f > 0 ? hzToMidi(f) : NaN)) }, error: null });
      })
      .catch((e) => !cancelled && setRefPitch({ path: pitchVocal, ref: null, error: `原唱音高分析失败：${String(e)}` }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pitchVocal]);
  const pitchStatus = !refPitch || refPitch.path !== pitchVocal ? "正在分析原唱音高…" : refPitch.error ?? (refPitch.ref ? null : "正在分析原唱音高…（第一次要几秒）");
  const getHeard = useCallback(
    () => (player.playing ? player.getPosition() - (settings.outputLatencyMs / 1000) * player.rate : player.getPosition()),
    [player, settings.outputLatencyMs],
  );
  const liveInput = useMemo<LiveInput | null>(
    () =>
      rec.phase === "idle" || rec.phase === "opening"
        ? null
        : {
            read: rec.readInput,
            sampleRate: rec.inputSampleRate,
            songTimeNow: () => player.positionAt(player.context().currentTime - 0.018) - rec.latencyMs / 1000,
            playing: () => player.playing,
          },
    [rec.phase, rec.readInput, rec.inputSampleRate, rec.latencyMs, player],
  );

  const jumpLine = useCallback(
    (dir: 1 | -1) => {
      if (!lyricsDoc) return;
      const idx = findLineIndex(lyricsDoc, heard);
      const target = lyricsDoc.lines[Math.max(0, idx + dir)];
      const t = target ? effectiveTime(lyricsDoc, target) : null;
      if (t !== null) seekTo(Math.max(0, t));
    },
    [lyricsDoc, heard, seekTo],
  );

  const selectSong = (id: string) => {
    if (mode === "tap" || mode === "tune" || recBusy) return;
    setSelectedId(id);
    setSourceIndex(0);
  };

  const enterTap = () => {
    setSourceIndex(0);
    setMode("tap");
  };

  // ---------- 快捷键（演唱模式） ----------
  const setLoopPoint = (which: "a" | "b") => {
    const t = player.getPosition();
    const cur = player.loop;
    if (which === "a") player.setLoop({ a: t, b: cur && cur.b > t + 0.5 ? cur.b : Math.min(player.duration, t + 10) });
    else if (cur && t > cur.a + 0.5) player.setLoop({ a: cur.a, b: t });
    else player.setLoop({ a: Math.max(0, t - 10), b: t });
  };

  const onKey = (ev: KeyboardEvent) => {
    if (isTyping(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (mode === "tune") {
      if (ev.code === "Space") void togglePlay();
      else if (ev.code === "KeyV") setVocalOn((v) => !v);
      else if (ev.code === "ArrowLeft") skip(-SKIP_SECONDS);
      else if (ev.code === "ArrowRight") skip(SKIP_SECONDS);
      else return;
      ev.preventDefault();
      return;
    }
    // 录音中只响应停止
    if (recBusy) {
      if (ev.code === "Space" || ev.code === "Escape") {
        rec.stop();
        ev.preventDefault();
      }
      return;
    }
    switch (ev.code) {
      case "Space":
        void togglePlay();
        break;
      case "KeyR":
        if (source?.kind !== "accompaniment") return;
        if (rec.phase === "idle") void rec.openPrep();
        else if (rec.phase === "prep") void rec.start();
        break;
      case "BracketLeft":
        setLoopPoint("a");
        break;
      case "BracketRight":
        setLoopPoint("b");
        break;
      case "Backslash":
        player.setLoop(null);
        break;
      case "ArrowLeft":
        skip(-SKIP_SECONDS);
        break;
      case "ArrowRight":
        skip(SKIP_SECONDS);
        break;
      case "ArrowUp":
        jumpLine(-1);
        break;
      case "ArrowDown":
        jumpLine(1);
        break;
      case "KeyV":
        if (hasVocal) setVocalOn((v) => !v);
        break;
      case "KeyF":
        void toggleBig();
        break;
      case "Escape":
        if (big) void toggleBig();
        else if (rec.phase === "prep") rec.close();
        else return;
        break;
      default:
        return;
    }
    ev.preventDefault();
  };
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  // ⌘F 聚焦搜索框
  useEffect(() => {
    const onFind = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyF") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  useEffect(() => {
    if ((mode !== "sing" && mode !== "tune") || dialogOpen) return;
    const handler = (ev: KeyboardEvent) => onKeyRef.current(ev);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode, dialogOpen]);

  // ---------- 进度条拖动 ----------
  const [scrub, setScrub] = useState<number | null>(null);
  const shownPosition = scrub ?? player.position;
  const duration = player.duration;

  return (
    <div className={big ? "app big" : mode === "practice" ? "app practice-mode" : "app"}>
      <aside className="sidebar">
        <header className="sidebar-head">
          <div>
            <h1>曲库</h1>
            <p className="muted path" title={library?.root}>
              {library?.root ?? "还没选素材文件夹"}
            </p>
          </div>
          <div className="head-buttons">
            <Btn className="ghost" onClick={() => void scan()} disabled={scanning}>
              {scanning ? "扫描中…" : "重新扫描"}
            </Btn>
            <Btn
              className={goLive.phase === "live" || goLive.obs?.streaming ? "ghost live-on streaming" : settings.liveEnabled ? "ghost live-on" : "ghost"}
              onClick={() => setLiveOpen(true)}
              title={settings.liveEnabled ? "直播歌词同步中" : "直播（OBS 歌词叠加层）"}
            >
              直播
            </Btn>
            <Btn
              className={mode === "practice" ? "ghost active" : "ghost"}
              onClick={() => {
                if (mode === "tap" || mode === "tune" || recBusy) return;
                player.pause();
                rec.close();
                setMode("practice");
              }}
              title="每日练声：音阶、气息、长音、听音"
            >
              练声
            </Btn>
            <Btn className="ghost" onClick={() => setSettingsOpen(true)} title="设置">
              设置
            </Btn>
            <Btn className={videoBusy ? "ghost active" : "ghost"} onClick={() => setVideoOpen(true)} title="粘贴 YouTube 链接，下载视频到素材文件夹" disabled={!library}>
              {videoBusy ?? "下载视频"}
            </Btn>
            <Btn className={tvBusy ? "ghost active" : "ghost"} onClick={() => setTvOpen(true)} title="把歌传到电视上的「波点」，像 KTV 一样唱" disabled={!library}>
              {tvBusy ?? "电视"}
            </Btn>
            <Btn className={tagBusy ? "ghost active" : "ghost"} onClick={() => setTagsOpen(true)} title="歌手、语种、年代标签和歌单" disabled={!library}>
              {tagBusy ?? "标签"}
            </Btn>
            <Btn className="ghost" onClick={() => setCheckOpen(true)} title="资料检查：每首歌缺什么、哪些功能用不了，一键补齐" disabled={!library}>
              资料
            </Btn>
          </div>
        </header>

        {scanError && (
          <div className="notice error">
            <p>{scanError}</p>
            <Btn className="ghost" onClick={() => void scan()}>
              重试
            </Btn>
          </div>
        )}

        {library && library.songs.length === 0 && !scanError && (
          <p className="notice muted">没有找到歌曲。把「歌名 - 伴奏.wav」这样命名的文件放进文件夹后点重新扫描。</p>
        )}

        {library && library.songs.length > 3 && (
          <div className="search">
            <input
              ref={searchRef}
              type="search"
              placeholder="搜索歌名 / 原唱（⌘F）"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  e.currentTarget.blur();
                }
                if (e.key === "Enter" && shownSongs[0]) {
                  selectSong(shownSongs[0].id);
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
        )}
        {query && shownSongs.length === 0 && <p className="notice muted">没有找到「{query}」</p>}

        <ul className={mode === "tap" ? "song-list locked" : "song-list"}>
          {shownSongs.map((song) => (
            <li key={song.id}>
              <Btn
                className={song.id === selectedId ? "song active" : "song"}
                title={tagsOf(song)?.note || undefined}
                onClick={() => selectSong(song.id)}
                disabled={mode === "tap" && song.id !== selectedId}
              >
                <span className="song-title">{songName(song)}</span>
                <span className="song-artist muted">{[displayArtist(tagsOf(song), song.artist) ?? "原唱未知", langEraLine(tagsOf(song))].filter(Boolean).join(" · ")}</span>
                <SongBadges song={song} />
              </Btn>
            </li>
          ))}
        </ul>

        {library && library.unassigned.length > 0 && (
          <details className="unassigned">
            <summary>未归类（{library.unassigned.length}）</summary>
            <ul>
              {library.unassigned.map((f) => (
                <li key={f.path} className="muted" title={f.path}>
                  <span className="unassigned-name">{f.fileName}</span>
                  {/\.(mp4|mov|m4v|mkv)$/i.test(f.fileName) && (
                    <Btn className="link unassigned-action" onClick={() => openSeparate(f, null)} title="用 Demucs 分离出伴奏和人声，配成一首歌">
                      做成伴奏
                    </Btn>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </aside>

      <main className="stage">
        {mode === "practice" ? (
          <PracticePage settings={settings} onExit={() => setMode("sing")} />
        ) : needLibrary ? (
          <div className="empty welcome">
            <h2>欢迎使用波点</h2>
            <p className="muted">先选一个放伴奏和歌词的文件夹。文件按这样命名就会自动配成一首歌：</p>
            <ul className="muted small">
              <li>歌名 - 伴奏.wav（或 mp3 / m4a / flac）</li>
              <li>歌名 - 人声.wav（可选，引导人声 / 修音参考）</li>
              <li>歌名.lrc（可选，没有的话可以在应用里打轴）</li>
            </ul>
            <Btn className="primary" onClick={() => void chooseLibrary()}>
              选择文件夹…
            </Btn>
            <p className="muted small">录音、修音和导出也会存在这个文件夹里（「录音」子文件夹）。之后可以在设置里换。</p>
          </div>
        ) : !selected ? (
          <div className="empty">
            <p className="muted">从左边选一首歌</p>
          </div>
        ) : mode === "tune" && tuneTake && takesApi.dir ? (
          <TunePage
            key={tuneTake.id}
            song={selected}
            take={tuneTake}
            dir={takesApi.dir}
            lyricsDoc={lyricsDoc}
            player={player}
            compare={vocalOn}
            onToggleCompare={() => setVocalOn((v) => !v)}
            onVoice={setTuneVoice}
            onExit={() => {
              player.pause();
              setVocalOn(false);
              setMode("sing");
            }}
          />
        ) : mode === "tap" ? (
          <TapEditor
            key={selected.id}
            song={selected}
            doc={lyricsDoc}
            player={player}
            settings={settings}
            keysDisabled={dialogOpen}
            onOpenSettings={() => setSettingsOpen(true)}
            onSaved={(doc) => {
              setLyricsDoc(doc);
              void scan();
            }}
            onExit={() => setMode("sing")}
          />
        ) : (
          <section className="lyrics-area">
            <div className="song-head">
              <div className="song-head-text">
                <h2 title={selected.title}>{songName(selected)}</h2>
                {displayArtist(tagsOf(selected), selected.artist) && <p className="muted" title={tagsOf(selected)?.note || undefined}>原唱：{displayArtist(tagsOf(selected), selected.artist)}</p>}
                {selected.originals[0] && (
                  <p className="muted small originals">
                    原曲视频：
                    <Btn className="link" onClick={() => void invoke("open_file", { path: selected.originals[0].path })}>
                      打开
                    </Btn>
                    <Btn className="link" onClick={() => void invoke("reveal_file", { path: selected.originals[0].path })}>
                      在访达中显示
                    </Btn>
                    {(selected.vocals.length === 0 || selected.accompaniments.length === 0) && (
                      <Btn className="link" onClick={() => openSeparate(selected.originals[0], selected.title)} title="用 Demucs 从视频里分离出缺的伴奏 / 人声">
                        做成伴奏
                      </Btn>
                    )}
                    {!selected.externalRecordings.some((f) => /原曲/.test(f.fileName)) && (
                      <Btn
                        className="link"
                        onClick={() =>
                          void invoke("extract_audio", { video: selected.originals[0].path, title: selected.title })
                            .then(() => scan())
                            .catch((e) => setLyricsError(String(e)))
                        }
                        title="抽出视频里的音频，之后可以在下面切到「原曲」试听"
                      >
                        抽出音频
                      </Btn>
                    )}
                  </p>
                )}
              </div>
              <div className="head-actions">
                <Btn className="ghost" onClick={() => setInfoSong(selected)} title="歌曲资料：歌名、读音、歌手……；改文件名">
                  资料
                </Btn>
                <Btn className="ghost" onClick={() => setLearnOpen(true)} title="外语学唱：问老师，老师说错了纠正它">
                  学唱
                </Btn>
                <Btn className="ghost" onClick={() => void toggleBig()} title="全屏大字（F）">
                  {big ? "退出全屏" : "全屏"}
                </Btn>
                <Btn
                  className={settings.showPitch && hasVocal ? "ghost active" : "ghost"}
                  onClick={() => updateSettings({ showPitch: !settings.showPitch })}
                  disabled={!hasVocal}
                  title={hasVocal ? "音高窗口：原唱音高跟着播放滚动，打开录音栏时显示自己唱的" : "需要「歌名 - 人声.wav」原唱人声文件"}
                >
                  音高
                </Btn>
                {lyricsDoc && hasTimedLines(lyricsDoc) && (
                  <div className="offset" title="歌词整体偏移，保存在歌词文件里">
                    <span className="muted small">歌词</span>
                    <Btn className="ghost tiny" onClick={() => changeOffset(-OFFSET_STEP_MS)} title="推后 50ms">
                      −
                    </Btn>
                    <span className="small offset-value">{formatOffset(lyricsDoc.offsetMs)}</span>
                    <Btn className="ghost tiny" onClick={() => changeOffset(OFFSET_STEP_MS)} title="提前 50ms">
                      +
                    </Btn>
                  </div>
                )}
                <Btn className="ghost" onClick={() => importInputRef.current?.click()} disabled={aligning}>
                  导入 LRC
                </Btn>
                {lyricsDoc && hasTimedLines(lyricsDoc) && selected.vocals.length > 0 && (
                  <Btn
                    className="ghost"
                    disabled={aligning}
                    title="按原唱人声自动修正每句歌词的时间"
                    onClick={() => void alignAndSave(lyricsDoc, lyricsDoc)}
                  >
                    {aligning ? "对齐中…" : "智能对齐"}
                  </Btn>
                )}
                <Btn className="ghost" onClick={enterTap} disabled={!selected.accompaniments[0]}>
                  {lyricsDoc ? "编辑歌词" : "打轴"}
                </Btn>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".lrc,.txt"
                  hidden
                  onChange={(e) => void onImportFile(e)}
                />
              </div>
            </div>

            {aligning && <div className="import-confirm muted">正在按人声对齐歌词，第一次要几秒钟…</div>}
            {alignNotice && !aligning && (
              <div className={alignNotice.error ? "import-confirm error-text" : "import-confirm"}>
                <span>{alignNotice.text}</span>
                {alignNotice.undo && (
                  <Btn className="ghost" onClick={() => void undoAlign()}>
                    撤销对齐
                  </Btn>
                )}
                <Btn className="ghost" onClick={() => setAlignNotice(null)}>
                  知道了
                </Btn>
              </div>
            )}
            {pendingImport && (
              <div className="import-confirm">
                <span>
                  导入的歌词有 {pendingImport.lines.filter((l) => l.text !== "").length} 句，替换掉现在的歌词？
                </span>
                <Btn className="ghost" onClick={() => setPendingImport(null)}>
                  取消
                </Btn>
                <Btn className="primary" onClick={() => void alignAndSave(pendingImport, pendingImport)}>
                  替换
                </Btn>
              </div>
            )}

            <div className="lyrics-body">
              {lyricsDoc && hasTimedLines(lyricsDoc) ? (
                <LyricsView doc={lyricsDoc} time={heard} playing={player.playing} onSeek={seekTo} large />
              ) : (
                <div className="empty-lyrics">
                  <p className="muted">{lyricsDoc ? "歌词还没打轴" : "还没有歌词"}</p>
                  <Btn className="primary" onClick={enterTap} disabled={!selected.accompaniments[0]}>
                    {lyricsDoc ? "继续打轴" : "粘贴歌词，开始打轴"}
                  </Btn>
                </div>
              )}
              {source?.kind === "accompaniment" && (takesApi.takes.length > 0 || rec.phase !== "idle") && (
                <TakesPanel
                  title={selected.title}
                  takes={takesApi}
                  compare={vocalOn}
                  onToggleCompare={() => setVocalOn((v) => !v)}
                  canCompare={hasVocal}
                  voiceVolume={settings.myVoiceVolume}
                  onVoiceVolume={(v) => updateSettings({ myVoiceVolume: v })}
                  onSeek={seekTo}
                  disabled={recBusy}
                  onComp={() => setCompOpen(true)}
                  onOpenTune={(t) => {
                    rec.close();
                    player.pause();
                    setVocalOn(false);
                    setTuneTakeId(t.id);
                    setMode("tune");
                  }}
                />
              )}
            </div>
            {pitchVocal && (
              <SingPitch
                refPitch={refPitch?.path === pitchVocal ? refPitch.ref : null}
                transpose={transpose}
                status={pitchStatus}
                getHeard={getHeard}
                live={liveInput}
                big={big}
              />
            )}
            {lyricsError && <p className="error-text small center">{lyricsError}</p>}
          </section>
        )}

        {selected && mode === "sing" && rec.phase !== "idle" && (
          <RecordBar
            rec={rec}
            position={player.position}
            recordStart={recordStartRef.current}
            canPunch={!!takesApi.selected && !!player.loop}
            loopLabel={player.loop ? `${formatTime(player.loop.a)}–${formatTime(player.loop.b)}` : null}
          />
        )}

        {selected && mode !== "practice" && (
          <footer className="controls">
            {mode === "sing" && sources.length > 1 && (
              <div className="segmented" role="tablist" aria-label="播放音源">
                {sources.map((s, i) => (
                  <Btn
                    key={s.file.path}
                    role="tab"
                    aria-selected={s === source}
                    className={s === source ? "seg active" : "seg"}
                    onClick={() => setSourceIndex(i)}
                    title={s.file.fileName}
                  >
                    {s.label}
                  </Btn>
                ))}
              </div>
            )}

            <div className="transport">
              <Btn className="icon" onClick={() => skip(-SKIP_SECONDS)} disabled={!ready} title="后退 5 秒（←）">
                −5
              </Btn>
              <Btn
                className="icon play"
                onClick={() => void togglePlay()}
                disabled={!ready}
                title="播放 / 暂停（空格）"
                aria-label={player.playing ? "暂停" : "播放"}
              >
                <PlayIcon playing={player.playing} />
              </Btn>
              <Btn className="icon" onClick={() => skip(SKIP_SECONDS)} disabled={!ready} title="前进 5 秒（→）">
                +5
              </Btn>
              {mode === "sing" && source?.kind === "accompaniment" && (
                <Btn
                  className={rec.phase !== "idle" ? "rec-btn on" : "rec-btn"}
                  onClick={() => (rec.phase === "idle" ? void rec.openPrep() : recBusy ? rec.stop() : rec.close())}
                  disabled={!ready || speed !== 1}
                  title={speed !== 1 ? "变速播放时不能录音，先调回 1x" : "录音（R）"}
                >
                  ● 录音
                </Btn>
              )}
            </div>

            <div className="timeline">
              <span className="time">{formatTime(shownPosition)}</span>
              <div className="track-wrap">
                {player.loop && duration > 0 && (
                  <div
                    className="loop-region"
                    style={{ left: `${(player.loop.a / duration) * 100}%`, width: `${((player.loop.b - player.loop.a) / duration) * 100}%` }}
                    title={`A-B 循环 ${formatTime(player.loop.a)}–${formatTime(player.loop.b)}`}
                  />
                )}
                <input
                  type="range"
                  min={0}
                  max={duration || 1}
                  step={0.1}
                  value={Math.min(shownPosition, duration || 1)}
                  disabled={!ready || recBusy}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setScrub(Number(e.target.value))}
                  onPointerUp={(e: ReactPointerEvent<HTMLInputElement>) => {
                    seekTo(Number(e.currentTarget.value));
                    setScrub(null);
                  }}
                  aria-label="播放进度"
                />
              </div>
              <span className="time">{formatTime(duration)}</span>
              {mode === "sing" && (
                <div className="ab" aria-label="A-B 循环">
                  <Btn className="ghost tiny" onClick={() => setLoopPoint("a")} disabled={!ready || recBusy} title="把当前位置设为 A（[）">
                    A
                  </Btn>
                  <Btn className="ghost tiny" onClick={() => setLoopPoint("b")} disabled={!ready || recBusy} title="把当前位置设为 B（]）">
                    B
                  </Btn>
                  {player.loop && (
                    <Btn className="ghost tiny" onClick={() => player.setLoop(null)} disabled={recBusy} title="取消循环（\）">
                      ×
                    </Btn>
                  )}
                </div>
              )}
            </div>

            {mode === "sing" && source?.kind === "accompaniment" && (
              <div className="mixer">
                <label className="mix">
                  <span className="muted small">伴奏</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={settings.accompanimentVolume}
                    onChange={(e) => updateSettings({ accompanimentVolume: Number(e.target.value) })}
                    aria-label="伴奏音量"
                  />
                </label>
                <div className="mix transpose" title="升降调（不变速），伴奏和引导人声一起移">
                  <span className="muted small">升降调</span>
                  <Btn className="ghost tiny" onClick={() => setSongTranspose(Math.max(-6, transpose - 1))} disabled={transpose <= -6 || recBusy}>
                    −
                  </Btn>
                  <span className="small offset-value">{transpose > 0 ? `+${transpose}` : transpose}</span>
                  <Btn className="ghost tiny" onClick={() => setSongTranspose(Math.min(6, transpose + 1))} disabled={transpose >= 6 || recBusy}>
                    +
                  </Btn>
                </div>
                <label className="mix" title="变速不变调：练快歌时放慢，音调不变">
                  <span className="muted small">速度</span>
                  <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} disabled={recBusy || rec.phase !== "idle"}>
                    {[0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5].map((v) => (
                      <option key={v} value={v}>
                        {v}x
                      </option>
                    ))}
                  </select>
                </label>
                {playTake ? (
                  <span className="muted small">回放「{playTake.name}」· V 切换听原唱对比</span>
                ) : (
                <div className="mix">
                  <Btn
                    className={vocalOn ? "toggle on" : "toggle"}
                    onClick={() => setVocalOn((v) => !v)}
                    disabled={!hasVocal}
                    title={hasVocal ? "引导人声开 / 关（V）" : "这首歌没有人声文件"}
                  >
                    引导人声 {vocalOn ? "开" : "关"}
                  </Btn>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={settings.vocalGuideVolume}
                    disabled={!hasVocal}
                    onChange={(e) => {
                      updateSettings({ vocalGuideVolume: Number(e.target.value) });
                      setVocalOn(true);
                    }}
                    aria-label="引导人声音量"
                  />
                </div>
                )}
              </div>
            )}

            <p className="status muted">
              {transposing && "正在处理升降调 / 变速（第一次要几秒）…"}
              {transposeError && <span className="error-text">{transposeError}</span>}
              {player.load.kind === "loading" && "正在加载…"}
              {player.load.kind === "error" && <span className="error-text">{player.load.message}</span>}
              {player.load.kind === "ready" &&
                source &&
                `${source.label}${transpose ? `（${transpose > 0 ? "升" : "降"} ${Math.abs(transpose)} 个半音）` : ""}${playSpeed !== 1 ? `（${playSpeed}x）` : ""}：${source.file.fileName}${playTake ? ` + 录音「${playTake.name}」` : ""}`}
              {player.load.kind === "ready" && mode === "sing" && settings.outputLatencyMs === 0 && lyricsDoc && (
                <>
                  {" · "}
                  <Btn className="link" onClick={() => setSettingsOpen(true)}>
                    戴 AirPods？校准耳机延迟让歌词更准
                  </Btn>
                </>
              )}
            </p>
          </footer>
        )}
      </main>

      {compOpen && <CompDialog takes={takesApi} lyricsDoc={lyricsDoc} onSeek={seekTo} onClose={() => setCompOpen(false)} />}
      {liveOpen && <LivePanel settings={settings} onChange={updateSettings} onClose={() => setLiveOpen(false)} live={goLive} />}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
          libraryRoot={library?.root ?? null}
          onChooseLibrary={() => void chooseLibrary()}
          onUpdateFound={(u) => {
            setSettingsOpen(false);
            setUpdate(u);
          }}
        />
      )}
      <VideoDialog open={videoOpen} onClose={() => setVideoOpen(false)} libraryRoot={library?.root ?? null} onDownloaded={onVideoDownloaded} onBusy={setVideoBusy} target={videoTarget} onSeparated={onSeparated} onOpenSong={openSongByName} />
      {learnOpen && selected && (
        <LearnDialog
          title={selected.title}
          shownTitle={songName(selected)}
          annotations={selected.originals.map((f) => f.fileName.replace(/\.[^.]+$/, ""))}
          onClose={() => setLearnOpen(false)}
        />
      )}
      <TvDialog open={tvOpen} onClose={() => setTvOpen(false)} songs={library?.songs ?? []} onBusy={setTvBusy} />
      <TagsDialog open={tagsOpen} onClose={() => setTagsOpen(false)} songs={library?.songs ?? []} onBusy={setTagBusy} onOpenSettings={() => setSettingsOpen(true)} onTagsChanged={setTags} onLibraryChanged={() => void invoke<Library>("scan_library").then(setLibrary)} />
      <CheckDialog
        open={checkOpen}
        songs={library?.songs ?? []}
        onClose={() => setCheckOpen(false)}
        onEdit={setInfoSong}
        onGoTo={(song, m) => {
          setCheckOpen(false);
          setSelectedId(song.id);
          setSourceIndex(0);
          setMode(m);
        }}
        onSeparate={(f, key) => openSeparate(f, key)}
        onOpenVideo={() => setVideoOpen(true)}
        onChanged={() => void scan().then(() => loadTags().then(setTags).catch(() => {}))}
      />
      <SongInfoDialog song={infoSong} onClose={() => setInfoSong(null)} onSaved={() => void scan().then(() => loadTags().then(setTags).catch(() => {}))} onRenamed={onSongRenamed} />
      {update && <UpdateCard key={update.version} update={update} onClose={() => setUpdate(null)} />}
    </div>
  );
}
