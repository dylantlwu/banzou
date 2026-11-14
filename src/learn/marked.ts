/**
 * 老师说话里的 `原文{读音}`（PRD 4.12）：屏幕显示原文加注音，念的时候只念读音（后端 learn::marked）。
 * `原文{?}` = 读音待确认。原文 = `{` 前面连着的一串字，遇到空白、标点就停。两边拆法要一致。
 * 没有花括号的旧文字整段原样显示。
 */

export type MarkedPiece = string | { orig: string; reading: string | null };

const MAX_READING = 40;
const BOUNDARY = new Set(Array.from("{}。，、！？：；「」『』《》〈〉（）【】“”‘’…—～〜·,.!?:;()[]\"/／*`"));

export const isBoundary = (c: string) => /\s/.test(c) || BOUNDARY.has(c);

const isHiragana = (c: string) => c >= "\u3041" && c <= "\u309f";

/** 片假名转平假名（比较读音开头用） */
const toHiragana = (s: string) => s.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

const isPending = (inner: string) => ["?", "？", "待确认", "读音待确认"].includes(inner.trim());

function pushText(out: MarkedPiece[], s: string) {
  if (!s) return;
  const last = out[out.length - 1];
  if (typeof last === "string") out[out.length - 1] = last + s;
  else out.push(s);
}

export function parseMarked(text: string): MarkedPiece[] {
  const chars = Array.from(text);
  const out: MarkedPiece[] = [];
  let plain: string[] = [];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "{") {
      let len = -1;
      for (let k = 0; k <= MAX_READING && i + 1 + k < chars.length; k++) {
        const d = chars[i + 1 + k];
        if (d === "{" || d === "\n") break;
        if (d === "}") {
          len = k;
          break;
        }
      }
      if (len >= 0) {
        const inner = chars.slice(i + 1, i + 1 + len).join("");
        let cut = plain.length;
        while (cut > 0 && !isBoundary(plain[cut - 1])) cut--;
        // 原文前头的平假名（助词、上一个词的送假名：君{きみ}を呼{よ}ぶ 的「を」）不算原文，除非读音也这样开头
        let lead = 0;
        while (cut + lead < plain.length && isHiragana(plain[cut + lead])) lead++;
        const leadText = plain.slice(cut, cut + lead).join("");
        if (lead > 0 && cut + lead < plain.length && !toHiragana(inner.trim()).startsWith(leadText)) cut += lead;
        const orig = plain.slice(cut).join("");
        pushText(out, plain.slice(0, cut).join(""));
        plain = [];
        const reading = isPending(inner) ? null : inner.trim();
        if (!orig) {
          // 前面没有原文：只显示读音，不让人看到花括号
          if (reading) pushText(out, reading);
        } else if (reading === "") {
          pushText(out, orig);
        } else {
          out.push({ orig, reading });
        }
        i += len + 2;
        continue;
      }
    }
    plain.push(chars[i]);
    i++;
  }
  pushText(out, plain.join(""));
  return out;
}

/** 去掉标记的纯文字（复制、提示里用）：原文（读音） */
export function plainMarked(text: string): string {
  return parseMarked(text)
    .map((p) => (typeof p === "string" ? p : p.reading ? `${p.orig}（${p.reading}）` : `${p.orig}（读音待确认）`))
    .join("");
}
