import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

// Real desktop IPC and image decoding, independent profile, no reading/upload actions.
const label = process.env.TOMATO_COVER_LABEL ?? 'candidate';
const executable = process.env.TOMATO_NATIVE_EXE ?? resolve('src-tauri/target/release/tomato-reader.exe');
const app = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=1487',
  WEBVIEW2_USER_DATA_FOLDER: resolve(`test-output/covers-${label}-${Date.now()}`),
} });
let browser, page;
const report = { label, recommendations: [], queries: [], errors: [] };
try {
  for (let i = 0; i < 150; i++) {
    if (app.exitCode !== null) throw Error(`App exited: ${app.exitCode}`);
    try { if ((await fetch('http://127.0.0.1:1487/json/version')).ok) break; } catch {}
    await delay(200);
  }
  browser = await chromium.connectOverCDP('http://127.0.0.1:1487');
  page = browser.contexts()[0].pages()[0];
  page.on('pageerror', error => report.errors.push(error.message));
  await page.locator('.app-shell').waitFor();
  report.version = await page.locator('.side-bottom small').textContent();
  const observe = () => {
    const original = window.fetch.bind(window); window.__coverCalls = []; window.__searchBooks = []; window.__uploadCalls = 0;
    window.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const command = url.hostname === 'ipc.localhost' ? decodeURIComponent(url.pathname.slice(1)) : '';
      if (command === 'official_sync_progress') window.__uploadCalls++;
      const response = await original(input, options);
      if (command === 'official_cover') {
        const value = await response.clone().json();
        let args = {}; try { args = JSON.parse(options.body); } catch {}
        window.__coverCalls.push({ bookId: args.bookId, success: !!value.dataUrl, cached: value.cached, bytes: value.bytes,
          mime: typeof value.dataUrl === 'string' ? value.dataUrl.slice(0, value.dataUrl.indexOf(';')) : null,
          error: typeof value === 'string' ? value : null });
      }
      if (command === 'official_search' && response.ok) window.__searchBooks = (await response.clone().json()).books;
      return response;
    };
  };
  await page.addInitScript(observe);
  await page.evaluate(observe);
  await page.locator('.side-nav button').filter({ hasText: '找书发现' }).click();
  if (process.env.TOMATO_COVER_OBSERVE !== '1') {
    const cards = page.locator('.rec-card');
    for (let i = 0; i < await cards.count(); i++) {
      const cover = cards.nth(i).locator('.rec-cover'); await cover.scrollIntoViewIfNeeded();
      await cover.locator('img, .official-cover-fallback').waitFor({ timeout: 45000 });
      const image = cover.locator('img');
      if (await image.count()) await image.evaluate(i => i.decode()).catch(() => {});
      report.recommendations.push({ title: await cards.nth(i).locator('.rec-title').textContent(), loaded: await image.count() > 0 && await image.evaluate(i => i.naturalWidth > 0) });
    }
    report.recommendationCalls = await page.evaluate(() => window.__coverCalls.splice(0));
    console.log(JSON.stringify({ recommendations: report.recommendations, calls: report.recommendationCalls }));
    assert.ok(report.recommendations.length > 0);
    assert.ok(report.recommendations.every(r => r.loaded), 'Every curated cover must actually decode');
    await page.screenshot({ path: `test-output/native-covers-${label}-recommendations.png` });
  }
  for (const query of (process.env.TOMATO_COVER_QUERIES ?? '十日终焉,斩神').split(',').filter(Boolean)) {
    await page.getByLabel('搜索正版小说').fill(query);
    await page.getByRole('button', { name: '搜索小说', exact: true }).click();
    await page.locator('.search-book-card').first().waitFor({ timeout: 45000 });
    const count = await page.locator('.search-book-card').count();
    for (let i = 0; i < count; i++) {
      const cover = page.locator('.search-book-cover-wrap').nth(i);
      await cover.scrollIntoViewIfNeeded();
      await cover.locator('img, .official-cover-fallback').waitFor({ timeout: 45000 });
      const img = cover.locator('img');
      if (await img.count()) await img.evaluate(i => i.decode()).catch(() => {});
    }
    const result = await page.evaluate(() => ({
      books: window.__searchBooks.map(b => ({ id: b.id, title: b.title, coverUrl: b.coverUrl })),
      images: [...document.querySelectorAll('.search-book-cover-wrap')].map(el => {
        const img = el.querySelector('img');
        return { loaded: !!img?.naturalWidth, width: img?.naturalWidth ?? 0, source: img?.dataset.coverSource ?? null,
          fallback: !!el.querySelector('.official-cover-fallback') };
      }), calls: window.__coverCalls.splice(0),
    }));
    report.queries.push({ query, ...result });
    console.log(JSON.stringify({ query, images: result.images, calls: result.calls, books: result.books }));
    if (process.env.TOMATO_COVER_OBSERVE !== '1') {
      assert.equal(result.images.length, count);
      assert.ok(result.images[0].loaded, 'The matching original work cover must decode');
      for (let i = 0; i < count; i++) if (!result.images[i].loaded) {
        assert.ok(result.images[i].fallback && result.calls.some(call => call.bookId === result.books[i].id && call.error?.includes('代码 -1')),
          'Only an explicit official unavailable response may leave a search cover as a placeholder');
      }
    }
  }
  report.uploadCalls = await page.evaluate(() => window.__uploadCalls);
  if (process.env.TOMATO_COVER_OBSERVE !== '1') {
    await page.reload(); await page.locator('.app-shell').waitFor();
    await page.locator('.side-nav button').filter({ hasText: '找书发现' }).click();
    report.warmCovers = [];
    for (const cover of await page.locator('.rec-cover').all()) {
      await cover.scrollIntoViewIfNeeded(); await cover.locator('img').waitFor({ timeout: 30000 });
      await cover.locator('img').evaluate(img => img.decode());
      report.warmCovers.push(await cover.locator('img').getAttribute('data-cover-source'));
    }
    assert.ok(report.warmCovers.length > 0 && report.warmCovers.every(source => source === 'disk'));
    console.log('PASS all curated covers decode from the disk cache after a full page reload');
    await page.locator('.side-nav button').filter({ hasText: '排行榜单' }).click();
    const ranking = page.locator('.ranking-card').first(); await ranking.waitFor({ timeout: 45000 });
    await ranking.locator('.ranking-cover').scrollIntoViewIfNeeded();
    await ranking.locator('.ranking-cover img').waitFor({ timeout: 30000 });
    await ranking.locator('.ranking-cover img').evaluate(img => img.decode());
    report.rankingCover = await ranking.locator('.ranking-cover img').evaluate(img => img.naturalWidth > 0);
    assert.equal(report.rankingCover, true);
    console.log('PASS a real official ranking cover still decodes');
    report.uploadCalls += await page.evaluate(() => window.__uploadCalls);
  }
  assert.equal(report.uploadCalls, 0); assert.deepEqual(report.errors, []);
  console.log('PASS no cloud progress uploads or unhandled errors');
} finally {
  await mkdir('test-output', { recursive: true });
  await writeFile(`test-output/native-covers-${label}.json`, JSON.stringify(report, null, 2));
  if (page) await page.screenshot({ path: `test-output/native-covers-${label}.png` }).catch(() => {});
  await browser?.close().catch(() => {}); app.kill();
}
