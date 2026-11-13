import { type ReactNode, useEffect, useRef, useState } from "react";
import { Btn } from "../components/Btn";

interface Props {
  /** 触发按钮里的内容 */
  label: ReactNode;
  /** 触发按钮的 class（沿用应用里的按钮样式） */
  className?: string;
  title?: string;
  disabled?: boolean;
  /** 菜单往哪边展开 */
  align?: "left" | "right";
  /** 往上弹（放在窗口底部时用） */
  up?: boolean;
  /** 菜单内容；拿到 close 可以点完就收起 */
  children: (close: () => void) => ReactNode;
  /** 菜单的额外 class */
  menuClass?: string;
}

/**
 * 小弹出菜单：点按钮打开，点外面或按 Esc 收起。
 * Esc 在捕获阶段吃掉，免得同时触发「退出全屏」等快捷键
 */
export function Popover({ label, className = "ghost", title, disabled, align = "right", up, children, menuClass }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div className="pop-wrap" ref={wrap}>
      <Btn className={open ? `${className} open` : className} title={title} disabled={disabled} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {label}
      </Btn>
      {open && <div className={`pop-menu ${align}${up ? " up" : ""}${menuClass ? ` ${menuClass}` : ""}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

/** 菜单里的一行 */
export function MenuItem({ children, onClick, disabled, title, close }: { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string; close?: () => void }) {
  return (
    <Btn
      className="pop-item"
      disabled={disabled}
      title={title}
      onClick={() => {
        close?.();
        onClick();
      }}
    >
      {children}
    </Btn>
  );
}

export const MenuHead = ({ children }: { children: ReactNode }) => <div className="pop-head">{children}</div>;
export const MenuLine = () => <hr className="pop-line" />;
