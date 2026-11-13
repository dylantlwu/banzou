import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { guessSongName } from "../video/guessName";
import { Btn } from "./Btn";

interface ToolStatus {
  ytdlp: string | null;
  ffmpeg: string | null;
  dir: string;
}
interface Quality {
  id: "compat" | "best";
  height: number;
  codec: string;
  size: number | null;
}
interface VideoInfo {
  title: string;
  uploader: string | null;
  duration: number | null;
  url: string;
  qualities: Quality[];
}
interface Job {
  kind: string;
  text: string;
  percent: number | null;
}
interface Downloaded {
  path: string;
  fileName: string;
  size: number;
  already: boolean;
  width: number | null;
  height: number | null;
  duration: number | null;
  codec: string | null;
}

interface SepStatus {
  demucs: string | null;
  hasPython: boolean;
}
interface Separated {
  name: string;
  written: string[];
  kept: string[];
  seconds: number;
}
/** 要做成伴奏的文件（素材文件夹里的视频 / 音频） */
export interface SepTarget {
  path: string;
  fileName: string;
  /** 已经挂到的歌名（用作默认文件名） */
  song: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 素材文件夹（下载到这里） */
  libraryRoot: string | null;
  /** 下载好以后重新扫描曲库；返回这个视频挂到的歌名 */
  /** meta：视频的 YouTube 标题和频道名，用来给这首歌自动打标签 */
  onDownloaded: (path: string, meta?: { title: string; uploader: string | null }) => Promise<string | null>;
  /** 后台任务的进度，给顶部按钮显示（关掉窗口也能看到） */
  onBusy: (text: string | null) => void;
  /** 从曲库里点「做成伴奏」打开时带进来的文件；key 变了就重新开始 */
  target: (SepTarget & { key: number }) | null;
  /** 做好伴奏后重新扫描曲库 */
  /** source：做成伴奏的视频文件名，给自动打标签当线索 */
  onSeparated: (name: string, source?: string) => Promise<void>;
  /** 跳到这首歌 */
  onOpenSong: (name: string) => void;
}

type Busy = "install" | "probe" | "download" | "update" | "install-sep" | "separate" | null;
const LONG: Busy[] = ["install", "download", "update", "install-sep", "separate"];

