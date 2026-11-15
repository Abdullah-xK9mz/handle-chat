CREATE TABLE public.signup_rate_limits (
  ip_hash text PRIMARY KEY CHECK (ip_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0)
);

ALTER TABLE public.signup_rate_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY deny_signup_rate_limits_api_access ON public.signup_rate_limits
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.signup_rate_limits FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.signup_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.chat_allow_signup(p_ip_hash text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_allowed boolean;
BEGIN
  IF p_ip_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN false;
  END IF;

  DELETE FROM public.signup_rate_limits
  WHERE window_started_at < now() - interval '24 hours';

  INSERT INTO public.signup_rate_limits (ip_hash, window_started_at, attempts)
  VALUES (p_ip_hash, now(), 1)
  ON CONFLICT (ip_hash) DO UPDATE SET
    window_started_at = CASE
      WHEN public.signup_rate_limits.window_started_at < now() - interval '1 hour'
      THEN now()
      ELSE public.signup_rate_limits.window_started_at
    END,
    attempts = CASE
      WHEN public.signup_rate_limits.window_started_at < now() - interval '1 hour'
      THEN 1
      ELSE public.signup_rate_limits.attempts + 1
    END
  RETURNING attempts <= 5 INTO v_allowed;

  RETURN v_allowed;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.chat_allow_signup(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_allow_signup(text) TO service_role;
