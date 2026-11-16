import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEY = getSecretKey();
const USERNAME_PATTERN = /^[a-z0-9_.]{3,20}$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

class ChatError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}

function getSecretKey() {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys);
      if (parsed.default) return parsed.default as string;
    } catch {
      // Older projects may expose only the legacy service role key.
    }
  }
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacyKey) throw new Error("Supabase server key is not configured.");
  return legacyKey;
}

function getServiceAuthorizationKey() {
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? SECRET_KEY;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

async function readError(response: Response) {
  const body = await response.json().catch(() => null);
  return {
    code:
      body?.error_code ??
      body?.code ??
      body?.error ??
      body?.message ??
      "GENERIC",
    detail: String(body?.message ?? body?.msg ?? body?.error_description ?? ""),
  };
}

async function rpc(name: string, args: Record<string, unknown>) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SECRET_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    const error = await readError(response);
    const searchable = `${error.code} ${error.detail}`.toUpperCase();
    const known = [
      "USER_NOT_FOUND",
      "SELF_CHAT",
      "EMPTY_MESSAGE",
      "MESSAGE_TOO_LONG",
      "INVALID_MEDIA",
      "INVALID_IMAGE",
      "NAME_REQUIRED",
      "NAME_TOO_LONG",
      "USER_BLOCKED",
      "INVALID_GROUP_NAME",
      "INVALID_GROUP_MEMBERS",
      "INVALID_MESSAGE_TYPE",
      "INVALID_MESSAGE",
      "INVALID_POLL",
      "INVALID_REPLY",
      "ABOUT_TOO_LONG",
      "EMPTY_STATUS",
      "STATUS_TOO_LONG",
      "NOT_FOUND",
    ].find((code) => searchable.includes(code));
    if (known) {
      throw new ChatError(known, known === "NOT_FOUND" ? 404 : 400);
    }
    throw new ChatError("GENERIC", response.status >= 500 ? 500 : 400);
  }
  return response.json();
}

async function authenticate(request: Request) {
  const authorization = request.headers.get("Authorization") ?? "";
  const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) throw new ChatError("UNAUTHORIZED", 401);

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SECRET_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) throw new ChatError("UNAUTHORIZED", 401);
  const user = await response.json();
  if (typeof user?.id !== "string") throw new ChatError("UNAUTHORIZED", 401);
  return user as { id: string };
}

function encodeObjectPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function createSignedMediaUrl(path: string) {
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/chat-media/${encodeObjectPath(path)}`,
    {
      method: "POST",
      headers: {
        apikey: SECRET_KEY,
        Authorization: `Bearer ${getServiceAuthorizationKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: 3600 }),
    },
  );
  if (!response.ok) throw new ChatError("GENERIC", 500);

  const data = await response.json();
  const signed = data?.signedURL ?? data?.signedUrl;
  if (typeof signed !== "string") throw new ChatError("GENERIC", 500);
  const url = signed.startsWith("http")
    ? signed
    : signed.startsWith("/storage/v1/")
      ? `${SUPABASE_URL}${signed}`
      : `${SUPABASE_URL}/storage/v1${signed.startsWith("/") ? signed : `/${signed}`}`;
  return { url, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
}

function validMessageId(value: unknown) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ChatError("NOT_FOUND", 404);
  return id;
}

