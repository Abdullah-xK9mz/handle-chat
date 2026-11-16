-- Keep message history shared while allowing each account to hide a chat locally.
ALTER TABLE public.conversation_members
  ADD COLUMN IF NOT EXISTS "hiddenAt" timestamptz;

CREATE TABLE IF NOT EXISTS public.conversation_requests (
  conversation_id integer PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  admin_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requester_id <> admin_id)
);
CREATE INDEX IF NOT EXISTS conversation_requests_admin_status_idx
  ON public.conversation_requests (admin_id, status, created_at DESC);
ALTER TABLE public.conversation_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_conversation_requests_api_access ON public.conversation_requests;
CREATE POLICY deny_conversation_requests_api_access ON public.conversation_requests
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.conversation_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.conversation_requests TO service_role;

CREATE OR REPLACE FUNCTION public.chat_start_conversation(p_user_id uuid, p_username text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_target_id uuid;
  v_target_role text;
  v_user_role text;
  v_conversation_id integer;
  v_dm_key text;
  v_has_history boolean;
BEGIN
  SELECT id, role INTO v_target_id, v_target_role
  FROM public.profiles WHERE username = lower(p_username) LIMIT 1;
  SELECT role INTO v_user_role FROM public.profiles WHERE id = p_user_id;
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
  VALUES (v_conversation_id, p_user_id)
  ON CONFLICT ("conversationId", "userId") DO UPDATE SET "hiddenAt" = NULL;
  INSERT INTO public.conversation_members ("conversationId", "userId")
  VALUES (v_conversation_id, v_target_id)
  ON CONFLICT ("conversationId", "userId") DO NOTHING;

  IF v_target_role = 'admin' AND coalesce(v_user_role, '') <> 'admin' THEN
    SELECT EXISTS (SELECT 1 FROM public.messages WHERE "conversationId" = v_conversation_id)
      INTO v_has_history;
    INSERT INTO public.conversation_requests AS existing
      (conversation_id, requester_id, admin_id, status, created_at, updated_at)
    VALUES (
      v_conversation_id, p_user_id, v_target_id,
      CASE WHEN v_has_history THEN 'accepted' ELSE 'pending' END,
      now(), now()
    )
    ON CONFLICT (conversation_id) DO UPDATE SET
      requester_id = CASE WHEN existing.status = 'declined' THEN EXCLUDED.requester_id ELSE existing.requester_id END,
      admin_id = CASE WHEN existing.status = 'declined' THEN EXCLUDED.admin_id ELSE existing.admin_id END,
      status = CASE WHEN existing.status = 'declined' THEN 'pending' ELSE existing.status END,
      updated_at = CASE WHEN existing.status = 'declined' THEN now() ELSE existing.updated_at END;
  END IF;
  RETURN v_conversation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_get_block_state(p_conversation_id integer, p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'otherUserId', peer.id,
    'isBlockedByMe', EXISTS (
      SELECT 1 FROM public.user_blocks b WHERE b.blocker_id = p_user_id AND b.blocked_id = peer.id
    ),
    'isBlockedByOther', EXISTS (
      SELECT 1 FROM public.user_blocks b WHERE b.blocker_id = peer.id AND b.blocked_id = p_user_id
    ),
    'messageRequestStatus', (
      SELECT request.status FROM public.conversation_requests request
      WHERE request.conversation_id = c.id AND (request.requester_id = p_user_id OR request.admin_id = p_user_id)
    )
  )
  FROM public.conversations c
  JOIN public.conversation_members mine ON mine."conversationId" = c.id AND mine."userId" = p_user_id
  LEFT JOIN LATERAL (
    SELECT member."userId" AS id FROM public.conversation_members member
    WHERE member."conversationId" = c.id AND member."userId" <> p_user_id
    ORDER BY member."userId" LIMIT 1
  ) peer ON true
  WHERE c.id = p_conversation_id AND c.kind = 'direct'
$$;

CREATE OR REPLACE FUNCTION public.chat_list_conversations(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_result jsonb;
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
    'otherImage', CASE WHEN c.kind = 'group' OR peer.blockedMe THEN NULL ELSE peer.image END,
    'otherAbout', CASE WHEN c.kind = 'group' OR peer.blockedMe THEN NULL ELSE peer.about END,
    'otherBlockedMe', coalesce(peer.blockedMe, false),
    'messageRequestStatus', request.status,
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
    SELECT profile.id, profile.username, profile.name, profile.image, profile.about,
      EXISTS (SELECT 1 FROM public.user_blocks b WHERE b.blocker_id = profile.id AND b.blocked_id = p_user_id) AS blockedMe
    FROM public.conversation_members member
    JOIN public.profiles profile ON profile.id = member."userId"
    WHERE member."conversationId" = c.id AND member."userId" <> p_user_id
    ORDER BY profile.username LIMIT 1
  ) peer ON true
  LEFT JOIN public.conversation_preferences pref
    ON pref."userId" = p_user_id AND pref."conversationId" = c.id
  LEFT JOIN public.conversation_requests request ON request.conversation_id = c.id
    AND (request.requester_id = p_user_id OR request.admin_id = p_user_id)
  WHERE mine."userId" = p_user_id
    AND (mine."hiddenAt" IS NULL OR EXISTS (
      SELECT 1 FROM public.messages newer
      WHERE newer."conversationId" = c.id AND newer."createdAt" > mine."hiddenAt"
    ))
    AND NOT (public.chat_is_admin(p_user_id) AND request.status = 'pending');
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_assert_send_allowed(p_conversation_id integer, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_request public.conversation_requests%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id
  ) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.conversation_members peer ON peer."conversationId" = c.id AND peer."userId" <> p_user_id
    JOIN public.user_blocks block ON (block.blocker_id = p_user_id AND block.blocked_id = peer."userId")
      OR (block.blocker_id = peer."userId" AND block.blocked_id = p_user_id)
    WHERE c.id = p_conversation_id AND c.kind = 'direct'
  ) THEN RAISE EXCEPTION 'USER_BLOCKED'; END IF;
  SELECT * INTO v_request FROM public.conversation_requests WHERE conversation_id = p_conversation_id;
  IF FOUND THEN
    IF v_request.status = 'declined' THEN RAISE EXCEPTION 'MESSAGE_REQUEST_DECLINED'; END IF;
    IF v_request.status = 'pending' AND p_user_id <> v_request.requester_id THEN
      RAISE EXCEPTION 'MESSAGE_REQUEST_PENDING';
    END IF;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_admin_set_message_request(
  p_actor_id uuid, p_conversation_id integer, p_status text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.chat_is_admin(p_actor_id) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_status NOT IN ('accepted', 'declined') THEN RAISE EXCEPTION 'INVALID_MESSAGE'; END IF;
  UPDATE public.conversation_requests
  SET status = p_status, updated_at = now()
  WHERE conversation_id = p_conversation_id AND admin_id = p_actor_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p_status = 'accepted' THEN
    UPDATE public.conversation_members SET "hiddenAt" = NULL
    WHERE "conversationId" = p_conversation_id AND "userId" = p_actor_id;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_user_can_view_status(p_owner_id uuid, p_viewer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_owner_id = p_viewer_id OR (
    NOT EXISTS (
      SELECT 1 FROM public.user_blocks b
      WHERE (b.blocker_id = p_owner_id AND b.blocked_id = p_viewer_id)
         OR (b.blocker_id = p_viewer_id AND b.blocked_id = p_owner_id)
    )
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      JOIN public.conversation_members owner_member ON owner_member."conversationId" = c.id AND owner_member."userId" = p_owner_id
      JOIN public.conversation_members viewer_member ON viewer_member."conversationId" = c.id AND viewer_member."userId" = p_viewer_id
      WHERE c.kind = 'direct'
        AND EXISTS (SELECT 1 FROM public.messages m WHERE m."conversationId" = c.id AND m."senderId" = p_owner_id)
        AND EXISTS (SELECT 1 FROM public.messages m WHERE m."conversationId" = c.id AND m."senderId" = p_viewer_id)
    )
  )
$$;

CREATE OR REPLACE FUNCTION public.chat_list_statuses(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
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
      AND public.chat_user_can_view_status(status."userId", p_user_id)
    ORDER BY status."createdAt" DESC LIMIT 100
  ) active
$$;

CREATE OR REPLACE FUNCTION public.chat_can_access_status_media(
  p_status_id uuid, p_user_id uuid, p_media_path text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.statuses status
    WHERE status.id = p_status_id AND status."mediaPath" = p_media_path
      AND status."expiresAt" > now()
      AND public.chat_user_can_view_status(status."userId", p_user_id)
  )
$$;

CREATE OR REPLACE FUNCTION public.chat_delete_conversation(p_user_id uuid, p_conversation_id integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.conversation_members SET "hiddenAt" = now()
  WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_admin_delete_conversation(p_actor_id uuid, p_conversation_id integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.chat_is_admin(p_actor_id) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.conversations WHERE id = p_conversation_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  DELETE FROM public.conversation_preferences WHERE "conversationId" = p_conversation_id;
  DELETE FROM public.conversation_members WHERE "conversationId" = p_conversation_id;
  DELETE FROM public.messages WHERE "conversationId" = p_conversation_id;
  DELETE FROM public.conversations WHERE id = p_conversation_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_cleanup_orphan_conversations(p_actor_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_deleted integer := 0; v_conversation_id integer;
BEGIN
  IF NOT public.chat_is_admin(p_actor_id) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  FOR v_conversation_id IN
    SELECT c.id FROM public.conversations c
    WHERE (c.kind = 'direct' AND (SELECT count(*) FROM public.conversation_members cm WHERE cm."conversationId" = c.id) < 2)
       OR (c.kind = 'group' AND NOT EXISTS (SELECT 1 FROM public.conversation_members cm WHERE cm."conversationId" = c.id))
  LOOP
    PERFORM public.chat_admin_delete_conversation(p_actor_id, v_conversation_id);
    v_deleted := v_deleted + 1;
  END LOOP;
  RETURN v_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.chat_start_conversation(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_list_conversations(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_assert_send_allowed(integer,uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_get_block_state(integer,uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_admin_set_message_request(uuid,integer,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_user_can_view_status(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_list_statuses(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_can_access_status_media(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_delete_conversation(uuid,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_admin_delete_conversation(uuid,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_cleanup_orphan_conversations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_start_conversation(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_list_conversations(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_assert_send_allowed(integer,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_get_block_state(integer,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_admin_set_message_request(uuid,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_user_can_view_status(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_list_statuses(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_can_access_status_media(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_delete_conversation(uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_admin_delete_conversation(uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_cleanup_orphan_conversations(uuid) TO service_role;

