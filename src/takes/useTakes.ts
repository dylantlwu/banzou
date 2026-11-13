/**
 * 当前歌曲的录音 Take 列表：读写 takes.json、选中、改名、标星、删除、对齐微调。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type Take, deleteTake, loadTakes, recoveredTake, saveTakes } from "./takes";

export interface TakesApi {
  dir: string | null;
  takes: Take[];
  selected: Take | null;
  error: string | null;
  select: (id: string | null) => void;
  add: (take: Take) => Promise<void>;
  update: (id: string, patch: Partial<Take>) => void;
  remove: (id: string) => Promise<void>;
}

export function useTakes(title: string | null): TakesApi {
  const [dir, setDir] = useState<string | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef(title);
  titleRef.current = title;
  const takesRef = useRef(takes);
  takesRef.current = takes;

  useEffect(() => {
    setTakes([]);
    setSelectedId(null);
    setDir(null);
    setError(null);
    if (!title) return;
    let cancelled = false;
    loadTakes(title)
      .then((list) => {
        if (cancelled) return;
        setDir(list.dir);
        const abnormal = list.abnormal.length
          ? `这首歌有 ${list.abnormal.length} 条异常录音（比歌长很多，多半是忘了停），没放进列表。可以在「资料」里移到废纸篓`
          : null;
        if (list.recovered.length) {
          const next = [...list.takes, ...list.recovered.map((r) => recoveredTake(r.file, r.seconds))];
          setTakes(next);
          void saveTakes(title, next).catch((e) => setError(String(e)));
          setError(`上次有 ${list.recovered.length} 条录音没录完就退出了，已经恢复到列表里（时间可能需要手动对齐）` + (abnormal ? `。${abnormal}` : ""));
        } else {
          setTakes(list.takes);
          setError(abnormal);
        }
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [title]);

  const persist = useCallback((next: Take[]) => {
    const t = titleRef.current;
    takesRef.current = next;
    setTakes(next);
    if (t) saveTakes(t, next).catch((e) => setError(String(e)));
  }, []);

  // 连续拖微调滑杆时别每一下都写盘
  const saveTimer = useRef<number | undefined>(undefined);
  const update = useCallback((id: string, patch: Partial<Take>) => {
    const next = takesRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t));
    takesRef.current = next;
    setTakes(next);
    window.clearTimeout(saveTimer.current);
    const t = titleRef.current;
    saveTimer.current = window.setTimeout(() => {
      if (t) saveTakes(t, takesRef.current).catch((e) => setError(String(e)));
    }, 400);
  }, []);

  const add = useCallback(
    async (take: Take) => {
      persist([...takesRef.current, take]);
      setSelectedId(take.id);
    },
    [persist],
  );

  const remove = useCallback(async (id: string) => {
    const t = titleRef.current;
    if (!t) return;
    try {
      const rest = await deleteTake(t, takesRef.current, id);
      takesRef.current = rest;
      setTakes(rest);
      setSelectedId((s) => (s === id ? null : s));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  return {
    dir,
    takes,
    selected: takes.find((t) => t.id === selectedId) ?? null,
    error,
    select: setSelectedId,
    add,
    update,
    remove,
  };
}
