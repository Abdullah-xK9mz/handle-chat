-- Opening a conversation advances read/delivery timestamps even when no new
-- incoming message exists. Broadcasting every timestamp write makes clients
-- refetch the conversation repeatedly. Notify peers only when a receipt moves
-- past at least one incoming message; keep hidden-conversation updates intact.

CREATE OR REPLACE FUNCTION public.chat_broadcast_member_receipt_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_receipt_advanced boolean := false;
BEGIN
  IF NEW."lastReadAt" IS DISTINCT FROM OLD."lastReadAt"
     AND EXISTS (
       SELECT 1
       FROM public.messages message
       WHERE message."conversationId" = NEW."conversationId"
         AND message."senderId" <> NEW."userId"
         AND message."createdAt" > OLD."lastReadAt"
         AND message."createdAt" <= NEW."lastReadAt"
     ) THEN
    v_receipt_advanced := true;
  END IF;

  IF NEW."lastDeliveredAt" IS DISTINCT FROM OLD."lastDeliveredAt"
     AND EXISTS (
       SELECT 1
       FROM public.messages message
       WHERE message."conversationId" = NEW."conversationId"
         AND message."senderId" <> NEW."userId"
         AND message."createdAt" > OLD."lastDeliveredAt"
         AND message."createdAt" <= NEW."lastDeliveredAt"
     ) THEN
    v_receipt_advanced := true;
  END IF;

  IF v_receipt_advanced THEN
    PERFORM public.chat_broadcast_updates_for_conversation(
      NEW."conversationId",
      NEW."userId"
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_broadcast_member_read_activity ON public.conversation_members;
CREATE TRIGGER chat_broadcast_member_read_activity
AFTER UPDATE OF "lastReadAt", "lastDeliveredAt" ON public.conversation_members
FOR EACH ROW
WHEN (
  OLD."lastReadAt" IS DISTINCT FROM NEW."lastReadAt"
  OR OLD."lastDeliveredAt" IS DISTINCT FROM NEW."lastDeliveredAt"
)
EXECUTE FUNCTION public.chat_broadcast_member_receipt_activity();

DROP TRIGGER IF EXISTS chat_broadcast_member_hidden_activity ON public.conversation_members;
CREATE TRIGGER chat_broadcast_member_hidden_activity
AFTER UPDATE OF "hiddenAt" ON public.conversation_members
FOR EACH ROW
WHEN (OLD."hiddenAt" IS DISTINCT FROM NEW."hiddenAt")
EXECUTE FUNCTION public.chat_broadcast_membership_change();

REVOKE ALL ON FUNCTION public.chat_broadcast_member_receipt_activity() FROM PUBLIC, anon, authenticated;
