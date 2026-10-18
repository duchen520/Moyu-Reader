import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
const port = 1533;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
let browser, passed = 0;
const errors = [];
const check = label => { passed++; console.log('PASS ' + label); };
const paragraph = i => `第${i + 1}段，连续阅读位置验证。${'这是一段用于检验前后章节衔接和阅读进度的测试文字。'.repeat(4)}`;
async function fixture(official = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(({ official, content }) => {
    const book = { id: 'continuous-test', title: '连续阅读测试', author: '测试', description: '', source: official ? 'official' : 'local', coverStyle: 0, addedAt: 1,
      chapters: Array.from({ length: 300 }, (_, i) => ({ id: 'continuous-' + i, title: `第${i + 1}章 测试`, content: official ? '' : content, loaded: !official })) };
    if (!sessionStorage.getItem('fixture-seeded')) {
    localStorage.setItem('tomato-reader-v01:books', JSON.stringify([book]));
    localStorage.setItem('tomato-reader-v01:progress', JSON.stringify({ 'continuous-test': { chapterIndex: 147, scrollRatio: .25, updatedAt: 1 } }));
    localStorage.setItem('tomato-reader-v01:preferences', JSON.stringify({ theme: 'paper', fontSize: 19, lineHeight: 1.95, contentWidth: 760, autoUploadProgress: false, showParagraphComments: false }));
    sessionStorage.setItem('fixture-seeded', 'yes');
    }
    window.__requests = []; window.__fail = null; window.__hold = null; window.__release = null;
    window.isTauri = official;
    if (official) window.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === 'official_account') return null;
      if (command === 'official_read_progress') return [];
      if (command === 'official_cancel_login') return;
      if (command === 'official_chapter') {
        window.__requests.push(args.id);
        if (args.id === window.__hold) await new Promise(resolve => { window.__release = resolve; });
        await new Promise(resolve => setTimeout(resolve, 60));
        if (args.id === window.__fail) throw Error('测试正文加载失败');
        return { id: args.id, title: book.chapters.find(c => c.id === args.id).title, loaded: true, content: content.split('\n\n').map(p => `<p>${p}</p>`).join('') };
      }
      if (command === 'official_sync_progress') throw Error('Prefetch must never upload');
      throw Error('Unexpected command: ' + command);
    } };
  }, { official, content: Array.from({ length: 35 }, (_, i) => paragraph(i)).join('\n\n') });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole('button', { name: '阅读 连续阅读测试', exact: true }).click();
  await page.locator('.story-content p').first().waitFor();
  return page;
}
async function enable(page) {
  await page.getByTitle('阅读设置', { exact: true }).click();
  assert.equal(await page.getByLabel('阅读模式', { exact: true }).inputValue(), 'normal');
  await page.getByLabel('阅读模式', { exact: true }).selectOption('continuous');
  await page.getByRole('button', { name: '关闭阅读偏好', exact: true }).click();
  await page.locator('.continuous-stream').waitFor();
}
const current = page => page.locator('.chapter-item.current');
async function scrollChapter(page, index, offset = 160) {
  await page.locator(`[data-chapter-index="${index}"]`).waitFor();
  await page.locator(`[data-chapter-index="${index}"]`).evaluate((section, offset) => {
    const canvas = document.querySelector('.reading-canvas');
    canvas.scrollTop += section.getBoundingClientRect().top - canvas.getBoundingClientRect().top + offset;
  }, offset);
  await page.waitForTimeout(120);
  try { await page.waitForFunction(index => Number(document.querySelector('.chapter-item.current .chapter-index')?.textContent) === index + 1, index, { timeout: 5000 }); }
  catch (error) {
    console.log('Chapter movement diagnostic', await page.evaluate(expected => ({ expected, current: document.querySelector('.chapter-item.current')?.textContent, scroll: document.querySelector('.reading-canvas')?.scrollTop, sections: [...document.querySelectorAll('.continuous-chapter')].map(el => ({ index: el.dataset.chapterIndex, top: el.getBoundingClientRect().top, height: el.offsetHeight })), requests: window.__requests?.slice(-12) }), index));
    throw error;
  }
}
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true });
  const p = await fixture();
  assert.equal(await p.locator('.book-card').count(), 0); // Reader is open; inspect persisted shelf below.
  assert.equal(await p.locator('.continuous-stream').count(), 0);
  assert.equal(await p.locator('.pagination').count(), 1);
  assert.match(await current(p).textContent(), /第148章/);
  check('Existing preferences keep normal reading with chapter navigation');
  await enable(p);
  assert.equal(await p.locator('.continuous-chapter').count(), 5);
  assert.equal(await p.locator('.pagination').count(), 0);
  await scrollChapter(p, 148);
  assert.match(await current(p).textContent(), /第149章/);
  assert.equal(await p.locator('.continuous-chapter').count(), 5);
  await p.waitForTimeout(350);
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('tomato-reader-v01:progress'))['continuous-test'].chapterIndex), 148);
  check('Scrolling into the next chapter updates the directory and saved chapter without a click');
  const before = await p.locator('[data-chapter-index="148"]').evaluate(el => el.getBoundingClientRect().top);
  await p.waitForTimeout(100);
  assert.ok(Math.abs(await p.locator('[data-chapter-index="148"]').evaluate(el => el.getBoundingClientRect().top) - before) < 2);
  await scrollChapter(p, 147);
  check('Scrolling back enters the previous chapter and window trimming preserves the text anchor');
  for (let i = 148; i < 156; i++) await scrollChapter(p, i);
  assert.equal(await p.locator('.continuous-chapter').count(), 5);
  assert.equal(await p.locator('[data-chapter-index="147"]').count(), 0);
  check('After many chapter boundaries the DOM still contains only five chapters');
  await p.locator('.chapter-item').nth(0).click();
  await p.waitForFunction(() => document.querySelector('.chapter-item.current .chapter-index')?.textContent === '01');
  await p.waitForTimeout(200);
  assert.equal(await p.locator('.continuous-chapter').count(), 3);
  assert.ok(Math.abs(await p.locator('[data-chapter-index="0"]').evaluate(el => el.getBoundingClientRect().top - document.querySelector('.reading-canvas').getBoundingClientRect().top)) < 2);
  await p.locator('.chapter-item').nth(299).click();
  await p.waitForTimeout(200);
  assert.match(await current(p).textContent(), /第300章/);
  assert.equal(await p.locator('.continuous-chapter').count(), 3);
  await p.getByText('— 全书完 —', { exact: true }).waitFor();
  check('Directory jumps reach exact first/last chapter boundaries without phantom chapters');
  await p.locator('.chapter-item').nth(147).click();
  await scrollChapter(p, 147, 900);
  await p.waitForTimeout(400);
  const oldRatio = await p.evaluate(() => JSON.parse(localStorage.getItem('tomato-reader-v01:progress'))['continuous-test'].scrollRatio);
  await p.getByRole('button', { name: '返回书架', exact: true }).click();
  assert.equal(await p.locator('.book-card').count(), 1);
  await p.reload();
  await p.locator('.book-card').first().waitFor();
  assert.equal(await p.locator('.book-card').count(), 1);
  await p.getByRole('button', { name: '阅读 连续阅读测试', exact: true }).click();
  await p.locator('.continuous-stream').waitFor();
  await p.waitForTimeout(450);
  const newRatio = await p.evaluate(() => JSON.parse(localStorage.getItem('tomato-reader-v01:progress'))['continuous-test'].scrollRatio);
  assert.ok(Math.abs(oldRatio - newRatio) < .005, `${oldRatio} vs ${newRatio}`);
  assert.match(await current(p).textContent(), /第148章/);
  check('Restart retains continuous mode and chapter-relative position; built-in samples are absent');
  await p.getByTitle('阅读设置', { exact: true }).click();
  await p.getByLabel('阅读模式', { exact: true }).selectOption('normal');
  await p.getByRole('button', { name: '关闭阅读偏好', exact: true }).click();
  assert.equal(await p.locator('.continuous-stream').count(), 0);
  assert.equal(await p.locator('.pagination').count(), 1);
  check('Switching back restores ordinary chapter mode');
  await enable(p);
  await p.getByTitle('听书与自动翻页').click();
  await p.getByRole('button', { name: '自动阅读', exact: true }).click();
  await p.getByRole('button', { name: '平滑滚动', exact: true }).click();
  await p.getByLabel('自动滚动速度', { exact: true }).fill('80');
  await p.getByRole('button', { name: '收起面板', exact: true }).click();
  await p.locator('[data-chapter-index="148"]').evaluate(section => {
    const canvas = document.querySelector('.reading-canvas');
    canvas.scrollTop += section.getBoundingClientRect().top - canvas.getBoundingClientRect().top - 100;
  });
  await p.waitForFunction(() => document.querySelector('.chapter-item.current .chapter-index')?.textContent === '149');
  // Trimming a chapter above the viewport intentionally reduces scrollTop.
  // Assert actual text movement after that trim instead of a global offset.
  await p.waitForFunction(() => !document.querySelector('[data-chapter-index="145"]'));
  const autoBefore = await p.locator('[data-chapter-index="148"]').evaluate(el => el.getBoundingClientRect().top);
  await p.waitForFunction(top => document.querySelector('[data-chapter-index="148"]').getBoundingClientRect().top < top - 2, autoBefore);
  await p.locator('.audio-mini-pill').getByTitle('停止', { exact: true }).click();
  check('Automatic scrolling crosses a continuous chapter boundary and keeps moving');
  await p.close();

  const empty = await browser.newPage();
  empty.on('pageerror', e => errors.push(e.message));
  await empty.goto(`http://127.0.0.1:${port}`);
  await empty.getByRole('button', { name: '去找一本书', exact: true }).click();
  await empty.locator('.discovery-screen').waitFor();
  await empty.close();
  check('A fresh empty shelf has no samples and the start action opens discovery');

  const o = await fixture(true);
  await o.evaluate(() => { window.__fail = 'continuous-149'; window.__hold = 'continuous-146'; });
  await enable(o);
  await o.waitForFunction(() => window.__release && document.querySelector('[data-chapter-index="148"] .story-content'));
  const calls = await o.evaluate(() => window.__requests);
  assert.equal(calls.filter(id => id === 'continuous-147').length, 1);
  assert.ok(calls.every(id => Math.abs(Number(id.split('-').pop()) - 147) <= 2));
  const anchor = await o.locator('[data-chapter-index="147"]').evaluate(el => el.getBoundingClientRect().top);
  await o.evaluate(() => window.__release());
  await o.locator('[data-chapter-index="146"] .story-content').waitFor();
  assert.ok(Math.abs(await o.locator('[data-chapter-index="147"]').evaluate(el => el.getBoundingClientRect().top) - anchor) < 2);
  await o.waitForTimeout(350);
  assert.equal(await o.evaluate(() => JSON.parse(localStorage.getItem('tomato-reader-v01:progress'))['continuous-test'].chapterIndex), 147);
  check('Official prefetch is limited to two neighbouring chapters, deduplicates the current request, and preserves position when preceding text arrives');
  await o.getByRole('button', { name: '重试第 150 章', exact: true }).waitFor();
  await o.evaluate(() => { window.__fail = null; });
  await o.getByRole('button', { name: '重试第 150 章', exact: true }).click();
  await o.locator('[data-chapter-index="149"] .story-content').waitFor();
  await scrollChapter(o, 148, 300);
  await o.waitForTimeout(350);
  assert.equal(await o.evaluate(() => JSON.parse(localStorage.getItem('tomato-reader-v01:progress'))['continuous-test'].chapterIndex), 148);
  check('Failed prefetch exposes a retry; recovering it does not advance reading progress until actually scrolled into');
  for (let i = 149; i <= 180; i++) {
    await o.locator(`[data-chapter-index="${i}"] .story-content`).waitFor();
    await scrollChapter(o, i, 200);
  }
  await o.getByRole('button', { name: '返回书架', exact: true }).click();
  await o.getByRole('button', { name: '阅读 连续阅读测试', exact: true }).click();
  await o.locator('.continuous-stream').waitFor();
  const cached = await o.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('tomato-reader-library', 1);
    request.onsuccess = () => { const db = request.result, tx = db.transaction('books'); const result = tx.objectStore('books').getAll(); tx.oncomplete = () => { db.close(); resolve(result.result.flatMap(b => b.source === 'official' ? b.chapters : []).filter(c => c.content).length); }; tx.onabort = reject; };
  }));
  assert.ok(cached <= 24, String(cached));
  await o.locator('.chapter-item').nth(147).click();
  await o.locator('[data-chapter-index="147"] .story-content').waitFor();
  assert.ok(await o.evaluate(() => window.__requests.filter(id => id === 'continuous-147').length >= 2));
  check('Long continuous reading retains at most 24 cached official bodies and re-fetches an evicted chapter without losing its directory position');
  await mkdir('test-output', { recursive: true });
  await o.screenshot({ path: 'test-output/continuous-reading.png' });
  assert.deepEqual(errors, []);
  console.log(`${passed} continuous reading checks passed; official service was mocked, no account writes.`);
} finally { await browser?.close(); server.kill(); }
