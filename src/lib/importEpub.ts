import type { Book, Chapter } from '../types';

const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_TEXT_FILE = 8 * 1024 * 1024;
const MAX_TEXT_TOTAL = 32 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function normalizePath(base: string, relative: string): string {
  const path = decodeURIComponent(relative.split(/[?#]/, 1)[0]);
  const parts = (path.startsWith('/') ? [] : base.split('/').slice(0, -1)).concat(path.split('/'));
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!stack.length) throw Error('EPUB 资源路径超出了书籍目录');
      stack.pop();
    } else stack.push(part);
  }
  return stack.join('/');
}
function lookup(files: Map<string, Uint8Array>, path: string) {
  const exact = files.get(path);
  if (exact) return exact;
  const matches = [...files.keys()].filter(name => name.toLowerCase() === path.toLowerCase());
  return matches.length === 1 ? files.get(matches[0]) : undefined;
}
async function inflate(bytes: Uint8Array<ArrayBuffer>, expected: number): Promise<Uint8Array> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > expected || size > MAX_TEXT_FILE) throw Error('EPUB 解压大小超限');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
async function decompressZip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  if (buffer.byteLength > MAX_ARCHIVE) throw Error('EPUB 文件不能超过64 MiB');
  const view = new DataView(buffer), raw = new Uint8Array(buffer);
  let end = -1;
  for (let i = raw.length - 22; i >= Math.max(0, raw.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === raw.length) { end = i; break; }
  }
  if (end < 0) throw Error('无效的 EPUB ZIP 索引');
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true), directory = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)
      || view.getUint16(end + 8, true) !== count || count > 4096 || count === 65535
      || directory + directorySize !== end) throw Error('EPUB 索引超限或格式不支持');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const files = new Map<string, Uint8Array>();
  let offset = directory, total = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw Error('EPUB ZIP 索引损坏');
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true), compressed = view.getUint32(offset + 20, true);
    const expanded = view.getUint32(offset + 24, true), nameSize = view.getUint16(offset + 28, true);
    const next = offset + 46 + nameSize + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    if (next > end) throw Error('EPUB ZIP 文件名索引损坏');
    const name = decoder.decode(raw.subarray(offset + 46, offset + 46 + nameSize));
    offset = next;
    // Reading text does not require unpacking all cover images, fonts or audio.
    if (!/\.(xml|opf|xhtml|html|htm|txt)$/i.test(name)) continue;
    if (files.has(name)) throw Error('EPUB 中存在重复的资源路径');
    if (flags & 1) throw Error('EPUB 正文已加密，不能直接导入');
    if (expanded > MAX_TEXT_FILE || total + expanded > MAX_TEXT_TOTAL) throw Error('EPUB 正文解压大小超限');
    if (local + 30 > directory || view.getUint32(local, true) !== 0x04034b50) throw Error('EPUB ZIP 数据位置损坏');
    const data = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (data + compressed > directory) throw Error('EPUB ZIP 数据被截断');
    const bytes = raw.subarray(data, data + compressed);
    const text = method === 0 ? bytes : method === 8 ? await inflate(bytes, expanded) : null;
    if (!text) throw Error('EPUB 正文压缩格式不支持');
    if (text.length !== expanded || crc32(text) !== crc) throw Error('EPUB 正文校验失败，文件可能已损坏');
    total += text.length;
    files.set(name, text);
    if (n % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (offset !== end) throw Error('EPUB ZIP 索引长度不匹配');
  return files;
}
function extractParagraphs(body: Element): string[] {
  const paragraphs: string[] = [];
  let text = '';
  const flush = () => { const clean = text.replace(/\s+/g, ' ').trim(); if (clean) paragraphs.push(clean); text = ''; };
  const blocks = new Set(['p', 'div', 'section', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'table', 'tr', 'td', 'pre']);
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { text += node.textContent ?? ''; return; }
    if (!(node instanceof Element)) return;
    const tag = node.localName.toLowerCase();
    if (['script', 'style', 'noscript', 'head', 'nav'].includes(tag)) return;
    if (tag === 'br') { flush(); return; }
    const block = blocks.has(tag);
    if (block) flush();
    for (const child of node.childNodes) visit(child);
    if (block) flush();
  };
  visit(body); flush();
  return paragraphs;
}

