import { useState } from "react";
import { Btn } from "../components/Btn";
import { type Note, type Scope, setNote } from "./api";
import "./learn.css";

interface Props {
  scope: Scope;
  /** 这首歌的笔记要歌名；通用笔记不用 */
  title: string | null;
  notes: Note[];
  /** 改完了重新读 */
  onChanged: () => void;
  empty?: string;
}

/** 一本老师笔记：一条一行，点「改」就地改，「删」删掉，最下面能加一条（PRD 4.12「老师的记性」） */
export function TeacherNotes({ scope, title, notes, onChanged, empty }: Props) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = async (index: number | null, text: string) => {
    try {
      await setNote(scope, title, index, text);
      setError(null);
      setEditing(null);
      setAdding("");
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="teacher-notes">
      {notes.length === 0 && <p className="muted small">{empty ?? "还没有"}</p>}
      <ul>
        {notes.map((n, i) => (
          <li key={`${i}-${n.text}`}>
            {editing === i ? (
              <>
                <textarea
                  value={draft}
                  rows={2}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void save(i, draft);
                    }
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
                <span className="note-btns">
                  <Btn className="link" onClick={() => void save(i, draft)} disabled={!draft.trim()}>
                    存
                  </Btn>
                  <Btn className="link" onClick={() => setEditing(null)}>
                    取消
                  </Btn>
                </span>
              </>
            ) : (
              <>
                <span className="note-text">
                  {n.text}
                  {n.tag && <small className="muted"> {n.tag}</small>}
                </span>
                <span className="note-btns">
                  <Btn
                    className="link"
                    onClick={() => {
                      setDraft(n.text);
                      setEditing(i);
                    }}
                  >
                    改
                  </Btn>
                  <Btn className="link" onClick={() => void save(i, "")}>
                    删
                  </Btn>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="note-add">
        <input
          value={adding}
          placeholder={scope === "song" ? "加一条，比如：读音：夏実 = かじつ" : "加一条，对所有歌都管用"}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && adding.trim() && void save(null, adding)}
          spellCheck={false}
        />
        <Btn className="ghost" onClick={() => void save(null, adding)} disabled={!adding.trim()}>
          记下
        </Btn>
      </div>
      {error && <p className="small error-text">{error}</p>}
    </div>
  );
}
