import type { Preferences, ReadingProgress } from '../types';
import { initializeBooks, savedBooks, addBooks, removeBook, whenBooksIdle, cacheChapter } from './bookDatabase';
import { restoredState, RESTORED_STATE_KEY } from './restoredState';
import { DEFAULT_PREFERENCES, preferencesFrom, progressFrom, validPreferences, validProgress } from './profile';
export { DEFAULT_PREFERENCES } from './profile';

const PREFIX = 'tomato-reader-v01:';
const profileValid = (key: string, value: unknown) => key === 'preferences' ? validPreferences(value) : validProgress(value);
const profileValue = (key: string, value: unknown) => key === 'preferences' ? preferencesFrom(value) : progressFrom(value);
function profileHealthy(): boolean {
  try {
    const restored = restoredState();
    return ['preferences', 'progress'].every(key => {
      const raw = localStorage.getItem(PREFIX + key);
      return restored ? profileValid(key, restored[key as 'preferences' | 'progress']) : !raw || profileValid(key, JSON.parse(raw));
    });
  } catch { return false; }
}

function read<T>(key: string, fallback: T): T {
  try {
    const restored = restoredState();
    if (restored && (key === 'progress' || key === 'preferences')) return profileValue(key, restored[key]) as T;
    const stored = localStorage.getItem(PREFIX + key);
    return stored ? profileValue(key, JSON.parse(stored)) as T : fallback;
  } catch {
    return fallback;
  }
}

function write<T>(key: string, value: T) {
  // Deliberately do not swallow quota errors: the UI must report failed saves.
  const restored = restoredState();
  const originalKey = restored ? RESTORED_STATE_KEY : PREFIX + key;
  const original = localStorage.getItem(originalKey);
  if (original) {
    let valid = false;
    try { valid = profileValid(key, restored ? restored[key as 'preferences' | 'progress'] : JSON.parse(original)); } catch { /* Preserve malformed JSON too. */ }
    if (!valid) {
      // If this protective copy fails, leave the original selected record alone.
      localStorage.setItem(`${PREFIX}recovered-${key}:${crypto.randomUUID()}`, original);
    }
  }
  if (restored && (key === 'progress' || key === 'preferences')) localStorage.setItem(RESTORED_STATE_KEY, JSON.stringify({ ...restored, [key]: value }));
  else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent('moyu-library-changed', { detail: key }));
}

export const storage = {
  initializeBooks,
  books: savedBooks,
  addBooks,
  removeBook,
  whenBooksIdle,
  cacheChapter,
  profileHealthy,
  profileWarning: () => profileHealthy() ? '' : '部分设置或进度格式异常，已采用可用值。原记录仍保留；重新保存前会另存原记录。',
  progress: () => read<Record<string, ReadingProgress>>('progress', {}),
  saveProgress: (value: Record<string, ReadingProgress>) => write('progress', value),
  preferences: () => read<Preferences>('preferences', DEFAULT_PREFERENCES),
  savePreferences: (value: Preferences) => write('preferences', value),
};
