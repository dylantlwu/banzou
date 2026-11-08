import type { RecordingApi } from "../takes/useRecording";
import { formatTime } from "../utils/time";
import { Btn } from "./Btn";

interface Props {
  rec: RecordingApi;
  /** 当前播放位置（录音中显示已录时长） */
  position: number;
  recordStart: number;
  canPunch: boolean;
  loopLabel: string | null;
}

/** 电平表：太小 / 合适 / 爆音三色 */
function Meter({ level }: { level: number }) {
  const db = 20 * Math.log10(level + 1e-6);
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const zone = level > 0.95 ? "clip" : db > -30 ? "good" : "low";
  return (
    <div className="meter" title={`${db.toFixed(0)} dB`}>
      <div className={`meter-fill ${zone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 录音准备栏 + 录音中状态（PRD 4.4） */
export function RecordBar({ rec, position, recordStart, canPunch, loopLabel }: Props) {
  const busy = rec.phase === "noise" || rec.phase === "countdown" || rec.phase === "recording" || rec.phase === "saving" || rec.phase === "calibrating";

  if (rec.phase === "noise") {
    return (
      <div className="record-bar live">
        <span className="rec-dot" /> 请保持安静 2 秒，正在录环境底噪（修音时降噪用）…
        <Btn className="ghost" onClick={rec.stop}>
          取消
        </Btn>
      </div>
    );
  }
  if (rec.phase === "countdown") {
    return (
      <div className="record-bar live">
        <span className="countdown">{rec.countdown}</span> 准备开唱…
        <Btn className="ghost" onClick={rec.stop}>
          取消
        </Btn>
      </div>
    );
  }
  if (rec.phase === "recording") {
    return (
      <div className="record-bar live recording">
        <span className="rec-dot blink" /> 录音中 {formatTime(Math.max(0, position - recordStart))}
        <Meter level={rec.level} />
        <Btn className="primary" onClick={rec.stop}>
          停止（空格）
        </Btn>
      </div>
    );
  }
  if (rec.phase === "saving") return <div className="record-bar live">正在保存、按原唱对齐…</div>;
  if (rec.phase === "calibrating") {
    return (
      <div className="record-bar live">
        <span className="rec-dot blink" /> 跟着耳机里的 8 下节拍，每一下对着麦克风说「嗒」…
      </div>
    );
  }

  const kind = rec.outputKind;
  return (
    <div className="record-bar">
      <div className="rec-row">
        <label className="rec-field">
          <span className="muted small">麦克风</span>
          <select
            value={rec.deviceId ?? ""}
            onChange={(e) => rec.setDeviceId(e.target.value)}
            disabled={busy || rec.phase === "opening"}
          >
            {rec.inputs.length === 0 && <option value="">{rec.phase === "opening" ? "正在打开…" : "没有找到麦克风"}</option>}
            {rec.inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId} disabled={d.bluetooth}>
                {d.label}
                {d.bluetooth ? "（蓝牙，不能用来录）" : ""}
              </option>
            ))}
          </select>
        </label>
        <Meter level={rec.level} />
        <span className={kind === "speaker" ? "route bad" : "route"} title="当前输出设备">
          {rec.routeName}
          {kind === "speaker" ? " · 外放" : kind === "bluetooth" ? " · 蓝牙" : kind === "wired" ? " · 有线耳机" : ""}
        </span>
        {(kind === "wired" || kind === "usb") && (
          <label className="small check" title="把自己的声音实时送回耳机（只适合有线耳机）">
            <input type="checkbox" checked={rec.monitor} onChange={(e) => rec.setMonitor(e.target.checked)} />
            耳返
          </label>
        )}
        <span className="spacer" />
        <Btn className="ghost" onClick={rec.close}>
          收起
        </Btn>
      </div>

      <div className="rec-row">
        <div className="segmented" aria-label="录音范围">
          <Btn className={rec.range === "whole" ? "seg active" : "seg"} onClick={() => rec.setRange("whole")}>
            整首
          </Btn>
          <Btn className={rec.range === "here" ? "seg active" : "seg"} onClick={() => rec.setRange("here")}>
            从当前位置
          </Btn>
          <Btn
            className={rec.range === "punch" ? "seg active" : "seg"}
            onClick={() => rec.setRange("punch")}
            disabled={!canPunch}
            title={canPunch ? "把选中那遍的 A-B 段重录一次" : "先在录音列表选中一遍，再用 A / B 设好区间"}
          >
            补录 {loopLabel ?? "A-B"}
          </Btn>
        </div>
        <span className="muted small" title="耳机输出 + 麦克风输入的总延迟，录完自动扣掉">
          延迟 {rec.latencyMs}ms{rec.calibrated ? "（已校准）" : "（未校准）"}
        </span>
        <Btn className="ghost" onClick={() => void rec.calibrate()} disabled={rec.phase !== "prep"}>
          {rec.calibrated ? "重新校准" : "校准延迟"}
        </Btn>
        <span className="spacer" />
        <Btn className="primary rec-start" onClick={() => void rec.start()} disabled={rec.phase !== "prep" || rec.inputs.length === 0}>
          ● 开始录音（R）
        </Btn>
      </div>

      {kind === "speaker" && <p className="rec-msg error-text">现在是外放：伴奏会被一起录进去，请戴上耳机（只想清唱可以忽略）。</p>}
      {kind === "bluetooth" && (
        <p className="rec-msg muted">
          用蓝牙耳机听伴奏没问题，录音用的是上面选的麦克风。AirPods Pro / Max 可以开「通透模式」听到自己的声音；建议关掉空间音频。
        </p>
      )}
      {!rec.calibrated && rec.phase === "prep" && (
        <p className="rec-msg muted">第一次用这个耳机录音，建议先点「校准延迟」，录出来和伴奏对得更准。</p>
      )}
      {rec.inputWarning && <p className="rec-msg error-text">{rec.inputWarning}</p>}
      {rec.error && <p className="rec-msg error-text">{rec.error}</p>}
      {rec.notice && (
        <p className="rec-msg notice">
          {rec.notice}
          <Btn className="link" onClick={rec.dismissNotice}>
            知道了
          </Btn>
        </p>
      )}
    </div>
  );
}
