import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Only local reading is tested. A separate WebView2 profile keeps test books
// and preferences out of the user's normal application data.
const executable = process.env.TOMATO_NATIVE_EXE ?? resolve('src-tauri/target/release/tomato-reader.exe');
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const app = spawn(executable, [], {
  windowsHide: true,
  stdio: 'ignore',
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=1484', WEBVIEW2_USER_DATA_FOLDER: resolve(`test-output/native-profile-${Date.now()}`) },
});
let browser, nativePage;
let launchError;
app.on('error', error => { launchError = error; });
try {
  for (let i = 0; i < 150; i++) {
    if (launchError) throw launchError;
    if (app.exitCode !== null) throw new Error(`Native app exited early: ${app.exitCode}`);
    try { if ((await fetch('http://127.0.0.1:1484/json/version')).ok) break; } catch {}
    await delay(200);
  }
  browser = await chromium.connectOverCDP('http://127.0.0.1:1484');
  const page = browser.contexts()[0].pages()[0]; nativePage = page;
  assert.ok(page, 'WebView2 exposes an application page');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.app-shell').waitFor();
  assert.ok(await page.evaluate(() => !!window.__TAURI_INTERNALS__), 'Real Tauri bridge is present');
  assert.ok((await page.locator('.side-bottom').textContent()).includes(`v${version}`));
  console.log(`PASS Native ${version} window renders through WebView2 with the real Tauri bridge`);
  if (process.env.TOMATO_NATIVE_CHECK_RANKINGS === '1') {
    await page.locator('.side-nav button').filter({ hasText: '排行榜单' }).click();
    await page.locator('.ranking-card').nth(9).waitFor({ timeout: 60000 });
    assert.equal(await page.locator('.ranking-card').count(), 10);
    const titles = await page.locator('.ranking-card h3').allTextContents();
    assert.ok(titles.every(title => title && !/[\ue000-\uf8ff]/.test(title) && !title.includes('资料暂未取得')));
    let coverLoaded = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      coverLoaded = await page.locator('.ranking-cover img').evaluateAll(images => images.some(img => img.naturalWidth > 0));
      if (coverLoaded) break;
      await delay(200);
    }
    assert.ok(coverLoaded, 'Native CSP allows the actual official cover image host');
    assert.ok((await page.locator('.section-subtitle').textContent()).includes('官方版本'));
    console.log('PASS Native live official rankings load normal Chinese titles, covers and source version');
    await page.getByRole('button', { name: '加载更多榜单作品', exact: true }).click();
    await page.locator('.ranking-card').nth(19).waitFor({ timeout: 60000 });
    assert.equal(await page.locator('.ranking-card').count(), 20);
    assert.equal((await page.locator('.plain-rank').allTextContents()).at(-1), '20');
    console.log('PASS Native live official rankings load the second page with continuous positions');
    await page.locator('.side-nav button').filter({ hasText: '本地书架' }).click();
  }
  if (process.env.TOMATO_NATIVE_CHECK_CLOUD === '1') {
    await page.locator('.side-bottom').getByText('官方账号在线', { exact: true }).waitFor({ timeout: 45000 });
    assert.equal(await page.locator('.library-screen').count(), 1);
    console.log('PASS Native startup validates the saved account without entering account management');
    await page.locator('.side-nav button').filter({ hasText: '云端书架' }).click();
    await page.locator('.official-shelf button').first().waitFor({ timeout: 45000 });
    await page.locator('.cloud-shelf-toolbar').getByRole('button', { name: '刷新官方书架', exact: true }).waitFor();
    assert.ok(await page.locator('.official-shelf button').count() > 0);
    console.log('PASS Native background prefetch renders the actual cloud shelf (read-only)');
    await page.locator('.side-nav button').filter({ hasText: '本地书架' }).click();
  }
  if (process.env.TOMATO_NATIVE_CHECK_THEMES === '1') {
    await mkdir('test-output', { recursive: true });
    await page.locator('.side-nav button').filter({ hasText: '阅读设置' }).click();
    for (const theme of ['night', 'sepia', 'paper']) {
      await page.locator('.theme-choice.' + theme).click();
      const colors = await page.locator('.settings-card').evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color, scheme: getComputedStyle(el).colorScheme }));
      assert.equal(colors.scheme, theme === 'night' ? 'dark' : 'light');
      if (theme === 'night') {
        assert.equal(colors.bg, 'rgb(19, 27, 46)');
        assert.equal(colors.text, 'rgb(248, 250, 252)');
      }
      assert.equal(await page.locator('.theme-choice.' + theme).getAttribute('aria-pressed'), 'true');
      await page.screenshot({ path: `test-output/native-${version}-theme-${theme}.png` });
    }
    await page.locator('.side-nav button').filter({ hasText: '本地书架' }).click();
    console.log('PASS Native WebView2 renders all three themes and updates control color schemes');
  }
  await page.locator('input[type=file]').setInputFiles({
    name: '桌面回归测试.txt', mimeType: 'text/plain',
    buffer: Buffer.from('第一章 测试\n' + Array.from({ length: 100 }, (_, i) => `段落${i}：${'桌面端阅读位置验证。'.repeat(15)}`).join('\n\n')),
  });
  await page.getByRole('button', { name: '阅读 桌面回归测试', exact: true }).click();
  await page.locator('.story-content p').first().waitFor();
  await page.evaluate(() => {
    const canvas = document.querySelector('.reading-canvas');
    canvas.scrollTop = (canvas.scrollHeight - canvas.clientHeight) * .45;
    canvas.dispatchEvent(new Event('scroll'));
    [...document.querySelectorAll('.side-nav button')].find(b => b.textContent.includes('阅读设置')).click();
  });
  await page.locator('.settings-screen').waitFor();
  assert.equal(await page.getByRole('switch', { name: '云端自动上传阅读进度' }).getAttribute('aria-checked'), 'false');
  console.log('PASS Native automatic upload switch defaults to off');
  await page.getByRole('button', { name: '返回我的书架', exact: true }).click();
  await page.getByRole('button', { name: '阅读 桌面回归测试', exact: true }).click();
  await page.locator('.story-content p').first().waitFor();
  const ratio = await page.locator('.reading-canvas').evaluate(el => el.scrollTop / (el.scrollHeight - el.clientHeight));
  assert.ok(Math.abs(ratio - .45) < .01, `Native restored scroll ratio: ${ratio}`);
  console.log('PASS Native TXT import and sidebar-exit position restoration');
  if (process.env.TOMATO_NATIVE_CHECK_SCROLL === '1') {
    await page.getByTitle('听书与自动翻页').click();
    await page.locator('.reading-canvas').evaluate(el => el.scrollTop = 1000);
    await page.getByRole('button', { name: '自动阅读', exact: true }).click();
    await page.getByRole('button', { name: '平滑滚动', exact: true }).click();
    const motion = await page.evaluate(() => new Promise(resolve => {
      const paper = document.querySelector('.page-paper');
      const canvas = document.querySelector('.reading-canvas');
      const times = [], positions = [];
      let start;
      const initialScroll = canvas.scrollTop;
      function tick(time) {
        start ??= time; times.push(time); positions.push(-paper.getBoundingClientRect().top);
        if (time - start < 1500) requestAnimationFrame(tick);
        else resolve({ frames: times.length, elapsedMs: time - start,
          movingFrames: positions.filter((value, i) => i && Math.abs(value - positions[i - 1]) > .05).length,
          maxFrameMs: Math.max(...times.slice(1).map((value, i) => value - times[i])),
          distancePx: canvas.scrollTop - initialScroll });
      }
      requestAnimationFrame(tick);
    }));
    console.log('Native scroll sample: ' + JSON.stringify(motion));
    assert.ok(motion.movingFrames / motion.frames > .65, 'Native default slow speed should move smoothly on most available frames');
    assert.ok(Math.abs(motion.distancePx - 25 * motion.elapsedMs / 1000) < 5);
    const holdBox = await page.locator('.reading-canvas').boundingBox();
    await page.mouse.move(holdBox.x + holdBox.width / 2, holdBox.y + Math.min(100, holdBox.height / 2));
    await page.mouse.down();
    const holdPosition = await page.locator('.reading-canvas').evaluate(el => el.scrollTop);
    await delay(350);
    assert.equal(await page.locator('.reading-canvas').evaluate(el => el.scrollTop), holdPosition);
    await page.mouse.up();
    await delay(250);
    assert.ok(await page.locator('.reading-canvas').evaluate(el => el.scrollTop) > holdPosition);
    console.log('PASS Native left-button hold pauses automatic reading and release resumes');
    await page.locator('.reading-canvas').dispatchEvent('wheel');
    await page.waitForTimeout(100);
    assert.ok(await page.getByRole('button', { name: '停止自动阅读', exact: true }).isVisible());
    await page.getByRole('button', { name: '停止自动阅读', exact: true }).click();
    assert.equal(await page.locator('.page-paper').evaluate(el => el.style.transform), '');
    console.log('PASS Native default-speed fractional auto-scroll and manual-wheel continuation');
  }
  await mkdir('test-output', { recursive: true });
  await page.screenshot({ path: `test-output/native-${version}.png` });
  if (process.env.TOMATO_NATIVE_CHECK_TTS === '1') {
    await page.locator('.side-nav button').filter({ hasText: '找书发现' }).click();
    await page.getByRole('button', { name: '通过番茄链接或书籍ID直接打开作品' }).click();
    await page.getByLabel('打开正版作品').fill('7069948840148732967');
    await page.getByRole('button', { name: '打开作品', exact: true }).click();
    // The test profile starts with auto-upload disabled. Never confirm a progress write.
    const chooseCloud = page.getByRole('button', { name: /采用云端：第/ });
    if (await chooseCloud.isVisible().catch(() => false)) await chooseCloud.click();
    await page.locator('.story-content p').first().waitFor({ timeout: 60000 });
    await page.getByTitle('听书与自动翻页').click();
    await page.getByRole('button', { name: '番茄AI音色', exact: true }).click();
    await page.getByLabel('番茄AI音色').locator('option[value="74"]').waitFor({ state: 'attached', timeout: 60000 });
    const sample = async tone => {
      await page.getByLabel('番茄AI音色').selectOption(tone);
      await page.getByRole('button', { name: '播放本章', exact: true }).click();
      for (let attempt = 0; attempt < 300; attempt++) {
        const state = await page.locator('.official-tts audio').evaluate(a => ({ duration: a.duration, playing: !a.paused, seconds: a.currentTime }));
        if (state.duration > 0 && state.playing && state.seconds > 0) {
          return state;
        }
        const error = await page.locator('.official-tts .audio-error').count() ? await page.locator('.official-tts .audio-error').textContent() : '';
        if (error) throw Error(error);
        await delay(200);
      }
      throw Error('Native AI playback timed out');
    };
    const first = await sample('74');
    await page.getByRole('button', { name: '收起面板', exact: true }).click();
    assert.ok(await page.locator('.official-tts audio').evaluate(a => !a.paused));
    await page.getByRole('button', { name: '暂停播放', exact: true }).click();
    assert.ok(await page.locator('.official-tts audio').evaluate(a => a.paused));
    await page.getByRole('button', { name: '继续播放', exact: true }).click();
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await page.locator('.official-tts audio').evaluate(a => !a.paused)) break;
      await delay(100);
    }
    assert.ok(await page.locator('.official-tts audio').evaluate(a => !a.paused));
    console.log('PASS Native collapsed AI playback, mini pause and resume');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-output/native-${version}-mini-player.png` });
    await page.getByTitle('听书与自动翻页').click();

    await page.locator('.official-tts audio').evaluate(a => { a.currentTime = 8; });
    const second = await sample('1');
    assert.notEqual(first.duration, second.duration, 'Different official tones return audio with different durations');
    assert.ok(second.seconds >= 7.5, 'Native voice switch restores the listening time');
    await page.getByRole('button', { name: '停止AI朗读', exact: true }).click();
    assert.ok(await page.locator('.official-tts audio').evaluate(a => a.paused));
    console.log(`PASS Native official AI voices 74 and 1 play different audio and preserve position (durations ${first.duration.toFixed(1)}s / ${second.duration.toFixed(1)}s; no progress upload)`);
    await page.screenshot({ path: `test-output/native-${version}-official-tts.png` });
  }
  if (process.env.TOMATO_NATIVE_CHECK_READER_FEATURES === '1') {
    await page.locator('.side-nav button').filter({ hasText: '找书发现' }).click();
    await page.getByRole('button', { name: '通过番茄链接或书籍ID直接打开作品' }).click();
    await page.getByLabel('打开正版作品').fill('7255936586997566505');
    await page.getByRole('button', { name: '打开作品', exact: true }).click();
    await page.locator('.chapter-item').filter({ hasText: '第887章 要不…你滚！' }).click({ timeout: 60000 });
    const bubble = page.locator('.paragraph-bubble[data-paragraph-id="0"]');
    await bubble.waitFor({ timeout: 60000 });
    await page.locator('.chapter-scroll').evaluate(el => el.scrollTop = 0);
    const readerPosition = await page.locator('.reading-canvas').evaluate(el => el.scrollTop);
    await page.getByRole('button', { name: '收起目录', exact: true }).click();
    await page.getByRole('button', { name: '展开目录', exact: true }).click();
    assert.ok(await page.locator('.chapter-scroll').evaluate(el => {
      const row = el.querySelector('.chapter-item.current').getBoundingClientRect(), box = el.getBoundingClientRect();
      return row.top >= box.top && row.bottom <= box.bottom;
    }));
    assert.equal(await page.locator('.reading-canvas').evaluate(el => el.scrollTop), readerPosition);
    console.log('PASS Native directory collapse and expansion restore the current chapter without moving the body');

    await bubble.click();
    await page.locator('.paragraph-comments .comment').first().waitFor({ timeout: 60000 });
    assert.ok(await page.locator('.paragraph-comments .comment').count() > 0);
    await page.screenshot({ path: `test-output/native-${version}-paragraphs.png` });
    await page.getByRole('button', { name: '关闭段评', exact: true }).click();
    await page.locator('.paragraph-bubble[data-paragraph-id="97"]').click();
    await page.getByRole('button', { name: '加载更多段评', exact: true }).waitFor({ timeout: 60000 });
    const before = await page.locator('.paragraph-comments .comment').count();
    await page.getByRole('button', { name: '加载更多段评', exact: true }).click();
    await page.locator('.paragraph-comments .comment').nth(before).waitFor({ timeout: 60000 });
    console.log('PASS Native real paragraph bubbles, comment list and pagination');
    await page.getByRole('button', { name: '关闭段评', exact: true }).click();
    await page.getByTitle('听书与自动翻页').click();
    await page.getByRole('button', { name: '官方有声', exact: true }).click();
    await page.getByText('当前文字章节对应：第729集 · 3:47', { exact: false }).waitFor({ timeout: 60000 });
    assert.equal(await page.getByLabel('有声集数').inputValue(), '728');
    await page.getByRole('button', { name: '从当前文字章节播放' }).click();
    let playing = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      const state = await page.locator('.official-audio:not(.official-tts) audio').evaluate(a => ({ duration: a.duration, playing: !a.paused, seconds: a.currentTime }));
      if (state.duration > 227.17 && state.playing && state.seconds >= 227.17) { playing = true; break; }
      const error = await page.locator('.official-audio .audio-error').count() ? await page.locator('.official-audio .audio-error').textContent() : '';
      if (error) throw Error(error);
      await delay(200);
    }
    assert.ok(playing, 'Real recorded audio starts at the official chapter timestamp');
    await page.locator('.official-audio:not(.official-tts) audio').evaluate(a => a.pause());
    await page.screenshot({ path: `test-output/native-${version}-alignment.png` });
    console.log('PASS Native text chapter 887 maps to episode 729 and plays from 227.17 seconds, no cloud upload');
  }
  if (process.env.TOMATO_PRIVATE_BOOK_ID) {
    await page.getByRole('button', { name: '账号管理', exact: true }).click();
    await page.getByRole('button', { name: '退出账号', exact: true }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: /找书发现/ }).click();
    await page.getByRole('button', { name: '通过番茄链接或书籍ID直接打开作品' }).click();
    await page.getByLabel('打开正版作品').fill(process.env.TOMATO_PRIVATE_BOOK_ID);
    await page.getByRole('button', { name: '打开作品', exact: true }).click();
    await page.getByRole('button', { name: '查看已读章节', exact: true }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: '查看已读章节', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '从已读记录找回位置' });
    await dialog.waitFor({ timeout: 30000 });
    assert.ok(await dialog.locator('.history-chapters button').count() > 0);
    assert.ok((await page.locator('.sync-bar').textContent()).includes('自动上传已关闭'));
    await page.screenshot({ path: `test-output/native-history-${version}.png` });
    console.log('PASS Real-account read-history command and recovery dialog work in native WebView2 (no upload requested)');
  }
  assert.deepEqual(errors, []);
  console.log('PASS No unhandled errors during native local reading');
} catch (error) {
  if (nativePage) {
    await nativePage.screenshot({ path: `test-output/native-${version}-failure.png` }).catch(() => {});
    console.error('Native player status:', await nativePage.locator('.official-audio .audio-status, .official-audio .audio-alignment, .official-audio .audio-error').allTextContents().catch(() => []));
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  app.kill();
}
