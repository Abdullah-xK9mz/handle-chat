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
      SELECT 1
      FROM public.conversations c
      JOIN public.conversation_members owner_member
        ON owner_member."conversationId" = c.id AND owner_member."userId" = p_owner_id
      JOIN public.conversation_members viewer_member
        ON viewer_member."conversationId" = c.id AND viewer_member."userId" = p_viewer_id
      WHERE c.kind = 'direct'
        AND EXISTS (
          SELECT 1 FROM public.messages m
          WHERE m."conversationId" = c.id
        )
    )
  )
$$;

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
    WHERE EXISTS (
      SELECT 1 FROM public.user_reports report
      WHERE report.conversation_id = c.id
    )
    ORDER BY c."lastMessageAt" DESC
    LIMIT 500
  ) listed;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.chat_user_can_view_status(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_user_can_view_status(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.chat_admin_list_conversations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_admin_list_conversations(uuid) TO service_role;
