import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const executable=process.env.TOMATO_NATIVE_EXE ?? resolve('src-tauri/target/release/tomato-reader.exe');
const profile=resolve(`test-output/titlebar-${Date.now()}`);
const app=spawn(executable,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=1530',WEBVIEW2_USER_DATA_FOLDER:profile}});
let browser,page; const errors=[],report={};
const native=(command)=>page.evaluate(command=>window.__TAURI_INTERNALS__.invoke(`plugin:window|${command}`,{label:'main'}),command);
async function until(check){for(let i=0;i<100;i++){if(await check())return;await delay(100);}assert.fail('Window state did not settle');}
try{
  for(let i=0;i<150;i++){try{if((await fetch('http://127.0.0.1:1530/json/version')).ok)break;}catch{}await delay(200);}
  browser=await chromium.connectOverCDP('http://127.0.0.1:1530');page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));
  await page.locator('.app-shell').waitFor();assert.equal(await native('title'),'墨屿');assert.equal(await native('is_decorated'),false);
  assert.equal(await page.locator('.window-titlebar-brand').textContent(),'墨屿');
  report.frameless=true;console.log('PASS Native window title is Moyu and the system white titlebar is disabled');
  await mkdir('test-output',{recursive:true});report.themes=[];
  for(const theme of ['paper','night','sepia']){
    await page.evaluate(theme=>{const key='tomato-reader-v01:preferences';const prefs={fontSize:19,lineHeight:1.95,contentWidth:760,autoUploadProgress:false,...JSON.parse(localStorage.getItem(key)??'{}'),theme};localStorage.setItem(key,JSON.stringify(prefs));},theme);
    await page.reload();await page.locator(`.app-shell.theme-${theme}`).waitFor();
    const colors=await page.locator('.window-titlebar').evaluate(el=>({bar:getComputedStyle(el).backgroundColor,sidebar:getComputedStyle(document.querySelector('.sidebar')).backgroundColor,height:el.getBoundingClientRect().height}));
    assert.equal(colors.bar,colors.sidebar);assert.equal(colors.height,36);
    if(theme==='night')assert.notEqual(colors.bar,'rgb(255, 255, 255)');
    report.themes.push({theme,...colors});await page.screenshot({path:`test-output/moyu-titlebar-${theme}.png`});
  }
  console.log('PASS All three themes color the real titlebar to match the application');
  await page.getByRole('button',{name:'最大化窗口',exact:true}).click();await until(()=>native('is_maximized'));
  await page.getByRole('button',{name:'还原窗口',exact:true}).click();await until(async()=>!(await native('is_maximized')));
  await page.locator('.window-titlebar-context').dblclick();await until(()=>native('is_maximized'));
  await page.locator('.window-titlebar-context').dblclick();await until(async()=>!(await native('is_maximized')));
  report.maximizeRestore=true;report.doubleClick=true;console.log('PASS Real maximize/restore controls and native drag-region double click work');
  report.dragRegion=true;
  await page.getByRole('button',{name:'阅读设置',exact:true}).click();
  assert.equal(await page.locator('.window-titlebar').count(),1);
  assert.ok((await page.locator('.settings-screen').textContent()).includes('墨屿'));
  await page.getByRole('button',{name:'最小化窗口',exact:true}).click();await until(()=>native('is_minimized'));
  report.minimize=true;assert.deepEqual(errors,[]);
  // Closing through the same control while minimized avoids taking over the user's desktop to restore it.
  const exited=new Promise(resolve=>app.once('exit',resolve));
  await page.getByRole('button',{name:'关闭窗口',exact:true}).evaluate(button=>button.click()).catch(()=>{});
  await Promise.race([exited,delay(10000).then(()=>{throw Error('Close button did not exit the native app');})]);
  report.close=true;console.log('PASS Real minimize and close controls work without unhandled UI errors');
}finally{await mkdir('test-output',{recursive:true});await writeFile('test-output/native-titlebar-report.json',JSON.stringify({...report,errors},null,2));await browser?.close().catch(()=>{});app.kill();}
