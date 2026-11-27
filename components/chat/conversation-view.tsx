'use client'

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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
  Download,
  Forward,
  Flag,
  FileAudio,
  FileText,
  Image as ImageIcon,
  Link2,
  MoreHorizontal,
  Pencil,
  Pin,
  Reply,
  Search,
  Share2,
  ShieldCheck,
  Star,
  Trash2,
  UserRoundPlus,
  Users,
  X,
  Video,
} from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errorMessage } from '@/lib/i18n/dictionaries'
import { closeChatPage, pushChatPage } from '@/lib/chat-pages'
import { chatRequest, edgeRequest, sendChatMedia } from '@/lib/supabase'
import { setLocalContactName } from '@/lib/local-contact-names'
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
  type GroupSettings,
} from './types'
import { UserAvatar } from './user-avatar'

const DEFAULT_GROUP_SETTINGS: GroupSettings = {
  addMembers: 'admins',
  shareInvite: 'admins',
  requireApproval: false,
  sendMessages: 'all',
  editGroup: 'admins',
}

const MESSAGE_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏'] as const

function renderMessageText(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  const pattern = /(?:https?:\/\/|www\.)[^\s<>"']+/gi
  let cursor = 0

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    const raw = match[0]
    const trailing = raw.match(/[.,!?;:)\]}]+$/)?.[0] ?? ''
    const visibleUrl = raw.slice(0, raw.length - trailing.length)
    if (!visibleUrl) continue

    if (start > cursor) parts.push(text.slice(cursor, start))
    const candidate = visibleUrl.startsWith('www.') ? `https://${visibleUrl}` : visibleUrl
    let href: string | null = null
    try {
      const parsed = new URL(candidate)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') href = parsed.href
    } catch {
      href = null
    }

    if (href) {
      parts.push(
        <a
          key={`message-link-${start}`}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-primary underline underline-offset-2 hover:opacity-80"
          dir="ltr"
        >
          {visibleUrl}
        </a>,
      )
      cursor = start + visibleUrl.length
    } else {
      parts.push(raw)
      cursor = start + raw.length
    }
  }

  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

type ConversationViewProps = {
  conversationId: number
  currentUserId: string
  isAdmin?: boolean
  otherUserId?: string
  fallbackName?: string
  displayNameOverride?: string
  fallbackUsername?: string
  fallbackImage?: string
  fallbackBlockedByOther?: boolean
  onBack: () => void
  onActivity: () => void
  onOpenConversation: (id: number) => void
  availableConversations: ConversationSummary[]
}

