'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Search, Shield, Trash2 } from 'lucide-react'
import { UserAvatar } from '@/components/chat/user-avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/components/i18n-provider'
import { edgeRequest } from '@/lib/supabase'

type AdminUser = {
  id: string
  username: string
  name: string
  image: string | null
  about: string
  role: 'user' | 'admin'
}

type AdminConversation = {
  id: number
  kind: 'direct' | 'group'
  name: string | null
  lastMessageAt: string
  participantCount: number
  messageCount: number
}

type AdminMessage = {
  id: number
  senderId: string
  body: string
  createdAt: string
  messageType: string
  deletedAt: string | null
  mediaName: string | null
  pinned: boolean
}

type Props = { currentUserId: string }

export function AdminView({ currentUserId }: Props) {
  const { t, locale } = useI18n()
  const [section, setSection] = useState<'users' | 'conversations'>('users')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [userQuery, setUserQuery] = useState('')
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [draft, setDraft] = useState({ name: '', username: '', image: '', about: '', password: '' })
  const [conversations, setConversations] = useState<AdminConversation[]>([])
  const [selectedConversation, setSelectedConversation] = useState<number | null>(null)
  const [messages, setMessages] = useState<AdminMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null
  const filteredUsers = useMemo(() => {
    const query = userQuery.trim().replace(/^@/, '').toLocaleLowerCase()
    if (!query) return users
    return users.filter((user) => `${user.name} ${user.username}`.toLocaleLowerCase().includes(query))
  }, [userQuery, users])

  async function loadUsers() {
    const result = await edgeRequest<{ users: AdminUser[] }>({ action: 'admin-list-users' })
    setUsers(result.users)
    return result.users
  }

  async function loadConversations() {
    const result = await edgeRequest<{ conversations: AdminConversation[] }>({ action: 'admin-list-conversations' })
    setConversations(result.conversations)
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([
      edgeRequest<{ users: AdminUser[] }>({ action: 'admin-list-users' }),
      edgeRequest<{ conversations: AdminConversation[] }>({ action: 'admin-list-conversations' }),
    ]).then(([userResult, conversationResult]) => {
      if (cancelled) return
      setUsers(userResult.users)
      setConversations(conversationResult.conversations)
    }).catch(() => {
      if (!cancelled) setError(t.errors.GENERIC)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [t.errors.GENERIC])

  function selectUser(user: AdminUser) {
    setSelectedUserId(user.id)
    setDraft({ name: user.name, username: user.username, image: user.image ?? '', about: user.about ?? '', password: '' })
    setError(null)
    setNotice(null)
  }

  async function saveUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedUser) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await edgeRequest({ action: 'admin-update-user', userId: selectedUser.id, ...draft })
      const nextUsers = await loadUsers()
      const updated = nextUsers.find((user) => user.id === selectedUser.id)
      if (updated) selectUser(updated)
      setNotice(t.admin.saved)
    } catch {
      setError(t.errors.GENERIC)
    } finally {
      setSaving(false)
    }
  }

  async function deleteUser(user: AdminUser) {
    if (user.id === currentUserId) {
      setError(t.admin.selfDelete)
      return
    }
    if (!window.confirm(t.admin.deleteUserConfirm)) return
    setSaving(true)
    setError(null)
    try {
      await edgeRequest({ action: 'admin-delete-user', userId: user.id })
      setUsers((current) => current.filter((item) => item.id !== user.id))
      await loadConversations()
      setSelectedUserId(null)
      setNotice(t.admin.saved)
    } catch {
      setError(t.errors.GENERIC)
    } finally {
      setSaving(false)
    }
  }

  async function selectConversation(id: number) {
    setSelectedConversation(id)
    setError(null)
    try {
      const result = await edgeRequest<{ messages: AdminMessage[] }>({ action: 'admin-get-messages', conversationId: id })
      setMessages(result.messages)
    } catch {
      setMessages([])
      setError(t.errors.GENERIC)
    }
  }

  async function changeMessage(message: AdminMessage, action: 'delete-message' | 'pin-message') {
    try {
      await edgeRequest({ action, messageId: message.id, pinned: !message.pinned })
      if (selectedConversation !== null) await selectConversation(selectedConversation)
    } catch {
      setError(t.errors.GENERIC)
    }
  }

  async function deleteConversation(conversation: AdminConversation) {
    if (!window.confirm(t.admin.deleteConversationConfirm)) return
    try {
      await edgeRequest({ action: 'admin-delete-conversation', conversationId: conversation.id })
      setConversations((current) => current.filter((item) => item.id !== conversation.id))
      setSelectedConversation(null)
      setMessages([])
      setNotice(t.admin.saved)
    } catch {
      setError(t.errors.GENERIC)
    }
  }

  return (
    <main className="min-h-dvh bg-canvas p-3 sm:p-6">
      <div className="mx-auto flex min-h-[calc(100dvh-1.5rem)] max-w-7xl flex-col overflow-hidden rounded-2xl border bg-background shadow-xl sm:min-h-[calc(100dvh-3rem)]">
        <header className="flex items-center gap-3 border-b px-4 py-3 sm:px-6">
          <Link href="/" className="flex size-9 items-center justify-center rounded-full hover:bg-muted" aria-label={t.settings.back}>
            <ArrowLeft className="rtl:rotate-180" />
          </Link>
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><Shield className="size-5" /></span>
          <h1 className="flex-1 text-lg font-semibold">{t.admin.title}</h1>
          <span className="hidden text-xs text-muted-foreground sm:inline">{currentUserId.slice(0, 8)}</span>
        </header>

        <nav className="grid grid-cols-2 gap-2 border-b p-3 sm:px-6">
          {(['users', 'conversations'] as const).map((tab) => (
            <button key={tab} type="button" onClick={() => setSection(tab)} className={`rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${section === tab ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
              {t.admin[tab]}
            </button>
          ))}
        </nav>

        {(error || notice) && <p role={error ? 'alert' : 'status'} className={`border-b px-4 py-2 text-sm sm:px-6 ${error ? 'text-destructive' : 'text-primary'}`}>{error || notice}</p>}

        {loading ? <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">…</div> : section === 'users' ? (
          <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(250px,0.8fr)_minmax(0,1.5fr)]">
            <aside className="flex min-h-0 flex-col border-b md:border-b-0 md:border-e">
              <div className="relative border-b p-3">
                <Search className="pointer-events-none absolute start-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={userQuery} onChange={(event) => setUserQuery(event.target.value)} className="h-10 rounded-full ps-10" placeholder={t.admin.searchUsers} />
              </div>
              <div