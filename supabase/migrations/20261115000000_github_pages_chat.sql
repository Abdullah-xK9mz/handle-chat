-- Move Handle's empty chat schema from Better Auth user IDs to Supabase Auth.
-- The new project was inspected before this migration; the existing chat and
-- Better Auth tables contain zero rows.

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE,
  name text NOT NULL,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_username_format
    CHECK (username ~ '^[a-z0-9_.]{3,20}$'),
  CONSTRAINT profiles_name_length
    CHECK (char_length(name) BETWEEN 1 AND 50)
);

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_username text := lower(btrim(coalesce(NEW.raw_user_meta_data ->> 'username', '')));
  v_name text := btrim(coalesce(NEW.raw_user_meta_data ->> 'name', ''));
BEGIN
  IF v_username !~ '^[a-z0-9_.]{3,20}$' THEN
    RAISE EXCEPTION 'INVALID_USERNAME' USING ERRCODE = '23514';
  END IF;
  IF char_length(v_name) = 0 OR char_length(v_name) > 50 THEN
    RAISE EXCEPTION 'INVALID_NAME' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.profiles (id, username, name)
  VALUES (NEW.id, v_username, v_name);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS on_auth_user_created_handle_profile ON auth.users;
CREATE TRIGGER on_auth_user_created_handle_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

ALTER TABLE public.conversation_members
  DROP CONSTRAINT IF EXISTS "conversation_members_userId_fkey";
ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS "messages_senderId_fkey";

ALTER TABLE public.conversation_members
  ALTER COLUMN "userId" TYPE uuid USING "userId"::uuid;
ALTER TABLE public.messages
  ALTER COLUMN "senderId" TYPE uuid USING "senderId"::uuid;

ALTER TABLE public.conversation_members
  ADD CONSTRAINT conversation_members_profile_fkey
  FOREIGN KEY ("userId") REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_sender_profile_fkey
  FOREIGN KEY ("senderId") REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.conversations
  ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" SET DEFAULT now(),
  ALTER COLUMN "lastMessageAt" TYPE timestamptz USING "lastMessageAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "lastMessageAt" SET DEFAULT now();
ALTER TABLE public.conversation_members
  ALTER COLUMN "lastReadAt" TYPE timestamptz USING "lastReadAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "lastReadAt" SET DEFAULT now();
ALTER TABLE public.messages
  ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" SET DEFAULT now();

CREATE INDEX profiles_username_prefix_idx ON public.profiles (username text_pattern_ops);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY deny_profiles_api_access ON public.profiles
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE public.profiles FROM anon, authenticated;
REVOKE ALL ON TABLE
  public.conversations,
  public.conversation_members,
  public.messages
FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.profiles,
  public.conversations,
  public.conversation_members,
  public.messages
TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.conversations_id_seq, public.messages_id_seq
TO service_role;

CREATE OR REPLACE FUNCTION public.chat_get_profile(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'username', p.username,
    'image', p.image
  )
  FROM public.profiles p
  WHERE p.id = p_user_id
$$;

CREATE OR REPLACE FUNCTION public.chat_search_users(p_user_id uuid, p_query text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    jsonb_agg(jsonb_build_object(
      'username', p.username,
      'name', p.name,
      'image', p.image
    ) ORDER BY p.username),
    '[]'::jsonb
  )
  FROM (
    SELECT username, name, image
    FROM public.profiles
    WHERE id <> p_user_id
      AND left(username, char_length(p_query)) = p_query
    ORDER BY username
    LIMIT 8
  ) p
$$;

CREATE OR REPLACE FUNCTION public.chat_list_conversations(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    jsonb_agg(jsonb_build_object(
      'id', c.id,
      'lastMessageAt', c."lastMessageAt",
      'otherUserId', other_profile.id,
      'otherUsername', other_profile.username,
      'otherName', other_profile.name,
      'otherImage', other_profile.image,
      'lastBody', (
        SELECT m.body
        FROM public.messages m
        WHERE m."conversationId" = c.id
        ORDER BY m.id DESC
        LIMIT 1
      ),
      'lastSenderId', (
        SELECT m."senderId"
        FROM public.messages m
        WHERE m."conversationId" = c.id
        ORDER BY m.id DESC
        LIMIT 1
      ),
      'unreadCount', (
        SELECT count(*)::integer
        FROM public.messages m
        WHERE m."conversationId" = c.id
          AND m."senderId" <> p_user_id
          AND m."createdAt" > mine."lastReadAt"
      )
    ) ORDER BY c."lastMessageAt" DESC),
    '[]'::jsonb
  )
  FROM public.conversation_members mine
  JOIN public.conversations c ON c.id = mine."conversationId"
  JOIN public.conversation_members other_member
    ON other_member."conversationId" = c.id
   AND other_member."userId" <> p_user_id
  JOIN public.profiles other_profile ON other_profile.id = other_member."userId"
  WHERE mine."userId" = p_user_id
