ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS "groupSettings" jsonb NOT NULL DEFAULT '{"addMembers":"admins","shareInvite":"admins","requireApproval":false,"sendMessages":"all","editGroup":"admins"}'::jsonb;

UPDATE public.conversations
SET "groupSettings" = '{"addMembers":"admins","shareInvite":"admins","requireApproval":false,"sendMessages":"all","editGroup":"admins"}'::jsonb || "groupSettings"
WHERE kind = 'group';

ALTER TABLE public.conversation_members
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member';

ALTER TABLE public.conversation_members
  DROP CONSTRAINT IF EXISTS conversation_members_role_check;
ALTER TABLE public.conversation_members
  ADD CONSTRAINT conversation_members_role_check CHECK (role IN ('admin', 'member'));

UPDATE public.conversation_members member
SET role = 'admin'
FROM public.conversations conversation
WHERE conversation.id = member."conversationId"
  AND conversation.kind = 'group'
  AND conversation."createdBy" = member."userId";

CREATE TABLE IF NOT EXISTS public.group_member_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id integer NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  UNIQUE (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS group_member_requests_pending_idx
  ON public.group_member_requests (conversation_id, created_at DESC)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.group_invites (
  token text PRIMARY KEY CHECK (token ~ '^[a-f0-9]{48}$'),
  conversation_id integer NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS group_invites_expiry_idx
  ON public.group_invites (expires_at);

ALTER TABLE public.group_member_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.group_member_requests, public.group_invites FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.chat_assert_send_allowed(p_conversation_id integer, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request public.conversation_requests%ROWTYPE;
  v_kind text;
  v_created_by uuid;
  v_group_settings jsonb;
  v_member_role text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id
  ) THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;

  SELECT kind, "createdBy", "groupSettings"
  INTO v_kind, v_created_by, v_group_settings
  FROM public.conversations WHERE id = p_conversation_id;

  IF v_kind = 'direct' AND EXISTS (
    SELECT 1
    FROM public.conversation_members peer
    JOIN public.user_blocks block ON
      (block.blocker_id = p_user_id AND block.blocked_id = peer."userId") OR
      (block.blocker_id = peer."userId" AND block.blocked_id = p_user_id)
    WHERE peer."conversationId" = p_conversation_id AND peer."userId" <> p_user_id
  ) THEN
    RAISE EXCEPTION 'USER_BLOCKED';
  END IF;

  IF v_kind = 'group' AND coalesce(v_group_settings->>'sendMessages', 'all') = 'admins' THEN
    SELECT role INTO v_member_role FROM public.conversation_members
    WHERE "conversationId" = p_conversation_id AND "userId" = p_user_id;
    IF p_user_id <> v_created_by AND coalesce(v_member_role, 'member') <> 'admin' THEN
      RAISE EXCEPTION 'GROUP_ADMIN_ONLY';
    END IF;
  END IF;

  SELECT * INTO v_request FROM public.conversation_requests WHERE conversation_id = p_conversation_id;
  IF FOUND THEN
    IF v_request.status = 'declined' THEN RAISE EXCEPTION 'MESSAGE_REQUEST_DECLINED'; END IF;
    IF v_request.status = 'pending' AND p_user_id <> v_request.requester_id THEN
      RAISE EXCEPTION 'MESSAGE_REQUEST_PENDING';
    END IF;
  END IF;
  RETURN true;
END;
$function$;
