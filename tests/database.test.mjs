import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const moduleName = process.env.KEION_PGLITE_MODULE;
const { PGlite } = await import(moduleName ? pathToFileURL(moduleName).href : '@electric-sql/pglite');
const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

test('database migration and authorization regressions', async t => {
  const db = new PGlite();
  const query = async (sql, args = []) => (await db.query(sql, args)).rows;
  const scalar = async (sql, args = []) => Object.values((await query(sql, args))[0])[0];
  const asUser = async n => {
    await db.exec('RESET ROLE');
    await query("SELECT set_config('request.jwt.claim.sub',$1,false)", [n ? id(n) : '']);
    await db.exec('SET ROLE authenticated');
  };
  const owner = () => db.exec('RESET ROLE');
  const create = async (name, previous = null, general = 1, freshman = 1) => {
    await asUser(1);
    return scalar(`SELECT public.audition_create_with_previous($1,'',now()+interval '1 day',
      NULL,$2,$3,'[{"name":"演奏","max_score":10,"weight":1}]'::jsonb,$4)`,
    [name, general, freshman, previous]);
  };
  try {
    await db.exec(await read('tests/fixtures/database.sql'));
    await db.exec(await read('setup.sql'));
    // Migration must be safe to reapply after an interrupted deployment.
    await db.exec(await read('setup.sql'));
    await query(`INSERT INTO profiles(id,username,admission_year) VALUES
      ($1,'部長',2026),($2,'新入生',2026),($3,'先輩',2025),($4,'採点者',2025),($5,'未登録',NULL)`,
    [1,2,3,4,5].map(id));
    await query('INSERT INTO circle_president(user_id) VALUES($1)', [id(1)]);
    for (const [band, member] of [[101,2],[102,3],[103,5],[104,2]]) {
      await query('INSERT INTO bands(id,name) VALUES($1,$2)',[id(band),'バンド'+band]);
      await query('INSERT INTO band_members VALUES($1,$2)',[id(band),id(member)]);
    }

    await t.test('April school year, Japan timezone, overrides, and unknown years',async()=>{
      assert.equal(await scalar("SELECT audition_member_year(2026,NULL,'2027-03-31 14:59:59Z')"),1);
      assert.equal(await scalar("SELECT audition_member_year(2026,NULL,'2027-03-31 15:00:00Z')"),2);
      assert.equal(await scalar("SELECT audition_member_year(2020,1,'2026-10-30Z')"),1);
      assert.equal(await scalar("SELECT audition_member_year(NULL,NULL,'2026-10-30Z')"),null);
    });

    await t.test('creation rolls back if the previous live is invalid',async()=>{
      const before=await scalar('SELECT count(*)::int FROM auditions');
      await assert.rejects(create('残らない',id(999)),/前回ライブ/);
      await owner();
      assert.equal(await scalar('SELECT count(*)::int FROM auditions'),before);
    });

    await t.test('audition deletion rejects ordinary members and removes related criteria',async()=>{
      const target=await create('削除対象');
      await asUser(3);
      await assert.rejects(query('SELECT audition_delete($1)',[target]),/部長またはサイト管理者のみ削除できます/);
      await owner();
      assert.equal(await scalar('SELECT count(*)::int FROM auditions WHERE id=$1',[target]),1);
      await asUser(1);
      await query('SELECT audition_delete($1)',[target]);
      await owner();
      assert.equal(await scalar('SELECT count(*)::int FROM auditions WHERE id=$1',[target]),0);
      assert.equal(await scalar('SELECT count(*)::int FROM audition_criteria WHERE audition_id=$1',[target]),0);
    });

    const audition=await create('審査');
    await owner();
    await query("UPDATE auditions SET entry_deadline='2026-10-30Z' WHERE id=$1",[audition]);
    await asUser(1);
    await query("SELECT audition_change_status($1,'open')",[audition]);
    // Make the window future-proof; use an explicit freshman override for entry tests.
    await owner();
    await query("UPDATE auditions SET entry_deadline=now()+interval '1 day' WHERE id=$1",[audition]);
    await query('UPDATE profiles SET year_override=1 WHERE id=$1',[id(2)]);
    const enter=async(band,user)=>{await asUser(user);return scalar('SELECT audition_enter($1,$2)',[audition,id(band)]);};
    const freshman=await enter(101,2);
    const senior=await enter(102,3);

    await t.test('entry names are visible without exposing unrelated bands or draft entries',async()=>{
      await asUser(4);
      assert.equal((await query('SELECT * FROM bands')).length,0);
      const entries=await query('SELECT * FROM audition_entries_view($1)',[audition]);
      assert.deepEqual(entries.map(e=>e.band_name).sort(),['バンド101','バンド102']);
      assert.ok(entries.every(e=>!e.can_withdraw));
      const draft=await create('下書き');
      await asUser(4);
      await assert.rejects(query('SELECT * FROM audition_entries_view($1)',[draft]),/閲覧できません/);
    });

    await t.test('unknown members are not ignored in freshman classification',async()=>{
      await owner();
      await query('INSERT INTO band_members VALUES($1,$2)',[id(104),id(5)]);
      const entry=await enter(104,2);
      await owner();
      assert.equal(await scalar('SELECT is_freshman_band FROM audition_entries WHERE id=$1',[entry]),false);
      await asUser(2);await query('SELECT audition_withdraw($1)',[entry]);
    });

    await t.test('withdraw requires current membership and an open deadline',async()=>{
      await asUser(4);
      assert.equal(await scalar('SELECT audition_can_withdraw($1)',[freshman]),false);
      await assert.rejects(query('SELECT audition_withdraw($1)',[freshman]),/所属バンド/);
      const entry=await enter(103,5);
      assert.equal(await scalar('SELECT audition_can_withdraw($1)',[entry]),true);
      await query('SELECT audition_withdraw($1)',[entry]);
      await owner();
      assert.equal(await scalar('SELECT count(*)::int FROM audition_entry_members WHERE entry_id=$1',[entry]),0);
      await query("UPDATE auditions SET entry_deadline=now()-interval '1 second' WHERE id=$1",[audition]);
      await asUser(2);
      assert.equal(await scalar('SELECT audition_can_withdraw($1)',[freshman]),false);
      await assert.rejects(query('SELECT audition_withdraw($1)',[freshman]),/締切前/);
    });

    await asUser(1);await query("SELECT audition_change_status($1,'scoring')",[audition]);
    await owner();
    const criterion=await scalar('SELECT id FROM audition_criteria WHERE audition_id=$1',[audition]);
    const scores=JSON.stringify({[criterion]:8});
    await t.test('saved reviews load only the caller, and self-scoring stays prohibited',async()=>{
      await asUser(4);
      await query('SELECT audition_save_review($1,$2::jsonb,$3)',[freshman,scores,'よかった']);
      await query('SELECT audition_save_review($1,$2::jsonb,$3)',[senior,scores,'迫力がある']);
      const review=await scalar('SELECT audition_my_review($1)',[freshman]);
      assert.equal(review.scores[criterion],8);assert.equal(review.comment,'よかった');
      await assert.rejects(query('SELECT * FROM audition_scores'),/permission denied/);
      await asUser(3);
      assert.deepEqual((await scalar('SELECT audition_my_review($1)',[freshman])).scores,{});
      await asUser(2);
      await assert.rejects(query('SELECT audition_my_review($1)',[freshman]),/自分のバンド/);
    });
    await asUser(1);await query("SELECT audition_change_status($1,'closed')",[audition]);
    await query('SELECT audition_finalize($1)',[audition]);
    await t.test('only president can decide; freshman eligibility and quotas are enforced',async()=>{
      await asUser(4);
      await assert.rejects(query("SELECT audition_set_pass($1,true,'general')",[senior]),/部長/);
      await asUser(1);
      await assert.rejects(query("SELECT audition_set_pass($1,true,'freshman')",[senior]),/1年生バンド/);
      await query("SELECT audition_set_pass($1,true,'general')",[senior]);
      await assert.rejects(query("SELECT audition_set_pass($1,true,'general')",[freshman]),/上限/);
      await query("SELECT audition_set_pass($1,true,'freshman')",[freshman]);
    });
    await t.test('recalculation preserves decisions while refreshing totals and invalid votes',async()=>{
      await query('SELECT audition_set_invalid_vote($1,$2,true)',[audition,id(4)]);
      await query('SELECT audition_finalize($1)',[audition]);
      await owner();
      const results=await query(`SELECT passed,result_category,total_score,invalid_votes FROM audition_results
        WHERE entry_id IN ($1,$2) ORDER BY result_category`,[freshman,senior]);
      assert.ok(results.every(r=>r.passed===true && Number(r.total_score)===0 && r.invalid_votes===1));
      assert.deepEqual(results.map(r=>r.result_category),['freshman','general']);
    });
    await t.test('publication rejects old invalid decisions even through direct updates',async()=>{
      await owner();
      await query("UPDATE audition_results SET result_category='general' WHERE entry_id=$1",[freshman]);
      await asUser(1);
      await assert.rejects(query("UPDATE auditions SET status='published' WHERE id=$1",[audition]),/上限/);
      await query("SELECT audition_set_pass($1,true,'freshman')",[freshman]);
      await query("SELECT audition_change_status($1,'published')",[audition]);
      const results=await query('SELECT * FROM audition_results_view($1)',[audition]);
      assert.equal(results.length,2);
    });
    await t.test('new RPCs reject anonymous execution and the icon limit matches the UI',async()=>{
      await owner();
      for(const signature of ['audition_entries_view(uuid)','audition_withdraw(uuid)','audition_my_review(uuid)',
        'audition_create_with_previous(text,text,timestamptz,timestamptz,integer,integer,jsonb,uuid)']) {
        assert.equal(await scalar("SELECT has_function_privilege('anon',$1,'EXECUTE')",[signature]),false);
      }
      assert.equal(Number(await scalar("SELECT file_size_limit FROM storage.buckets WHERE id='band-icons'")),2097152);
    });
  } finally { await db.close(); }
});
