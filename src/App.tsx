import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, ReactNode } from 'react';
import {
  ArrowLeft, ArrowRight, Award, BookOpen, Check, ChevronRight,
  Cloud, CloudOff, Compass, ExternalLink, FilePlus, Filter, Flame, FolderOpen, Info,
  Library, Minus, Moon, Plus, RefreshCw, Search, Settings2, Sparkles, Sun, Trash2, Trophy, UploadCloud, UserRound, X,
} from 'lucide-react';
import { importBook } from './lib/importBook';
import { checkForUpdate, CURRENT_VERSION } from './lib/updater';
import type { UpdateCheckResult } from './lib/updater';
import { openOfficialWebsite } from './lib/officialSite';
import { official, errorMessage, plainChapter } from './lib/official';
import type { OfficialUser } from './lib/official';
import { OfficialCover } from './components/OfficialCover';
import { OfficialPanel } from './components/OfficialPanel';
import { CloudShelf } from './components/CloudShelf';
import { useOfficialAccount } from './lib/useOfficialAccount';
import { Reader } from './components/Reader';
import { LeaderboardView } from './components/LeaderboardView';
import { DiscoveryView } from './components/DiscoveryView';
import { storage } from './lib/storage';
import { APP_NAME, APP_TAGLINE } from './lib/branding';
import { WindowTitlebar } from './components/WindowTitlebar';
import { cloudTime } from './lib/cloudProgress';
import type { Book, Preferences, ReadingProgress, Theme } from './types';

type Screen = 'rankings' | 'discovery' | 'bookshelf' | 'reader' | 'settings' | 'official' | 'cloud-shelf' | 'opening';

function loadBooks(): Book[] {
  return storage.books().filter(book => book.source !== 'demo');
}

function timeLabel(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(timestamp);
}

