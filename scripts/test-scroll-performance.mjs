import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1492', '--strictPort'], { stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:1492')).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await page.addInitScript(() => {
    const book = { id: 'scroll-perf', title: '滚动压力测试', author: '本机测试', description: '', source: 'local', coverStyle: 0, addedAt: 1,
      chapters: Array.from({ length: 3500 }, (_, index) => ({ id: `perf-${index}`, title: `第${index + 1}章 性能测试`,
        content: index ? '后续章节的测试正文。' : Array.from({ length: 1200 }, (_, i) => `段落${i}：${'这是长章节滚动测试文字。'.repeat(6)}`).join('\n\n'), loaded: true })) };
    localStorage.setItem('tomato-reader-v01:books', JSON.stringify([book]));
    window.__paragraphRects = 0;
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { if (this.matches('.story-content p')) window.__paragraphRects++; return rect.call(this); };
    window.__scrollWrites = 0;
    const property = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(Element.prototype, 'scrollTop', { ...property, set(value) { if (this.matches('.reading-canvas')) window.__scrollWrites++; property.set.call(this, value); } });
  });
  await page.goto('http://127.0.0.1:1492');
  await page.getByRole('button', { name: '阅读 滚动压力测试', exact: true }).click();
  await page.locator('.story-content p').last().waitFor();
  await page.waitForTimeout(400);
  const sample = await page.evaluate(() => {
    const canvas = document.querySelector('.reading-canvas');
    window.__paragraphRects = 0;
    const before = performance.now();
    for (let i = 0; i < 60; i++) {
      canvas.scrollTop = (canvas.scrollHeight - canvas.clientHeight) * (.7 + i * .003);
      canvas.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    return { paragraphCount: document.querySelectorAll('.story-content p').length, chapterCount: document.querySelectorAll('.chapter-item').length,
      scrollEvents: 60, paragraphRectReads: window.__paragraphRects, synchronousScrollWorkMs: +(performance.now() - before).toFixed(2) };
  });
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tomato-reader-v01:progress'))['scroll-perf']);
  assert.ok(saved.scrollRatio > .87 && saved.scrollRatio < .88);
  assert.ok(saved.paragraphIndex > 800);
  await page.getByRole('button', { name: '阅读 滚动压力测试', exact: true }).click();
  await page.locator('.story-content p').last().waitFor();
  await page.getByTitle('听书与自动翻页').click();
  await page.locator('.reading-canvas').evaluate(el => el.scrollTop = 1000);
  await page.getByRole('button', { name: '自动阅读', exact: true }).click();
  await page.getByRole('button', { name: '平滑滚动', exact: true }).click();
  await page.getByLabel('自动滚动速度').fill('80');
  const measure = async () => page.evaluate(() => new Promise(resolve => {
    window.__scrollWrites = 0;
    const canvas = document.querySelector('.reading-canvas');
    const times = [], positions = [], visualPositions = [];
    const paper = document.querySelector('.page-paper');
    let start;
    function tick(time) {
      start ??= time; times.push(time); positions.push(canvas.scrollTop); visualPositions.push(-paper.getBoundingClientRect().top);
      if (time - start < 1200) requestAnimationFrame(tick);
      else resolve({ frames: times.length, elapsedMs: time - start, scriptScrollWrites: window.__scrollWrites,
        movingFrames: visualPositions.filter((value, i) => i && Math.abs(value - visualPositions[i - 1]) > .05).length,
        nativeScrollMovingFrames: positions.filter((value, i) => i && Math.abs(value - positions[i - 1]) > .1).length,
        distancePx: positions.at(-1) - positions[0] });
    }
    requestAnimationFrame(tick);
  }));
  const frames = await measure();
  await page.getByLabel('自动滚动速度').fill('25');
  const lowSpeed = await measure();
  await page.locator('.reading-canvas').evaluate(el => el.scrollTop += 2);
  const manual = await page.locator('.reading-canvas').evaluate(el => el.scrollTop);
  await page.waitForTimeout(200);
  const resumed = await page.locator('.reading-canvas').evaluate(el => el.scrollTop);
  assert.ok(resumed > manual && resumed < manual + 12, 'Small manual scrolling must resume from its new position without snapping back');
  await page.getByRole('button', { name: '收起面板', exact: true }).click();
  await page.getByRole('button', { name: '暂停播放', exact: true }).click();
  const paused = await page.locator('.reading-canvas').evaluate(el => el.scrollTop);
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.reading-canvas').evaluate(el => el.scrollTop), paused);
  await page.getByRole('button', { name: '继续播放', exact: true }).click();
  await page.waitForTimeout(200);
  assert.ok(await page.locator('.reading-canvas').evaluate(el => el.scrollTop) > paused);
  await page.locator('.audio-mini-pill').getByTitle('停止', { exact: true }).click();
  assert.equal(await page.locator('.page-paper').evaluate(el => el.style.transform), '');
  assert.equal(await page.locator('.page-paper').evaluate(el => el.style.willChange), '');
  const result = { sample, automatic: frames, lowSpeed };
  await mkdir('test-output', { recursive: true });
  await writeFile(`test-output/scroll-${process.env.TOMATO_PERF_LABEL ?? 'current'}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (process.env.TOMATO_PERF_BASELINE !== '1') {
    assert.ok(sample.paragraphRectReads < sample.scrollEvents * 20, 'Scroll tracking should not scan all paragraphs');
    assert.ok(frames.movingFrames / frames.frames > .65, 'Automatic scrolling should advance on most display frames');
    assert.ok(lowSpeed.movingFrames / lowSpeed.frames > .65, 'Default slow speed should preserve fractional visual movement');
    assert.ok(Math.abs(frames.distancePx - 80 * frames.elapsedMs / 1000) < 4);
    assert.ok(Math.abs(lowSpeed.distancePx - 25 * lowSpeed.elapsedMs / 1000) < 4);
  }
  console.log('PASS Long chapter scroll tracking and immediate exit preserve the correct reading position');
} finally { await browser?.close(); server.kill(); }
