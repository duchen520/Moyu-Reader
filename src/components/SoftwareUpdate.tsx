import { useEffect, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { Download, ExternalLink, RefreshCw, X } from 'lucide-react';
import { checkForUpdate, CURRENT_VERSION } from '../lib/updater';
import type { UpdateCheckResult } from '../lib/updater';

type Phase = 'idle' | 'preparing' | 'downloading' | 'verifying' | 'cancelling' | 'ready' | 'installing' | 'failed';
interface DownloadState { phase: Phase; received: number; total: number; error?: string }
interface Progress { phase: 'preparing' | 'downloading' | 'verifying'; received: number; total: number }
const empty: DownloadState = { phase: 'idle', received: 0, total: 0 };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// Kept in App so opening a book or leaving Settings cannot lose an active
// download, its cancellation signal, or a verified installer ready to retry.
export function useSoftwareUpdate(notice: (text: string) => void) {
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [download, setDownload] = useState<DownloadState>(empty);
  const busy = useRef(false), cancelling = useRef(false), generation = useRef(0);
  const isNative = typeof Reflect.get(window, '__TAURI_INTERNALS__')?.invoke === 'function';
  const check = async () => {
    if (busy.current || download.phase === 'ready') return;
    setChecking(true); setDownload(empty);
    try {
      const result = await checkForUpdate(); setResult(result);
      if (result.hasUpdate) notice(`发现新版本 v${result.latestVersion}。`);
      else if (result.error) notice(result.error);
      else notice(`当前已是最新版本（v${result.currentVersion}）。`);
    } finally { setChecking(false); }
  };
  const install = async () => {
    setDownload(old => ({ ...old, phase: 'installing', error: undefined }));
    try {
      // Reader writes its pending chapter/paragraph position synchronously on
      // pagehide. Flush it even if Settings was left while downloading.
      window.dispatchEvent(new Event('pagehide'));
      await invoke('update_install');
    } catch (error) {
      busy.current = false;
      setDownload(old => ({ ...old, phase: 'ready', error: message(error) }));
      notice(`安装未启动：${message(error)}`);
    }
  };
  const start = async () => {
    if (!result?.hasUpdate || busy.current || checking) return;
    if (!isNative) { notice('请在墨屿桌面应用中使用内置更新。'); return; }
    busy.current = true; cancelling.current = false;
    if (download.phase === 'ready') { await install(); return; }
    const ticket = ++generation.current;
    setDownload({ ...empty, phase: 'preparing' });
    let streaming = true;
    try {
    const progress = new Channel<Progress>();
    progress.onmessage = value => {
      if (!streaming || ticket !== generation.current || cancelling.current) return;
      if (!['preparing', 'downloading', 'verifying'].includes(value.phase)) return;
      setDownload({ phase: value.phase, received: Math.max(0, value.received), total: Math.max(0, value.total) });
    };
      const ready = await invoke<{ version: string; total: number }>('update_download', { version: result.latestVersion, progress });
      streaming = false;
      if (ticket !== generation.current || cancelling.current) { busy.current = false; setDownload(empty); return; }
      if (ready.version !== result.latestVersion) throw Error('下载版本与当前更新不一致，请重新检查。');
      setDownload({ phase: 'ready', received: ready.total, total: ready.total });
      await install();
    } catch (error) {
      streaming = false;
      if (ticket !== generation.current) return;
      busy.current = false;
      if (cancelling.current) { setDownload(empty); notice('已取消更新下载。'); }
      else { setDownload(old => ({ ...old, phase: 'failed', error: message(error) })); notice(`更新未完成：${message(error)}`); }
    }
  };
  const cancel = async () => {
    if (cancelling.current) return;
    cancelling.current = true;
    setDownload(old => ({ ...old, phase: 'cancelling' }));
    try { await invoke('update_cancel'); }
    catch (error) { setDownload(old => ({ ...old, error: `取消请求失败：${message(error)}` })); }
  };
  const redownload = () => { if (!busy.current) { setDownload(empty); } };
  useEffect(() => () => { generation.current++; if (busy.current) void invoke('update_cancel').catch(() => {}); }, []);
  return { result, checking, download, isNative, check, start, cancel, redownload };
}

export function SoftwareUpdate({ update }: { update: ReturnType<typeof useSoftwareUpdate> }) {
  const { result, checking, download, isNative } = update;
  const transferring = ['preparing', 'downloading', 'verifying', 'cancelling'].includes(download.phase);
  const installing = download.phase === 'installing';
  const percent = download.total ? Math.min(100, Math.round(download.received / download.total * 100)) : 0;
  const status = download.phase === 'preparing' ? '正在获取并核对安装包资料…'
    : download.phase === 'downloading' ? `正在下载 ${percent}% · ${(download.received / 1048576).toFixed(1)} / ${(download.total / 1048576).toFixed(1)} MB`
    : download.phase === 'verifying' ? '下载完成，正在校验安装包…'
    : download.phase === 'cancelling' ? '正在取消下载…'
    : installing ? '正在启动安装程序，应用即将关闭；安装完成后会重新打开。'
    : download.phase === 'ready' ? '安装包已校验，可重试启动安装。' : '';
  return <div className="settings-card update-card">
    <div className="update-summary">
      <div><strong>当前版本: v{CURRENT_VERSION}</strong><p className="update-version-note">{checking ? '正在连接服务器检查新版本…' : result?.error ? `检查更新提示：${result.error}` : result?.hasUpdate ? `发现新版本: v${result.latestVersion}${result.publishedAt ? `（发布于 ${result.publishedAt}）` : ''}` : result ? '已是最新版本，无需更新。' : '点击按钮检查最新版本。'}</p></div>
      <div className="update-actions">
        <button type="button" className="outline-button" disabled={checking || transferring || installing || download.phase === 'ready'} onClick={() => void update.check()}><RefreshCw size={14} className={checking ? 'spin' : ''}/>{checking ? '检查中…' : '检查更新'}</button>
        {result?.hasUpdate && <button type="button" className="primary-button" disabled={checking || transferring || installing || !isNative || !result.installerUrl} onClick={() => void update.start()}><Download size={14}/>{installing ? '正在安装…' : transferring ? '更新中…' : download.phase === 'ready' ? '重试安装并重启' : download.phase === 'failed' ? '重试更新' : '立即更新'}</button>}
        {transferring && <button type="button" className="outline-button" disabled={download.phase === 'cancelling'} onClick={() => void update.cancel()}><X size={14}/>取消下载</button>}
        {download.phase === 'ready' && !installing && <button className="outline-button" onClick={update.redownload}>重新下载</button>}
      </div>
    </div>
    {(transferring || installing || download.phase === 'ready') && <div className="update-transfer"><progress aria-label="更新下载进度" value={percent} max={100}/><p role="status">{status}</p></div>}
    {download.error && <p className="update-error" role="alert">{download.error}</p>}
    {result?.hasUpdate && <p className="update-version-note">{result.installerUrl ? '下载并校验完成后会自动关闭应用、安装新版并重新打开。原有书架与阅读记录会保留。' : '此版本尚未提供可用的 Setup 安装包，请稍后检查或查看发布页。'}</p>}
    {(result?.error || download.error || (result?.hasUpdate && !result.installerUrl)) && <a className="update-release-link" href="https://github.com/duchen520/Moyu-Reader/releases" target="_blank" rel="noopener noreferrer"><ExternalLink size={14}/>查看发布页</a>}
    {result?.hasUpdate && result.releaseNotes && <div className="update-notes"><strong>更新说明</strong><pre>{result.releaseNotes}</pre></div>}
  </div>;
}
