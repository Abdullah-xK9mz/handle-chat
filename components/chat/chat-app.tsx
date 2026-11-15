'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { MessageCircle } from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { cn } from '@/lib/utils'
import { ConversationView } from './conversation-view'
import { Sidebar } from './sidebar'
import {
  fetcher,
  type ConversationSummary,
  type CurrentUser,
} from './types'

export function ChatApp({ currentUser }: { currentUser: CurrentUser }) {
  const { t } = useI18n()
  const [activeId, setActiveId] = useState<number | null>(null)
  const { data, error, isLoading, mutate } = useSWR<{
    conversations: ConversationSummary[]
  }>('/api/conversations', fetcher, { refreshInterval: 3000 })

  const conversations = data?.conversations ?? []
  const active = conversations.find((c) => c.id === activeId) ?? null
  const seenMessagesRef = useRef<Map<number, string> | null>(null)

  useEffect(() => {
    if (!data) return
    const previous = seenMessagesRef.current
    const current = new Map(conversations.map((conversation) => [conversation.id, conversation.lastMessageAt]))
    if (previous && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const enabled = localStorage.getItem('handle.notifications.enabled.v1') === 'true'
      if (enabled && document.visibilityState === 'hidden') {
        for (const conversation of conversations) {
          const before = previous.get(conversation.id)
          if (
            conversation.lastSenderId &&
            conversation.lastSenderId !== currentUser.id &&
            !conversation.isMuted &&
            conversation.lastMessageAt !== before
          ) {
            const body = conversation.lastBody || (conversation.lastMessageType === 'voice'
              ? t.chat.recordVoice
              : conversation.lastMessageType === 'document'
                ? t.chat.document
                : conversation.lastMessageType === 'poll'
                  ? t.chat.poll
                  : conversation.lastMessageType === 'event'
                    ? t.chat.event
                    : conversation.lastMediaType?.startsWith('video/')
                      ? t.chat.videoMessage
                      : conversation.lastMediaType?.startsWith('image/')
                        ? t.chat.photoMessage
                        : t.chat.contact)
            const notification = new Notification(conversation.isGroup ? conversation.groupName ?? conversation.otherName : conversation.otherName, {
              body,
              icon: conversation.isGroup ? undefined : conversation.otherImage ?? undefined,
              tag: `handle-conversation-${conversation.id}`,
            })
            notification.onclick = () => {
              window.focus()
              setActiveId(conversation.id)
              notification.close()
            }
          }
        }
      }
    }
    seenMessagesRef.current = current
  }, [conversations, currentUser.id, data, t.chat])

  function openConversation(id: number) {
    setActiveId(id)
    mutate()
  }

  return (
    <div className="h-dvh w-screen overflow-hidden bg-background">
      <div className="mx-auto flex h-dvh w-full max-w-none overflow-hidden bg-background">
        <aside
          className={cn(
            'w-full flex-col border-e md:flex md:w-80 lg:w-96',
            activeId ? 'hidden' : 'flex',
          )}
        >
          <Sidebar
            currentUser={currentUser}
            conversations={conversations}
            isLoading={isLoading}
            error={error}
            activeId={activeId}
            onSelect={openConversation}
          />
        </aside>

        <main
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col bg-canvas md:flex',
            activeId ? 'flex' : 'hidden',
          )}
        >
          {activeId ? (
            <ConversationView
              key={activeId}
              conversationId={activeId}
              currentUserId={currentUser.id}
              otherUserId={active?.otherUserId}
              fallbackName={active?.otherName}
              fallbackUsername={active?.otherUsername ?? undefined}
              fallbackImage={active?.otherImage ?? undefined}
              onBack={() => setActiveId(null)}
              onActivity={() => mutate()}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
              <div className="flex size-16 items-center justify-center rounded-3xl bg-secondary text-primary">
                <MessageCircle className="size-8" aria-hidden="true" />
              </div>
              <div className="flex flex-col gap-1">
                <h2 className="text-lg font-semibold">{t.chat.emptyTitle}</h2>
                <p className="max-w-xs text-sm text-muted-foreground text-pretty">
                  {t.chat.emptyBody}
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

