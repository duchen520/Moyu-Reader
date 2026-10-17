import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const executable=process.env.TOMATO_NATIVE_EXE??resolve('src-tauri/target/release/tomato-reader.exe');
const model=process.env.TOMATO_KOKORO_MODEL;
assert.ok(model,'TOMATO_KOKORO_MODEL must name the extracted public INT8 model directory');
const profile=resolve(`test-output/kf-${Date.now()}`);
const app=spawn(executable,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=1486',WEBVIEW2_USER_DATA_FOLDER:profile}});
let browser,page;const errors=[];let checks=0;const check=name=>{checks++;console.log('PASS '+name);};
const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('kokoro_status'));
async function released(){for(let i=0;i<100;i++){if(!(await status()).modelLoaded)return;await delay(100);}assert.fail('Native model was not released after stop/pause');}
try{
 for(let i=0;i<150;i++){try{if((await fetch('http://127.0.0.1:1486/json/version')).ok)break;}catch{}await delay(200);}
 browser=await chromium.connectOverCDP('http://127.0.0.1:1486');page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));
 await page.locator('.app-shell').waitFor();
 const book={id:'native-kokoro-test',title:'本地离线语音验证',author:'测试',description:'',source:'local',coverStyle:0,addedAt:1,chapters:[{id:'native-k1',title:'第一章 语音',content:'你好，这是第一章。'},{id:'native-k2',title:'第二章 语音',content:'现在开始第二章。'}]};
 await page.evaluate(async book=>{
  localStorage.setItem('tomato-reader-v01:books',JSON.stringify([book]));
  await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase('tomato-reader-library');r.onsuccess=resolve;r.onerror=()=>reject(r.error);});
 },book);
 await page.reload();await page.locator('.app-shell').waitFor();
 await page.evaluate(()=>{
  const originalFetch=window.fetch.bind(window);window.__kokoroCalls=[];window.__kokoroAudios=[];
  window.fetch=async(input,options)=>{const url=new URL(input instanceof Request?input.url:String(input),location.href);const cmd=url.hostname==='ipc.localhost'?decodeURIComponent(url.pathname.slice(1)):'';const response=await originalFetch(input,options);if(cmd)window.__kokoroCalls.push(cmd);return response;};
  const OriginalAudio=window.Audio;window.Audio=function(...args){const audio=new OriginalAudio(...args);window.__kokoroAudios.push(audio);return audio;};window.Audio.prototype=OriginalAudio.prototype;
 });
 await page.getByRole('button',{name:'阅读 本地离线语音验证',exact:true}).click();await page.locator('.story-content p').first().waitFor();
 await page.getByTitle('听书与自动翻页').click();await page.getByRole('button',{name:'Kokoro 离线语音',exact:true}).click();
 await page.getByText('请先导入语音包',{exact:true}).waitFor();assert.equal((await status()).modelLoaded,false);assert.equal((await status()).engineAvailable,true);
 await page.getByLabel('语音包文件夹',{exact:true}).fill(model);await page.getByRole('button',{name:'导入语音包',exact:true}).click();await page.getByText('语音包已就绪 · 离线朗读',{exact:true}).waitFor({timeout:60000});
 assert.equal((await status()).modelLoaded,false);assert.equal(await page.locator('#kokoro-voice option').count(),100);
 check('Actual extracted voice package imports through native commands and remains unloaded until playback');
 await page.getByLabel('连续朗读下一章',{exact:true}).uncheck();
 const started=Date.now();await page.getByRole('button',{name:'开始离线朗读',exact:true}).click();await page.getByRole('button',{name:'暂停离线朗读',exact:true}).waitFor({timeout:60000});
 assert.equal((await status()).modelLoaded,true);
 const audioInfo=await page.evaluate(()=>{const a=window.__kokoroAudios.at(-1);return{duration:a.duration,ready:a.readyState,paused:a.paused};});
 assert.ok(audioInfo.duration>0);assert.equal(audioInfo.paused,false);
 console.log(JSON.stringify({firstPlaybackMs:Date.now()-started,audioSeconds:audioInfo.duration}));
 check('Real WebView2 plays generated in-memory WAV through the native CPU engine');
 await page.getByRole('button',{name:'暂停离线朗读',exact:true}).click();await released();
 const time=await page.evaluate(()=>window.__kokoroAudios.at(-1).currentTime);await delay(150);assert.equal(await page.evaluate(()=>window.__kokoroAudios.at(-1).currentTime),time);
 await page.getByRole('button',{name:'继续离线朗读',exact:true}).click();await page.getByRole('button',{name:'暂停离线朗读',exact:true}).waitFor();
 await delay(150);assert.ok(await page.evaluate(()=>window.__kokoroAudios.at(-1).currentTime)>time);
 await page.getByRole('button',{name:'停止离线朗读',exact:true}).click();await released();
 check('Pause releases the model; resume retains audio position; explicit stop frees native work');
 await page.getByLabel('Kokoro 中文音色',{exact:true}).selectOption('58');await page.getByLabel('Kokoro 朗读倍速',{exact:true}).selectOption('1.25');
 await page.getByRole('button',{name:'开始离线朗读',exact:true}).click();await page.getByRole('button',{name:'暂停离线朗读',exact:true}).waitFor({timeout:60000});
 assert.equal(await page.evaluate(()=>window.__kokoroAudios.at(-1).playbackRate),1.25);
 await page.getByRole('button',{name:'收起面板',exact:true}).click();await page.locator('.audio-mini-pill').getByTitle('停止',{exact:true}).click();await released();
 check('A second real Chinese voice, speed selection and collapsed stop controls work');
 await page.getByTitle('听书与自动翻页').click();await page.getByLabel('连续朗读下一章',{exact:true}).check();await page.getByRole('button',{name:'开始离线朗读',exact:true}).click();
 await page.locator('.page-paper h1').filter({hasText:'第二章'}).waitFor({timeout:60000});await page.getByText('语音包已就绪 · 离线朗读',{exact:true}).waitFor({timeout:60000});await released();
 assert.equal(await page.evaluate(()=>window.__kokoroAudios.length)>=4,true);
 check('Real generated playback automatically continues into the next local chapter and stops at book end');
 await page.setViewportSize({width:900,height:700});
 await mkdir('test-output',{recursive:true});await page.screenshot({path:'test-output/native-kokoro-ready.png'});
 const calls=await page.evaluate(()=>window.__kokoroCalls);assert.equal(calls.filter(c=>c==='official_sync_progress').length,0);assert.deepEqual(errors,[]);
 check('No cloud uploads or unhandled UI errors during actual native offline playback');
 await writeFile('test-output/native-kokoro-report.json',JSON.stringify({checks,profile,firstAudio:audioInfo,uploadCalls:0},null,2));
}catch(error){if(page)await page.screenshot({path:'test-output/native-kokoro-failure.png'}).catch(()=>{});throw error;}
finally{await browser?.close().catch(()=>{});app.kill();}
