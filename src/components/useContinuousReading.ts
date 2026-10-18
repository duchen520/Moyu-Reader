import { useLayoutEffect, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Book, Preferences, ReadingProgress } from '../types';
import { readingParagraph } from '../lib/readerPosition';

// A moving five-chapter window keeps both directions available without growing
// the DOM with the length of a book. Re-anchor the same section after trimming.
export function useContinuousReading({ enabled, book, index, prefs, canvas, initialProgress, onVisible, loadChapter }: {
  enabled: boolean; book: Book; index: number; prefs: Preferences;
  canvas: RefObject<HTMLElement | null>; initialProgress?: ReadingProgress;
  onVisible: (index: number) => void; loadChapter: (index: number) => Promise<void>;
}) {
  const [center, setCenter] = useState(index);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [attempt, setAttempt] = useState(0);
  const [jumpVersion, setJumpVersion] = useState(0);
  const sections = useRef(new Map<number, HTMLElement>());
  const visible = useRef(index);
  const ready = useRef(false);
  const anchor = useRef<{ index: number; offset: number } | null>(null);
  const pendingJump = useRef<{ index: number; ratio: number } | null>({ index, ratio: initialProgress?.chapterIndex === index ? initialProgress.scrollRatio ?? 0 : 0 });
  const context = useRef({ book, index, onVisible, loadChapter });
  context.current = { book, index, onVisible, loadChapter };
  const first = Math.max(0, center - 2), last = Math.min(book.chapters.length - 1, center + 2);
  const indices = Array.from({ length: last - first + 1 }, (_, n) => first + n);

  const rememberAnchor = () => {
    const el = canvas.current, section = sections.current.get(visible.current);
    if (el && section) anchor.current = { index: visible.current, offset: section.getBoundingClientRect().top - el.getBoundingClientRect().top };
  };
  const position = () => {
    const el = canvas.current, section = sections.current.get(visible.current);
    const chapter = context.current.book.chapters[visible.current];
    if (!enabled || !ready.current || !el || !section || !chapter?.content || (context.current.book.source === 'official' && !chapter.loaded)) return null;
    const top = el.getBoundingClientRect().top;
    return { index: visible.current,
      ratio: Math.max(0, Math.min(1, (top - section.getBoundingClientRect().top) / Math.max(1, section.offsetHeight - el.clientHeight))),
      paragraph: readingParagraph(Array.from(section.querySelectorAll<HTMLParagraphElement>('.story-content p')), top) };
  };
  const onScroll = () => {
    if (!enabled || !ready.current || pendingJump.current || !canvas.current) return;
    const top = canvas.current.getBoundingClientRect().top + 60;
    let current = first;
    for (const i of indices) {
      const el = sections.current.get(i);
      if (el && el.getBoundingClientRect().top <= top) current = i;
    }
    if (current !== visible.current) {
      visible.current = current;
      rememberAnchor();
      setCenter(current);
      context.current.onVisible(current);
    } else rememberAnchor();
  };

  // A parent index change is either our visible-chapter notification or an
  // explicit jump from the directory/keyboard/cloud/voice player.
  useLayoutEffect(() => {
    if (!enabled) { ready.current = false; return; }
    if (!ready.current || index !== visible.current) {
      if (index !== visible.current || !pendingJump.current) pendingJump.current = { index, ratio: !ready.current && initialProgress?.chapterIndex === index ? initialProgress.scrollRatio ?? 0 : 0 };
      visible.current = index; ready.current = true; anchor.current = null;
      setCenter(index);
    }
  }, [enabled, index, book.id]);

  const layoutKey = indices.map(i => `${i}:${book.chapters[i].content.length}`).join('|');
  useLayoutEffect(() => {
    if (!enabled || !canvas.current) return;
    const el = canvas.current, target = pendingJump.current;
    if (target) {
      const section = sections.current.get(target.index);
      if (!section) return;
      el.scrollTop += section.getBoundingClientRect().top - el.getBoundingClientRect().top
        + target.ratio * Math.max(0, section.offsetHeight - el.clientHeight);
      // Keep a restored ratio pending until the requested official text exists.
      if (book.chapters[target.index]?.content) pendingJump.current = null;
    } else if (anchor.current) {
      const section = sections.current.get(anchor.current.index);
      if (section) el.scrollTop += section.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.current.offset;
    }
    rememberAnchor();
  }, [enabled, center, index, layoutKey, jumpVersion, prefs.fontSize, prefs.lineHeight, prefs.contentWidth]);

  useEffect(() => {
    if (!enabled || book.source !== 'official') return;
    let cancelled = false;
    // Current first, then the immediate neighbours, then the second neighbours.
    const queue = [center, center + 1, center - 1, center + 2, center - 2]
      .filter(i => i >= 0 && i < book.chapters.length && !book.chapters[i].loaded);
    const run = async () => {
      while (!cancelled && queue.length) {
        const i = queue.shift()!;
        try {
          await context.current.loadChapter(i);
          if (!cancelled) setErrors(old => { const next = { ...old }; delete next[i]; return next; });
        } catch (error) {
          if (!cancelled) setErrors(old => ({ ...old, [i]: error instanceof Error ? error.message : String(error) }));
        }
      }
    };
    void run(); void run();
    return () => { cancelled = true; };
  }, [enabled, book.id, center, attempt]);

  return { enabled, indices, sections, position, onScroll, errors,
    jump: (i: number) => { pendingJump.current = { index: i, ratio: 0 }; visible.current = i; anchor.current = null; setCenter(i); setJumpVersion(n => n + 1); },
    retry: (i: number) => { setErrors(old => { const next = { ...old }; delete next[i]; return next; }); setAttempt(n => n + 1); } };
}
