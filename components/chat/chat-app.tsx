'use client'

import { useState } from 'react'
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

  function openConversation(id: number) {
    setActiveId(id)
    mutate()
  }

  return (
    <div className="min-h-dvh bg-canvas p-2 sm:p-4 lg:p-6">
      <div className="mx-auto flex h-[calc(100dvh-1rem)] max-w-[1440px] overflow-hidden rounded-xl border bg-background shadow-xl sm:h-[calc(100dvh-2rem)] sm:rounded-2xl lg:h-[calc(100dvh-3rem)]">
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
            'min-w-0 flex-1 flex-col bg-canvas md:flex',
            activeId ? 'flex' : 'hidden',
          )}
        >
          {activeId ? (
            <ConversationView
              key={activeId}
              conversationId={activeId}
              currentUserId={currentUser.id}
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
