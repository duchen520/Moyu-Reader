import type { Book } from '../types';
import { focusChapterCache, limitChapterCache } from './chapterCache';
import { restoredState } from './restoredState';

const DATABASE = 'tomato-reader-library';
const LEGACY_KEY = 'tomato-reader-v01:books';
let database: IDBDatabase | null = null;
let initialization: Promise<void> | null = null;
let books: Book[] = [];
let writes: Promise<unknown> = Promise.resolve();

function open(name = restoredState()?.database ?? DATABASE): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    let rejected = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('books', { keyPath: 'id' });
      db.createObjectStore('metadata');
    };
    request.onerror = () => reject(request.error ?? Error('本地书架无法打开'));
    request.onblocked = () => { rejected = true; reject(Error('本地书架正在被其他窗口占用，请关闭其他窗口后重试。')); };
    request.onsuccess = () => {
      const db = request.result;
      if (rejected) { db.close(); return; }
      db.onversionchange = () => { db.close(); if (database === db) database = null; };
      resolve(db);
    };
  });
}

function migrate(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    // The marker and all legacy books commit together. A restart after commit
    // must never re-import a stale legacy shelf over newer data or deletions.
    const tx = db.transaction(['books', 'metadata'], 'readwrite', { durability: 'strict' });
    let failure: unknown;
    const marker = tx.objectStore('metadata').get('legacy-migrated');
    marker.onsuccess = () => {
      if (marker.result === true) return;
      try {
        const raw = localStorage.getItem(LEGACY_KEY);
        const legacy: unknown = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(legacy) || legacy.some(book => !book || typeof book.id !== 'string' || !Array.isArray(book.chapters))) {
          throw Error('旧版书架资料格式无法识别，原资料已保留。');
        }
        for (const book of legacy) tx.objectStore('books').put(book);
        if (raw) tx.objectStore('metadata').put(raw, 'legacy-backup');
        tx.objectStore('metadata').put(legacy.map(book => book.id), 'book-order');
        tx.objectStore('metadata').put(true, 'legacy-migrated');
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.onabort = () => reject(failure ?? tx.error ?? Error('旧版书架迁移未完成，原资料已保留。'));
    tx.oncomplete = () => resolve();
  });
}

function readAll(db: IDBDatabase): Promise<Book[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['books', 'metadata'], 'readonly');
    const request = tx.objectStore('books').getAll();
    const order = tx.objectStore('metadata').get('book-order');
    tx.onabort = () => reject(tx.error ?? Error('本地书架读取失败'));
    tx.oncomplete = () => {
      const byId = new Map((request.result as Book[]).map(book => [book.id, book]));
      const result: Book[] = [];
      for (const id of Array.isArray(order.result) ? order.result : []) {
        const book = byId.get(id);
        if (book) { result.push(book); byId.delete(id); }
      }
      resolve([...result, ...byId.values()]);
    };
  });
}

export function initializeBooks(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    const db = await open();
    database = db;
    try {
      await migrate(db);
      const saved = restoredState()?.progress ?? JSON.parse(localStorage.getItem('tomato-reader-v01:progress') ?? '{}');
      const latest = Object.entries(saved).filter((entry): entry is [string, { chapterIndex: number; updatedAt: number }] => !!entry[1] && typeof entry[1] === 'object' && 'chapterIndex' in entry[1] && typeof entry[1].chapterIndex === 'number').sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))[0];
      if (latest) focusChapterCache(latest[0], latest[1].chapterIndex);
      books = limitChapterCache(await readAll(db));
      // Only retire the legacy copy after the transaction and subsequent read
      // succeeded. The transaction marker makes a leftover copy harmless.
      try { if (!restoredState()) localStorage.removeItem(LEGACY_KEY); } catch { /* New database remains authoritative. */ }
    } catch (error) { db.close(); database = null; throw error; }
  })().catch(error => { initialization = null; throw error; });
  return initialization;
}

export const savedBooks = () => books;

function change(additions: Book[], removeId?: string): Promise<Book[]> {
  const operation = writes.then(async () => {
    await initializeBooks();
    const db = database;
    if (!db) throw Error('本地书架连接已关闭，请重新启动后重试。');
    const merged = new Map(books.map(book => [book.id, book]));
    if (removeId !== undefined) merged.delete(removeId);
    for (const book of additions) merged.set(book.id, book);
    const next = limitChapterCache([...merged.values()]);
    const previous = new Map(books.map(book => [book.id, book]));
    const changed = next.filter(book => previous.get(book.id) !== book);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['books', 'metadata'], 'readwrite', { durability: 'strict' });
      tx.onabort = () => reject(tx.error ?? Error('书架保存失败，可能是可用空间不足。'));
      tx.oncomplete = () => resolve();
      try {
        const store = tx.objectStore('books');
        if (removeId !== undefined) store.delete(removeId);
        for (const book of changed) store.put(book);
        tx.objectStore('metadata').put(next.map(book => book.id), 'book-order');
      } catch (error) { tx.abort(); reject(error); }
    });
    // Neither the visible shelf nor the in-memory cache changes on failure.
    books = next;
    window.dispatchEvent(new CustomEvent('moyu-library-changed', { detail: 'books' }));
    return books;
  });
  writes = operation.catch(() => {});
  return operation;
}

export const addBooks = (additions: Book[]) => change(additions);
export const removeBook = (id: string) => change([], id);
export const whenBooksIdle = () => writes.then(() => {});

// Commit recovery into a NEW database, then let the caller atomically switch
// the single localStorage record holding its database/progress/preferences.
// The original database is never cleared or deleted, even if it cannot open.
export async function createRecoveredLibrary(additions: Book[]): Promise<string> {
  const name = `tomato-reader-library-recovery-${Date.now().toString(36)}-${crypto.randomUUID().replaceAll('-', '')}`;
  const db = await open(name);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['books', 'metadata'], 'readwrite', { durability: 'strict' });
      tx.onabort = () => reject(tx.error ?? Error('恢复书架写入失败，原资料未更改。'));
      tx.oncomplete = () => resolve();
      try {
        for (const book of additions) tx.objectStore('books').put(book);
        tx.objectStore('metadata').put(true, 'legacy-migrated');
        tx.objectStore('metadata').put(additions.map(book => book.id), 'book-order');
      } catch (error) { tx.abort(); reject(error); }
    });
    const restored = await readAll(db);
    if (restored.length !== additions.length || restored.some((book, i) => book.id !== additions[i].id)) throw Error('恢复后的书架核对失败，原资料未更改。');
    return name;
  } finally { db.close(); }
}
