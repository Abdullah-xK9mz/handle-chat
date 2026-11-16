CREATE INDEX IF NOT EXISTS account_bans_banned_by_idx
  ON public.account_bans (banned_by)
  WHERE banned_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS device_bans_banned_by_idx
  ON public.device_bans (banned_by)
  WHERE banned_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS user_reports_conversation_created_idx
  ON public.user_reports (conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS user_reports_reporter_created_idx
  ON public.user_reports (reporter_id, created_at DESC)
  WHERE reporter_id IS NOT NULL;

