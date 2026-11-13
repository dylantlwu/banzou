import { useEffect, useMemo, useRef, useState } from "react";
import { Btn } from "../components/Btn";
import { songName } from "../songs/meta";
import { type SongTags, type TagStore, displayArtist } from "../tags";
import type { Library, MediaFile, Song } from "../types";
import { type LibFilter, NO_FILTER, beadsTitle, filterSongs, langsInUse, songBeads } from "./filter";
import { MenuHead, MenuItem, MenuLine, Popover } from "./Popover";

const isVideo = (f: MediaFile) => /\.(mp4|mov|m4v|mkv|webm)$/i.test(f.fileName);

interface Props {
  /** 收起（学唱、⌘\、练声）；不卸载，筛选留着 */
  hidden?: boolean;
  library: Library | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 打轴、修音、录音中不能换歌 */
  locked: boolean;
  tags: TagStore;
  tagsOf: (s: Song) => SongTags | undefined;
  idOf: (s: Song) => string;
  scanError: string | null;
  onRetry: () => void;
  /** 「＋」：粘贴 YouTube 链接 */
  onYoutube: () => void;
  /** 下载 / 做成伴奏在后台进行时的进度 */
  videoBusy: string | null;
  /** 「＋」：选一个视频做成伴奏；song = 已经挂到的歌名 */
  onSeparate: (file: MediaFile, song: string | null) => void;
  onRefresh: () => void;
  scanning: boolean;
  /** 待处理 → 资料检查与补齐 */
  onCheck: () => void;
  /** 歌单 ▾ → 管理标签与歌单 */
  onManageTags: () => void;
  /** AI 打标签进度 */
  tagBusy: string | null;
}

function Beads({ song }: { song: Song }) {
  return (
    <span className="beads" title={beadsTitle(song)}>
      {songBeads(song).map((b) => (
        <i key={b.label} className={b.on ? undefined : "no"} />
      ))}
    </span>
  );
}

