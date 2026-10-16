import { useEffect, useRef, useState } from 'react';
import { official, errorMessage } from '../lib/official';
import { CommentDetailView } from './CommentDetails';
import type { Book } from '../types';
import type { OfficialUser, QrTicket, CommentPage, BookComment } from '../lib/official';
import type { OfficialAccountState } from '../lib/useOfficialAccount';
import { QrCode, RefreshCw, LogOut, ShieldCheck } from 'lucide-react';

export function OfficialPanel({ account, notice, onAccount }: {
  account: OfficialAccountState; notice: (s: string) => void; onAccount: (u: OfficialUser | null) => void;
}) {
  const { user, checking, accountError, checkAccount } = account;
  const [ticket, setTicket] = useState<QrTicket | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const callbacks = useRef({ notice, onAccount }); callbacks.current = { notice, onAccount };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; generation.current++;
      if (official.available()) void official.cancelLogin();
    };
  }, []);
  useEffect(() => {
    if (!ticket) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const gen = generation.current;
    const poll = async () => {
      try {
        const result = await official.pollLogin();
        if (cancelled || gen !== generation.current) return;
        if (result.stage === 'authenticated' && result.user) {
          callbacks.current.onAccount(result.user); setTicket(null); setStatus('');
          if (result.warning) callbacks.current.notice(result.warning);
          return;
        }
        if (result.stage === 'expired') { setTicket(null); setStatus('二维码已失效，请重新生成'); return; }
        setStatus(result.stage === 'scanned' ? '已扫码，请在手机上确认' : result.stage === 'confirming' ? '确认中，正在核验账号' : '请用番茄小说或抖音扫码并确认登录');
      } catch (e) {
        if (!cancelled && gen === generation.current) { setStatus(errorMessage(e)); setTicket(null); }
        return;
      }
      timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [ticket]);

  const login = async () => {
    const gen = ++generation.current;
    setTicket(null); setBusy(true); setStatus('正在向官网请求二维码…');
    try {
      const next = await official.startLogin();
      if (mounted.current && gen === generation.current) setTicket(next);
    } catch (e) { if (mounted.current && gen === generation.current) setStatus(errorMessage(e)); }
    finally { if (mounted.current && gen === generation.current) setBusy(false); }
  };
  const logout = async () => {
    const gen = ++generation.current;
    setTicket(null); setBusy(true);
    try {
      await official.logout();
      // Logging out changes the shared session even if the user left this page meanwhile.
      callbacks.current.onAccount(null);
      if (mounted.current && gen === generation.current) setStatus('已退出本机账号');
    } catch (e) {
      if (mounted.current && gen === generation.current) { setStatus(`退出失败：${errorMessage(e)}`); void checkAccount(); }
    } finally { if (mounted.current && gen === generation.current) setBusy(false); }
  };
  return (
    <div className="official-screen account-screen">
      <div className="official-screen-header">
        <div className="eyebrow">FANQIE NOVEL · ACCOUNT</div>
        <h1>账号管理</h1>
        <p className="subheading">管理番茄账号的登录状态。云端藏书请前往左侧“云端书架”，搜索作品请前往“找书发现”。</p>
      </div>
      <div className="official-card account-card-modern">
        <div className="account-row">
          <div className="account-identity">
            <span className={`account-avatar ${user ? 'logged-in' : ''}`}>{user ? <ShieldCheck size={22} /> : <QrCode size={22} />}</span>
            <div><strong>{user?.name ?? (checking ? '正在检查登录状态…' : accountError ? '账号状态暂未确认' : '登录你的番茄账号')}</strong>
              <small>{user ? `UID: ${user.id}` : '扫码关联手机上的番茄小说账号'}</small></div>
          </div>
          <div className="account-actions">
            <button className="shelf-refresh-btn" disabled={busy || checking || !official.available()} onClick={() => { setStatus(''); void checkAccount(); }}>
              <RefreshCw size={14} className={checking ? 'spinning' : ''} /><span>{checking ? '正在检查…' : '重新检查账号'}</span>
            </button>
            {user ? <button className="logout-btn" disabled={busy || checking} onClick={() => void logout()}><LogOut size={14} /><span>退出账号</span></button>
              : <button className="login-btn" disabled={busy || checking || !official.available()} onClick={() => void login()}><QrCode size={15} /><span>{ticket ? '刷新二维码' : '扫码登录'}</span></button>}
            {ticket && <button className="cancel-btn" disabled={busy} onClick={() => { generation.current++; setTicket(null); void official.cancelLogin(); setStatus('已取消扫码登录'); }}>取消</button>}
          </div>
        </div>
        <p className="connection-status" role="status">{!official.available() ? '当前是浏览器预览，扫码与云端接口仅在桌面模式可用。'
          : checking ? '正在后台检查登录状态…' : accountError ? `账号检查失败：${accountError}` : status || (user ? `已验证登录：${user.name}` : '尚未登录')}</p>
        {ticket && <div className="qr-box"><div className="qr-image-wrapper"><img src={ticket.imageDataUrl} alt="番茄官网生成的登录二维码" /></div>
          <p>请用番茄小说或抖音扫码并确认登录 · 有效期约 {ticket.expiresInSeconds} 秒</p></div>}
      </div>
      <div className="official-notes-card"><p className="small-note">启动后会自动检查已保存的登录状态，并在后台读取云端书架。退出账号不会删除本机收藏、阅读记录和 TXT 文件。</p></div>
    </div>
  );
}

export function CommentsPanel({ book, notice, onClose }: { book: Book; notice: (s: string) => void; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<BookComment | null>(null);
  const [data, setData] = useState<CommentPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (book.source !== 'official') return;
    setBusy(true);
    setError('');
    setData(null);
    setSelected(null);
    official.comments(book.id, page)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(errorMessage(e)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [book.id, book.source, page]);

  return (
    <aside className="comments-panel">
      <div className="settings-panel-top">
        <strong>官方书评 {data ? `· ${data.total}` : ''}</strong>
        <button onClick={onClose} aria-label="关闭评论">×</button>
      </div>
      <p className="small-note">这里显示整本书的书评与回复。查看段评请点击正文段落旁的气泡。</p>
      {selected ? (
        <CommentDetailView bookId={book.id} comment={selected} onClose={() => setSelected(null)} />
      ) : (
        <>
          {book.source !== 'official' ? (
            <p className="comment-empty">这本是本地或示例书，没有番茄官方评论。请从“云端书架”或“找书发现”打开官方作品。</p>
          ) : busy ? (
            <p role="status">正在读取官方书评…</p>
          ) : error ? (
            <p role="alert">{error}</p>
          ) : data?.comments.length ? (
            data.comments.map(c => (
              <article className="comment" key={c.id}>
                <strong>{c.name}</strong>
                <p>{c.text}</p>
                <small>点赞 {c.likes} · 回复 {c.replies}</small>
                <button className="comment-detail-button" onClick={() => setSelected(c)}>查看详情与回复</button>
              </article>
            ))
          ) : (
            <p>官方本页没有返回书评。</p>
          )}
          {data && (
            <div className="comments-pagination">
              <button disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
              <span>{page}</span>
              <button disabled={busy || !data.hasMore} onClick={() => setPage(page + 1)}>下一页</button>
            </div>
          )}
        </>
      )}
      <button className="outline-button" onClick={() => notice('发表评论、回复和点赞将在后续版本接入。')}>
        互动功能待接入
      </button>
    </aside>
  );
}
