import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
if(!process.env.TOMATO_NATIVE_EXE)throw Error('Set TOMATO_NATIVE_EXE');
const app=spawn(process.env.TOMATO_NATIVE_EXE,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:resolve(`test-output/chapter-diagnosis-${Date.now()}`),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=1543'}});
let browser;
try{
 for(let i=0;i<150;i++){try{if((await fetch('http://127.0.0.1:1543/json/version')).ok)break;}catch{}await delay(200);}
 browser=await chromium.connectOverCDP('http://127.0.0.1:1543');
 const page=browser.contexts()[0].pages()[0];
 await page.locator('.app-shell').waitFor({timeout:30000});
 const invoke=(command,args)=>page.evaluate(async({command,args})=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(e){return {ok:false,error:String(e)};}},{command,args});
 let id=process.env.TOMATO_CHAPTER_BOOK;
 if(!id){const search=await invoke('official_search',{keyword:process.env.TOMATO_CHAPTER_SEARCH||'巴菲特致股东的信',offset:0});if(!search.ok)throw Error(search.error);console.log('SEARCH',JSON.stringify(search.value.books.map(({id,title})=>({id,title}))));
 const match=search.value.books.find(b=>b.title.includes(process.env.TOMATO_CHAPTER_MATCH||'第4版'));if(!match)throw Error('Set TOMATO_CHAPTER_BOOK to the intended edition');id=match.id;}
 const book=await invoke('official_book',{id});if(!book.ok)throw Error(book.error);
 if(process.env.TOMATO_CHAPTER_CATALOG==='1')await writeFile(`test-output/chapter-catalog-${id}.json`,JSON.stringify(book.value.chapters.map(({id,title})=>({id,title}))));
 console.log('BOOK',JSON.stringify({id,title:book.value.title,count:book.value.chapters.length,chapters:book.value.chapters.slice(0,5).map(({id,title})=>({id,title}))}));
 if(process.env.TOMATO_CHAPTER_ALL==='1'){
  const results=[];
  for(const [index,chapter] of book.value.chapters.entries()){
   const result=await invoke('official_chapter',{id:chapter.id});
   results.push(result.ok?{chapter:index+1,id:chapter.id,ok:result.value.loaded===true,length:result.value.content?.length}:{chapter:index+1,id:chapter.id,ok:false,error:result.error});
   console.log('NATIVE_SCAN',JSON.stringify(results.at(-1)));
  }
  await writeFile('test-output/native-book-all-chapters.json',JSON.stringify(results,null,2));
  assert.equal(results.filter(r=>!r.ok).length,0,'All requested native chapters must load');
  console.log('PASS all native chapter requests:',results.length);
 }
 const chapter=book.value.chapters[Number(process.env.TOMATO_CHAPTER_INDEX||1)];
 console.log('SELECTED',JSON.stringify({id:chapter.id,title:chapter.title}));
 const result=await invoke('official_chapter',{id:chapter.id});
 console.log('CHAPTER',JSON.stringify(result.ok?{ok:true,id:chapter.id,loaded:result.value.loaded,length:result.value.content?.length}:result));
 if(process.env.TOMATO_CHAPTER_UI==='1'){
  assert.ok(result.ok,'Native chapter request must succeed');
  const expected=await page.evaluate(html=>{const doc=new DOMParser().parseFromString(html,'text/html');doc.querySelectorAll('br').forEach(el=>el.replaceWith('\n'));const parts=[...doc.querySelectorAll('p,aside')].filter(el=>!el.parentElement?.closest('p,aside')).map(p=>p.textContent.replace(/\s*\n\s*/g,' ').trim()).filter(Boolean);return parts.length?parts:doc.body.textContent.split(/\n+/).map(s=>s.trim()).filter(Boolean);},result.value.content);
  await page.locator('.side-nav button').filter({hasText:'找书发现'}).click();
  await page.getByRole('button',{name:'通过番茄链接或书籍ID直接打开作品'}).click();
  await page.getByLabel('打开正版作品').fill(id);
  await page.getByRole('button',{name:'打开作品',exact:true}).click();
  await page.locator('.chapter-item').nth(Number(process.env.TOMATO_CHAPTER_INDEX||1)).click({timeout:60000});
  await page.locator('.story-content p').first().waitFor({timeout:60000});
  const rendered=await page.locator('.story-content p').allTextContents();
  assert.deepEqual(rendered.map(s=>s.trim()),expected);
  assert.ok(expected.length>0);
  assert.equal(await page.getByText('官方正文段落不完整，未标记已读',{exact:true}).count(),0);
  await page.screenshot({path:'test-output/native-published-book.png'});
  console.log('PASS actual native reader text blocks match all returned body/notes or title-page lines:',expected.length);
 }
}finally{await browser?.close();app.kill();}
