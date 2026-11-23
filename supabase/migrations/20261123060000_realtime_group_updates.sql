CREATE OR REPLACE FUNCTION public.chat_list_conversations(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
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
      EXISTS (
        SELECT 1 FROM public.user_blocks b
        WHERE b.blocker_id = profile.id AND b.blocked_id = p_user_id
      ) AS blockedMe
    FROM public.conversation_members member
    JOIN public.profiles profile ON profile.id = member."userId"
    WHERE member."conversationId" = c.id AND member."userId" <> p_user_id
    ORDER BY profile.username
    LIMIT 1
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
    AND (NOT public.chat_is_admin(p_user_id) OR request.status IS DISTINCT FROM 'pending');

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.chat_record_group_members_added(
  p_actor_id uuid,
  p_conversation_id integer,
  p_added_user_ids uuid[]
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_kind text;
  v_actor_name text;
  v_added_members jsonb;
  v_message_id bigint;
  v_created_at timestamptz;
BEGIN
  SELECT kind INTO v_kind
  FROM public.conversations
  WHERE id = p_conversation_id;

  IF v_kind <> 'group' OR NOT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE "conversationId" = p_conversation_id AND "userId" = p_actor_id
  ) THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;

  SELECT name INTO v_actor_name FROM public.profiles WHERE id = p_actor_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', profile.id,
    'name', profile.name
  ) ORDER BY profile.name), '[]'::jsonb)
  INTO v_added_members
  FROM public.conversation_members member
  JOIN public.profiles profile ON profile.id = member."userId"
  WHERE member."conversationId" = p_conversation_id
    AND member."userId" <> p_actor_id
    AND member."userId" = ANY(coalesce(p_added_user_ids, ARRAY[]::uuid[]));

  IF jsonb_array_length(v_added_members) = 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.messages ("conversationId", "senderId", body, "messageType", payload)
  VALUES (
    p_conversation_id,
    p_actor_id,
    '',
    'event',
    jsonb_build_object(
      'systemEvent', 'members_added',
      'actorName', coalesce(v_actor_name, ''),
      'addedMembers', v_added_members
    )
  )
  RETURNING id, "createdAt" INTO v_message_id, v_created_at;

  UPDATE public.conversations
  SET "lastMessageAt" = greatest("lastMessageAt", v_created_at)
  WHERE id = p_conversation_id;

  RETURN v_message_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.chat_record_group_members_added(uuid, integer, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_record_group_members_added(uuid, integer, uuid[])
  TO service_role;

CREATE OR REPLACE FUNCTION public.chat_broadcast_updates_for_conversation(
  p_conversation_id integer,
  p_extra_user_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid;
BEGIN
  FOR v_user_id IN
    SELECT recipients.user_id
    FROM (
      SELECT member."userId" AS user_id
      FROM public.conversation_members member
      WHERE member."conversationId" = p_conversation_id
      UNION
      SELECT p_extra_user_id
    ) recipients
    WHERE recipients.user_id IS NOT NULL
  LOOP
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object('conversationId', p_conversation_id),
        'chat-updated',
        'user-updates:' || v_user_id::text,
        true
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.chat_broadcast_membership_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.chat_broadcast_updates_for_conversation(OLD."conversationId", OLD."userId");
    RETURN OLD;
  END IF;

  PERFORM public.chat_broadcast_updates_for_conversation(NEW."conversationId", NEW."userId");
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.chat_broadcast_conversation_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.chat_broadcast_updates_for_conversation(NEW.id);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.chat_broadcast_message_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.chat_broadcast_updates_for_conversation(OLD."conversationId");
    RETURN OLD;
  END IF;

  PERFORM public.chat_broadcast_updates_for_conversation(NEW."conversationId");
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.chat_broadcast_updates_for_conversation(integer, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_membership_change()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_conversation_change()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_message_change()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_broadcast_updates_for_conversation(integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_broadcast_membership_change() TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_broadcast_conversation_change() TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_broadcast_message_change() TO service_role;

DROP TRIGGER IF EXISTS chat_broadcast_membership_insert ON public.conversation_members;
CREATE TRIGGER chat_broadcast_membership_insert
AFTER INSERT ON public.conversation_members
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_membership_change();

DROP TRIGGER IF EXISTS chat_broadcast_membership_update ON public.conversation_members;
CREATE TRIGGER chat_broadcast_membership_update
AFTER UPDATE OF role ON public.conversation_members
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_membership_change();

DROP TRIGGER IF EXISTS chat_broadcast_membership_delete ON public.conversation_members;
CREATE TRIGGER chat_broadcast_membership_delete
AFTER DELETE ON public.conversation_members
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_membership_change();

DROP TRIGGER IF EXISTS chat_broadcast_conversation_metadata ON public.conversations;
CREATE TRIGGER chat_broadcast_conversation_metadata
AFTER UPDATE OF name, "groupSettings" ON public.conversations
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_conversation_change();

DROP TRIGGER IF EXISTS chat_broadcast_message_activity ON public.messages;
CREATE TRIGGER chat_broadcast_message_activity
AFTER INSERT OR UPDATE OR DELETE ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_message_change();

DROP POLICY IF EXISTS "users can receive own chat updates" ON realtime.messages;
CREATE POLICY "users can receive own chat updates"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  extension = 'broadcast'
  AND (SELECT realtime.topic()) = 'user-updates:' || (SELECT auth.uid())::text
);
