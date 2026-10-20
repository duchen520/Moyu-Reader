import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir,writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const port=1545,url=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:'ignore'});
let browser;const results=[];
async function fixture(options={}){
 const page=await browser.newPage({viewport:{width:1280,height:820}});
 await page.route('https://**/*',r=>r.abort());
 await page.addInitScript(options=>{
  if(!sessionStorage.getItem('seeded')){
   localStorage.setItem('tomato-reader-v01:books',JSON.stringify([{id:'123456789',title:'深度检查',author:'测试',description:'',source:options.local?'local':'official',coverStyle:0,addedAt:1,chapters:[0,1,2,3,4].map(i=>({id:String(10001+i),title:'测试章'+(i+1),content:options.local?'本地正文。':'',loaded:!!options.local}))}]));
   localStorage.setItem('tomato-reader-v01:preferences',options.badPrefs?'null':JSON.stringify({theme:'paper',fontSize:19,lineHeight:1.95,contentWidth:760,readingMode:'normal',autoUploadProgress:!!options.auto,showParagraphComments:false}));
   localStorage.setItem('tomato-reader-v01:progress',options.badProgress?'null':'{}');sessionStorage.setItem('seeded','yes');
  }
  window.isTauri=true;window.__calls=[];window.__failProgress=false;window.__holdProgress=false;window.__releaseProgress=null;window.__remote='10001';
  window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{
   window.__calls.push({command,args});
   if(command==='official_account')return options.auto?{id:'55555',name:'测试账号'}:null;
   if(command==='official_cancel_login')return;
   if(command==='official_bookshelf')return {entries:[]};
   if(command==='official_read_progress'){if(window.__holdProgress)await new Promise(resolve=>window.__releaseProgress=resolve);if(window.__failProgress)throw Error('模拟进度故障');return [{book_id:'123456789',item_id:window.__remote,read_timestamp:1234567890}];}
   if(command==='official_chapter'){if(localStorage.getItem('offline'))throw Error('模拟离线');await new Promise(resolve=>setTimeout(resolve,400));return {id:args.id,title:'测试章'+(Number(args.id)-10000),content:'<p idx="0">这是测试正文，不是私人书籍。</p>',loaded:true};}
   if(command==='official_sync_progress')return {confirmed:true,chapterId:args.itemId};
   if(command==='backup_list')return {path:'test',backups:[]};
   if(command==='backup_create')return {id:'mock',createdAt:Date.now(),kind:args.kind,books:1,localBooks:0,bytes:10,valid:true,version:'test'};
   throw Error('Unexpected '+command);
  }};
 },options);
 await page.goto(url);return page;
}
const open=async page=>{await page.getByRole('button',{name:'阅读 深度检查',exact:true}).click({timeout:4000});};
async function check(name,run){try{const detail=await run();results.push({name,ok:true,detail});console.log('PASS',name,detail??'');}catch(error){results.push({name,ok:false,error:error.message});console.log('FAIL',name,error.message.split('\n')[0]);}}
try{
 for(let i=0;i<100;i++){try{if((await fetch(url)).ok)break;}catch{}await delay(100);}
 browser=await chromium.launch({headless:true});
 await check('Cached official chapter survives restart and reads offline without another download',async()=>{
  const p=await fixture();try{const first=Date.now();await open(p);await p.locator('.story-content p').first().waitFor();const firstReadMs=Date.now()-first;await p.evaluate(async()=>{await (await import('/src/lib/storage.ts')).storage.whenBooksIdle();localStorage.setItem('offline','1');});await p.reload();const start=Date.now();await open(p);await p.locator('.story-content p').first().waitFor({timeout:4000});assert.equal(await p.evaluate(()=>window.__calls.filter(c=>c.command==='official_chapter').length),0);return {firstReadMs,offlineReopenMs:Date.now()-start,offlineChapterRequests:0};}finally{await p.close();}
 });
 for(const field of ['badPrefs','badProgress'])await check('Malformed '+field+' cannot prevent local reading',async()=>{const p=await fixture({[field]:true,local:true});try{await open(p);await p.locator('.story-content p').first().waitFor({timeout:4000});assert.ok(await p.evaluate(field=>localStorage.getItem('tomato-reader-v01:'+ (field==='badPrefs'?'preferences':'progress'))==='null'||Object.keys(localStorage).some(key=>key.startsWith('tomato-reader-v01:recovered-')&&localStorage.getItem(key)==='null'),field));}finally{await p.close();}});
 await check('A failed re-entry cloud check cannot use the previous entry baseline for automatic upload',async()=>{
  const p=await fixture({auto:true});try{await open(p);await p.locator('.story-content p').first().waitFor();await p.locator('.chapter-item').nth(1).click();await p.locator('.page-paper h1').filter({hasText:'测试章2'}).waitFor();await p.locator('.story-content p').first().waitFor();await p.getByRole('button',{name:'返回书架',exact:true}).click();await p.evaluate(()=>window.__failProgress=true);await open(p);await p.locator('.story-content p').first().waitFor();await p.evaluate(()=>window.__failProgress=false);await p.waitForTimeout(5600);assert.equal(await p.evaluate(()=>window.__calls.filter(c=>c.command==='official_sync_progress').length),0);}finally{await p.close();}
 });
 await check('Slow cloud checks offer local reading without late cloud jumps or automatic uploads',async()=>{
  const p=await fixture({auto:true});try{await p.evaluate(()=>{window.__holdProgress=true;window.__remote='10002';});const start=Date.now();await open(p);await p.getByRole('button',{name:'先从第一章阅读',exact:true}).waitFor();const offeredMs=Date.now()-start;const chosen=Date.now();await p.getByRole('button',{name:'先从第一章阅读',exact:true}).click();await p.locator('.story-content p').first().waitFor();const textAfterChoiceMs=Date.now()-chosen;await p.evaluate(()=>{window.__holdProgress=false;window.__releaseProgress();});await p.waitForTimeout(5600);assert.equal(await p.locator('.page-paper h1').textContent(),'测试章1');assert.equal(await p.getByRole('dialog').count(),0);assert.equal(await p.evaluate(()=>window.__calls.filter(c=>c.command==='official_sync_progress').length),0);return {offeredMs,textAfterChoiceMs};}finally{await p.close();}
 });
 await check('A late cached chapter cannot revive a book deleted while its request was running',async()=>{
  const p=await fixture();try{await open(p);await p.locator('.story-content p').first().waitFor();assert.equal(await p.evaluate(async()=>{const {storage}=await import('/src/lib/storage.ts');await Promise.all([storage.removeBook('123456789'),storage.cacheChapter('123456789',{id:'10002',title:'迟到章节',content:'迟到正文',loaded:true})]);return storage.books().length;}),0);}finally{await p.close();}
 });
 await mkdir('test-output',{recursive:true});await writeFile(`test-output/deep-loading-${process.env.TOMATO_AUDIT_LABEL||'current'}.json`,JSON.stringify(results,null,2));
 console.log(JSON.stringify({passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length}));
 if(results.some(r=>!r.ok)&&process.env.TOMATO_AUDIT_BASELINE!=='1')process.exitCode=1;
}finally{await browser?.close();server.kill();}
