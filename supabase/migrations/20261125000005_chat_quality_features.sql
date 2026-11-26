-- User-facing chat quality features. Existing messages and memberships are kept.

ALTER TABLE public.conversation_members
  ADD COLUMN IF NOT EXISTS "archivedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "pinnedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "manualUnread" boolean NOT NULL DEFAULT false;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS "expiresInSeconds" integer;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS "editedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "expiresAt" timestamptz;
CREATE INDEX IF NOT EXISTS messages_expiry_idx
  ON public.messages ("expiresAt") WHERE "expiresAt" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_expiry_duration_check'
      AND conrelid = 'public.conversations'::regclass
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_expiry_duration_check
      CHECK ("expiresInSeconds" IS NULL OR "expiresInSeconds" IN (86400, 604800, 7776000));
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.message_reactions (
  "messageId" integer NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  "userId" uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (emoji IN ('👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("messageId", "userId")
);
CREATE INDEX IF NOT EXISTS message_reactions_message_idx
  ON public.message_reactions ("messageId", emoji);

ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.message_reactions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.message_reactions TO service_role;

CREATE OR REPLACE FUNCTION public.chat_apply_message_expiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_duration integer;
BEGIN
  SELECT c."expiresInSeconds" INTO v_duration
  FROM public.conversations c WHERE c.id = NEW."conversationId";
  IF v_duration IS NOT NULL AND NEW."expiresAt" IS NULL THEN
    NEW."expiresAt" := NEW."createdAt" + make_interval(secs => v_duration);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_apply_message_expiry() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS chat_apply_message_expiry ON public.messages;
CREATE TRIGGER chat_apply_message_expiry
BEFORE INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.chat_apply_message_expiry();

CREATE OR REPLACE FUNCTION public.chat_update_conversation_state(
  p_user_id uuid,
  p_conversation_id integer,
  p_archived boolean DEFAULT NULL,
  p_pinned boolean DEFAULT NULL,
  p_marked_unread boolean DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.conversation_members member
  SET "archivedAt" = CASE WHEN p_archived IS NULL THEN member."archivedAt" WHEN p_archived THEN now() ELSE NULL END,
      "pinnedAt" = CASE WHEN p_pinned IS NULL THEN member."pinnedAt" WHEN p_pinned THEN coalesce(member."pinnedAt", now()) ELSE NULL END,
      "manualUnread" = coalesce(p_marked_unread, member."manualUnread"),
      "lastReadAt" = CASE WHEN p_marked_unread IS FALSE THEN now() ELSE member."lastReadAt" END,
      "lastDeliveredAt" = CASE WHEN p_marked_unread IS FALSE THEN now() ELSE member."lastDeliveredAt" END
  WHERE member."conversationId" = p_conversation_id AND member."userId" = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_set_expiry_duration(
  p_user_id uuid,
  p_conversation_id integer,
  p_duration_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_group boolean; v_admin boolean;
BEGIN
  SELECT c.kind = 'group', coalesce(member.role = 'admin' OR c."createdBy" = p_user_id, false)
  INTO v_group, v_admin
  FROM public.conversations c
  JOIN public.conversation_members member ON member."conversationId" = c.id AND member."userId" = p_user_id
  WHERE c.id = p_conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_group AND NOT v_admin THEN RAISE EXCEPTION 'GROUP_ADMIN_ONLY'; END IF;
  IF p_duration_seconds IS NOT NULL AND p_duration_seconds NOT IN (86400, 604800, 7776000) THEN
    RAISE EXCEPTION 'INVALID_EXPIRY_DURATION';
  END IF;
  UPDATE public.conversations SET "expiresInSeconds" = p_duration_seconds WHERE id = p_conversation_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_get_expired_media_paths()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(DISTINCT message."mediaPath"), ARRAY[]::text[])
  FROM public.messages message
  WHERE message."expiresAt" IS NOT NULL AND message."expiresAt" <= now()
    AND message."mediaPath" IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION public.chat_purge_expired_messages()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.messages WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= now();
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_edit_message(
  p_user_id uuid,
  p_message_id integer,
  p_body text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF length(btrim(coalesce(p_body, ''))) = 0 THEN RAISE EXCEPTION 'EMPTY_MESSAGE'; END IF;
  IF length(p_body) > 4000 THEN RAISE EXCEPTION 'MESSAGE_TOO_LONG'; END IF;
  UPDATE public.messages
  SET body = btrim(p_body), "editedAt" = now()
  WHERE id = p_message_id AND "senderId" = p_user_id AND "messageType" = 'text'
    AND "deletedAt" IS NULL AND "createdAt" > now() - interval '15 minutes'
    AND EXISTS (
      SELECT 1 FROM public.conversation_members member
      WHERE member."conversationId" = messages."conversationId" AND member."userId" = p_user_id
    );
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSAGE_NOT_EDITABLE'; END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_set_message_reaction(
  p_user_id uuid,
  p_message_id integer,
  p_emoji text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_conversation_id integer;
BEGIN
  SELECT message."conversationId" INTO v_conversation_id
  FROM public.messages message
  WHERE message.id = p_message_id AND message."deletedAt" IS NULL
    AND (message."expiresAt" IS NULL OR message."expiresAt" > now());
  IF v_conversation_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.conversation_members member
    WHERE member."conversationId" = v_conversation_id AND member."userId" = p_user_id
  ) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p_emoji IS NULL THEN
    DELETE FROM public.message_reactions WHERE "messageId" = p_message_id AND "userId" = p_user_id;
  ELSE
    IF p_emoji NOT IN ('👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏') THEN RAISE EXCEPTION 'INVALID_REACTION'; END IF;
    INSERT INTO public.message_reactions ("messageId", "userId", emoji)
    VALUES (p_message_id, p_user_id, p_emoji)
    ON CONFLICT ("messageId", "userId") DO UPDATE SET emoji = EXCLUDED.emoji, "createdAt" = now();
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_get_conversation_features(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'archived', mine."archivedAt" IS NOT NULL,
    'pinned', mine."pinnedAt" IS NOT NULL,
    'markedUnread', mine."manualUnread",
    'pinnedAt', mine."pinnedAt",
    'expiresInSeconds', c."expiresInSeconds",
    'hasStarredMessages', EXISTS (
      SELECT 1 FROM public.message_stars star
      JOIN public.messages starred ON starred.id = star."messageId"
      WHERE star."userId" = p_user_id AND starred."conversationId" = c.id
        AND starred."deletedAt" IS NULL
        AND (starred."expiresAt" IS NULL OR starred."expiresAt" > now())
    ),
    'unreadCount', CASE WHEN mine."manualUnread" THEN greatest(coalesce((
      SELECT count(*)::integer FROM public.messages message
      WHERE message."conversationId" = c.id AND message."senderId" <> p_user_id
        AND message."createdAt" > mine."lastReadAt" AND message."deletedAt" IS NULL
        AND (message."expiresAt" IS NULL OR message."expiresAt" > now())
    ), 0), 1) ELSE (
      SELECT count(*)::integer FROM public.messages message
      WHERE message."conversationId" = c.id AND message."senderId" <> p_user_id
        AND message."createdAt" > mine."lastReadAt" AND message."deletedAt" IS NULL
        AND (message."expiresAt" IS NULL OR message."expiresAt" > now())
    ) END,
    'lastMessageAt', coalesce(last_message."createdAt", c."createdAt"),
    'lastBody', CASE WHEN last_message."deletedAt" IS NOT NULL THEN '' ELSE last_message.body END,
    'lastMediaType', CASE WHEN last_message."deletedAt" IS NOT NULL THEN NULL ELSE last_message."mediaType" END,
    'lastMessageType', CASE WHEN last_message."deletedAt" IS NOT NULL THEN 'text' ELSE last_message."messageType" END,
    'lastSenderId', last_message."senderId"
  ) ORDER BY mine."pinnedAt" DESC NULLS LAST, coalesce(last_message."createdAt", c."createdAt") DESC), '[]'::jsonb)
  FROM public.conversation_members mine
  JOIN public.conversations c ON c.id = mine."conversationId"
  LEFT JOIN LATERAL (
    SELECT message."createdAt", message.body, message."mediaType", message."messageType", message."senderId", message."deletedAt"
    FROM public.messages message
    WHERE message."conversationId" = c.id
      AND (message."expiresAt" IS NULL OR message."expiresAt" > now())
    ORDER BY message.id DESC LIMIT 1
  ) last_message ON true
  WHERE mine."userId" = p_user_id
$$;

CREATE OR REPLACE FUNCTION public.chat_get_message_features(p_user_id uuid, p_conversation_id integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.conversation_members member
    WHERE member."conversationId" = p_conversation_id AND member."userId" = p_user_id
  ) THEN jsonb_build_object(
    'expiresInSeconds', (SELECT c."expiresInSeconds" FROM public.conversations c WHERE c.id = p_conversation_id),
    'messages', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', recent.id,
        'editedAt', recent."editedAt",
        'expiresAt', recent."expiresAt",
        'reactions', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'emoji', reaction.emoji,
            'count', reaction.total,
            'reactedByMe', reaction.mine
          ) ORDER BY reaction.emoji)
          FROM (
            SELECT r.emoji, count(*)::integer AS total, bool_or(r."userId" = p_user_id) AS mine
            FROM public.message_reactions r WHERE r."messageId" = recent.id GROUP BY r.emoji
          ) reaction
        ), '[]'::jsonb)
      ) ORDER BY recent.id ASC)
      FROM (
        SELECT message.id, message."editedAt", message."expiresAt"
        FROM public.messages message
        WHERE message."conversationId" = p_conversation_id
        ORDER BY message.id DESC LIMIT 500
      ) recent
    ), '[]'::jsonb)
  ) ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION public.chat_search_messages(
  p_conversation_id integer,
  p_user_id uuid,
  p_query text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
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
        AND m."deletedAt" IS NULL
        AND (m."expiresAt" IS NULL OR m."expiresAt" > now())
        AND position(lower(btrim(p_query)) IN lower(coalesce(m.body, '') || ' ' || coalesce(m.payload::text, ''))) > 0
      ORDER BY m.id DESC LIMIT 100
    ) message
  ), '[]'::jsonb) ELSE '[]'::jsonb END
