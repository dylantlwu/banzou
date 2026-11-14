//! 老师说话里的 `原文{读音}`（PRD 4.12）：屏幕上显示原文加注音，念的时候只念读音。
//! `原文{?}` = 读音待确认。原文 = `{` 前面连着的一串字，遇到空白、标点就停（守则让老师在原文前空一格）。
//! 界面那边（src/learn/marked.ts）按同样的规则拆，两边要一致。

use super::lesson::Fix;
use super::reading::{self, Analyzers, Table};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece {
    Text(String),
    /// reading = None：读音待确认（`{?}`）
    Word { orig: String, reading: Option<String> },
}

/// 花括号里最多这么多字，再长就不当读音（多半是别的用途）
const MAX_READING: usize = 40;

/// 待确认的词念出来时换成这个（不替用户定读音）
pub const UNKNOWN_SPOKEN: &str = "这个词";

/// 原文的边界：空白和标点
pub fn is_boundary(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '{' | '}' | '。' | '，' | '、' | '！' | '？' | '：' | '；' | '「' | '」' | '『' | '』' | '《' | '》' | '〈' | '〉' | '（' | '）' | '【'
                | '】' | '“' | '”' | '‘' | '’' | '…' | '—' | '～' | '〜' | '·' | ',' | '.' | '!' | '?' | ':' | ';' | '(' | ')' | '['
                | ']' | '"' | '/' | '／' | '*' | '`'
        )
}

fn is_hiragana(c: char) -> bool {
    matches!(c, '\u{3041}'..='\u{309F}')
}

fn is_pending(inner: &str) -> bool {
    matches!(inner.trim(), "?" | "？" | "待确认" | "读音待确认")
}

fn push_text(out: &mut Vec<Piece>, s: &str) {
    if s.is_empty() {
        return;
    }
    if let Some(Piece::Text(t)) = out.last_mut() {
        t.push_str(s);
    } else {
        out.push(Piece::Text(s.to_string()));
    }
}

/// 拆成普通文字和标了读音的词。没有花括号的旧文字整段是 Text
pub fn parse(text: &str) -> Vec<Piece> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut plain = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' {
            let close = chars[i + 1..].iter().take(MAX_READING + 1).position(|&d| d == '}' || d == '{' || d == '\n');
            if let Some(len) = close.filter(|&len| chars[i + 1 + len] == '}') {
                let inner: String = chars[i + 1..i + 1 + len].iter().collect();
                let cut = plain.char_indices().rev().take_while(|(_, c)| !is_boundary(*c)).last().map(|(k, _)| k).unwrap_or(plain.len());
                let mut cut = cut;
                let reading_txt = inner.trim();
                // 原文前头的平假名（助词、上一个词的送假名：君{きみ}を呼{よ}ぶ 的「を」）不算原文，除非读音也这样开头（この花火{このはなび}）
                let lead: String = plain[cut..].chars().take_while(|c| is_hiragana(*c)).collect();
                if !lead.is_empty() && lead.len() < plain.len() - cut && !reading::to_hiragana(reading_txt).starts_with(&lead) {
                    cut += lead.len();
                }
                let orig = plain[cut..].to_string();
                plain.truncate(cut);
                push_text(&mut out, &std::mem::take(&mut plain));
                let reading = (!is_pending(&inner)).then(|| inner.trim().to_string());
                match (orig.is_empty(), reading) {
                    // 前面没有原文：有读音就只显示读音，`{?}` 丢掉
                    (true, Some(r)) => push_text(&mut out, &r),
                    (true, None) => {}
                    // 空花括号：当普通字
                    (false, Some(r)) if r.is_empty() => push_text(&mut out, &orig),
                    (false, reading) => out.push(Piece::Word { orig, reading }),
                }
                i += len + 2;
                continue;
            }
        }
        plain.push(chars[i]);
        i += 1;
    }
    push_text(&mut out, &plain);
    out
}

pub fn has_marks(text: &str) -> bool {
    parse(text).iter().any(|p| matches!(p, Piece::Word { .. }))
}

