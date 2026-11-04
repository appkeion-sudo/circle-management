import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const read=f=>readFile(new URL('../'+f,import.meta.url),'utf8');
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
test('UI migration, notices, schedules and notification authorization',async t=>{
 const db=new PGlite(),q=async(sql,args=[])=> (await db.query(sql,args)).rows;
 const scalar=async(sql,args=[])=>Object.values((await q(sql,args))[0])[0];
 const user=async n=>{await db.exec('RESET ROLE');await q("SELECT set_config('request.jwt.claim.sub',$1,false)",[n?id(n):'']);await db.exec('SET ROLE authenticated');};
 try {
  await db.exec(await read('tests/fixtures/database.sql'));
  await db.exec(await read('setup.sql'));await db.exec(await read('setup.sql'));
  await q("INSERT INTO profiles(id,username) VALUES($1,'部長'),($2,'サイト管理者'),($3,'一般'),($4,'別の一般')",[1,2,3,4].map(id));
  await q('INSERT INTO circle_president(user_id) VALUES($1)',[id(1)]);
  await t.test('members cannot post or access underlying notice/notification tables',async()=>{
   await user(3);assert.equal(await scalar('SELECT ui_can_post()'),false);
   await assert.rejects(q('SELECT ui_notice_save($1,$2,$3)',[id(100),'title','body']),/部長またはサイト管理者/);
   await assert.rejects(q('SELECT * FROM ui_notices'),/permission denied/);
   await assert.rejects(q('SELECT * FROM ui_event_notifications'),/permission denied/);
  });
  await t.test('president and independent site administrator can manage notices; retries do not duplicate',async()=>{
   await user(1);await q('SELECT ui_notice_save($1,$2,$3)',[id(100),'title','body']);
   await user(2);assert.equal(await scalar('SELECT ui_can_post()'),true);
   assert.equal(await scalar('SELECT is_circle_president()'),false);
   await q('SELECT ui_notice_save($1,$2,$3)',[id(100),'edited','<script>literal text</script>']);
   await user(3);const data=await scalar('SELECT ui_dashboard()');assert.equal(data.notices.length,1);assert.equal(data.notices[0].title,'edited');
   await user(2);await q('SELECT ui_notice_delete($1)',[id(100)]);
   await assert.rejects(q('SELECT ui_notice_save($1,$2,$3)',[id(101),' ','body']),/確認/);
  });
  await t.test('schedule RPC upserts only the authenticated user and validates the eight slots',async()=>{
   await user(3);await q("SELECT ui_schedule_save('2099-01-01',1,true)");await q("SELECT ui_schedule_save('2099-01-01',1,false)");
   assert.deepEqual((await q('SELECT available FROM schedules')).map(r=>r.available),[false]);
   await assert.rejects(q("SELECT ui_schedule_save('2099-01-01',9,true)"),/不正/);
   await assert.rejects(q("SELECT ui_schedule_save(NULL,1,true)"),/不正/);
   await user(4);assert.equal((await q('SELECT * FROM schedules')).length,0);
   await q("SELECT ui_schedule_save('2099-01-01',1,true)");
   await user(3);assert.equal((await q('SELECT * FROM schedules')).length,1);
  });
  await t.test('opening entry emits one notification per recipient; reads cannot mark another user',async()=>{
   await db.exec('RESET ROLE');await q("INSERT INTO auditions(id,title,status,event_date,entry_deadline) VALUES($1,'next','draft','2099-01-01',now()+interval '1 day')",[id(200)]);
   await q("UPDATE auditions SET status='open' WHERE id=$1",[id(200)]);await q("UPDATE auditions SET status='open' WHERE id=$1",[id(200)]);
   await user(3);let rows=await q('SELECT * FROM ui_notifications()');assert.equal(rows.length,1);
   const own=rows[0].id;await user(4);await q('SELECT ui_notifications_read($1::uuid[])',[[own]]);
   assert.equal((await q('SELECT * FROM ui_notifications()'))[0].read_at,null);
   await user(3);await q('SELECT ui_notifications_read($1::uuid[])',[[own]]);assert.ok((await q('SELECT * FROM ui_notifications()'))[0].read_at);
   const dashboard=await scalar('SELECT ui_dashboard()');assert.equal(dashboard.unread,0);assert.equal(dashboard.events[0].event_date,'2099-01-01');
  });
  await t.test('timetable notifications share read counts without exposing another member',async()=>{
   await db.exec('RESET ROLE');await q('INSERT INTO od_publication_events(id,audition_id,publication) VALUES($1,$2,1)',[id(300),id(200)]);
   await q("INSERT INTO od_timetable_notifications(event_id,user_id,message,after_schedule) VALUES($1,$2,'公開','{}')",[id(300),id(3)]);
   await user(4);await q('SELECT ui_notifications_read($1::uuid[])',[[id(300)]]);
   await user(3);assert.equal((await scalar('SELECT ui_dashboard()')).unread,1);
   await q('SELECT ui_notifications_read($1::uuid[])',[[id(300)]]);assert.equal((await scalar('SELECT ui_dashboard()')).unread,0);
   await db.exec('RESET ROLE');await db.exec(await read('setup.sql'));await user(3);
   assert.equal((await scalar('SELECT ui_dashboard()')).unread,0);
  });
  await t.test('anonymous users cannot execute RPCs or spoof the notification trigger',async()=>{
   await db.exec('RESET ROLE');await db.exec('SET ROLE anon');await assert.rejects(q('SELECT ui_dashboard()'),/permission denied/);
   await assert.rejects(q('SELECT ui_schedule_save(current_date,1,true)'),/permission denied/);
   await assert.rejects(q('SELECT ui_audition_notification()'),/permission denied/);
  });
 } finally {await db.close();}
});
