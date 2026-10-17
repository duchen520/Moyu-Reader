import { useState, useRef, useEffect } from 'react';
import { Search, Compass, Sparkles, BookOpen, Plus, CheckCircle2, ArrowRight, ExternalLink, Link2, Filter, Loader2, Tag } from 'lucide-react';
import { GENRES, HOT_KEYWORDS } from '../data/categories';
import { official, errorMessage, parseBookId } from '../lib/official';
import type { SearchPage, ShelfEntry } from '../lib/official';
import { OfficialCover } from './OfficialCover';
import { openOfficialWebsite } from '../lib/officialSite';

interface DiscoveryViewProps {
  onOpenBookId: (id: string, title?: string, coverUrl?: string) => Promise<void>;
  onAddBookToShelf: (book: { id: string; title: string; author: string; description: string; coverUrl?: string; coverStyle: number }) => void;
  isBookInShelf: (id: string) => boolean;
  notice: (msg: string) => void;
  busy: boolean;
}

export function DiscoveryView({ onOpenBookId, onAddBookToShelf, isBookInShelf, notice, busy }: DiscoveryViewProps) {
  const [searchInput, setSearchInput] = useState('');
  const [searchResult, setSearchResult] = useState<SearchPage | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [activeGenreId, setActiveGenreId] = useState('all');
  const [linkInput, setLinkInput] = useState('');
  const [showIdOpener, setShowIdOpener] = useState(false);

  const searchGeneration = useRef(0);
  const submittedSearch = useRef('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      searchGeneration.current++;
    };
  }, []);

  const doSearch = async (queryText: string, append = false) => {
    const query = queryText.trim();
    if (!query) {
      setSearchError('请输入书名、作者或关键词');
      return;
    }
    const gen = ++searchGeneration.current;
    setSearchBusy(true);
    setSearchError('');
    if (!append) {
      submittedSearch.current = query;
      setSearchResult(null);
    }

    try {
      const next = await official.search(query, append ? searchResult?.nextOffset ?? 0 : 0);
      if (!mounted.current || gen !== searchGeneration.current) return;
      setSearchResult(old => ({
        ...next,
        books: [...new Map([...(append ? old?.books ?? [] : []), ...next.books].map(b => [b.id, b])).values()],
      }));
    } catch (e) {
      if (mounted.current && gen === searchGeneration.current) {
        setSearchError(errorMessage(e));
      }
    } finally {
      if (mounted.current && gen === searchGeneration.current) {
        setSearchBusy(false);
      }
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void doSearch(searchInput);
  };

  const handleChipClick = (keyword: string) => {
    setSearchInput(keyword);
    void doSearch(keyword);
  };

  const handleOpenLink = (e: React.FormEvent) => {
    e.preventDefault();
    const id = parseBookId(linkInput);
    if (id) {
      void onOpenBookId(id);
    } else {
      notice('请输入有效的番茄官方小说链接（/page/书籍ID）或纯数字书籍ID。');
    }
  };

  const clearSearch = () => {
    searchGeneration.current++;
    setSearchBusy(false);
    setSearchInput('');
    setSearchResult(null);
    submittedSearch.current = '';
    setSearchError('');
  };

  const currentGenre = GENRES.find(g => g.id === activeGenreId) ?? GENRES[0];

  return (
    <div className="discovery-screen">
      {/* Header Banner */}
      <div className="discovery-hero">
        <div className="discovery-hero-bg" />
        <div className="discovery-hero-content">
          <div className="hero-eyebrow">
            <Compass size={14} className="hero-sparkle" />
            <span>FIND & EXPLORE BOOKS</span>
          </div>
          <h1>找书发现 · 海量正版书库</h1>
          <p className="hero-desc">
            全网检索番茄官方书库，实时在线阅读与加入书架；支持关键词搜索、分类筛选以及链接直达。
          </p>

          {/* Main Search Input Form */}
          <form className="discovery-search-bar" onSubmit={handleSearchSubmit}>
            <div className="search-input-wrapper">
              <Search size={18} className="search-input-icon" />
              <label htmlFor="official-search" className="sr-only">搜索正版小说</label>
              <input
                id="official-search"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                maxLength={100}
                placeholder="搜索全网书名、作者或题材标签（如：十日终焉、斩神、末日、克苏鲁）..."
                aria-label="搜索正版小说"
              />
              {searchInput && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={clearSearch}
                  title="清空输入"
                >
                  ✕
                </button>
              )}
            </div>
            <button
              type="submit"
              className="search-submit-btn"
              disabled={searchBusy}
            >
              {searchBusy ? <Loader2 size={16} className="spinning" /> : <Search size={16} />}
              <span>搜索小说</span>
            </button>
          </form>

          {/* Hot Keyword Chips */}
          <div className="hot-keywords-bar">
            <span className="hot-label">
              <Sparkles size={13} />
              <span>大家都在搜：</span>
            </span>
            <div className="hot-chips-list">
              {HOT_KEYWORDS.map(kw => (
                <button
                  key={kw}
                  type="button"
                  className="hot-chip"
                  onClick={() => handleChipClick(kw)}
                >
                  {kw}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Direct Link Tool Bar */}
      <div className="discovery-toolbar">
        <button
          type="button"
          className="toggle-link-btn"
          onClick={() => setShowIdOpener(v => !v)}
        >
          <Link2 size={15} />
          <span>{showIdOpener ? '收起链接/ID直达' : '通过番茄链接或书籍ID直接打开作品'}</span>
        </button>

        {showIdOpener && (
          <form className="direct-link-form" onSubmit={handleOpenLink}>
            <label htmlFor="official-book" className="sr-only">打开正版作品</label>
            <input
              id="official-book"
              value={linkInput}
              onChange={e => setLinkInput(e.target.value)}
              placeholder="粘贴番茄作品链接（如：https://fanqienovel.com/page/7167812543419993100）或纯数字书籍 ID"
              aria-label="打开正版作品"
            />
            <button type="submit" disabled={busy}>
              打开作品
            </button>
          </form>
        )}
      </div>

      {/* Search Status & Errors */}
      {searchBusy && (
        <div className="discovery-status-box" role="status">
          <Loader2 size={18} className="spinning" />
          <span>正在搜索番茄官方云端书库，请稍候…</span>
        </div>
      )}
      {searchError && (
        <div className="discovery-error-box" role="alert">
          <span>{searchError}</span>
        </div>
      )}

      {/* Search Results Display */}
      {searchResult && (
        <div className="official-search-results">
          <div className="results-header">
            <div>
              <h2>搜索结果 · “{submittedSearch.current}”</h2>
              <span className="results-count">找到 {searchResult.books.length} 本相关作品</span>
            </div>
            <button className="clear-results-btn" onClick={clearSearch}>
              返回分类探索
            </button>
          </div>

          {!searchResult.books.length && (
            <div className="no-results-box">
              <Search size={32} />
              <p>官方书库没有返回匹配作品，尝试更换关键词再试。</p>
            </div>
          )}

          <div className="search-books-grid">
            {searchResult.books.map(b => {
              const inShelf = isBookInShelf(b.id);
              return (
                <article key={b.id} className="search-book-card">
                  <div
                    className="search-book-cover-wrap"
                    onClick={() => void onOpenBookId(b.id, b.title, b.coverUrl)}
                  >
                    <OfficialCover bookId={b.id} url={b.coverUrl} title={b.title} />
                  </div>

                  <div className="search-book-details">
                    <div className="search-book-top">
                      <strong
                        className="search-book-title"
                        onClick={() => void onOpenBookId(b.id, b.title, b.coverUrl)}
                      >
                        {b.title}
                      </strong>
                      <small className="search-book-author">
                        {b.author}
                        {b.score ? ` · 评分 ${b.score}` : ''}
                      </small>
                    </div>

                    <p className="search-book-abstract">{b.description || '暂无作品简介。'}</p>

                    <div className="search-card-actions">
                      <button
                        className="search-open-btn"
                        disabled={busy}
                        onClick={() => void onOpenBookId(b.id, b.title, b.coverUrl)}
                      >
                        <BookOpen size={14} />
                        <span>打开作品</span>
                      </button>

                      <button
                        className={`search-shelf-btn ${inShelf ? 'in-shelf' : ''}`}
                        onClick={() => {
                          if (inShelf) {
                            notice(`《${b.title}》已在书架中`);
                          } else {
                            onAddBookToShelf({
                              id: b.id,
                              title: b.title,
                              author: b.author,
                              description: b.description,
                              coverUrl: b.coverUrl,
                              coverStyle: Math.floor(Math.random() * 5),
                            });
                          }
                        }}
                      >
                        {inShelf ? <CheckCircle2 size={13} /> : <Plus size={13} />}
                        <span>{inShelf ? '已在书架' : '加入书架'}</span>
                      </button>

                      <button
                        className="search-link-btn"
                        onClick={() => void openOfficialWebsite(`https://fanqienovel.com/page/${b.id}`).catch(e => notice(String(e)))}
                        title="在浏览器中查看番茄官网"
                      >
                        <ExternalLink size={13} />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {searchResult.hasMore && (
            <div className="load-more-wrap">
              <button
                className="load-more-btn"
                disabled={searchBusy}
                onClick={() => void doSearch(submittedSearch.current, true)}
              >
                {searchBusy ? <Loader2 size={15} className="spinning" /> : <ArrowRight size={15} />}
                <span>加载更多搜索结果</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Discovery Default View (Categories & Featured Novels) */}
      {!searchResult && (
        <div className="discovery-explore-body">
          {/* Genre Category Pills */}
          <div className="genre-nav-section">
            <div className="genre-section-title">
              <Filter size={16} />
              <h3>题材分类浏览</h3>
            </div>
            <div className="genre-pills-row">
              {GENRES.map(g => (
                <button
                  key={g.id}
                  className={`genre-pill ${activeGenreId === g.id ? 'active' : ''}`}
                  onClick={() => setActiveGenreId(g.id)}
                >
                  <span>{g.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Curated Recommendations for Current Genre */}
          <div className="genre-recommendations">
            <div className="genre-header">
              <div>
                <h2>{currentGenre.name} · 精选推荐</h2>
                <p className="genre-desc">{currentGenre.desc}</p>
              </div>
            </div>

            <div className="recommendations-grid">
              {(activeGenreId === 'all'
                ? GENRES.flatMap(g => g.sampleBooks).slice(0, 8)
                : currentGenre.sampleBooks
              ).map(book => {
                const inShelf = isBookInShelf(book.id);
                return (
                  <article key={book.id} className="rec-card">
                    <div
                      className={`rec-cover cover-${book.coverStyle % 5}`}
                      onClick={() => void onOpenBookId(book.id, book.title)}
                    >
                      <span className="rec-cover-badge">{book.score} 分</span>
                      <OfficialCover bookId={book.id} title={book.title} />
                    </div>

                    <div className="rec-info">
                      <div className="rec-top-row">
                        <h4
                          className="rec-title"
                          onClick={() => void onOpenBookId(book.id, book.title)}
                        >
                          {book.title}
                        </h4>
                      </div>

                      <div className="rec-meta">
                        <span>{book.author}</span>
                        <span>·</span>
                        <span className={`status-pill ${book.status === '已完结' ? 'finished' : 'ongoing'}`}>
                          {book.status}
                        </span>
                      </div>

                      <p className="rec-abstract">{book.description}</p>

                      <div className="rec-tags">
                        {book.tags.map(t => (
                          <span key={t} className="rec-tag-chip">#{t}</span>
                        ))}
                      </div>

                      <div className="rec-actions">
                        <button
                          className="rec-read-btn"
                          disabled={busy}
                          onClick={() => void onOpenBookId(book.id, book.title)}
                        >
                          <BookOpen size={14} />
                          <span>立即阅读</span>
                        </button>
                        <button
                          className={`rec-shelf-btn ${inShelf ? 'in-shelf' : ''}`}
                          onClick={() => {
                            if (inShelf) {
                              notice(`《${book.title}》已在书架中`);
                            } else {
                              onAddBookToShelf({
                                id: book.id,
                                title: book.title,
                                author: book.author,
                                description: book.description,
                                coverStyle: book.coverStyle,
                              });
                            }
                          }}
                        >
                          {inShelf ? <CheckCircle2 size={13} /> : <Plus size={13} />}
                          <span>{inShelf ? '已在书架' : '加书架'}</span>
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
