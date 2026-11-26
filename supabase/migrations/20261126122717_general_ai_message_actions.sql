alter table public.general_ai_messages
  add column if not exists client_id uuid,
  add column if not exists reply_to_id bigint,
  add column if not exists reply_body text,
  add column if not exists deleted_at timestamptz,
  add column if not exists starred boolean not null default false,
  add column if not exists pinned boolean not null default false;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'general_ai_messages_reply_to_id_fkey'
      and conrelid = 'public.general_ai_messages'::regclass
  ) then
    alter table public.general_ai_messages
      add constraint general_ai_messages_reply_to_id_fkey
      foreign key (reply_to_id)
      references public.general_ai_messages(id)
      on delete set null;
  end if;
end
$$;

create unique index if not exists general_ai_messages_user_client_id_idx
  on public.general_ai_messages (user_id, client_id)
  where client_id is not null;
