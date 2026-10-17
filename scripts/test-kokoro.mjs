import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const port=1504;
let ending=false;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:['ignore','ignore','pipe']});
server.stderr.on('data',data=>process.stderr.write(data));
server.on('exit',code=>{if(!ending)console.error('Unexpected fixture server exit: '+code);});
let browser,passed=0;const errors=[];
const check=name=>{passed++;console.log('PASS '+name);};
function wav(seconds){const w=Buffer.alloc(44+Math.round(seconds*24000)*2);w.write('RIFF');w.writeUInt32LE(w.length-8,4);w.write('WAVEfmt ',8);w.writeUInt32LE(16,16);w.writeUInt16LE(1,20);w.writeUInt16LE(1,22);w.writeUInt32LE(24000,24);w.writeUInt32LE(48000,28);w.writeUInt16LE(2,32);w.writeUInt16LE(16,34);w.write('data',36);w.writeUInt32LE(w.length-44,40);return w.toString('base64');}
async function fixture(options={}){
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({options,audio})=>{
  window.isTauri=true;window.__calls=[];window.__session=1;window.__hold=!!options.hold;window.__installed=options.installed!==false;window.__audios=[];window.__plays=0;
  const OriginalAudio=window.Audio;window.Audio=function(...args){const a=new OriginalAudio(...args);window.__audios.push(a);return a;};window.Audio.prototype=OriginalAudio.prototype;
  const play=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){window.__plays++;return play.call(this);};
  Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>[],addEventListener(){},removeEventListener(){},cancel(){},speak(){window.__systemSpoken=true;}}});
  localStorage.setItem('tomato-reader-v01:books',JSON.stringify([{id:'local-kokoro-test',title:'离线语音测试',author:'本机测试',source:'local',description:'',coverStyle:0,addedAt:1,chapters:[{id:'k1',title:'第一章 测试',content:'第一段离线朗读测试。\n\n第二段继续朗读测试。'},{id:'k2',title:'第二章 测试',content:'下一章朗读测试。'}]}]));
  localStorage.setItem('tomato-reader-v01:preferences',JSON.stringify({theme:'paper',fontSize:19,lineHeight:1.95,contentWidth:760,autoUploadProgress:false}));
  window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{
   window.__calls.push({command,args});
   if(command==='official_account')return null;
   if(command==='official_cancel_login')return;
   if(command==='kokoro_status')return{installed:window.__installed,engineAvailable:true,importing:false};
   if(command==='kokoro_import'){if(window.__importFails)throw Error('语音包校验失败');window.__installed=true;return{installed:true,engineAvailable:true,importing:false};}
   if(command==='kokoro_begin')return ++window.__session;
   if(command==='kokoro_stop')return;
   if(command==='kokoro_synthesize'){
    if(window.__hold)await new Promise(r=>window.__release=()=>{window.__hold=false;r();});
    if(window.__fail)throw Error('测试合成失败');
    return{session:args.session,mime:'audio/wav',audioBase64:audio};
   }
   throw Error('Unexpected mock command '+command);
  }};
 },{options,audio:wav(options.seconds??3)});
 await page.route('https://**/*',route=>route.abort());
 await page.goto(`http://127.0.0.1:${port}`,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'阅读 离线语音测试',exact:true}).click();await page.locator('.story-content p').first().waitFor();return page;
}
async function panel(page){await page.getByTitle('听书与自动翻页').click();await page.getByRole('button',{name:'Kokoro 离线语音',exact:true}).click();}
const calls=(page,command)=>page.evaluate(command=>window.__calls.filter(c=>c.command===command),command);
const playing=page=>page.getByRole('button',{name:'暂停离线朗读',exact:true}).waitFor({timeout:10000});
try{
 for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}`)).ok)break;}catch{}await delay(100);}
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
 {
  const p=await fixture({installed:false});assert.equal((await calls(p,'kokoro_status')).length,0);await panel(p);
  assert.equal((await calls(p,'kokoro_begin')).length,0);assert.equal(await p.locator('#kokoro-voice option').count(),100);
  assert.equal(await p.getByRole('button',{name:'开始离线朗读',exact:true}).isEnabled(),false);
  await p.getByLabel('语音包文件夹',{exact:true}).fill('D:\\test-kokoro');await p.getByRole('button',{name:'导入语音包',exact:true}).click();
  await p.getByText('语音包已就绪 · 离线朗读',{exact:true}).waitFor();assert.equal((await calls(p,'kokoro_import')).length,1);
  check('Model import is explicit; opening the panel does not load/generate, and all 100 Chinese voices are selectable');await p.close();
 }
 {
  const p=await fixture({hold:true});await panel(p);await p.getByRole('button',{name:'开始离线朗读',exact:true}).click();await p.getByRole('button',{name:'取消加载',exact:true}).waitFor();
  await p.getByRole('button',{name:'取消加载',exact:true}).click();await p.evaluate(()=>window.__release());await delay(150);
  assert.equal(await p.evaluate(()=>window.__plays),0);assert.ok((await calls(p,'kokoro_stop')).length);
  check('Cancelling a pending synthesis prevents the late audio from starting');await p.close();
 }
 {
  const p=await fixture({hold:true});await panel(p);await p.getByRole('button',{name:'开始离线朗读',exact:true}).click();await p.getByRole('button',{name:'取消加载',exact:true}).waitFor();
  await p.locator('.chapter-item').nth(1).click();await p.locator('.page-paper h1').filter({hasText:'第二章'}).waitFor();await p.evaluate(()=>window.__release());await delay(150);
  assert.equal(await p.evaluate(()=>window.__plays),0);
  check('Manual chapter changes cancel old synthesis and never play text from the previous chapter');await p.close();
 }
 {
  const p=await fixture();await panel(p);await p.getByRole('button',{name:'开始离线朗读',exact:true}).click();await playing(p);
  await p.getByRole('button',{name:'收起面板',exact:true}).click();assert.ok((await p.locator('.audio-mini-pill').textContent()).includes('离线朗读'));
  await p.getByTitle('听书与自动翻页').click();
  await p.getByRole('button',{name:'暂停离线朗读',exact:true}).click();await p.getByRole('button',{name:'继续离线朗读',exact:true}).waitFor();
  const t=await p.evaluate(()=>window.__audios.at(-1).currentTime);await delay(180);assert.equal(await p.evaluate(()=>window.__audios.at(-1).currentTime),t);
  await p.getByRole('button',{name:'继续离线朗读',exact:true}).click();await playing(p);await delay(180);assert.ok(await p.evaluate(()=>window.__audios.at(-1).currentTime)>t);
  assert.ok((await calls(p,'kokoro_stop')).length);
  await p.getByRole('button',{name:'收起面板',exact:true}).click();assert.ok((await p.locator('.audio-mini-pill').textContent()).includes('离线朗读'));
  await p.locator('.audio-mini-pill').getByTitle('停止',{exact:true}).click();await p.locator('.audio-mini-pill').waitFor({state:'detached'});
  assert.equal(await p.evaluate(()=>window.__audios.every(a=>a.paused)),true);
  check('Pause/resume retains audio position; collapsed mini controls stop playback and release the native session');await p.close();
 }
 {
  const p=await fixture();await panel(p);await p.getByRole('button',{name:'开始离线朗读',exact:true}).click();await playing(p);
  await p.getByLabel('Kokoro 中文音色',{exact:true}).selectOption('58');await p.getByRole('button',{name:'开始离线朗读',exact:true}).waitFor();
  await p.getByLabel('Kokoro 朗读倍速',{exact:true}).selectOption('1.5');await p.getByRole('button',{name:'开始离线朗读',exact:true}).click();await playing(p);
  assert.equal((await calls(p,'kokoro_synthesize')).at(-1).args.speaker,58);assert.equal(await p.evaluate(()=>window.__audios.at(-1).playbackRate),1.5);
  check('Changing a voice stops old audio; new voice and playback speed apply to the next start');await p.close();
 }
 {
  const p=await fixture();await panel(p);await p.getByRole('button',{name:'开始离线朗读',exact:true}).click();await playing(p);
  await p.getByRole('button',{name:'电脑语音',exact:true}).click();await p.getByRole('button',{name:'开始朗读',exact:true}).click();
  assert.equal(await p.evaluate(()=>window.__systemSpoken),true);assert.equal(await p.evaluate(()=>window.__audios.every(a=>a.paused)),true);
  check('System speech and offline Kokoro cannot play simultaneously');await p.close();
 }
 {
  const p=await fixture({seconds:.3});await panel(p);await p.getByRole('button',{name:'开始离线朗读',exact:true}).click();
  await p.locator('.page-paper h1').filter({hasText:'第二章'}).waitFor({timeout:10000});
  await p.getByText('语音包已就绪 · 离线朗读',{exact:true}).waitFor({timeout:10000});
  assert.ok((await calls(p,'kokoro_synthesize')).some(c=>c.args.text.includes('下一章')));
  check('Automatic chapter continuation reads the next chapter and stops at the end of the book');await p.close();
 }
 {
  const p=await fixture({seconds:.3});await panel(p);await p.getByLabel('连续朗读下一章',{exact:true}).uncheck();await p.getByRole('button',{name:'开始离线朗读',exact:true}).click();
  await p.getByText('语音包已就绪 · 离线朗读',{exact:true}).waitFor({timeout:10000});assert.ok((await p.locator('.page-paper h1').textContent()).includes('第一章'));
  check('Disabling continuous reading stays in the current chapter');await p.close();
 }
 {
  const p=await fixture();await panel(p);await p.evaluate(()=>window.__fail=true);await p.getByRole('button',{name:'开始离线朗读',exact:true}).click();
  await p.getByRole('alert').filter({hasText:'测试合成失败'}).waitFor();assert.equal(await p.evaluate(()=>window.__plays),0);assert.equal(await p.locator('.audio-mini-pill').count(),0);
  check('Synthesis failures are visible and leave no phantom playing state');await p.close();
 }
 {
  const p=await fixture();await panel(p);await p.getByRole('button',{name:'开始离线朗读',exact:true}).click();await playing(p);
  await p.locator('.side-nav button').filter({hasText:'本地书架'}).click();assert.equal(await p.evaluate(()=>window.__audios.every(a=>a.paused)),true);assert.ok((await calls(p,'kokoro_stop')).length);
  assert.equal((await calls(p,'official_sync_progress')).length,0);
  check('Leaving the reader stops audio and native work without cloud uploads');await p.close();
 }
 assert.deepEqual(errors,[]);check('Offline speech scenarios have no unhandled browser errors');console.log(`${passed} offline speech checks passed (mock native engine).`);
}finally{ending=true;await browser?.close();server.kill();}
