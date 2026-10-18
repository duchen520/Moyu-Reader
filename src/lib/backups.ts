import { invoke } from '@tauri-apps/api/core';
import type { Book, Preferences, ReadingProgress } from '../types';
import { storage, DEFAULT_PREFERENCES } from './storage';
import { createRecoveredLibrary } from './bookDatabase';
import { RESTORED_STATE_KEY, restoredState } from './restoredState';
import { CURRENT_VERSION } from './updater';

export interface BackupInfo { id: string; createdAt: number; kind: string; version: string; books: number; localBooks: number; bytes: number; valid: boolean; error?: string }
export interface BackupPayload { schema: 1; version: string; books: Book[]; progress: Record<string, ReadingProgress>; preferences: Preferences }
type Kind = 'auto' | 'manual' | 'before-update' | 'before-restore';
const native = () => typeof Reflect.get(window, '__TAURI_INTERNALS__')?.invoke === 'function';
let queue: Promise<unknown> = Promise.resolve();
let restoring = false;
let revision = 1, savedRevision = 0;
let latestInfo: BackupInfo | null = null;
let lastStatus = '启动后自动备份，阅读期间每 5 分钟保存一次有变化的资料。';
export const backupStatus = () => lastStatus;
const report = (text: string) => { lastStatus = text; window.dispatchEvent(new Event('moyu-backup-status')); };
export const listBackups = () => invoke<{ path: string; backups: BackupInfo[] }>('backup_list');

