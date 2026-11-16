'use client'

import Link from 'next/link'
import { BellOff, CircleDashed, MessageSquareText, MoreHorizontal, Settings, Shield, Trash2, Users } from 'lucide-react'
import { useRef, useState } from 'react'
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
  onDeleteConversation: (id: number) => void
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
  onDeleteConversation,
  section,
  onSectionChange,
}: SidebarProps) {
  const { t, locale } = useI18n()
  const [openActionsId, setOpenActionsId] = useState<number | null>(null)
  const holdTimer = useRef<number | null>(null)
  const longPressTriggered = useRef(false)
  const visibleConversations = conversations.filter((conversation) => section === 'groups' ? conversation.isGroup : !conversation.isGroup)

  function startHold(id: number) {
    longPressTriggered.current = false
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    holdTimer.current = window.setTimeout(() => {
      longPressTriggered.current = true
      setOpenActionsId(id)
    }, 550)
  }

  function clearHold() {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    holdTimer.current = null
  }

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
        {currentUser.isAdmin && (
          <Link
            href="/admin"
            aria-label={t.chat.adminPanel}
            title={t.chat.adminPanel}
            className={buttonVariants({ variant: 'ghost', size: 'icon' })}
          >
            <Shield />
          </Link>
        )}
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
                <li
                  key={c.id}
                  className="group relative"
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setOpenActionsId(c.id)
                  }}
                  onTouchStart={() => startHold(c.id)}
                  onTouchEnd={clearHold}
                  onTouchMove={clearHold}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (longPressTriggered.current) {
                        longPressTriggered.current = false
                        return
                      }
                      setOpenActionsId(null)
                      onSelect(c.id)
                    }}
                    aria-current={isActive ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl p-3 pe-11 text-start transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
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
                  <button
                    type="button"
                    className="absolute end-2 top-1/2 hidden size-8 -translate-y-1/2 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow-sm hover:text-foreground group-hover:flex focus-visible:flex md:flex"
                    aria-label={t.chat.messageActions}
                    title={t.chat.messageActions}
                    onClick={(event) => {
                      event.stopPropagation()
                      setOpenActionsId((open) => open === c.id ? null : c.id)
                    }}
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                  {openActionsId === c.id && (
                    <div className="absolute end-2 top-12 z-30 min-w-48 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start text-xs text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          setOpenActionsId(null)
                          onDeleteConversation(c.id)
                        }}
                      >
                        <Trash2 className="size-3.5" />
                        {t.chat.deleteConversation}
                      </button>
                    </div>
                  )}
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
