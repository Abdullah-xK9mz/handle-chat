CREATE OR REPLACE FUNCTION public.chat_manage_group_member(
  p_actor_id uuid,
  p_conversation_id integer,
  p_target_id uuid,
  p_operation text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_group public.conversations%ROWTYPE;
  v_actor_role text;
  v_target_role text;
  v_other_admin_count integer;
  v_new_role text;
BEGIN
  SELECT *
  INTO v_group
  FROM public.conversations
  WHERE id = p_conversation_id AND kind = 'group'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;

  SELECT role
  INTO v_actor_role
  FROM public.conversation_members
  WHERE "conversationId" = p_conversation_id AND "userId" = p_actor_id
  FOR UPDATE;

  IF NOT FOUND OR (p_actor_id <> v_group."createdBy" AND v_actor_role <> 'admin') THEN
    RAISE EXCEPTION 'GROUP_PERMISSION_DENIED';
  END IF;

  IF p_target_id = p_actor_id OR p_operation NOT IN ('promote', 'demote', 'remove') THEN
    RAISE EXCEPTION 'INVALID_MESSAGE';
  END IF;

  SELECT role
  INTO v_target_role
  FROM public.conversation_members
  WHERE "conversationId" = p_conversation_id AND "userId" = p_target_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  IF p_target_id = v_group."createdBy" AND p_operation <> 'promote' THEN
    RAISE EXCEPTION 'GROUP_PERMISSION_DENIED';
  END IF;

  IF p_operation IN ('demote', 'remove') AND v_target_role = 'admin' THEN
    SELECT count(*)
    INTO v_other_admin_count
    FROM public.conversation_members
    WHERE "conversationId" = p_conversation_id
      AND "userId" <> p_target_id
      AND (role = 'admin' OR "userId" = v_group."createdBy");

    IF v_other_admin_count = 0 THEN
      RAISE EXCEPTION 'GROUP_PERMISSION_DENIED';
    END IF;
  END IF;

  IF p_operation = 'remove' THEN
    DELETE FROM public.conversation_members
    WHERE "conversationId" = p_conversation_id AND "userId" = p_target_id;
    DELETE FROM public.group_member_requests
    WHERE conversation_id = p_conversation_id AND user_id = p_target_id;
    RETURN jsonb_build_object('ok', true, 'removed', true);
  END IF;

  v_new_role := CASE WHEN p_operation = 'promote' THEN 'admin' ELSE 'member' END;
  UPDATE public.conversation_members
  SET role = v_new_role
  WHERE "conversationId" = p_conversation_id AND "userId" = p_target_id;

  RETURN jsonb_build_object('ok', true, 'role', v_new_role);
END;
$function$;

REVOKE ALL ON FUNCTION public.chat_manage_group_member(uuid, integer, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_manage_group_member(uuid, integer, uuid, text)
  TO service_role;
