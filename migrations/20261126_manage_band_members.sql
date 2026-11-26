BEGIN;

CREATE OR REPLACE FUNCTION public.change_band_members(
  p_band_id uuid, p_member_ids uuid[], p_action text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  member_ids uuid[];
  changed_count integer;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'ログインしてください。' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('add', 'remove') THEN
    RAISE EXCEPTION 'メンバーの操作が不正です。' USING ERRCODE = '22023';
  END IF;

  -- 同じバンドの更新を直列化し、操作中の脱退や所属削除も待機させる。
  PERFORM 1 FROM public.bands b WHERE b.id = p_band_id
    AND public.is_band_member(b.id) FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '対象バンドが見つからないか、所属していません。' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.band_members
  WHERE band_id = p_band_id AND user_id = actor_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '対象バンドが見つからないか、所属していません。' USING ERRCODE = '42501';
  END IF;

  SELECT array_agg(DISTINCT id) INTO member_ids FROM unnest(p_member_ids) AS ids(id);
  IF member_ids IS NULL OR array_position(member_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'メンバーを選択してください。' USING ERRCODE = '22023';
  END IF;

  IF p_action = 'add' THEN
    IF EXISTS (
      SELECT 1 FROM unnest(member_ids) AS ids(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.profiles p JOIN auth.users u ON u.id = p.id WHERE p.id = ids.id
      )
    ) THEN
      RAISE EXCEPTION '追加できないユーザが含まれています。バンドを選び直してください。' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.band_members (band_id, user_id)
    SELECT p_band_id, id FROM unnest(member_ids) AS ids(id)
    ON CONFLICT (band_id, user_id) DO NOTHING;
    GET DIAGNOSTICS changed_count = ROW_COUNT;
    IF changed_count <> cardinality(member_ids) THEN
      RAISE EXCEPTION 'すでに所属しているメンバーが含まれています。バンドを選び直してください。' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF actor_id = ANY(member_ids) THEN
      RAISE EXCEPTION '自分が抜ける場合はバンド脱退を使ってください。' USING ERRCODE = '22023';
    END IF;
    DELETE FROM public.band_members WHERE band_id = p_band_id AND user_id = ANY(member_ids);
    GET DIAGNOSTICS changed_count = ROW_COUNT;
    IF changed_count <> cardinality(member_ids) THEN
      RAISE EXCEPTION '所属していないメンバーが含まれています。バンドを選び直してください。' USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN changed_count;
END;
$$;

REVOKE ALL ON FUNCTION public.change_band_members(uuid, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_band_members(uuid, uuid[], text) TO authenticated;

COMMIT;
