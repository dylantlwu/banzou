import { useEffect, useRef, useState } from "react";
import { Btn } from "../components/Btn";
import { CANDIDATE_LABEL, type Reading, type ReadingTable, SOURCE_LABEL, saveReading } from "./readingApi";

interface Props {
  songId: string;
  word: string;
  table: ReadingTable;
  onSaved: (t: ReadingTable) => void;
  onClose: () => void;
}

/** 确认或改一个词的读音：存进这首歌的笔记，注音、老师、念出来都按它（PRD 4.12） */
export function ReadingEditor({ songId, word, table, onSaved, onClose }: Props) {
  const r: Reading | undefined = table.words.find((w) => w.word === word);
  const [draft, setDraft] = useState(r?.reading ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // 从下面「等你确认」点过来时，编辑框在上面的句子区，滚到看得见
  useEffect(() => {
    // 新的 Chrome 里 scrollIntoView 会返回 Promise，不能当 effect 的返回值
    void boxRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [word]);
  useEffect(() => {
    setDraft(r?.reading ?? "");
    setError(null);
  }, [word, r?.reading]);

  if (!r) return null;
  const candidates = (Object.keys(CANDIDATE_LABEL) as (keyof Reading["candidates"])[])
    .map((k) => ({ k, v: r.candidates[k] }))
    .filter((c): c is { k: keyof Reading["candidates"]; v: string } => !!c.v);

  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await saveReading(songId, word, value));
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rv-editor" ref={boxRef}>
      <div className="rv-editor-head">
        <b className="rv-editor-word">{r.word}</b>
        <span>
          {r.reading}
          <span className="muted small">
            {" "}
            {r.romaji} · {SOURCE_LABEL[r.source]}
          </span>
        </span>
        <Btn className="link rv-close" onClick={onClose} title="关上">
          关上
        </Btn>
      </div>
      {r.needsReview && <p className="small rv-why">待确认：{r.reasons.join("；")}</p>}
      {candidates.length > 0 && (
        <div className="rv-cands">
          {candidates.map((c) => (
            <Btn key={c.k} className={draft === c.v ? "ghost tiny active" : "ghost tiny"} onClick={() => setDraft(c.v)} title={`${CANDIDATE_LABEL[c.k]}给的读音`}>
              {CANDIDATE_LABEL[c.k]}：{c.v}
            </Btn>
          ))}
        </div>
      )}
      <div className="rv-edit-row">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && draft.trim() && void save(draft)}
          placeholder="假名或罗马字，比如 かじつ / kajitsu"
          spellCheck={false}
          aria-label={`${r.word}的读音`}
        />
        <Btn className="primary" onClick={() => void save(draft)} disabled={busy || !draft.trim()}>
          {r.needsReview && draft === r.reading ? "就是这个" : "确认这个读音"}
        </Btn>
      </div>
      <p className="muted small">确认后记进这首歌的笔记；注音、老师讲解、念出来都按它。</p>
      {error && <p className="small error-text">{error}</p>}
    </div>
  );
}