/// 拼回文字（`原文{读音}`）
pub fn render(pieces: &[Piece]) -> String {
    let mut out = String::new();
    for p in pieces {
        match p {
            Piece::Text(t) => out.push_str(t),
            Piece::Word { orig, reading: Some(r) } => out += &format!("{orig}{{{r}}}"),
            Piece::Word { orig, reading: None } => out += &format!("{orig}{{?}}"),
        }
    }
    out
}

/// 念出来的文字：标了读音的只念读音，待确认的念「这个词」，其余照旧
pub fn spoken(text: &str) -> String {
    parse(text)
        .into_iter()
        .map(|p| match p {
            Piece::Text(t) => t,
            Piece::Word { reading: Some(r), .. } => r,
            Piece::Word { reading: None, .. } => UNKNOWN_SPOKEN.to_string(),
        })
        .collect()
}

fn has_kana(s: &str) -> bool {
    s.chars().any(|c| matches!(c, '\u{3041}'..='\u{309F}' | '\u{30A1}'..='\u{30FA}'))
}

/// 读音比较用：罗马字转假名，再统一长音等写法
fn norm(r: &str) -> String {
    let r = r.trim();
    let r = if r.chars().all(|c| c.is_ascii_alphabetic() || c == ' ' || c == '\'' || c == '-') { reading::to_hiragana(&r.replace(' ', "")) } else { r.to_string() };
    reading::normalize(&r)
}

/// 原文和中文粘在一起时（「这首歌叫夏実{かじつ}」），按读音表把词切出来，前面补一个空格。
/// 只在这几种情况切：读音就是表里那个词的读音；或者 `{?}` 而那个词待确认；或者前面一截不带假名（多半是中文）、读音又不是一整句的读音
fn split_glued(orig: &str, reading: Option<&str>, table: &Table) -> Option<(String, String)> {
    if table.get(orig).is_some() {
        return None;
    }
    let mut words: Vec<&reading::Reading> = table.words.iter().filter(|w| orig.ends_with(&w.word) && orig.len() > w.word.len()).collect();
    words.sort_by_key(|w| std::cmp::Reverse(w.word.chars().count()));
    let w = words.first()?;
    let prefix = &orig[..orig.len() - w.word.len()];
    let ok = match reading {
        None => w.needs_review,
        Some(r) => {
            let (r, wr) = (norm(r), reading::normalize(&w.reading));
            r == wr || (!has_kana(prefix) && !r.ends_with(&wr))
        }
    };
    ok.then(|| (prefix.to_string(), w.word.clone()))
}

/// 一个词该标的读音：表里有就按表（待确认 = None）；表里没有、装了词典，就现场分析（两个分析器一致才算数）。
/// okuri = 花括号后面紧跟的平假名（送り仮名，比如 咲{さ}く 的 く）：有的话按「词 + 送假名」查表再去掉送假名，
/// 不现场分析单个汉字（单独的「咲」会分析成 さき）。返回 None = 管不了，照老师写的
fn expected(word: &str, okuri: &str, table: &Table, an: Option<&Analyzers>) -> Option<Option<String>> {
    if let Some(w) = table.get(word) {
        return Some((!w.needs_review).then(|| w.reading.clone()));
    }
    if !okuri.is_empty() {
        let ok: Vec<char> = okuri.chars().collect();
        for k in (1..=ok.len()).rev() {
            let tail: String = ok[..k].iter().collect();
            let Some(w) = table.get(&format!("{word}{tail}")) else { continue };
            let r = reading::to_hiragana(&w.reading);
            return r.strip_suffix(tail.as_str()).filter(|s| !s.is_empty()).map(|stem| (!w.needs_review).then(|| stem.to_string()));
        }
        return None;
    }
    let an = an.filter(|_| reading::has_kanji(word))?;
    let t = reading::build(Some(an), &reading::Inputs { lines: vec![word.to_string()], ..Default::default() });
    match t.words.as_slice() {
        [w] if w.word == word => Some((!w.needs_review).then(|| w.reading.clone())),
        _ => None,
    }
}

