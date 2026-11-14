import type { KeyboardEvent, ReactNode } from "react";

interface Props {
  base: string;
  reading: ReactNode;
  className?: string;
  title?: string;
  onPick?: () => void;
}

/**
 * 原文加注音。不用 <ruby>：注音比汉字宽时浏览器会把汉字撑开（「心 の 中 で」）。
 * 这里原文字距不变，注音浮在上面居中、可以伸出两边（reading.css 的 .rv-word / .rv-rt）。
 * 整个词不折行；行距要留出注音的高度（.learn-orig、.marked-text）
 */
export function Ruby({ base, reading, className, title, onPick }: Props) {
  const onKeyDown = onPick ? (e: KeyboardEvent) => e.key === "Enter" && onPick() : undefined;
  return (
    <span className={["rv-word", className].filter(Boolean).join(" ")} title={title} onClick={onPick} role={onPick ? "button" : undefined} tabIndex={onPick ? 0 : undefined} onKeyDown={onKeyDown}>
      {base}
      <span className="rv-rt" aria-hidden>
        {reading}
      </span>
    </span>
  );
}
