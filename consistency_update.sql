-- Apply to the existing keion-circle database before deploying the updated JavaScript.
-- One transaction: failed validation/DDL rolls back the complete migration.
BEGIN;

CREATE OR REPLACE FUNCTION public.audition_member_year(
 p_admission_year integer,p_year_override integer,p_reference timestamptz
) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
 SELECT coalesce(p_year_override,
   extract(year FROM p_reference AT TIME ZONE 'Asia/Tokyo')::integer
   - CASE WHEN extract(month FROM p_reference AT TIME ZONE 'Asia/Tokyo')<4 THEN 1 ELSE 0 END
   - p_admission_year + 1);
$$;


CREATE OR REPLACE FUNCTION public.audition_can_withdraw(p_entry_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT auth.uid() IS NOT NULL AND EXISTS (
   SELECT 1 FROM public.audition_entries e
   JOIN public.auditions a ON a.id=e.audition_id
   WHERE e.id=p_entry_id AND a.status='open' AND now()<a.entry_deadline
     AND public.is_band_member(e.band_id)
 );
$$;

CREATE OR REPLACE FUNCTION public.audition_withdraw(p_entry_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_audition_id uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'ログインしてください'; END IF;
 SELECT audition_id INTO v_audition_id FROM public.audition_entries WHERE id=p_entry_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'エントリーが見つかりません'; END IF;
 -- Use the same parent lock as entry and status changes.
 PERFORM 1 FROM public.auditions WHERE id=v_audition_id FOR UPDATE;
 IF NOT public.audition_can_withdraw(p_entry_id) THEN
   RAISE EXCEPTION '受付中・締切前の所属バンドのみ取り消せます';
 END IF;
 DELETE FROM public.audition_entries WHERE id=p_entry_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'エントリーが見つかりません'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.audition_can_withdraw(uuid),public.audition_withdraw(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.audition_can_withdraw(uuid),public.audition_withdraw(uuid) TO authenticated;


-- Only expose entry summaries, not arbitrary bands or their memberships.
CREATE OR REPLACE FUNCTION public.audition_entries_view(p_audition_id uuid)
RETURNS TABLE(id uuid,band_id uuid,band_name text,is_freshman_band boolean,
 can_withdraw boolean,can_score boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'ログインしてください'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.auditions a WHERE a.id=p_audition_id
   AND (a.status<>'draft' OR public.is_circle_president())) THEN
   RAISE EXCEPTION 'このオーディションを閲覧できません';
 END IF;
 RETURN QUERY
 SELECT e.id,e.band_id,b.name,e.is_freshman_band,
   public.audition_can_withdraw(e.id),
   a.status='scoring' AND NOT EXISTS(
     SELECT 1 FROM public.audition_entry_members m WHERE m.entry_id=e.id AND m.user_id=auth.uid())
 FROM public.audition_entries e JOIN public.bands b ON b.id=e.band_id
 JOIN public.auditions a ON a.id=e.audition_id
 WHERE e.audition_id=p_audition_id ORDER BY e.entered_at,e.id;
END $$;

-- Both operations run in the same transaction, including previous-live validation.
CREATE OR REPLACE FUNCTION public.audition_create_with_previous(
 p_title text,p_description text,p_entry_deadline timestamptz,p_scoring_deadline timestamptz,
 p_general_slots integer,p_freshman_slots integer,p_criteria jsonb,p_previous_live_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
 v_id := public.audition_create(p_title,p_description,p_entry_deadline,p_scoring_deadline,
   p_general_slots,p_freshman_slots,p_criteria);
 PERFORM public.audition_set_previous_live(v_id,p_previous_live_id);
 RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.audition_enter(p_audition_id uuid, p_band_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_id uuid; v_fresh boolean; v_deadline timestamptz; v_status text; v_previous uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'ログインしてください'; END IF;
 SELECT a.status,a.entry_deadline,a.previous_live_audition_id INTO v_status,v_deadline,v_previous
 FROM public.auditions a WHERE a.id=p_audition_id FOR UPDATE;
 IF v_status IS DISTINCT FROM 'open' OR v_deadline IS NULL OR now()>=v_deadline THEN RAISE EXCEPTION 'エントリー期間外です'; END IF;
 IF NOT public.is_band_member(p_band_id) THEN RAISE EXCEPTION '所属バンドのみエントリーできます'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.band_members WHERE band_id=p_band_id) THEN RAISE EXCEPTION 'メンバーのいないバンドです'; END IF;
 IF v_previous IS NOT NULL AND EXISTS (
  SELECT 1 FROM public.audition_performed_bands p WHERE p.audition_id=v_previous AND p.band_id=p_band_id
 ) THEN RAISE EXCEPTION '前回ライブに出演した同一バンドIDはエントリーできません'; END IF;
 IF EXISTS (
  SELECT 1 FROM public.audition_entries e
  JOIN public.audition_entry_members m ON m.entry_id=e.id
  JOIN public.band_members bm ON bm.user_id=m.user_id AND bm.band_id=p_band_id
  WHERE e.audition_id=p_audition_id AND e.band_id<>p_band_id
  GROUP BY e.id HAVING count(DISTINCT bm.user_id)>=3
 ) THEN RAISE EXCEPTION '他のエントリーバンドとメンバーが3人以上重複しています'; END IF;
 -- Match the profile's April school year; unknown members are not freshmen.
 SELECT coalesce(bool_and(coalesce(public.audition_member_year(
   p.admission_year, p.year_override, v_deadline
 ) = 1, false)), false)
 INTO v_fresh FROM public.band_members bm LEFT JOIN public.profiles p ON p.id=bm.user_id WHERE bm.band_id=p_band_id;
 INSERT INTO public.audition_entries(audition_id,band_id,entered_by,is_freshman_band)
 VALUES(p_audition_id,p_band_id,auth.uid(),v_fresh)
 ON CONFLICT(audition_id,band_id) DO UPDATE SET band_id=EXCLUDED.band_id RETURNING id INTO v_id;
 DELETE FROM public.audition_entry_members WHERE entry_id=v_id;
 INSERT INTO public.audition_entry_members(entry_id,user_id)
 SELECT v_id,user_id FROM public.band_members WHERE band_id=p_band_id;
 RETURN v_id;
END $function$
;

-- Fix pending entries only. Preserve the classification of auditions already being scored/published.
UPDATE public.audition_entries e SET is_freshman_band=(
 SELECT coalesce(bool_and(coalesce(public.audition_member_year(
   p.admission_year,p.year_override,a.entry_deadline)=1,false)),false)
 FROM public.audition_entry_members m LEFT JOIN public.profiles p ON p.id=m.user_id
 WHERE m.entry_id=e.id
)
FROM public.auditions a
WHERE a.id=e.audition_id AND a.status IN ('draft','open');

-- Return only the caller's own review. Direct score-table access remains revoked.
CREATE OR REPLACE FUNCTION public.audition_my_review(p_entry_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_review jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'ログインしてください'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audition_entries e JOIN public.auditions a ON a.id=e.audition_id
   WHERE e.id=p_entry_id AND a.status='scoring') THEN RAISE EXCEPTION '採点期間外です'; END IF;
 IF EXISTS(SELECT 1 FROM public.audition_entry_members m
   WHERE m.entry_id=p_entry_id AND m.user_id=auth.uid()) THEN
   RAISE EXCEPTION '自分のバンドは採点できません';
 END IF;
 SELECT jsonb_build_object(
   'scores',coalesce(jsonb_object_agg(s.criterion_id::text,s.score),'{}'::jsonb),
   'comment',max(s.comment))
 INTO v_review FROM public.audition_scores s
 WHERE s.entry_id=p_entry_id AND s.judge_id=auth.uid();
 RETURN v_review;
END $$;

CREATE OR REPLACE FUNCTION public.audition_set_pass(p_entry_id uuid,p_passed boolean,p_category text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_a public.auditions%rowtype; v_fresh boolean; v_count integer; v_limit integer;
BEGIN
 IF NOT public.is_circle_president() THEN RAISE EXCEPTION '部長のみ操作できます'; END IF;
 -- Serialize decisions within an audition to prevent concurrent quota overruns.
 SELECT a.* INTO v_a FROM public.auditions a JOIN public.audition_entries e ON e.audition_id=a.id
 WHERE e.id=p_entry_id FOR UPDATE OF a;
 IF NOT FOUND OR v_a.status IS DISTINCT FROM 'closed' OR NOT EXISTS(
   SELECT 1 FROM public.audition_results WHERE entry_id=p_entry_id) THEN
   RAISE EXCEPTION '公開前の集計済み結果のみ変更できます';
 END IF;
 IF p_passed IS NULL THEN RAISE EXCEPTION '合否を選択してください'; END IF;
 IF p_passed THEN
   IF p_category IS NULL OR p_category NOT IN ('general','freshman') THEN
     RAISE EXCEPTION '合格枠が不正です';
   END IF;
   SELECT is_freshman_band INTO v_fresh FROM public.audition_entries WHERE id=p_entry_id;
   IF p_category='freshman' AND v_fresh IS DISTINCT FROM true THEN
     RAISE EXCEPTION '1年生バンドのみ1年生枠に合格できます';
   END IF;
   v_limit := CASE WHEN p_category='freshman' THEN v_a.freshman_slots ELSE v_a.general_slots END;
   SELECT count(*) INTO v_count FROM public.audition_results r
   JOIN public.audition_entries e ON e.id=r.entry_id
   WHERE e.audition_id=v_a.id AND r.entry_id<>p_entry_id AND r.passed AND r.result_category=p_category;
   IF v_count>=v_limit THEN RAISE EXCEPTION '合格枠の上限を超えています'; END IF;
 END IF;
 UPDATE public.audition_results SET passed=p_passed,
   result_category=CASE WHEN p_passed THEN p_category ELSE NULL END WHERE entry_id=p_entry_id;
END $$;

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
 WITH judges AS (
   SELECT DISTINCT s.judge_id FROM public.audition_scores s WHERE s.audition_id=p_audition_id
 ), required AS (
   SELECT j.judge_id,e.id AS entry_id,c.id AS criterion_id
   FROM judges j JOIN public.audition_entries e ON e.audition_id=p_audition_id
   JOIN public.audition_criteria c ON c.audition_id=p_audition_id
   WHERE NOT EXISTS (SELECT 1 FROM public.audition_entry_members m WHERE m.entry_id=e.id AND m.user_id=j.judge_id)
 ), judge_valid AS (
   SELECT j.judge_id,
     NOT EXISTS (SELECT 1 FROM required x LEFT JOIN public.audition_scores s
       ON s.entry_id=x.entry_id AND s.criterion_id=x.criterion_id AND s.judge_id=x.judge_id
       WHERE x.judge_id=j.judge_id AND s.id IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.audition_invalid_votes iv
       WHERE iv.audition_id=p_audition_id AND iv.judge_id=j.judge_id) AS valid
   FROM judges j
 ), judge_entry AS (
   SELECT s.entry_id,s.judge_id,sum(s.score*c.weight) AS points
   FROM public.audition_scores s JOIN public.audition_criteria c ON c.id=s.criterion_id
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
END $function$
;

-- Recheck all results when publishing, including decisions saved before this migration.
CREATE OR REPLACE FUNCTION public.audition_validate_publication()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NEW.status='published' AND OLD.status IS DISTINCT FROM 'published' THEN
   IF NOT EXISTS(SELECT 1 FROM public.audition_entries WHERE audition_id=NEW.id) OR EXISTS(
     SELECT 1 FROM public.audition_entries e LEFT JOIN public.audition_results r ON r.entry_id=e.id
     WHERE e.audition_id=NEW.id AND (r.entry_id IS NULL OR r.passed IS NULL)) THEN
     RAISE EXCEPTION '全バンドを集計し、合否を決定してください';
   END IF;
   IF EXISTS(
     SELECT 1 FROM public.audition_results r JOIN public.audition_entries e ON e.id=r.entry_id
     WHERE e.audition_id=NEW.id AND r.passed AND
       (r.result_category IS NULL OR r.result_category NOT IN ('general','freshman')
        OR (r.result_category='freshman' AND e.is_freshman_band IS DISTINCT FROM true))) THEN
     RAISE EXCEPTION '合格区分または1年生枠の資格を確認してください';
   END IF;
   IF (SELECT count(*) FROM public.audition_results r JOIN public.audition_entries e ON e.id=r.entry_id
       WHERE e.audition_id=NEW.id AND r.passed AND r.result_category='general')>NEW.general_slots
   OR (SELECT count(*) FROM public.audition_results r JOIN public.audition_entries e ON e.id=r.entry_id
       WHERE e.audition_id=NEW.id AND r.passed AND r.result_category='freshman')>NEW.freshman_slots THEN
     RAISE EXCEPTION '合格枠の上限を超えています';
   END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS audition_validate_publication_trigger ON public.auditions;
CREATE TRIGGER audition_validate_publication_trigger BEFORE UPDATE OF status ON public.auditions
FOR EACH ROW EXECUTE FUNCTION public.audition_validate_publication();

-- The existing icon bucket is public; align its upload limit with the 2 MiB UI.
UPDATE storage.buckets SET file_size_limit=2097152
WHERE id='band-icons';

REVOKE ALL ON FUNCTION public.audition_member_year(integer,integer,timestamptz),
 public.audition_entries_view(uuid),
 public.audition_create_with_previous(text,text,timestamptz,timestamptz,integer,integer,jsonb,uuid),
 public.audition_my_review(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.audition_member_year(integer,integer,timestamptz),
 public.audition_entries_view(uuid),
 public.audition_create_with_previous(text,text,timestamptz,timestamptz,integer,integer,jsonb,uuid),
 public.audition_my_review(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.audition_validate_publication() FROM PUBLIC,anon,authenticated;
COMMIT;