fn okurigana(next: Option<&Piece>) -> String {
    match next {
        Some(Piece::Text(t)) => t.chars().take_while(|c| matches!(c, '\u{3041}'..='\u{309F}')).collect(),
        _ => String::new(),
    }
}

/// 按读音表核对 `原文{读音}`：读音和表里不一样就改成表里的，表里待确认的改成 `{?}`。返回改好的文字和改了哪些
pub fn check(text: &str, table: &Table, an: Option<&Analyzers>, place: &str) -> (String, Vec<Fix>) {
    let mut pieces = Vec::new();
    let mut fixes = Vec::new();
    let parsed = parse(text);
    for (i, p) in parsed.iter().enumerate() {
        let Piece::Word { orig, reading: got } = p.clone() else {
            pieces.push(p.clone());
            continue;
        };
        let okuri = okurigana(parsed.get(i + 1));
        let (prefix, word) = split_glued(&orig, got.as_deref(), table).unwrap_or((String::new(), orig));
        if !prefix.is_empty() {
            push_text(&mut pieces, &format!("{prefix} "));
        }
        // 只有假名的（は、こころ）不用核对
        let want = if has_kana(&word) && !reading::has_kanji(&word) { None } else { expected(&word, &okuri, table, an) };
        let reading = match want {
            Some(None) if got.is_some() => {
                fixes.push(Fix { place: place.into(), word: word.clone(), from: got.clone().unwrap_or_default(), to: "读音待确认".into() });
                None
            }
            Some(Some(r)) if got.as_deref().map(norm) != Some(reading::normalize(&r)) => {
                fixes.push(Fix { place: place.into(), word: word.clone(), from: got.clone().unwrap_or_else(|| "?".into()), to: r.clone() });
                Some(r)
            }
            _ => got,
        };
        pieces.push(Piece::Word { orig: word, reading });
    }
    (render(&pieces), fixes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::learn::notes::Note;

    fn w(orig: &str, r: Option<&str>) -> Piece {
        Piece::Word { orig: orig.into(), reading: r.map(str::to_string) }
    }
    fn t(s: &str) -> Piece {
        Piece::Text(s.into())
    }

    #[test]
    fn parses_marks_inside_chinese() {
        assert_eq!(parse("这首歌叫 夏実{かじつ}，很好听"), vec![t("这首歌叫 "), w("夏実", Some("かじつ")), t("，很好听")]);
        // 一句里好几个；紧挨着的两个
        assert_eq!(
            parse("「夏実{かじつ}」和 花火{はなび} 、心{こころ}"),
            vec![t("「"), w("夏実", Some("かじつ")), t("」和 "), w("花火", Some("はなび")), t(" 、"), w("心", Some("こころ"))]
        );
        // 前头的平假名留在外面；读音也这样开头的才算原文
        assert_eq!(parse("夏実{かじつ}の花火{はなび}"), vec![w("夏実", Some("かじつ")), t("の"), w("花火", Some("はなび"))]);
        assert_eq!(parse("君{きみ}を呼{よ}ぶ"), vec![w("君", Some("きみ")), t("を"), w("呼", Some("よ")), t("ぶ")]);
        assert_eq!(parse("この花火{このはなび}"), vec![w("この花火", Some("このはなび"))]);
        assert_eq!(parse("きみ{きみ}"), vec![w("きみ", Some("きみ"))]);
        // 待确认
        assert_eq!(parse("美月{?} 读音待确认"), vec![w("美月", None), t(" 读音待确认")]);
        assert_eq!(parse("美月{？}"), vec![w("美月", None)]);
    }

    #[test]
    fn old_text_and_odd_braces_stay_text() {
        assert_eq!(parse("「夏実」念 かじつ（Kajitsu）"), vec![t("「夏実」念 かじつ（Kajitsu）")]);
        assert!(!has_marks("「夏実」念 かじつ"));
        assert_eq!(parse("没有闭合 {かじつ"), vec![t("没有闭合 {かじつ")]);
        assert_eq!(parse("空的 夏実{} 照旧"), vec![t("空的 夏実 照旧")]);
        // 前面没原文：只留读音，不让人看到花括号
        assert_eq!(parse("念 {かじつ}"), vec![t("念 かじつ")]);
        assert_eq!(parse(""), vec![]);
    }

    #[test]
    fn spoken_sends_only_readings() {
        assert_eq!(spoken("这首歌叫 夏実{かじつ}"), "这首歌叫 かじつ");
        assert_eq!(spoken("注意 花火{はなび} 的 は"), "注意 はなび 的 は");
        assert_eq!(spoken("夏実{かじつ} 里的 花火{はなび}，还有 心{こころ}"), "かじつ 里的 はなび，还有 こころ");
        assert_eq!(spoken("美月{?} 的读音待确认"), "这个词 的读音待确认");
        assert_eq!(spoken("心{こころ}の 中{なか}で 君{きみ}を呼{よ}ぶ"), "こころの なかで きみをよぶ");
        assert_eq!(spoken("「夏実」念 かじつ"), "「夏実」念 かじつ");
    }

    fn table() -> Table {
        let notes = [Note { text: "读音：夏実 = かじつ".into(), tag: None }, Note { text: "读音：花火 = はなび".into(), tag: None }];
        reading::build(None, &reading::Inputs { song_notes: &notes, claude: vec![("美月".into(), "みつき".into())], ..Default::default() })
    }

    #[test]
    fn check_follows_the_table() {
        let tb = table();
        // 读音错了按表改；待确认的改成 {?}；表里没有的照老师写的；{?} 而表里确认过的补上
        let (out, fixes) = check("夏実{なつみ} 和 美月{みつき}，还有 星屑{ほしくず}；花火{?}", &tb, None, "回答");
        assert_eq!(out, "夏実{かじつ} 和 美月{?}，还有 星屑{ほしくず}；花火{はなび}");
        assert_eq!(fixes.len(), 3);
        assert_eq!((fixes[0].from.as_str(), fixes[0].to.as_str()), ("なつみ", "かじつ"));
        assert_eq!(fixes[1].to, "读音待确认");
        // 对的不动；罗马字、片假名写法算一样
        let (same, f) = check("夏実{かじつ} 夏実{kajitsu} 花火{ハナビ}", &tb, None, "回答");
        assert_eq!(same, "夏実{かじつ} 夏実{kajitsu} 花火{ハナビ}");
        assert!(f.is_empty());
        // 没有花括号的旧文字原样
        assert_eq!(check("「夏実」念 なつみ", &tb, None, "回答").0, "「夏実」念 なつみ");
    }

    #[test]
    fn check_cuts_word_glued_to_chinese() {
        let tb = table();
        assert_eq!(check("这首歌叫夏実{かじつ}", &tb, None, "x").0, "这首歌叫 夏実{かじつ}");
        assert_eq!(check("这首歌叫夏実{なつみ}", &tb, None, "x").0, "这首歌叫 夏実{かじつ}");
        assert_eq!(check("夏実{かじつ}の花火{はなび}", &tb, None, "x").0, "夏実{かじつ}の花火{はなび}");
        // 一整句的读音：不切
        assert_eq!(check("夏実の花火{かじつのはなび}", &tb, None, "x").0, "夏実の花火{かじつのはなび}");
        assert_eq!(spoken(&check("就是夏実{かじつ}", &tb, None, "x").0), "就是 かじつ");
    }

    #[test]
    fn okurigana_outside_braces() {
        let notes = [Note { text: "读音：咲く = さく".into(), tag: None }];
        let tb = reading::build(None, &reading::Inputs { song_notes: &notes, ..Default::default() });
        // 咲{さ}く：按「咲く = さく」去掉く，是对的
        assert_eq!(check("空に 咲{さ}く", &tb, None, "x"), ("空に 咲{さ}く".to_string(), vec![]));
        assert_eq!(check("空に 咲{さき}く", &tb, None, "x").0, "空に 咲{さ}く");
        // 表里没有带这个送假名的词：不动
        assert_eq!(check("咲{さ}いた", &tb, None, "x").0, "咲{さ}いた");
    }
}
