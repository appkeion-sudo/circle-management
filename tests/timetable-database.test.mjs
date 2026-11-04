import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
const {PGlite}=await import(process.env.KEION_PGLITE_MODULE?pathToFileURL(process.env.KEION_PGLITE_MODULE).href:'@electric-sql/pglite');
const read=name=>readFile(new URL('../'+name,import.meta.url),'utf8');
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
test('timetable migration, authorization, publication snapshots, cancellation, and archives',async t=>{
 const db=new PGlite();const q=async(sql,args=[])=>(await db.query(sql,args)).rows;
 const scalar=async(sql,args=[])=>Object.values((await q(sql,args))[0])[0];
 const user=async n=>{await db.exec('RESET ROLE');await q("SELECT set_config('request.jwt.claim.sub',$1,false)",[n?id(n):'']);await db.exec('SET ROLE authenticated');};
 const owner=()=>db.exec('RESET ROLE');
 try{
  await db.exec(await read('tests/fixtures/database.sql'));
  await db.exec(await read('setup.sql'));await db.exec(await read('setup.sql'));
  await q("INSERT INTO profiles(id,username,admission_year) SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'User'||n,2025 FROM generate_series(1,8) n");
  await q('INSERT INTO circle_president(user_id) VALUES($1)',[id(1)]);
  const aid=id(100),entries=[201,202,203].map(id);
  await q("INSERT INTO auditions(id,title,status,entry_deadline) VALUES($1,'OD','open',now()+interval '1 day')",[aid]);
  for(let i=0;i<3;i++){
   await q('INSERT INTO bands(id,name) VALUES($1,$2)',[id(301+i),'Band'+i]);
   await q('INSERT INTO audition_entries(id,audition_id,band_id) VALUES($1,$2,$3)',[entries[i],aid,id(301+i)]);
   await q('INSERT INTO audition_entry_members VALUES($1,$2)',[entries[i],id(i+2)]);
   await q('INSERT INTO band_members VALUES($1,$2)',[id(301+i),id(i+2)]);
  }
  for(let i=5;i<=8;i++)await q('INSERT INTO audition_entry_members VALUES($1,$2)',[entries[2],id(i)]);
  await q('INSERT INTO audition_participants SELECT $1,id FROM profiles',[aid]);
  let revision=0;
  const plan={staff_scope:'band',date:'2099-01-01',pa:510,gather:570,start:600,items:[
   {kind:'performance',entry:entries[0],minutes:15,staff:[5,6,7,8].map(id)},
   {kind:'transition',minutes:5,staff:[]},
   {kind:'performance',entry:entries[1],minutes:15,staff:[null,null,null,null]},
   {kind:'transition',minutes:5,staff:[]},
   {kind:'performance',entry:entries[2],minutes:15,staff:[null,null,null,null]}
  ]};
  const save=async(p=plan,publish=false,allow=false,automatic=false)=>{await q('SELECT od_timetable_save($1,$2::jsonb,$3,$4,$5,$6)',[aid,JSON.stringify(p),revision,publish,allow,automatic]);revision++;};
  const context=()=>scalar('SELECT od_timetable_context($1)',[aid]);
  await t.test('deadline and confirmed order required; president authorization is enforced',async()=>{
   await user(1);await assert.rejects(q('SELECT audition_confirm_order($1,$2::uuid[])',[aid,entries]),/締切/);await assert.rejects(save(),/締切/);
   await owner();await q("UPDATE auditions SET entry_deadline=now()-interval '1 day' WHERE id=$1",[aid]);await user(1);
   await assert.rejects(save(),/演奏順/);await q('SELECT audition_confirm_order($1,$2::uuid[])',[aid,entries]);
   await assert.rejects(q('SELECT audition_set_availability($1,$2::jsonb)',[entries[0],'[[null,null]]']),/時間帯/);
   await q('SELECT audition_set_availability($1,$2::jsonb)',[entries[0],'[[590,900]]']);
   await user(2);await assert.rejects(save(),/部長/);await assert.rejects(q('SELECT audition_confirm_order($1,$2::uuid[])',[aid,entries]),/部長/);
   await assert.rejects(q('SELECT * FROM od_timetables'),/permission denied/);
  });
  await t.test('canonical names and identities; no draft leak; order is immutable',async()=>{
   await user(1);await save();let data=await context();assert.equal(data.draft.items[0].name,'Band0');assert.equal(data.revision,1);
   await assert.rejects(q('SELECT audition_confirm_order($1,$2::uuid[])',[aid,entries.toReversed()]),/生成済み/);
   const bad=structuredClone(plan);bad.items[0].entry=entries[1];await assert.rejects(save(bad),/演奏順/);
   await user(2);data=await context();assert.equal(data.published,null);assert.equal(data.draft,undefined);assert.equal(data.people,undefined);
  });
  await t.test('availability comes from stored declarations and needs confirmation even in automatic mode',async()=>{
   await user(1);const out=structuredClone(plan);out.items[0].minutes=400;out.items[0].available=[];
   await assert.rejects(save(out),/出演可能時間帯外/);await save(out,false,true,true);await save();
   await assert.rejects(q('SELECT audition_set_availability($1,$2::jsonb)',[entries[0],'[]']),/生成後/);
  });
  await t.test('manual exceptions need explicit confirmation; automatic mode never relaxes staff rules',async()=>{
   await user(1);const bad=structuredClone(plan);bad.items[0].staff[0]=id(2);
   await assert.rejects(save(bad),/条件違反/);await assert.rejects(save(bad,false,true,true),/条件違反/);await save(bad,false,true);
   const duplicate=structuredClone(plan);duplicate.items[0].staff[1]=id(5);await assert.rejects(save(duplicate),/条件違反/);
   const noShow=structuredClone(plan);noShow.items[0].staff[0]=id(1);await assert.rejects(save(noShow),/条件違反/);
   await save();
  });
  await t.test('breaks replace transitions and discard all staff; empty slots can be published',async()=>{
   const p=structuredClone(plan);p.items[3]={kind:'break',minutes:20,staff:[id(1)]};await save(p,true);
   const data=await context();assert.deepEqual(data.published.items[3].staff,[]);assert.equal(data.publication,1);
   assert.ok(data.published.people.every(p=>p.registered===undefined&&p.excluded===undefined&&p.year===undefined));
  });
  await t.test('all bands require four slots; transitions cannot acquire duties; boundary and break conflicts are validated',async()=>{
   const missing=structuredClone(plan);missing.items[4].staff=[];await assert.rejects(save(missing),/4枠/);
   const neighbor=structuredClone(plan);neighbor.items[2].staff=[id(2),null,null,null];await assert.rejects(save(neighbor),/条件違反/);
   neighbor.items[1]={kind:'break',minutes:10,staff:[id(1)]};await save(neighbor);
   const data=await context();assert.equal(data.draft.items[2].staff[0],id(2));assert.deepEqual(data.draft.items[1].staff,[]);
   const last=structuredClone(plan);last.items[4].staff=[id(2),null,null,null];await save(last);
   last.items[4].staff[0]=id(4);await assert.rejects(save(last),/条件違反/);await save();
  });
  await t.test('published data stays stable through edits; notifications target the affected person',async()=>{
   await user(2);const before=(await context()).published;await user(1);plan.items[0].minutes=20;await save();
   await user(2);assert.deepEqual((await context()).published,before);await user(1);await save(plan,true);
   await user(2);const inbox=await q('SELECT * FROM od_timetable_inbox()');assert.equal(inbox.length,2);
   assert.ok(inbox[0].message.includes('あなたの予定に変更'));assert.notDeepEqual(inbox[0].before_schedule,inbox[0].after_schedule);
   await assert.rejects(q('SELECT * FROM od_timetable_notifications'),/permission denied/);
  });
  await t.test('published cancellation is president-only; draft is cleared and publication retained',async()=>{
   await user(5);await assert.rejects(q('SELECT od_timetable_participation($1,$2,false)',[aid,id(5)]),/部長/);
   await assert.rejects(q('DELETE FROM audition_participants WHERE audition_id=$1',[aid]),/permission denied/);
   await user(1);await q('SELECT od_timetable_participation($1,$2,false)',[aid,id(5)]);revision++;
   const data=await context();assert.equal(data.draft.items[0].staff[0],null);assert.equal(data.published.items[0].staff[0],id(5));
   await assert.rejects(save(),/条件違反/);
   const fresh=structuredClone(data.draft);await save(fresh,true);assert.equal((await context()).published.items[0].staff[0],null);
   await user(5);const inbox=await q('SELECT * FROM od_timetable_inbox()');assert.ok(inbox[0].before_schedule.schedule.some(s=>s.role==='ローディー（Band0）'));assert.ok(!inbox[0].after_schedule.schedule.some(s=>s.role==='ローディー（Band0）'));await user(1);
  });
  await t.test('SQL reapplication retains both existing versions; legacy publication schedules remain compatible',async()=>{
   const before=await context();await owner();await db.exec(await read('setup.sql'));await user(1);
   const after=await context();assert.deepEqual(after.published,before.published);assert.deepEqual(after.draft,before.draft);assert.equal(after.revision,before.revision);
   const legacy=structuredClone(before.published);delete legacy.staff_scope;legacy.items[1].staff=[id(5),null,null,null];legacy.items[0].staff=[];
   await owner();const schedule=await scalar('SELECT od_person_schedule($1::jsonb,$2)',[JSON.stringify(legacy),id(5)]);assert.ok(schedule.schedule.some(s=>s.role==='ローディー'&&s.start===620));
   const both=structuredClone(before.published);both.items[0].staff=[id(2),null,null,null];const self=await scalar('SELECT od_person_schedule($1::jsonb,$2)',[JSON.stringify(both),id(2)]);
   assert.ok(self.schedule.some(s=>s.role==='Band0'));assert.ok(self.schedule.some(s=>s.role==='ローディー（Band0）'));await user(1);
  });
  await t.test('role exclusion and all performing memberships are server-owned',async()=>{
   await owner();await q("INSERT INTO test_roles VALUES(10,'幹部',false),(11,'会計',true)");await q('INSERT INTO test_member_roles VALUES($1,10),($2,11)',[id(6),id(7)]);await user(1);
   let people=(await context()).people;assert.ok(people.find(p=>p.id===id(6)).excluded);assert.ok(people.find(p=>p.id===id(7)).excluded);
   await q('SELECT od_set_role_exclusion(10,false)');people=(await context()).people;assert.equal(people.find(p=>p.id===id(6)).excluded,false);
   await user(2);await assert.rejects(q('SELECT od_set_role_exclusion(10,false)'),/部長/);
  });
  await t.test('freshman pairs and eligibility are checked from server data, ignoring forged client profiles',async()=>{
   await owner();await q('UPDATE profiles SET year_override=1 WHERE id IN ($1,$2)',[id(6),id(8)]);await user(1);
   const p=structuredClone(plan);p.items[0].staff=[id(6),id(8),null,null];p.people=[{id:id(6),year:2,registered:true,excluded:false}];
   await assert.rejects(save(p),/条件違反/);await save(p,false,true);assert.equal((await context()).draft.people.find(p=>p.id===id(6)).year,1);
  });
  await t.test('optimistic revision prevents overwriting concurrent edits; archives cannot be changed',async()=>{
   await user(1);await assert.rejects(q('SELECT od_timetable_save($1,$2::jsonb,0)',[aid,JSON.stringify(plan)]),/更新/);
   await owner();await q("UPDATE od_timetables SET event_date='2000-01-01' WHERE audition_id=$1",[aid]);await user(1);
   const data=await context();assert.ok(data.archived);assert.ok(data.published);await assert.rejects(save(),/過去OD/);
   await assert.rejects(q('SELECT od_timetable_participation($1,$2,false)',[aid,id(6)]),/過去OD/);
   await assert.rejects(q('SELECT audition_delete($1)',[aid]),/過去OD/);
   await db.exec('SET ROLE anon');await assert.rejects(q('SELECT od_timetable_context($1)',[aid]),/permission denied/);
   await assert.rejects(q('SELECT od_timetable_save($1,$2::jsonb,0)',[aid,JSON.stringify(plan)]),/permission denied/);
  });
 }finally{await db.close();}
});
