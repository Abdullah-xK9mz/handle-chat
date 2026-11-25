-- Explicitly deny direct Data API access to tables served through the trusted
-- edge function, and cover every foreign key used for deletes and joins.
DROP POLICY IF EXISTS deny_user_blocks_api_access ON public.user_blocks;
CREATE POLICY deny_user_blocks_api_access ON public.user_blocks
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS deny_conversation_preferences_api_access ON public.conversation_preferences;
CREATE POLICY deny_conversation_preferences_api_access ON public.conversation_preferences
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS deny_statuses_api_access ON public.statuses;
CREATE POLICY deny_statuses_api_access ON public.statuses
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS deny_poll_votes_api_access ON public.poll_votes;
CREATE POLICY deny_poll_votes_api_access ON public.poll_votes
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS deny_message_stars_api_access ON public.message_stars;
CREATE POLICY deny_message_stars_api_access ON public.message_stars
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS deny_conversation_pins_api_access ON public.conversation_pins;
CREATE POLICY deny_conversation_pins_api_access ON public.conversation_pins
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE INDEX IF NOT EXISTS conversation_pins_message_idx ON public.conversation_pins ("messageId");
CREATE INDEX IF NOT EXISTS conversation_pins_pinned_by_idx ON public.conversation_pins ("pinnedBy");
CREATE INDEX IF NOT EXISTS conversation_preferences_conversation_idx ON public.conversation_preferences ("conversationId");
CREATE INDEX IF NOT EXISTS messages_forwarded_from_idx ON public.messages ("forwardedFrom");
CREATE INDEX IF NOT EXISTS messages_reply_to_idx ON public.messages ("replyTo");
CREATE INDEX IF NOT EXISTS messages_sender_idx ON public.messages ("senderId");
CREATE INDEX IF NOT EXISTS poll_votes_user_idx ON public.poll_votes ("userId");

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
      v_image := 'https://xecdfgxbcmltubkwlbah.supabase.co/storage/v1/object/public/avatars/' || p_avatar_path;
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
      'image', profile.image, 'about', profile.about,
      'isAdmin', profile.role = 'admin'
    )
    FROM public.profiles profile WHERE profile.id = p_user_id
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.chat_update_profile(uuid,text,text,boolean,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_update_profile(uuid,text,text,boolean,text) TO service_role;

