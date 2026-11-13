import { invoke } from "@tauri-apps/api/core";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Song } from "../types";
import {
  addPlaylist,
  addToPlaylist,
  isManual,
  LANGS,
  mergeAfterAi,
  moveInPlaylist,
  needsTags,
  normalizeStore,
  removeFromPlaylist,
  removePlaylist,
  renamePlaylist,
  loadTags,
  saveTags,
  setTag,
  songId,
  type TagField,
  type TagStore,
} from "../tags";
import { songName } from "../songs/meta";
import { Btn } from "./Btn";

interface Props {
  open: boolean;
  onClose: () => void;
  songs: Song[];
  /** 后台任务的进度，给顶部按钮显示（关掉窗口也能看到） */
  onBusy: (text: string | null) => void;
  /** 没有 key / key 不对时，关掉本窗口去设置里填 */
  onOpenSettings: () => void;
  /** 标签有变（手动改、AI 打完）时把最新的标签给主列表 */
  onTagsChanged?: (store: TagStore) => void;
  /** 打标签时顺手搜到了歌词，曲库要重新扫描 */
  onLibraryChanged?: () => void;
}

const ERA_CHOICES = ["70s", "80s", "90s", "00s", "10s", "20s", "更早"];
const EMPTY: TagStore = { songs: {}, playlists: [] };

/** 小选单用 fixed 定位贴在格子下方（表格里滚动会把它裁掉）；年代靠右所以右对齐，下面放不下就翻到上面 */
function popStyle(r: DOMRect, field: "lang" | "era"): React.CSSProperties {
  const h = field === "lang" ? 74 : 108;
  const below = r.bottom + 4 + h < window.innerHeight;
  return {
    position: "fixed",
    ...(field === "era" ? { left: "auto", right: window.innerWidth - r.right } : { left: r.left }),
    ...(below ? { top: r.bottom + 4 } : { top: "auto", bottom: window.innerHeight - r.top + 4 }),
  };
}

