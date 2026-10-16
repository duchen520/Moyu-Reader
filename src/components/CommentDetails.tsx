import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { official, errorMessage } from '../lib/official';
import type { BookComment, CommentDetails, DetailedComment } from '../lib/official';
import { officialImage } from '../lib/media';
export function CommentDetailView({ bookId, comment, onClose }: { bookId: string; comment: BookComment; onClose: () => void }) {
  const [details, setDetails] = useState<CommentDetails | null>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    let cancelled = false; generation.current++; setDetails(null); setError(''); setMoreBusy(false);
    official.commentDetails(bookId, comment.id, comment.userId).then(data => { if (!cancelled) setDetails(data); }).catch(e => { if (!cancelled) setError(errorMessage(e)); });
    return () => { cancelled = true; generation.current++; };
  }, [bookId, comment.id, attempt]);
  useEffect(() => {
    if (!preview) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPreview(null); } };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [preview]);
  const more = async () => {
    if (!details?.hasMore || !details.nextCursor || moreBusy) return;
    const gen = generation.current; setMoreBusy(true); setError('');
    try {
      const next = await official.commentDetails(bookId, comment.id, comment.userId, details.nextCursor);
      if (gen !== generation.current) return;
      setDetails(old => old ? { ...next, replies: [...new Map([...old.replies, ...next.replies].map(r => [r.id, r])).values()] } : next);
    } catch (e) { if (gen === generation.current) setError(errorMessage(e)); }
    finally { if (gen === generation.current) setMoreBusy(false); }
  };
  const render = (item: DetailedComment, depth = 0): ReactNode => <article className={depth ? 'comment comment-reply' : 'comment'} key={item.id}>
    <strong>{item.name}{item.replyTo && <span className="reply-to"> 回复 {item.replyTo}</span>}</strong><p>{item.text}</p>
    <div className="comment-images">{(item.images ?? []).map(officialImage).filter((u): u is string => !!u).map((u, i) => <button key={u} aria-label={`查看评论图片 ${i+1}`} onClick={() => setPreview(u)}><img src={u} alt={`评论附图 ${i+1}`} loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.alt = '图片加载失败'; }}/></button>)}</div>
    <small>点赞 {item.likes} · 回复 {item.replies}</small>
    {depth < 3 && (item.children ?? []).map(c => render(c, depth + 1))}
  </article>;
  return <div className="comment-details">
    <button className="outline-button" onClick={onClose}>返回书评列表</button>
    {error && <div role="alert"><p>{error}</p>{!details && <button onClick={() => setAttempt(n => n+1)}>重试详情</button>}</div>}
    {!details && !error ? <p role="status">正在读取官方评论详情…</p> : details && <>
      {render(details.comment)}<h3>官方可见回复 · {details.replies.length}</h3>
      {details.replies.map(item => render(item, 1))}
      {!details.replies.length && <p className="comment-empty">官方本次没有返回可见回复。</p>}
      {details.hasMore && <button disabled={moreBusy} onClick={() => void more()}>{moreBusy ? '正在加载…' : '加载更多回复'}</button>}
      <p className="small-note">按官方实际返回展示。统计可能包含不可见或已删除内容，二级回复完整分页尚未接入。</p>
    </>}
    {preview && <div className="image-preview" role="dialog" aria-label="评论图片预览" onClick={() => setPreview(null)}><button aria-label="关闭图片预览" onClick={() => setPreview(null)}>×</button><img src={preview} alt="评论图片大图" onClick={e => e.stopPropagation()} referrerPolicy="no-referrer"/></div>}
  </div>;
}
