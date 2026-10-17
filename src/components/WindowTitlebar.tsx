import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { BookOpen, Copy, Minus, Square, X } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { APP_NAME } from '../lib/branding';
import { storage } from '../lib/storage';

export function WindowTitlebar({ context = '私人阅读空间' }: { context?: string }) {
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState('');
  const appWindow = useMemo(() => {
    if (!isTauri()) return null;
    try { return getCurrentWindow(); } catch { return null; }
  }, []);

  useEffect(() => {
    if (!appWindow) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const refresh = () => { void appWindow.isMaximized().then(value => { if (!disposed) setMaximized(value); }).catch(() => {}); };
    refresh();
    void appWindow.onResized(refresh).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, [appWindow]);

  async function control(action: 'minimize' | 'maximize' | 'close') {
    if (!appWindow) return;
    setError('');
    try {
      if (action === 'minimize') await appWindow.minimize();
      else if (action === 'close') await appWindow.close();
      else { await appWindow.toggleMaximize(); setMaximized(await appWindow.isMaximized()); }
    } catch { setError('窗口操作暂时失败，请重试'); }
  }

  return <header className="window-titlebar" aria-label="窗口标题栏" data-tauri-drag-region>
    <div className="window-titlebar-brand" data-tauri-drag-region>
      <span className="window-titlebar-mark" aria-hidden="true" data-tauri-drag-region><BookOpen size={13}/></span>
      <span data-tauri-drag-region>{APP_NAME}</span>
    </div>
    <span className="window-titlebar-context" data-tauri-drag-region>{context}</span>
    {error && <span className="window-titlebar-error" role="status">{error}</span>}
    <div className="window-titlebar-controls">
      <button type="button" aria-label="最小化窗口" title="最小化窗口" disabled={!appWindow} onClick={() => void control('minimize')}><Minus size={15}/></button>
      <button type="button" aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原窗口' : '最大化窗口'} disabled={!appWindow} onClick={() => void control('maximize')}>{maximized ? <Copy size={12}/> : <Square size={12}/>}</button>
      <button type="button" className="window-close" aria-label="关闭窗口" title="关闭窗口" disabled={!appWindow} onClick={() => void control('close')}><X size={16}/></button>
    </div>
  </header>;
}

// A frameless window must still be movable and closable during startup or errors.
export function WindowFallback({ children }: { children: ReactNode }) {
  return <div className={`app-shell desktop-fallback theme-${storage.preferences().theme}`}><WindowTitlebar/>{children}</div>;
}