async function signUp(body: Record<string, unknown>) {
  const username =
    typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!USERNAME_PATTERN.test(username)) {
    throw new ChatError("INVALID_USERNAME", 400);
  }
  if (name.length < 1) throw new ChatError("NAME_REQUIRED", 400);
  if (name.length > 50) throw new ChatError("NAME_TOO_LONG", 400);
  if (password.length < 8 || password.length > 128) {
    throw new ChatError("SIGN_UP_FAILED", 400);
  }

  const usernameCheck = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?select=id&username=eq.${encodeURIComponent(username)}`,
    { headers: { apikey: SECRET_KEY } },
  );
  if (!usernameCheck.ok) throw new ChatError("SIGN_UP_FAILED", 500);
  const existingProfiles = await usernameCheck.json();
  if (existingProfiles.length > 0) throw new ChatError("USERNAME_TAKEN", 409);

  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SECRET_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: `${username}@users.handle.local`,
      password,
      email_confirm: true,
      user_metadata: { username, name },
    }),
  });

  if (!response.ok) {
    const error = await readError(response);
    const searchable = `${error.code} ${error.detail}`.toLowerCase();
    if (
      searchable.includes("duplicate key") ||
      searchable.includes("profiles_username") ||
      searchable.includes("already registered") ||
      searchable.includes("email_exists")
    ) {
      throw new ChatError("USERNAME_TAKEN", 409);
    }
    if (searchable.includes("invalid_username")) {
      throw new ChatError("INVALID_USERNAME", 400);
    }
    console.error("Supabase user creation failed:", error.code, error.detail);
    throw new ChatError("SIGN_UP_FAILED", 400);
  }

  return { ok: true };
}

async function hashIpAddress(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validConversationId(value: unknown) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ChatError("NOT_FOUND", 404);
  }
  return id;
}

async function handle(request: Request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") return json({ error: "NOT_FOUND" }, 405);

  try {
    const body = await request.json().catch(() => {
      throw new ChatError("GENERIC", 400);
    });
    if (body?.action === "sign-up") {
      const ipAddress =
        request.headers.get("cf-connecting-ip") ??
        request.headers.get("x-real-ip") ??
        request.headers.get("x-forwarded-for")?.split(",")[0].trim();
      if (!ipAddress) throw new ChatError("SIGN_UP_FAILED", 503);
      const allowed = await rpc("chat_allow_signup", {
        p_ip_hash: await hashIpAddress(ipAddress),
      });
      if (!allowed) throw new ChatError("SIGN_UP_FAILED", 429);
      return json(await signUp(body));
    }

    const user = await authenticate(request);
    switch (body?.action) {
      case "me": {
        const profile = await rpc("chat_get_profile", { p_user_id: user.id });
        if (!profile) throw new ChatError("UNAUTHORIZED", 401);
        return json(profile);
      }
      case "search-users": {
        const query =
          typeof body.query === "string"
            ? body.query.trim().replace(/^@/, "").toLowerCase()
            : "";
        if (query && !/^[a-z0-9_.]{1,20}$/.test(query)) {
          throw new ChatError("INVALID_USERNAME", 400);
        }
        const users = query
          ? await rpc("chat_search_users", {
              p_user_id: user.id,
              p_query: query,
            })
          : [];
        return json({ users });
      }
      case "list-conversations": {
        const conversations = await rpc("chat_list_conversations", {
          p_user_id: user.id,
        });
        return json({ conversations });
      }
      case "start-conversation": {
        const username =
          typeof body.username === "string"
            ? body.username.trim().replace(/^@/, "").toLowerCase()
            : "";
        if (!USERNAME_PATTERN.test(username)) {
          throw new ChatError("INVALID_USERNAME", 400);
        }
        const id = await rpc("chat_start_conversation", {
          p_user_id: user.id,
          p_username: username,
        });
        return json({ id });
      }
      case "get-messages": {
        const conversationId = validConversationId(body.conversationId);
        const detail = await rpc("chat_get_messages", {
          p_conversation_id: conversationId,
          p_user_id: user.id,
        });
        if (!detail) throw new ChatError("NOT_FOUND", 404);
        return json(detail);
      }
      case "send-message": {
        const conversationId = validConversationId(body.conversationId);
        if (typeof body.body !== "string" || !body.body.trim()) {
          throw new ChatError("EMPTY_MESSAGE", 400);
        }
        if (body.body.trim().length > 4000) {
          throw new ChatError("MESSAGE_TOO_LONG", 400);
        }
        const message = await rpc("chat_send_message", {
          p_conversation_id: conversationId,
          p_user_id: user.id,
          p_body: body.body,
          p_reply_to: body.replyToId == null ? null : validMessageId(body.replyToId),
        });
        return json({ message });
      }
      case "send-media": {
        const conversationId = validConversationId(body.conversationId);
        const mediaPath = typeof body.mediaPath === "string" ? body.mediaPath : "";
        const mediaType = typeof body.mediaType === "string" ? body.mediaType : "";
        const mediaName = typeof body.mediaName === "string" ? body.mediaName : "";
        const caption = typeof body.body === "string" ? body.body : "";
        if (mediaPath.length > 500 || mediaName.length > 255) {
          throw new ChatError("INVALID_MEDIA", 400);
        }
        const message = await rpc("chat_send_media", {
          p_conversation_id: conversationId,
          p_user_id: user.id,
          p_body: caption,
          p_media_path: mediaPath,
          p_media_type: mediaType,
          p_media_name: mediaName,
          p_reply_to: body.replyToId == null ? null : validMessageId(body.replyToId),
        });
        return json({ message });
      }
      case "get-media-url": {
        const mediaPath = typeof body.mediaPath === "string" ? body.mediaPath : "";
        const isStatus = body.scope === "status";
        const allowed = isStatus
          ? await rpc("chat_can_access_status_media", {
              p_status_id: body.statusId,
              p_user_id: user.id,
              p_media_path: mediaPath,
            })
          : await rpc("chat_can_access_media", {
              p_conversation_id: validConversationId(body.conversationId),
              p_user_id: user.id,
              p_media_path: mediaPath,
            });
        if (!allowed) throw new ChatError("NOT_FOUND", 404);
        return json(await createSignedMediaUrl(mediaPath));
      }
      case "update-profile": {
        const name = typeof body.name === "string" ? body.name : "";
        const avatarPath = typeof body.avatarPath === "string" ? body.avatarPath : null;
        const updateImage = body.updateImage === true;
        if (
          avatarPath &&
          (!avatarPath.startsWith(`${user.id}/`) || avatarPath.length > 200)
        ) {
          throw new ChatError("INVALID_IMAGE", 400);
        }
        const profile = await rpc("chat_update_profile", {
          p_user_id: user.id,
          p_name: name,
          p_avatar_path: avatarPath,
          p_update_image: updateImage,
          p_about: typeof body.about === "string" ? body.about : "",
        });
        return json(profile);
      }
      case "create-group": {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const usernames = Array.isArray(body.usernames)
          ? body.usernames
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim().replace(/^@/, "").toLowerCase())
          : [];
        if (usernames.some((value) => !USERNAME_PATTERN.test(value))) {
          throw new ChatError("INVALID_USERNAME", 400);
        }
        const id = await rpc("chat_create_group", {
          p_user_id: user.id,
          p_name: name,
          p_usernames: usernames,
        });
        return json({ id });
      }
      case "search-messages": {
        const conversationId = validConversationId(body.conversationId);
        const query = typeof body.query === "string" ? body.query.trim().slice(0, 100) : "";
        if (!query) return json({ messages: [] });
        const messages = await rpc("chat_search_messages", {
          p_conversation_id: conversationId,
          p_user_id: user.id,
          p_query: query,
        });
        return json({ messages });
      }
      case "send-structured-message": {
        const conversationId = validConversationId(body.conversationId);
        const messageType = typeof body.messageType === "string" ? body.messageType : "";
        const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
          ? body.payload
          : {};
        const message = await rpc("chat_send_structured_message", {
          p_conversation_id: conversationId,
          p_user_id: user.id,
          p_message_type: messageType,
          p_body: typeof body.body === "string" ? body.body : "",
          p_payload: payload,
          p_reply_to: body.replyToId == null ? null : validMessageId(body.replyToId),
        });
        return json({ message });
      }
      case "delete-message": {
        const messageId = validMessageId(body.messageId);
        await rpc("chat_delete_message", { p_user_id: user.id, p_message_id: messageId });
        return json({ ok: true });
      }
      case "star-message": {
        const messageId = validMessageId(body.messageId);
        await rpc("chat_set_star", {
          p_user_id: user.id,
          p_message_id: messageId,
          p_starred: body.starred === true,
        });
        return json({ ok: true });
      }
      case "pin-message": {
        const messageId = validMessageId(body.messageId);
        await rpc("chat_set_pin", {
          p_user_id: user.id,
          p_message_id: messageId,
          p_pinned: body.pinned === true,
        });
        return json({ ok: true });
      }
      case "forward-message": {
        const message = await rpc("chat_forward_message", {
          p_user_id: user.id,
          p_message_id: validMessageId(body.messageId),
          p_target_conversation_id: validConversationId(body.targetConversationId),
        });
        return json({ message });
      }
      case "vote-poll": {
        const messageId = validMessageId(body.messageId);
        const optionIndex = Number(body.optionIndex);
        if (!Number.isSafeInteger(optionIndex) || optionIndex < 0) {
          throw new ChatError("INVALID_POLL", 400);
        }
        await rpc("chat_vote_poll", {
          p_message_id: messageId,
          p_user_id: user.id,
          p_option_index: optionIndex,
        });
        return json({ ok: true });
      }
      case "block-user": {
        if (typeof body.userId !== "string") throw new ChatError("USER_NOT_FOUND", 404);
        await rpc("chat_block_user", { p_user_id: user.id, p_blocked_id: body.userId });
        return json({ ok: true });
      }
      case "unblock-user": {
        if (typeof body.userId !== "string") throw new ChatError("USER_NOT_FOUND", 404);
        await rpc("chat_unblock_user", { p_user_id: user.id, p_blocked_id: body.userId });
        return json({ ok: true });
      }
      case "get-blocked-users": {
        const users = await rpc("chat_list_blocked", { p_user_id: user.id });
        return json({ users });
      }
      case "set-muted": {
        const conversationId = validConversationId(body.conversationId);
        await rpc("chat_set_muted", {
          p_user_id: user.id,
          p_conversation_id: conversationId,
          p_muted: body.muted === true,
        });
        return json({ ok: true });
      }
      case "list-statuses": {
        const statuses = await rpc("chat_list_statuses", { p_user_id: user.id });
        return json({ statuses });
      }
      case "create-status": {
        const status = await rpc("chat_create_status", {
          p_user_id: user.id,
          p_body: typeof body.body === "string" ? body.body : "",
          p_media_path: typeof body.mediaPath === "string" ? body.mediaPath : null,
          p_media_type: typeof body.mediaType === "string" ? body.mediaType : null,
          p_media_name: typeof body.mediaName === "string" ? body.mediaName : null,
        });
        return json({ status });
      }
      case "delete-status": {
        if (typeof body.statusId !== "string") throw new ChatError("NOT_FOUND", 404);
        const deleted = await rpc("chat_delete_status", {
          p_user_id: user.id,
          p_status_id: body.statusId,
        });
        return json({ deleted });
      }
      default:
        throw new ChatError("NOT_FOUND", 404);
    }
  } catch (error) {
    if (error instanceof ChatError) return json({ error: error.code }, error.status);
    console.error("handle-chat failed:", error);
    return json({ error: "GENERIC" }, 500);
  }
}

Deno.serve(handle);
