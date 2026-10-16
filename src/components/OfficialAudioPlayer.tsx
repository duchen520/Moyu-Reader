import type { RefObject } from 'react';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { official, errorMessage } from '../lib/official';
import type { AudioCatalog, AudioEpisode, AudioAlignment } from '../lib/official';
import { readAudioProgress, saveAudioProgress, playableUrl, formatDuration } from '../lib/media';

export function OfficialAudioPlayer({ bookId, chapterId, chapterTitle, stopSignal, onStart, notice, onPlaybackStateChange, controls, onBusyChange }: {
  onBusyChange?: (busy: boolean) => void;
  controls?: RefObject<{ toggle: () => void } | null>;
  bookId: string; chapterId?: string; chapterTitle?: string; stopSignal: number;
  onStart: () => void; notice: (s: string) => void;
  onPlaybackStateChange?: (isPlaying: boolean, statusText: string) => void;
}) {
  const [catalog, setCatalog] = useState<AudioCatalog | null>(null);
  const [albumId, setAlbumId] = useState('');
  const [episodes, setEpisodes] = useState<AudioEpisode[]>([]);
  const [index, setIndex] = useState(0);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('正在检查官方有声版…');
  const [rate, setRate] = useState(1);
  const [continuous, setContinuous] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [retry, setRetry] = useState(0);
  const [checking, setChecking] = useState(false);
  const [alignment, setAlignment] = useState<AudioAlignment | null>(null);
  const [alignmentBusy, setAlignmentBusy] = useState(false);
  const [alignmentStatus, setAlignmentStatus] = useState('');
  const alignedSeconds = useRef<number | undefined>(undefined);
  const manualSelection = useRef(false);
  const directoryAlbum = useRef('');
  const audio = useRef<HTMLAudioElement>(null);
  const request = useRef(0);
  const pendingPlay = useRef(false);
  const fallbackUrls = useRef<string[]>([]);
  const lastSave = useRef(0);
  const saved = useRef(readAudioProgress(bookId));
  const activeEpisode = useRef<AudioEpisode | null>(null);
  const activeContext = useRef<{ bookId: string; albumId: string } | null>(null);
  const metadataReady = useRef(false);
  const objectUrl = useRef('');
  const releaseAudio = () => { if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = ''; } };
  const callbacks = useRef({ onStart, notice, onPlaybackStateChange, onBusyChange }); callbacks.current = { onStart, notice, onPlaybackStateChange, onBusyChange };
  useEffect(() => { callbacks.current.onBusyChange?.(busy); }, [busy]);
  const save = (el = audio.current) => {
    const ep = activeEpisode.current, context = activeContext.current;
    if (!el || !ep || !context || !metadataReady.current || !Number.isFinite(el.currentTime)) return;
    const value = { albumId: context.albumId, episodeId: ep.id, seconds: el.currentTime, updatedAt: Date.now() };
    saved.current = value;
    try { saveAudioProgress(context.bookId, value); }
    catch { callbacks.current.notice('听书位置保存失败，本次播放仍可继续。'); }
  };
  const halt = () => { request.current++; pendingPlay.current = false; audio.current?.pause(); save(); setBusy(false); callbacks.current.onPlaybackStateChange?.(false, '官方音频已暂停'); };
  useEffect(() => {
    let cancelled = false; setChecking(true); setError(''); setCatalog(null); saved.current = readAudioProgress(bookId);
    official.audioCatalog(bookId).then(data => {
      if (cancelled) return;
      setCatalog(data); const restored = data.albums.some(a => a.id === saved.current?.albumId) ? saved.current!.albumId : data.albums[0]?.id ?? '';
      setAlbumId(restored); setStatus(data.albums.length ? '官方有声版已找到，请选择集数试播' : '官方本次未返回有声版，仍可使用电脑朗读');
    }).catch(e => { if (!cancelled) { setError(errorMessage(e)); setStatus('官方有声版读取失败'); } }).finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [bookId, retry]);
  useEffect(() => {
    directoryAlbum.current = '';
    halt(); metadataReady.current = false; setSource(''); setEpisodes([]); setIndex(0); setTime(0); setDuration(0); activeEpisode.current = null; activeContext.current = null;
    if (audio.current) { audio.current.removeAttribute('src'); audio.current.load(); }
    releaseAudio(); fallbackUrls.current = [];
    if (!albumId) return;
    let cancelled = false; setBusy(true); setError('');
    official.audioEpisodes(albumId).then(list => {
      if (cancelled) return;
      if (!list.length) throw new Error('官方未返回有声版集数');
      directoryAlbum.current = albumId;
      setEpisodes(list); const restored = saved.current?.albumId === albumId ? list.findIndex(ep => ep.id === saved.current?.episodeId) : -1;
      setIndex(Math.max(0, restored));
    }).catch(e => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [albumId, retry]);
  useEffect(() => {
    if (!chapterId) return;
    halt(); metadataReady.current = false; activeEpisode.current = null; activeContext.current = null;
    setSource(''); setTime(0); setDuration(0);
    if (audio.current) { audio.current.removeAttribute('src'); audio.current.load(); }
    releaseAudio();
  }, [chapterId]);
  useEffect(() => {
    setAlignment(null); setAlignmentStatus(''); setAlignmentBusy(false); manualSelection.current = false;
    if (!chapterId || !albumId || !episodes.length || directoryAlbum.current !== albumId) return;
    let cancelled = false; setAlignmentBusy(true); setAlignmentStatus('正在核对当前文字章节与有声集数…');
    official.audioAlignment(bookId, chapterId, albumId).then(result => {
      if (cancelled) return;
      if (result.chapterId !== chapterId || result.albumId !== albumId) throw Error('官方对应关系与当前章节或版本不一致');
      if (!result.matched) { setAlignmentStatus('官方未返回本章与该有声版本的对应关系，可手动选集。'); return; }
      const target = episodes.findIndex(ep => ep.id === result.episodeId);
      if (target < 0 || !Number.isFinite(result.seconds) || result.seconds! < 0) throw Error('官方对应的集数不在当前目录中，请重新检查');
      setAlignment(result);
      if (!manualSelection.current) setIndex(target);
      setAlignmentStatus(`当前文字章节对应：第${target + 1}集 · ${formatDuration(result.seconds!)}`);
    }).catch(e => { if (!cancelled) setAlignmentStatus(`本章定位暂不可用：${errorMessage(e)}。仍可手动选集。`); })
      .finally(() => { if (!cancelled) setAlignmentBusy(false); });
    return () => { cancelled = true; };
  }, [bookId, chapterId, albumId, episodes, retry]);
  useEffect(() => { halt(); }, [stopSignal]);
  useEffect(() => { if (audio.current) audio.current.playbackRate = rate; }, [rate]);
  useEffect(() => {
    const el = audio.current;
    return () => {
      request.current++; pendingPlay.current = false;
      if (el) {
        save(el); metadataReady.current = false;
        el.pause(); el.removeAttribute('src'); el.load();
      }
      releaseAudio();
    };
  }, []);
  const play = async (target: number, seconds?: number) => {
    const ep = episodes[target]; if (!ep) return;
    manualSelection.current = true; alignedSeconds.current = seconds;
    save(); audio.current?.pause(); metadataReady.current = false; activeEpisode.current=null; activeContext.current=null;
    if(audio.current){audio.current.removeAttribute('src');audio.current.load();}
    releaseAudio(); fallbackUrls.current = [];
    setSource(''); setTime(0); setDuration(0);
    const generation = ++request.current; setBusy(true); setError(''); setStatus('正在取得本集官方播放信息…'); pendingPlay.current = true;
    callbacks.current.onStart();
    try {
      const info = await official.audioPlay(ep.id);
      if (generation !== request.current) return;
      if (info.itemId !== ep.id) throw new Error('音频响应与所选集数不匹配');
      let urls = info.urls.map(playableUrl).filter((u): u is string => !!u);
      if (info.audioBase64) {
        if (info.mime !== 'audio/mp4' || info.audioBase64.length > 45 * 1024 * 1024) throw new Error('官方音频格式或大小不受支持');
        const raw = atob(info.audioBase64), bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        objectUrl.current = URL.createObjectURL(new Blob([bytes], { type: 'audio/mp4' }));
        urls = [objectUrl.current];
      }
      if (!urls.length) throw new Error('官方没有提供可播放的 HTTPS 音频地址');
      fallbackUrls.current = urls.slice(1); activeEpisode.current=ep; activeContext.current={bookId,albumId}; setIndex(target); setSource(urls[0]);
      if(audio.current){audio.current.src=urls[0];audio.current.load();} setStatus('播放信息已取得，正在加载音频');
    } catch (e) { if (generation === request.current) { pendingPlay.current = false; setError(errorMessage(e)); setStatus('本集试播未成功，可继续使用电脑朗读'); } }
    finally { if (generation === request.current) setBusy(false); }
  };
  useImperativeHandle(controls, () => ({ toggle: () => {
    const el = audio.current;
    if (busy || (el && !el.paused)) halt();
    else if (el?.src && metadataReady.current) { callbacks.current.onStart(); void el.play().catch(() => setStatus('请展开面板后点击播放')); }
    else void play(index);
  } }));
  const metadata = () => {
    const el = audio.current; if (!el) return;
    setDuration(Number.isFinite(el.duration) ? el.duration : 0); el.playbackRate = rate;
    const old = saved.current;
    if (alignedSeconds.current !== undefined) {
      if (!Number.isFinite(el.duration) || alignedSeconds.current >= el.duration) { pendingPlay.current = false; setError('官方章节定位超出本集时长，请重新检查对应关系。'); return; }
      el.currentTime = alignedSeconds.current; alignedSeconds.current = undefined;
    } else if (old?.albumId === albumId && old.episodeId === activeEpisode.current?.id && old.seconds > 0 && Number.isFinite(el.duration)) el.currentTime = Math.min(old.seconds, Math.max(0, el.duration - .1));
    metadataReady.current = true;
    if (pendingPlay.current) { pendingPlay.current = false; void el.play().catch(() => setStatus('音频已加载，请点击播放器的播放按钮')); }
  };
  const mediaError = () => {
    if (!source) return;
    const next = fallbackUrls.current.shift();
    if (next) { pendingPlay.current = true; setSource(next);if(audio.current){audio.current.src=next;audio.current.load();}return; }
    setError('音频播放失败，可能是地址过期、格式受限或网络不可达；可重新试播刷新地址。'); setStatus('音频播放失败');
  };
  return <div className="official-audio">
    <div className="playback-row"><strong>番茄官方真人有声版</strong><button disabled={checking || busy} onClick={() => { halt(); setRetry(n => n+1); }}>重新检查</button></div>
    <p className="audio-status" role="status">{status}</p>
    {catalog && !!catalog.albums.length && <div className="playback-row">
      <label>版本 <select aria-label="官方有声版本" value={albumId} onChange={e => { halt(); setAlbumId(e.target.value); }}>{catalog.albums.map(a => <option key={a.id} value={a.id}>{a.name} · {a.narrator}</option>)}</select></label>
      <label>集数 <select aria-label="有声集数" value={index} onChange={e => { manualSelection.current=true; halt(); metadataReady.current=false; setSource(''); activeEpisode.current=null;activeContext.current=null;if(audio.current){audio.current.removeAttribute('src');audio.current.load();}releaseAudio();setIndex(Number(e.target.value));setStatus('已切换集数，点击播放本集'); }}>{episodes.map((ep,i) => <option key={ep.id} value={i}>{i+1}. {ep.title}</option>)}</select></label>
      <button disabled={busy || !episodes.length} onClick={() => void play(index)}>播放本集</button>
      <button disabled={busy || index<=0} onClick={() => void play(index-1)}>上一集</button><button disabled={busy || index>=episodes.length-1} onClick={() => void play(index+1)}>下一集</button>
      <div className="chip-group" role="group" aria-label="有声倍速" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>倍速:</span>
        {[.75, 1, 1.25, 1.5, 2].map(r => (
          <button key={r} type="button" aria-pressed={rate === r} className={`chip-item ${rate === r ? 'active' : ''}`} onClick={() => setRate(r)}>{r}×</button>
        ))}
      </div>
      <label><input type="checkbox" checked={continuous} onChange={e => setContinuous(e.target.checked)}/> 连续下一集</label>
    </div>}
    {chapterId && <div className="audio-alignment"><p className="small-note">{chapterTitle} · {alignmentStatus}</p><button className="comment-detail-button" disabled={busy || alignmentBusy || !alignment} onClick={() => { const target = episodes.findIndex(ep => ep.id === alignment?.episodeId); if (target >= 0) void play(target, alignment?.seconds); }}>从当前文字章节播放</button></div>}
    <audio ref={audio} controls preload="metadata" onLoadedMetadata={metadata}
      onPlay={() => { callbacks.current.onStart(); setStatus('正在播放官方音频'); callbacks.current.onPlaybackStateChange?.(true, `官方有声: 第 ${index + 1} 集`); }}
      onPause={() => { save(); if(source) setStatus('官方音频已暂停'); callbacks.current.onPlaybackStateChange?.(false, '官方音频已暂停'); }}
      onTimeUpdate={() => { const el=audio.current; if(!el)return;setTime(el.currentTime);if(Date.now()-lastSave.current>=1000){lastSave.current=Date.now();save();} }}
      onError={mediaError} onEnded={() => { if(!source || !activeEpisode.current || !audio.current?.ended)return;save(); callbacks.current.onPlaybackStateChange?.(false, '本集播放结束'); if(continuous && index+1<episodes.length) void play(index+1);else setStatus('本集播放结束'); }}/>
    {source && <span className="audio-time">{formatDuration(time)} / {formatDuration(duration)}</span>}
    {error && <p className="audio-error" role="alert">{error}</p>}
    <small>首次播放需加载本集音频（上限32MB）。有声集数与文字章节独立，通过官方对应关系定位到集数和秒数；听书位置保存在本机，不上传官方账号。</small>
  </div>;
}
