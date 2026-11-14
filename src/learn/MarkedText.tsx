import { parseMarked } from "./marked";
import { Ruby } from "./Ruby";
import "./reading.css";

interface Props {
  text: string;
  /** 点一个词：确认或改读音（学唱页里有读音表时才给） */
  onPick?: (word: string) => void;
}

/** 老师写的 `原文{读音}` 显示成原文加注音；`{?}` 是待确认（橙色虚线，读音处显示 ?）。旧文字原样 */
export function MarkedText({ text, onPick }: Props) {
  return (
    <span className="marked-text">
      {parseMarked(text).map((p, i) => {
        if (typeof p === "string") return <span key={i}>{p}</span>;
        const pending = p.reading === null;
        return (
          <Ruby
            key={i}
            base={p.orig}
            reading={pending ? "?" : p.reading}
            className={pending ? "rv-pending" : undefined}
            title={pending ? "读音待确认" : undefined}
            onPick={onPick ? () => onPick(p.orig) : undefined}
          />
        );
      })}
    </span>
  );
}
