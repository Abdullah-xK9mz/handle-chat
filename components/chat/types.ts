import { chatRequest, SupabaseError } from '@/lib/supabase'

export type CurrentUser = {
  id: string
  name: string
  username: string
  image: string | null
  about?: string
  isAdmin?: boolean
}

export type ConversationSummary = {
  id: number
  lastMessageAt: string
  isGroup: boolean
  groupName: string | null
  participantCount: number
  otherUserId: string
  otherUsername: string | null
  otherName: string
  otherImage: string | null
  lastBody: string | null
  lastMediaType: string | null
  lastMessageType: string | null
  lastSenderId: string | null
  unreadCount: number
  isMuted: boolean
}

export type ChatMessage = {
  id: number
  senderId: string
  body: string
  createdAt: string
  mediaPath?: string | null
  mediaType?: string | null
  mediaName?: string | null
  messageType?: string
  payload?: Record<string, unknown>
  pending?: boolean
  deletedAt?: string | null
  replyTo?: number | null
  replyBody?: string | null
  replyDeleted?: boolean
  replySenderName?: string | null
  forwardedFrom?: number | null
  starredByMe?: boolean
  pinned?: boolean
}

export type ConversationDetail = {
  other: {
    username: string | null
    name: string
    image: string | null
    about?: string
    isGroup?: boolean
    participantCount?: number
    members?: Array<{ id: string; name: string; username: string; image: string | null }>
    isBlockedByMe?: boolean
    isBlocked?: boolean
  } | null
  conversation?: {
    id: number
    isGroup: boolean
    name: string | null
    participantCount: number
    isMuted: boolean
  }
  otherLastReadAt: string | null
  otherLastDeliveredAt?: string | null
  pinnedMessage?: { id: number; body: string; deleted: boolean; senderId: string } | null
  messages: ChatMessage[]
}

export type StatusEntry = {
  id: string
  userId: string
  name: string
  username: string
  image: string | null
  body: string
  mediaPath: string | null
  mediaType: string | null
  mediaName: string | null
  createdAt: string
  expiresAt: string
}

export class ApiError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

export async function fetcher<T>(url: string): Promise<T> {
  try {
    return await chatRequest<T>(url, { cache: 'no-store' })
  } catch (error) {
    if (error instanceof SupabaseError) {
      throw new ApiError(error.code)
    }
    throw new ApiError('GENERIC')
  }
}

export function formatListTime(iso: string, locale: string) {
  const date = new Date(iso)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(locale, {
      hour: 'numeric',
      minute: '2-digit',
    })
  }
  const diffDays = (now.getTime() - date.getTime()) / 86_400_000
  if (diffDays < 7) {
    return date.toLocaleDateString(locale, { weekday: 'short' })
  }
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

export function formatMessageTime(iso: string, locale: string) {
  return new Date(iso).toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatDayLabel(
  iso: string,
  locale: string,
  labels: { today: string; yesterday: string },
) {
  const date = new Date(iso)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === now.toDateString()) return labels.today
  if (date.toDateString() === yesterday.toDateString()) return labels.yesterday
  return date.toLocaleDateString(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

