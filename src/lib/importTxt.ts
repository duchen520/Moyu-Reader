import type { Book, Chapter } from '../types';

const CHAPTER_LINE = /^\s*(第[零〇一二三四五六七八九十百千万两\d]+[章节回卷][^\r\n]{0,48})\s*$/gm;
const MAX_FILE_BYTES = 1_500_000; // localStorage prototype: prevent easy quota overflow

export function parseNovel(filename: string, text: string): Book {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').trim();
  if (!normalized) throw new Error('文件没有可读取的文字。');
  const matches = [...normalized.matchAll(CHAPTER_LINE)];
  let chapters: Chapter[];
  if (matches.length > 0) {
    chapters = matches.map((match, idx) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = idx + 1 < matches.length ? matches[idx + 1].index! : normalized.length;
      return { id: `c${idx + 1}`, title: match[1].trim(), content: normalized.slice(start, end).trim() };
    }).filter(c => c.content.length > 0);
    const preface = normalized.slice(0, matches[0].index).trim();
    if (preface) chapters.unshift({ id: 'preface', title: '前言', content: preface });
  } else {
    chapters = [];
    for (let i = 0; i < normalized.length; i += 3500) {
      chapters.push({ id: `part${chapters.length + 1}`, title: `第 ${chapters.length + 1} 部分`, content: normalized.slice(i, i + 3500) });
    }
  }
  if (!chapters.length) throw new Error('未找到可阅读的章节。');
  return {
    id: `local-${crypto.randomUUID()}`,
    title: filename.replace(/\.txt$/i, '').trim() || '未命名书籍',
    author: '本地导入', description: `本地 TXT · 共 ${chapters.length} 个章节`,
    source: 'local', coverStyle: Math.floor(Math.random() * 5),
    chapters, addedAt: Date.now(),
  };
}

export async function importTxt(file: File): Promise<Book> {
  if (!/\.txt$/i.test(file.name)) throw new Error('目前仅支持 .txt 文件。');
  if (file.size > MAX_FILE_BYTES) throw new Error('当前版本仅支持 1.5 MB 以内的 UTF-8 TXT。后续将改用 SQLite。');
  const text = await file.text();
  if (text.includes('\uFFFD')) throw new Error('检测到乱码：请把 TXT 转成 UTF-8 编码后重新导入。');
  return parseNovel(file.name, text);
}