/** 曲库栏：加歌、搜索、筛选牌子、歌曲列表、底部「待处理」 */
export function LibraryColumn(p: Props) {
  const { library, tags, tagsOf, idOf } = p;
  const [filter, setFilter] = useState<LibFilter>(NO_FILTER);
  const searchRef = useRef<HTMLInputElement>(null);
  const songs = library?.songs ?? [];
  const shown = useMemo(() => filterSongs(songs, filter, tagsOf, idOf, tags), [songs, filter, tagsOf, idOf, tags]);
  const langs = useMemo(() => langsInUse(songs, tagsOf), [songs, tagsOf]);
  const playlist = filter.playlist ? tags.playlists.find((x) => x.id === filter.playlist) : null;
  const filtered = !!(filter.query.trim() || filter.lang || playlist);

  // ⌘F 聚焦搜索框
  useEffect(() => {
    const onFind = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyF") {
        e.preventDefault();
        // 曲库栏可能刚从收起打开，等它显示出来再聚焦
        window.setTimeout(() => {
          searchRef.current?.focus();
          searchRef.current?.select();
        }, 0);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  // 能做成伴奏的视频：还没配对的，和缺伴奏 / 人声的歌的原曲视频
  const videos = useMemo(() => {
    const list: { file: MediaFile; song: string | null }[] = (library?.unassigned ?? []).filter(isVideo).map((file) => ({ file, song: null }));
    for (const s of songs) if (s.originals[0] && (s.vocals.length === 0 || s.accompaniments.length === 0)) list.push({ file: s.originals[0], song: s.title });
    return list;
  }, [library, songs]);
  const unassigned = library?.unassigned ?? [];

  const select = (id: string) => !p.locked && p.onSelect(id);

  return (
    <aside className="lib" hidden={p.hidden}>
      <header className="lib-head">
        <h1>曲库</h1>
        {p.videoBusy && (
          <span className="lib-busy muted small" title={p.videoBusy}>
            {p.videoBusy}
          </span>
        )}
        <Popover label="＋" className="plus" title="加歌" disabled={!library} menuClass="add-menu">
          {(close) => (
            <>
              <MenuItem close={close} onClick={p.onYoutube}>
                粘贴 YouTube 链接…
              </MenuItem>
              <MenuLine />
              <MenuHead>选一个视频做成伴奏</MenuHead>
              {videos.length === 0 && <p className="pop-note muted small">素材文件夹里没有要做的视频</p>}
              {videos.map((v) => (
                <MenuItem key={v.file.path} close={close} onClick={() => p.onSeparate(v.file, v.song)} title={v.file.path}>
                  <span className="pop-file">{v.song ? songName(songs.find((s) => s.title === v.song) ?? { title: v.song, meta: null }) : v.file.fileName}</span>
                </MenuItem>
              ))}
              <MenuLine />
              <MenuItem close={close} onClick={p.onRefresh} disabled={p.scanning} title="文件夹有变化会自动刷新；没刷出来时点这里">
                {p.scanning ? "刷新中…" : "手动刷新曲库"}
              </MenuItem>
            </>
          )}
        </Popover>
      </header>

      {p.scanError && (
        <div className="notice error">
          <p>{p.scanError}</p>
          <Btn className="ghost" onClick={p.onRetry}>
            重试
          </Btn>
        </div>
      )}

      {songs.length > 3 && (
        <div className="lib-search">
          <input
            ref={searchRef}
            type="search"
            placeholder="搜索歌名 / 原唱（⌘F）"
            value={filter.query}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilter((f) => ({ ...f, query: "" }));
                e.currentTarget.blur();
              }
              if (e.key === "Enter" && shown[0]) {
                select(shown[0].id);
                e.currentTarget.blur();
              }
            }}
          />
        </div>
      )}

      {/* 没有语种标签时也留着这一排：「歌单 ▾」是管理标签与歌单的入口 */}
      {songs.length > 0 && (
        <div className="chips">
          <Btn className={!filter.lang && !playlist ? "chip on" : "chip"} onClick={() => setFilter((f) => ({ ...f, lang: null, playlist: null }))}>
            全部
          </Btn>
          {langs.map((l) => (
            <Btn key={l} className={filter.lang === l ? "chip on" : "chip"} onClick={() => setFilter((f) => ({ ...f, lang: f.lang === l ? null : l }))}>
              {l}
            </Btn>
          ))}
          <Popover label={`${playlist?.name ?? "歌单"} ▾`} className={playlist ? "chip on" : "chip"} align="left" menuClass="list-menu">
            {(close) => (
              <>
                {tags.playlists.length === 0 && <p className="pop-note muted small">还没有歌单</p>}
                {tags.playlists.map((x) => (
                  <MenuItem key={x.id} close={close} onClick={() => setFilter((f) => ({ ...f, playlist: f.playlist === x.id ? null : x.id }))}>
                    <span className="pop-check">{filter.playlist === x.id ? "✓" : ""}</span>
                    {x.name}
                    <span className="muted small pop-count">{x.songs.length}</span>
                  </MenuItem>
                ))}
                <MenuLine />
                <MenuItem close={close} onClick={p.onManageTags} title="歌手、语种、年代标签和歌单；AI 补标签">
                  管理标签与歌单…
                </MenuItem>
              </>
            )}
          </Popover>
        </div>
      )}

      {library && songs.length === 0 && !p.scanError && <p className="notice muted">没有找到歌曲。把「歌名 - 伴奏.wav」这样命名的文件放进文件夹，会自动出现在这里。</p>}
      {filtered && shown.length === 0 && songs.length > 0 && (
        <p className="notice muted">
          没有符合的歌。
          <Btn className="link" onClick={() => setFilter(NO_FILTER)}>
            清除筛选
          </Btn>
        </p>
      )}

      <ul className={p.locked ? "lib-songs locked" : "lib-songs"}>
        {shown.map((song) => {
          const artist = displayArtist(tagsOf(song), song.artist);
          return (
            <li key={song.id}>
              <Btn
                className={song.id === p.selectedId ? "lib-song on" : "lib-song"}
                title={tagsOf(song)?.note || undefined}
                onClick={() => select(song.id)}
                disabled={p.locked && song.id !== p.selectedId}
              >
                <span className="lib-song-text">
                  <span className="lib-song-title">{songName(song)}</span>
                  <small className="muted">{artist ?? "原唱未知"}</small>
                </span>
                <Beads song={song} />
              </Btn>
            </li>
          );
        })}
      </ul>

      {library && (
        <footer className="lib-foot">
          <span className="muted small" title={p.tagBusy ?? undefined}>
            {p.tagBusy ?? (filtered ? `${shown.length} / ${songs.length} 首` : `${songs.length} 首`)}
          </span>
          <Popover label={unassigned.length ? `待处理 ${unassigned.length}` : "待处理"} className="link-quiet" up title="没配对的文件；每首歌缺什么" menuClass="todo-menu">
            {(close) => (
              <>
                <MenuHead>没配对的文件{unassigned.length ? `（${unassigned.length}）` : ""}</MenuHead>
                {unassigned.length === 0 && <p className="pop-note muted small">没有，文件都配上了</p>}
                {unassigned.map((f) => (
                  <div key={f.path} className="pop-row" title={f.path}>
                    <span className="pop-file muted">{f.fileName}</span>
                    {isVideo(f) && (
                      <Btn
                        className="link"
                        onClick={() => {
                          close();
                          p.onSeparate(f, null);
                        }}
                        title="用 Demucs 分离出伴奏和人声，配成一首歌"
                      >
                        做成伴奏
                      </Btn>
                    )}
                  </div>
                ))}
                <MenuLine />
                <MenuItem close={close} onClick={p.onCheck} title="每首歌缺什么、哪些功能用不了，一键补齐">
                  资料检查与补齐…
                </MenuItem>
              </>
            )}
          </Popover>
        </footer>
      )}
    </aside>
  );
}