$$;

CREATE OR REPLACE FUNCTION public.chat_export_conversation(p_user_id uuid, p_conversation_id integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.conversation_members member
    WHERE member."conversationId" = p_conversation_id AND member."userId" = p_user_id
  ) THEN jsonb_build_object(
    'conversationId', c.id,
    'name', coalesce(c.name, peer.name, 'Conversation'),
    'exportedAt', now(),
    'messages', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', message.id, 'sender', sender.username, 'body', CASE WHEN message."deletedAt" IS NULL THEN message.body ELSE '[deleted]' END,
        'createdAt', message."createdAt", 'editedAt', message."editedAt",
        'messageType', message."messageType", 'mediaName', message."mediaName", 'mediaType', message."mediaType",
        'payload', CASE WHEN message."deletedAt" IS NULL THEN message.payload ELSE '{}'::jsonb END
      ) ORDER BY message.id)
      FROM public.messages message
      LEFT JOIN public.profiles sender ON sender.id = message."senderId"
      WHERE message."conversationId" = c.id AND (message."expiresAt" IS NULL OR message."expiresAt" > now())
    ), '[]'::jsonb)
  ) ELSE NULL END
  FROM public.conversations c
  LEFT JOIN LATERAL (
    SELECT profile.name FROM public.conversation_members member
    JOIN public.profiles profile ON profile.id = member."userId"
    WHERE member."conversationId" = c.id AND member."userId" <> p_user_id ORDER BY profile.name LIMIT 1
  ) peer ON true
  WHERE c.id = p_conversation_id
