import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const executable = process.env.TOMATO_NATIVE_EXE;
assert.ok(executable, 'Set TOMATO_NATIVE_EXE');
const profile = resolve(`test-output/native-update-${Date.now()}`);
const app = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=1536' } });
let browser, passed = 0; const errors = [];
const check = text => { passed++; console.log('PASS ' + text); };
try {
  for (let i = 0; i < 150; i++) { try { if ((await fetch('http://127.0.0.1:1536/json/version')).ok) break; } catch {} await delay(200); }
  browser = await chromium.connectOverCDP('http://127.0.0.1:1536');
  const page = browser.contexts()[0].pages()[0]; page.on('pageerror', e => errors.push(e.message));
  await page.locator('.app-shell').waitFor();
  const noReady = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await invoke('update_cancel');
    try { await invoke('update_install'); return 'unexpected success'; } catch (error) { return String(error); }
  });
  assert.match(noReady, /先下载并校验/);
  assert.ok(await page.locator('.app-shell').isVisible());
  check('Native install command refuses an unverified/missing installer and the app stays open');
  await page.route('https://api.github.com/repos/duchen520/Moyu-Reader/releases/latest', route => route.fulfill({ json: { tag_name: 'v99.0.0', draft: false, prerelease: false, assets: [{ name: 'Moyu-Reader-99.0.0-x64-setup.exe', browser_download_url: 'https://github.com/duchen520/Moyu-Reader/releases/download/v99.0.0/Moyu-Reader-99.0.0-x64-setup.exe' }] } }));
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByText('当前版本: v0.5.20', { exact: true }).waitFor();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('button', { name: '立即更新', exact: true }).click();
  await page.locator('.update-error').waitFor();
  assert.match(await page.locator('.update-error').textContent(), /发布版本已变化|不是较新的正式版/);
  assert.ok(await page.getByRole('button', { name: '重试更新', exact: true }).isEnabled());
  assert.ok(await page.locator('.app-shell').isVisible());
  const progress = await page.evaluate(async () => {
    const events = [];
    const id = window.__TAURI_INTERNALS__.transformCallback(raw => events.push(raw));
    try { await window.__TAURI_INTERNALS__.invoke('update_download', { version: '99.0.0', progress: '__CHANNEL__:' + id }); } catch {}
    return events;
  });
  assert.ok(progress.some(raw => raw.message?.phase === 'preparing' || raw.phase === 'preparing'), JSON.stringify(progress));
  check('Real WebView2 streams Rust progress and rejects a mismatched frontend release using independently fetched GitHub metadata');
  const downgrade = await page.evaluate(async () => {
    const id = window.__TAURI_INTERNALS__.transformCallback(() => {});
    try { await window.__TAURI_INTERNALS__.invoke('update_download', { version: '0.0.0', progress: '__CHANNEL__:' + id }); return 'unexpected success'; } catch (error) { return String(error); }
  });
  assert.match(downgrade, /没有可下载的较新正式版/);
  check('Native update IPC refuses a downgrade before any file or installer is used');
  await mkdir('test-output', { recursive: true });
  await page.screenshot({ path: 'test-output/native-update-error.png' });
  assert.deepEqual(errors, []);
  console.log(`${passed} native updater checks passed; frontend release was mocked, Rust queried public GitHub, no installer executed.`);
} finally { await browser?.close(); app.kill(); }
