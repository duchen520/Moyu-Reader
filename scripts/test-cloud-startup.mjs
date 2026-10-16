import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1491', '--strictPort'], { stdio: 'ignore' });
let browser, passed = 0;
const errors = [];
const check = name => { passed++; console.log('PASS ' + name); };
const accountPage = page => page.getByRole('button', { name: '账号管理', exact: true }).click();
const shelfPage = page => page.locator('.side-nav button').filter({ hasText: '云端书架' }).click();
async function fixture(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(options => {
    window.isTauri = true; window.__calls = [];
    window.__user = { id: '11111', name: '测试账号甲' };
    Object.assign(window, { __holdAccount: !!options.holdAccount, __holdShelf: !!options.holdShelf,
      __accountFail: !!options.accountFail, __shelfFail: !!options.shelfFail });
    window.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      window.__calls.push({ command, args });
      if (command === 'official_account') {
        if (window.__holdAccount) await new Promise(resolve => window.__releaseAccount = resolve);
        if (window.__accountFail) throw Error('模拟账号网络故障');
        return window.__user;
      }
      if (command === 'official_bookshelf') {
        const user = window.__user;
        if (window.__holdShelf) await new Promise(resolve => window.__releaseShelf = resolve);
        if (window.__shelfFail) throw Error('模拟书架网络故障');
        return { entries: [{ id: user.id === '11111' ? '123456789' : '987654321', title: user.name + '的藏书', author: '测试作者',
          progressState: 'available', lastReadTitle: '第一章', lastReadItemId: '10001' }] };
      }
      if (command === 'official_logout') {
        if (window.__holdLogout) await new Promise(resolve => window.__releaseLogout = resolve);
        window.__user = null; return;
      }
      if (command === 'official_cancel_login') return;
      throw Error('Unexpected mock command ' + command);
    } };
  }, options);
  await page.goto('http://127.0.0.1:1491');
  return page;
}
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:1491')).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  {
    const page = await fixture({ holdAccount: true, holdShelf: true });
    await page.waitForFunction(() => !!window.__releaseAccount);
    assert.equal(await page.locator('.cloud-status-text strong').textContent(), '正在检查账号…');
    assert.equal(await page.locator('.library-screen').count(), 1);
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_account').length), 1);
    check('Startup checks account in the background once, without showing a false logged-out state');
    await page.locator('input[type=file]').setInputFiles({ name: '后台加载测试.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 测试\n本机阅读不等待云端账号。') });
    await page.getByRole('button', { name: '阅读 后台加载测试', exact: true }).click();
    await page.locator('.story-content p').first().waitFor();
    await page.evaluate(() => { window.__holdAccount = false; window.__releaseAccount(); });
    await page.waitForFunction(() => !!window.__releaseShelf);
    assert.equal(await page.locator('.reader-layout').count(), 1);
    check('Local reading remains usable while account and shelf requests are pending');
    await shelfPage(page);
    await page.getByText('正在后台读取官方书架、封面和章节进度…', { exact: true }).waitFor();
    await page.evaluate(() => { window.__holdShelf = false; window.__releaseShelf(); });
    await page.locator('.official-shelf button').waitFor();
    await accountPage(page);
    assert.equal(await page.locator('.account-screen .official-shelf').count(), 0);
    assert.equal(await page.getByLabel('搜索正版小说').count(), 0);
    assert.equal(await page.getByLabel('打开正版作品').count(), 0);
    check('Account management contains account controls without shelf or search forms');
    await shelfPage(page);
    assert.equal(await page.getByRole('button', { name: '退出账号', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: '云端书架', exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_bookshelf').length), 1);
    check('Cloud shelf reuses the startup result across navigation and contains no logout controls');
    await page.getByLabel('筛选云端书架').fill('不存在的书');
    await page.getByText('书架中没有匹配的作品。', { exact: true }).waitFor();
    await page.getByLabel('筛选云端书架').fill('测试作者');
    assert.equal(await page.locator('.official-shelf button').count(), 1);
    check('Cloud shelf filters cached titles and authors without extra requests');
    await mkdir('test-output', { recursive: true });
    await page.screenshot({ path: 'test-output/cloud-shelf-0.5.2.png' });
    await accountPage(page); await page.screenshot({ path: 'test-output/account-0.5.2.png' });
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_sync_progress').length), 0);
    check('Startup, shelf loading and page navigation never upload reading progress'); await page.close();
  }
  {
    const page = await fixture({ accountFail: true });
    await page.getByText('账号状态待确认', { exact: true }).waitFor();
    await accountPage(page);
    await page.getByText('账号检查失败：模拟账号网络故障', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_bookshelf').length), 0);
    await page.evaluate(() => window.__accountFail = false);
    await page.getByRole('button', { name: '重新检查账号', exact: true }).click();
    await page.getByRole('button', { name: '退出账号', exact: true }).waitFor();
    await shelfPage(page); await page.locator('.official-shelf button').waitFor();
    check('Account network failure remains distinct from logged out; retry resumes shelf prefetch'); await page.close();
  }
  {
    const page = await fixture({ shelfFail: true }); await shelfPage(page);
    await page.getByText('书架读取失败：模拟书架网络故障', { exact: false }).waitFor();
    await page.evaluate(() => window.__shelfFail = false);
    await page.getByRole('button', { name: '刷新官方书架', exact: true }).click();
    await page.locator('.official-shelf button').waitFor();
    await page.evaluate(() => window.__shelfFail = true);
    await page.getByRole('button', { name: '刷新官方书架', exact: true }).click();
    await page.getByText('书架读取失败：模拟书架网络故障', { exact: false }).waitFor();
    assert.equal(await page.locator('.official-shelf button').count(), 1);
    check('Shelf errors can be retried and later failures preserve the existing shelf'); await page.close();
  }
  {
    const page = await fixture({ holdShelf: true }); await page.waitForFunction(() => !!window.__releaseShelf);
    await accountPage(page); await page.getByRole('button', { name: '退出账号', exact: true }).click();
    await page.getByRole('button', { name: '扫码登录', exact: true }).waitFor();
    await page.evaluate(() => { window.__holdShelf = false; window.__releaseShelf(); });
    await shelfPage(page); await page.waitForTimeout(200);
    assert.equal(await page.locator('.official-shelf button').count(), 0);
    check('A shelf response from before logout cannot restore the previous account books');
    await page.evaluate(() => window.__user = { id: '22222', name: '测试账号乙' });
    await accountPage(page); await page.getByRole('button', { name: '重新检查账号', exact: true }).click();
    await page.getByRole('button', { name: '退出账号', exact: true }).waitFor();
    await shelfPage(page); await page.locator('.official-shelf button').waitFor();
    assert.ok((await page.locator('.official-shelf').textContent()).includes('测试账号乙的藏书'));
    assert.ok(!(await page.locator('.official-shelf').textContent()).includes('测试账号甲的藏书'));
    check('A different account loads a fresh shelf without mixing previous account results'); await page.close();
  }
  {
    const page = await fixture(); await accountPage(page);
    await page.getByRole('button', { name: '退出账号', exact: true }).waitFor();
    await page.evaluate(() => window.__holdLogout = true);
    await page.getByRole('button', { name: '退出账号', exact: true }).click();
    await page.waitForFunction(() => !!window.__releaseLogout); await shelfPage(page);
    await page.evaluate(() => window.__releaseLogout());
    await page.getByRole('button', { name: '前往账号管理', exact: true }).waitFor();
    assert.equal(await page.locator('.official-shelf button').count(), 0);
    check('Logout updates shared account state even after leaving account management'); await page.close();
  }
  assert.deepEqual(errors, []); check('No unhandled errors in account and background shelf scenarios');
  console.log(`${passed} background account and cloud shelf checks passed (mock services).`);
} finally { await browser?.close(); server.kill(); }
