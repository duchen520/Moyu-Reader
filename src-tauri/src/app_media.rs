//! GPL-3.0-only. Normal server-provided audio; protocol reference: fanqie-assistant/player/cenc.ts.
use aes::cipher::{KeyIvInit, StreamCipher};
#[derive(Clone)]
struct B {
    p: usize,
    end: usize,
    h: usize,
    t: [u8; 4],
}
fn be(d: &[u8], p: usize) -> Result<u32, String> {
    Ok(u32::from_be_bytes(
        d.get(p..p + 4).ok_or("音频表不完整")?.try_into().unwrap(),
    ))
}
fn walk(d: &[u8], mut p: usize, end: usize, depth: usize, out: &mut Vec<B>) -> Result<(), String> {
    if depth > 16 {
        return Err("音频结构过深".into());
    }
    while p < end {
        if p + 8 > end {
            return Err("音频不完整".into());
        }
        let n = be(d, p)?;
        let t = d[p + 4..p + 8].try_into().unwrap();
        let (h, n) = if n == 1 {
            (
                16,
                u64::from_be_bytes(
                    d.get(p + 8..p + 16)
                        .ok_or("音频不完整")?
                        .try_into()
                        .unwrap(),
                ) as usize,
            )
        } else if n == 0 {
            (8, end - p)
        } else {
            (8, n as usize)
        };
        let next = p
            .checked_add(n)
            .filter(|v| *v <= end && n >= h)
            .ok_or("音频大小错误")?;
        out.push(B { p, end: next, h, t });
        if matches!(
            &t,
            b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"sinf" | b"schi"
        ) {
            walk(d, p + h, next, depth + 1, out)?;
        }
        p = next;
    }
    Ok(())
}
pub fn clear_audio(mut d: Vec<u8>, key: &[u8]) -> Result<Vec<u8>, String> {
    if d.len() > 32 * 1024 * 1024 || key.len() != 16 {
        return Err("音频大小或参数超出支持范围".into());
    }
    let mut bs = vec![];
    walk(&d, 0, d.len(), 0, &mut bs)?;
    let one = |t: &[u8; 4]| -> Result<B, String> {
        let a: Vec<_> = bs.iter().filter(|b| &b.t == t).collect();
        if a.len() != 1 {
            return Err("当前音频封装不支持".into());
        }
        Ok(a[0].clone())
    };
    let sizes = one(b"stsz")?;
    let ivs = one(b"senc")?;
    let stsd = one(b"stsd")?;
    let stsc = one(b"stsc")?;
    if sizes.end - sizes.p < 20
        || ivs.end - ivs.p < 16
        || stsd.end - stsd.p < 16
        || stsc.end - stsc.p < 16
    {
        return Err("音频表不完整".into());
    }
    let count = be(&d, sizes.p + 16)? as usize;
    if count == 0
        || count > 500000
        || be(&d, ivs.p + 12)? as usize != count
        || be(&d, ivs.p + 8)? & 2 != 0
    {
        return Err("音频采样保护格式不支持".into());
    }
    let ivlen = (ivs.end - ivs.p - 16) / count;
    if !matches!(ivlen, 8 | 16) || (ivs.end - ivs.p - 16) % count != 0 {
        return Err("音频IV表无效".into());
    }
    let fixed = be(&d, sizes.p + 12)? as usize;
    if fixed == 0 && sizes.p + 20 + count * 4 > sizes.end {
        return Err("音频采样表不完整".into());
    }
    let sizes: Vec<usize> = (0..count)
        .map(|i| {
            if fixed > 0 {
                Ok(fixed)
            } else {
                be(&d, sizes.p + 20 + i * 4).map(|x| x as usize)
            }
        })
        .collect::<Result<_, _>>()?;
    let chunk = bs
        .iter()
        .find(|b| matches!(&b.t, b"stco" | b"co64"))
        .cloned()
        .ok_or("音频缺少位置表")?;
    if chunk.end - chunk.p < 16 {
        return Err("音频位置表不完整".into());
    }
    let wide = &chunk.t == b"co64";
    let chunks = be(&d, chunk.p + 12)? as usize;
    if chunks == 0 || chunks > count || chunk.p + 16 + chunks * if wide { 8 } else { 4 } > chunk.end
    {
        return Err("音频位置表无效".into());
    }
    let entries = be(&d, stsc.p + 12)? as usize;
    if entries == 0 || entries > chunks || stsc.p + 16 + entries * 12 > stsc.end {
        return Err("音频分块表无效".into());
    }
    let mut mapping = vec![];
    for i in 0..entries {
        let p = stsc.p + 16 + i * 12;
        let f = be(&d, p)? as usize;
        let n = be(&d, p + 4)? as usize;
        if f == 0 || n == 0 || be(&d, p + 8)? != 1 {
            return Err("音频分块无效".into());
        }
        mapping.push((f, n));
    }
    if mapping[0].0 != 1 || mapping.windows(2).any(|p| p[0].0 >= p[1].0) {
        return Err("音频分块无序".into());
    }
    let mdat = one(b"mdat")?;
    let (mut sample, mut mi) = (0, 0);
    for i in 0..chunks {
        while mi + 1 < mapping.len() && mapping[mi + 1].0 <= i + 1 {
            mi += 1;
        }
        let p = chunk.p + 16 + i * if wide { 8 } else { 4 };
        let mut off = if wide {
            u64::from_be_bytes(d[p..p + 8].try_into().unwrap()) as usize
        } else {
            be(&d, p)? as usize
        };
        for _ in 0..mapping[mi].1 {
            let size = *sizes.get(sample).ok_or("音频采样数不一致")?;
            let end = off
                .checked_add(size)
                .filter(|e| off >= mdat.p + mdat.h && *e <= mdat.end)
                .ok_or("音频采样越界")?;
            let mut iv = [0; 16];
            let p = ivs.p + 16 + sample * ivlen;
            iv[..ivlen].copy_from_slice(&d[p..p + ivlen]);
            ctr::Ctr64BE::<aes::Aes128>::new_from_slices(key, &iv)
                .map_err(|_| "音频播放参数错误")?
                .apply_keystream(&mut d[off..end]);
            off = end;
            sample += 1;
        }
    }
    if sample != count || be(&d, stsd.p + 12)? != 1 {
        return Err("音频采样数或编码不支持".into());
    }
    let entry = stsd.p + 16;
    let end = entry
        .checked_add(be(&d, entry)? as usize)
        .filter(|e| *e <= stsd.end)
        .ok_or("音频编码不完整")?;
    if d.get(entry + 4..entry + 8) != Some(b"enca")
        || entry + 36 > end
        || d[entry + 16..entry + 18] != [0, 0]
    {
        return Err("音频编码保护结构不支持".into());
    }
    let mut children = vec![];
    walk(&d, entry + 36, end, 0, &mut children)?;
    let f = children
        .iter()
        .find(|b| &b.t == b"frma")
        .ok_or("音频缺少原始编码")?;
    let codec: [u8; 4] = d
        .get(f.p + 8..f.p + 12)
        .ok_or("音频编码不完整")?
        .try_into()
        .unwrap();
    if !matches!(&codec, b"mp4a" | b"Opus" | b"fLaC") {
        return Err("当前音频编码不支持".into());
    }
    d[entry + 4..entry + 8].copy_from_slice(&codec);
    for b in bs.iter().chain(children.iter()) {
        if matches!(&b.t, b"senc" | b"saiz" | b"saio" | b"pssh" | b"sinf") {
            d[b.p + 4..b.p + 8].copy_from_slice(b"free");
        }
    }
    Ok(d)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_rejected() {
        for v in [vec![], vec![0; 32], b"not mp4".to_vec()] {
            assert!(clear_audio(v, &[0; 16]).is_err());
        }
    }
}
