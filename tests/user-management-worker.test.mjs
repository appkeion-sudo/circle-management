import assert from 'node:assert/strict';
import {test} from 'node:test';
import worker from '../worker.mjs';
const actor='00000000-0000-0000-0000-000000000001', target='00000000-0000-0000-0000-000000000002';
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'server-secret',ASSETS:{fetch:async()=>new Response('asset')}};
function request(path='',method='GET',body,origin='https://circle.example') {
 return new Request('https://circle.example/api/admin/users'+path,{method,headers:{Authorization:'Bearer verified-token',Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
}
test('Worker verifies Auth, binds actor server-side and confines privileged RPC calls',async t=>{
 const original=globalThis.fetch, info=console.info, error=console.error;
 const calls=[],logs=[];
 let identityStatus=200, rpcStatus=200, rpcData={users:[],total:0}, timeout=false;
 console.info=console.error=x=>logs.push(x);
 globalThis.fetch=async(url,options)=>{
  calls.push({url,options});
  if(timeout)throw new DOMException('network down','TimeoutError');
  if(url.endsWith('/auth/v1/user'))return Response.json(identityStatus===200?{id:actor}:{error:'bad token'},{status:identityStatus});
  return Response.json(rpcData,{status:rpcStatus});
 };
 try {
  await t.test('list authenticates before privileged access and forwards literal search',async()=>{
   const response=await worker.fetch(request('?q=%25%27%20OR%20true&offset=100'),env);
   assert.equal(response.status,200);assert.equal(calls.length,2);
   assert.equal(calls[0].options.headers.Authorization,'Bearer verified-token');
   assert.equal(calls[1].options.headers.apikey,'server-secret');
   assert.deepEqual(JSON.parse(calls[1].options.body),{p_actor:actor,p_search:"%' OR true",p_offset:100});
   assert.equal(response.headers.get('Cache-Control'),'no-store');
   assert.doesNotMatch(await response.text(),/server-secret/);
  });
  await t.test('no token, invalid token, cross origin, invalid ID and confirmation never call deletion RPC',async()=>{
   calls.length=0;
   assert.equal((await worker.fetch(new Request('https://circle.example/api/admin/users'),env)).status,401);
   assert.equal(calls.length,0);
   identityStatus=401;
   assert.equal((await worker.fetch(request(),env)).status,401);assert.equal(calls.length,1);
   identityStatus=200;calls.length=0;
   assert.equal((await worker.fetch(request('/'+target,'DELETE',{},'https://attacker.example'),env)).status,403);
   assert.equal(calls.length,0);
   assert.equal((await worker.fetch(request('/bad','DELETE',{}),env)).status,400);
   assert.equal(calls.length,1);
   calls.length=0;
   assert.equal((await worker.fetch(request('/'+target,'DELETE',{confirmation:'delete',operation_id:target}),env)).status,400);
   assert.equal(calls.length,1);
  });
  await t.test('only SQL-authorized site admins can delete; client-supplied actor is ignored',async()=>{
   calls.length=0;rpcStatus=400;rpcData={code:'KA403',message:'raw private error'};
   const body={confirmation:'削除',operation_id:target,p_actor:target};
   const rejected=await worker.fetch(request('/'+target,'DELETE',body),env);
   assert.equal(rejected.status,403);assert.doesNotMatch(await rejected.text(),/raw private error/);
   assert.equal(JSON.parse(calls[1].options.body).p_actor,actor);
   rpcStatus=200;rpcData={deleted:true,replayed:true};
   const accepted=await worker.fetch(request('/'+target,'DELETE',body),env);
   assert.equal(accepted.status,200);assert.equal((await accepted.json()).data.replayed,true);
   assert.ok(calls.at(-1).url.endsWith('/rpc/admin_user_delete'));
  });
  await t.test('network uncertainty is reported and no second destructive request is attempted',async()=>{
   calls.length=0;timeout=true;
   const response=await worker.fetch(request('/'+target,'DELETE',{confirmation:'削除',operation_id:target}),env);
   assert.equal(response.status,503);assert.equal(calls.length,1);
   assert.match((await response.json()).error,/状態を確認/);
   assert.doesNotMatch(logs.join('\n'),/verified-token|server-secret|raw private error/);
   timeout=false;
   assert.equal(await (await worker.fetch(new Request('https://circle.example/'),env)).text(),'asset');
  });
 } finally {globalThis.fetch=original;console.info=info;console.error=error;}
});
