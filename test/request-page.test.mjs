import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../web/js/request-page.mjs',import.meta.url),'utf8');
class Element{
 constructor(){this.disabled=false;this.hidden=true;this.value='테스트 사연';this.textContent='';this.handlers={};this.attrs=new Map();this.classes=new Set();this.classList={toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};}
 addEventListener(name,fn){this.handlers[name]=fn;}
 setAttribute(key,value){this.attrs.set(key,value);}
 removeAttribute(key){this.attrs.delete(key);}
}
function setup(fetchImpl){
 const elements=new Map(),steps=Array.from({length:4},()=>new Element()),timers=new Map();let sequence=0;
 const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 el('submit-request').disabled=true;
 el('request-form').querySelectorAll=selector=>selector==='select'?[]:[el('story'),el('submit-request')];
 const location=new URL('https://example.com/');
 const context={document:{getElementById:el,querySelectorAll:()=>steps,addEventListener(){},hidden:false},window:{addEventListener(){}},location,
  history:{replaceState(_,__,value){const next=new URL(value,location);location.href=next.href;}},fetch:fetchImpl,URL,URLSearchParams,crypto,AbortSignal,
  setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}};
 vm.runInNewContext(source,context);
 const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
 const run=async ms=>{const entry=[...timers.entries()].find(([,v])=>v.ms===ms);assert.ok(entry,`expected ${ms}ms timer`);timers.delete(entry[0]);await entry[1].fn();await flush();};
 return {el,steps,timers,run,flush,submit:()=>el('request-form').handlers.submit({preventDefault(){}})};
}
test('readiness failure recovers automatically without reloading or submitting a song',async()=>{
 let checks=0,posts=0;
 const page=setup(async(_,init)=>{if(init?.method==='POST')posts++;checks++;return checks===1?Response.json({error:'unavailable'},{status:503}):Response.json({enabled:true,workerReady:true});});
 await page.flush();assert.equal(page.el('submit-request').disabled,true);
 await page.run(5000);assert.equal(page.el('submit-request').disabled,false);assert.equal(posts,0);
});
test('only the current processing stage is marked active, and completion stops it',async()=>{
 let status='generating';
 const page=setup(async(path)=>Response.json(path.endsWith('/health')?{enabled:true,workerReady:true}:path.endsWith('/submit')?{status:'accepted'}:{status}));
 await page.flush();await page.submit();await page.flush();
 assert.deepEqual(page.steps.map(e=>e.classes.has('is-current')),[false,true,false,false]);assert.equal(page.steps[1].attrs.get('aria-current'),'step');
 status='saving';await page.run(3000);assert.deepEqual(page.steps.map(e=>e.classes.has('is-current')),[false,false,true,false]);
 status='completed';await page.run(3000);assert.equal(page.steps.some(e=>e.classes.has('is-current')),false);assert.equal(page.steps.every(e=>e.classes.has('is-complete')),true);
});
test('a delayed readiness response cannot unlock a submitted request or reset its active stage',async()=>{
 let healthChecks=0,release;
 const page=setup(async path=>{
  if(path.endsWith('/health')){healthChecks++;if(healthChecks===2)return new Promise(resolve=>release=()=>resolve(Response.json({enabled:true,workerReady:true})));return Response.json({enabled:true,workerReady:true});}
  return Response.json({status:path.endsWith('/submit')?'accepted':'generating'});
 });
 await page.flush();const pending=page.run(5000);await page.flush();await page.submit();release();await pending;
 assert.equal(page.el('submit-request').disabled,true);assert.equal(page.steps[1].classes.has('is-current'),true);
});

test('an open page recovers from missing password session without losing the story or auto-submitting',async()=>{
 let authenticated=false,posts=0;
 const page=setup(async(path,init)=>{
  if(path==='/api/session/login'){authenticated=true;return Response.json({status:'authenticated'});}
  if(init?.method==='POST')posts++;
  return authenticated?Response.json({enabled:true,workerReady:true}):Response.json({error:'unauthorized'},{status:401});
 });
 await page.flush();assert.equal(page.el('session-gate').hidden,false);assert.equal(page.el('submit-request').disabled,true);
 page.el('story').value='작성 중인 사연';page.el('session-password').value='test-password';
 await page.el('session-form').handlers.submit({preventDefault(){}});await page.flush();
 assert.equal(page.el('session-gate').hidden,true);assert.equal(page.el('submit-request').disabled,false);assert.equal(page.el('story').value,'작성 중인 사연');assert.equal(posts,0);assert.equal(page.el('session-password').value,'');
});
