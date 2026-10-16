export function officialImage(raw: string): string | null {
  try {
    const u = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const domains = ['byteimg.com', 'toutiaoimg.com', 'fqnovelstatic.com', 'fqnovelpic.com', 'bytescm.com', 'bytecdn.cn'];
    return domains.some(d => u.hostname === d || u.hostname.endsWith(`.${d}`)) ? u.href : null;
  } catch { return null; }
}
export function playableUrl(raw: string): string | null {
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
export interface AudioProgress { albumId: string; episodeId: string; seconds: number; updatedAt: number }
const PREFIX = 'tomato-reader-v03:audio:';
export function readAudioProgress(bookId: string): AudioProgress | null {
  try {
    const v = JSON.parse(localStorage.getItem(PREFIX + bookId) ?? 'null');
    if (!v || typeof v.albumId !== 'string' || typeof v.episodeId !== 'string' || typeof v.seconds !== 'number' || !Number.isFinite(v.seconds) || v.seconds < 0) return null;
    return v;
  } catch { return null; }
}
export function saveAudioProgress(bookId: string, value: AudioProgress) { localStorage.setItem(PREFIX + bookId, JSON.stringify(value)); }
