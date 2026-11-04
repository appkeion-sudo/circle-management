import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

async function environment() {
  const timers=new Map(),listeners={}; let timerId=0;
  const context=vm.createContext({structuredClone,
    setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},
    window:{addEventListener(name,fn){listeners[name]=fn;}}
  });
  vm.runInContext(await readFile(new URL('../autosave.js',import.meta.url),'utf8'),context);
  return {save:vm.runInContext('CircleSave',context),timers,listeners};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('rapid edits serialize per cell and only the newest value follows an in-flight write',async()=>{
  const {save}=await environment(),first=deferred(),writes=[];
  const write=value=>{writes.push(value);return writes.length===1?first.promise:Promise.resolve();};
  save.put('schedule:one',true,write);save.put('schedule:one',false,write);save.put('schedule:one',true,write);
  assert.deepEqual(writes,[true]);assert.equal(save.pending('schedule:'),true);
  first.resolve();await tick();assert.deepEqual(writes,[true,true]);assert.equal(save.pending(),false);
});
test('a newer edit is immediately written even when the older in-flight write fails',async()=>{
  const {save,timers}=await environment(),first=deferred(),writes=[];
  const write=value=>{writes.push(value);return writes.length===1?first.promise:Promise.resolve();};
  save.put('cell',false,write);save.put('cell',true,write);first.reject(Error('offline'));
  await tick();assert.deepEqual(writes,[false,true]);assert.equal(save.pending(),false);assert.equal(timers.size,0);
});
test('failed writes retain data, retry automatically with a limit, and offer manual recovery',async()=>{
  const {save,timers,listeners}=await environment(),statuses=[];let online=false,writes=0;
  const write=async value=>{writes++;assert.equal(value,7);if(!online)throw Error('offline');};
  save.put('score:one',7,write,status=>statuses.push(status));await tick();
  for(let i=0;i<3;i++){const [id,fn]=timers.entries().next().value;timers.delete(id);fn();await tick();}
  assert.equal(writes,4);assert.equal(timers.size,0);assert.equal(save.pending('score:'),true);
  assert.equal(statuses.at(-1),'保存失敗／再試行中');
  const event={preventDefault(){this.prevented=true;}};listeners.beforeunload(event);assert.equal(event.prevented,true);
  online=true;save.retry('score:');await tick();assert.equal(save.pending(),false);assert.equal(statuses.at(-1),'保存済み');
});
test('logout cancels queued retries, and a late failure cannot schedule another write',async()=>{
  const {save,timers}=await environment(),first=deferred();let writes=0;
  save.put('cell',1,()=>{writes++;return first.promise;});save.put('cell',2,()=>{writes++;});
  save.clear();first.reject(Error('late response'));await tick();
  assert.equal(writes,1);assert.equal(timers.size,0);assert.equal(save.pending(),false);
});
test('online recovery retries the latest data and independent cells can save concurrently',async()=>{
  const {save,listeners}=await environment();let online=false;const values=[];
  save.put('a',1,async value=>{if(!online)throw Error('offline');values.push(value);});
  save.put('b',2,async value=>values.push(value));await tick();assert.deepEqual(values,[2]);
  online=true;listeners.online();await tick();assert.deepEqual(values,[2,1]);assert.equal(save.pending(),false);
});
