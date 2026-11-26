import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEY = getSecretKey();
const USERNAME_PATTERN = /^[a-z0-9_.]{3,20}$/;
const GENERAL_AI_HISTORY_PAGE_SIZE = 80;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-device-id, x-message-bot-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

class ChatError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public details: Record<string, unknown> = {},
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
      Authorization: `Bearer ${getServiceAuthorizationKey()}`,
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
      "MESSAGE_REQUEST_PENDING",
      "MESSAGE_REQUEST_DECLINED",
      "INVALID_GROUP_NAME",
      "INVALID_GROUP_MEMBERS",
      "INVALID_MESSAGE_TYPE",
      "INVALID_MESSAGE",
      "INVALID_POLL",
      "INVALID_REPLY",
      "ABOUT_TOO_LONG",
      "EMPTY_STATUS",
      "STATUS_TOO_LONG",
      "ADMIN_REQUIRED",
      "INVALID_USERNAME",
      "GROUP_ADMIN_ONLY",
      "GROUP_PERMISSION_DENIED",
      "INVALID_GROUP_INVITE",
      "MESSAGE_NOT_EDITABLE",
      "INVALID_REACTION",
      "INVALID_EXPIRY_DURATION",
      "NAME_REQUIRED",
      "NAME_TOO_LONG",
      "ABOUT_TOO_LONG",
      "NOT_FOUND",
    ].find((code) => searchable.includes(code));
    if (known) {
      throw new ChatError(
        known,
        known === "NOT_FOUND" || known === "USER_NOT_FOUND" || known === "INVALID_GROUP_INVITE"
          ? 404
          : known === "ADMIN_REQUIRED" || known === "GROUP_PERMISSION_DENIED" || known === "GROUP_ADMIN_ONLY"
            ? 403
            : 400,
      );
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

async function createSignedMediaUrl(path: string, expiresIn = 3600) {
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/chat-media/${encodeObjectPath(path)}`,
    {
      method: "POST",
      headers: {
        apikey: SECRET_KEY,
        Authorization: `Bearer ${getServiceAuthorizationKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn }),
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
  return { url, expiresAt: Math.floor(Date.now() / 1000) + expiresIn };
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

function validUserId(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new ChatError("USER_NOT_FOUND", 404);
  }
  return value;
}

async function serviceRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("apikey", SECRET_KEY);
  headers.set("Authorization", `Bearer ${getServiceAuthorizationKey()}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
}

async function purgeExpiredMessages() {
  const mediaPaths = await rpc("chat_get_expired_media_paths", {});
  if (Array.isArray(mediaPaths) && mediaPaths.length > 0) {
    const response = await serviceRequest("/storage/v1/object/chat-media", {
      method: "DELETE",
      body: JSON.stringify({ prefixes: mediaPaths }),
    }).catch(() => null);
    if (!response?.ok) return;
  }
  await rpc("chat_purge_expired_messages", {});
}

async function groupContext(conversationId: number, userId: string) {
  const [conversationResponse, memberResponse] = await Promise.all([
    serviceRequest(`/rest/v1/conversations?select=id,kind,name,createdBy,groupSettings&id=eq.${conversationId}&limit=1`),
    serviceRequest(`/rest/v1/conversation_members?select=userId,role&conversationId=eq.${conversationId}&userId=eq.${encodeURIComponent(userId)}&limit=1`),
  ]);
  if (!conversationResponse.ok || !memberResponse.ok) throw new ChatError("GENERIC", 500);
  const conversations = await conversationResponse.json();
  const members = await memberResponse.json();
  const conversation = conversations?.[0];
  const member = members?.[0];
  if (conversation?.kind !== "group" || !member) throw new ChatError("NOT_FOUND", 404);
  const raw = conversation.groupSettings && typeof conversation.groupSettings === "object"
    ? conversation.groupSettings
    : {};
  const settings = {
    addMembers: raw.addMembers === "all" ? "all" : "admins",
    shareInvite: raw.shareInvite === "all" ? "all" : "admins",
    requireApproval: raw.requireApproval === true,
    sendMessages: raw.sendMessages === "admins" ? "admins" : "all",
    editGroup: raw.editGroup === "all" ? "all" : "admins",
  };
  const isAdmin = conversation.createdBy === userId || member.role === "admin";
  return { conversation, member, settings, isAdmin };
}

async function groupContextForInvite(conversationId: number) {
  const response = await serviceRequest(
    `/rest/v1/conversations?select=id,kind,groupSettings&id=eq.${conversationId}&limit=1`,
  );
  if (!response.ok) throw new ChatError("GENERIC", 500);
  const conversations = await response.json();
  const conversation = conversations?.[0];
  if (conversation?.kind !== "group") throw new ChatError("INVALID_GROUP_INVITE", 404);
  const raw = conversation.groupSettings && typeof conversation.groupSettings === "object"
    ? conversation.groupSettings
    : {};
  return {
    settings: {
      requireApproval: raw.requireApproval === true,
    },
  };
}

async function requireGroupAdmin(conversationId: number, userId: string) {
  const group = await groupContext(conversationId, userId);
  if (!group.isAdmin) throw new ChatError("GROUP_PERMISSION_DENIED", 403);
  return group;
}

async function insertGroupMembers(conversationId: number, userIds: string[]) {
  if (!userIds.length) return;
  const response = await serviceRequest("/rest/v1/conversation_members?on_conflict=conversationId,userId", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(userIds.map((userId) => ({ conversationId, userId, role: "member" }))),
  });
  if (!response.ok) throw new ChatError("GENERIC", 500);
}

async function upsertGroupRequests(conversationId: number, userIds: string[], requestedBy: string) {
  if (!userIds.length) return;
  const response = await serviceRequest("/rest/v1/group_member_requests?on_conflict=conversation_id,user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(userIds.map((userId) => ({
      conversation_id: conversationId,
      user_id: userId,
      requested_by: requestedBy,
      status: "pending",
      reviewed_by: null,
      reviewed_at: null,
      created_at: new Date().toISOString(),
    }))),
  });
  if (!response.ok) throw new ChatError("GENERIC", 500);
}

async function recordGroupMembersAddedNotice(conversationId: number, actorId: string, addedUserIds: string[]) {
  const uniqueIds = [...new Set(addedUserIds)].filter((id) => id !== actorId);
  if (!uniqueIds.length) return;
  try {
    await rpc("chat_record_group_members_added", {
      p_actor_id: actorId,
      p_conversation_id: conversationId,
      p_added_user_ids: uniqueIds,
    });
  } catch {
    // The membership change is already committed; keep it successful if the optional notice fails.
    console.error("Could not record the group member notice.");
  }
}

async function recordGroupMembersAddedByUsername(conversationId: number, actorId: string, usernames: string[]) {
  if (!usernames.length) return;
  try {
    const response = await serviceRequest(
      `/rest/v1/profiles?select=id&username=in.(${usernames.join(",")})`,
    );
    if (!response.ok) throw new ChatError("GENERIC", 500);
    const profiles = await response.json();
    await recordGroupMembersAddedNotice(
      conversationId,
      actorId,
      profiles.map((profile: { id: string }) => profile.id),
    );
  } catch {
    console.error("Could not resolve group invitees for the notice.");
  }
}

async function requireAdmin(userId: string) {
  const response = await serviceRequest(
    `/rest/v1/profiles?select=role&id=eq.${encodeURIComponent(userId)}`,
  );
  if (!response.ok) throw new ChatError("GENERIC", 500);
  const profiles = await response.json();
  if (profiles?.[0]?.role !== "admin") throw new ChatError("ADMIN_REQUIRED", 403);
}

function normalizeDeviceId(raw: unknown) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function requestDeviceId(request: Request) {
  return normalizeDeviceId(request.headers.get("x-device-id"));
}

async function assertDeviceAllowed(deviceId: string) {
  const response = await serviceRequest(
    `/rest/v1/device_bans?select=reason,created_at&device_id=eq.${encodeURIComponent(deviceId)}&limit=1`,
  );
  if (!response.ok) throw new ChatError("GENERIC", 500);
  const ban = (await response.json())?.[0];
  if (ban) throw new ChatError("DEVICE_BANNED", 403, { reason: ban.reason });
}

async function recordDevice(request: Request, deviceId: string | null, userId: string) {
  if (!deviceId) return;
  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 512);
  const response = await serviceRequest(
    "/rest/v1/device_registry?on_conflict=device_id",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        device_id: deviceId,
        user_id: userId,
        last_seen_at: new Date().toISOString(),
        user_agent: userAgent,
      }),
    },
  );
  if (!response.ok) throw new ChatError("GENERIC", 500);
}

async function activeAccountBan(userId: string) {
  const response = await serviceRequest(
    `/rest/v1/account_bans?select=expires_at,reason&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
  );
  if (!response.ok) throw new ChatError("GENERIC", 500);
  const ban = (await response.json())?.[0] as
    | { expires_at: string | null; reason: string }
    | undefined;
  if (!ban) return null;
  if (ban.expires_at && Date.parse(ban.expires_at) <= Date.now()) return null;
  return { expiresAt: ban.expires_at, reason: ban.reason };
}

