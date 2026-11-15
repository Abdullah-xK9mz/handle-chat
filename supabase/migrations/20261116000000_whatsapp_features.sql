-- Add group chats, structured messages, statuses and account-level chat controls.
-- Existing conversations and messages are kept in place.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'direct',
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS "createdBy" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_kind_check'
      AND conrelid = 'public.conversations'::regclass
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_kind_check
      CHECK (kind IN ('direct', 'group'));
  END IF;
END;
$$;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS "messageType" text NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_message_type_check'
      AND conrelid = 'public.messages'::regclass
  ) THEN
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_message_type_check
      CHECK ("messageType" IN ('text', 'image', 'video', 'voice', 'document', 'location', 'contact', 'poll', 'event'));
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.user_blocks (
  blocker_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx
  ON public.user_blocks (blocked_id, blocker_id);

CREATE TABLE IF NOT EXISTS public.conversation_preferences (
  "userId" uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  "conversationId" integer NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  muted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "conversationId")
);

CREATE TABLE IF NOT EXISTS public.statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body text NOT NULL DEFAULT '',
  "mediaPath" text,
  "mediaType" text,
  "mediaName" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  CHECK (char_length(body) <= 700),
  CHECK (body <> '' OR "mediaPath" IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS statuses_expiry_idx
  ON public.statuses ("expiresAt", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS statuses_user_expiry_idx
  ON public.statuses ("userId", "expiresAt", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS public.poll_votes (
  "messageId" integer NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  "userId" uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  option_index integer NOT NULL CHECK (option_index >= 0),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("messageId", "userId")
);
CREATE INDEX IF NOT EXISTS poll_votes_message_idx
  ON public.poll_votes ("messageId", option_index);

ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poll_votes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.user_blocks,
  public.conversation_preferences,
  public.statuses,
  public.poll_votes
FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.user_blocks,
  public.conversation_preferences,
  public.statuses,
  public.poll_votes
TO service_role;

INSERT INTO storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
)
VALUES (
  'chat-media', 'chat-media', false, 52428800,
  ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/webm', 'video/quicktime',
    'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav',
    'application/pdf', 'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE SET
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS handle_chat_media_member_upload ON storage.objects;
CREATE POLICY handle_chat_media_member_upload
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat-media'
    AND (storage.foldername(name))[2] = (SELECT auth.uid()::text)
    AND CASE
      WHEN split_part(name, '/', 1) = 'status'
        AND name ~ '^status/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$'
      THEN true
      WHEN split_part(name, '/', 1) ~ '^[1-9][0-9]{0,8}$'
        AND name ~ '^[1-9][0-9]{0,8}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif|mp4|webm|mov|ogg|mpeg|wav|pdf|txt|csv|doc|docx|xls|xlsx|ppt|pptx)$'
      THEN private.chat_user_in_conversation(split_part(name, '/', 1)::integer)
      ELSE false
    END
  );

CREATE OR REPLACE FUNCTION public.chat_start_conversation(
  p_user_id uuid,
  p_username text
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
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

  IF v_target_id IS NULL THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  IF v_target_id = p_user_id THEN RAISE EXCEPTION 'SELF_CHAT'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_blocks block
    WHERE (block.blocker_id = p_user_id AND block.blocked_id = v_target_id)
       OR (block.blocker_id = v_target_id AND block.blocked_id = p_user_id)
  ) THEN RAISE EXCEPTION 'USER_BLOCKED'; END IF;

  v_dm_key := least(p_user_id::text, v_target_id::text)
    || ':' || greatest(p_user_id::text, v_target_id::text);

  INSERT INTO public.conversations ("dmKey", kind)
  VALUES (v_dm_key, 'direct')
  ON CONFLICT ("dmKey") DO UPDATE SET "dmKey" = EXCLUDED."dmKey"
  RETURNING id INTO v_conversation_id;

  INSERT INTO public.conversation_members ("conversationId", "userId")
  VALUES (v_conversation_id, p_user_id), (v_conversation_id, v_target_id)
  ON CONFLICT ("conversationId", "userId") DO NOTHING;

  RETURN v_conversation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_create_group(
  p_user_id uuid,
  p_name text,
  p_usernames text[]
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_name text := btrim(coalesce(p_name, ''));
  v_conversation_id integer;
  v_found integer;
BEGIN
  IF length(v_name) < 1 OR length(v_name) > 50 THEN
    RAISE EXCEPTION 'INVALID_GROUP_NAME';
  END IF;
  IF p_usernames IS NULL OR cardinality(p_usernames) < 1 OR cardinality(p_usernames) > 49 THEN
    RAISE EXCEPTION 'INVALID_GROUP_MEMBERS';
  END IF;
  SELECT count(DISTINCT profile.id)::integer INTO v_found
  FROM public.profiles profile
  WHERE profile.username = ANY (p_usernames)
    AND profile.id <> p_user_id;
  IF v_found <> cardinality(p_usernames) THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  INSERT INTO public.conversations ("dmKey", kind, name, "createdBy")
  VALUES ('group:' || gen_random_uuid()::text, 'group', v_name, p_user_id)
  RETURNING id INTO v_conversation_id;

  INSERT INTO public.conversation_members ("conversationId", "userId")
  VALUES (v_conversation_id, p_user_id)
  ON CONFLICT ("conversationId", "userId") DO NOTHING;

  INSERT INTO public.conversation_members ("conversationId", "userId")
  SELECT v_conversation_id, profile.id
  FROM public.profiles profile
  WHERE profile.username = ANY (p_usernames)
    AND profile.id <> p_user_id
  ON CONFLICT ("conversationId", "userId") DO NOTHING;

  RETURN v_conversation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_search_users(p_user_id uuid, p_query text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(
    jsonb_agg(jsonb_build_object(
      'username', matches.username,
      'name', matches.name,
      'image', matches.image
    ) ORDER BY matches.username),
    '[]'::jsonb
  )
  FROM (
    SELECT profile.username, profile.name, profile.image
    FROM public.profiles profile
    WHERE profile.id <> p_user_id
      AND left(profile.username, char_length(p_query)) = p_query
      AND NOT EXISTS (
        SELECT 1 FROM public.user_blocks block
        WHERE (block.blocker_id = p_user_id AND block.blocked_id = profile.id)
           OR (block.blocker_id = profile.id AND block.blocked_id = p_user_id)
      )
    ORDER BY profile.username
    LIMIT 8
  ) matches
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
      'isGroup', c.kind = 'group',
      'groupName', c.name,
      'otherUserId', peer.id,
      'otherUsername', peer.username,
      'otherName', CASE WHEN c.kind = 'group' THEN c.name ELSE peer.name END,
      'otherImage', CASE WHEN c.kind = 'group' THEN NULL ELSE peer.image END,
      'participantCount', (
        SELECT count(*)::integer FROM public.conversation_members member
        WHERE member."conversationId" = c.id
      ),
      'lastBody', (
        SELECT message.body FROM public.messages message
        WHERE message."conversationId" = c.id ORDER BY message.id DESC LIMIT 1
      ),
      'lastMediaType', (
        SELECT message."mediaType" FROM public.messages message
        WHERE message."conversationId" = c.id ORDER BY message.id DESC LIMIT 1
      ),
      'lastMessageType', (
        SELECT message."messageType" FROM public.messages message
        WHERE message."conversationId" = c.id ORDER BY message.id DESC LIMIT 1
      ),
      'lastSenderId', (
        SELECT message."senderId" FROM public.messages message
        WHERE message."conversationId" = c.id ORDER BY message.id DESC LIMIT 1
      ),
      'unreadCount', (
        SELECT count(*)::integer
        FROM public.messages message
        WHERE message."conversationId" = c.id
          AND message."senderId" <> p_user_id
          AND message."createdAt" > mine."lastReadAt"
      ),
      'isMuted', coalesce(pref.muted, false)
    ) ORDER BY c."lastMessageAt" DESC),
    '[]'::jsonb
  )
  FROM public.conversation_members mine
  JOIN public.conversations c ON c.id = mine."conversationId"
  LEFT JOIN LATERAL (
    SELECT profile.id, profile.username, profile.name, profile.image
    FROM public.conversation_members member
    JOIN public.profiles profile ON profile.id = member."userId"
    WHERE member."conversationId" = c.id AND member."userId" <> p_user_id
    ORDER BY profile.username
    LIMIT 1
  ) peer ON true
  LEFT JOIN public.conversation_preferences pref
    ON pref."userId" = p_user_id AND pref."conversationId" = c.id
  WHERE mine."userId" = p_user_id
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
  v_conversation jsonb;
  v_other_read_at timestamptz;
  v_messages jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members member
    WHERE member."conversationId" = p_conversation_id AND member."userId" = p_user_id
  ) THEN RETURN NULL; END IF;

  SELECT jsonb_build_object(
      'username', CASE WHEN c.kind = 'group' THEN NULL ELSE peer.username END,
      'name', CASE WHEN c.kind = 'group' THEN c.name ELSE peer.name END,
      'image', CASE WHEN c.kind = 'group' THEN NULL ELSE peer.image END,
      'isGroup', c.kind = 'group',
      'participantCount', (SELECT count(*)::integer FROM public.conversation_members m WHERE m."conversationId" = c.id),
      'members', CASE WHEN c.kind = 'group' THEN (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', profile.id, 'name', profile.name,
          'username', profile.username, 'image', profile.image
        ) ORDER BY profile.name), '[]'::jsonb)
        FROM public.conversation_members m
        JOIN public.profiles profile ON profile.id = m."userId"
        WHERE m."conversationId" = c.id
      ) ELSE '[]'::jsonb END,
      'isBlockedByMe', CASE WHEN c.kind = 'group' THEN false ELSE EXISTS (
        SELECT 1 FROM public.user_blocks block
        WHERE block.blocker_id = p_user_id AND block.blocked_id = peer.id
      ) END,
      'isBlocked', CASE WHEN c.kind = 'group' THEN false ELSE EXISTS (
        SELECT 1 FROM public.user_blocks block
        WHERE (block.blocker_id = p_user_id AND block.blocked_id = peer.id)
           OR (block.blocker_id = peer.id AND block.blocked_id = p_user_id)
      ) END
    ),
    jsonb_build_object(
      'id', c.id, 'isGroup', c.kind = 'group', 'name', c.name,
      'participantCount', (SELECT count(*)::integer FROM public.conversation_members m WHERE m."conversationId" = c.id),
      'isMuted', coalesce(pref.muted, false)
    ),
    peer_member."lastReadAt"
  INTO v_other, v_conversation, v_other_read_at
  FROM public.conversations c
  LEFT JOIN LATERAL (
    SELECT profile.id, profile.username, profile.name, profile.image
    FROM public.conversation_members member
    JOIN public.profiles profile ON profile.id = member."userId"
    WHERE member."conversationId" = c.id AND member."userId" <> p_user_id
    ORDER BY profile.username LIMIT 1
  ) peer ON true
  LEFT JOIN public.conversation_members peer_member
    ON peer_member."conversationId" = c.id AND peer_member."userId" = peer.id
  LEFT JOIN public.conversation_preferences pref
    ON pref."userId" = p_user_id AND pref."conversationId" = c.id
  WHERE c.id = p_conversation_id;

  SELECT coalesce(
    jsonb_agg(jsonb_build_object(
      'id', recent.id,
      'senderId', recent."senderId",
      'body', recent.body,
      'createdAt', recent."createdAt",
      'mediaPath', recent."mediaPath",
      'mediaType', recent."mediaType",
      'mediaName', recent."mediaName",
      'messageType', recent."messageType",
      'payload', CASE WHEN recent."messageType" = 'poll' THEN recent.payload || jsonb_build_object(
        'counts', (
          SELECT coalesce(jsonb_agg(coalesce(votes.vote_count, 0) ORDER BY opt.idx), '[]'::jsonb)
          FROM generate_series(0, jsonb_array_length(recent.payload->'options') - 1) AS opt(idx)
          LEFT JOIN (
            SELECT vote.option_index, count(*)::integer AS vote_count
            FROM public.poll_votes vote WHERE vote."messageId" = recent.id
            GROUP BY vote.option_index
          ) votes ON votes.option_index = opt.idx
        ),
        'myVote', (
          SELECT vote.option_index FROM public.poll_votes vote
          WHERE vote."messageId" = recent.id AND vote."userId" = p_user_id
        )
      ) ELSE recent.payload END
    ) ORDER BY recent.id ASC),
    '[]'::jsonb
  )
  INTO v_messages
  FROM (
    SELECT id, "senderId", body, "createdAt", "mediaPath", "mediaType", "mediaName", "messageType", payload
    FROM public.messages
    WHERE "conversationId" = p_conversation_id
    ORDER BY id DESC LIMIT 500
  ) recent;

  UPDATE public.conversation_members
  SET "lastReadAt" = now()
  WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id;

  RETURN jsonb_build_object(
    'other', v_other,
    'conversation', v_conversation,
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
SET search_path = ''
AS $$
DECLARE
  v_message public.messages%ROWTYPE;
BEGIN
  IF length(btrim(p_body)) = 0 THEN RAISE EXCEPTION 'EMPTY_MESSAGE'; END IF;
  IF length(p_body) > 4000 THEN RAISE EXCEPTION 'MESSAGE_TOO_LONG'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id
  ) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.conversation_members other ON other."conversationId" = c.id AND other."userId" <> p_user_id
    JOIN public.user_blocks block ON (block.blocker_id = p_user_id AND block.blocked_id = other."userId")
       OR (block.blocker_id = other."userId" AND block.blocked_id = p_user_id)
    WHERE c.id = p_conversation_id AND c.kind = 'direct'
  ) THEN RAISE EXCEPTION 'USER_BLOCKED'; END IF;

  INSERT INTO public.messages ("conversationId", "senderId", body, "messageType", payload)
  VALUES (p_conversation_id, p_user_id, btrim(p_body), 'text', '{}'::jsonb)
  RETURNING * INTO v_message;

  UPDATE public.conversations SET "lastMessageAt" = v_message."createdAt" WHERE id = p_conversation_id;
  UPDATE public.conversation_members SET "lastReadAt" = v_message."createdAt"
    WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id;

  RETURN jsonb_build_object(
    'id', v_message.id, 'senderId', v_message."senderId", 'body', v_message.body,
    'createdAt', v_message."createdAt", 'messageType', v_message."messageType", 'payload', v_message.payload
  );
