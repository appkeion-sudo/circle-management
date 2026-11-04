-- Apply after consistency_update.sql. No service-role key is used in the browser.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.circle_members_admin()') IS NULL OR to_regprocedure('public.circle_roles_list()') IS NULL
  OR to_regprocedure('public.audition_member_year(integer,integer,timestamp with time zone)') IS NULL THEN
  RAISE EXCEPTION '既存のプロフィール・役職RPCとconsistency_update.sqlを先に適用してください';
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.audition_timetable_sources (
 audition_id uuid PRIMARY KEY REFERENCES public.auditions ON DELETE CASCADE,
 entry_order uuid[] NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.audition_availability (
 entry_id uuid PRIMARY KEY REFERENCES public.audition_entries ON DELETE CASCADE,
 windows jsonb NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS public.od_timetables (
 audition_id uuid PRIMARY KEY REFERENCES public.auditions ON DELETE CASCADE,
 event_date date NOT NULL, draft jsonb NOT NULL, published jsonb,
 revision integer NOT NULL DEFAULT 1, publication integer NOT NULL DEFAULT 0,
 published_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.od_staff_role_settings (
 role_id bigint PRIMARY KEY, excluded boolean NOT NULL
);
CREATE TABLE IF NOT EXISTS public.od_publication_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), audition_id uuid NOT NULL REFERENCES public.auditions ON DELETE CASCADE,
 publication integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(audition_id,publication)
);
CREATE TABLE IF NOT EXISTS public.od_timetable_notifications (
 event_id uuid REFERENCES public.od_publication_events ON DELETE CASCADE,
 user_id uuid REFERENCES public.profiles ON DELETE CASCADE, message text NOT NULL,
 before_schedule jsonb, after_schedule jsonb NOT NULL, PRIMARY KEY(event_id,user_id)
);
ALTER TABLE public.audition_timetable_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audition_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.od_timetables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.od_staff_role_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.od_publication_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.od_timetable_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audition_timetable_sources,public.audition_availability,public.od_timetables,
 public.od_staff_role_settings,public.od_publication_events,public.od_timetable_notifications FROM anon,authenticated;

-- This adapter uses existing role/member RPCs rather than assuming their backing table names.
CREATE OR REPLACE FUNCTION public.od_timetable_people(p_audition_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; members jsonb; roles jsonb;
BEGIN
 IF NOT public.is_circle_president() THEN RAISE EXCEPTION '部長のみ操作できます'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(m)),'[]') INTO members FROM public.circle_members_admin() m;
 SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') INTO roles FROM public.circle_roles_list() r;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',p.id,'name',coalesce(p.username,'名前未設定'),
  'year',public.audition_member_year(p.admission_year,p.year_override,now()),
  'registered',EXISTS(SELECT 1 FROM public.audition_participants ap WHERE ap.audition_id=p_audition_id AND ap.user_id=p.id),
  'excluded',EXISTS(SELECT 1 FROM public.circle_president cp WHERE cp.user_id=p.id) OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(members) m, jsonb_array_elements(roles) r
   LEFT JOIN public.od_staff_role_settings s ON s.role_id=(r->>'id')::bigint
   WHERE m->>'user_id'=p.id::text AND coalesce(m->'role_ids','[]') @> jsonb_build_array((r->>'id')::bigint)
   AND coalesce(s.excluded,coalesce((r->>'exclude_from_staff_auto_assign')::boolean,false) OR (r->>'name') IN ('幹部','部長'))),
  'entries',coalesce((SELECT jsonb_agg(em.entry_id) FROM public.audition_entry_members em
    JOIN public.audition_entries e ON e.id=em.entry_id WHERE e.audition_id=p_audition_id AND em.user_id=p.id),'[]')
 )),'[]') INTO result FROM public.profiles p;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.audition_confirm_order(p_audition_id uuid,p_entries uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE deadline timestamptz;
BEGIN
 IF NOT public.is_circle_president() THEN RAISE EXCEPTION '部長のみ操作できます'; END IF;
 SELECT entry_deadline INTO deadline FROM public.auditions WHERE id=p_audition_id FOR UPDATE;
 IF deadline IS NULL OR now()<deadline THEN RAISE EXCEPTION 'エントリー締切後に確定してください'; END IF;
 IF EXISTS(SELECT 1 FROM public.od_timetables WHERE audition_id=p_audition_id) THEN RAISE EXCEPTION '生成済みのため演奏順は変更できません'; END IF;
 IF coalesce(cardinality(p_entries),0)=0 OR
  cardinality(p_entries)<>(SELECT count(DISTINCT x) FROM unnest(p_entries) x) OR
  cardinality(p_entries)<>(SELECT count(*) FROM public.audition_entries WHERE audition_id=p_audition_id) OR
  EXISTS(SELECT 1 FROM unnest(p_entries) x WHERE NOT EXISTS(SELECT 1 FROM public.audition_entries WHERE id=x AND audition_id=p_audition_id))
 THEN RAISE EXCEPTION '全エントリーを重複なく指定してください'; END IF;
 INSERT INTO public.audition_timetable_sources(audition_id,entry_order) VALUES(p_audition_id,p_entries)
 ON CONFLICT(audition_id) DO UPDATE SET entry_order=EXCLUDED.entry_order,confirmed_at=now();
END $$;

CREATE OR REPLACE FUNCTION public.audition_set_availability(p_entry_id uuid,p_windows jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE aid uuid; w jsonb;
BEGIN
 SELECT audition_id INTO aid FROM public.audition_entries WHERE id=p_entry_id;
 PERFORM 1 FROM public.auditions WHERE id=aid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION '対象がありません'; END IF;
 IF NOT public.is_circle_president() AND NOT EXISTS(
  SELECT 1 FROM public.audition_entries e JOIN public.band_members bm ON bm.band_id=e.band_id
  JOIN public.auditions a ON a.id=e.audition_id
  WHERE e.id=p_entry_id AND bm.user_id=auth.uid() AND a.status='open' AND now()<a.entry_deadline
 ) THEN RAISE EXCEPTION '出演可能時間帯の変更権限がありません'; END IF;
 IF EXISTS(SELECT 1 FROM public.od_timetables WHERE audition_id=aid) THEN RAISE EXCEPTION '生成後は申告時間帯を変更できません'; END IF;
 IF jsonb_typeof(p_windows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION '時間帯が不正です'; END IF;
 FOR w IN SELECT value FROM jsonb_array_elements(p_windows) LOOP
  IF jsonb_typeof(w) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION '時間帯が不正です'; END IF;
  IF jsonb_array_length(w)<>2 OR
   (w->>0)::integer<0 OR (w->>1)::integer<=(w->>0)::integer OR (w->>1)::integer>100000
   OR jsonb_typeof(w->0) IS DISTINCT FROM 'number' OR jsonb_typeof(w->1) IS DISTINCT FROM 'number'
   OR (w->>0)::numeric<>trunc((w->>0)::numeric) OR (w->>1)::numeric<>trunc((w->>1)::numeric)
  THEN RAISE EXCEPTION '時間帯が不正です'; END IF;
 END LOOP;
 INSERT INTO public.audition_availability VALUES(p_entry_id,p_windows)
 ON CONFLICT(entry_id) DO UPDATE SET windows=EXCLUDED.windows;
END $$;

CREATE OR REPLACE FUNCTION public.od_timetable_context(p_audition_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE t public.od_timetables; chief boolean:=public.is_circle_president(); result jsonb; roles jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.auditions WHERE id=p_audition_id AND (status<>'draft' OR chief)) THEN RAISE EXCEPTION '閲覧できません'; END IF;
 SELECT * INTO t FROM public.od_timetables WHERE audition_id=p_audition_id;
 result:=jsonb_build_object('president',chief,'published',t.published,'publication',t.publication,
  'revision',t.revision,'archived',t.event_date<(now() AT TIME ZONE 'Asia/Tokyo')::date,
  'has_timetable',t.audition_id IS NOT NULL,
  'availability',(SELECT coalesce(jsonb_agg(jsonb_build_object('entry',e.id,'windows',coalesce(av.windows,'[]'))),'[]')
   FROM public.audition_entries e LEFT JOIN public.audition_availability av ON av.entry_id=e.id WHERE e.audition_id=p_audition_id
   AND (chief OR EXISTS(SELECT 1 FROM public.band_members bm WHERE bm.band_id=e.band_id AND bm.user_id=auth.uid()))),
  'registered',EXISTS(SELECT 1 FROM public.audition_participants WHERE audition_id=p_audition_id AND user_id=auth.uid()));
 IF chief THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('excluded',coalesce(s.excluded,coalesce(r.exclude_from_staff_auto_assign,false) OR r.name IN ('部長','幹部')))),'[]')
  INTO roles FROM public.circle_roles_list() r LEFT JOIN public.od_staff_role_settings s ON s.role_id=r.id;
  result:=result||jsonb_build_object('draft',t.draft,'people',public.od_timetable_people(p_audition_id),'roles',roles,
   'order',(SELECT to_jsonb(entry_order) FROM public.audition_timetable_sources WHERE audition_id=p_audition_id),
   'entries',(SELECT coalesce(jsonb_agg(jsonb_build_object('entry',e.id,'name',b.name,'available',coalesce(av.windows,'[]')) ORDER BY e.entered_at,e.id),'[]')
    FROM public.audition_entries e JOIN public.bands b ON b.id=e.band_id LEFT JOIN public.audition_availability av ON av.entry_id=e.id WHERE e.audition_id=p_audition_id));
 END IF;
 RETURN result;
END $$;

-- Validate and canonicalize the submitted snapshot. Identity, order, availability and
-- eligibility always come from the server; only durations, breaks and staff are editable.
CREATE OR REPLACE FUNCTION public.od_timetable_validate(p_audition_id uuid,p_plan jsonb,p_allow_exceptions boolean,p_automatic boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE ord uuid[]; people jsonb; item jsonb; canonical jsonb; items jsonb:='[]';
 i integer:=0; n integer; minute integer; duration integer; pid text; person jsonb; partner jsonb;
 staff jsonb; j integer; violation boolean; entryid uuid; bandname text; windows jsonb;
BEGIN
 IF NOT public.is_circle_president() THEN RAISE EXCEPTION '部長のみ操作できます'; END IF;
 SELECT entry_order INTO ord FROM public.audition_timetable_sources WHERE audition_id=p_audition_id;
 people:=public.od_timetable_people(p_audition_id);
 IF p_plan->>'staff_scope' IS DISTINCT FROM 'band' THEN RAISE EXCEPTION 'バンド単位の係割り当てに更新されています。画面を再読み込みしてください'; END IF;
 IF jsonb_typeof(p_plan->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_plan->'items')<>cardinality(ord)*2-1 THEN RAISE EXCEPTION '演奏順・行数が不正です'; END IF;
 FOREACH pid IN ARRAY ARRAY['pa','gather','start'] LOOP
  IF jsonb_typeof(p_plan->pid) IS DISTINCT FROM 'number' OR (p_plan->>pid)::numeric<>trunc((p_plan->>pid)::numeric)
   OR (p_plan->>pid)::integer<0 OR (p_plan->>pid)::integer>=1440 THEN RAISE EXCEPTION '集合・開始時刻が不正です'; END IF;
 END LOOP;
 minute:=(p_plan->>'start')::integer;
 FOR item IN SELECT value FROM jsonb_array_elements(p_plan->'items') LOOP
  IF jsonb_typeof(item->'minutes') IS DISTINCT FROM 'number' OR (item->>'minutes')::numeric<>trunc((item->>'minutes')::numeric)
   OR (item->>'minutes')::integer<=0 THEN RAISE EXCEPTION '所要時間は正の整数で入力してください'; END IF;
  duration:=(item->>'minutes')::integer;
  IF i%2=0 THEN
   entryid:=ord[i/2+1];
   IF item->>'kind' IS DISTINCT FROM 'performance' OR item->>'entry' IS DISTINCT FROM entryid::text THEN RAISE EXCEPTION '確定演奏順は変更できません'; END IF;
   SELECT b.name,coalesce(av.windows,'[]') INTO bandname,windows FROM public.audition_entries e JOIN public.bands b ON b.id=e.band_id
    LEFT JOIN public.audition_availability av ON av.entry_id=e.id WHERE e.id=entryid AND e.audition_id=p_audition_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'エントリーが変更されています'; END IF;
   IF jsonb_array_length(windows)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(windows) w WHERE (w->>0)::integer<=minute AND minute+duration<=(w->>1)::integer)
    AND NOT coalesce(p_allow_exceptions,false) THEN RAISE EXCEPTION '出演可能時間帯外です。警告を確認してください'; END IF;
   staff:=item->'staff';
    IF jsonb_typeof(staff) IS DISTINCT FROM 'array' OR jsonb_array_length(staff)<>4 THEN RAISE EXCEPTION '係は4枠必要です'; END IF;
    FOR j IN 0..3 LOOP
     pid:=staff->>j;
     IF pid IS NULL THEN CONTINUE; END IF;
     SELECT value INTO person FROM jsonb_array_elements(people) WHERE value->>'id'=pid;
     IF person IS NULL THEN RAISE EXCEPTION '担当者が存在しません'; END IF;
     SELECT value INTO partner FROM jsonb_array_elements(people) WHERE value->>'id'=staff->>(j # 1);
     violation:=NOT (person->>'registered')::boolean OR (person->>'excluded')::boolean OR jsonb_array_length(person->'entries')=0
      OR person->'entries' ? entryid::text
      OR (p_plan->'items'->(i-1)->>'kind'='transition' AND person->'entries' ? ord[i/2]::text)
      OR (p_plan->'items'->(i+1)->>'kind'='transition' AND person->'entries' ? ord[i/2+2]::text)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(staff) WITH ORDINALITY s(v,k) WHERE v=pid AND k<>j+1)
      OR ((person->>'year')::integer=1 AND (partner->>'year')::integer=1);
     IF coalesce(violation,false) AND (coalesce(p_automatic,false) OR NOT coalesce(p_allow_exceptions,false)) THEN RAISE EXCEPTION '係の条件違反があります。例外として保存する確認が必要です'; END IF;
    END LOOP;
   canonical:=jsonb_build_object('kind','performance','entry',entryid,'name',bandname,'available',windows,'minutes',duration,'staff',staff);
  ELSE
   IF item->>'kind' NOT IN ('transition','break') OR item->>'kind' IS NULL THEN RAISE EXCEPTION '転換・休憩が不正です'; END IF;
   canonical:=jsonb_build_object('kind',item->>'kind','minutes',duration,'staff','[]'::jsonb);
  END IF;
  items:=items||jsonb_build_array(canonical); minute:=minute+duration; i:=i+1;
 END LOOP;
 RETURN jsonb_build_object('staff_scope','band','date',p_plan->>'date','pa',(p_plan->>'pa')::integer,'gather',(p_plan->>'gather')::integer,
  'start',(p_plan->>'start')::integer,'items',items,'people',people);
END $$;

CREATE OR REPLACE FUNCTION public.od_person_schedule(p_plan jsonb,p_user uuid)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE result jsonb:='[]'; item jsonb; person jsonb; minute integer; j integer;
BEGIN
 IF p_plan IS NULL THEN RETURN result; END IF;
 SELECT value INTO person FROM jsonb_array_elements(p_plan->'people') WHERE value->>'id'=p_user::text;
 minute:=(p_plan->>'start')::integer;
 FOR item IN SELECT value FROM jsonb_array_elements(p_plan->'items') LOOP
  IF item->>'kind'='performance' AND person->'entries' ? (item->>'entry') THEN
   result:=result||jsonb_build_array(jsonb_build_object('role',item->>'name','start',minute,'end',minute+(item->>'minutes')::integer));
  END IF;
  IF item->>'kind'=(CASE WHEN p_plan->>'staff_scope'='band' THEN 'performance' ELSE 'transition' END) THEN
   FOR j IN 0..3 LOOP
    IF item->'staff'->>j=p_user::text THEN result:=result||jsonb_build_array(jsonb_build_object('role',
     CASE WHEN j<2 THEN 'ローディー' ELSE 'タイムキーパー' END || CASE WHEN p_plan->>'staff_scope'='band' THEN '（'||(item->>'name')||'）' ELSE '' END,
     'start',minute,'end',minute+(item->>'minutes')::integer)); END IF;
   END LOOP;
  END IF;
  minute:=minute+(item->>'minutes')::integer;
 END LOOP;
 RETURN jsonb_build_object('date',p_plan->>'date','pa',p_plan->'pa','gather',p_plan->'gather','schedule',result);
END $$;

CREATE OR REPLACE FUNCTION public.od_timetable_save(p_audition_id uuid,p_plan jsonb,p_revision integer,p_publish boolean DEFAULT false,p_allow_exceptions boolean DEFAULT false,p_automatic boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t public.od_timetables; plan jsonb; datevalue date; deadline timestamptz; ord uuid[]; eid uuid; u record; beforevalue jsonb; aftervalue jsonb;
BEGIN
 IF NOT public.is_circle_president() THEN RAISE EXCEPTION '部長のみ操作できます'; END IF;
 -- All related mutations take the audition lock first, preventing publication races.
 SELECT entry_deadline INTO deadline FROM public.auditions WHERE id=p_audition_id FOR UPDATE;
 IF deadline IS NULL OR now()<deadline THEN RAISE EXCEPTION 'エントリー締切後に生成できます'; END IF;
 SELECT entry_order INTO ord FROM public.audition_timetable_sources WHERE audition_id=p_audition_id;
 IF ord IS NULL THEN RAISE EXCEPTION 'OD側で演奏順を確定してください'; END IF;
 SELECT * INTO t FROM public.od_timetables WHERE audition_id=p_audition_id FOR UPDATE;
 IF t.event_date<(now() AT TIME ZONE 'Asia/Tokyo')::date THEN RAISE EXCEPTION '過去ODは編集できません'; END IF;
 IF coalesce(t.revision,0) IS DISTINCT FROM p_revision THEN RAISE EXCEPTION '他の操作で更新されました。再読み込みしてください'; END IF;
 datevalue:=(p_plan->>'date')::date;
 IF datevalue IS NULL OR datevalue<(now() AT TIME ZONE 'Asia/Tokyo')::date THEN RAISE EXCEPTION '開催日は本日以降を指定してください'; END IF;
 plan:=public.od_timetable_validate(p_audition_id,p_plan,p_allow_exceptions,p_automatic);
 IF t.audition_id IS NULL AND (jsonb_array_length(plan->'items')<>(SELECT count(*)*2-1 FROM public.audition_entries WHERE audition_id=p_audition_id)) THEN RAISE EXCEPTION '確定演奏順が古くなっています'; END IF;
 INSERT INTO public.od_timetables(audition_id,event_date,draft,revision) VALUES(p_audition_id,datevalue,plan,1)
 ON CONFLICT(audition_id) DO UPDATE SET event_date=datevalue,draft=plan,revision=public.od_timetables.revision+1;
 IF coalesce(p_publish,false) THEN
  INSERT INTO public.od_publication_events(audition_id,publication) VALUES(p_audition_id,coalesce(t.publication,0)+1) RETURNING id INTO eid;
  FOR u IN SELECT id FROM public.profiles WHERE member_status='active' OR id IN (
   SELECT (s.pid #>> '{}')::uuid FROM jsonb_array_elements(coalesce(t.published->'items','[]')) it,
    LATERAL jsonb_array_elements(coalesce(it->'staff','[]')) s(pid) WHERE s.pid<>'null'::jsonb)
   OR id IN (SELECT (p->>'id')::uuid FROM jsonb_array_elements(coalesce(t.published->'people','[]')) p WHERE jsonb_array_length(p->'entries')>0)
   OR id IN (SELECT (p->>'id')::uuid FROM jsonb_array_elements(plan->'people') p WHERE jsonb_array_length(p->'entries')>0)
   OR id IN (SELECT (s.pid #>> '{}')::uuid FROM jsonb_array_elements(plan->'items') it,
    LATERAL jsonb_array_elements(coalesce(it->'staff','[]')) s(pid) WHERE s.pid<>'null'::jsonb)
  LOOP
   beforevalue:=public.od_person_schedule(t.published,u.id); aftervalue:=public.od_person_schedule(plan,u.id);
   INSERT INTO public.od_timetable_notifications(event_id,user_id,message,before_schedule,after_schedule)
   VALUES(eid,u.id,CASE WHEN t.published IS NULL THEN 'ODタイムテーブルが公開されました。' WHEN beforevalue IS DISTINCT FROM aftervalue THEN 'ODタイムテーブルが再公開され、あなたの予定に変更があります。' ELSE 'ODタイムテーブルが再公開されました。' END,beforevalue,aftervalue);
  END LOOP;
  -- Public snapshots contain identities needed to read the table, not private eligibility data.
  SELECT jsonb_set(plan,'{people}',coalesce(jsonb_agg(jsonb_build_object('id',p->'id','name',p->'name','entries',p->'entries')),'[]')) INTO plan
   FROM jsonb_array_elements(plan->'people') p WHERE jsonb_array_length(p->'entries')>0 OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(plan->'items') it WHERE it->'staff' ? (p->>'id'));
  UPDATE public.od_timetables SET published=plan,publication=coalesce(t.publication,0)+1,published_at=now() WHERE audition_id=p_audition_id;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.od_set_role_exclusion(p_role_id bigint,p_excluded boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT public.is_circle_president() THEN RAISE EXCEPTION '部長のみ操作できます'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.circle_roles_list() r WHERE r.id=p_role_id) THEN RAISE EXCEPTION '役職がありません'; END IF;
 IF p_excluded IS NULL THEN RAISE EXCEPTION '対象外設定が不正です'; END IF;
 INSERT INTO public.od_staff_role_settings VALUES(p_role_id,p_excluded) ON CONFLICT(role_id) DO UPDATE SET excluded=EXCLUDED.excluded;
END $$;

CREATE OR REPLACE FUNCTION public.od_timetable_participation(p_audition_id uuid,p_user_id uuid,p_registered boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t public.od_timetables; item jsonb; items jsonb:='[]'; staff jsonb; pid jsonb;
BEGIN
 PERFORM 1 FROM public.auditions WHERE id=p_audition_id AND status<>'draft' FOR UPDATE;
 IF NOT FOUND OR auth.uid() IS NULL THEN RAISE EXCEPTION '操作できません'; END IF;
 SELECT * INTO t FROM public.od_timetables WHERE audition_id=p_audition_id FOR UPDATE;
 IF t.event_date<(now() AT TIME ZONE 'Asia/Tokyo')::date THEN RAISE EXCEPTION '過去ODは変更できません'; END IF;
 IF NOT public.is_circle_president() AND (p_user_id IS DISTINCT FROM auth.uid() OR (NOT coalesce(p_registered,false) AND t.published IS NOT NULL)) THEN RAISE EXCEPTION '公開後の参加取消は部長のみ操作できます'; END IF;
 IF p_registered THEN
  IF NOT EXISTS(SELECT 1 FROM public.auditions WHERE id=p_audition_id AND status='open' AND now()<entry_deadline) THEN RAISE EXCEPTION '参加登録期間外です'; END IF;
  INSERT INTO public.audition_participants VALUES(p_audition_id,p_user_id) ON CONFLICT DO NOTHING;
 ELSE
  DELETE FROM public.audition_participants WHERE audition_id=p_audition_id AND user_id=p_user_id;
 END IF;
END $$;

-- Also cover cancellation from any existing privileged code path.
CREATE OR REPLACE FUNCTION public.od_participant_deleted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t public.od_timetables; item jsonb; items jsonb:='[]'; staff jsonb; pid jsonb;
BEGIN
 SELECT * INTO t FROM public.od_timetables WHERE audition_id=OLD.audition_id FOR UPDATE;
 IF t.audition_id IS NULL THEN RETURN OLD; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(t.draft->'items') LOOP
  IF jsonb_typeof(item->'staff')='array' THEN
   staff:='[]';
   FOR pid IN SELECT value FROM jsonb_array_elements(item->'staff') LOOP
    staff:=staff||jsonb_build_array(CASE WHEN pid #>> '{}' = OLD.user_id::text THEN 'null'::jsonb ELSE pid END);
   END LOOP;
   item:=jsonb_set(item,'{staff}',staff);
  END IF;
  items:=items||jsonb_build_array(item);
 END LOOP;
 UPDATE public.od_timetables SET draft=jsonb_set(draft,'{items}',items),revision=revision+1 WHERE audition_id=OLD.audition_id;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS od_participant_deleted ON public.audition_participants;
CREATE TRIGGER od_participant_deleted AFTER DELETE ON public.audition_participants FOR EACH ROW EXECUTE FUNCTION public.od_participant_deleted();
-- No direct DML bypass of publication cancellation restrictions.
REVOKE INSERT,UPDATE,DELETE ON public.audition_participants FROM authenticated,anon;

CREATE OR REPLACE FUNCTION public.od_preserve_archive()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.od_timetables WHERE audition_id=OLD.id AND published IS NOT NULL
  AND event_date<(now() AT TIME ZONE 'Asia/Tokyo')::date) THEN RAISE EXCEPTION '過去ODの公開タイムテーブルは保存されるため削除できません'; END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS od_preserve_archive ON public.auditions;
CREATE TRIGGER od_preserve_archive BEFORE DELETE ON public.auditions FOR EACH ROW EXECUTE FUNCTION public.od_preserve_archive();

CREATE OR REPLACE FUNCTION public.od_timetable_inbox()
RETURNS TABLE(event_id uuid,audition_id uuid,title text,message text,before_schedule jsonb,after_schedule jsonb,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT e.id,e.audition_id,a.title,n.message,n.before_schedule,n.after_schedule,e.created_at
 FROM public.od_timetable_notifications n JOIN public.od_publication_events e ON e.id=n.event_id
 JOIN public.auditions a ON a.id=e.audition_id WHERE n.user_id=auth.uid() ORDER BY e.created_at DESC LIMIT 100;
$$;

-- Restrict every new RPC, including helper functions, explicitly.
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('od_timetable_people','audition_confirm_order','audition_set_availability','od_timetable_context','od_timetable_validate','od_person_schedule','od_timetable_save','od_set_role_exclusion','od_timetable_participation','od_participant_deleted','od_timetable_inbox','od_preserve_archive') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
  IF f.signature::text NOT LIKE 'od_person_schedule(%' AND f.signature::text NOT LIKE 'od_participant_deleted(%' AND f.signature::text NOT LIKE 'od_preserve_archive(%' THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f.signature);
  END IF;
 END LOOP;
END $$;
COMMIT;
