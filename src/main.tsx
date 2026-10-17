import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { storage } from './lib/storage';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
async function start() {
  root.render(<main className="library-startup"><h1>Tomato Reader</h1><p role="status">正在读取本地书架，首次更新会迁移旧资料…</p></main>);
  try {
    await storage.initializeBooks();
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
  } catch (error) {
    root.render(<main className="library-startup"><h1>本地书架暂时无法读取</h1><p role="alert">{error instanceof Error ? error.message : '请检查本机可用空间后重试。'}</p><p>原有资料未清除。为避免误覆盖，暂不打开空白书架。</p><button onClick={() => void start()}>重试读取书架</button></main>);
  }
}
void start();
