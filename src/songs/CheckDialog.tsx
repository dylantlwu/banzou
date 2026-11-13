// 资料检查：按字段登记表（fields.ts）列出每首歌缺什么、缺了哪些功能用不了，每个缺口给能用的「补齐」办法。
// 自成一个窗口，以后换桌面布局时可以整块挪过去。
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn } from "../components/Btn";
import { AbnormalRecordings } from "./AbnormalRecordings";
import type { MediaFile, Song } from "../types";
import { FEATURES, FIELDS, FIX_LABEL, type Feature, type Fix, type Gap, type SongState, featureLabel, gaps, ready } from "./fields";
import { BY_LABEL, type CheckRow, type PlanItem, songMeta, songName } from "./meta";
import "./songs.css";

interface Props {
  open: boolean;
  songs: Song[];
  onClose: () => void;
  /** 打开某首歌的资料窗口 */
  onEdit: (song: Song) => void;
  /** 去这首歌的演唱页 / 打轴页（智能对齐按钮在演唱页） */
  onGoTo: (song: Song, mode: "sing" | "tap") => void;
  /** 从视频做成伴奏 / 人声 */
  onSeparate: (video: MediaFile, key: string) => void;
  onOpenVideo: () => void;
  /** 资料改了，重新扫描曲库 */
  onChanged: () => void;
}

