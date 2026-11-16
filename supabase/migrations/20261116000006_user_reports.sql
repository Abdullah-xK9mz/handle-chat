CREATE TABLE IF NOT EXISTS public.user_reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reporter_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reported_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  conversation_id integer REFERENCES public.conversations(id) ON DELETE SET NULL,
  details text NOT NULL CHECK (char_length(details) BETWEEN 3 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_reports_status_created_idx
  ON public.user_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS user_reports_target_created_idx
  ON public.user_reports (reported_user_id, created_at DESC);

ALTER TABLE public.user_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_user_reports_api_access ON public.user_reports;
CREATE POLICY deny_user_reports_api_access ON public.user_reports
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE public.user_reports FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_reports TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.user_reports_id_seq TO service_role;

