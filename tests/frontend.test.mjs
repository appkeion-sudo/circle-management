import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

class Element {
  constructor(tag='div') {
    this.tagName=tag;this.children=[];this.listeners={};this.value='';this.hidden=false;
    this.disabled=false;this.dataset={};this.style={};this.classList={toggle(){}};
  }
  addEventListener(event,handler){(this.listeners[event]??=[]).push(handler);}
  append(...children){this.children.push(...children);}
  appendChild(child){this.append(child);return child;}
  after(element){this.nextSibling=element;}
  replaceChildren(...children){this.children=[...children];}
  querySelectorAll(selector){
    const descendants=this.children.flatMap(child=>child instanceof Element?[child,...child.querySelectorAll('*')]:[]);
    return selector==='*'?descendants:selector==='input'?descendants.filter(c=>c.tagName==='input'):[];
  }
  setAttribute(){}
  reset(){}
  async emit(event,data={}){for(const handler of this.listeners[event]??[])await handler({preventDefault(){},target:this,...data});}
}
function environment(db) {
  const elements=new Map(),created=[];
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const context=vm.createContext({
    db,document:{getElementById:get,createElement(tag){const e=new Element(tag);created.push(e);return e;},
      createTextNode:text=>text},
    showPage:id=>{for(const [name,e] of elements)if(name.endsWith('-section'))e.hidden=name!==id;},
    console:{warn(){},error(){}},URL:{createObjectURL:()=> 'blob:preview',revokeObjectURL(){}},
    crypto:{randomUUID:()=> 'test-file'},alert(){},confirm:()=>true,
    currentAuthUser:{id:'user'},window:{innerWidth:1024}
  });
  return {get,created,context,run:async file=>vm.runInContext(await readFile(new URL('../'+file,import.meta.url),'utf8'),context)};
}
function bandEnvironment({rpcFails=false,lookupFound=false,lookupFails=false}={}) {
  const removed=[],publicPaths=[];
  const band={id:'band',name:'バンド',icon_path:'user/icon.png'};
  const db={
    auth:{getUser:async()=>({data:{user:{id:'user'}}}),onAuthStateChange(){}},
    rpc:async()=>rpcFails?{error:new Error('作成失敗')}:{data:'band'},
    storage:{from:()=>({
      getPublicUrl:path=>{publicPaths.push(path);return {data:{publicUrl:'https://images.example/'+path}};},
      createSignedUrl:()=>{throw Error('署名URLを使ってはいけません');},
      upload:async()=>({data:{path:'user/new.png'}}),
      remove:async paths=>{removed.push(...paths);return {};}
    })},
    from(table){
      let columns;
      const builder={
        select(value){columns=value;return this;},eq(){return this;},in(){return this;},order(){return this;},limit(){return this;},
        then(resolve,reject){
          let result;
          if(table==='band_members')result={data:[{band_id:band.id}]};
          else if(table==='bands' && columns==='id')result=lookupFails?{error:new Error('確認失敗')}:{data:lookupFound?[{id:band.id}]:[]};
          else result={data:[band]};
          return Promise.resolve(result).then(resolve,reject);
        }
      };
      return builder;
    }
  };
  return {...environment(db),removed,publicPaths};
}
async function submitBand(env){
  await env.run('band.js');
  env.get('band-name').value='新バンド';
  await env.get('band-icon').emit('change',{target:{files:[{type:'image/png',size:100}]}});
  await env.get('create-band-form').emit('submit');
}

test('band icons use the existing public bucket without signed-read permission',async()=>{
  const env=bandEnvironment();await env.run('band.js');
  await env.get('open-band-button').emit('click');
  assert.deepEqual(env.publicPaths,['user/icon.png']);
  assert.equal(env.get('band-list').children[0].children[0].src,'https://images.example/user/icon.png');
});
test('failed band creation removes the uploaded icon after checking database references',async()=>{
  const env=bandEnvironment({rpcFails:true});await submitBand(env);
  assert.deepEqual(env.removed,['user/new.png']);
  assert.match(env.get('create-band-message').textContent,/作成失敗/);
});
test('lost RPC response never deletes an icon already referenced by a created band',async()=>{
  const env=bandEnvironment({rpcFails:true,lookupFound:true});await submitBand(env);
  assert.deepEqual(env.removed,[]);
  assert.equal(env.get('band-section').hidden,false);
});
test('failed reference lookup keeps the icon and reports the cleanup failure',async()=>{
  const env=bandEnvironment({rpcFails:true,lookupFails:true});await submitBand(env);
  assert.deepEqual(env.removed,[]);
  assert.match(env.get('create-band-message').textContent,/後片付けを確認できません/);
});
test('successful band creation keeps the uploaded icon',async()=>{
  const env=bandEnvironment();await submitBand(env);
  assert.deepEqual(env.removed,[]);
  assert.equal(env.get('band-section').hidden,false);
});
test('roles reuse the HTML container and discard responses arriving after logout',async()=>{
  let logout,finish;
  const env=environment({auth:{onAuthStateChange:handler=>{logout=handler;}},
    rpc:()=>new Promise(resolve=>{finish=resolve;})});
  const container=env.get('profile-roles');
  await env.run('profile-roles.js');
  assert.equal(env.created.length,0);
  const request=env.get('open-profile-button').emit('click');
  logout('SIGNED_OUT');finish({data:[{name:'会計'}]});await request;
  assert.equal(container.children.length,0);
});
test('schedule delete-all follows retry, requires saved changes and confirmation, and retains cells on failure',async()=>{
  let pending=false,accepted=false,fail=true,calls=0,finish;
  const env=environment({
    auth:{getUser:async()=>({data:{user:{id:'user'}}}),onAuthStateChange(){}},
    rpc:async name=>{
      assert.equal(name,'ui_schedule_delete_all');calls++;
      if(fail)return {error:new Error('通信失敗')};
      await new Promise(resolve=>{finish=resolve;});return {};
    },
    from(){return {select(){return this;},eq(){return this;},gte(){return this;},
      lte:async()=>({data:[{schedule_date:'2026-11-06',slot:1,available:true}]})};}
  });
  env.context.CircleSave={pending:()=>pending,retry(){}};
  env.context.confirm=()=>accepted;
  const head=new Element('thead'),body=new Element('tbody'),table=env.get('schedule-table');
  table.append(head,body);table.querySelector=selector=>selector==='thead'?head:body;
  await env.run('schedule.js');
  const retry=env.get('schedule-message').nextSibling,button=retry.nextSibling;
  assert.equal(retry.textContent,'再保存');
  assert.equal(button.textContent,'入力した日程をすべて削除');
  env.get('start-date').value='2026-11-06';env.get('end-date').value='2026-11-06';
  await env.get('date-range-form').emit('submit');
  const cell=()=>body.querySelectorAll('*').find(e=>e.tagName==='button');
  assert.equal(cell().textContent,'○');
  pending=true;accepted=true;await button.emit('click');assert.equal(calls,0);
  pending=false;accepted=false;await button.emit('click');assert.equal(calls,0);
  accepted=true;await button.emit('click');assert.equal(calls,1);
  assert.match(env.get('schedule-message').textContent,/通信失敗/);
  assert.equal(cell().textContent,'○');assert.equal(button.disabled,false);
  fail=false;const deletion=button.emit('click');
  while(!finish)await Promise.resolve();
  assert.equal(button.disabled,true);assert.equal(retry.disabled,true);
  await button.emit('click');assert.equal(calls,2);
  finish();await deletion;
  assert.ok(body.querySelectorAll('*').filter(e=>e.tagName==='button').every(e=>e.textContent==='ー'));
  assert.match(env.get('schedule-message').textContent,/すべて削除しました/);
  assert.equal(button.disabled,false);assert.equal(retry.disabled,false);
});

