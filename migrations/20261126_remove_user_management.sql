-- Retire the old account management RPCs while keeping existing records.
BEGIN;
DROP FUNCTION IF EXISTS public.admin_user_delete(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.admin_users_list(uuid, text, integer);
DROP FUNCTION IF EXISTS public.admin_scrub_timetable(jsonb, uuid);
NOTIFY pgrst, 'reload schema';
COMMIT;
