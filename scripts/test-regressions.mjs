import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1483', '--strictPort'], { stdio: 'ignore' });
let browser, passed = 0;
const errors = [];
const check = name => { passed++; console.log('PASS ' + name); };
async function pageFixture({ blockChapter = false, saved = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ blockChapter, saved }) => {
    window.isTauri = true;
    window.__calls = [];
    window.__hold = { chapter: blockChapter };
    window.__release = {};
    window.__remote = { '123456789': '10001' };
    const pause = async key => { if (window.__hold[key]) await new Promise(resolve => { window.__release[key] = () => { window.__hold[key] = false; resolve(); }; }); };
    if (saved) localStorage.setItem('tomato-reader-v01:progress', JSON.stringify({ '123456789': { chapterIndex: 0, scrollRatio: .65, paragraphIndex: 20, updatedAt: 1 } }));
    window.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      window.__calls.push({ command, args });
      if (command === 'official_account') { await pause('account'); return { id: '55555', name: '回归账号' }; }
      if (command === 'official_cancel_login') return;
      if (command === 'official_bookshelf') return { entries: [] };
      if (command === 'official_book') {
        await pause('book');
        return { id: args.id, title: '回归作品', author: '作者', source: 'official', description: '', coverStyle: 0, addedAt: 0,
          chapters: ['10001', '10002', '10003'].map((id, i) => ({ id, title: `测试章${i + 1}`, content: '', loaded: false })) };
      }
      if (command === 'official_read_progress') {
        await pause('progress');
        if (window.__progressFail) throw '模拟云端读取失败';
        return Object.entries(window.__remote).map(([book_id, item_id]) => ({ book_id, item_id, read_timestamp: 1792070981 }));
      }
      if (command === 'official_chapter') {
        await pause('chapter');
        return { id: args.id, title: `测试章${Number(args.id) - 10000}`, content: Array.from({ length: 100 }, (_, i) => `<p>段落${i}：${'用于阅读位置验证的长文本。'.repeat(10)}</p>`).join(''), loaded: true };
      }
      if (command === 'official_read_history') return ['10001', '10003'];
      if (command === 'official_sync_progress') {
        await pause('sync'); window.__remote[args.bookId] = args.itemId; return { confirmed: true };
      }
      throw new Error('Unexpected mock command ' + command);
    } };
  }, { blockChapter, saved });
  await page.goto('http://127.0.0.1:1483');
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  await page.getByRole('button', { name: '退出账号', exact: true }).waitFor();
  return page;
}
async function open(page, id = '123456789') {
  await page.getByRole('button', { name: /找书发现/ }).click();
  await page.getByRole('button', { name: '通过番茄链接或书籍ID直接打开作品' }).click();
  await page.getByLabel('打开正版作品').fill(id);
  await page.getByRole('button', { name: '打开作品', exact: true }).click();
}
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('tomato-reader-v01:progress'))['123456789']);

