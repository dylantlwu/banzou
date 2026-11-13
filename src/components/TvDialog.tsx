import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Song } from "../types";
import { songName } from "../songs/meta";
import { Btn } from "./Btn";
import { fmtSize } from "./VideoDialog";

interface TvStatus {
  adb: boolean;
  ffmpeg: boolean;
  connected: boolean;
  error: string | null;
  model: string | null;
  freeBytes: number | null;
  appVersion: number | null;
  bundledVersion: number;
  songs: string[];
}
interface MvChoice {
  path: string | null;
  note: string | null;
  size: number;
}
interface Job {
  text: string;
  percent: number | null;
}
interface Pushed {
  title: string;
  freeBytes: number | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  songs: Song[];
  /** 后台任务的进度，给顶部按钮显示（关掉窗口也能看到） */
  onBusy: (text: string | null) => void;
}

type Busy = "status" | "find" | "install" | "app" | "push" | "remove" | "catalog" | null;
const LONG: Busy[] = ["install", "app", "push", "catalog"];

const baseName = (p: string) => p.split("/").pop() ?? p;

/** 电视 KTV：把歌传到电视上的「波点」，或者从电视上删掉 */
export function TvDialog({ open, onClose, songs, onBusy }: Props) {
  const [addr, setAddr] = useState("");
  const [status, setStatus] = useState<TvStatus | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [busySong, setBusySong] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [found, setFound] = useState<string[] | null>(null);
  const [mvs, setMvs] = useState<Record<string, MvChoice>>({});
  /** 这次打开窗口后同步过歌单没有（连上后自动同步一次） */
  const [synced, setSynced] = useState<string | null>(null);

  const playable = useMemo(() => songs.filter((s) => s.accompaniments.length > 0), [songs]);

  const refresh = useCallback(async (a: string) => {
    setBusy("status");
    setError(null);
    try {
      const st = await invoke<TvStatus>("tv_status", { addr: a });
      setStatus(st);
      if (st.connected) void invoke("save_store", { name: "tv", value: { address: a } });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  // 打开时读记住的电视地址并连接
  useEffect(() => {
    if (!open || busy !== null) return;
    void (async () => {
      const saved = await invoke<{ address?: string }>("load_store", { name: "tv" }).catch(() => ({}) as { address?: string });
      const a = saved.address ?? addr;
      setAddr(a);
      if (a) await refresh(a);
      else setStatus(await invoke<TvStatus>("tv_status", { addr: "" }).catch(() => null));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开时
  }, [open]);

  // 每首歌挑 MV（读文件信息要一点时间，打开窗口后在后台做）
  useEffect(() => {
    if (!open) return;
    let stop = false;
    void (async () => {
      for (const s of playable) {
        if (stop) return;
        if (mvs[s.id]) continue;
        const choice = await invoke<MvChoice>("tv_choose_mv", {
          accompaniment: s.accompaniments[0].path,
          videos: s.originals.map((o) => o.path),
        }).catch(() => null);
        if (choice && !stop) setMvs((m) => ({ ...m, [s.id]: choice }));
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 歌单变了再挑
  }, [open, playable]);

  // 长任务：轮询进度
  useEffect(() => {
    if (!LONG.includes(busy)) {
      onBusy(null);
      return;
    }
    const timer = window.setInterval(() => {
      void invoke<Job | null>("tv_job").then((j) => {
        if (!j) return;
        setJob(j);
        const pct = j.percent != null ? ` ${Math.round(j.percent)}%` : "";
        onBusy(busy === "push" ? `传到电视${pct}` : busy === "catalog" ? `电视歌单${pct}` : `电视${pct}`);
      });
    }, 500);
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

  const findTv = async () => {
    setBusy("find");
    setError(null);
    setFound(null);
    try {
      const list = await invoke<string[]>("tv_discover");
      setFound(list);
      if (list.length === 1) {
        setAddr(list[0]);
        setBusy(null);
        await refresh(list[0]);
        return;
      }
    } catch (e) {
      setError(String(e));
    }
    setBusy(null);
  };

  const installTools = async () => {
    setBusy("install");
    setJob(null);
    setError(null);
    try {
      await invoke("tv_install_tools");
      setBusy(null);
      if (addr) await refresh(addr);
      else setStatus(await invoke<TvStatus>("tv_status", { addr: "" }));
    } catch (e) {
      setError(String(e) === "已取消" ? null : `工具没装好：${String(e)}`);
      setBusy(null);
    }
  };

  const installApp = async () => {
    setBusy("app");
    setJob(null);
    setError(null);
    try {
      await invoke("tv_install_app", { addr });
      await invoke("tv_open_app", { addr }).catch(() => undefined);
      setNote("「波点」装好了，已经在电视上打开");
      setBusy(null);
      await refresh(addr);
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  };

  const push = async (s: Song) => {
    setBusy("push");
    setBusySong(s.title);
    setJob(null);
    setError(null);
    setNote(null);
    try {
      const mv = mvs[s.id];
      const r = await invoke<Pushed>("tv_push", {
        addr,
        req: {
          title: s.title,
          id: s.songId,
          name: s.meta?.title ?? null,
          accompaniment: s.accompaniments[0].path,
          vocal: s.vocals[0]?.path ?? null,
          lyrics: s.lyrics?.path ?? null,
          video: mv?.path ?? null,
        },
      });
      setStatus((st) => (st ? { ...st, songs: [...new Set([...st.songs, r.title])].sort(), freeBytes: r.freeBytes ?? st.freeBytes } : st));
      setNote(`「${r.title}」传好了，电视上的「波点」里就能点`);
    } catch (e) {
      const msg = String(e);
      if (msg === "TOOLS_MISSING") void refresh(addr);
      else if (msg !== "已取消") setError(msg);
    } finally {
      setBusy(null);
      setBusySong(null);
    }
  };

  const syncCatalog = async () => {
    setBusy("catalog");
    setJob(null);
    setError(null);
    try {
      const r = await invoke<{ songs: number; newPreviews: number }>("tv_sync_catalog", { addr });
      setSynced(r.newPreviews > 0 ? `电视歌单更新好了：${r.songs} 首，新做了 ${r.newPreviews} 段副歌预览` : `电视歌单是最新的（${r.songs} 首）`);
    } catch (e) {
      const msg = String(e);
      if (msg !== "已取消") setError(`电视歌单没更新：${msg}`);
      setSynced("");
    } finally {
      setBusy(null);
    }
  };

  // 连上、电视 APP 也是新的，就自动同步一次歌单（只做新歌的预览，很快）
  useEffect(() => {
    if (!open) {
      setSynced(null);
      return;
    }
    const ok = status?.connected && status.adb && status.ffmpeg && status.appVersion != null && status.appVersion >= status.bundledVersion;
    if (ok && synced === null && busy === null) void syncCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 状态变了再看
  }, [open, status, busy]);

  const remove = async (title: string) => {
    setBusy("remove");
    setBusySong(title);
    setError(null);
    setNote(null);
    try {
      await invoke("tv_remove", { addr, title });
      setBusy(null);
      await refresh(addr);
      setNote(`已从电视上删掉「${title}」（电脑上的文件没动）`);
    } catch (e) {
      setError(String(e));
      setBusy(null);
    } finally {
      setBusySong(null);
    }
  };

  const cancel = () => void invoke("tv_cancel");
  const pct = job?.percent != null ? Math.round(job.percent) : null;
  const working = LONG.includes(busy);
  const ready = !!status?.adb && !!status?.ffmpeg;
  const connected = ready && !!status?.connected;
  const appOk = connected && status?.appVersion != null && status.appVersion >= status.bundledVersion;
  const onTv = new Set(status?.songs ?? []);
  const libraryTitles = new Set(playable.map((s) => s.title));
  const tvOnly = (status?.songs ?? []).filter((t) => !libraryTitles.has(t));

  return (
    <div className="overlay" hidden={!open} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog video-dialog tv-dialog" role="dialog" aria-label="电视 KTV">
        <h2>电视 KTV</h2>

        {!status && !error && <p className="muted">正在检查…</p>}

        {status && !ready && (
          <div className="field">
            <p>第一次用要先装工具，从官方地址下载，核对过校验值再装，放在应用自己的文件夹里：</p>
            <ul className="small video-tools-list">
              <li>
                <strong>adb</strong>：安卓官方的连接工具，用来往电视传歌（Google，约 16 MB）{status.adb ? "（已装）" : ""}
              </li>
              <li>
                <strong>ffmpeg</strong>：把 MV、伴奏、人声合成电视能放的文件（和下载视频共用）{status.ffmpeg ? "（已装）" : ""}
              </li>
            </ul>
            {busy === "install" ? (
              <Progress text={job?.text ?? "准备下载工具"} pct={pct} onCancel={cancel} />
            ) : (
              <div className="dialog-actions">
                <Btn className="primary" onClick={() => void installTools()}>
                  下载工具
                </Btn>
              </div>
            )}
          </div>
        )}

        {ready && (
          <div className="field">
            <label htmlFor="tv-addr">电视的 IP 地址</label>
            <div className="field-row">
              <input
                id="tv-addr"
                className="video-url"
                placeholder="比如 192.168.1.20（电视「设置 → 关于 → 网络信息」里能看到）"
                value={addr}
                disabled={busy !== null}
                onChange={(e) => setAddr(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void refresh(addr);
                }}
              />
              <Btn className="ghost" onClick={() => void refresh(addr)} disabled={!addr.trim() || busy !== null}>
                {busy === "status" ? "连接中…" : "连接"}
              </Btn>
              <Btn className="ghost" onClick={() => void findTv()} disabled={busy !== null} title="在这个网络里找打开了调试的电视">
                {busy === "find" ? "找…" : "自动找"}
              </Btn>
            </div>
            {found && found.length === 0 && <p className="muted small">网络里没找到开着调试的电视。电视要开着，并且在工程菜单里打开了 adb debug。</p>}
            {found && found.length > 1 && (
              <p className="small">
                找到几台：
                {found.map((f) => (
                  <Btn
                    key={f}
                    className="link"
                    onClick={() => {
                      setAddr(f);
                      void refresh(f);
                    }}
                  >
                    {f}
                  </Btn>
                ))}
              </p>
            )}
            {status?.connected ? (
              <p className="small">
                已连接 {status.model ?? "电视"}
                {status.freeBytes != null && <span className="muted"> · 电视剩余空间 {fmtSize(status.freeBytes)}</span>}
              </p>
            ) : (
              status?.error && <p className="small error-text">{status.error}</p>
            )}
          </div>
        )}

        {connected && !appOk && (
          <div className="video-result">
            <strong>{status?.appVersion == null ? "电视上还没装「波点」" : "电视上的「波点」有新版本"}</strong>
            <span className="muted small">装好后在电视的应用列表里能找到它，用遥控器点歌。</span>
            {busy === "app" ? (
              <Progress text={job?.text ?? "传到电视"} pct={null} onCancel={cancel} />
            ) : (
              <div className="dialog-actions">
                <Btn className="primary" onClick={() => void installApp()} disabled={busy !== null}>
                  {status?.appVersion == null ? "装到电视上" : "更新"}
                </Btn>
              </div>
            )}
          </div>
        )}

        {connected && appOk && (
          <div className="field">
            <p className="small">
              电视上能看到全部 {playable.length} 首歌，每首有一段副歌预览。还没传过去的歌在电视上点了，电脑上的波点开着就会自动传过去。
            </p>
            {busy === "catalog" ? (
              <Progress text={job?.text ?? "整理电视歌单"} pct={pct} onCancel={cancel} />
            ) : (
              <div className="field-row">
                {synced && <span className="muted small">{synced}</span>}
                <span style={{ flex: 1 }} />
                <Btn className="ghost tiny" onClick={() => void syncCatalog()} disabled={busy !== null}>
                  更新电视歌单
                </Btn>
              </div>
            )}
          </div>
        )}

        {connected && (
          <div className="tv-songs">
            {playable.length === 0 && <p className="muted small">曲库里还没有带伴奏的歌。</p>}
            {playable.map((s) => {
              const mv = mvs[s.id];
              const there = onTv.has(s.title);
              const mine = busySong === s.title;
              return (
                <div key={s.id} className={there ? "tv-song on-tv" : "tv-song"}>
                  <div className="tv-song-main">
                    <span className="tv-song-title">{songName(s)}</span>
                    <span className="muted small" title={mv?.note ?? mv?.path ?? ""}>
                      {!mv ? "看 MV…" : mv.path ? `MV：${baseName(mv.path)}` : mv.note ? `没有 MV（${mv.note}）` : "没有 MV，电视上显示背景和歌词"}
                      {mv && !there ? ` · 约 ${fmtSize(mv.size)}` : ""}
                      {!s.lyrics ? " · 没有歌词" : ""}
                    </span>
                  </div>
                  {there ? (
                    <>
                      <span className="tv-badge">在电视上</span>
                      <Btn className="ghost tiny" onClick={() => void remove(s.title)} disabled={busy !== null}>
                        {mine && busy === "remove" ? "删除中…" : "从电视删除"}
                      </Btn>
                    </>
                  ) : (
                    <Btn className="ghost tiny" onClick={() => void push(s)} disabled={busy !== null || !mv}>
                      {mine ? "传送中…" : "传到电视"}
                    </Btn>
                  )}
                </div>
              );
            })}
            {tvOnly.map((t) => (
              <div key={t} className="tv-song on-tv">
                <div className="tv-song-main">
                  <span className="tv-song-title">{t}</span>
                  <span className="muted small">只在电视上（电脑的曲库里没有）</span>
                </div>
                <Btn className="ghost tiny" onClick={() => void remove(t)} disabled={busy !== null}>
                  从电视删除
                </Btn>
              </div>
            ))}
          </div>
        )}

        {busy === "push" && <Progress text={job?.text ?? `准备「${busySong}」`} pct={pct} onCancel={cancel} />}
        {error && <p className="small error-text">{error}</p>}
        {note && <p className="muted small">{note}</p>}

        <div className="video-foot">
          {connected && appOk ? (
            <Btn className="link" onClick={() => void invoke("tv_open_app", { addr })} disabled={busy !== null}>
              在电视上打开「波点」
            </Btn>
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
