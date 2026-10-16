import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { installRankingMock } from './ranking-fixture.mjs';

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1495', '--strictPort'], { stdio: 'ignore' });
let browser, passed = 0;
const errors = [];
const check = name => { passed++; console.log('PASS ' + name); };
const nav = (page, text) => page.locator('.side-nav button').filter({ hasText: text }).click();
async function readable(page, selector) {
  const results = await page.locator(selector).evaluateAll(elements => elements.map(element => {
    const rgba = value => (value.match(/[\d.]+/g) ?? []).map(Number);
    const blend = (fg, bg) => fg.slice(0, 3).map((v, i) => v * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
    let bg = [255, 255, 255], ancestors = [];
    for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
    for (const node of ancestors) bg = blend(rgba(getComputedStyle(node).backgroundColor), bg);
    const luminance = rgb => rgb.map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
    const color = getComputedStyle(element).color;
    const a = luminance(blend(rgba(color), bg)), b = luminance(bg);
    return { text: element.textContent.slice(0, 45), color, bg, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
  }));
  assert.ok(results.length, 'Expected theme contrast targets: ' + selector);
  for (const result of results) assert.ok(result.ratio >= 4.5, JSON.stringify({ selector, ...result }));
}
async function fits(page, selector) {
  const result = await page.locator(selector).evaluate(el => ({ scroll: el.scrollWidth, width: el.clientWidth }));
  assert.ok(result.scroll <= result.width + 1, selector + ': ' + JSON.stringify(result));
}
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:1495')).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => {
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === 'official_cancel_login') return;
      if (command === 'official_account') return { id: '12345', name: '主题测试账号' };
      if (command === 'official_bookshelf') return { entries: Array.from({ length: 6 }, (_, i) => ({ id: String(10000000 + i), title: '书架排版与主题测试作品' + (i + 1), author: '测试作者', progressState: 'available', lastReadTitle: '第七百一十章 继续前行', lastReadItemId: '10001' })) };
      if (command === 'official_book') return { id: args.id, title: '书架排版与主题测试作品1', author: '测试作者', description: '', source: 'official', coverStyle: 0, addedAt: 0, chapters: [{ id: '10001', title: '第七百一十章 继续前行', content: '仅用于主题测试的模拟正文。', loaded: true }] };
      if (command === 'official_read_progress') return [{ book_id: '10000000', item_id: '10001', read_timestamp: 1 }];
      if (command === 'official_comments') return { total: 1, hasMore: false, comments: [{ id: '1', name: '测试书友', text: '用于检查深色主题评论文字的模拟内容。', likes: 3, replies: 0 }] };
      throw Error('Unexpected command ' + command);
    } };
  });
  await installRankingMock(page);
  await page.goto('http://127.0.0.1:1495');
  await mkdir('test-output', { recursive: true });
  await page.locator('input[type=file]').setInputFiles({ name: '排版测试.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 测试正文\n' + '这是一段用于检查主题切换与阅读排版的文字。'.repeat(60)) });
  for (const theme of ['night', 'paper', 'sepia']) {
    await nav(page, '阅读设置');
    await page.locator('.theme-choice.' + theme).click();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.theme-choice.' + theme).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.app-shell').evaluate(el => getComputedStyle(el).colorScheme), theme === 'night' ? 'dark' : 'light');
    await readable(page, '.settings-center h1, .control-block > label, .control-block p, .preference-switch, .theme-choice');
    await fits(page, '.settings-screen');
    await page.screenshot({ path: `test-output/theme-${theme}-settings.png` });
    await page.reload();
    assert.ok(await page.locator('.app-shell.theme-' + theme).count());
    await nav(page, '账号管理');
    await page.getByRole('button', { name: '退出账号', exact: true }).waitFor();
    await readable(page, '.account-identity strong, .account-identity small, .logout-btn, .connection-status');
    await nav(page, '云端书架');
    await page.locator('.official-shelf button').first().waitFor();
    await readable(page, '.official-shelf-info strong, .official-shelf-info span, .official-shelf-info small, .shelf-refresh-btn');
    await page.screenshot({ path: `test-output/theme-${theme}-cloud.png` });
    await page.locator('.official-shelf button').first().click();
    await page.locator('.story-content p').first().waitFor();
    await page.getByTitle('听书与自动翻页').click();
    await readable(page, '.sync-bar strong, .sync-bar button, .chapter-item.current, .chapter-collapse, .audio-progress-title, .audio-progress-stats, .drawer-tab-btn, .drawer-close-action, .control-field select, .chip-item');
    await page.getByTitle('官方评论').click();
    await page.locator('.comment p').waitFor();
    await readable(page, '.comment strong, .comment p, .comment small');
    await page.getByLabel('关闭评论').click();
    await page.getByRole('button', { name: '上传本章进度', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await readable(page, '.progress-dialog h2, .progress-dialog p, .progress-dialog button');
    await page.getByRole('button', { name: '取消上传', exact: true }).click();
    await page.screenshot({ path: `test-output/theme-${theme}-official-reader.png` });
    await page.getByRole('button', { name: '返回书架', exact: true }).click();
    await nav(page, '排行榜单');
    await page.locator('.ranking-card').nth(9).waitFor();
    await readable(page, '.book-title-clickable, .ranking-desc, .meta-author, .tag-chip, .secondary-action-btn');
    await page.screenshot({ path: `test-output/theme-${theme}-rankings.png` });
    await nav(page, '找书发现');
    await page.getByRole('button', { name: '通过番茄链接或书籍ID直接打开作品' }).click();
    await readable(page, '.search-input-wrapper input, .direct-link-form input, .direct-link-form button');
    await page.screenshot({ path: `test-output/theme-${theme}-discovery.png` });
    await nav(page, '本地书架');
    await readable(page, '.book-info h3, .cta-left strong, .cta-left p, .shelf-tab.active');
    await page.screenshot({ path: `test-output/theme-${theme}-library.png` });
    await page.getByRole('button', { name: '阅读 排版测试', exact: true }).click();
    await page.locator('.story-content p').first().waitFor();
    await page.getByTitle('阅读设置', { exact: true }).click();
    await readable(page, '.story-content p, .reader-top-title, .reader-settings .control-block > label, .reader-settings .control-block p');
    for (const width of [900, 1280, 1600]) {
      await page.setViewportSize({ width, height: 820 });
      await fits(page, '.reader-layout');
      assert.ok(await page.locator('.reading-canvas').evaluate(el => el.clientWidth) >= 360, 'Reader keeps usable width at ' + width);
      const close = page.getByRole('button', { name: '关闭阅读偏好', exact: true });
      await close.click();
      await page.getByTitle('阅读设置', { exact: true }).click();
      await page.screenshot({ path: `test-output/theme-${theme}-reader-${width}.png` });
    }
    await page.getByTitle('章节目录', { exact: true }).click();
    assert.equal(await page.locator('.reader-settings').count(), 0);
    await page.locator('.chapters-list').waitFor({ state: 'visible' });
    await page.getByTitle('阅读设置', { exact: true }).click();
    await page.getByRole('button', { name: '关闭阅读偏好', exact: true }).click();
    await page.getByRole('button', { name: '返回书架', exact: true }).click();
    await page.setViewportSize({ width: 900, height: 640 });
    for (const screen of ['本地书架', '云端书架', '账号管理', '排行榜单', '找书发现', '阅读设置']) {
      await nav(page, screen);
      await fits(page, '.main-panel > div');
    }
    await page.screenshot({ path: `test-output/theme-${theme}-settings-900.png` });
    await page.setViewportSize({ width: 1280, height: 820 });
    check(`${theme}: readable text, native control colors, persisted preference, six pages and three reader widths`);
  }
  assert.deepEqual(errors, []);
  check('No unhandled UI errors while switching themes and layouts');
  console.log(`${passed} theme and layout scenarios passed (mock cloud services).`);
} finally { await browser?.close(); server.kill(); }
