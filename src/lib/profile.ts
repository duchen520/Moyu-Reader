import type { Preferences, ReadingProgress } from '../types';

export const DEFAULT_PREFERENCES: Preferences = {
  readingMode: 'normal', theme: 'paper', fontSize: 19, lineHeight: 1.95, contentWidth: 760, autoUploadProgress: false,
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const range = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export function preferencesFrom(raw: unknown): Preferences {
  const p = object(raw) ? raw : {};
  return {
    ...DEFAULT_PREFERENCES,
    theme: ['paper', 'sepia', 'night'].includes(String(p.theme)) ? p.theme as Preferences['theme'] : DEFAULT_PREFERENCES.theme,
    fontSize: range(p.fontSize, 14, 30) ? p.fontSize : DEFAULT_PREFERENCES.fontSize,
    lineHeight: range(p.lineHeight, 1.4, 2.6) ? p.lineHeight : DEFAULT_PREFERENCES.lineHeight,
    contentWidth: range(p.contentWidth, 540, 980) ? p.contentWidth : DEFAULT_PREFERENCES.contentWidth,
    readingMode: p.readingMode === 'continuous' ? 'continuous' : 'normal',
    autoUploadProgress: p.autoUploadProgress === true,
    showParagraphComments: p.showParagraphComments !== false,
  };
}
export function validPreferences(raw: unknown): boolean {
  if (!object(raw)) return false;
  const clean = preferencesFrom(raw);
  return Object.keys(clean).every(key => raw[key] === undefined || raw[key] === clean[key as keyof Preferences]);
}
function validPosition(p: unknown): p is ReadingProgress {
  if (!object(p)) return false;
  return Number.isInteger(p.chapterIndex) && Number(p.chapterIndex) >= 0 && range(p.updatedAt, 0, Number.MAX_VALUE)
    && (p.scrollRatio === undefined || range(p.scrollRatio, 0, 1))
    && (p.paragraphIndex === undefined || (Number.isInteger(p.paragraphIndex) && Number(p.paragraphIndex) >= 0));
}
export function progressFrom(raw: unknown): Record<string, ReadingProgress> {
  return object(raw) ? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, ReadingProgress] => validPosition(entry[1]))) : {};
}
export const validProgress = (raw: unknown): boolean => object(raw) && Object.values(raw).every(validPosition);
