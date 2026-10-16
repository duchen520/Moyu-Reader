const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const compile = p => ts.transpileModule(fs.readFileSync(p, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const records = new Map();
const localStorage = {getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v)};
const load = (p, imports={}) => {
  const exports = {};
  vm.runInNewContext(compile(p), {exports, require:n=>imports[n]??require(n), localStorage, URL, Blob, atob, console, SpeechSynthesisUtterance:class{constructor(text){this.text=text;}}});
  return exports;
};
async function main(){
  let slots=[], cursor=0, effects=[], tree;
  const changed=(a,b)=>!a||!b||a.length!==b.length||a.some((v,i)=>!Object.is(v,b[i]));
  const hooks={
    useState(v){const i=cursor++;if(!slots[i])slots[i]={v:typeof v==='function'?v():v};return[slots[i].v,v=>{slots[i].v=typeof v==='function'?v(slots[i].v):v;}];},
    useRef(v){const i=cursor++;return slots[i]??(slots[i]={current:v});},
    useEffect(fn,deps){const i=cursor++;if(changed(slots[i]?.deps,deps))effects.push(()=>{slots[i]?.clean?.();slots[i]={deps,clean:fn()};});}
  };
  const jsx=(type,props)=>({type,props});
  const media=load('src/lib/media.ts');
  records.set('tomato-reader-v03:audio:book1',JSON.stringify({albumId:'album1',episodeId:'episode1',seconds:12,updatedAt:1}));
  const official={audioCatalog:async()=>({albums:[{id:'album1',name:'A'},{id:'album2',name:'B'}]}),audioEpisodes:async a=>[{id:a==='album1'?'episode1':'episode2',title:'episode'}],audioPlay:async id=>({itemId:id,urls:['https://example.com/audio.mp4']})};
  const {OfficialAudioPlayer}=load('src/components/OfficialAudioPlayer.tsx',{'react':hooks,'react/jsx-runtime':{jsx,jsxs:jsx},'../lib/official':{official,errorMessage:String},'../lib/media':media});
  const audio={currentTime:0,duration:60,pause(){},load(){},removeAttribute(){},play:async()=>{}};
  const walk=(x,pred)=>{if(!x||typeof x!=='object')return null;if(pred(x))return x;for(const y of [x.props?.children].flat(Infinity)){const r=walk(y,pred);if(r)return r;}return null;};
  const render=()=>{cursor=0;effects=[];tree=OfficialAudioPlayer({bookId:'book1',stopSignal:0,onStart(){},notice(){}});walk(tree,x=>x.type==='audio').props.ref.current=audio;const batch=effects;batch.forEach(f=>f());};
  const flush=async()=>{for(let i=0;i<6;i++){render();await new Promise(r=>setImmediate(r));}};
  await flush();
  const button=()=>walk(tree,x=>x.type==='button'&&x.props.children==='播放本集');
  const audioNode=()=>walk(tree,x=>x.type==='audio');
  button().props.onClick();await flush();audioNode().props.onLoadedMetadata();
  assert.equal(audio.currentTime,12);
  audio.currentTime=40;audioNode().props.onPause();
  assert.equal(media.readAudioProgress('book1').seconds,40);
  button().props.onClick();await flush();audioNode().props.onLoadedMetadata();
  assert.equal(audio.currentTime,40);
  console.log('PASS Replay restores the latest saved 40s position');
  audio.currentTime=40;
  walk(tree,x=>x.type==='select'&&x.props['aria-label']==='官方有声版本').props.onChange({target:{value:'album2'}});
  await flush();
  const savedPosition=media.readAudioProgress('book1');
  assert.equal(savedPosition.albumId,'album1');assert.equal(savedPosition.episodeId,'episode1');
  console.log('PASS Changing album preserves the correct album and episode pair');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
