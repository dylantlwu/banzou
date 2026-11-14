import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Btn } from "../components/Btn";
import { MarkedText } from "./MarkedText";
import { type LearnView, cancelPrepare, installReadingDict, loadLearnView, prepareLesson } from "./readingApi";
import "./reading.css";

/** 一首歌的学唱资料：歌词、读音表、课程、词典状态。歌换了、笔记改了就重新读 */
export function useLearnView(songId: string | null) {
  const [view, setView] = useState<LearnView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  // 现在显示的是哪首：慢的请求（备课完再刷新）回来时歌已经换了，就不要套到新歌上
  const shown = useRef(songId);
  shown.current = songId;
  const reload = useCallback(() => {
    if (!songId) return;
    const n = ++seq.current;
    loadLearnView(songId)
      .then((v) => {
        if (n !== seq.current || shown.current !== songId) return;
        setView(v);
        setError(null);
      })
      .catch((e) => n === seq.current && shown.current === songId && setError(String(e)));
  }, [songId]);
  useEffect(() => {
    setView(null);
    reload();
  }, [reload]);
  return { view, setView, error, reload };
}

interface Job {
  text: string;
  percent: number | null;
}

/** 正在备课的歌（歌 ID → 开始时间，也当这一次的编号）。放在组件外：备课途中换歌再换回来，按钮仍是「备课中」，也不会套到别的歌上 */
const preparing = new Map<string, number>();
const preparingListeners = new Set<() => void>();
const notifyPreparing = () => preparingListeners.forEach((f) => f());

function usePreparing(songId: string): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    preparingListeners.add(f);
    // 备课中每秒刷新一次「已等 x 秒」
    const t = window.setInterval(() => preparing.has(songId) && f(), 1000);
    return () => {
      preparingListeners.delete(f);
      window.clearInterval(t);
    };
  }, [songId]);
  return preparing.get(songId) ?? null;
}

interface Props {
  songId: string;
  view: LearnView | null;
  error: string | null;
  onChanged: () => void;
  onPickWord: (word: string) => void;
}

