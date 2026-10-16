import { isTauri } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
export const OFFICIAL_URL = 'https://fanqienovel.com/';
export async function openOfficialWebsite(url = OFFICIAL_URL): Promise<void> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !['fanqienovel.com','www.fanqienovel.com'].includes(target.hostname)) throw new Error('只允许打开番茄官方 HTTPS 页面。');
  if (!isTauri()) {
    const opened = window.open(target.href, '_blank', 'noopener,noreferrer');
    // Browsers may return null for noopener windows even when opened successfully.
    void opened;
    return;
  }
  // Different chapters get separate labels; an existing hidden window is focused again.
  const label = target.pathname.startsWith('/rank')
    ? `fanqie-official-${target.pathname.replace(/[^a-zA-Z0-9_-]/g, '-')}`
    : `fanqie-official-${target.pathname.match(/\d+/)?.[0] ?? 'home'}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) { await existing.show(); await existing.setFocus(); return; }
  const win = new WebviewWindow(label, { url: target.href, title: '番茄小说 · 官方网页（独立会话）', width:1050,height:760,center:true });
  await new Promise<void>((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('官网窗口创建超时')), 15000);
    void win.once('tauri://created', () => { clearTimeout(timer); resolve(); });
    void win.once('tauri://error', event => { clearTimeout(timer); reject(new Error(String(event.payload))); });
  });
}
