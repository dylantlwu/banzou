import type { ButtonHTMLAttributes } from "react";

/** 点击后不抢焦点的按钮，避免空格键既触发快捷键又触发按钮 */
export function Btn(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" onMouseDown={(e) => e.preventDefault()} {...props} />;
}

/** 键盘事件是否发生在文字输入框里（这时不响应快捷键） */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.isContentEditable) return true;
  return el.tagName === "INPUT" && !["range", "checkbox", "button"].includes((el as HTMLInputElement).type);
}
