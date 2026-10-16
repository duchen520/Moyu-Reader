import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1481','--strictPort'],{stdio:'ignore'});
let browser;let passed=0;const errors=[];
const check=name=>{passed++;console.log('PASS '+name);};
function wav(){const samples=16000*8;const buffer=Buffer.alloc(44+samples*2);buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(16000,24);buffer.writeUInt32LE(32000,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(samples*2,40);return buffer;}
try{
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:1481')).ok)break;}catch{}await delay(100);}
 browser=await chromium.launch({headless:true,...(process.env.TOMATO_TEST_BROWSER?{executablePath:process.env.TOMATO_TEST_BROWSER}:{}),args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage({viewport:{width:1360,height:900}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://p3-novel.byteimg.com/test.png',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAAHUlEQVR4nGP8tKCbgVzARLbOUc2jmkc1j2qmimYAcwsCRX6NxhcAAAAASUVORK5CYII=','base64')}));
 await page.route('https://audio-test.invalid/**',route=>route.fulfill({contentType:'audio/wav',body:wav()}));
 await page.addInitScript(()=>{
  window.isTauri=true;window.__calls=[];window.__audioMode='failure';window.__audioDelay=0;window.__episodesMode='failure';window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
  Object.defineProperty(window,'speechSynthesis',{value:{cancel(){},getVoices(){return[];},addEventListener(){},removeEventListener(){},speak(){}},configurable:true});
  const c={id:'333333',name:'测试书友',text:'模拟评论正文',likes:2,replies:1,userId:'444444'};
  window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{
   window.__calls.push({command,args});
   if(command==='official_account')return{id:'999999',name:'测试账号'};
   if(command==='official_cancel_login')return;
   if(command==='official_search')return{books:args.offset?[{id:'123456789',title:'测试作品一',author:'测试作者',description:'第二页重叠结果',score:'9.0'},{id:'987654321',title:'测试作品二',author:'测试作者',description:'第二页新作品',score:'8.0'}]:[{id:'123456789',title:'测试作品一',author:'测试作者',description:'官方搜索模拟结果',score:'9.0'}],hasMore:!args.offset,nextOffset:args.offset?20:10};
   if(command==='official_book')return{id:args.id,title:'测试作品一',author:'测试作者',description:'',source:'official',coverStyle:0,addedAt:0,chapters:[{id:'111111',title:'第一章',content:'',loaded:false}]};
   if(command==='official_read_progress')return[{book_id:'123456789',item_id:'111111',read_timestamp:1}];
   if(command==='official_chapter')return{id:'111111',title:'第一章',content:'<p>用于验证界面的文字。</p>',loaded:true};
   if(command==='official_comments')return{comments:[c],total:1,hasMore:false};
   if(command==='official_comment_details')return{comment:{...c,images:['https://p3-novel.byteimg.com/test.png','javascript:alert(1)'],children:[],replyTo:''},replies:[{id:'555555',name:'回复书友',text:'模拟官网可见回复',likes:0,replies:0,images:[],children:[],replyTo:'测试书友'}],source:'official-web',complete:false};
   if(command==='official_audio_catalog')return{albums:[{id:'777777',name:'测试作品一',narrator:'测试主播',kind:'recorded'}],ttsTones:[]};
   if(command==='official_audio_episodes'){if(window.__episodesMode==='failure')throw '模拟目录连接失败';return[{id:'888881',title:'第一集'},{id:'888882',title:'第二集'}];}
   if(command==='official_audio_play'){const mode=window.__audioMode;await new Promise(r=>setTimeout(r,window.__audioDelay));if(mode==='failure')throw '官方返回空响应，试播未成功';if(mode==='native-audio')return{...window.__realAudio,itemId:args.itemId};return{itemId:args.itemId,urls:['https://audio-test.invalid/test.wav?episode='+args.itemId]};}
   throw Error('Unexpected '+command);
  }};
 });
 await page.goto('http://127.0.0.1:1481');await page.getByRole('button',{name:/找书发现/}).click();await page.getByLabel('搜索正版小说').fill('测试');await page.getByRole('button',{name:'搜索小说',exact:true}).click();await page.getByText('官方搜索模拟结果',{exact:true}).waitFor();await page.getByRole('button',{name:'加载更多搜索结果'}).click();await page.getByText('第二页新作品',{exact:true}).waitFor();assert.equal(await page.locator('.official-search-results article').count(),2);check('Official search loads more and deduplicates overlapping results');
 await page.locator('.official-search-results article').first().getByRole('button',{name:'打开作品'}).click();await page.locator('.story-content p').first().waitFor();await page.getByTitle('官方评论').click();await page.getByRole('button',{name:'查看详情与回复'}).click();await page.getByText('模拟官网可见回复',{exact:true}).waitFor();assert.equal(await page.locator('.comment-images img').count(),1);await page.waitForFunction(()=>document.querySelector('.comment-images img')?.naturalWidth>0);check('Comment details show available replies and exclude unsafe images');
 await page.getByRole('button',{name:'查看评论图片 1'}).click();await page.getByRole('dialog',{name:'评论图片预览'}).waitFor();await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.locator('.reader-layout').count(),1);check('Photo preview opens and Escape closes only the preview');
 await page.getByLabel('关闭评论').click();await page.getByTitle('听书与自动翻页').click();await page.getByRole('button',{name:'官方有声',exact:true}).click();await page.getByText('模拟目录连接失败',{exact:true}).waitFor();const beforeRetry=await page.evaluate(()=>window.__calls.filter(c=>c.command==='official_audio_episodes').length);await page.evaluate(()=>window.__episodesMode='plain');await page.getByRole('button',{name:'重新检查',exact:true}).click();await page.getByLabel('有声集数').locator('option').nth(1).waitFor({state:'attached'});assert.ok(await page.evaluate(()=>window.__calls.filter(c=>c.command==='official_audio_episodes').length)>beforeRetry);check('Rechecking retries a failed episode directory even when the album ID is unchanged');assert.equal(await page.getByLabel('有声集数').locator('option').count(),2);check('Official audio editions and their independent episode list load');
 await page.getByRole('button',{name:'播放本集'}).click();await page.getByText('官方返回空响应，试播未成功',{exact:true}).waitFor();assert.equal(await page.locator('audio').getAttribute('src'),null);check('An unavailable official stream reports failure without a fake audio source');
 await page.evaluate(()=>window.__audioMode='plain');await page.getByRole('button',{name:'播放本集'}).click();await page.getByText('正在播放官方音频',{exact:true}).waitFor();await page.getByRole('group',{name:'有声倍速'}).getByRole('button',{name:'1.5×',exact:true}).click();assert.equal(await page.locator('audio').evaluate(el=>el.playbackRate),1.5);await page.waitForTimeout(300);assert.ok(await page.locator('audio').evaluate(el=>el.currentTime)>0);check('Media element plays a test WAV and changes playback speed');
 await page.getByRole('button',{name:'电脑语音',exact:true}).click();await page.getByRole('button',{name:'开始朗读',exact:true}).click();await page.getByRole('button',{name:'暂停朗读',exact:true}).waitFor();assert.ok(await page.locator('audio').evaluate(el=>el.paused));check('Starting computer speech pauses official audio');
 await page.getByRole('button',{name:'停止全部播放',exact:true}).click();await page.getByRole('button',{name:'官方有声',exact:true}).click();await page.evaluate(()=>window.__audioDelay=200);await page.getByRole('button',{name:'播放本集'}).click();await page.getByLabel('有声集数').selectOption('1');await page.waitForTimeout(350);assert.equal(await page.locator('audio').getAttribute('src'),null);check('Changing episodes cancels late playback responses');
 await page.evaluate(()=>window.__audioDelay=0);await page.getByRole('button',{name:'播放本集'}).click();await page.getByText('正在播放官方音频',{exact:true}).waitFor();await page.clock.install();await page.getByLabel('定时停止').selectOption('15');await page.clock.fastForward(900000);assert.ok(await page.locator('audio').evaluate(el=>el.paused));check('Sleep deadline pauses official audio as well as computer speech');
 if(process.env.TOMATO_PRIVATE_AUDIO_FIXTURE){
  const fixture=JSON.parse(await readFile(process.env.TOMATO_PRIVATE_AUDIO_FIXTURE,'utf8'));
  await page.clock.resume();
  await page.evaluate(a=>{window.__realAudio=a;window.__audioMode='native-audio';window.__audioDelay=0;},fixture.audio);
  await page.getByRole('button',{name:'播放本集'}).click();
  await page.waitForFunction(()=>{const a=document.querySelector('audio');return a&&a.duration>700&&!a.paused;},null,{timeout:15000});
  await page.locator('audio').evaluate(a=>{a.currentTime=300;});
  await page.waitForFunction(()=>{const a=document.querySelector('audio');return a.currentTime>300&&!a.seeking;});
  await page.getByRole('group',{name:'有声倍速'}).getByRole('button',{name:'1.25×',exact:true}).click();
  assert.equal(await page.locator('audio').evaluate(a=>a.playbackRate),1.25);
  assert.ok((await page.locator('audio').getAttribute('src')).startsWith('blob:'));
  check('Real official AAC from native backend plays as Blob, seeks to 300s and changes rate');
 }
 await mkdir('test-output',{recursive:true});await page.screenshot({path:'test-output/extras-visual.png'});
 assert.deepEqual(errors,[]);check('No unhandled errors in new feature flows');console.log(`${passed} extra UI checks passed (native replies and media addresses mocked)`);
}finally{await browser?.close();server.kill();}
