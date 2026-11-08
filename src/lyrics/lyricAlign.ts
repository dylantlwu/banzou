/**
 * 智能对齐：把歌词和「语音识别听到的字」逐字比对，定出每句的开唱时间。
 *
 * 1. 歌词、识别结果都拆成「字」（汉字一个一个，英文按单词），繁简、他她它等统一
 * 2. 用序列比对（允许漏字、多字、错字）把歌词的字对到识别出的字上，顺序不变
 * 3. 对上字足够多的句子：取第一个对上的字的时间，再用人声开口点微调
 * 4. 没对上的句子：按前后对上的句子插值（LRC 按原时间比例，纯文本按字数比例）
 * 5. 顺带找出差异：某句听到的和歌词不一样（错别字）、识别出一段歌词里没有的（漏句）
 *
 * 纯计算，便于测试。
 */
import type { LrcLine } from "./lrc";
import type { Onset } from "./vocalOnsets";

export interface Token {
  start: number;
  end: number;
  text: string;
}

// ---------- 拆字与归一 ----------

const T2S_PAIRS =
  "麽么麼么這这個个們们說说愛爱妳你祢你為为來来時时會会對对開开過过還还讓让經经後后從从見见聽听夢梦無无與与間间東东魚鱼薩萨裡里裏里樣样嗎吗長长風风頭头點点雖虽淚泪戀恋給给靜静學学錯错隻只難难邊边遠远謊谎話话誰谁傷伤結结實实種种應应該该總总愛爱寫写歡欢樂乐聲声帶带燈灯門门問问關关雲云電电飛飞機机車车馬马鳥鸟島岛爾尔畫画體体氣气們们幾几現现發发變变離离覺觉黃黄紅红綠绿藍蓝細细親亲壞坏懷怀讀读記记計计認认識识譜谱講讲誤误請请謝谢語语論论舊旧歲岁歸归歷历條条紙纸線线終终純纯絲丝網网罪罪醉醉漢汉義义滿满溫温澀涩濕湿濃浓灣湾燒烧熱热爭争狀状猶犹獨独獻献環环盡尽眾众睜睁碼码確确禮礼窮穷筆笔節节範范簡简糾纠紀纪約约級级紛纷練练織织繼继續续罵骂聞闻聯联腦脑臉脸興兴舉举艱艰藥药蘭兰處处號号蟲虫術术衛卫補补複复覽览觀观計计訴诉試试詩诗誠诚調调談谈證证讚赞貝贝負负貴贵買买賣卖賽赛趕赶跡迹躍跃軟软輕轻輸输辦办這这進进遊游運运過过達达違违遙遥適适遲迟選选還还鄉乡醫医針针鐘钟鋼钢錢钱鏡镜長长閃闪閉闭陽阳陰阴隊队際际隨随險险雙双雞鸡離离雜杂靈灵頁页順顺須须領领頻频顏颜願愿顯显飄飘飯饭餘余驚惊體体髮发鬥斗鬧闹齊齐龍龙";
const T2S = new Map<string, string>();
for (let i = 0; i + 1 < T2S_PAIRS.length; i += 2) T2S.set(T2S_PAIRS[i], T2S_PAIRS[i + 1]);
/** 识别时容易混的字统一成一个 */
const FOLD: Record<string, string> = { 她: "他", 它: "他", 祂: "他", 地: "的", 得: "的", 妳: "你", 噢: "哦", 喔: "哦" };

const CJK = /[㐀-鿿]/;

