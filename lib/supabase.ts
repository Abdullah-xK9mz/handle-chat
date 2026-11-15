import { normalizeUsername, placeholderEmail } from './username'

export const SUPABASE_URL = 'https://uzzjkfriikqsoxjlzjbe.supabase.co'
export const SUPABASE_PUBLISHABLE_KEY =
  'sb_publishable_6g-JJIZlZRYHNhlNXE9eMA_Ohx9Eksu'

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/handle-chat`
const SESSION_KEY = 'handle.supabase.session.v1'

export type Profile = {
  id: string
  name: string
  username: string
  image: string | null
}

type Session = {
  access_token: string
  refresh_token: string
  expires_at: number
  user: {
    id: string
    user_metadata?: { username?: string; name?: string }
  }
}

export class SupabaseError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code)
  }
}

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const session = JSON.parse(raw) as Partial<Session>
    if (
      typeof session.access_token !== 'string' ||
      typeof session.refresh_token !== 'string' ||
      !session.user?.id
    ) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }
    return {
      ...session,
      expires_at:
        typeof session.expires_at === 'number'
          ? session.expires_at
          : Math.floor(Date.now() / 1000) + 3600,
    } as Session
  } catch {
    localStorage.removeItem(SESSION_KEY)
    return null
  }
}

function saveSession(session: Omit<Session, 'expires_at'> & { expires_at?: number; expires_in?: number }) {
  const expiresAt =
    session.expires_at ??
    Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600)
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ ...session, expires_at: expiresAt }),
  )
}

let refreshInFlight: Promise<Session | null> | null = null

async function refreshSession(session: Session): Promise<Session | null> {
  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    },
  )
  if (!response.ok) {
    localStorage.removeItem(SESSION_KEY)
    return null
  }
  const renewed = await response.json()
  saveSession(renewed)
  return readSession()
}

export async function getSession(): Promise<Session | null> {
  const session = readSession()
  if (!session) return null
  if (session.expires_at > Math.floor(Date.now() / 1000) + 60) return session

  if (!refreshInFlight) {
    refreshInFlight = refreshSession(session).finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

async function passwordSignIn(username: string, password: string) {
  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: placeholderEmail(normalizeUsername(username)),
        password,
      }),
    },
  )
  const result = await response.json().catch(() => null)
  if (!response.ok) throw new SupabaseError('INVALID_CREDENTIALS', response.status)
  saveSession(result)
}

export async function signInWithUsername(username: string, password: string) {
  await passwordSignIn(username, password)
}

export async function createAccount(
  username: string,
  name: string,
  password: string,
) {
  const response = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'sign-up',
      username: normalizeUsername(username),
      name,
      password,
    }),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    throw new SupabaseError(result?.error ?? 'SIGN_UP_FAILED', response.status)
  }
  await passwordSignIn(username, password)
}

export async function signOut() {
  const session = await getSession()
  try {
    if (session) {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
      })
    }
  } catch {
    // Sign out locally even when the network is unavailable.
  } finally {
    localStorage.removeItem(SESSION_KEY)
  }
}

export async function edgeRequest<T>(payload: Record<string, unknown>): Promise<T> {
  const session = payload.action === 'sign-up' ? null : await getSession()
  if (payload.action !== 'sign-up' && !session) {
    throw new SupabaseError('UNAUTHORIZED', 401)
  }

  const headers: Record<string, string> = {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    'Content-Type': 'application/json',
  }
  if (session) headers.Authorization = `Bearer ${session.access_token}`

  const response = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    throw new SupabaseError(result?.error ?? 'GENERIC', response.status)
  }
  return result as T
}

export async function chatRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const requestUrl = new URL(path, window.location.origin)
  const method = init?.method?.toUpperCase() ?? 'GET'
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
  let payload: Record<string, unknown>

  if (requestUrl.pathname === '/api/conversations') {
    payload =
      method === 'POST'
        ? { action: 'start-conversation', username: body.username }
        : { action: 'list-conversations' }
  } else if (requestUrl.pathname === '/api/users') {
    payload = {
      action: 'search-users',
      query: requestUrl.searchParams.get('q') ?? '',
    }
  } else {
    const match = requestUrl.pathname.match(
      /^\/api\/conversations\/(\d+)\/messages$/,
    )
    if (!match) throw new SupabaseError('NOT_FOUND', 404)
    payload =
      method === 'POST'
        ? {
            action: 'send-message',
            conversationId: Number(match[1]),
            body: body.body,
          }
        : {
            action: 'get-messages',
            conversationId: Number(match[1]),
          }
  }

  return edgeRequest<T>(payload)
}
