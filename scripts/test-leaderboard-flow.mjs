import { installRankingMock } from './ranking-fixture.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = '1489';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: 'ignore' });
let browser;
let passed = 0;
const errors = [];
const check = name => { passed++; console.log('PASS ' + name); };

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) break;
    } catch {}
    await delay(100);
  }

  browser = await chromium.launch({
    headless: true,
    ...(process.env.TOMATO_TEST_BROWSER ? { executablePath: process.env.TOMATO_TEST_BROWSER } : {}),
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']
  });

  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));

  // Mock Tauri environment with realistic book responses
  await page.addInitScript(() => {
    window.isTauri = true;
    window.__calls = [];
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args = {}) => {
        window.__calls.push({ command, args });
        if (command === 'official_account') return null; // Guest user
        if (command === 'official_book') {
          return {
            id: args.id,
            title: args.id === '7143038691944959011' ? '十日终焉' : (args.id === '6982529841564224526' ? '我在精神病院学斩神' : '番茄测试小说'),
            author: args.id === '7143038691944959011' ? '杀虫队队员' : '三九音域',
            description: '精彩的番茄官方小说',
            source: 'official',
            coverStyle: 0,
            coverUrl: 'https://p6-tt.bytecdn.cn/novel-pic/4900f950c7af7f82fdc14cf528e0e288~tplv-shrink:640:0.image',
            addedAt: Date.now(),
            chapters: [
              { id: `${args.id}-c1`, title: '第1章 空屋', content: '', loaded: false },
              { id: `${args.id}-c2`, title: '第2章 说谎', content: '', loaded: false }
            ]
          };
        }
        if (command === 'official_chapter') {
          return {
            id: args.id,
            title: args.id.endsWith('-c1') ? '第1章 空屋' : '第2章 说谎',
            content: '齐夏缓缓睁开双眼。\n\n四周是一片昏暗的封闭水泥房间，没有窗户，空气中弥漫着淡淡的发霉气味。\n\n记忆最后的画面，停留在繁华闹市街头的一场车祸。\n\n“我没死？”齐夏揉了揉剧痛的额头。\n\n墙壁上挂着一个陈旧的电子钟，正以一种极其诡异的节奏跳动着倒计时。',
            loaded: true
          };
        }
        if (command === 'official_search') {
          return {
            books: [
              {
                id: '7143038691944959011',
                title: '十日终焉',
                author: '杀虫队队员',
                description: '【悬疑+无限流+智商在线+群像】当你被选中进入终焉之地...',
                score: '9.8',
                coverUrl: 'https://p6-tt.bytecdn.cn/novel-pic/4900f950c7af7f82fdc14cf528e0e288~tplv-shrink:640:0.image'
              }
            ],
            hasMore: false,
            nextOffset: 10
          };
        }
        if (command === 'official_audio_catalog') return { albums: [], ttsTones: [] };
        if (command === 'official_comments') return { total: 0, hasMore: false, comments: [] };
        return null;
      }
    };
  });

  await installRankingMock(page);
  await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForLoadState('domcontentloaded');

  // 1. Click Leaderboard navigation tab
  const rankingsNav = page.locator('button.nav-btn:has-text("排行榜单")');
  await rankingsNav.waitFor();
  await rankingsNav.click();
  await page.waitForSelector('.leaderboard-screen');
  check('Leaderboard view rendered successfully');

  // 2. Verify 《十日终焉》 is shown on top chart
  const topBookTitle = page.locator('.ranking-card h3:has-text("十日终焉")').first();
  await topBookTitle.waitFor();
  check('Top ranking book 《十日终焉》 found in list');

  // 3. Click "立即阅读" on 《十日终焉》
  const readBtn = page.locator('.ranking-card:has-text("十日终焉") button.primary-action-btn').first();
  await readBtn.click();

  // 4. Verify transition into Reader screen
  await page.waitForSelector('.reader-layout');
  const readerBookTitle = await page.locator('.reader-top-title').textContent();
  assert(readerBookTitle?.includes('十日终焉'), `Expected reader title to contain 十日终焉, got ${readerBookTitle}`);
  check('Reader view opened with correct book title 《十日终焉》');

  // 5. Verify chapter content loaded and rendered in reading canvas
  await page.waitForSelector('.page-paper');
  const content = await page.locator('.page-paper').textContent();
  assert(content?.includes('齐夏缓缓睁开双眼'), 'Expected chapter 1 text to be loaded and rendered in reading canvas');
  check('Chapter 1 content rendered properly in reading canvas');

  // 6. Return back from Reader
  const backBtn = page.locator('button.text-action:has-text("返回")');
  await backBtn.click();
  await page.waitForSelector('.app-shell');
  check('Back button successfully closed reader');

  // 7. Go back to Leaderboard, test "加入书架" for 《我在精神病院学斩神》
  await rankingsNav.click();
  await page.waitForSelector('.leaderboard-screen');
  const zhanshenCard = page.locator('.ranking-card:has-text("我在精神病院学斩神")').first();
  const addShelfBtn = zhanshenCard.locator('button.secondary-action-btn');
  await addShelfBtn.click();
  await page.waitForSelector('.ranking-card:has-text("我在精神病院学斩神") button.secondary-action-btn.in-shelf');
  check('Added book 《我在精神病院学斩神》 to shelf and button updated to in-shelf');

  // 8. Navigate to "本地书架" and verify 《我在精神病院学斩神》 appears there
  const shelfNav = page.locator('button.nav-btn:has-text("本地书架")');
  await shelfNav.click();
  await page.waitForSelector('.library-content');
  const bookOnShelf = page.locator('.book-card:has-text("我在精神病院学斩神")');
  await bookOnShelf.waitFor();
  check('Book 《我在精神病院学斩神》 found on bookshelf');

  // 9. Click on the book cover on shelf and verify it opens in reader
  await bookOnShelf.locator('.book-cover').click();
  await page.waitForSelector('.reader-layout');
  const openedShelfTitle = await page.locator('.reader-top-title').textContent();
  assert(openedShelfTitle?.includes('我在精神病院学斩神'));
  check('Opened 《我在精神病院学斩神》 directly from bookshelf into reader');

  // 10. Return to shelf, then switch to "找书发现" (DiscoveryView)
  await page.locator('button.text-action:has-text("返回")').click();
  const discoveryNav = page.locator('button.nav-btn:has-text("找书发现")');
  await discoveryNav.click();
  await page.waitForSelector('.discovery-screen');
  check('Discovery view loaded successfully');

  // 11. Click search or quick tag in Discovery view
  const hotTag = page.locator('.hot-chip:has-text("十日终焉")').first();
  await hotTag.click();
  await page.waitForSelector('.search-book-card:has-text("十日终焉")');
  check('Hot search tag triggered search results card');

  // 12. Click "打开作品" in search result card
  const openSearchResultBtn = page.locator('.search-book-card:has-text("十日终焉") button.search-open-btn');
  await openSearchResultBtn.click();
  await page.waitForSelector('.reader-layout');
  check('Opened search result book from Discovery view into reader');

  assert.equal(errors.length, 0, `Page errors encountered: ${errors.join('; ')}`);
  check('No unhandled page errors throughout complete reading and discovery flows');
  console.log(`\nAll ${passed} leaderboard and book opening checks passed!`);
} finally {
  if (browser) await browser.close();
  server.kill();
}
