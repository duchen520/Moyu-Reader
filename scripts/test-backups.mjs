import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const port = 1537, server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
let browser, passed = 0; const records = [], errors = [];
const check = text => { passed++; console.log('PASS ' + text); };
const content = Array.from({ length: 30 }, (_, i) => `第${i + 1}段${'备份恢复验证正文。'.repeat(12)}`).join('\n\n');
async function fixture(damaged = false, brokenPreferences = false) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  p.on('pageerror', e => { if (!(brokenPreferences && /Cannot read properties of null/.test(e.message))) errors.push(e.message); });
  await p.exposeFunction('__backupBridge', async (command, args) => {
    if (command === 'backup_list') return { path: 'test-backups', backups: records.map(r => r.info).reverse() };
    if (command === 'backup_create') {
      const data = JSON.parse(args.payload), createdAt = Date.now() + records.length;
      const info = { id: 'backup-' + records.length, createdAt, kind: args.kind, version: data.version, books: data.books.length, localBooks: data.books.filter(b => b.source === 'local').length, bytes: args.payload.length, valid: true };
      records.push({ info, data }); return info;
    }
    if (command === 'backup_load') return JSON.stringify(records.find(r => r.info.id === args.id).data);
    throw Error('Unexpected backup command');
  });
  await p.addInitScript(({ damaged, brokenPreferences, content }) => {
    if (!sessionStorage.getItem('seeded')) {
      const books = [{ id: 'local-test', title: '备份本地书', author: '测试作者', description: '', source: 'local', coverStyle: 0, addedAt: 1, privateSession: 'must-not-export',
        chapters: [0, 1].map(i => ({ id: 'l' + i, title: '第' + (i + 1) + '章', content, loaded: true })) },
        { id: 'official-test', title: '备份官方书', author: '测试作者', description: '', source: 'official', coverStyle: 1, addedAt: 1,
          chapters: Array.from({ length: 60 }, (_, i) => ({ id: 'o' + i, title: '第' + (i + 1) + '章', content: '不应写进备份的官方缓存正文', loaded: true })) }];
      localStorage.setItem('tomato-reader-v01:books', JSON.stringify(books));
      localStorage.setItem('tomato-reader-v01:progress', JSON.stringify({ 'local-test': { chapterIndex: 1, scrollRatio: .25, paragraphIndex: 5, updatedAt: 123 }, 'official-test': { chapterIndex: 48, scrollRatio: .4, updatedAt: 122 } }));
      localStorage.setItem('tomato-reader-v01:preferences', JSON.stringify({ theme: 'night', fontSize: 19, lineHeight: 1.95, contentWidth: 760, readingMode: 'continuous', autoUploadProgress: true }));
      if (brokenPreferences) localStorage.setItem('tomato-reader-v01:preferences', 'null');
      sessionStorage.setItem('seeded', 'yes');
    }
    if (damaged) {
      const getAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function(...args) { if (this.transaction.db.name === 'tomato-reader-library' && this.name === 'books') throw Error('模拟原数据库无法读取'); return getAll.apply(this, args); };
    }
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === 'official_account') return null;
      if (command === 'official_cancel_login') return;
      if (command.startsWith('backup_')) return window.__backupBridge(command, args);
      throw Error('Unexpected native command: ' + command);
    } };
  }, { damaged, brokenPreferences, content });
  await p.goto(`http://127.0.0.1:${port}`); return p;
}
const settings = p => p.getByRole('button', { name: '阅读设置', exact: true }).click();
const restoreButton = (p, id) => p.locator(`[data-backup-id="${id}"]`).getByRole('button', { name: '恢复此备份', exact: true });
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true });
  const p = await fixture();
  for (let i = 0; i < 80 && !records.length; i++) await delay(100);
  assert.equal(records.length, 1); assert.equal(records[0].info.kind, 'auto');
  const original = records[0], id = original.info.id;
  assert.equal(original.data.books[0].chapters[0].content, content);
  assert.ok(original.data.books[1].chapters.every(c => !c.content && c.loaded === false));
  assert.equal(original.data.progress['official-test'].chapterIndex, 48);
  assert.ok(!JSON.stringify(original.data).includes('must-not-export'));
  check('Startup backs up full local text, official catalogs, progress and preferences while excluding cached official text and extra private fields');
  await settings(p);
  await p.getByRole('button', { name: '增大字体', exact: true }).click();
  await p.evaluate(() => {
    window.__fileText = File.prototype.text;
    File.prototype.text = async function() { await new Promise(resolve => window.__releaseImport = resolve); return window.__fileText.call(this); };
  });
  await p.locator('input[type=file]').setInputFiles({ name: '恢复前新增.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 新书\n这本书必须在原数据库和恢复前快照中保留。') });
  await p.waitForFunction(() => !!window.__releaseImport);
  await restoreButton(p, id).click();
  await p.getByText('书籍仍在导入，请等待导入保存完成后再恢复。', { exact: true }).waitFor();
  assert.equal(await p.evaluate(() => localStorage.getItem('tomato-reader-v01:restored-state')), null);
  await p.evaluate(() => { File.prototype.text = window.__fileText; window.__releaseImport(); });
  check('Restoring cannot interrupt a file that is still being imported');
  await p.waitForFunction(() => document.querySelectorAll('.book-card').length === 3);
  await settings(p);
  await p.getByRole('button', { name: '刷新备份列表', exact: true }).click();
  // Make the atomic pointer commit fail. The newly written database must not
  // replace any original records, even though the recovery copy is complete.
  await p.evaluate(() => {
    window.__setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === 'tomato-reader-v01:restored-state') throw new DOMException('测试恢复索引容量不足', 'QuotaExceededError'); return window.__setItem.call(this, key, value); };
  });
  p.once('dialog', dialog => dialog.accept());
  await restoreButton(p, id).click();
  await p.locator('.backup-panel [role=alert]').waitFor();
  assert.equal(await p.evaluate(() => localStorage.getItem('tomato-reader-v01:restored-state')), null);
  const originalCount = await p.evaluate(() => new Promise((resolve, reject) => { const req = indexedDB.open('tomato-reader-library', 1); req.onsuccess = () => { const db = req.result, tx = db.transaction('books'); const count = tx.objectStore('books').count(); tx.oncomplete = () => { db.close(); resolve(count.result); }; tx.onabort = reject; }; }));
  assert.equal(originalCount, 3);
  assert.ok(records.some(r => r.info.kind === 'before-restore' && r.info.books === 3 && r.data.preferences.fontSize === 20));
  check('A failed restore-index commit leaves the original three-book database selected and creates a protective pre-restore snapshot');
  await p.evaluate(() => { Storage.prototype.setItem = window.__setItem; });
  p.once('dialog', dialog => dialog.accept());
  await restoreButton(p, id).click();
  await p.locator('.book-card').first().waitFor();
  assert.equal(await p.locator('.book-card').count(), 2);
  const restored = await p.evaluate(() => JSON.parse(localStorage.getItem('tomato-reader-v01:restored-state')));
  assert.match(restored.database, /^tomato-reader-library-recovery-/);
  assert.equal(restored.progress['local-test'].scrollRatio, .25);
  assert.equal(restored.preferences.fontSize, 19); assert.equal(restored.preferences.autoUploadProgress, false);
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('tomato-reader-v01:preferences')).fontSize), 20);
  await settings(p);
  await p.getByRole('button', { name: '增大字体', exact: true }).click();
  await p.reload(); await p.locator('.book-card').first().waitFor();
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('tomato-reader-v01:restored-state')).preferences.fontSize), 20);
  assert.equal(await p.locator('.book-card').count(), 2);
  check('Successful restore switches book database, progress and preferences atomically, disables cloud upload, preserves original data, and remains writable after reload');
  await p.close();
  const broken = await fixture(true);
  await broken.getByRole('heading', { name: '本地书架暂时无法读取', exact: true }).waitFor();
  assert.equal(await broken.getByRole('button', { name: '立即备份', exact: true }).count(), 0);
  await restoreButton(broken, id).waitFor();
  broken.once('dialog', dialog => dialog.accept());
  await restoreButton(broken, id).click();
  await broken.locator('.book-card').first().waitFor();
  assert.equal(await broken.locator('.book-card').count(), 2);
  assert.ok(await broken.evaluate(() => localStorage.getItem('tomato-reader-v01:books')), 'Damaged legacy source must remain preserved');
  check('The startup error screen can recover into a fresh database while the original database remains unreadable and legacy data is retained');
  await broken.close();
  const invalidPrefs = await fixture(false, true);
  await invalidPrefs.locator('.book-card').first().waitFor();
  await settings(invalidPrefs);
  await invalidPrefs.getByRole('alert').filter({ hasText: '部分设置或进度格式异常' }).waitFor();
  const backupCount = records.length;
  await invalidPrefs.evaluate(() => localStorage.setItem('tomato-reader-v01:preferences', JSON.stringify({ fontSize: 999 })));
  const invalidBackup = await invalidPrefs.evaluate(async () => {
    try { await (await import('/src/lib/backups.ts')).createBackup('auto'); return 'unexpected success'; }
    catch (error) { return String(error); }
  });
  assert.match(invalidBackup, /旧备份已保留/);
  assert.equal(records.length, backupCount, 'Invalid known fields cannot silently replace healthy backups with defaults');
  await restoreButton(invalidPrefs, id).waitFor();
  invalidPrefs.once('dialog', dialog => dialog.accept());
  await restoreButton(invalidPrefs, id).click();
  await invalidPrefs.locator('.book-card').first().waitFor();
  assert.equal(await invalidPrefs.locator('.book-card').count(), 2);
  check('Malformed preferences retain a usable shelf and can be recovered from settings without replacing the original records');
  assert.deepEqual(errors, []);
  console.log(`${passed} backup/recovery checks passed with actual IndexedDB and a mocked disk bridge.`);
} finally { await browser?.close(); server.kill(); }
