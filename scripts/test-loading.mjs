import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1501','--strictPort'],{stdio:'ignore'});
let browser,passed=0; const errors=[];
const check=name=>{passed++;console.log('PASS '+name);};
async function fixture(options={}) {
 const page=await browser.newPage({viewport:{width:1280,height:820}});
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(options=>{
  window.isTauri=true;window.__calls=[];window.__callbacks={};window.__nextCallback=1;
  window.__hold={book:!!options.holdBook,progress:!!options.holdProgress,shelf:!!options.holdShelf};window.__release={};
  window.__user={id:'55555',name:'加载测试账号'};window.__remote='10001';window.__progressFail=false;
  window.__coverURL='https://p3.fqnovelpic.com/sample.webp?x-signature=one';
  window.__count=options.many?80:1;
  const pause=async key=>{if(window.__hold[key])await new Promise(resolve=>window.__release[key]=()=>{window.__hold[key]=false;resolve();});};
  const entries=()=>Array.from({length:window.__count},(_,i)=>({id:String(123456789+i),title:'加载作品'+i,author:'作者',coverUrl:window.__coverURL,progressState:'loading'}));
  localStorage.setItem('tomato-reader-v01:preferences',JSON.stringify({theme:'paper',fontSize:20,lineHeight:1.9,contentWidth:900,autoUploadProgress:!!options.autoUpload,showParagraphComments:false}));
  if(options.saved)localStorage.setItem('tomato-reader-v01:progress',JSON.stringify({'123456789':{chapterIndex:0,scrollRatio:0,updatedAt:1}}));
  window.__TAURI_INTERNALS__={
   transformCallback(callback){const id=window.__nextCallback++;window.__callbacks[id]=callback;return id;},
   unregisterCallback(id){delete window.__callbacks[id];},
   invoke:async(command,args={})=>{
    window.__calls.push({command,args});
    if(command==='official_account')return window.__user;
    if(command==='official_cancel_login')return;
    if(command==='official_logout'){window.__user=null;return;}
    if(command==='official_bookshelf'){
     window.__shelfChannel=args.updates;
     if(args.updates)window.__callbacks[args.updates.id]({index:0,message:{entries:entries(),partial:true,total:window.__count}});
     await pause('shelf');
     if(args.updates) {
      if(options.latePartial)setTimeout(()=>{window.__callbacks[args.updates.id]?.({index:1,message:{entries:entries(),partial:true}});window.__callbacks[args.updates.id]?.({index:2,end:true});},100);
      else window.__callbacks[args.updates.id]?.({index:1,end:true});
     }
     return{entries:entries().map(b=>({...b,progressState:'available',lastReadTitle:'测试章1',lastReadItemId:'10001'}))};
    }
    if(command==='official_cover')return{dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',cached:false,bytes:68};
    if(command==='official_book'){
     await pause('book');
     return{id:args.id,title:'加载作品0',author:'作者',description:'',source:'official',coverStyle:0,addedAt:1,
      chapters:['10001','10002'].map((id,i)=>({id,title:'测试章'+(i+1),content:'',loaded:false}))};
    }
    if(command==='official_read_progress'){
     await pause('progress');if(window.__progressFail)throw Error('进度暂不可用');
     return[{book_id:'123456789',item_id:window.__remote,read_timestamp:1792070981}];
    }
    if(command==='official_chapter')return{id:args.id,title:'测试章'+(Number(args.id)-10000),content:'<p idx="0">这是生成的测试正文。</p>',loaded:true};
    if(command==='official_sync_progress')throw Error('Tests must not upload');
    throw Error('Unexpected command '+command);
   }
  };
 },options);
 await page.goto('http://127.0.0.1:1501');return page;
}
const shelf=page=>page.locator('.side-nav button').filter({hasText:'云端书架'}).click();
const calls=(page,command)=>page.evaluate(command=>window.__calls.filter(c=>c.command===command).length,command);
const open=async page=>{await shelf(page);await page.locator('.official-shelf button').first().click();};
try {
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:1501')).ok)break;}catch{}await delay(100);}
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 {
  const page=await fixture({holdShelf:true});await shelf(page);
  await page.locator('.official-shelf button').first().waitFor();
  assert.equal(await page.getByRole('button',{name:'正在加载书架…',exact:true}).isDisabled(),true);
  assert.ok((await page.locator('.official-shelf').textContent()).includes('章节进度正在后台读取'));
  check('Shelf metadata renders before the progress request completes');
  await page.locator('img[data-cover-source]').waitFor();
  assert.ok(await page.locator('img[data-cover-source]').evaluate(img=>img.naturalWidth>0));
  assert.equal(await calls(page,'official_cover'),1);
  await page.evaluate(()=>window.__release.shelf());
  await page.getByRole('button',{name:'刷新官方书架',exact:true}).waitFor();
  await page.getByRole('button',{name:'阅读设置',exact:true}).click();await shelf(page);
  await page.locator('img[data-cover-source]').waitFor();assert.equal(await calls(page,'official_cover'),1);
  check('Visible cover requests are deduplicated across navigation');
  await page.evaluate(()=>window.__coverURL='https://p3.fqnovelpic.com/sample.webp?x-signature=two');
  await page.getByRole('button',{name:'刷新官方书架',exact:true}).click();await page.locator('img[data-cover-source]').waitFor();
  assert.equal(await calls(page,'official_cover'),1);check('Refreshed signed cover URLs reuse the same cover resource');
  await page.evaluate(()=>window.__coverURL='https://p3.fqnovelpic.com/changed.webp');
  await page.getByRole('button',{name:'刷新官方书架',exact:true}).click();await page.locator('img[data-cover-source]').waitFor();
  assert.equal(await calls(page,'official_cover'),2);check('A changed cover path triggers a fresh image');await page.close();
 }
 {
  const page=await fixture({latePartial:true});await shelf(page);await page.getByText('云端读至：测试章1',{exact:true}).waitFor();
  await page.waitForTimeout(250);assert.ok((await page.locator('.official-shelf').textContent()).includes('云端读至：测试章1'));
  check('A delayed partial update cannot replace completed shelf progress');await page.close();
 }
 {
  const page=await fixture({many:true});await shelf(page);await page.locator('img[data-cover-source]').first().waitFor();
  await page.waitForTimeout(200);assert.ok(await calls(page,'official_cover')<40);
  check('Offscreen covers do not start a whole-shelf download');await page.close();
 }
 {
  const page=await fixture({holdBook:true,holdProgress:true,autoUpload:true});await open(page);
  await page.locator('.opening-screen').waitFor();await page.waitForFunction(()=>!!window.__release.book&&!!window.__release.progress);
  assert.equal(await calls(page,'official_account'),1);check('Clicking opens a loading view immediately and reuses startup account verification');
  await page.evaluate(()=>window.__release.book());await page.waitForTimeout(5600);
  assert.equal(await page.locator('.reader-layout').count(),0);assert.equal(await calls(page,'official_sync_progress'),0);
  check('Directory and progress run together; pending progress cannot trigger automatic upload');
  await page.evaluate(()=>{window.__remote='10002';window.__release.progress();});
  await page.locator('.story-content p').first().waitFor();assert.equal(await page.locator('.page-paper h1').textContent(),'测试章2');
  check('A late phone progress result selects the correct chapter before reading starts');await page.close();
 }
 {
  const page=await fixture({holdBook:true,holdProgress:true});await open(page);await page.locator('.opening-screen').waitFor();
  await page.waitForFunction(()=>!!window.__release.book&&!!window.__release.progress);
  await page.getByRole('button',{name:'阅读设置',exact:true}).click();
  await page.evaluate(()=>{window.__release.book();window.__release.progress();});await page.waitForTimeout(200);
  assert.equal(await page.locator('.settings-screen').count(),1);assert.equal(await page.locator('.reader-layout').count(),0);
  check('Leaving a pending open prevents late responses from reopening the reader');await page.close();
 }
 {
  const page=await fixture({saved:true});await page.evaluate(()=>window.__remote='10002');await open(page);
  await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.locator('.library-screen').waitFor();assert.equal(await page.locator('.opening-screen').count(),0);
  check('Cancelling a progress conflict returns to a usable shelf');await page.close();
 }
 {
  const page=await fixture({autoUpload:true});await page.evaluate(()=>window.__progressFail=true);await open(page);
  await page.locator('.story-content p').first().waitFor();await page.waitForTimeout(5600);
  assert.ok((await page.locator('.sync-bar').textContent()).includes('暂停'));assert.equal(await calls(page,'official_sync_progress'),0);
  check('A failed progress check allows local reading while automatic upload stays paused');await page.close();
 }
 {
  const page=await fixture({holdShelf:true});await shelf(page);await page.locator('.official-shelf button').first().waitFor();
  await page.getByRole('button',{name:'账号管理',exact:true}).click();await page.getByRole('button',{name:'退出账号',exact:true}).click();
  await page.evaluate(()=>window.__callbacks[window.__shelfChannel.id]?.({index:1,message:{entries:[{id:'123456789',title:'旧账号响应',author:'旧账号',progressState:'loading'}]}}));
  await page.evaluate(()=>window.__release.shelf());await shelf(page);await page.waitForTimeout(200);
  assert.equal(await page.locator('.official-shelf button').count(),0);
  check('Partial shelf updates from a logged-out account are ignored');await page.close();
 }
 assert.deepEqual(errors,[]);check('Loading optimization scenarios produce no unhandled errors');
 console.log(`${passed} loading optimization checks passed (mock services).`);
} finally {await browser?.close();server.kill();}
