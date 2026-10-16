import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const browser=await chromium.launch({headless:true,...(process.env.TOMATO_TEST_BROWSER?{executablePath:process.env.TOMATO_TEST_BROWSER}:{}),args:['--no-sandbox'],...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
const base=process.env.TEST_BASE_URL??'http://127.0.0.1:1480';
const server=process.env.TEST_BASE_URL?null:spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1480','--strictPort'],{stdio:'ignore'});
for(let i=0;i<100;i++){try{const r=await fetch(base);if(r.ok)break;}catch{}await delay(100);}
let passed=0;const errors=[];
const check=(name)=>{passed++;console.log('PASS '+name);};
async function addSpeech(page){await page.addInitScript(()=>{window.__spoken=[];window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};let voices=[{voiceURI:'test-zh',name:'测试中文声音',lang:'zh-CN'}];Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>voices,addEventListener(){},removeEventListener(){},cancel(){},speak(u){window.__spoken.push(u);}},configurable:true});});}
try{
 const page=await browser.newPage({viewport:{width:1360,height:900}});page.on('pageerror',e=>errors.push(e.message));await addSpeech(page);await page.goto(base);
 await page.locator('input[type=file]').setInputFiles({name:'自动阅读测试.txt',mimeType:'text/plain',buffer:Buffer.from('第一章 开始\n'+Array.from({length:70},(_,i)=>'段落'+i+'：'+ '这是用于验证阅读位置和自动翻页的测试文本。'.repeat(6)).join('\n\n')+'\n第二章 继续\n结束测试。')});
 await page.getByRole('button',{name:'阅读 自动阅读测试',exact:true}).click();await page.locator('.story-content p').first().waitFor();
 const chapterTitle=await page.locator('.page-paper h1').textContent();
 await page.locator('.reading-canvas').click({position:{x:100,y:100}});await page.keyboard.press('PageDown');await page.waitForTimeout(500);
 assert.equal(await page.locator('.page-paper h1').textContent(),chapterTitle);assert.ok(await page.locator('.reading-canvas').evaluate(el=>el.scrollTop)>0);check('PageDown turns a screen page without skipping the chapter');
 await page.locator('.reading-canvas').evaluate(el=>el.scrollTop=(el.scrollHeight-el.clientHeight)*.45);await page.waitForTimeout(350);
 const before=await page.locator('.reading-canvas').evaluate(el=>el.scrollTop);
 await page.getByRole('button',{name:'返回书架',exact:true}).click();await page.getByRole('button',{name:'开始阅读',exact:true}).click();await page.waitForTimeout(100);
 const restored=await page.locator('.reading-canvas').evaluate(el=>el.scrollTop);
 assert.ok(Math.abs(restored-before)<5,JSON.stringify({before,restored,saved:await page.evaluate(()=>localStorage.getItem('tomato-reader-v01:progress'))}));check('Returning to a book restores its chapter-internal position');
 await page.getByTitle('听书与自动翻页').click();await page.getByRole('button',{name:'开始朗读',exact:true}).click();await page.getByRole('button',{name:'暂停朗读',exact:true}).waitFor();assert.ok(await page.locator('.spoken-paragraph').count());
 await page.getByRole('button',{name:'暂停朗读',exact:true}).click();await page.getByRole('button',{name:'继续朗读',exact:true}).click();await page.getByRole('button',{name:'停止',exact:true}).click();check('Speech starts, highlights, pauses, resumes and stops');
 await page.getByRole('button',{name:'自动阅读',exact:true}).click();await page.getByRole('button',{name:'平滑滚动',exact:true}).click();const start=await page.locator('.reading-canvas').evaluate(el=>el.scrollTop);await page.waitForTimeout(700);const after=await page.locator('.reading-canvas').evaluate(el=>el.scrollTop);assert.ok(after>start+5,JSON.stringify({start,after,mode:'scroll',visibility:await page.evaluate(()=>document.visibilityState)}));await page.locator('.reading-canvas').dispatchEvent('wheel');assert.ok(await page.getByRole('button',{name:'停止自动阅读',exact:true}).isVisible());check('Automatic scroll advances and continues after manual wheel input');
 await page.getByRole('button',{name:'定时翻页',exact:true}).click();await page.getByLabel('翻页间隔').fill('3');const pageBefore=await page.locator('.reading-canvas').evaluate(el=>el.scrollTop);await page.waitForTimeout(3700);assert.ok((await page.locator('.reading-canvas').evaluate(el=>el.scrollTop))>pageBefore+10);await page.getByRole('button',{name:'停止自动阅读',exact:true}).click();check('Timed page turn advances at the configured interval');
 await page.clock.install();await page.getByLabel('定时停止').selectOption('15');await page.getByText('剩余 15 分钟',{exact:false}).waitFor();await page.getByLabel('定时停止').selectOption('0');await page.getByRole('button',{name:'电脑语音',exact:true}).click();await page.getByRole('button',{name:'开始朗读',exact:true}).click();await page.getByLabel('定时停止').selectOption('15');await page.clock.fastForward(15*60*1000);await page.getByRole('button',{name:'开始朗读',exact:true}).waitFor();assert.equal(await page.getByLabel('定时停止').inputValue(),'0');check('Sleep timer enables, cancels and stops speech at its deadline (virtual clock)');
 await page.getByTitle('官方评论').click();await page.getByText('这本是本地或示例书，没有番茄官方评论。',{exact:false}).waitFor();check('Local books do not display fabricated official comments');
 await mkdir('test-output',{recursive:true});await page.screenshot({path:'test-output/reader.png'});
 await page.getByRole('button',{name:'返回书架',exact:true}).click();await page.getByRole('button',{name:'账号管理',exact:true}).click();assert.ok(await page.getByRole('button',{name:'扫码登录',exact:true}).isDisabled());await page.getByText('当前是浏览器预览',{exact:false}).waitFor();check('Browser preview explicitly disables native login');
 await page.screenshot({path:'test-output/official.png'});
 await page.getByRole('button',{name:/本地书架/}).click();await page.locator('.book-cover').first().click();await page.getByTitle('听书与自动翻页').click();const shortTitle=await page.locator('.page-paper h1').textContent();await page.getByRole('button',{name:'自动阅读',exact:true}).click();await page.getByRole('button',{name:'平滑滚动',exact:true}).click();await page.waitForTimeout(700);assert.equal(await page.locator('.page-paper h1').textContent(),shortTitle);await page.getByRole('button',{name:'停止自动阅读',exact:true}).click();check('Short chapters that fit a screen are held for reading before auto-advance');
 await page.close();

 // Native command mocks exercise UI behavior only; they are not real account verification.
 const native=await browser.newPage({viewport:{width:1360,height:900}});native.on('pageerror',e=>errors.push(e.message));await addSpeech(native);
 await native.route('https://p6-tt.bytecdn.cn/test.image',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="70" height="96"><rect width="70" height="96" fill="tan"/></svg>'}));
 await native.addInitScript(()=>{
  window.isTauri=true;window.__calls=[];window.__remoteChapter='10001';window.__pollAuthenticated=false;
  const chapters=[{id:'10001',title:'第一章',content:'',loaded:false},{id:'10002',title:'第二章',content:'',loaded:false}];
  window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{
   window.__calls.push({command,args});
   if(command==='official_account')return window.__loggedIn?{id:'12345',name:'测试账号'}:null;
   if(command==='official_start_login'){await new Promise(r=>setTimeout(r,25));return{imageDataUrl:'data:image/png;base64,iVBORw0KGgo=',expiresInSeconds:60};}
   if(command==='official_poll_login'){if(window.__pollAuthenticated){window.__loggedIn=true;return{stage:'authenticated',user:{id:'12345',name:'测试账号'}};}return{stage:'waiting'};}
   if(command==='official_cancel_login')return;
   if(command==='official_logout'){window.__loggedIn=false;return;}
   if(command==='official_bookshelf'){if(window.__shelfFail)throw '模拟书架网络错误';return{entries:[{id:'123456789',title:'测试官方作品',author:'测试作者',coverUrl:'https://p6-tt.bytecdn.cn/test.image',lastReadTitle:'第一章',lastReadItemId:'10001',progressState:'available'}]};}
   if(command==='official_book')return{id:args.id,title:args.id==='123456789'?'测试官方作品':'失败正文测试',author:'测试作者',description:'',source:'official',coverStyle:0,addedAt:0,chapters};
   if(command==='official_read_progress')return window.__noProgress?[]:[{book_id:'123456789',item_id:window.__remoteChapter,read_timestamp:1}];
   if(command==='official_chapter'){if(window.__chapterFail)throw '官方要求人机验证';return{id:args.id,title:args.id==='10001'?'第一章':'第二章',content:'<p>正文一。</p><p>正文二。</p>',loaded:true};}
   if(command==='official_sync_progress'){if(window.__syncFail)throw '官方写入失败';window.__remoteChapter=args.itemId;window.__noProgress=false;return{confirmed:true};}
   if(command==='official_comments')return{total:21,hasMore:args.page===1,comments:[{id:String(args.page),name:'测试书友',text:'这是模拟书评，仅用于界面测试',likes:3,replies:1}]};
   throw new Error('Unexpected command '+command);
  }};
 });
 await native.goto(base);await native.getByRole('button',{name:'账号管理',exact:true}).click();await native.getByRole('button',{name:'扫码登录',exact:true}).click();await native.getByAltText('番茄官网生成的登录二维码').waitFor();await native.getByRole('button',{name:'取消',exact:true}).click();await native.waitForTimeout(1700);assert.equal(await native.evaluate(()=>window.__calls.filter(c=>c.command==='official_poll_login').length),0);check('Cancelling QR login stops polling');
 await native.evaluate(()=>window.__pollAuthenticated=true);await native.getByRole('button',{name:'扫码登录',exact:true}).click();await native.getByText('已验证登录：测试账号',{exact:true}).waitFor();await native.getByRole('button',{name:'云端书架',exact:false}).first().click();await native.getByRole('button',{name:'刷新官方书架'}).waitFor();await native.getByText('云端读至：第一章',{exact:true}).waitFor();assert.equal(await native.evaluate(()=>window.__calls.filter(c=>c.command==='official_bookshelf').length),1);await native.getByAltText('测试官方作品 官方封面').waitFor();await native.waitForFunction(()=>document.querySelector('.official-cover')?.naturalWidth>0);check('Official cover URL reaches a rendered image');await native.locator('.official-shelf button').first().click();await native.locator('.story-content p').first().waitFor();check('Verified mock account reads a mock cloud shelf and loads a chapter');
 await native.getByTitle('官方评论').click();await native.getByText('这是模拟书评，仅用于界面测试').waitFor();await native.getByRole('button',{name:'下一页',exact:true}).click();assert.equal(await native.locator('.comments-pagination span').textContent(),'2');check('Official book review pagination passes book ID and page');
 await native.getByLabel('关闭评论').click();await native.evaluate(()=>window.__syncFail=true);await native.locator('.chapter-item').nth(1).click();await native.locator('.page-paper h1').filter({hasText:'第二章'}).waitFor();await native.getByRole('button',{name:'上传本章进度',exact:true}).click();await native.getByRole('button',{name:'确认上传本章',exact:true}).click();await native.waitForTimeout(500);await native.getByText('同步未完成：官方写入失败',{exact:false}).waitFor();assert.ok((await native.evaluate(()=>JSON.parse(localStorage.getItem('tomato-reader-v01:progress'))))['123456789']);check('Failed remote synchronization keeps local progress and reports failure');
 await native.getByRole('button',{name:'返回书架',exact:true}).click();await native.getByRole('button',{name:'阅读 测试官方作品'}).click();await native.getByRole('dialog').waitFor();await native.getByRole('button',{name:'采用云端：第 1 章'}).click();await native.locator('.page-paper h1').filter({hasText:'第一章'}).waitFor();check('Different local and cloud chapters require a progress choice');
 await native.evaluate(()=>{window.__chapterFail=true;window.__syncFail=false;}); // cached chapters need a fresh book fetch
 await native.getByRole('button',{name:'返回书架',exact:true}).click();await native.getByRole('button',{name:/找书发现/}).click();await native.getByRole('button',{name:'通过番茄链接或书籍ID直接打开作品'}).click();await native.getByLabel('打开正版作品').fill('123456780');await native.getByRole('button',{name:'打开作品',exact:true}).click();await native.getByText('官方要求人机验证',{exact:true}).waitFor();const writesBefore=await native.evaluate(()=>window.__calls.filter(c=>c.command==='official_sync_progress').length);await native.waitForTimeout(3500);assert.equal(await native.evaluate(()=>window.__calls.filter(c=>c.command==='official_sync_progress').length),writesBefore);check('Unavailable official chapter does not upload read progress');
 await native.evaluate(()=>{window.__chapterFail=false;window.__noProgress=true;window.__syncFail=false;});
 await native.getByRole('button',{name:'返回书架',exact:true}).click();await native.getByRole('button',{name:'阅读 测试官方作品'}).click();
 await native.getByText('官方未返回本书章节进度',{exact:false}).waitFor();const missingWrites=await native.evaluate(()=>window.__calls.filter(c=>c.command==='official_sync_progress').length);await native.waitForTimeout(3500);assert.equal(await native.evaluate(()=>window.__calls.filter(c=>c.command==='official_sync_progress').length),missingWrites);check('Missing cloud progress does not automatically overwrite phone progress');
 await native.getByRole('button',{name:'上传本章进度',exact:true}).click();await native.getByRole('button',{name:'确认上传本章',exact:true}).click();await native.getByText('官网已确认本章记录',{exact:false}).waitFor();assert.equal(await native.evaluate(()=>window.__calls.filter(c=>c.command==='official_sync_progress').length),missingWrites+1);check('Manual sync can initialize a previously missing cloud record');
 await native.getByRole('button',{name:'返回书架',exact:true}).click();await native.getByRole('button',{name:'云端书架',exact:false}).first().click();await native.getByText('云端读至：第一章',{exact:true}).waitFor();await native.evaluate(()=>window.__shelfFail=true);await native.getByRole('button',{name:'刷新官方书架',exact:true}).click();await native.getByText('书架读取失败：模拟书架网络错误',{exact:false}).waitFor();assert.equal(await native.locator('.official-shelf button').count(),1);check('Failed shelf refresh reports the error and preserves visible books');
 await native.close();
 assert.deepEqual(errors,[]);check('No unhandled browser runtime errors');console.log(`${passed} UI checks passed (speech and native calls mocked)`);
}finally{await browser.close();server?.kill();}
