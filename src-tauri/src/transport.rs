//! Shared per-host pacing and cooldown. Never replay a request, including writes.
use reqwest::{header::RETRY_AFTER, RequestBuilder, Response};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::{sync::Mutex, time::Instant};

const SPACING: Duration = Duration::from_millis(500);

#[derive(Default)]
struct HostState {
    next_request: Option<Instant>,
    blocked: Option<(Instant, Duration)>,
    strikes: u32,
}

#[derive(Default)]
pub(crate) struct Transport {
    hosts: Mutex<HashMap<String, Arc<Mutex<HostState>>>>,
}

fn retry_after(raw: Option<&str>, now: SystemTime) -> Option<Duration> {
    let raw = raw?.trim();
    if !raw.is_empty() && raw.bytes().all(|c| c.is_ascii_digit()) {
        return raw.parse::<u64>().ok().map(Duration::from_secs);
    }
    httpdate::parse_http_date(raw)
        .ok()?
        .duration_since(now)
        .ok()
}

fn backoff(strikes: u32, hint: Option<Duration>) -> Duration {
    // 60, 120, 240, 480, 900 seconds. Do not truncate the server's longer hint.
    let seconds = (60u64 << strikes.saturating_sub(1).min(4)).min(900);
    Duration::from_secs(seconds).max(hint.unwrap_or_default())
}

fn remaining_message(started: Instant, wait: Duration, now: Instant) -> Option<String> {
    let elapsed = now.saturating_duration_since(started);
    if elapsed >= wait {
        return None;
    }
    let remaining = wait - elapsed;
    let seconds = remaining
        .as_secs()
        .saturating_add(u64::from(remaining.subsec_nanos() > 0));
    Some(format!(
        "官方服务正在冷却，请等待 {seconds} 秒后再试；本次没有发送请求"
    ))
}

impl Transport {
    // Public image CDNs use a bounded download pool in CoverCache. Reserve
    // dispatch slots without holding the host mutex throughout the network
    // round trip; API calls continue using send() and its original 500ms rule.
    pub(crate) async fn send_asset(&self, builder: RequestBuilder) -> Result<Response, String> {
        let (client, request) = builder.build_split();
        let request = request.map_err(|_| "封面请求构建失败")?;
        let host = request.url().host_str().ok_or("封面地址缺少主机")?.to_string();
        let shared = {
            let mut hosts = self.hosts.lock().await;
            hosts.entry(host).or_default().clone()
        };
        {
            let mut state = shared.lock().await;
            if let Some((started, wait)) = state.blocked {
                if let Some(error) = remaining_message(started, wait, Instant::now()) {return Err(error);}
                state.blocked = None;
            }
            if let Some(next) = state.next_request {tokio::time::sleep_until(next).await;}
            state.next_request = Some(Instant::now() + Duration::from_millis(200));
        }
        let response = client.execute(request).await.map_err(|_| "封面连接失败，请稍后重试")?;
        let status = response.status().as_u16();
        let mut state = shared.lock().await;
        if matches!(status, 429 | 503) {
            state.strikes = state.strikes.saturating_add(1);
            let wait = backoff(state.strikes, retry_after(response.headers().get(RETRY_AFTER).and_then(|h|h.to_str().ok()), SystemTime::now()));
            state.blocked = Some((Instant::now(), wait));
            return Err(format!("图片服务返回HTTP {status}，请等待{}秒后再试",wait.as_secs()));
        }
        // A concurrent successful image must never clear another image's 429.
        if response.status().is_success() && state.blocked.is_none() {state.strikes = 0;}
        Ok(response)
    }

    pub(crate) async fn send(&self, builder: RequestBuilder) -> Result<Response, String> {
        let (client, request) = builder.build_split();
        let request = request.map_err(|_| "官方请求构建失败")?;
        let host = request
            .url()
            .host_str()
            .ok_or("官方请求地址缺少主机")?
            .to_string();
        let state = {
            let mut hosts = self.hosts.lock().await;
            hosts.entry(host).or_default().clone()
        };
        // Hold only this host's lock across dispatch, so concurrent callers cannot
        // race a 429 or clear another response's cooldown. Other hosts are independent.
        let mut state = state.lock().await;
        if let Some((started, wait)) = state.blocked {
            if let Some(error) = remaining_message(started, wait, Instant::now()) {
                return Err(error);
            }
        }
        if let Some(next) = state.next_request {
            tokio::time::sleep_until(next).await;
        }
        let response = client.execute(request).await;
        state.next_request = Some(Instant::now() + SPACING);
        let response = response.map_err(|_| "无法连接番茄官方服务，请检查网络后重试")?;
        let status = response.status().as_u16();
        if matches!(status, 429 | 503) {
            state.strikes = state.strikes.saturating_add(1);
            let hint = retry_after(
                response
                    .headers()
                    .get(RETRY_AFTER)
                    .and_then(|h| h.to_str().ok()),
                SystemTime::now(),
            );
            let wait = backoff(state.strikes, hint);
            // Keep duration separately: a large server hint must not overflow Instant.
            state.blocked = Some((Instant::now(), wait));
            return Err(format!(
                "官方服务返回 HTTP {status}，请等待 {} 秒后再试；已停止重复请求",
                wait.as_secs()
            ));
        }
        if response.status().is_success() {
            state.strikes = 0;
            state.blocked = None;
        }
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::atomic::{AtomicUsize, Ordering},
    };

