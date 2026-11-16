-- Account suspension and persistent browser-installation bans are separate
-- controls. Deleting a profile cascades account suspensions but never creates
-- a device ban; registered devices remain eligible to create a new account.
CREATE TABLE IF NOT EXISTS public.account_bans (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  expires_at timestamptz,
  reason text NOT NULL DEFAULT 'Conversation review in progress',
  banned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_bans_reason_length CHECK (char_length(reason) <= 200)
);

CREATE TABLE IF NOT EXISTS public.device_registry (
  device_id uuid PRIMARY KEY,
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  CONSTRAINT device_registry_user_agent_length CHECK (user_agent IS NULL OR char_length(user_agent) <= 512)
);

CREATE INDEX IF NOT EXISTS device_registry_user_seen_idx
  ON public.device_registry (user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.device_bans (
  device_id uuid PRIMARY KEY,
  reason text NOT NULL DEFAULT 'Device blocked by an administrator',
  banned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_bans_reason_length CHECK (char_length(reason) <= 200)
);

ALTER TABLE public.account_bans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_bans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deny_account_bans_api_access ON public.account_bans;
CREATE POLICY deny_account_bans_api_access ON public.account_bans
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS deny_device_registry_api_access ON public.device_registry;
CREATE POLICY deny_device_registry_api_access ON public.device_registry
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS deny_device_bans_api_access ON public.device_bans;
CREATE POLICY deny_device_bans_api_access ON public.device_bans
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE public.account_bans, public.device_registry, public.device_bans
  FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.account_bans, public.device_registry, public.device_bans
  TO service_role;

