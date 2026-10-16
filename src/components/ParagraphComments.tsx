import { useEffect, useMemo, useState } from 'react';
import type { Chapter } from '../types';
import { official, plainChapter, errorMessage } from '../lib/official';
import type { BookComment, ParagraphPage } from '../lib/official';
import { officialImage } from '../lib/media';

interface Bubble { id: number; count: number }
const cache = new Map<string, { at: number; ids: (number | null)[]; version: string; counts: Record<string, number> }>();
export function useParagraphBubbles(chapter: Chapter, enabled: boolean) {
  const [result, setResult] = useState<{ chapterId: string; ids: (number | null)[]; counts: Record<string, number>; version: string } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setResult(null); setError('');
    if (!enabled || !chapter.loaded || !chapter.content) return;
    let cancelled = false;
    const key = chapter.id + ':' + (chapter.itemVersion ?? '');
    const load = async () => {
      const old = cache.get(key);
      if (!attempt && old && Date.now() - old.at < 180000) return old;
      // Old saved chapters predate paragraph metadata. Verify their exact text
      // against the official HTML before reattaching any paragraph identifiers.
      let current = chapter;
      if (current.paragraphIds === undefined) {
        current = plainChapter(await official.chapter(chapter.id));
        const text = (s: string) => s.split(/\n\s*\n|\n/).map(p => p.replace(/\s/g, '')).filter(Boolean);
        if (JSON.stringify(text(current.content)) !== JSON.stringify(text(chapter.content))) throw Error('本章缓存正文与官方版本不同，暂不显示段评，以免对应错误。');
      }
      const ids = current.paragraphIds ?? [];
      if (!ids.some(id => id !== null)) return { ids, counts: {}, version: current.itemVersion ?? '' };
      const counts = await official.paragraphCounts(chapter.id, current.itemVersion);
      if (counts.chapterId !== chapter.id) throw Error('段评计数与当前章节不匹配');
      const entry = { at: Date.now(), ids, counts: counts.counts, version: counts.itemVersion || current.itemVersion || '' };
      if (cache.size > 100) cache.clear();
      cache.set(key, entry);
      return entry;
    };
    load().then(value => { if (!cancelled) setResult({ ...value, chapterId: chapter.id }); })
      .catch(e => { if (!cancelled) setError(errorMessage(e)); });
    return () => { cancelled = true; };
  }, [chapter.id, chapter.loaded, chapter.content, chapter.paragraphIds, chapter.itemVersion, enabled, attempt]);
  const bubbles = useMemo(() => {
    const output: Record<number, Bubble> = {};
    if (enabled && result?.chapterId === chapter.id) result.ids.forEach((id, index) => {
      const count = id === null ? 0 : result.counts[String(id)];
      if (id !== null && Number.isSafeInteger(count) && count > 0) output[index] = { id, count };
    });
    return output;
  }, [result, chapter.id, enabled]);
  return { bubbles, version: result?.chapterId === chapter.id ? result.version : '', error, retry: () => setAttempt(n => n + 1) };
}

export function ParagraphCommentsPanel({ bookId, chapterId, paragraphId, snippet, itemVersion, onClose }: {
  bookId: string; chapterId: string; paragraphId: number; snippet: string; itemVersion: string; onClose: () => void;
}) {
  const [data, setData] = useState<ParagraphPage | null>(null);
  const [cursor, setCursor] = useState('');
  const [selected, setSelected] = useState<BookComment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false; setBusy(true); setError('');
    const request = selected ? official.paragraphReplies(bookId, chapterId, selected.id, cursor)
      : official.paragraphComments(bookId, chapterId, paragraphId, itemVersion, cursor);
    request.then(page => {
      if (cancelled) return;
      if (page.chapterId !== chapterId || (selected ? page.commentId !== selected.id : page.paragraphId !== paragraphId)) throw Error('返回的评论与当前段落不一致');
      setData(previous => !cursor || !previous ? page : { ...page, comments: [...previous.comments, ...page.comments.filter(c => !previous.comments.some(old => old.id === c.id))] });
    }).catch(e => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [bookId, chapterId, paragraphId, itemVersion, selected?.id, cursor, attempt]);
  const change = (comment: BookComment | null) => { setSelected(comment); setCursor(''); setData(null); setError(''); };
  return <aside className="comments-panel paragraph-comments" aria-label="官方段评面板">
    <div className="settings-panel-top"><strong>{selected ? '段评回复' : '本段评论'} {data ? `· ${data.total}` : ''}</strong><button className="icon-button" aria-label="关闭段评" onClick={onClose}>×</button></div>
    <blockquote className="paragraph-quote">{snippet}</blockquote>
    {selected && <><button className="comment-detail-button" onClick={() => change(null)}>返回本段评论</button><article className="comment"><strong>{selected.name}</strong><p>{selected.text}</p></article></>}
    {error && <div className="paragraph-error" role="alert"><p>{error}</p><button className="comment-detail-button" onClick={() => setAttempt(n => n + 1)}>重试段评</button></div>}
    {!data && busy && <p role="status">正在读取{selected ? '段评回复' : '本段评论'}…</p>}
    {data?.comments.map(comment => <article key={comment.id} className="comment">
      <strong>{comment.name}</strong><p>{comment.text}</p>
      <div className="comment-images">{comment.images?.map((url, index) => { const safe = officialImage(url); return safe ? <img key={index} src={safe} alt="段评图片" loading="lazy" /> : null; })}</div>
      <small>点赞 {comment.likes} · 回复 {comment.replies}</small>
      {!selected && comment.replies > 0 && <button className="comment-detail-button" onClick={() => change(comment)}>查看段评回复</button>}
    </article>)}
    {data && !data.comments.length && <p className="small-note">官方本次没有返回{selected ? '回复' : '本段评论'}。</p>}
    {data?.hasMore && data.nextCursor && data.nextCursor !== cursor && <button className="comment-detail-button" disabled={busy} onClick={() => setCursor(data.nextCursor)}>{busy ? '正在加载…' : selected ? '加载更多段评回复' : '加载更多段评'}</button>}
    <p className="small-note">显示官方返回的评论。查看段评不会上传阅读进度。</p>
  </aside>;
}
