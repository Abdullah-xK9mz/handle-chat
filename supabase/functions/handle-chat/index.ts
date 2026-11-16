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
      "ADMIN_REQUIRED",
      "INVALID_USERNAME",
      "NAME_REQUIRED",
      "NAME_TOO_LONG",
      "ABOUT_TOO_LONG",
      "NOT_FOUND",
    ].find((code) => searchable.includes(code));
    if (known) {
      throw new ChatError(
        known,
        known === "NOT_FOUND" || known === "USER_NOT_FOUND"
          ? 404
          : known === "ADMIN_REQUIRED"
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

async function requireAdmin(userId: string) {
  const response = await serviceRequest(
    `/rest/v1/pro