export function normalizeUnit(u: string): string {
  if (CJK.test(u)) {
    const s = T2S.get(u) ?? u;
    return FOLD[s] ?? s;
  }
  return u.toLowerCase().replace(/'/g, "");
}

/** 一句话拆成字（汉字）和单词（英文、数字） */
export function splitUnits(text: string): string[] {
  return text.match(/[㐀-鿿]|[A-Za-z0-9']+/g) ?? [];
}

interface HeardUnit {
  key: string;
  raw: string;
  start: number;
  end: number;
}

/** 识别结果拆成一个个字；一个片段里有多个字时按时间平分 */
export function heardUnits(tokens: Token[]): HeardUnit[] {
  const out: HeardUnit[] = [];
  for (const t of tokens) {
    const parts = splitUnits(t.text);
    if (parts.length === 0) continue;
    const step = (t.end - t.start) / parts.length;
    parts.forEach((raw, k) => {
      out.push({ key: normalizeUnit(raw), raw, start: t.start + k * step, end: t.start + (k + 1) * step });
    });
  }
  return out;
}

/** 语气词：识别出一串这种字不算「漏句」 */
const FILLER = new Set(["嗯", "啊", "哦", "呀", "哈", "呃", "唉", "哎", "喂", "嘿", "呜", "噢", "喔", "啦", "yeah", "oh", "ah", "uh", "hey", "ooh", "la", "na", "baby", "yo"]);

// ---------- 信息行 ----------

/** 作词、作曲、编曲这类信息行，以及「歌手 - 歌名」标题行，不是唱出来的 */
const CREDIT =
  /^(.{0,16}\s[-－–—]\s.+|(作?词|作?曲|编曲|編曲|制作人?|製作人?|监制|監製|混音|母带|母帶|和声|和聲|吉他|贝斯|貝斯|鼓|键盘|鍵盤|弦乐|弦樂|录音|錄音|OP|SP|出品|发行|發行|企划|企劃|统筹|統籌|Producer|Lyrics?|Composer|Arranger|Mix(ing)?|Master(ing)?)\s*[:：].*)$/i;

export function isCreditText(text: string): boolean {
  return CREDIT.test(text.trim());
}

// ---------- 对齐 ----------

/** 推算没对上的句子时，每个字大约唱多久 */
const SECONDS_PER_UNIT = 0.35;

const MATCH = 2;
const MISMATCH = -1;
const GAP_LYRIC = 1; // 歌词里的字没听到
const GAP_HEARD = 0.5; // 听到了歌词里没有的字（即兴、和声、重复）

interface Pair {
  lyric: number;
  heard: number;
  equal: boolean;
}

/** 半全局序列比对：识别结果头尾多出来的部分不扣分 */
export function alignSequences(lyric: string[], heard: string[]): Pair[] {
  const n = lyric.length;
  const m = heard.length;
  const W = m + 1;
  const score = new Float32Array((n + 1) * W);
  const move = new Uint8Array((n + 1) * W); // 1 斜对 2 歌词跳过 3 识别跳过
  for (let i = 1; i <= n; i++) {
    score[i * W] = -i * GAP_LYRIC;
    move[i * W] = 2;
  }
  for (let j = 1; j <= m; j++) move[j] = 3;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = lyric[i - 1] === heard[j - 1];
      const diag = score[(i - 1) * W + j - 1] + (same ? MATCH : MISMATCH);
      const up = score[(i - 1) * W + j] - GAP_LYRIC;
      const left = score[i * W + j - 1] - GAP_HEARD;
      // 分数相同时：错字尽量贴着前面对上的字（回溯时先跳过多听到的字），不要跑到一段即兴后面
      if (same ? diag >= up && diag >= left : diag > up && diag > left) {
        score[i * W + j] = diag;
        move[i * W + j] = 1;
      } else if (left >= up) {
        score[i * W + j] = left;
        move[i * W + j] = 3;
      } else {
        score[i * W + j] = up;
        move[i * W + j] = 2;
      }
    }
  }
  let j = 0;
  for (let k = 1; k <= m; k++) if (score[n * W + k] > score[n * W + j]) j = k;
  const pairs: Pair[] = [];
  let i = n;
  while (i > 0 && j > 0) {
    const mv = move[i * W + j];
    if (mv === 1) {
      pairs.push({ lyric: i - 1, heard: j - 1, equal: lyric[i - 1] === heard[j - 1] });
      i--;
      j--;
    } else if (mv === 2) i--;
    else j--;
  }
  return pairs.reverse();
}

export interface Suggestion {
  /** fix：这句听到的不一样；missing：听到了一段歌词里没有的 */
  kind: "fix" | "missing";
  /** fix 是要改的行；missing 是插在哪一行之前（可以等于行数，表示最后） */
  line: number;
  /** fix：改好之后的整句；missing：听到的那段 */
  heard: string;
  /** fix：改了哪些字，比如「碎→醉」 */
  changes?: string;
  time: number;
}

/** 一句里最多改几个字才算「错别字」；差得更多多半是识别听错了，不提示 */
const MAX_FIX_EDITS = 2;

export interface AlignResult {
  lines: LrcLine[];
  /** 靠识别对上的句数 / 应该唱的句数 */
  aligned: number;
  sung: number;
  suggestions: Suggestion[];
}

function joinRaw(units: HeardUnit[]): string {
  let s = "";
  for (const u of units) {
    const latin = !CJK.test(u.raw);
    if (latin && s && !s.endsWith(" ")) s += " ";
    s += u.raw;
    if (latin) s += " ";
  }
  return s.trim().replace(/ +(?=[㐀-鿿])/g, "");
}

/**
 * 只改听到不一样的字（错字替换、句中多出来的字插入），歌词里有但没听到的字保留 ——
 * 多半是识别漏听，不是歌词多写了。改动超过 MAX_FIX_EDITS 个字就不提示。
 */
function proposeFix(
  text: string,
  ps: Pair[],
  unitPos: number[],
  heard: HeardUnit[],
  paired: Set<number>,
): { text: string; changes: string } | null {
  const spans: { start: number; end: number }[] = [];
  const re = /[\u3400-\u9fff]|[A-Za-z0-9']+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) spans.push({ start: m.index, end: m.index + m[0].length });
  const replace = new Map<number, string>();
  const insertAfter = new Map<number, string[]>();
  const changes: string[] = [];
  ps.forEach((p, k) => {
    const pos = unitPos[p.lyric];
    if (!p.equal) {
      replace.set(pos, heard[p.heard].raw);
      changes.push(`${text.slice(spans[pos].start, spans[pos].end)}→${heard[p.heard].raw}`);
    }
    const next = ps[k + 1];
    if (next) {
      const extra: string[] = [];
      for (let h = p.heard + 1; h < next.heard; h++) {
        if (!paired.has(h) && !FILLER.has(heard[h].key)) extra.push(heard[h].raw);
      }
      if (extra.length) {
        insertAfter.set(pos, extra);
        changes.push(`+${extra.join("")}`);
      }
    }
  });
  const edits = replace.size + [...insertAfter.values()].reduce((n, e) => n + e.length, 0);
  if (edits === 0 || edits > MAX_FIX_EDITS) return null;
  let out = "";
  let cursor = 0;
  spans.forEach((sp, pos) => {
    out += text.slice(cursor, sp.start) + (replace.get(pos) ?? text.slice(sp.start, sp.end));
    const ins = insertAfter.get(pos);
    if (ins) out += ins.join("");
    cursor = sp.end;
  });
  out += text.slice(cursor);
  return out === text ? null : { text: out, changes: changes.join("，") };
}

/**
 * 按识别结果对齐歌词。lines 按歌词顺序给（LRC 按时间排好，纯文本按原顺序），
 * 返回同样顺序、同样数量的行（只改时间）。一句都对不上时返回 null。
 */
export function alignToTranscript(lines: LrcLine[], tokens: Token[], onsets: Onset[] = []): AlignResult | null {
  const heard = heardUnits(tokens);
  // 开头的信息行不参与
  const credit = lines.map((l, i) => i < 10 && l.text !== "" && isCreditText(l.text));
  const sungIdx = lines.map((_, i) => i).filter((i) => lines[i].text !== "" && !credit[i]);

  const lyricKeys: string[] = [];
  const unitLine: number[] = [];
  const unitPos: number[] = [];
  const lineUnits = new Map<number, number>();
  for (const i of sungIdx) {
    const units = splitUnits(lines[i].text);
    lineUnits.set(i, units.length);
    units.forEach((u, p) => {
      lyricKeys.push(normalizeUnit(u));
      unitLine.push(i);
      unitPos.push(p);
    });
  }
  if (lyricKeys.length === 0 || heard.length === 0) return null;

  const pairs = alignSequences(
    lyricKeys,
    heard.map((h) => h.key),
  );

  const pairedSet = new Set(pairs.map((p) => p.heard));
  // 每句对上的情况
  const perLine = new Map<number, Pair[]>();
  for (const p of pairs) {
    const line = unitLine[p.lyric];
    if (!perLine.has(line)) perLine.set(line, []);
    perLine.get(line)!.push(p);
  }

  const newTime = new Map<number, number>();
  const suggestions: Suggestion[] = [];
  let lastTime = -Infinity;
  for (const i of sungIdx) {
    const ps = (perLine.get(i) ?? []).slice();
    const total = lineUnits.get(i) ?? 0;
    const equal = ps.filter((p) => p.equal).length;
    const trusted = total <= 2 ? equal === total && total > 0 : equal >= 2 && equal >= 0.4 * total;

    if (ps.length > 0 && equal >= Math.max(2, 0.6 * total)) {
      const fix = proposeFix(lines[i].text, ps, unitPos, heard, pairedSet);
      if (fix) suggestions.push({ kind: "fix", line: i, heard: fix.text, changes: fix.changes, time: heard[ps[0].heard].start });
    }
    if (!trusted) continue;

    const first = ps[0];
    const unit = heard[first.heard];
    const durations = ps.map((p) => heard[p.heard].end - heard[p.heard].start).sort((a, b) => a - b);
    const perUnit = Math.min(0.6, Math.max(0.15, durations[Math.floor(durations.length / 2)]));
    const pos = unitPos[first.lyric];
    // 识别会把句首字前面的停顿也算进这个字（比如「听」标成 21.8–25.0，其实 24.7 才开口），
    // 所以句首字的开口要在它时间段的后半找
    const stretched = unit.end - unit.start > 0.8;
    let t = stretched && pos === 0 ? unit.end - perUnit : unit.start - pos * perUnit;
    // 用人声开口点微调：句首字的范围内找最明显的开口
    const lo = pos === 0 ? Math.max(unit.start - 0.15, unit.end - 1) : t - 0.15;
    const hi = pos === 0 ? unit.end - 0.05 : t + 0.3;
    let best: Onset | null = null;
    for (const o of onsets) {
      if (o.time < lo || o.time > hi || o.strength < 0.3) continue;
      if (!best || o.strength > best.strength + 0.05 || (Math.abs(o.strength - best.strength) <= 0.05 && Math.abs(o.time - t) < Math.abs(best.time - t))) best = o;
    }
    if (best) t = best.time;
    t = Math.max(0, t);
    if (t <= lastTime + 0.25) continue; // 顺序乱了，当作没对上
    newTime.set(i, t);
    lastTime = t;
  }

  if (newTime.size === 0) return null;

  // 漏句：连续听到 4 个以上歌词里没有、又不是语气词的字
  // 几乎没对上的句子，它「错对」上的字不算数（多半是硬凑的），让漏句检测能看到
  const weak = new Set(
    sungIdx.filter((i) => {
      const ps = perLine.get(i) ?? [];
      return ps.filter((p) => p.equal).length < Math.max(1, 0.3 * (lineUnits.get(i) ?? 0));
    }),
  );
  const pairedHeard = new Map<number, number>(); // heard 下标 → 歌词行
  for (const p of pairs) if (!weak.has(unitLine[p.lyric])) pairedHeard.set(p.heard, unitLine[p.lyric]);
  let run: HeardUnit[] = [];
  let runStart = -1;
  const sungPos = new Map(sungIdx.map((i, k) => [i, k]));
  const flush = (endIndex: number) => {
    const words = run.filter((u) => !FILLER.has(u.key));
    if (words.length >= 5) {
      // 插在后面第一句对上的行之前
      let before = lines.length;
      for (let k = endIndex; k < heard.length; k++) {
        const line = pairedHeard.get(k);
        if (line !== undefined) {
          before = line;
          break;
        }
      }
      // 和前后句的字大量重合，多半是那句被听错/唱长了，不是漏句
      const k = sungPos.get(before) ?? sungIdx.length;
      const neighborKeys = new Set(
        [sungIdx[k - 1], sungIdx[k]]
          .filter((x) => x !== undefined)
          .flatMap((x) => splitUnits(lines[x].text).map(normalizeUnit)),
      );
      const overlap = words.filter((u) => neighborKeys.has(u.key)).length / words.length;
      if (overlap < 0.4) {
        suggestions.push({ kind: "missing", line: before, heard: joinRaw(run), time: run[0].start });
      }
    }
    run = [];
    runStart = -1;
  };
  const firstPaired = pairs[0]?.heard ?? 0;
  const lastPaired = pairs[pairs.length - 1]?.heard ?? heard.length - 1;
  for (let k = firstPaired; k <= lastPaired; k++) {
    if (pairedHeard.has(k)) {
      if (run.length) flush(k);
    } else {
      if (runStart < 0) runStart = k;
      run.push(heard[k]);
      // 中间隔了 1.5 秒以上就算两段
      if (run.length > 1 && heard[k].start - run[run.length - 2].end > 1.5) {
        const last = run.pop()!;
        flush(k);
        run = [last];
        runStart = k;
      }
    }
  }
  if (run.length) flush(lastPaired + 1);

  // 没对上的行：插值
  const anchors = [...newTime.entries()].sort((a, b) => a[0] - b[0]);
  const out = lines.map((l, i) => {
    if (newTime.has(i)) return { ...l, time: round(newTime.get(i)!) };
    return { ...l };
  });
  const prevAnchor = (i: number) => {
    let r: [number, number] | null = null;
    for (const a of anchors) if (a[0] < i) r = a;
    return r;
  };
  const nextAnchor = (i: number) => anchors.find((a) => a[0] > i) ?? null;
  const unitsBetween = (a: number, b: number) => {
    let s = 0;
    for (let k = a; k < b; k++) s += lines[k].text === "" ? 1 : Math.max(1, splitUnits(lines[k].text).length);
    return s;
  };
  const firstAnchorTime = anchors[0][1];

  lines.forEach((l, i) => {
    if (newTime.has(i)) return;
    if (credit[i]) {
      if (l.time !== null) out[i].time = round(Math.min(l.time, Math.max(0, firstAnchorTime - 0.5 * (anchors[0][0] - i))));
      return;
    }
    const prev = prevAnchor(i);
    const next = nextAnchor(i);
    const orig = l.time;
    if (orig !== null) {
      const po = prev ? lines[prev[0]].time : null;
      const no = next ? lines[next[0]].time : null;
      if (prev && next && po !== null && no !== null && no > po) {
        out[i].time = round(prev[1] + ((orig - po) / (no - po)) * (next[1] - prev[1]));
      } else if (prev && po !== null) {
        out[i].time = round(orig + (prev[1] - po));
      } else if (next && no !== null) {
        out[i].time = round(Math.max(0, orig + (next[1] - no)));
      }
      return;
    }
    // 纯文本没有原时间：夹在两句对上的中间时按字数比例分；头尾的按每字约 0.35 秒往外推
    if (prev && next) {
      const frac = unitsBetween(prev[0], i) / unitsBetween(prev[0], next[0]);
      out[i].time = round(prev[1] + frac * (next[1] - prev[1]));
    } else if (next) {
      out[i].time = round(next[1] - unitsBetween(i, next[0]) * SECONDS_PER_UNIT);
    } else if (prev) {
      out[i].time = round(prev[1] + unitsBetween(prev[0], i) * SECONDS_PER_UNIT);
    }
  });

  return { lines: out, aligned: newTime.size, sung: sungIdx.length, suggestions };
}

function round(t: number): number {
  return Math.round(Math.max(0, t) * 100) / 100;
}
