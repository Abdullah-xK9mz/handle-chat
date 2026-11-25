-- Push app changes to private, per-user Supabase Realtime channels.
-- Payloads contain only invalidation hints; clients refetch authorized data.

CREATE OR REPLACE FUNCTION public.chat_broadcast_user_event(
  p_user_id uuid,
  p_event text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  PERFORM realtime.send(
    coalesce(p_payload, '{}'::jsonb),
    p_event,
    'user-updates:' || p_user_id::text,
    true
  );
EXCEPTION WHEN OTHERS THEN
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_broadcast_admin_update(
  p_admin_id uuid,
  p_resource text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_admin_id IS NULL OR NOT public.chat_is_admin(p_admin_id) THEN RETURN; END IF;
  PERFORM realtime.send(
    jsonb_build_object('resource', p_resource),
    'admin-updated',
    'admin-updates:' || p_admin_id::text,
    true
  );
EXCEPTION WHEN OTHERS THEN
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_broadcast_all_admins(p_resource text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_admin_id uuid;
BEGIN
  FOR v_admin_id IN SELECT id FROM public.profiles WHERE role = 'admin' LOOP
    PERFORM public.chat_broadcast_admin_update(v_admin_id, p_resource);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_can_receive_admin_realtime()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(public.chat_is_admin((SELECT auth.uid())), false)
$$;

REVOKE ALL ON FUNCTION public.chat_broadcast_user_event(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_admin_update(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_all_admins(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_can_receive_admin_realtime() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_can_receive_admin_realtime() TO authenticated;

DROP POLICY IF EXISTS "admins can receive admin updates" ON realtime.messages;
CREATE POLICY "admins can receive admin updates"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  extension = 'broadcast'
  AND (SELECT realtime.topic()) = 'admin-updates:' || (SELECT auth.uid())::text
  AND public.chat_can_receive_admin_realtime()
);

CREATE OR REPLACE FUNCTION public.chat_broadcast_profile_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_conversation_id integer;
  v_viewer_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_user_id := OLD.id; ELSE v_user_id := NEW.id; END IF;

  FOR v_conversation_id IN
    SELECT member."conversationId" FROM public.conversation_members member
    WHERE member."userId" = v_user_id
  LOOP
    PERFORM public.chat_broadcast_updates_for_conversation(v_conversation_id, v_user_id);
  END LOOP;

  PERFORM public.chat_broadcast_user_event(v_user_id, 'profile-updated', '{}'::jsonb);
  IF TG_OP <> 'DELETE' THEN
    FOR v_viewer_id IN
      SELECT profile.id FROM public.profiles profile
      WHERE profile.id = v_user_id
         OR public.chat_user_can_view_status(v_user_id, profile.id)
    LOOP
      PERFORM public.chat_broadcast_user_event(v_viewer_id, 'statuses-updated', '{}'::jsonb);
    END LOOP;
  END IF;
  PERFORM public.chat_broadcast_all_admins('users');

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_broadcast_profile_insert ON public.profiles;
CREATE TRIGGER chat_broadcast_profile_insert
AFTER INSERT ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_profile_activity();
DROP TRIGGER IF EXISTS chat_broadcast_profile_update ON public.profiles;
CREATE TRIGGER chat_broadcast_profile_update
AFTER UPDATE OF username, name, image, about, role ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_profile_activity();
DROP TRIGGER IF EXISTS chat_broadcast_profile_delete ON public.profiles;
CREATE TRIGGER chat_broadcast_profile_delete
AFTER DELETE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_profile_activity();

CREATE OR REPLACE FUNCTION public.chat_broadcast_status_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner_id uuid;
  v_recipient_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_owner_id := OLD."userId"; ELSE v_owner_id := NEW."userId"; END IF;
  FOR v_recipient_id IN
    SELECT profile.id FROM public.profiles profile
    WHERE profile.id = v_owner_id
       OR public.chat_user_can_view_status(v_owner_id, profile.id)
  LOOP
    PERFORM public.chat_broadcast_user_event(v_recipient_id, 'statuses-updated', '{}'::jsonb);
  END LOOP;
  IF TG_OP = 'UPDATE' AND OLD."userId" IS DISTINCT FROM NEW."userId" THEN
    FOR v_recipient_id IN
      SELECT profile.id FROM public.profiles profile
      WHERE profile.id = OLD."userId"
         OR public.chat_user_can_view_status(OLD."userId", profile.id)
    LOOP
      PERFORM public.chat_broadcast_user_event(v_recipient_id, 'statuses-updated', '{}'::jsonb);
    END LOOP;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_broadcast_status_activity ON public.statuses;
CREATE TRIGGER chat_broadcast_status_activity
AFTER INSERT OR UPDATE OR DELETE ON public.statuses
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_status_activity();

CREATE OR REPLACE FUNCTION public.chat_broadcast_block_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_blocker_id uuid;
  v_blocked_id uuid;
  v_user_id uuid;
  v_conversation_id integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_blocker_id := OLD.blocker_id;
    v_blocked_id := OLD.blocked_id;
  ELSE
    v_blocker_id := NEW.blocker_id;
    v_blocked_id := NEW.blocked_id;
  END IF;

  FOREACH v_user_id IN ARRAY ARRAY[v_blocker_id, v_blocked_id] LOOP
    PERFORM public.chat_broadcast_user_event(v_user_id, 'account-updated', '{}'::jsonb);
    PERFORM public.chat_broadcast_user_event(v_user_id, 'statuses-updated', '{}'::jsonb);
  END LOOP;
  FOR v_conversation_id IN
    SELECT mine."conversationId"
    FROM public.conversation_members mine
    JOIN public.conversation_members peer
      ON peer."conversationId" = mine."conversationId"
    JOIN public.conversations conversation
      ON conversation.id = mine."conversationId" AND conversation.kind = 'direct'
    WHERE mine."userId" = v_blocker_id AND peer."userId" = v_blocked_id
  LOOP
    PERFORM public.chat_broadcast_updates_for_conversation(v_conversation_id);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_broadcast_block_activity ON public.user_blocks;
CREATE TRIGGER chat_broadcast_block_activity
AFTER INSERT OR DELETE ON public.user_blocks
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_block_activity();

CREATE OR REPLACE FUNCTION public.chat_broadcast_preference_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_user_id uuid; v_conversation_id integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD."userId";
    v_conversation_id := OLD."conversationId";
  ELSE
    v_user_id := NEW."userId";
    v_conversation_id := NEW."conversationId";
  END IF;
  PERFORM public.chat_broadcast_user_event(
    v_user_id,
    'chat-updated',
    jsonb_build_object('conversationId', v_conversation_id)
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_broadcast_preference_activity ON public.conversation_preferences;
CREATE TRIGGER chat_broadcast_preference_activity
AFTER INSERT OR UPDATE OR DELETE ON public.conversation_preferences
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_preference_activity();

CREATE OR REPLACE FUNCTION public.chat_broadcast_conversation_request_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_conversation_id integer; v_admin_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_conversation_id := OLD.conversation_id;
    v_admin_id := OLD.admin_id;
  ELSE
    v_conversation_id := NEW.conversation_id;
    v_admin_id := NEW.admin_id;
  END IF;
  PERFORM public.chat_broadcast_updates_for_conversation(v_conversation_id);
  PERFORM public.chat_broadcast_admin_update(v_admin_id, 'requests');
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_broadcast_conversation_request_activity ON public.conversation_requests;
CREATE TRIGGER chat_broadcast_conversation_request_activity
AFTER INSERT OR UPDATE OR DELETE ON public.conversation_requests
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_conversation_request_activity();

CREATE OR REPLACE FUNCTION public.chat_broadcast_group_request_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_conversation_id integer; v_requester_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_conversation_id := OLD.conversation_id;
    v_requester_id := OLD.user_id;
  ELSE
    v_conversation_id := NEW.conversation_id;
    v_requester_id := NEW.user_id;
  END IF;
  PERFORM public.chat_broadcast_updates_for_conversation(v_conversation_id, v_requester_id);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_broadcast_group_request_activity ON public.group_member_requests;
CREATE TRIGGER chat_broadcast_group_request_activity
AFTER INSERT OR UPDATE OR DELETE ON public.group_member_requests
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_group_request_activity();

CREATE OR REPLACE FUNCTION public.chat_broadcast_pin_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_conversation_id integer;
BEGIN
  IF TG_OP = 'DELETE' THEN v_conversation_id := OLD."conversationId"; ELSE v_conversation_id := NEW."conversationId"; END IF;
  PERFORM public.chat_broadcast_updates_for_conversation(v_conversation_id);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_broadcast_pin_activity ON public.conversation_pins;
CREATE TRIGGER chat_broadcast_pin_activity
AFTER INSERT OR UPDATE OR DELETE ON public.conversation_pins
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_pin_activity();

CREATE OR REPLACE FUNCTION public.chat_broadcast_star_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_message_id integer; v_user_id uuid; v_conversation_id integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_message_id := OLD."messageId";
    v_user_id := OLD."userId";
  ELSE
    v_message_id := NEW."messageId";
    v_user_id := NEW."userId";
  END IF;
  SELECT message."conversationId" INTO v_conversation_id FROM public.messages message WHERE message.id = v_message_id;
  IF v_conversation_id IS NOT NULL THEN
    PERFORM public.chat_broadcast_user_event(
      v_user_id,
      'chat-updated',
      jsonb_build_object('conversationId', v_conversation_id)
    );
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_broadcast_star_activity ON public.message_stars;
CREATE TRIGGER chat_broadcast_star_activity
AFTER INSERT OR UPDATE OR DELETE ON public.message_stars
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_star_activity();

CREATE OR REPLACE FUNCTION public.chat_broadcast_poll_vote_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_message_id integer; v_conversation_id integer;
BEGIN
  IF TG_OP = 'DELETE' THEN v_message_id := OLD."messageId"; ELSE v_message_id := NEW."messageId"; END IF;
  SELECT message."conversationId" INTO v_conversation_id FROM public.messages message WHERE message.id = v_message_id;
  IF v_conversation_id IS NOT NULL THEN PERFORM public.chat_broadcast_updates_for_conversation(v_conversation_id); END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_broadcast_poll_vote_activity ON public.poll_votes;
CREATE TRIGGER chat_broadcast_poll_vote_activity
AFTER INSERT OR UPDATE OR DELETE ON public.poll_votes
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_poll_vote_activity();

CREATE OR REPLACE FUNCTION public.chat_broadcast_account_access_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_user_id uuid; v_device_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'account_bans' THEN
    IF TG_OP = 'DELETE' THEN v_user_id := OLD.user_id; ELSE v_user_id := NEW.user_id; END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN v_device_id := OLD.device_id; ELSE v_device_id := NEW.device_id; END IF;
    SELECT registry.user_id INTO v_user_id FROM public.device_registry registry WHERE registry.device_id = v_device_id;
  END IF;
  PERFORM public.chat_broadcast_user_event(v_user_id, 'access-updated', '{}'::jsonb);
  PERFORM public.chat_broadcast_all_admins('users');
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_broadcast_account_ban_activity ON public.account_bans;
CREATE TRIGGER chat_broadcast_account_ban_activity
AFTER INSERT OR UPDATE OR DELETE ON public.account_bans
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_account_access_activity();
DROP TRIGGER IF EXISTS chat_broadcast_device_ban_activity ON public.device_bans;
CREATE TRIGGER chat_broadcast_device_ban_activity
AFTER INSERT OR UPDATE OR DELETE ON public.device_bans
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_account_access_activity();

CREATE OR REPLACE FUNCTION public.chat_broadcast_device_registry_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    PERFORM public.chat_broadcast_user_event(NEW.user_id, 'account-updated', '{}'::jsonb);
  END IF;
  PERFORM public.chat_broadcast_all_admins('devices');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_broadcast_device_registry_insert ON public.device_registry;
CREATE TRIGGER chat_broadcast_device_registry_insert
AFTER INSERT ON public.device_registry
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_device_registry_activity();
DROP TRIGGER IF EXISTS chat_broadcast_device_registry_user_change ON public.device_registry;
CREATE TRIGGER chat_broadcast_device_registry_user_change
AFTER UPDATE OF user_id ON public.device_registry
FOR EACH ROW WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id)
EXECUTE FUNCTION public.chat_broadcast_device_registry_activity();

CREATE OR REPLACE FUNCTION public.chat_broadcast_report_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.chat_broadcast_all_admins('reports');
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_broadcast_report_activity ON public.user_reports;
CREATE TRIGGER chat_broadcast_report_activity
AFTER INSERT OR UPDATE OR DELETE ON public.user_reports
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_report_activity();

CREATE OR REPLACE FUNCTION public.chat_broadcast_message_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_conversation_id integer;
BEGIN
  IF TG_OP = 'DELETE' THEN v_conversation_id := OLD."conversationId"; ELSE v_conversation_id := NEW."conversationId"; END IF;
  PERFORM public.chat_broadcast_updates_for_conversation(v_conversation_id);
  IF EXISTS (SELECT 1 FROM public.user_reports report WHERE report.conversation_id = v_conversation_id) THEN
    PERFORM public.chat_broadcast_all_admins('reported-messages');
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_broadcast_member_read_activity ON public.conversation_members;
CREATE TRIGGER chat_broadcast_member_read_activity
AFTER UPDATE OF "lastReadAt", "lastDeliveredAt", "hiddenAt" ON public.conversation_members
FOR EACH ROW EXECUTE FUNCTION public.chat_broadcast_membership_change();

REVOKE ALL ON FUNCTION public.chat_broadcast_profile_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_status_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_block_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_preference_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_conversation_request_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_group_request_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_pin_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_star_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_poll_vote_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_account_access_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_device_registry_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_report_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_broadcast_message_change() FROM PUBLIC, anon, authenticated;
