import type { Preferences, ReadingProgress } from '../types';
import { initializeBooks, savedBooks, addBooks, removeBook, whenBooksIdle } from './bookDatabase';
import { restoredState, RESTORED_STATE_KEY } from './restoredState';

const PREFIX = 'tomato-reader-v01:';
export const DEFAULT_PREFERENCES: Preferences = {
  readingMode: 'normal', theme: 'paper', fontSize: 19, lineHeight: 1.95, contentWidth: 760, autoUploadProgress: false,
};

function read<T>(key: string, fallback: T): T {
  try {
    const restored = restoredState();
    if (restored && (key === 'progress' || key === 'preferences')) return restored[key] as T;
    const stored = localStorage.getItem(PREFIX + key);
    return stored ? JSON.parse(stored) as T : fallback;
  } catch {
    return fallback;
  }
}

function write<T>(key: string, value: T) {
  // Deliberately do not swallow quota errors: the UI must report failed saves.
  const restored = restoredState();
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
  progress: () => read<Record<string, ReadingProgress>>('progress', {}),
  saveProgress: (value: Record<string, ReadingProgress>) => write('progress', value),
  preferences: () => read<Preferences>('preferences', DEFAULT_PREFERENCES),
  savePreferences: (value: Preferences) => write('preferences', value),
};