export default function App() {
  const [books, setBooks] = useState<Book[]>(loadBooks);
  const [shelfIds, setShelfIds] = useState(() => new Set(storage.books().map(b => b.id)));
  const [prefs, setPrefs] = useState<Preferences>(storage.preferences);
  const [progress, setProgress] = useState<Record<string, ReadingProgress>>(storage.progress);
  const [opening, setOpening] = useState<{ title: string; stage: string; error?: string; id?: string } | null>(null);
  const [screen, setScreen] = useState<Screen>('bookshelf');
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [readerChapter, setReaderChapter] = useState(0);
  const [query, setQuery] = useState('');
  const [shelfFilter, setShelfFilter] = useState<'all' | 'recent' | 'official' | 'local'>('all');
  const account = useOfficialAccount();
  const officialUser = account.user;
  const setOfficialUser = account.acceptUser;
  const [chapterLoading, setChapterLoading] = useState(false);
  const [chapterError, setChapterError] = useState('');
  const [retryChapter, setRetryChapter] = useState(0);
  const [syncStatus, setSyncStatus] = useState('');
  const [conflict, setConflict] = useState<{ book: Book; local: number; cloud: number; cloudUpdatedAt?: number } | null>(null);
  const [cloudRefreshing, setCloudRefreshing] = useState(false);
  const refreshInFlight = useRef(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [autoAttempt, setAutoAttempt] = useState(0);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [readHistory, setReadHistory] = useState<{ index: number; title: string }[] | null>(null);
  const [historyQuery, setHistoryQuery] = useState('');
  const [uploadConfirmation, setUploadConfirmation] = useState<{
    generation: number; bookId: string; chapterId: string; chapterTitle: string;
    remoteId: string; remoteTimestamp: number; remoteTitle: string;
  } | null>(null);
  const importing = useRef(false);
  const [importBusy, setImportBusy] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const progressRef = useRef(progress);
  const cloudBaseline = useRef<Record<string, string>>({});
  const cloudVersions = useRef<Record<string, number>>({});
  const autoUploadEnabled = useRef(!!prefs.autoUploadProgress);
  const autoUploadEpoch = useRef(0);
  autoUploadEnabled.current = !!prefs.autoUploadProgress;
  const syncInFlight = useRef(false);
  const readerEntryProgress = useRef<ReadingProgress | undefined>(undefined);
  const openGeneration = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const handleCheckUpdate = async () => {
    setUpdateChecking(true);
    try {
      const res = await checkForUpdate();
      setUpdateResult(res);
      if (res.hasUpdate) {
        flash(`发现新版本 v${res.latestVersion}！`);
      } else if (!res.error) {
        flash(`当前已是最新版本 (v${res.currentVersion})。`);
      }
    } catch {
      flash('检查更新失败，请检查网络连接后重试。');
    } finally {
      setUpdateChecking(false);
    }
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const activeBook = books.find(b => b.id === activeBookId) ?? null;
  const chapter = activeBook?.chapters[readerChapter] ?? null;
  const syncContext = useRef({ screen, bookId: activeBookId, chapterId: chapter?.id });
  syncContext.current = { screen, bookId: activeBookId, chapterId: chapter?.id };

  const navigate = (next: Screen) => {
    openGeneration.current++;
    setUploadConfirmation(null);
    setReadHistory(null);
    setConflict(null);
    setChapterLoading(false);
    setOpening(null);
    setScreen(next);
  };

  const filteredBooks = useMemo(() => books.filter(book => {
    const matchesQuery = `${book.title} ${book.author}`.toLowerCase().includes(query.trim().toLowerCase());
    if (!matchesQuery) return false;
    if (shelfFilter === 'recent') return !!progress[book.id];
    if (shelfFilter === 'official') return book.source === 'official';
    if (shelfFilter === 'local') return book.source === 'local';
    return true;
  }), [books, query, shelfFilter, progress]);

  const lastRead = useMemo(() =>
    [...books].filter(b => progress[b.id]).sort((a, b) => (progress[b.id]?.updatedAt ?? 0) - (progress[a.id]?.updatedAt ?? 0))[0],
    [books, progress]
  );

  const flash = (message: string) => {
    setNotice(message);
  };

  const setPreference = (changes: Partial<Preferences>) => {
    if (changes.autoUploadProgress && !prefs.autoUploadProgress && !window.confirm('开启自动上传阅读进度？\n\n正文加载后停留 5 秒会上传当前章节，可能改变手机端的续读位置。检测到云端记录变化时会暂停并让你选择进度。')) return;
    const next = { ...prefs, ...changes };
    try {
      storage.savePreferences(next);
      autoUploadEnabled.current = !!next.autoUploadProgress;
      if (changes.autoUploadProgress !== undefined) autoUploadEpoch.current++;
      setPrefs(next);
    } catch { flash('设置保存失败：本地存储不可用。'); }
  };

  // Read the latest persisted shelf after async work; captured React state may be stale.
  const persistBooks = async (additions: Book[]) => {
    const next = await storage.addBooks(additions);
    const merged = new Map(next.map(b => [b.id, b]));
    setShelfIds(new Set(next.map(b => b.id)));
    setBooks(old => [...old.filter(b => !merged.has(b.id)), ...next]);
  };

  const saveReading = useCallback((bookId: string, chapterIndex: number, scrollRatio = 0, paragraphIndex = 0) => {
    const next = { ...progressRef.current, [bookId]: { chapterIndex, scrollRatio, paragraphIndex, updatedAt: Date.now() } };
    progressRef.current = next;
    setProgress(next);
    try { storage.saveProgress(next); } catch { flash('进度保存失败：本地存储不可用。'); }
  }, []);

  const enterBook = async (book: Book, chapterIndex: number, restoreLocal: boolean) => {
    const generation = openGeneration.current;
    if (book.source === 'official') {
      try { await persistBooks([book]); } catch { flash('作品已打开，但书架保存失败，请释放本地存储空间后重新收藏。'); }
    }
    if (generation !== openGeneration.current) return;
    setBooks(old => old.some(b => b.id === book.id) ? old.map(b => b.id === book.id ? book : b) : [...old, book]);
    readerEntryProgress.current = restoreLocal ? progressRef.current[book.id] : undefined;
    setActiveBookId(book.id);
    setReaderChapter(chapterIndex);
    setChapterError('');
    setScreen('reader');
  };

  const openBook = (book: Book) => {
    if (book.source === 'official') { void openOfficialBook(book); return; }
    openGeneration.current++; setUploadConfirmation(null); setConflict(null);
    const chapterIndex = Math.max(0, Math.min(progressRef.current[book.id]?.chapterIndex ?? 0, book.chapters.length - 1));
    enterBook(book, chapterIndex, true);
  };

  const openOfficialBook = async (book: Book) => {
    const generation = ++openGeneration.current;
    setUploadConfirmation(null); setConflict(null);
    setSyncStatus('正在核对云端进度，自动上传暂停…');
    setOpening({ title: book.title, stage: '正在读取作品目录…' });
    setScreen('opening');
    // Resolve progress alongside the directory, reusing startup account status.
    // No reader/automatic upload exists until progress is resolved or failed.
    const cloud = (async () => {
      const user = await account.getUser();
      const list = user ? await official.readProgress() : null;
      return { user, list };
    })().then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));

    // If chapters are not yet loaded (e.g. from discovery or rankings), fetch them
    let loadedBook = book;
    if (book.chapters.length === 0 && official.available()) {
      try {
        const fetched = await official.book(book.id);
        loadedBook = { ...fetched, coverUrl: fetched.coverUrl || book.coverUrl, description: fetched.description || book.description };
        if (generation !== openGeneration.current) return;
      } catch (err) {
        if (generation !== openGeneration.current) return;
        setOpening({ id: book.id, title: book.title, stage: '', error: `获取作品目录失败：${errorMessage(err)}` });
        return;
      }
    }
    if (loadedBook.chapters.length === 0) {
      if (!official.available()) {
        loadedBook = {
          ...loadedBook,
          chapters: [
            {
              id: `${loadedBook.id}-preview`,
              title: '第一章 序幕',
              content: `《${loadedBook.title}》\n作者：${loadedBook.author}\n\n简介：${loadedBook.description}\n\n（当前为浏览器预览环境，完整官方正文请启动 Windows 桌面程序阅读）`,
              loaded: true,
            },
          ],
        };
      } else {
        setOpening({ id: book.id, title: book.title, stage: '', error: '作品目录为空或暂无发布章节。' });
        return;
      }
    }

    const local = progressRef.current[loadedBook.id];
    let index = Math.max(0, Math.min(local?.chapterIndex ?? 0, Math.max(0, loadedBook.chapters.length - 1)));
    try {
      if (generation !== openGeneration.current) return;
      setOpening({ title: loadedBook.title, stage: '正在核对云端阅读位置…' });
      const result = await cloud;
      if (!result.ok) throw result.error;
      const { user, list } = result.value;
      if (generation !== openGeneration.current) return;
      setOfficialUser(user);
      if (user) {
        if (!Array.isArray(list)) throw new Error('官方进度格式已变化，自动同步暂停。');
        const remote = list.find(p => String(p.book_id) === loadedBook.id);
        if (generation !== openGeneration.current) return;
        cloudBaseline.current[loadedBook.id] = remote ? String(remote.item_id) : '';
        cloudVersions.current[loadedBook.id] = remote?.read_timestamp ?? 0;
        const cloudIndex = remote ? loadedBook.chapters.findIndex(c => c.id === String(remote.item_id)) : -1;
        if (remote && cloudIndex < 0) throw new Error('云端章节不在当前目录中，自动同步暂停，请先检查官网。');
        if (cloudIndex >= 0 && local && index !== cloudIndex) {
          setConflict({ book: loadedBook, local: index, cloud: cloudIndex, cloudUpdatedAt: remote?.read_timestamp }); return;
        }
        if (cloudIndex >= 0) index = cloudIndex;
        setSyncStatus(cloudIndex >= 0 ? '已读取云端章节进度 · 章内位置仅本机保存' : '官方未返回本书章节进度 · 自动上传暂停；手动同步将采用本机当前章节');
        if (remote) setSyncStatus(`官网记录：${loadedBook.chapters[cloudIndex].title} · 记录时间：${cloudTime(remote.read_timestamp)}`);
      } else setSyncStatus('尚未登录 · 阅读进度仅保存在本机');
    } catch (e) {
      if (generation !== openGeneration.current) return;
      setSyncStatus(`云端读取失败，自动同步暂停：${errorMessage(e)}`);
    }
    if (generation === openGeneration.current) enterBook(loadedBook, index, !!local && local.chapterIndex === index);
  };

  const openBookById = async (id: string, title?: string, coverUrl?: string) => {
    // If book already exists in local books list
    const existing = books.find(b => b.id === id);
    if (existing && existing.chapters.length > 0) {
      openBook({ ...existing, title: title || existing.title, coverUrl: coverUrl || existing.coverUrl });
      return;
    }

    if (official.available()) {
      await openOfficialBook({ id, title: title || '官方作品', author: '', description: '', source: 'official',
        coverStyle: 0, coverUrl, addedAt: Date.now(), chapters: [] });
    } else {
      // Browser preview mode fallback
      const mockBook: Book = {
        id,
        title: title || '官方作品',
        author: '番茄正版作者',
        description: '在 Windows 桌面应用中可阅读真实云端章节。当前是浏览器演示环境。',
        source: 'official',
        coverStyle: 0,
        coverUrl,
        addedAt: Date.now(),
        chapters: [
          { id: `${id}-c1`, title: '第一章 序幕', content: `${title || '官方小说'}\n\n当前处于浏览器模拟环境。请通过桌面版启动以阅读官方在线正文与有声版。`, loaded: true }
        ],
      };
      setBooks(old => [...old.filter(b => b.id !== id), mockBook]);
      void openOfficialBook(mockBook);
    }
  };

  const addBookToShelf = async (bookInfo: { id: string; title: string; author: string; description: string; coverUrl?: string; coverStyle?: number }) => {
    if (shelfIds.has(bookInfo.id)) {
      flash(`《${bookInfo.title}》已在书架中。`);
      return;
    }
    let fullBook: Book;
    if (official.available()) {
      try {
        const fetched = await official.book(bookInfo.id);
        fullBook = {
          ...fetched,
          coverUrl: fetched.coverUrl || bookInfo.coverUrl,
          description: fetched.description || bookInfo.description,
        };
      } catch {
        fullBook = {
          id: bookInfo.id,
          title: bookInfo.title,
          author: bookInfo.author,
          description: bookInfo.description,
          source: 'official',
          coverStyle: bookInfo.coverStyle ?? 0,
          coverUrl: bookInfo.coverUrl,
          chapters: [],
          addedAt: Date.now(),
        };
      }
    } else {
      fullBook = {
        id: bookInfo.id,
        title: bookInfo.title,
        author: bookInfo.author,
        description: bookInfo.description,
        source: 'official',
        coverStyle: bookInfo.coverStyle ?? 0,
        coverUrl: bookInfo.coverUrl,
        chapters: [
          { id: `${bookInfo.id}-c1`, title: '第一章 启程', content: `${bookInfo.title}\n\n作者：${bookInfo.author}\n\n简介：${bookInfo.description}\n\n（桌面模式可读取实时正文与云端进度）`, loaded: true }
        ],
        addedAt: Date.now(),
      };
    }

    try {
      await persistBooks([fullBook]);
      flash(`已将《${bookInfo.title}》收藏至书架！`);
    } catch {
      flash('书架保存失败：本地存储空间不足。');
    }
  };

  const isBookInShelf = (id: string) => shelfIds.has(id);

  const chooseProgress = (source: 'local' | 'cloud') => {
    if (!conflict) return;
    setSyncStatus(source === 'local' ? '已选择本机章节，尚未上传' : '已选择云端章节进度');
    enterBook(conflict.book, source === 'local' ? conflict.local : conflict.cloud, source === 'local');
    setConflict(null);
  };

  const jumpChapter = useCallback((index: number) => {
    if (!activeBook || index < 0 || index >= activeBook.chapters.length) return;
    setReaderChapter(index); setChapterError('');
    if (activeBook.source !== 'official') saveReading(activeBook.id, index);
  }, [activeBook, saveReading]);

  const chapterRequests = useRef(new Map<string, Promise<void>>());
  const chapterSlots = useRef({ active: 0, waiting: [] as (() => void)[] });
  const chapterContext = useRef({ screen, bookId: activeBook?.id, index: readerChapter });
  chapterContext.current = { screen, bookId: activeBook?.id, index: readerChapter };
  const loadChapterAt = useCallback((book: Book, index: number): Promise<void> => {
    const target = book.chapters[index];
    if (!target || book.source !== 'official' || target.loaded) return Promise.resolve();
    const key = `${book.id}:${target.id}`;
    const previous = chapterRequests.current.get(key);
    if (previous) return previous;
    const request = (async () => {
      await new Promise<void>(resolve => {
        if (chapterSlots.current.active < 2) { chapterSlots.current.active++; resolve(); }
        else chapterSlots.current.waiting.push(resolve);
      });
      try {
      const current = chapterContext.current;
      if (current.screen !== 'reader' || current.bookId !== book.id || Math.abs(current.index - index) > 2) return;
      const raw = await official.chapter(target.id);
      if (raw.id !== target.id) throw new Error('官方返回章节与请求不匹配，请重试。');
      const loaded = plainChapter(raw);
      if (!loaded.content) throw new Error('官方正文没有可阅读的文字。');
      setBooks(old => old.map(b => b.id === book.id ? { ...b, chapters: b.chapters.map(c => c.id === target.id ? { ...c, ...loaded, title: loaded.title || c.title } : c) } : b));
      } finally {
        const next = chapterSlots.current.waiting.shift();
        if (next) next(); else chapterSlots.current.active--;
      }
    })().finally(() => { chapterRequests.current.delete(key); });
    chapterRequests.current.set(key, request);
    return request;
  }, []);

  useEffect(() => {
    if (screen !== 'reader' || !activeBook || !chapter) { setChapterLoading(false); return; }
    if (activeBook.source !== 'official' || chapter.loaded) { setChapterLoading(false); setChapterError(''); return; }
    let cancelled = false;
    setChapterLoading(true); setChapterError('');
    loadChapterAt(activeBook, readerChapter).catch(e => { if (!cancelled) { setChapterError(errorMessage(e)); setSyncStatus('正文读取失败，本章未上传阅读进度'); } })
      .finally(() => { if (!cancelled) setChapterLoading(false); });
    return () => { cancelled = true; };
  }, [screen, activeBook?.id, chapter?.id, chapter?.loaded, retryChapter]);

  useEffect(() => {
    if (screen !== 'reader' || !activeBook || !chapter?.content || chapterLoading) return;
    const saved = progressRef.current[activeBook.id];
    saveReading(activeBook.id, readerChapter,
      saved?.chapterIndex === readerChapter ? saved.scrollRatio ?? 0 : 0,
      saved?.chapterIndex === readerChapter ? saved.paragraphIndex ?? 0 : 0);
  }, [screen, activeBook?.id, chapter?.id, chapter?.loaded, chapterLoading]);

  const prepareUpload = async () => {
    if (screen !== 'reader' || activeBook?.source !== 'official' || !chapter?.loaded || refreshInFlight.current || syncInFlight.current || conflict || readHistory || historyBusy || uploadConfirmation) return;
    const generation = openGeneration.current, book = activeBook, currentChapter = chapter;
    syncInFlight.current = true; setUploadBusy(true);
    try {
      const list = await official.readProgress();
      if (generation !== openGeneration.current || syncContext.current.chapterId !== currentChapter.id) return;
      if (!Array.isArray(list)) throw new Error('官方进度格式已变化');
      const remote = list.find(p => String(p.book_id) === book.id);
      const remoteId = remote ? String(remote.item_id) : '';
      const remoteTitle = book.chapters.find(c => c.id === remoteId)?.title;
      if (remoteId && !remoteTitle) throw new Error('官网记录不在当前目录中，未上传本机进度');
      setUploadConfirmation({
        generation, bookId: book.id, chapterId: currentChapter.id,
        chapterTitle: currentChapter.title, remoteId, remoteTimestamp: remote?.read_timestamp ?? 0,
        remoteTitle: remoteTitle ?? '官网未返回记录',
      });
    } catch (e) { if (generation === openGeneration.current) setSyncStatus(`上传前核对失败，未修改云端：${errorMessage(e)}`); }
    finally { syncInFlight.current = false; setUploadBusy(false); }
  };

  const syncNow = async (confirmation: NonNullable<typeof uploadConfirmation>) => {
    setUploadConfirmation(null);
    if (screen !== 'reader' || !activeBook || activeBook.source !== 'official' || !chapter?.loaded || refreshInFlight.current || conflict || syncInFlight.current) return;
    const generation = openGeneration.current;
    if (confirmation.generation !== generation || confirmation.bookId !== activeBook.id || confirmation.chapterId !== chapter.id) {
      setSyncStatus('当前书籍或章节已改变，请重新核对后上传'); return;
    }
    syncInFlight.current = true; setUploadBusy(true);
    const bookId = activeBook.id, chapterId = chapter.id, index = readerChapter;
    const isCurrent = () => generation === openGeneration.current && syncContext.current.screen === 'reader' && syncContext.current.bookId === bookId;
    const isChapterCurrent = () => isCurrent() && syncContext.current.chapterId === chapterId;
    setSyncStatus('正在验证并同步本章进度…');
    try {
      const list = await official.readProgress();
      if (!isCurrent()) return;
      if (!Array.isArray(list)) throw new Error('官方进度格式已变化');
      const remote = list.find(p => String(p.book_id) === bookId);
      const remoteId = remote ? String(remote.item_id) : '';
      if (remoteId !== confirmation.remoteId || (remote?.read_timestamp ?? 0) !== confirmation.remoteTimestamp) {
        throw new Error('官网进度在确认后发生变化，本次未上传；请重新读取云端进度');
      }
      if (!isChapterCurrent()) return;
      if (remoteId !== chapterId) await official.syncProgress(bookId, chapterId, index);
      if (!isCurrent()) return;
      cloudBaseline.current[bookId] = chapterId;
      // Read back the timestamp on the next automatic attempt after a manual upload.
      delete cloudVersions.current[bookId];
      if (isChapterCurrent()) setSyncStatus('官网已确认本章记录 · 手机端位置仍需核对');
      else setSyncStatus(`已上传你确认的「${confirmation.chapterTitle}」；当前章节未上传`);
    } catch (e) { if (isCurrent()) setSyncStatus(`同步未完成：${errorMessage(e)}`); }
    finally {
      syncInFlight.current = false;
      setUploadBusy(false);
    }
  };

  const refreshCloud = async (manual = false) => {
    if (screen !== 'reader' || activeBook?.source !== 'official' || refreshInFlight.current || conflict || uploadConfirmation || readHistory || historyBusy) return;
    if (syncInFlight.current) {
      if (manual) flash('本章正在同步，请完成后再读取云端进度。');
      return;
    }
    refreshInFlight.current = true; setCloudRefreshing(true);
    const generation = ++openGeneration.current;
    const book = activeBook, index = readerChapter;
    const valid = () => generation === openGeneration.current && syncContext.current.screen === 'reader' && syncContext.current.bookId === book.id;
    try {
      const list = await official.readProgress();
      if (!valid()) return;
      if (!Array.isArray(list)) throw new Error('官方进度格式已变化');
      const remote = list.find(p => String(p.book_id) === book.id);
      if (!remote) {
        cloudBaseline.current[book.id] = '';
        cloudVersions.current[book.id] = 0;
        setSyncStatus('官网未返回本书进度；无法确认手机当前章节，自动上传暂停');
        return;
      }
      const remoteId = String(remote.item_id);
      const cloudIndex = book.chapters.findIndex(c => c.id === remoteId);
      if (cloudIndex < 0) throw new Error('官网记录的章节不在当前目录中，未按章节编号猜测定位');
      const changed = cloudBaseline.current[book.id] !== remoteId;
      cloudBaseline.current[book.id] = remoteId;
      cloudVersions.current[book.id] = remote.read_timestamp;
      setSyncStatus(`官网记录：${book.chapters[cloudIndex].title} · 记录时间：${cloudTime(remote.read_timestamp)}`);
      if (syncContext.current.chapterId !== remoteId && (changed || manual)) {
        const currentIndex = book.chapters.findIndex(c => c.id === syncContext.current.chapterId);
        setConflict({ book, local: currentIndex >= 0 ? currentIndex : index, cloud: cloudIndex, cloudUpdatedAt: remote.read_timestamp });
      }
    } catch (e) {
      if (valid()) { setSyncStatus(`云端读取失败，自动上传暂停：${errorMessage(e)}`); }
    } finally {
      refreshInFlight.current = false; setCloudRefreshing(false);
      if (valid()) setAutoAttempt(n => n + 1);
    }
  };

  useEffect(() => {
    if (!prefs.autoUploadProgress || screen !== 'reader' || activeBook?.source !== 'official' ||
      !officialUser || !chapter?.loaded || !chapter.content || chapterLoading || chapterError ||
      conflict || uploadConfirmation || readHistory || historyBusy) return;
    const book = activeBook, currentChapter = chapter, index = readerChapter;
    const generation = openGeneration.current, epoch = autoUploadEpoch.current;
    let cancelled = false;
    const valid = () => !cancelled && autoUploadEnabled.current && epoch === autoUploadEpoch.current &&
      generation === openGeneration.current && syncContext.current.screen === 'reader' &&
      syncContext.current.bookId === book.id && syncContext.current.chapterId === currentChapter.id &&
      document.visibilityState === 'visible' && document.hasFocus();
    const timer = window.setTimeout(async () => {
      if (!valid() || syncInFlight.current || refreshInFlight.current) return;
      syncInFlight.current = true; setUploadBusy(true);
      try {
        const list = await official.readProgress();
        if (!valid()) return;
        if (!Array.isArray(list)) throw new Error('官方进度格式已变化');
        const remote = list.find(p => String(p.book_id) === book.id);
        const remoteId = remote ? String(remote.item_id) : '';
        const remoteIndex = book.chapters.findIndex(c => c.id === remoteId);
        if (remoteId && remoteIndex < 0) throw new Error('云端章节不在当前目录中');
        const changed = cloudBaseline.current[book.id] !== remoteId ||
          (cloudVersions.current[book.id] !== undefined && cloudVersions.current[book.id] !== (remote?.read_timestamp ?? 0));
        if (changed && !remoteId) throw new Error('云端记录已消失，请先手动核对进度');
        cloudBaseline.current[book.id] = remoteId;
        cloudVersions.current[book.id] = remote?.read_timestamp ?? 0;
        if (changed && remoteId !== currentChapter.id) {
          if (remoteIndex >= 0) setConflict({ book, local: index, cloud: remoteIndex, cloudUpdatedAt: remote?.read_timestamp });
          setSyncStatus('云端进度已变化，自动上传暂停；请先选择要继续阅读的进度');
          return;
        }
        if (!valid()) return;
        if (remoteId !== currentChapter.id) {
          const result = await official.syncProgress(book.id, currentChapter.id, index);
          if (!result.confirmed) throw new Error('官网未确认上传结果');
          // The server assigns its own timestamp; establish a fresh baseline before the next upload.
          cloudBaseline.current[book.id] = currentChapter.id;
          delete cloudVersions.current[book.id];
        }
        if (valid()) setSyncStatus(`已自动上传：${currentChapter.title} · 手机端位置仍需核对`);
      } catch (e) {
        if (valid()) setSyncStatus(`自动上传暂停：${errorMessage(e)}；可手动重试`);
      } finally { syncInFlight.current = false; setUploadBusy(false); }
    }, 5000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [prefs.autoUploadProgress, screen, activeBook?.id, chapter?.id, chapter?.loaded, chapterLoading,
    chapterError, officialUser, conflict, uploadConfirmation, readHistory, historyBusy, autoAttempt]);

  const refreshRef = useRef(refreshCloud); refreshRef.current = refreshCloud;
  const showReadHistory = async () => {
    if (screen !== 'reader' || activeBook?.source !== 'official' || historyBusy) return;
    const generation = openGeneration.current, book = activeBook;
    setHistoryBusy(true);
    try {
      const ids = new Set(await official.readHistory(book.id));
      if (generation !== openGeneration.current || syncContext.current.bookId !== book.id || syncContext.current.screen !== 'reader') return;
      const matches = book.chapters.flatMap((c, index) => ids.has(c.id) ? [{ index, title: c.title }] : []).reverse();
      setHistoryQuery(''); setReadHistory(matches);
    } catch (e) { if (generation === openGeneration.current) flash(`已读记录读取失败：${errorMessage(e)}`); }
    finally { setHistoryBusy(false); }
  };

  useEffect(() => {
    if (screen !== 'reader' || activeBook?.source !== 'official') return;
    let lastAttempt = 0;
    const refresh = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastAttempt < 2000) return;
      lastAttempt = Date.now();
      void refreshRef.current();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [screen, activeBook?.id]);

  const handleImportFiles = async (files: File[]) => {
    if (!files.length) return;
    if (importing.current) { flash('正在导入文件，请等待本次保存完成。'); return; }
    importing.current = true; setImportBusy(true);
    try {
      const additions: Book[] = [];
      for (const file of files) {
        try { additions.push(await importBook(file)); }
        catch (err) { flash(`${file.name} 导入失败：${err instanceof Error ? err.message : String(err)}`); }
      }
      if (!additions.length) return;
      try {
        await persistBooks(additions);
        flash(`成功导入 ${additions.length} 本书籍，已收藏至书架。`);
        setQuery(''); navigate('bookshelf');
      } catch {
        flash('导入保存失败，请检查磁盘空间和本地资料是否可写。此次导入未加入书架。');
      }
    } finally { importing.current = false; setImportBusy(false); }
  };

  const handleImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    await handleImportFiles(files);
  };

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(false);
    const files = Array.from(e.dataTransfer.files).filter(f =>
      /\.(txt|epub)$/i.test(f.name) || f.type === 'text/plain' || f.type === 'application/epub+zip'
    );
    if (files.length) {
      await handleImportFiles(files);
    }
  };

  const deleteBook = async (book: Book) => {
    if ((book.source !== 'local' && book.source !== 'official') || !window.confirm(`确定从书架移除「${book.title}」？`)) return;
    try {
      const saved = await storage.removeBook(book.id);
      setShelfIds(new Set(saved.map(b => b.id)));
      setBooks(old => old.filter(b => b.id !== book.id));
      if (activeBookId === book.id) { navigate('bookshelf'); setActiveBookId(null); }
      flash(`已从书架移除《${book.title}》。`);
    } catch { flash('书架更新保存失败。'); }
  };

  const openOfficial = async () => {
    try { await openOfficialWebsite(); }
    catch (err) { flash(`无法打开官方网站：${err instanceof Error ? err.message : String(err)}`); }
  };

  return (
    <div
      aria-busy={importBusy}
      className={`app-shell theme-${prefs.theme}`}
      onDragOver={e => { e.preventDefault(); setIsDraggingFile(true); }}
      onDragLeave={e => { if (e.currentTarget === e.target) setIsDraggingFile(false); }}
      onDrop={handleDrop}
    >
      <WindowTitlebar context={screen === 'reader' && activeBook ? activeBook.title : '私人阅读空间'}/>
      {/* Sidebar Navigation */}
      {importBusy && <div className="import-status" role="status">正在导入并保存书籍，请稍候…</div>}
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate('bookshelf')} title="回到书架">
          <span className="brand-icon moyu-mark"><BookOpen size={22}/></span>
          <div className="brand-text">
            <strong>{APP_NAME}</strong>
            <small>{APP_TAGLINE}</small>
          </div>
        </button>

        <div className="side-group-title">发现好书</div>
        <nav className="side-nav" aria-label="主导航">
          <button
            className={screen === 'rankings' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => navigate('rankings')}
            title="热门排行榜单"
          >
            <Trophy size={18} className="nav-icon" />
            <span>排行榜单</span>
            <span className="nav-pill-badge hot">HOT</span>
          </button>

          <button
            className={screen === 'discovery' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => navigate('discovery')}
            title="找书发现与分类探索"
          >
            <Compass size={18} className="nav-icon" />
            <span>找书发现</span>
            <span className="nav-pill-badge new">搜全网</span>
          </button>
        </nav>

        <div className="side-group-title" style={{ marginTop: 20 }}>我的空间</div>
        <nav className="side-nav" aria-label="用户导航">
          <button
            className={screen === 'bookshelf' || screen === 'reader' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => navigate('bookshelf')}
          >
            <Library size={18} className="nav-icon" />
            <span>本地书架</span>
            <span className="nav-count">{books.length}</span>
          </button>

          <button
            className={screen === 'cloud-shelf' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => navigate('cloud-shelf')}
          >
            <Cloud size={18} className="nav-icon" />
            <span>云端书架</span>
            {officialUser && <span className="nav-count">{account.shelfBusy ? '…' : account.shelf.length}</span>}
          </button>

          <button
            className={screen === 'official' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => navigate('official')}
          >
            <UserRound size={18} className="nav-icon" />
            <span>账号管理</span>
          </button>

          <button
            className={screen === 'settings' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => navigate('settings')}
          >
            <Settings2 size={18} className="nav-icon" />
            <span>阅读设置</span>
          </button>

          <button className="nav-btn nav-link" onClick={openOfficial}>
            <ExternalLink size={17} className="nav-icon" />
            <span>番茄官方网站</span>
          </button>
        </nav>

        {/* Cloud Sync Account Status Box */}
        <div className="cloud-module">
          <div className="cloud-header">
            <span className={`cloud-icon ${officialUser ? 'connected' : ''}`}>
              {officialUser ? <Cloud size={16} /> : <CloudOff size={16} />}
            </span>
            <div className="cloud-status-text">
              <strong>{officialUser ? officialUser.name : account.checking ? '正在检查账号…' : account.accountError ? '账号状态待确认' : '未登录官方账号'}</strong>
              <small>{account.accountError ? '账号检查失败，可重试' : officialUser ? account.shelfBusy ? '正在后台加载云端书架…' : account.shelfError ? '云端书架加载失败，可重试' : `云端书架 ${account.shelf.length} 本` : '阅读记录保存在本机'}</small>
            </div>
          </div>
          <button className="cloud-module-btn" onClick={() => navigate('official')}>
            <span>{officialUser ? '管理账号' : account.checking ? '查看账号状态' : '登录或检查账号'}</span>
            <ArrowRight size={13} />
          </button>
        </div>

        <div className="side-bottom">
          <span className={`online-dot ${officialUser ? 'green' : 'orange'}`} />
          <span>{account.checking ? '正在检查账号' : account.accountError ? '账号检查失败' : officialUser ? '官方账号在线' : '本地阅读模式'}</span>
          <small>v{CURRENT_VERSION}</small>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-panel">
        {screen === 'opening' && opening ? (
          <section className="opening-screen" aria-busy={!opening.error}>
            <button className="secondary-button" onClick={() => navigate('bookshelf')}><ArrowLeft size={16}/>返回书架</button>
            <div className="opening-card"><div className="eyebrow">正在打开作品</div><h1>{opening.title}</h1>
              {opening.error ? <><p role="alert">{opening.error}</p>{opening.id && <button className="primary-button" onClick={() => void openBookById(opening.id!, opening.title)}>重试打开</button>}<button className="primary-button" onClick={() => navigate('discovery')}>返回找书</button></> : <><p role="status">{opening.stage}</p><div className="opening-skeleton" aria-hidden="true">{[1,2,3,4,5].map(i => <span key={i}/>)}</div></>}
            </div>
          </section>
        ) : screen === 'reader' && activeBook && chapter ? (
          <Reader
            book={activeBook}
            index={readerChapter}
            prefs={prefs}
            initialProgress={readerEntryProgress.current}
            onJump={jumpChapter}
            onVisible={i => { setReaderChapter(i); setChapterError(''); }}
            loadChapter={i => loadChapterAt(activeBook, i)}
            onBack={() => navigate('bookshelf')}
            onSave={(i, ratio, paragraph) => saveReading(activeBook.id, i, ratio, paragraph)}
            onSync={() => void prepareUpload()}
            onRefreshCloud={() => void refreshCloud(true)}
            onReadHistory={() => void showReadHistory()}
            historyBusy={historyBusy}
            cloudRefreshing={cloudRefreshing}
            canSync={!cloudRefreshing && !uploadBusy && !!officialUser}
            syncStatus={syncStatus}
            loading={chapterLoading}
            loadError={chapterError}
            onRetry={() => setRetryChapter(n => n + 1)}
            onOfficial={() => { void openOfficialWebsite(`https://fanqienovel.com/reader/${chapter.id}`).catch(e => flash(errorMessage(e))); }}
            settings={<PreferenceControls prefs={prefs} setPreference={setPreference} />}
            notice={flash}
          />
        ) : screen === 'rankings' ? (
          <LeaderboardView
            onOpenBookId={openBookById}
            onAddBookToShelf={addBookToShelf}
            isBookInShelf={isBookInShelf}
            notice={flash}
            busy={chapterLoading}
          />
        ) : screen === 'discovery' ? (
          <DiscoveryView
            onOpenBookId={openBookById}
            onAddBookToShelf={addBookToShelf}
            isBookInShelf={isBookInShelf}
            notice={flash}
            busy={chapterLoading}
          />
        ) : screen === 'cloud-shelf' ? (
          <CloudShelf account={account} onOpenBookId={openBookById} onManageAccount={() => navigate('official')} />
        ) : screen === 'official' ? (
          <OfficialPanel
            account={account}
            notice={flash}
            onAccount={u => {
              openGeneration.current++;
              setUploadConfirmation(null);
              setConflict(null);
              setOfficialUser(u);
              cloudBaseline.current = {};
              cloudVersions.current = {};
              if (!u) {
                setActiveBookId(null);
              }
            }}
          />
        ) : screen === 'settings' ? (
          <div className="settings-screen">
            <div className="topbar">
              <div className="breadcrumbs">设置 <ChevronRight size={15} /> 阅读偏好</div>
              <span className="version-label">{APP_NAME} / v{CURRENT_VERSION}</span>
            </div>
            <div className="settings-center">
              <div className="eyebrow">READING PREFERENCES</div>
              <h1>阅读偏好</h1>
              <p className="subheading">调整整个应用的主题与正文排版。更改会自动保存到这台电脑。</p>
              <div className="settings-card">
                <PreferenceControls prefs={prefs} setPreference={setPreference} />
              </div>

              <div className="eyebrow" style={{ marginTop: '28px' }}>SOFTWARE UPDATES</div>
              <h2>软件检查更新</h2>
              <p className="subheading">检查{APP_NAME}最新版本与功能升级。</p>
              <div className="settings-card update-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '14px' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '15px' }}>
                      当前版本: v{CURRENT_VERSION}
                    </div>
                    <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
                      {updateChecking
                        ? '正在连接服务器检查新版本…'
                        : updateResult?.hasUpdate
                        ? `发现新版本: v${updateResult.latestVersion}${updateResult.publishedAt ? ` (发布于 ${updateResult.publishedAt})` : ''}`
                        : updateResult?.error
                        ? `检查更新提示: ${updateResult.error}`
                        : updateResult
                        ? '已是最新版本，无需更新。'
                        : '点击按钮即可在线检测官方最新版本。'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      className="outline-button"
                      disabled={updateChecking}
                      onClick={() => void handleCheckUpdate()}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 16px' }}
                    >
                      <RefreshCw size={14} className={updateChecking ? 'spin' : ''} />
                      <span>{updateChecking ? '检查中…' : '检查更新'}</span>
                    </button>
                    {updateResult?.hasUpdate && (
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => {
                          const url = updateResult.installerUrl || updateResult.downloadUrl || 'https://github.com/duchen520/Tomato-Reader/releases';
                          window.open(url, '_blank', 'noopener,noreferrer');
                        }}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 16px' }}
                      >
                        <ExternalLink size={14} />
                        <span>下载更新</span>
                      </button>
                    )}
                  </div>
                </div>
                {updateResult?.hasUpdate && updateResult.releaseNotes && (
                  <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-light)' }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--brand-orange)', marginBottom: '6px' }}>更新说明：</div>
                    <pre style={{ fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', maxHeight: '140px', overflowY: 'auto', background: 'var(--bg-sidebar)', padding: '10px', borderRadius: '8px', margin: 0 }}>
                      {updateResult.releaseNotes}
                    </pre>
                  </div>
                )}
              </div>

              <div className="settings-bottom-actions">
                <button className="primary-button" onClick={() => navigate('bookshelf')}>
                  <span>返回我的书架</span>
                  <ArrowRight size={16} />
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Bookshelf Screen */
          <div className="library-screen">
            <header className="topbar">
              <div className="breadcrumbs">
                <span>我的空间</span>
                <ChevronRight size={14} />
                <span className="active-breadcrumb">本地书架</span>
              </div>
              <div className="top-actions">
                <div className="search-box">
                  <Search size={16} />
                  <input
                    aria-label="搜索书架"
                    placeholder="在我的书架中搜索书名或作者..."
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                  />
                  {query && (
                    <button className="clear-search-mini" onClick={() => setQuery('')}>✕</button>
                  )}
                </div>
                {/* Modern subtle book import button, not intrusive */}
                <button
                  className="shelf-import-btn outline-button"
                  onClick={() => fileInput.current?.click()}
                  title="导入本地 TXT 或 EPUB 电子书"
                >
                  <FilePlus size={15} />
                  <span>导入本地书籍 (TXT/EPUB)</span>
                </button>
                <button className="profile-button" onClick={openOfficial} title="打开番茄官方网站">
                  <span>🍅 番茄官网</span>
                  <ExternalLink size={12} />
                </button>
              </div>
            </header>

            <div className="library-content">
              {/* Hero Reading Card */}
              <div className="hero-card">
                <div className="hero-copy">
                  <div className="hero-chip">
                    <BookOpen size={14} />
                    <span>最近阅读</span>
                  </div>
                  <h2>{lastRead?.title ?? '今天，想读点什么故事？'}</h2>
                  <p>
                    {lastRead
                      ? `${lastRead.author} · 上次阅读至第 ${(progress[lastRead.id]?.chapterIndex ?? 0) + 1} 章 · ${timeLabel(progress[lastRead.id].updatedAt)}`
                      : '从排行榜或书库发现好书，或者直接打开已收藏的作品开始阅读。'}
                  </p>
                  <div className="hero-btn-row">
                    <button className="hero-read-btn" onClick={() => { const book = lastRead ?? books[0]; if (book) openBook(book); else navigate('discovery'); }}>
                      <span>{books.length ? '开始阅读' : '去找一本书'}</span>
                      <ArrowRight size={16} />
                    </button>
                    <button className="hero-explore-btn" onClick={() => navigate('rankings')}>
                      <Trophy size={15} />
                      <span>查看排行榜</span>
                    </button>
                  </div>
                </div>
                <div className="hero-art" aria-hidden="true">
                  <div className="art-orbit orbit-a"></div>
                  <div className="art-orbit orbit-b"></div>
                  <BookOpen size={94} strokeWidth={0.9} />
                </div>
              </div>

              {/* Shelf Controls & Filter Tabs */}
              <div className="shelf-heading">
                <div>
                  <div className="shelf-title-row">
                    <h2>我的书架</h2>
                    <span className="subtle-count">{filteredBooks.length} 本</span>
                  </div>
                  <p className="shelf-desc">收藏好书，记录每一段阅读时光。</p>
                </div>

                <div className="shelf-tabs-group">
                  <button
                    className={`shelf-tab ${shelfFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setShelfFilter('all')}
                  >
                    全部 ({books.length})
                  </button>
                  <button
                    className={`shelf-tab ${shelfFilter === 'recent' ? 'active' : ''}`}
                    onClick={() => setShelfFilter('recent')}
                  >
                    在读 ({books.filter(b => progress[b.id]).length})
                  </button>
                  <button
                    className={`shelf-tab ${shelfFilter === 'official' ? 'active' : ''}`}
                    onClick={() => setShelfFilter('official')}
                  >
                    正版云端 ({books.filter(b => b.source === 'official').length})
                  </button>
                  <button
                    className={`shelf-tab ${shelfFilter === 'local' ? 'active' : ''}`}
                    onClick={() => setShelfFilter('local')}
                  >
                    本地书籍 ({books.filter(b => b.source === 'local').length})
                  </button>
                </div>
              </div>

              {/* Book Grid */}
              <div className="book-grid">
                {filteredBooks.map(book => {
                  const currentProg = progress[book.id];
                  const totalCh = Math.max(1, book.chapters.length);
                  const readCh = currentProg ? currentProg.chapterIndex + 1 : 0;
                  const percent = Math.min(100, Math.round((readCh / totalCh) * 100));

                  return (
                    <article className="book-card" key={book.id}>
                      <button
                        className={`book-cover cover-${book.coverStyle % 5} ${book.source === 'official' ? 'official-book-cover' : ''}`}
                        onClick={() => openBook(book)}
                        aria-label={`阅读 ${book.title}`}
                      >
                        {book.source === 'official' ? (
                          <OfficialCover bookId={book.id} url={book.coverUrl} title={book.title} />
                        ) : (
                          <>
                            <div className="cover-topline">{APP_NAME} · 私人书藏</div>
                            <span className="cover-title">{book.title}</span>
                            <span className="cover-bottom">
                              {book.source === 'demo' ? 'SAMPLE FICTION' : 'LOCAL LIBRARY'}
                            </span>
                          </>
                        )}
                        {currentProg && (
                          <span className="cover-progress-badge">{percent}%</span>
                        )}
                      </button>

                      <div className="book-caption">
                        <div className="book-name-row">
                          <button
                            className="book-title-btn"
                            onClick={() => openBook(book)}
                            title={book.title}
                          >
                            {book.title}
                          </button>
                          {(book.source === 'local' || book.source === 'official') && (
                            <button
                              className="trash-btn"
                              title="从书架移除"
                              onClick={() => deleteBook(book)}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>

                        <p className="book-author-text">{book.author}</p>

                        <div className="book-meta">
                          <span>{book.chapters.length} 章</span>
                          <span>{currentProg ? `读至 ${readCh} 章` : '未读'}</span>
                        </div>

                        <div className="progress-track" title={`阅读进度：${percent}%`}>
                          <div style={{ width: `${percent}%` }} />
                        </div>
                      </div>
                    </article>
                  );
                })}

                {/* Subtle Add Card at end of grid, not in front */}
                {!query && (
                  <button
                    className="add-book-card"
                    onClick={() => fileInput.current?.click()}
                    title="点击导入本地 TXT 或 EPUB 文件"
                  >
                    <span className="add-icon-circle">
                      <Plus size={22} />
                    </span>
                    <strong>导入本地书籍</strong>
                    <small>支持 TXT / EPUB 或拖入窗口</small>
                  </button>
                )}
              </div>

              {filteredBooks.length === 0 && (
                <div className="empty-state">
                  <Search size={32} />
                  <p>没有找到匹配的书籍</p>
                  <button onClick={() => { setQuery(''); setShelfFilter('all'); }}>清除筛选条件</button>
                </div>
              )}

              {/* Bottom Quick Discover Banner */}
              <div className="discover-cta-banner">
                <div className="cta-left">
                  <Sparkles size={20} className="cta-sparkle" />
                  <div>
                    <strong>想看更多精彩小说？</strong>
                    <p>在线读取官方阅读榜与新书榜，可按男女频和题材分类浏览、加载更多作品，排名以官网当日榜单为准。</p>
                  </div>
                </div>
                <div className="cta-right">
                  <button className="cta-btn primary" onClick={() => navigate('rankings')}>
                    <Trophy size={14} />
                    <span>查看排行榜</span>
                  </button>
                  <button className="cta-btn secondary" onClick={() => navigate('discovery')}>
                    <Compass size={14} />
                    <span>全网找书</span>
                  </button>
                </div>
              </div>

              {/* Privacy / Beta Info footer */}
              <div className="privacy-strip">
                <Info size={16} />
                <span>{APP_NAME}已接入官方正版书库搜索、云端阅读进度双向核对、真人有声剧播放及书评系统。</span>
                <button onClick={openOfficial}>
                  <span>访问番茄官网</span>
                  <ExternalLink size={13} />
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Hidden File Input for TXT/EPUB Import */}
      <input
        ref={fileInput}
        className="hidden-input"
        type="file"
        accept=".txt,.epub,text/plain,application/epub+zip"
        multiple
        onChange={handleImport}
      />

      {/* Drag & Drop File Overlay */}
      {isDraggingFile && (
        <div
          className="drag-drop-overlay"
          onDragOver={e => e.preventDefault()}
          onDragLeave={() => setIsDraggingFile(false)}
          onDrop={handleDrop}
        >
          <div className="drag-drop-card" onDragOver={e => e.preventDefault()} onDrop={handleDrop}>
            <UploadCloud size={48} className="drag-icon-glow" />
            <h2>释放文件以导入书籍</h2>
            <p>支持 UTF-8 TXT 和 EPUB 电子书，导入后加入本地书架。</p>
          </div>
        </div>
      )}

      {/* Read History Modal */}
      {readHistory && (
        <div className="modal-backdrop">
          <div className="progress-dialog" role="dialog" aria-modal="true" aria-labelledby="history-dialog-title">
            <h2 id="history-dialog-title">从已读记录找回位置</h2>
            <p>这些章节曾被标记为已读，不代表最后停留位置。选择后仅在电脑打开，不上传云端。</p>
            <input
              className="history-search"
              aria-label="搜索已读章节"
              placeholder="输入章节编号或标题"
              value={historyQuery}
              onChange={e => setHistoryQuery(e.target.value)}
            />
            <div className="history-chapters">
              {readHistory.filter(c => `${c.index + 1} ${c.title}`.includes(historyQuery.trim())).map(c => (
                <button key={c.index} onClick={() => { setReadHistory(null); jumpChapter(c.index); }}>
                  {c.title}
                </button>
              ))}
              {!readHistory.length && <p>官网本次没有返回可对应目录的已读章节。</p>}
            </div>
            <button onClick={() => setReadHistory(null)}>关闭已读记录</button>
          </div>
        </div>
      )}

      {/* Cloud Upload Confirmation Modal */}
      {uploadConfirmation && (
        <div className="modal-backdrop">
          <div className="progress-dialog" role="dialog" aria-modal="true" aria-labelledby="upload-dialog-title">
            <h2 id="upload-dialog-title">确认覆盖云端章节？</h2>
            <p>本操作会写入官网记录，并可能改变手机的续读位置。若手机读得更靠后，请取消。</p>
            <p>云端：{uploadConfirmation.remoteTitle} · {cloudTime(uploadConfirmation.remoteTimestamp)}</p>
            <p>将上传：{uploadConfirmation.chapterTitle}</p>
            <button onClick={() => void syncNow(uploadConfirmation)}>确认上传本章</button>
            <button onClick={() => setUploadConfirmation(null)}>取消上传</button>
          </div>
        </div>
      )}

      {/* Cloud / Local Conflict Modal */}
      {conflict && (
        <div className="modal-backdrop">
          <div className="progress-dialog" role="dialog" aria-modal="true" aria-labelledby="progress-dialog-title">
            <h2 id="progress-dialog-title">从哪里继续阅读？</h2>
            <p>「{conflict.book.title}」本机和官网返回的章节不同，尚未上传本机进度。</p>
            <p>云端：{conflict.book.chapters[conflict.cloud].title} · {cloudTime(conflict.cloudUpdatedAt ?? 0)}</p>
            <p>本机：{conflict.book.chapters[conflict.local].title}</p>
            <button onClick={() => chooseProgress('cloud')}>采用云端：第 {conflict.cloud + 1} 章</button>
            <button onClick={() => chooseProgress('local')}>采用本机：第 {conflict.local + 1} 章</button>
            <button onClick={() => { setConflict(null); if (screen === 'opening') navigate('bookshelf'); }}>取消</button>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button title="关闭提示" onClick={() => setNotice(null)}>
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

function PreferenceControls({ prefs, setPreference }: { prefs: Preferences, setPreference: (changes: Partial<Preferences>) => void }) {
  const themes: { value: Theme, name: string, icon: ReactNode }[] = [
    { value: 'paper', name: '纸张白', icon: <Sun size={17} /> },
    { value: 'sepia', name: '羊皮纸', icon: <BookOpen size={17} /> },
    { value: 'night', name: '深夜黑', icon: <Moon size={17} /> },
  ];
  return (
    <div className="preference-controls">
      <div className="control-block">
        <label htmlFor="reading-mode">阅读模式</label>
        <select id="reading-mode" value={prefs.readingMode ?? 'normal'} onChange={event => setPreference({ readingMode: event.target.value as 'normal' | 'continuous' })}>
          <option value="normal">普通模式 · 按章节阅读</option>
          <option value="continuous">连续阅读 · 上下滚动跨章节</option>
        </select>
        <p>默认普通模式。连续阅读可直接滚入前后章，提前读取附近 1–2 章；目录与进度跟随实际阅读位置，预加载不会上传进度。</p>
      </div>
      <div className="control-block upload-preference">
        <label htmlFor="auto-upload-progress">云端自动上传阅读进度</label>
        <button id="auto-upload-progress" className="preference-switch" type="button" role="switch" aria-checked={!!prefs.autoUploadProgress}
          onClick={() => setPreference({ autoUploadProgress: !prefs.autoUploadProgress })}>
          <span className="switch-track" aria-hidden="true"><span /></span>
          {prefs.autoUploadProgress ? '已开启 · 点击关闭' : '已关闭 · 点击开启'}
        </button>
        <p>默认关闭。开启后，正文加载并停留 5 秒会上传当前章节，可能改变手机续读位置；云端进度变化时暂停并询问。仅同步章节，不同步章内位置。</p>
      </div>
      <div className="control-block">
        <label>应用与阅读主题</label>
        <div className="theme-options">
          {themes.map(theme => (
            <button
              key={theme.value}
              className={`theme-choice ${theme.value} ${prefs.theme === theme.value ? 'chosen' : ''}`}
              aria-pressed={prefs.theme === theme.value}
              onClick={() => setPreference({ theme: theme.value })}
            >
              {theme.icon}
              {theme.name}
              {prefs.theme === theme.value && <Check size={14} />}
            </button>
          ))}
        </div>
      </div>
      <div className="control-block">
        <label>字体大小 <span>{prefs.fontSize}px</span></label>
        <div className="stepper">
          <button aria-label="减小字体" disabled={prefs.fontSize <= 14} onClick={() => setPreference({ fontSize: Math.max(14, prefs.fontSize - 1) })}>
            <Minus size={17} />
          </button>
          <div className="range-track">
            <div style={{ width: `${((prefs.fontSize - 14) / 16) * 100}%` }} />
          </div>
          <button aria-label="增大字体" disabled={prefs.fontSize >= 30} onClick={() => setPreference({ fontSize: Math.min(30, prefs.fontSize + 1) })}>
            <Plus size={17} />
          </button>
        </div>
      </div>
      <div className="control-block">
        <label>行间距 <span>{prefs.lineHeight.toFixed(2)}</span></label>
        <input
          type="range"
          aria-label="行间距"
          min="1.4"
          max="2.6"
          step="0.1"
          value={prefs.lineHeight}
          onChange={e => setPreference({ lineHeight: Number(e.target.value) })}
        />
      </div>
      <div className="control-block">
        <label>正文宽度 <span>{prefs.contentWidth}px</span></label>
        <input
          type="range"
          aria-label="正文宽度"
          min="540"
          max="980"
          step="20"
          value={prefs.contentWidth}
          onChange={e => setPreference({ contentWidth: Number(e.target.value) })}
        />
      </div>
      <div className="control-block">
        <label htmlFor="show-paragraph-comments">正文段评气泡</label>
        <button id="show-paragraph-comments" className="preference-switch" type="button" role="switch" aria-checked={prefs.showParagraphComments !== false} onClick={() => setPreference({ showParagraphComments: prefs.showParagraphComments === false })}>
          <span className="switch-track" aria-hidden="true"><span /></span>{prefs.showParagraphComments !== false ? '已开启 · 点击关闭' : '已关闭 · 点击开启'}
        </button>
        <p>正版作品的有评论段落显示气泡，点击后读取该段评论与回复。阅读器顶部也可临时隐藏气泡。</p>
      </div>
    </div>
  );
}
