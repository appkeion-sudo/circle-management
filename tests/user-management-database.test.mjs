import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const read = p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const id = n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;

test('user deletion: real local transactions, permission checks, anonymous history and retries',async t=>{
 const db=new PGlite();
 const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
 const scalar=async(sql,args=[])=>Object.values((await q(sql,args))[0])[0];
 const role=async(name)=>{await db.exec('RESET ROLE');await db.exec('SET ROLE '+name);};
 const remove=(actor,target,op=1000)=>scalar('SELECT admin_user_delete($1,$2,$3,$4)',[id(actor),id(target),id(op),'削除']);
 try {
  await db.exec(await read('tests/fixtures/supabase-platform.sql'));
  await db.exec('CREATE ROLE service_role; GRANT USAGE ON SCHEMA public TO service_role');
  await db.exec(await read('setup.sql'));
  await db.exec(await read('migrations/20261108_user_management.sql'));
  await db.exec(await read('migrations/20261108_user_management.sql'));
  // Model managed Auth dependencies and current/legacy Storage ownership locally.
  await db.exec(`CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users ON DELETE CASCADE);
   CREATE TABLE auth.identities(user_id uuid REFERENCES auth.users ON DELETE CASCADE);
   CREATE TABLE auth.refresh_tokens(user_id uuid REFERENCES auth.users ON DELETE CASCADE);
   ALTER TABLE storage.objects ADD COLUMN owner uuid REFERENCES auth.users;
   ALTER TABLE storage.objects ADD COLUMN owner_id text;
   ALTER TABLE storage.buckets ADD COLUMN owner uuid REFERENCES auth.users;`);
  for(const n of [1,2,3,4,5]) await q('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',[id(n),`user${n}@example.test`,JSON.stringify({username:n===3?'テスト削除':'ユーザ'+n})]);
  await q('INSERT INTO site_admins VALUES($1),($2)',[id(1),id(5)]);
  await q('INSERT INTO circle_president(user_id) VALUES($1)',[id(2)]);

  await t.test('untrusted clients cannot list emails, spoof actors, or delete users',async()=>{
   for(const name of ['anon','authenticated']) {
    await role(name);
    await assert.rejects(q('SELECT admin_users_list($1)',[id(1)]),/permission denied/);
    await assert.rejects(remove(1,3),/permission denied/);
    await assert.rejects(q('SELECT * FROM user_deletion_audit'),/permission denied/);
   }
   await role('service_role');
   for(const actor of [2,3,99]) {
    await assert.rejects(q('SELECT admin_users_list($1)',[id(actor)]),/サイト管理者/);
    await assert.rejects(remove(actor,4),/サイト管理者/);
   }
   await assert.rejects(remove(1,1),/自分自身/);
   await assert.rejects(q('SELECT admin_user_delete($1,$2,$3,$4)',[id(1),id(3),id(1000),'delete']),/削除確認/);
   const rows=await scalar('SELECT admin_users_list($1,$2,0)',[id(1),'USER3@']);
   assert.equal(rows.total,1);assert.equal(rows.users[0].id,id(3));
   assert.equal((await scalar('SELECT admin_users_list($1,$2,0)',[id(1),"%' OR true --"])).total,0);
   await role('postgres');
  });

  await db.exec(`INSERT INTO circle_roles(name) VALUES('会計');`);
  await q('INSERT INTO circle_member_roles VALUES($1,1)',[id(3)]);
  await q('UPDATE profiles SET admission_year=2026 WHERE id=$1',[id(3)]);
  await q('INSERT INTO admission_year_requests(user_id,requested_year) VALUES($1,2025)',[id(3)]);
  await q('INSERT INTO president_transfers(from_user,to_user) VALUES($1,$2)',[id(2),id(3)]);
  for(const n of [3,4]) await q("INSERT INTO schedules VALUES($1,'2099-01-01',1,true)",[id(n)]);
  for(const n of [101,102]) await q('INSERT INTO bands(id,name,created_by) VALUES($1,$2,$3)',[id(n),'バンド'+n,id(3)]);
  await q('INSERT INTO band_members VALUES($1,$2),($1,$3),($4,$3)',[id(101),id(3),id(4),id(102)]);
  await q("INSERT INTO auditions(id,title,created_by,status) VALUES($1,'過去OD',$2,'closed')",[id(201),id(3)]);
  await q("INSERT INTO audition_criteria(id,audition_id,name,max_score,weight) VALUES($1,$2,'演奏',10,1)",[id(301),id(201)]);
  for(const [entry,band] of [[401,101],[402,102]]) await q('INSERT INTO audition_entries(id,audition_id,band_id,entered_by,is_freshman_band) VALUES($1,$2,$3,$4,true)',[id(entry),id(201),id(band),id(3)]);
  await q('INSERT INTO audition_entry_members VALUES($1,$2)',[id(401),id(3)]);
  await q('INSERT INTO audition_participants VALUES($1,$2)',[id(201),id(3)]);
  // User 3 cannot score their own entry, but their vote for entry 402 is complete.
  for(const [entry,judge,score] of [[402,3,8],[401,4,6],[402,4,4],[401,5,1],[402,5,1]]) {
   await q('INSERT INTO audition_scores(audition_id,entry_id,criterion_id,judge_id,score,comment) VALUES($1,$2,$3,$4,$5,$6)',[id(201),id(entry),id(301),id(judge),score,'個人コメント']);
  }
  await q('INSERT INTO audition_invalid_votes VALUES($1,$2)',[id(201),id(5)]);
  await q("INSERT INTO audition_penalties(entry_id,reason,points,created_by) VALUES($1,'減点',1,$2)",[id(402),id(3)]);
  const finalize=async()=>{
   await role('postgres');await q("SELECT set_config('request.jwt.claim.sub',$1,false)",[id(2)]);
   await role('authenticated');await q('SELECT audition_finalize($1)',[id(201)]);await role('postgres');
  };
  await finalize();
  await q("UPDATE audition_results SET passed=true,result_category='general'");
  const results=()=>q('SELECT entry_id,total_score,overall_rank,valid_votes,invalid_votes,passed,result_category FROM audition_results ORDER BY entry_id');
  const before=await results();
  const plan={date:'2099-01-01',start:600,people:[{id:id(3),name:'テスト削除',entries:[id(401)]},{id:id(4),name:'残る',entries:[]}],items:[{kind:'performance',name:'バンド101',entry:id(401),minutes:15,staff:[id(3),id(4),null,null]}]};
  await q("INSERT INTO od_timetables(audition_id,event_date,draft,published) VALUES($1,'2099-01-01',$2,$2)",[id(201),JSON.stringify(plan)]);
  await q('INSERT INTO od_publication_events(id,audition_id,publication) VALUES($1,$2,1)',[id(501),id(201)]);
  await q("INSERT INTO od_timetable_notifications VALUES($1,$2,'通知',NULL,'{}')",[id(501),id(3)]);
  await q('INSERT INTO ui_timetable_reads(event_id,user_id) VALUES($1,$2)',[id(501),id(3)]);
  await q("INSERT INTO ui_event_notifications(user_id,title,body) VALUES($1,'通知','本文')",[id(3)]);
  await q("INSERT INTO ui_notices(id,title,body,created_by) VALUES($1,'お知らせ','本文',$2)",[id(601),id(3)]);
  await q("INSERT INTO storage.objects(bucket_id,name,owner,owner_id) VALUES('band-icons',$1,$2,$3)",[id(3)+'/icon.png',id(3),id(3)]);
  await q('UPDATE bands SET icon_path=$1 WHERE id=$2',[id(3)+'/icon.png',id(101)]);
  await q('INSERT INTO auth.sessions VALUES($1,$2)',[id(701),id(3)]);
  await q('INSERT INTO auth.identities VALUES($1)',[id(3)]);
  await q('INSERT INTO auth.refresh_tokens VALUES($1)',[id(3)]);

  await t.test('unexpected Auth dependency rolls back every cleanup and ownership transfer',async()=>{
   await db.exec('CREATE TABLE auth.unexpected_dependency(user_id uuid REFERENCES auth.users)');
   await q('INSERT INTO auth.unexpected_dependency VALUES($1)',[id(3)]);
   // This managed-schema dependency passes the app schema guard and forces a
   // late Auth DELETE failure, after all application cleanup has run.
   await role('service_role');await assert.rejects(remove(1,3),/foreign key/);
   await role('postgres');
   assert.equal(await scalar('SELECT count(*)::int FROM profiles WHERE id=$1',[id(3)]),1);
   assert.equal(await scalar('SELECT count(*)::int FROM band_members WHERE user_id=$1',[id(3)]),1);
   assert.equal(await scalar('SELECT count(*)::int FROM schedules'),2);
   assert.equal(await scalar('SELECT count(*)::int FROM audition_deleted_judges'),0);
   assert.equal(await scalar('SELECT count(*)::int FROM user_deletion_audit'),0);
   assert.equal(await scalar('SELECT owner_id FROM storage.objects'),id(3));
   assert.deepEqual(await scalar('SELECT published FROM od_timetables'),plan);
   assert.deepEqual(await results(),before);
   await db.exec('DROP TABLE auth.unexpected_dependency');
  });
  await t.test('unknown cascading application dependencies stop deletion before cleanup',async()=>{
   await db.exec('CREATE TABLE public.production_only_shared_data(user_id uuid REFERENCES profiles ON DELETE CASCADE)');
   await q('INSERT INTO production_only_shared_data VALUES($1)',[id(3)]);
   await role('service_role');await assert.rejects(remove(1,3),/未確認のユーザ依存関係/);
   await role('postgres');
   assert.equal(await scalar('SELECT count(*)::int FROM production_only_shared_data'),1);
   assert.equal(await scalar('SELECT count(*)::int FROM profiles WHERE id=$1',[id(3)]),1);
   await db.exec('DROP TABLE public.production_only_shared_data');
  });
  await t.test('complete deletion preserves bands, other schedules, icons, results and timetable rows',async()=>{
   await role('service_role');assert.equal((await remove(1,3)).deleted,true);
   assert.equal((await remove(1,3)).replayed,true);
   await assert.rejects(remove(1,4),/操作ID/);
   await role('postgres');
   for(const [table,column] of [['auth.users','id'],['profiles','id'],['schedules','user_id'],['band_members','user_id'],['audition_participants','user_id'],['audition_entry_members','user_id'],['audition_scores','judge_id'],['circle_member_roles','user_id'],['admission_year_requests','user_id'],['od_timetable_notifications','user_id'],['ui_event_notifications','user_id'],['ui_timetable_reads','user_id'],['auth.sessions','user_id'],['auth.identities','user_id'],['auth.refresh_tokens','user_id']]) assert.equal(await scalar(`SELECT count(*)::int FROM ${table} WHERE ${column}=$1`,[id(3)]),0,table);
   assert.equal(await scalar('SELECT count(*)::int FROM schedules WHERE user_id=$1',[id(4)]),1);
   assert.equal(await scalar('SELECT count(*)::int FROM bands'),2);
   assert.equal(await scalar('SELECT count(*)::int FROM band_members WHERE user_id=$1',[id(4)]),2);
   assert.equal(await scalar('SELECT count(*)::int FROM bands WHERE created_by IS NOT NULL'),0);
   assert.equal(await scalar('SELECT count(*)::int FROM ui_notices WHERE created_by IS NULL'),1);
   assert.equal(await scalar('SELECT owner_id FROM storage.objects'),id(1));
   const afterPlan=await scalar('SELECT published FROM od_timetables');
   assert.equal(afterPlan.items.length,plan.items.length);assert.equal(afterPlan.items[0].staff[0],null);
   assert.equal(afterPlan.items[0].staff[1],id(4));assert.equal(afterPlan.people.length,1);
   assert.doesNotMatch(JSON.stringify(afterPlan),/テスト削除/);
   assert.deepEqual(await results(),before);
   await finalize();assert.deepEqual(await results(),before);
   // Remove the second administrator / invalid judge; invalid votes must also survive.
   await role('service_role');await remove(1,5,1001);
   await finalize();assert.deepEqual(await results(),before);
   await role('service_role');await assert.rejects(remove(1,1,1002),/自分自身/);
   await role('postgres');assert.equal(await scalar('SELECT count(*)::int FROM site_admins'),1);
  });
 } finally {await db.close();}
});
