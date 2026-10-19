import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import type { Book, Chapter } from '../types';
import type { RankingCatalog, RankingPage } from '../data/rankings';
export interface OfficialUser { id: string; name: string }
export interface ShelfEntry { id: string; title: string; author: string; coverUrl?: string; lastReadItemId?: string | null; lastReadTitle?: string | null; progressState?: 'available' | 'missing' | 'failed' | 'loading' }
export interface ShelfSnapshot { entries: ShelfEntry[]; progressError?: string | null; metadataWarning?: string | null; partial?: boolean; total?: number }
export interface CloudProgress { book_id: string; item_id: string; read_timestamp: number }
export interface BookComment { id: string; name: string; text: string; likes: number; replies: number; userId?: string; createdAt?: number; images?: string[] }
export interface DetailedComment extends BookComment { images: string[]; children: DetailedComment[]; replyTo: string }
export interface CommentDetails { comment: DetailedComment; replies: DetailedComment[]; source: 'official-web' | 'official-app'; complete: boolean; hasMore?: boolean; nextCursor?: string; total?: number }
export interface SearchPage { books: (ShelfEntry & { description: string; score: string })[]; hasMore: boolean; nextOffset: number }
export interface AudioAlbum { id: string; name: string; narrator: string; kind: 'recorded' }
export interface AudioCatalog { albums: AudioAlbum[]; ttsTones: { id: string; name: string }[] }
export interface AudioEpisode { id: string; title: string }
export interface AudioAlignment { matched: boolean; chapterId: string; albumId: string; episodeId?: string; episodeIndex?: number; seconds?: number }
export interface AudioPlayInfo { itemId: string; urls: string[]; audioBase64?: string; mime?: string }
export interface CommentPage { total: number; hasMore: boolean; comments: BookComment[] }
export interface ParagraphCounts { chapterId: string; itemVersion: string; counts: Record<string, number> }
export interface ParagraphPage extends CommentPage { chapterId: string; paragraphId?: number; commentId?: string; nextCursor: string }
export interface QrTicket { imageDataUrl: string; expiresInSeconds: number }
export interface LoginPoll { stage: 'waiting' | 'scanned' | 'confirming' | 'authenticated' | 'expired'; user?: OfficialUser; warning?: string }
function call<T>(command: string, args?: Record<string, unknown>) {
  if (!isTauri()) return Promise.reject(new Error('官方接入需要 Windows 桌面模式，请运行 npm run tauri dev；浏览器预览只有本地阅读功能。'));
  return invoke<T>(command, args);
}
export const official = {
  rankingCategories: () => call<RankingCatalog>('official_ranking_categories'),
  rankings: (gender: number, mold: number, category: string, offset = 0, version = '') =>
    call<RankingPage>('official_rankings', { gender, mold, category, offset, version }),
  available: isTauri,
  account: () => call<OfficialUser | null>('official_account'),
  startLogin: () => call<QrTicket>('official_start_login'),
  pollLogin: () => call<LoginPoll>('official_poll_login'),
  cancelLogin: () => call<void>('official_cancel_login'),
  logout: () => call<void>('official_logout'),
  bookshelf: (onUpdate?: (snapshot: ShelfSnapshot) => void) => {
    const supported = typeof Reflect.get(window, '__TAURI_INTERNALS__')?.transformCallback === 'function';
    const updates = onUpdate && supported ? new Channel<ShelfSnapshot>(onUpdate) : undefined;
    return call<ShelfSnapshot>('official_bookshelf', updates ? { updates } : undefined);
  },
  book: (id: string) => call<Book>('official_book', { id }),
  chapter: (id: string) => call<Chapter>('official_chapter', { id }),
  readProgress: () => call<CloudProgress[]>('official_read_progress'),
  readHistory: (bookId: string) => call<string[]>('official_read_history', { bookId }),
  syncProgress: (bookId: string, itemId: string, index: number) => call<{ confirmed: boolean }>('official_sync_progress', { bookId, itemId, index }),
  search: (keyword: string, offset = 0) => call<SearchPage>('official_search', { keyword, offset }),
  commentDetails: (bookId: string, commentId: string, userId = '', cursor?: string) => call<CommentDetails>('official_comment_details', { bookId, commentId, userId, cursor }),
  audioCatalog: (bookId: string) => call<AudioCatalog>('official_audio_catalog', { bookId }),
  audioEpisodes: (albumId: string) => call<AudioEpisode[]>('official_audio_episodes', { albumId }),
  audioPlay: (itemId: string) => call<AudioPlayInfo>('official_audio_play', { itemId }),
  audioAlignment: (bookId: string, itemId: string, albumId: string) => call<AudioAlignment>('official_audio_alignment', { bookId, itemId, albumId }),
  paragraphCounts: (itemId: string, itemVersion = '') => call<ParagraphCounts>('official_paragraph_counts', { itemId, itemVersion }),
  paragraphComments: (bookId: string, itemId: string, paragraphId: number, itemVersion = '', cursor = '') => call<ParagraphPage>('official_paragraph_comments', { bookId, itemId, paragraphId, itemVersion, cursor }),
  paragraphReplies: (bookId: string, itemId: string, commentId: string, cursor = '') => call<ParagraphPage>('official_paragraph_replies', { bookId, itemId, commentId, cursor }),
  ttsPlay: (bookId: string, itemId: string, toneId: string) => call<AudioPlayInfo & { toneId: string }>('official_tts_play', { bookId, itemId, toneId }),
  comments: (id: string, page = 1) => call<CommentPage>('official_comments', { id, page }),
};
export function errorMessage(e: unknown) { return e instanceof Error ? e.message : String(e); }
export function parseBookId(input: string): string | null {
  const raw = input.trim();
  if (/^\d{5,24}$/.test(raw)) return raw;
  const match = raw.match(/\/page\/(\d{5,24})/);
  if (match) return match[1];
  try {
    const candidate = raw.startsWith('http') ? raw : `https://${raw}`;
    const u = new URL(candidate);
    if (['fanqienovel.com', 'www.fanqienovel.com'].includes(u.hostname)) {
      return u.pathname.match(/^\/page\/(\d{5,24})\/?$/)?.[1] ?? null;
    }
  } catch { /* invalid input */ }
  return null;
}
export function plainChapter(raw: Chapter): Chapter {
  // Never inject remote HTML into React. Render only text, excluding executable elements.
  const doc = new DOMParser().parseFromString(raw.content, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,svg').forEach(el => el.remove());
  doc.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
  const parts = [...doc.querySelectorAll('p,aside')].filter(el => !el.parentElement?.closest('p,aside')).map(el => {
    // Notes are readable text, but are not body paragraph IDs for comments.
    const value = el.tagName === 'P' ? el.getAttribute('idx') : null;
    return { text: el.textContent?.replace(/\s*\n\s*/g, ' ').trim() ?? '', id: value !== null && /^\d{1,6}$/.test(value) ? Number(value) : null };
  }).filter(p => p.text);
  if (parts.length) return { ...raw, content: parts.map(p => p.text).join('\n\n'), paragraphIds: parts.map(p => p.id), loaded: true };
  doc.querySelectorAll('p,div,br').forEach(el => el.append('\n\n'));
  return { ...raw, content: doc.body.textContent?.trim() ?? '', paragraphIds: [], loaded: true };
}
