import { installRankingMock } from './ranking-fixture.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1489', '--strictPort'], { stdio: 'ignore' });
let browser, passed = 0;
const check = name => { passed++; console.log('PASS ' + name); };
const uploads = page => page.evaluate(() => window.__calls.filter(c => c.command === 'official_sync_progress'));
async function fixture() {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    window.isTauri = true; window.__calls = []; window.__remote = '111111'; window.__timestamp = 10;
    window.__holdProgress = false;
    window.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      window.__calls.push({ command, args });
      if (command === 'official_account') return { id: '12345', name: '模拟账号' };
      if (command === 'official_book') return { id: args.id, title: '自动上传测试', author: '模拟作者', description: '', source: 'official', coverStyle: 0, addedAt: 0,
        chapters: ['111111', '222222', '333333'].map((id, i) => ({ id, title: `测试第${i + 1}章`, content: '', loaded: false })) };
      if (command === 'official_chapter') return { id: args.id, title: `测试第${Number(args.id[0])}章`, content: '<p>模拟正文，仅测试进度逻辑。</p>', loaded: true };
      if (command === 'official_read_progress') {
        if (window.__holdProgress) await new Promise(r => window.__releaseProgress = r);
        if (window.__progressFail) throw Error('模拟读取失败');
        return window.__remote ? [{ book_id: '7143038691944959011', item_id: window.__remote, read_timestamp: window.__timestamp }] : [];
      }
      if (command === 'official_sync_progress') { window.__remote = args.itemId; window.__timestamp++; return { confirmed: true }; }
      if (command === 'official_cancel_login') return;
      if (command === 'official_bookshelf') return { entries: [] };
      throw Error('Unexpected mock command ' + command);
    } };
  });
  await page.route('https://**/*', route => route.abort());
  await installRankingMock(page);
  await page.goto('http://127.0.0.1:1489');
  return page;
}
async function settings(page) { await page.locator('.side-nav').getByRole('button', { name: '阅读设置', exact: true }).click(); }
async function enable(page) {
  await settings(page);
  await page.getByRole('switch', { name: '云端自动上传阅读进度' }).click();
  await assertEnabled(page, true);
}
async function assertEnabled(page, enabled) {
  assert.equal(await page.getByRole('switch', { name: '云端自动上传阅读进度' }).getAttribute('aria-checked'), String(enabled));
}
async function open(page) {
  await page.locator('button.nav-btn').filter({ hasText: '排行榜单' }).click();
  await page.locator('.ranking-card').first().locator('.primary-action-btn').click();
  await page.locator('.story-content p').first().waitFor();
}
async function jump(page, index = 1) {
  await page.locator('.chapter-item').nth(index).click();
  await page.locator('.page-paper h1').filter({ hasText: `测试第${index + 1}章` }).waitFor();
  await page.locator('.story-content p').first().waitFor();
}
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:1489')).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  {
    const page = await fixture(); await settings(page); await assertEnabled(page, false);
    await open(page); await jump(page); await page.waitForTimeout(5500);
    assert.equal((await uploads(page)).length, 0);
    check('Default is off: reading and changing chapters never upload'); await page.close();
  }
  {
    const page = await fixture(); await enable(page); await page.reload(); await settings(page); await assertEnabled(page, true);
    check('User choice persists after reload');
    await open(page);
    assert.equal(await page.locator('.sync-bar strong').textContent(), '自动上传已开启');
    assert.ok(!(await page.locator('.sync-bar').textContent()).includes('自动上传已关闭'));
    await jump(page);
    await page.waitForFunction(() => window.__calls.some(c => c.command === 'official_sync_progress'));
    assert.deepEqual((await uploads(page))[0].args, { bookId: '7143038691944959011', itemId: '222222', index: 1 });
    check('Enabled switch uploads the exact loaded chapter after dwell');
    await jump(page, 2); await settings(page);
    await page.getByRole('switch', { name: '云端自动上传阅读进度' }).click();
    await assertEnabled(page, false); await page.waitForTimeout(5500);
    assert.equal((await uploads(page)).length, 1);
    check('Disabling cancels the next scheduled chapter upload'); await page.close();
  }
  {
    const page = await fixture(); await enable(page); await open(page); await jump(page);
    await page.evaluate(() => { window.__remote = '333333'; window.__timestamp++; });
    await page.getByRole('button', { name: '采用本机：第 2 章', exact: true }).waitFor();
    assert.equal((await uploads(page)).length, 0);
    check('New phone progress pauses automatic uploading and asks which position to use');
    await page.getByRole('button', { name: '采用本机：第 2 章', exact: true }).click();
    await page.waitForFunction(() => window.__calls.some(c => c.command === 'official_sync_progress'));
    assert.equal((await uploads(page))[0].args.itemId, '222222');
    check('Explicitly choosing local progress resumes automatic uploading'); await page.close();
  }
  {
    const page = await fixture(); await enable(page); await open(page); await jump(page);
    await page.evaluate(() => { window.__holdProgress = true; });
    await page.waitForFunction(() => !!window.__releaseProgress);
    await page.getByTitle('阅读设置', { exact: true }).click();
    await page.getByRole('switch', { name: '云端自动上传阅读进度' }).click();
    assert.equal(await page.locator('.sync-bar strong').textContent(), '自动上传已关闭');
    assert.ok(!(await page.locator('.sync-bar').textContent()).includes('自动上传已开启'));
    await page.evaluate(() => window.__releaseProgress()); await page.waitForTimeout(300);
    assert.equal((await uploads(page)).length, 0);
    check('Disabling while cloud preflight is pending prevents the subsequent write'); await page.close();
  }
  {
    const page = await fixture(); await enable(page); await open(page); await jump(page);
    await page.evaluate(() => { window.__holdProgress = true; });
    await page.waitForFunction(() => !!window.__releaseProgress);
    await jump(page, 2);
    await page.evaluate(() => { window.__holdProgress = false; window.__releaseProgress(); });
    await page.waitForFunction(() => window.__calls.some(c => c.command === 'official_sync_progress'));
    assert.deepEqual((await uploads(page)).map(c => c.args.itemId), ['333333']);
    check('Changing chapters during preflight discards the stale chapter and uploads the new one'); await page.close();
  }
  {
    const page = await fixture(); await enable(page); await open(page); await jump(page);
    await page.evaluate(() => { window.__progressFail = true; }); await page.waitForTimeout(5500);
    assert.equal((await uploads(page)).length, 0);
    check('A cloud read failure never falls back to an unchecked upload'); await page.close();
  }
  console.log(`All ${passed} auto-upload checks passed (mock account only).`);
} finally { await browser?.close(); server.kill(); }
