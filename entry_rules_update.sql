-- Legacy incremental migration. Current databases can apply consistency_update.sql directly.
BEGIN;

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

COMMIT;

