import { useEffect, useRef, useState } from 'react';
import { BookOpen, CheckCircle2, ExternalLink, Plus, RefreshCw, Sparkles, Star } from 'lucide-react';
import type { RankingBook, RankingCatalog, RankingPage } from '../data/rankings';
import { official, errorMessage } from '../lib/official';
import { OfficialCover } from './OfficialCover';
import { openOfficialWebsite } from '../lib/officialSite';

interface Props {
  onOpenBookId: (id: string, title?: string, coverUrl?: string) => Promise<void>;
  onAddBookToShelf: (book: { id: string; title: string; author: string; description: string; coverUrl?: string; coverStyle: number }) => void;
  isBookInShelf: (id: string) => boolean;
  notice: (msg: string) => void;
  busy: boolean;
}
const cache = new Map<string, RankingPage>();
function quantity(raw: string): string {
  if (!/^\d+$/.test(raw)) return '';
  const value = Number(raw);
  return value >= 10000 ? `${(value / 10000).toFixed(1).replace(/\.0$/, '')}万` : value.toLocaleString('zh-CN');
}
function selection(): { gender: number; mold: number; category: string } {
  try {
    const value = JSON.parse(sessionStorage.getItem('tomato-reader-rank-selection') ?? 'null');
    if (value && [0, 1].includes(value.gender) && [1, 2].includes(value.mold) && /^\d{1,8}$/.test(value.category)) return value;
  } catch { /* optional session preference */ }
  return { gender: 1, mold: 2, category: '257' };
}
function versionTime(version: string): string {
  const value = Number(version);
  if (!Number.isFinite(value) || value < 1000000000) return version;
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value * 1000);
}

