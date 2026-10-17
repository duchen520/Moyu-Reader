import { importTxt } from './importTxt';
import { importEpub } from './importEpub';
import type { Book } from '../types';

export async function importBook(file: File): Promise<Book> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.epub') || file.type === 'application/epub+zip') {
    return importEpub(file);
  }
  if (name.endsWith('.txt') || file.type === 'text/plain') {
    return importTxt(file);
  }
  throw new Error('目前仅支持导入 .txt 与 .epub 电子书文件。');
}
