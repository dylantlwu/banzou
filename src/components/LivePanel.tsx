import { useEffect, useRef, useState } from "react";
import { type InputDevice, listInputs } from "../audio/recorder";
import { type LiveInfo, getLiveInfo, openLiveWindow } from "../live/liveSync";
import type { GoLiveApi } from "../live/useGoLive";
import type { LivePosition, Settings } from "../settings";
import { NOTE_NAMES } from "../tune/autotune";
import { Btn } from "./Btn";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
  live: GoLiveApi;
}

const COLORS = [
  ["#ffffff", "白"],
  ["#ffe066", "黄"],
  ["#ff8fb1", "粉"],
  ["#7fe7ff", "青"],
] as const;

const POSITIONS: [LivePosition, string][] = [
  ["bottom", "底部"],
  ["center", "居中"],
  ["top", "顶部"],
];

const FX: [Settings["liveFx"], string][] = [
  [null, "不加"],
  ["clean", "干净"],
  ["pop", "流行"],
  ["warm", "温暖"],
];

function noteName(m: number) {
  if (!Number.isFinite(m)) return "—";
  const r = Math.round(m);
  return `${NOTE_NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
}

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:` : ""}${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** 直播面板（PRD 4.7）：一键开播、推流设置、直播修音、歌词样式 */
export function LivePanel({ settings, onChange, onClose, live }: Props) {
  const [info, setInfo] = useState<LiveInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [inputs, setInputs] = useState<InputDevice[]>([]);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getLiveInfo()
      .then(setInfo)
      .catch((e) => setError(String(e)));
    listInputs()
      .then(setInputs)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(`${info.url}?audio=1`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      urlRef.current?.select();
      setError("没能自动复制，地址已选中，按 ⌘C 复制");
    }
  };

  const busy = live.phase === "starting" || live.phase === "stopping";
  const on = live.phase === "live" || live.phase === "ready";
  const obs = live.obs;
  const statusText =
    live.phase === "starting"
      ? "正在准备：打开 OBS、建场景…"
      : live.phase === "stopping"
        ? "正在结束…"
        : live.phase === "live" || obs?.streaming
          ? `● 直播中 ${clock(obs?.durationMs ?? 0)}${obs && obs.congestion > 0.3 ? " · 网络有点堵" : ""}`
          : live.phase === "ready"
            ? obs?.connected
              ? "OBS 已准备好（没填推流码，没有开始推流）"
              : "声音和歌词已准备好"
            : obs && !obs.installed
              ? "没有安装 OBS"
              : "还没开始";
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const db = 20 * Math.log10(live.peak + 1e-6);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog live-dialog" role="dialog" aria-label="直播">
        <div className="live-head">
          <h2>直播</h2>
          <span className={live.phase === "live" || obs?.streaming ? "live-pill on" : "live-pill"}>{statusText}</span>
        </div>

        <div className="golive">
          {on ? (
            <Btn className="primary golive-btn stop" onClick={() => void live.stop()} disabled={busy}>
              结束直播
            </Btn>
          ) : (
            <Btn className="primary golive-btn" onClick={() => void live.start()} disabled={busy}>
              {busy ? "准备中…" : "● 开始直播"}
            </Btn>
          )}
          {live.phase === "ready" && settings.streamKey && settings.streamServer && (
            <Btn className="ghost" onClick={() => void live.start()} disabled={busy}>
              开始推流
            </Btn>
          )}
          <p className="muted small">
            一键：打开歌词同步和直播修音，打开 OBS、建好「伴奏歌词」场景、开始推流。你的耳机里听原声（插在麦克风的耳机孔上），观众听到的是修过的。
          </p>
        </div>

        {(on || live.phase === "starting") && (
          <div className="golive-status small">
            <div>
              声音：
              {live.micError ? <span className="error-text">{live.micError}（现在只推伴奏和歌词）</span> : "麦克风 → 实时修音 → 直播"}
              <span className="meter inline">
                <span className={`meter-fill ${live.peak > 0.95 ? "clip" : db > -30 ? "good" : "low"}`} style={{ width: `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%` }} />
              </span>
            </div>
            {settings.liveTune && live.info && Number.isFinite(live.info.midi) && (
              <div className="muted">
                我 {noteName(live.info.midi)} → 目标 {noteName(live.info.target)} · 修正 {live.info.cents > 0 ? "+" : ""}
                {Math.round(live.info.cents)} 音分
              </div>
            )}
            {live.steps.length > 0 && <div className="muted">{live.steps.join(" · ")}</div>}
          </div>
        )}
        {(live.error || error) && <p className="error-text small">{live.error ?? error}</p>}

        <details className="live-section" open={!settings.streamKey}>
          <summary>推流设置（TikTok）</summary>
          <div className="field">
            <label htmlFor="stream-server">推流地址（Server URL）</label>
            <input
              id="stream-server"
              className="url-input"
              placeholder="rtmp://…"
              value={settings.streamServer}
              onChange={(e) => onChange({ streamServer: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="stream-key">推流码（Stream Key）</label>
            <div className="field-row">
              <input
                id="stream-key"
                className="url-input"
                type={showKey ? "text" : "password"}
                value={settings.streamKey}
                onChange={(e) => onChange({ streamKey: e.target.value })}
              />
              <Btn className="ghost" onClick={() => setShowKey((v) => !v)}>
                {showKey ? "隐藏" : "显示"}
              </Btn>
            </div>
            <p className="muted small">
              在 TikTok 的直播设置里找（电脑推流 / LIVE Producer）。只存在这台电脑上；推流码相当于直播密码，别发给别人。不填也能点开始：会把 OBS 场景准备好，只是不推流。
            </p>
          </div>
        </details>

        <details className="live-section" open>
          <summary>直播修音</summary>
          <label className="small check">
            <input type="checkbox" checked={settings.liveTune} onChange={(e) => onChange({ liveTune: e.target.checked })} />
            实时修音（往原唱旋律上修；原唱没在唱的地方吸到调内音）
          </label>
          <div className="live-style">
            <span className="muted small">强度</span>
            <input type="range" min={0} max={1} step={0.05} value={settings.liveTuneStrength} onChange={(e) => onChange({ liveTuneStrength: Number(e.target.value) })} disabled={!settings.liveTune} />
            <span className="small">{pct(settings.liveTuneStrength)}</span>
          </div>
          <div className="live-style">
            <span className="muted small">自然</span>
            <input type="range" min={0} max={1} step={0.05} value={settings.liveTuneSpeed} onChange={(e) => onChange({ liveTuneSpeed: Number(e.target.value) })} disabled={!settings.liveTune} />
            <span className="muted small">电音</span>
          </div>
          <div className="live-style">
            <span className="muted small">效果</span>
            <div className="segmented">
              {FX.map(([v, label]) => (
                <Btn key={label} className={settings.liveFx === v ? "seg active" : "seg"} onClick={() => onChange({ liveFx: v })}>
                  {label}
                </Btn>
              ))}
            </div>
          </div>
          <div className="live-style">
            <span className="muted small">人声</span>
            <input type="range" min={0} max={1.5} step={0.05} value={settings.liveVoiceGain} onChange={(e) => onChange({ liveVoiceGain: Number(e.target.value) })} />
            <span className="muted small">伴奏</span>
            <input type="range" min={0} max={1.5} step={0.05} value={settings.liveAccGain} onChange={(e) => onChange({ liveAccGain: Number(e.target.value) })} />
          </div>
          <div className="live-style">
            <span className="muted small">麦克风</span>
            <select
              value={settings.liveMicId}
              onChange={(e) => {
                onChange({ liveMicId: e.target.value });
                if (on) window.setTimeout(() => void live.restartVoice(), 0);
              }}
            >
              <option value="">自动（不用蓝牙麦克风）</option>
              {inputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId} disabled={d.bluetooth}>
                  {d.label}
                  {d.bluetooth ? "（蓝牙，不能用）" : ""}
                </option>
              ))}
            </select>
          </div>
          <p className="muted small">直播里人声比你唱的晚约 0.1 秒（修音和传输），伴奏会一起往后对齐，观众听不出来。直播时别开 OBS 的「监听」。</p>
        </details>

        <details className="live-section">
          <summary>歌词样式</summary>
          <div className="live-style">
            <span className="muted small">字号</span>
            <input type="range" min={24} max={140} value={settings.liveFontSize} onChange={(e) => onChange({ liveFontSize: Number(e.target.value) })} />
            <span className="small">{settings.liveFontSize}</span>
          </div>
          <div className="live-style">
            <span className="muted small">颜色</span>
            {COLORS.map(([c, name]) => (
              <button
                key={c}
                type="button"
                className={settings.liveColor.toLowerCase() === c ? "swatch active" : "swatch"}
                style={{ background: c }}
                title={name}
                onClick={() => onChange({ liveColor: c })}
              />
            ))}
            <input type="color" value={settings.liveColor} onChange={(e) => onChange({ liveColor: e.target.value })} />
          </div>
          <div className="live-style">
            <span className="muted small">位置</span>
            <div className="segmented">
              {POSITIONS.map(([p, label]) => (
                <Btn key={p} className={settings.livePosition === p ? "seg active" : "seg"} onClick={() => onChange({ livePosition: p })}>
                  {label}
                </Btn>
              ))}
            </div>
            <label className="small check">
              <input type="checkbox" checked={settings.liveShowNext} onChange={(e) => onChange({ liveShowNext: e.target.checked })} />
              显示下一句
            </label>
          </div>
          <div className="live-preview" style={{ color: settings.liveColor }}>
            <div style={{ fontSize: Math.round(settings.liveFontSize * 0.4) }}>风吹过 窗外的晚霞</div>
            {settings.liveShowNext && <div style={{ fontSize: Math.round(settings.liveFontSize * 0.4 * 0.62), opacity: 0.78 }}>我数着路灯慢慢回家</div>}
          </div>
        </details>

        <details className="live-section">
          <summary>高级（手动接 OBS、歌词窗口）</summary>
          <label className="small check">
            <input type="checkbox" checked={settings.liveEnabled} onChange={(e) => onChange({ liveEnabled: e.target.checked })} />
            歌词同步到叠加层
          </label>
          <div className="field">
            <label>叠加层地址（OBS 浏览器源，勾选「通过 OBS 控制音频」就有声音）</label>
            <div className="field-row">
              <input ref={urlRef} className="url-input" readOnly value={info ? `${info.url}?audio=1` : "…"} onFocus={(e) => e.target.select()} />
              <Btn className="ghost" onClick={() => void copy()} disabled={!info}>
                {copied ? "已复制" : "复制"}
              </Btn>
            </div>
          </div>
          <div className="field-row">
            <Btn className="ghost" onClick={() => openLiveWindow("green").catch((e) => setError(String(e)))}>
              歌词窗口 · 绿幕
            </Btn>
            <Btn className="ghost" onClick={() => openLiveWindow("black").catch((e) => setError(String(e)))}>
              歌词窗口 · 黑底
            </Btn>
          </div>
          <p className="muted small">
            提醒：直播别用 AirPods 麦克风（蓝牙会切到通话音质）；商业歌曲伴奏可能被平台静音。
          </p>
        </details>

        <div className="dialog-actions">
          <Btn className="primary" onClick={onClose}>
            完成
          </Btn>
        </div>
      </div>
    </div>
  );
}
