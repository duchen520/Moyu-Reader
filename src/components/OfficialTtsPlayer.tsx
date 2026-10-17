import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { official, errorMessage } from '../lib/official';
import { base64ToBlobUrl } from '../lib/media';

interface Props {
  bookId: string; chapterId: string; chapterTitle: string; nextChapterId?: string;
  disabled: boolean; stopSignal: number; onStart: () => void; onNext: () => void;
  onBusyChange?: (busy: boolean) => void;
  controls?: RefObject<{ toggle: () => void; play: () => void; pause: () => void } | null>;
  paragraphs?: string[];
  onProgress?: (data: { activeParagraph: number; percent: number; isPlaying: boolean; statusText: string }) => void;
  onPlaybackStateChange?: (isPlaying: boolean) => void;
}
interface Position { chapterId: string; toneId: string; seconds: number }
const key = (bookId: string) => 'tomato-reader-v056:tts:' + bookId;
function position(bookId: string): Position | null {
  try {
    const value = JSON.parse(localStorage.getItem(key(bookId)) ?? 'null');
    return value && typeof value.chapterId === 'string' && typeof value.toneId === 'string' && Number.isFinite(value.seconds) && value.seconds >= 0 ? value : null;
  } catch { return null; }
}

export function OfficialTtsPlayer(props: Props) {
  const [tones, setTones] = useState<{ id: string; name: string }[]>([]);
  const [tone, setTone] = useState('');
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [continuous, setContinuous] = useState(true);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('正在读取番茄AI音色…');
  const [retry, setRetry] = useState(0);
  const paragraphCharOffsets = useMemo(() => {
    let sum = 0;
    return (props.paragraphs || []).map(p => {
      sum += p.length;
      return sum;
    });
  }, [props.paragraphs]);
  const audio = useRef<HTMLAudioElement>(null);
  const latest = useRef(props); latest.current = props;
  useEffect(() => { latest.current.onBusyChange?.(busy); }, [busy]);
  const request = useRef(0);
  const requestBusy = useRef(false);
  const objectUrl = useRef('');
  const context = useRef<(Position & { bookId: string }) | null>(null);
  const ready = useRef(false);
  const pendingPlay = useRef(false);
  const next = useRef<string | null>(null);
  const seek = useRef<{ chapterId: string; seconds: number } | null>(null);
  const savedAt = useRef(0);
  const save = () => {
    const el = audio.current, current = context.current;
    if (!el || !ready.current || !current || !Number.isFinite(el.currentTime)) return;
    try { localStorage.setItem(key(current.bookId), JSON.stringify({ chapterId: current.chapterId, toneId: current.toneId, seconds: el.ended ? 0 : el.currentTime })); }
    catch { setError('AI听书位置保存失败，本次播放仍可继续。'); }
  };
  const halt = () => {
    request.current++; requestBusy.current = false; pendingPlay.current = false; next.current = null;
    save(); audio.current?.pause(); setBusy(false); setPlaying(false);
    latest.current.onPlaybackStateChange?.(false);
  };
  const clear = () => {
    halt(); ready.current = false; context.current = null;
    if (audio.current) { audio.current.removeAttribute('src'); audio.current.load(); }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = '';
  };
  const play = async () => {
    if (!tone || props.disabled || requestBusy.current || (audio.current && !audio.current.paused)) return;
    const el = audio.current;
    if (el?.src && ready.current && context.current?.chapterId === props.chapterId && context.current.toneId === tone) {
      props.onStart();
      try { await el.play(); } catch { setStatus('请点击播放器的播放按钮继续'); }
      return;
    }
    clear(); setError(''); setBusy(true); setStatus('正在加载本章番茄AI音频…');
    const generation = ++request.current; requestBusy.current = true;
    const { bookId, chapterId } = props;
    props.onStart();
    try {
      const info = await official.ttsPlay(bookId, chapterId, tone);
      if (generation !== request.current) return;
      if (info.itemId !== chapterId || info.toneId !== tone) throw Error('AI音频与当前章节或音色不匹配');
      if (info.mime !== 'audio/mp4' || !info.audioBase64 || info.audioBase64.length > 45 * 1024 * 1024) throw Error('官方未返回支持的AI音频');
      const url = await base64ToBlobUrl(info.audioBase64, 'audio/mp4');
      if (generation !== request.current) { URL.revokeObjectURL(url); return; }
      objectUrl.current = url;
      context.current = { bookId, chapterId, toneId: tone, seconds: 0 };
      pendingPlay.current = true;
      if (audio.current) { audio.current.src = objectUrl.current; audio.current.load(); }
      setStatus('AI音频已取得，正在准备播放…');
    } catch (e) { if (generation === request.current) { setError(errorMessage(e)); setStatus('本章AI朗读未成功，可重试或使用电脑朗读'); } }
    finally { if (generation === request.current) { requestBusy.current = false; setBusy(false); } }
  };
  useEffect(() => {
    let cancelled = false; setChecking(true); setError('');
    official.audioCatalog(props.bookId).then(catalog => {
      if (cancelled) return;
      const list = catalog.ttsTones.filter(t => /^\d{1,10}$/.test(t.id) && t.name);
      setTones(list);
      setTone(old => list.some(t => t.id === old) ? old : list.find(t => t.id === position(props.bookId)?.toneId)?.id ?? list[0]?.id ?? '');
      setStatus(list.length ? '选择番茄音色，点击播放本章' : '该书本次没有返回AI音色，可使用电脑朗读');
    }).catch(e => { if (!cancelled) { setError(errorMessage(e)); setStatus('AI音色读取失败'); } })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [props.bookId, retry]);
  useEffect(() => {
    const expected = next.current;
    clear();
    if (expected === props.chapterId && props.disabled) next.current = expected;
    else if (expected === props.chapterId && !props.disabled) void play();
    else setStatus(tones.length ? '选择番茄音色，点击播放本章' : '正在读取番茄AI音色…');
    seek.current = null;
  }, [props.bookId, props.chapterId, props.disabled]);
  useEffect(() => { halt(); }, [props.stopSignal]);
  useEffect(() => { if (audio.current) audio.current.playbackRate = rate; }, [rate]);
  useEffect(() => {
    const saveOnHide = () => { if (document.visibilityState === 'hidden') save(); };
    const saveOnClose = () => save();
    document.addEventListener('visibilitychange', saveOnHide);
    window.addEventListener('pagehide', saveOnClose);
    return () => { document.removeEventListener('visibilitychange', saveOnHide); window.removeEventListener('pagehide', saveOnClose); clear(); };
  }, []);
  useImperativeHandle(props.controls, () => ({ toggle: () => { if (busy || (audio.current && !audio.current.paused)) halt(); else void play(); }, play: () => { void play(); }, pause: halt }));
  const metadata = () => {
    const el = audio.current, current = context.current;
    if (!el || !current || el.currentSrc !== objectUrl.current) return;
    const old = position(current.bookId);
    const seconds = seek.current?.chapterId === current.chapterId ? seek.current.seconds : old?.chapterId === current.chapterId && old.toneId === current.toneId ? old.seconds : 0;
    if (Number.isFinite(el.duration) && el.duration > 0) el.currentTime = Math.min(seconds, Math.max(0, el.duration - .1));
    seek.current = null; ready.current = true; el.playbackRate = rate;
    if (pendingPlay.current) { pendingPlay.current = false; void el.play().catch(() => setStatus('音频已就绪，请点击播放本章')); }
  };
  return <div className="official-audio official-tts">
    <div className="playback-row"><strong>番茄AI朗读</strong><button disabled={busy || checking} onClick={() => { clear(); setRetry(n => n + 1); }}>刷新AI音色</button></div>
    <p className="audio-status" role="status">{status}</p>
    {!!tones.length && <div className="playback-row">
      <label>音色 <select aria-label="番茄AI音色" value={tone} disabled={checking} onChange={e => {
        const el = audio.current;
        const seconds = ready.current && el ? el.currentTime : 0;
        clear(); seek.current = { chapterId: props.chapterId, seconds }; setTone(e.target.value); setError(''); setStatus('音色已切换，点击播放本章');
      }}>{tones.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <button disabled={busy || checking || props.disabled} onClick={() => { if (playing) { halt(); setStatus('番茄AI朗读已暂停'); } else void play(); }}>{busy ? '正在加载AI音频…' : playing ? '暂停AI朗读' : '播放本章'}</button>
      <button disabled={!busy && !objectUrl.current} onClick={() => { halt(); setStatus('番茄AI朗读已停止'); }}>停止AI朗读</button>
      <div className="chip-group" role="group" aria-label="AI朗读倍速" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>倍速:</span>
        {[.75, 1, 1.25, 1.5, 2].map(r => (
          <button key={r} type="button" aria-pressed={rate === r} className={`chip-item ${rate === r ? 'active' : ''}`} onClick={() => setRate(r)}>{r}×</button>
        ))}
      </div>
      <label><input type="checkbox" checked={continuous} onChange={e => setContinuous(e.target.checked)} /> 连续朗读下一章</label>
    </div>}
    <div className="tts-chapter-title">当前章节：{props.chapterTitle}</div>
    <audio ref={audio} aria-label="番茄AI章节播放器" controls preload="metadata" onLoadedMetadata={metadata}
      onPlay={() => { latest.current.onStart(); setPlaying(true); setStatus('正在播放番茄AI朗读'); latest.current.onPlaybackStateChange?.(true); }}
      onPause={() => { save(); setPlaying(false); latest.current.onPlaybackStateChange?.(false); }}
      onTimeUpdate={() => {
        const el = audio.current;
        if (el && ready.current && context.current?.chapterId === props.chapterId && Number.isFinite(el.duration) && el.duration > 0 && paragraphCharOffsets.length > 0) {
          const ratio = Math.min(1, Math.max(0, el.currentTime / el.duration));
          const totalChars = paragraphCharOffsets[paragraphCharOffsets.length - 1] || 1;
          const currentChars = ratio * totalChars;
          let activeIdx = paragraphCharOffsets.findIndex(c => c >= currentChars);
          if (activeIdx < 0) activeIdx = paragraphCharOffsets.length - 1;
          const percent = Math.round(ratio * 100);
          props.onProgress?.({
            activeParagraph: activeIdx,
            percent,
            isPlaying: !el.paused,
            statusText: `AI朗读估算 第 ${activeIdx + 1}/${paragraphCharOffsets.length} 段 (${percent}%)`
          });
        }
        if (Date.now() - savedAt.current > 1000) { savedAt.current = Date.now(); save(); }
      }}
      onError={() => { if (objectUrl.current) { pendingPlay.current = false; setPlaying(false); setError('本章AI音频播放失败，请重试加载。'); latest.current.onPlaybackStateChange?.(false); } }}
      onEnded={() => {
        if (!ready.current || !audio.current?.ended || context.current?.chapterId !== latest.current.chapterId) return;
        save(); setPlaying(false); latest.current.onPlaybackStateChange?.(false);
        if (continuous && latest.current.nextChapterId) { next.current = latest.current.nextChapterId; latest.current.onNext(); }
        else setStatus('本章AI朗读结束');
      }} />
    {error && <p className="audio-error" role="alert">{error}</p>}
    <small>使用番茄为该书提供的AI音色，首次播放需加载本章音频。切换音色后点击播放可接着听；听书秒数保存在本机。自动切章沿用现有的云端上传开关。</small>
  </div>;
}