    #[tokio::test]
    async fn late_successful_image_cannot_erase_a_concurrent_cooldown() {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();
        let server=std::thread::spawn(move || {
            let mut handlers=Vec::new();
            for index in 0..2 {
                let (mut socket,_)=listener.accept().unwrap();
                handlers.push(std::thread::spawn(move || {
                    socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                    let mut request=Vec::new();let mut buffer=[0;1024];
                    while !request.windows(4).any(|s|s==b"\r\n\r\n") {let n=socket.read(&mut buffer).unwrap();if n==0 {break;}request.extend_from_slice(&buffer[..n]);}
                    std::thread::sleep(Duration::from_millis(if index==0 {300}else{400}));
                    let status=if index==0 {429}else{200};
                    socket.write_all(format!("HTTP/1.1 {status} Result\r\nContent-Length: 0\r\nRetry-After: 1800\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
                    let _=socket.shutdown(std::net::Shutdown::Write);
                    while matches!(socket.read(&mut buffer),Ok(n) if n>0) {}
                }));
            }
            for handler in handlers {handler.join().unwrap();}
        });
        let client=reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap();let transport=Transport::default();let url=format!("http://{address}/cover");
        let (first,second)=tokio::join!(transport.send_asset(client.get(&url)),transport.send_asset(client.get(&url)));
        assert!(first.unwrap_err().contains("429"));assert!(second.is_ok());drop(second);
        assert!(transport.send_asset(client.get(&url)).await.unwrap_err().contains("没有发送请求"));
        server.join().unwrap();
    }

    #[test]
    fn server_wait_and_exponential_delay() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert_eq!(
            retry_after(Some("120"), now),
            Some(Duration::from_secs(120))
        );
        let date = httpdate::fmt_http_date(now + Duration::from_secs(1800));
        assert_eq!(
            retry_after(Some(&date), now),
            Some(Duration::from_secs(1800))
        );
        for raw in ["-3", "1.5", "junk", "18446744073709551616"] {
            assert_eq!(retry_after(Some(raw), now), None);
        }
        assert_eq!(backoff(1, None), Duration::from_secs(60));
        assert_eq!(backoff(2, None), Duration::from_secs(120));
        assert_eq!(backoff(99, None), Duration::from_secs(900));
        assert_eq!(
            backoff(1, Some(Duration::from_secs(1800))),
            Duration::from_secs(1800)
        );
        let instant = Instant::now();
        assert!(remaining_message(
            instant,
            Duration::from_secs(60),
            instant + Duration::from_secs(60)
        )
        .is_none());
        assert!(
            remaining_message(instant, Duration::from_millis(1), instant)
                .unwrap()
                .contains("1 秒")
        );
        let huge = retry_after(Some("18446744073709551615"), now).unwrap();
        assert!(remaining_message(instant, huge, instant)
            .unwrap()
            .contains("18446744073709551615 秒"));
    }

    #[tokio::test]
    async fn concurrent_calls_and_new_clients_cannot_bypass_cooldown() {
        for status in [429, 503] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = listener.local_addr().unwrap();
            let count = Arc::new(AtomicUsize::new(0));
            let seen = count.clone();
            let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let done_clone = done.clone();
            let server = std::thread::spawn(move || {
                let end = std::time::Instant::now() + Duration::from_secs(5);
                while std::time::Instant::now() < end && !done_clone.load(Ordering::SeqCst) {
                    if let Ok((mut socket, _)) = listener.accept() {
                        // TCP reads can split headers. Closing after one partial
                        // read resets the connection on Windows instead of
                        // delivering the HTTP response this test is exercising.
                        socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                        let mut request = Vec::new();
                        let mut buffer = [0u8; 1024];
                        while request.len() < 16384 && !request.windows(4).any(|part| part == b"\r\n\r\n") {
                            match socket.read(&mut buffer) {
                                Ok(0) | Err(_) => break,
                                Ok(length) => request.extend_from_slice(&buffer[..length]),
                            }
                        }
                        seen.fetch_add(1, Ordering::SeqCst);
                        // Let the client finish flushing its request on fast
                        // loopback connections before sending a zero-body reply.
                        std::thread::sleep(Duration::from_millis(5));
                        let _ = socket.write_all(format!("HTTP/1.1 {status} Limited\r\nRetry-After: 1800\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
                        let _ = socket.flush();
                        // Gracefully finish the mock response and drain the peer.
                        // Dropping a Windows socket immediately after write can
                        // reset the connection before reqwest receives the 429.
                        let _ = socket.shutdown(std::net::Shutdown::Write);
                        while matches!(socket.read(&mut buffer), Ok(length) if length > 0) {}

                    } else {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                }
            });
            let transport = Transport::default();
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let url = format!("http://{address}/read");
            let (a, b) = tokio::join!(
                transport.send(client.get(&url)),
                transport.send(client.post(&url))
            );
            let errors = [a.err().unwrap(), b.err().unwrap()];
            assert!(
                errors.iter().any(|e| e.contains("HTTP") && e.contains("1800")),
                "Expected HTTP and 1800 in errors, but got: {:?}",
                errors
            );
            assert!(errors.iter().any(|e| e.contains("没有发送请求")), "Expected a blocked second request, got: {:?}", errors);
            let replacement_client = reqwest::Client::builder().no_proxy().build().unwrap();
            assert!(transport
                .send(replacement_client.get(&url))
                .await
                .err()
                .unwrap()
                .contains("没有发送请求"));
            done.store(true, Ordering::SeqCst);
            server.join().unwrap();
            assert_eq!(count.load(Ordering::SeqCst), 1);
        }
    }
}
