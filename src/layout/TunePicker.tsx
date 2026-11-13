import { Btn } from "../components/Btn";
import type { Take } from "../takes/takes";

/** 修音模式：先选要修哪一遍（新的在上面，加星的排前） */
export function TunePicker({ takes, onPick, onRecord }: { takes: Take[]; onPick: (t: Take) => void; onRecord: () => void }) {
  const list = [...takes].sort((a, b) => Number(b.starred) - Number(a.starred) || b.createdAt.localeCompare(a.createdAt));
  if (list.length === 0)
    return (
      <div className="mode-hint">
        <p className="muted">还没有录音，修音要先录一遍。</p>
        <Btn className="primary" onClick={onRecord}>
          去录音
        </Btn>
      </div>
    );
  return (
    <div className="tune-pick">
      <p className="muted">修哪一遍？</p>
      <ul>
        {list.map((t) => (
          <li key={t.id}>
            <span>
              {t.starred ? "★ " : ""}
              {t.name}
            </span>
            <span className="muted small">{new Date(t.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            <Btn className="ghost" onClick={() => onPick(t)}>
              修这一遍
            </Btn>
          </li>
        ))}
      </ul>
    </div>
  );
}
