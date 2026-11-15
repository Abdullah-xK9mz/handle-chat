-- Add durable message attachments and editable profile photos without touching
-- any existing messages or profiles.

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES
  (
    'avatars',
    'avatars',
    true,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
  ),
  (
    'chat-media',
    'chat-media',
    false,
    52428800,
    ARRAY[
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'video/mp4', 'video/webm', 'video/quicktime'
    ]::text[]
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS "mediaPath" text,
  ADD COLUMN IF NOT EXISTS "mediaType" text,
  ADD COLUMN IF NOT EXISTS "mediaName" text;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.chat_user_in_conversation(
  p_conversation_id integer
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversation_members member
    WHERE member."conversationId" = p_conversation_id
      AND member."userId" = (SELECT auth.uid())
  )
$$;

REVOKE ALL ON FUNCTION private.chat_user_in_conversation(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.chat_user_in_conversation(integer)
  TO authenticated;

DROP POLICY IF EXISTS handle_avatar_owner_upload ON storage.objects;
CREATE POLICY handle_avatar_owner_upload
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

DROP POLICY IF EXISTS handle_avatar_owner_delete ON storage.objects;
CREATE POLICY handle_avatar_owner_delete
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

DROP POLICY IF EXISTS handle_chat_media_member_upload ON storage.objects;
CREATE POLICY handle_chat_media_member_upload
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat-media'
    AND (storage.foldername(name))[2] = (SELECT auth.uid()::text)
    AND CASE
      WHEN split_part(name, '/', 1) ~ '^[1-9][0-9]{0,8}$'
        AND name ~ '^[1-9][0-9]{0,8}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$'
      THEN private.chat_user_in_conversation(split_part(name, '/', 1)::integer)
      ELSE false
    END
  );

DROP POLICY IF EXISTS handle_chat_media_owner_delete ON storage.objects;
CREATE POLICY handle_chat_media_owner_delete
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND (storage.foldername(name))[2] = (SELECT auth.uid()::text)
  );

CREATE OR REPLACE FUNCTION public.chat_send_media(
  p_conversation_id integer,
  p_user_id uuid,
  p_body text,
  p_media_path text,
  p_media_type text,
  p_media_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_message public.messages%ROWTYPE;
  v_body text := btrim(coalesce(p_body, ''));
BEGIN
  IF length(v_body) > 4000 THEN
    RAISE EXCEPTION 'MESSAGE_TOO_LONG';
  END IF;
  IF p_media_type NOT IN (
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/webm', 'video/quicktime'
  ) THEN
    RAISE EXCEPTION 'INVALID_MEDIA';
  END IF;
  IF p_media_path !~ format(
    '^%s/%s/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$',
    p_conversation_id,
    p_user_id
  ) THEN
    RAISE EXCEPTION 'INVALID_MEDIA';
  END IF;
  IF p_media_type LIKE 'image/%'
     AND p_media_path !~ '\.(jpg|jpeg|png|webp|gif)$' THEN
    RAISE EXCEPTION 'INVALID_MEDIA';
  END IF;
  IF p_media_type LIKE 'video/%'
     AND p_media_path !~ '\.(mp4|webm|mov)$' THEN
    RAISE EXCEPTION 'INVALID_MEDIA';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members member
    WHERE member."conversationId" = p_conversation_id
      AND member."userId" = p_user_id
  ) THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects object
    WHERE object.bucket_id = 'chat-media'
      AND object.name = p_media_path
  ) THEN
    RAISE EXCEPTION 'INVALID_MEDIA';
  END IF;

  INSERT INTO public.messages (
    "conversationId", "senderId", body, "mediaPath", "mediaType", "mediaName"
  )
  VALUES (
    p_conversation_id,
    p_user_id,
    v_body,
    p_media_path,
    p_media_type,
    left(regexp_replace(coalesce(p_media_name, ''), '[[:cntrl:]/\\]', '', 'g'), 255)
  )
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
    'createdAt', v_message."createdAt",
    'mediaPath', v_message."mediaPath",
    'mediaType', v_message."mediaType",
    'mediaName', v_message."mediaName"
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_can_access_media(
  p_conversation_id integer,
  p_user_id uuid,
  p_media_path text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversation_members member
    JOIN public.messages message
      ON message."conversationId" = member."conversationId"
    WHERE member."conversationId" = p_conversation_id
      AND member."userId" = p_user_id
      AND message."mediaPath" = p_media_path
  )
