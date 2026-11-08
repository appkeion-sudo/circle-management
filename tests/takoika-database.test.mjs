import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;

test('takoika migration: best-only writes, ranking privacy, RLS and account deletion',async t=>{
 const db=new PGlite();
 const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
 const scalar=async(sql,args=[])=>Object.values((await q(sql,args))[0])[0];
 const user=async n=>{await db.exec('RESET ROLE');await q("SELECT set_config('request.jwt.claim.sub',$1,false)",[n?id(n):'']);await db.exec('SET ROLE authenticated');};
 try{
  await db.exec(await read('tests/fixtures/supabase-platform.sql'));
  await db.exec('CREATE ROLE service_role; GRANT USAGE ON SCHEMA public TO service_role');
  // Exercise an existing deployment's old deletion guard as well as fresh setup.
  const oldSetup=(await read('setup.sql')).split('-- タコイカゲーム')[0]+'COMMIT;';
  await db.exec(oldSetup.replace("'public.takoika_bests.user_id',",''));
  await db.exec(await read('migrations/20261108_takoika.sql'));
  await db.exec(await read('migrations/20261108_takoika.sql'));
  for(let n=1;n<=5;n++) await q('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',[id(n),`u${n}@example.test`,JSON.stringify({username:'部員'+n})]);
  await t.test('zero creates no record; negative/null rejected; ties/lower scores preserve timestamps',async()=>{
   await user(1);
   assert.equal(await scalar('SELECT takoika_save_best(0)'),0);
   assert.deepEqual(await scalar('SELECT takoika_ranking()'),[]);
   await assert.rejects(q('SELECT takoika_save_best(-1)'),/スコア/);
   await assert.rejects(q('SELECT takoika_save_best(NULL)'),/スコア/);
   assert.equal(await scalar('SELECT takoika_save_best(3)'),3);
   const before=await q('SELECT * FROM takoika_bests');
   await q('SELECT takoika_save_best(3)');await q('SELECT takoika_save_best(1)');
   assert.deepEqual(await q('SELECT * FROM takoika_bests'),before);
   // Out-of-order submissions from multiple tabs may only raise the best.
   await Promise.all([q('SELECT takoika_save_best(12)'),q('SELECT takoika_save_best(4)')]);
   assert.equal(await scalar('SELECT best_score FROM takoika_bests'),12);
  });
  await t.test('competition ranking, live profile names and minimum profile fields',async()=>{
   for(const [n,score] of [[2,7],[3,7],[4,1]]){await user(n);await q('SELECT takoika_save_best($1)',[score]);}
   await user(5);
   let ranking=await scalar('SELECT takoika_ranking()');
   assert.deepEqual(ranking.map(r=>r.rank),[1,2,2,4]);
   assert.equal(ranking.length,4);
   assert.deepEqual(Object.keys(ranking[0]).sort(),['best_score','rank','user_id','username']);
   await user(2);await q("SELECT update_my_profile('新しい名前',2026)");
   ranking=await scalar('SELECT takoika_ranking()');assert.equal(ranking.find(r=>r.user_id===id(2)).username,'新しい名前');
  });
  await t.test('users cannot change any record directly or pass another owner to RPC',async()=>{
   await user(2);
   await assert.rejects(q('INSERT INTO takoika_bests(user_id,best_score) VALUES($1,99)',[id(5)]),/permission denied/);
   await assert.rejects(q('UPDATE takoika_bests SET best_score=99 WHERE user_id=$1',[id(1)]),/permission denied/);
   await assert.rejects(q('DELETE FROM takoika_bests'),/permission denied/);
   await assert.rejects(q('SELECT takoika_save_best($1,99)',[id(1)]),/does not exist/);
   await assert.rejects(q('SELECT * FROM profiles'),/permission denied/);
   await db.exec('RESET ROLE; SET ROLE anon');
   await assert.rejects(q('SELECT takoika_ranking()'),/permission denied/);
   await assert.rejects(q('SELECT takoika_save_best(99)'),/permission denied/);
   await user(null);await assert.rejects(q('SELECT takoika_ranking()'),/ログイン/);
   await assert.rejects(q('SELECT takoika_save_best(99)'),/ログイン/);
  });
  await t.test('all recorded users returned beyond PostgREST default row limit',async()=>{
   await db.exec('RESET ROLE');
   await q(`INSERT INTO auth.users(id,email) SELECT ('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'many'||n||'@example.test' FROM generate_series(1,1005) n`);
   await q("INSERT INTO takoika_bests(user_id,best_score) SELECT id,1 FROM auth.users WHERE email LIKE 'many%'");
   await user(1);assert.equal((await scalar('SELECT takoika_ranking()')).length,1009);
  });
  await t.test('admin deletion recognizes game FK and cascades only target best',async()=>{
   await db.exec('RESET ROLE');await q('INSERT INTO site_admins VALUES($1)',[id(5)]);
   await db.exec('SET ROLE service_role');
   await q('SELECT admin_user_delete($1,$2,$3,$4)',[id(5),id(2),id(900),'削除']);
   await user(1);const ranking=await scalar('SELECT takoika_ranking()');
   assert.equal(ranking.some(r=>r.user_id===id(2)),false);
   assert.equal(ranking.find(r=>r.user_id===id(1)).best_score,12);
  });
 }finally{await db.close();}
});