export function CheckDialog({ open, songs, onClose, onEdit, onGoTo, onSeparate, onOpenVideo, onChanged }: Props) {
  const [rows, setRows] = useState<CheckRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<Feature | "all">("all");
  const [plan, setPlan] = useState<PlanItem[] | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await songMeta<CheckRow[]>("songs_check"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) void load();
    else setPlan(null);
  }, [open, load, songs]);

  const states: SongState[] = useMemo(() => {
    if (!rows) return [];
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return songs.flatMap((song) => {
      const row = byKey.get(song.title);
      return row ? [{ song, row }] : [];
    });
  }, [rows, songs]);

  const withGaps = useMemo(() => states.map((s) => ({ s, gaps: gaps(s) })), [states]);
  const shown = withGaps.filter(({ s, gaps }) => (filter === "all" ? gaps.length > 0 : !ready(s, filter)));
  const noSheet = states.filter((s) => s.row.sheet === "none").length;
  const broken = states.filter((s) => s.row.sheet === "broken");

  const run = async (label: string, job: () => Promise<string | null>) => {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      setNote(await job());
      onChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const aiFill = (keys: string[] | null) =>
    run(keys ? `ai:${keys[0]}` : "ai:all", async () => {
      const r = await invoke<{ songs: number; lyrics: number }>("ai_tag_songs", { retag: false, titles: keys });
      return r.songs === 0 ? "没有要查的（用户填过的不会再查）" : `AI 查了 ${r.songs} 首${r.lyrics ? `，找到 ${r.lyrics} 首歌词` : "，没找到合适的歌词"}`;
    });

  const tvSync = () =>
    run("tv", async () => {
      const saved = await invoke<{ address?: string } | null>("load_store", { name: "tv" }).catch(() => null);
      if (!saved?.address) throw new Error("还没连过电视：先在「电视」里连上一次");
      const st = await invoke<{ connected: boolean }>("tv_status", { addr: saved.address });
      if (!st.connected) throw new Error("电视没连上：打开电视、确认和电脑在同一个网络");
      const r = await invoke<{ songs: number; newPreviews: number }>("tv_sync_catalog", { addr: saved.address });
      return `电视歌单同步好了：${r.songs} 首，新做了 ${r.newPreviews} 个小 MV`;
    });

  const fix = (s: SongState, f: Fix) => {
    switch (f) {
      case "edit":
        return onEdit(s.song);
      case "ai":
      case "lyricsSearch":
        return void aiFill([s.song.title]);
      case "tap":
        return onGoTo(s.song, "tap");
      case "align":
        return onGoTo(s.song, "sing");
      case "separate":
        return s.song.originals[0] && onSeparate(s.song.originals[0], s.song.title);
      case "video":
        return onOpenVideo();
      case "tvSync":
        return void tvSync();
    }
  };

  const previewMigrate = () =>
    run("plan", async () => {
      setPlan(await songMeta<PlanItem[]>("songs_migrate_plan"));
      return null;
    });

  const doMigrate = () =>
    run("migrate", async () => {
      const n = await songMeta<number>("songs_migrate");
      setPlan(null);
      return `建好了 ${n} 个资料表`;
    });

  if (!open) return null;

  const gapLine = (s: SongState, g: Gap) => (
    <li key={g.def.key} className="check-gap">
      <span className="check-gap-name">{typeof g.def.missing === "function" ? g.def.missing(s) : (g.def.missing ?? `缺${g.def.label}`)}</span>
      {g.blocks.length > 0 ? <span className="check-blocks">{g.blocks.map(featureLabel).join("、")}用不了</span> : <span className="muted small">{g.def.helps.map(featureLabel).join("、")}会差一点</span>}
      <span className="check-fixes">
        {g.fix.map((f) => (
          <Btn key={f} className="ghost tiny" disabled={busy !== null || (f === "separate" && !s.song.originals[0])} onClick={() => fix(s, f)}>
            {busy === `ai:${s.song.title}` && (f === "ai" || f === "lyricsSearch") ? "查询中…" : FIX_LABEL[f]}
          </Btn>
        ))}
      </span>
    </li>
  );

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog check-dialog" role="dialog" aria-label="资料检查">
        <div className="check-head">
          <h2>资料检查</h2>
          <span className="muted small">{states.length} 首歌</span>
        </div>

        <div className="check-features">
          <Btn className={filter === "all" ? "seg active" : "seg"} onClick={() => setFilter("all")}>
            全部缺口
          </Btn>
          {FEATURES.map((f) => {
            const ok = states.filter((s) => ready(s, f.key)).length;
            return (
              <Btn key={f.key} className={filter === f.key ? "seg active" : "seg"} onClick={() => setFilter(f.key)} title={`${f.label}：${ok}/${states.length} 首能用`}>
                {f.label} {ok}/{states.length}
              </Btn>
            );
          })}
        </div>

        {noSheet > 0 && !plan && (
          <div className="check-banner">
            <span>
              {noSheet} 首还没有资料表（现在的标签读的是 tags.json 里的旧值）。建好后改名、AI 补资料都写进每首歌旁边的 <code>歌名.song.json</code>。
            </span>
            <Btn className="ghost" onClick={() => void previewMigrate()} disabled={busy !== null}>
              预览建表
            </Btn>
          </div>
        )}
        {plan && (
          <div className="check-plan">
            <p className="small">
              预演：新建 {plan.filter((p) => p.action === "create").length} 个资料表，不改、不删任何已有文件。
            </p>
            <ul className="small">
              {plan
                .filter((p) => p.action === "create")
                .map((p) => (
                  <li key={p.key}>
                    <b>{p.file}</b> · 编号 {p.id} ·{" "}
                    {Object.entries(p.fields)
                      .filter(([, [v]]) => v !== null)
                      .map(([k, [v, by]]) => `${FIELDS.find((f) => f.key === k)?.label ?? k}：${String(v)}${by ? `（${BY_LABEL[by]}）` : ""}`)
                      .join("，") || "（只有编号）"}
                  </li>
                ))}
            </ul>
            <div className="dialog-actions">
              <Btn className="ghost" onClick={() => setPlan(null)}>
                先不建
              </Btn>
              <Btn className="primary" onClick={() => void doMigrate()} disabled={busy !== null}>
                确认建表
              </Btn>
            </div>
          </div>
        )}
        <AbnormalRecordings open={open} />
        {broken.map((s) => (
          <p key={s.song.title} className="error-text small">
            「{songName(s.song)}」的资料表读不懂，没有动它：{s.row.sheetError}
          </p>
        ))}

        <div className="check-list">
          {!rows && !error && <p className="muted">检查中…</p>}
          {rows && shown.length === 0 && <p className="muted">{filter === "all" ? "每首歌的资料都齐了" : `每首歌都能用「${featureLabel(filter)}」`}</p>}
          {shown.map(({ s, gaps }) => (
            <div key={s.song.title} className="check-song">
              <div className="check-song-head">
                <span className="check-song-name">{songName(s.song)}</span>
                {songName(s.song) !== s.song.title && <span className="muted small">文件名：{s.song.title}</span>}
                <Btn className="link small" onClick={() => onEdit(s.song)}>
                  资料
                </Btn>
              </div>
              <ul>{(filter === "all" ? gaps : gaps.filter((g) => g.blocks.includes(filter))).map((g) => gapLine(s, g))}</ul>
            </div>
          ))}
        </div>

        {error && <p className="error-text small">{error}</p>}
        {note && <p className="muted small">{note}</p>}
        <div className="dialog-actions">
          <Btn className="ghost" onClick={() => void aiFill(null)} disabled={busy !== null} title="歌手、语种、年代、背景、原曲名还缺的歌，一起联网查；没歌词的顺手搜歌词。你填的不会被改">
            {busy === "ai:all" ? "AI 查询中…" : "AI 补齐全部"}
          </Btn>
          <Btn className="ghost" onClick={() => void tvSync()} disabled={busy !== null}>
            {busy === "tv" ? "同步中…" : "同步电视歌单"}
          </Btn>
          <Btn className="primary" onClick={onClose}>
            关闭
          </Btn>
        </div>
      </div>
    </div>
  );
}
