import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const port=1544;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:'ignore'});
let browser;
try{
 for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}`)).ok)break;}catch{}await delay(100);}
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${port}`);
 const parse=html=>page.evaluate(async html=>{const {plainChapter}=await import('/src/lib/official.ts');return plainChapter({id:'test',title:'标题',content:html,loaded:false});},html);
 const split=await parse('<h1><blk>上行标题</blk><br><blk>下行标题</blk></h1><p idx="0"><blk>正文前</blk><br><blk>正文后</blk></p>');
 assert.equal(split.content,'正文前 正文后');assert.deepEqual(split.paragraphIds,[0]);
 console.log('PASS Multi-run body text stays in one paragraph and does not repeat the heading');
 const notes=await parse('<p idx="7"><blk>正文前</blk><a><img/></a><blk>正文后</blk></p><section><aside idx="999"><blk>注释正文</blk></aside></section>');
 assert.equal(notes.content,'正文前正文后\n\n注释正文');assert.deepEqual(notes.paragraphIds,[7,null]);
 console.log('PASS Footnote text is preserved without inventing body comment IDs');
 const nested=await parse('<p idx="0">正文</p><aside><p>注释</p></aside>');
 assert.equal(nested.content,'正文\n\n注释');
 console.log('PASS Nested note paragraphs are not duplicated');
 const clean=await parse('<p idx="0"><script>bad()</script>正文</p><aside><style>bad</style>注释</aside>');
 assert.equal(clean.content,'正文\n\n注释');
 console.log('PASS Executable and style contents are excluded from body and notes');
 for(const [name,bodyCount,noteCount] of [['multiline-paragraph.json',18,0],['inline-footnote-paragraph.json',69,3]]){
  const fixture=JSON.parse(await readFile(`src-tauri/tests/fixtures/chapter-structures/${name}`,'utf8'));
  const value=await parse(fixture.html);
  assert.equal(value.content.split('\n\n').length,bodyCount+noteCount);
  assert.equal(value.paragraphIds.filter(id=>id!==null).length,bodyCount);
  assert.deepEqual(value.paragraphIds.slice(bodyCount),Array(noteCount).fill(null));
 }
 console.log('PASS Both redacted real structures retain all body paragraphs and notes');
 console.log('5 chapter layout checks passed; fixtures contain no book text or account data.');
}finally{await browser?.close();server.kill();}
