-- Every RPC has fully qualified table names and a fixed search path.
ALTER FUNCTION public.chat_get_profile(uuid) SET search_path = '';
ALTER FUNCTION public.chat_search_users(uuid, text) SET search_path = '';
ALTER FUNCTION public.chat_list_conversations(uuid) SET search_path = '';
ALTER FUNCTION public.chat_start_conversation(uuid, text) SET search_path = '';
ALTER FUNCTION public.chat_get_messages(integer, uuid) SET search_path = '';
ALTER FUNCTION public.chat_send_message(integer, uuid, text) SET search_path = '';
