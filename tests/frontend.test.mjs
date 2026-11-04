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
test('score forms restore saved scores and comments instead of submitting blanks',async()=>{
  const calls=[];
  const env=environment({auth:{onAuthStateChange(){}},
    rpc:async(name,args)=>{
      calls.push(name);
      if(name==='is_circle_president')return {data:false};
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