END;
$$;

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
  v_message_type text;
BEGIN
  IF length(v_body) > 4000 THEN RAISE EXCEPTION 'MESSAGE_TOO_LONG'; END IF;
  IF p_media_type NOT IN (
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/webm', 'video/quicktime',
    'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav',
    'application/pdf', 'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) THEN RAISE EXCEPTION 'INVALID_MEDIA'; END IF;
  IF p_media_path !~ format(
    '^%s/%s/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif|mp4|webm|mov|ogg|mpeg|wav|pdf|txt|csv|doc|docx|xls|xlsx|ppt|pptx)$',
    p_conversation_id, p_user_id
  ) THEN RAISE EXCEPTION 'INVALID_MEDIA'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members member
    WHERE member."conversationId" = p_conversation_id AND member."userId" = p_user_id
  ) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.conversation_members other ON other."conversationId" = c.id AND other."userId" <> p_user_id
    JOIN public.user_blocks block ON (block.blocker_id = p_user_id AND block.blocked_id = other."userId")
       OR (block.blocker_id = other."userId" AND block.blocked_id = p_user_id)
    WHERE c.id = p_conversation_id AND c.kind = 'direct'
  ) THEN RAISE EXCEPTION 'USER_BLOCKED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects object
    WHERE object.bucket_id = 'chat-media' AND object.name = p_media_path
  ) THEN RAISE EXCEPTION 'INVALID_MEDIA'; END IF;

  v_message_type := CASE
    WHEN p_media_type LIKE 'image/%' THEN 'image'
    WHEN p_media_type LIKE 'video/%' THEN 'video'
    WHEN p_media_type LIKE 'audio/%' THEN 'voice'
    ELSE 'document'
  END;

  INSERT INTO public.messages (
    "conversationId", "senderId", body, "mediaPath", "mediaType", "mediaName", "messageType", payload
  ) VALUES (
    p_conversation_id, p_user_id, v_body, p_media_path, p_media_type,
    left(regexp_replace(coalesce(p_media_name, ''), '[[:cntrl:]/\\]', '', 'g'), 255),
    v_message_type, '{}'::jsonb
  ) RETURNING * INTO v_message;

  UPDATE public.conversations SET "lastMessageAt" = v_message."createdAt" WHERE id = p_conversation_id;
  UPDATE public.conversation_members SET "lastReadAt" = v_message."createdAt"
    WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id;

  RETURN jsonb_build_object(
    'id', v_message.id, 'senderId', v_message."senderId", 'body', v_message.body,
    'createdAt', v_message."createdAt", 'mediaPath', v_message."mediaPath",
    'mediaType', v_message."mediaType", 'mediaName', v_message."mediaName",
    'messageType', v_message."messageType", 'payload', v_message.payload
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_send_structured_message(
  p_conversation_id integer,
  p_user_id uuid,
  p_message_type text,
  p_body text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_message public.messages%ROWTYPE;
  v_body text := btrim(coalesce(p_body, ''));
BEGIN
  IF p_message_type NOT IN ('location', 'contact', 'poll', 'event') THEN RAISE EXCEPTION 'INVALID_MESSAGE_TYPE'; END IF;
  IF jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object' THEN RAISE EXCEPTION 'INVALID_MESSAGE'; END IF;
  IF length(v_body) > 4000 THEN RAISE EXCEPTION 'MESSAGE_TOO_LONG'; END IF;
  IF p_message_type = 'location' AND (
    NOT (p_payload ? 'latitude') OR NOT (p_payload ? 'longitude')
    OR (p_payload->>'latitude')::numeric NOT BETWEEN -90 AND 90
    OR (p_payload->>'longitude')::numeric NOT BETWEEN -180 AND 180
  ) THEN RAISE EXCEPTION 'INVALID_MESSAGE'; END IF;
  IF p_message_type = 'contact' AND length(btrim(coalesce(p_payload->>'name', ''))) = 0 THEN
    RAISE EXCEPTION 'INVALID_MESSAGE';
  END IF;
  IF p_message_type = 'poll' AND (
    length(btrim(coalesce(p_payload->>'question', ''))) = 0
    OR jsonb_typeof(p_payload->'options') <> 'array'
    OR jsonb_array_length(p_payload->'options') < 2
    OR jsonb_array_length(p_payload->'options') > 10
  ) THEN RAISE EXCEPTION 'INVALID_POLL'; END IF;
  IF p_message_type = 'event' AND (
    length(btrim(coalesce(p_payload->>'title', ''))) = 0
    OR nullif(p_payload->>'startsAt', '') IS NULL
  ) THEN RAISE EXCEPTION 'INVALID_MESSAGE'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members member
    WHERE member."conversationId" = p_conversation_id AND member."userId" = p_user_id
  ) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.conversation_members other ON other."conversationId" = c.id AND other."userId" <> p_user_id
    JOIN public.user_blocks block ON (block.blocker_id = p_user_id AND block.blocked_id = other."userId")
       OR (block.blocker_id = other."userId" AND block.blocked_id = p_user_id)
    WHERE c.id = p_conversation_id AND c.kind = 'direct'
  ) THEN RAISE EXCEPTION 'USER_BLOCKED'; END IF;

  INSERT INTO public.messages ("conversationId", "senderId", body, "messageType", payload)
  VALUES (p_conversation_id, p_user_id, v_body, p_message_type, p_payload)
  RETURNING * INTO v_message;
  UPDATE public.conversations SET "lastMessageAt" = v_message."createdAt" WHERE id = p_conversation_id;
  UPDATE public.conversation_members SET "lastReadAt" = v_message."createdAt"
    WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id;

  RETURN jsonb_build_object(
    'id', v_message.id, 'senderId', v_message."senderId", 'body', v_message.body,
    'createdAt', v_message."createdAt", 'messageType', v_message."messageType", 'payload', v_message.payload
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_vote_poll(
  p_message_id integer,
  p_user_id uuid,
  p_option_index integer
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  SELECT jsonb_array_length(message.payload->'options') INTO v_count
  FROM public.messages message
  JOIN public.conversation_members member ON member."conversationId" = message."conversationId"
  WHERE message.id = p_message_id AND message."messageType" = 'poll'
    AND member."userId" = p_user_id;
  IF v_count IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p_option_index < 0 OR p_option_index >= v_count THEN RAISE EXCEPTION 'INVALID_POLL'; END IF;
  INSERT INTO public.poll_votes ("messageId", "userId", option_index)
  VALUES (p_message_id, p_user_id, p_option_index)
  ON CONFLICT ("messageId", "userId") DO UPDATE SET
    option_index = EXCLUDED.option_index, "createdAt" = now();
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_search_messages(
  p_conversation_id integer,
  p_user_id uuid,
  p_query text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.conversation_members member
    WHERE member."conversationId" = p_conversation_id AND member."userId" = p_user_id
  ) THEN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', message.id, 'senderId', message."senderId", 'body', message.body,
      'createdAt', message."createdAt", 'messageType', message."messageType"
    ) ORDER BY message.id DESC)
    FROM (
      SELECT m.id, m."senderId", m.body, m."createdAt", m."messageType", m.payload
      FROM public.messages m
      WHERE m."conversationId" = p_conversation_id
        AND position(lower(btrim(p_query)) IN lower(coalesce(m.body, '') || ' ' || coalesce(m.payload::text, ''))) > 0
      ORDER BY m.id DESC LIMIT 100
    ) message
  ), '[]'::jsonb) ELSE '[]'::jsonb END
