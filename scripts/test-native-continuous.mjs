import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const executable = process.env.TOMATO_NATIVE_EXE;
assert.ok(executable, 'Set TOMATO_NATIVE_EXE to the built program');
const profile = resolve(`test-output/native-continuous-${Date.now()}`);
const app = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=1534' } });
let browser, passed = 0;
const errors = [];
const check = text => { passed++; console.log('PASS ' + text); };
const chapterIs = async (page, number) => {
  for (let i = 0; i < 80; i++) { if (Number(await page.locator('.chapter-item.current .chapter-index').textContent()) === number) return; await delay(100); }
  assert.fail('Native current chapter did not reach ' + number);
};
try {
  for (let i = 0; i < 150; i++) { try { if ((await fetch('http://127.0.0.1:1534/json/version')).ok) break; } catch {} await delay(200); }
  browser = await chromium.connectOverCDP('http://127.0.0.1:1534');
  const page = browser.contexts()[0].pages()[0];
  page.on('pageerror', e => errors.push(e.message));
  await page.locator('.app-shell').waitFor();
  assert.equal(await page.locator('.book-card').count(), 0);
  await page.getByRole('button', { name: '去找一本书', exact: true }).waitFor();
  check('Actual packaged application starts with a usable empty shelf and no built-in samples');
  await page.evaluate(async () => {
    const content = Array.from({ length: 35 }, (_, i) => `第${i + 1}段。${'独立测试书籍，用于检查打包后的连续阅读。'.repeat(6)}`).join('\n\n');
    const book = { id: 'native-continuous', title: '本机连续阅读测试', author: '测试', description: '', source: 'local', coverStyle: 0, addedAt: 1,
      chapters: Array.from({ length: 30 }, (_, i) => ({ id: 'native-' + i, title: `第${i + 1}章 本机测试`, loaded: true, content })) };
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('tomato-reader-library', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction(['books', 'metadata'], 'readwrite');
        tx.objectStore('books').put(book); tx.objectStore('metadata').put([book.id], 'book-order');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
      };
    });
    localStorage.setItem('tomato-reader-v01:preferences', JSON.stringify({ readingMode: 'continuous', theme: 'night', fontSize: 19, lineHeight: 1.95, contentWidth: 760, autoUploadProgress: false, showParagraphComments: false }));
    localStorage.setItem('tomato-reader-v01:progress', JSON.stringify({ 'native-continuous': { chapterIndex: 9, scrollRatio: .3, updatedAt: 1 } }));
  });
  await page.reload();
  await page.getByRole('button', { name: '阅读 本机连续阅读测试', exact: true }).click();
  await page.locator('.continuous-stream').waitFor();
  assert.equal(await page.locator('.continuous-chapter').count(), 5);
  assert.match(await page.locator('.chapter-item.current').textContent(), /第10章/);
  await page.locator('[data-chapter-index="10"]').evaluate(section => {
    const canvas = document.querySelector('.reading-canvas');
    canvas.scrollTop += section.getBoundingClientRect().top - canvas.getBoundingClientRect().top + 900;
  });
  await chapterIs(page, 11);
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('tomato-reader-v01:progress'))['native-continuous'].chapterIndex), 10);
  check('Real WebView2 scrolling crosses chapters and updates the directory and persisted reading position');
  await page.locator('.chapter-item').nth(29).click();
  await chapterIs(page, 30);
  assert.equal(await page.locator('.continuous-chapter').count(), 3);
  await page.getByText('— 全书完 —', { exact: true }).waitFor();
  await page.locator('.chapter-item').nth(10).click();
  await chapterIs(page, 11);
  check('Native directory jumps land on exact chapters, including the final chapter');
  await page.getByTitle('阅读设置', { exact: true }).click();
  await page.getByLabel('阅读模式', { exact: true }).selectOption('normal');
  await page.getByRole('button', { name: '关闭阅读偏好', exact: true }).click();
  assert.equal(await page.locator('.continuous-stream').count(), 0);
  assert.equal(await page.locator('.pagination').count(), 1);
  check('Actual application can switch back to ordinary chapter reading');
  await mkdir('test-output', { recursive: true });
  await page.screenshot({ path: 'test-output/native-continuous-mode-switch.png' });
  assert.deepEqual(errors, []);
  console.log(`${passed} native checks passed using isolated fixture data.`);
} finally { await browser?.close(); app.kill(); }
