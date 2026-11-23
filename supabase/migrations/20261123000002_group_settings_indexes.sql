CREATE INDEX IF NOT EXISTS group_member_requests_user_id_idx
  ON public.group_member_requests (user_id);
CREATE INDEX IF NOT EXISTS group_member_requests_requested_by_idx
  ON public.group_member_requests (requested_by);
CREATE INDEX IF NOT EXISTS group_member_requests_reviewed_by_idx
  ON public.group_member_requests (reviewed_by);
CREATE INDEX IF NOT EXISTS group_invites_conversation_id_idx
  ON public.group_invites (conversation_id);
CREATE INDEX IF NOT EXISTS group_invites_created_by_idx
  ON public.group_invites (created_by);

CREATE POLICY group_member_requests_deny_client_access
  ON public.group_member_requests
  FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);
CREATE POLICY group_invites_deny_client_access
  ON public.group_invites
  FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);