/** 标签与歌单：给歌补歌手 / 语种 / 年代，建自己的歌单（电视上只读） */
export function TagsDialog({ open, onClose, songs, onBusy, onOpenSettings, onTagsChanged, onLibraryChanged }: Props) {
  const [tab, setTab] = useState<"tags" | "lists">("tags");
  const [store, setStore] = useState<TagStore>(EMPTY);
  const storeRef = useRef(store);
  const [plays, setPlays] = useState<Record<string, number>>({});
  const [idOf, setIdOf] = useState<Map<string, string>>(new Map());

  // 标签页
  const [hasKey, setHasKey] = useState(false);
  const [running, setRunning] = useState(false);
  const [detached, setDetached] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRetag, setConfirmRetag] = useState(false);
  const [pop, setPop] = useState<{ id: string; field: "lang" | "era"; rect: DOMRect } | null>(null);
  const [editArtist, setEditArtist] = useState<string | null>(null);
  const artistDone = useRef(false);
  const runningRef = useRef(false);

  // 歌单页
  const [sel, setSel] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; where: "list" | "main" } | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [drag, setDrag] = useState<{ from: number; before: number } | null>(null);
  const nameDone = useRef(false);
  const songsRef = useRef<HTMLDivElement>(null);

  const playable = useMemo(() => songs.filter((s) => s.accompaniments.length > 0), [songs]);

  // 歌名 → 歌名编号（异步算一次）
  useEffect(() => {
    let stop = false;
    void Promise.all(songs.map(async (s) => [s.title, s.songId || (await songId(s.title))] as const)).then((pairs) => {
      if (!stop) setIdOf(new Map(pairs));
    });
    return () => {
      stop = true;
    };
  }, [songs]);
  const byId = useMemo(() => {
    const m = new Map<string, Song>();
    for (const s of songs) {
      const id = idOf.get(s.title);
      if (id) m.set(id, s);
    }
    return m;
  }, [songs, idOf]);

  const apply = useCallback((next: TagStore) => {
    storeRef.current = next;
    setStore(next);
    void saveTags(next);
    onTagsChanged?.(next);
  }, [onTagsChanged]);

  const reload = useCallback(async () => {
    const next = await loadTags().catch(() => normalizeStore(null));
    storeRef.current = next;
    setStore(next);
  }, []);

  // 每次打开：读标签、点歌次数、key 状态
  useEffect(() => {
    if (!open) return;
    setPop(null);
    setEditArtist(null);
    void (async () => {
      if (!runningRef.current) await reload();
      const p = await invoke<Record<string, number> | null>("load_store", { name: "plays" }).catch(() => null);
      setPlays(p && typeof p === "object" ? p : {});
      setHasKey(await invoke<boolean>("ai_key_status").catch(() => false));
    })();
  }, [open, reload]);

  // Esc：先关最上面的小东西，没有了才关窗口
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pop) setPop(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, pop]);

  // 点小选单外面关掉
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".tag-pop-anchor")) setPop(null);
    };
    const close = () => setPop(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("scroll", close, true);
    };
  }, [pop]);

  const rows = useMemo(() => {
    const list = playable.map((s) => ({ song: s, id: idOf.get(s.title) ?? "" })).filter((r) => r.id);
    return list.sort((a, b) => (plays[b.id] ?? 0) - (plays[a.id] ?? 0) || a.song.title.localeCompare(b.song.title, "zh"));
  }, [playable, idOf, plays]);
  const missing = useMemo(() => rows.filter((r) => needsTags(store, r.id)).length, [rows, store]);

  // ---------- 标签页 ----------
  /** 打完标签后，电视连着就悄悄把新资料同步过去；失败不提示 */
  const syncTv = async (): Promise<boolean> => {
    try {
      const saved = await invoke<{ address?: string } | null>("load_store", { name: "tv" });
      const addr = saved?.address;
      if (!addr) return false;
      const st = await invoke<{ connected: boolean }>("tv_status", { addr });
      if (!st.connected) return false;
      await invoke("tv_sync_catalog", { addr });
      return true;
    } catch {
      return false;
    }
  };

  const runAi = async (retag = false) => {
    if (runningRef.current) return;
    setConfirmRetag(false);
    runningRef.current = true;
    setRunning(true);
    setDetached(false);
    setNote(null);
    setError(null);
    onBusy("打标签中…");
    try {
      const r = await invoke<{ songs: number; lyrics: number }>("ai_tag_songs", { retag });
      const n = r.songs;
      if (r.lyrics > 0) onLibraryChanged?.();
      const disk = await loadTags().catch(() => normalizeStore(null));
      apply(mergeAfterAi(disk, storeRef.current));
      const done = `打好了 ${n} 首${r.lyrics > 0 ? `，找到 ${r.lyrics} 首歌词` : ""}`;
      setNote(done);
      void syncTv().then((ok) => ok && setNote((cur) => (cur === done ? `${done}，已同步到电视` : cur)));
    } catch (e) {
      await reload();
      onTagsChanged?.(storeRef.current);
      setError(String(e));
    } finally {
      runningRef.current = false;
      setRunning(false);
      setDetached(false);
      onBusy(null);
    }
  };

  const chooseTag = (id: string, field: "lang" | "era", v: string) => {
    setPop(null);
    if ((store.songs[id]?.[field] ?? "") !== v) apply(setTag(store, id, field, v));
  };

  const commitArtist = (id: string, v: string) => {
    if (artistDone.current) return;
    artistDone.current = true;
    setEditArtist(null);
    if ((store.songs[id]?.artist ?? "") !== v.trim()) apply(setTag(store, id, "artist", v));
  };

  const cell = (id: string, field: TagField) => {
    const v = store.songs[id]?.[field];
    const manual = isManual(store, id, field);
    const open = pop?.id === id && pop.field === field;
    const btn = (
      <Btn
        className={["tag-cell", manual ? "manual" : "", v ? "" : "empty", open ? "open" : ""].filter(Boolean).join(" ")}
        title={manual ? "手动改过" : undefined}
        onClick={(e) => {
          if (field === "artist") {
            artistDone.current = false;
            setPop(null);
            setEditArtist(id);
          } else setPop(open ? null : { id, field, rect: e.currentTarget.getBoundingClientRect() });
        }}
      >
        {v}
      </Btn>
    );
    if (field === "artist" && editArtist === id) {
      return (
        <input
          className="tag-cell-input"
          autoFocus
          defaultValue={v ?? ""}
          onBlur={(e) => commitArtist(id, e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitArtist(id, e.currentTarget.value);
            else if (e.key === "Escape") {
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
              artistDone.current = true;
              setEditArtist(null);
            }
          }}
        />
      );
    }
    if (!open) return btn;
    const choices: readonly string[] = field === "lang" ? LANGS : ERA_CHOICES;
    return (
      <div className="tag-pop-anchor">
        {btn}
        <div className="tag-pop" style={popStyle(pop.rect, field)}>
          {choices.map((x) => (
            <Btn key={x} className={x === v ? "chip on" : "chip"} onClick={() => chooseTag(id, field, x)}>
              {x}
            </Btn>
          ))}
        </div>
      </div>
    );
  };

  // ---------- 歌单页 ----------
  const list = store.playlists.find((p) => p.id === sel) ?? store.playlists[0] ?? null;
  const entries = useMemo(
    () => (list?.songs ?? []).map((id, idx) => ({ id, idx, song: byId.get(id) })).filter((e): e is { id: string; idx: number; song: Song } => !!e.song),
    [list, byId],
  );
  const pickRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return playable.filter((s) => !q || s.title.toLowerCase().includes(q) || songName(s).toLowerCase().includes(q) || (s.artist ?? "").toLowerCase().includes(q));
  }, [playable, search]);

  const startCreate = () => {
    nameDone.current = false;
    setPicking(false);
    setConfirmDel(false);
    setRenaming(null);
    setCreating(true);
  };
  const commitCreate = (name: string) => {
    if (nameDone.current) return;
    nameDone.current = true;
    setCreating(false);
    if (!name.trim()) return;
    const id = `p${Date.now().toString(36)}`;
    apply(addPlaylist(store, name, id));
    setSel(id);
  };
  const commitRename = (id: string, name: string) => {
    if (nameDone.current) return;
    nameDone.current = true;
    setRenaming(null);
    apply(renamePlaylist(store, id, name));
  };
  const pickList = (id: string) => {
    setSel(id);
    setPicking(false);
    setConfirmDel(false);
    setRenaming(null);
  };
  const startRename = (id: string, where: "list" | "main") => {
    nameDone.current = false;
    setCreating(false);
    setRenaming({ id, where });
  };

  const nameInput = (initial: string, placeholder: string | undefined, onCommit: (v: string) => void, onCancel: () => void) => (
    <input
      className="pl-name-input"
      autoFocus
      defaultValue={initial}
      placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onCommit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(e.currentTarget.value);
        else if (e.key === "Escape") {
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          nameDone.current = true;
          onCancel();
        }
      }}
    />
  );

  const dropIndex = (y: number) => {
    const els = songsRef.current?.querySelectorAll<HTMLElement>(".pl-song") ?? [];
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return els.length;
  };
  const endDrag = () => {
    if (drag && list) {
      const to = drag.before > drag.from ? drag.before - 1 : drag.before;
      if (to !== drag.from) apply(moveInPlaylist(store, list.id, entries[drag.from].idx, entries[to].idx));
    }
    setDrag(null);
  };

  const emptyMark = (
    <div className="pl-empty-mark">
      <i className="bead hollow" />
      <i className="bead hollow" />
      <i className="bead hollow" />
    </div>
  );

  const goSettings = () => {
    onClose();
    onOpenSettings();
  };

  const keyBox = hasKey ? (
    <span className="key-saved small muted">
      <i className="bead" />
      API key 已保存
    </span>
  ) : (
    <Btn className="link small" onClick={goSettings}>
      去设置填 key
    </Btn>
  );

  const showProgress = running && !detached;

  return (
    <div className="overlay" hidden={!open} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog tags-dialog" role="dialog" aria-label="标签与歌单">
        <div className="tags-head">
          <h2>标签与歌单</h2>
          <div className="segmented">
            <Btn className={tab === "tags" ? "seg active" : "seg"} onClick={() => setTab("tags")}>
              标签
            </Btn>
            <Btn className={tab === "lists" ? "seg active" : "seg"} onClick={() => setTab("lists")}>
              歌单
            </Btn>
          </div>
        </div>

        {tab === "tags" && (
          <>
            {showProgress ? (
              <div className="video-progress">
                <div className="field-row">
                  <span className="small">正在联网查资料…</span>
                  <Btn
                    className="ghost"
                    onClick={() => {
                      setDetached(true);
                      setNote("放到后台了，打完会自动存好");
                    }}
                  >
                    取消
                  </Btn>
                </div>
                <progress />
              </div>
            ) : (
              <div className="tags-bar">
                <Btn className="primary" onClick={() => void runAi()} disabled={!hasKey || running || missing === 0}>
                  AI 自动打标签
                </Btn>
                <Btn className="ghost" onClick={() => setConfirmRetag(true)} disabled={!hasKey || running}>
                  重新打标签
                </Btn>
                {hasKey && <span className="muted small">{missing === 0 ? "都有标签了" : `${missing} 首还没有标签`}</span>}
                <span className="spacer" />
                {keyBox}
              </div>
            )}
            {confirmRetag && !showProgress && (
              <div className="confirm">
                <span>重新联网查全部歌？你改过的不会动。</span>
                <span className="spacer" />
                <Btn className="ghost" onClick={() => setConfirmRetag(false)}>
                  取消
                </Btn>
                <Btn className="primary" onClick={() => void runAi(true)}>
                  重新打
                </Btn>
              </div>
            )}
            {note && <p className="muted small">{note}</p>}
            {error && (
              <p className="small error-text">
                {error}
                {!running && (
                  <>
                    {" "}
                    {/key|密钥/i.test(error) ? (
                      <Btn className="link" onClick={goSettings}>
                        去设置更换 key
                      </Btn>
                    ) : (
                      <Btn className="link" onClick={() => void runAi()}>
                        再试一次
                      </Btn>
                    )}
                  </>
                )}
              </p>
            )}
            <div className="tv-songs tag-table">
              <div className="tag-row head">
                <span>歌名</span>
                <span>歌手</span>
                <span>语种</span>
                <span>年代</span>
                <span>常点</span>
              </div>
              {rows.map((r) => (
                <div className="tag-row" key={r.id}>
                  <span className="tag-title" title={store.songs[r.id]?.note || r.song.title}>
                    {songName(r.song)}
                  </span>
                  {cell(r.id, "artist")}
                  {cell(r.id, "lang")}
                  {cell(r.id, "era")}
                  <span className="tag-plays">{plays[r.id] || ""}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "lists" &&
          (store.playlists.length === 0 && !creating ? (
            <div className="pl none">
              <div className="pl-empty">
                {emptyMark}
                <span>还没有歌单</span>
                <Btn className="primary" onClick={startCreate}>
                  ＋ 新建歌单
                </Btn>
              </div>
            </div>
          ) : (
            <div className="pl">
              <div className="pl-lists">
                <div className="pl-lists-scroll">
                  {store.playlists.map((p) =>
                    renaming?.id === p.id && renaming.where === "list" ? (
                      <div className="pl-item active" key={p.id}>
                        {nameInput(p.name, "歌单名字", (v) => commitRename(p.id, v), () => setRenaming(null))}
                      </div>
                    ) : (
                      <Btn key={p.id} className={p.id === list?.id && !creating ? "pl-item active" : "pl-item"} onClick={() => pickList(p.id)} onDoubleClick={() => startRename(p.id, "list")}>
                        <span className="pl-item-name">{p.name}</span>
                        <span className="pl-item-count">{p.songs.length}</span>
                      </Btn>
                    ),
                  )}
                  {creating && (
                    <div className="pl-item active">
                      {nameInput("", "歌单名字", commitCreate, () => setCreating(false))}
                    </div>
                  )}
                </div>
                <Btn className="pl-new" onClick={startCreate}>
                  ＋ 新建歌单
                </Btn>
              </div>

              <div className="pl-main">
                {creating || !list ? (
                  <div className="pl-empty">{emptyMark}</div>
                ) : (
                  <>
                    <div className="pl-main-head">
                      {renaming?.id === list.id && renaming.where === "main" ? (
                        nameInput(list.name, "歌单名字", (v) => commitRename(list.id, v), () => setRenaming(null))
                      ) : (
                        <Btn className="pl-main-name" title="点一下改名" onClick={() => startRename(list.id, "main")}>
                          {list.name}
                        </Btn>
                      )}
                      <span className="spacer" />
                      {picking ? (
                        <Btn className="primary" onClick={() => setPicking(false)}>
                          好了
                        </Btn>
                      ) : (
                        <>
                          <Btn
                            className="ghost"
                            onClick={() => {
                              setSearch("");
                              setConfirmDel(false);
                              setPicking(true);
                            }}
                          >
                            ＋ 添加歌曲
                          </Btn>
                          <Btn className="ghost" title="删除这个歌单" onClick={() => setConfirmDel(true)}>
                            删除
                          </Btn>
                        </>
                      )}
                    </div>
                    {confirmDel && !picking && (
                      <div className="confirm">
                        <span>删除「{list.name}」？歌还在曲库里。</span>
                        <span className="spacer" />
                        <Btn className="ghost" onClick={() => setConfirmDel(false)}>
                          取消
                        </Btn>
                        <Btn
                          className="primary"
                          onClick={() => {
                            setConfirmDel(false);
                            setSel(null);
                            apply(removePlaylist(store, list.id));
                          }}
                        >
                          删除
                        </Btn>
                      </div>
                    )}
                    {picking ? (
                      <>
                        <div className="pl-pick-search">
                          <input autoFocus placeholder="搜歌名、歌手" value={search} onChange={(e) => setSearch(e.target.value)} />
                        </div>
                        <div className="pl-songs">
                          {pickRows.map((s) => {
                            const id = idOf.get(s.title) ?? "";
                            const inList = list.songs.includes(id);
                            return (
                              <Btn
                                key={s.id}
                                className={inList ? "pl-pick in" : "pl-pick"}
                                onClick={() => id && apply(inList ? removeFromPlaylist(store, list.id, id) : addToPlaylist(store, list.id, id))}
                              >
                                <i className={inList ? "bead" : "bead hollow"} />
                                <span className="pl-song-title">{songName(s)}</span>
                                <span className="pl-song-artist">{store.songs[id]?.artist ?? s.artist ?? ""}</span>
                              </Btn>
                            );
                          })}
                        </div>
                      </>
                    ) : entries.length === 0 ? (
                      <div className="pl-empty">
                        {emptyMark}
                        <span>还没有歌</span>
                        <Btn
                          className="primary"
                          onClick={() => {
                            setSearch("");
                            setPicking(true);
                          }}
                        >
                          ＋ 添加歌曲
                        </Btn>
                      </div>
                    ) : (
                      <div className="pl-songs" ref={songsRef}>
                        {entries.map((e, i) => (
                          <Fragment key={e.id}>
                            {drag && drag.before === i && drag.before !== drag.from && drag.before !== drag.from + 1 && <div className="pl-drop" />}
                            <div className={drag?.from === i ? "pl-song dragging" : "pl-song"}>
                              <span
                                className="pl-grip"
                                title="拖动调整顺序"
                                onPointerDown={(ev) => {
                                  ev.currentTarget.setPointerCapture(ev.pointerId);
                                  setDrag({ from: i, before: i });
                                }}
                                onPointerMove={(ev) => drag && setDrag({ from: drag.from, before: dropIndex(ev.clientY) })}
                                onPointerUp={endDrag}
                                onPointerCancel={() => setDrag(null)}
                                style={{ touchAction: "none" }}
                              />
                              <span className="pl-num">{i + 1}</span>
                              <span className="pl-song-title">{songName(e.song)}</span>
                              <span className="pl-song-artist">{store.songs[e.id]?.artist ?? e.song.artist ?? ""}</span>
                              <Btn className="pl-x" title="从歌单移除" onClick={() => apply(removeFromPlaylist(store, list.id, e.id))}>
                                ×
                              </Btn>
                            </div>
                          </Fragment>
                        ))}
                        {drag && drag.before === entries.length && drag.before !== drag.from + 1 && <div className="pl-drop" />}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}

        <div className="video-foot">
          <span />
          <Btn className="ghost" onClick={onClose}>
            {showProgress ? "放到后台" : "关闭"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
