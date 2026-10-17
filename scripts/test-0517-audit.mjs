import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateRawSync } from 'node:zlib';
const load = async source => {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
};
let passed = 0;
const check = name => { passed++; console.log('PASS ' + name); };
const { compareSemver, checkForUpdate, CURRENT_VERSION } = await load(await readFile('src/lib/updater.ts', 'utf8'));
assert.equal(compareSemver('1.0.0', '1.0.0-beta.1'), -1);
assert.equal(compareSemver('1.0.0-beta.2', '1.0.0-beta.10'), 1);
assert.equal(compareSemver('1.0.0-1', '1.0.0-alpha'), 1);
assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), 1);
assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), 1);
assert.equal(compareSemver('1.0.0+local.50', '1.0.0+build.99'), 0);
for (const bad of ['0.5', 'version-0.5.17', '1.0.0-01', '01.0.0']) assert.throws(() => compareSemver('1.0.0', bad));
check('Semantic versions preserve prerelease precedence, ignore build metadata and reject malformed tags');
const originalFetch = globalThis.fetch, originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
try {
  let timer, cleared = 0;
  globalThis.setTimeout = fn => { timer = fn; return 17; };
  globalThis.clearTimeout = () => { cleared++; };
  globalThis.fetch = async () => { throw Error('offline'); };
  assert.match((await checkForUpdate()).error, /offline/);
  assert.equal(cleared, 1);
  check('Failed update requests always clear the abort timer');
  let signal;
  globalThis.fetch = async (_, options) => {
    signal = options.signal;
    return { ok: true, json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('body aborted')))) };
  };
  const pending = checkForUpdate();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(cleared, 1, 'body still being read must retain its timeout');
  timer();
  assert.match((await pending).error, /body aborted/);
  assert.equal(cleared, 2);
  check('Update timeout covers stalled response bodies as well as response headers');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v9.0.0-beta.1' }) });
  assert.equal((await checkForUpdate()).hasUpdate, false);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ tag_name: null }) });
  assert.ok((await checkForUpdate()).error);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v99.0.0', assets: [] }) });
  assert.equal((await checkForUpdate()).hasUpdate, true);
  check('Update checks exclude preview releases, reject bad responses and still detect stable releases');
} finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear; }
const nativeSpeechSource = (await readFile('src/lib/localSpeech.ts', 'utf8'))
  .replace("import { invoke } from '@tauri-apps/api/core';", 'const invoke = (...args) => globalThis.__auditInvoke(...args);')
  .replace("import { base64ToBlobUrl } from './media';", 'const base64ToBlobUrl = (...args) => globalThis.__auditBlob(...args);');
const { LocalSpeechReader } = await load(nativeSpeechSource);
const originalAudio = globalThis.Audio, originalRevoke = URL.revokeObjectURL;
try {
  for (const action of ['stop', 'pause', 'replace']) {
    let resolveBlob, waiting = false, audioCreated = 0, revoked = [], errors = [];
    globalThis.Audio = class { constructor() { audioCreated++; } };
    URL.revokeObjectURL = value => revoked.push(value);
    globalThis.__auditInvoke = async (command, args) => command === 'kokoro_begin' ? 2
      : command === 'kokoro_synthesize' ? { session: args.session, mime: 'audio/wav', audioBase64: 'YQ==' } : undefined;
    globalThis.__auditBlob = () => { waiting = true; return new Promise(resolve => { resolveBlob = resolve; }); };
    const reader = new LocalSpeechReader(() => {}, () => {}, message => errors.push(message));
    reader.setText(['旧段落。']); reader.start();
    for (let i = 0; i < 100 && !waiting; i++) await delay(1);
    assert.ok(waiting);
    if (action === 'replace') reader.setText(['新段落。']); else reader[action]();
    resolveBlob('blob:cancelled');
    await delay(5);
    assert.equal(audioCreated, 0);
    assert.deepEqual(revoked, ['blob:cancelled']);
    assert.deepEqual(errors, []);
    reader.stop();
    check('Cancelled offline audio cannot start after blob conversion: ' + action);
  }
} finally { globalThis.Audio = originalAudio; URL.revokeObjectURL = originalRevoke; delete globalThis.__auditInvoke; delete globalThis.__auditBlob; }
const build = await readFile('src-tauri/build.rs', 'utf8');
const capability = JSON.parse(await readFile('src-tauri/capabilities/main.json', 'utf8'));
for (const command of ['kokoro_pick_directory', 'kokoro_uninstall']) {
  assert.ok(build.includes('"' + command + '"'));
  assert.ok(capability.permissions.includes('allow-' + command.replaceAll('_', '-')));
  const permission = await readFile('src-tauri/permissions/autogenerated/' + command + '.toml', 'utf8');
  assert.ok(permission.includes(command));
}
check('New native speech commands have matching manifest, permission and capability declarations');