$$;

CREATE OR REPLACE FUNCTION public.chat_start_conversation(
  p_user_id uuid,
  p_username text
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_target_id uuid;
  v_conversation_id integer;
  v_dm_key text;
BEGIN
  SELECT id INTO v_target_id
  FROM public.profiles
  WHERE username = lower(p_username)
  LIMIT 1;

  IF v_target_id IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;
  IF v_target_id = p_user_id THEN
    RAISE EXCEPTION 'SELF_CHAT';
  END IF;

  v_dm_key := least(p_user_id::text, v_target_id::text)
    || ':' || greatest(p_user_id::text, v_target_id::text);

  INSERT INTO public.conversations ("dmKey")
  VALUES (v_dm_key)
  ON CONFLICT ("dmKey") DO UPDATE SET "dmKey" = EXCLUDED."dmKey"
  RETURNING id INTO v_conversation_id;

  INSERT INTO public.conversation_members ("conversationId", "userId")
  VALUES
    (v_conversation_id, p_user_id),
    (v_conversation_id, v_target_id)
  ON CONFLICT ("conversationId", "userId") DO NOTHING;

  RETURN v_conversation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_get_messages(
  p_conversation_id integer,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_other jsonb;
  v_other_read_at timestamptz;
  v_messages jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.conversation_members
    WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id
  ) THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
      'username', p.username,
      'name', p.name,
      'image', p.image
    ),
    member."lastReadAt"
  INTO v_other, v_other_read_at
  FROM public.conversation_members member
  JOIN public.profiles p ON p.id = member."userId"
  WHERE member."conversationId" = p_conversation_id
    AND member."userId" <> p_user_id
  LIMIT 1;

  SELECT coalesce(
    jsonb_agg(jsonb_build_object(
      'id', recent.id,
      'senderId', recent."senderId",
      'body', recent.body,
      'createdAt', recent."createdAt"
    ) ORDER BY recent.id ASC),
    '[]'::jsonb
  )
  INTO v_messages
  FROM (
    SELECT id, "senderId", body, "createdAt"
    FROM public.messages
    WHERE "conversationId" = p_conversation_id
    ORDER BY id DESC
    LIMIT 200
  ) recent;

  UPDATE public.conversation_members
  SET "lastReadAt" = now()
  WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id;

  RETURN jsonb_build_object(
    'other', v_other,
    'otherLastReadAt', v_other_read_at,
    'messages', v_messages
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_send_message(
  p_conversation_id integer,
  p_user_id uuid,
  p_body text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_message public.messages%ROWTYPE;
BEGIN
  IF length(btrim(p_body)) = 0 THEN
    RAISE EXCEPTION 'EMPTY_MESSAGE';
  END IF;
  IF length(p_body) > 4000 THEN
    RAISE EXCEPTION 'MESSAGE_TOO_LONG';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id
  ) THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;

  INSERT INTO public.messages ("conversationId", "senderId", body)
  VALUES (p_conversation_id, p_user_id, btrim(p_body))
  RETURNING * INTO v_message;

  UPDATE public.conversations
  SET "lastMessageAt" = v_message."createdAt"
  WHERE id = p_conversation_id;

  UPDATE public.conversation_members
  SET "lastReadAt" = v_message."createdAt"
  WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id;

  RETURN jsonb_build_object(
    'id', v_message.id,
    'senderId', v_message."senderId",
    'body', v_message.body,
    'createdAt', v_message."createdAt"
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.chat_get_profile(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_search_users(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_list_conversations(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_start_conversation(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_get_messages(integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_send_message(integer, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.chat_get_profile(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_search_users(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_list_conversations(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_start_conversation(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_get_messages(integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_send_message(integer, uuid, text) TO service_role;
