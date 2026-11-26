-- Index the profile foreign key so profile deletion and user lookups stay efficient.
CREATE INDEX IF NOT EXISTS message_reactions_user_idx
  ON public.message_reactions ("userId");