export async function parseEpub(filename: string, buffer: ArrayBuffer): Promise<Book> {
  const files = await decompressZip(buffer);
  const decoder = new TextDecoder('utf-8');

  // 1. Locate container.xml
  const containerBytes = lookup(files, 'META-INF/container.xml');
  if (!containerBytes) {
    throw new Error('无效的 EPUB 格式（缺少 META-INF/container.xml）。');
  }

  const containerXml = decoder.decode(containerBytes);
  const domParser = new DOMParser();
  const containerDoc = domParser.parseFromString(containerXml, 'application/xml');
  if (containerDoc.querySelector('parsererror')) throw Error('EPUB container.xml 格式损坏');
  const rootfile = containerDoc.querySelector('rootfile');
  let opfPath = rootfile?.getAttribute('full-path') || '';

  if (!opfPath) {
    // Fallback: search for .opf in files
    for (const key of files.keys()) {
      if (key.endsWith('.opf')) {
        opfPath = key;
        break;
      }
    }
  }

  if (!opfPath) {
    throw new Error('未在 EPUB 中找到 OPF 元数据清单。');
  }

  // 2. Read OPF file
  const opfBytes = lookup(files, opfPath);
  if (!opfBytes) {
    throw new Error(`无法读取 EPUB 清单文件：${opfPath}`);
  }

  const opfXml = decoder.decode(opfBytes);
  const opfDoc = domParser.parseFromString(opfXml, 'application/xml');

  if (opfDoc.querySelector('parsererror')) throw Error('EPUB OPF 清单格式损坏');

  // Metadata
  const title = opfDoc.querySelector('title, dc\\:title')?.textContent?.trim() ||
    filename.replace(/\.epub$/i, '').trim() || '未命名书籍';
  const author = opfDoc.querySelector('creator, dc\\:creator')?.textContent?.trim() || '本地导入';
  const description = opfDoc.querySelector('description, dc\\:description')?.textContent?.trim() || '';

  // Manifest: id -> href
  const manifest = new Map<string, string>();
  opfDoc.querySelectorAll('manifest > item').forEach(item => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) {
      manifest.set(id, href);
    }
  });

  // Spine: ordered itemref idrefs
  const spineIds: string[] = [];
  opfDoc.querySelectorAll('spine > itemref').forEach(itemref => {
    const idref = itemref.getAttribute('idref');
    if (idref) spineIds.push(idref);
  });

  if (!spineIds.length) {
    // If no spine found, fallback to all html/xhtml in manifest
    manifest.forEach((href, id) => {
      if (/\.(xhtml|html|htm|xml)(?:[?#]|$)/i.test(href)) spineIds.push(id);
    });
  }

  // 3. Parse chapters
  const chapters: Chapter[] = [];
  let chapterIndex = 1;

  for (const idref of spineIds) {
    const href = manifest.get(idref);
    if (!href) throw Error('EPUB 阅读顺序引用了不存在的资源：' + idref);

    const resolvedPath = normalizePath(opfPath, href);
    const chapterBytes = lookup(files, resolvedPath);
    if (!chapterBytes) throw Error('EPUB 正文资源缺失：' + resolvedPath);

    const htmlContent = decoder.decode(chapterBytes);
    const doc = domParser.parseFromString(htmlContent, 'text/html');

    // Remove script and style elements
    doc.querySelectorAll('script, style, noscript').forEach(el => el.remove());

    // Extract title
    let chapterTitle = (doc.body.querySelector('h1, h2, h3') ?? doc.querySelector('title'))?.textContent?.trim() || '';
    if (chapterTitle.length > 50 || !chapterTitle) {
      chapterTitle = `第 ${chapterIndex} 章`;
    }

    // Walk each text node once; repeated author paragraphs are real content.
    const paragraphs = extractParagraphs(doc.body);

    const cleanContent = paragraphs.join('\n\n').trim();
    if (cleanContent.length > 0) {
      chapters.push({
        id: `epub-ch-${chapterIndex}`,
        title: chapterTitle,
        content: cleanContent,
      });
      chapterIndex++;
    }
  }

  if (!chapters.length) {
    throw new Error('未能从该 EPUB 中解析出可阅读的正文章节。');
  }

  return {
    id: `local-${crypto.randomUUID()}`,
    title,
    author,
    description: description || `本地 EPUB · 共 ${chapters.length} 个章节`,
    source: 'local',
    coverStyle: Math.floor(Math.random() * 5),
    chapters,
    addedAt: Date.now(),
  };
}

export async function importEpub(file: File): Promise<Book> {
  if (!/\.epub$/i.test(file.name)) {
    throw new Error('目前仅支持 .epub 电子书文件。');
  }
  if (file.size > MAX_ARCHIVE) throw Error('EPUB 文件不能超过64 MiB');
  const buffer = await file.arrayBuffer();
  return parseEpub(file.name, buffer);
}
