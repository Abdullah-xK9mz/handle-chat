import { chatRequest, SupabaseError } from '@/lib/supabase'

export type CurrentUser = {
  id: string
  name: string
  username: string
  image: string | null
}

export type ConversationSummary = {
  id: number
  lastMessageAt: string
  otherUserId: string
  otherUsername: string | null
  otherName: string
  otherImage: string | null
  lastBody: string | null
  lastSenderId: string | null
  unreadCount: number
}

export type ChatMessage = {
  id: number
  senderId: string
  body: string
  createdAt: string
  pending?: boolean
}

export type ConversationDetail = {
  other: { username: string | null; name: string; image: string | null } | null
  otherLastReadAt: string | null
  messages: ChatMessage[]
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

