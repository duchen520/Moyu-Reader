import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const executable = process.env.TOMATO_NATIVE_EXE;
if (!executable) throw Error('Set TOMATO_NATIVE_EXE');
const profile = resolve(`test-output/audio-diagnosis-${Date.now()}`);
const app = spawn(executable, [], { windowsHide:true, stdio:'ignore', env:{...process.env, WEBVIEW2_USER_DATA_FOLDER:profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=1542'} });
let browser;
try {
  for(let i=0;i<150;i++){try {if((await fetch('http://127.0.0.1:1542/json/version')).ok) break;}catch{} await delay(200);}
  browser=await chromium.connectOverCDP('http://127.0.0.1:1542');
  const page=browser.contexts()[0].pages()[0];
  await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
  const invoke=async(command,args)=>page.evaluate(async({command,args})=>{try{const value=await window.__TAURI_INTERNALS__.invoke(command,args);
    if(value?.audioBase64){const raw=atob(value.audioBase64); const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0)); const audio=document.createElement('audio');audio.muted=true;const url=URL.createObjectURL(new Blob([bytes],{type:value.mime}));
      value.decode=await new Promise(resolve=>{let finished=false;const timer=setTimeout(()=>done({error:'playback timeout'}),15000);const done=result=>{if(finished)return;finished=true;clearTimeout(timer);audio.pause();audio.removeAttribute('src');audio.load();URL.revokeObjectURL(url);resolve(result);};audio.onloadedmetadata=async()=>{try{await audio.play();setTimeout(()=>done({duration:audio.duration,seconds:audio.currentTime,readyState:audio.readyState,advancing:audio.currentTime>.5}),1500);}catch(e){done({error:String(e)});}};audio.onerror=()=>done({error:audio.error?.message,code:audio.error?.code,header:Array.from(bytes.slice(0,16))});audio.src=url;audio.load();});
      value.bytes=value.audioBase64.length;delete value.audioBase64;}
    return {ok:true,value};}catch(e){return {ok:false,error:String(e)};}},{command,args});
  let bookId=process.env.TOMATO_AUDIO_BOOK || '7255936586997566505';
  if(process.env.TOMATO_AUDIO_SEARCH){const result=await invoke('official_search',{keyword:process.env.TOMATO_AUDIO_SEARCH,offset:0});console.log('SEARCH',JSON.stringify(result.ok?result.value.books.map(({id,title})=>({id,title})):result));if(!result.ok || !result.value.books.length)throw Error('Book not found');bookId=result.value.books[0].id;}
  const catalog=await invoke('official_audio_catalog',{bookId}); console.log('CATALOG',JSON.stringify(catalog));
  if(catalog.ok){
    const album=catalog.value.albums[0];
    if(album){const episodes=await invoke('official_audio_episodes',{albumId:album.id});console.log('EPISODES',JSON.stringify(episodes.ok?{ok:true,count:episodes.value.length,first:episodes.value[0]}:episodes));
      const episode=episodes.value?.[Number(process.env.TOMATO_AUDIO_EPISODE || 0)];
      if(episodes.ok && episode){const play=await invoke('official_audio_play',{itemId:episode.id});console.log('RECORDED',JSON.stringify(play));}}
    const tone=catalog.value.ttsTones[0];
    if(tone){const book=await invoke('official_book',{id:bookId});console.log('BOOK',JSON.stringify(book.ok?{ok:true,keys:Object.keys(book.value)}:book));
      const chapter=book.value?.chapters?.[Number(process.env.TOMATO_AUDIO_CHAPTER || 0)]; if(chapter){const play=await invoke('official_tts_play',{bookId,itemId:chapter.id,toneId:process.env.TOMATO_AUDIO_TONE || tone.id});console.log('TTS',JSON.stringify(play));}}
  }
  if(process.env.TOMATO_AUDIO_UI === '1') {
    assert.ok(catalog.ok, 'Native catalog must load');
    await page.locator('.side-nav button').filter({hasText:'找书发现'}).click();
    await page.getByRole('button',{name:'通过番茄链接或书籍ID直接打开作品'}).click();
    await page.getByLabel('打开正版作品').fill(bookId);
    await page.getByRole('button',{name:'打开作品',exact:true}).click();
    await page.locator('.chapter-item').nth(Number(process.env.TOMATO_AUDIO_CHAPTER || 0)).click({timeout:60000});
    await page.locator('.story-content p').first().waitFor({timeout:60000});
    await page.getByTitle('听书与自动翻页').click();
    await page.getByRole('button',{name:'番茄AI音色',exact:true}).click();
    await page.getByLabel('番茄AI音色').selectOption(process.env.TOMATO_AUDIO_TONE || catalog.value.ttsTones[0].id);
    await page.locator('.official-tts audio').evaluate(a=>{a.muted=true;});
    await page.getByRole('button',{name:'播放本章',exact:true}).click();
    let advancing=false;
    for(let i=0;i<120;i++){
      advancing=await page.locator('.official-tts audio').evaluate(a=>!a.paused && a.currentTime>1);
      if(advancing)break;
      await delay(500);
    }
    assert.ok(advancing, 'Actual native UI audio must advance beyond one second');
    console.log('UI_TTS',JSON.stringify(await page.locator('.official-tts audio').evaluate(a=>({seconds:a.currentTime,duration:a.duration}))));
    await page.getByRole('button',{name:'停止AI朗读',exact:true}).click();
    await page.getByRole('button',{name:'官方有声',exact:true}).click();
    await page.getByText('官方本次未提供真人有声版，可切换到「番茄AI音色」朗读。',{exact:true}).waitFor();
    assert.equal(await page.locator('.official-audio .audio-error').count(),0);
    await page.screenshot({path:'test-output/native-audio-no-recorded.png'});
    console.log('PASS actual native AI player advances; absent recorded edition is a normal state without catalog errors. No cloud progress written.');
  }
} finally {await browser?.close();app.kill();}