try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:1483')).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true, ...(process.env.TOMATO_TEST_BROWSER ? { executablePath: process.env.TOMATO_TEST_BROWSER } : {}), args: ['--no-sandbox'] });
  {
    const page = await pageFixture({ blockChapter: true });
    await open(page); await page.getByText('正在读取官方正文…', { exact: true }).waitFor();
    await page.getByRole('button', { name: '返回书架', exact: true }).click();
    assert.equal((await stored(page)).scrollRatio, .65);
    assert.equal((await stored(page)).paragraphIndex, 20);
    check('Leaving an unloaded chapter preserves the previous reading position');
    await page.close();
  }
  {
    const page = await pageFixture(); await open(page); await page.locator('.story-content p').first().waitFor();
    await page.evaluate(() => {
      const canvas = document.querySelector('.reading-canvas');
      canvas.scrollTop = (canvas.scrollHeight - canvas.clientHeight) * .4;
      canvas.dispatchEvent(new Event('scroll'));
      [...document.querySelectorAll('.side-nav button')].find(b => b.textContent.includes('阅读设置')).click();
    });
    await page.locator('.settings-screen').waitFor();
    assert.ok(Math.abs((await stored(page)).scrollRatio - .4) < .01);
    check('Sidebar navigation flushes a scroll update before the debounce expires'); await page.close();
  }
  for (const stage of ['book', 'account']) {
    const page = await pageFixture();
    await page.evaluate(stage => { window.__hold[stage] = true; }, stage);
    await open(page); await page.waitForFunction(stage => !!window.__release[stage], stage);
    await page.getByRole('button', { name: '阅读设置', exact: true }).click();
    await page.evaluate(stage => window.__release[stage](), stage); await page.waitForTimeout(300);
    assert.equal(await page.locator('.settings-screen').count(), 1);
    assert.equal(await page.locator('.reader-layout').count(), 0);
    check(`Late ${stage} response cannot reopen a reader after navigation`); await page.close();
  }
  {
    const page = await pageFixture(); await open(page); await page.locator('.story-content p').first().waitFor();
    await page.evaluate(() => { window.__hold.sync = true; });
    await page.locator('.chapter-item').nth(1).click(); await page.locator('.story-content p').first().waitFor();
    await page.getByRole('button', { name: '上传本章进度', exact: true }).click();
    await page.getByRole('button', { name: '确认上传本章', exact: true }).click();
    await page.waitForFunction(() => !!window.__release.sync);
    await page.locator('.chapter-item').nth(2).click(); await page.locator('.story-content p').first().waitFor();
    await page.waitForTimeout(3300);
    await page.evaluate(() => window.__release.sync());
    await page.waitForFunction(() => window.__remote['123456789'] === '10002');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_sync_progress').length), 1);
    assert.equal(await page.locator('.page-paper h1').textContent(), '测试章3');
    check('Slow manual upload writes only the confirmed chapter and never queues an automatic upload'); await page.close();
  }
  {
    const page = await pageFixture(); await open(page); await page.locator('.story-content p').first().waitFor();
    await page.evaluate(() => { window.__hold.sync = true; });
    await page.locator('.chapter-item').nth(1).click(); await page.locator('.story-content p').first().waitFor();
    await page.getByRole('button', { name: '上传本章进度', exact: true }).click();
    await page.getByRole('button', { name: '确认上传本章', exact: true }).click(); await page.waitForFunction(() => !!window.__release.sync);
    await page.getByRole('button', { name: '账号管理', exact: true }).click();
    await page.getByRole('button', { name: '退出账号', exact: true }).waitFor();
    await open(page, '987654321'); await page.locator('.story-content p').first().waitFor();
    await page.getByText('官方未返回本书章节进度', { exact: false }).waitFor();
    await page.evaluate(() => window.__release.sync()); await page.waitForTimeout(3400);
    assert.equal(await page.evaluate(() => window.__remote['987654321']), undefined);
    assert.ok((await page.locator('.sync-bar').textContent()).includes('自动上传暂停'));
    check('Old sync completion cannot enable automatic uploads for a newly opened book'); await page.close();
  }
  for (const trigger of ['focus', 'manual']) {
    const page = await pageFixture(); await open(page); await page.locator('.story-content p').first().waitFor();
    await page.evaluate(() => { window.__remote['123456789'] = '10003'; });
    if (trigger === 'focus') await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    else await page.getByRole('button', { name: '读取云端进度', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.ok((await page.getByRole('dialog').textContent()).includes('测试章3'));
    assert.ok((await page.getByRole('dialog').textContent()).includes('记录时间'));
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_sync_progress').length), 0);
    await page.getByRole('button', { name: '采用云端：第 3 章', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.page-paper h1')?.textContent === '测试章3');
    check(`${trigger} refresh discovers another device's new chapter without uploading local progress`);
    await page.close();
  }
  {
    const page = await pageFixture(); await open(page); await page.locator('.story-content p').first().waitFor();
    await page.locator('.chapter-item').nth(1).click(); await page.locator('.story-content p').first().waitFor();
    const reads = await page.evaluate(() => window.__calls.filter(c => c.command === 'official_read_progress').length);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(reads => window.__calls.filter(c => c.command === 'official_read_progress').length > reads, reads);
    await page.waitForTimeout(200);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.locator('.page-paper h1').textContent(), '测试章2');
    check('An unchanged server record does not rewind intentional local reading on focus'); await page.close();
  }
  {
    const page = await pageFixture(); await open(page); await page.locator('.story-content p').first().waitFor();
    await page.evaluate(() => { window.__progressFail = true; });
    await page.getByRole('button', { name: '读取云端进度', exact: true }).click();
    await page.getByText('云端读取失败，自动上传暂停：模拟云端读取失败', { exact: false }).waitFor();
    await page.locator('.chapter-item').nth(1).click(); await page.locator('.story-content p').first().waitFor();
    await page.waitForTimeout(3300);
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_sync_progress').length), 0);
    check('A failed cloud refresh pauses automatic uploads instead of assuming the old chapter is current'); await page.close();
  }
  {
    const page = await pageFixture(); await open(page); await page.locator('.story-content p').first().waitFor();
    await page.evaluate(() => { window.__hold.progress = true; });
    await page.getByRole('button', { name: '读取云端进度', exact: true }).click();
    await page.waitForFunction(() => !!window.__release.progress);
    await page.locator('.side-nav').getByRole('button', { name: '阅读设置', exact: true }).click();
    await page.evaluate(() => { window.__remote['123456789'] = '10003'; window.__release.progress(); });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.settings-screen').count(), 1);
    assert.equal(await page.getByRole('dialog').count(), 0);
    check('A late cloud refresh cannot change pages or show a chapter dialog after navigation'); await page.close();
  }
  {
    const page = await pageFixture(); await open(page); await page.locator('.story-content p').first().waitFor();
    await page.locator('.chapter-item').nth(1).click(); await page.locator('.story-content p').first().waitFor();
    await page.waitForTimeout(3300);
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_sync_progress').length), 0);
    await page.getByRole('button', { name: '上传本章进度', exact: true }).click();
    await page.getByRole('button', { name: '取消上传', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__remote['123456789']), '10001');
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_sync_progress').length), 0);
    check('Reading and cancelling the upload confirmation never write old desktop progress to the server'); await page.close();
  }
  {
    const page = await pageFixture(); await open(page); await page.locator('.story-content p').first().waitFor();
    await page.locator('.chapter-item').nth(1).click(); await page.locator('.story-content p').first().waitFor();
    await page.getByRole('button', { name: '上传本章进度', exact: true }).click();
    await page.getByRole('button', { name: '确认上传本章', exact: true }).waitFor();
    await page.evaluate(() => { window.__remote['123456789'] = '10003'; });
    await page.getByRole('button', { name: '确认上传本章', exact: true }).click();
    await page.getByText('官网进度在确认后发生变化，本次未上传', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_sync_progress').length), 0);
    check('A phone progress change after confirmation is shown blocks the stale upload'); await page.close();
  }
  {
    const page = await pageFixture(); await open(page); await page.locator('.story-content p').first().waitFor();
    await page.getByRole('button', { name: '查看已读章节', exact: true }).click();
    await page.getByRole('dialog', { name: '从已读记录找回位置' }).waitFor();
    await page.getByLabel('搜索已读章节').fill('3');
    await page.getByRole('button', { name: '测试章3', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.page-paper h1')?.textContent === '测试章3');
    await page.waitForTimeout(3300);
    assert.equal(await page.evaluate(() => window.__remote['123456789']), '10001');
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_sync_progress').length), 0);
    check('Read-history recovery opens the exact chapter locally without uploading it'); await page.close();
  }
  assert.deepEqual(errors, []); check('Regression scenarios produce no unhandled browser errors');
  console.log(`${passed} regression UI checks passed (official services mocked)`);
} finally { await browser?.close(); server.kill(); }
