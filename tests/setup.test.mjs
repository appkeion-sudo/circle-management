import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const read=name=>readFile(new URL('../'+name,import.meta.url),'utf8');
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;

test('setup.sql builds a fresh Supabase application without application fixtures',async t=>{
 const db=new PGlite();
 const q=async(sql,args=[])=> (await db.query(sql,args)).rows;
 const scalar=async(sql,args=[])=>Object.values((await q(sql,args))[0])[0];
 const owner=()=>db.exec('RESET ROLE');
 const user=async n=>{
  await owner();await q("SELECT set_config('request.jwt.claim.sub',$1,false)",[n?id(n):'']);
  await db.exec('SET ROLE authenticated');
 };
 const setup=await read('setup.sql');
 const configured=setup.replace('initial_president_email text := NULL',"initial_president_email text := 'president@example.test'")
  .replace('initial_site_admin_email text := NULL',"initial_site_admin_email text := 'admin@example.test'");
 try {
  await db.exec(await read('tests/fixtures/supabase-platform.sql'));
  // A user who signed up before setup is backfilled; setup assigns only configured identities.
  await q("INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,'president@example.test','{\"username\":\"部長\"}'),($2,'admin@example.test','{\"username\":\"管理者\"}')",[id(1),id(2)]);
  await db.exec(configured);
  await t.test('Auth profiles, explicit initial privileges, and complete RLS',async()=>{
   await q("INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,'member@example.test','{\"username\":\"部員\",\"is_site_admin\":true}'),($2,'other@example.test','{}')",[id(3),id(4)]);
   await user(3);
   const ctx=await scalar('SELECT profile_context()');
   assert.equal(ctx.profile.username,'部員');assert.equal(ctx.is_site_admin,false);assert.equal(ctx.is_president,false);
   await assert.rejects(q('INSERT INTO site_admins VALUES($1)',[id(3)]),/permission denied/);
   await assert.rejects(q('SELECT recover_president($1)',[id(3)]),/サイト管理者/);
   await assert.rejects(q('SELECT * FROM profiles'),/permission denied/);
   assert.equal((await q('SELECT * FROM list_circle_users()')).length,4);
   await owner();
   assert.deepEqual(await q("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity"),[]);
  });
  await t.test('profile editing, year requests, roles, and independent admin powers',async()=>{
   await user(3);await q("SELECT update_my_profile('部員改',2026)");
   await assert.rejects(q("SELECT update_my_profile('部員改',2025)"),/申請/);
   await q('SELECT request_admission_year(2025)');
   await assert.rejects(q('SELECT * FROM pending_year_requests()'),/管理者/);
   await user(2);
   const request=(await q('SELECT * FROM pending_year_requests()'))[0];
   await q('SELECT review_year_request($1,true)',[request.id]);
   await assert.rejects(q("SELECT save_circle_role(NULL,'会計',false)"),/部長/);
   await user(1);await q("SELECT save_circle_role(NULL,'会計',true)");
   const role=(await q('SELECT * FROM circle_roles_list()'))[0];
   await q('SELECT set_user_role($1,$2,true)',[id(3),role.id]);
   await q("SELECT set_member_details($1,'alumni',2)",[id(3)]);
   assert.deepEqual((await q('SELECT * FROM circle_members_admin()')).find(m=>m.user_id===id(3)).role_ids,[role.id]);
   await user(3);assert.equal((await q('SELECT * FROM my_circle_roles()'))[0].name,'会計');
   assert.equal((await scalar('SELECT profile_context()')).profile.admission_year,2025);
   await user(1);await q("SELECT save_circle_role($1,'会計改',false)",[role.id]);
   await q('SELECT delete_circle_role($1)',[role.id]);
   await user(3);assert.deepEqual(await q('SELECT * FROM my_circle_roles()'),[]);
   await user(2);await assert.rejects(q('SELECT set_site_admin($1,false)',[id(2)]),/最後/);
   await q('SELECT set_site_admin($1,true)',[id(4)]);
   assert.equal((await q('SELECT * FROM site_admin_list()')).length,2);
   await q('SELECT set_site_admin($1,false)',[id(4)]);
  });
  let band;
  await t.test('storage ownership, band creation, private schedule aggregation, and leave',async()=>{
   await user(3);
   const path=id(3)+'/icon.png';
   await assert.rejects(q("INSERT INTO storage.objects(bucket_id,name) VALUES('band-icons',$1)",[id(4)+'/bad.png']),/row-level security/);
   await q("INSERT INTO storage.objects(bucket_id,name) VALUES('band-icons',$1)",[path]);
   band=await scalar('SELECT create_band($1,$2,$3)', ['バンド',path,[id(4)]]);
   assert.equal((await q('SELECT * FROM bands')).length,1);
   await q("SELECT ui_schedule_save('2099-01-01',1,true)");
   await user(4);await q("SELECT ui_schedule_save('2099-01-01',1,false)");
   assert.equal((await q("SELECT * FROM get_band_schedules($1,'2099-01-01','2099-01-02')",[band])).length,2);
   await assert.rejects(q("SELECT * FROM get_band_schedules($1,'2099-01-01','2099-02-02')",[band]),/31日/);
   await user(1);
   assert.deepEqual(await q('SELECT * FROM bands'),[]);
   await assert.rejects(q("SELECT * FROM get_band_schedules($1,'2099-01-01','2099-01-02')",[band]),/所属/);
   await user(3);
   assert.equal((await q("DELETE FROM storage.objects WHERE name=$1 RETURNING id",[path])).length,0);
   const unused=id(3)+'/unused.png';
   await q("INSERT INTO storage.objects(bucket_id,name) VALUES('band-icons',$1)",[unused]);
   assert.equal((await q('DELETE FROM storage.objects WHERE name=$1 RETURNING id',[unused])).length,1);
   await user(4);await q('DELETE FROM band_members WHERE band_id=$1 AND user_id=$2',[band,id(4)]);
   assert.deepEqual(await q('SELECT * FROM bands'),[]);
  });
  await t.test('fresh installation supports audition criteria and timetable role contracts',async()=>{
   await user(1);
   const audition=await scalar(`SELECT audition_create_with_previous('OD','',now()+interval '1 day',NULL,1,1,'[{"name":"演奏","max_score":10,"weight":1}]',NULL)`);
   await q("SELECT audition_change_status($1,'open')",[audition]);
   await user(3);
   assert.equal((await q('SELECT * FROM audition_criteria WHERE audition_id=$1',[audition])).length,1);
   await q('SELECT audition_register($1)',[audition]);
   await q('SELECT audition_enter($1,$2)',[audition,band]);
   await user(1);
   const people=await scalar('SELECT od_timetable_people($1)',[audition]);
   assert.equal(people.length,4);
   assert.equal(people.find(p=>p.id===id(3)).registered,true);
  });
  await t.test('handover requires recipient consent; reapplying preserves data, RPCs and privileges',async()=>{
   await user(1);await q('SELECT propose_president($1)',[id(3)]);
   await user(3);const transfer=(await scalar('SELECT profile_context()')).incoming_transfer_id;
   await user(4);await assert.rejects(q('SELECT accept_president($1)',[transfer]),/引き継ぎ/);
   await user(3);await q('SELECT accept_president($1)',[transfer]);
   assert.equal(await scalar('SELECT is_circle_president()'),true);
   await owner();
   const before=await scalar("SELECT pg_get_functiondef('public.profile_context()'::regprocedure)");
   await db.exec(configured);
   assert.equal(await scalar("SELECT pg_get_functiondef('public.profile_context()'::regprocedure)"),before);
   assert.equal(await scalar('SELECT count(*)::int FROM bands'),1);
   await user(3);assert.equal(await scalar('SELECT is_circle_president()'),true);
   await user(2);await q('SELECT recover_president($1)',[id(1)]);
   await user(1);assert.equal(await scalar('SELECT is_circle_president()'),true);
  });
  await t.test('anonymous callers cannot execute application RPCs or access data',async()=>{
   await owner();await q("SELECT set_config('request.jwt.claim.sub','',false)");await db.exec('SET ROLE anon');
   await assert.rejects(q('SELECT profile_context()'),/permission denied/);
   await assert.rejects(q('SELECT * FROM list_circle_users()'),/permission denied/);
   await assert.rejects(q("SELECT create_band('bad',NULL,'{}')"),/permission denied/);
   await assert.rejects(q('SELECT * FROM bands'),/permission denied/);
  });
 } finally {await db.close();}
});

test('fresh setup grants no automatic administrator privileges and rolls back invalid initialization',async()=>{
 const db=new PGlite();
 try {
  await db.exec(await read('tests/fixtures/supabase-platform.sql'));
  const setup=await read('setup.sql');
  await assert.rejects(db.exec(setup.replace('initial_site_admin_email text := NULL',"initial_site_admin_email text := 'missing@example.test'")),/Authユーザーがありません/);
  await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT to_regclass('public.profiles') AS table_name")).rows[0].table_name,null);
  await db.exec(setup);
  await db.exec("INSERT INTO auth.users(email,raw_user_meta_data) VALUES('first@example.test','{\"is_president\":true,\"is_site_admin\":true}')");
  assert.equal((await db.query('SELECT count(*)::int AS n FROM profiles')).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM circle_president')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM site_admins')).rows[0].n,0);
  await db.exec(setup);
 } finally {await db.close();}
});
