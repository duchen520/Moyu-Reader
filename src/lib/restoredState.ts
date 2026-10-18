import type { Preferences, ReadingProgress } from '../types';
export const RESTORED_STATE_KEY = 'tomato-reader-v01:restored-state';
export interface RestoredState { database: string; preferences: Preferences; progress: Record<string, ReadingProgress> }
export function restoredState(): RestoredState | null {
  const raw = localStorage.getItem(RESTORED_STATE_KEY);
  if (!raw) return null;
  const value = JSON.parse(raw) as RestoredState;
  if (!value || !/^tomato-reader-library-recovery-[a-z0-9-]+$/.test(value.database) || !value.preferences || typeof value.preferences !== 'object' || !value.progress || typeof value.progress !== 'object') throw Error('恢复资料索引无法读取，原资料已保留。');
  return value;
}
