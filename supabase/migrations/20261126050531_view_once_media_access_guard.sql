CREATE OR REPLACE FUNCTION public.chat_find_view_once_message(
  p_user_id uuid,
  p_conversation_id integer,
  p_media_path text
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT message.id
  FROM public.messages message
  WHERE message."conversationId" = p_conversation_id
    AND message."mediaPath" = p_media_path
    AND message."viewOnce" = true
    AND message."deletedAt" IS NULL
    AND EXISTS (
      SELECT 1 FROM public.conversation_members member
      WHERE member."conversationId" = p_conversation_id AND member."userId" = p_user_id
    )
  ORDER BY message.id DESC
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.chat_find_view_once_message(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_find_view_once_message(uuid, integer, text) TO service_role;

CREATE OR REPLACE FUNCTION public.chat_is_view_once_message(p_user_id uuid, p_message_id integer)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.messages message
    JOIN public.conversation_members member
      ON member."conversationId" = message."conversationId" AND member."userId" = p_user_id
    WHERE message.id = p_message_id AND message."viewOnce" = true AND message."deletedAt" IS NULL
  )
$$;
REVOKE ALL ON FUNCTION public.chat_is_view_once_message(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_is_view_once_message(uuid, integer) TO service_role;
