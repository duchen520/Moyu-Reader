import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { installRankingMock } from './ranking-fixture.mjs';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1494', '--strictPort'], { stdio: 'ignore' });
let browser, passed = 0;
const errors = [];
const check = name => { passed++; console.log('PASS ' + name); };
async function fixture() {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.isTauri = true; window.__calls = [];
    window.__TAURI_INTERNALS__ = { invoke: async command => {
      window.__calls.push({ command });
      if (command === 'official_account') return null;
      if (command === 'official_cancel_login') return;
      throw Error('Unexpected command ' + command);
    } };
  });
  await installRankingMock(page);
  await page.route('https://**/*', route => route.abort());
  await page.goto('http://127.0.0.1:1494');
  return page;
}
const rankings = page => page.locator('.side-nav button').filter({ hasText: '排行榜单' }).click();
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:1494')).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  {
    const page = await fixture(); await rankings(page); await page.locator('.ranking-card').nth(9).waitFor();
    assert.equal(await page.locator('.ranking-card').count(), 10);
    assert.ok((await page.locator('.leaderboard-hero').textContent()).includes('按日更新'));
    assert.ok((await page.locator('.section-subtitle').textContent()).includes('官方版本'));
    assert.equal(await page.locator('.metric-score').count(), 0);
    check('Online initial page shows official update timing and does not invent missing scores');
    await page.getByRole('button', { name: '加载更多榜单作品', exact: true }).click(); await page.locator('.ranking-card').nth(19).waitFor();
    const request = await page.evaluate(() => window.__calls.filter(c => c.command === 'official_rankings').at(-1).args);
    assert.equal(request.offset, 10); assert.equal(request.version, '1792086600');
    assert.equal((await page.locator('.plain-rank').allTextContents()).at(-1), '20');
    check('Load more passes the prior official version and preserves continuous ranking positions');
    await page.evaluate(() => window.__rankFailOffset = 20);
    await page.getByRole('button', { name: '加载更多榜单作品', exact: true }).click();
    await page.getByText('模拟榜单网络故障', { exact: false }).waitFor();
    assert.equal(await page.locator('.ranking-card').count(), 20);
    await page.evaluate(() => window.__rankFailOffset = undefined);
    await page.getByRole('button', { name: '重试加载榜单', exact: true }).click(); await page.locator('.ranking-card').nth(29).waitFor();
    assert.equal(await page.locator('.ranking-card').count(), 30);
    check('Pagination failure preserves existing books and retries the failed page');
    await page.getByRole('button', { name: '加载更多榜单作品', exact: true }).click(); await page.locator('.ranking-card').nth(34).waitFor();
    assert.equal(await page.getByRole('button', { name: '加载更多榜单作品', exact: true }).count(), 0);
    check('The last partial page stops loading at the actual available total');
    await page.getByLabel('榜单分类').selectOption('8'); await page.getByText('男频-8-2-1', { exact: true }).waitFor();
    await page.getByLabel('榜单类型').selectOption('1'); await page.getByText('男频-8-1-1', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '女频榜', exact: true }).click(); await page.getByText('女频-24-1-1', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('榜单分类').inputValue(), '24');
    check('Gender, genre and reading/new-book filters request the matching official list');
    await page.evaluate(() => window.__rankFail = true);
    await page.getByRole('button', { name: '刷新榜单', exact: true }).click(); await page.getByText('模拟榜单网络故障', { exact: false }).waitFor();
    assert.equal(await page.locator('.ranking-card').count(), 10);
    check('Refresh failure retains the previous list and reports the failure');
    await page.evaluate(() => window.__rankFail = false);
    await page.getByRole('button', { name: '重试加载榜单', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.ranking-status[role=alert]'));
    await page.getByRole('button', { name: '阅读设置', exact: true }).click(); await rankings(page);
    await page.getByText('女频-24-1-1', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('榜单类型').inputValue(), '1');
    check('Returning to rankings retains the selected filters and recent loaded results');
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_sync_progress').length), 0);
    check('Ranking reads, refresh and pagination never upload reading progress');
    await mkdir('test-output', { recursive: true }); await page.screenshot({ path: 'test-output/online-rankings-0.5.4.png' }); await page.close();
  }
  {
    const page = await fixture(); await page.evaluate(() => window.__rankHold = true); await rankings(page);
    await page.waitForFunction(() => window.__rankingReleases.length > 0);
    await page.evaluate(() => window.__rankHold = false); await page.getByLabel('榜单分类').selectOption('8');
    await page.getByText('男频-8-2-1', { exact: true }).waitFor();
    await page.evaluate(() => window.__rankingReleases.forEach(r => r.release())); await page.waitForTimeout(200);
    assert.equal(await page.getByText('十日终焉', { exact: true }).count(), 0);
    check('A delayed old category response cannot overwrite the newly selected category'); await page.close();
  }
  {
    const page = await fixture(); await rankings(page); await page.locator('.ranking-card').nth(9).waitFor();
    await page.evaluate(() => window.__rankVersionOverride = '1792173000');
    await page.getByRole('button', { name: '加载更多榜单作品', exact: true }).click();
    await page.getByText('官方榜单已更新，请刷新后重新加载', { exact: false }).waitFor();
    assert.equal(await page.locator('.ranking-card').count(), 10);
    check('A new official version cannot be mixed into an existing paginated list'); await page.close();
  }
  {
    const page = await fixture(); await page.evaluate(() => window.__rankCatalogFail = true); await rankings(page);
    await page.getByText('分类读取失败：模拟分类读取失败', { exact: false }).waitFor();
    assert.equal(await page.locator('.ranking-card').count(), 0);
    await page.evaluate(() => window.__rankCatalogFail = false); await page.getByRole('button', { name: '重试读取分类', exact: true }).click();
    await page.locator('.ranking-card').nth(9).waitFor();
    check('Category failure provides retry without substituting static recommendations'); await page.close();
  }
  assert.deepEqual(errors, []); check('Online ranking flows produce no unhandled page errors');
  console.log(`${passed} online ranking UI checks passed (mock services).`);
} finally { await browser?.close(); server.kill(); }
