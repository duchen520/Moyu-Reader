import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const label=process.env.TOMATO_PERF_LABEL??'candidate';
const executable=process.env.TOMATO_PERF_EXE??resolve('src-tauri/target/release/tomato-reader.exe');
const started=Date.now();
// Keep WebView's nested IndexedDB paths below Windows path limits.
const app=spawn(executable,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=1485',WEBVIEW2_USER_DATA_FOLDER:resolve(`test-output/pf-${started}`)}});
let browser,page;
const result={label};
async function observe(){await page.evaluate(()=>{
 const fetchOriginal=window.fetch.bind(window);window.__benchCalls=[];
 window.fetch=async(input,options)=>{
  const url=new URL(input instanceof Request?input.url:String(input),location.href);
  const cmd=url.hostname==='ipc.localhost'?decodeURIComponent(url.pathname.slice(1)):'';
  const response=await fetchOriginal(input,options);
  if(cmd){const entry={cmd};if(cmd==='official_cover'&&response.ok){const image=await response.clone().json();entry.cached=image.cached;entry.bytes=image.bytes;if(typeof image==='string')entry.error=image;}window.__benchCalls.push(entry);}
  return response;
 };
});}
try{
 for(let i=0;i<150;i++){try{if((await fetch('http://127.0.0.1:1485/json/version')).ok)break;}catch{}await delay(200);}
 browser=await chromium.connectOverCDP('http://127.0.0.1:1485');page=browser.contexts()[0].pages()[0];
 await page.locator('.app-shell').waitFor();result.version=await page.locator('.side-bottom small').textContent();await observe();
 await page.locator('.side-nav button').filter({hasText:'云端书架'}).click();
 await page.locator('.official-shelf button').first().waitFor({timeout:60000});result.firstShelfMs=Date.now()-started;
 let loaded=false;for(let i=0;i<150;i++) {loaded=await page.locator('.official-shelf img').evaluateAll(imgs=>imgs.some(img=>img.naturalWidth>0));if(loaded)break;await delay(100);}
 result.firstCoverMs=loaded?Date.now()-started:null;
 await page.getByRole('button',{name:'刷新官方书架',exact:true}).waitFor({timeout:60000});result.fullShelfMs=Date.now()-started;
 await page.locator('.side-nav button').filter({hasText:'找书发现'}).click();
 await page.getByLabel('搜索正版小说').fill('这个游戏不对劲 我挖矿成神');
 await page.getByRole('button',{name:'搜索小说',exact:true}).click();await page.locator('.search-open-btn').first().waitFor({timeout:30000});
 const before=await page.evaluate(()=>window.__benchCalls.length);const openStarted=Date.now();
 await page.locator('.search-open-btn').first().click();
 result.openFeedbackMs=await page.locator('.opening-screen').count()?Date.now()-openStarted:null;
 await page.locator('.story-content p').first().waitFor({timeout:60000});result.openTextMs=Date.now()-openStarted;
 assert.ok((await page.locator('.sync-bar').textContent()).includes('自动上传已关闭'));
 const calls=await page.evaluate(()=>window.__benchCalls);result.openAccountCalls=calls.slice(before).filter(c=>c.cmd==='official_account').length;
 result.coverCalls=calls.filter(c=>c.cmd==='official_cover').length;result.coverDiskHits=calls.filter(c=>c.cmd==='official_cover'&&c.cached).length;
 result.uploadCalls=calls.filter(c=>c.cmd==='official_sync_progress').length;result.coverErrors=calls.filter(c=>c.error).map(c=>c.error);assert.equal(result.uploadCalls,0);
 await mkdir('test-output',{recursive:true});await writeFile(`test-output/loading-benchmark-${label}.json`,JSON.stringify(result,null,2));
 if(process.env.TOMATO_PERF_WARM==='1'){
  const warmStarted=Date.now();await page.reload();await page.locator('.book-cover img[data-cover-source="disk"]').first().waitFor({timeout:15000});
  await page.locator('.book-cover img[data-cover-source="disk"]').first().evaluate(img=>img.decode());
  assert.ok(await page.locator('.book-cover img[data-cover-source="disk"]').first().evaluate(img=>img.naturalWidth>0));
  result.warmCoverReloadMs=Date.now()-warmStarted;result.coverDiskSurvivesReload=true;
 }
 await mkdir('test-output',{recursive:true});await writeFile(`test-output/loading-benchmark-${label}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){if(page)await page.screenshot({path:`test-output/loading-benchmark-${label}-failure.png`}).catch(()=>{});throw error;}
finally{await browser?.close().catch(()=>{});app.kill();}
