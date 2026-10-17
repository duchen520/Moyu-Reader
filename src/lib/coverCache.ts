import { invoke, isTauri } from '@tauri-apps/api/core';
import { officialImage } from './media';
export interface CoverImage { dataUrl: string; cached: boolean; bytes: number }
const pending = new Map<string, { at: number; promise: Promise<CoverImage> }>();
export const coverCacheAvailable = () => isTauri() && typeof Reflect.get(window, '__TAURI_INTERNALS__')?.transformCallback === 'function';
export function cachedCover(raw: string, bookId?: string): Promise<CoverImage> {
  const safe = officialImage(raw);
  if ((raw && !safe) || (!safe && !/^\d{5,24}$/.test(bookId ?? ''))) return Promise.reject(Error('封面地址无效'));
  const url = safe ? new URL(safe) : null;
  if (url) {
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) if (['x-signature', 'x-expires'].includes(name.toLowerCase())) url.searchParams.delete(name);
  }
  const key = url ? (bookId ? `${bookId}:${url.href}` : url.href) : `book:${bookId}`;
  const old = pending.get(key);
  if (old && Date.now() - old.at < 300000) return old.promise;
  const promise = invoke<CoverImage>('official_cover', { url: safe ?? '', bookId }).then(image => {
    if (!/^data:image\/(?:png|jpeg|webp|gif);base64,/.test(image.dataUrl)) throw Error('封面响应无效');
    return image;
  }).catch(error => { if (pending.get(key)?.promise === promise) pending.delete(key); throw error; });
  pending.delete(key); pending.set(key, { at: Date.now(), promise });
  while (pending.size > 256) pending.delete(pending.keys().next().value!);
  return promise;
}