$$;

CREATE OR REPLACE FUNCTION public.chat_update_profile(
  p_user_id uuid,
  p_name text,
  p_avatar_path text,
  p_update_image boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_name text := btrim(coalesce(p_name, ''));
  v_image text;
BEGIN
  IF length(v_name) = 0 THEN
    RAISE EXCEPTION 'NAME_REQUIRED';
  END IF;
  IF length(v_name) > 50 THEN
    RAISE EXCEPTION 'NAME_TOO_LONG';
  END IF;

  IF p_update_image THEN
    IF p_avatar_path IS NULL THEN
      v_image := NULL;
    ELSE
      IF p_avatar_path !~ format(
        '^%s/[0-9a-f-]{36}\.(jpg|png|webp)$',
        p_user_id
      ) OR NOT EXISTS (
        SELECT 1 FROM storage.objects object
        WHERE object.bucket_id = 'avatars'
          AND object.name = p_avatar_path
      ) THEN
        RAISE EXCEPTION 'INVALID_IMAGE';
      END IF;
      v_image := 'https://uzzjkfriikqsoxjlzjbe.supabase.co/storage/v1/object/public/avatars/'
        || p_avatar_path;
    END IF;
  END IF;

  UPDATE public.profiles
  SET name = v_name,
      image = CASE WHEN p_update_image THEN v_image ELSE image END
  WHERE id = p_user_id;

  RETURN (
    SELECT jsonb_build_object(
      'id', profile.id,
      'name', profile.name,
      'username', profile.username,
      'image', profile.image
    )
    FROM public.profiles profile
    WHERE profile.id = p_user_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_get_messages(
  p_conversation_id integer,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
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
      'username', profile.username,
      'name', profile.name,
      'image', profile.image
    ), member."lastReadAt"
  INTO v_other, v_other_read_at
  FROM public.conversation_members member
  JOIN public.profiles profile ON profile.id = member."userId"
  WHERE member."conversationId" = p_conversation_id
    AND member."userId" <> p_user_id
  LIMIT 1;

  SELECT coalesce(
    jsonb_agg(jsonb_build_object(
      'id', recent.id,
      'senderId', recent."senderId",
      'body', recent.body,
      'createdAt', recent."createdAt",
      'mediaPath', recent."mediaPath",
      'mediaType', recent."mediaType",
      'mediaName', recent."mediaName"
    ) ORDER BY recent.id ASC),
    '[]'::jsonb
  )
  INTO v_messages
  FROM (
    SELECT id, "senderId", body, "createdAt", "mediaPath", "mediaType", "mediaName"
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

CREATE OR REPLACE FUNCTION public.chat_list_conversations(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
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
        SELECT m.body FROM public.messages m
        WHERE m."conversationId" = c.id ORDER BY m.id DESC LIMIT 1
      ),
      'lastMediaType', (
        SELECT m."mediaType" FROM public.messages m
        WHERE m."conversationId" = c.id ORDER BY m.id DESC LIMIT 1
      ),
      'lastSenderId', (
        SELECT m."senderId" FROM public.messages m
        WHERE m."conversationId" = c.id ORDER BY m.id DESC LIMIT 1
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

REVOKE EXECUTE ON FUNCTION public.chat_send_media(integer, uuid, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_can_access_media(integer, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_update_profile(uuid, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_send_media(integer, uuid, text, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_can_access_media(integer, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_update_profile(uuid, text, text, boolean)
  TO service_role;

