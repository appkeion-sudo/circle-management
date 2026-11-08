-- Additive game migration. Apply after the existing user-management migration.
BEGIN;
CREATE TABLE IF NOT EXISTS public.takoika_bests (
 user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 best_score integer NOT NULL CHECK (best_score >= 0),
 achieved_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.takoika_bests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.takoika_bests FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.takoika_bests TO authenticated;
DROP POLICY IF EXISTS takoika_read ON public.takoika_bests;
CREATE POLICY takoika_read ON public.takoika_bests FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
-- Direct writes are denied. The RPC derives the owner exclusively from auth.uid().
CREATE OR REPLACE FUNCTION public.takoika_save_best(p_score integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE uid uuid := auth.uid(); result integer;
BEGIN
 IF uid IS NULL THEN RAISE EXCEPTION 'ログインが必要です' USING ERRCODE='42501'; END IF;
 IF p_score IS NULL OR p_score < 0 THEN RAISE EXCEPTION 'スコアが不正です' USING ERRCODE='22023'; END IF;
 IF p_score > 0 THEN
  INSERT INTO public.takoika_bests(user_id,best_score) VALUES(uid,p_score)
  ON CONFLICT(user_id) DO UPDATE SET best_score=EXCLUDED.best_score,achieved_at=now(),updated_at=now()
  WHERE public.takoika_bests.best_score < EXCLUDED.best_score;
 END IF;
 SELECT best_score INTO result FROM public.takoika_bests WHERE user_id=uid;
 RETURN coalesce(result,0);
END $$;
CREATE OR REPLACE FUNCTION public.takoika_ranking()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'ログインが必要です' USING ERRCODE='42501'; END IF;
 -- Return only game scores and display names, without exposing profile fields.
 SELECT coalesce(jsonb_agg(r ORDER BY r.best_score DESC,r.username,r.user_id),'[]'::jsonb) INTO result
 FROM (
  SELECT b.user_id,b.best_score,coalesce(nullif(p.username,''),'名前未設定') username,
   rank() OVER(ORDER BY b.best_score DESC) AS rank
  FROM public.takoika_bests b LEFT JOIN public.profiles p ON p.id=b.user_id
 ) r;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.takoika_save_best(integer),public.takoika_ranking() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.takoika_save_best(integer),public.takoika_ranking() TO authenticated;

-- Existing deletion deliberately rejects unknown auth/profile dependencies.
-- Recognize only this reviewed CASCADE FK, preserving the rest of the guard.
DO $migration$
DECLARE definition text;
BEGIN
 IF to_regprocedure('public.admin_user_delete(uuid,uuid,uuid,text)') IS NOT NULL THEN
  SELECT pg_get_functiondef('public.admin_user_delete(uuid,uuid,uuid,text)'::regprocedure) INTO definition;
  IF position('''public.takoika_bests.user_id''' in definition)=0 THEN
   IF position('''public.profiles.id'',''storage.objects.owner''' in definition)=0 THEN
    RAISE EXCEPTION 'User deletion guard differs from the reviewed version; review before applying';
   END IF;
   definition := replace(definition,'''public.profiles.id'',''storage.objects.owner''',
    '''public.takoika_bests.user_id'',''public.profiles.id'',''storage.objects.owner''');
   EXECUTE definition;
  END IF;
 END IF;
END $migration$;
COMMIT;
