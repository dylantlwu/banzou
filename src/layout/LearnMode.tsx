import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn } from "../components/Btn";
import { TeacherChat } from "../learn/TeacherChat";
import { TeacherNotes } from "../learn/TeacherNotes";
import { type NotesView, loadNotes } from "../learn/api";
import { type LrcDoc, effectiveTime, findLineIndex } from "../lyrics/lrc";
import { formatTime } from "../utils/time";

export interface LearnLine {
  /** 在 doc.lines 里的位置 */
  index: number;
  text: string;
  start: number | null;
  end: number | null;
}

const SECTION_NAMES = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** 把歌词按空行分段（没有空行就每 4 句一段），每句带上起止时间 */
export function learnSections(doc: LrcDoc | null): LearnLine[][] {
  if (!doc) return [];
  const timed = doc.lines.map((l, i) => ({ i, t: effectiveTime(doc, l) }));
  const nextStart = (i: number) => timed.find((x) => x.i > i && x.t !== null && doc.lines[x.i].text.trim() !== "")?.t ?? null;
  const sections: LearnLine[][] = [];
  let cur: LearnLine[] = [];
  const hasBlank = doc.lines.some((l, i) => l.text.trim() === "" && i > 0 && i < doc.lines.length - 1);
  doc.lines.forEach((l, i) => {
    if (l.text.trim() === "") {
      if (cur.length) sections.push(cur);
      cur = [];
      return;
    }
    const start = timed[i].t;
    const next = nextStart(i);
    cur.push({ index: i, text: l.text, start, end: start === null ? null : (next ?? start + 8) });
    if (!hasBlank && cur.length === 4) {
      sections.push(cur);
      cur = [];
    }
  });
  if (cur.length) sections.push(cur);
  return sections;
}

interface Props {
  /** 歌名键：笔记和对话按它存 */
  title: string;
  /** 歌曲自带的标注（原视频文件名） */
  annotations: string[];
  doc: LrcDoc | null;
  /** 耳朵听到的位置 */
  time: number;
  /** 框住这一句（A-B）并从头放 */
  onPlayLine: (a: number, b: number) => void;
  onClearLoop: () => void;
  loop: { a: number; b: number } | null;
}

/**
 * 学唱模式（PRD 4.12）：左边句子、中间这一句 + 老师笔记、右边问老师。
 * 「听 / 念 / 唱 / 点评」四步和每句的小珠子等学唱功能做出来再接到这里
 */
export function LearnMode({ title, annotations, doc, time, onPlayLine, onClearLoop, loop }: Props) {
  const sections = useMemo(() => learnSections(doc), [doc]);
  const lines = useMemo(() => sections.flat(), [sections]);
  const playingIdx = doc ? findLineIndex(doc, time) : -1;
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => setPicked(null), [title]);
  // 框住一句时停在那一句；不然跟着播放走
  const loopLine = loop ? lines.find((l) => l.start !== null && Math.abs(l.start - loop.a) < 0.05) : null;
  const focus = lines.find((l) => l.index === (picked ?? loopLine?.index ?? playingIdx)) ?? lines.find((l) => l.index >= playingIdx) ?? lines[0] ?? null;

  const [notes, setNotes] = useState<NotesView | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const reload = useCallback(() => {
    loadNotes(title)
      .then((v) => {
        setNotes(v);
        setNotesError(null);
      })
      .catch((e) => setNotesError(String(e)));
  }, [title]);
  useEffect(reload, [reload]);

  const play = (l: LearnLine) => {
    setPicked(l.index);
    if (l.start !== null && l.end !== null) onPlayLine(Math.max(0, l.start - 0.15), l.end);
  };

  return (
    <div className="learn-mode">
      <nav className="learn-lines" aria-label="句子">
        {sections.length === 0 && <p className="muted small">还没有歌词。先在「⋯」里导入 LRC 或打轴。</p>}
        {sections.map((sec, si) => (
          <div key={si}>
            <div className="learn-sec muted">
              <span>第{SECTION_NAMES[si] ?? si + 1}段</span>
            </div>
            {sec.map((l) => (
              <Btn
                key={l.index}
                className={focus?.index === l.index ? "learn-line on" : l.index === playingIdx ? "learn-line now" : "learn-line"}
                onClick={() => play(l)}
                disabled={l.start === null}
                title={l.start === null ? "这句还没打轴" : `${formatTime(l.start)} · 点一下只放这一句`}
              >
                <span>{l.text}</span>
              </Btn>
            ))}
          </div>
        ))}
      </nav>

      <section className="learn-card">
        {focus ? (
          <>
            <div className="learn-orig">{focus.text}</div>
            <div className="learn-act">
              <Btn className="primary big-btn" onClick={() => play(focus)} disabled={focus.start === null}>
                放这一句
              </Btn>
              {loop && (
                <Btn className="ghost" onClick={onClearLoop} title="取消 A-B，接着往下放">
                  放整首
                </Btn>
              )}
            </div>
            <p className="muted small">读音、意思、难点和「听 / 念 / 唱 / 点评」四步还在做；现在可以一句一句放，有问题问右边的老师。</p>
          </>
        ) : (
          <p className="muted">选一句开始</p>
        )}
        <div className="learn-notes learn-mode-notes">
          {annotations.length > 0 && <p className="muted small">歌曲自带的标注：{annotations.join(" / ")}</p>}
          <h3>老师笔记 · 这首歌</h3>
          {notes && <TeacherNotes scope="song" title={title} notes={notes.song} onChanged={reload} empty="还没有。老师说错了就在右边纠正它，它会记在这里。" />}
          <h3>老师笔记 · 所有歌</h3>
          {notes && <TeacherNotes scope="global" title={null} notes={notes.global} onChanged={reload} />}
          {notesError && <p className="small error-text">{notesError}</p>}
        </div>
      </section>

      <TeacherChat title={title} onNotesChanged={reload} />
    </div>
  );
}
