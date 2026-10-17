import { useState } from 'react';
import { RefreshCw, Cloud, ArrowRight } from 'lucide-react';
import { OfficialCover } from './OfficialCover';
import type { OfficialAccountState } from '../lib/useOfficialAccount';

export function CloudShelf({ account, onOpenBookId, onManageAccount }: {
  account: OfficialAccountState;
  onOpenBookId: (id: string, title?: string, coverUrl?: string) => Promise<void>;
  onManageAccount: () => void;
}) {
  const [query, setQuery] = useState('');
  const { user, checking, accountError, shelf, shelfBusy, shelfError, shelfWarning, shelfLoaded, refreshShelf, checkAccount } = account;
  const visible = shelf.filter(b => `${b.title} ${b.author}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="official-screen cloud-shelf-screen">
      <div className="official-screen-header">
        <div className="eyebrow">FANQIE NOVEL · CLOUD LIBRARY</div>
        <h1>云端书架</h1>
        <p className="subheading">读取番茄账号的藏书与章节进度。启动时后台加载，切换页面保留本次结果；刷新书架不会上传阅读进度。</p>
      </div>
      <div className="official-card cloud-shelf-toolbar">
        <div><Cloud size={20} /><strong>{user ? `${user.name}的云端书架` : checking ? '正在检查账号…' : accountError ? '暂时无法确认账号状态' : '尚未登录番茄账号'}</strong></div>
        {user ? <>
          <label className="sr-only" htmlFor="cloud-shelf-search">筛选云端书架</label>
          <input id="cloud-shelf-search" placeholder="在书架中查找书名或作者" value={query} onChange={e => setQuery(e.target.value)} />
          <button className="shelf-refresh-btn" disabled={shelfBusy || checking} onClick={() => void refreshShelf()}><RefreshCw size={14} className={shelfBusy ? 'spinning' : ''} /><span>{shelfBusy ? '正在加载书架…' : '刷新官方书架'}</span></button>
        </> : <button className="shelf-refresh-btn" disabled={checking} onClick={accountError ? () => void checkAccount() : onManageAccount}>
          {accountError ? '重试账号检查' : '前往账号管理'}<ArrowRight size={14} /></button>}
      </div>
      {accountError && <p role="alert">账号检查失败：{accountError}</p>}
      {user && <>
        <p className="connection-status" role="status">{shelfBusy ? '正在后台读取官方书架、封面和章节进度…' : shelfLoaded ? `官方书架：${shelf.length} 本${query.trim() ? ` · 找到 ${visible.length} 本` : ''}` : '云端书架尚未加载成功'}</p>
        {shelfError && <p role="alert">书架读取失败：{shelfError}{shelfLoaded ? '；已保留上次读取结果。' : '；可点击刷新重试。'}</p>}
        {shelfWarning && <p role="status">{shelfWarning}</p>}
        <div className="official-shelf">
          {visible.map(b => <button key={b.id} onClick={() => void onOpenBookId(b.id, b.title, b.coverUrl)}>
            <OfficialCover bookId={b.id} url={b.coverUrl} title={b.title} />
            <div className="official-shelf-info"><strong>{b.title}</strong><span>{b.author}</span>
              <small>{b.progressState === 'loading' ? '章节进度正在后台读取…' : b.progressState === 'available' ? `云端读至：${b.lastReadTitle || '已记录章节，打开后定位'}` : b.progressState === 'failed' ? '章节进度读取失败，打开后可再读取' : '官方暂未返回该书章节进度'}</small>
              <small className="continue-link">查看目录并续读 →</small>
            </div>
          </button>)}
        </div>
        {shelfLoaded && !visible.length && !shelfBusy && <p>{query.trim() ? '书架中没有匹配的作品。' : '当前账号的官方书架为空。'}</p>}
      </>}
    </div>
  );
}