export function fmtSize(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function qualityLabel(q: Quality): string {
  return q.id === "compat" ? `兼容版 ${q.height}p（${q.codec}，QuickTime 能直接放）` : `最高画质 ${q.height}p（${q.codec}，要用 VLC / IINA 播放）`;
}

/** 下载 YouTube 视频（PRD 4.10）：粘贴链接 → 看标题和画质 → 下载到素材文件夹 */
export function VideoDialog({ open, onClose, libraryRoot, onDownloaded, onBusy, target, onSeparated, onOpenSong }: Props) {
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [url, setUrl] = useState("");
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [quality, setQuality] = useState<"compat" | "best">("compat");
  const [busy, setBusy] = useState<Busy>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<(Downloaded & { song: string | null }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 做成伴奏
  const [sep, setSep] = useState<(SepTarget & { name: string }) | null>(null);
  const [sepStatus, setSepStatus] = useState<SepStatus | null>(null);
  const [sepResult, setSepResult] = useState<Separated | null>(null);

  const ready = !!tools?.ytdlp && !!tools?.ffmpeg;

  const loadTools = useCallback(async () => {
    try {
      setTools(await invoke<ToolStatus>("video_tools"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    // 每次打开都重新看一下工具（可能刚装好 / 刚更新）
    if (open && busy === null) void loadTools();
    if (open) window.setTimeout(() => inputRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开时检查
  }, [open, loadTools]);

  // 长任务进行中：轮询后端写的进度
  useEffect(() => {
    if (!LONG.includes(busy)) {
      onBusy(null);
      return;
    }
    const timer = window.setInterval(() => {
      void invoke<Job | null>("video_job").then((j) => {
        if (!j) return;
        setJob(j);
        const pct = j.percent != null ? ` ${Math.round(j.percent)}%` : "";
        onBusy(busy === "download" ? `下载中${pct}` : busy === "separate" ? `做伴奏${pct}` : `${j.text}${pct}`);
      });
    }, 400);
    return () => window.clearInterval(timer);
  }, [busy, onBusy]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const startSep = useCallback(async (t: SepTarget) => {
    setError(null);
    setSepResult(null);
    const guess = t.song ?? (await invoke<string>("to_simplified", { text: guessSongName(t.fileName) }).catch(() => guessSongName(t.fileName)));
    setSep({ ...t, name: guess });
    setSepStatus(await invoke<SepStatus>("sep_status").catch(() => null));
  }, []);

  // 从曲库点「做成伴奏」进来
  useEffect(() => {
    if (target && busy !== "separate") void startSep(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换了文件时开始
  }, [target?.key]);

  const installSep = async () => {
    setError(null);
    setBusy("install-sep");
    setJob(null);
    try {
      setSepStatus(await invoke<SepStatus>("sep_install"));
    } catch (e) {
      setError(String(e) === "已取消" ? null : String(e));
    } finally {
      setBusy(null);
    }
  };

  const runSep = async () => {
    if (!sep?.name.trim()) return;
    setError(null);
    setBusy("separate");
    setJob(null);
    try {
      const r = await invoke<Separated>("sep_run", { path: sep.path, name: sep.name.trim() });
      setSepResult(r);
      await onSeparated(r.name, sep.fileName).catch(() => undefined);
    } catch (e) {
      const msg = String(e);
      if (msg === "TOOLS_MISSING") void loadTools();
      else if (msg === "SEP_MISSING") setSepStatus(await invoke<SepStatus>("sep_status").catch(() => null));
      else if (msg !== "已取消") setError(msg);
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    setError(null);
    setBusy("install");
    setJob(null);
    try {
      setTools(await invoke<ToolStatus>("video_install_tools"));
    } catch (e) {
      setError(String(e) === "已取消" ? null : `工具没装好：${String(e)}`);
      void loadTools();
    } finally {
      setBusy(null);
    }
  };

  const probe = async (text = url) => {
    if (!text.trim()) return;
    setError(null);
    setNote(null);
    setInfo(null);
    setResult(null);
    setBusy("probe");
    try {
      const v = await invoke<VideoInfo>("video_probe", { url: text.trim() });
      setInfo(v);
      setQuality("compat");
    } catch (e) {
      if (String(e) === "TOOLS_MISSING") void loadTools();
      else setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    if (!info) return;
    setError(null);
    setBusy("download");
    setJob(null);
    try {
      const d = await invoke<Downloaded>("video_download", { url: info.url, quality });
      const song = await onDownloaded(d.path, { title: info.title, uploader: info.uploader }).catch(() => null);
      setResult({ ...d, song });
      setInfo(null);
      setUrl("");
    } catch (e) {
      setError(String(e) === "已取消" ? null : String(e));
    } finally {
      setBusy(null);
    }
  };

  const updateYtdlp = async () => {
    setError(null);
    setNote(null);
    setBusy("update");
    try {
      const v = await invoke<string>("video_update_ytdlp");
      setNote(v === tools?.ytdlp ? `yt-dlp 已经是最新版（${v}）` : `yt-dlp 已更新到 ${v}`);
      void loadTools();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const cancel = () => void invoke("video_cancel");

  const pct = job?.percent != null ? Math.round(job.percent) : null;
  const working = LONG.includes(busy);
  const baseName = (p: string) => p.split("/").pop() ?? p;

  return (
    <div className="overlay" hidden={!open} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog video-dialog" role="dialog" aria-label="下载视频">
        <h2>下载视频</h2>

        {!tools && !error && <p className="muted">正在检查…</p>}

        {tools && !ready && (
          <div className="field">
            <p>第一次用要先装两个小工具（共约 80 MB），从官方地址下载，核对过校验值再装，放在应用自己的文件夹里：</p>
            <ul className="small video-tools-list">
              <li>
                <strong>yt-dlp</strong>：从 YouTube 下载{tools.ytdlp ? `（已装 ${tools.ytdlp}）` : "（GitHub）"}
              </li>
              <li>
                <strong>ffmpeg</strong>：把画面和声音合成一个文件{tools.ffmpeg ? `（已装 ${tools.ffmpeg}）` : "（PyPI imageio-ffmpeg）"}
              </li>
            </ul>
            {busy === "install" ? (
              <Progress text={job?.text ?? "准备下载工具"} pct={pct} onCancel={cancel} />
            ) : (
              <div className="dialog-actions">
                <Btn className="primary" onClick={() => void install()}>
                  下载工具
                </Btn>
              </div>
            )}
          </div>
        )}

        {ready && (
          <>
            <div className="field">
              <label htmlFor="video-url">YouTube 链接</label>
              <div className="field-row">
                <input
                  id="video-url"
                  ref={inputRef}
                  className="video-url"
                  placeholder="粘贴视频地址，比如 https://www.youtube.com/watch?v=…"
                  value={url}
                  disabled={working}
                  onChange={(e) => setUrl(e.target.value)}
                  onPaste={(e) => {
                    const text = e.clipboardData.getData("text");
                    if (/https?:\/\//.test(text)) {
                      e.preventDefault();
                      setUrl(text.trim());
                      void probe(text);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void probe();
                  }}
                />
                <Btn className="ghost" onClick={() => void probe()} disabled={!url.trim() || busy !== null}>
                  查看
                </Btn>
              </div>
              <p className="muted small">链接里带的播放列表会被忽略，只下这一个视频。</p>
            </div>

            {busy === "probe" && <p className="muted">正在读取视频信息…</p>}

            {info && (
              <div className="video-info">
                <strong className="video-title">{info.title}</strong>
                <span className="muted small">{[info.uploader, fmtDuration(info.duration)].filter(Boolean).join(" · ")}</span>
                <div className="video-qualities">
                  {info.qualities.map((q) => (
                    <label key={q.id} className="video-quality">
                      <input type="radio" name="quality" checked={quality === q.id} disabled={working} onChange={() => setQuality(q.id)} />
                      <span>
                        {qualityLabel(q)}
                        {q.size ? <span className="muted"> · 约 {fmtSize(q.size)}</span> : null}
                      </span>
                    </label>
                  ))}
                </div>
                {busy === "download" ? (
                  <Progress text={job?.text ?? "连接 YouTube"} pct={pct} onCancel={cancel} />
                ) : (
                  <div className="dialog-actions">
                    <span className="muted small video-dest" title={libraryRoot ?? ""}>
                      存到 {libraryRoot ?? "素材文件夹"}
                    </span>
                    <Btn className="primary" onClick={() => void download()} disabled={busy !== null}>
                      下载
                    </Btn>
                  </div>
                )}
              </div>
            )}

            {result && (
              <div className="video-result">
                <strong>{result.already ? "这个视频之前下载过了" : "下载好了"}</strong>
                <span className="video-title" title={result.path}>
                  {result.fileName}
                </span>
                <span className="muted small">
                  {[
                    result.width && result.height ? `${result.width}×${result.height}` : null,
                    result.codec,
                    fmtDuration(result.duration),
                    fmtSize(result.size),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="muted small">{result.song ? `已经挂到「${result.song}」作为原曲视频` : "在曲库的「未归类」里；文件名和歌名对上后会自动挂到那首歌"}</span>
                <div className="dialog-actions">
                  {sep?.path !== result.path && (
                    <Btn className="ghost" onClick={() => void startSep({ path: result.path, fileName: result.fileName, song: result.song })} disabled={busy !== null} title="用 Demucs 把人声去掉，生成伴奏和人声两个文件">
                      做成伴奏
                    </Btn>
                  )}
                  <Btn className="ghost" onClick={() => void invoke("reveal_file", { path: result.path })}>
                    在访达中显示
                  </Btn>
                  <Btn className="primary" onClick={() => void invoke("open_file", { path: result.path })}>
                    播放
                  </Btn>
                </div>
              </div>
            )}
          </>
        )}

        {ready && sep && (
          <div className="video-result sep-card">
            <strong>做成伴奏</strong>
            <span className="muted small video-title">{sep.fileName}</span>
            {!sepStatus ? (
              <span className="muted small">正在检查…</span>
            ) : !sepStatus.demucs ? (
              <>
                <p className="small">
                  要先装分离人声的工具 Demucs（开源，Meta 出品）：在应用自己的文件夹里建一个 Python 环境，下载 Demucs 和 PyTorch，共约 1 GB，要几分钟。第一次分离时还会下载模型（约 300 MB）。
                </p>
                {!sepStatus.hasPython && <p className="small error-text">这台 Mac 还没有 Python：先在「终端」里运行 xcode-select --install，装好后再点安装。</p>}
                {busy === "install-sep" ? (
                  <Progress text={job?.text ?? "准备 Python 环境"} pct={pct} onCancel={cancel} />
                ) : (
                  <div className="dialog-actions">
                    <Btn className="ghost" onClick={() => setSep(null)}>
                      不做了
                    </Btn>
                    <Btn className="primary" onClick={() => void installSep()} disabled={busy !== null || !sepStatus.hasPython}>
                      安装 Demucs
                    </Btn>
                  </div>
                )}
              </>
            ) : sepResult ? (
              <>
                <span className="small">
                  做好了，用了 {fmtDuration(sepResult.seconds)}：{sepResult.written.map(baseName).join("、")}
                </span>
                {sepResult.kept.length > 0 && <span className="muted small">已经有的没覆盖：{sepResult.kept.map(baseName).join("、")}</span>}
                <span className="muted small">分离出来的伴奏只适合自己练唱，不要上传或公开发布。</span>
                <div className="dialog-actions">
                  <Btn className="ghost" onClick={() => void invoke("reveal_file", { path: sepResult.written[0] ?? sepResult.kept[0] })}>
                    在访达中显示
                  </Btn>
                  <Btn className="primary" onClick={() => onOpenSong(sepResult.name)}>
                    去这首歌
                  </Btn>
                </div>
              </>
            ) : (
              <>
                <div className="field-row">
                  <label htmlFor="sep-name" className="small">
                    歌名
                  </label>
                  <input
                    id="sep-name"
                    className="video-url"
                    value={sep.name}
                    disabled={busy !== null}
                    onChange={(e) => setSep({ ...sep, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void runSep();
                    }}
                  />
                </div>
                <span className="muted small">
                  会生成「{sep.name.trim() || "歌名"} - 伴奏.wav」和「{sep.name.trim() || "歌名"} - 人声.wav」，已经有的不覆盖。习惯写「歌名 歌手」，视频会自动挂到这首歌上。
                </span>
                <span className="muted small">用 Demucs 分离人声，4 分钟的歌大约 1–3 分钟。</span>
                {busy === "separate" ? (
                  <Progress text={job?.text ?? "抽出音频"} pct={pct} onCancel={cancel} />
                ) : (
                  <div className="dialog-actions">
                    <Btn className="ghost" onClick={() => setSep(null)}>
                      不做了
                    </Btn>
                    <Btn className="primary" onClick={() => void runSep()} disabled={busy !== null || !sep.name.trim()}>
                      开始
                    </Btn>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {error && <p className="small error-text">{error}</p>}
        {busy === "update" && <Progress text={job?.text ?? "更新 yt-dlp"} pct={pct} onCancel={cancel} />}
        {note && <p className="muted small">{note}</p>}

        <div className="video-foot">
          {ready ? (
            <span className="muted small">
              yt-dlp {tools?.ytdlp} · ffmpeg {tools?.ffmpeg}
              {sepStatus?.demucs ? ` · Demucs ${sepStatus.demucs}` : ""}
              <Btn className="link" onClick={() => void updateYtdlp()} disabled={busy !== null}>
                更新 yt-dlp
              </Btn>
            </span>
          ) : (
            <span />
          )}
          <Btn className="ghost" onClick={onClose}>
            {working ? "放到后台" : "关闭"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

function Progress({ text, pct, onCancel }: { text: string; pct: number | null; onCancel: () => void }) {
  return (
    <div className="video-progress">
      <div className="field-row">
        <span className="small">
          {text}
          {pct != null ? ` ${pct}%` : "…"}
        </span>
        <Btn className="ghost" onClick={onCancel}>
          取消
        </Btn>
      </div>
      <progress max={100} value={pct ?? undefined} />
    </div>
  );
}
