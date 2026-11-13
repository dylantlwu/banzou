import { invoke } from "@tauri-apps/api/core";

/** 外语学唱的后端接口（PRD 4.12）：老师笔记、问老师、老师念出来 */

export type Scope = "global" | "song";

export interface Note {
  text: string;
  /** 行尾〔…〕：什么时候、从哪记下的 */
  tag: string | null;
}

export interface NotesView {
  global: Note[];
  song: Note[];
  globalPath: string;
  songPath: string | null;
}

/** 老师在对话里记下的一条笔记 */
export interface Remembered {
  scope: Scope;
  text: string;
  /** 替换掉的旧笔记 */
  replaced?: string;
  replacedScope?: Scope;
}

export interface Turn {
  role: "me" | "teacher";
  text: string;
  remembered?: Remembered[];
}

export interface Spoken {
  /** mp3 的 base64 */
  audio: string;
  /** 实际念的文字（按笔记里的读音替换后） */
  said: string;
  cached: boolean;
  ms: number;
}

export const loadNotes = (title?: string) => invoke<NotesView>("learn_notes", { title: title ?? null });

/** index 为空 = 加一条；text 为空 = 删掉 */
export const setNote = (scope: Scope, title: string | null, index: number | null, text: string) =>
  invoke<void>("learn_note_set", { scope, title, index, text });

export const undoRemember = (title: string, remembered: Remembered) => invoke<void>("learn_undo_remember", { title, remembered });

export const loadChat = (title: string) => invoke<Turn[]>("learn_chat", { title });

export const clearChat = (title: string) => invoke<void>("learn_chat_clear", { title });

export const askTeacher = (title: string, question: string) => invoke<Turn>("learn_ask", { title, question });

export const speakLine = (title: string | null, text: string) => invoke<Spoken>("learn_speak", { title, text });

export const SCOPE_NAME: Record<Scope, string> = { global: "所有歌", song: "这首歌" };
