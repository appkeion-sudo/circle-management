-- Apply after setup.sql. No user is deleted by applying this migration.
BEGIN;
CREATE TABLE IF NOT EXISTS public.user_deletion_audit (
 operation_id uuid PRIMARY KEY, actor_id uuid NOT NULL, target_id uuid NOT NULL,
 deleted_at timestamptz NOT NULL DEFAULT now()
);
-- Retain numerical votes anonymously, so recalculation cannot change past results
-- merely because an account was removed. No original user ID/name/email is stored.
CREATE TABLE IF NOT EXISTS public.audition_deleted_judges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 audition_id uuid NOT NULL REFERENCES public.auditions ON DELETE CASCADE,
 excluded_entries uuid[] NOT NULL DEFAULT '{}', invalid boolean NOT NULL
);
CREATE TABLE IF NOT EXISTS public.audition_deleted_scores (
 judge_id uuid NOT NULL REFERENCES public.audition_deleted_judges ON DELETE CASCADE,
 entry_id uuid NOT NULL, audition_id uuid NOT NULL, criterion_id uuid NOT NULL, score numeric NOT NULL,
 PRIMARY KEY(judge_id,entry_id,criterion_id),
 FOREIGN KEY(entry_id,audition_id) REFERENCES public.audition_entries(id,audition_id) ON DELETE CASCADE,
 FOREIGN KEY(criterion_id,audition_id) REFERENCES public.audition_criteria(id,audition_id) ON DELETE CASCADE
);
ALTER TABLE public.user_deletion_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audition_deleted_judges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audition_deleted_scores ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_deletion_audit,public.audition_deleted_judges,public.audition_deleted_scores FROM PUBLIC,anon,authenticated;
ALTER TABLE public.ui_notices ALTER COLUMN created_by DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.admin_users_list(p_actor uuid,p_search text DEFAULT '',p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; total bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.site_admins a JOIN auth.users u ON u.id=a.user_id WHERE a.user_id=p_actor) THEN
  RAISE EXCEPTION USING ERRCODE='KA403',MESSAGE='サイト管理者のみ操作できます'; END IF;
 IF p_offset IS NULL OR p_offset<0 OR p_search IS NULL OR length(p_search)>200 THEN RAISE EXCEPTION USING ERRCODE='KA422',MESSAGE='検索条件が不正です'; END IF;
 SELECT count(*) INTO total FROM auth.users u LEFT JOIN public.profiles p ON p.id=u.id
 WHERE strpos(lower(coalesce(p.username,'')),lower(p_search))>0 OR strpos(lower(coalesce(u.email,'')),lower(p_search))>0;
 SELECT coalesce(jsonb_agg(x ORDER BY x.username NULLS LAST,x.id),'[]') INTO result FROM (
  SELECT u.id,coalesce(p.username,'名前未設定') username,u.email,p.admission_year,
   EXISTS(SELECT 1 FROM public.site_admins a WHERE a.user_id=u.id) is_site_admin,
   EXISTS(SELECT 1 FROM public.circle_president c WHERE c.user_id=u.id) is_president,
   coalesce((SELECT jsonb_agg(r.name ORDER BY r.id) FROM public.circle_member_roles mr
    JOIN public.circle_roles r ON r.id=mr.role_id WHERE mr.user_id=u.id),'[]') roles
  FROM auth.users u LEFT JOIN public.profiles p ON p.id=u.id
  WHERE strpos(lower(coalesce(p.username,'')),lower(p_search))>0 OR strpos(lower(coalesce(u.email,'')),lower(p_search))>0
  ORDER BY p.username NULLS LAST,u.id LIMIT 100 OFFSET p_offset
 ) x;
 RETURN jsonb_build_object('users',result,'total',total);
END $$;

CREATE OR REPLACE FUNCTION public.admin_scrub_timetable(p_plan jsonb,p_user uuid)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE people jsonb; items jsonb;
BEGIN
 IF p_plan IS NULL THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(p ORDER BY n),'[]') INTO people
 FROM jsonb_array_elements(coalesce(p_plan->'people','[]')) WITH ORDINALITY AS x(p,n)
 WHERE p->>'id' IS DISTINCT FROM p_user::text;
 SELECT coalesce(jsonb_agg(CASE WHEN it ? 'staff' THEN jsonb_set(it,'{staff}',
  (SELECT coalesce(jsonb_agg(CASE WHEN s=to_jsonb(p_user::text) THEN 'null'::jsonb ELSE s END ORDER BY sn),'[]')
   FROM jsonb_array_elements(coalesce(it->'staff','[]')) WITH ORDINALITY AS a(s,sn))) ELSE it END ORDER BY n),'[]')
 INTO items FROM jsonb_array_elements(coalesce(p_plan->'items','[]')) WITH ORDINALITY AS x(it,n);
 RETURN jsonb_set(jsonb_set(p_plan,'{people}',people),'{items}',items);
