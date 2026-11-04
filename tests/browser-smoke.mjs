// Optional real-browser checks. All Supabase traffic is replaced by an in-memory fake.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const executable=process.env.KEION_BROWSER || [
 'C:/Program Files/Google/Chrome/Application/chrome.exe',
 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(existsSync);
assert.ok(executable,'Set KEION_BROWSER to a Chrome/Edge executable.');
const artifacts=resolve(root,'.tmp/browser-smoke');await mkdir(artifacts,{recursive:true});
const mock=`
window.mock={offline:false,writes:[],user:{id:'00000000-0000-0000-0000-000000000001',email:'member@example.test'},listeners:[]};
window.supabase={createClient:()=>({auth:{
 getUser:async()=>({data:{user:mock.user}}),onAuthStateChange:fn=>{mock.listeners.push(fn);},
 signOut:async()=>{mock.user=null;mock.listeners.forEach(fn=>fn('SIGNED_OUT'));return {};}
},rpc:async(name,args)=>{
 if(name==='profile_context')return {data:{profile:{username:'テストメンバー'},is_president:true,is_site_admin:false}};
 if(name==='ui_dashboard')return {data:{events:[{title:'秋のOD',event_date:'2099-11-04',entry_deadline:'2099-11-01T10:00:00Z'}],notices:[{id:'notice',title:'お知らせ',body:'本文',created_at:'2026-11-04T00:00:00Z'}],can_post:true,unread:1}};
 if(name==='od_timetable_inbox')return {data:[]};
 if(name==='ui_notifications')return {data:[{id:'n',title:'受付開始',body:'エントリーできます',read_at:null}]};
 if(name==='ui_notifications_read')return {data:null};
 if(name==='ui_schedule_save'){mock.writes.push(args);return mock.offline?{error:{message:'通信失敗'}}:{data:null};}
 return {error:{message:'Unexpected RPC '+name}};
},from:()=>{const builder={select(){return this;},eq(){return this;},gte(){return this;},lte(){return this;},then(fn){return Promise.resolve({data:[]}).then(fn);}};return builder;}})};
`;
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/__mock.js'){res.setHeader('Content-Type','application/javascript');res.end(mock);return;}
  const path=resolve(root,req.url==='/'?'index.html':'.'+decodeURIComponent(req.url.split('?')[0]));
  const allowed=['index.html','style.css','app.js','autosave.js','ui.js','schedule.js','band.js','profile.js','profile-roles.js','audition.js','timetable-core.js','timetable-export.js','timetable.js'];
  if(!allowed.some(f=>path===resolve(root,f))){res.writeHead(404);res.end();return;}
  let body=await readFile(path);
  if(extname(path)==='.html')body=body.toString().replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2','/__mock.js');
  res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[extname(path)]);res.end(body);
 }catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu','--remote-debugging-port=0',`--user-data-dir=${resolve(artifacts,'profile')}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let socket;
try{
 const endpoint=await new Promise((resolve,reject)=>{
  let output='';const timer=setTimeout(()=>reject(Error('Browser startup timed out')),15000);
  browser.stderr.on('data',chunk=>{output+=chunk;const match=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
  browser.on('error',e=>{clearTimeout(timer);reject(e);});browser.on('exit',code=>{clearTimeout(timer);reject(Error('Browser exited: '+code));});
 });
 socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('DevTools connection timed out')),10000);socket.onopen=()=>{clearTimeout(timer);resolve();};socket.onerror=e=>{clearTimeout(timer);reject(Error('DevTools connection failed: '+e.message));};});
 let nextId=0;const pending=new Map(),errors=[];
 socket.onmessage=({data})=>{const message=JSON.parse(data);if(message.id){const task=pending.get(message.id);pending.delete(message.id);if(message.error)task.reject(Error(message.error.message));else task.resolve(message.result);}if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text+': '+message.params.exceptionDetails.exception?.description);};
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);reject(Error('DevTools timed out: '+method));},15000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id,method,params,sessionId}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});
 const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const command=(method,params)=>send(method,params,sessionId);
 const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
 const waitFor=expression=>evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;function check(){if(${expression})return resolve(true);if(Date.now()>end)return reject(Error('Timed out: '+${JSON.stringify(expression)}));setTimeout(check,20);}check();})`);
 await command('Runtime.enable');await command('Page.enable');
 for(const width of [1280,375,320]){
  await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<760});
  await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
  try { await waitFor(`document.getElementById('dashboard-next')?.textContent.includes('秋のOD')`); }
  catch(error){console.error(JSON.stringify({errors,page:await evaluate('document.body.innerText')},null,2));throw error;}
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true,`page fits at ${width}`);
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('sidebar-toggle')).display!=='none'`),width<760);
  if(width<760){
   await evaluate(`document.getElementById('sidebar-toggle').click()`);
   assert.equal(await evaluate(`document.getElementById('sidebar-toggle').getAttribute('aria-expanded')`),'true');
   await evaluate(`document.getElementById('sidebar-backdrop').click()`);
   assert.equal(await evaluate(`document.getElementById('sidebar-toggle').getAttribute('aria-expanded')`),'false');
  }
  await evaluate(`document.getElementById('open-schedule-button').click()`);
  await waitFor(`document.querySelectorAll('#schedule-table tbody .slot-button').length===56`);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth && document.getElementById('schedule-table').getBoundingClientRect().right<=innerWidth`),true,`eight slots fit at ${width}`);
  assert.equal(await evaluate(`document.getElementById('start-date').getBoundingClientRect().width>=110 && document.getElementById('end-date').getBoundingClientRect().width>=110`),true,`date inputs remain readable at ${width}`);
  await evaluate(`mock.offline=true;document.querySelector('#schedule-table .slot-button').click()`);
  await waitFor(`document.querySelector('#schedule-table .slot-button').dataset.saveState==='error'`);
  assert.equal(await evaluate(`document.querySelector('#schedule-table .slot-button').textContent`),'○');
  await evaluate(`document.getElementById('back-home-button').click();document.getElementById('open-schedule-button').click()`);
  assert.equal(await evaluate(`document.getElementById('schedule-results').hidden`),false,'returning keeps unsaved cells visible');
  await evaluate(`mock.offline=false;CircleSave.retry('schedule:')`);
  await waitFor(`!CircleSave.pending()`);
  await evaluate(`document.querySelector('#schedule-table .slot-button').click();document.querySelector('#schedule-table .slot-button').click()`);
  await waitFor(`!CircleSave.pending()`);
  assert.equal(await evaluate(`mock.writes.at(-1).p_available`),true);
  const screenshot=await command('Page.captureScreenshot',{format:'png'});
  await writeFile(resolve(artifacts,`schedule-${width}.png`),Buffer.from(screenshot.data,'base64'));
  await evaluate(`document.getElementById('notification-bell').click()`);
  await waitFor(`document.querySelector('dialog[open]')`);
  await evaluate(`document.getElementById('logout-button').click()`);
  await waitFor(`document.getElementById('app-header').hidden`);
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open]').length`),0,'logout closes private dialogs');
  console.log(`PASS browser ${width}px: navigation, dashboard, eight-slot layout, retry, rapid edits, logout`);
 }
 assert.deepEqual(errors,[],'no browser runtime errors');
 await send('Browser.close');
}finally{
 socket?.close();browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