$$;

CREATE OR REPLACE FUNCTION public.chat_block_user(p_user_id uuid, p_blocked_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_user_id = p_blocked_id THEN RAISE EXCEPTION 'INVALID_USER'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_blocked_id) THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  INSERT INTO public.user_blocks (blocker_id, blocked_id)
  VALUES (p_user_id, p_blocked_id) ON CONFLICT DO NOTHING;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_unblock_user(p_user_id uuid, p_blocked_id uuid)
RETURNS boolean
LANGUAGE sql
SET search_path = ''
AS $$
  WITH removed AS (
    DELETE FROM public.user_blocks WHERE blocker_id = p_user_id AND blocked_id = p_blocked_id RETURNING 1
  ) SELECT true
$$;

CREATE OR REPLACE FUNCTION public.chat_list_blocked(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', profile.id, 'name', profile.name, 'username', profile.username, 'image', profile.image
  ) ORDER BY profile.name), '[]'::jsonb)
  FROM public.user_blocks block
  JOIN public.profiles profile ON profile.id = block.blocked_id
  WHERE block.blocker_id = p_user_id
$$;

CREATE OR REPLACE FUNCTION public.chat_set_muted(
  p_user_id uuid,
  p_conversation_id integer,
  p_muted boolean
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members member
    WHERE member."conversationId" = p_conversation_id AND member."userId" = p_user_id
  ) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  INSERT INTO public.conversation_preferences ("userId", "conversationId", muted, updated_at)
  VALUES (p_user_id, p_conversation_id, p_muted, now())
  ON CONFLICT ("userId", "conversationId") DO UPDATE SET muted = EXCLUDED.muted, updated_at = now();
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_create_status(
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
  v_status public.statuses%ROWTYPE;
  v_body text := btrim(coalesce(p_body, ''));
BEGIN
  IF length(v_body) > 700 THEN RAISE EXCEPTION 'STATUS_TOO_LONG'; END IF;
  IF v_body = '' AND p_media_path IS NULL THEN RAISE EXCEPTION 'EMPTY_STATUS'; END IF;
  IF p_media_path IS NOT NULL THEN
    IF p_media_type NOT IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime')
      OR p_media_path !~ format('^status/%s/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$', p_user_id)
      OR NOT EXISTS (SELECT 1 FROM storage.objects object WHERE object.bucket_id = 'chat-media' AND object.name = p_media_path)
    THEN RAISE EXCEPTION 'INVALID_MEDIA'; END IF;
  END IF;
  INSERT INTO public.statuses ("userId", body, "mediaPath", "mediaType", "mediaName")
  VALUES (p_user_id, v_body, p_media_path, p_media_type, left(coalesce(p_media_name, ''), 255))
  RETURNING * INTO v_status;
  RETURN jsonb_build_object(
    'id', v_status.id, 'userId', v_status."userId", 'body', v_status.body,
    'mediaPath', v_status."mediaPath", 'mediaType', v_status."mediaType",
    'mediaName', v_status."mediaName", 'createdAt', v_status."createdAt", 'expiresAt', v_status."expiresAt"
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_list_statuses(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', active.id, 'userId', active."userId", 'name', active.name,
    'username', active.username, 'image', active.image, 'body', active.body,
    'mediaPath', active."mediaPath", 'mediaType', active."mediaType", 'mediaName', active."mediaName",
    'createdAt', active."createdAt", 'expiresAt', active."expiresAt"
  ) ORDER BY active."createdAt" DESC), '[]'::jsonb)
  FROM (
    SELECT status.id, status."userId", profile.name, profile.username, profile.image,
      status.body, status."mediaPath", status."mediaType", status."mediaName", status."createdAt", status."expiresAt"
    FROM public.statuses status
    JOIN public.profiles profile ON profile.id = status."userId"
    WHERE status."expiresAt" > now()
      AND (
        status."userId" = p_user_id
        OR NOT EXISTS (
          SELECT 1 FROM public.user_blocks block
          WHERE (block.blocker_id = p_user_id AND block.blocked_id = status."userId")
             OR (block.blocker_id = status."userId" AND block.blocked_id = p_user_id)
        )
      )
    ORDER BY status."createdAt" DESC
    LIMIT 100
  ) active
