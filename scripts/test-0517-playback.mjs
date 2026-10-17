import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
function wav() {
  const w = Buffer.alloc(44 + 24000 * 2 * 15);
  w.write('RIFF'); w.writeUInt32LE(w.length - 8, 4); w.write('WAVEfmt ', 8);
  w.writeUInt32LE(16, 16); w.writeUInt16LE(1, 20); w.writeUInt16LE(1, 22);
  w.writeUInt32LE(24000, 24); w.writeUInt32LE(48000, 28); w.writeUInt16LE(2, 32); w.writeUInt16LE(16, 34);
  w.write('data', 36); w.writeUInt32LE(w.length - 44, 40); return w.toString('base64');
}
const port = 1518;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
let browser, passed = 0;
const check = name => { passed++; console.log('PASS ' + name); };
const errors = [];
async function fixture() {
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  p.on('pageerror', error => errors.push(error.message));
  await p.route('https://**/*', route => route.abort());
  await p.addInitScript(audio => {
    window.isTauri = true; window.__calls = []; window.__session = 1; window.__blobHeld = false; window.__holdBlob = false;
    window.__handlers = {}; window.__revoked = [];
    Object.defineProperty(navigator, 'mediaSession', { value: {
      metadata: null, playbackState: 'none', setPositionState() {},
      setActionHandler(action, callback) { window.__handlers[action] = callback; },
    } });
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (String(args[0]).startsWith('data:') && window.__holdBlob) {
        window.__blobHeld = true;
        await new Promise(resolve => { window.__releaseBlob = () => { window.__holdBlob = false; resolve(); }; });
      }
      return response;
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { window.__revoked.push(url); revoke(url); };
    Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel() {}, speak() {} } });
    window.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      window.__calls.push({ command, args });
      if (command === 'official_account') return null;
      if (command === 'official_cancel_login') return;
      if (command === 'official_read_progress') return [];
      if (command === 'official_book') return { id: args.id, title: '播放回归', author: '测试', source: 'official', description: '', coverStyle: 0, addedAt: 0,
        chapters: [{ id: '7083521020400763392', title: '第一章', content: '第一段内容。', loaded: true }, { id: '7083521020400763393', title: '第二章', content: '第二章内容。', loaded: true }] };
      if (command === 'official_audio_catalog') return { albums: [{ id: '7000000000000000001', name: '测试专辑', narrator: '测试主播' }], ttsTones: [{ id: '74', name: '测试音色' }] };
      if (command === 'official_audio_episodes') return [{ id: '7000000000000000011', title: '第一集' }, { id: '7000000000000000012', title: '第二集' }, { id: '7000000000000000013', title: '第三集' }];
      if (command === 'official_audio_alignment') return { matched: false, chapterId: args.chapterId, albumId: args.albumId };
      if (command === 'official_audio_play') return { itemId: args.itemId, urls: [], audioBase64: audio, mime: 'audio/mp4' };
      if (command === 'official_tts_play') return { itemId: args.itemId, toneId: args.toneId, urls: [], audioBase64: audio, mime: 'audio/mp4' };
      if (command === 'kokoro_status') return { installed: true, engineAvailable: true, importing: false };
      if (command === 'kokoro_begin') return ++window.__session;
      if (command === 'kokoro_stop') return;
      if (command === 'kokoro_synthesize') return { session: args.session, audioBase64: audio, mime: 'audio/wav' };
      throw Error('Unexpected fixture command ' + command);
    } };
  }, wav());
  await p.goto('http://127.0.0.1:' + port);
  await p.locator('.side-nav button').filter({ hasText: '找书发现' }).click();
  await p.getByRole('button', { name: '通过番茄链接或书籍ID直接打开作品' }).click();
  await p.getByLabel('打开正版作品').fill('7069948840148732967');
  await p.getByRole('button', { name: '打开作品', exact: true }).click();
  await p.locator('.story-content p').first().waitFor();
  await p.getByTitle('听书与自动翻页').click();
  return p;
}
async function tab(p, name) { await p.getByRole('button', { name, exact: true }).click(); }
async function running(p, selector) { await p.waitForFunction(selector => { const a = document.querySelector(selector); return a && !a.paused && a.currentTime > 0; }, selector); }
async function media(p, action) { await p.evaluate(action => window.__handlers[action](), action); }
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:' + port)).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  {
    const p = await fixture(); await tab(p, '官方有声');
    await p.getByRole('button', { name: '播放本集', exact: true }).waitFor();
    await p.getByRole('button', { name: '播放本集', exact: true }).click();
    await running(p, '.official-audio audio');
    await p.waitForFunction(() => navigator.mediaSession.metadata?.title === '第一集');
    await media(p, 'nexttrack');
    await p.waitForFunction(() => window.__calls.filter(c => c.command === 'official_audio_play').at(-1)?.args.itemId === '7000000000000000012');
    await running(p, '.official-audio audio');
    assert.match(await p.locator('.page-paper h1').textContent(), /第一章/);
    await p.waitForFunction(() => navigator.mediaSession.metadata?.title === '第二集');
    check('OS next-track selects the next audio episode, keeps the text chapter and updates metadata');
    await p.evaluate(() => { window.__handlers.pause(); window.__handlers.pause(); });
    assert.ok(await p.locator('.official-audio audio').evaluate(a => a.paused));
    await p.evaluate(() => { window.__handlers.play(); window.__handlers.play(); });
    await running(p, '.official-audio audio');
    await p.evaluate(() => window.__handlers.seekto({})); // An absent seekTime is ignored.
    await p.evaluate(() => window.__handlers.seekto({ seekTime: 7 }));
    assert.ok(await p.locator('.official-audio audio').evaluate(a => a.currentTime >= 7));
    check('Repeated OS play/pause stays idempotent and seeking reaches the current audio');
    await p.getByLabel('有声集数', { exact: true }).selectOption('2');
    await p.waitForFunction(() => document.querySelector('.official-audio audio')?.getAttribute('src') === null);
    await p.evaluate(() => { window.__handlers.play(); window.__handlers.play(); });
    await p.waitForFunction(() => window.__calls.filter(c => c.command === 'official_audio_play').at(-1)?.args.itemId === '7000000000000000013');
    await running(p, '.official-audio audio');
    assert.equal(await p.evaluate(() => window.__calls.filter(c => c.command === 'official_audio_play' && c.args.itemId === '7000000000000000013').length), 1);
    check('OS play loads a newly selected episode once, even when invoked twice immediately');
    await p.close();
  }
  for (const kind of ['tts', 'audio']) {
    const p = await fixture(); await tab(p, kind === 'tts' ? '番茄AI音色' : '官方有声');
    await p.evaluate(() => { window.__holdBlob = true; });
    await p.getByRole('button', { name: kind === 'tts' ? '播放本章' : '播放本集', exact: true }).click();
    await p.waitForFunction(() => window.__blobHeld);
    if (kind === 'tts') await p.getByRole('button', { name: '停止AI朗读', exact: true }).click();
    else await p.locator('.chapter-item').nth(1).click();
    await p.evaluate(() => window.__releaseBlob());
    await p.waitForFunction(() => window.__revoked.length > 0);
    assert.equal(await p.locator('audio').evaluateAll(audios => audios.every(a => a.paused && !a.getAttribute('src'))), true);
    check('Cancelled ' + kind + ' playback discards a late blob and never attaches stale audio');
    await p.close();
  }
  for (const kind of ['tts', 'kokoro']) {
    const p = await fixture(); await tab(p, kind === 'tts' ? '番茄AI音色' : 'Kokoro 离线语音');
    await p.getByRole('button', { name: kind === 'tts' ? '播放本章' : '开始离线朗读', exact: true }).click();
    if (kind === 'tts') await running(p, '.official-tts audio');
    else await p.getByRole('button', { name: '暂停离线朗读', exact: true }).waitFor();
    await p.evaluate(() => { window.__handlers.pause(); window.__handlers.pause(); });
    await p.getByRole('button', { name: kind === 'tts' ? '播放本章' : '继续离线朗读', exact: true }).waitFor();
    await p.evaluate(() => { window.__handlers.play(); window.__handlers.play(); });
    if (kind === 'tts') await running(p, '.official-tts audio');
    else await p.getByRole('button', { name: '暂停离线朗读', exact: true }).waitFor();
    check('Repeated OS pause/play cannot toggle ' + kind + ' playback in the opposite direction');
    await p.close();
  }
  assert.deepEqual(errors, []);
  check('Playback regressions produce no unhandled browser errors');
  console.log(passed + ' playback audit checks passed (mock native responses, generated WAV audio)');
} finally { await browser?.close(); server.kill(); }