// ZIP fixtures use real central/local headers and CRC; images need not be unpacked.
const table = Array.from({ length: 256 }, (_, n) => {
  let crc = n; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(buffer) { let crc = 0xffffffff; for (const b of buffer) crc = table[(crc ^ b) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const chunks = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), bytes = Buffer.from(entry.text ?? ''), method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(bytes) : bytes, crc = crc32(bytes) ^ (entry.corrupt ? 1 : 0);
    const local = Buffer.alloc(30), dir = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.expanded ?? bytes.length, 22); local.writeUInt16LE(name.length, 26);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc >>> 0, 16); dir.writeUInt32LE(compressed.length, 20); dir.writeUInt32LE(entry.expanded ?? bytes.length, 24);
    dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    chunks.push(local, name, compressed); central.push(dir, name); offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]).toString('base64');
}
function epub(body, options = {}) {
  return [
    { name: 'META-INF/container.xml', text: '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>' },
    { name: 'OPS/book.opf', text: '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>测试书</dc:title><dc:creator>作者</dc:creator></metadata><manifest><item id="c1" href="' + (options.href ?? 'c1.xhtml') + '"/></manifest><spine><itemref idref="' + (options.idref ?? 'c1') + '"/></spine></package>' },
    ...(options.missing ? [] : [{ name: options.path ?? 'OPS/c1.xhtml', text: '<html><head><title>重复的书名</title></head><body>' + body + '</body></html>', method: options.method ?? 8, corrupt: options.corrupt, expanded: options.expanded }]),
    ...(options.extra ?? []),
  ];
}
const port = 1517;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:' + port)).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(); await page.route('https://**/*', route => route.abort());
  await page.goto('http://127.0.0.1:' + port);
  const parse = entries => page.evaluate(async data => {
    const { parseEpub } = await import('/src/lib/importEpub.ts');
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    try { return { book: await parseEpub('测试.epub', bytes.buffer) }; }
    catch (error) { return { error: String(error.message) }; }
  }, zip(entries));
  let result = await parse(epub('<h1>第一章</h1><p>真的重复。</p><p>真的重复。</p>'));
  assert.equal(result.book.title, '测试书');
  assert.equal(result.book.chapters[0].title, '第一章');
  assert.equal(result.book.chapters[0].content, '第一章\n\n真的重复。\n\n真的重复。');
  check('EPUB retains identical author paragraphs and prefers the chapter heading');
  result = await parse(epub('<section><p>甲<span>乙</span>。</p><blockquote><p>引用。</p></blockquote><p>尾段。</p></section>'));
  assert.equal(result.book.chapters[0].content, '甲乙。\n\n引用。\n\n尾段。');
  check('Nested EPUB sections and blockquotes emit every text node exactly once');
  result = await parse(epub('<p>根路径正文。</p>', { href: '/Text/ch%201.xhtml?ref=1#p2', path: 'Text/ch 1.xhtml', method: 0 }));
  assert.equal(result.book.chapters[0].content, '根路径正文。');
  check('Stored ZIP text and root-relative/escaped hrefs with fragments resolve correctly');
  for (const options of [{ corrupt: true }, { missing: true }, { idref: 'absent' }]) {
    assert.ok((await parse(epub('<p>正文。</p>', options))).error);
  }
  check('Corrupted CRC, missing chapter files and broken spine references fail without partial import');
  assert.match((await parse(epub('<p>正文。</p>', { expanded: 9 * 1024 * 1024 }))).error, /超限/);
  assert.ok((await parse(epub('<p>正文。</p>', { extra: [{ name: 'OPS/c1.xhtml', text: 'duplicate' }] }))).error);
  check('EPUB text budgets and duplicate resource paths are enforced before use');
  result = await parse(epub('<p>纯文本。</p>', { extra: [{ name: 'images/huge.jpg', expanded: 0x7fffffff, method: 99 }] }));
  assert.equal(result.book.chapters[0].content, '纯文本。');
  check('Unused binary resources are skipped without decompression');
  const oversized = await page.evaluate(async () => {
    const { importEpub } = await import('/src/lib/importEpub.ts');
    let read = false;
    try { await importEpub({ name: 'big.epub', size: 65 * 1024 * 1024, arrayBuffer: () => { read = true; throw Error('must not read'); } }); }
    catch (error) { return { read, message: error.message }; }
  });
  assert.equal(oversized.read, false); assert.match(oversized.message, /64 MiB/);
  check('Oversized EPUB is rejected before reading its file into memory');
  console.log(passed + ' audit regression checks passed; current version ' + CURRENT_VERSION);
} finally { await browser?.close(); server.kill(); }