async function adminAuthUser(userId: string, method: "PATCH" | "DELETE", body?: Record<string, unknown>) {
  const response = await serviceRequest(
    `/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  if (!response.ok) {
    const error = await readError(response);
    throw new ChatError(
      error.code === "USER_NOT_FOUND" ? error.code : "GENERIC",
      response.status >= 500 ? 500 : 400,
    );
  }
  return method === "DELETE" ? null : response.json();
}

function randomBase64Url(byteLength: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function getMessageBotCredential(ownerUserId: string) {
  const response = await serviceRequest(
    `/rest/v1/message_bot_credentials?select=owner_user_id,bot_user_id,conversation_id,token_hash,token_hint,created_at,last_used_at,revoked_at&owner_user_id=eq.${encodeURIComponent(ownerUserId)}&limit=1`,
  );
  if (!response.ok) throw new ChatError("GENERIC", 500);
  return (await response.json())?.[0] ?? null;
}

async function issueMessageBotKey(ownerUserId: string) {
  const token = `mchat_ai_${randomBase64Url(32)}`;
  const tokenHash = await sha256Hex(token);
  const tokenHint = token.slice(-8);
  const previous = await getMessageBotCredential(ownerUserId);

  if (previous?.bot_user_id && previous?.conversation_id) {
    const response = await serviceRequest(
      `/rest/v1/message_bot_credentials?owner_user_id=eq.${encodeURIComponent(ownerUserId)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          token_hash: tokenHash,
          token_hint: tokenHint,
          created_at: new Date().toISOString(),
          last_used_at: null,
          revoked_at: null,
          rate_window_started_at: new Date().toISOString(),
          request_count: 0,
        }),
      },
    );
    if (!response.ok) throw new ChatError("GENERIC", 500);
    const profileResponse = await serviceRequest(
      `/rest/v1/profiles?select=username,name&id=eq.${encodeURIComponent(previous.bot_user_id)}&limit=1`,
    );
    if (!profileResponse.ok) throw new ChatError("GENERIC", 500);
    const botProfile = (await profileResponse.json())?.[0];
    return { token, botUsername: botProfile?.username ?? null, conversationId: previous.conversation_id };
  }

  if (previous) {
    if (previous.bot_user_id) await adminAuthUser(previous.bot_user_id, "DELETE").catch(() => null);
    const reset = await serviceRequest(
      `/rest/v1/message_bot_credentials?owner_user_id=eq.${encodeURIComponent(ownerUserId)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          bot_user_id: null,
          conversation_id: null,
          token_hash: tokenHash,
          token_hint: tokenHint,
          created_at: new Date().toISOString(),
          last_used_at: null,
          revoked_at: null,
          rate_window_started_at: new Date().toISOString(),
          request_count: 0,
        }),
      },
    );
    if (!reset.ok) throw new ChatError("GENERIC", 500);
  } else {
    const reserve = await serviceRequest("/rest/v1/message_bot_credentials", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ owner_user_id: ownerUserId, token_hash: tokenHash, token_hint: tokenHint }),
    });
    if (!reserve.ok) throw new ChatError("GENERIC", 409);
  }

  const botUsername = `message_ai_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const botPassword = randomBase64Url(48);
  let botUserId: string | null = null;
  try {
    const created = await serviceRequest("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({
        email: `${botUsername}@users.handle.local`,
        password: botPassword,
        email_confirm: true,
        user_metadata: { username: botUsername, name: "Message AI" },
      }),
    });
    if (!created.ok) throw new ChatError("GENERIC", 500);
    const botUser = await created.json();
    if (typeof botUser?.id !== "string") throw new ChatError("GENERIC", 500);
    botUserId = botUser.id;
    const conversationId = await rpc("chat_start_conversation", { p_user_id: ownerUserId, p_username: botUsername });
    const finish = await serviceRequest(
      `/rest/v1/message_bot_credentials?owner_user_id=eq.${encodeURIComponent(ownerUserId)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ bot_user_id: botUserId, conversation_id: conversationId }),
      },
    );
    if (!finish.ok) throw new ChatError("GENERIC", 500);
    return { token, botUsername, conversationId };
  } catch (error) {
    await serviceRequest(`/rest/v1/message_bot_credentials?owner_user_id=eq.${encodeURIComponent(ownerUserId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    }).catch(() => null);
    if (botUserId) await adminAuthUser(botUserId, "DELETE").catch(() => null);
    throw error;
  }
}

async function authenticateMessageBot(request: Request) {
  const token = (request.headers.get("x-message-bot-key") ?? "").trim();
  if (!/^mchat_ai_[A-Za-z0-9_-]{40,64}$/.test(token)) throw new ChatError("UNAUTHORIZED", 401);
  const tokenHash = await sha256Hex(token);
  const response = await serviceRequest(
    `/rest/v1/message_bot_credentials?select=owner_user_id,bot_user_id,conversation_id,revoked_at&token_hash=eq.${tokenHash}&limit=1`,
  );
  if (!response.ok) throw new ChatError("GENERIC", 500);
  const credential = (await response.json())?.[0];
  if (!credential || credential.revoked_at || !credential.bot_user_id || !credential.conversation_id) {
    throw new ChatError("UNAUTHORIZED", 401);
  }
  if (!await rpc("chat_bot_allow_request", { p_credential_owner: credential.owner_user_id })) {
    throw new ChatError("RATE_LIMITED", 429);
  }
  return credential as { owner_user_id: string; bot_user_id: string; conversation_id: number };
}

const IMPORT_MESSAGE_TYPES = new Set(["text", "image", "video", "voice", "document", "location", "contact", "poll", "event"]);

