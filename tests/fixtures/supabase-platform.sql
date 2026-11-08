-- Supabase-managed objects only. Application schema must come from setup.sql.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
CREATE TABLE auth.users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text UNIQUE,
 raw_user_meta_data jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE storage.buckets (
 id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]
);
CREATE TABLE storage.objects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text REFERENCES storage.buckets,
 name text NOT NULL,UNIQUE(bucket_id,name)
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated;
