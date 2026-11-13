import { useCallback, useEffect, useState } from "react";
import { Btn } from "../components/Btn";
import { TeacherChat } from "./TeacherChat";
import { TeacherNotes } from "./TeacherNotes";
import { type NotesView, loadNotes } from "./api";

interface Props {
  /** 歌名键（文件名里的歌名），笔记和对话都按它存 */
  title: string;
  /** 资料表里的显示名 */
  shownTitle: string;
  /** 歌曲自带的标注（原视频文件名），给人看老师依据的是什么 */
  annotations: string[];
  onClose: () => void;
}

/**
 * 学唱（PRD 4.12）：现在只有「问老师」和老师笔记。
 * 以后布局改好了，这里的两块放进学唱模式的右栏；备课、一句一循环再加在中间
 */
export function LearnDialog({ title, shownTitle, annotations, onClose }: Props) {
  const [notes, setNotes] = useState<NotesView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    loadNotes(title)
      .then((v) => {
        setNotes(v);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [title]);

  useEffect(reload, [reload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog learn-dialog" role="dialog" aria-label="学唱">
        <div className="learn-head">
          <div>
            <h2>学唱 · {shownTitle}</h2>
            {annotations.length > 0 && <p className="muted small">歌曲自带的标注：{annotations.join(" / ")}</p>}
          </div>
          <Btn className="ghost" onClick={onClose}>
            关闭
          </Btn>
        </div>
        <div className="learn-body">
          <section className="learn-notes">
            <h3>老师笔记 · 这首歌</h3>
            {notes && (
              <TeacherNotes
                scope="song"
                title={title}
                notes={notes.song}
                onChanged={reload}
                empty="还没有。老师说错了就在右边纠正它，它会记在这里。"
              />
            )}
            <h3>老师笔记 · 所有歌</h3>
            {notes && <TeacherNotes scope="global" title={null} notes={notes.global} onChanged={reload} />}
            {error && <p className="small error-text">{error}</p>}
          </section>
          <TeacherChat title={title} onNotesChanged={reload} />
        </div>
      </div>
    </div>
  );
}
