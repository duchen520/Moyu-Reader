import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Read-only official calls; isolated disk profile, never the user's shelf.
const executable = process.env.TOMATO_NATIVE_EXE;
assert.ok(executable, 'Set TOMATO_NATIVE_EXE');
const profile = resolve(`test-output/nl-${Date.now()}`), port = 1546;
const bookId = process.env.TOMATO_LOADING_BOOK ?? '7611433607134972990';
const expectedParagraphs = Number(process.env.TOMATO_LOADING_PARAGRAPHS ?? 59);
let app, browser, page;
const result = { bookId, uploadCalls: 0 }, errors = [];
async function launch(offline = false) {
  // Limit the failure simulation to this child process's Rust HTTP clients.
  // No bridge mocks, machine-wide proxy settings or firewall changes.
  const proxy = offline ? Object.fromEntries(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'].map(k => [k, 'http://127.0.0.1:9'])) : {};
  app = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
    ...proxy, ...(offline ? { NO_PROXY: '', no_proxy: '' } : {}),
    WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    await delay(200);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser.contexts()[0].pages()[0];
  page.on('pageerror', e => errors.push(e.message));
  await page.locator('.app-shell').waitFor();
  await observe();
}
async function observe() {
  await page.evaluate(() => {
    window.__loadingCalls = [];
    const original = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.hostname === 'ipc.localhost') window.__loadingCalls.push(decodeURIComponent(url.pathname.slice(1)));
      return original(input, options);
    };
  });
}
async function close() {
  if (page) result.uploadCalls += await page.evaluate(() => window.__loadingCalls?.filter(c => c === 'official_sync_progress').length ?? 0).catch(() => 0);
  await browser?.close().catch(() => {}); browser = null;
  app?.kill();
  await delay(500);
}
try {
  await launch();
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  if (await page.locator('#show-paragraph-comments').getAttribute('aria-checked') === 'true') await page.locator('#show-paragraph-comments').click();
  await page.locator('.side-nav button').filter({ hasText: '找书发现' }).click();
  await page.getByRole('button', { name: '通过番茄链接或书籍ID直接打开作品' }).click();
  await page.getByLabel('打开正版作品').fill(bookId);
  const first = Date.now();
  await page.getByRole('button', { name: '打开作品', exact: true }).click();
  await page.locator('.story-content p').nth(expectedParagraphs - 1).waitFor({ timeout: 60000 });
  result.firstOpenMs = Date.now() - first;
  const paragraphs = await page.locator('.story-content p').allTextContents();
  assert.equal(paragraphs.length, expectedParagraphs);
  assert.match(await page.locator('.sync-bar').textContent(), /自动上传已关闭/);
  // Verify a committed IndexedDB transaction, rather than only React's memory.
  let cached = false;
  for (let i = 0; i < 60 && !cached; i++) {
    cached = await page.evaluate(id => new Promise((resolve, reject) => {
      const request = indexedDB.open('tomato-reader-library', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('books', 'readonly'), read = tx.objectStore('books').get(id);
        tx.oncomplete = () => { db.close(); resolve(!!read.result?.chapters[0]?.loaded && !!read.result.chapters[0].content); };
        tx.onabort = () => reject(tx.error);
      };
    }), bookId);
    if (!cached) await delay(100);
  }
  assert.ok(cached, 'Actual chapter body must be committed to disk before restart');
  console.log(`PASS Real chapter renders all ${expectedParagraphs} body paragraphs and commits its offline cache`);
  await close();
  await launch();
  const warm = Date.now();
  await page.locator('.book-card .book-cover').first().click();
  await page.locator('.story-content p').nth(expectedParagraphs - 1).waitFor({ timeout: 60000 });
  result.afterProcessRestartMs = Date.now() - warm;
  assert.deepEqual(await page.locator('.story-content p').allTextContents(), paragraphs);
  result.restartChapterRequests = await page.evaluate(() => window.__loadingCalls.filter(c => c === 'official_chapter').length);
  assert.equal(result.restartChapterRequests, 0);
  console.log('PASS After a complete application-process restart the actual body is identical, with zero chapter downloads');
  await close(); await launch(true);
  const unavailable = await page.evaluate(async () => {
    try { await window.__TAURI_INTERNALS__.invoke('official_account'); return 'unexpected success'; }
    catch (error) { return String(error); }
  });
  assert.match(unavailable, /无法连接|网络|连接失败/, 'The actual Rust HTTP client must be unable to reach the official service');
  result.nativeNetworkFailureConfirmed = true;
  await page.locator('.book-card').first().waitFor();
  const offline = Date.now();
  await page.locator('.book-card .book-cover').first().click();
  await page.locator('.story-content p').nth(expectedParagraphs - 1).waitFor({ timeout: 10000 });
  result.offlineOpenMs = Date.now() - offline;
  assert.deepEqual(await page.locator('.story-content p').allTextContents(), paragraphs);
  result.offlineChapterRequests = await page.evaluate(() => window.__loadingCalls.filter(c => c === 'official_chapter').length);
  assert.equal(result.offlineChapterRequests, 0);
  console.log('PASS Packaged WebView2 reads the cached body after simulated official-service failure, without another chapter request');
  assert.deepEqual(errors, []);
  await close(); assert.equal(result.uploadCalls, 0);
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/native-loading-0525.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await mkdir('test-output', { recursive: true });
  if (page) {
    await page.screenshot({ path: 'test-output/native-loading-failure.png' }).catch(() => {});
    const state = await page.locator('body').innerText().catch(() => 'Page unavailable');
    console.log('NATIVE FAILURE STATE', state.slice(0, 1600));
  }
  throw error;
} finally { if (browser || app?.exitCode === null) await close(); }
