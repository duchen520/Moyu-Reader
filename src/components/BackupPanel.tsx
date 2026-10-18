import { useEffect, useState } from 'react';
import { backupStatus, createBackup, listBackups, restoreBackup } from '../lib/backups';
import type { BackupInfo } from '../lib/backups';

export function BackupPanel({ healthy = true }: { healthy?: boolean }) {
  const [items, setItems] = useState<BackupInfo[]>([]), [path, setPath] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState(backupStatus);
  const refresh = async () => {
    try { const result = await listBackups(); setItems(result.backups); setPath(result.path); setError(''); }
    catch (error) { setError(String(error)); }
  };
  useEffect(() => { void refresh(); const update = () => { setStatus(backupStatus()); }; window.addEventListener('moyu-backup-status', update); return () => window.removeEventListener('moyu-backup-status', update); }, []);
  const save = async () => {
    setBusy(true); setError('');
    try { await createBackup('manual'); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const restore = async (item: BackupInfo) => {
    if (!window.confirm(`恢复 ${new Date(item.createdAt).toLocaleString()} 的备份（${item.books} 本书）？\n\n${healthy ? '会先备份当前资料，再切换到备份中的书架、进度和设置。' : '会创建新的书架副本，保留当前无法读取的原数据库。'}\n恢复后云端自动上传会关闭，需要你重新开启。`)) return;
    setBusy(true); setError('');
    try { await restoreBackup(item.id, healthy); window.location.reload(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false); }
  };
  const labels: Record<string, string> = { auto: '自动备份', manual: '手动备份', 'before-update': '更新前', 'before-restore': '恢复前' };
  return <section className="settings-card backup-panel" aria-label="备份与恢复">
    <div className="update-summary"><div><h2>备份与恢复</h2><p className="update-version-note">本机保存书架、本地书籍全文、阅读进度和设置；不备份账号登录资料。官方作品恢复后会重新读取正文。</p></div><div className="update-actions">{healthy && <button className="primary-button" disabled={busy} onClick={() => void save()}>立即备份</button>}<button className="outline-button" disabled={busy} onClick={() => void refresh()}>刷新备份列表</button></div></div>
    {healthy && <p className="update-version-note" role="status">{status}</p>}
    <p className="update-version-note">自动保存有变化的资料，保留最近 10 份自动备份和 8 份手动、更新前或恢复前备份。恢复操作保留原数据库，并关闭云端自动上传。</p>
    {error && <p className="update-error" role="alert">{error}</p>}
    {busy && <p role="status">正在处理备份资料，请稍候…</p>}
    <div className="backup-list">{items.length ? items.map(item => <article className="backup-item" data-backup-id={item.id} key={item.id}><div><strong>{item.valid ? new Date(item.createdAt).toLocaleString() : '备份校验失败'}</strong><p>{item.valid ? `${labels[item.kind] ?? '备份'} · ${item.books} 本书（本地 ${item.localBooks} 本）· ${(item.bytes / 1048576).toFixed(1)} MB · v${item.version}` : item.error}</p></div><button className="outline-button" disabled={busy || !item.valid} onClick={() => void restore(item)}>恢复此备份</button></article>) : <p className="update-version-note">尚无可列出的本机备份。{healthy ? '可点击“立即备份”创建。' : '请保留原资料，暂时不要清空应用数据。'}</p>}</div>
    {path && <p className="backup-path">本机备份目录：{path}</p>}
  </section>;
}
