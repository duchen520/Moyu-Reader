import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const inputFile = new URL('../test-output/大文件小说.txt', import.meta.url);

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1499', '--strictPort'], { stdio: 'ignore' });
let browser, passed = 0;
const check = text => { passed++; console.log('PASS ' + text); };
const dbBooks = page => page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('tomato-reader-library', 1);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result, tx = db.transaction('books', 'readonly'), read = tx.objectStore('books').getAll();
    tx.oncomplete = () => { db.close(); resolve(read.result.map(b => ({ id: b.id, title: b.title, chapters: b.chapters.length, chars: b.chapters.reduce((n, c) => n + c.content.length, 0) }))); };
    tx.onabort = () => reject(tx.error);
  };
}));
async function nextChapter(page) {
  const button = page.getByRole('button', { name: '下一章', exact: true });
  // Auto-scroll intentionally moves the paper on every frame. Use the actual
  // mouse (whose down event freezes it) instead of waiting for a stationary DOM.
  await button.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const box = await button.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
const legacyBook = { id: 'z-legacy', title: '旧书迁移测试', author: '测试', source: 'local', description: '', coverStyle: 0, addedAt: 1, chapters: [{ id: 'old-1', title: '第一章', content: '旧书正文。' }, { id: 'old-2', title: '第二章', content: '旧书第二章正文。' }] };
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:1499')).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(book => {
    if (sessionStorage.getItem('fixture-created')) return;
    sessionStorage.setItem('fixture-created', '1');
    localStorage.setItem('tomato-reader-v01:books', JSON.stringify([book, { ...book, id: 'a-legacy', title: '旧书排序测试' }]));
    localStorage.setItem('tomato-reader-v01:progress', JSON.stringify({ 'z-legacy': { chapterIndex: 1, scrollRatio: .25, paragraphIndex: 0, updatedAt: 1 } }));
    localStorage.setItem('tomato-reader-v01:preferences', JSON.stringify({ theme: 'night', fontSize: 20, lineHeight: 1.9, contentWidth: 760, autoUploadProgress: false }));
  }, legacyBook);
  await page.goto('http://127.0.0.1:1499');
  await page.getByRole('button', { name: '阅读 旧书迁移测试', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('tomato-reader-v01:books')), null);
  assert.deepEqual((await dbBooks(page)).map(b => b.id).sort(), ['a-legacy', 'z-legacy']);
  assert.equal(await page.getByRole('button', { name: '阅读 旧书迁移测试', exact: true }).count(), 1);
  assert.ok(await page.locator('.app-shell.theme-night').count());
  await page.getByRole('button', { name: '阅读 旧书迁移测试', exact: true }).click();
  await page.locator('.page-paper h1').filter({ hasText: '第二章' }).waitFor();
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  const backupIds = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('tomato-reader-library', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('metadata', 'readonly'), backup = tx.objectStore('metadata').get('legacy-backup');
      tx.oncomplete = () => { db.close(); resolve(JSON.parse(backup.result).map(b => b.id)); };
      tx.onabort = () => reject(tx.error);
    };
  }));
  assert.deepEqual(backupIds, ['z-legacy', 'a-legacy']);
  check('Legacy books migrate atomically while progress and preferences remain readable');

  const paragraph = '大文件保存与自动阅读测试。'.repeat(70);
  const content = Array.from({ length: 1200 }, (_, i) => `第${i + 1}章 大文件章节\n${Array(8).fill(paragraph).join('\n\n')}\n`).join('');
  const buffer = Buffer.from(content);
  assert.ok(buffer.length > 20 * 1024 * 1024);
  // Use a real disk-backed file so the >20 MiB fixture is not base64-copied
  // through the browser control protocol before the import even begins.
  await mkdir(new URL('../test-output/', import.meta.url), { recursive: true });
  await writeFile(inputFile, buffer);
  await page.locator('input[type=file]').setInputFiles(fileURLToPath(inputFile), { timeout: 60000 });
  await page.getByRole('button', { name: '阅读 大文件小说', exact: true }).waitFor({ timeout: 60000 });
  const saved = (await dbBooks(page)).find(b => b.title === '大文件小说');
  assert.equal(saved.chapters, 1200);
  assert.ok(saved.chars > 6_000_000);
  assert.equal(await page.evaluate(() => localStorage.getItem('tomato-reader-v01:books')), null);
  console.log(`Generated TXT bytes: ${buffer.length}`);
  check('A TXT larger than 20 MiB is imported, automatically split into 1200 chapters and committed outside localStorage');
  await page.reload();
  await page.getByRole('button', { name: '阅读 大文件小说', exact: true }).click({ timeout: 60000 });
  await page.locator('.story-content p').first().waitFor();
  assert.equal(await page.locator('.chapter-item').count(), 1200);
  await page.getByTitle('听书与自动翻页').click();
  await page.getByRole('button', { name: '自动阅读', exact: true }).click();
  await page.getByRole('button', { name: '平滑滚动', exact: true }).click();
  await page.getByRole('button', { name: '收起面板', exact: true }).click();
  await nextChapter(page);
  await page.locator('.page-paper h1').filter({ hasText: '第2章' }).waitFor();
  await page.waitForTimeout(350);
  assert.ok(await page.locator('.reading-canvas').evaluate(el => el.scrollTop) > 0);
  await page.locator('.chapter-item').nth(9).click();
  await page.locator('.page-paper h1').filter({ hasText: '第10章' }).waitFor();
  await page.waitForTimeout(350);
  assert.ok(await page.locator('.reading-canvas').evaluate(el => el.scrollTop) > 0);
  await page.locator('.reading-canvas').click({ position: { x: 100, y: 150 } });
  await page.keyboard.press('Control+ArrowRight');
  await page.locator('.page-paper h1').filter({ hasText: '第11章' }).waitFor();
  await page.waitForTimeout(350);
  assert.ok(await page.locator('.reading-canvas').evaluate(el => el.scrollTop) > 0);
  await page.locator('.audio-mini-pill').getByTitle('停止', { exact: true }).click();
  await nextChapter(page);
  const stopped = await page.locator('.reading-canvas').evaluate(el => el.scrollTop);
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.reading-canvas').evaluate(el => el.scrollTop), stopped);
  check('The large book survives reload; next button, directory and keyboard keep auto-scroll, while an explicit stop stays stopped');
  await page.getByTitle('听书与自动翻页').click();
  await page.getByRole('button', { name: '定时翻页', exact: true }).click();
  await page.getByLabel('翻页间隔').fill('3');
  await nextChapter(page);
  await page.waitForFunction(() => document.querySelector('.reading-canvas')?.scrollTop > 10, undefined, { timeout: 10000 });
  await page.getByRole('button', { name: '停止自动阅读', exact: true }).click();
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  check('Timed page-turn mode and its interval survive manual chapter changes');

  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...args) {
      const result = put.call(this, value, ...args);
      if (this.name === 'books' && value.title === '保存失败测试') this.transaction.abort();
      return result;
    };
  });
  await page.locator('input[type=file]').setInputFiles({ name: '保存失败测试.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章\n保存事务失败测试。') });
  await page.getByText('导入保存失败', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: '阅读 保存失败测试', exact: true }).count(), 0);
  assert.ok(!(await dbBooks(page)).some(b => b.title === '保存失败测试'));
  await page.reload();
  await page.getByRole('button', { name: '阅读 大文件小说', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '阅读 保存失败测试', exact: true }).count(), 0);
  check('An aborted write never reports success or adds a transient book, and leaves existing books intact');
  const beforeDelete = (await dbBooks(page)).length;
  page.on('dialog', d => d.accept());
  await page.locator('.book-card').filter({ has: page.getByRole('button', { name: '阅读 旧书迁移测试', exact: true }) }).getByTitle('从书架移除', { exact: true }).click();
  await page.getByText('已从书架移除《旧书迁移测试》。', { exact: true }).waitFor();
  assert.equal((await dbBooks(page)).length, beforeDelete - 1);
  await page.evaluate(book => localStorage.setItem('tomato-reader-v01:books', JSON.stringify([book])), legacyBook);
  await page.reload();
  await page.getByRole('button', { name: '阅读 大文件小说', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '阅读 旧书迁移测试', exact: true }).count(), 0);
  check('A leftover legacy copy cannot resurrect deleted books on a subsequent start');
  assert.deepEqual(errors, []);
  await page.close();

  const failed = await browser.newPage();
  await failed.addInitScript(book => {
    localStorage.setItem('tomato-reader-v01:books', JSON.stringify([book]));
    window.__failMigration = true;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...args) {
      const result = put.call(this, value, ...args);
      if (window.__failMigration && this.name === 'books') this.transaction.abort();
      return result;
    };
  }, legacyBook);
  await failed.goto('http://127.0.0.1:1499');
  await failed.getByRole('heading', { name: '本地书架暂时无法读取', exact: true }).waitFor();
  assert.ok(await failed.evaluate(() => localStorage.getItem('tomato-reader-v01:books')));
  assert.equal(await failed.locator('.library-screen').count(), 0);
  assert.equal((await dbBooks(failed)).length, 0);
  await failed.evaluate(() => { window.__failMigration = false; });
  await failed.getByRole('button', { name: '重试读取书架', exact: true }).click();
  await failed.getByRole('button', { name: '阅读 旧书迁移测试', exact: true }).waitFor();
  assert.equal((await dbBooks(failed)).length, 1);
  check('Failed migration keeps the old copy, never opens an empty shelf, and retries successfully');
  await failed.close();
  console.log(`${passed} large TXT and migration checks passed.`);
} finally { await browser?.close(); server.kill(); await rm(inputFile, { force: true }); }
