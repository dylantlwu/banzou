import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Btn } from "../components/Btn";
import { type Box, type TourStep, placeCard, spotBox } from "./tourSteps";
import "./tour.css";

interface Props {
  steps: TourStep[];
  /** 切到某一步之前：让界面准备好（打开曲库栏、选上一首歌） */
  onPrepare: (step: TourStep) => void;
  /** 看完或跳过 */
  onClose: () => void;
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5);

/**
 * 第一次使用的导航（PRD 4.0.1）：聚光灯框住真实的界面，旁边一张小卡片。
 * 每帧重新量一次要框的元素，窗口变窄、拖过分界线、深浅色都跟得上。
 */
export function Tour({ steps, onPrepare, onClose }: Props) {
  const [index, setIndex] = useState(0);
  const step = steps[Math.min(index, steps.length - 1)];
  const last = index >= steps.length - 1;
  const [spot, setSpot] = useState<Box | null>(null);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  const cardRef = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState({ w: 300, h: 160 });

  const prepareRef = useRef(onPrepare);
  prepareRef.current = onPrepare;
  useEffect(() => {
    prepareRef.current(step);
  }, [step]);

  // 每帧量一次：目标的位置、窗口大小、卡片大小。另外每 200ms 兜底量一次（窗口在后台时浏览器会停掉逐帧回调）
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const v = { w: window.innerWidth, h: window.innerHeight };
      setView((o) => (o.w === v.w && o.h === v.h ? o : v));
      const el = step.target ? document.querySelector<HTMLElement>(step.target) : null;
      const r = el?.getBoundingClientRect();
      const box = r && r.width > 0 && r.height > 0 ? spotBox({ left: r.left, top: r.top, width: r.width, height: r.height }, v) : null;
      setSpot((o) => (sameBox(o, box) ? o : box));
      const c = cardRef.current;
      if (c) setCard((o) => (o.w === c.offsetWidth && o.h === c.offsetHeight ? o : { w: c.offsetWidth, h: c.offsetHeight }));
    };
    const tick = () => {
      measure();
      raf = requestAnimationFrame(tick);
    };
    tick();
    const timer = window.setInterval(measure, 200);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
    };
  }, [step]);

  const next = () => (last ? onClose() : setIndex((i) => i + 1));
  const prev = () => setIndex((i) => Math.max(0, i - 1));
  const nextRef = useRef(next);
  nextRef.current = next;
  const prevRef = useRef(prev);
  prevRef.current = prev;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // 导航开着时应用的快捷键都不响应；← / → / Enter 翻页，Esc 跳过
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") closeRef.current();
      else if (e.key === "ArrowRight" || e.key === "Enter") nextRef.current();
      else if (e.key === "ArrowLeft") prevRef.current();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const pos = placeCard(spot, card, view);

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="新手导航">
      {/* 挡住框外的点击，不会误点到后面的界面；框里那一块能点（比如「选择文件夹…」） */}
      {spot ? (
        <>
          <div className="tour-block" style={{ left: 0, top: 0, right: 0, height: spot.top }} />
          <div className="tour-block" style={{ left: 0, top: spot.top + spot.height, right: 0, bottom: 0 }} />
          <div className="tour-block" style={{ left: 0, top: spot.top, width: spot.left, height: spot.height }} />
          <div className="tour-block" style={{ left: spot.left + spot.width, top: spot.top, right: 0, height: spot.height }} />
        </>
      ) : (
        <div className="tour-block dim" style={{ inset: 0 }} />
      )}
      {spot && <div className="tour-spot" style={{ left: spot.left, top: spot.top, width: spot.width, height: spot.height }} />}
      <div ref={cardRef} className="tour-card" style={{ left: pos.left, top: pos.top }}>
        <div className="tour-count muted small">
          {index + 1} / {steps.length}
        </div>
        <h3>{step.title}</h3>
        <p>{step.text}</p>
        <div className="tour-actions">
          <Btn className="link-quiet" onClick={onClose}>
            跳过
          </Btn>
          <span className="tour-grow" />
          {index > 0 && (
            <Btn className="ghost" onClick={prev}>
              上一步
            </Btn>
          )}
          <Btn className="primary" onClick={next}>
            {last ? "开始用吧" : "下一步"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
