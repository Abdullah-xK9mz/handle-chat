CREATE TABLE IF NOT EXISTS public.imported_chat_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  conversation_count integer NOT NULL CHECK (conversation_count BETWEEN 1 AND 200),
  message_count integer NOT NULL CHECK (message_count BETWEEN 0 AND 20000),
  archive jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, checksum)
);
CREATE INDEX IF NOT EXISTS imported_chat_archives_user_date_idx
  ON public.imported_chat_archives (user_id, imported_at DESC);

CREATE TABLE IF NOT EXISTS public.message_bot_credentials (
  owner_user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  bot_user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id integer REFERENCES public.conversations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint text NOT NULL CHECK (char_length(token_hint) BETWEEN 4 AND 12),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  rate_window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0)
);

ALTER TABLE public.imported_chat_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_bot_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_imported_chat_archives_api_access ON public.imported_chat_archives;
CREATE POLICY deny_imported_chat_archives_api_access ON public.imported_chat_archives
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS deny_message_bot_credentials_api_access ON public.message_bot_credentials;
CREATE POLICY deny_message_bot_credentials_api_access ON public.message_bot_credentials
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.imported_chat_archives, public.message_bot_credentials FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.imported_chat_archives, public.message_bot_credentials TO service_role;

CREATE OR REPLACE FUNCTION public.chat_bot_allow_request(p_credential_owner uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_allowed boolean;
BEGIN
  UPDATE public.message_bot_credentials credential
  SET rate_window_started_at = CASE
        WHEN credential.rate_window_started_at < now() - interval '1 minute' THEN now()
        ELSE credential.rate_window_started_at
      END,
      request_count = CASE
        WHEN credential.rate_window_started_at < now() - interval '1 minute' THEN 1
        ELSE credential.request_count + 1
      END,
      last_used_at = now()
  WHERE credential.owner_user_id = p_credential_owner
    AND credential.revoked_at IS NULL
    AND credential.bot_user_id IS NOT NULL
    AND credential.conversation_id IS NOT NULL
  RETURNING request_count <= 30 INTO v_allowed;
  RETURN coalesce(v_allowed, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_bot_get_messages(
  p_owner_user_id uuid,
  p_bot_user_id uuid,
  p_conversation_id integer,
  p_after_id integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_messages jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.conversations conversation
    JOIN public.conversation_members owner_member
      ON owner_member."conversationId" = conversation.id AND owner_member."userId" = p_owner_user_id
    JOIN public.conversation_members bot_member
      ON bot_member."conversationId" = conversation.id AND bot_member."userId" = p_bot_user_id
    WHERE conversation.id = p_conversation_id AND conversation.kind = 'direct'
  ) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', recent.id,
    'from', CASE WHEN recent."senderId" = p_bot_user_id THEN 'ai' ELSE 'you' END,
    'body', CASE WHEN recent."deletedAt" IS NOT NULL THEN '' ELSE recent.body END,
    'createdAt', recent."createdAt",
    'messageType', recent."messageType",
    'mediaType', recent."mediaType",
    'mediaName', recent."mediaName",
    'deleted', recent."deletedAt" IS NOT NULL
  ) ORDER BY recent.id ASC), '[]'::jsonb)
  INTO v_messages
  FROM (
    SELECT message.id, message."senderId", message.body, message."createdAt",
      message."messageType", message."mediaType", message."mediaName", message."deletedAt"
    FROM public.messages message
    WHERE message."conversationId" = p_conversation_id
      AND (p_after_id <= 0 OR message.id > p_after_id)
    ORDER BY message.id DESC
    LIMIT CASE WHEN p_after_id <= 0 THEN 40 ELSE 100 END
  ) recent;

  UPDATE public.conversation_members
  SET "lastDeliveredAt" = now(), "lastReadAt" = now()
  WHERE "conversationId" = p_conversation_id AND "userId" = p_bot_user_id;

  RETURN v_messages;
END;
$$;

REVOKE ALL ON FUNCTION public.chat_bot_allow_request(uuid),
  public.chat_bot_get_messages(uuid, uuid, integer, integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_bot_allow_request(uuid),
  public.chat_bot_get_messages(uuid, uuid, integer, integer)
TO service_role;
