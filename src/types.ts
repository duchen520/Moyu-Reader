export interface Chapter {
  id: string;
  title: string;
  content: string;
  loaded?: boolean;
  paragraphIds?: (number | null)[];
  itemVersion?: string;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  description: string;
  source: 'demo' | 'local' | 'official';
  coverStyle: number;
  coverUrl?: string;
  metadataWarning?: string;
  chapters: Chapter[];
  addedAt: number;
}

export interface ReadingProgress {
  chapterIndex: number;
  scrollRatio?: number;
  paragraphIndex?: number;
  updatedAt: number;
}

export type Theme = 'paper' | 'sepia' | 'night';

export interface Preferences {
  readingMode?: 'normal' | 'continuous';
  autoUploadProgress?: boolean;
  showParagraphComments?: boolean;
  theme: Theme;
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
}