test('presidents and site administrators can delete auditions with confirmation',async()=>{
  for(const role of ['member','president','admin']){
    const president=role==='president',canDelete=role!=='member';
    const calls=[],alerts=[],confirmations=[];
    let accepted=false,fail=false,deleted=false;
    const audition={id:'audition',title:'秋の審査',status:'draft',created_at:'2026-11-06'};
    const env=environment({auth:{onAuthStateChange(){}},
      rpc:async(name,args)=>{
        if(name==='is_circle_president')return {data:president};
        if(name==='audition_can_delete')return {data:canDelete};
        if(name==='audition_delete'){
          calls.push(args);
          if(fail)return {error:new Error('削除できません')};
          deleted=true;return {data:null};
        }
        throw Error('Unexpected RPC '+name);
      },
      from(){return {select:async()=>({data:deleted?[]:[audition]})};}
    });
    env.context.confirm=message=>{confirmations.push(message);return accepted;};
    env.context.alert=message=>alerts.push(message);
    await env.run('audition.js');
    await env.get('open-audition-button').emit('click');
    const deleteButton=env.get('audition-list').querySelectorAll('*').find(e=>e.tagName==='button'&&e.textContent==='削除');
    assert.equal(!!deleteButton,canDelete);
    if(!canDelete)continue;
    await deleteButton.emit('click');
    assert.equal(calls.length,0);
    assert.match(confirmations[0],/秋の審査/);
    accepted=true;fail=true;
    await deleteButton.emit('click');
    assert.deepEqual(alerts,['削除できません']);
    assert.equal(deleteButton.disabled,false);
    assert.equal(env.get('audition-list').children.length,1);
    fail=false;
    await deleteButton.emit('click');
    assert.equal(calls.at(-1).p_audition_id,'audition');
    assert.equal(env.get('audition-list').children.length,0);
    assert.equal(env.get('audition-message').textContent,'オーディションはありません。');
  }
});

test('score forms restore saved scores and comments instead of submitting blanks',async()=>{
  const calls=[];
  const env=environment({auth:{onAuthStateChange(){}},
    rpc:async(name,args)=>{
      calls.push(name);
      if(name==='is_circle_president')return {data:false};
      if(name==='audition_can_delete')return {data:false};
      if(name==='audition_entries_view')return {data:[{id:'entry',band_id:'band',band_name:'他バンド',is_freshman_band:false,can_score:true}]};
      if(name==='audition_my_review')return {data:{scores:{criterion:7},comment:'保存済み感想'}};
      throw Error('Unexpected RPC '+name);
    },
    from(table){const builder={select(){return this;},eq(){return this;},order:async()=>({data:[{id:'criterion',name:'演奏',max_score:10}]}),
      single:async()=>({data:{id:'audition',title:'審査',status:'scoring',general_slots:1,freshman_slots:1}})};return builder;}
  });
  await env.run('audition.js');
  // The detailed screen is normally reached through its list button.
  // Use the existing back control to open the current detail, then click its real score button.
  await env.get('audition-score-back').emit('click');
  const root=env.get('audition-detail');
  const scoreButton=root.querySelectorAll('*').find(e=>e.tagName==='button' && e.textContent==='採点・感想を入力');
  assert.ok(scoreButton);await scoreButton.emit('click');
  assert.equal(env.get('audition-score-title').textContent,'他バンド');
  assert.equal(env.get('audition-score-fields').querySelectorAll('input')[0].value,7);
  assert.equal(env.get('audition-score-comment').value,'保存済み感想');
  assert.equal(env.get('audition-score-submit').disabled,false);
  assert.ok(calls.includes('audition_my_review'));
});
