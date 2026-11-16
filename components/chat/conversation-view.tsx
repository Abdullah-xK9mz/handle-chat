'use client'

import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react'
import useSWR from 'swr'
import {
  ArrowLeft,
  Ban,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  Clock,
  Copy,
  Forward,
  MoreHorizontal,
  Pin,
  Reply,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errorMessage } from '@/lib/i18n/dictionaries'
import { chatRequest, edgeRequest, sendChatMedia } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { MessageComposer } from './message-composer'
import {
  ApiError,
  fetcher,
  formatDayLabel,
  formatMessageTime,
  type ChatMessage,
  type ConversationDetail,
  type ConversationSummary,
} from './types'
import { UserAvatar } from './user-avatar'

type ConversationViewProps = {
  conversationId: number
  currentUserId: string
  isAdmin?: boolean
  otherUserId?: string
  fallbackName?: string
  fallbackUsername?: string
  fallbackImage?: string
  onBack: () => void
  onActivity: () => void
  availableConversations: ConversationSummary[]
}

export function ConversationView({
  conversationId,
  currentUserId,
  isAdmin = false,
  otherUserId,
  fallbackName,
  fallbackUsername,
  fallbackImage,
  onBack,
  onActivity,
  availableConversations,
}: ConversationViewProps) {
  const { t, locale } = useI18n()
  const key = `/api/conversations/${conversationId}/messages`
  const { data, error, mutate } = useSWR<ConversationDetail>(key, fetcher, {
    refreshInterval: 2000,
  })
  const [sendError, setSendError] = useState<string | null>(null)
  const [mediaUrls, setMediaUrls] = useState<Record<string, { url: string; expiresAt: number }>>({})
  const [imageModal, setImageModal] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ id: number; body: string; createdAt: string }>>([])
  const [searching, setSearching] = useState(false)
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [forwarding, setForwarding] = useState<ChatMessage | null>(null)
  const [forwardTargetId, setForwardTargetId] = useState<number | ''>('')
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [openMessageActions, setOpenMessageActions] = useState<number | null>(null)
  const [messageMenuAbove, setMessageMenuAbove] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const loadingMediaRef = useRef(new Set<string>())
  const holdTimer = useRef<number | null>(null)
  const longPressTriggered = useRef(false)

  const messages = data?.messages ?? []
  const lastId = messages.at(-1)?.id
  const name =
    data?.other?.name ?? fallbackName ?? t.chat.conversationFallback
  const username = data?.other?.username ?? fallbackUsername
  const image = data?.other?.image ?? fallbackImage
  const isGroup = data?.other?.isGroup ?? false
  const isBlocked = data?.other?.isBlocked ?? false
  const isBlockedByMe = data?.other?.isBlockedByMe ?? false
  const isMuted = data?.conversation?.isMuted ?? false
  const otherReadAt = data?.otherLastReadAt
    ? new Date(data.otherLastReadAt).getTime()
    : 0
  const otherDeliveredAt = data?.otherLastDeliveredAt
    ? new Date(data.otherLastDeliveredAt).getTime()
    : 0

  function startMessageHold(id: number) {
    longPressTriggered.current = false
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    holdTimer.current = window.setTimeout(() => {
      longPressTriggered.current = true
      showMessageActions(id)
    }, 500)
  }

  function showMessageActions(id: number) {
    const rect = document.getElementById(`message-${id}`)?.getBoundingClientRect()
    setMessageMenuAbove(Boolean(rect && rect.bottom > window.innerHeight - 280))
    setOpenMessageActions(id)
  }

  function clearMessageHold() {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    holdTimer.current = null
  }

  function setReply(message: ChatMessage) {
    if (message.deletedAt) return
    setReplyTo({ ...message, replySenderName: message.senderId === currentUserId ? t.chat.youPrefix.trim() : name })
    document.getElementById('message')?.focus()
  }

  async function copyMessage(message: ChatMessage) {
    const payload = message.payload ?? {}
    const text = message.body || message.mediaName || (Object.keys(payload).length ? JSON.stringify(payload) : '')
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setActionNotice(t.chat.copiedMessage)
    } catch {
      setSendError(t.errors.GENERIC)
    }
  }

  async function runMessageAction(action: 'delete' | 'star' | 'pin', message: ChatMessage) {
    setSendError(null)
    try {
      if (action === 'delete') await edgeRequest({ action: 'delete-message', messageId: message.id })
      else if (action === 'star') await edgeRequest({ action: 'star-message', messageId: message.id, starred: !message.starredByMe })
      else await edgeRequest({ action: 'pin-message', messageId: message.id, pinned: !message.pinned })
      await mutate()
      onActivity()
    } catch {
      setSendError(t.errors.GENERIC)
    }
  }

  async function forwardMessage() {
    if (!forwarding || !forwardTargetId) return
    try {
      await edgeRequest({ action: 'forward-message', messageId: forwarding.id, targetConversationId: forwardTargetId })
      setForwarding(null)
      setForwardTargetId('')
      setActionNotice(t.chat.forwarded)
      onActivity()
    } catch {
      setSendError(t.errors.GENERIC)
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [lastId])

  useEffect(() => {
    for (const mediaPath of new Set(
      messages
        .map((message) => message.mediaPath)
        .filter((path): path is string => Boolean(path)),
    )) {
      const cached = mediaUrls[mediaPath]
      if (
        (cached && cached.expiresAt > Math.floor(Date.now() / 1000) + 300) ||
        loadingMediaRef.current.has(mediaPath)
      ) {
        continue
      }
      loadingMediaRef.current.add(mediaPath)
      edgeRequest<{ url: string; expiresAt: number }>({
        action: 'get-media-url',
        conversationId,
        mediaPath,
      })
        .then((result) => {
          setMediaUrls((current) => ({ ...current, [mediaPath]: result }))
        })
        .catch(() => undefined)
        .finally(() => loadingMediaRef.current.delete(mediaPath))
    }
  }, [conversationId, mediaUrls, messages])

  async function handleSend(body: string, file: File | null, replyToId?: number) {
    setSendError(null)
    const optimistic: ChatMessage = {
      id: -Date.now(),
      senderId: currentUserId,
      body,
      createdAt: new Date().toISOString(),
      mediaType: file?.type ?? null,
      mediaName: file?.name ?? null,
      pending: true,
      replyTo: replyToId ?? null,
      replyBody: replyTo?.body ?? null,
      replySenderName: replyTo?.senderId === currentUserId ? t.chat.youPrefix.trim() : name,
    }

    try {
      await mutate(
        async (current) => {
          const message = file
            ? await sendChatMedia<ChatMessage>(conversationId, file, body, replyToId)
            : (
                await chatRequest<{ message: ChatMessage }>(key, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ body, replyToId: replyToId ?? null }),
                })
              ).message
          const base = current ?? {
            other: null,
            otherLastReadAt: null,
            otherLastDeliveredAt: null,
            messages: [],
          }
          return { ...base, messages: [...base.messages, message] }
        },
        {
          optimisticData: (current) => ({
          