export function LeaderboardView({ onOpenBookId, onAddBookToShelf, isBookInShelf, notice, busy }: Props) {
  const [filter, setFilter] = useState(selection);
  const [catalog, setCatalog] = useState<RankingCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [page, setPage] = useState<RankingPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [failedAppend, setFailedAppend] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const { gender, mold, category } = filter;
  const options = catalog?.[gender === 1 ? 'male' : 'female'] ?? [];
  const categoryName = options.find(c => c.id === category)?.name ?? '';
  const key = `${gender}_${mold}_${category}`;
  const sourceUrl = page?.sourceUrl ?? `https://fanqienovel.com/rank/${key}`;

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    setCatalogError('');
    official.rankingCategories().then(result => {
      if (cancelled) return;
      if (!result.male?.length || !result.female?.length) throw new Error('官方未返回可用分类');
      setCatalog(result);
      setFilter(old => {
        const items = result[old.gender === 1 ? 'male' : 'female'];
        return items.some(c => c.id === old.category) ? old : { ...old, category: items[0].id };
      });
    }).catch(e => { if (!cancelled) setCatalogError(errorMessage(e)); });
    return () => { cancelled = true; mounted.current = false; generation.current++; };
  }, [catalogAttempt]);

  const load = async (append = false, force = false) => {
    if (!catalog || (append && (inFlight.current || !page?.hasMore))) return;
    const ticket = ++generation.current;
    const previous = page;
    const cached = cache.get(key);
    if (!append && !force && cached && Date.now() - cached.fetchedAt < 180000) {
      inFlight.current = false; setPage(cached); setLoading(false); setError(''); return;
    }
    inFlight.current = true; setLoading(true); setError(''); setFailedAppend(append);
    try {
      const result = await official.rankings(gender, mold, category, append ? previous!.nextOffset : 0, append ? previous!.version : '');
      if (!mounted.current || ticket !== generation.current) return;
      if (!Array.isArray(result.books) || !result.version) throw new Error('榜单数据格式异常，请刷新重试');
      if (append && result.version !== previous?.version) throw new Error('官方榜单已更新，请刷新后重新加载');
      const next = { ...result, books: append ? [...new Map([...previous!.books, ...result.books].map(book => [book.id, book])).values()] : result.books };
      setPage(next); cache.set(key, next);
    } catch (e) {
      if (mounted.current && ticket === generation.current) setError(errorMessage(e));
    } finally {
      if (mounted.current && ticket === generation.current) { inFlight.current = false; setLoading(false); }
    }
  };

  useEffect(() => {
    if (!catalog) return;
    setPage(null); setError(''); inFlight.current = false;
    void load();
    try { sessionStorage.setItem('tomato-reader-rank-selection', JSON.stringify(filter)); } catch { /* optional */ }
    return () => { generation.current++; };
  }, [catalog, gender, mold, category]);

  const chooseGender = (next: number) => {
    if (next === gender || !catalog) return;
    generation.current++;
    setFilter({ ...filter, gender: next, category: catalog[next === 1 ? 'male' : 'female'][0].id });
  };
  const openWebsite = (url: string) => { void openOfficialWebsite(url).catch(e => notice(errorMessage(e))); };
  return <div className="leaderboard-screen">
    <div className="leaderboard-hero"><div className="leaderboard-hero-bg" /><div className="leaderboard-hero-content">
      <div className="hero-eyebrow"><Sparkles size={14} /><span>OFFICIAL ONLINE RANKINGS</span></div>
      <h1>官方排行榜</h1>
      <p className="hero-desc">在线获取番茄官网榜单。官方按日更新上一日的排名数据；可切换分类并继续加载更多作品。</p>
      <div className="ranking-tabs-bar" role="tablist" aria-label="榜单频道">
        {[{ id: 1, name: '男频榜' }, { id: 0, name: '女频榜' }].map(item => <button key={item.id} role="tab" aria-selected={gender === item.id}
          className={`ranking-tab-btn ${gender === item.id ? 'active' : ''}`} disabled={!catalog} onClick={() => chooseGender(item.id)}>{item.name}</button>)}
      </div>
    </div></div>
    <div className="leaderboard-body">
      <div className="online-rank-controls">
        <label>榜单 <select aria-label="榜单类型" value={mold} disabled={!catalog} onChange={e => setFilter({ ...filter, mold: Number(e.target.value) })}>
          <option value="2">阅读榜</option><option value="1">新书榜</option>
        </select></label>
        <label>分类 <select aria-label="榜单分类" value={category} disabled={!catalog} onChange={e => setFilter({ ...filter, category: e.target.value })}>
          {options.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <button className="secondary-action-btn" disabled={!catalog || loading} onClick={() => void load(false, true)}><RefreshCw size={14} className={loading ? 'spinning' : ''} />刷新榜单</button>
        <button className="tertiary-action-btn" onClick={() => openWebsite(sourceUrl)}><ExternalLink size={14} />查看官网榜单</button>
      </div>
      {catalogError ? <div className="ranking-status" role="alert"><p>分类读取失败：{catalogError}</p><button onClick={() => setCatalogAttempt(n => n + 1)}>重试读取分类</button></div>
        : !catalog && <p className="ranking-status" role="status">正在读取官方榜单分类…</p>}
      {page && <div className="leaderboard-section-header"><div><div className="section-title-row"><h2>{categoryName} · {mold === 2 ? '阅读榜' : '新书榜'}</h2>
        <span className="section-badge">已加载 {page.books.length} / {page.total} 本</span></div>
        <p className="section-subtitle">官方版本：{versionTime(page.version)}（北京时间） · 获取时间：{new Date(page.fetchedAt).toLocaleTimeString('zh-CN')}</p>
      </div></div>}
      {loading && <p className="ranking-status" role="status">{page ? '正在加载榜单，请稍候…' : '正在读取官方排名和作品资料，请稍候…'}</p>}
      {error && <div className="ranking-status" role="alert"><p>{error}{page ? '；已保留当前列表。' : ''}</p><button onClick={() => void load(failedAppend, !failedAppend)}>重试加载榜单</button></div>}
      {page?.warning && <p className="ranking-status" role="status">{page.warning}</p>}
      <div className="ranking-list">
        {page?.books.map((book: RankingBook) => {
          const inShelf = isBookInShelf(book.id);
          return <article key={book.id} className="ranking-card">
            <div className={`rank-number-box ${book.rank === 1 ? 'rank-badge-gold' : book.rank === 2 ? 'rank-badge-silver' : book.rank === 3 ? 'rank-badge-bronze' : 'rank-badge-normal'}`}>
              {book.rank <= 3 ? <span className="crown-label">{book.rank === 1 ? '👑 NO.1' : `TOP ${book.rank}`}</span> : <span className="plain-rank">{book.rank}</span>}
            </div>
            <div className={`ranking-cover cover-${book.rank % 5}`} onClick={() => void onOpenBookId(book.id, book.title, book.coverUrl)} title={`立即阅读《${book.title}》`}>
              <OfficialCover url={book.coverUrl} title={book.title} />
            </div>
            <div className="ranking-info"><div className="ranking-title-row"><h3 className="book-title-clickable" onClick={() => void onOpenBookId(book.id, book.title, book.coverUrl)}>{book.title}</h3></div>
              <div className="ranking-meta-row"><span className="meta-author">{book.author || '作者未返回'}</span><span>·</span><span>{book.category}</span><span>·</span><span>{book.status}</span>
                {quantity(book.wordCount) && <><span>·</span><span>{quantity(book.wordCount)}字</span></>}
              </div>
              <div className="ranking-metrics-row">{book.score && Number(book.score) > 0 && <div className="metric-score"><Star size={13} /><strong>{book.score}</strong><span>分</span></div>}
                {quantity(book.readCount) && <span className="metric-popularity">在读：{quantity(book.readCount)}</span>}
              </div>
              <p className="ranking-desc">{book.description || '官方暂未返回简介，可打开作品查看。'}</p>
            </div>
            <div className="ranking-actions">
              <button className="primary-action-btn" disabled={busy} onClick={() => void onOpenBookId(book.id, book.title, book.coverUrl)}><BookOpen size={15} /><span>立即阅读</span></button>
              <button className={`secondary-action-btn ${inShelf ? 'in-shelf' : ''}`} onClick={() => inShelf ? notice(`《${book.title}》已在书架中`) : onAddBookToShelf({ ...book, coverStyle: book.rank % 5 })}>
                {inShelf ? <CheckCircle2 size={14} /> : <Plus size={14} />}<span>{inShelf ? '已在书架' : '加入书架'}</span>
              </button>
              <button className="tertiary-action-btn" onClick={() => openWebsite(`https://fanqienovel.com/page/${book.id}`)}><ExternalLink size={13} /><span>官网主页</span></button>
            </div>
          </article>;
        })}
      </div>
      {page && !page.books.length && !loading && <p className="ranking-status">官方暂未返回该分类的上榜作品，可切换其他分类。</p>}
      {page?.hasMore && <div className="load-more-wrap"><button className="load-more-btn" disabled={loading} onClick={() => void load(true)}>加载更多榜单作品</button></div>}
      {page && !page.hasMore && page.books.length > 0 && <p className="ranking-status">已加载本榜全部可用作品，可切换其他分类继续找书。</p>}
    </div>
  </div>;
}