$$;

CREATE OR REPLACE FUNCTION public.chat_can_access_status_media(
  p_status_id uuid,
  p_user_id uuid,
  p_media_path text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.statuses status
    WHERE status.id = p_status_id AND status."mediaPath" = p_media_path
      AND status."expiresAt" > now()
      AND (
        status."userId" = p_user_id
        OR NOT EXISTS (
          SELECT 1 FROM public.user_blocks block
          WHERE (block.blocker_id = p_user_id AND block.blocked_id = status."userId")
             OR (block.blocker_id = status."userId" AND block.blocked_id = p_user_id)
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION public.chat_delete_status(p_user_id uuid, p_status_id uuid)
RETURNS boolean
LANGUAGE sql
SET search_path = ''
AS $$
  WITH removed AS (
    DELETE FROM public.statuses WHERE id = p_status_id AND "userId" = p_user_id RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM removed)
$$;

REVOKE EXECUTE ON FUNCTION public.chat_create_group(uuid, text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_send_structured_message(integer, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_vote_poll(integer, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_search_messages(integer, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_block_user(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_unblock_user(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_list_blocked(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_set_muted(uuid, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_create_status(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_list_statuses(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_can_access_status_media(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_delete_status(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.chat_create_group(uuid, text, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_send_structured_message(integer, uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_vote_poll(integer, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_search_messages(integer, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_block_user(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_unblock_user(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_list_blocked(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_set_muted(uuid, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_create_status(uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_list_statuses(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_can_access_status_media(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_delete_status(uuid, uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.chat_start_conversation(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_search_users(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_list_conversations(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_get_messages(integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_send_message(integer, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_send_media(integer, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.chat_start_conversation(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_search_users(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_list_conversations(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_get_messages(integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_send_message(integer, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_send_media(integer, uuid, text, text, text, text) TO service_role;

