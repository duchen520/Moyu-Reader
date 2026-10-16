import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import ts from 'typescript';
const code = await readFile(new URL('../src/lib/speech.ts',import.meta.url),'utf8');
const built = ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}});
const {SpeechReader,speechUnits} = await import('data:text/javascript;base64,'+Buffer.from(built.outputText).toString('base64'));
let passed=0;
function test(name,run){run();passed++;console.log('PASS '+name);}
globalThis.SpeechSynthesisUtterance = class { constructor(text){this.text=text;} };
function fixture(){let calls=[],updates=[],finished=0,errors=[];const synth={cancel(){},getVoices(){return[{voiceURI:'zh',lang:'zh-CN'}];},speak(u){calls.push(u);}};const reader=new SpeechReader(synth,s=>updates.push(s),()=>finished++,s=>errors.push(s));return{reader,calls,updates,errors,get finished(){return finished;}};}
test('Long text is chunked without losing characters or paragraph mapping',()=>{const p='甲'.repeat(410);const u=speechUnits([p,'乙。丙！']);assert.equal(u.slice(0,3).map(x=>x.text).join(''),p);assert.ok(u.every(x=>Array.from(x.text).length<=180));assert.equal(u.at(-1).paragraph,1);});
test('Cancelled utterance callbacks cannot advance paused playback',()=>{const f=fixture();f.reader.setText(['一。二。']);f.reader.start();const first=f.calls[0];f.reader.pause();first.onend();assert.equal(f.calls.length,1);assert.equal(f.updates.at(-1).status,'paused');f.reader.resume();assert.equal(f.calls.length,2);assert.equal(f.calls[1].text,first.text);});
test('Completion fires once and leaves stopped state',()=>{const f=fixture();f.reader.setText(['一。']);f.reader.start();f.calls[0].onend();assert.equal(f.finished,1);assert.equal(f.updates.at(-1).status,'stopped');f.calls[0].onend();assert.equal(f.finished,1);});
test('Stopped or replaced text cannot be advanced by stale callbacks',()=>{const f=fixture();f.reader.setText(['旧。']);f.reader.start();const old=f.calls[0];f.reader.setText(['新。']);old.onend();old.onerror();assert.equal(f.finished,0);assert.equal(f.errors.length,0);f.reader.start();assert.equal(f.calls.at(-1).text,'新。');});
test('Rate change preserves position and invalidates previous callbacks',()=>{const f=fixture();f.reader.setText(['一。二。']);f.reader.start();const old=f.calls[0];f.reader.configure(1.5,'zh');old.onend();assert.equal(f.calls.length,2);assert.equal(f.calls[1].rate,1.5);assert.equal(f.calls[1].text,'一。');});
console.log(`${passed} unit checks passed`);
