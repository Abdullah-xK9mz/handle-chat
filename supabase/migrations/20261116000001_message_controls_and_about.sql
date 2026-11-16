-- Profile about text, per-message controls and delivery watermarks.
-- All existing profile/conversation/message data is retained.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS about text NOT NULL DEFAULT '';

ALTER TABLE public.conversation_members
  ADD COLUMN IF NOT EXISTS "lastDeliveredAt" timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS "deletedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "replyTo" integer,
  ADD COLUMN IF NOT EXISTS "forwardedFrom" integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_reply_to_fkey' AND conrelid='public.messages'::regclass) THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_reply_to_fkey
      FOREIGN KEY ("replyTo") REFERENCES public.messages(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_forwarded_from_fkey' AND conrelid='public.messages'::regclass) THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_forwarded_from_fkey
      FOREIGN KEY ("forwardedFrom") REFERENCES public.messages(id) ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.message_stars (
  "messageId" integer NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  "userId" uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("messageId", "userId")
);
CREATE INDEX IF NOT EXISTS message_stars_user_idx
  ON public.message_stars ("userId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS public.conversation_pins (
  "conversationId" integer NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  "messageId" integer NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  "pinnedBy" uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  "pinnedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversationId", "messageId")
);
CREATE INDEX IF NOT EXISTS conversation_pins_recent_idx
  ON public.conversation_pins ("conversationId", "pinnedAt" DESC);

ALTER TABLE public.message_stars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_pins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.message_stars, public.conversation_pins FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.message_stars, public.conversation_pins TO service_role;

CREATE OR REPLACE FUNCTION public.chat_get_profile(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'id', profile.id, 'name', profile.name, 'username', profile.username,
    'image', profile.image, 'about', profile.about
  )
  FROM public.profiles profile
  WHERE profile.id = p_user_id
$$;

CREATE OR REPLACE FUNCTION public.chat_update_profile(
  p_user_id uuid,
  p_name text,
  p_avatar_path text,
  p_update_image boolean,
  p_about text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_name text := btrim(coalesce(p_name, ''));
  v_about text := btrim(coalesce(p_about, ''));
  v_image text;
BEGIN
  IF length(v_name) = 0 THEN RAISE EXCEPTION 'NAME_REQUIRED'; END IF;
  IF length(v_name) > 50 THEN RAISE EXCEPTION 'NAME_TOO_LONG'; END IF;
  IF length(v_about) > 150 THEN RAISE EXCEPTION 'ABOUT_TOO_LONG'; END IF;

  IF p_update_image THEN
    IF p_avatar_path IS NULL THEN
      v_image := NULL;
    ELSE
      IF p_avatar_path !~ format('^%s/[0-9a-f-]{36}\.(jpg|png|webp)$', p_user_id)
        OR NOT EXISTS (
          SELECT 1 FROM storage.objects object
          WHERE object.bucket_id = 'avatars' AND object.name = p_avatar_path
        ) THEN RAISE EXCEPTION 'INVALID_IMAGE'; END IF;
      v_image := 'https://uzzjkfriikqsoxjlzjbe.supabase.co/storage/v1/object/public/avatars/' || p_avatar_path;
    END IF;
  END IF;

  UPDATE public.profiles
  SET name = v_name,
      about = v_about,
      image = CASE WHEN p_update_image THEN v_image ELSE image END
  WHERE id = p_user_id;

  RETURN (
    SELECT jsonb_build_object(
      'id', profile.id, 'name', profile.name, 'username', profile.username,
      'image', profile.image, 'about', profile.about
    )
    FROM public.profiles profile WHERE profile.id = p_user_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_search_users(p_user_id uuid, p_query text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'username', matches.username, 'name', matches.name, 'image', matches.image, 'about', matches.about
  ) ORDER BY matches.username), '[]'::jsonb)
  FROM (
    SELECT profile.username, profile.name, profile.image, profile.about
    FROM public.profiles profile
    WHERE profile.id <> p_user_id
      AND left(profile.username, char_length(p_query)) = p_query
      AND NOT EXISTS (
        SELECT 1 FROM public.user_blocks block
        WHERE (block.blocker_id = p_user_id AND block.blocked_id = profile.id)
           OR (block.blocker_id = profile.id AND block.blocked_id = p_user_id)
      )
    ORDER BY profile.username LIMIT 8
  ) matches
