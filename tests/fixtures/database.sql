-- Minimal Supabase base schema for isolated regression tests (no production data).
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb DEFAULT '{}');
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated;
CREATE TABLE public.profiles (
 id uuid PRIMARY KEY,username text,admission_year integer,year_override integer,
 member_status text DEFAULT 'active'
);
CREATE TABLE public.circle_president (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),user_id uuid REFERENCES public.profiles
);
CREATE TABLE public.bands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,icon_path text,created_by uuid,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.band_members (
 band_id uuid REFERENCES public.bands ON DELETE CASCADE,user_id uuid REFERENCES public.profiles,
 PRIMARY KEY(band_id,user_id)
);
CREATE TABLE public.auditions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text NOT NULL,description text,
 created_by uuid REFERENCES public.profiles,status text NOT NULL DEFAULT 'draft',
 entry_deadline timestamptz,scoring_deadline timestamptz,general_slots integer NOT NULL DEFAULT 0,
 freshman_slots integer NOT NULL DEFAULT 0,rules jsonb DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.audition_criteria (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),audition_id uuid NOT NULL REFERENCES public.auditions ON DELETE CASCADE,
 name text NOT NULL,max_score numeric NOT NULL CHECK(max_score>0),weight numeric NOT NULL CHECK(weight>=0),
 sort_order integer DEFAULT 0,UNIQUE(id,audition_id)
);
CREATE TABLE public.audition_participants (
 audition_id uuid REFERENCES public.auditions ON DELETE CASCADE,user_id uuid REFERENCES public.profiles,
 PRIMARY KEY(audition_id,user_id)
);
CREATE TABLE public.audition_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),audition_id uuid NOT NULL REFERENCES public.auditions ON DELETE CASCADE,
 band_id uuid NOT NULL REFERENCES public.bands,entered_by uuid REFERENCES public.profiles,
 is_freshman_band boolean,entered_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(audition_id,band_id),UNIQUE(id,audition_id)
);
CREATE TABLE public.audition_scores (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),audition_id uuid NOT NULL,
 entry_id uuid NOT NULL,criterion_id uuid NOT NULL,judge_id uuid REFERENCES public.profiles,
 score numeric NOT NULL CHECK(score>=0),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(entry_id,audition_id) REFERENCES public.audition_entries(id,audition_id) ON DELETE CASCADE,
 FOREIGN KEY(criterion_id,audition_id) REFERENCES public.audition_criteria(id,audition_id) ON DELETE CASCADE,
 UNIQUE(entry_id,criterion_id,judge_id)
);
CREATE TABLE public.audition_penalties (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),entry_id uuid REFERENCES public.audition_entries ON DELETE CASCADE,
 reason text,points numeric CHECK(points>=0),created_by uuid REFERENCES public.profiles
);
CREATE TABLE public.audition_results (
 entry_id uuid PRIMARY KEY REFERENCES public.audition_entries ON DELETE CASCADE,
 total_score numeric,overall_rank integer,category_ranks jsonb NOT NULL DEFAULT '{}',
 valid_votes integer NOT NULL DEFAULT 0,invalid_votes integer NOT NULL DEFAULT 0,
 passed boolean,result_category text,calculated_at timestamptz
);
CREATE TABLE storage.buckets(id text PRIMARY KEY,public boolean,file_size_limit bigint,name text,allowed_mime_types text[]);
INSERT INTO storage.buckets(id,public,file_size_limit) VALUES('band-icons',true,5242880);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,DELETE ON storage.objects TO authenticated;

CREATE FUNCTION public.is_circle_president() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.circle_president WHERE user_id=auth.uid());
$$;
CREATE FUNCTION public.is_band_member(target_band_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.band_members WHERE band_id=target_band_id AND user_id=auth.uid());
$$;
REVOKE ALL ON FUNCTION public.is_circle_president(),public.is_band_member(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.is_circle_president(),public.is_band_member(uuid) TO authenticated;

ALTER TABLE public.auditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audition_criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audition_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audition_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audition_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audition_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audition_penalties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.band_members ENABLE ROW LEVEL SECURITY;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
CREATE POLICY auditions_select ON public.auditions FOR SELECT TO authenticated
USING(status<>'draft' OR public.is_circle_president());
CREATE POLICY auditions_update ON public.auditions FOR UPDATE TO authenticated
USING(public.is_circle_president()) WITH CHECK(public.is_circle_president());
CREATE POLICY bands_select ON public.bands FOR SELECT TO authenticated USING(public.is_band_member(id));
CREATE POLICY band_members_select ON public.band_members FOR SELECT TO authenticated USING(public.is_band_member(band_id));

-- Contracts of existing profile/role RPCs used by the consolidated migration.
CREATE TABLE public.test_roles(id bigint PRIMARY KEY,name text,exclude_from_staff_auto_assign boolean);
CREATE TABLE public.test_member_roles(user_id uuid,role_id bigint);
CREATE FUNCTION public.circle_roles_list() RETURNS TABLE(id bigint,name text,exclude_from_staff_auto_assign boolean)
LANGUAGE sql AS $$ SELECT * FROM public.test_roles $$;
CREATE FUNCTION public.circle_members_admin() RETURNS TABLE(user_id uuid,role_ids bigint[])
LANGUAGE sql AS $$
 SELECT p.id,coalesce(array_agg(r.role_id) FILTER(WHERE r.role_id IS NOT NULL),'{}'::bigint[])
 FROM public.profiles p LEFT JOIN public.test_member_roles r ON r.user_id=p.id GROUP BY p.id
$$;
CREATE FUNCTION public.profile_context() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('is_site_admin',auth.uid()='00000000-0000-0000-0000-000000000002'::uuid)
$$;
