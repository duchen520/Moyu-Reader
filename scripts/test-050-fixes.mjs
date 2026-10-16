import { installRankingMock } from './ranking-fixture.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {join} from 'node:path';
const root=join(import.meta.dirname,'..');
const require=createRequire(join(root,'package.json'));
const {chromium}=require('playwright');
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1488','--strictPort'],{cwd:root,stdio:'ignore'});
const first='7143038691944959011',second='6982529841564224526';
let browser;
async function fixture(){
  const page=await browser.newPage({viewport:{width:1360,height:900}});
  await page.addInitScript(()=>{
    window.isTauri=true;window.__calls=[];window.__release={};window.__holdBooks=false;window.__holdSearch=false;
    window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{
      window.__calls.push({command,args});
      if(command==='official_account')return null;
      if(command==='official_cancel_login')return;
      if(command==='official_book'){
        if(window.__holdBooks)await new Promise(r=>window.__release[args.id]=r);
        return{id:args.id,title:args.id==='7143038691944959011'?'十日终焉':'我在精神病院学斩神',author:'作者',description:'模拟作品',source:'official',coverStyle:0,addedAt:1,chapters:[{id:'111111',title:'测试第一章',content:'',loaded:false}]};
      }
      if(command==='official_chapter')return{id:args.id,title:'测试第一章',content:'<p>模拟正文，只用于界面检查。</p>',loaded:true};
      if(command==='official_search'){
        if(window.__holdSearch)await new Promise(r=>window.__release.search=r);
        return{books:[{id:'7143038691944959011',title:'十日终焉',author:'作者',description:'模拟搜索结果',score:'9.8'}],hasMore:false,nextOffset:0};
      }
      throw Error('Unexpected mock command '+command);
    }};
  });
  await page.route('https://**/*',route=>route.abort());
  await installRankingMock(page);
  await page.goto('http://127.0.0.1:1488');return page;
}
const stored=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('tomato-reader-v01:books')??'[]').map(b=>b.id));
const rankings=page=>page.locator('button.nav-btn').filter({hasText:'排行榜单'}).click();
const shelf=page=>page.getByRole('button',{name:/本地书架/}).click();
try{
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:1488')).ok)break;}catch{}await delay(100);}
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  {
    const page=await fixture();await rankings(page);await page.evaluate(()=>window.__holdBooks=true);
    await page.locator('.ranking-card').nth(0).locator('.secondary-action-btn').click();
    await page.locator('.ranking-card').nth(1).locator('.secondary-action-btn').click();
    await page.waitForFunction(()=>Object.keys(window.__release).length===2);
    await page.evaluate(id=>window.__release[id](),first);
    await page.locator('.ranking-card').nth(0).locator('.in-shelf').waitFor();
    await page.evaluate(id=>window.__release[id](),second);
    await page.locator('.ranking-card').nth(1).locator('.in-shelf').waitFor();
    assert.equal(await page.locator('.ranking-card .secondary-action-btn.in-shelf').count(),2);
    assert.deepEqual(await stored(page),[first,second]);
    console.log('PASS concurrent favorites are both persisted');await page.close();
  }
  {
    const page=await fixture();await rankings(page);
    await page.locator('.ranking-card').first().locator('.primary-action-btn').click();
    await page.locator('.story-content p').first().waitFor();
    await page.getByRole('button',{name:'返回书架',exact:true}).click();await rankings(page);
    await page.locator('.ranking-card').first().locator('.in-shelf').waitFor();
    assert.deepEqual(await stored(page),[first]);
    await page.locator('.ranking-card').first().locator('.secondary-action-btn').click();
    assert.deepEqual(await stored(page),[first]);
    console.log('PASS reading a book saves it to the shelf');await page.close();
  }
  {
    const page=await fixture();await rankings(page);
    await page.locator('.ranking-card').first().locator('.secondary-action-btn').click();
    await page.locator('.ranking-card').first().locator('.in-shelf').waitFor();
    assert.deepEqual(await stored(page),[first]);
    await page.getByRole('button',{name:'账号管理',exact:true}).click();
    await page.getByRole('button',{name:'扫码登录',exact:true}).waitFor();
    await shelf(page);assert.equal(await page.getByRole('button',{name:'阅读 十日终焉',exact:true}).count(),1);
    await page.locator('input[type=file]').setInputFiles({name:'检查.txt',mimeType:'text/plain',buffer:Buffer.from('第一章 测试\n测试正文。')});
    await page.getByRole('button',{name:'阅读 检查',exact:true}).waitFor();
    assert.ok((await stored(page)).includes(first));
    console.log('PASS guest account and TXT import preserve favorites');await page.close();
  }
  {
    const page=await fixture();await rankings(page);await page.evaluate(()=>window.__holdBooks=true);
    await page.locator('.ranking-card').first().locator('.primary-action-btn').click();
    await page.waitForFunction(()=>!!window.__release['7143038691944959011']);
    await page.locator('.side-nav').getByRole('button',{name:'阅读设置',exact:true}).click();
    await page.locator('.settings-screen').waitFor();
    await page.evaluate(id=>window.__release[id](),first);await page.waitForTimeout(300);
    assert.equal(await page.locator('.settings-screen').count(),1);
    assert.equal(await page.locator('.reader-layout').count(),0);
    console.log('PASS late book responses preserve navigation');await page.close();
  }
  {
    const page=await fixture();await page.locator('button.nav-btn').filter({hasText:'找书发现'}).click();
    await page.evaluate(()=>window.__holdSearch=true);
    await page.getByLabel('搜索正版小说').fill('测试');await page.getByRole('button',{name:'搜索小说',exact:true}).click();
    await page.waitForFunction(()=>!!window.__release.search);
    await page.getByTitle('清空输入').click();await page.evaluate(()=>window.__release.search());
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.search-book-card').count(),0);
    assert.equal(await page.getByLabel('搜索正版小说').inputValue(),'');
    console.log('PASS clearing search invalidates pending results');await page.close();
  }
}finally{await browser?.close();server.kill();}