function normalizeImportedArchive(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ChatError("INVALID_ARCHIVE", 400);
  if (JSON.stringify(input).length > 5_000_000) throw new ChatError("ARCHIVE_TOO_LARGE", 413);
  const root = input as Record<string, unknown>;
  const rawConversations = Array.isArray(root.conversations) ? root.conversations : [root];
  if (rawConversations.length < 1 || rawConversations.length > 200) throw new ChatError("INVALID_ARCHIVE", 400);
  let messageCount = 0;
  const conversations = rawConversations.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ChatError("INVALID_ARCHIVE", 400);
    const conversation = entry as Record<string, unknown>;
    if (!Array.isArray(conversation.messages) || conversation.messages.length > 20_000) throw new ChatError("INVALID_ARCHIVE", 400);
    messageCount += conversation.messages.length;
    if (messageCount > 20_000) throw new ChatError("INVALID_ARCHIVE", 400);
    const name = typeof conversation.name === "string" ? conversation.name.trim().slice(0, 100) : "";
    if (!name) throw new ChatError("INVALID_ARCHIVE", 400);
    const messages = conversation.messages.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ChatError("INVALID_ARCHIVE", 400);
      const message = entry as Record<string, unknown>;
      const body = typeof message.body === "string" ? message.body : "";
      if (body.length > 4000) throw new ChatError("INVALID_ARCHIVE", 400);
      const parsedDate = typeof message.createdAt === "string" ? Date.parse(message.createdAt) : Number.NaN;
      if (!Number.isFinite(parsedDate)) throw new ChatError("INVALID_ARCHIVE", 400);
      const payload = message.payload && typeof message.payload === "object" && !Array.isArray(message.payload) ? message.payload : {};
      if (JSON.stringify(payload).length > 20_000) throw new ChatError("INVALID_ARCHIVE", 400);
      const mediaType = typeof message.mediaType === "string" && message.mediaType.length <= 100 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(message.mediaType) ? message.mediaType : null;
      return {
        id: Number.isSafeInteger(Number(message.id)) && Number(message.id) > 0 ? Number(message.id) : null,
        sender: typeof message.sender === "string" ? message.sender.trim().replace(/^@/, "").slice(0, 20) : "unknown",
        body,
        createdAt: new Date(parsedDate).toISOString(),
        editedAt: typeof message.editedAt === "string" && Number.isFinite(Date.parse(message.editedAt)) ? new Date(message.editedAt).toISOString() : null,
        messageType: typeof message.messageType === "string" && IMPORT_MESSAGE_TYPES.has(message.messageType) ? message.messageType : "text",
        mediaType,
        mediaName: typeof message.mediaName === "string" ? message.mediaName.slice(0, 255) : null,
        payload,
      };
    });
    const exportedAt = typeof conversation.exportedAt === "string" && Number.isFinite(Date.parse(conversation.exportedAt))
      ? new Date(conversation.exportedAt).toISOString()
      : new Date().toISOString();
    return {
      sourceConversationId: Number.isSafeInteger(Number(conversation.conversationId)) ? Number(conversation.conversationId) : null,
      name,
      exportedAt,
      messages,
    };
  });
  const profile = root.profile && typeof root.profile === "object" && !Array.isArray(root.profile)
    ? root.profile as Record<string, unknown>
    : null;
  const archive = {
    format: "message-chat-archive",
    version: 1,
    profile: profile ? {
      username: typeof profile.username === "string" ? profile.username.slice(0, 20) : null,
      name: typeof profile.name === "string" ? profile.name.slice(0, 50) : null,
    } : null,
    conversations,
  };
  const name = conversations.length === 1 ? conversations[0].name : (profile?.name ? `${String(profile.name).slice(0, 65)} · archive` : "Imported conversations");
  return { archive, name, conversationCount: conversations.length, messageCount };
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
    if (body?.action === "bot-inbox" || body?.action === "bot-send") {
      const credential = await authenticateMessageBot(request);
      if (await activeAccountBan(credential.owner_user_id)) throw new ChatError("ACCOUNT_BANNED", 403);
      if (body.action === "bot-inbox") {
        const afterId = body.afterId == null ? 0 : Number(body.afterId);
        if (!Number.isSafeInteger(afterId) || afterId < 0) throw new ChatError("NOT_FOUND", 400);
        const messages = await rpc("chat_bot_get_messages", {
          p_owner_user_id: credential.owner_user_id,
          p_bot_user_id: credential.bot_user_id,
          p_conversation_id: credential.conversation_id,
          p_after_id: afterId,
        });
        return json({ messages: Array.isArray(messages) ? messages : [] });
      }
      const messageBody = typeof body.body === "string" ? body.body.trim() : "";
      if (!messageBody) throw new ChatError("EMPTY_MESSAGE", 400);
      if (messageBody.length > 4000) throw new ChatError("MESSAGE_TOO_LONG", 400);
      await rpc("chat_assert_send_allowed", {
        p_conversation_id: credential.conversation_id,
        p_user_id: credential.bot_user_id,
      });
      const message = await rpc("chat_send_message", {
        p_conversation_id: credential.conversation_id,
        p_user_id: credential.bot_user_id,
        p_body: messageBody,
        p_reply_to: body.replyToId == null ? null : validMessageId(body.replyToId),
      });
      return json({ message });
    }
    const deviceId = requestDeviceId(request);
    if (!deviceId) throw new ChatError("DEVICE_ID_REQUIRED", 400);
    if (body?.action === "sign-up") {
      if (deviceId) await assertDeviceAllowed(deviceId);
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
    await assertDeviceAllowed(deviceId);
    if (body?.action === "me") await recordDevice(request, deviceId, user.id);
    const accountBan = await activeAccountBan(user.id);
    if (accountBan) {
      throw new ChatError("ACCOUNT_BANNED", 403, accountBan);
    }
    switch (body?.action) {
      case "me": {
        const profile = await rpc("chat_get_profile", { p_user_id: user.id });
        if (!profile) throw new ChatError("UNAUTHORIZED", 401);
        return json(profile);
      }
      case "list-general-ai-history": {
        const beforeId = Number(body.beforeId);
        const beforeFilter = Number.isSafeInteger(beforeId) && beforeId > 0
          ? `&id=lt.${beforeId}`
          : "";
        const response = await serviceRequest(
          `/rest/v1/general_ai_messages?select=id,client_id,role,body,created_at,deleted_at,starred,pinned,reply_to_id,reply_body&user_id=eq.${encodeURIComponent(user.id)}${beforeFilter}&order=id.desc&limit=${GENERAL_AI_HISTORY_PAGE_SIZE + 1}`,
        );
        if (!response.ok) throw new ChatError("GENERIC", 500);
        const rows = await response.json();
        const page = Array.isArray(rows) ? rows.slice(0, GENERAL_AI_HISTORY_PAGE_SIZE) : [];
        return json({
          messages: page.reverse(),
          hasMore: Array.isArray(rows) && rows.length > GENERAL_AI_HISTORY_PAGE_SIZE,
        });
      }
      case "import-general-ai-history": {
        const incoming = Array.isArray(body.messages) ? body.messages : null;
        if (!incoming || incoming.length > 25) throw new ChatError("INVALID_AI_HISTORY", 400);
        let totalCharacters = 0;
        const rows = incoming.map((message) => {
          const clientId = typeof message?.client_id === "string" && /^[0-9a-f-]{36}$/i.test(message.client_id)
            ? message.client_id
            : "";
          const role = message?.role === "user" || message?.role === "assistant" ? message.role : null;
          const content = typeof message?.body === "string" ? message.body : "";
          if (!clientId || !role || !content || content.length > 1_000_000 || (role === "user" && content.length > 2_000)) {
            throw new ChatError("INVALID_AI_HISTORY", 400);
          }
          totalCharacters += content.length;
          if (totalCharacters > 1_000_000) throw new ChatError("INVALID_AI_HISTORY", 400);
          const createdAt = typeof message.created_at === "string" && Number.isFinite(Date.parse(message.created_at))
            ? new Date(message.created_at).toISOString()
            : new Date().toISOString();
          const deletedAt = typeof message.deleted_at === "string" && Number.isFinite(Date.parse(message.deleted_at))
            ? new Date(message.deleted_at).toISOString()
            : null;
          return {
            user_id: user.id,
            client_id: clientId,
            role,
            body: content,
            created_at: createdAt,
            deleted_at: deletedAt,
            starred: message.starred === true,
            pinned: message.pinned === true,
            reply_body: typeof message.reply_body === "string" ? message.reply_body.slice(0, 4_000) : null,
          };
        });
        if (!rows.length) return json({ messages: [] });
        const response = await serviceRequest("/rest/v1/general_ai_messages?on_conflict=user_id,client_id", {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
          body: JSON.stringify(rows),
        });
        if (!response.ok) throw new ChatError("GENERIC", 500);
        return json({ messages: await response.json() });
      }
      case "save-general-ai-exchange": {
        const userMessage = typeof body.userMessage === "string" ? body.userMessage.trim() : "";
        const assistantMessage = typeof body.assistantMessage === "string" ? body.assistantMessage.trim() : "";
        if (!userMessage || userMessage.length > 2000 || !assistantMessage || assistantMessage.length > 1_000_000) {
          throw new ChatError("INVALID_AI_EXCHANGE", 400);
        }
        const userClientId = typeof body.userMessageId === "string" && /^[0-9a-f-]{36}$/i.test(body.userMessageId)
          ? body.userMessageId
          : crypto.randomUUID();
        const assistantClientId = typeof body.assistantMessageId === "string" && /^[0-9a-f-]{36}$/i.test(body.assistantMessageId)
          ? body.assistantMessageId
          : crypto.randomUUID();
        const replyToId = body.replyToId == null ? null : validMessageId(body.replyToId);
        let replyBody: string | null = null;
        if (replyToId !== null) {
          const replyResponse = await serviceRequest(
            `/rest/v1/general_ai_messages?select=id,body,deleted_at&user_id=eq.${encodeURIComponent(user.id)}&id=eq.${replyToId}&limit=1`,
          );
          if (!replyResponse.ok) throw new ChatError("GENERIC", 500);
          const replyRows = await replyResponse.json();
          if (!replyRows.length) throw new ChatError("INVALID_REPLY", 400);
          replyBody = String(replyRows[0].body ?? "").slice(0, 4000);
        }
        const insertResponse = await serviceRequest("/rest/v1/general_ai_messages?on_conflict=user_id,client_id", {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
          body: JSON.stringify([
            { user_id: user.id, client_id: userClientId, role: "user", body: userMessage, reply_to_id: replyToId, reply_body: replyBody },
            { user_id: user.id, client_id: assistantClientId, role: "assistant", body: assistantMessage },
          ]),
        });
        if (!insertResponse.ok) throw new ChatError("GENERIC", 500);
        return json({ saved: true, messages: await insertResponse.json() });
      }
      case "set-general-ai-message-flags": {
        const messageId = validMessageId(body.messageId);
        const update: Record<string, boolean> = {};
        if (typeof body.starred === "boolean") update.starred = body.starred;
        if (typeof body.pinned === "boolean") update.pinned = body.pinned;
        if (!Object.keys(update).length) throw new ChatError("INVALID_MESSAGE", 400);
        const response = await serviceRequest(
          `/rest/v1/general_ai_messages?user_id=eq.${encodeURIComponent(user.id)}&id=eq.${messageId}&deleted_at=is.null`,
          { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(update) },
        );
        if (!response.ok) throw new ChatError("GENERIC", 500);
        const rows = await response.json();
        if (!rows.length) throw new ChatError("NOT_FOUND", 404);
        return json({ message: rows[0] });
      }
      case "delete-general-ai-message": {
        const messageId = validMessageId(body.messageId);
        const response = await serviceRequest(
          `/rest/v1/general_ai_messages?user_id=eq.${encodeURIComponent(user.id)}&id=eq.${messageId}&deleted_at=is.null`,
          {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({ deleted_at: new Date().toISOString(), starred: false, pinned: false }),
          },
        );
        if (!response.ok) throw new ChatError("GENERIC", 500);
        const rows = await response.json();
        if (!rows.length) throw new ChatError("NOT_FOUND", 404);
        return json({ ok: true, message: rows[0] });
      }
      case "clear-general-ai-history": {
        const response = await serviceRequest(
          `/rest/v1/general_ai_messages?user_id=eq.${encodeURIComponent(user.id)}`,
          { method: "DELETE", headers: { Prefer: "return=minimal" } },
        );
        if (!response.ok) throw new ChatError("GENERIC", 500);
        return json({ cleared: true });
      }
      case "list-own-devices": {
        const response = await serviceRequest(
          `/rest/v1/device_registry?select=device_id,last_seen_at,user_agent&user_id=eq.${encodeURIComponent(user.id)}&order=last_seen_at.desc&limit=100`,
        );
        if (!response.ok) throw new ChatError("GENERIC", 500);
        const devices = await response.json();
        return json({
          devices: (devices as Array<Record<string, unknown>>).map((device) => ({
            deviceId: device.device_id,
            lastSeenAt: device.last_seen_at,
            userAgent: device.user_agent,
            isCurrent: device.device_id === deviceId,
          })),
        });
      }
      case "admin-list-users": {
        await requireAdmin(user.id);
        const [response, bansResponse] = await Promise.all([
          serviceRequest(
          "/rest/v1/profiles?select=id,username,name,image,about,role,created_at&order=username.asc&limit=1000",
          ),
          serviceRequest("/rest/v1/account_bans?select=user_id,expires_at,reason&limit=1000"),
        ]);
        if (!response.ok || !bansResponse.ok) throw new ChatError("GENERIC", 500);
        const [users, bans] = await Promise.all([response.json(), bansResponse.json()]);
        const activeBans = new Map(
          (bans as Array<{ user_id: string; expires_at: string | null; reason: string }>)
            .filter((ban) => !ban.expires_at || Date.parse(ban.expires_at) > Date.now())
            .map((ban) => [ban.user_id, { expiresAt: ban.expires_at, reason: ban.reason }]),
        );
        return json({ users: (users as Array<Record<string, unknown>>).map((item) => ({
          ...item,
          accountBan: activeBans.get(String(item.id)) ?? null,
        })) });
      }
      case "admin-update-user": {
        await requireAdmin(user.id);
        const targetId = validUserId(body.userId);
        const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const image = typeof body.image === "string" ? body.image.trim() : "";
        const about = typeof body.about === "string" ? body.about.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!USERNAME_PATTERN.test(username)) throw new ChatError("INVALID_USERNAME", 400);
        if (!name || name.length > 50) throw new ChatError(name ? "NAME_TOO_LONG" : "NAME_REQUIRED", 400);
        if (image.length > 500 || about.length > 150 || password.length > 128 || (password && password.length < 8)) {
          throw new ChatError(about.length > 150 ? "ABOUT_TOO_LONG" : "INVALID_MESSAGE", 400);
        }

        const targetResponse = await serviceRequest(
          `/rest/v1/profiles?select=id,username,name,image,about&id=eq.${encodeURIComponent(targetId)}`,
        );
        if (!targetResponse.ok) throw new ChatError("GENERIC", 500);
        const currentProfiles = await targetResponse.json();
        const current = currentProfiles?.[0];
        if (!current) throw new ChatError("USER_NOT_FOUND", 404);
        const duplicateResponse = await serviceRequest(
          `/rest/v1/profiles?select=id&username=eq.${encodeURIComponent(username)}&id=neq.${encodeURIComponent(targetId)}`,
        );
        if (!duplicateResponse.ok) throw new ChatError("GENERIC", 500);
        if ((await duplicateResponse.json()).length) throw new ChatError("USERNAME_TAKEN", 409);

        await rpc("chat_admin_update_profile", {
          p_actor_id: user.id,
          p_target_id: targetId,
          p_username: username,
          p_name: name,
          p_image: image,
          p_about: about,
        });
        try {
          await adminAuthUser(targetId, "PATCH", {
            email: `${username}@users.handle.local`,
            email_confirm: true,
            user_metadata: { username, name },
            ...(password ? { password } : {}),
          });
        } catch (error) {
          await rpc("chat_admin_update_profile", {
            p_actor_id: user.id,
            p_target_id: targetId,
            p_username: current.username,
            p_name: current.name,
            p_image: current.image ?? "",
            p_about: current.about ?? "",
          }).catch(() => undefined);
          throw error;
        }
        return json({ ok: true });
      }
      case "admin-delete-user": {
        await requireAdmin(user.id);
        const targetId = validUserId(body.userId);
        if (targetId === user.id) throw new ChatError("INVALID_MESSAGE", 400);
        await adminAuthUser(targetId, "DELETE");
        // Account deletion never creates a device ban. That action is explicit.
        await rpc("chat_cleanup_orphan_conversations", { p_actor_id: user.id });
        return json({ ok: true });
      }
      case "admin-set-account-ban": {
        await requireAdmin(user.id);
        const targetId = validUserId(body.userId);
        const duration = body.duration;
        const durationHours = duration === "until_lifted"
          ? null
          : Number(duration);
        if (durationHours !== null && ![1, 24, 168, 720].includes(durationHours)) {
          throw new ChatError("INVALID_MESSAGE", 400);
        }
        const targetResponse = await serviceRequest(
          `/rest/v1/profiles?select=id&id=eq.${encodeURIComponent(targetId)}&limit=1`,
        );
        if (!targetResponse.ok) throw new ChatError("GENERIC", 500);
        if (!(await targetResponse.json()).length) throw new ChatError("USER_NOT_FOUND", 404);
        const reason = typeof body.reason === "string"
          ? body.reason.trim().slice(0, 200)
          : "";
        const expiresAt = durationHours === null
          ? null
          : new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();
        const response = await serviceRequest("/rest/v1/account_bans?on_conflict=user_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            user_id: targetId,
            expires_at: expiresAt,
            reason: reason || "Conversation review in progress",
            banned_by: user.id,
          }),
        });
        if (!response.ok) throw new ChatError("GENERIC", 500);
        return json({ accountBan: { expiresAt, reason: reason || "Conversation review in progress" } });
      }
      case "admin-clear-account-ban": {
        await requireAdmin(user.id);
        const targetId = validUserId(body.userId);
        const response = await serviceRequest(
          `/rest/v1/account_bans?user_id=eq.${encodeURIComponent(targetId)}`,
          { method: "DELETE" },
        );
        if (!response.ok) throw new ChatError("GENERIC", 500);
        return json({ ok: true });
      }
      case "admin-list-devices": {
        await requireAdmin(user.id);
        const targetId = validUserId(body.userId);
        const [devicesResponse, bansResponse] = await Promise.all([
          serviceRequest(`/rest/v1/device_registry?select=device_id,last_seen_at,user_agent&user_id=eq.${encodeURIComponent(targetId)}&order=last_seen_at.desc&limit=100`),
          serviceRequest("/rest/v1/device_bans?select=device_id,reason,created_at&limit=1000"),
        ]);
        if (!devicesResponse.ok || !bansResponse.ok) throw new ChatError("GENERIC", 500);
        const [devices, bans] = await Promise.all([devicesResponse.json(), bansResponse.json()]);
        const byId = new Map((bans as Array<{ device_id: string; reason: string; created_at: string }>).map((ban) => [ban.device_id, ban]));
        return json({ devices: (devices as Array<Record<string, unknown>>).map((device) => {
          const ban = byId.get(String(device.device_id));
          return { ...device, blockedAt: ban?.created_at ?? null, blockReason: ban?.reason ?? null };
        }) });
      }
      case "admin-set-device-ban": {
        await requireAdmin(user.id);
        const deviceId = normalizeDeviceId(body.deviceId);
        if (!deviceId) throw new ChatError("INVALID_MESSAGE", 400);
        if (body.blocked === true) {
          const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "";
          const response = await serviceRequest("/rest/v1/device_bans?on_conflict=device_id", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({
              device_id: deviceId,
              reason: reason || "Device blocked by an administrator",
              banned_by: user.id,
            }),
          });
          if (!response.ok) throw new ChatError("GENERIC", 500);
        } else {
          const response = await serviceRequest(
            `/rest/v1/device_bans?device_id=eq.${encodeURIComponent(deviceId)}`,
            { method: "DELETE" },
          );
          if (!response.ok) throw new ChatError("GENERIC", 500);
        }
        return json({ ok: true });
      }
      case "submit-report": {
        const details = typeof body.details === "string" ? body.details.trim() : "";
        const reportedUserId = body.reportedUserId ? validUserId(body.reportedUserId) : null;
        const conversationId = body.conversationId == null ? null : validConversationId(body.conversationId);
        if ((!reportedUserId && !conversationId) || details.length < 3 || details.length > 1000 || reportedUserId === user.id) {
          throw new ChatError("INVALID_REPORT", 400);
        }
        if (reportedUserId) {
          const targetResponse = await serviceRequest(`/rest/v1/profiles?select=id&id=eq.${encodeURIComponent(reportedUserId)}&limit=1`);
          if (!targetResponse.ok) throw new ChatError("GENERIC", 500);
          if (!(await targetResponse.json()).length) throw new ChatError("USER_NOT_FOUND", 404);
        }
        if (conversationId !== null) {
          const membersResponse = await serviceRequest(
            `/rest/v1/conversation_members?select=userId&conversationId=eq.${conversationId}`,
          );
          if (!membersResponse.ok) throw new ChatError("GENERIC", 500);
          const members = (await membersResponse.json()) as Array<{ userId: string }>;
          if (!members.some((member) => member.userId === user.id) || (reportedUserId && !members.some((member) => member.userId === reportedUserId))) {
            throw new ChatError("NOT_FOUND", 404);
          }
        }
        const response = await serviceRequest("/rest/v1/user_reports", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            reporter_id: user.id,
            reported_user_id: reportedUserId,
            conversation_id: conversationId,
            details,
          }),
        });
        if (!response.ok) throw new ChatError("GENERIC", 500);
        return json({ ok: true });
      }
      case "admin-list-reports": {
        await requireAdmin(user.id);
        const [reportsResponse, profilesResponse] = await Promise.all([
          serviceRequest("/rest/v1/user_reports?select=id,reporter_id,reported_user_id,conversation_id,details,status,created_at&order=created_at.desc&limit=500"),
          serviceRequest("/rest/v1/profiles?select=id,username,name&limit=1000"),
        ]);
        if (!reportsResponse.ok || !profilesResponse.ok) throw new ChatError("GENERIC", 500);
        const [reports, profiles] = await Promise.all([reportsResponse.json(), profilesResponse.json()]);
        const byId = new Map((profiles as Array<{ id: string; username: string; name: string }>).map((profile) => [profile.id, profile]));
        return json({ reports: (reports as Array<Record<string, unknown>>).map((report) => ({
          ...report,
          reporter: byId.get(String(report.reporter_id)) ?? null,
          reportedUser: report.reported_user_id ? byId.get(String(report.reported_user_id)) ?? null : null,
        })) });
      }
      case "admin-list-message-requests": {
        await requireAdmin(user.id);
        const requestResponse = await serviceRequest(
          `/rest/v1/conversation_requests?select=conversation_id,requester_id,status,created_at&admin_id=eq.${encodeURIComponent(user.id)}&status=eq.pending&order=created_at.desc&limit=200`,
        );
        if (!requestResponse.ok) throw new ChatError("GENERIC", 500);
        const requests = await requestResponse.json() as Array<Record<string, unknown>>;
        const requesterIds = [...new Set(requests.map((item) => String(item.requester_id)))];
        const profilesResponse = requesterIds.length
          ? await serviceRequest(`/rest/v1/profiles?select=id,username,name,image&id=in.(${requesterIds.join(",")})`)
          : null;
        if (profilesResponse && !profilesResponse.ok) throw new ChatError("GENERIC", 500);
        const profiles = profilesResponse ? await profilesResponse.json() as Array<Record<string, unknown>> : [];
        const byId = new Map(profiles.map((profile) => [String(profile.id), profile]));
        return json({ requests: requests.map((item) => ({
          conversationId: Number(item.conversation_id),
          requesterId: String(item.requester_id),
          status: item.status,
          createdAt: item.created_at,
          requester: byId.get(String(item.requester_id)) ?? null,
        })) });
      }
      case "admin-set-message-request": {
        await requireAdmin(user.id);
        const conversationId = validConversationId(body.conversationId);
        const status = body.status;
        if (status !== "accepted" && status !== "declined") throw new ChatError("INVALID_MESSAGE", 400);
        await rpc("chat_admin_set_message_request", {
          p_actor_id: user.id,
          p_conversation_id: conversationId,
          p_status: status,
        });
        return json({ ok: true });
      }
      case "admin-set-report-status": {
        await requireAdmin(user.id);
        const reportId = validMessageId(body.reportId);
        const status = body.status;
        if (!["open", "reviewed", "dismissed"].includes(status)) throw new ChatError("INVALID_MESSAGE", 400);
        const response = await serviceRequest(`/rest/v1/user_reports?id=eq.${reportId}`, {
          method: "PATCH",
          body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
          headers: { Prefer: "return=minimal" },
        });
        if (!response.ok) throw new ChatError("GENERIC", 500);
        return json({ ok: true });
      }
      case "admin-list-conversations": {
        await requireAdmin(user.id);
        const conversations = await rpc("chat_admin_list_conversations", { p_actor_id: user.id });
        return json({ conversations });
      }
      case "admin-get-messages": {
        await requireAdmin(user.id);
        const conversationId = validConversationId(body.conversationId);
        const [messagesResponse, pinsResponse] = await Promise.all([
          serviceRequest(`/rest/v1/messages?select=id,senderId,body,createdAt,messageType,deletedAt,mediaName&conversationId=eq.${conversationId}&order=createdAt.asc&limit=300`),
          serviceRequest(`/rest/v1/conversation_pins?select=messageId&conversationId=eq.${conversationId}`),
        ]);
        if (!messagesResponse.ok || !pinsResponse.ok) throw new ChatError("GENERIC", 500);
        const [messages, pins] = await Promise.all([messagesResponse.json(), pinsResponse.json()]);
        const pinned = new Set((pins as Array<{ messageId: number }>).map((pin) => pin.messageId));
        return json({ messages: (messages as Array<Record<string, unknown>>).map((message) => ({ ...message, pinned: pinned.has(Number(message.id)) })) });
      }
      case "admin-delete-conversation":
      {
        await requireAdmin(user.id);
        const conversationId = validConversationId(body.conversationId);
        await rpc("chat_admin_delete_conversation", { p_actor_id: user.id, p_conversation_id: conversationId });
        return json({ ok: true });
      }
      case "delete-conversation": {
        const conversationId = validConversationId(body.conversationId);
        await rpc("chat_delete_conversation", { p_user_id: user.id, p_conversation_id: conversationId });
        return json({ ok: true });
      }
      case "set-conversation-state": {
        const conversationId = validConversationId(body.conversationId);
        await rpc("chat_update_conversation_state", {
          p_user_id: user.id,
          p_conversation_id: conversationId,
          p_archived: typeof body.archived === "boolean" ? body.archived : null,
          p_pinned: typeof body.pinned === "boolean" ? body.pinned : null,
          p_marked_unread: typeof body.markedUnread === "boolean" ? body.markedUnread : null,
        });
        return json({ ok: true });
      }
      case "set-expiry-duration": {
        const conversationId = validConversationId(body.conversationId);
        const duration = body.durationSeconds == null ? null : Number(body.durationSeconds);
        if (duration !== null && !Number.isSafeInteger(duration)) throw new ChatError("INVALID_EXPIRY_DURATION", 400);
        await rpc("chat_set_expiry_duration", {
          p_user_id: user.id,
          p_conversation_id: conversationId,
          p_duration_seconds: duration,
        });
        return json({ ok: true });
      }
      case "export-conversation": {
        const conversationId = validConversationId(body.conversationId);
        const conversation = await rpc("chat_export_conversation", {
          p_user_id: user.id,
          p_conversation_id: conversationId,
        });
        if (!conversation) throw new ChatError("NOT_FOUND", 404);
        return json({ conversation });
      }
      case "export-user-data": {
        const data = await rpc("chat_export_user_data", { p_user_id: user.id });
        if (!data?.profile) throw new ChatError("NOT_FOUND", 404);
        return json({ data });
      }
      case "import-chat-archive": {
        const normalized = normalizeImportedArchive(body.archive);
        const checksum = await sha256Hex(JSON.stringify(normalized.archive));
        const insertion = await serviceRequest(
          "/rest/v1/imported_chat_archives?on_conflict=user_id,checksum",
          {
            method: "POST",
            headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
            body: JSON.stringify({
              user_id: user.id,
              checksum,
              name: normalized.name,
              conversation_count: normalized.conversationCount,
              message_count: normalized.messageCount,
              archive: normalized.archive,
            }),
          },
        );
        if (!insertion.ok) throw new ChatError("INVALID_ARCHIVE", 400);
        let row = (await insertion.json().catch(() => []))?.[0];
        const duplicate = !row;
        if (duplicate) {
          const existing = await serviceRequest(
            `/rest/v1/imported_chat_archives?select=id,name,conversation_count,message_count,imported_at&id=not.is.null&user_id=eq.${encodeURIComponent(user.id)}&checksum=eq.${checksum}&limit=1`,
          );
          if (!existing.ok) throw new ChatError("GENERIC", 500);
          row = (await existing.json())?.[0];
        }
        if (!row) throw new ChatError("GENERIC", 500);
        return json({ archive: row, duplicate });
      }
      case "list-imported-chats": {
        const response = await serviceRequest(
          `/rest/v1/imported_chat_archives?select=id,name,conversation_count,message_count,imported_at&user_id=eq.${encodeURIComponent(user.id)}&order=imported_at.desc&limit=200`,
        );
        if (!response.ok) throw new ChatError("GENERIC", 500);
        return json({ archives: await response.json() });
      }
      case "get-imported-chat": {
        const archiveId = typeof body.id === "string" ? body.id : "";
        if (!/^[0-9a-f-]{36}$/i.test(archiveId)) throw new ChatError("NOT_FOUND", 404);
        const response = await serviceRequest(
          `/rest/v1/imported_chat_archives?select=id,name,conversation_count,message_count,imported_at,archive&id=eq.${encodeURIComponent(archiveId)}&user_id=eq.${encodeURIComponent(user.id)}&limit=1`,
        );
        if (!response.ok) throw new ChatError("GENERIC", 500);
        const archive = (await response.json())?.[0];
        if (!archive) throw new ChatError("NOT_FOUND", 404);
        return json({ archive });
      }
      case "delete-imported-chat": {
        const archiveId = typeof body.id === "string" ? body.id : "";
        if (!/^[0-9a-f-]{36}$/i.test(archiveId)) throw new ChatError("NOT_FOUND", 404);
        const response = await serviceRequest(
          `/rest/v1/imported_chat_archives?id=eq.${encodeURIComponent(archiveId)}&user_id=eq.${encodeURIComponent(user.id)}`,
          { method: "DELETE" },
        );
        if (!response.ok) throw new ChatError("GENERIC", 500);
        return json({ ok: true });
      }
      case "get-message-bot-status": {
        const credential = await getMessageBotCredential(user.id);
        let botUsername: string | null = null;
        if (credential?.bot_user_id) {
          const profileResponse = await serviceRequest(
            `/rest/v1/profiles?select=username,name&id=eq.${encodeURIComponent(credential.bot_user_id)}&limit=1`,
          );
          if (!profileResponse.ok) throw new ChatError("GENERIC", 500);
          botUsername = (await profileResponse.json())?.[0]?.username ?? null;
        }
        return json({
          active: Boolean(credential && !credential.revoked_at && credential.bot_user_id && credential.conversation_id),
          tokenHint: credential?.token_hint ?? null,
          botUsername,
          conversationId: credential?.conversation_id ?? null,
          createdAt: credential?.created_at ?? null,
          lastUsedAt: credential?.last_used_at ?? null,
        });
      }
      case "issue-message-bot-key": {
        const result = await issueMessageBotKey(user.id);
        return json(result);
      }
      case "revoke-message-bot-key": {
        const response = await serviceRequest(
          `/rest/v1/message_bot_credentials?owner_user_id=eq.${encodeURIComponent(user.id)}`,
          {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ revoked_at: new Date().toISOString() }),
          },
        );
        if (!response.ok) throw new ChatError("GENERIC", 500);
        return json({ ok: true });
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
        await purgeExpiredMessages();
        const [conversations, features] = await Promise.all([
          rpc("chat_list_conversations", { p_user_id: user.id }),
          rpc("chat_get_conversation_features", { p_user_id: user.id }),
        ]);
        const featureMap = new Map((Array.isArray(features) ? features : []).map((item: Record<string, unknown>) => [Number(item.id), item]));
        const enriched = (Array.isArray(conversations) ? conversations : []).map((conversation: Record<string, unknown>) => ({
          ...conversation,
          ...(featureMap.get(Number(conversation.id)) ?? {}),
        }));
        return json({ conversations: enriched });
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
        await purgeExpiredMessages();
        const [detail, blockState] = await Promise.all([
          rpc("chat_get_messages", { p_conversation_id: conversationId, p_user_id: user.id }),
          rpc("chat_get_block_state", { p_conversation_id: conversationId, p_user_id: user.id }),
        ]);
        if (!detail) throw new ChatError("NOT_FOUND", 404);
        const [features] = await Promise.all([
          rpc("chat_get_message_features", { p_conversation_id: conversationId, p_user_id: user.id }),
          rpc("chat_update_conversation_state", {
            p_user_id: user.id,
            p_conversation_id: conversationId,
            p_archived: null,
            p_pinned: null,
            p_marked_unread: false,
          }),
        ]);
        const [viewOnceFeatures, peerPrivacy, wallpaper] = await Promise.all([
          rpc("chat_get_view_once_features", { p_conversation_id: conversationId, p_user_id: user.id }),
          rpc("chat_get_peer_privacy", { p_conversation_id: conversationId, p_user_id: user.id }),
          rpc("chat_get_conversation_wallpaper", { p_conversation_id: conversationId, p_user_id: user.id }),
        ]);
        const messageFeatures = new Map((Array.isArray(features?.messages) ? features.messages : []).map((item: Record<string, unknown>) => [Number(item.id), item]));
        const viewOnceMap = new Map((Array.isArray(viewOnceFeatures) ? viewOnceFeatures : []).map((item: Record<string, unknown>) => [Number(item.id), item]));
        const now = Date.now();
        detail.messages = (Array.isArray(detail.messages) ? detail.messages : [])
          .filter((message: Record<string, unknown>) => {
            const metadata = messageFeatures.get(Number(message.id));
            const expiresAt = typeof metadata?.expiresAt === "string" ? Date.parse(metadata.expiresAt) : Number.NaN;
            return !Number.isFinite(expiresAt) || expiresAt > now;
          })
          .map((message: Record<string, unknown>) => {
            const metadata = messageFeatures.get(Number(message.id));
            const once = viewOnceMap.get(Number(message.id));
            const parentMetadata = messageFeatures.get(Number(message.replyTo));
            const parentExpired = typeof parentMetadata?.expiresAt === "string" && Date.parse(parentMetadata.expiresAt) <= now;
            const viewedByMe = once?.viewedByMe === true;
            return {
              ...message,
              viewOnce: once?.viewOnce === true,
              viewedByMe,
              viewed: once?.viewed === true,
              ...(once?.viewOnce === true && once.viewed === true ? { mediaPath: null, viewedMediaPath: message.mediaPath ?? null } : {}),
              editedAt: metadata?.editedAt ?? null,
              expiresAt: metadata?.expiresAt ?? null,
              reactions: Array.isArray(metadata?.reactions) ? metadata.reactions : [],
              ...(parentExpired ? { replyBody: null, replyDeleted: true } : {}),
            };
          });
        if (detail.pinnedMessage) {
          const pinnedMetadata = messageFeatures.get(Number(detail.pinnedMessage.id));
          if (typeof pinnedMetadata?.expiresAt === "string" && Date.parse(pinnedMetadata.expiresAt) <= now) detail.pinnedMessage = null;
        }
        if (detail.conversation) {
          detail.conversation.expiresInSeconds = features?.expiresInSeconds ?? null;
          detail.conversation.wallpaper = typeof wallpaper === "string" ? wallpaper : "default";
        }
        if (detail.other && peerPrivacy && typeof peerPrivacy === "object") {
          detail.other.isOnline = typeof peerPrivacy.lastSeenAt === "string" && Date.now() - Date.parse(peerPrivacy.lastSeenAt) < 120_000;
          detail.other.lastSeenAt = peerPrivacy.lastSeenAt ?? null;
          detail.other.readReceipts = peerPrivacy.readReceipts !== false;
          if (peerPrivacy.readReceipts === false) detail.otherLastReadAt = null;
        }
        if (detail.conversation?.isGroup) {
          const group = await groupContext(conversationId, user.id);
          const membersResponse = await serviceRequest(
            `/rest/v1/conversation_members?select=userId,role&conversationId=eq.${conversationId}`,
          );
          if (!membersResponse.ok) throw new ChatError("GENERIC", 500);
          const groupMembers = await membersResponse.json();
          const roles = new Map(groupMembers.map((member: { userId: string; role: string }) => [member.userId, member.role] as const));
          detail.conversation.isGroupAdmin = group.isAdmin;
          detail.conversation.groupSettings = group.settings;
          if (Array.isArray(detail.other?.members)) {
            detail.other.members = detail.other.members.map((member: { id: string }) => ({
              ...member,
              role: roles.get(member.id) ?? "member",
            }));
          }
        }
        if (detail.other && blockState) {
          detail.other.isBlockedByMe = blockState.isBlockedByMe === true;
          detail.other.isBlockedByOther = blockState.isBlockedByOther === true;
          detail.other.isBlocked = detail.other.isBlockedByMe || detail.other.isBlockedByOther;
          if (detail.other.isBlockedByOther) {
            detail.other.image = null;
            detail.other.about = null;
          }
          if (detail.conversation) {
            detail.conversation.messageRequestStatus = blockState.messageRequestStatus ?? null;
          }
        }
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
        await rpc("chat_assert_send_allowed", { p_conversation_id: conversationId, p_user_id: user.id });
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
        await rpc("chat_assert_send_allowed", { p_conversation_id: conversationId, p_user_id: user.id });
        const mediaPath = typeof body.mediaPath === "string" ? body.mediaPath : "";
        const mediaType = typeof body.mediaType === "string" ? body.mediaType : "";
        const mediaName = typeof body.mediaName === "string" ? body.mediaName : "";
        const caption = typeof body.body === "string" ? body.body : "";
        if (mediaPath.length > 500 || mediaName.length > 255) {
          throw new ChatError("INVALID_MEDIA", 400);
        }
        const message = await rpc(body.viewOnce === true ? "chat_send_media_once" : "chat_send_media", {
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
        let signedViewOnce: { url: string; expiresAt: number } | null = null;
        let allowed = isStatus
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
        let expiresIn = 3600;
        if (!isStatus) {
          const conversationId = validConversationId(body.conversationId);
          const oneTimeMessageId = await rpc("chat_find_view_once_message", {
            p_user_id: user.id,
            p_conversation_id: conversationId,
            p_media_path: mediaPath,
          });
          if (oneTimeMessageId != null) {
            if (body.messageId == null || validMessageId(body.messageId) !== Number(oneTimeMessageId)) {
              allowed = false;
            } else {
              signedViewOnce = await createSignedMediaUrl(mediaPath, 90);
              allowed = await rpc("chat_consume_view_once", {
                p_message_id: Number(oneTimeMessageId),
                p_user_id: user.id,
                p_media_path: mediaPath,
              });
            }
            expiresIn = 90;
          }
        }
        if (!allowed) throw new ChatError("NOT_FOUND", 404);
        return json(signedViewOnce ?? await createSignedMediaUrl(mediaPath, expiresIn));
      }
      case "get-message-draft": {
        const conversationId = validConversationId(body.conversationId);
        const draft = await rpc("chat_get_message_draft", { p_conversation_id: conversationId, p_user_id: user.id });
        if (draft == null) throw new ChatError("NOT_FOUND", 404);
        return json({ draft });
      }
      case "save-message-draft": {
        const conversationId = validConversationId(body.conversationId);
        const draftBody = typeof body.body === "string" ? body.body : "";
        const replyTo = body.replyToId == null ? null : validMessageId(body.replyToId);
        await rpc("chat_set_message_draft", { p_conversation_id: conversationId, p_user_id: user.id, p_body: draftBody, p_reply_to: replyTo });
        return json({ ok: true });
      }
      case "schedule-message": {
        const conversationId = validConversationId(body.conversationId);
        const sendAt = typeof body.sendAt === "string" ? new Date(body.sendAt) : null;
        if (!sendAt || !Number.isFinite(sendAt.getTime())) throw new ChatError("INVALID_SCHEDULE_TIME", 400);
        const scheduled = await rpc("chat_schedule_message", {
          p_user_id: user.id, p_conversation_id: conversationId,
          p_body: typeof body.body === "string" ? body.body : "",
          p_send_at: sendAt.toISOString(), p_reply_to: body.replyToId == null ? null : validMessageId(body.replyToId),
        });
        return json({ scheduled });
      }
      case "list-scheduled-messages": {
        const conversationId = validConversationId(body.conversationId);
        const scheduled = await rpc("chat_list_scheduled_messages", { p_user_id: user.id, p_conversation_id: conversationId });
        return json({ scheduled: Array.isArray(scheduled) ? scheduled : [] });
      }
      case "cancel-scheduled-message": {
        const id = typeof body.id === "string" ? body.id : "";
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ChatError("NOT_FOUND", 404);
        const cancelled = await rpc("chat_cancel_scheduled_message", { p_user_id: user.id, p_id: id });
        return json({ cancelled: cancelled === true });
      }
      case "get-conversation-wallpaper": {
        const conversationId = validConversationId(body.conversationId);
        const wallpaper = await rpc("chat_get_conversation_wallpaper", { p_user_id: user.id, p_conversation_id: conversationId });
        if (wallpaper == null) throw new ChatError("NOT_FOUND", 404);
        return json({ wallpaper });
      }
      case "set-conversation-wallpaper": {
        const conversationId = validConversationId(body.conversationId);
        const wallpaper = typeof body.wallpaper === "string" ? body.wallpaper : "default";
        await rpc("chat_set_conversation_wallpaper", { p_user_id: user.id, p_conversation_id: conversationId, p_wallpaper: wallpaper });
        return json({ wallpaper });
      }
      case "get-privacy-settings": {
        const settings = await rpc("chat_get_privacy_settings", { p_user_id: user.id });
        return json({ settings });
      }
      case "set-privacy-settings": {
        const presenceVisibility = typeof body.presenceVisibility === "string" ? body.presenceVisibility : "contacts";
        const settings = await rpc("chat_set_privacy_settings", { p_user_id: user.id, p_read_receipts: body.readReceipts !== false, p_presence_visibility: presenceVisibility });
        return json({ settings });
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
        const roleUpdate = await serviceRequest(
          `/rest/v1/conversation_members?conversationId=eq.${id}&userId=eq.${encodeURIComponent(user.id)}`,
          {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ role: "admin" }),
          },
        );
        if (!roleUpdate.ok) throw new ChatError("GENERIC", 500);
        await recordGroupMembersAddedByUsername(id, user.id, usernames);
        return json({ id });
      }
      case "manage-group-member": {
        const conversationId = validConversationId(body.conversationId);
        const targetId = validUserId(body.userId);
        const operation = body.operation;
        if (!(["promote", "demote", "remove"] as const).includes(operation as "promote" | "demote" | "remove") || targetId === user.id) {
          throw new ChatError("INVALID_MESSAGE", 400);
        }
        return json(await rpc("chat_manage_group_member", {
          p_actor_id: user.id,
          p_conversation_id: conversationId,
          p_target_id: targetId,
          p_operation: operation,
        }));
      }
      case "set-group-settings": {
        const conversationId = validConversationId(body.conversationId);
        const group = await groupContext(conversationId, user.id);
        const canEditName = group.isAdmin || group.settings.editGroup === "all";
        if (!canEditName) {
          throw new ChatError("GROUP_PERMISSION_DENIED", 403);
        }
        const input = body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
          ? body.settings as Record<string, unknown>
          : {};
        const settings = {
          addMembers: input.addMembers === "all" ? "all" : "admins",
          shareInvite: input.shareInvite === "all" ? "all" : "admins",
          requireApproval: input.requireApproval === true,
          sendMessages: input.sendMessages === "admins" ? "admins" : "all",
          editGroup: input.editGroup === "all" ? "all" : "admins",
        };
        if (!group.isAdmin && (
          settings.addMembers !== group.settings.addMembers ||
          settings.shareInvite !== group.settings.shareInvite ||
          settings.requireApproval !== group.settings.requireApproval ||
          settings.sendMessages !== group.settings.sendMessages ||
          settings.editGroup !== group.settings.editGroup
        )) {
          throw new ChatError("GROUP_PERMISSION_DENIED", 403);
        }
        const name = typeof body.name === "string" ? body.name.trim() : group.conversation.name;
        if (!name || name.length > 50) throw new ChatError("INVALID_GROUP_NAME", 400);
        const update = await serviceRequest(`/rest/v1/conversations?id=eq.${conversationId}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ groupSettings: settings, name }),
        });
        if (!update.ok) throw new ChatError("GENERIC", 500);
        return json({ groupSettings: settings, name });
      }
      case "add-group-members": {
        const conversationId = validConversationId(body.conversationId);
        const group = await groupContext(conversationId, user.id);
        if (!group.isAdmin && group.settings.addMembers !== "all") {
          throw new ChatError("GROUP_PERMISSION_DENIED", 403);
        }
        const usernames = Array.isArray(body.usernames)
          ? [...new Set(body.usernames
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim().replace(/^@/, "").toLowerCase())
              .filter((value) => USERNAME_PATTERN.test(value)))].slice(0, 20)
          : [];
        if (!usernames.length) throw new ChatError("INVALID_USERNAME", 400);
        const profilesResponse = await serviceRequest(
          `/rest/v1/profiles?select=id,username&username=in.(${usernames.join(",")})`,
        );
        if (!profilesResponse.ok) throw new ChatError("GENERIC", 500);
        const profiles = await profilesResponse.json();
        if (profiles.length !== usernames.length) throw new ChatError("USER_NOT_FOUND", 404);
        const targetIds = profiles.map((profile: { id: string }) => profile.id)
          .filter((id: string) => id !== user.id);
        if (!targetIds.length) return json({ added: 0, pending: 0 });
        const existingResponse = await serviceRequest(
          `/rest/v1/conversation_members?select=userId&conversationId=eq.${conversationId}&userId=in.(${targetIds.join(",")})`,
        );
        if (!existingResponse.ok) throw new ChatError("GENERIC", 500);
        const existing = new Set((await existingResponse.json()).map((member: { userId: string }) => member.userId));
        const newIds = targetIds.filter((id: string) => !existing.has(id));
        if (group.settings.requireApproval) await upsertGroupRequests(conversationId, newIds, user.id);
        else {
          await insertGroupMembers(conversationId, newIds);
          await recordGroupMembersAddedNotice(conversationId, user.id, newIds);
        }
        return json({ added: group.settings.requireApproval ? 0 : newIds.length, pending: group.settings.requireApproval ? newIds.length : 0 });
      }
      case "list-group-requests": {
        const conversationId = validConversationId(body.conversationId);
        await requireGroupAdmin(conversationId, user.id);
        const requestsResponse = await serviceRequest(
          `/rest/v1/group_member_requests?select=id,user_id,requested_by,status,created_at&conversation_id=eq.${conversationId}&status=eq.pending&order=created_at.asc`,
        );
        if (!requestsResponse.ok) throw new ChatError("GENERIC", 500);
        const requests = await requestsResponse.json();
        const ids = [...new Set(requests.map((request: { user_id: string }) => request.user_id))];
        const profilesResponse = ids.length
          ? await serviceRequest(`/rest/v1/profiles?select=id,username,name,image&id=in.(${ids.join(",")})`)
          : null;
        if (profilesResponse && !profilesResponse.ok) throw new ChatError("GENERIC", 500);
        const profiles = profilesResponse ? await profilesResponse.json() : [];
        const profilesById = new Map(profiles.map((profile: { id: string }) => [profile.id, profile] as const));
        return json({ requests: requests.map((request: { user_id: string }) => ({ ...request, profile: profilesById.get(request.user_id) ?? null })) });
      }
      case "review-group-request": {
        const conversationId = validConversationId(body.conversationId);
        await requireGroupAdmin(conversationId, user.id);
        const requestId = typeof body.requestId === "string" && /^[0-9a-f-]{36}$/i.test(body.requestId)
          ? body.requestId
          : "";
        const decision = body.decision === "approve" ? "approved" : body.decision === "reject" ? "rejected" : "";
        if (!requestId || !decision) throw new ChatError("NOT_FOUND", 404);
        const requestResponse = await serviceRequest(
          `/rest/v1/group_member_requests?select=id,user_id&conversation_id=eq.${conversationId}&id=eq.${requestId}&status=eq.pending&limit=1`,
        );
        if (!requestResponse.ok) throw new ChatError("GENERIC", 500);
        const requests = await requestResponse.json();
        if (!requests.length) throw new ChatError("NOT_FOUND", 404);
        if (decision === "approved") await insertGroupMembers(conversationId, [requests[0].user_id]);
        const update = await serviceRequest(
          `/rest/v1/group_member_requests?id=eq.${requestId}&conversation_id=eq.${conversationId}&status=eq.pending`,
          {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ status: decision, reviewed_by: user.id, reviewed_at: new Date().toISOString() }),
          },
        );
        if (!update.ok) throw new ChatError("GENERIC", 500);
        if (decision === "approved") {
          await recordGroupMembersAddedNotice(conversationId, user.id, [requests[0].user_id]);
        }
        return json({ ok: true });
      }
      case "create-group-invite": {
        const conversationId = validConversationId(body.conversationId);
        const group = await groupContext(conversationId, user.id);
        if (!group.isAdmin && group.settings.shareInvite !== "all") {
          throw new ChatError("GROUP_PERMISSION_DENIED", 403);
        }
        const bytes = crypto.getRandomValues(new Uint8Array(24));
        const token = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const response = await serviceRequest("/rest/v1/group_invites", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ token, conversation_id: conversationId, created_by: user.id, expires_at: expiresAt }),
        });
        if (!response.ok) throw new ChatError("GENERIC", 500);
        return json({ token, expiresAt });
      }
      case "join-group-invite": {
        const token = typeof body.token === "string" && /^[a-f0-9]{48}$/.test(body.token) ? body.token : "";
        if (!token) throw new ChatError("INVALID_GROUP_INVITE", 404);
        const inviteResponse = await serviceRequest(
          `/rest/v1/group_invites?select=conversation_id&token=eq.${token}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
        );
        if (!inviteResponse.ok) throw new ChatError("GENERIC", 500);
        const invites = await inviteResponse.json();
        if (!invites.length) throw new ChatError("INVALID_GROUP_INVITE", 404);
        const conversationId = Number(invites[0].conversation_id);
        const group = await groupContextForInvite(conversationId);
        const existingResponse = await serviceRequest(
          `/rest/v1/conversation_members?select=userId&conversationId=eq.${conversationId}&userId=eq.${encodeURIComponent(user.id)}&limit=1`,
        );
        if (!existingResponse.ok) throw new ChatError("GENERIC", 500);
        if ((await existingResponse.json()).length) return json({ id: conversationId, status: "member" });
        if (group.settings.requireApproval) {
          await upsertGroupRequests(conversationId, [user.id], user.id);
          return json({ id: conversationId, status: "pending" });
        }
        await insertGroupMembers(conversationId, [user.id]);
        return json({ id: conversationId, status: "member" });
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
        await rpc("chat_assert_send_allowed", { p_conversation_id: conversationId, p_user_id: user.id });
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
      case "edit-message": {
        const messageId = validMessageId(body.messageId);
        if (typeof body.body !== "string") throw new ChatError("EMPTY_MESSAGE", 400);
        await rpc("chat_edit_message", { p_user_id: user.id, p_message_id: messageId, p_body: body.body });
        return json({ ok: true });
      }
      case "set-message-reaction": {
        const messageId = validMessageId(body.messageId);
        const emoji = body.emoji == null ? null : String(body.emoji);
        await rpc("chat_set_message_reaction", { p_user_id: user.id, p_message_id: messageId, p_emoji: emoji });
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
        const targetConversationId = validConversationId(body.targetConversationId);
        const sourceMessageId = validMessageId(body.messageId);
        if (await rpc("chat_is_view_once_message", { p_user_id: user.id, p_message_id: sourceMessageId })) {
          throw new ChatError("INVALID_MEDIA", 400);
        }
        await rpc("chat_assert_send_allowed", { p_conversation_id: targetConversationId, p_user_id: user.id });
        const message = await rpc("chat_forward_message", {
          p_user_id: user.id,
          p_message_id: sourceMessageId,
          p_target_conversation_id: targetConversationId,
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
    if (error instanceof ChatError) return json({ error: error.code, ...error.details }, error.status);
    console.error("handle-chat failed:", error);
    return json({ error: "GENERIC" }, 500);
  }
}

Deno.serve(handle);

