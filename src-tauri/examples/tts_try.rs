//! 试老师开口的两种念法（PRD 4.12）：每句录「整句标日语」和「日语段换 Hana / Bonnie 再拼接」。
//! 用法：tts_try <配置目录> <输出目录> < 每行一句（可以带 原文{读音}）
//! key 从配置目录的 tts.json 读，不打印。

use banzou_lib::learn::{marked, speech};
use std::io::Read;
use std::path::Path;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (config, out) = (Path::new(&args[1]), Path::new(&args[2]));
    std::fs::create_dir_all(out).unwrap();
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    for (i, line) in input.lines().map(str::trim).filter(|l| !l.is_empty()).enumerate() {
        let said = marked::spoken(line);
        println!("{}. {line}\n   念：{said}", i + 1);
        let mut runs: Vec<(String, Result<Vec<u8>, String>)> = Vec::new();
        let t = Instant::now();
        runs.push(("整句".into(), banzou_lib::ai::speak(config, &said)));
        println!("   整句 {} ms", t.elapsed().as_millis());
        for (name, id) in speech::JA_VOICES {
            let t = Instant::now();
            runs.push((name.to_string(), speech::speak_split(config, &said, id)));
            println!("   {name} {} ms", t.elapsed().as_millis());
        }
        for (name, r) in runs {
            match r {
                Ok(b) => std::fs::write(out.join(format!("{:02}-{name}.mp3", i + 1)), b).unwrap(),
                Err(e) => println!("   {name} 出错：{e}"),
            }
        }
    }
}
