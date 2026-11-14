//! 试验用，不在默认路径（PRD 4.12）：中文段用设置里的音色，日语段换日语音色（Hana / Bonnie），再拼成一段。
//! 用户 2026-11-14 选了默认念法 A：整句一次发、有假名就标 explicit_language=ja（teacher::speak → ai::speak），
//! 每句 2–3 秒；这里的拼接每句 4–20 秒。只给 examples/tts_try.rs 做对比，应用里不调用。

use std::path::Path;

use crate::ai;

/// 豆包 2.0 的日语音色（官方音色列表，2026-11 查）
pub const JA_VOICES: &[(&str, &str)] = &[("Hana", "ja_female_bv522_uranus_bigtts"), ("Bonnie", "ja_female_bv024_uranus_bigtts")];

/// 按假名切成「日语段 / 其他段」；标点和空格跟着前一段，只有标点的段并进前一段
pub fn split_ja(text: &str) -> Vec<(bool, String)> {
    let mut runs: Vec<(bool, String)> = Vec::new();
    for c in text.chars() {
        let ja = if ai::is_kana(c) || c == 'ー' {
            Some(true)
        } else if c.is_alphanumeric() {
            Some(false)
        } else {
            None
        };
        match (ja, runs.last_mut()) {
            (None, Some(last)) => last.1.push(c),
            (Some(j), Some(last)) if last.0 == j => last.1.push(c),
            (Some(j), _) => runs.push((j, c.to_string())),
            (None, None) => runs.push((false, c.to_string())),
        }
    }
    runs
}

/// 去掉 mp3 开头的 ID3v2 标签，好直接接起来
fn strip_id3(b: &[u8]) -> &[u8] {
    if b.len() > 10 && &b[..3] == b"ID3" {
        let size = b[6..10].iter().fold(0usize, |n, &x| (n << 7) | (x & 0x7f) as usize);
        return &b[(10 + size).min(b.len())..];
    }
    b
}

/// 几段 mp3 首尾相接（同样的采样率和码率，播放器能连着放）
pub fn join_mp3(parts: &[Vec<u8>]) -> Vec<u8> {
    parts.iter().enumerate().flat_map(|(i, p)| if i == 0 { &p[..] } else { strip_id3(p) }.iter().copied()).collect()
}

/// 日语段用 ja_speaker 念，其他段用设置里的音色，拼起来
pub fn speak_split(config: &Path, text: &str, ja_speaker: &str) -> Result<Vec<u8>, String> {
    let mut parts = Vec::new();
    for (ja, part) in split_ja(text) {
        if part.trim().is_empty() {
            continue;
        }
        parts.push(if ja { ai::speak_as(config, &part, Some(ja_speaker), Some("ja"))? } else { ai::speak_as(config, &part, None, None)? });
    }
    if parts.is_empty() {
        return Err("没有要念的话".into());
    }
    Ok(join_mp3(&parts))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_japanese_runs() {
        assert_eq!(split_ja("这首歌叫 かじつ"), vec![(false, "这首歌叫 ".into()), (true, "かじつ".into())]);
        assert_eq!(
            split_ja("注意 はなび 的 は。"),
            vec![(false, "注意 ".into()), (true, "はなび ".into()), (false, "的 ".into()), (true, "は。".into())]
        );
        assert_eq!(split_ja("「こころ」"), vec![(false, "「".into()), (true, "こころ」".into())]);
    }

    #[test]
    fn joins_mp3_without_inner_id3() {
        let a = b"ID3\x04\0\0\0\0\0\x02xxAAAA".to_vec();
        assert_eq!(join_mp3(&[a.clone(), a]), b"ID3\x04\0\0\0\0\0\x02xxAAAAAAAA".to_vec());
    }
}
