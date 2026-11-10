/**
 * 从 YouTube 视频标题猜「歌名 歌手」（做成伴奏时的默认文件名，用户可以改）。
 * 素材文件夹的习惯是「寂寞先生 曹格」「The Door Teddy Swims」：歌名在前、歌手在后。
 */
const NOISE = /\b(official|music|video|lyric|lyrics|audio|mv|hd|4k|live|visualizer|performance)\b/gi;

/** 去掉文件扩展名 */
function stem(s: string): string {
  return s.replace(/\.(mp4|mov|m4v|mkv|webm)$/i, "");
}

/** 去掉成对括号及内容 */
function dropBrackets(s: string): string {
  return s.replace(/[（(\[［][^）)\]］]*[）)\]］]/g, " ");
}

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 中英混写时只留中文那段（「幾分之幾 You Complete Me」→「幾分之幾」） */
function cjkPart(s: string): string {
  const m = s.match(/[\p{Script=Han}][\p{Script=Han}\s·・]*/u);
  return m ? tidy(m[0]) : tidy(s);
}

export function guessSongName(title: string): string {
  const t = stem(title).replace(/^\s*[[［]\p{Extended_Pictographic}*[\]］]\s*/u, "");

  // 【歌手】歌名 ⧸ 别名（…）：括号在最前面时，括号里是歌手（YouTube 存文件时把 / 换成 ⧸）
  const lead = t.match(/^\s*【([^】]+)】(.+)$/);
  if (lead) {
    const rest = dropBrackets(lead[2]).replace(NOISE, " ").split(/[/／⧸|｜]/)[0];
    const song = tidy(rest);
    if (song) return tidy(`${song} ${tidy(lead[1])}`);
  }

  // 歌手【歌名 …】…
  const bracket = t.match(/^(.*?)【([^】]+)】/);
  if (bracket) {
    const song = cjkPart(bracket[2]);
    const artist = cjkPart(dropBrackets(bracket[1]).split(/\s{1,}/).filter(Boolean)[0] ?? "");
    return tidy(`${song} ${artist}`);
  }

  // 《歌名》.歌手 / 《歌名》歌手
  const book = t.match(/《([^》]+)》[.\s]*([^\s《]+)?/);
  if (book) return tidy(`${book[1]} ${book[2] ?? ""}`);

  // 歌手 - 歌名 (Official Video)
  const dash = dropBrackets(t).split(/\s+[-–—]\s+/);
  if (dash.length === 2) {
    const artist = tidy(dash[0]);
    const song = tidy(dash[1].replace(NOISE, " "));
    if (artist && song) return `${song} ${artist}`;
  }

  return tidy(dropBrackets(t).replace(/[【】]/g, " ").replace(NOISE, " "));
}
