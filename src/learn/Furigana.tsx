import { type ReadingTable, SOURCE_LABEL, splitByTable } from "./readingApi";
import { Ruby } from "./Ruby";

interface Props {
  text: string;
  table: ReadingTable | null | undefined;
  /** 点一个词：确认或改读音 */
  onPick?: (word: string) => void;
  picked?: string | null;
}

/** 一行歌词加注音（读音从读音表来）。待确认的词橙色虚线、读音后面带 ?，点一下能确认或改 */
export function Furigana({ text, table, onPick, picked }: Props) {
  return (
    <>
      {splitByTable(text, table).map((p, i) => {
        if (typeof p === "string") return <span key={i}>{p}</span>;
        const cls = ["rv-word", p.needsReview ? "rv-pending" : "", picked === p.word ? "rv-picked" : ""].filter(Boolean).join(" ");
        const tip = p.needsReview ? `读音待确认：${p.reasons.join("；")}。点一下确认或改` : `${p.romaji} · ${SOURCE_LABEL[p.source]}。点一下可以改`;
        return (
          <Ruby
            key={i}
            base={p.word}
            reading={p.needsReview ? `${p.reading}?` : p.reading}
            className={cls}
            title={tip}
            onPick={onPick ? () => onPick(p.word) : undefined}
          />
        );
      })}
    </>
  );
}
