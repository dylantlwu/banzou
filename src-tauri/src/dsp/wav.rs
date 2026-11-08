//! WAV 读写（hound）。读进来统一成单声道 f32；写出 32 位浮点。

use std::io;
use std::path::Path;

fn err(e: hound::Error) -> io::Error {
    io::Error::other(e.to_string())
}

/// 读成单声道（多声道取平均），返回 (采样, 采样率)
pub fn read_mono(path: &Path) -> io::Result<(Vec<f32>, u32)> {
    let mut reader = hound::WavReader::open(path).map_err(err)?;
    let spec = reader.spec();
    let ch = spec.channels.max(1) as usize;
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>().map_err(err)?,
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
            reader.samples::<i32>().map(|s| s.map(|v| v as f32 * scale)).collect::<Result<_, _>>().map_err(err)?
        }
    };
    let mono = if ch == 1 {
        interleaved
    } else {
        interleaved.chunks(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect()
    };
    Ok((mono, spec.sample_rate))
}

/// 读成各声道分开的采样
pub fn read_channels(path: &Path) -> io::Result<(Vec<Vec<f32>>, u32)> {
    let mut reader = hound::WavReader::open(path).map_err(err)?;
    let spec = reader.spec();
    let ch = spec.channels.max(1) as usize;
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>().map_err(err)?,
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
            reader.samples::<i32>().map(|s| s.map(|v| v as f32 * scale)).collect::<Result<_, _>>().map_err(err)?
        }
    };
    let mut out = vec![Vec::with_capacity(interleaved.len() / ch); ch];
    for (i, s) in interleaved.into_iter().enumerate() {
        out[i % ch].push(s);
    }
    Ok((out, spec.sample_rate))
}

/// 写 32 位浮点 WAV。手写标准的 44 字节头（格式码 3）：hound 写的是 WAVE_FORMAT_EXTENSIBLE，
/// 有的解码器（浏览器的 decodeAudioData）不认立体声浮点的这种格式。
pub fn write_f32(path: &Path, channels: u16, sample_rate: u32, interleaved: &[f32]) -> io::Result<()> {
    use std::io::Write;
    let data_bytes = (interleaved.len() * 4) as u32;
    let mut h = Vec::with_capacity(44);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    h.extend_from_slice(b"WAVEfmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&3u16.to_le_bytes());
    h.extend_from_slice(&channels.to_le_bytes());
    h.extend_from_slice(&sample_rate.to_le_bytes());
    h.extend_from_slice(&(sample_rate * 4 * channels as u32).to_le_bytes());
    h.extend_from_slice(&(4 * channels).to_le_bytes());
    h.extend_from_slice(&32u16.to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&data_bytes.to_le_bytes());
    // 每次写用不同的临时文件名：同一个文件被并发写（比如前端重复请求）时不会互相踩
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("{}-{n}.tmp", std::process::id()));
    {
        let mut f = io::BufWriter::new(std::fs::File::create(&tmp)?);
        f.write_all(&h)?;
        for &s in interleaved {
            f.write_all(&s.to_le_bytes())?;
        }
        f.flush()?;
    }
    std::fs::rename(tmp, path)
}

/// 线性插值重采样（修音、降噪内部用，质量够）
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let n = ((input.len() as f64) / ratio).floor() as usize;
    (0..n)
        .map(|i| {
            let x = i as f64 * ratio;
            let j = x.floor() as usize;
            let f = (x - j as f64) as f32;
            let a = input[j.min(input.len() - 1)];
            let b = input[(j + 1).min(input.len() - 1)];
            a + (b - a) * f
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_resample() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.wav");
        write_f32(&p, 2, 48000, &[0.5, -0.5, 0.25, 0.25]).unwrap();
        let (mono, sr) = read_mono(&p).unwrap();
        assert_eq!(sr, 48000);
        assert_eq!(mono, vec![0.0, 0.25]);
        let r = resample(&[0.0, 1.0, 2.0, 3.0], 48000, 24000);
        assert_eq!(r, vec![0.0, 2.0]);
    }
}
