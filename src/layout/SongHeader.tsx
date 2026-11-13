import { Btn } from "../components/Btn";
import { MenuHead, MenuItem, MenuLine, Popover } from "./Popover";

/** 这首歌的四种模式；每种只出现自己的工具 */
export type SongMode = "sing" | "learn" | "record" | "tune";
const MODES: [SongMode, string][] = [
  ["sing", "唱歌"],
  ["learn", "学唱"],
  ["record", "录音"],
  ["tune", "修音"],
];

export interface SongMenuProps {
  /** 歌曲资料（显示名、读音、歌手……；改文件名） */
  onInfo: () => void;
  onImportLrc: () => void;
  /** 有带时间的歌词和人声才能智能对齐 */
  onAlign: (() => void) | null;
  aligning: boolean;
  /** 「编辑歌词 / 打轴」；没伴奏时是 null */
  onTap: (() => void) | null;
  hasLyrics: boolean;
  /** 歌词整体偏移；没打轴的歌词是 null */
  offset: { label: string; onChange: (deltaMs: number) => void } | null;
  /** 原曲视频；没有就是 null */
  original: {
    onOpen: () => void;
    onReveal: () => void;
    /** 已经抽过就是 null */
    onExtract: (() => void) | null;
    /** 伴奏和人声都有了就是 null */
    onSeparate: (() => void) | null;
  } | null;
  /** 在访达中显示这首歌的文件 */
  onRevealSong: (() => void) | null;
}

interface Props {
  title: string;
  /** 原唱 · 语种 等 */
  subtitle: string | null;
  subtitleTip?: string;
  mode: SongMode;
  onMode: (m: SongMode) => void;
  /** 不能切过去的模式和原因（提示文字） */
  modeBlocked?: Partial<Record<SongMode, string>>;
  /** 录音中：整排不能点 */
  locked?: boolean;
  menu: SongMenuProps;
}

const OFFSET_STEP_MS = 50;

/** 「⋯」这首歌的更多操作 */
export function SongMenu({ menu, disabled }: { menu: SongMenuProps; disabled?: boolean }) {
  return (
    <Popover
      className="iconbtn"
      title="这首歌的更多操作：资料、歌词、原曲视频"
      disabled={disabled}
      label={
        <svg viewBox="0 0 24 24" aria-hidden>
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </svg>
      }
      menuClass="song-menu"
    >
      {(close) => (
        <>
          <MenuItem close={close} onClick={menu.onInfo} title="歌名、读音、歌手……；改文件名">
            歌曲资料…
          </MenuItem>
          <MenuLine />
          <MenuHead>歌词</MenuHead>
          <MenuItem close={close} onClick={menu.onImportLrc} disabled={menu.aligning}>
            导入 LRC…
          </MenuItem>
          {menu.onAlign && (
            <MenuItem close={close} onClick={menu.onAlign} disabled={menu.aligning} title="按原唱人声自动修正每句歌词的时间">
              {menu.aligning ? "对齐中…" : "智能对齐"}
            </MenuItem>
          )}
          <MenuItem close={close} onClick={() => menu.onTap?.()} disabled={!menu.onTap} title={menu.onTap ? undefined : "要先有伴奏文件"}>
            {menu.hasLyrics ? "编辑歌词 / 打轴" : "粘贴歌词，打轴"}
          </MenuItem>
          {menu.offset && (
            <div className="pop-row offset-row" title="歌词整体偏移，保存在歌词文件里">
              <span>时间</span>
              <Btn className="ghost tiny" onClick={() => menu.offset!.onChange(-OFFSET_STEP_MS)} title="推后 50ms">
                −
              </Btn>
              <span className="small offset-value">{menu.offset.label}</span>
              <Btn className="ghost tiny" onClick={() => menu.offset!.onChange(OFFSET_STEP_MS)} title="提前 50ms">
                +
              </Btn>
            </div>
          )}
          {menu.original && (
            <>
              <MenuLine />
              <MenuHead>原曲视频</MenuHead>
              <MenuItem close={close} onClick={menu.original.onOpen}>
                打开
              </MenuItem>
              <MenuItem close={close} onClick={menu.original.onReveal}>
                在访达中显示
              </MenuItem>
              {menu.original.onExtract && (
                <MenuItem close={close} onClick={menu.original.onExtract} title="抽出视频里的音频，之后可以在「声音」里切到「原曲」试听">
                  抽出音频
                </MenuItem>
              )}
              {menu.original.onSeparate && (
                <MenuItem close={close} onClick={menu.original.onSeparate} title="用 Demucs 从视频里分离出缺的伴奏 / 人声">
                  做成伴奏
                </MenuItem>
              )}
            </>
          )}
          {menu.onRevealSong && (
            <>
              <MenuLine />
              <MenuItem close={close} onClick={menu.onRevealSong}>
                在访达中显示这首歌
              </MenuItem>
            </>
          )}
        </>
      )}
    </Popover>
  );
}

/** 歌曲区顶栏：歌名、四种模式、「⋯」 */
export function SongHeader({ title, subtitle, subtitleTip, mode, onMode, modeBlocked = {}, locked, menu }: Props) {
  return (
    <header className="song-top">
      <div className="song-top-title">
        <h2 title={title}>{title}</h2>
        {subtitle && (
          <small className="muted" title={subtitleTip}>
            {subtitle}
          </small>
        )}
      </div>
      <div className="segmented mode-seg" role="tablist" aria-label="这首歌的模式">
        {MODES.map(([m, label]) => (
          <Btn
            key={m}
            role="tab"
            aria-selected={mode === m}
            className={mode === m ? "seg active" : "seg"}
            disabled={locked || (!!modeBlocked[m] && mode !== m)}
            title={modeBlocked[m]}
            onClick={() => mode !== m && onMode(m)}
          >
            {label}
          </Btn>
        ))}
      </div>
      <SongMenu menu={menu} disabled={locked} />
    </header>
  );
}

/** 歌词右上角很淡的两个开关：全屏、音高窗口 */
export function CornerToggles({ big, onBig, pitchOn, onPitch, pitchTip }: { big: boolean; onBig: () => void; pitchOn: boolean; onPitch: (() => void) | null; pitchTip: string }) {
  return (
    <div className="corner">
      <Btn className={big ? "iconbtn soft on" : "iconbtn soft"} onClick={onBig} title={big ? "退出全屏（F / Esc）" : "全屏大字（F）"} aria-label={big ? "退出全屏" : "全屏"}>
        <svg viewBox="0 0 24 24" aria-hidden>
          {big ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
        </svg>
      </Btn>
      <Btn className={pitchOn ? "iconbtn soft on" : "iconbtn soft"} onClick={() => onPitch?.()} disabled={!onPitch} title={pitchTip} aria-label="音高窗口">
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M3 15c3-6 5-6 7 0s4 6 7 0 3-4 4-2" />
        </svg>
      </Btn>
    </div>
  );
}
