import type { Preferences, ReadingProgress } from '../types';
import { initializeBooks, savedBooks, addBooks, removeBook } from './bookDatabase';

const PREFIX = 'tomato-reader-v01:';
export const DEFAULT_PREFERENCES: Preferences = {
  readingMode: 'normal', theme: 'paper', fontSize: 19, lineHeight: 1.95, contentWidth: 760, autoUploadProgress: false,
};

function read<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(PREFIX + key);
    return stored ? JSON.parse(stored) as T : fallback;
  } catch {
    return fallback;
  }
}

function write<T>(key: string, value: T) {
  // Deliberately do not swallow quota errors: the UI must report failed saves.
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
}

export const storage = {
  initializeBooks,
  books: savedBooks,
  addBooks,
  removeBook,
  progress: () => read<Record<string, ReadingProgress>>('progress', {}),
  saveProgress: (value: Record<string, ReadingProgress>) => write('progress', value),
  preferences: () => read<Preferences>('preferences', DEFAULT_PREFERENCES),
  savePreferences: (value: Preferences) => write('preferences', value),
};
