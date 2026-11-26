CREATE TABLE IF NOT EXISTS public.message_drafts (
  "userId" uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  "conversationId" integer NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  body text NOT NULL DEFAULT '',
  "replyTo" integer REFERENCES public.messages(id) ON DELETE SET NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "conversationId"),
  CONSTRAINT message_drafts_body_length CHECK (char_length(body) <= 4000)
);

CREATE TABLE IF NOT EXISTS public.scheduled_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  "conversationId" integer NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  body text NOT NULL,
  "replyTo" integer REFERENCES public.messages(id) ON DELETE SET NULL,
  "sendAt" timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  "messageId" integer REFERENCES public.messages(id) ON DELETE SET NULL,
  error text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_messages_body_length CHECK (char_length(body) BETWEEN 1 AND 4000)
);
CREATE INDEX IF NOT EXISTS scheduled_messages_due_idx
  ON public.scheduled_messages ("sendAt") WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.user_privacy_settings (
  "userId" uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  read_receipts boolean NOT NULL DEFAULT true,
  presence_visibility text NOT NULL DEFAULT 'contacts' CHECK (presence_visibility IN ('everyone', 'contacts', 'nobody')),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.conversation_preferences
  ADD COLUMN IF NOT EXISTS wallpaper text NOT NULL DEFAULT 'default';
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS "viewOnce" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "viewedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "viewedBy" uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.message_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_privacy_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_message_drafts_api_access ON public.message_drafts;
CREATE POLICY deny_message_drafts_api_access ON public.message_drafts FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS deny_scheduled_messages_api_access ON public.scheduled_messages;
CREATE POLICY deny_scheduled_messages_api_access ON public.scheduled_messages FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS deny_user_privacy_settings_api_access ON public.user_privacy_settings;
CREATE POLICY deny_user_privacy_settings_api_access ON public.user_privacy_settings FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.message_drafts, public.scheduled_messages, public.user_privacy_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.message_drafts, public.scheduled_messages, public.user_privacy_settings TO service_role;

CREATE OR REPLACE FUNCTION public.chat_get_message_draft(p_user_id uuid, p_conversation_id integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.conversation_members m WHERE m."userId" = p_user_id AND m."conversationId" = p_conversation_id
  ) THEN coalesce((
    SELECT jsonb_build_object('body', d.body, 'replyTo', d."replyTo", 'updatedAt', d."updatedAt")
    FROM public.message_drafts d WHERE d."userId" = p_user_id AND d."conversationId" = p_conversation_id
  ), jsonb_build_object('body', '', 'replyTo', null, 'updatedAt', null)) ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION public.chat_set_message_draft(p_user_id uuid, p_conversation_id integer, p_body text, p_reply_to integer DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.conversation_members m WHERE m."userId" = p_user_id AND m."conversationId" = p_conversation_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF char_length(coalesce(p_body, '')) > 4000 THEN RAISE EXCEPTION 'MESSAGE_TOO_LONG'; END IF;
  IF p_reply_to IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.messages m WHERE m.id = p_reply_to AND m."conversationId" = p_conversation_id AND m."deletedAt" IS NULL
  ) THEN RAISE EXCEPTION 'INVALID_REPLY'; END IF;
  IF btrim(coalesce(p_body, '')) = '' AND p_reply_to IS NULL THEN
    DELETE FROM public.message_drafts WHERE "userId" = p_user_id AND "conversationId" = p_conversation_id;
  ELSE
    INSERT INTO public.message_drafts ("userId", "conversationId", body, "replyTo", "updatedAt")
    VALUES (p_user_id, p_conversation_id, coalesce(p_body, ''), p_reply_to, now())
    ON CONFLICT ("userId", "conversationId") DO UPDATE SET body = EXCLUDED.body, "replyTo" = EXCLUDED."replyTo", "updatedAt" = now();
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_send_media_once(p_conversation_id integer, p_user_id uuid, p_body text, p_media_path text, p_media_type text, p_media_name text, p_reply_to integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_message jsonb; v_message_id integer;
BEGIN
  v_message := public.chat_send_media(p_conversation_id, p_user_id, p_body, p_media_path, p_media_type, p_media_name, p_reply_to);
  v_message_id := (v_message->>'id')::integer;
  UPDATE public.messages SET "viewOnce" = true WHERE id = v_message_id AND "senderId" = p_user_id;
  RETURN v_message || jsonb_build_object('viewOnce', true, 'viewedAt', null, 'viewedBy', null);
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_consume_view_once(p_message_id integer, p_user_id uuid, p_media_path text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_message public.messages%ROWTYPE;
BEGIN
  SELECT * INTO v_message FROM public.messages WHERE id = p_message_id AND "deletedAt" IS NULL FOR UPDATE;
  IF v_message.id IS NULL OR v_message."mediaPath" IS DISTINCT FROM p_media_path OR NOT EXISTS (
    SELECT 1 FROM public.conversation_members m WHERE m."conversationId" = v_message."conversationId" AND m."userId" = p_user_id
  ) THEN RETURN false; END IF;
  IF NOT v_message."viewOnce" OR v_message."senderId" = p_user_id THEN RETURN true; END IF;
  IF v_message."viewedAt" IS NOT NULL THEN RETURN v_message."viewedBy" = p_user_id; END IF;
  UPDATE public.messages SET "viewedAt" = now(), "viewedBy" = p_user_id WHERE id = p_message_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_get_view_once_features(p_user_id uuid, p_conversation_id integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.conversation_members m WHERE m."userId" = p_user_id AND m."conversationId" = p_conversation_id)
    THEN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', message.id, 'viewOnce', message."viewOnce",
      'viewedByMe', message."viewedBy" = p_user_id,
      'viewed', message."viewedAt" IS NOT NULL
    ) ORDER BY message.id) FROM public.messages message WHERE message."conversationId" = p_conversation_id AND message."viewOnce"), '[]'::jsonb)
    ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION public.chat_get_conversation_wallpaper(p_user_id uuid, p_conversation_id integer)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.conversation_members m WHERE m."userId" = p_user_id AND m."conversationId" = p_conversation_id)
    THEN coalesce((SELECT p.wallpaper FROM public.conversation_preferences p WHERE p."userId" = p_user_id AND p."conversationId" = p_conversation_id), 'default')
    ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION public.chat_set_conversation_wallpaper(p_user_id uuid, p_conversation_id integer, p_wallpaper text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.conversation_members m WHERE m."userId" = p_user_id AND m."conversationId" = p_conversation_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p_wallpaper NOT IN ('default', 'slate', 'blue', 'green', 'rose', 'violet', 'sand') THEN RAISE EXCEPTION 'INVALID_WALLPAPER'; END IF;
  INSERT INTO public.conversation_preferences ("userId", "conversationId", wallpaper, updated_at)
  VALUES (p_user_id, p_conversation_id, p_wallpaper, now())
  ON CONFLICT ("userId", "conversationId") DO UPDATE SET wallpaper = EXCLUDED.wallpaper, updated_at = now();
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_get_privacy_settings(p_user_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'readReceipts', coalesce(settings.read_receipts, true),
    'presenceVisibility', coalesce(settings.presence_visibility, 'contacts')
  ) FROM (SELECT 1) seed LEFT JOIN public.user_privacy_settings settings ON settings."userId" = p_user_id
$$;

CREATE OR REPLACE FUNCTION public.chat_set_privacy_settings(p_user_id uuid, p_read_receipts boolean, p_presence_visibility text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_presence_visibility NOT IN ('everyone', 'contacts', 'nobody') THEN RAISE EXCEPTION 'INVALID_PRIVACY'; END IF;
  INSERT INTO public.user_privacy_settings ("userId", read_receipts, presence_visibility, "updatedAt")
  VALUES (p_user_id, coalesce(p_read_receipts, true), p_presence_visibility, now())
  ON CONFLICT ("userId") DO UPDATE SET read_receipts = EXCLUDED.read_receipts, presence_visibility = EXCLUDED.presence_visibility, "updatedAt" = now();
  RETURN public.chat_get_privacy_settings(p_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_get_peer_privacy(p_user_id uuid, p_conversation_id integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN c.kind = 'direct' AND mine."userId" = p_user_id AND peer."userId" IS NOT NULL THEN jsonb_build_object(
    'userId', peer."userId",
    'readReceipts', coalesce(settings.read_receipts, true),
    'presenceVisibility', coalesce(settings.presence_visibility, 'contacts'),
    'lastSeenAt', CASE WHEN coalesce(settings.presence_visibility, 'contacts') = 'nobody' THEN NULL
      ELSE (SELECT max(registry.last_seen_at) FROM public.device_registry registry WHERE registry.user_id = peer."userId") END
  ) ELSE NULL END
  FROM public.conversations c
  JOIN public.conversation_members mine ON mine."conversationId" = c.id AND mine."userId" = p_user_id
  LEFT JOIN public.conversation_members peer ON peer."conversationId" = c.id AND peer."userId" <> p_user_id
  LEFT JOIN public.user_privacy_settings settings ON settings."userId" = peer."userId"
  WHERE c.id = p_conversation_id LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.chat_prevent_private_read_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW."lastReadAt" IS DISTINCT FROM OLD."lastReadAt" AND EXISTS (
    SELECT 1 FROM public.user_privacy_settings settings WHERE settings."userId" = NEW."userId" AND settings.read_receipts = false
  ) THEN NEW."lastReadAt" := OLD."lastReadAt"; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS respect_read_receipt_privacy ON public.conversation_members;
CREATE TRIGGER respect_read_receipt_privacy BEFORE UPDATE OF "lastReadAt" ON public.conversation_members
FOR EACH ROW EXECUTE FUNCTION public.chat_prevent_private_read_receipt();

CREATE OR REPLACE FUNCTION public.chat_schedule_message(p_user_id uuid, p_conversation_id integer, p_body text, p_send_at timestamptz, p_reply_to integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item public.scheduled_messages%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.conversation_members m WHERE m."userId" = p_user_id AND m."conversationId" = p_conversation_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF length(btrim(coalesce(p_body, ''))) = 0 THEN RAISE EXCEPTION 'EMPTY_MESSAGE'; END IF;
  IF length(p_body) > 4000 THEN RAISE EXCEPTION 'MESSAGE_TOO_LONG'; END IF;
  IF p_send_at < now() + interval '1 minute' OR p_send_at > now() + interval '180 days' THEN RAISE EXCEPTION 'INVALID_SCHEDULE_TIME'; END IF;
  IF p_reply_to IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.id = p_reply_to AND m."conversationId" = p_conversation_id AND m."deletedAt" IS NULL) THEN RAISE EXCEPTION 'INVALID_REPLY'; END IF;
  PERFORM public.chat_assert_send_allowed(p_conversation_id, p_user_id);
  INSERT INTO public.scheduled_messages ("userId", "conversationId", body, "replyTo", "sendAt")
  VALUES (p_user_id, p_conversation_id, btrim(p_body), p_reply_to, p_send_at) RETURNING * INTO v_item;
  RETURN jsonb_build_object('id', v_item.id, 'body', v_item.body, 'sendAt', v_item."sendAt", 'status', v_item.status, 'replyTo', v_item."replyTo");
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_list_scheduled_messages(p_user_id uuid, p_conversation_id integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.conversation_members m WHERE m."userId" = p_user_id AND m."conversationId" = p_conversation_id)
    THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'body', s.body, 'sendAt', s."sendAt", 'status', s.status, 'replyTo', s."replyTo") ORDER BY s."sendAt")
      FROM public.scheduled_messages s WHERE s."userId" = p_user_id AND s."conversationId" = p_conversation_id AND s.status IN ('pending', 'failed')), '[]'::jsonb)
    ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION public.chat_cancel_scheduled_message(p_user_id uuid, p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.scheduled_messages SET status = 'cancelled'
  WHERE id = p_id AND "userId" = p_user_id AND status IN ('pending', 'failed');
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_process_scheduled_messages()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item public.scheduled_messages%ROWTYPE; v_message jsonb; v_count integer := 0;
BEGIN
  FOR v_item IN SELECT * FROM public.scheduled_messages WHERE status = 'pending' AND "sendAt" <= now() ORDER BY "sendAt" LIMIT 25 FOR UPDATE SKIP LOCKED LOOP
    BEGIN
      PERFORM public.chat_assert_send_allowed(v_item."conversationId", v_item."userId");
      v_message := public.chat_send_message(v_item."conversationId", v_item."userId", v_item.body, v_item."replyTo");
      UPDATE public.scheduled_messages SET status = 'sent', "messageId" = (v_message->>'id')::integer, error = NULL WHERE id = v_item.id;
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.scheduled_messages SET status = 'failed', error = left(SQLERRM, 200) WHERE id = v_item.id;
    END;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_broadcast_preference_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM realtime.send(jsonb_build_object('conversationId', NEW."conversationId"), 'chat-updated', 'user-updates:' || NEW."userId"::text, true);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS broadcast_conversation_preference_change ON public.conversation_preferences;
CREATE TRIGGER broadcast_conversation_preference_change AFTER INSERT OR UPDATE ON public.conversation_preferences
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_preference_change();

REVOKE ALL ON FUNCTION public.chat_get_message_draft(uuid, integer), public.chat_set_message_draft(uuid, integer, text, integer),
  public.chat_send_media_once(integer, uuid, text, text, text, text, integer), public.chat_consume_view_once(integer, uuid, text),
  public.chat_get_view_once_features(uuid, integer), public.chat_get_conversation_wallpaper(uuid, integer),
  public.chat_set_conversation_wallpaper(uuid, integer, text), public.chat_get_privacy_settings(uuid),
  public.chat_set_privacy_settings(uuid, boolean, text), public.chat_get_peer_privacy(uuid, integer),
  public.chat_prevent_private_read_receipt(), public.chat_schedule_message(uuid, integer, text, timestamptz, integer),
  public.chat_list_scheduled_messages(uuid, integer), public.chat_cancel_scheduled_message(uuid, uuid),
  public.chat_process_scheduled_messages(), public.chat_broadcast_preference_change()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_get_message_draft(uuid, integer), public.chat_set_message_draft(uuid, integer, text, integer),
  public.chat_send_media_once(integer, uuid, text, text, text, text, integer), public.chat_consume_view_once(integer, uuid, text),
  public.chat_get_view_once_features(uuid, integer), public.chat_get_conversation_wallpaper(uuid, integer),
  public.chat_set_conversation_wallpaper(uuid, integer, text), public.chat_get_privacy_settings(uuid),
  public.chat_set_privacy_settings(uuid, boolean, text), public.chat_get_peer_privacy(uuid, integer),
  public.chat_schedule_message(uuid, integer, text, timestamptz, integer), public.chat_list_scheduled_messages(uuid, integer),
  public.chat_cancel_scheduled_message(uuid, uuid), public.chat_process_scheduled_messages()
TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'handle-chat-send-scheduled-messages') THEN
    PERFORM cron.schedule('handle-chat-send-scheduled-messages', '* * * * *', 'select public.chat_process_scheduled_messages();');
  END IF;
END
$$;
