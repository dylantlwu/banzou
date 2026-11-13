// 资料检查里的「异常录音」：比歌长很多、没自动恢复的未完成录音（资料清单 §5-9）。
// 只给「移到废纸篓」（能找回），不自动删。
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { Btn } from "../components/Btn";
import { type AbnormalRecording, formatLength, formatSize } from "../takes/recordGuard";

export function AbnormalRecordings({ open }: { open: boolean }) {
  const [list, setList] = useState<AbnormalRecording[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await invoke<AbnormalRecording[]>("abnormal_recordings"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    setNote(null);
    setError(null);
    if (open) void load();
  }, [open, load]);

  const trash = async (r: AbnormalRecording) => {
    const key = `${r.title}/${r.file}`;
    setBusy(key);
    setError(null);
    try {
      await invoke("trash_takes", { title: r.title, files: [r.file] });
      setNote(`「${r.file}」已移到废纸篓，需要的话可以从废纸篓找回`);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  if (list.length === 0 && !error && !note) return null;
  return (
    <div className="check-abnormal">
      {list.length > 0 && (
        <>
          <p className="small">
            <b>异常录音 {list.length} 条</b>
            <span className="muted">：比歌长很多，多半是忘了停，没有放进录音列表。</span>
          </p>
          <ul>
            {list.map((r) => (
              <li key={`${r.title}/${r.file}`}>
                <span className="check-abnormal-name">
                  {r.title} · {r.file}
                </span>
                <span className="muted small">
                  {formatSize(r.bytes)} · {formatLength(r.seconds)}
                </span>
                <Btn className="ghost tiny" disabled={busy !== null} onClick={() => void trash(r)}>
                  {busy === `${r.title}/${r.file}` ? "移动中…" : "移到废纸篓"}
                </Btn>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="error-text small">{error}</p>}
      {note && <p className="muted small">{note}</p>}
    </div>
  );
}
