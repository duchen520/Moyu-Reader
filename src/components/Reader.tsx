import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { ArrowLeft, BookMarked, ChevronLeft, ChevronRight, ChevronUp, Headphones, MessageSquare, Pause, Play, Radio, ScrollText, Settings2, Sparkles, Square, Volume2, X } from 'lucide-react';
import type { Book, Preferences, ReadingProgress } from '../types';
import { SpeechReader } from '../lib/speech';
import type { SpeechState } from '../lib/speech';
import { CommentsPanel } from './OfficialPanel';
import { OfficialAudioPlayer } from './OfficialAudioPlayer';
import { OfficialTtsPlayer } from './OfficialTtsPlayer';
import { LocalTtsPlayer } from './LocalTtsPlayer';
import type { LocalSpeechState } from '../lib/localSpeech';
import { useParagraphBubbles, ParagraphCommentsPanel } from './ParagraphComments';
import { readingParagraph } from '../lib/readerPosition';
import { useContinuousReading } from './useContinuousReading';
import { APP_NAME } from '../lib/branding';
import { updateMediaSessionMetadata, setMediaSessionPlaybackState, updateMediaSessionHandlers, clearMediaSession } from '../lib/mediaSession';

export function Reader({ book, index, prefs, initialProgress, onJump, onVisible, loadChapter, onBack, onSave, onSync, onRefreshCloud, onReadHistory, historyBusy, cloudRefreshing, canSync, syncStatus, loading, loadError, onRetry, onOfficial, settings, notice }: {
  book: Book; index: number; prefs: Preferences; initialProgress?: ReadingProgress;
  onVisible: (index: number) => void; loadChapter: (index: number) => Promise<void>;
  onJump: (index: number) => void; onBack: () => void;
  onSave: (chapterIndex: number, scrollRatio: number, paragraphIndex: number) => void;
  onSync: () => void; onRefreshCloud: () => void; cloudRefreshing: boolean; canSync: boolean; syncStatus: string; loading: boolean; loadError: string; onRetry: () => void; onOfficial: () => void;
  onReadHistory: () => void; historyBusy: boolean;
  settings: ReactNode; notice: (s: string) => void;
}) {
  const chapter = book.chapters[index];
  const paragraphs = useMemo(() => chapter.content.split(/\n\s*\n|\n/).map(s => s.trim()).filter(Boolean), [chapter.content]);
  const [showChapters, setShowChapters] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [showAudio, setShowAudio] = useState(false);
  const [activeAudioTab, setActiveAudioTab] = useState<'speech' | 'kokoro' | 'tts' | 'audio' | 'auto'>('speech');
  const [openedPlayers, setOpenedPlayers] = useState({ tts: false, audio: false, kokoro: false });
  const [playbackSession, setPlaybackSession] = useState<'tts' | 'audio' | 'kokoro' | null>(null);
  const [kokoroState, setKokoroState] = useState<LocalSpeechState>({ status: 'stopped', paragraph: -1, unit: 0 });
  const [kokoroStopSignal, setKokoroStopSignal] = useState(0);
  const kokoroControls = useRef<{ toggle: () => void; play: () => void; pause: () => void } | null>(null);
  const [pausedAuto, setPausedAuto] = useState<'off' | 'scroll' | 'page'>('off');
  const [ttsStopSignal, setTtsStopSignal] = useState(0);
  const [recordedStopSignal, setRecordedStopSignal] = useState(0);
  const ttsControls = useRef<{ toggle: () => void; play: () => void; pause: () => void } | null>(null);
  const recordedControls = useRef<{ toggle: () => void; play: () => void; pause: () => void; previous: () => void; next: () => void; seek: (seconds: number) => void; metadata: () => { title: string; artist: string; album: string } | null } | null>(null);
  const [followEstimated, setFollowEstimated] = useState(false);
  const [ttsActiveParagraph, setTtsActiveParagraph] = useState(-1);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [recordedLoading, setRecordedLoading] = useState(false);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [ttsProgressText, setTtsProgressText] = useState('');
  const [officialAudioPlaying, setOfficialAudioPlaying] = useState(false);
  const [officialAudioText, setOfficialAudioText] = useState('');
  const [bubblesEnabled, setBubblesEnabled] = useState(prefs.showParagraphComments !== false);
  const [selectedParagraph, setSelectedParagraph] = useState<{ chapterId: string; id: number; index: number } | null>(null);
  const paragraphComments = useParagraphBubbles(chapter, book.source === 'official' && bubblesEnabled && !loading && !loadError);
  useEffect(() => { setBubblesEnabled(prefs.showParagraphComments !== false); }, [prefs.showParagraphComments]);
  useEffect(() => { setSelectedParagraph(null); }, [book.id, chapter.id]);
  const openParagraph = useCallback((id: number, index: number) => {
    setSelectedParagraph({ chapterId: latest.current.book.chapters[latest.current.index].id, id, index });
    setShowComments(false); setShowSettings(false);
  }, []);
  const [audioStopSignal, setAudioStopSignal] = useState(0);
  const [speech, setSpeech] = useState<SpeechState>({ status: 'stopped', unit: 0, paragraph: -1 });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState('');
  const [rate, setRate] = useState(1);
  const heldPointer = useRef<number | null>(null);
  const [autoHeld, setAutoHeld] = useState(false);
  const [auto, setAuto] = useState<'off' | 'scroll' | 'page'>('off');
  const [speed, setSpeed] = useState(25);
  const [pageSeconds, setPageSeconds] = useState(15);
  const [sleep, setSleep] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const canvas = useRef<HTMLElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const paragraphRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const engine = useRef<SpeechReader | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const continueSpeech = useRef(false);
  const latest = useRef({ onSave, onJump, onBack, notice, index, book, speech, loading, loadError });
  latest.current = { onSave, onJump, onBack, notice, index, book, speech, loading, loadError };
  const lastPosition = useRef(initialProgress);
  const continuous = useContinuousReading({ enabled: prefs.readingMode === 'continuous', book, index, prefs, canvas, initialProgress: lastPosition.current, onVisible, loadChapter });
  const continuousRef = useRef(continuous); continuousRef.current = continuous;
  const restoration = useRef(initialProgress);
  const restoredChapter = useRef('');
  const supportsSpeech = typeof window.speechSynthesis !== 'undefined';
  const pendingPosition = useRef<{ save: typeof onSave; index: number; ratio: number; paragraph: number } | null>(null);
  const flushPosition = () => {
    const pending = pendingPosition.current;
    pendingPosition.current = null;
    if (pending) pending.save(pending.index, pending.ratio, pending.paragraph);
  };
  const capturePosition = () => {
    const el = canvas.current;
    const current = latest.current;
    if (continuousRef.current.enabled) {
      const position = continuousRef.current.position();
      if (position) {
        pendingPosition.current = { save: current.onSave, ...position };
        lastPosition.current = { chapterIndex: position.index, scrollRatio: position.ratio, paragraphIndex: position.paragraph, updatedAt: Date.now() };
      }
      return;
    }
    const content = current.book.chapters[current.index];
    if (!el || current.loading || current.loadError || !content?.content || restoredChapter.current !== `${current.book.id}:${content.id}`) return;
    const ratio = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);
    const viewportTop = el.getBoundingClientRect().top;
    const visible = readingParagraph(paragraphRefs.current, viewportTop);
    pendingPosition.current = { save: current.onSave, index: current.index, ratio: Math.min(1, Math.max(0, ratio)), paragraph: Math.max(0, visible) };
    lastPosition.current = { chapterIndex: current.index, scrollRatio: ratio, paragraphIndex: Math.max(0, visible), updatedAt: Date.now() };
  };
  const savePosition = () => { capturePosition(); flushPosition(); };
  useLayoutEffect(() => () => {
    clearTimeout(saveTimer.current);
    flushPosition();
  }, [book.id, chapter.id]);
  const stop = () => {
    continueSpeech.current = false;
    engine.current?.stop();
    setAudioStopSignal(n => n + 1);
    setTtsPlaying(false);
    setOfficialAudioPlaying(false);
    setPlaybackSession(null); setPausedAuto('off');
  };
  const currentActiveParagraph = speech.status === 'playing'
    ? speech.paragraph
    : kokoroState.status === 'playing' ? kokoroState.paragraph
    : ttsPlaying && followEstimated
      ? ttsActiveParagraph
      : -1;
  const isAudioActive = speech.status !== 'stopped' || playbackSession !== null || auto !== 'off' || pausedAuto !== 'off';
  const miniPlaying = speech.status === 'playing' || kokoroState.status === 'playing' || ttsPlaying || officialAudioPlaying || auto !== 'off';
  const miniLoading = playbackSession === 'kokoro' ? kokoroState.status === 'loading' : playbackSession === 'tts' ? ttsLoading : playbackSession === 'audio' ? recordedLoading : false;
  const miniAction = miniLoading ? '取消加载' : miniPlaying ? '暂停播放' : '继续播放';
  useEffect(() => { setTtsActiveParagraph(-1); setTtsProgressText(''); setPausedAuto('off'); }, [book.id, chapter.id]);
  useEffect(() => {
    if (!supportsSpeech) return;
    const synth = window.speechSynthesis;
    const updateVoices = () => setVoices(synth.getVoices());
    updateVoices(); synth.addEventListener('voiceschanged', updateVoices);
    engine.current = new SpeechReader(synth, setSpeech, () => {
      const { book: b, index: i, onJump: jump } = latest.current;
      if (i + 1 < b.chapters.length) { continueSpeech.current = true; jump(i + 1); }
      else latest.current.notice('已朗读至全书末尾。');
    }, s => latest.current.notice(s));
    return () => { synth.removeEventListener('voiceschanged', updateVoices); engine.current?.stop(); engine.current = null; };
  }, [supportsSpeech]);
  useEffect(() => {
    engine.current?.setText(paragraphs);
    paragraphRefs.current.length = paragraphs.length;
    if (continueSpeech.current && paragraphs.length) { continueSpeech.current = false; engine.current?.start(0); }
    // Text change is the only event that resets playback. Scroll and settings don't reset it.
  }, [book.id, chapter.id, chapter.content]);
  useEffect(() => { engine.current?.configure(rate, voiceURI); }, [rate, voiceURI]);
  useLayoutEffect(() => { restoredChapter.current = ''; restoration.current = lastPosition.current; }, [prefs.readingMode]);
  useLayoutEffect(() => {
    if (prefs.readingMode === 'continuous' || loading || !chapter.content || !canvas.current) return;
    const key = `${book.id}:${chapter.id}`;
    if (restoredChapter.current === key) return;
    restoredChapter.current = key;
    const el = canvas.current;
    const saved = restoration.current;
    const ratio = saved?.chapterIndex === index ? saved.scrollRatio ?? 0 : 0;
    el.scrollTop = ratio * Math.max(0, el.scrollHeight - el.clientHeight);
    restoration.current = undefined;
  }, [book.id, chapter.id, chapter.content, loading, prefs.readingMode]);
  useEffect(() => {
    if (currentActiveParagraph >= 0) {
      paragraphRefs.current[currentActiveParagraph]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [currentActiveParagraph]);
  useEffect(() => {
    const saveOnHide = () => { if (document.visibilityState === 'hidden') savePosition(); };
    const saveOnClose = () => savePosition();
    document.addEventListener('visibilitychange', saveOnHide); window.addEventListener('pagehide', saveOnClose);
    return () => { clearTimeout(saveTimer.current); document.removeEventListener('visibilitychange', saveOnHide); window.removeEventListener('pagehide', saveOnClose); };
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey || (e.target instanceof HTMLElement && (e.target.matches('input,textarea,select,button') || e.target.isContentEditable))) return;
      if (e.key === 'Escape') { savePosition(); stop(); setAuto('off'); latest.current.onBack(); return; }
      if (!['ArrowRight','ArrowLeft','PageDown','PageUp',' '].includes(e.key)) return;
      e.preventDefault();
      const direction = e.key === 'ArrowLeft' || e.key === 'PageUp' ? -1 : 1;
      const el = canvas.current;
      if (e.ctrlKey) { stop(); latest.current.onJump(latest.current.index + direction); }
      else if (el) {
        const atEdge = direction > 0 ? el.scrollTop + el.clientHeight >= el.scrollHeight - 2 : el.scrollTop <= 2;
        if (atEdge) { stop(); latest.current.onJump(latest.current.index + direction); }
        else { setAuto('off'); el.scrollBy({ top: direction * el.clientHeight * .85, behavior: 'smooth' }); }
      }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    const release = () => { heldPointer.current = null; setAutoHeld(false); };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      heldPointer.current = event.pointerId; setAutoHeld(true);
      // Stop any in-flight smooth page turn without taking pointer capture
      // away from text selection, buttons or the scrollbar.
      const el = canvas.current;
      el?.scrollTo({ top: el.scrollTop, behavior: 'instant' });
    };
    const up = (event: PointerEvent) => { if (event.pointerId === heldPointer.current && event.button === 0) release(); };
    const move = (event: PointerEvent) => { if (heldPointer.current !== null && event.pointerType === 'mouse' && !(event.buttons & 1)) release(); };
    const hide = () => { if (document.visibilityState === 'hidden') release(); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', hide);
    return () => {
      window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', release, true); window.removeEventListener('pointermove', move, true);
      window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', hide);
      heldPointer.current = null;
    };
  }, []);
  useEffect(() => {
    if (auto === 'off' || loading || loadError || !chapter.content) return;
    if (canvas.current) canvas.current.scrollTo({ top: canvas.current.scrollTop, behavior: 'instant' });
    let frame = 0, previous = 0, accumulated = 0, edgeTime = 0;
    // Keep the fractional target between frames. Reading rounded scrollTop back
    // each frame loses slow movement on WebView2/high-refresh displays.
    let scrollPosition = canvas.current?.scrollTop ?? 0;
    let lastWritten = scrollPosition;
    const page = paper.current;
    const originalTransform = page?.style.transform ?? '';
    const originalWillChange = page?.style.willChange ?? '';
    if (auto === 'scroll' && page) page.style.willChange = 'transform';
    const tick = (time: number) => {
      const el = canvas.current;
      if (!el) return;
      if (!previous) previous = time;
      const delta = Math.min(100, time - previous); previous = time;
      if (document.visibilityState === 'visible' && heldPointer.current === null) {
        accumulated += delta;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
          edgeTime += delta;
          const fits = el.scrollHeight <= el.clientHeight + 2;
          const hold = auto === 'page' ? pageSeconds * 1000
            : fits ? Math.max(3000, Math.min(120000, chapter.content.length / 8 * 1000)) : 1500;
          if (edgeTime < hold) { frame = requestAnimationFrame(tick); return; }
          accumulated = 0;
          if (continuousRef.current.enabled && index + 1 < book.chapters.length) { frame = requestAnimationFrame(tick); return; }
          if (index + 1 < book.chapters.length) onJump(index + 1);
          else { setAuto('off'); notice('已阅读至全书末尾。'); }
          return;
        }
        edgeTime = 0;
        if (auto === 'scroll') {
          // 方案 A: 立即接管 - 监测用户滚轮手动滑动偏差并立即同步，滚动不中断
          if (Math.abs(el.scrollTop - lastWritten) > .01) {
            scrollPosition = el.scrollTop;
          }
          scrollPosition = Math.min(el.scrollHeight - el.clientHeight, scrollPosition + speed * delta / 1000);
          el.scrollTop = scrollPosition;
          lastWritten = el.scrollTop;
          // WebView2 may round scrollTop to device pixels. Apply the remaining
          // fraction visually so low speeds do not fall back to one-pixel jumps.
          if (page) page.style.transform = `translate3d(0, ${el.scrollTop - scrollPosition}px, 0)`;
        } else if (accumulated >= pageSeconds * 1000) {
          accumulated = 0; el.scrollBy({ top: el.clientHeight * .85, behavior: 'smooth' });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      if (page) { page.style.transform = originalTransform; page.style.willChange = originalWillChange; }
    };
  }, [auto, speed, pageSeconds, index, chapter.content, loading, loadError]);
  useEffect(() => {
    if (!sleep) { setRemaining(0); return; }
    const deadline = Date.now() + sleep * 60000;
    setRemaining(sleep * 60);
    const timer = setInterval(() => {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)); setRemaining(seconds);
      if (!seconds) { stop(); engine.current?.stop(); continueSpeech.current = false; setAuto('off'); setSleep(0); latest.current.notice('定时已到，朗读和自动翻页已停止。'); }
    }, 1000);
    return () => clearInterval(timer);
  }, [sleep]);
  const toggleSpeech = () => {
    setAudioStopSignal(n => n + 1);
    setAuto('off');
    setTtsPlaying(false);
    setOfficialAudioPlaying(false);
    setPlaybackSession(null); setPausedAuto('off');
    if (speech.status === 'playing') engine.current?.pause();
    else if (speech.status === 'paused') engine.current?.resume();
    else {
      const el = canvas.current;
      const top = el?.getBoundingClientRect().top ?? 0;
      const visible = readingParagraph(paragraphRefs.current, top);
      engine.current?.start(Math.max(0, visible));
    }
  };
  const collapseChapters = useCallback(() => setShowChapters(false), []);
  const expandChapters = useCallback(() => { setShowChapters(true); setShowSettings(false); setShowComments(false); setSelectedParagraph(null); }, []);
  const jump = useCallback((i: number) => {
    if (i < 0 || i >= latest.current.book.chapters.length) return;
    savePosition(); stop();
    if (continuousRef.current.enabled) continuousRef.current.jump(i);
    latest.current.onJump(i);
  }, []);

  useEffect(() => {
    if (!isAudioActive) {
      clearMediaSession();
      return;
    }
    updateMediaSessionMetadata((playbackSession === 'audio' ? recordedControls.current?.metadata() : null) ?? {
      title: chapter.title,
      artist: book.author || '番茄小说',
      album: book.title,
      artworkUrl: book.coverUrl,
    });
    setMediaSessionPlaybackState(miniPlaying ? 'playing' : 'paused');
    updateMediaSessionHandlers({
      onPlay: () => {
        if (miniPlaying || miniLoading) return;
        if (playbackSession === 'audio') { recordedControls.current?.play(); return; }
        if (speech.status === 'paused') engine.current?.resume();
        else if (playbackSession === 'kokoro') kokoroControls.current?.play();
        else if (playbackSession === 'tts') ttsControls.current?.play();
        else if (pausedAuto !== 'off') { setAuto(pausedAuto); setPausedAuto('off'); }
        else toggleSpeech();
      },
      onPause: () => {
        if (!miniPlaying && !miniLoading) return;
        if (playbackSession === 'audio') { recordedControls.current?.pause(); return; }
        if (speech.status === 'playing') engine.current?.pause();
        else if (playbackSession === 'kokoro') kokoroControls.current?.pause();
        else if (playbackSession === 'tts') ttsControls.current?.pause();
        else if (auto !== 'off') { setPausedAuto(auto); setAuto('off'); }
      },
      onPreviousTrack: () => {
        if (playbackSession === 'audio') { recordedControls.current?.previous(); return; }
        if (index > 0) jump(index - 1);
      },
      onNextTrack: () => {
        if (playbackSession === 'audio') { recordedControls.current?.next(); return; }
        if (index + 1 < book.chapters.length) jump(index + 1);
      },
      onSeekTo: playbackSession === 'audio' ? details => { if (details.seekTime !== undefined) recordedControls.current?.seek(details.seekTime); } : undefined,
      onStop: () => {
        stop();
        setAuto('off');
      },
    });
    return () => {
      clearMediaSession();
    };
  }, [isAudioActive, miniPlaying, miniLoading, officialAudioText, speech.status, playbackSession, auto, pausedAuto, chapter.title, book.title, book.author, book.coverUrl, index, book.chapters.length, jump]);

  return <div className="reader-layout">
    <header className="reader-topbar">
      <button className="text-action" onClick={() => { savePosition(); stop(); onBack(); }}><ArrowLeft size={18}/> 返回书架</button>
      <span className="reader-top-title">{book.title}<span> / {chapter.title}</span></span>
      
      {/* 常驻微型播放胶囊 (当抽屉关闭但有音频或自动阅读进行时) */}
      {isAudioActive && !showAudio && (
        <div className="audio-mini-pill" onClick={() => setShowAudio(true)} title="听书或自动阅读进行中，点击展开控制面板">
          <span className="mini-pill-dot" />
          <span className="mini-pill-text">
            {speech.status === 'playing' ? `电脑朗读: 第 ${speech.paragraph + 1}/${paragraphs.length} 段 (${paragraphs.length ? Math.round(((speech.paragraph + 1) / paragraphs.length) * 100) : 0}%)` :
             speech.status === 'paused' ? '电脑朗读已暂停' :
             playbackSession === 'kokoro' ? (kokoroState.status === 'loading' ? '离线语音准备中' : kokoroState.status === 'playing' ? `离线朗读: 第 ${kokoroState.paragraph + 1}/${paragraphs.length} 段` : '离线朗读已暂停') :
             playbackSession === 'tts' ? (ttsLoading ? '番茄AI音频加载中' : ttsPlaying ? (ttsProgressText || '番茄AI朗读中') : '番茄AI已暂停') :
             playbackSession === 'audio' ? (recordedLoading ? '官方有声加载中' : officialAudioPlaying ? (officialAudioText || '官方有声播放中') : '官方有声已暂停') :
             auto !== 'off' && autoHeld ? '按住左键，自动阅读暂缓中' :
             pausedAuto !== 'off' ? '自动阅读已暂停' :
             auto === 'scroll' ? `自动滚动中 (${speed} px/s)` : `定时翻页中 (${pageSeconds}s)`}
          </span>
          <button className="mini-pill-action-btn" onClick={(e) => {
            e.stopPropagation();
            if (speech.status === 'playing') engine.current?.pause();
            else if (speech.status === 'paused') engine.current?.resume();
            else if (playbackSession === 'kokoro') kokoroControls.current?.toggle();
            else if (playbackSession === 'tts') ttsControls.current?.toggle();
            else if (playbackSession === 'audio') recordedControls.current?.toggle();
            else if (auto !== 'off') { setPausedAuto(auto); setAuto('off'); }
            else if (pausedAuto !== 'off') { setAuto(pausedAuto); setPausedAuto('off'); }
          }} title={miniAction} aria-label={miniAction}>
            {miniLoading ? <X size={13}/> : miniPlaying ? <Pause size={13}/> : <Play size={13}/>}
          </button>
          <button className="mini-pill-action-btn" onClick={(e) => {
            e.stopPropagation();
            stop();
            setAuto('off');
          }} title="停止">
            <X size={13}/>
          </button>
        </div>
      )}

      <div className="reader-actions">
        {book.source === 'official' && <button className={`round-action paragraph-toggle ${bubblesEnabled ? 'selected' : ''}`} title={bubblesEnabled ? '隐藏段评气泡' : '显示段评气泡'} aria-pressed={bubblesEnabled} onClick={() => { setBubblesEnabled(!bubblesEnabled); setSelectedParagraph(null); }}>段评</button>}
        <button className={showAudio ? 'round-action selected' : 'round-action'} onClick={() => setShowAudio(!showAudio)} title="听书与自动翻页"><Headphones size={19}/></button>
        <button className={showComments ? 'round-action selected' : 'round-action'} onClick={() => { setShowComments(!showComments); setShowSettings(false); setSelectedParagraph(null); }} title="官方评论"><MessageSquare size={19}/></button>
        <button className={showChapters && !showSettings && !showComments && !selectedParagraph ? 'round-action selected' : 'round-action'} onClick={() => { setShowChapters(showSettings || showComments || selectedParagraph ? true : !showChapters); setShowSettings(false); setShowComments(false); setSelectedParagraph(null); }} title="章节目录" aria-expanded={showChapters} aria-controls="reader-chapters"><BookMarked size={19}/></button>
        <button className={showSettings ? 'round-action selected' : 'round-action'} onClick={() => { setShowSettings(!showSettings); setShowComments(false); setSelectedParagraph(null); }} title="阅读设置"><Settings2 size={19}/></button>
      </div>
    </header>

    {/* 顶部下拉抽屉式听书控制面板 (方案 A) */}
    <div className={`audio-drawer ${showAudio ? 'open' : 'closed'}`} aria-label="听书与阅读助手">
      <div className="audio-drawer-container">
        <div className="audio-drawer-header">
          <div className="drawer-tabs">
            <button
              type="button"
              className={`drawer-tab-btn ${activeAudioTab === 'speech' ? 'active' : ''}`}
              onClick={() => setActiveAudioTab('speech')}
            >
              <Volume2 size={15}/> 电脑语音
            </button>
            <button type="button" className={`drawer-tab-btn ${activeAudioTab === 'kokoro' ? 'active' : ''}`} onClick={() => { setActiveAudioTab('kokoro'); setOpenedPlayers(p => ({ ...p, kokoro: true })); }}>
              <Headphones size={15}/> Kokoro 离线语音
            </button>
            {book.source === 'official' && (
              <button
                type="button"
                className={`drawer-tab-btn ${activeAudioTab === 'tts' ? 'active' : ''}`}
                onClick={() => { setActiveAudioTab('tts'); setOpenedPlayers(p => ({ ...p, tts: true })); }}
              >
                <Sparkles size={15}/> 番茄AI音色
              </button>
            )}
            {book.source === 'official' && (
              <button
                type="button"
                className={`drawer-tab-btn ${activeAudioTab === 'audio' ? 'active' : ''}`}
                onClick={() => { setActiveAudioTab('audio'); setOpenedPlayers(p => ({ ...p, audio: true })); }}
              >
                <Radio size={15}/> 官方有声
              </button>
            )}
            <button
              type="button"
              className={`drawer-tab-btn ${activeAudioTab === 'auto' ? 'active' : ''}`}
              onClick={() => setActiveAudioTab('auto')}
            >
              <ScrollText size={15}/> 自动阅读
            </button>
          </div>

          <div className="drawer-header-right"><button className="drawer-close-action" onClick={() => { stop(); setAuto('off'); }}>停止全部播放</button><label className="control-field">定时停止 <select aria-label="定时停止" value={sleep} onChange={e => setSleep(Number(e.target.value))}><option value="0">关闭</option>{[15,30,45,60].map(v => <option key={v} value={v}>{v} 分钟</option>)}</select></label>
            {remaining > 0 && <span className="drawer-sleep-tag">⏳ 剩余 {Math.ceil(remaining / 60)} 分钟</span>}
            <button
              type="button"
              className="drawer-close-action"
              onClick={() => setShowAudio(false)}
              title="收起面板（后台将继续播放）"
            >
              <ChevronUp size={15}/> 收起面板
            </button>
          </div>
        </div>

        <div className="audio-drawer-body">
          {/* Tab 1: 电脑语音朗读 */}
          <div className="drawer-tab-panel" style={{ display: activeAudioTab === 'speech' ? 'block' : 'none' }}>
            <div className="audio-card">
              <div className="audio-card-main-row">
                <div className="audio-progress-info">
                  <span className="audio-progress-title">电脑语音朗读</span>
                  <span className="audio-progress-stats">
                    {speech.status === 'stopped' 
                      ? (supportsSpeech ? '就绪 · 点击开始朗读' : '当前环境不支持电脑语音')
                      : `已朗读至 第 ${Math.max(1, speech.paragraph + 1)} / ${paragraphs.length} 段 (${paragraphs.length ? Math.round(((speech.paragraph + 1) / paragraphs.length) * 100) : 0}%)`}
                  </span>
                </div>
                <div className="audio-main-controls">
                  <button 
                    type="button" 
                    className="audio-btn-primary" 
                    disabled={!supportsSpeech || loading || !chapter.content} 
                    onClick={toggleSpeech}
                  >
                    {speech.status === 'playing' ? <><Pause size={15}/> 暂停朗读</> : speech.status === 'paused' ? <><Play size={15}/> 继续朗读</> : <><Play size={15}/> 开始朗读</>}
                  </button>
                  <button 
                    type="button" 
                    className="audio-btn-secondary" 
                    disabled={speech.status === 'stopped'} 
                    onClick={stop}
                  >
                    <Square size={13}/> 停止
                  </button>
                </div>
              </div>

              <div className="audio-progress-bar-wrapper">
                <div 
                  className="audio-progress-fill" 
                  style={{ width: `${paragraphs.length ? Math.min(100, Math.round(((speech.paragraph + 1) / paragraphs.length) * 100)) : 0}%` }}
                />
              </div>

              <div className="audio-card-secondary-row">
                <div className="control-field">
                  <label>声音选择</label>
                  <select aria-label="朗读声音" value={voiceURI} onChange={e => setVoiceURI(e.target.value)}>
                    <option value="">自动选择中文声音</option>
                    {voices.map(v => <option value={v.voiceURI} key={v.voiceURI}>{v.name} · {v.lang}</option>)}
                  </select>
                </div>

                <div className="control-field">
                  <label>朗读倍速</label>
                  <div className="chip-group">
                    {[.75, 1, 1.25, 1.5, 2].map(v => (
                      <button 
                        key={v} 
                        type="button" 
                        className={`chip-item ${rate === v ? 'active' : ''}`} 
                        onClick={() => setRate(v)}
                      >
                        {v}×
                      </button>
                    ))}
                  </div>
                </div>

                <div className="control-field">
                  <label>定时停止</label>
                  <div className="chip-group">
                    {[0, 15, 30, 45, 60].map(v => (
                      <button 
                        key={v} 
                        type="button" 
                        className={`chip-item ${sleep === v ? 'active' : ''}`} 
                        onClick={() => setSleep(v)}
                      >
                        {v === 0 ? '不设' : `${v}分`}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {openedPlayers.kokoro && <div className="drawer-tab-panel" style={{ display: activeAudioTab === 'kokoro' ? 'block' : 'none' }}>
            <LocalTtsPlayer key={book.id} bookId={book.id} chapterId={chapter.id} nextChapterId={book.chapters[index + 1]?.id} paragraphs={paragraphs}
              disabled={loading || !!loadError || !chapter.content} stopSignal={audioStopSignal + kokoroStopSignal} controls={kokoroControls}
              fromParagraph={() => { const top = canvas.current?.getBoundingClientRect().top ?? 0; return Math.max(0, readingParagraph(paragraphRefs.current, top)); }}
              onStart={() => { continueSpeech.current = false; engine.current?.stop(); setAuto('off'); setPausedAuto('off'); setTtsStopSignal(n => n + 1); setRecordedStopSignal(n => n + 1); setPlaybackSession('kokoro'); }}
              onNext={() => { savePosition(); setAuto('off'); latest.current.onJump(latest.current.index + 1); }}
              onState={state => { setKokoroState(state); if (state.status === 'stopped') setPlaybackSession(current => current === 'kokoro' ? null : current); else setPlaybackSession('kokoro'); }}
            />
          </div>}

          {/* 首次选择后常驻，收起面板继续播放。 */}
          {book.source === 'official' && openedPlayers.tts && (
            <div className="drawer-tab-panel" style={{ display: activeAudioTab === 'tts' ? 'block' : 'none' }}>
              <label className="estimated-follow"><input type="checkbox" checked={followEstimated} onChange={e => setFollowEstimated(e.target.checked)} /> 按估算位置跟随正文（可能不准）</label>
              <OfficialTtsPlayer
                key={book.id}
                bookId={book.id}
                chapterId={chapter.id}
                chapterTitle={chapter.title}
                nextChapterId={book.chapters[index + 1]?.id}
                paragraphs={paragraphs}
                disabled={loading || !!loadError || !chapter.content}
                onBusyChange={setTtsLoading}
                controls={ttsControls}
                stopSignal={audioStopSignal + ttsStopSignal}
                onStart={() => { continueSpeech.current = false; engine.current?.stop(); setAuto('off'); setPausedAuto('off'); setRecordedStopSignal(n => n + 1); setKokoroStopSignal(n => n + 1); setPlaybackSession('tts'); }}
                onNext={() => { savePosition(); setAuto('off'); latest.current.onJump(latest.current.index + 1); }}
                onProgress={({ activeParagraph, statusText }) => {
                  setTtsActiveParagraph(activeParagraph);
                  setTtsProgressText(statusText);
                }}
                onPlaybackStateChange={(playing) => setTtsPlaying(playing)}
              />
            </div>
          )}

          {/* 首次选择后保留独立真人播放器。 */}
          {book.source === 'official' && openedPlayers.audio && (
            <div className="drawer-tab-panel" style={{ display: activeAudioTab === 'audio' ? 'block' : 'none' }}>
              <OfficialAudioPlayer
                key={book.id}
                bookId={book.id}
                chapterId={chapter.id}
                chapterTitle={chapter.title}
                onBusyChange={setRecordedLoading}
                controls={recordedControls}
                stopSignal={audioStopSignal + recordedStopSignal}
                notice={notice}
                onStart={() => { continueSpeech.current = false; engine.current?.stop(); setAuto('off'); setPausedAuto('off'); setTtsStopSignal(n => n + 1); setKokoroStopSignal(n => n + 1); setPlaybackSession('audio'); }}
                onPlaybackStateChange={(playing, text) => {
                  setOfficialAudioPlaying(playing);
                  setOfficialAudioText(text);
                }}
              />
            </div>
          )}

          {/* Tab 4: 自动阅读 */}
          <div className="drawer-tab-panel" style={{ display: activeAudioTab === 'auto' ? 'block' : 'none' }}>
            <div className="audio-card">
              <div className="audio-card-main-row">
                <div className="audio-progress-info">
                  <span className="audio-progress-title">自动阅读模式</span>
                  <span className="audio-progress-stats">
                    {auto === 'off' ? '当前关闭 · 选择模式后自动向下阅读' : autoHeld ? '按住左键暂缓中 · 松开后继续' : auto === 'scroll' ? `自动滚动中 · 速度 ${speed} px/s` : `定时翻页中 · 每 ${pageSeconds} 秒翻页`}
                  </span>
                </div>
                <div className="audio-main-controls">
                  {auto !== 'off' ? (
                    <button type="button" className="audio-btn-secondary" onClick={() => { setAuto('off'); setPausedAuto('off'); }}>
                      <Square size={13}/> 停止自动阅读
                    </button>
                  ) : (
                    <button type="button" className="audio-btn-primary" onClick={() => { stop(); setAuto('scroll'); }}>
                      <Play size={15}/> 开启自动滚动
                    </button>
                  )}
                </div>
              </div>

              <div className="audio-card-secondary-row">
                <div className="control-field">
                  <label>模式切换</label>
                  <div className="chip-group">
                    <button type="button" className={`chip-item ${auto === 'off' ? 'active' : ''}`} onClick={() => { setAuto('off'); setPausedAuto('off'); }}>关闭</button>
                    <button type="button" className={`chip-item ${auto === 'scroll' ? 'active' : ''}`} onClick={() => { stop(); setAuto('scroll'); }}>平滑滚动</button>
                    <button type="button" className={`chip-item ${auto === 'page' ? 'active' : ''}`} onClick={() => { stop(); setAuto('page'); }}>定时翻页</button>
                  </div>
                </div>

                {auto === 'scroll' && (
                  <div className="control-field">
                    <label>滚动速度: {speed} px/s</label>
                    <input aria-label="自动滚动速度" type="range" min="10" max="80" step="5" value={speed} onChange={e => setSpeed(Number(e.target.value))}/>
                  </div>
                )}

                {auto === 'page' && (
                  <div className="control-field">
                    <label>翻页间隔 (秒)</label>
                    <input aria-label="翻页间隔" type="number" min="3" max="120" value={pageSeconds} onChange={e => setPageSeconds(Math.min(120, Math.max(3, Number(e.target.value) || 3)))}/>
                  </div>
                )}

                <div className="control-field">
                  <label>定时停止</label>
                  <div className="chip-group">
                    {[0, 15, 30, 45, 60].map(v => (
                      <button 
                        key={v} 
                        type="button" 
                        className={`chip-item ${sleep === v ? 'active' : ''}`} 
                        onClick={() => setSleep(v)}
                      >
                        {v === 0 ? '不设' : `${v}分`}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <small className="audio-hint-note">💡 提示：自动滚动时，鼠标滚轮随时可以自由上下滑动查看前后文，停止滑动后从新位置接续；按住鼠标左键暂缓，松开继续。</small>
            </div>
          </div>
        </div>
      </div>
    </div>
    {book.source === 'official' && <div className={`sync-bar ${prefs.autoUploadProgress ? 'upload-enabled' : 'upload-disabled'}`}><span><strong className="upload-state">{prefs.autoUploadProgress ? '自动上传已开启' : '自动上传已关闭'}</strong> · 最近结果：{syncStatus || '尚未读取云端记录'}</span><button onClick={onRefreshCloud} disabled={cloudRefreshing}>{cloudRefreshing ? '正在读取…' : '读取云端进度'}</button><button onClick={onReadHistory} disabled={historyBusy}>{historyBusy ? '正在读取历史…' : '查看已读章节'}</button><button onClick={onSync} disabled={loading || !chapter.content || !canSync}>上传本章进度</button><button onClick={onOfficial}>在官网打开本章</button></div>}
    <div className="reader-main">
      {showChapters ? <ChapterList chapters={book.chapters} index={index} onJump={jump} onCollapse={collapseChapters} visible={!showSettings && !showComments && !selectedParagraph} /> : <div className="chapter-rail"><button className="chapter-expand" aria-label="展开目录" aria-expanded="false" aria-controls="reader-chapters" onClick={expandChapters}><BookMarked size={17}/><span>目录</span><ChevronRight size={15}/></button></div>}
      <section className={`reading-canvas ${prefs.theme}`} ref={canvas} onScroll={() => { continuous.onScroll(); capturePosition(); clearTimeout(saveTimer.current); saveTimer.current = setTimeout(flushPosition, 250); }}>
        <div className="page-paper" ref={paper} style={{maxWidth:prefs.contentWidth+92}}><div className="page-decoration">{APP_NAME} · {book.source === 'official' ? '官方作品' : '本地阅读'}</div>{continuous.enabled ? <div className="continuous-stream" data-reading-mode="continuous">
          {continuous.indices.map(i => {
            const item = book.chapters[i], active = i === index;
            const error = continuous.errors[i] || (active ? loadError : '');
            return <section className="continuous-chapter" data-chapter-index={i} key={item.id} ref={el => { if (el) continuous.sections.current.set(i, el); else continuous.sections.current.delete(i); }}>
              <div className="chapter-subtitle">CHAPTER {String(i + 1).padStart(2, '0')} · {i + 1} / {book.chapters.length}</div><h1>{item.title}</h1>
              {item.content ? <ChapterText paragraphs={active ? paragraphs : item.content.split(/\n\s*\n|\n/).map(s => s.trim()).filter(Boolean)} fontSize={prefs.fontSize} lineHeight={prefs.lineHeight} activeParagraph={active ? currentActiveParagraph : -1} paragraphRefs={active ? paragraphRefs : undefined} bubbles={active ? paragraphComments.bubbles : {}} onParagraph={openParagraph} />
                : <div className="continuous-placeholder" aria-busy={!error}>{error ? <div role="alert"><p>{error}</p><button onClick={() => { continuous.retry(i); if (active) onRetry(); }}>重试第 {i + 1} 章</button></div> : <p role="status">正在读取第 {i + 1} 章…</p>}</div>}
              <div className="end-marker">{i === book.chapters.length - 1 ? '— 全书完 —' : '— 本章完 · 向下继续阅读 —'}</div>
            </section>;
          })}
        </div> : <><div className="chapter-subtitle">CHAPTER {String(index+1).padStart(2,'0')}</div><h1>{chapter.title}</h1>
          {bubblesEnabled && paragraphComments.error && <div className="paragraph-load-note" role="status">段评暂不可用：{paragraphComments.error}<button onClick={paragraphComments.retry}>重试段评计数</button></div>}
          {loading ? <p role="status">正在读取官方正文…</p> : loadError ? <div className="chapter-error" role="alert"><p>{loadError}</p><button onClick={onRetry}>重试正文</button><button onClick={onOfficial}>在官网阅读</button></div> : <ChapterText paragraphs={paragraphs} fontSize={prefs.fontSize} lineHeight={prefs.lineHeight} activeParagraph={currentActiveParagraph} paragraphRefs={paragraphRefs} bubbles={paragraphComments.bubbles} onParagraph={openParagraph} />}
          <div className="end-marker">— 本章完 —</div><div className="pagination"><button disabled={index<=0} onClick={() => jump(index-1)}><ChevronLeft size={19}/> 上一章</button><span>{index+1} / {book.chapters.length}</span><button disabled={index>=book.chapters.length-1} onClick={() => jump(index+1)}>下一章 <ChevronRight size={19}/></button></div></>}
        </div>
      </section>
      {showSettings && <aside className="reader-settings" aria-label="阅读偏好面板"><div className="settings-panel-top"><strong>阅读偏好</strong><button className="icon-button" aria-label="关闭阅读偏好" onClick={() => setShowSettings(false)}><X size={17}/></button></div>{settings}<div className="small-note">设置和章内位置保存在当前电脑。方向键、空格翻页，Ctrl + 方向键切章。</div></aside>}
      {showComments && <CommentsPanel book={book} notice={notice} onClose={() => setShowComments(false)}/>}
      {selectedParagraph?.chapterId === chapter.id && <ParagraphCommentsPanel key={`${book.id}:${chapter.id}:${selectedParagraph.id}`} bookId={book.id} chapterId={chapter.id} paragraphId={selectedParagraph.id} snippet={paragraphs[selectedParagraph.index]} itemVersion={paragraphComments.version} onClose={() => setSelectedParagraph(null)} />}
    </div>
  </div>;
}

const ChapterList = memo(function ChapterList({ chapters, index, onJump, onCollapse, visible }: {
  chapters: Book['chapters']; index: number; onJump: (index: number) => void; onCollapse: () => void; visible: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const list = scroll.current;
    if (!list || !visible) return;
    let frame = 0;
    const center = () => {
      cancelAnimationFrame(frame);
      let passes = 0, stable = 0;
      const settle = () => {
        const row = current.current;
        if (!row || !list.clientHeight) return;
        const target = row.getBoundingClientRect(), bounds = list.getBoundingClientRect();
        const offset = target.top - bounds.top - (list.clientHeight - target.height) / 2;
        list.scrollTop += offset;
        stable = Math.abs(offset) < 1 ? stable + 1 : 0;
        // content-visibility first uses estimated row heights. Recheck after
        // rendering those rows, then stop rather than following manual scrolls.
        if (++passes < 8 && stable < 2) frame = requestAnimationFrame(settle);
      };
      settle();
    };
    center();
    const observer = new ResizeObserver(center); observer.observe(list);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [index, visible, chapters.length]);
  return <aside className="chapters-list" id="reader-chapters" aria-label="章节目录列表"><div className="chapters-header"><div><span>章节目录</span><small>共 {chapters.length} 章</small></div><button className="chapter-collapse" aria-label="收起目录" aria-expanded="true" aria-controls="reader-chapters" onClick={onCollapse}><ChevronLeft size={17}/></button></div>
    <div className="chapter-scroll" ref={scroll}>{chapters.map((chapter, i) => <button key={chapter.id} ref={i === index ? current : null} aria-current={i === index ? 'true' : undefined} className={i === index ? 'chapter-item current' : 'chapter-item'} onClick={() => onJump(i)}>
      <span className="chapter-index">{String(i + 1).padStart(2, '0')}</span><span>{chapter.title}</span>
    </button>)}</div>
  </aside>;
});

const ChapterText = memo(function ChapterText({ paragraphs, fontSize, lineHeight, activeParagraph, paragraphRefs, bubbles, onParagraph }: {
  paragraphs: string[]; fontSize: number; lineHeight: number; activeParagraph: number;
  paragraphRefs?: RefObject<(HTMLParagraphElement | null)[]>;
  bubbles: Record<number, { id: number; count: number }>;
  onParagraph: (id: number, index: number) => void;
}) {
  return <div className="story-content" style={{ fontSize, lineHeight }}>{paragraphs.map((paragraph, i) =>
    <p key={i} ref={node => { if (paragraphRefs) paragraphRefs.current[i] = node; }} className={activeParagraph === i ? 'spoken-paragraph' : ''}>{paragraph}{bubbles[i] && <button className="paragraph-bubble" data-paragraph-id={bubbles[i].id} aria-label={`查看第${i+1}段评论，共${bubbles[i].count}条`} onClick={() => onParagraph(bubbles[i].id, i)}><MessageSquare size={13} /><span>{bubbles[i].count > 999 ? '999+' : bubbles[i].count}</span></button>}</p>)}</div>;
});
