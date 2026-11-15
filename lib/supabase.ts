import { normalizeUsername, placeholderEmail } from './username'

export const SUPABASE_URL = 'https://uzzjkfriikqsoxjlzjbe.supabase.co'
export const SUPABASE_PUBLISHABLE_KEY =
  'sb_publishable_6g-JJIZlZRYHNhlNXE9eMA_Ohx9Eksu'

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/handle-chat`
const SESSION_KEY = 'handle.supabase.session.v1'
const MAX_MEDIA_SIZE = 50 * 1024 * 1024
const MAX_AVATAR_SIZE = 5 * 1024 * 1024

const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}

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

function encodeObjectPath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/')
}

function uploadExtension(file: File, allowedTypes: string[]) {
  if (!allowedTypes.includes(file.type)) {
    throw new SupabaseError('INVALID_MEDIA', 400)
  }
  return MEDIA_EXTENSIONS[file.type]
}

function tusEndpoint() {
  const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
  return `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`
}

function base64Metadata(value: string) {
  return btoa(value)
}

async function uploadTusFile(file: File, path: string, session: Session) {
  const metadata = [
    `bucketName ${base64Metadata('chat-media')}`,
    `objectName ${base64Metadata(path)}`,
    `contentType ${base64Metadata(file.type)}`,
    `cacheControl ${base64Metadata('3600')}`,
  ].join(',')
  const created = await fetch(tusEndpoint(), {
    method: 'POST',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(file.size),
      'Upload-Metadata': metadata,
    },
  })
  if (!created.ok) {
    throw new SupabaseError(
      created.status === 413 ? 'MEDIA_TOO_LARGE' : 'UPLOAD_FAILED',
      created.status,
    )
  }

  const location = created.headers.get('Location')
  if (!location) throw new SupabaseError('UPLOAD_FAILED', 500)
  const uploadUrl = new URL(location, tusEndpoint()).toString()
  let offset = Number(created.headers.get('Upload-Offset') ?? 0)

  while (offset < file.size) {
    const chunkEnd = Math.min(offset + 6 * 1024 * 1024, file.size)
    const response = await fetch(uploadUrl, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${session.access_token}`,
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
      },
      body: file.slice(offset, chunkEnd),
    })
    if (!response.ok) {
      throw new SupabaseError(
        response.status === 413 ? 'MEDIA_TOO_LARGE' : 'UPLOAD_FAILED',
        response.status,
      )
    }
    const nextOffset = Number(response.headers.get('Upload-Offset'))
    if (!Number.isFinite(nextOffset) || nextOffset <= offset) {
      throw new SupabaseError('UPLOAD_FAILED', 500)
    }
    offset = nextOffset
  }
}

async function deleteStorageObject(
  bucket: string,
  path: string,
  session: Session,
) {
  try {
    await fetch(
      `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeObjectPath(path)}`,
      {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
      },
    )
  } catch {
    // A failed cleanup does not change the message/profile request result.
  }
}

export async function sendChatMedia<T>(
  conversationId: number,
  file: File,
  body: string,
): Promise<T> {
  if (file.size > MAX_MEDIA_SIZE) {
    throw new SupabaseError('MEDIA_TOO_LARGE', 413)
  }
  const extension = uploadExtension(file, Object.keys(MEDIA_EXTENSIONS))
  const session = await getSession()
  if (!session) throw new SupabaseError('UNAUTHORIZED', 401)

  const mediaPath = `${conversationId}/${session.user.id}/${crypto.randomUUID()}.${extension}`
  await uploadTusFile(file, mediaPath, session)
  try {
    const result = await edgeRequest<{ message: T }>({
      action: 'send-media',
      conversationId,
      body,
      mediaPath,
      mediaType: file.type,
      mediaName: file.name.slice(0, 255),
    })
    return result.message
  } catch (error) {
    await deleteStorageObject('chat-media', mediaPath, session)
    throw error
  }
}

export async function uploadAvatar(file: File, userId: string) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new SupabaseError('INVALID_IMAGE', 400)
  }
  if (file.size > MAX_AVATAR_SIZE) {
    throw new SupabaseError('IMAGE_TOO_LARGE', 413)
  }
  const session = await getSession()
  if (!session || session.user.id !== userId) {
    throw new SupabaseError('UNAUTHORIZED', 401)
  }

  const extension = MEDIA_EXTENSIONS[file.type]
  const path = `${userId}/${crypto.randomUUID()}.${extension}`
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/avatars/${encodeObjectPath(path)}`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': file.type,
        'cache-control': '3600',
        'x-upsert': 'false',
      },
      body: file,
    },
  )
  if (!response.ok) {
    throw new SupabaseError(
      response.status === 413 ? 'IMAGE_TOO_LARGE' : 'UPLOAD_FAILED',
      response.status,
    )
  }
  return path
}

export async function uploadStatusMedia(file: File, userId: string) {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'].includes(file.type)) {
    throw new SupabaseError('INVALID_MEDIA', 400)
  }
  if (file.size > MAX_MEDIA_SIZE) throw new SupabaseError('MEDIA_TOO_LARGE', 413)
  const session = await getSession()
  if (!session || session.user.id !== userId) throw new SupabaseError('UNAUTHORIZED', 401)
  const path = `status/${userId}/${crypto.randomUUID()}.${MEDIA_EXTENSIONS[file.type]}`
  await uploadTusFile(file, path, session)
  return path
}

export async function chatRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const requestUrl = new URL(path, window.location.origin)
  const method = init?.method?.toUpperCase() ?? 'GET'
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
  let payload: Record<string, unknown>

  if (requestUrl.pathname === '/api/statuses') {
    payload = { action: 'list-statuses' }
  } else if (requestUrl.pathname === '/api/conversations') {
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