// Canonical field lists intentionally exclude session/account information,
// browser data, Blob references and cached official chapter bodies.
export function validateBackup(raw: unknown): BackupPayload {
  const value = raw as BackupPayload;
  if (!value || value.schema !== 1 || typeof value.version !== 'string' || !Array.isArray(value.books) || !value.progress || typeof value.progress !== 'object' || Array.isArray(value.progress) || !value.preferences) throw Error('备份格式不兼容，原资料未更改。');
  const ids = new Set<string>();
  const books = value.books.map(book => {
    if (!book || typeof book.id !== 'string' || !book.id || ids.has(book.id) || typeof book.title !== 'string' || typeof book.author !== 'string' || typeof book.description !== 'string' || !['local', 'official'].includes(book.source) || !Array.isArray(book.chapters)) throw Error('备份书架格式异常，原资料未更改。');
    ids.add(book.id);
    const chapterIds = new Set<string>();
    const chapters = book.chapters.map(chapter => {
      if (!chapter || typeof chapter.id !== 'string' || chapterIds.has(chapter.id) || typeof chapter.title !== 'string' || typeof chapter.content !== 'string') throw Error('备份章节不完整，原资料未更改。');
      chapterIds.add(chapter.id);
      return { id: chapter.id, title: chapter.title, content: book.source === 'official' ? '' : chapter.content, loaded: book.source !== 'official' };
    });
    return { id: book.id, title: book.title, author: book.author, description: book.description, source: book.source,
      coverStyle: Number.isFinite(book.coverStyle) ? book.coverStyle : 0, coverUrl: typeof book.coverUrl === 'string' ? book.coverUrl : undefined,
      addedAt: Number.isFinite(book.addedAt) ? book.addedAt : 0, chapters };
  });
  const progress = Object.fromEntries(Object.entries(value.progress).map(([id, p]) => {
    if (!p || !Number.isInteger(p.chapterIndex) || p.chapterIndex < 0 || !Number.isFinite(p.updatedAt) || (p.scrollRatio !== undefined && (!Number.isFinite(p.scrollRatio) || p.scrollRatio < 0 || p.scrollRatio > 1)) || (p.paragraphIndex !== undefined && (!Number.isInteger(p.paragraphIndex) || p.paragraphIndex < 0))) throw Error('备份阅读进度格式异常，原资料未更改。');
    return [id, { chapterIndex: p.chapterIndex, scrollRatio: p.scrollRatio, paragraphIndex: p.paragraphIndex, updatedAt: p.updatedAt }];
  }));
  const prefs = { ...DEFAULT_PREFERENCES, ...value.preferences };
  if (!['paper', 'night', 'sepia'].includes(prefs.theme) || !Number.isFinite(prefs.fontSize) || prefs.fontSize < 14 || prefs.fontSize > 30 || !Number.isFinite(prefs.lineHeight) || prefs.lineHeight < 1.4 || prefs.lineHeight > 2.6 || !Number.isFinite(prefs.contentWidth) || prefs.contentWidth < 540 || prefs.contentWidth > 980 || !['normal', 'continuous'].includes(prefs.readingMode ?? 'normal')) throw Error('备份阅读设置格式异常，原资料未更改。');
  return { schema: 1, version: value.version, books, progress, preferences: { theme: prefs.theme, fontSize: prefs.fontSize, lineHeight: prefs.lineHeight, contentWidth: prefs.contentWidth, readingMode: prefs.readingMode, autoUploadProgress: !!prefs.autoUploadProgress, showParagraphComments: prefs.showParagraphComments !== false } };
}
function snapshot(): BackupPayload {
  // Never silently replace a previously healthy backup with a parse fallback.
  if (!restoredState()) for (const key of ['progress', 'preferences']) {
    const raw = localStorage.getItem('tomato-reader-v01:' + key);
    if (raw) { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('本机进度或设置格式异常，旧备份已保留。'); }
  }
  return validateBackup({ schema: 1, version: CURRENT_VERSION, books: storage.books().filter(b => b.source !== 'demo'), preferences: storage.preferences(), progress: storage.progress() });
}
export function createBackup(kind: Kind): Promise<BackupInfo> {
  const operation = queue.then(async () => {
    if (!native()) throw Error('请在桌面应用中使用本机文件备份。');
    if (restoring && kind !== 'before-restore') throw Error('正在恢复资料，请等待恢复完成。');
    await storage.whenBooksIdle();
    if (kind === 'auto' && savedRevision === revision && latestInfo) return latestInfo;
    const captured = revision;
    const data = snapshot();
    report('正在保存本机备份…');
    const info = await invoke<BackupInfo>('backup_create', { payload: JSON.stringify(data), kind });
    savedRevision = captured;
    latestInfo = info;
    report(`最近备份：${new Date(info.createdAt).toLocaleString()} · ${info.books} 本书`);
    return info;
  });
  queue = operation.catch(error => { report(`备份未完成：${error instanceof Error ? error.message : String(error)}`); });
  return operation;
}
export function startAutoBackups() {
  let booksTimer: ReturnType<typeof setTimeout> | undefined;
  const auto = () => { if (native() && !restoring && revision !== savedRevision) void createBackup('auto').catch(() => {}); };
  const changed = (event: Event) => {
    revision++;
    if ((event as CustomEvent).detail === 'books') { clearTimeout(booksTimer); booksTimer = setTimeout(auto, 3000); }
  };
  window.addEventListener('moyu-library-changed', changed);
  const initial = setTimeout(auto, 3000), interval = setInterval(auto, 5 * 60 * 1000);
  return () => { clearTimeout(initial); clearTimeout(booksTimer); clearInterval(interval); window.removeEventListener('moyu-library-changed', changed); };
}
export async function restoreBackup(id: string, healthy: boolean) {
  if (restoring) throw Error('资料恢复已经开始，请稍候。');
  restoring = true;
  try {
    const payload = await invoke<string>('backup_load', { id });
    const data = validateBackup(JSON.parse(payload));
    if (healthy) await createBackup('before-restore');
    else await queue;
    const database = await createRecoveredLibrary(data.books);
    // One atomic localStorage write switches the book database, preferences and
    // progress together. A quota/error leaves all original records selected.
    localStorage.setItem(RESTORED_STATE_KEY, JSON.stringify({ database, progress: data.progress, preferences: { ...data.preferences, autoUploadProgress: false } }));
    return database;
  } catch (error) { restoring = false; throw error; }
}