END $$;

CREATE OR REPLACE FUNCTION public.admin_user_delete(p_actor uuid,p_target uuid,p_operation uuid,p_confirmation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE prior public.user_deletion_audit; a record; anonymous_id uuid; asset record; col record;
BEGIN
 -- This is a single PostgreSQL transaction, including the actual auth.users DELETE.
 -- No Auth HTTP request or Storage deletion is performed before/after this commit.
 LOCK TABLE public.site_admins IN EXCLUSIVE MODE;
 IF NOT EXISTS(SELECT 1 FROM public.site_admins sa JOIN auth.users u ON u.id=sa.user_id WHERE sa.user_id=p_actor) THEN
  RAISE EXCEPTION USING ERRCODE='KA403',MESSAGE='サイト管理者のみ操作できます'; END IF;
 IF p_actor=p_target THEN RAISE EXCEPTION USING ERRCODE='KA400',MESSAGE='自分自身は削除できません'; END IF;
 IF p_target IS NULL OR p_operation IS NULL OR p_confirmation IS DISTINCT FROM '削除' THEN
  RAISE EXCEPTION USING ERRCODE='KA422',MESSAGE='削除確認が不正です'; END IF;
 SELECT * INTO prior FROM public.user_deletion_audit WHERE operation_id=p_operation;
 IF FOUND THEN
  IF prior.actor_id IS DISTINCT FROM p_actor OR prior.target_id IS DISTINCT FROM p_target THEN
   RAISE EXCEPTION USING ERRCODE='KA422',MESSAGE='操作IDが不正です'; END IF;
  RETURN jsonb_build_object('deleted',true,'replayed',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.site_admins WHERE user_id=p_target) AND (SELECT count(*) FROM public.site_admins)<=1 THEN
  RAISE EXCEPTION USING ERRCODE='KA409',MESSAGE='最後のサイト管理者は削除できません'; END IF;
 PERFORM 1 FROM auth.users WHERE id=p_target FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='KA404',MESSAGE='対象ユーザがありません'; END IF;
 -- Fail closed for production-only dependencies, including ON DELETE CASCADE.
 -- Unknown cascades must not silently remove shared application records.
 IF EXISTS(
  SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
  JOIN pg_namespace n ON n.oid=r.relnamespace
  CROSS JOIN LATERAL unnest(c.conkey) k(attnum)
  JOIN pg_attribute att ON att.attrelid=r.oid AND att.attnum=k.attnum
  WHERE c.contype='f' AND (
   (c.confrelid='public.profiles'::regclass AND n.nspname||'.'||r.relname||'.'||att.attname NOT IN (
    'public.circle_president.user_id','public.bands.created_by','public.band_members.user_id',
    'public.auditions.created_by','public.audition_participants.user_id','public.audition_entries.entered_by',
    'public.audition_scores.judge_id','public.audition_penalties.created_by','public.site_admins.user_id',
    'public.circle_member_roles.user_id','public.admission_year_requests.user_id',
    'public.president_transfers.from_user','public.president_transfers.to_user','public.schedules.user_id',
    'public.audition_entry_members.user_id','public.audition_invalid_votes.judge_id',
    'public.od_timetable_notifications.user_id','public.ui_notices.created_by',
    'public.ui_event_notifications.user_id','public.ui_timetable_reads.user_id'))
   OR (c.confrelid='auth.users'::regclass AND n.nspname<>'auth'
    AND n.nspname||'.'||r.relname||'.'||att.attname NOT IN (
     'public.takoika_bests.user_id','public.profiles.id','storage.objects.owner','storage.objects.owner_id',
     'storage.buckets.owner','storage.buckets.owner_id'))
  )
 ) THEN RAISE EXCEPTION USING ERRCODE='KA412',MESSAGE='未確認のユーザ依存関係があります。DB構造を確認してください'; END IF;
 -- Match timetable/publication lock order; updates waiting on these rows must reread revisions.
 PERFORM 1 FROM public.auditions ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.profiles WHERE id=p_target FOR UPDATE;

 FOR a IN SELECT DISTINCT audition_id FROM public.audition_scores WHERE judge_id=p_target LOOP
  INSERT INTO public.audition_deleted_judges(audition_id,excluded_entries,invalid)
  SELECT a.audition_id,ARRAY(SELECT m.entry_id FROM public.audition_entry_members m
   JOIN public.audition_entries e ON e.id=m.entry_id WHERE m.user_id=p_target AND e.audition_id=a.audition_id),
   EXISTS(SELECT 1 FROM public.audition_invalid_votes iv WHERE iv.audition_id=a.audition_id AND iv.judge_id=p_target)
  RETURNING id INTO anonymous_id;
  INSERT INTO public.audition_deleted_scores(judge_id,entry_id,audition_id,criterion_id,score)
  SELECT anonymous_id,entry_id,audition_id,criterion_id,score FROM public.audition_scores WHERE judge_id=p_target AND audition_id=a.audition_id;
 END LOOP;
 DELETE FROM public.audition_scores WHERE judge_id=p_target;
 DELETE FROM public.audition_invalid_votes WHERE judge_id=p_target;
 DELETE FROM public.audition_entry_members WHERE user_id=p_target;
 DELETE FROM public.audition_participants WHERE user_id=p_target;
 DELETE FROM public.band_members WHERE user_id=p_target;
 DELETE FROM public.schedules WHERE user_id=p_target;
 DELETE FROM public.circle_member_roles WHERE user_id=p_target;
 DELETE FROM public.admission_year_requests WHERE user_id=p_target;
 DELETE FROM public.president_transfers WHERE from_user=p_target OR to_user=p_target;
 DELETE FROM public.od_timetable_notifications WHERE user_id=p_target;
 DELETE FROM public.ui_event_notifications WHERE user_id=p_target;
 DELETE FROM public.ui_timetable_reads WHERE user_id=p_target;
 UPDATE public.circle_president SET user_id=NULL WHERE user_id=p_target;
 UPDATE public.bands SET created_by=NULL WHERE created_by=p_target;
 UPDATE public.auditions SET created_by=NULL WHERE created_by=p_target;
 UPDATE public.audition_entries SET entered_by=NULL WHERE entered_by=p_target;
 UPDATE public.audition_penalties SET created_by=NULL WHERE created_by=p_target;
 UPDATE public.ui_notices SET created_by=NULL WHERE created_by=p_target;
 UPDATE public.od_timetables SET draft=public.admin_scrub_timetable(draft,p_target),
  published=public.admin_scrub_timetable(published,p_target),revision=revision+1
 WHERE draft::text LIKE '%'||p_target::text||'%' OR published::text LIKE '%'||p_target::text||'%';

 -- Shared band icons must survive. Transfer Storage ownership to the executing
 -- administrator, preserving bucket/path and object bytes. Support legacy owner
 -- and current owner_id columns without assuming their types or existence.
 FOR asset IN SELECT unnest(ARRAY['objects','buckets']) AS name LOOP
  FOR col IN SELECT column_name FROM information_schema.columns WHERE table_schema='storage'
   AND table_name=asset.name AND column_name IN ('owner','owner_id') LOOP
   EXECUTE format('UPDATE storage.%I SET %I=%L WHERE %I::text=%L',asset.name,col.column_name,p_actor,col.column_name,p_target);
  END LOOP;
 END LOOP;
 DELETE FROM public.site_admins WHERE user_id=p_target;
 DELETE FROM public.profiles WHERE id=p_target;
 -- Supabase's auth identities/sessions/refresh tokens follow their actual FKs.
 -- Any unexpected restrictive FK or trigger aborts and rolls back ALL above work.
 DELETE FROM auth.users WHERE id=p_target;
 INSERT INTO public.user_deletion_audit(operation_id,actor_id,target_id) VALUES(p_operation,p_actor,p_target);
 RETURN jsonb_build_object('deleted',true,'replayed',false);
EXCEPTION WHEN OTHERS THEN
 RAISE LOG 'admin_user_delete operation=% actor=% target=% SQLSTATE=%',p_operation,p_actor,p_target,SQLSTATE;
 RAISE;
END $$;

REVOKE ALL ON FUNCTION public.admin_users_list(uuid,text,integer),public.admin_user_delete(uuid,uuid,uuid,text),public.admin_scrub_timetable(jsonb,uuid) FROM PUBLIC,anon,authenticated;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT EXECUTE ON FUNCTION public.admin_users_list(uuid,text,integer),public.admin_user_delete(uuid,uuid,uuid,text) TO service_role;
 END IF;
END $$;
-- The finalizer below includes anonymous votes using the same eligibility rules.
CREATE OR REPLACE FUNCTION public.audition_finalize(p_audition_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_status text;
BEGIN
 IF NOT public.is_circle_president() THEN RAISE EXCEPTION '部長のみ操作できます'; END IF;
 SELECT status INTO v_status FROM public.auditions WHERE id=p_audition_id FOR UPDATE;
 IF v_status IS DISTINCT FROM 'closed' THEN RAISE EXCEPTION '採点終了後に集計してください'; END IF;
 WITH all_scores AS (
 SELECT s.entry_id,s.audition_id,s.criterion_id,s.judge_id,s.score FROM public.audition_scores s
 UNION ALL SELECT s.entry_id,s.audition_id,s.criterion_id,s.judge_id,s.score FROM public.audition_deleted_scores s
 ), judges AS (
   SELECT DISTINCT s.judge_id FROM all_scores s WHERE s.audition_id=p_audition_id
 ), required AS (
   SELECT j.judge_id,e.id AS entry_id,c.id AS criterion_id
   FROM judges j JOIN public.audition_entries e ON e.audition_id=p_audition_id
   JOIN public.audition_criteria c ON c.audition_id=p_audition_id
   WHERE NOT EXISTS (SELECT 1 FROM public.audition_entry_members m WHERE m.entry_id=e.id AND m.user_id=j.judge_id)
   AND NOT EXISTS(SELECT 1 FROM public.audition_deleted_judges d WHERE d.id=j.judge_id AND e.id=ANY(d.excluded_entries))
 ), judge_valid AS (
   SELECT j.judge_id,
     NOT EXISTS (SELECT 1 FROM required x LEFT JOIN all_scores s
       ON s.entry_id=x.entry_id AND s.criterion_id=x.criterion_id AND s.judge_id=x.judge_id
       WHERE x.judge_id=j.judge_id AND s.criterion_id IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.audition_invalid_votes iv
       WHERE iv.audition_id=p_audition_id AND iv.judge_id=j.judge_id)
     AND NOT EXISTS(SELECT 1 FROM public.audition_deleted_judges d WHERE d.id=j.judge_id AND d.invalid) AS valid
   FROM judges j
 ), judge_entry AS (
   SELECT s.entry_id,s.judge_id,sum(s.score*c.weight) AS points
   FROM all_scores s JOIN public.audition_criteria c ON c.id=s.criterion_id
   WHERE s.audition_id=p_audition_id GROUP BY s.entry_id,s.judge_id
 ), totals AS (
   SELECT e.id AS entry_id,
     coalesce(avg(je.points) FILTER (WHERE j.valid),0) -
       coalesce((SELECT sum(p.points) FROM public.audition_penalties p WHERE p.entry_id=e.id),0) AS total,
     count(je.judge_id) FILTER (WHERE j.valid) AS valid_votes,
     count(je.judge_id) FILTER (WHERE NOT j.valid) AS invalid_votes
   FROM public.audition_entries e
   LEFT JOIN judge_entry je ON je.entry_id=e.id
   LEFT JOIN judge_valid j ON j.judge_id=je.judge_id
   WHERE e.audition_id=p_audition_id GROUP BY e.id
 ), ranked AS (
   SELECT *,rank() OVER(ORDER BY total DESC) AS overall_rank FROM totals
 )
 INSERT INTO public.audition_results(entry_id,total_score,overall_rank,valid_votes,invalid_votes,calculated_at)
 SELECT entry_id,total,overall_rank,valid_votes,invalid_votes,now() FROM ranked
 ON CONFLICT (entry_id) DO UPDATE SET
   total_score=EXCLUDED.total_score,
   overall_rank=EXCLUDED.overall_rank,
   valid_votes=EXCLUDED.valid_votes,
   invalid_votes=EXCLUDED.invalid_votes,
   calculated_at=EXCLUDED.calculated_at;
END $function$;
COMMIT;
