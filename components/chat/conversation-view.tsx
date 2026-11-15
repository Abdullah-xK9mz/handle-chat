'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { ArrowLeft, Check, CheckCheck, Clock } from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { Button } from '@/components/ui/button'
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
} from './types'
import { UserAvatar } from './user-avatar'

type ConversationViewProps = {
  conversationId: number
  currentUserId: string
  fallbackName?: string
  fallbackUsername?: string
  fallbackImage?: string
  onBack: () => void
  onActivity: () => void
}

export function ConversationView({
  conversationId,
  currentUserId,
  fallbackName,
  fallbackUsername,
  fallbackImage,
  onBack,
  onActivity,
}: ConversationViewProps) {
  const { t, locale } = useI18n()
  const key = `/api/conversations/${conversationId}/messages`
  const { data, error, mutate } = useSWR<ConversationDetail>(key, fetcher, {
    refreshInterval: 2000,
  })
  const [sendError, setSendError] = useState<string | null>(null)
  const [mediaUrls, setMediaUrls] = useState<Record<string, { url: string; expiresAt: number }>>({})
  const bottomRef = useRef<HTMLDivElement>(null)
  const loadingMediaRef = useRef(new Set<string>())

  const messages = data?.messages ?? []
  const lastId = messages.at(-1)?.id
  const name =
    data?.other?.name ?? fallbackName ?? t.chat.conversationFallback
  const username = data?.other?.username ?? fallbackUsername
  const image = data?.other?.image ?? fallbackImage
  const otherReadAt = data?.otherLastReadAt
    ? new Date(data.otherLastReadAt).getTime()
    : 0

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

  async function handleSend(body: string, file: File | null) {
    setSendError(null)
    const optimistic: ChatMessage = {
      id: -Date.now(),
      senderId: currentUserId,
      body,
      createdAt: new Date().toISOString(),
      mediaType: file?.type ?? null,
      mediaName: file?.name ?? null,
      pending: true,
    }

    try {
      await mutate(
        async (current) => {
          const message = file
            ? await sendChatMedia<ChatMessage>(conversationId, file, body)
            : (
                await chatRequest<{ message: ChatMessage }>(key, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ body }),
                })
              ).message
          const base = current ?? {
            other: null,
            otherLastReadAt: null,
            messages: [],
          }
          return { ...base, messages: [...base.messages, message] }
        },
        {
          optimisticData: (current) => ({
            other: current?.other ?? null,
            otherLastReadAt: current?.otherLastReadAt ?? null,
            messages: [...(current?.messages ?? []), optimistic],
          }),
          rollbackOnError: true,
          populateCache: true,
          revalidate: false,
        },
      )
      onActivity()
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
          {username && (
            <p className="truncate text-xs text-muted-foreground" dir="ltr">
              <span className="inline-block">@{username}</span>
            </p>
          )}
        </div>
      </header>

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
                    className={cn(
                      'flex',
                      mine ? 'justify-end' : 'justify-start',
                      !groupedWithPrev && 'mt-2',
                    )}
                  >
                    <div
                      className={cn(
                        'max-w-[80%] rounded-2xl px-3 py-1.5 shadow-xs md:max-w-[65%]',
                        mine
                          ? 'bg-bubble-out text-bubble-out-foreground'
                          : 'bg-bubble-in text-bubble-in-foreground',
                        !groupedWithPrev &&
                          (mine ? 'rounded-se-md' : 'rounded-ss-md'),
                      )}
                    >
                      {message.mediaType && (
                        <div className="mb-1 min-w-44 overflow-hidden rounded-xl">
                          {message.mediaPath && mediaUrls[message.mediaPath] ? (
                            message.mediaType.startsWith('video/') ? (
                              <video
                                src={mediaUrls[message.mediaPath].url}
                                controls
                                playsInline
                                preload="metadata"
                                className="max-h-80 max-w-full bg-black"
                                aria-label={message.mediaName ?? t.chat.videoMessage}
                              />
                            ) : (
                              <a
                                href={mediaUrls[message.mediaPath].url}
                                target="_blank"
                                rel="noreferrer"
                                className="block"
                              >
                                <img
                                  src={mediaUrls[message.mediaPath].url}
                                  alt={message.mediaName ?? t.chat.photoMessage}
                                  loading="lazy"
                                  className="max-h-80 max-w-full object-contain"
                                />
                              </a>
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
                      {message.body && (
                        <p
                          dir="auto"
                          className="text-sm leading-relaxed break-words whitespace-pre-wrap"
                        >
                          {message.body}
                        </p>
                      )}
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
                              className="size-3.5"
                              aria-label={t.chat.read}
                            />
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

      <MessageComposer onSend={handleSend} error={sendError} />
    </>
  )
}

