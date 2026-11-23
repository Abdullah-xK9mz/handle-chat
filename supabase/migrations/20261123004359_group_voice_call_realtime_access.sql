-- Group voice calls exchange short-lived WebRTC signaling over private channels.
-- Only current members of a group may read or send signaling payloads.

create policy "group members can receive voice call signaling"
on realtime.messages
for select
to authenticated
using (
  extension = 'broadcast'
  and (select realtime.topic()) ~ '^message-group-call:[0-9]+$'
  and exists (
    select 1
    from public.conversation_members as member
    join public.conversations as conversation
      on conversation.id = member."conversationId"
    where member."conversationId"::text = regexp_replace((select realtime.topic()), '^message-group-call:', '')
      and member."userId" = (select auth.uid())
      and conversation.kind = 'group'
  )
);

create policy "group members can send voice call signaling"
on realtime.messages
for insert
to authenticated
with check (
  extension = 'broadcast'
  and (select realtime.topic()) ~ '^message-group-call:[0-9]+$'
  and exists (
    select 1
    from public.conversation_members as member
    join public.conversations as conversation
      on conversation.id = member."conversationId"
    where member."conversationId"::text = regexp_replace((select realtime.topic()), '^message-group-call:', '')
      and member."userId" = (select auth.uid())
      and conversation.kind = 'group'
  )
);
