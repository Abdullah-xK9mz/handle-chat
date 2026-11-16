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
  Flag,
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
  const [reportMenuOpen, setReportMenuOpen] = useState(false)
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

  async function reportChat(target: 'person' | 'conversation') {
    const details = window.prompt(t.chat.reportReason)
    setReportMenuOpen(false)
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
        <UserAvatar name={name} image={image} />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{name}</h2>
          {isGroup ? (
            <p className="truncate text-xs text-muted-foreground">
              {t.chat.memberCount(data?.other?.participantCount ?? 0)}
            </p>
          ) : data?.other?.about ? (
            <p className="truncate text-xs text-muted-foreground">{data.other.about}</p>
          ) : username && (
            <p className="truncate text-xs text-muted-foreground" dir="ltr">
              <span className="inline-block">@{username}</span>
            </p>
          )}
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon" onClick={() => { setSearchOpen((open) => !open); setSearchResults([]) }} aria-label={t.chat.searchConversation} title={t.chat.searchConversation}>
            <Search />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => void toggleMute()} aria-label={isMuted ? t.chat.unmuteConversation : t.chat.muteConversation} title={isMuted ? t.chat.unmuteConversation : t.chat.muteConversation}>
            {isMuted ? <BellOff /> : <Bell />}
          </Button>
          {!isGroup && otherUserId && (
            <Button variant="ghost" size="icon" onClick={() => void toggleBlock()} aria-label={isBlockedByMe ? t.chat.unblockPerson : t.chat.blockPerson} title={isBlockedByMe ? t.chat.unblockPerson : t.chat.blockPerson}>
              {isBlockedByMe ? <ShieldCheck /> : <Ban />}
            </Button>
          )}
          <div className="relative">
            <Button variant="ghost" size="icon" onClick={() => setReportMenuOpen((open) => !open)} aria-label={t.chat.reportOptions} title={t.chat.reportOptions}>
              <Flag />
            </Button>
            {reportMenuOpen && (
              <div className="absolute end-0 top-full z-20 mt-1 min-w-48 rounded-xl border bg-popover p-1 shadow-lg">
                {!isGroup && otherUserId && <button type="button" className="w-full rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => void reportChat('person')}>{t.chat.reportPerson}</button>}
                <button type="button" className="w-full rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => void reportChat('conversation')}>{t.chat.reportConversation}</button>
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
          {t.chat.blockedNotice}
        </div>
      )}

      {data?.pinnedMessage && (
        <button type="button" className="flex w-full items-center gap-2 border-b bg-primary/5 px-4 py-2 text-start text-xs hover:bg-primary/10" onClick={() => document.getElementById(`message-${data.pinnedMessage?.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
          <Pin className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span className="font-medium">{t.chat.pinnedMessage}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{data.pinnedMessage.deleted ? t.chat.deletedMessage : data.pinnedMessage.body}</span>
        </button>
      )}
      {actionNotice && <p role="status" className="border-b bg-background px-4 py-1.5 text-center text-xs text-muted-foreground">{actionNotice}</p>}

      <div
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-8"
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
              }
              const messageType = message.messageType ?? 'text'
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
                      mine ? 'justify-end' : 'justify-start',
                      !groupedWithPrev && 'mt-2',
                    )}
                    onContextMenu={(event) => {
                      if (message.deletedAt || message.pending) return
                      event.preventDefault()
                      showMessageActions(message.id)
                    }}
                    onTouchStart={() => {
                      if (!message.deletedAt && !message.pending) startMessageHold(message.id)
                    }}
                    onTouchEnd={clearMessageHold}
                    onTouchMove={clearMessageHold}
                  >
                    <div
                      className={cn(
                        'relative max-w-[88%] rounded-2xl px-3 py-1.5 pt-7 shadow-xs md:max-w-[72%]',
                        mine
                          ? 'bg-bubble-out text-bubble-out-foreground'
                          : 'bg-bubble-in text-bubble-in-foreground',
                        !groupedWithPrev &&
                          (mine ? 'rounded-se-md' : 'rounded-ss-md'),
                      )}
                    >
                      {!message.deletedAt && !message.pending && (
                        <>
                          <button
                            type="button"
                            className="absolute end-1 top-1 hidden size-6 items-center justify-center rounded-full bg-background/70 text-muted-foreground hover:bg-background focus-visible:flex md:flex"
                            aria-label={t.chat.messageActions}
                            title={t.chat.messageActions}
                            onClick={() => {
                              if (openMessageActions === message.id) setOpenMessageActions(null)
                              else showMessageActions(message.id)
                            }}
                          >
                            <MoreHorizontal className="size-4" />
                          </button>
                          {openMessageActions === message.id && (
                            <div className={cn('absolute end-1 z-30 grid max-h-[60dvh] min-w-48 gap-0.5 overflow-y-auto rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl', messageMenuAbove ? 'bottom-full mb-2' : 'top-8')}>
                              <button type="button" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs hover:bg-muted" onClick={() => { setReply(message); setOpenMessageActions(null) }}><Reply className="size-3.5" />{t.chat.reply}</button>
                              <button type="button" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs hover:bg-muted" onClick={() => { void copyMessage(message); setOpenMessageActions(null) }}><Copy className="size-3.5" />{t.chat.copyMessage}</button>
                              <button type="button" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs hover:bg-muted" onClick={() => { setForwarding(message); setOpenMessageActions(null) }}><Forward className="size-3.5" />{t.chat.forwardMessage}</button>
                              <button type="button" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs hover:bg-muted" onClick={() => { void runMessageAction('star', message); setOpenMessageActions(null) }}><Star className={cn('size-3.5', message.starredByMe && 'fill-current text-primary')} />{message.starredByMe ? t.chat.unstarMessage : t.chat.starMessage}</button>
                              <button type="button" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs hover:bg-muted" onClick={() => { void runMessageAction('pin', message); setOpenMessageActions(null) }}><Pin className="size-3.5" />{message.pinned ? t.chat.unpinMessage : t.chat.pinMessage}</button>
                              {(mine || isAdmin) && <button type="button" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs text-destructive hover:bg-destructive/10" onClick={() => { void runMessageAction('delete', message); setOpenMessageActions(null) }}><Trash2 className="size-3.5" />{t.chat.deleteMessage}</button>}
                            </div>
                          )}
                        </>
                      )}
                      {message.replyTo && (
                        <button type="button" className="mb-1 w-full rounded-lg border-s-2 border-primary/70 bg-background/50 px-2 py-1 text-start" onClick={() => document.getElementById(`message-${message.replyTo}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
                          <span className="block truncate text-[11px] font-semibold text-primary">{message.replySenderName || t.chat.reply}</span>
                          <span className="block truncate text-xs opacity-75">{message.replyDeleted ? t.chat.replyDeleted : message.replyBody || t.chat.replyDeleted}</span>
                        </button>
                      )}
                      {message.forwardedFrom && <p className="mb-1 flex items-center gap-1 text-[11px] italic opacity-75"><Forward className="size-3" />{t.chat.forwarded}</p>}
                      {message.mediaType && (
                        <div className="mb-1 min-w-44 overflow-hidden rounded-xl">
                          {mediaUrl ? (
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
                              <button type="button" className="block cursor-zoom-in" onClick={() => setImageModal(mediaUrl)} aria-label={t.chat.photoMessage}>
                                <img
                                  src={mediaUrl}
                                  alt={message.mediaName ?? t.chat.photoMessage}
                                  loading="lazy"
                                  className="max-h-80 max-w-full object-contain"
                                />
                              </button>
                            )
                          ) : (
                            <div className="flex min-h-20 items-center justify-center bg-black/5 px-5 py-4 text-xs text-muted-foreground">
                              {message.pending
                                ? t.chat.uploadingMedia
                                : message.mediaType.startsWith('video/')
                                  ? t.chat.videoMessage
                                  : t.chat.photoMessage}
                            </div>
                          )}
                        </div>
                      )}
                      {messageType === 'location' && (
                        <div className="mb-1 rounded-xl bg-background/60 p-3 text-sm">
                          <p className="font-medium">{t.chat.location}</p>
                          <p className="mt-1 text-xs opacity-75">{Number(payload.latitude).toFixed(5)}, {Number(payload.longitude).toFixed(5)}</p>
                          <a className="mt-2 inline-block underline" href={`https://www.google.com/maps?q=${payload.latitude},${payload.longitude}`} target="_blank" rel="noreferrer">{t.chat.openMap}</a>
                        </div>
                      )}
                      {messageType === 'contact' && (
                        <div className="mb-1 min-w-48 rounded-xl bg-background/60 p-3 text-sm">
                          <p className="font-medium">{payload.name}</p>
                          {payload.phone && <p className="mt-1 text-xs" dir="ltr">{payload.phone}</p>}
                          {payload.email && <p className="mt-1 text-xs" dir="ltr">{payload.email}</p>}
                        </div>
                      )}
                      {messageType === 'event' && (
                        <div className="mb-1 min-w-52 rounded-xl bg-background/60 p-3 text-sm">
                          <p className="font-semibold">{payload.title}</p>
                          {payload.startsAt && <time className="mt-1 block text-xs text-muted-foreground">{new Date(payload.startsAt).toLocaleString(locale)}</time>}
                          {payload.location && <p className="mt-1 text-xs">{payload.location}</p>}
                          {payload.details && <p className="mt-2 whitespace-pre-wrap text-xs">{payload.details}</p>}
                        </div>
                      )}
                      {messageType === 'poll' && (
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
                      {message.deletedAt ? (
                        <p className="py-1 text-sm italic opacity-70">{t.chat.deletedMessage}</p>
                      ) : message.body ? (
                        <p
                          dir="auto"
                          className="text-sm leading-relaxed break-words whitespace-pre-wrap"
                        >
                          {message.body}
                        </p>
                      ) : null}
                      <p
                        className={cn(
                          'mt-0.5 flex items-center justify-end gap-1 text-[11px]',
                          mine ? 'opacity-80' : 'text-muted-foreground',
                        )}
                      >
                        <time dateTime={message.createdAt}>
                          {formatMessageTime(message.createdAt, locale)}
                        </time>
                        {mine &&
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
          {t.chat.blockedNotice}
        </div>
      ) : (
        <MessageComposer
          onSend={handleSend}
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

      {imageModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-3" role="dialog" aria-modal="true" aria-label={t.chat.photoMessage} onClick={() => setImageModal(null)}>
          <Button type="button" variant="ghost" size="icon" className="absolute end-3 top-3 text-white hover:bg-white/15" aria-label={t.chat.back} onClick={() => setImageModal(null)}><X /></Button>
          <img src={imageModal} alt={t.chat.photoMessage} className="max-h-[94dvh] max-w-[96vw] object-contain" onClick={(event) => event.stopPropagation()} />
        </div>
      )}

      {forwarding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-labelledby="forward-dialog-title">
          <section className="w-full max-w-sm rounded-2xl bg-background p-5 shadow-2xl">
            <header className="mb-4 flex items-center gap-2"><h2 id="forward-dialog-title" className="flex-1 font-semibold">{t.chat.forwardMessage}</h2><Button type="button" variant="ghost" size="icon" onClick={() => setForwarding(null)} aria-label={t.chat.cancel}><X /></Button></header>
            <label htmlFor="forward-target" className="mb-2 block text-sm">{t.chat.chooseConversation}</label>
            <select id="forward-target" value={forwardTargetId} onChange={(event) => setForwardTargetId(event.target.value ? Number(event.target.value) : '')} className="h-11 w-full rounded-xl border bg-background px-3 text-sm">
              <option value="">{t.chat.chooseConversation}</option>
              {availableConversations.filter((conversation) => conversation.id !== conversationId).map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.otherName}</option>)}
            </select>
            <div className="mt-4 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setForwarding(null)}>{t.chat.cancel}</Button><Button type="button" disabled={!forwardTargetId} onClick={() => void forwardMessage()}>{t.chat.forwardMessage}</Button></div>
          </section>
        </div>
      )}
    </>
  )
}

