import { useState } from "react";
import { type UpdateInfo, describeUpdateError, restart } from "../update/updater";
import { Btn } from "./Btn";

interface Props {
  update: UpdateInfo;
  onClose: () => void;
}

type Phase = { kind: "ask" } | { kind: "downloading"; progress: number | null } | { kind: "ready" } | { kind: "error"; message: string };

/** 右下角的更新提示：有新版本 → 下载中 → 重启生效（PRD 4.10） */
export function UpdateCard({ update, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "ask" });

  const install = async () => {
    setPhase({ kind: "downloading", progress: 0 });
    try {
      await update.install((progress) => setPhase({ kind: "downloading", progress }));
      setPhase({ kind: "ready" });
    } catch (e) {
      setPhase({ kind: "error", message: describeUpdateError(e) });
    }
  };

  const notes = update.notes
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6);

  return (
    <div className="update-card" role="status" aria-label="软件更新">
      {phase.kind === "ask" && (
        <>
          <strong>有新版本 {update.version}</strong>
          {notes.length > 0 && (
            <ul className="update-notes small">
              {notes.map((l, i) => (
                <li key={i}>{l.replace(/^[-*•]\s*/, "")}</li>
              ))}
            </ul>
          )}
          <div className="update-actions">
            <Btn className="ghost" onClick={onClose}>
              以后再说
            </Btn>
            <Btn className="primary" onClick={() => void install()}>
              更新
            </Btn>
          </div>
        </>
      )}
      {phase.kind === "downloading" && (
        <>
          <strong>正在下载 {update.version}…</strong>
          <progress max={1} value={phase.progress ?? undefined} />
          <span className="muted small">可以接着用，下载完再重启。</span>
        </>
      )}
      {phase.kind === "ready" && (
        <>
          <strong>{update.version} 已经装好</strong>
          <span className="muted small">重启后生效。第一次录音时 macOS 可能会再问一次麦克风权限，点「允许」。</span>
          <div className="update-actions">
            <Btn className="ghost" onClick={onClose}>
              稍后
            </Btn>
            <Btn className="primary" onClick={() => void restart()}>
              现在重启
            </Btn>
          </div>
        </>
      )}
      {phase.kind === "error" && (
        <>
          <strong>没更新成功</strong>
          <span className="small error-text">{phase.message}</span>
          <div className="update-actions">
            <Btn className="ghost" onClick={onClose}>
              关闭
            </Btn>
            <Btn className="ghost" onClick={() => void install()}>
              重试
            </Btn>
          </div>
        </>
      )}
    </div>
  );
}
