//! GPL-3.0-only. Rust protocol port of naiyQAQ/fanqie-assistant
//! b62ec5dbe6149a93bca249949549c805ac7da424. No privilege operations.
use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use base64::{engine::general_purpose::STANDARD, Engine};
use md5::Md5;
use rand::RngCore;
use sha2::{Digest, Sha512};
use sm3::Sm3;
use std::io::{Read, Write};
const SHARED: &str = "ac25c67ddd8f38c1b37a2348828e222e";
const SIGN: &str = "ac1adaae95a7af94a5114ab3b3a97dd80050aa0a39314c40528caec95256c28c";
pub fn hex(v: &[u8]) -> String {
    v.iter().map(|x| format!("{x:02x}")).collect()
}
pub fn unhex(v: &str) -> Result<Vec<u8>, String> {
    if v.len() % 2 != 0 || !v.is_ascii() {
        return Err("协议编码无效".into());
    }
    (0..v.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&v[i..i + 2], 16).map_err(|_| "协议编码无效".into()))
        .collect()
}
pub fn encode(v: &[u8]) -> String {
    STANDARD.encode(v)
}
pub fn decode(v: &str) -> Result<Vec<u8>, String> {
    STANDARD.decode(v).map_err(|_| "官方数据编码无效".into())
}
pub fn random(n: usize) -> Vec<u8> {
    let mut v = vec![0; n];
    rand::thread_rng().fill_bytes(&mut v);
    v
}
fn pad(v: &[u8]) -> Vec<u8> {
    let mut x = v.to_vec();
    let n = 16 - v.len() % 16;
    x.resize(v.len() + n, n as u8);
    x
}
fn enc(k: &[u8], iv: &[u8], v: &[u8]) -> Result<Vec<u8>, String> {
    Ok(cbc::Encryptor::<aes::Aes128>::new_from_slices(k, iv)
        .map_err(|_| "协议参数错误")?
        .encrypt_padded_vec_mut::<Pkcs7>(v))
}
fn dec(k: &[u8], v: &[u8]) -> Result<Vec<u8>, String> {
    if v.len() < 32 {
        return Err("官方内容数据不完整".into());
    }
    cbc::Decryptor::<aes::Aes128>::new_from_slices(k, &v[..16])
        .map_err(|_| "协议参数错误")?
        .decrypt_padded_vec_mut::<Pkcs7>(&v[16..])
        .map_err(|_| "官方内容解析失败，请稍后重新打开章节".into())
}
fn le(v: &[u8]) -> u64 {
    u64::from_le_bytes(v[..8].try_into().unwrap())
}
fn var(p: &mut Vec<u8>, mut n: u32) {
    while n >= 128 {
        p.push((n as u8 & 127) | 128);
        n >>= 7;
    }
    p.push(n as u8);
}
fn int(p: &mut Vec<u8>, f: u32, n: u64) {
    var(p, f << 3);
    var(p, n as u32);
}
fn bytes(p: &mut Vec<u8>, f: u32, v: &[u8]) {
    var(p, (f << 3) | 2);
    var(p, v.len() as u32);
    p.extend(v);
}
fn string(p: &mut Vec<u8>, f: u32, v: &str) {
    bytes(p, f, v.as_bytes());
}
fn proto(q: &str, body: &[u8], t: u64, r: u32) -> Vec<u8> {
    let query: std::collections::HashMap<_, _> = url::form_urlencoded::parse(q.as_bytes())
        .into_owned()
        .collect();
    let mut p = vec![];
    for (f, n) in [(1, 0x20200929u64 * 2), (2, 2), (3, r as u64)] {
        int(&mut p, f, n);
    }
    for (f, s) in [
        (4, "1967"),
        (5, query.get("device_id").map(String::as_str).unwrap_or("")),
        (6, "1611921764"),
        (
            7,
            query.get("version_name").map(String::as_str).unwrap_or(""),
        ),
        (8, "v04.04.05-ov-android"),
    ] {
        string(&mut p, f, s);
    }
    int(&mut p, 9, 134744640);
    bytes(&mut p, 10, &[0; 8]);
    int(&mut p, 11, 0);
    int(&mut p, 12, t * 2);
    let b = if body.is_empty() {
        vec![0; 16]
    } else {
        Md5::digest(body).to_vec()
    };
    let query = if q.is_empty() {
        vec![0; 16]
    } else {
        q.as_bytes().to_vec()
    };
    bytes(&mut p, 13, &Sm3::digest(b)[..6]);
    bytes(&mut p, 14, &Sm3::digest(query)[..6]);
    let mut sub = vec![];
    for (f, n) in [(1, 1), (2, 1), (3, 1), (7, 3348294860)] {
        int(&mut sub, f, n);
    }
    bytes(&mut p, 15, &sub);
    string(&mut p, 16, "");
    string(&mut p, 20, "none");
    int(&mut p, 21, 738);
    let mut sub = vec![];
    string(&mut sub, 1, "NX551J");
    int(&mut sub, 2, 8196);
    int(&mut sub, 4, 2162219008);
    bytes(&mut p, 23, &sub);
    int(&mut p, 25, 2);
    p
}
fn argus(q: &str, body: &[u8], t: u64, r: u32) -> Result<String, String> {
    let key = unhex(SIGN)?;
    let mut input = key.clone();
    input.extend([0xf2, 0x81, 0x61, 0x6f]);
    input.extend(&key);
    let k = Sm3::digest(input);
    let mut ks = vec![le(&k), le(&k[8..]), le(&k[16..]), le(&k[24..])];
    for i in 4..72 {
        let mut tmp = ks[i - 1].rotate_right(3) ^ ks[i - 3];
        tmp ^= tmp.rotate_right(1);
        ks.push(!ks[i - 4] ^ tmp ^ ((0x3dc94c3a046d678bu64 >> ((i - 4) % 62)) & 1) ^ 3);
    }
    let mut out = vec![];
    for b in pad(&proto(q, body, t, r)).chunks_exact(16) {
        let (mut x, mut y) = (le(b), le(&b[8..]));
        for k in &ks {
            let old = y;
            y = x ^ (y.rotate_left(1) & y.rotate_left(8)) ^ y.rotate_left(2) ^ k;
            x = old;
        }
        out.extend(x.to_le_bytes());
        out.extend(y.to_le_bytes());
    }
    let mut data = vec![0xf2, 0xf7, 0xfc, 0xff, 0xf2, 0xf7, 0xfc, 0xff];
    data.extend(out);
    for i in 8..data.len() {
        data[i] ^= data[i % 8];
    }
    data.reverse();
    let mut plain = vec![0xa6, 0x6e, 0xad, 0x9f, 0x77, 1, 0xd0, 0x0c, 0x18];
    plain.extend(data);
    plain.extend([0x61, 0x6f]);
    let mut out = vec![0xf2, 0x81];
    out.extend(enc(
        &Md5::digest(&key[..16]),
        &Md5::digest(&key[16..]),
        &plain,
    )?);
    Ok(encode(&out))
}
fn ladon(t: u64, r: &[u8]) -> String {
    let mut input = r.to_vec();
    input.extend(b"1967");
    let key = hex(&Md5::digest(input));
    let key = key.as_bytes();
    let mut ks = vec![le(key)];
    let mut ls = vec![le(&key[8..]), le(&key[16..]), le(&key[24..])];
    for i in 0..33 {
        let x = ls[i].rotate_right(8).wrapping_add(ks[i]) ^ i as u64;
        ls.push(x);
        ks.push(x ^ ks[i].rotate_left(3));
    }
    let mut out = r.to_vec();
    for b in pad(format!("{t}-1611921764-1967").as_bytes()).chunks_exact(16) {
        let (mut y, mut x) = (le(b), le(&b[8..]));
        for k in &ks {
            x = x.rotate_right(8).wrapping_add(y) ^ k;
            y = x ^ y.rotate_left(3);
        }
        out.extend(y.to_le_bytes());
        out.extend(x.to_le_bytes());
    }
    encode(&out)
}
pub fn sign(q: &str, body: &[u8]) -> Result<Vec<(&'static str, String)>, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时间错误")?;
    let mut v = vec![
        (
            "x-argus",
            argus(
                q,
                body,
                now.as_secs(),
                rand::thread_rng().next_u32() % 0x7fffffff,
            )?,
        ),
        ("x-ladon", ladon(now.as_secs(), &random(4))),
        ("x-khronos", now.as_secs().to_string()),
        ("x-ss-req-ticket", now.as_millis().to_string()),
    ];
    if !body.is_empty() {
        v.push(("x-ss-stub", hex(&Md5::digest(body))));
    }
    Ok(v)
}
pub fn device_body(v: &serde_json::Value) -> Result<Vec<u8>, String> {
    let data = serde_json::to_vec(v).map_err(|_| "注册数据错误")?;
    let mut z = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    z.write_all(&data).map_err(|_| "注册数据压缩失败")?;
    let z = z.finish().map_err(|_| "注册数据压缩失败")?;
    let r = random(32);
    let mut m = Sha512::digest(&r).to_vec();
    m.extend(decode(
        "TdTC5rgxYgkOUrPHpnM7pByyRiuCmrWKGWs521cXdST0m69/COjWjSanLjfBqVovHwWlGJKu8pSXMrYqOKrdWA==",
    )?);
    let hash = Sha512::digest(m);
    let mut plain = Sha512::digest(&z).to_vec();
    plain.extend(z);
    let mut out = vec![116, 99, 5, 16, 0, 0];
    out.extend(r);
    out.extend(enc(&hash[..16], &hash[16..32], &plain)?);
    Ok(out)
}
pub fn key_body(id: &str) -> Result<serde_json::Value, String> {
    let id = id.parse::<u64>().map_err(|_| "设备会话格式错误")?;
    let iv = random(16);
    let encrypted = enc(&unhex(SHARED)?, &iv, &id.to_le_bytes())?;
    let mut v = iv;
    v.extend(encrypted);
    Ok(serde_json::json!({"content":encode(&v)}))
}
pub fn session_key(v: &str) -> Result<Vec<u8>, String> {
    dec(&unhex(SHARED)?, &decode(v)?)
}
pub fn chapter(v: &str, key: &[u8], compressed: bool) -> Result<String, String> {
    let raw = dec(key, &decode(v)?)?;
    let data = if compressed {
        let mut out = vec![];
        flate2::read::GzDecoder::new(raw.as_slice())
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut out)
            .map_err(|_| "正文压缩数据不完整")?;
        out
    } else {
        raw
    };
    if data.len() > 2 * 1024 * 1024 {
        return Err("正文过大".into());
    }
    String::from_utf8(data).map_err(|_| "正文编码不支持".into())
}
pub fn media_key(v: &str) -> Result<Vec<u8>, String> {
    let raw = decode(v)?;
    if raw.len() < 3 {
        return Err("音频参数不完整".into());
    }
    let pad = (raw[0] ^ raw[1] ^ raw[2]) as i32 - 48;
    if pad < 0 || raw.len() < pad as usize + 3 {
        return Err("音频参数无效".into());
    }
    let input = &raw[1..raw.len() - pad as usize];
    let mut prefix = vec![0xfa, 0x55];
    prefix.extend(input);
    let data: Vec<u8> = input
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let mut n = (b ^ prefix[i]) as i32 - i.count_ones() as i32 - 21;
            while n < 0 {
                n += 255;
            }
            n as u8
        })
        .collect();
    let skip = match data[0] {
        b'0'..=b'9' => data[0] - b'0',
        b'a'..=b'z' => data[0] - b'a' + 10,
        _ => return Err("音频参数无效".into()),
    } as usize;
    let end = 1
        + (raw.len() - pad as usize - 2)
            .checked_sub(skip)
            .ok_or("音频参数长度无效")?;
    let key = std::str::from_utf8(data.get(1..end).ok_or("音频参数不完整")?)
        .map_err(|_| "音频参数错误")?;
    let key = unhex(key)?;
    if key.len() != 16 {
        return Err("音频参数长度错误".into());
    }
    Ok(key)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bad_data_rejected() {
        assert!(unhex("f").is_err());
        assert!(media_key("bad").is_err());
        assert!(chapter("AA==", &[0; 16], false).is_err());
    }
    #[test]
    fn vector() {
        let got = argus(
            "device_id=123456&version_name=7.0.1.32",
            b"{}",
            1700000000,
            12345,
        )
        .unwrap();
        assert_eq!(got,"8oG1GzXRCYFxRHbO9/LI7M+nXbi8pQS89TwD6CpCJChU0AVEh3CIe2jMYzfeEPPf8YjAhXha1SY0weUMJ5Gl+nHTLPq2dsfYD9nsP1PXi2nt05nn5IpvRxArnLh8mFdB/RNBHDjXG5wyvQjvScmDfyCBsA5W7BOmLAtqq1VVob2KNVeRnnDMt1kkr3y9IqQBEqIVUdPXaxv6DrVd80EPaxyCPd6XrvaRSuli2Ema+W0DZ61e+7UgfoSNwdYQyNYLU3A=");
        assert!(decode(&got).unwrap().len() > 100);
    }
}
