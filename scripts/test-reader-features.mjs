import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1497', '--strictPort'], { stdio: 'ignore' });
const wav = Buffer.alloc(44 + 8000 * 300 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
let browser, passed = 0;
const errors = [];
const check = name => { passed++; console.log('PASS ' + name); };
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:1497')).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(audio => {
    window.isTauri = true; window.__calls = []; window.__audio = audio;
    const first = '7399337929476162072', second = '7399337929476162073';
    const comment = n => ({ id: String(123450 + n), name: '测试书友' + n, text: '这条是当前段落的模拟评论' + n, likes: n, replies: n === 1 ? 1 : 0 });
    window.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      window.__calls.push({ command, args });
      if (command === 'official_account') return null;
      if (command === 'official_cancel_login') return;
      if (command === 'official_read_progress') return [];
      if (command === 'official_book') return { id: args.id, title: '段评与有声定位测试', author: '测试作者', source: 'official', description: '', coverStyle: 0, addedAt: 0, chapters: [{ id: first, title: '第887章', content: '', loaded: false }, { id: second, title: '第888章', content: '', loaded: false }] };
      if (command === 'official_chapter') return { id: args.id, title: args.id === first ? '第887章' : '第888章', content: '<p idx="0">正文第一段，编号为零。</p><p idx="4">正文第二段，官方编号为四。</p>', itemVersion: '123', loaded: true };
      if (command === 'official_paragraph_counts') {
        if (window.__holdCounts === args.itemId) await new Promise(resolve => window.__releaseCounts = resolve);
        return { chapterId: args.itemId, itemVersion: '123', counts: args.itemId === first ? { '0': 5, '4': 30, '1': 999 } : { '4': 2 } };
      }
      if (command === 'official_paragraph_comments') {
        if (window.__holdComments) await new Promise(resolve => window.__releaseComments = resolve);
        if (window.__failComments) throw Error('模拟段评网络错误');
        return { chapterId: args.itemId, paragraphId: args.paragraphId, comments: args.cursor ? [comment(2), comment(3)] : [comment(1), comment(2)], total: 30, hasMore: !args.cursor, nextCursor: args.cursor ? '' : '9007199254740993' };
      }
      if (command === 'official_paragraph_replies') return { chapterId: args.itemId, commentId: args.commentId, comments: [comment(8)], total: 1, hasMore: false, nextCursor: '' };
      if (command === 'official_audio_catalog') return { albums: [{ id: '7325015266541423678', name: '真人测试版', narrator: '测试主播' }], ttsTones: [{id: '74', name: '测试AI音色'}] };
      if (command === 'official_audio_episodes') return [{ id: '7417131808128830487', title: '上一集' }, { id: '7417131808128830488', title: '对应集数' }, { id: '7417131808128830489', title: '下一集' }];
      if (command === 'official_audio_alignment') {
        if (window.__holdAlignment === args.itemId) await new Promise(resolve => window.__releaseAlignment = resolve);
        return { chapterId: args.itemId, albumId: args.albumId, matched: args.itemId === first, episodeId: '7417131808128830488', episodeIndex: 1, seconds: 227.17 };
      }
      if (command === 'official_tts_play') { if (window.__holdTts) await new Promise(resolve => window.__releaseTts = resolve); return { itemId: args.itemId, toneId: args.toneId, urls: [], audioBase64: window.__audio, mime: 'audio/mp4' }; }
      if (command === 'official_audio_play') return { itemId: args.itemId, urls: [], audioBase64: window.__audio, mime: 'audio/mp4' };
      throw Error('Unexpected command ' + command);
    } };
  }, wav.toString('base64'));
  await page.goto('http://127.0.0.1:1497');
  await page.locator('.side-nav button').filter({ hasText: '找书发现' }).click();
  await page.getByRole('button', { name: '通过番茄链接或书籍ID直接打开作品' }).click();
  await page.getByLabel('打开正版作品').fill('7255936586997566505');
  await page.getByRole('button', { name: '打开作品', exact: true }).click();
  await page.locator('.paragraph-bubble').nth(1).waitFor();
  assert.deepEqual(await page.locator('.paragraph-bubble').allTextContents(), ['5', '30']);
  assert.deepEqual(await page.locator('.paragraph-bubble').evaluateAll(els => els.map(el => el.dataset.paragraphId)), ['0', '4']);
  assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_paragraph_comments').length), 0);
  check('Bubbles use original paragraph IDs, including nonconsecutive indices, without fetching every comment');
  await page.locator('.paragraph-bubble').nth(1).click();
  await page.locator('.paragraph-comments .comment').nth(1).waitFor();
  assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_paragraph_comments').at(-1).args.paragraphId), 4);
  await page.getByRole('button', { name: '加载更多段评', exact: true }).click();
  await page.locator('.paragraph-comments .comment').nth(2).waitFor();
  assert.equal(await page.locator('.paragraph-comments .comment').count(), 3);
  assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_paragraph_comments').at(-1).args.cursor), '9007199254740993');
  check('Paragraph comments pass the exact chapter/version, paginate with a string cursor and deduplicate');
  await page.getByRole('button', { name: '查看段评回复', exact: true }).click();
  await page.getByText('这条是当前段落的模拟评论8', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_paragraph_replies').at(-1).args.itemId), '7399337929476162072');
  await page.getByRole('button', { name: '返回本段评论', exact: true }).click();
  await page.locator('.paragraph-comments .comment').nth(1).waitFor();
  check('Paragraph replies retain chapter and parent comment context');
  await page.getByTitle('隐藏段评气泡').click();
  assert.equal(await page.locator('.paragraph-bubble').count(), 0);
  assert.equal(await page.locator('.paragraph-comments').count(), 0);
  await page.getByTitle('显示段评气泡').click();
  await page.locator('.paragraph-bubble').nth(1).waitFor();
  check('Hiding bubbles closes the paragraph panel and restoring them reuses cached counts');
  await page.evaluate(() => { window.__holdComments = true; window.__releaseComments = null; });
  await page.locator('.paragraph-bubble').first().click();
  await page.waitForFunction(() => !!window.__releaseComments);
  await page.getByTitle('章节目录', { exact: true }).click();
  await page.locator('.chapter-item').nth(1).click();
  await page.evaluate(() => { window.__holdComments = false; window.__releaseComments(); });
  await page.locator('.paragraph-bubble').waitFor();
  assert.equal(await page.locator('.paragraph-comments').count(), 0);
  assert.deepEqual(await page.locator('.paragraph-bubble').allTextContents(), ['2']);
  check('Switching chapters discards late paragraph responses and the old selected paragraph');

  await page.getByTitle('听书与自动翻页').click();
  await page.getByRole('button', { name: '官方有声', exact: true }).click();
  await page.getByText('官方未返回本章与该有声版本的对应关系，可手动选集。', { exact: false }).waitFor();
  assert.ok(await page.getByRole('button', { name: '从当前文字章节播放' }).isDisabled());
  assert.ok(await page.getByRole('button', { name: '播放本集', exact: true }).isEnabled());
  check('Missing official mapping permits manual listening and never guesses a matching episode');
  await page.locator('.chapter-item').first().click();
  await page.getByText('当前文字章节对应：第2集 · 3:47', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('有声集数').inputValue(), '1');
  await page.getByRole('button', { name: '从当前文字章节播放' }).click();
  await page.waitForFunction(() => { const a = document.querySelector('.official-audio:not(.official-tts) audio'); return a && !a.paused && a.currentTime >= 227.17; });
  assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_audio_play').at(-1).args.itemId), '7417131808128830488');
  check('Official chapter mapping selects the exact episode ID and seeks to 227.17 seconds');
  await page.getByLabel('有声集数').selectOption('0');
  await page.getByRole('button', { name: '播放本集', exact: true }).click();
  await page.waitForFunction(() => { const a = document.querySelector('.official-audio:not(.official-tts) audio'); return a && !a.paused && a.currentTime > 0 && a.currentTime < 5; });
  check('Manual selection remains independent of the chapter-mapping seek target');
  const recorded = page.locator('.official-audio:not(.official-tts) audio');
  await page.getByRole('button', { name: '番茄AI音色', exact: true }).click();
  await page.getByRole('button', { name: '播放本章', exact: true }).click();
  await page.waitForFunction(() => { const a = document.querySelector('.official-tts audio'); return a && !a.paused && a.currentTime > 0; });
  assert.ok(await recorded.evaluate(a => a.paused));
  await page.getByRole('button', { name: '官方有声', exact: true }).click();
  await page.getByRole('button', { name: '播放本集', exact: true }).click();
  await page.waitForFunction(() => { const a = document.querySelector('.official-audio:not(.official-tts) audio'); return a && !a.paused && a.currentTime > 0; });
  assert.ok(await page.locator('.official-tts audio').evaluate(a => a.paused));
  await page.getByRole('button', { name: '收起面板', exact: true }).click();
  assert.ok(await recorded.evaluate(a => !a.paused));
  await page.getByRole('button', { name: '暂停播放', exact: true }).click();
  assert.ok(await recorded.evaluate(a => a.paused));
  await page.getByRole('button', { name: '继续播放', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.official-audio:not(.official-tts) audio').paused);
  await page.getByTitle('听书与自动翻页').click();
  check('AI and recorded players stop each other; collapsed recorded playback pauses and resumes from the mini controls');
  await page.getByRole('button', { name: '番茄AI音色', exact: true }).click();
  await page.evaluate(() => { window.__holdTts = true; });
  // A different chapter forces a fresh request rather than resuming an existing media source.
  await page.locator('.chapter-item').nth(1).click();
  await page.getByRole('button', { name: '播放本章', exact: true }).click();
  await page.waitForFunction(() => !!window.__releaseTts);
  await page.getByRole('button', { name: '官方有声', exact: true }).click();
  await page.getByRole('button', { name: '播放本集', exact: true }).click();
  await page.evaluate(() => { window.__holdTts = false; window.__releaseTts(); });
  await page.waitForTimeout(300);
  assert.ok(await page.locator('.official-tts audio').evaluate(a => a.paused && !a.getAttribute('src')));
  check('Starting recorded playback invalidates an outstanding AI download, preventing delayed overlapping audio');
  await page.locator('.chapter-item').first().click();

  await page.evaluate(() => { window.__holdAlignment = '7399337929476162072'; window.__releaseAlignment = null; });
  await page.locator('.chapter-item').nth(1).click();
  await page.getByText('官方未返回本章与该有声版本的对应关系', { exact: false }).waitFor();
  await page.locator('.chapter-item').first().click();
  await page.waitForFunction(() => !!window.__releaseAlignment);
  await page.locator('.chapter-item').nth(1).click();
  await page.evaluate(() => { window.__holdAlignment = ''; window.__releaseAlignment(); });
  await page.getByText('官方未返回本章与该有声版本的对应关系', { exact: false }).waitFor();
  assert.ok(await page.getByRole('button', { name: '从当前文字章节播放' }).isDisabled());
  check('An old chapter mapping cannot overwrite a later chapter selection');
  await page.setViewportSize({ width: 900, height: 640 });
  await page.locator('.paragraph-bubble').click();
  await page.locator('.paragraph-comments .comment').first().waitFor();
  assert.ok(await page.locator('.reading-canvas').evaluate(el => el.clientWidth) >= 360);
  await page.getByRole('button', { name: '关闭段评', exact: true }).click();
  check('Paragraph panel remains usable at the minimum desktop size');
  await mkdir('test-output', { recursive: true });
  await page.screenshot({ path: 'test-output/reader-features-900.png' });
  assert.equal(await page.evaluate(() => window.__calls.filter(c => c.command === 'official_sync_progress').length), 0);
  assert.deepEqual(errors, []);
  check('No progress writes or unhandled runtime errors in mapping and paragraph flows');
  console.log(`${passed} reader feature checks passed (mock official service and generated audio).`);
} finally { await browser?.close(); server.kill(); }