$$;

CREATE OR REPLACE FUNCTION public.chat_list_conversations(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  UPDATE public.conversation_members mine
  SET "lastDeliveredAt" = now()
  WHERE mine."userId" = p_user_id
    AND EXISTS (
      SELECT 1 FROM public.messages message
      WHERE message."conversationId" = mine."conversationId"
        AND message."senderId" <> p_user_id
        AND message."createdAt" > mine."lastDeliveredAt"
    );

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'lastMessageAt', c."lastMessageAt",
    'isGroup', c.kind = 'group',
    'groupName', c.name,
    'otherUserId', peer.id,
    'otherUsername', peer.username,
    'otherName', CASE WHEN c.kind = 'group' THEN c.name ELSE peer.name END,
    'otherImage', CASE WHEN c.kind = 'group' THEN NULL ELSE peer.image END,
    'otherAbout', CASE WHEN c.kind = 'group' THEN NULL ELSE peer.about END,
    'participantCount', (SELECT count(*)::integer FROM public.conversation_members member WHERE member."conversationId" = c.id),
    'lastBody', (SELECT message.body FROM public.messages message WHERE message."conversationId" = c.id ORDER BY message.id DESC LIMIT 1),
    'lastMediaType', (SELECT message."mediaType" FROM public.messages message WHERE message."conversationId" = c.id ORDER BY message.id DESC LIMIT 1),
    'lastMessageType', (SELECT message."messageType" FROM public.messages message WHERE message."conversationId" = c.id ORDER BY message.id DESC LIMIT 1),
    'lastSenderId', (SELECT message."senderId" FROM public.messages message WHERE message."conversationId" = c.id ORDER BY message.id DESC LIMIT 1),
    'unreadCount', (
      SELECT count(*)::integer FROM public.messages message
      WHERE message."conversationId" = c.id AND message."senderId" <> p_user_id
        AND message."createdAt" > mine."lastReadAt"
    ),
    'isMuted', coalesce(pref.muted, false)
  ) ORDER BY c."lastMessageAt" DESC), '[]'::jsonb)
  INTO v_result
  FROM public.conversation_members mine
  JOIN public.conversations c ON c.id = mine."conversationId"
  LEFT JOIN LATERAL (
    SELECT profile.id, profile.username, profile.name, profile.image, profile.about
    FROM public.conversation_members member
    JOIN public.profiles profile ON profile.id = member."userId"
    WHERE member."conversationId" = c.id AND member."userId" <> p_user_id
    ORDER BY profile.username LIMIT 1
  ) peer ON true
  LEFT JOIN public.conversation_preferences pref
    ON pref."userId" = p_user_id AND pref."conversationId" = c.id
  WHERE mine."userId" = p_user_id;

  RETURN v_result;
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
  v_conversation jsonb;
  v_other_read_at timestamptz;
  v_other_delivered_at timestamptz;
  v_pinned jsonb;
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
      'about', CASE WHEN c.kind = 'group' THEN NULL ELSE peer.about END,
      'isGroup', c.kind = 'group',
      'participantCount', (SELECT count(*)::integer FROM public.conversation_members m WHERE m."conversationId" = c.id),
      'members', CASE WHEN c.kind = 'group' THEN (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', profile.id, 'name', profile.name, 'username', profile.username,
          'image', profile.image, 'about', profile.about
        ) ORDER BY profile.name), '[]'::jsonb)
        FROM public.conversation_members m JOIN public.profiles profile ON profile.id = m."userId"
        WHERE m."conversationId" = c.id
      ) ELSE '[]'::jsonb END,
      'isBlockedByMe', CASE WHEN c.kind = 'group' THEN false ELSE EXISTS (
        SELECT 1 FROM public.user_blocks block WHERE block.blocker_id = p_user_id AND block.blocked_id = peer.id
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
    (SELECT min(member."lastReadAt") FROM public.conversation_members member WHERE member."conversationId" = c.id AND member."userId" <> p_user_id),
    (SELECT min(member."lastDeliveredAt") FROM public.conversation_members member WHERE member."conversationId" = c.id AND member."userId" <> p_user_id),
    (
      SELECT jsonb_build_object(
        'id', message.id, 'body', message.body, 'deleted', message."deletedAt" IS NOT NULL,
        'senderId', message."senderId"
      )
      FROM public.conversation_pins pin
      JOIN public.messages message ON message.id = pin."messageId"
      WHERE pin."conversationId" = c.id
      ORDER BY pin."pinnedAt" DESC LIMIT 1
    )
  INTO v_other, v_conversation, v_other_read_at, v_other_delivered_at, v_pinned
  FROM public.conversations c
  LEFT JOIN LATERAL (
    SELECT profile.id, profile.username, profile.name, profile.image, profile.about
    FROM public.conversation_members member
    JOIN public.profiles profile ON profile.id = member."userId"
    WHERE member."conversationId" = c.id AND member."userId" <> p_user_id
    ORDER BY profile.username LIMIT 1
  ) peer ON true
  LEFT JOIN public.conversation_preferences pref ON pref."userId" = p_user_id AND pref."conversationId" = c.id
  WHERE c.id = p_conversation_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', recent.id,
    'senderId', recent."senderId",
    'body', CASE WHEN recent."deletedAt" IS NOT NULL THEN '' ELSE recent.body END,
    'createdAt', recent."createdAt",
    'mediaPath', CASE WHEN recent."deletedAt" IS NOT NULL THEN NULL ELSE recent."mediaPath" END,
    'mediaType', CASE WHEN recent."deletedAt" IS NOT NULL THEN NULL ELSE recent."mediaType" END,
    'mediaName', recent."mediaName",
    'messageType', CASE WHEN recent."deletedAt" IS NOT NULL THEN 'text' ELSE recent."messageType" END,
    'payload', CASE WHEN recent."deletedAt" IS NOT NULL THEN '{}'::jsonb
      WHEN recent."messageType" = 'poll' THEN recent.payload || jsonb_build_object(
        'counts', (
          SELECT coalesce(jsonb_agg(coalesce(votes.vote_count, 0) ORDER BY opt.idx), '[]'::jsonb)
          FROM generate_series(0, jsonb_array_length(recent.payload->'options') - 1) AS opt(idx)
          LEFT JOIN (
            SELECT vote.option_index, count(*)::integer AS vote_count
            FROM public.poll_votes vote WHERE vote."messageId" = recent.id GROUP BY vote.option_index
          ) votes ON votes.option_index = opt.idx
        ),
        'myVote', (SELECT vote.option_index FROM public.poll_votes vote WHERE vote."messageId" = recent.id AND vote."userId" = p_user_id)
      ) ELSE recent.payload END,
    'deletedAt', recent."deletedAt",
    'replyTo', recent."replyTo",
    'replyBody', CASE WHEN parent."deletedAt" IS NOT NULL THEN NULL ELSE parent.body END,
    'replyDeleted', coalesce(parent."deletedAt" IS NOT NULL, false),
    'replySenderName', reply_sender.name,
    'forwardedFrom', recent."forwardedFrom",
    'starredByMe', EXISTS (SELECT 1 FROM public.message_stars star WHERE star."messageId" = recent.id AND star."userId" = p_user_id),
    'pinned', EXISTS (SELECT 1 FROM public.conversation_pins pin WHERE pin."messageId" = recent.id AND pin."conversationId" = p_conversation_id)
  ) ORDER BY recent.id ASC), '[]'::jsonb)
  INTO v_messages
  FROM (
    SELECT id, "senderId", body, "createdAt", "mediaPath", "mediaType", "mediaName",
      "messageType", payload, "deletedAt", "replyTo", "forwardedFrom"
    FROM public.messages WHERE "conversationId" = p_conversation_id
    ORDER BY id DESC LIMIT 500
  ) recent
  LEFT JOIN public.messages parent ON parent.id = recent."replyTo"
  LEFT JOIN public.profiles reply_sender ON reply_sender.id = parent."senderId";

  UPDATE public.conversation_members
  SET "lastReadAt" = now(), "lastDeliveredAt" = now()
  WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id;

  RETURN jsonb_build_object(
    'other', v_other,
    'conversation', v_conversation,
    'otherLastReadAt', v_other_read_at,
    'otherLastDeliveredAt', v_other_delivered_at,
    'pinnedMessage', v_pinned,
    'messages', v_messages
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_send_message(
  p_conversation_id integer,
  p_user_id uuid,
  p_body text,
  p_reply_to integer
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_message public.messages%ROWTYPE;
BEGIN
  IF length(btrim(p_body)) = 0 THEN RAISE EXCEPTION 'EMPTY_MESSAGE'; END IF;
  IF length(p_body) > 4000 THEN RAISE EXCEPTION 'MESSAGE_TOO_LONG'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.conversation_members WHERE "conversationId"=p_conversation_id AND "userId"=p_user_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.conversation_members peer ON peer."conversationId"=c.id AND peer."userId"<>p_user_id
    JOIN public.user_blocks block ON (block.blocker_id=p_user_id AND block.blocked_id=peer."userId") OR (block.blocker_id=peer."userId" AND block.blocked_id=p_user_id)
    WHERE c.id=p_conversation_id AND c.kind='direct'
  ) THEN RAISE EXCEPTION 'USER_BLOCKED'; END IF;
  IF p_reply_to IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.messages WHERE id=p_reply_to AND "conversationId"=p_conversation_id AND "deletedAt" IS NULL
  ) THEN RAISE EXCEPTION 'INVALID_REPLY'; END IF;

  INSERT INTO public.messages ("conversationId","senderId",body,"messageType",payload,"replyTo")
  VALUES (p_conversation_id,p_user_id,btrim(p_body),'text','{}'::jsonb,p_reply_to)
  RETURNING * INTO v_message;
  UPDATE public.conversations SET "lastMessageAt"=v_message."createdAt" WHERE id=p_conversation_id;
  UPDATE public.conversation_members SET "lastReadAt"=v_message."createdAt" WHERE "conversationId"=p_conversation_id AND "userId"=p_user_id;
  RETURN jsonb_build_object('id',v_message.id,'senderId',v_message."senderId",'body',v_message.body,'createdAt',v_message."createdAt",'messageType',v_message."messageType",'payload',v_message.payload,'replyTo',v_message."replyTo");
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_send_media(
  p_conversation_id integer,
  p_user_id uuid,
  p_body text,
  p_media_path text,
  p_media_type text,
  p_media_name text,
  p_reply_to integer
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_message public.messages%ROWTYPE; v_body text:=btrim(coalesce(p_body,'')); v_message_type text;
BEGIN
  IF length(v_body)>4000 THEN RAISE EXCEPTION 'MESSAGE_TOO_LONG'; END IF;
  IF p_media_type NOT IN (
    'image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime',
    'audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','application/pdf','text/plain','text/csv',
    'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) THEN RAISE EXCEPTION 'INVALID_MEDIA'; END IF;
  IF p_media_path !~ format('^%s/%s/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif|mp4|webm|mov|ogg|mpeg|wav|pdf|txt|csv|doc|docx|xls|xlsx|ppt|pptx)$',p_conversation_id,p_user_id)
    OR NOT EXISTS (SELECT 1 FROM storage.objects object WHERE object.bucket_id='chat-media' AND object.name=p_media_path)
  THEN RAISE EXCEPTION 'INVALID_MEDIA'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.conversation_members WHERE "conversationId"=p_conversation_id AND "userId"=p_user_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.conversation_members peer ON peer."conversationId"=c.id AND peer."userId"<>p_user_id
    JOIN public.user_blocks block ON (block.blocker_id=p_user_id AND block.blocked_id=peer."userId") OR (block.blocker_id=peer."userId" AND block.blocked_id=p_user_id)
    WHERE c.id=p_conversation_id AND c.kind='direct'
  ) THEN RAISE EXCEPTION 'USER_BLOCKED'; END IF;
  IF p_reply_to IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.messages WHERE id=p_reply_to AND "conversationId"=p_conversation_id AND "deletedAt" IS NULL) THEN RAISE EXCEPTION 'INVALID_REPLY'; END IF;

  v_message_type:=CASE WHEN p_media_type LIKE 'image/%' THEN 'image' WHEN p_media_type LIKE 'video/%' THEN 'video' WHEN p_media_type LIKE 'audio/%' THEN 'voice' ELSE 'document' END;
  INSERT INTO public.messages ("conversationId","senderId",body,"mediaPath","mediaType","mediaName","messageType",payload,"replyTo")
  VALUES (p_conversation_id,p_user_id,v_body,p_media_path,p_media_type,left(regexp_replace(coalesce(p_media_name,''),'[[:cntrl:]/\\]','','g'),255),v_message_type,'{}'::jsonb,p_reply_to)
  RETURNING * INTO v_message;
  UPDATE public.conversations SET "lastMessageAt"=v_message."createdAt" WHERE id=p_conversation_id;
  UPDATE public.conversation_members SET "lastReadAt"=v_message."createdAt" WHERE "conversationId"=p_conversation_id AND "userId"=p_user_id;
  RETURN jsonb_build_object('id',v_message.id,'senderId',v_message."senderId",'body',v_message.body,'createdAt',v_message."createdAt",'mediaPath',v_message."mediaPath",'mediaType',v_message."mediaType",'mediaName',v_message."mediaName",'messageType',v_message."messageType",'payload',v_message.payload,'replyTo',v_message."replyTo");
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_send_structured_message(
  p_conversation_id integer,
  p_user_id uuid,
  p_message_type text,
  p_body text,
  p_payload jsonb,
  p_reply_to integer
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_message public.messages%ROWTYPE; v_body text:=btrim(coalesce(p_body,''));
BEGIN
  IF p_message_type NOT IN ('location','contact','poll','event') OR jsonb_typeof(coalesce(p_payload,'{}'::jsonb))<>'object' THEN RAISE EXCEPTION 'INVALID_MESSAGE'; END IF;
  IF length(v_body)>4000 THEN RAISE EXCEPTION 'MESSAGE_TOO_LONG'; END IF;
  IF p_message_type='location' AND (NOT (p_payload?'latitude') OR NOT (p_payload?'longitude') OR (p_payload->>'latitude')::numeric NOT BETWEEN -90 AND 90 OR (p_payload->>'longitude')::numeric NOT BETWEEN -180 AND 180) THEN RAISE EXCEPTION 'INVALID_MESSAGE'; END IF;
  IF p_message_type='contact' AND length(btrim(coalesce(p_payload->>'name','')))=0 THEN RAISE EXCEPTION 'INVALID_MESSAGE'; END IF;
  IF p_message_type='poll' AND (length(btrim(coalesce(p_payload->>'question','')))=0 OR jsonb_typeof(p_payload->'options')<>'array' OR jsonb_array_length(p_payload->'options')<2 OR jsonb_array_length(p_payload->'options')>10) THEN RAISE EXCEPTION 'INVALID_POLL'; END IF;
  IF p_message_type='event' AND (length(btrim(coalesce(p_payload->>'title','')))=0 OR nullif(p_payload->>'startsAt','') IS NULL) THEN RAISE EXCEPTION 'INVALID_MESSAGE'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.conversation_members WHERE "conversationId"=p_conversation_id AND "userId"=p_user_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p_reply_to IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.messages WHERE id=p_reply_to AND "conversationId"=p_conversation_id AND "deletedAt" IS NULL) THEN RAISE EXCEPTION 'INVALID_REPLY'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.conversations c JOIN public.conversation_members peer ON peer."conversationId"=c.id AND peer."userId"<>p_user_id
    JOIN public.user_blocks block ON (block.blocker_id=p_user_id AND block.blocked_id=peer."userId") OR (block.blocker_id=peer."userId" AND block.blocked_id=p_user_id)
    WHERE c.id=p_conversation_id AND c.kind='direct'
  ) THEN RAISE EXCEPTION 'USER_BLOCKED'; END IF;
  INSERT INTO public.messages ("conversationId","senderId",body,"messageType",payload,"replyTo") VALUES (p_conversation_id,p_user_id,v_body,p_message_type,p_payload,p_reply_to) RETURNING * INTO v_message;
  UPDATE public.conversations SET "lastMessageAt"=v_message."createdAt" WHERE id=p_conversation_id;
  UPDATE public.conversation_members SET "lastReadAt"=v_message."createdAt" WHERE "conversationId"=p_conversation_id AND "userId"=p_user_id;
  RETURN jsonb_build_object('id',v_message.id,'senderId',v_message."senderId",'body',v_message.body,'createdAt',v_message."createdAt",'messageType',v_message."messageType",'payload',v_message.payload,'replyTo',v_message."replyTo");
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_delete_message(p_user_id uuid,p_message_id integer)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.messages SET "deletedAt"=now(), body='', "mediaPath"=NULL, "mediaType"=NULL, "mediaName"=NULL, "messageType"='text', payload='{}'::jsonb
  WHERE id=p_message_id AND "senderId"=p_user_id AND "deletedAt" IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  DELETE FROM public.message_stars WHERE "messageId"=p_message_id;
  DELETE FROM public.conversation_pins WHERE "messageId"=p_message_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_set_star(p_user_id uuid,p_message_id integer,p_starred boolean)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_conversation_id integer;