$$;

CREATE OR REPLACE FUNCTION public.chat_export_user_data(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'exportedAt', now(),
    'profile', (SELECT jsonb_build_object('username', profile.username, 'name', profile.name, 'about', profile.about, 'createdAt', profile.created_at) FROM public.profiles profile WHERE profile.id = p_user_id),
    'conversations', coalesce((
      SELECT jsonb_agg(public.chat_export_conversation(p_user_id, member."conversationId") ORDER BY conversation."lastMessageAt" DESC)
      FROM public.conversation_members member JOIN public.conversations conversation ON conversation.id = member."conversationId"
      WHERE member."userId" = p_user_id
    ), '[]'::jsonb)
  )
$$;

CREATE OR REPLACE FUNCTION public.chat_broadcast_reaction_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_message_id integer; v_conversation_id integer;
BEGIN
  v_message_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."messageId" ELSE NEW."messageId" END;
  SELECT message."conversationId" INTO v_conversation_id FROM public.messages message WHERE message.id = v_message_id;
  IF v_conversation_id IS NOT NULL THEN PERFORM public.chat_broadcast_updates_for_conversation(v_conversation_id); END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_broadcast_reaction_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS chat_broadcast_reaction_change ON public.message_reactions;
CREATE TRIGGER chat_broadcast_reaction_change
AFTER INSERT OR UPDATE OR DELETE ON public.message_reactions
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_reaction_change();

DROP TRIGGER IF EXISTS chat_broadcast_chat_state_change ON public.conversation_members;
CREATE TRIGGER chat_broadcast_chat_state_change
AFTER UPDATE OF "archivedAt", "pinnedAt", "manualUnread" ON public.conversation_members
FOR EACH ROW
WHEN (
  OLD."archivedAt" IS DISTINCT FROM NEW."archivedAt"
  OR OLD."pinnedAt" IS DISTINCT FROM NEW."pinnedAt"
  OR OLD."manualUnread" IS DISTINCT FROM NEW."manualUnread"
)
EXECUTE FUNCTION public.chat_broadcast_membership_change();

DROP TRIGGER IF EXISTS chat_broadcast_expiry_settings_change ON public.conversations;
CREATE TRIGGER chat_broadcast_expiry_settings_change
AFTER UPDATE OF "expiresInSeconds" ON public.conversations
FOR EACH ROW
WHEN (OLD."expiresInSeconds" IS DISTINCT FROM NEW."expiresInSeconds")
EXECUTE FUNCTION public.chat_broadcast_conversation_change();

REVOKE ALL ON FUNCTION public.chat_update_conversation_state(uuid, integer, boolean, boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_set_expiry_duration(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_purge_expired_messages() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_get_expired_media_paths() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_edit_message(uuid, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_set_message_reaction(uuid, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_get_conversation_features(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_get_message_features(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_export_conversation(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_export_user_data(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_search_messages(integer, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_update_conversation_state(uuid, integer, boolean, boolean, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_set_expiry_duration(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_purge_expired_messages() TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_get_expired_media_paths() TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_edit_message(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_set_message_reaction(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_get_conversation_features(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_get_message_features(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_export_conversation(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_export_user_data(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_search_messages(integer, uuid, text) TO service_role;