/** 学唱页上的读音表和备课：装词典、备课、按表改了哪些、哪些读音等我确认（PRD 4.12） */
export function LessonPanel({ songId, view, error, onChanged, onPickWord }: Props) {
  const [installing, setInstalling] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const prepStarted = usePreparing(songId);
  const isPreparing = prepStarted !== null;
  const [note, setNote] = useState<{ text: string; error?: boolean; songId?: string } | null>(null);
  const current = useRef(songId);
  current.current = songId;

  useEffect(() => {
    if (!installing) return;
    const t = window.setInterval(() => {
      void invoke<Job | null>("video_job").then((j) => setJob(j));
    }, 500);
    return () => window.clearInterval(t);
  }, [installing]);

  useEffect(() => setNote(null), [songId]);

  const install = async () => {
    setInstalling(true);
    setNote(null);
    try {
      await installReadingDict();
      setNote({ text: "读音词典装好了" });
      onChanged();
    } catch (e) {
      setNote({ text: String(e), error: true });
    } finally {
      setInstalling(false);
      setJob(null);
    }
  };

  const prepare = async () => {
    const id = songId;
    if (preparing.has(id)) return;
    const run = Date.now();
    preparing.set(id, run);
    notifyPreparing();
    setNote(null);
    let result: { text: string; error?: boolean };
    try {
      const lesson = await prepareLesson(id);
      result = { text: lesson.fixes.length ? `备好了，按读音表和笔记改了 ${lesson.fixes.length} 处` : "备好了" };
    } catch (e) {
      result = { text: String(e), error: true };
    }
    // 这一次已经取消了（或取消后又重新开始了一次）：结果后端没存，这里也不管
    if (preparing.get(id) !== run) return;
    preparing.delete(id);
    notifyPreparing();
    // 歌已经换了：结果留在那首歌自己的文件里，换回去时会读到，这里不显示也不刷新
    if (current.current !== id) return;
    setNote({ ...result, songId: id });
    if (!result.error) onChanged();
  };

  const cancel = () => {
    const id = songId;
    preparing.delete(id);
    notifyPreparing();
    setNote({ text: "取消了，原来的课程还在", songId: id });
    void cancelPrepare(id).catch((e) => setNote({ text: `取消没成功：${String(e)}`, error: true, songId: id }));
  };

  if (!view) return error ? <p className="small error-text">{error}</p> : null;
  const { dict, table, lesson } = view;
  const pending = table.words.filter((w) => w.needsReview);

  return (
    <div className="lesson-panel">
      {view.japanese && !dict.installed && (
        <div className="lesson-dict">
          <p className="small">
            给每个词标读音要两个日语分析器的词典（下载约 {dict.downloadMb} MB，装好占约 {dict.diskMb} MB）。没装时只有笔记和歌曲标注里的读音。
          </p>
          <Btn className="ghost" onClick={() => void install()} disabled={installing}>
            {installing ? "正在装…" : "安装读音词典"}
          </Btn>
          {installing && job && (
            <span className="muted small">
              {job.text}
              {job.percent !== null ? ` ${Math.round(job.percent)}%` : ""}
            </span>
          )}
        </div>
      )}

      <div className="lesson-row">
        <Btn className={lesson ? "ghost" : "primary"} onClick={() => void prepare()} disabled={isPreparing || view.lines.length === 0}>
          {isPreparing ? `老师在备课… ${Math.round((Date.now() - prepStarted) / 1000)} 秒` : lesson ? (view.lessonStale ? "歌词改过了，重新备课" : "重新备课") : "备课"}
        </Btn>
        {isPreparing && (
          <Btn className="ghost" onClick={cancel} title="不等了：这次的结果不存，原来的课程保留">
            取消
          </Btn>
        )}
        <span className="muted small">
          {view.lines.length === 0
            ? "还没有歌词，先导入或打轴"
            : `${view.japanese ? `读音表 ${table.words.length} 个词${pending.length ? `，${pending.length} 个待确认` : ""}` : "不是日语歌，不标读音"}${lesson ? ` · ${lesson.created} 备的课` : ""}`}
        </span>
      </div>
      {isPreparing && <p className="muted small">先由本机分析器填好读音表，再让老师讲意思和难点，一首歌约一两分钟（实测 64 句 88 秒）。</p>}
      {note && !isPreparing && <p className={note.error ? "small error-text" : "muted small"}>{note.text}</p>}

      {lesson?.summary && (
        <p className="lesson-summary">
          <MarkedText text={lesson.summary} />
        </p>
      )}
      {lesson && lesson.fixes.length > 0 && (
        <div className="lesson-fixes">
          <b className="small">程序按读音表和笔记改了老师写的</b>
          <ul>
            {lesson.fixes.map((f, i) => (
              <li key={i} className="small">
                {f.place}：{f.word} {f.from} → {f.to}
              </li>
            ))}
          </ul>
        </div>
      )}
      {pending.length > 0 && (
        <div className="lesson-review">
          <b className="small">这些读音等你确认</b>
          <div className="lesson-review-words">
            {pending.map((w) => (
              <Btn key={w.word} className="ghost tiny rv-pending-btn" onClick={() => onPickWord(w.word)} title={w.reasons.join("；")}>
                {w.word} {w.reading}?
              </Btn>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 当前这句的意思和难点（备过课才有） */
export function LessonLineInfo({ view, index }: { view: LearnView | null; index: number }) {
  const line = view?.lesson?.lines.find((l) => l.index === index);
  if (!line) return null;
  const hard = view?.lesson?.hardest.includes(index);
  return (
    <div className="lesson-line">
      {line.meaning && (
        <div className="lesson-meaning">
          <MarkedText text={line.meaning} />
        </div>
      )}
      {line.tips.map((t, i) => (
        <div key={i} className="lesson-tip">
          <b>难点</b>
          <MarkedText text={t} />
        </div>
      ))}
      {hard && <div className="muted small">这是全曲最难的几句之一，多放几遍。</div>}
    </div>
  );
}
