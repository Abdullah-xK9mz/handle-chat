-- Empty base schema for a new Handle deployment. Later migrations add profiles,
-- media, groups, statuses, reactions, and account controls.
CREATE TABLE public.conversations (
  id serial PRIMARY KEY,
  "dmKey" text UNIQUE,
  "createdAt" timestamp without time zone NOT NULL DEFAULT now(),
  "lastMessageAt" timestamp without time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.conversation_members (
  "conversationId" integer NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  "userId" text NOT NULL,
  "lastReadAt" timestamp without time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversationId", "userId")
);

CREATE TABLE public.messages (
  id serial PRIMARY KEY,
  "conversationId" integer NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  "senderId" text NOT NULL,
  body text NOT NULL DEFAULT '',
  "createdAt" timestamp without time zone NOT NULL DEFAULT now()
);

CREATE INDEX conversation_members_user_idx
  ON public.conversation_members ("userId", "conversationId");
CREATE INDEX messages_conversation_order_idx
  ON public.messages ("conversationId", id DESC);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY deny_conversations_api_access ON public.conversations
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_conversation_members_api_access ON public.conversation_members
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_messages_api_access ON public.messages
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE
  public.conversations,
  public.conversation_members,
  public.messages
FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.conversations,
  public.conversation_members,
  public.messages
TO service_role;
GRANT USAGE, SELECT ON SEQUENCE
  public.conversations_id_seq,
  public.messages_id_seq
TO service_role;
