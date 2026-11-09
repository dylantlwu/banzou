import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { type Take, takeSpan } from "../takes/takes";
import type { TakesApi } from "../takes/useTakes";
import { formatTime } from "../utils/time";
import { Btn } from "./Btn";

interface ExportFile {
  path: string;
  name: string;
  modified: number;
}

interface Props {
  /** 歌名：用来列出「录音/歌名/导出」里的成品 */
  title: string;
  takes: TakesApi;
  /** 回放时在「我的声音」和「原唱」之间切换（V） */
  compare: boolean;
  onToggleCompare: () => void;
  canCompare: boolean;
  voiceVolume: number;
  onVoiceVolume: (v: number) => void;
  onSeek: (t: number) => void;
  disabled: boolean;
  onOpenTune?: (take: Take) => void;
  onComp?: () => void;
}

function shortDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 录音 Take 列表（PRD 4.4 录完之后） */
export function TakesPanel({ title, takes, compare, onToggleCompare, canCompare, voiceVolume, onVoiceVolume, onSeek, disabled, onOpenTune, onComp }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmDelete) return;
    const id = window.setTimeout(() => setConfirmDelete(null), 3000);
    return () => window.clearTimeout(id);
  }, [confirmDelete]);

  // 导出的成品（修音页导出的 wav / m4a）；换歌、录音列表变了都重新读一次
  const [exports, setExports] = useState<ExportFile[]>([]);
  useEffect(() => {
    let cancelled = false;
    invoke<ExportFile[]>("list_exports", { title })
      .then((list) => !cancelled && setExports(list))
      .catch(() => !cancelled && setExports([]));
    return () => {
      cancelled = true;
    };
  }, [title, takes.takes]);

  const sel = takes.selected;
  const commitRename = () => {
    if (renaming && draft.trim()) takes.update(renaming, { name: draft.trim() });
    setRenaming(null);
  };

  return (
    <aside className="takes">
      <div className="takes-head">
        <span>录音（{takes.takes.length}）</span>
        <span>
          {onComp && takes.takes.length >= 2 && (
            <Btn className="link" onClick={onComp} disabled={disabled} title="每句挑最好的一遍，拼成新的一遍">
              拼接
            </Btn>
          )}
          <Btn className={sel ? "link" : "link active"} onClick={() => takes.select(null)} disabled={disabled}>
            只听伴奏
          </Btn>
        </span>
      </div>
      {takes.takes.length === 0 && <p className="muted small takes-empty">还没有录音。点下面的「● 录音」开始。</p>}
      <ul className="take-list">
        {[...takes.takes].reverse().map((t) => {
          const [a, b] = t.clips.length ? takeSpan(t) : [0, 0];
          return (
            <li
              key={t.id}
              className={t.id === sel?.id ? "take active" : "take"}
              onClick={() => {
                if (disabled) return;
                takes.select(t.id);
                if (t.range) onSeek(Math.max(0, t.range[0] - 2));
              }}
            >
              <button
                type="button"
                className={t.starred ? "star on" : "star"}
                title={t.starred ? "取消标星" : "标星"}
                onClick={(e) => {
                  e.stopPropagation();
                  takes.update(t.id, { starred: !t.starred });
                }}
              >
                {t.starred ? "★" : "☆"}
              </button>
              <div className="take-main">
                {renaming === t.id ? (
                  <input
                    className="take-rename"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenaming(null);
                      e.stopPropagation();
                    }}
                  />
                ) : (
                  <span
                    className="take-name"
                    title="双击改名"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setRenaming(t.id);
                      setDraft(t.name);
                    }}
                  >
                    {t.name}
                  </span>
                )}
                <span className="muted small">
                  {formatTime(a)}–{formatTime(b)} · {shortDate(t.createdAt)}
                </span>
              </div>
              <button
                type="button"
                className={confirmDelete === t.id ? "take-del confirm" : "take-del"}
                title="删除（移到废纸篓）"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirmDelete === t.id) {
                    setConfirmDelete(null);
                    void takes.remove(t.id);
                  } else setConfirmDelete(t.id);
                }}
              >
                {confirmDelete === t.id ? "确认删除" : "×"}
              </button>
            </li>
          );
        })}
      </ul>

      {sel && (
        <div className="take-detail">
          <div className="take-detail-row">
            <Btn className={compare ? "toggle on" : "toggle"} onClick={onToggleCompare} disabled={!canCompare} title="切换听我的声音 / 原唱（V）">
              {compare ? "正在听原唱" : "正在听我的声音"}
            </Btn>
          </div>
          <label className="take-detail-row">
            <span className="muted small">我的声音</span>
            <input type="range" min={0} max={1} step={0.01} value={voiceVolume} onChange={(e) => onVoiceVolume(Number(e.target.value))} />
          </label>
          <label className="take-detail-row">
            <span className="muted small">对齐微调</span>
            <input
              type="range"
              min={-150}
              max={150}
              step={5}
              value={sel.adjustMs}
              onChange={(e) => takes.update(sel.id, { adjustMs: Number(e.target.value) })}
              title="录音整体提前 / 推后，边播边拖听哪里最齐"
            />
            <span className="small adjust-value">{sel.adjustMs > 0 ? "+" : ""}{sel.adjustMs}ms</span>
          </label>
          <p className="muted small">
            {sel.clips.some((c) => c.autoAlignMs) &&
              `自动对齐 ${[...new Set(sel.clips.map((c) => c.autoAlignMs))].map((ms) => `${ms > 0 ? "+" : ""}${ms}ms`).join(" / ")} · `}
            延迟 {sel.latencyMs}ms{sel.deviceLabel ? ` · ${sel.deviceLabel}` : ""}
          </p>
          {onOpenTune && (
            <Btn className="primary" onClick={() => onOpenTune(sel)}>
              去修音
            </Btn>
          )}
        </div>
      )}
      {exports.length > 0 && (
        <div className="export-list">
          <div className="takes-head">
            <span>导出的成品（{exports.length}）</span>
            <Btn className="link" onClick={() => void invoke("reveal_file", { path: exports[0].path })} title="在访达里打开导出文件夹">
              打开文件夹
            </Btn>
          </div>
          <ul>
            {exports.map((f) => (
              <li key={f.path}>
                <span className="export-name" title={f.path}>
                  <span className="tag">{f.name.split(".").pop()?.toUpperCase()}</span> {f.name.replace(/\.[^.]+$/, "")}
                </span>
                <span className="muted small">{shortDate(new Date(f.modified * 1000).toISOString())}</span>
                <Btn className="link" onClick={() => void invoke("open_file", { path: f.path })} title="用系统播放器打开">
                  播放
                </Btn>
              </li>
            ))}
          </ul>
        </div>
      )}
      {takes.error && <p className="error-text small">{takes.error}</p>}
    </aside>
  );
}