BEGIN
  SELECT "conversationId" INTO v_conversation_id FROM public.messages WHERE id=p_message_id;
  IF v_conversation_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.conversation_members WHERE "conversationId"=v_conversation_id AND "userId"=p_user_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p_starred THEN INSERT INTO public.message_stars ("messageId","userId") VALUES (p_message_id,p_user_id) ON CONFLICT DO NOTHING;
  ELSE DELETE FROM public.message_stars WHERE "messageId"=p_message_id AND "userId"=p_user_id; END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_set_pin(p_user_id uuid,p_message_id integer,p_pinned boolean)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_conversation_id integer;
BEGIN
  SELECT "conversationId" INTO v_conversation_id FROM public.messages WHERE id=p_message_id AND "deletedAt" IS NULL;
  IF v_conversation_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.conversation_members WHERE "conversationId"=v_conversation_id AND "userId"=p_user_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p_pinned THEN INSERT INTO public.conversation_pins ("conversationId","messageId","pinnedBy") VALUES (v_conversation_id,p_message_id,p_user_id) ON CONFLICT DO NOTHING;
  ELSE DELETE FROM public.conversation_pins WHERE "conversationId"=v_conversation_id AND "messageId"=p_message_id; END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_forward_message(p_user_id uuid,p_message_id integer,p_target_conversation_id integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_source public.messages%ROWTYPE; v_copy public.messages%ROWTYPE;
BEGIN
  SELECT * INTO v_source FROM public.messages WHERE id=p_message_id AND "deletedAt" IS NULL;
  IF v_source.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.conversation_members WHERE "conversationId"=v_source."conversationId" AND "userId"=p_user_id)
    OR NOT EXISTS (SELECT 1 FROM public.conversation_members WHERE "conversationId"=p_target_conversation_id AND "userId"=p_user_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.conversations c JOIN public.conversation_members peer ON peer."conversationId"=c.id AND peer."userId"<>p_user_id
    JOIN public.user_blocks block ON (block.blocker_id=p_user_id AND block.blocked_id=peer."userId") OR (block.blocker_id=peer."userId" AND block.blocked_id=p_user_id)
    WHERE c.id=p_target_conversation_id AND c.kind='direct'
  ) THEN RAISE EXCEPTION 'USER_BLOCKED'; END IF;
  INSERT INTO public.messages ("conversationId","senderId",body,"mediaPath","mediaType","mediaName","messageType",payload,"forwardedFrom")
  VALUES (p_target_conversation_id,p_user_id,v_source.body,v_source."mediaPath",v_source."mediaType",v_source."mediaName",v_source."messageType",v_source.payload,v_source.id)
  RETURNING * INTO v_copy;
  UPDATE public.conversations SET "lastMessageAt"=v_copy."createdAt" WHERE id=p_target_conversation_id;
  UPDATE public.conversation_members SET "lastReadAt"=v_copy."createdAt" WHERE "conversationId"=p_target_conversation_id AND "userId"=p_user_id;
  RETURN jsonb_build_object('id',v_copy.id,'senderId',v_copy."senderId",'body',v_copy.body,'createdAt',v_copy."createdAt",'mediaPath',v_copy."mediaPath",'mediaType',v_copy."mediaType",'mediaName',v_copy."mediaName",'messageType',v_copy."messageType",'payload',v_copy.payload,'forwardedFrom',v_copy."forwardedFrom");
END;
$$;

REVOKE EXECUTE ON FUNCTION public.chat_update_profile(uuid,text,text,boolean,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_send_message(integer,uuid,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_send_media(integer,uuid,text,text,text,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_send_structured_message(integer,uuid,text,text,jsonb,integer) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_delete_message(uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_set_star(uuid,integer,boolean) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_set_pin(uuid,integer,boolean) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_forward_message(uuid,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.chat_update_profile(uuid,text,text,boolean,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_send_message(integer,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_send_media(integer,uuid,text,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_send_structured_message(integer,uuid,text,text,jsonb,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_delete_message(uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_set_star(uuid,integer,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_set_pin(uuid,integer,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_forward_message(uuid,integer,integer) TO service_role;
