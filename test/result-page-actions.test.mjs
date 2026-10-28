import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {buildResultView} from '../web/js/result-state.mjs';
const source=(await readFile(new URL('../web/js/result-page.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
class Element{
 constructor(){this.textContent='';this.disabled=false;this.hidden=false;this.value='1';this.handlers={};}
 addEventListener(name,fn){this.handlers[name]=fn;}
 removeAttribute(){} pause(){} load(){} remove(){} append(){} replaceChildren(){} click(){}
}
test('download then queued restore replaces consumed/preparing messages when polling finds the new version',async()=>{
 const elements=new Map(),timers=new Map();let sequence=0,phase='available',version=0,restores=0,downloads=0;
 const el=selector=>{if(!elements.has(selector))elements.set(selector,new Element());return elements.get(selector);};
 const body=Buffer.from('audio fixture');
 const state=()=>({status:phase,deliveryVersion:version,canRestore:phase!=='processing',expiresAt:new Date(Date.now()+86400000).toISOString(),restoreDeadline:new Date(Date.now()+50*86400000).toISOString(),files:[{index:1,mime:'audio/mpeg',bytes:body.length}]});
 class TestURL extends URL{static createObjectURL(){return 'blob:fixture';}static revokeObjectURL(){}}
 const context={URL:TestURL,URLSearchParams,location:{href:'https://example.com/result.html?id=11111111-1111-4111-8111-111111111111#token='+ 'a'.repeat(43)},
 document:{querySelector:s=>s.startsWith('meta[')?null:el(s),createElement:()=>new Element(),body:new Element(),addEventListener(){}},window:{addEventListener(){}},
 buildResultView,resultApiUrl:path=>path,setupResultPlayer:()=>({reset(){},setStatus(){},toggle:async()=>{}}),updateResultStatus(){},AbortController,AbortSignal,
 setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},
 fetch:async path=>{
  if(path.startsWith('/api/download')){downloads++;phase='consumed';return new Response(body,{headers:{'Content-Type':'audio/mpeg','Content-Length':String(body.length)}});}
  if(path.startsWith('/api/restore')){restores++;phase='processing';return Response.json(state(),{status:202});}
  return Response.json(state(),{status:phase==='available'?200:phase==='processing'?409:410});
 }};
 vm.runInNewContext(source,context);
 const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};await flush();
 assert.equal(el('#result-download').disabled,false);
 await el('#result-download').handlers.click();await flush();
 assert.match(el('#download-message').textContent,/사용 완료/);assert.equal(el('#result-restore').disabled,false);
 await el('#result-restore').handlers.click();await flush();
 assert.equal(el('#download-message').textContent,'');assert.match(el('#restore-message').textContent,/준비하고/);
 phase='available';version=1;
 const poll=[...timers.entries()].find(([,v])=>v.ms===3000);assert.ok(poll);timers.delete(poll[0]);await poll[1].fn();await flush();
 assert.equal(el('#download-message').textContent,'');assert.match(el('#restore-message').textContent,/다시 준비되었습니다/);assert.doesNotMatch(el('#restore-message').textContent,/준비하고 있습니다|사용 완료/);
 assert.equal(el('#result-download').hidden,false);assert.equal(el('#result-download').disabled,false);assert.equal(downloads,1);assert.equal(restores,1);
});
