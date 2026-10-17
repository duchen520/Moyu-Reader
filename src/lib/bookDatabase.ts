import type { Book } from '../types';

const DATABASE = 'tomato-reader-library';
const LEGACY_KEY = 'tomato-reader-v01:books';
let database: IDBDatabase | null = null;
let initialization: Promise<void> | null = null;
let books: Book[] = [];
let writes: Promise<unknown> = Promise.resolve();

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
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
      books = await readAll(db);
      // Only retire the legacy copy after the transaction and subsequent read
      // succeeded. The transaction marker makes a leftover copy harmless.
      try { localStorage.removeItem(LEGACY_KEY); } catch { /* New database remains authoritative. */ }
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
    const next = [...merged.values()];
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['books', 'metadata'], 'readwrite', { durability: 'strict' });
      tx.onabort = () => reject(tx.error ?? Error('书架保存失败，可能是可用空间不足。'));
      tx.oncomplete = () => resolve();
      try {
        const store = tx.objectStore('books');
        if (removeId !== undefined) store.delete(removeId);
        for (const book of additions) store.put(book);
        tx.objectStore('metadata').put(next.map(book => book.id), 'book-order');
      } catch (error) { tx.abort(); reject(error); }
    });
    // Neither the visible shelf nor the in-memory cache changes on failure.
    books = next;
    return books;
  });
  writes = operation.catch(() => {});
  return operation;
}

export const addBooks = (additions: Book[]) => change(additions);
export const removeBook = (id: string) => change([], id);
