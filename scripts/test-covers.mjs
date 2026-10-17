import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1507', '--strictPort'], { stdio: 'ignore' });
let browser, passed = 0; const errors = [];
const check = name => { passed++; console.log('PASS ' + name); };
async function fixture(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(options => {
    window.isTauri = true; window.__calls = []; window.__coverFail = !!options.fail; window.__coverHold = !!options.hold; window.__release = [];
    window.__TAURI_INTERNALS__ = { transformCallback() { return 1; }, unregisterCallback() {}, invoke: async (command, args = {}) => {
      window.__calls.push({ command, args });
      if (command === 'official_account') return null;
      if (command === 'official_cancel_login') return;
      if (command === 'official_cover') {
        if (window.__coverHold && args.bookId === '6982529841564224526') await new Promise(resolve => window.__release.push(resolve));
        if (window.__coverFail) throw Error('测试：官方暂未提供封面');
        return { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', cached: false, bytes: 68 };
      }
      if (command === 'official_search') return { books: [{ id: '123456789', title: '搜索作品', author: '作者', coverUrl: window.__searchUrl ?? 'https://p3.fqnovelpic.com/sample.image?x-signature=one' }], hasMore: false, nextOffset: 10 };
      throw Error('Unexpected command ' + command);
    } };
  }, options);
  await page.goto('http://127.0.0.1:1507');
  await page.locator('.side-nav button').filter({ hasText: '找书发现' }).click();
  return page;
}
const calls = page => page.evaluate(() => window.__calls.filter(c => c.command === 'official_cover'));
async function loaded(cover) { await cover.scrollIntoViewIfNeeded(); await cover.locator('img').waitFor(); await cover.locator('img').evaluate(img => img.decode()); }
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:1507')).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  {
    const page = await fixture(); await loaded(page.locator('.rec-cover').first());
    assert.ok((await calls(page)).length > 0); assert.ok((await calls(page)).length < await page.locator('.rec-cover').count());
    check('Recommendations with only book IDs load native images near the viewport');
    for (const cover of await page.locator('.rec-cover').all()) { await cover.scrollIntoViewIfNeeded(); await loaded(cover); }
    assert.ok((await calls(page)).every(c => c.args.url === '' && /^\d{5,24}$/.test(c.args.bookId)));
    assert.equal(await page.locator('.rec-cover .official-cover-fallback').count(), 0);
    check('Every curated recommendation requests the matching official book cover without a hardcoded URL');
    const before = (await calls(page)).length;
    await page.locator('.side-nav button').filter({ hasText: '本地书架' }).click();
    await page.locator('.side-nav button').filter({ hasText: '找书发现' }).click();
    await loaded(page.locator('.rec-cover').first()); assert.equal((await calls(page)).length, before);
    check('Revisiting discovery reuses successful cover requests'); await page.close();
  }
  {
    const page = await fixture({ fail: true }); await page.locator('.rec-cover .official-cover-fallback').first().waitFor();
    assert.equal(await page.locator('.rec-cover img').count(), 0);
    await page.evaluate(() => { window.__coverFail = false; });
    await page.locator('.side-nav button').filter({ hasText: '本地书架' }).click();
    await page.locator('.side-nav button').filter({ hasText: '找书发现' }).click();
    await loaded(page.locator('.rec-cover').first());
    check('Failed covers show a placeholder and a later visit retries instead of caching the failure'); await page.close();
  }
  {
    const page = await fixture({ hold: true }); await page.waitForFunction(() => window.__release.length > 0);
    await page.evaluate(() => { window.__coverHold = false; });
    await page.getByRole('button', { name: '悬疑惊悚 / 脑洞', exact: true }).click();
    await loaded(page.locator('.rec-cover').first());
    await page.evaluate(() => window.__release.forEach(resolve => resolve()));
    await loaded(page.locator('.rec-cover').nth(1));
    assert.equal(await page.locator('.rec-cover img').first().getAttribute('alt'), '十日终焉 官方封面');
    assert.equal(await page.locator('.rec-cover img').nth(1).getAttribute('alt'), '诡舍 官方封面');
    check('Changing category while old covers are loading keeps cover identity tied to the new book'); await page.close();
  }
  {
    const page = await fixture();
    const search = async () => { await page.getByLabel('搜索正版小说').fill('搜索作品'); await page.getByRole('button', { name: '搜索小说', exact: true }).click(); await loaded(page.locator('.search-book-cover-wrap').first()); };
    await search();
    let before = (await calls(page)).filter(c => c.args.bookId === '123456789').length;
    await page.evaluate(() => { window.__searchUrl = 'https://p3.fqnovelpic.com/sample.image?x-signature=two'; });
    await search();
    assert.equal((await calls(page)).filter(c => c.args.bookId === '123456789').length, before);
    await page.evaluate(() => { window.__searchUrl = 'https://p3.fqnovelpic.com/changed.image?x-signature=two'; });
    await search();
    assert.equal((await calls(page)).filter(c => c.args.bookId === '123456789').length, before + 1);
    check('Search images still decode, renewed signatures reuse cached images, and changed resources reload');
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_sync_progress').length), 0); await page.close();
  }
  assert.deepEqual(errors, []); check('No unhandled errors or cloud progress writes');
  console.log(`${passed} cover checks passed (mock native services).`);
} finally { await browser?.close(); server.kill(); }
