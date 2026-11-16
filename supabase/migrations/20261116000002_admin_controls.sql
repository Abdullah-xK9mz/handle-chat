-- Admin account controls. Role changes are never exposed to regular accounts.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_role_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_role_check CHECK (role IN ('user', 'admin'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS profiles_role_idx ON public.profiles (role);

CREATE OR REPLACE FUNCTION public.chat_is_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_user_id AND role = 'admin'
  )
$$;
REVOKE ALL ON FUNCTION public.chat_is_admin(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_is_admin(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.chat_get_profile(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'id', profile.id,
    'name', profile.name,
    'username', profile.username,
    'image', profile.image,
    'about', profile.about,
    'isAdmin', profile.role = 'admin'
  )
  FROM public.profiles profile
  WHERE profile.id = p_user_id
$$;
REVOKE EXECUTE ON FUNCTION public.chat_get_profile(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_get_profile(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.chat_admin_update_profile(
  p_actor_id uuid,
  p_target_id uuid,
  p_username text,
  p_name text,
  p_image text,
  p_about text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_profile public.profiles%ROWTYPE;
BEGIN
  IF NOT public.chat_is_admin(p_actor_id) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_username !~ '^[a-z0-9_.]{3,20}$' THEN RAISE EXCEPTION 'INVALID_USERNAME'; END IF;
  IF length(btrim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'NAME_REQUIRED'; END IF;
  IF length(coalesce(p_about, '')) > 150 THEN RAISE EXCEPTION 'ABOUT_TOO_LONG'; END IF;
  IF length(coalesce(p_image, '')) > 500 THEN RAISE EXCEPTION 'INVALID_IMAGE'; END IF;

  UPDATE public.profiles
  SET username = p_username,
      name = btrim(p_name),
      image = nullif(p_image, ''),
      about = coalesce(p_about, '')
  WHERE id = p_target_id
  RETURNING * INTO v_profile;
  IF v_profile.id IS NULL THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;

  RETURN jsonb_build_object(
    'id', v_profile.id, 'username', v_profile.username, 'name', v_profile.name,
    'image', v_profile.image, 'about', v_profile.about,
    'isAdmin', v_profile.role = 'admin'
  );
END;
$$;
REVOKE ALL ON FUNCTION public.chat_admin_update_profile(uuid,uuid,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_admin_update_profile(uuid,uuid,text,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.chat_delete_message(p_user_id uuid, p_message_id integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.messages
  SET "deletedAt" = now(), body = '', "mediaPath" = NULL,
      "mediaType" = NULL, "mediaName" = NULL,
      "messageType" = 'text', payload = '{}'::jsonb
  WHERE id = p_message_id
    AND "deletedAt" IS NULL
    AND ("senderId" = p_user_id OR public.chat_is_admin(p_user_id));
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  DELETE FROM public.message_stars WHERE "messageId" = p_message_id;
  DELETE FROM public.conversation_pins WHERE "messageId" = p_message_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_delete_message(uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_delete_message(uuid,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.chat_set_pin(p_user_id uuid, p_message_id integer, p_pinned boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_conversation_id integer;
BEGIN
  SELECT "conversationId" INTO v_conversation_id
  FROM public.messages WHERE id = p_message_id AND "deletedAt" IS NULL;
  IF v_conversation_id IS NULL OR (
    NOT public.chat_is_admin(p_user_id)
    AND NOT EXISTS (
      SELECT 1 FROM public.conversation_members
      WHERE "conversationId" = v_conversation_id AND "userId" = p_user_id
    )
  ) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;

  IF p_pinned THEN
    INSERT INTO public.conversation_pins ("conversationId", "messageId", "pinnedBy")
    VALUES (v_conversation_id, p_message_id, p_user_id)
    ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.conversation_pins
    WHERE "conversationId" = v_conversation_id AND "messageId" = p_message_id;
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_set_pin(uuid,integer,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_set_pin(uuid,integer,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.chat_delete_conversation(p_user_id uuid, p_conversation_id integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_is_admin boolean := public.chat_is_admin(p_user_id);
BEGIN
  IF NOT v_is_admin THEN
    DELETE FROM public.conversation_members
    WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.conversation_members
      WHERE "conversationId" = p_conversation_id
    ) THEN RETURN true; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.conversations WHERE id = p_conversation_id) THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;

  DELETE FROM public.conversation_preferences WHERE "conversationId" = p_conversation_id;
  DELETE FROM public.conversation_members WHERE "conversationId" = p_conversation_id;
  DELETE FROM public.messages WHERE "conversationId" = p_conversation_id;
  DELETE FROM public.conversations WHERE id = p_conversation_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_delete_conversation(uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_delete_conversation(uuid,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.chat_admin_list_conversations(p_actor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT public.chat_is_admin(p_actor_id) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  SELECT coalesce(jsonb_agg(item ORDER BY item->>'lastMessageAt' DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', c.id,
      'kind', c.kind,
      'name', c.name,
      'lastMessageAt', c."lastMessageAt",
      'participantCount', (SELECT count(*) FROM public.conversation_members cm WHERE cm."conversationId" = c.id),
      'messageCount', (SELECT count(*) FROM public.messages m WHERE m."conversationId" = c.id)
    ) AS item
    FROM public.conversations c
    ORDER BY c."lastMessageAt" DESC
    LIMIT 500
  ) listed;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_admin_list_conversations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_admin_list_conversations(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.chat_cleanup_orphan_conversations(p_actor_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_deleted integer;
        v_conversation_id integer;
BEGIN
  IF NOT public.chat_is_admin(p_actor_id) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  v_deleted := 0;
  FOR v_conversation_id IN
    SELECT c.id FROM public.conversations c
    WHERE (c.kind = 'direct' AND (
        SELECT count(*) FROM public.conversation_members cm WHERE cm."conversationId" = c.id
      ) < 2)
      OR (c.kind = 'group' AND NOT EXISTS (
        SELECT 1 FROM public.conversation_members cm WHERE cm."conversationId" = c.id
      ))
  LOOP
    PERFORM public.chat_delete_conversation(p_actor_id, v_conversation_id);
    v_deleted := v_deleted + 1;
  END LOOP;
  RETURN v_deleted;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_cleanup_orphan_conversations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_cleanup_orphan_conversations(uuid) TO service_role;