export function ConversationView({
  conversationId,
  currentUserId,
  isAdmin = false,
  otherUserId,
  fallbackName,
  displayNameOverride,
  fallbackUsername,
  fallbackImage,
  fallbackBlockedByOther = false,
  onBack,
  onActivity,
  onOpenConversation,
  availableConversations,
}: ConversationViewProps) {
  const { t, locale } = useI18n()
  const key = `/api/conversations/${conversationId}/messages`
  const { data, error, mutate } = useSWR<ConversationDetail>(key, fetcher, {
    refreshInterval: 30_000,
  })
  const [sendError, setSendError] = useState<string | null>(null)
  const [mediaUrls, setMediaUrls] = useState<Record<string, { url: string; expiresAt: number }>>({})
  const [imageModal, setImageModal] = useState<string | null>(null)
  const [mediaViewer, setMediaViewer] = useState<{ url: string; type: 'image' | 'video' | 'audio' } | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [editingContactName, setEditingContactName] = useState(false)
  const [contactNameDraft, setContactNameDraft] = useState(displayNameOverride ?? '')
  const [newGroupName, setNewGroupName] = useState('')
  const [creatingContactGroup, setCreatingContactGroup] = useState(false)
  const [existingGroupId, setExistingGroupId] = useState<number | ''>('')
  const [groupNameDraft, setGroupNameDraft] = useState('')
  const [groupSettingsDraft, setGroupSettingsDraft] = useState<GroupSettings>(DEFAULT_GROUP_SETTINGS)
  const [savingGroupSettings, setSavingGroupSettings] = useState(false)
  const [groupMemberDraft, setGroupMemberDraft] = useState('')
  const [groupMemberMenuId, setGroupMemberMenuId] = useState<string | null>(null)
  const [groupMemberBusy, setGroupMemberBusy] = useState<string | null>(null)
  const [groupRequests, setGroupRequests] = useState<Array<{ id: string; profile: { id: string; name: string; username: string; image: string | null } | null }>>([])
  const [groupInviteBusy, setGroupInviteBusy] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ id: number; body: string; createdAt: string }>>([])
  const [searching, setSearching] = useState(false)
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null)
  const [editedBody, setEditedBody] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [savingExpiry, setSavingExpiry] = useState(false)
  const [exportingConversation, setExportingConversation] = useState(false)
  const [forwarding, setForwarding] = useState<ChatMessage | null>(null)
  const [bulkForwardIds, setBulkForwardIds] = useState<number[]>([])
  const [forwardTargetId, setForwardTargetId] = useState<number | ''>('')
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<number>>(() => new Set())
  const [scheduledMessages, setScheduledMessages] = useState<Array<{ id: string; body: string; sendAt: string; status: 'pending' | 'failed'; replyTo: number | null }>>([])
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false)
  const [openMessageActions, setOpenMessageActions] = useState<number | null>(null)
  const [messageActionAnchor, setMessageActionAnchor] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null)
  const [messageActionPosition, setMessageActionPosition] = useState<{ top: number; left: number } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const messageActionMenuRef = useRef<HTMLDivElement>(null)
  const loadingMediaRef = useRef(new Set<string>())
  const holdTimer = useRef<number | null>(null)
  const pendingDraftReply = useRef<number | null>(null)

  useEffect(() => {
    const restorePage = (state: unknown) => {
      const historyState = state && typeof state === 'object'
        ? state as { handleChatPage?: string; handleChatParentPage?: string | null }
        : {}
      const page = historyState.handleChatPage
      const parent = historyState.handleChatParentPage
      setInfoOpen(page === 'conversation-details' || ((page === 'profile-photo' || page === 'media-viewer') && parent === 'conversation-details'))
      if (page !== 'profile-photo') setImageModal(null)
      if (page !== 'media-viewer') setMediaViewer(null)
      if (page !== 'forward-message') setForwarding(null)
    }
    restorePage(window.history.state)
    const handlePageBack = (event: PopStateEvent) => restorePage(event.state)
    window.addEventListener('popstate', handlePageBack)
    return () => window.removeEventListener('popstate', handlePageBack)
  }, [])

  const messages = data?.messages ?? []
  useEffect(() => {
    setSelectedMessageIds(new Set())
    setReplyTo(null)
    pendingDraftReply.current = null
  }, [conversationId])
  useEffect(() => {
    const id = pendingDraftReply.current
    if (id == null) return
    const restored = messages.find((message) => message.id === id)
    if (restored) {
      setReplyTo(restored)
      pendingDraftReply.current = null
    }
  }, [messages])
  useEffect(() => {
    let current = true
    void edgeRequest<{ scheduled: typeof scheduledMessages }>({ action: 'list-scheduled-messages', conversationId })
      .then((result) => { if (current) setScheduledMessages(result.scheduled) })
      .catch(() => { if (current) setScheduledMessages([]) })
    return () => { current = false }
  }, [conversationId, data?.messages.length])
  useEffect(() => {
    const viewedPaths = new Set(messages.filter((message) => message.viewOnce && message.viewed).flatMap((message) => [message.mediaPath, message.viewedMediaPath]).filter((path): path is string => Boolean(path)))
    if (viewedPaths.size) setMediaUrls((current) => Object.fromEntries(Object.entries(current).filter(([path]) => !viewedPaths.has(path))))
  }, [messages])
  const lastId = messages.at(-1)?.id
  const profileName = data?.other?.name ?? fallbackName ?? t.chat.conversationFallback
  const name = !data?.other?.isGroup
    ? displayNameOverride || profileName
    : profileName
  const username = data?.other?.username ?? fallbackUsername
  const isBlockedByMe = data?.other?.isBlockedByMe ?? false
  const isBlockedByOther = data?.other?.isBlockedByOther ?? fallbackBlockedByOther
  const image = isBlockedByOther ? null : data?.other ? data.other.image : fallbackImage
  const isGroup = data?.other?.isGroup ?? false
  const isGroupAdmin = data?.conversation?.isGroupAdmin ?? false
  const isBlocked = data?.other?.isBlocked ?? (isBlockedByMe || isBlockedByOther)
  const isMuted = data?.conversation?.isMuted ?? false
  const messageRequestStatus = data?.conversation?.messageRequestStatus

  useEffect(() => {
    if (!infoOpen) return
    setGroupSettingsDraft(data?.conversation?.groupSettings ?? DEFAULT_GROUP_SETTINGS)
    setGroupNameDraft(data?.conversation?.name ?? '')
  }, [infoOpen, data?.conversation?.id])

  const refreshGroupRequests = useCallback(async () => {
    try {
      const result = await edgeRequest<{ requests: typeof groupRequests }>({ action: 'list-group-requests', conversationId })
      setGroupRequests(result.requests)
    } catch {
      setGroupRequests([])
    }
  }, [conversationId])

  useEffect(() => {
    if (!infoOpen || !isGroup || !isGroupAdmin) return
    void refreshGroupRequests()
  }, [infoOpen, isGroup, isGroupAdmin, refreshGroupRequests])

  useEffect(() => {
    const handleChatUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: number }>).detail
      if (detail?.conversationId === conversationId) {
        void mutate()
        if (infoOpen && isGroup && isGroupAdmin) void refreshGroupRequests()
      }
    }
    const handleAccountUpdated = () => { void mutate() }
    window.addEventListener('handle-chat-updated', handleChatUpdated)
    window.addEventListener('handle-chat-account-updated', handleAccountUpdated)
    return () => {
      window.removeEventListener('handle-chat-updated', handleChatUpdated)
      window.removeEventListener('handle-chat-account-updated', handleAccountUpdated)
    }
  }, [conversationId, infoOpen, isGroup, isGroupAdmin, mutate, refreshGroupRequests])

  const otherReadAt = data?.otherLastReadAt
    ? new Date(data.otherLastReadAt).getTime()
    : 0
  const otherDeliveredAt = data?.otherLastDeliveredAt
    ? new Date(data.otherLastDeliveredAt).getTime()
    : 0

  function startMessageHold(id: number) {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    holdTimer.current = window.setTimeout(() => {
      showMessageActions(id)
    }, 500)
  }

  function showMessageActions(id: number) {
    const messageElement = document.getElementById(`message-${id}`)
    const bubbleElement = messageElement?.querySelector<HTMLElement>('[data-message-bubble]')
    if (!bubbleElement) return
    const rect = bubbleElement.getBoundingClientRect()
    setMessageActionAnchor({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right })
    setMessageActionPosition({
      top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 240)),
      left: Math.max(12, Math.min(document.documentElement.dir === 'rtl' ? rect.right - 208 : rect.left, window.innerWidth - 220)),
    })
    setOpenMessageActions(id)
  }

  useLayoutEffect(() => {
    if (openMessageActions === null || !messageActionAnchor || !messageActionMenuRef.current) return
    const menu = messageActionMenuRef.current.getBoundingClientRect()
    const padding = 12
    const gap = 8
    let left = document.documentElement.dir === 'rtl'
      ? messageActionAnchor.right - menu.width
      : messageActionAnchor.left
    left = Math.max(padding, Math.min(left, window.innerWidth - menu.width - padding))

    let top = messageActionAnchor.bottom + gap
    if (top + menu.height > window.innerHeight - padding && messageActionAnchor.top - menu.height - gap >= padding) {
      top = messageActionAnchor.top - menu.height - gap
    } else {
      top = Math.max(padding, Math.min(top, window.innerHeight - menu.height - padding))
    }

    setMessageActionPosition((current) =>
      current && Math.abs(current.top - top) < 1 && Math.abs(current.left - left) < 1
        ? current
        : { top, left },
    )
  }, [openMessageActions, messageActionAnchor])

  function clearMessageHold() {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    holdTimer.current = null
  }

  function setReply(message: ChatMessage) {
    if (message.deletedAt) return
    setReplyTo({ ...message, replySenderName: message.senderId === currentUserId ? t.chat.youPrefix.trim() : name })
    document.getElementById('message')?.focus()
  }

  function openConversationInfo() {
    setProfileMenuOpen(false)
    setInfoOpen(true)
    pushChatPage('conversation-details')
  }

  function openProfilePhoto(url: string | null | undefined) {
    if (!url) return
    setImageModal(url)
    pushChatPage('profile-photo')
  }

  function openSharedMedia(url: string, type: 'image' | 'video' | 'audio') {
    setMediaViewer({ url, type })
    pushChatPage('media-viewer')
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

  async function saveMessageEdit(message: ChatMessage) {
    const body = editedBody.trim()
    if (!body || savingEdit) return
    setSavingEdit(true)
    try {
      await edgeRequest({ action: 'edit-message', messageId: message.id, body })
      setEditingMessageId(null)
      setEditedBody('')
      await mutate()
      onActivity()
    } catch (caught) {
      const code = typeof caught === 'object' && caught && 'code' in caught ? String(caught.code) : 'GENERIC'
      setSendError(errorMessage(t, code))
    } finally {
      setSavingEdit(false)
    }
  }

  async function setMessageReaction(message: ChatMessage, emoji: string) {
    const current = message.reactions?.find((reaction) => reaction.reactedByMe)?.emoji
    try {
      await edgeRequest({ action: 'set-message-reaction', messageId: message.id, emoji: current === emoji ? null : emoji })
      setOpenMessageActions(null)
      await mutate()
      onActivity()
    } catch (caught) {
      const code = typeof caught === 'object' && caught && 'code' in caught ? String(caught.code) : 'GENERIC'
      setSendError(errorMessage(t, code))
    }
  }

  async function setExpiryDuration(value: string) {
    if (savingExpiry) return
    const durationSeconds = value ? Number(value) : null
    setSavingExpiry(true)
    try {
      await edgeRequest({ action: 'set-expiry-duration', conversationId, durationSeconds })
      await mutate()
      setActionNotice(t.chat.expirySaved)
      onActivity()
    } catch (caught) {
      const code = typeof caught === 'object' && caught && 'code' in caught ? String(caught.code) : 'GENERIC'
      setSendError(errorMessage(t, code))
    } finally {
      setSavingExpiry(false)
    }
  }

  async function exportConversation() {
    if (exportingConversation) return
    setExportingConversation(true)
    try {
      const result = await edgeRequest<{ conversation: { name: string; conversationId: number } }>({ action: 'export-conversation', conversationId })
      const blob = new Blob([JSON.stringify(result.conversation, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `message-conversation-${conversationId}-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setActionNotice(t.chat.exportReady)
    } catch {
      setSendError(t.errors.GENERIC)
    } finally {
      setExportingConversation(false)
    }
  }

  async function forwardMessage() {
    if (!forwarding || !forwardTargetId) return
    try {
      const ids = bulkForwardIds.length ? bulkForwardIds : [forwarding.id]
      for (const messageId of ids) await edgeRequest({ action: 'forward-message', messageId, targetConversationId: forwardTargetId })
      closeChatPage('forward-message')
      setForwardTargetId('')
      setBulkForwardIds([])
      setSelectedMessageIds(new Set())
      setActionNotice(t.chat.forwarded)
      onActivity()
    } catch {
      setSendError(t.errors.GENERIC)
    }
  }

  async function runBulkMessageAction(action: 'delete' | 'star' | 'forward') {
    const selected = messages.filter((message) => selectedMessageIds.has(message.id) && !message.deletedAt)
    if (!selected.length) return
    if (action === 'forward') {
      setForwarding(selected[0])
      setBulkForwardIds(selected.map((message) => message.id))
      setForwardTargetId('')
      pushChatPage('forward-message')
      return
    }
    setSendError(null)
    try {
      if (action === 'star') {
        const shouldStar = selected.some((message) => !message.starredByMe)
        await Promise.all(selected.map((message) => edgeRequest({ action: 'star-message', messageId: message.id, starred: shouldStar })))
      } else {
        await Promise.all(selected.map((message) => edgeRequest({ action: 'delete-message', messageId: message.id })))
      }
      setSelectedMessageIds(new Set())
      await mutate()
      onActivity()
    } catch (caught) {
      const code = typeof caught === 'object' && caught && 'code' in caught ? String(caught.code) : 'GENERIC'
      setSendError(errorMessage(t, code))
      await mutate()
    }
  }

  async function setWallpaper(wallpaper: string) {
    try {
      await edgeRequest({ action: 'set-conversation-wallpaper', conversationId, wallpaper })
      await mutate()
    } catch {
      setSendError(t.errors.GENERIC)
    }
  }

  async function reportChat(target: 'person' | 'conversation') {
    const details = window.prompt(t.chat.reportReason)
    setConversationMenuOpen(false)
    if (details === null) return
    try {
      await edgeRequest({
        action: 'submit-report',
        ...(target === 'person' && otherUserId ? { reportedUserId: otherUserId } : {}),
        conversationId,
        details,
      })
      setActionNotice(t.chat.reportSubmitted)
    } catch (err) {
      const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : 'GENERIC'
      setSendError(errorMessage(t, code))
    }
  }

  useEffect(() => {
    const container = messagesContainerRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [lastId])

  useEffect(() => {
    const viewport = window.visualViewport
    let frame = 0
    const keepLatestVisible = () => {
      const container = messagesContainerRef.current
      const nearBottom = container && container.scrollHeight - container.scrollTop - container.clientHeight < 180
      const composing = document.activeElement?.id === 'message'
      if (!nearBottom && !composing) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const latest = messagesContainerRef.current
          if (latest) latest.scrollTop = latest.scrollHeight
        })
      })
    }
    viewport?.addEventListener('resize', keepLatestVisible)
    viewport?.addEventListener('scroll', keepLatestVisible)
    return () => {
      cancelAnimationFrame(frame)
      viewport?.removeEventListener('resize', keepLatestVisible)
      viewport?.removeEventListener('scroll', keepLatestVisible)
    }
  }, [])

  useEffect(() => {
    if (openMessageActions === null) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-message-action-menu], [data-message-action-trigger]')) return
      setOpenMessageActions(null)
      setMessageActionAnchor(null)
      setMessageActionPosition(null)
    }
    const dismissOnLayoutChange = () => {
      setOpenMessageActions(null)
      setMessageActionAnchor(null)
      setMessageActionPosition(null)
    }
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', dismissOnLayoutChange)
    messagesContainerRef.current?.addEventListener('scroll', dismissOnLayoutChange)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('resize', dismissOnLayoutChange)
      messagesContainerRef.current?.removeEventListener('scroll', dismissOnLayoutChange)
    }
  }, [openMessageActions])

  useEffect(() => {
    if (!conversationMenuOpen) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-conversation-menu], [data-conversation-menu-trigger]')) return
      setConversationMenuOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [conversationMenuOpen])

  useEffect(() => {
    if (!groupMemberMenuId) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-group-member-menu]')) return
      setGroupMemberMenuId(null)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [groupMemberMenuId])

  useEffect(() => {
    if (!profileMenuOpen) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-profile-menu]')) return
      setProfileMenuOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [profileMenuOpen])

  useEffect(() => {
    const mediaMessages = messages.filter((message) => message.mediaPath && (!message.viewOnce || message.senderId === currentUserId))
    for (const message of mediaMessages) {
      const mediaPath = message.mediaPath!
      const cached = mediaUrls[mediaPath]
      if (
        (cached && cached.expiresAt > Math.floor(Date.now() / 1000) + 30) ||
        loadingMediaRef.current.has(mediaPath)
      ) {
        continue
      }
      loadingMediaRef.current.add(mediaPath)
      edgeRequest<{ url: string; expiresAt: number }>({
        action: 'get-media-url',
        conversationId,
        mediaPath,
        messageId: message.id,
      })
        .then((result) => {
          setMediaUrls((current) => ({ ...current, [mediaPath]: result }))
        })
        .catch(() => undefined)
        .finally(() => loadingMediaRef.current.delete(mediaPath))
    }
  }, [conversationId, currentUserId, mediaUrls, messages])

  useEffect(() => {
    const refreshAt = Math.min(...Object.values(mediaUrls).map(({ expiresAt }) => expiresAt * 1000 - 30_000))
    if (!Number.isFinite(refreshAt)) return

    const timer = window.setTimeout(() => {
      const refreshWindow = Math.floor(Date.now() / 1000) + 30
      setMediaUrls((current) => Object.fromEntries(
        Object.entries(current).filter(([, media]) => media.expiresAt > refreshWindow),
      ))
    }, Math.max(0, refreshAt - Date.now()))

    return () => window.clearTimeout(timer)
  }, [mediaUrls])

  async function handleSend(body: string, file: File | null, replyToId?: number, viewOnce = false) {
    setSendError(null)
    const optimistic: ChatMessage = {
      id: -Date.now(),
      senderId: currentUserId,
      body,
      createdAt: new Date().toISOString(),
      mediaType: file?.type ?? null,
      mediaName: file?.name ?? null,
      pending: true,
      viewOnce,
      replyTo: replyToId ?? null,
      replyBody: replyTo?.body ?? null,
      replySenderName: replyTo?.senderId === currentUserId ? t.chat.youPrefix.trim() : name,
    }

    try {
      await mutate(
        async (current) => {
          const message = file
            ? await sendChatMedia<ChatMessage>(conversationId, file, body, replyToId, viewOnce)
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
            other: current?.other ?? null,
            otherLastReadAt: current?.otherLastReadAt ?? null,
            otherLastDeliveredAt: current?.otherLastDeliveredAt ?? null,
            messages: [...(current?.messages ?? []), optimistic],
          }),
          rollbackOnError: true,
          populateCache: true,
          revalidate: false,
        },
      )
      onActivity()
      setReplyTo(null)
    } catch (err) {
      const code =
        typeof err === 'object' && err && 'code' in err
          ? err.code
          : err instanceof ApiError
            ? err.code
            : 'GENERIC'
      setSendError(
        errorMessage(t, code),
      )
      return false
    }
    return true
  }

  async function scheduleMessage(body: string, sendAt: string, replyToId?: number) {
    setSendError(null)
    try {
      await edgeRequest({ action: 'schedule-message', conversationId, body, sendAt, replyToId: replyToId ?? null })
      const result = await edgeRequest<{ scheduled: typeof scheduledMessages }>({ action: 'list-scheduled-messages', conversationId })
      setScheduledMessages(result.scheduled)
      setActionNotice(locale === 'ar' ? 'تم حفظ الرسالة المجدولة.' : 'Scheduled message saved.')
      onActivity()
      return true
    } catch (caught) {
      const code = typeof caught === 'object' && caught && 'code' in caught ? String(caught.code) : 'GENERIC'
      setSendError(errorMessage(t, code))
      return false
    }
  }

  async function cancelScheduledMessage(id: string) {
    try {
      await edgeRequest({ action: 'cancel-scheduled-message', id })
      setScheduledMessages((current) => current.filter((item) => item.id !== id))
    } catch {
      setSendError(t.errors.GENERIC)
    }
  }

  async function openViewOnceMessage(message: ChatMessage) {
    if (!message.mediaPath || message.viewedByMe) return
    try {
      const result = await edgeRequest<{ url: string; expiresAt: number }>({
        action: 'get-media-url', conversationId, messageId: message.id, mediaPath: message.mediaPath,
      })
      const type = message.mediaType?.startsWith('video/') ? 'video' : 'image'
      setMediaViewer({ url: result.url, type })
      pushChatPage('media-viewer')
      await mutate()
    } catch (caught) {
      const code = typeof caught === 'object' && caught && 'code' in caught ? String(caught.code) : 'GENERIC'
      setSendError(code === 'NOT_FOUND' ? (locale === 'ar' ? 'تم فتح هذه الصورة أو انتهت صلاحيتها.' : 'This item has already been opened or expired.') : t.errors.GENERIC)
    }
  }

  async function searchMessages(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = searchQuery.trim()
    if (!query) return
    setSearching(true)
    try {
      const result = await edgeRequest<{ messages: Array<{ id: number; body: string; createdAt: string }> }>({
        action: 'search-messages', conversationId, query,
      })
      setSearchResults(result.messages)
    } catch {
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }

  async function toggleMute() {
    try {
      await edgeRequest({ action: 'set-muted', conversationId, muted: !isMuted })
      await mutate()
    } catch {
      setSendError(t.errors.GENERIC)
    }
  }

  async function toggleBlock() {
    if (!otherUserId || isGroup) return
    try {
      await edgeRequest({
        action: isBlockedByMe ? 'unblock-user' : 'block-user',
        userId: otherUserId,
      })
      await mutate()
    } catch {
      setSendError(t.errors.GENERIC)
    }
  }

  async function shareContact() {
    if (!username) return
    const link = new URL(window.location.href)
    link.search = ''
    link.hash = ''
    link.searchParams.set('chat', username)
    const text = `${name} (@${username})\n${link.toString()}`
    try {
      if (navigator.share) await navigator.share({ title: name, text, url: link.toString() })
      else {
        await navigator.clipboard.writeText(text)
        setActionNotice(t.chat.copiedMessage)
      }
    } catch {
      // A dismissed native share sheet does not need an error message.
    }
  }

  function saveContactName() {
    if (!otherUserId) return
    setLocalContactName(otherUserId, contactNameDraft)
    setEditingContactName(false)
  }

  async function createGroupWithContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!username || !newGroupName.trim() || creatingContactGroup) return
    setCreatingContactGroup(true)
    setSendError(null)
    try {
      const result = await edgeRequest<{ id: number }>({
        action: 'create-group',
        name: newGroupName.trim(),
        usernames: [username],
      })
      setInfoOpen(false)
      setNewGroupName('')
      onActivity()
      onOpenConversation(result.id)
    } catch {
      setSendError(t.errors.GENERIC)
    } finally {
      setCreatingContactGroup(false)
    }
  }

  async function addContactToExistingGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!username || !existingGroupId) return
    try {
      const result = await edgeRequest<{ added: number; pending: number }>({
        action: 'add-group-members',
        conversationId: existingGroupId,
        usernames: [username],
      })
      setActionNotice(result.pending ? t.chat.groupMemberApprovalPending : t.chat.groupMemberAdded)
      setInfoOpen(false)
      onActivity()
      onOpenConversation(existingGroupId)
    } catch (err) {
      const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : 'GENERIC'
      setSendError(errorMessage(t, code))
    }
  }

  async function addGroupMembers(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const usernames = groupMemberDraft.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean)
    if (!usernames.length) return
    try {
      const result = await edgeRequest<{ added: number; pending: number }>({
        action: 'add-group-members', conversationId, usernames,
      })
      setGroupMemberDraft('')
      setActionNotice(result.pending ? t.chat.groupMemberApprovalPending : t.chat.groupMemberAdded)
      await mutate()
      onActivity()
    } catch (err) {
      const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : 'GENERIC'
      setSendError(errorMessage(t, code))
    }
  }

  async function manageGroupMember(member: { id: string; name: string }, operation: 'promote' | 'demote' | 'remove') {
    if (groupMemberBusy) return
    if (operation === 'remove' && !window.confirm(t.chat.removeGroupMemberConfirm(member.name))) return
    setGroupMemberBusy(member.id)
    setSendError(null)
    try {
      await edgeRequest({ action: 'manage-group-member', conversationId, userId: member.id, operation })
      setGroupMemberMenuId(null)
      await mutate()
      onActivity()
      setActionNotice(operation === 'remove' ? t.chat.groupMemberRemoved : t.chat.groupAdminUpdated)
    } catch (caught) {
      const code = typeof caught === 'object' && caught && 'code' in caught ? caught.code : 'GENERIC'
      setSendError(errorMessage(t, code))
    } finally {
      setGroupMemberBusy(null)
    }
  }

  async function saveGroupSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (savingGroupSettings) return
    setSavingGroupSettings(true)
    try {
      const result = await edgeRequest<{ groupSettings: GroupSettings; name: string }>({
        action: 'set-group-settings', conversationId,
        settings: groupSettingsDraft,
        name: groupNameDraft,
      })
      setGroupSettingsDraft(result.groupSettings)
      setGroupNameDraft(result.name)
      setActionNotice(t.chat.groupSettingsSaved)
      await mutate()
      onActivity()
    } catch (err) {
      const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : 'GENERIC'
      setSendError(errorMessage(t, code))
    } finally {
      setSavingGroupSettings(false)
    }
  }

  async function shareGroupInvite() {
    setGroupInviteBusy(true)
    try {
      const invite = await edgeRequest<{ token: string }>({ action: 'create-group-invite', conversationId })
      const url = new URL(window.location.href)
      url.search = ''
      url.searchParams.set('groupInvite', invite.token)
      if (navigator.share) await navigator.share({ title: name, text: t.chat.groupInviteText(name), url: url.toString() })
      else {
        await navigator.clipboard.writeText(url.toString())
        setActionNotice(t.chat.groupInviteCopied)
      }
    } catch (err) {
      const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : 'GENERIC'
      setSendError(errorMessage(t, code))
    } finally {
      setGroupInviteBusy(false)
    }
  }

  async function reviewGroupRequest(requestId: string, decision: 'approve' | 'reject') {
    try {
      await edgeRequest({ action: 'review-group-request', conversationId, requestId, decision })
      const result = await edgeRequest<{ requests: typeof groupRequests }>({ action: 'list-group-requests', conversationId })
      setGroupRequests(result.requests)
      await mutate()
      onActivity()
    } catch (err) {
      const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : 'GENERIC'
      setSendError(errorMessage(t, code))
    }
  }

  const groupMembers = (data?.other?.members ?? []).filter((member) => member.id !== currentUserId)
  const sharedMedia = messages.filter((message) =>
    Boolean(message.mediaPath) &&
    !message.viewOnce &&
    (message.messageType === 'image' || message.messageType === 'video' || message.messageType === 'voice' ||
      message.mediaType?.startsWith('image/') || message.mediaType?.startsWith('video/') || message.mediaType?.startsWith('audio/')),
  )
  const sharedDocuments = messages.filter((message) =>
    Boolean(message.mediaPath) &&
    (message.messageType === 'document' || (!message.mediaType?.startsWith('image/') &&
      !message.mediaType?.startsWith('video/') && !message.mediaType?.startsWith('audio/'))),
  )
  const sharedLinks = messages.flatMap((message) =>
    [...(message.body.matchAll(/https?:\/\/[^\s<>()]+/g) ?? [])].map(([url]) => ({ url, messageId: message.id })),
  ).slice(-100).reverse()

  return (
    <>
      <header className="flex items-center gap-3 border-b bg-background px-3 py-2.5 md:px-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="md:hidden"
          aria-label={t.chat.back}
        >
          <ArrowLeft className="rtl:rotate-180" />
        </Button>
        <button type="button" className="flex min-w-0 items-center gap-3 rounded-xl text-start hover:opacity-85" onClick={openConversationInfo} aria-label={isGroup ? t.chat.groupDetails : t.chat.profileDetails}>
          {isGroup ? <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-primary"><Users className="size-5" /></span> : <UserAvatar name={name} image={image} />}
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{name}</span>
            {isGroup ? (
              <span className="block truncate text-xs text-muted-foreground">
                {t.chat.memberCount(data?.other?.participantCount ?? 0)}
              </span>
            ) : data?.other?.about ? (
              <span className="block truncate text-xs text-muted-foreground">{data.other.about}</span>
            ) : username && (
              <span className="block truncate text-xs text-muted-foreground" dir="ltr">
                <span className="inline-block">@{username}</span>
              </span>
            )}
            {!isGroup && data?.other?.isOnline && <span className="block text-[11px] text-emerald-600">{locale === 'ar' ? 'متصل الآن' : 'Online'}</span>}
            {!isGroup && !data?.other?.isOnline && data?.other?.lastSeenAt && <span className="block text-[11px] text-muted-foreground">{locale === 'ar' ? 'آخر ظهور' : 'Last seen'} · {new Date(data.other.lastSeenAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}</span>}
          </span>
        </button>
        <div className="ms-auto flex shrink-0 items-center gap-0.5" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
          <Button variant="ghost" size="icon" onClick={() => { setSearchOpen((open) => !open); setSearchResults([]) }} aria-label={t.chat.searchConversation} title={t.chat.searchConversation}>
            <Search />
          </Button>
          <div className="relative">
            <Button variant="ghost" size="icon" data-conversation-menu-trigger onClick={() => setConversationMenuOpen((open) => !open)} aria-label={t.chat.conversationOptions} title={t.chat.conversationOptions} aria-expanded={conversationMenuOpen}>
              <MoreHorizontal />
            </Button>
            {conversationMenuOpen && (
              <div data-conversation-menu className="absolute end-0 top-full z-30 mt-1 grid min-w-56 gap-1 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl">
                <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => { setConversationMenuOpen(false); void toggleMute() }}>
                  {isMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}{isMuted ? t.chat.unmuteConversation : t.chat.muteConversation}
                </button>
                {!isGroup && otherUserId && (
                  <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => { setConversationMenuOpen(false); void toggleBlock() }}>
                    {isBlockedByMe ? <ShieldCheck className="size-4" /> : <Ban className="size-4" />}{isBlockedByMe ? t.chat.unblockPerson : t.chat.blockPerson}
                  </button>
                )}
                {!isGroup && otherUserId && <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => void reportChat('person')}><Flag className="size-4" />{t.chat.reportPerson}</button>}
                <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => void reportChat('conversation')}><Flag className="size-4" />{t.chat.reportConversation}</button>
                {(!isGroup || isGroupAdmin) && (
                  <label className="grid gap-1 border-t px-3 pb-1 pt-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-2"><Clock className="size-3.5" />{t.chat.disappearingMessages}</span>
                    <select
                      value={data?.conversation?.expiresInSeconds == null ? '' : String(data.conversation.expiresInSeconds)}
                      disabled={savingExpiry || !data?.conversation}
                      onChange={(event) => void setExpiryDuration(event.target.value)}
                      aria-label={t.chat.disappearingMessages}
                      className="h-9 w-full rounded-lg border bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
                    >
                      <option value="">{t.chat.expiryOff}</option>
                      <option value="86400">{t.chat.expiryOneDay}</option>
                      <option value="604800">{t.chat.expiryOneWeek}</option>
                      <option value="7776000">{t.chat.expiryNinetyDays}</option>
                    </select>
                  </label>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {searchOpen && (
        <div className="border-b bg-background px-3 py-2 md:px-4">
          <form className="mx-auto flex max-w-3xl gap-2" onSubmit={(event) => void searchMessages(event)}>
            <Input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t.chat.searchPlaceholderMessages} aria-label={t.chat.searchConversation} className="h-9 rounded-full bg-muted" />
            <Button type="submit" size="sm" disabled={searching || !searchQuery.trim()}>{searching ? '…' : t.chat.searchConversation}</Button>
            <Button type="button" size="icon" variant="ghost" aria-label={t.chat.back} onClick={() => setSearchOpen(false)}><X /></Button>
          </form>
          {searchResults.length > 0 ? (
            <ul className="mx-auto mt-2 max-h-36 max-w-3xl divide-y overflow-y-auto rounded-lg border">
              {searchResults.map((result) => (
                <li key={result.id}>
                  <button type="button" className="w-full p-2 text-start hover:bg-muted" onClick={() => {
                    document.getElementById(`message-${result.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    setSearchOpen(false)
                  }}>
                    <span className="block truncate text-sm">{result.body || t.chat.document}</span>
                    <time className="text-xs text-muted-foreground">{formatMessageTime(result.createdAt, locale)}</time>
                  </button>
                </li>
              ))}
            </ul>
          ) : searchQuery && !searching ? (
            <p className="mx-auto mt-2 max-w-3xl text-xs text-muted-foreground">{t.chat.noSearchResults}</p>
          ) : null}
        </div>
      )}

      {isBlocked && !isGroup && (
        <div className="border-b bg-destructive/5 px-4 py-2 text-center text-xs text-destructive">
          {isBlockedByOther && !isBlockedByMe ? t.chat.blockedYouNotice : t.chat.blockedByYouNotice}
        </div>
      )}

      {!isGroup && messageRequestStatus === 'pending' && <p role="status" className="border-b bg-primary/5 px-4 py-2 text-center text-xs text-muted-foreground">{t.chat.messageRequestPending}</p>}
      {!isGroup && messageRequestStatus === 'declined' && <p role="status" className="border-b bg-destructive/5 px-4 py-2 text-center text-xs text-destructive">{t.chat.messageRequestDeclined}</p>}

      {data?.pinnedMessage && (
        <button type="button" className="flex w-full items-center gap-2 border-b bg-primary/5 px-4 py-2 text-start text-xs hover:bg-primary/10" onClick={() => document.getElementById(`message-${data.pinnedMessage?.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
          <Pin className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span className="font-medium">{t.chat.pinnedMessage}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{data.pinnedMessage.deleted ? t.chat.deletedMessage : data.pinnedMessage.body}</span>
        </button>
      )}
      {actionNotice && <p role="status" className="border-b bg-background px-4 py-1.5 text-center text-xs text-muted-foreground">{actionNotice}</p>}

      {scheduledMessages.length > 0 && <section className="border-b bg-primary/5 px-3 py-2 md:px-5" aria-label={locale === 'ar' ? 'الرسائل المجدولة' : 'Scheduled messages'}><div className="mx-auto grid max-w-3xl gap-1.5">{scheduledMessages.map((item) => <div key={item.id} className="flex min-w-0 items-center gap-2 rounded-lg bg-background/80 px-2.5 py-1.5 text-xs"><Clock className="size-3.5 shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate">{item.body}</span><time className="shrink-0 text-muted-foreground">{new Date(item.sendAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}</time><button type="button" className="shrink-0 rounded px-2 py-1 text-destructive hover:bg-destructive/10" onClick={() => void cancelScheduledMessage(item.id)}>{locale === 'ar' ? 'إلغاء' : 'Cancel'}</button></div>)}</div></section>}

      {selectedMessageIds.size > 0 && <div className="flex min-h-11 items-center gap-2 border-b bg-primary/5 px-3 py-1.5 md:px-5"><span className="min-w-0 flex-1 text-xs font-medium">{selectedMessageIds.size} {locale === 'ar' ? 'رسائل محددة' : 'selected'}</span><Button type="button" size="sm" variant="outline" onClick={() => void runBulkMessageAction('star')}><Star className="me-1 size-3.5" />{locale === 'ar' ? 'تمييز' : 'Star'}</Button><Button type="button" size="sm" variant="outline" disabled={messages.some((message) => selectedMessageIds.has(message.id) && message.viewOnce)} title={locale === 'ar' ? 'لا يمكن إعادة توجيه عرض مرة واحدة.' : 'View-once media cannot be forwarded.'} onClick={() => void runBulkMessageAction('forward')}><Forward className="me-1 size-3.5" />{locale === 'ar' ? 'إعادة توجيه' : 'Forward'}</Button>{messages.filter((message) => selectedMessageIds.has(message.id)).every((message) => isAdmin || message.senderId === currentUserId) && <Button type="button" size="sm" variant="outline" className="text-destructive" onClick={() => void runBulkMessageAction('delete')}><Trash2 className="me-1 size-3.5" />{locale === 'ar' ? 'حذف' : 'Delete'}</Button>}<Button type="button" size="icon" variant="ghost" aria-label={t.chat.cancel} onClick={() => setSelectedMessageIds(new Set())}><X className="size-4" /></Button></div>}

      <div
        ref={messagesContainerRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-8"
        style={{ backgroundColor: ({ default: 'var(--background)', slate: 'color-mix(in srgb, var(--background) 91%, #64748b 9%)', blue: 'color-mix(in srgb, var(--background) 91%, #3b82f6 9%)', green: 'color-mix(in srgb, var(--background) 91%, #22c55e 9%)', rose: 'color-mix(in srgb, var(--background) 91%, #f43f5e 9%)', violet: 'color-mix(in srgb, var(--background) 91%, #8b5cf6 9%)', sand: 'color-mix(in srgb, var(--background) 91%, #c08457 9%)' } as Record<string, string>)[data?.conversation?.wallpaper ?? 'default'] ?? 'var(--background)' }}
        role="log"
        aria-live="polite"
        aria-label={t.chat.messagesWith(name)}
      >
        {error && !data ? (
          <p className="mt-10 text-center text-sm text-destructive">
            {t.chat.loadMessagesError}
          </p>
        ) : !data ? (
          <p className="mt-10 text-center text-sm text-muted-foreground">
            {t.chat.loadingMessages}
          </p>
        ) : messages.length === 0 ? (
          <div className="mx-auto mt-10 max-w-xs rounded-xl bg-background/60 px-4 py-3 text-center text-sm text-muted-foreground">
            {t.chat.sayHello(name, username ?? '')}
          </div>
        ) : (
          <ol className="mx-auto flex max-w-3xl flex-col gap-1">
            {messages.map((message, index) => {
              const prev = messages[index - 1]
              const showDay =
                !prev ||
                new Date(prev.createdAt).toDateString() !==
                  new Date(message.createdAt).toDateString()
              const mine = message.senderId === currentUserId
              const groupedWithPrev =
                !showDay && prev?.senderId === message.senderId
              const read =
                mine && new Date(message.createdAt).getTime() <= otherReadAt
              const delivered =
                mine && new Date(message.createdAt).getTime() <= otherDeliveredAt
              const payload = (message.payload ?? {}) as {
                latitude?: number
                longitude?: number
                name?: string
                phone?: string
                email?: string
                question?: string
                options?: string[]
                counts?: number[]
                myVote?: number | null
                title?: string
                startsAt?: string
                location?: string
                details?: string
                systemEvent?: string
                actorName?: string
                addedMembers?: Array<{ id: string; name: string }>
              }
              const messageType = message.messageType ?? (
                message.mediaType?.startsWith('audio/') ? 'voice'
                  : message.mediaType?.startsWith('video/') ? 'video'
                    : message.mediaType?.startsWith('image/') ? 'image'
                      : message.mediaType ? 'document' : 'text'
              )
              const isMembersAddedEvent = messageType === 'event' && payload.systemEvent === 'members_added'
              const addedMemberNames = (payload.addedMembers ?? []).map((member) => member.name).filter(Boolean)
              const youWereAdded = (payload.addedMembers ?? []).some((member) => member.id === currentUserId)
              const mediaUrl = message.mediaPath ? mediaUrls[message.mediaPath]?.url : undefined

              return (
                <Fragment key={message.id}>
                  {showDay && (
                    <li className="my-3 flex justify-center">
                      <span className="rounded-full bg-background px-3 py-1 text-xs font-medium text-muted-foreground shadow-xs">
                        {formatDayLabel(message.createdAt, locale, t.chat)}
                      </span>
                    </li>
                  )}
                  <li
                    id={`message-${message.id}`}
                    className={cn(
                      'flex',
                      isMembersAddedEvent ? 'justify-center' : mine ? 'justify-end' : 'justify-start',
                      !groupedWithPrev && 'mt-2',
                    )}
                    onContextMenu={(event) => {
                      if (isMembersAddedEvent) return
                      if (message.deletedAt || message.pending) return
                      event.preventDefault()
                      showMessageActions(message.id)
                    }}
                    onTouchStart={() => {
                      if (isMembersAddedEvent) return
                      if (!message.deletedAt && !message.pending) startMessageHold(message.id)
                    }}
                    onTouchEnd={clearMessageHold}
                    onTouchMove={clearMessageHold}
                  >
                    <div
                      data-message-bubble
                      onClick={(event) => {
                        if (!selectedMessageIds.size || message.deletedAt || message.pending) return
                        if (event.target instanceof Element && event.target.closest('button, a, audio, video, input')) return
                        setSelectedMessageIds((current) => {
                          const next = new Set(current)
                          if (next.has(message.id)) next.delete(message.id)
                          else next.add(message.id)
                          return next
                        })
                      }}
                      className={cn(
                        'relative max-w-[88%] rounded-2xl px-3 py-1.5 shadow-xs md:max-w-[72%]',
                        selectedMessageIds.has(message.id) && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
                        isMembersAddedEvent
                          ? 'max-w-[90%] rounded-full bg-background/90 px-3 py-1 text-center text-xs text-muted-foreground shadow-sm md:max-w-[80%]'
                          : mine
                          ? 'bg-bubble-out text-bubble-out-foreground'
                          : 'bg-bubble-in text-bubble-in-foreground',
                        !isMembersAddedEvent && !groupedWithPrev &&
                          (mine ? 'rounded-se-md' : 'rounded-ss-md'),
                      )}
                    >
                      {!isMembersAddedEvent && !message.deletedAt && !message.pending && (
                        <>
                          <button
                            type="button"
                            className="absolute end-1 top-1 hidden size-6 items-center justify-center rounded-full bg-background/70 text-muted-foreground hover:bg-background focus-visible:flex md:flex"
                            aria-label={t.chat.messageActions}
                            title={t.chat.messageActions}
                            data-message-action-trigger
                            onClick={() => {
                              if (openMessageActions === message.id) setOpenMessageActions(null)
                              else showMessageActions(message.id)
                            }}
                          >
                            <MoreHorizontal className="size-4" />
                          </button>
                          {openMessageActions === message.id && (
                            typeof document !== 'undefined' && messageActionPosition && createPortal(
                              <div
                                ref={messageActionMenuRef}
                                data-message-action-menu
                                style={{ top: messageActionPosition.top, left: messageActionPosition.left }}
                                className="fixed z-[100] grid w-52 max-w-[calc(100vw-1.5rem)] max-h-[min(60dvh,22rem)] gap-0.5 overflow-y-auto rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl"
                              >
                                <div className="grid grid-cols-4 gap-0.5 border-b pb-1" role="group" aria-label={t.chat.messageReactions}>
                                  {MESSAGE_REACTIONS.map((emoji) => (
                                    <button key={emoji} type="button" className="rounded-lg px-1 py-1.5 text-lg leading-none hover:bg-muted" aria-label={`${t.chat.messageReactions}: ${emoji}`} onClick={() => void setMessageReaction(message, emoji)}>{emoji}</button>
                                  ))}
                                </div>
                                <button type="button" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs hover:bg-muted" onClick={() => { setReply(message); setOpenMessageActions(null) }}><Reply className="size-3.5" />{t.chat.reply}</button>
                                <button type="button" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs hover:bg-muted" onClick={() => { setSelectedMessageIds((current) => new Set(current).add(message.id)); setOpenMessageActions(null) }}><Check className="size-3.5" />{locale === 'ar' ? 'تحديد الرسالة' : 'Select message'}</button>
                                <button type="button" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs hover:bg-muted" onClick={() => { void copyMessage(message); setOpenMessageActions(null) }}><Copy className="size-3.5" />{t.chat.copyMessage}</button>
                                {!message.viewOnce && <button type="button" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs hover:bg-muted" onClick={() => { setForwarding(message); setBulkForwardIds([]); setOpenMessageActions(null); pushChatPage('forward-message') }}><Forward className="size-3.5" />{t.chat.forwardMessage}</button>}
                                {mine && message.messageType === 'text' && Date.now() - new Date(message.createdAt).getTime() < 15 * 60_000 && <button type="button" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs hover:bg-muted" onClick={() => { setEditingMessageId(message.id); setEditedBody(message.body); setOpenMessageActions(null) }}><Pencil className="size-3.5" />{t.chat.editMessage}</button>}
                                <button type="button" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs hover:bg-muted" onClick={() => { void runMessageAction('star', message); setOpenMessageActions(null) }}><Star className={cn('size-3.5', message.starredByMe && 'fill-current text-primary')} />{message.starredByMe ? t.chat.unstarMessage : t.chat.starMessage}</button>
                                <button type="button" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs hover:bg-muted" onClick={() => { void runMessageAction('pin', message); setOpenMessageActions(null) }}><Pin className="size-3.5" />{message.pinned ? t.chat.unpinMessage : t.chat.pinMessage}</button>
                                {(mine || isAdmin) && <button type="button" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs text-destructive hover:bg-destructive/10" onClick={() => { void runMessageAction('delete', message); setOpenMessageActions(null) }}><Trash2 className="size-3.5" />{t.chat.deleteMessage}</button>}
                              </div>,
                              document.body,
                            )
                          )}
                        </>
                      )}
                      {!isMembersAddedEvent && message.replyTo && (
                        <button type="button" className="mb-1 w-full rounded-lg border-s-2 border-primary/70 bg-background/50 px-2 py-1 text-start" onClick={() => document.getElementById(`message-${message.replyTo}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
                          <span className="block truncate text-[11px] font-semibold text-primary">{message.replySenderName || t.chat.reply}</span>
                          <span className="block truncate text-xs opacity-75">{message.replyDeleted ? t.chat.replyDeleted : message.replyBody || t.chat.replyDeleted}</span>
                        </button>
                      )}
                      {!isMembersAddedEvent && message.forwardedFrom && <p className="mb-1 flex items-center gap-1 text-[11px] italic opacity-75"><Forward className="size-3" />{t.chat.forwarded}</p>}
                      {!isMembersAddedEvent && message.mediaType && (
                        <div className="mb-1 min-w-44 overflow-hidden rounded-xl">
                          {message.viewOnce && message.viewed ? (
                            <div className="flex min-h-16 items-center gap-2 rounded-lg bg-background/70 px-3 py-3 text-xs text-muted-foreground"><Clock className="size-4 shrink-0" /><span>{locale === 'ar' ? (mine ? 'تم فتح الوسيط لمرة واحدة.' : 'تم فتح هذه الرسالة.') : (mine ? 'Your one-time media was opened.' : 'This item was opened.')}</span></div>
                          ) : message.viewOnce && !mine ? (
                            <button type="button" className="flex min-h-16 w-full items-center gap-2 rounded-lg bg-background/70 px-3 py-3 text-start text-xs hover:bg-background disabled:opacity-60" disabled={message.viewedByMe} onClick={() => void openViewOnceMessage(message)}><Clock className="size-4 shrink-0 text-primary" /><span>{message.viewedByMe ? (locale === 'ar' ? 'تم الفتح' : 'Opened') : (locale === 'ar' ? 'اضغط لعرضها مرة واحدة' : 'Tap to view once')}</span></button>
                          ) : mediaUrl ? (
                            messageType === 'voice' ? (
                              <audio src={mediaUrl} controls className="max-w-full" aria-label={t.chat.recordVoice} />
                            ) : messageType === 'document' ? (
                              <a href={mediaUrl} download={message.mediaName ?? undefined} className="block rounded-lg bg-background/70 px-3 py-3 text-sm underline">
                                {message.mediaName ?? t.chat.viewDocument}
                              </a>
                            ) : messageType === 'video' || message.mediaType.startsWith('video/') ? (
                              <video
                                src={mediaUrl}
                                controls
                                playsInline
                                preload="metadata"
                                className="max-h-80 max-w-full bg-black"
                                aria-label={message.mediaName ?? t.chat.videoMessage}
                              />
                            ) : (
                              <button type="button" className="block cursor-zoom-in" onClick={() => openProfilePhoto(mediaUrl)} aria-label={t.chat.photoMessage}>
                                <img
                                  src={mediaUrl}
                                  alt={message.mediaName ?? t.chat.photoMessage}
                                  loading="lazy"
                                  className="max-h-80 max-w-full object-contain"
                                />
                              </button>
                            )
                          ) : (
                            <div className="flex min-h-16 items-center gap-2 bg-black/5 px-4 py-3 text-xs text-muted-foreground">
                              {message.pending ? <Clock className="size-4 shrink-0" /> : messageType === 'voice' ? <FileAudio className="size-4 shrink-0" /> : messageType === 'document' ? <FileText className="size-4 shrink-0" /> : messageType === 'video' ? <Video className="size-4 shrink-0" /> : <ImageIcon className="size-4 shrink-0" />}
                              <span className="min-w-0 truncate">{message.pending ? t.chat.uploadingMedia : messageType === 'voice' ? t.chat.recordVoice : messageType === 'document' ? message.mediaName ?? t.chat.document : messageType === 'video' ? t.chat.videoMessage : t.chat.photoMessage}</span>
                            </div>
                          )}
                        </div>
                      )}
                      {!isMembersAddedEvent && messageType === 'location' && (
                        <div className="mb-1 rounded-xl bg-background/60 p-3 text-sm">
                          <p className="font-medium">{t.chat.location}</p>
                          <p className="mt-1 text-xs opacity-75">{Number(payload.latitude).toFixed(5)}, {Number(payload.longitude).toFixed(5)}</p>
                          <a className="mt-2 inline-block underline" href={`https://www.google.com/maps?q=${payload.latitude},${payload.longitude}`} target="_blank" rel="noreferrer">{t.chat.openMap}</a>
                        </div>
                      )}
                      {!isMembersAddedEvent && messageType === 'contact' && (
                        <div className="mb-1 min-w-48 rounded-xl bg-background/60 p-3 text-sm">
                          <p className="font-medium">{payload.name}</p>
                          {payload.phone && <p className="mt-1 text-xs" dir="ltr">{payload.phone}</p>}
                          {payload.email && <p className="mt-1 text-xs" dir="ltr">{payload.email}</p>}
                        </div>
                      )}
                      {messageType === 'event' && (
                        isMembersAddedEvent ? (
                          <p>{t.chat.membersAddedNotice(payload.actorName ?? '', addedMemberNames, youWereAdded)}</p>
                        ) : (
                          <div className="mb-1 min-w-52 rounded-xl bg-background/60 p-3 text-sm">
                            <p className="font-semibold">{payload.title}</p>
                            {payload.startsAt && <time className="mt-1 block text-xs text-muted-foreground">{new Date(payload.startsAt).toLocaleString(locale)}</time>}
                            {payload.location && <p className="mt-1 text-xs">{payload.location}</p>}
                            {payload.details && <p className="mt-2 whitespace-pre-wrap text-xs">{payload.details}</p>}
                          </div>
                        )
                      )}
                      {!isMembersAddedEvent && messageType === 'poll' && (
                        <div className="mb-1 min-w-52 rounded-xl bg-background/60 p-3 text-sm">
                          <p className="mb-2 font-semibold">{payload.question}</p>
                          {(payload.options ?? []).map((option, optionIndex) => (
                            <button
                              key={`${message.id}-option-${optionIndex}`}
                              type="button"
                              className={cn('mb-1 flex w-full items-center justify-between gap-3 rounded-lg border px-2.5 py-2 text-start', payload.myVote === optionIndex && 'border-primary bg-primary/10')}
                              onClick={async () => {
                                try {
                                  await edgeRequest({ action: 'vote-poll', messageId: message.id, optionIndex })
                                  await mutate()
                                } catch {
                                  setSendError(t.errors.GENERIC)
                                }
                              }}
                            >
                              <span>{option}</span>
                              <span className="text-xs text-muted-foreground">{payload.counts?.[optionIndex] ?? 0}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {!isMembersAddedEvent && (message.deletedAt ? (
                        <p className="py-1 text-sm italic opacity-70">{t.chat.deletedMessage}</p>
                      ) : editingMessageId === message.id ? (
                        <form className="my-1 grid min-w-52 gap-2" onSubmit={(event) => { event.preventDefault(); void saveMessageEdit(message) }}>
                          <textarea autoFocus rows={3} maxLength={4000} value={editedBody} onChange={(event) => setEditedBody(event.target.value)} aria-label={t.chat.editMessage} className="w-full resize-y rounded-lg border bg-background/70 px-2.5 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                          <div className="flex justify-end gap-1.5">
                            <Button type="button" size="sm" variant="ghost" disabled={savingEdit} onClick={() => { setEditingMessageId(null); setEditedBody('') }}>{t.chat.cancelEdit}</Button>
                            <Button type="submit" size="sm" disabled={savingEdit || !editedBody.trim()}>{savingEdit ? '…' : t.chat.saveEdit}</Button>
                          </div>
                        </form>
                      ) : message.body ? (
                        <p
                          dir="auto"
                          className="chat-message-text select-none text-sm leading-relaxed break-words whitespace-pre-wrap"
                        >
                          {renderMessageText(message.body)}
                        </p>
                      ) : null)}
                      {!isMembersAddedEvent && !message.deletedAt && (message.reactions?.length ?? 0) > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label={t.chat.messageReactions}>
                          {message.reactions?.map((reaction) => (
                            <button key={reaction.emoji} type="button" onClick={() => void setMessageReaction(message, reaction.emoji)} aria-pressed={reaction.reactedByMe} title={`${reaction.emoji} ${reaction.count}`} className={cn('flex items-center gap-1 rounded-full border bg-background/70 px-1.5 py-0.5 text-xs', reaction.reactedByMe && 'border-primary/50 bg-primary/10')}>
                              <span>{reaction.emoji}</span><span>{reaction.count}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <p
                        className={cn(
                          'mt-0.5 flex items-center justify-end gap-1 text-[11px]',
                          isMembersAddedEvent ? 'justify-center text-muted-foreground' : mine ? 'opacity-80' : 'text-muted-foreground',
                        )}
                      >
                        <time dateTime={message.createdAt}>
                          {formatMessageTime(message.createdAt, locale)}
                        </time>
                        {message.editedAt && <span>{t.chat.edited}</span>}
                        {!isMembersAddedEvent && mine &&
                          (message.pending ? (
                            <Clock className="size-3" aria-label={t.chat.sending} />
                          ) : read ? (
                            <CheckCheck
                              className="size-3.5 text-sky-500"
                              aria-label={t.chat.read}
                            />
                          ) : delivered ? (
                            <CheckCheck className="size-3.5" aria-label={t.chat.delivered} />
                          ) : (
                            <Check
                              className="size-3.5"
                              aria-label={t.chat.delivered}
                            />
                          ))}
                      </p>
                    </div>
                  </li>
                </Fragment>
              )
            })}
          </ol>
        )}
        <div ref={bottomRef} />
      </div>

      {isBlocked && !isGroup ? (
        <div className="border-t bg-background px-4 py-4 text-center text-sm text-muted-foreground">
          {isBlockedByOther && !isBlockedByMe ? t.chat.blockedYouNotice : t.chat.blockedByYouNotice}
        </div>
      ) : messageRequestStatus === 'declined' ? (
        <div className="border-t bg-background px-4 py-4 text-center text-sm text-muted-foreground">{t.chat.messageRequestDeclined}</div>
      ) : (
        <MessageComposer
          conversationId={conversationId}
          onSend={handleSend}
          onSchedule={scheduleMessage}
          onRestoreDraftReply={(id) => {
            if (id == null) {
              setReplyTo(null)
              pendingDraftReply.current = null
            } else {
              const restored = messages.find((message) => message.id === id)
              if (restored) setReplyTo(restored)
              else pendingDraftReply.current = id
            }
          }}
          replyMessage={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onSendStructured={async (messageType, payload) => {
            setSendError(null)
            try {
              await edgeRequest({ action: 'send-structured-message', conversationId, messageType, payload, replyToId: replyTo?.id ?? null })
              await mutate()
              onActivity()
              setReplyTo(null)
              return true
            } catch (caught) {
              const code = typeof caught === 'object' && caught && 'code' in caught ? caught.code : 'GENERIC'
              setSendError(errorMessage(t, code))
              return false
            }
          }}
          error={sendError}
        />
      )}

      {infoOpen && (
        <div className="fixed inset-0 z-50 bg-background" role="dialog" aria-modal="true" aria-labelledby="conversation-info-title">
          <section className="flex h-full w-full flex-col overflow-hidden bg-background">
            <header className="flex items-center gap-2 border-b px-4 py-3">
              <Button type="button" variant="ghost" size="icon" aria-label={t.chat.back} onClick={() => closeChatPage('conversation-details')}><ArrowLeft className="rtl:rotate-180" /></Button>
              <h2 id="conversation-info-title" className="flex-1 font-semibold">{isGroup ? t.chat.groupDetails : t.chat.profileDetails}</h2>
              <div className="relative" data-profile-menu>
                <Button type="button" variant="ghost" size="icon" aria-label={t.chat.profileMenu} onClick={() => setProfileMenuOpen((open) => !open)}><MoreHorizontal /></Button>
                {profileMenuOpen && (
                  <div className="absolute end-0 top-full z-10 min-w-52 rounded-xl border bg-popover p-1.5 shadow-xl">
                    {!isGroup && username && <button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => { setProfileMenuOpen(false); void shareContact() }}><Share2 className="size-4" />{t.chat.shareContact}</button>}
                    {!isGroup && otherUserId && <button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => { setProfileMenuOpen(false); setContactNameDraft(displayNameOverride ?? ''); setEditingContactName(true) }}><Pencil className="size-4" />{t.chat.editLocalName}</button>}
                    <button type="button" disabled={exportingConversation} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted disabled:opacity-60" onClick={() => { setProfileMenuOpen(false); void exportConversation() }}><Download className="size-4" />{exportingConversation ? t.chat.exporting : t.chat.exportConversation}</button>
                  </div>
                )}
              </div>
            </header>

            <section className="border-b px-4 py-4" aria-label={locale === 'ar' ? 'خلفية المحادثة' : 'Chat wallpaper'}>
              <h3 className="mb-3 text-sm font-semibold">{locale === 'ar' ? 'خلفية المحادثة' : 'Chat wallpaper'}</h3>
              <div className="flex flex-wrap gap-2">
                {([
                  ['default', locale === 'ar' ? 'افتراضي' : 'Default', 'bg-background'],
                  ['slate', locale === 'ar' ? 'رمادي' : 'Slate', 'bg-slate-500'],
                  ['blue', locale === 'ar' ? 'أزرق' : 'Blue', 'bg-blue-500'],
                  ['green', locale === 'ar' ? 'أخضر' : 'Green', 'bg-green-500'],
                  ['rose', locale === 'ar' ? 'وردي' : 'Rose', 'bg-rose-500'],
                  ['violet', locale === 'ar' ? 'بنفسجي' : 'Violet', 'bg-violet-500'],
                  ['sand', locale === 'ar' ? 'رملي' : 'Sand', 'bg-amber-700'],
                ] as const).map(([value, label, swatch]) => (
                  <button key={value} type="button" aria-pressed={(data?.conversation?.wallpaper ?? 'default') === value} aria-label={label} title={label} onClick={() => void setWallpaper(value)} className={cn('size-9 rounded-full border-2 shadow-sm', swatch, (data?.conversation?.wallpaper ?? 'default') === value ? 'border-primary ring-2 ring-primary/25' : 'border-background')} />
                ))}
              </div>
            </section>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="flex flex-col items-center border-b px-5 py-6 text-center">
                {isGroup ? (
                  <span className="mb-3 flex size-24 items-center justify-center rounded-full bg-muted text-primary"><Users className="size-10" /></span>
                ) : (
                  <button type="button" aria-label={t.chat.photoMessage} className="mb-3 rounded-full" onClick={() => openProfilePhoto(image)}>
                    <UserAvatar name={name} image={image} className="size-24 text-2xl" />
                  </button>
                )}
                <h3 className="max-w-full truncate text-lg font-semibold">{name}</h3>
                {!isGroup && username && <p className="mt-1 text-sm text-muted-foreground" dir="ltr">@{username}</p>}
                {!isGroup && data?.other?.about && <p className="mt-2 max-w-sm text-sm text-muted-foreground">{data.other.about}</p>}
                {editingContactName && !isGroup && (
                  <form className="mt-4 flex w-full max-w-sm gap-2" onSubmit={(event) => { event.preventDefault(); saveContactName() }}>
                    <Input autoFocus maxLength={50} value={contactNameDraft} onChange={(event) => setContactNameDraft(event.target.value)} placeholder={t.chat.localNamePlaceholder} aria-label={t.chat.localNamePlaceholder} />
                    <Button type="submit" disabled={!otherUserId}>{t.chat.saveLocalName}</Button>
                  </form>
                )}
                {!isGroup && username && !isBlocked && (
                  <div className="mt-4 grid w-full max-w-sm gap-2">
                    <form className="grid gap-2 rounded-xl border p-3 text-start" onSubmit={(event) => void createGroupWithContact(event)}>
                      <label htmlFor="contact-group-name" className="text-sm font-medium">{t.chat.createGroupWithContact}</label>
                      <Input id="contact-group-name" maxLength={50} required value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder={t.chat.groupNameForContact} />
                      <Button type="submit" disabled={creatingContactGroup || !newGroupName.trim()}><UserRoundPlus className="me-2 size-4" />{creatingContactGroup ? t.chat.creatingGroupWithContact : t.chat.createGroupWithContact}</Button>
                    </form>
                    {availableConversations.some((conversation) => conversation.isGroup) && (
                      <form className="grid gap-2 rounded-xl border p-3 text-start" onSubmit={(event) => void addContactToExistingGroup(event)}>
                        <label htmlFor="existing-group" className="text-sm font-medium">{t.chat.addToExistingGroup}</label>
                        <select id="existing-group" required value={existingGroupId} onChange={(event) => setExistingGroupId(Number(event.target.value) || '')} className="h-10 rounded-xl border bg-muted px-3 text-sm">
                          <option value="">{t.chat.selectGroup}</option>
                          {availableConversations.filter((conversation) => conversation.isGroup).map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.groupName ?? conversation.otherName}</option>)}
                        </select>
                        <Button type="submit" disabled={!existingGroupId}><UserRoundPlus className="me-2 size-4" />{t.chat.addMembers}</Button>
                      </form>
                    )}
                  </div>
                )}
              </div>

              {isGroup && (
                <section className="border-b px-4 py-4">
                  <h3 className="mb-3 text-sm font-semibold">{t.chat.groupMembers} · {t.chat.memberCount(data?.other?.participantCount ?? 0)}</h3>
                  <ul className="grid gap-1">
                    {groupMembers.map((member) => (
                      <li key={member.id} className="flex items-center gap-1 rounded-xl">
                        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-2 text-start hover:bg-muted" onClick={async () => {
                          if (!member.username) return
                          try {
                            const result = await chatRequest<{ id: number }>('/api/conversations', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ username: member.username }),
                            })
                            setInfoOpen(false)
                            onOpenConversation(result.id)
                          } catch {
                            setSendError(t.errors.GENERIC)
                          }
                        }}>
                          <UserAvatar name={member.name} image={member.image} className="size-10" />
                          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{member.name}</span><span className="block truncate text-xs text-muted-foreground" dir="ltr">@{member.username}</span></span>
                          {member.role === 'admin' && <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] text-primary">{t.chat.adminRole}</span>}
                          <span className="hidden text-xs text-primary sm:inline">{t.chat.openContactChat}</span>
                        </button>
                        {isGroupAdmin && <div className="relative shrink-0" data-group-member-menu>
                          <Button type="button" variant="ghost" size="icon" disabled={groupMemberBusy !== null} aria-label={t.chat.manageMember} onClick={() => setGroupMemberMenuId((current) => current === member.id ? null : member.id)}><MoreHorizontal /></Button>
                          {groupMemberMenuId === member.id && <div className="absolute end-0 top-full z-20 min-w-52 rounded-xl border bg-popover p-1.5 shadow-xl">
                            <button type="button" className="flex w-full items-center rounded-lg px-3 py-2 text-start text-sm hover:bg-muted disabled:opacity-60" disabled={groupMemberBusy !== null} onClick={() => void manageGroupMember(member, member.role === 'admin' ? 'demote' : 'promote')}>{member.role === 'admin' ? t.chat.removeGroupAdmin : t.chat.makeGroupAdmin}</button>
                            <button type="button" className="flex w-full items-center rounded-lg px-3 py-2 text-start text-sm text-destructive hover:bg-destructive/10 disabled:opacity-60" disabled={groupMemberBusy !== null} onClick={() => void manageGroupMember(member, 'remove')}>{t.chat.removeGroupMember}</button>
                          </div>}
                        </div>}
                      </li>
                    ))}
                  </ul>
                  {((data?.conversation?.groupSettings?.addMembers ?? 'admins') === 'all' || isGroupAdmin) && (
                    <form className="mt-3 grid gap-2 border-t pt-3" onSubmit={(event) => void addGroupMembers(event)}>
                      <label htmlFor="group-member-usernames" className="text-sm font-medium">{t.chat.addMembers}</label>
                      <Input id="group-member-usernames" value={groupMemberDraft} onChange={(event) => setGroupMemberDraft(event.target.value)} placeholder={t.chat.addMembersPrompt} />
                      <Button type="submit" disabled={!groupMemberDraft.trim()}><UserRoundPlus className="me-2 size-4" />{t.chat.addMembers}</Button>
                    </form>
                  )}
                  {((data?.conversation?.groupSettings?.shareInvite ?? 'admins') === 'all' || isGroupAdmin) && (
                    <Button type="button" variant="outline" className="mt-2 w-full" disabled={groupInviteBusy} onClick={() => void shareGroupInvite()}>
                      <Share2 className="me-2 size-4" />{groupInviteBusy ? t.chat.creatingGroupInvite : t.chat.shareGroupInvite}
                    </Button>
                  )}
                  {(isGroupAdmin || data?.conversation?.groupSettings?.editGroup === 'all') && (
                    <form className="mt-4 grid gap-3 border-t pt-4" onSubmit={(event) => void saveGroupSettings(event)}>
                      <h4 className="text-sm font-semibold">{t.chat.groupSettings}</h4>
                      <label className="grid gap-1 text-xs text-muted-foreground">
                        {t.chat.renameGroup}
                        <Input maxLength={50} value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} />
                      </label>
                      {isGroupAdmin && <>
                        <label className="grid gap-1 text-xs text-muted-foreground">
                          {t.chat.addMembersPermission}
                          <select value={groupSettingsDraft.addMembers} onChange={(event) => setGroupSettingsDraft((settings) => ({ ...settings, addMembers: event.target.value as GroupSettings['addMembers'] }))} className="h-10 rounded-xl border bg-muted px-3 text-sm text-foreground"><option value="all">{t.chat.everyone}</option><option value="admins">{t.chat.adminsOnly}</option></select>
                        </label>
                        <label className="grid gap-1 text-xs text-muted-foreground">
                          {t.chat.shareInvitePermission}
                          <select value={groupSettingsDraft.shareInvite} onChange={(event) => setGroupSettingsDraft((settings) => ({ ...settings, shareInvite: event.target.value as GroupSettings['shareInvite'] }))} className="h-10 rounded-xl border bg-muted px-3 text-sm text-foreground"><option value="all">{t.chat.everyone}</option><option value="admins">{t.chat.adminsOnly}</option></select>
                        </label>
                        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={groupSettingsDraft.requireApproval} onChange={(event) => setGroupSettingsDraft((settings) => ({ ...settings, requireApproval: event.target.checked }))} />{t.chat.requireApproval}</label>
                        <label className="grid gap-1 text-xs text-muted-foreground">
                          {t.chat.sendMessagesPermission}
                          <select value={groupSettingsDraft.sendMessages} onChange={(event) => setGroupSettingsDraft((settings) => ({ ...settings, sendMessages: event.target.value as GroupSettings['sendMessages'] }))} className="h-10 rounded-xl border bg-muted px-3 text-sm text-foreground"><option value="all">{t.chat.everyone}</option><option value="admins">{t.chat.adminsOnly}</option></select>
                        </label>
                        <label className="grid gap-1 text-xs text-muted-foreground">
                          {t.chat.editGroupPermission}
                          <select value={groupSettingsDraft.editGroup} onChange={(event) => setGroupSettingsDraft((settings) => ({ ...settings, editGroup: event.target.value as GroupSettings['editGroup'] }))} className="h-10 rounded-xl border bg-muted px-3 text-sm text-foreground"><option value="all">{t.chat.everyone}</option><option value="admins">{t.chat.adminsOnly}</option></select>
                        </label>
                      </>}
                      <Button type="submit" disabled={savingGroupSettings}>{savingGroupSettings ? t.chat.savingGroupSettings : t.chat.saveGroupSettings}</Button>
                    </form>
                  )}
                  {isGroupAdmin && groupRequests.length > 0 && (
                    <div className="mt-4 border-t pt-4">
                      <h4 className="mb-2 text-sm font-semibold">{t.chat.pendingGroupRequests}</h4>
                      <ul className="grid gap-2">
                        {groupRequests.map((request) => <li key={request.id} className="flex items-center gap-2 rounded-xl border p-2">
                          <span className="min-w-0 flex-1 truncate text-sm">{request.profile?.name ?? request.profile?.username ?? t.chat.conversationFallback}</span>
                          <Button type="button" size="sm" onClick={() => void reviewGroupRequest(request.id, 'approve')}>{t.chat.approve}</Button>
                          <Button type="button" size="sm" variant="outline" onClick={() => void reviewGroupRequest(request.id, 'reject')}>{t.chat.reject}</Button>
                        </li>)}
                      </ul>
                    </div>
                  )}
                </section>
              )}

              <section className="px-4 py-4">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Link2 className="size-4 text-primary" />{t.chat.sharedMediaLinksDocs}</h3>
                <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                  {sharedMedia.map((message) => {
                    const url = message.mediaPath ? mediaUrls[message.mediaPath]?.url : undefined
                    const isVideo = message.mediaType?.startsWith('video/') || message.messageType === 'video'
                    const isAudio = message.mediaType?.startsWith('audio/') || message.messageType === 'voice'
                    return (
                      <button key={message.id} type="button" disabled={!url} className="relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted disabled:opacity-50" onClick={() => url && openSharedMedia(url, isAudio ? 'audio' : isVideo ? 'video' : 'image')} aria-label={isAudio ? t.chat.recordVoice : isVideo ? t.chat.videoMessage : t.chat.photoMessage}>
                        {url && !isVideo && !isAudio ? <img src={url} alt="" className="size-full object-cover" loading="lazy" /> : isAudio ? <FileAudio className="size-6" /> : isVideo ? <Video className="size-6" /> : <ImageIcon className="size-6" />}
                      </button>
                    )
                  })}
                </div>
                {sharedLinks.length > 0 && (
                  <div className="mb-3 rounded-xl border p-3">
                    <h4 className="mb-2 text-xs font-medium text-muted-foreground">{t.chat.sharedLinks}</h4>
                    <ul className="grid gap-1">
                      {sharedLinks.map((item, index) => <li key={`${item.messageId}-${index}`}><a href={item.url} target="_blank" rel="noreferrer" className="block truncate text-sm text-primary underline">{item.url}</a></li>)}
                    </ul>
                  </div>
                )}
                {sharedDocuments.length > 0 && (
                  <div className="rounded-xl border p-3">
                    <h4 className="mb-2 text-xs font-medium text-muted-foreground">{t.chat.sharedDocuments}</h4>
                    <ul className="grid gap-1">
                      {sharedDocuments.map((message) => {
                        const url = message.mediaPath ? mediaUrls[message.mediaPath]?.url : undefined
                        return <li key={message.id}><a href={url} download={message.mediaName ?? undefined} className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-muted"><FileText className="size-4 shrink-0 text-primary" /><span className="truncate">{message.mediaName ?? t.chat.document}</span></a></li>
                      })}
                    </ul>
                  </div>
                )}
                {sharedMedia.length === 0 && sharedLinks.length === 0 && sharedDocuments.length === 0 && <p className="text-xs text-muted-foreground">{t.chat.noSharedItems}</p>}
              </section>
            </div>
          </section>
        </div>
      )}

      {mediaViewer && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-black text-white" role="dialog" aria-modal="true" aria-label={mediaViewer.type === 'video' ? t.chat.videoMessage : t.chat.photoMessage}>
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-3">
            <Button type="button" variant="ghost" size="icon" className="text-white hover:bg-white/15" aria-label={t.chat.back} onClick={() => closeChatPage('media-viewer')}><ArrowLeft className="rtl:rotate-180" /></Button>
            <h2 className="font-medium">{mediaViewer.type === 'video' ? t.chat.videoMessage : mediaViewer.type === 'audio' ? t.chat.recordVoice : t.chat.photoMessage}</h2>
          </header>
          <div className="flex min-h-0 flex-1 items-center justify-center p-3 sm:p-6">
            {mediaViewer.type === 'video' ? <video src={mediaViewer.url} controls autoPlay playsInline className="max-h-full max-w-full" /> : mediaViewer.type === 'audio' ? <audio src={mediaViewer.url} controls autoPlay className="w-full max-w-xl" /> : <img src={mediaViewer.url} alt={t.chat.photoMessage} className="max-h-full max-w-full object-contain" />}
          </div>
        </div>
      )}

      {imageModal && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-black text-white" role="dialog" aria-modal="true" aria-label={t.chat.photoMessage}>
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-3">
            <Button type="button" variant="ghost" size="icon" className="text-white hover:bg-white/15" aria-label={t.chat.back} onClick={() => closeChatPage('profile-photo')}><ArrowLeft className="rtl:rotate-180" /></Button>
            <h2 className="font-medium">{t.chat.photoMessage}</h2>
          </header>
          <div className="flex min-h-0 flex-1 items-center justify-center p-3 sm:p-6">
            <img src={imageModal} alt={t.chat.photoMessage} className="max-h-full max-w-full object-contain" />
          </div>
        </div>
      )}

      {forwarding && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background" role="dialog" aria-modal="true" aria-labelledby="forward-dialog-title">
          <section className="flex h-full w-full flex-col">
            <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
              <Button type="button" variant="ghost" size="icon" onClick={() => closeChatPage('forward-message')} aria-label={t.chat.back}><ArrowLeft className="rtl:rotate-180" /></Button>
              <h2 id="forward-dialog-title" className="flex-1 font-semibold">{t.chat.forwardMessage}</h2>
            </header>
            <div className="flex flex-1 flex-col p-4 sm:p-6">
            <label htmlFor="forward-target" className="mb-2 block text-sm">{t.chat.chooseConversation}</label>
            <select id="forward-target" value={forwardTargetId} onChange={(event) => setForwardTargetId(event.target.value ? Number(event.target.value) : '')} className="h-11 w-full rounded-xl border bg-background px-3 text-sm">
              <option value="">{t.chat.chooseConversation}</option>
              {availableConversations.filter((conversation) => conversation.id !== conversationId).map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.otherName}</option>)}
            </select>
            <div className="mt-auto flex justify-end gap-2 pt-6"><Button type="button" variant="outline" onClick={() => closeChatPage('forward-message')}>{t.chat.cancel}</Button><Button type="button" disabled={!forwardTargetId} onClick={() => void forwardMessage()}>{t.chat.forwardMessage}</Button></div>
            </div>
          </section>
        </div>
      )}
    </>
  )
}

