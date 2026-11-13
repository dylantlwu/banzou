import { useEffect, useRef, useState } from "react";
import { Btn } from "../components/Btn";
import { type Remembered, SCOPE_NAME, type Turn, askTeacher, clearChat, loadChat, loadNotes, setNote, speakLine, undoRemember } from "./api";

interface Props {
  title: string;
  /** 老师记了 / 撤销了笔记，旁边的笔记要刷新 */
  onNotesChanged: () => void;
}

const AUTO_SPEAK_KEY = "banzou.learn.autoSpeak";

function readAutoSpeak(): boolean {
  try {
    return localStorage.getItem(AUTO_SPEAK_KEY) !== "0";
  } catch {
    return true;
  }
}

/** 老师记下的一条笔记：能撤销、能改（PRD 4.12「老师的记性」） */
function RememberedCard({ title, r, onNotesChanged }: { title: string; r: Remembered; onNotesChanged: () => void }) {
  const [state, setState] = useState<"kept" | "undone" | "editing">("kept");
  const [text, setText] = useState(r.text);
  const [draft, setDraft] = useState(r.text);
  const [error, setError] = useState<string | null>(null);

  const undo = async () => {
    try {
      await undoRemember(title, { ...r, text });
      setState("undone");
      onNotesChanged();
    } catch (e) {
      setError(String(e));
    }
  };

  const saveEdit = async () => {
    try {
      const view = await loadNotes(title);
      const list = r.scope === "global" ? view.global : view.song;
      const i = list.findIndex((n) => n.text === text);
      if (i < 0) throw new Error("这条笔记已经不在了");
      await setNote(r.scope, title, i, draft);
      setText(draft.trim());
      setState("kept");
      setError(null);
      onNotesChanged();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  if (state === "undone") return <div className="remembered undone">已撤销：{text}</div>;
  return (
    <div className="remembered">
      <div>
        <b>记住了</b>
        <span className="muted">（{SCOPE_NAME[r.scope]}）</span>
        {state === "editing" ? (
          <textarea
            value={draft}
            rows={2}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void saveEdit();
              }
              if (e.key === "Escape") setState("kept");
            }}
          />
        ) : (
          <span>{text}</span>
        )}
      </div>
      {r.replaced && <div className="muted small">改掉了：{r.replaced}</div>}
      <div className="remembered-btns">
        {state === "editing" ? (
          <>
            <Btn className="link" onClick={() => void saveEdit()} disabled={!draft.trim()}>
              存
            </Btn>
            <Btn className="link" onClick={() => setState("kept")}>
              取消
            </Btn>
          </>
        ) : (
          <>
            <Btn className="link" onClick={() => void undo()}>
              撤销
            </Btn>
            <Btn
              className="link"
              onClick={() => {
                setDraft(text);
                setState("editing");
              }}
            >
              改
            </Btn>
          </>
        )}
      </div>
      {error && <div className="small error-text">{error}</div>}
    </div>
  );
}

/** 问老师：打字问，老师回答并念出来；纠正老师时它会记进笔记（PRD 4.12） */
export function TeacherChat({ title, onNotesChanged }: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [autoSpeak, setAutoSpeak] = useState(readAutoSpeak);
  const [speaking, setSpeaking] = useState<number | null>(null);
  const [said, setSaid] = useState<Record<number, string>>({});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setTurns([]);
    setError(null);
    loadChat(title)
      .then(setTurns)
      .catch((e) => setError(String(e)));
    return () => audioRef.current?.pause();
  }, [title]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns, busy]);

  const speak = async (index: number, text: string) => {
    audioRef.current?.pause();
    setSpeaking(index);
    setVoiceError(null);
    try {
      const r = await speakLine(title, text);
      setSaid((s) => ({ ...s, [index]: r.said }));
      const audio = new Audio(`data:audio/mpeg;base64,${r.audio}`);
      audioRef.current = audio;
      audio.onended = () => setSpeaking((s) => (s === index ? null : s));
      await audio.play();
    } catch (e) {
      setVoiceError(String(e));
      setSpeaking(null);
    }
  };

  const send = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setDraft("");
    const base = turns.length;
    setTurns((t) => [...t, { role: "me", text: q }]);
    try {
      const reply = await askTeacher(title, q);
      setTurns((t) => [...t, reply]);
      if (reply.remembered?.length) onNotesChanged();
      if (autoSpeak) void speak(base + 1, reply.text);
    } catch (e) {
      setTurns((t) => t.slice(0, base));
      setDraft(q);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleAutoSpeak = () => {
    const next = !autoSpeak;
    setAutoSpeak(next);
    if (!next) audioRef.current?.pause();
    try {
      localStorage.setItem(AUTO_SPEAK_KEY, next ? "1" : "0");
    } catch {
      /* 不能存就只管这一次 */
    }
  };

  const clear = async () => {
    audioRef.current?.pause();
    try {
      await clearChat(title);
      setTurns([]);
      setSaid({});
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <aside className="teacher">
      <div className="teacher-head">
        <b>老师</b>
        <span className="teacher-head-btns">
          <Btn className={autoSpeak ? "link on" : "link"} onClick={toggleAutoSpeak} title="老师的回答自动念出来（豆包语音）">
            {autoSpeak ? "念出来：开" : "念出来：关"}
          </Btn>
          {turns.length > 0 && (
            <Btn className="link" onClick={() => void clear()} title="清空这首歌和老师的对话（笔记不受影响）">
              清空对话
            </Btn>
          )}
        </span>
      </div>
      <div className="teacher-chat" ref={listRef}>
        {turns.length === 0 && !busy && <p className="muted small">问什么都行，比如「歌名怎么念」。老师说错了直接纠正它，它会记住。</p>}
        {turns.map((t, i) =>
          t.role === "me" ? (
            <div key={i} className="msg me">
              {t.text}
            </div>
          ) : (
            <div key={i} className="msg t">
              <div className="msg-text">{t.text}</div>
              {t.remembered?.map((r, j) => <RememberedCard key={j} title={title} r={r} onNotesChanged={onNotesChanged} />)}
              <Btn
                className="link say"
                onClick={() => void speak(i, t.text)}
                disabled={speaking === i}
                title={said[i] && said[i] !== t.text ? `念的是：${said[i]}` : undefined}
              >
                {speaking === i ? "正在念…" : "再听老师说"}
              </Btn>
            </div>
          ),
        )}
        {busy && <div className="msg t muted">老师在想…</div>}
      </div>
      {error && <p className="small error-text teacher-error">{error}</p>}
      {voiceError && <p className="small error-text teacher-error">念不出来：{voiceError}</p>}
      <div className="teacher-ask">
        <textarea
          value={draft}
          rows={2}
          placeholder="打字问老师；说错了直接纠正它"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(draft);
            }
          }}
          disabled={busy}
        />
        <span className="teacher-ask-btns">
          <Btn className="primary" onClick={() => void send(draft)} disabled={busy || !draft.trim()}>
            问
          </Btn>
          <Btn
            className="ghost"
            onClick={() => void send(`记住：${draft.trim()}`)}
            disabled={busy || !draft.trim()}
            title="让老师把这句话记进笔记，以后都照做"
          >
            记住
          </Btn>
        </span>
      </div>
    </aside>
  );
}
