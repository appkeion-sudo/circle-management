-- Apply after setup.sql, update.sql and entry_rules_update.sql.
BEGIN;
ALTER TABLE public.auditions ADD COLUMN IF NOT EXISTS previous_live_audition_id uuid REFERENCES public.auditions(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS public.audition_performed_bands (
 audition_id uuid NOT NULL REFERENCES public.auditions(id) ON DELETE CASCADE,
 band_id uuid NOT NULL REFERENCES public.bands(id),
 PRIMARY KEY(audition_id,band_id)
);
ALTER TABLE public.audition_performed_bands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audition_performed_bands FROM PUBLIC,anon,authenticated;

-- The president records actual performers, independently of entry records.
CREATE OR REPLACE FUNCTION public.audition_set_performed(p_audition_id uuid,p_band_id uuid,p_performed boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NOT public.is_circle_president() THEN RAISE EXCEPTION '部長のみ操作できます'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.auditions WHERE id=p_audition_id AND status='published') THEN
  RAISE EXCEPTION '結果公開済みのライブのみ出演履歴を登録できます'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audition_entries WHERE audition_id=p_audition_id AND band_id=p_band_id) THEN
  RAISE EXCEPTION 'このライブにエントリーしていないバンドです'; END IF;
 IF EXISTS(SELECT 1 FROM public.auditions WHERE previous_live_audition_id=p_audition_id AND status<>'draft') THEN
  RAISE EXCEPTION 'この出演履歴は既に次のオーディションの判定に使われています。変更できません'; END IF;
 IF p_performed THEN
  INSERT INTO public.audition_performed_bands(audition_id,band_id) VALUES(p_audition_id,p_band_id) ON CONFLICT DO NOTHING;
 ELSE
  DELETE FROM public.audition_performed_bands WHERE audition_id=p_audition_id AND band_id=p_band_id;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.audition_performed_list(p_audition_id uuid)
RETURNS TABLE(band_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NOT public.is_circle_president() THEN RAISE EXCEPTION '部長のみ閲覧できます'; END IF;
 RETURN QUERY SELECT p.band_id FROM public.audition_performed_bands p WHERE p.audition_id=p_audition_id;
END $$;
CREATE OR REPLACE FUNCTION public.audition_set_previous_live(p_audition_id uuid,p_previous_live_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_previous_status text;
BEGIN
 IF NOT public.is_circle_president() THEN RAISE EXCEPTION '部長のみ操作できます'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.auditions WHERE id=p_audition_id AND status='draft') THEN RAISE EXCEPTION '下書きのみ設定できます'; END IF;
 IF p_previous_live_id=p_audition_id THEN RAISE EXCEPTION '自分自身を前回ライブにできません'; END IF;
 IF p_previous_live_id IS NOT NULL THEN
  SELECT status INTO v_previous_status FROM public.auditions WHERE id=p_previous_live_id;
  IF v_previous_status IS DISTINCT FROM 'published' THEN RAISE EXCEPTION '前回ライブは結果公開済みのものを選択してください'; END IF;
 END IF;
 UPDATE public.auditions SET previous_live_audition_id=p_previous_live_id WHERE id=p_audition_id;
END $$;
-- Replace entry RPC: serializes entries and checks actual performance history.
CREATE OR REPLACE FUNCTION public.audition_enter(p_audition_id uuid,p_band_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
 -- April-based school year in Japan, with explicit grade overrides.
 SELECT coalesce(bool_and(coalesce(
   coalesce(p.year_override,
     extract(year from v_deadline AT TIME ZONE 'Asia/Tokyo')::integer
     - CASE WHEN extract(month from v_deadline AT TIME ZONE 'Asia/Tokyo') < 4 THEN 1 ELSE 0 END
     - p.admission_year + 1) = 1,
   false)),false)
 INTO v_fresh FROM public.band_members bm LEFT JOIN public.profiles p ON p.id=bm.user_id WHERE bm.band_id=p_band_id;
 INSERT INTO public.audition_entries(audition_id,band_id,entered_by,is_freshman_band)
 VALUES(p_audition_id,p_band_id,auth.uid(),v_fresh)
 ON CONFLICT(audition_id,band_id) DO UPDATE SET band_id=EXCLUDED.band_id RETURNING id INTO v_id;
 DELETE FROM public.audition_entry_members WHERE entry_id=v_id;
 INSERT INTO public.audition_entry_members(entry_id,user_id)
 SELECT v_id,user_id FROM public.band_members WHERE band_id=p_band_id;
 RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.audition_set_performed(uuid,uuid,boolean),public.audition_performed_list(uuid),public.audition_set_previous_live(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.audition_set_performed(uuid,uuid,boolean),public.audition_performed_list(uuid),public.audition_set_previous_live(uuid,uuid) TO authenticated;
COMMIT;
