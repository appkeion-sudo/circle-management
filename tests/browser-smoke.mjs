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
window.mock={offline:false,writes:[],user:{id:'00000000-0000-0000-0000-000000000001',email:'member@example.test'},listeners:[],best:0,gameWrites:[],rankFails:false,gameFails:false};
const bandUsers=[{id:mock.user.id,username:'テストメンバー'},{id:'a',username:'Alpha'},{id:'b',username:'Beta'}];
const bands=[{id:'band1',name:'検証バンド'},{id:'band2',name:'別のバンド'}];
mock.memberships={band1:[mock.user.id],band2:[mock.user.id,'a','b']};
mock.bandWrites=[];
window.supabase={createClient:()=>({auth:{
 getUser:async()=>({data:{user:mock.user}}),onAuthStateChange:fn=>{mock.listeners.push(fn);},
 getSession:async()=>({data:{session:{access_token:'mock-token'}}}),
 signOut:async()=>{mock.user=null;mock.listeners.forEach(fn=>fn('SIGNED_OUT'));return {};}
},rpc:async(name,args)=>{
 if(name==='takoika_ranking')return mock.rankFails?{error:{message:'取得失敗'}}:{data:mock.best?[{user_id:mock.user.id,username:'テストメンバー',best_score:mock.best,rank:1}]:[]};
 if(name==='takoika_save_best'){mock.gameWrites.push(args);if(mock.gameFails)return {error:{message:'保存失敗'}};mock.best=Math.max(mock.best,args.p_score);return {data:mock.best};}
 if(name==='profile_context')return {data:{profile:{username:'テストメンバー'},is_president:true,is_site_admin:true}};
 if(['circle_members_admin','circle_roles_list','pending_year_requests'].includes(name))return {data:[]};
 if(name==='ui_dashboard')return {data:{events:[{title:'秋のOD',event_date:'2099-11-04',entry_deadline:'2099-11-01T10:00:00Z'}],notices:[{id:'notice',title:'お知らせ',body:'本文',created_at:'2026-11-04T00:00:00Z'}],can_post:true,unread:1}};
 if(name==='od_timetable_inbox')return {data:[]};
 if(name==='ui_notifications')return {data:[{id:'n',title:'受付開始',body:'エントリーできます',read_at:null}]};
 if(name==='ui_notifications_read')return {data:null};
 if(name==='ui_schedule_save'){mock.writes.push(args);return mock.offline?{error:{message:'通信失敗'}}:{data:null};}
 if(name==='list_circle_users')return {data:bandUsers};
 if(name==='get_band_schedules')return {data:mock.memberships[args.p_band_id].map(user_id=>({user_id,schedule_date:args.p_start_date,slot:1,available:true}))};
 if(name==='change_band_members'){
  mock.bandWrites.push(args);
  if(mock.bandFails)return {error:{message:'通信失敗'}};
  const {p_band_id:id,p_member_ids:ids,p_action:action}=args;
  mock.memberships[id]=action==='add'?[...mock.memberships[id],...ids]:mock.memberships[id].filter(user=>!ids.includes(user));
  return {data:ids.length};
 }
 return {error:{message:'Unexpected RPC '+name}};
},from:table=>{const filters={};const builder={
 select(){return this;},eq(key,value){filters[key]=value;return this;},
 in(key,values){filters[key]=values;return this;},order(){return this;},gte(){return this;},lte(){return this;},
 then(fn){
  let data=[];
  if(table==='bands')data=bands.filter(band=>filters.id.includes(band.id));
  if(table==='band_members'){
   data=filters.band_id?mock.memberships[filters.band_id].map(user_id=>({user_id}))
    :bands.filter(band=>mock.memberships[band.id].includes(filters.user_id)).map(band=>({band_id:band.id}));
  }
  return Promise.resolve({data}).then(fn);
 }
};return builder;}})};
`;
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/__mock.js'){res.setHeader('Content-Type','application/javascript');res.end(mock);return;}
  const path=resolve(root,req.url==='/'?'index.html':'.'+decodeURIComponent(req.url.split('?')[0]));
  const allowed=['index.html','style.css','app.js','autosave.js','ui.js','takoika.js','assets/takoika/pot.png','assets/takoika/octopus.png','assets/takoika/squid.png','schedule.js','band.js','profile.js','profile-roles.js','audition.js','timetable-core.js','timetable-export.js','timetable.js'];
  if(!allowed.some(f=>path===resolve(root,f))){res.writeHead(404);res.end();return;}
  let body=await readFile(path);
  if(extname(path)==='.html')body=body.toString().replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2','/__mock.js');
  res.setHeader('Content-Type',({'.png':'image/png','.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[extname(path)]);res.end(body);
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
  await evaluate(`document.querySelector('#sidebar button').click();document.getElementById('open-schedule-button').click()`);
  assert.equal(await evaluate(`document.getElementById('schedule-results').hidden`),false,'returning keeps unsaved cells visible');
  await evaluate(`mock.offline=false;CircleSave.retry('schedule:')`);
  await waitFor(`!CircleSave.pending()`);
  await evaluate(`document.querySelector('#schedule-table .slot-button').click();document.querySelector('#schedule-table .slot-button').click()`);
  await waitFor(`!CircleSave.pending()`);
  assert.equal(await evaluate(`mock.writes.at(-1).p_available`),true);
  const screenshot=await command('Page.captureScreenshot',{format:'png'});
  await writeFile(resolve(artifacts,`schedule-${width}.png`),Buffer.from(screenshot.data,'base64'));
  await evaluate(`document.getElementById('open-band-button').click()`);
  await waitFor(`document.querySelectorAll('#band-list button').length===2`);
  await evaluate(`window.bandButton=text=>Array.from(document.querySelectorAll('.band-member-dialog[open] button')).find(b=>b.textContent===text);
   window.bandInput=value=>Array.from(document.querySelectorAll('.band-member-dialog[open] input')).find(i=>i.value===value);
   window.bandSearch=value=>{const input=document.querySelector('.band-member-dialog[open] input[type=search]');input.value=value;input.dispatchEvent(new Event('input'));};
   document.getElementById('open-add-band-members').click()`);
  await waitFor(`bandButton('検証バンド')`);
  await evaluate(`bandButton('検証バンド').click()`);
  await waitFor(`bandInput('a')&&bandInput('b')`);
  assert.equal(await evaluate(`bandButton('決定').disabled && !bandInput(mock.user.id)`),true);
  assert.equal(await evaluate(`document.querySelector('.band-member-dialog[open]').getBoundingClientRect().right<=innerWidth`),true);
  await evaluate(`bandInput('a').click();bandButton('← バンド選択に戻る').click();bandButton('別のバンド').click()`);
  await waitFor(`document.querySelector('.band-member-dialog[open] [role=status]').textContent.includes('追加できるメンバーはいません')`);
  await evaluate(`bandButton('← バンド選択に戻る').click();bandButton('検証バンド').click()`);
  await waitFor(`bandInput('a')`);
  assert.equal(await evaluate(`bandButton('決定').disabled`),true,'changing bands resets the selection');
  await evaluate(`bandInput('a').click();bandSearch('beta');bandInput('b').click();bandButton('決定').click();bandButton('決定').click()`);
  await waitFor(`document.getElementById('band-list-message').textContent.includes('2人追加')`);
  assert.equal(await evaluate(`mock.bandWrites.length`),1,'batch adds are submitted once');
  await evaluate(`document.querySelector('#band-list button').click()`);
  await waitFor(`!document.getElementById('band-schedule-results').hidden`);
  assert.equal(await evaluate(`document.querySelectorAll('#detail-member-list input').length`),3);
  await evaluate(`document.getElementById('detail-back-band').click();document.getElementById('open-remove-band-members').click()`);
  await waitFor(`bandButton('検証バンド')`);
  await evaluate(`bandButton('検証バンド').click()`);
  await waitFor(`bandInput('a')&&bandInput('b')`);
  assert.equal(await evaluate(`!bandInput(mock.user.id)`),true);
  await evaluate(`bandInput('a').click();bandInput('b').click()`);
  assert.equal(await evaluate(`bandButton('決定').disabled`),false);
  await evaluate(`bandButton('決定').click()`);
  await waitFor(`document.querySelector('.band-member-dialog[open] h2').textContent==='メンバー削除の確認'`);
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.band-member-dialog[open] li'),li=>li.textContent)`),['Alpha','Beta']);
  assert.equal(await evaluate(`document.querySelector('.band-member-dialog[open] h3').textContent`),'検証バンド');
  await evaluate(`bandButton('キャンセル').click()`);
  assert.equal(await evaluate(`mock.bandWrites.length`),1,'cancelled confirmation does not remove members');
  await evaluate(`mock.bandFails=true;bandButton('決定').click();bandButton('削除').click()`);
  await waitFor(`document.querySelector('.band-member-dialog[open] [role=status]').textContent.includes('通信失敗')`);
  await evaluate(`mock.bandFails=false;bandButton('削除').click()`);
  await waitFor(`document.getElementById('band-list-message').textContent.includes('2人削除')`);
  await waitFor(`document.querySelector('#band-list button')`);
  await evaluate(`document.querySelector('#band-list button').click()`);
  await waitFor(`!document.getElementById('band-schedule-results').hidden`);
  assert.equal(await evaluate(`document.querySelectorAll('#detail-member-list input').length`),1);
  await evaluate(`Array.from(document.querySelectorAll('#sidebar button')).find(b=>b.textContent.includes('設定')).click()`);
  await evaluate(`Array.from(document.querySelectorAll('dialog[open] button')).find(b=>b.textContent==='メンバー・役職管理').click()`);
  assert.equal(await evaluate(`!document.getElementById('admin-section').hidden && !document.querySelector('dialog[open]')`),true,'member management opens and closes settings');
  // Game: actual settings entry, real sprites, locked input, saved best and retries.
  await evaluate(`Array.from(document.querySelectorAll('#sidebar button')).find(b=>b.textContent.includes('設定')).click()`);
  await waitFor(`document.querySelector('dialog[open]')`);
  assert.equal(await evaluate(`Array.from(document.querySelector('dialog[open] div').children).slice(-2).map(b=>b.textContent).join(',')`),'ログアウト,タコイカゲーム');
  await evaluate(`document.querySelector('dialog[open] div').lastChild.click()`);
  await waitFor(`document.getElementById('takoika-ranking-status').textContent.includes('まだ記録')`);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true,`game fits at ${width}`);
  await waitFor(`Array.from(document.querySelectorAll('#takoika-pots img')).every(i=>i.complete&&i.naturalWidth>0)`);
  await evaluate(`window.originalRandom=Math.random;Math.random=()=>0.5;document.querySelector('#takoika-pots button').click()`);
  await waitFor(`!document.getElementById('takoika-result').hidden&&!document.getElementById('takoika-again').disabled`);
  assert.equal(await evaluate(`document.getElementById('takoika-rank').textContent`),'未ランクイン','first zero is unranked');
  assert.equal(await evaluate(`mock.gameWrites.length`),0,'zero does not write');
  await evaluate(`document.getElementById('takoika-again').click()`);
  await evaluate(`Math.random=()=>0.1;document.querySelector('#takoika-pots button').click();document.querySelector('#takoika-pots button').click()`);
  await waitFor(`!document.querySelector('#takoika-pots button').disabled`);
  assert.equal(await evaluate(`document.getElementById('takoika-score').textContent`),'1','double tap counts once');
  assert.equal(await evaluate(`mock.gameWrites.length`),0,'ongoing scores are never saved');
  await evaluate(`mock.gameFails=true;Math.random=()=>0.9;document.querySelectorAll('#takoika-pots button')[1].click()`);
  await waitFor(`!document.getElementById('takoika-save-retry').hidden`);
  assert.equal(await evaluate(`document.getElementById('takoika-final').textContent`),'1匹');
  await evaluate(`mock.gameFails=false;document.getElementById('takoika-save-retry').click()`);
  await waitFor(`document.getElementById('takoika-save-status').textContent.includes('保存しました')`);
  assert.equal(await evaluate(`document.getElementById('takoika-rank').textContent`),'1位');
  assert.equal(await evaluate(`document.querySelectorAll('#takoika-ranking-list .is-me').length`),1);
  const gameScreenshot=await command('Page.captureScreenshot',{format:'png'});
  await writeFile(resolve(artifacts,`game-${width}.png`),Buffer.from(gameScreenshot.data,'base64'));
  await evaluate(`document.getElementById('takoika-again').click();window.writesBefore=mock.gameWrites.length;document.querySelector('#takoika-pots button').click()`);
  await waitFor(`!document.getElementById('takoika-result').hidden&&!document.getElementById('takoika-again').disabled`);
  assert.equal(await evaluate(`mock.gameWrites.length===writesBefore`),true,'lower score does not write');
  await evaluate(`document.getElementById('takoika-again').click();Math.random=()=>0.1;document.querySelector('#takoika-pots button').click()`);
  await waitFor(`!document.querySelector('#takoika-pots button').disabled`);
  await evaluate(`Math.random=()=>0.9;document.querySelector('#takoika-pots button').click()`);
  await waitFor(`!document.getElementById('takoika-result').hidden&&!document.getElementById('takoika-again').disabled`);
  assert.equal(await evaluate(`mock.gameWrites.length===writesBefore`),true,'tied score does not write');
  await evaluate(`document.getElementById('takoika-again').click();Math.random=()=>0.1;document.querySelector('#takoika-pots button').click();document.getElementById('takoika-back').click();showPage('takoika-section')`);
  await waitFor(`!document.querySelector('#takoika-pots button').disabled`);
  assert.equal(await evaluate(`document.getElementById('takoika-score').textContent`),'0','leaving discards in-progress game');
  await evaluate(`mock.rankFails=true;document.getElementById('takoika-refresh').click()`);
  await waitFor(`document.getElementById('takoika-ranking-status').textContent.includes('取得できません')`);
  await evaluate(`mock.rankFails=false;document.getElementById('takoika-refresh').click()`);
  await waitFor(`document.getElementById('takoika-ranking-status').textContent.includes('ランクイン')`);
  await evaluate(`Math.random=originalRandom;document.getElementById('takoika-back').click()`);
  await evaluate(`document.getElementById('notification-bell').click()`);
  await waitFor(`document.querySelector('dialog[open]')`);
  await evaluate(`document.getElementById('logout-button').click()`);
  await waitFor(`document.getElementById('app-header').hidden`);
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open]').length`),0,'logout closes private dialogs');
  console.log(`PASS browser ${width}px: navigation, dashboard, schedule, band membership, takoika, logout`);
 }
 assert.deepEqual(errors,[],'no browser runtime errors');
 await send('Browser.close');
}finally{
 socket?.close();browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
