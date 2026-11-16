CREATE INDEX IF NOT EXISTS conversation_requests_requester_idx
  ON public.conversation_requests (requester_id);

