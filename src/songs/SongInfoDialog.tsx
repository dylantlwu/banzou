// 歌曲资料窗口：改歌名（显示名）、读音、歌手等资料（写进 `<歌名>.song.json`），以及改文件名（编号不变）。
import { useEffect, useMemo, useState } from "react";
import { Btn } from "../components/Btn";
import { ERAS, LANGS } from "../tags";
import type { Song } from "../types";
import { SHEET_FIELDS } from "./fields";
import { BY_LABEL, type FilledBy, type RenameStep, type SongMeta, songMeta, songName, textOf } from "./meta";
import "./songs.css";

interface Props {
  song: Song | null;
  onClose: () => void;
  /** 资料改了（要重新扫描曲库） */
  onSaved: () => void;
  /** 文件名改了：旧歌名键 → 新歌名键 */
  onRenamed: (oldKey: string, newKey: string) => void;
}

export function SongInfoDialog({ song, onClose, onSaved, onRenamed }: Props) {
  const [meta, setMeta] = useState<SongMeta | null>(null);
  const [exists, setExists] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [plan, setPlan] = useState<RenameStep[] | null>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    if (!song) return;
    setMeta(null);
    setError(null);
    setNote(null);
    setPlan(null);
    setNewKey(song.title);
    void songMeta<{ meta: SongMeta; exists: boolean }>("song_view", { key: song.title })
      .then((r) => {
        setMeta(r.meta);
        setExists(r.exists);
        setDraft(Object.fromEntries(SHEET_FIELDS.map((f) => [f.key, textOf(r.meta, f.key)])));
        setMore(SHEET_FIELDS.some((f) => f.optional && f.key !== "title" && textOf(r.meta, f.key)));
      })
      .catch((e) => setError(String(e)));
  }, [song]);

  const changed = useMemo(() => (meta ? SHEET_FIELDS.filter((f) => (draft[f.key] ?? "").trim() !== textOf(meta, f.key)) : []), [draft, meta]);

  if (!song) return null;

  const save = async () => {
    if (!meta || changed.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const patch = Object.fromEntries(changed.map((f) => [f.key, (draft[f.key] ?? "").trim()]));
      const m = await songMeta<SongMeta>("song_meta_save", { key: song.title, patch });
      setMeta(m);
      setExists(true);
      setNote(`存好了（${changed.map((f) => f.label).join("、")}）`);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const previewRename = async () => {
    setError(null);
    setPlan(null);
    try {
      setPlan(await songMeta<RenameStep[]>("song_rename_plan", { key: song.title, newKey: newKey.trim() }));
    } catch (e) {
      setError(String(e));
    }
  };

  const doRename = async () => {
    setBusy(true);
    setError(null);
    try {
      const k = await songMeta<string>("song_rename", { key: song.title, newKey: newKey.trim() });
      setPlan(null);
      onRenamed(song.title, k);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const byOf = (k: string): FilledBy | undefined => meta?.by?.[k];
  const shown = SHEET_FIELDS.filter((f) => !f.optional || f.key === "title" || more);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog song-info" role="dialog" aria-label="歌曲资料">
        <div className="song-info-head">
          <h2>{(meta && textOf(meta, "title")) || songName(song)}</h2>
          <span className="muted small">编号 {meta?.id ?? song.songId}{exists ? "" : " · 还没有资料表（存的时候建）"}</span>
        </div>

        {!meta && !error && <p className="muted">读取中…</p>}
        {meta && (
          <div className="song-info-fields">
            {shown.map((f) => (
              <label key={f.key} className="song-info-row">
                <span className="song-info-label">
                  {f.label}
                  {byOf(f.key) && textOf(meta, f.key) && <span className={`by by-${byOf(f.key)}`}>{BY_LABEL[byOf(f.key)!]}</span>}
                </span>
                {f.input === "lang" || f.input === "era" ? (
                  <select value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}>
                    <option value="">（没有）</option>
                    {(f.input === "lang" ? LANGS : ERAS).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                ) : f.input === "longtext" ? (
                  <textarea rows={2} value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                ) : (
                  <input value={draft[f.key] ?? ""} placeholder={f.key === "title" ? song.title : ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                )}
                {f.hint && <span className="muted small song-info-hint">{f.hint}</span>}
              </label>
            ))}
            {!more && (
              <Btn className="link small" onClick={() => setMore(true)}>
                更多：演唱者、作词、作曲、版本
              </Btn>
            )}
          </div>
        )}

        <details className="song-info-rename">
          <summary>改文件名</summary>
          <p className="muted small">
            现在的文件名：<b>{song.title}</b>。改名会把伴奏、人声、歌词、资料表、笔记和录音文件夹一起改，编号不变，标签、歌单、电视都还对得上。只想改显示的名字，改上面的「歌名」就行。
          </p>
          <div className="song-info-rename-row">
            <input value={newKey} onChange={(e) => (setNewKey(e.target.value), setPlan(null))} />
            <Btn className="ghost" onClick={() => void previewRename()} disabled={busy || !newKey.trim() || newKey.trim() === song.title}>
              预览
            </Btn>
          </div>
          {plan && (
            <div className="song-info-plan">
              <p className="small">会改这 {plan.length} 项（不删任何文件）：</p>
              <ul className="small">
                {plan.map((st) => (
                  <li key={st.from}>
                    {st.from} → <b>{st.to}</b>
                  </li>
                ))}
              </ul>
              <Btn className="primary" onClick={() => void doRename()} disabled={busy}>
                确认改名
              </Btn>
            </div>
          )}
        </details>

        {error && <p className="error-text small">{error}</p>}
        {note && <p className="muted small">{note}</p>}
        <div className="dialog-actions">
          <Btn className="ghost" onClick={onClose}>
            关闭
          </Btn>
          <Btn className="primary" onClick={() => void save()} disabled={busy || changed.length === 0}>
            保存
          </Btn>
        </div>
      </div>
    </div>
  );
}
