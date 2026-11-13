import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { TeacherNotes } from "../learn/TeacherNotes";
import { type Note as TeacherNote, loadNotes } from "../learn/api";
import { Btn } from "./Btn";

/** 后端 ai::AiStatus：key 只给末四位 */
interface AiStatus {
  claudeTail: string | null;
  /** 新版控制台 API Key 的末四位 */
  doubaoKeyTail: string | null;
  /** 旧版控制台：APP ID 和 Access Token 末四位 */
  doubaoAppId: string | null;
  doubaoTokenTail: string | null;
  speaker: string;
  speechRate: number;
}

interface Note {
  text: string;
  error?: boolean;
  busy?: boolean;
}

/** 试听用的句子：中文里夹日语，顺便看豆包能不能把混说念对 */
export const SAMPLE_LINE = "你好，我是你的老师。这首歌叫「夏実」，念「かじつ」，不是「なつみ」。";

const RATES = [
  { value: -25, label: "慢一点" },
  { value: 0, label: "正常" },
  { value: 25, label: "快一点" },
];

const DEFAULT_SPEAKER = "zh_female_xiaohe_uranus_bigtts";

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

/** 设置里的「AI 老师」：Claude API key、豆包语音，各自能测试（PRD 4.12） */
export function AiSettings() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [editClaude, setEditClaude] = useState(false);
  const [claudeKey, setClaudeKey] = useState("");
  const [claudeNote, setClaudeNote] = useState<Note | null>(null);
  const [editDoubao, setEditDoubao] = useState(false);
  const [oldConsole, setOldConsole] = useState(false);
  const [doubaoKey, setDoubaoKey] = useState("");
  const [appId, setAppId] = useState("");
  const [token, setToken] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [voiceNote, setVoiceNote] = useState<Note | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [globalNotes, setGlobalNotes] = useState<TeacherNote[] | null>(null);

  const reloadNotes = async () => {
    try {
      setGlobalNotes((await loadNotes()).global);
    } catch {
      setGlobalNotes(null);
    }
  };

  const reload = async () => {
    const s = await invoke<AiStatus>("ai_status");
    setStatus(s);
    setSpeaker(s.speaker);
    return s;
  };

  useEffect(() => {
    void reload().catch((e) => setClaudeNote({ text: String(e), error: true }));
    void reloadNotes();
    return () => audioRef.current?.pause();
  }, []);

  if (!status) return null;
  const hasClaude = status.claudeTail !== null;
  const hasDoubao = status.doubaoKeyTail !== null || (status.doubaoAppId !== null && status.doubaoTokenTail !== null);

  const saveClaude = async (key: string) => {
    try {
      await invoke("ai_key_save", { key });
      setClaudeKey("");
      setEditClaude(false);
      const s = await reload();
      setClaudeNote(s.claudeTail ? { text: "存好了，点「测试」看看能不能用" } : { text: "已删除" });
    } catch (e) {
      setClaudeNote({ text: String(e), error: true });
    }
  };

  const testClaude = async () => {
    setClaudeNote({ text: "正在问 Claude…", busy: true });
    try {
      const r = await invoke<{ text: string; model: string; ms: number }>("ai_test_claude");
      setClaudeNote({ text: `「${r.text}」· ${r.model} · ${secs(r.ms)}` });
    } catch (e) {
      setClaudeNote({ text: String(e), error: true });
    }
  };

  const saveDoubao = async (patch: Record<string, unknown>, note?: string) => {
    try {
      await invoke("ai_save_tts", { patch });
      await reload();
      if (note) setVoiceNote({ text: note });
      return true;
    } catch (e) {
      setVoiceNote({ text: String(e), error: true });
      return false;
    }
  };

  const canSave = oldConsole ? appId.trim() !== "" && token.trim() !== "" : doubaoKey.trim() !== "";
  const saveCredentials = async () => {
    if (!canSave) return;
    const patch = oldConsole ? { appId, token } : { apiKey: doubaoKey };
    const ok = await saveDoubao(patch, "存好了，点「试听」看看能不能用");
    if (ok) {
      setDoubaoKey("");
      setAppId("");
      setToken("");
      setEditDoubao(false);
    }
  };

  const listen = async () => {
    audioRef.current?.pause();
    setVoiceNote({ text: "正在合成…", busy: true });
    try {
      const r = await invoke<{ audio: string; bytes: number; ms: number }>("ai_test_tts", { text: SAMPLE_LINE });
      const audio = new Audio(`data:audio/mpeg;base64,${r.audio}`);
      audioRef.current = audio;
      setVoiceNote({ text: `合成用了 ${secs(r.ms)}，正在播放：${SAMPLE_LINE}` });
      await audio.play();
    } catch (e) {
      setVoiceNote({ text: String(e), error: true });
    }
  };

  return (
    <div className="field ai-settings">
      <label>AI 老师（外语学唱）</label>
      <p className="muted small">key 只存在这台 Mac 上。老师要说的话会发给 Claude 和豆包语音，你的录音不会发出去。</p>

      <div className="ai-row">
        <span className="ai-name">Claude</span>
        {hasClaude && !editClaude ? (
          <>
            <span className="muted">已填（…{status.claudeTail}）</span>
            <Btn className="ghost" onClick={() => setEditClaude(true)}>
              换一个
            </Btn>
            <Btn className="ghost" onClick={() => void testClaude()} disabled={claudeNote?.busy}>
              测试
            </Btn>
          </>
        ) : (
          <>
            <input
              className="ai-input"
              type="password"
              placeholder="粘贴 API key（sk-ant-…）"
              value={claudeKey}
              onChange={(e) => setClaudeKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && claudeKey.trim() && void saveClaude(claudeKey)}
              autoComplete="off"
              spellCheck={false}
            />
            <Btn className="primary" onClick={() => void saveClaude(claudeKey)} disabled={!claudeKey.trim()}>
              保存
            </Btn>
            {hasClaude && (
              <>
                <Btn className="ghost" onClick={() => void saveClaude("")}>
                  删除
                </Btn>
                <Btn className="ghost" onClick={() => setEditClaude(false)}>
                  取消
                </Btn>
              </>
            )}
          </>
        )}
      </div>
      {!hasClaude && !claudeNote && <p className="muted small">在 console.anthropic.com 先充值（Billing），再到 API Keys 里新建一个。</p>}
      {claudeNote && <p className={claudeNote.error ? "small error-text" : "muted small"}>{claudeNote.text}</p>}

      <div className="ai-row">
        <span className="ai-name">豆包语音</span>
        {hasDoubao && !editDoubao ? (
          <>
            <span className="muted">
              {status.doubaoKeyTail !== null
                ? `已填 API Key（…${status.doubaoKeyTail}）`
                : `APP ID ${status.doubaoAppId} · Token …${status.doubaoTokenTail}`}
            </span>
            <Btn className="ghost" onClick={() => setEditDoubao(true)}>
              换一个
            </Btn>
          </>
        ) : (
          <>
            {oldConsole ? (
              <>
                <input
                  className="ai-input short"
                  placeholder="APP ID"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <input
                  className="ai-input"
                  type="password"
                  placeholder="Access Token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void saveCredentials()}
                  autoComplete="off"
                  spellCheck={false}
                />
              </>
            ) : (
              <input
                className="ai-input"
                type="password"
                placeholder="粘贴 API Key"
                value={doubaoKey}
                onChange={(e) => setDoubaoKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void saveCredentials()}
                autoComplete="off"
                spellCheck={false}
              />
            )}
            <Btn className="primary" onClick={() => void saveCredentials()} disabled={!canSave}>
              保存
            </Btn>
            {hasDoubao && (
              <Btn className="ghost" onClick={() => setEditDoubao(false)}>
                取消
              </Btn>
            )}
          </>
        )}
      </div>
      {(!hasDoubao || editDoubao) && (
        <p className="muted small">
          {oldConsole
            ? "旧版控制台：在应用管理里看 APP ID 和 Access Token。"
            : "火山引擎控制台 → 豆包语音 → API Key 管理，新建一个，复制过来。"}{" "}
          <button type="button" className="link" onClick={() => setOldConsole(!oldConsole)}>
            {oldConsole ? "改用 API Key" : "我是旧版控制台（APP ID + Token）"}
          </button>
        </p>
      )}

      {hasDoubao && (
        <div className="ai-row">
          <span className="ai-name">音色</span>
          <input
            className="ai-input"
            value={speaker}
            onChange={(e) => setSpeaker(e.target.value)}
            onBlur={() => speaker.trim() !== status.speaker && void saveDoubao({ speaker: speaker.trim() || DEFAULT_SPEAKER })}
            spellCheck={false}
            title="音色 ID，在火山引擎控制台的音色列表里找；清空恢复默认的「小何」"
          />
          <select value={status.speechRate} onChange={(e) => void saveDoubao({ speechRate: Number(e.target.value) })} aria-label="语速">
            {RATES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <Btn className="ghost" onClick={() => void listen()} disabled={voiceNote?.busy}>
            试听
          </Btn>
        </div>
      )}
      {voiceNote && <p className={voiceNote.error ? "small error-text" : "muted small"}>{voiceNote.text}</p>}

      <div className="ai-row">
        <span className="ai-name">老师笔记</span>
        <span className="muted small">我纠正过老师的事，所有歌都照做。每首歌自己的笔记在「学唱」里。</span>
      </div>
      {globalNotes && <TeacherNotes scope="global" title={null} notes={globalNotes} onChanged={() => void reloadNotes()} />}
    </div>
  );
}
