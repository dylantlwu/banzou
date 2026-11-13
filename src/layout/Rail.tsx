import type { ReactElement } from "react";
import { Btn } from "../components/Btn";

export type Place = "library" | "practice" | "live" | "tv" | "settings";

const ICONS: Record<Place, ReactElement> = {
  library: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </svg>
  ),
  practice: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M3 12h3l3-7 4 14 3-7h5" />
    </svg>
  ),
  live: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="2.5" />
      <path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 7.5a6.4 6.4 0 0 1 0 9M4.6 4.6a10.5 10.5 0 0 0 0 14.8M19.4 4.6a10.5 10.5 0 0 1 0 14.8" />
    </svg>
  ),
  tv: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
    </svg>
  ),
};

const LABELS: Record<Place, string> = { library: "曲库", practice: "练声", live: "直播", tv: "电视", settings: "设置" };
const TIPS: Record<Place, string> = {
  library: "曲库（⌘\\ 收起 / 打开）",
  practice: "每日练声：音阶、气息、长音、听音",
  live: "直播（OBS 歌词叠加层）",
  tv: "把歌传到电视上的「波点」，像 KTV 一样唱",
  settings: "设置",
};

interface Props {
  active: Place | null;
  onGo: (place: Place) => void;
  /** 有事在进行时图标上一颗橙点，文字放进提示里（直播同步中、电视传歌中…） */
  busy?: Partial<Record<Place, string | null>>;
  disabled?: Partial<Record<Place, boolean>>;
}

/** 最左一条：要去的地方。设置在最下面 */
export function Rail({ active, onGo, busy = {}, disabled = {} }: Props) {
  const item = (p: Place) => (
    <Btn
      key={p}
      className={active === p ? "place on" : "place"}
      onClick={() => onGo(p)}
      disabled={disabled[p]}
      title={busy[p] ? `${LABELS[p]}：${busy[p]}` : TIPS[p]}
      aria-current={active === p ? "page" : undefined}
    >
      {ICONS[p]}
      <span>{LABELS[p]}</span>
      {busy[p] && <i className="place-dot" aria-hidden />}
    </Btn>
  );
  return (
    <nav className="rail" aria-label="地方">
      <div className="rail-mark" title="波点" aria-label="波点">
        <i />
        <i />
        <i />
      </div>
      {(["library", "practice", "live", "tv"] as const).map(item)}
      <div className="rail-grow" />
      {item("settings")}
    </nav>
  );
}
