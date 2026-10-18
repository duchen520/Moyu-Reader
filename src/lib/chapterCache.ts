import type { Book } from '../types';

export const CHAPTER_CACHE_LIMIT = 24;
export const CHAPTER_CACHE_BYTES = 8 * 1024 * 1024;
const recent = new Map<string, number>();
let clock = 0;
let focus: { bookId: string; index: number } | null = null;
const key = (bookId: string, chapterId: string) => `${bookId}:${chapterId}`;
export function focusChapterCache(bookId: string | null, index: number) {
  focus = bookId ? { bookId, index } : null;
}
export function touchChapterCache(bookId: string, chapterId: string) {
  recent.set(key(bookId, chapterId), ++clock);
}
export function limitChapterCache(books: Book[]): Book[] {
  const candidates = books.flatMap(book => book.source !== 'official' ? [] : book.chapters.flatMap((chapter, index) => chapter.content ? [{
    key: key(book.id, chapter.id), pinned: focus?.bookId === book.id && Math.abs(focus.index - index) <= 2,
    bytes: chapter.content.length * 2 + (chapter.paragraphIds?.length ?? 0) * 8,
  }] : []));
  candidates.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (recent.get(b.key) ?? 0) - (recent.get(a.key) ?? 0));
  const keep = new Set<string>(); let bytes = 0;
  for (const item of candidates) {
    // Keep the current five-chapter reading window even for an unusually long
    // official chapter. All other bodies obey both the byte and count limits.
    if (item.pinned || (keep.size < CHAPTER_CACHE_LIMIT && bytes + item.bytes <= CHAPTER_CACHE_BYTES)) { keep.add(item.key); bytes += item.bytes; }
  }
  for (const id of recent.keys()) if (!keep.has(id)) recent.delete(id);
  return books.map(book => {
    if (book.source !== 'official') return book;
    let changed = false;
    const chapters = book.chapters.map(chapter => {
      if (!chapter.content || keep.has(key(book.id, chapter.id))) return chapter;
      changed = true;
      return { ...chapter, content: '', loaded: false, paragraphIds: undefined, itemVersion: undefined };
    });
    return changed ? { ...book, chapters } : book;
  });
}
