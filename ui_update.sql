-- Apply after timetable_update.sql. Existing profile_context() remains the authority for site admins.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.profile_context()') IS NULL THEN
  RAISE EXCEPTION '既存のprofile_context()を先に用意してください';
 END IF;
END $$;
ALTER TABLE public.auditions ADD COLUMN IF NOT EXISTS event_date date;
CREATE TABLE IF NOT EXISTS public.schedules (
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 schedule_date date NOT NULL, slot integer NOT NULL CHECK(slot BETWEEN 1 AND 8),
 available boolean NOT NULL DEFAULT false,
 PRIMARY KEY(user_id,schedule_date,slot)
);
CREATE UNIQUE INDEX IF NOT EXISTS ui_schedule_cell ON public.schedules(user_id,schedule_date,slot);
ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;
-- Keep existing band-schedule read policies. Writes from this UI use the authenticated RPC.
GRANT SELECT ON public.schedules TO authenticated;
DROP POLICY IF EXISTS ui_schedule_self_read ON public.schedules;
CREATE POLICY ui_schedule_self_read ON public.schedules FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE TABLE IF NOT EXISTS public.ui_notices (
 id uuid PRIMARY KEY, title text NOT NULL, body text NOT NULL,
 created_by uuid NOT NULL REFERENCES public.profiles(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ui_event_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 title text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz
);
CREATE INDEX IF NOT EXISTS ui_notification_user ON public.ui_event_notifications(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS public.ui_timetable_reads (
 event_id uuid NOT NULL REFERENCES public.od_publication_events(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(event_id,user_id)
);
ALTER TABLE public.ui_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ui_event_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ui_timetable_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ui_notices,public.ui_event_notifications,public.ui_timetable_reads FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.ui_can_post() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT auth.uid() IS NOT NULL AND (public.is_circle_president()
  OR coalesce((to_jsonb(public.profile_context())->>'is_site_admin')::boolean,false));
$$;
CREATE OR REPLACE FUNCTION public.ui_schedule_save(p_date date,p_slot integer,p_available boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'ログインしてください'; END IF;
 IF p_date IS NULL OR p_slot IS NULL OR p_slot NOT BETWEEN 1 AND 8 OR p_available IS NULL THEN
  RAISE EXCEPTION '日付・時間枠・参加可否が不正です'; END IF;
 INSERT INTO public.schedules(user_id,schedule_date,slot,available) VALUES(auth.uid(),p_date,p_slot,p_available)
 ON CONFLICT(user_id,schedule_date,slot) DO UPDATE SET available=excluded.available;
END $$;
CREATE OR REPLACE FUNCTION public.ui_notice_save(p_id uuid,p_title text,p_body text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT public.ui_can_post() THEN RAISE EXCEPTION '部長またはサイト管理者のみ操作できます'; END IF;
 IF p_id IS NULL OR nullif(trim(p_title),'') IS NULL OR length(p_title)>100
  OR nullif(trim(p_body),'') IS NULL OR length(p_body)>10000 THEN RAISE EXCEPTION 'タイトル・本文を確認してください'; END IF;
 INSERT INTO public.ui_notices(id,title,body,created_by) VALUES(p_id,trim(p_title),p_body,auth.uid())
 ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,updated_at=now();
END $$;
CREATE OR REPLACE FUNCTION public.ui_notice_delete(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT public.ui_can_post() THEN RAISE EXCEPTION '部長またはサイト管理者のみ操作できます'; END IF;
 DELETE FROM public.ui_notices WHERE id=p_id;
END $$;
CREATE OR REPLACE FUNCTION public.ui_notifications()
RETURNS TABLE(id uuid,title text,body text,created_at timestamptz,read_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT n.id,n.title,n.body,n.created_at,n.read_at FROM public.ui_event_notifications n WHERE n.user_id=auth.uid()
 UNION ALL
 SELECT e.id,a.title,n.message,e.created_at,r.read_at
 FROM public.od_timetable_notifications n JOIN public.od_publication_events e ON e.id=n.event_id
 JOIN public.auditions a ON a.id=e.audition_id
 LEFT JOIN public.ui_timetable_reads r ON r.event_id=e.id AND r.user_id=auth.uid()
 WHERE n.user_id=auth.uid() ORDER BY created_at DESC,id;
$$;
CREATE OR REPLACE FUNCTION public.ui_notifications_read(p_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'ログインしてください'; END IF;
 UPDATE public.ui_event_notifications SET read_at=coalesce(read_at,now()) WHERE user_id=auth.uid() AND id=ANY(p_ids);
 INSERT INTO public.ui_timetable_reads(event_id,user_id)
 SELECT event_id,auth.uid() FROM public.od_timetable_notifications WHERE user_id=auth.uid() AND event_id=ANY(p_ids)
 ON CONFLICT DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION public.ui_dashboard() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'ログインしてください'; END IF;
 SELECT jsonb_build_object(
  'can_post',public.ui_can_post(),
  'events',coalesce((SELECT jsonb_agg(x ORDER BY x.event_date NULLS LAST,x.entry_deadline NULLS LAST) FROM (
   SELECT a.id,a.title,coalesce(a.event_date,t.event_date) event_date,
    CASE WHEN a.status='open' AND a.entry_deadline>now() THEN a.entry_deadline END entry_deadline,
    CASE WHEN a.status IN ('open','scoring') AND a.scoring_deadline>now() THEN a.scoring_deadline END scoring_deadline
   FROM public.auditions a LEFT JOIN public.od_timetables t ON t.audition_id=a.id
   WHERE a.status IN ('open','scoring','closed')
    AND (coalesce(a.event_date,t.event_date) IS NULL OR coalesce(a.event_date,t.event_date)>=(now() AT TIME ZONE 'Asia/Tokyo')::date)
  ) x),'[]'::jsonb),
  'notices',coalesce((SELECT jsonb_agg(n ORDER BY n.created_at DESC,n.id) FROM public.ui_notices n),'[]'::jsonb),
  'unread',(SELECT count(*) FROM public.ui_notifications() WHERE read_at IS NULL)
 ) INTO result;
 RETURN result;
END $$;

-- Status changes and their notifications commit together; repeated unchanged updates emit nothing.
CREATE OR REPLACE FUNCTION public.ui_audition_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('open','published') THEN
  INSERT INTO public.ui_event_notifications(user_id,title,body)
  SELECT id,NEW.title,CASE NEW.status WHEN 'open' THEN 'エントリー受付が始まりました。' ELSE 'オーディション結果が公開されました。' END
  FROM public.profiles WHERE member_status='active' OR id IN (
   SELECT user_id FROM public.audition_participants WHERE audition_id=NEW.id);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ui_audition_notification ON public.auditions;
CREATE TRIGGER ui_audition_notification AFTER UPDATE OF status ON public.auditions
 FOR EACH ROW EXECUTE FUNCTION public.ui_audition_notification();
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('ui_can_post','ui_schedule_save','ui_notice_save','ui_notice_delete',
   'ui_notifications','ui_notifications_read','ui_dashboard','ui_audition_notification') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
  IF f.proname<>'ui_audition_notification' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f.signature); END IF;
 END LOOP;
END $$;
COMMIT;
