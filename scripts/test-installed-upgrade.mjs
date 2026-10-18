// Requires two real installers built with a dedicated test identifier, product
// name, profile directory and --remote-debugging-port=1540. Never target the
// user's production installation. See TEST_REPORT-0.5.21.md for the procedure.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const mode = process.argv[2], dir = process.env.MOYU_UPGRADE_TEST_DIR, expectedFile = process.env.MOYU_UPGRADE_EXPECTED;
assert.ok(dir && expectedFile && ['seed', 'verify'].includes(mode), 'Set the isolated test directory and expected-data file');
let browser; const errors = [];
async function connect() {
  for (let i = 0; i < 300; i++) { try { if ((await fetch('http://127.0.0.1:1540/json/version')).ok) return chromium.connectOverCDP('http://127.0.0.1:1540'); } catch {} await delay(100); }
  assert.fail('Isolated upgrade-test application did not open');
}
const stored = page => page.evaluate(async () => {
  const active = JSON.parse(localStorage.getItem('tomato-reader-v01:restored-state') ?? 'null');
  const books = await new Promise((resolve, reject) => { const req = indexedDB.open(active?.database ?? 'tomato-reader-library', 1); req.onsuccess = () => { const db = req.result, tx = db.transaction('books'); const result = tx.objectStore('books').getAll(); tx.oncomplete = () => { db.close(); resolve(result.result); }; tx.onabort = reject; }; });
  return JSON.parse(JSON.stringify({ books, preferences: active?.preferences ?? JSON.parse(localStorage.getItem('tomato-reader-v01:preferences')), progress: active?.progress ?? JSON.parse(localStorage.getItem('tomato-reader-v01:progress')) }));
});
try {
  if (mode === 'seed') {
    const env = { ...process.env }; delete env.WEBVIEW2_USER_DATA_FOLDER; delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
    const child = spawn(join(dir, 'tomato-reader.exe'), [], { env, detached: true, windowsHide: true, stdio: 'ignore' }); child.unref();
  }
  browser = await connect(); const page = browser.contexts()[0].pages()[0]; page.on('pageerror', e => errors.push(e.message));
  await page.locator('.app-shell').waitFor();
  assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|title', { label: 'main' })), '墨屿升级验证');
  if (mode === 'seed') {
    const existing = await page.locator('.book-card').count();
    if (existing) assert.deepEqual((await stored(page)).books.map(b => b.id).sort(), ['upgrade-local', 'upgrade-official'], 'Reuse only this test fixture, never unrelated data');
    await page.evaluate(async () => {
      const content = Array.from({ length: 28 }, (_, i) => `第${i + 1}段${'覆盖升级验证用正文。'.repeat(10)}`).join('\n\n');
      const books = [{ id: 'upgrade-local', title: '升级保留本地书', author: '合成测试', description: '', source: 'local', coverStyle: 0, addedAt: 1, chapters: [0, 1].map(i => ({ id: 'ul-' + i, title: '第' + (i + 1) + '章', content, loaded: true })) },
        { id: 'upgrade-official', title: '升级保留官方目录', author: '合成测试', description: '', source: 'official', coverStyle: 1, addedAt: 2, chapters: Array.from({ length: 5 }, (_, i) => ({ id: 'uo-' + i, title: '官方第' + (i + 1) + '章', content: '', loaded: false })) }];
      await new Promise((resolve, reject) => { const req = indexedDB.open('tomato-reader-library', 1); req.onsuccess = () => { const db = req.result, tx = db.transaction(['books', 'metadata'], 'readwrite', { durability: 'strict' }); for (const b of books) tx.objectStore('books').put(b); tx.objectStore('metadata').put(books.map(b => b.id), 'book-order'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = reject; }; });
      localStorage.setItem('tomato-reader-v01:preferences', JSON.stringify({ theme: 'night', fontSize: 23, lineHeight: 2.15, contentWidth: 840, readingMode: 'continuous', autoUploadProgress: false, showParagraphComments: false }));
      localStorage.setItem('tomato-reader-v01:progress', JSON.stringify({ 'upgrade-local': { chapterIndex: 1, scrollRatio: .375, paragraphIndex: 8, updatedAt: 120 }, 'upgrade-official': { chapterIndex: 3, scrollRatio: .22, paragraphIndex: 2, updatedAt: 119 } }));
    });
    await page.reload(); await page.getByRole('button', { name: '阅读设置', exact: true }).click();
    await page.getByText('当前版本: v0.5.20', { exact: true }).waitFor();
    await writeFile(expectedFile, JSON.stringify(await stored(page)), 'utf8');
    console.log('PASS Real 0.5.20 installed test copy has two persisted books, chapter/paragraph progress and non-default preferences');
  } else {
    const expected = JSON.parse(await readFile(expectedFile, 'utf8'));
    assert.deepEqual(await stored(page), expected);
    await page.getByRole('button', { name: '阅读设置', exact: true }).click();
    await page.getByText('当前版本: v0.5.21', { exact: true }).waitFor();
    console.log('PASS Installer restarted the upgraded 0.5.21 application; books, local full text, both reading records and all settings match the old version exactly');
    let list;
    for (let i = 0; i < 80; i++) { list = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('backup_list')); if (list.backups.some(b => b.kind === 'auto')) break; await delay(100); }
    assert.ok(list.path.includes('dev.moyu.upgradecheck.20261018'), list.path);
    const backup = list.backups.find(b => b.kind === 'auto'); assert.ok(backup?.valid);
    const payload = await page.evaluate(id => window.__TAURI_INTERNALS__.invoke('backup_load', { id }), backup.id);
    const data = JSON.parse(payload); assert.equal(data.books.length, 2); assert.equal(data.books.find(b => b.source === 'local').chapters[0].content, expected.books.find(b => b.source === 'local').chapters[0].content);
    assert.deepEqual(data.progress, expected.progress); assert.equal(data.preferences.fontSize, 23);
    console.log('PASS New native backup service created and checksum-verified a real disk snapshot of the retained data after upgrading');
    await page.evaluate(async () => {
      const req = indexedDB.open('tomato-reader-library', 1); await new Promise((resolve, reject) => { req.onerror = reject; req.onsuccess = () => { const db = req.result, tx = db.transaction('books', 'readwrite'); tx.objectStore('books').put({ id: 'extra-before-restore', title: '恢复前额外书籍', author: '测试', description: '', source: 'local', coverStyle: 0, addedAt: 3, chapters: [{ id: 'extra', title: '第一章', content: '原数据库必须保留此书', loaded: true }] }); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = reject; }; });
      const prefs = JSON.parse(localStorage.getItem('tomato-reader-v01:preferences')); prefs.fontSize = 24; localStorage.setItem('tomato-reader-v01:preferences', JSON.stringify(prefs));
    });
    await page.reload(); await page.getByRole('button', { name: '阅读设置', exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator(`[data-backup-id="${backup.id}"]`).getByRole('button', { name: '恢复此备份', exact: true }).click();
    await page.locator('.book-card').first().waitFor();
    assert.deepEqual(await stored(page), expected);
    const originalCount = await page.evaluate(() => new Promise(resolve => { const req = indexedDB.open('tomato-reader-library', 1); req.onsuccess = () => { const db = req.result, tx = db.transaction('books'); const request = tx.objectStore('books').count(); tx.oncomplete = () => { db.close(); resolve(request.result); }; }; }));
    assert.equal(originalCount, 3);
    const protectedList = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('backup_list'));
    assert.ok(protectedList.backups.some(b => b.kind === 'before-restore' && b.books === 3));
    console.log('PASS Real native recovery restores the disk snapshot, preserves the original three-book database and creates a pre-restore disk backup');
    await writeFile(expectedFile + '.result.json', JSON.stringify({ passed: true, from: '0.5.20', to: '0.5.21', books: expected.books.length, progressRecords: Object.keys(expected.progress).length, diskBackup: true, restoreVerified: true }, null, 2));
    // The installer test owns only this dedicated application instance.
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' })).catch(error => { if (!page.isClosed()) throw error; });
  }
  assert.deepEqual(errors, []);
} finally { await browser?.close(); }
