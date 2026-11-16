'use client'

import Link from 'next/link'
import { BellOff, CircleDashed, MessageSquareText, Settings, Users } from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { LanguageToggle } from '@/components/language-toggle'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { NewChat } from './new-chat'
import {
  formatListTime,
  type ConversationSummary,
  type CurrentUser,
} from './types'
import { UserAvatar } from './user-avatar'
import { StatusStrip } from './status-strip'

export type SidebarSection = 'chats' | 'groups' | 'statuses'

type SidebarProps = {
  currentUser: CurrentUser
  conversations: ConversationSummary[]
  isLoading: boolean
  error: unknown
  activeId: number | null
  onSelect: (id: number) => void
  section: SidebarSection
  onSectionChange: (section: SidebarSection) => void
}

export function Sidebar({
  currentUser,
  conversations,
  isLoading,
  error,
  activeId,
  onSelect,
  section,
  onSectionChange,
}: SidebarProps) {
  const { t, locale } = useI18n()
  const visibleConversations = conversations.filter((conversation) => section === 'groups' ? conversation.isGroup : !conversation.isGroup)

  return (
    <>
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <UserAvatar name={currentUser.name} image={currentUser.image} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{currentUser.name}</p>
          <p className="truncate text-xs text-muted-foreground" dir="ltr">
            <span className="inline-block">@{currentUser.username}</span>
          </p>
          {currentUser.about && <p className="truncate text-[11px] text-muted-foreground">{currentUser.about}</p>}
        </div>
        <LanguageToggle compact />
        <Link
          href="/settings"
          aria-label={t.chat.settings}
          title={t.chat.settings}
          className={buttonVariants({ variant: 'ghost', size: 'icon' })}
        >
          <Settings />
        </Link>
      </header>

      {section !== 'statuses' && <NewChat key={section} initialGroupMode={section === 'groups'} showModeToggle={section === 'chats'} onStarted={onSelect} />}

      <nav
        aria-label={t.chat.conversations}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {section === 'statuses' ? <StatusStrip currentUser={currentUser} fullPage /> : isLoading ? (
          <ul className="flex flex-col gap-1 p-2" aria-hidden="true">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 rounded-xl p-3">
                <span className="size-11 animate-pulse rounded-full bg-muted" />
                <span className="flex flex-1 flex-col gap-2">
                  <span className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                  <span className="h-3 w-3/4 animate-pulse rounded bg-muted" />
                </span>
              </li>
            ))}
          </ul>
        ) : error ? (
          <p className="p-6 text-center text-sm text-destructive">
            {t.chat.loadError}
          </p>
        ) : visibleConversations.length === 0 ? (
          <div className="flex flex-col gap-1 p-6 text-center">
            <p className="text-sm font-medium">{t.chat.noConversations}</p>
            <p className="text-sm text-muted-foreground text-pretty">
              {t.chat.noConversationsBody}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5 p-2">
            {visibleConversations.map((c) => {
              const isActive = c.id === activeId
              const messagePreview = c.lastBody
                ? c.lastBody
                : c.lastMessageType === 'voice'
                  ? t.chat.recordVoice
                  : c.lastMessageType === 'document'
                    ? t.chat.document
                    : c.lastMessageType === 'poll'
                      ? t.chat.poll
                      : c.lastMessageType === 'event'
                        ? t.chat.event
                        : c.lastMessageType === 'contact'
                          ? t.chat.contact
                          : c.lastMessageType === 'location'
                            ? t.chat.location
                : c.lastMediaType?.startsWith('video/')
                  ? t.chat.videoMessage
                  : c.lastMediaType?.startsWith('image/')
                    ? t.chat.photoMessage
                    : t.chat.noMessagesYet
              const preview = c.lastSenderId === currentUser.id && c.lastSenderId
                ? `${t.chat.youPrefix}${messagePreview}`
                : messagePreview
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    aria-current={isActive ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl p-3 text-start transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      isActive && 'bg-accent hover:bg-accent',
                    )}
                  >
                    <UserAvatar
                      name={c.otherName}
                      image={c.otherImage}
                      className="size-11"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-semibold">
                          {c.isGroup && <Users className="me-1 inline size-3.5" aria-hidden="true" />}
                          {c.otherName}
                        </span>
                        <span
                          className={cn(
                            'flex shrink-0 items-center gap-1 text-xs',
                            c.unreadCount > 0
                              ? 'font-medium text-primary'
                              : 'text-muted-foreground',
                          )}
                        >
                          {c.isMuted && <BellOff className="size-3" aria-label={t.chat.muteConversation} />}
                          {formatListTime(c.lastMessageAt, locale)}
                        </span>
                      </span>
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate text-sm text-muted-foreground">
                          {preview}
                        </span>
                        {c.unreadCount > 0 && (
                          <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
                            <span aria-hidden="true">
                              {c.unreadCount.toLocaleString(locale)}
                            </span>
                            <span className="sr-only">
                              {t.chat.unread(c.unreadCount)}
                            </span>
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </nav>
      <nav aria-label={t.chat.tabs.chats} className="grid shrink-0 grid-cols-3 border-t bg-background px-2 pb-[max(0.35rem,env(safe-area-inset-bottom))] pt-1 md:pb-1">
        {([
          ['chats', t.chat.tabs.chats, MessageSquareText],
          ['groups', t.chat.tabs.groups, Users],
          ['statuses', t.chat.tabs.statuses, CircleDashed],
        ] as const).map(([id, label, Icon]) => (
          <button key={id} type="button" onClick={() => onSectionChange(id)} aria-current={section === id ? 'page' : undefined} className={cn('flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl text-[11px] text-muted-foreground transition-colors hover:bg-muted', section === id && 'bg-primary/10 font-semibold text-primary')}>
            <Icon className="size-5" aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </>
  )
}
