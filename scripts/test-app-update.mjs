import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const port = 1535, url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
let browser, passed = 0; const errors = [];
const check = text => { passed++; console.log('PASS ' + text); };
async function fixture(options = {}) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  p.on('pageerror', e => errors.push(e.message));
  await p.route('https://**/*', route => route.abort());
  await p.route('https://api.github.com/repos/duchen520/Moyu-Reader/releases/latest', route => route.fulfill({ status: options.apiError ? 404 : 200, json: {
    tag_name: 'v99.0.0', draft: false, prerelease: false, body: '仅用于本机更新界面测试。',
    assets: [{ name: options.rawOnly ? 'Moyu-Reader-99.0.0.exe' : 'Moyu-Reader-99.0.0-x64-setup.exe', browser_download_url: 'https://github.com/duchen520/Moyu-Reader/releases/download/v99.0.0/Moyu-Reader-99.0.0-x64-setup.exe' }],
  } }));
  await p.addInitScript(() => {
    window.isTauri = true; window.__calls = []; window.__downloads = []; window.__installFail = false;
    window.__callbackId = 0; window.__callbacks = {};
    localStorage.setItem('tomato-reader-v01:books', JSON.stringify([{ id: 'update-fixture', title: '更新期间阅读测试', author: '测试', description: '', source: 'local', coverStyle: 0, addedAt: 1,
      chapters: [{ id: 'c1', title: '第一章', content: Array.from({ length: 60 }, (_, i) => `第${i + 1}段${'保存更新前的阅读位置。'.repeat(8)}`).join('\n\n'), loaded: true }] }]));
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback) { const id = ++window.__callbackId; window.__callbacks[id] = callback; return id; },
      unregisterCallback(id) { delete window.__callbacks[id]; },
      invoke: async (command, args = {}) => {
        window.__calls.push(command);
        if (command === 'official_account') return null;
        if (command === 'official_cancel_login') return;
        if (command === 'backup_list') return { path: 'test backups', backups: [] };
        if (command === 'backup_create') { if (window.__backupFail) throw Error('测试备份磁盘无法写入'); return { id: 'test-backup', createdAt: Date.now(), books: JSON.parse(args.payload).books.length, valid: true }; }
        if (command === 'update_download') return new Promise((resolve, reject) => { window.__downloads.push({ resolve, reject, emit: value => args.progress.onmessage(value) }); });
        if (command === 'update_cancel') { window.__downloads.at(-1)?.reject('更新下载已取消'); return; }
        if (command === 'update_install') { if (window.__installFail) throw Error('无法启动安装程序；应用尚未退出'); return; }
        throw Error('Unexpected native command ' + command);
      },
    };
  });
  await p.goto(url);
  await p.getByRole('button', { name: '阅读设置', exact: true }).click();
  await p.getByRole('button', { name: '检查更新', exact: true }).click();
  if (!options.apiError) await p.getByText('发现新版本: v99.0.0', { exact: true }).waitFor();
  return p;
}
const calls = (p, command) => p.evaluate(command => window.__calls.filter(c => c === command).length, command);
const emit = (p, received, total = 1000) => p.evaluate(({ received, total }) => window.__downloads.at(-1).emit({ phase: 'downloading', received, total }), { received, total });
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true });
  const p = await fixture();
  await p.getByRole('button', { name: '立即更新', exact: true }).click();
  await p.waitForFunction(() => window.__downloads.length === 1);
  await emit(p, 410);
  await p.waitForFunction(() => document.querySelector('progress')?.value === 41);
  assert.equal(await p.getByRole('button', { name: '检查更新', exact: true }).isDisabled(), true);
  assert.equal(await calls(p, 'update_install'), 0);
  check('Update downloads inside the app with measured progress and no premature installation');
  await p.getByRole('button', { name: '本地书架', exact: false }).click();
  await p.getByRole('button', { name: '阅读 更新期间阅读测试', exact: true }).click();
  await p.locator('.story-content p').first().waitFor();
  await p.locator('.reading-canvas').evaluate(el => { el.scrollTop = 2000; el.dispatchEvent(new Event('scroll')); });
  await p.evaluate(() => window.__downloads[0].resolve({ version: '99.0.0', total: 1000 }));
  await p.waitForFunction(() => window.__calls.includes('update_install'));
  assert.ok(await p.evaluate(() => JSON.parse(localStorage.getItem('tomato-reader-v01:progress'))['update-fixture'].scrollRatio > 0));
  await p.getByRole('button', { name: '返回书架', exact: true }).click();
  await p.getByRole('button', { name: '阅读设置', exact: true }).click();
  await p.getByText('正在启动安装程序，应用即将关闭；安装完成后会重新打开。', { exact: true }).waitFor();
  await p.evaluate(() => window.__downloads[0].emit({ phase: 'downloading', received: 900, total: 1000 }));
  assert.equal(await p.getByRole('button', { name: '正在安装…', exact: true }).isDisabled(), true);
  assert.equal(await calls(p, 'update_install'), 1);
  check('Download survives navigation, flushes an active reader before install, and ignores late progress after completion');
  await mkdir('test-output', { recursive: true });
  await p.screenshot({ path: 'test-output/app-update-installing.png' });
  await p.close();
  const c = await fixture();
  await c.getByRole('button', { name: '立即更新', exact: true }).click();
  await c.waitForFunction(() => window.__downloads.length === 1);
  await emit(c, 200);
  await c.getByRole('button', { name: '取消下载', exact: true }).click();
  await c.getByRole('button', { name: '立即更新', exact: true }).waitFor();
  await c.evaluate(() => window.__downloads[0].emit({ phase: 'downloading', received: 900, total: 1000 }));
  assert.equal(await c.locator('progress').count(), 0);
  assert.equal(await calls(c, 'update_install'), 0);
  await c.getByRole('button', { name: '立即更新', exact: true }).click();
  await c.waitForFunction(() => window.__downloads.length === 2);
  await emit(c, 100);
  await c.evaluate(() => window.__downloads[0].emit({ phase: 'downloading', received: 990, total: 1000 }));
  await c.waitForFunction(() => document.querySelector('progress')?.value === 10);
  await c.getByRole('button', { name: '取消下载', exact: true }).click();
  check('Cancellation prevents install; retry gets a new session and stale callbacks cannot overwrite its progress');
  await c.close();
  const f = await fixture();
  await f.getByRole('button', { name: '立即更新', exact: true }).click();
  await f.waitForFunction(() => window.__downloads.length === 1);
  await f.evaluate(() => window.__downloads[0].reject('安装包校验失败'));
  await f.getByRole('alert').filter({ hasText: '安装包校验失败' }).waitFor();
  assert.equal(await calls(f, 'update_install'), 0);
  await f.getByRole('button', { name: '重试更新', exact: true }).click();
  await f.waitForFunction(() => window.__downloads.length === 2);
  await f.evaluate(() => { window.__installFail = true; window.__downloads[1].resolve({ version: '99.0.0', total: 1000 }); });
  await f.getByRole('button', { name: '重试安装并重启', exact: true }).waitFor();
  assert.equal(await calls(f, 'update_install'), 1);
  await f.evaluate(() => { window.__installFail = false; });
  await f.getByRole('button', { name: '重试安装并重启', exact: true }).click();
  assert.equal(await calls(f, 'update_download'), 2);
  assert.equal(await calls(f, 'update_install'), 2);
  check('Verification failure never installs; installer startup failure leaves the app usable and can retry without downloading again');
  await f.close();
  const raw = await fixture({ rawOnly: true });
  assert.equal(await raw.getByRole('button', { name: '立即更新', exact: true }).isDisabled(), true);
  assert.equal(await calls(raw, 'update_download'), 0);
  check('A release containing only a raw EXE is never treated as an installer');
  await raw.close();
  const offline = await fixture({ apiError: true });
  await offline.getByText(/检查更新提示：/).waitFor();
  assert.equal(await offline.getByText('已是最新版本，无需更新。', { exact: true }).count(), 0);
  assert.equal(await calls(offline, 'update_download'), 0);
  await offline.close();
  check('Unavailable release metadata reports an error instead of claiming the app is current');
  const protectedUpdate = await fixture();
  await protectedUpdate.getByRole('button', { name: '立即更新', exact: true }).click();
  await protectedUpdate.waitForFunction(() => window.__downloads.length === 1);
  await protectedUpdate.evaluate(() => { window.__backupFail = true; window.__downloads[0].resolve({ version: '99.0.0', total: 1000 }); });
  await protectedUpdate.getByRole('button', { name: '重试安装并重启', exact: true }).waitFor();
  assert.equal(await calls(protectedUpdate, 'update_install'), 0);
  await protectedUpdate.evaluate(() => { window.__backupFail = false; });
  await protectedUpdate.getByRole('button', { name: '重试安装并重启', exact: true }).click();
  await protectedUpdate.waitForFunction(() => window.__calls.includes('update_install'));
  assert.equal(await calls(protectedUpdate, 'update_install'), 1);
  check('A failed pre-update backup blocks installation and allows retry after backup storage recovers');
  await protectedUpdate.close();
  assert.deepEqual(errors, []);
  console.log(`${passed} app update checks passed using mocked release and native responses; no installer executed.`);
} finally { await browser?.close(); server.kill(); }
