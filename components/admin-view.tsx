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
  accountBan?: { expiresAt: string | null; reason: string } | null
}

type AdminDevice = {
  device_id: string
  last_seen_at: string
  user_agent: string | null
  blockedAt: string | null
  blockReason: string | null
}

type AdminReport = {
  id: number
  reporter_id: string | null
  reported_user_id: string | null
  conversation_id: number | null
  details: string
  status: 'open' | 'reviewed' | 'dismissed'
  created_at: string
  reporter: { username: string; name: string } | null
  reportedUser: { username: string; name: string } | null
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

type AdminMessageRequest = {
  conversationId: number
  requesterId: string
  status: 'pending'
  createdAt: string
  requester: { id: string; username: string; name: string; image: string | null } | null
}

type Props = { currentUserId: string }

export function AdminView({ currentUserId }: Props) {
  const { t, locale } = useI18n()
  const [section, setSection] = useState<'users' | 'conversations' | 'requests' | 'reports'>('users')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [userQuery, setUserQuery] = useState('')
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [draft, setDraft] = useState({ name: '', username: '', image: '', about: '', password: '' })
  const [conversations, setConversations] = useState<AdminConversation[]>([])
  const [messageRequests, setMessageRequests] = useState<AdminMessageRequest[]>([])
  const [selectedRequestId, setSelectedRequestId] = useState<number | null>(null)
  const [selectedConversation, setSelectedConversation] = useState<number | null>(null)
  const [messages, setMessages] = useState<AdminMessage[]>([])
  const [devices, setDevices] = useState<AdminDevice[]>([])
  const [banDuration, setBanDuration] = useState('24')
  const [banReason, setBanReason] = useState('')
  const [reports, setReports] = useState<AdminReport[]>([])
  const [selectedReportId, setSelectedReportId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null
  const selectedReport = reports.find((report) => report.id === selectedReportId) ?? null
  const selectedRequest = messageRequests.find((request) => request.conversationId === selectedRequestId) ?? null
  const openReportCount = reports.filter((report) => report.status === 'open').length
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

  async function loadReports() {
    const result = await edgeRequest<{ reports: AdminReport[] }>({ action: 'admin-list-reports' })
    setReports(result.reports)
  }

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      edgeRequest<{ users: AdminUser[] }>({ action: 'admin-list-users' }),
      edgeRequest<{ conversations: AdminConversation[] }>({ action: 'admin-list-conversations' }),
      edgeRequest<{ reports: AdminReport[] }>({ action: 'admin-list-reports' }),
      edgeRequest<{ requests: AdminMessageRequest[] }>({ action: 'admin-list-message-requests' }),
    ]).then(([userResult, conversationResult, reportResult, requestResult]) => {
      if (cancelled) return
      let failed = false
      if (userResult.status === 'fulfilled') setUsers(userResult.value.users)
      else failed = true
      if (conversationResult.status === 'fulfilled') setConversations(conversationResult.value.conversations)
      else failed = true
      if (reportResult.status === 'fulfilled') setReports(reportResult.value.reports)
      else failed = true
      if (requestResult.status === 'fulfilled') setMessageRequests(requestResult.value.requests)
      else failed = true
      if (failed) setError(t.errors.GENERIC)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [t.errors.GENERIC])

  useEffect(() => {
    if (section !== 'requests') return
    let cancelled = false
    const refresh = () => edgeRequest<{ requests: AdminMessageRequest[] }>({ action: 'admin-list-message-requests' })
      .then((result) => { if (!cancelled) setMessageRequests(result.requests) })
      .catch(() => undefined)
    const timer = window.setInterval(() => { void refresh() }, 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [section])

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      void edgeRequest<{ reports: AdminReport[] }>({ action: 'admin-list-reports' })
        .then((result) => { if (!cancelled) setReports(result.reports) })
        .catch(() => undefined)
      void edgeRequest<{ conversations: AdminConversation[] }>({ action: 'admin-list-conversations' })
        .then((result) => { if (!cancelled) setConversations(result.conversations) })
        .catch(() => undefined)
    }
    const timer = window.setInterval(refresh, 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (!selectedUserId) { setDevices([]); return }
    let cancelled = false
    edgeRequest<{ devices: AdminDevice[] }>({ action: 'admin-list-devices', userId: selectedUserId })
      .then((result) => { if (!cancelled) setDevices(result.devices) })
      .catch(() => { if (!cancelled) setDevices([]) })
    return () => { cancelled = true }
  }, [selectedUserId])

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

  async function selectMessageRequest(request: AdminMessageRequest) {
    setSelectedRequestId(request.conversationId)
    setMessages([])
    setError(null)
    try {
      const result = await edgeRequest<{ messages: AdminMessage[] }>({ action: 'admin-get-messages', conversationId: request.conversationId })
      setMessages(result.messages)
    } catch {
      setError(t.errors.GENERIC)
    }
  }

  async function decideMessageRequest(request: AdminMessageRequest, status: 'accepted' | 'declined') {
    setSaving(true)
    setError(null)
    try {
      await edgeRequest({ action: 'admin-set-message-request', conversationId: request.conversationId, status })
      setMessageRequests((current) => current.filter((item) => item.conversationId !== request.conversationId))
      setSelectedRequestId(null)
      setMessages([])
      if (status === 'accepted') await loadConversations()
      setNotice(t.admin.saved)
    } catch {
      setError(t.errors.GENERIC)
    } finally {
      setSaving(false)
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

  async function setAccountBan(blocked: boolean) {
    if (!selectedUser) return
    setSaving(true)
    setError(null)
    try {
      if (blocked) {
        await edgeRequest({ action: 'admin-set-account-ban', userId: selectedUser.id, duration: banDuration, reason: banReason })
      } else {
        await edgeRequest({ action: 'admin-clear-account-ban', userId: selectedUser.id })
      }
      await loadUsers()
      setNotice(t.admin.saved)
    } catch {
      setError(t.errors.GENERIC)
    } finally {
      setSaving(false)
    }
  }

  async function setDeviceBan(device: AdminDevice) {
    if (!selectedUserId) return
    const blocked = !device.blockedAt
    if (blocked && !window.confirm(t.admin.deviceBlockConfirm)) return
    try {
      await edgeRequest({ action: 'admin-set-device-ban', deviceId: device.device_id, blocked })
      const result = await edgeRequest<{ devices: AdminDevice[] }>({ action: 'admin-list-devices', userId: selectedUserId })
      setDevices(result.devices)
    } catch {
      setError(t.errors.GENERIC)
    }
  }

  async function selectReport(report: AdminReport) {
    setSelectedReportId(report.id)
    setSelectedConversation(report.conversation_id)
    setMessages([])
    if (report.conversation_id === null) return
    try {
      const result = await edgeRequest<{ messages: AdminMessage[] }>({ action: 'admin-get-messages', conversationId: report.conversation_id })
      setMessages(result.messages)
    } catch {
      setError(t.errors.GENERIC)
    }
  }

  async function updateReportStatus(report: AdminReport, status: 'reviewed' | 'dismissed') {
    try {
      await edgeRequest({ action: 'admin-set-report-status', reportId: report.id, status })
      setReports((current) => current.map((item) => item.id === report.id ? { ...item, status } : item))
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

        <nav className="grid grid-cols-4 gap-2 border-b p-3 sm:px-6">
          {(['users', 'conversations', 'requests', 'reports'] as const).map((tab) => (
            <button key={tab} type="button" onClick={() => setSection(tab)} className={`rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${section === tab ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
              {tab === 'requests' ? t.admin.messageRequests : tab === 'conversations' ? t.admin.reportedConversations : tab === 'reports' && openReportCount > 0 ? `${t.admin.reports} · ${openReportCount.toLocaleString(locale)}` : t.admin[tab]}
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
              <div className="max-h-60 overflow-y-auto p-2 md:max-h-none md:flex-1">
                {filteredUsers.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t.admin.noUsers}</p> : filteredUsers.map((user) => (
                  <button key={user.id} type="button" onClick={() => selectUser(user)} className={`flex w-full items-center gap-3 rounded-xl p-3 text-start hover:bg-muted ${selectedUserId === user.id ? 'bg-accent' : ''}`}>
                    <UserAvatar name={user.name} image={user.image} className="size-10" />
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{user.name}</span><span className="block truncate text-xs text-muted-foreground" dir="ltr">@{user.username}</span></span>
                    {user.role === 'admin' && <Shield className="size-4 text-primary" aria-label={t.admin.title} />}
                  </button>
                ))}
              </div>
            </aside>
            <section className="min-h-0 overflow-y-auto p-4 sm:p-6">
              {!selectedUser ? <p className="py-10 text-center text-sm text-muted-foreground">{t.admin.chooseUser}</p> : (
                <form onSubmit={(event) => void saveUser(event)} className="mx-auto flex max-w-xl flex-col gap-4">
                  <div className="mb-2 flex items-center gap-3"><UserAvatar name={draft.name} image={draft.image || null} className="size-14" /><div><p className="font-semibold">{selectedUser.name}</p><p className="text-xs text-muted-foreground">{selectedUser.role === 'admin' ? t.admin.title : t.admin.users}</p></div></div>
                  <label className="grid gap-1.5 text-sm">{t.admin.accountName}<Input required maxLength={50} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                  <label className="grid gap-1.5 text-sm">{t.admin.username}<Input required minLength={3} maxLength={20} dir="ltr" value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} /></label>
                  <label className="grid gap-1.5 text-sm">{t.admin.imageUrl}<Input dir="ltr" value={draft.image} onChange={(event) => setDraft({ ...draft, image: event.target.value })} /></label>
                  <label className="grid gap-1.5 text-sm">{t.admin.about}<Input maxLength={150} value={draft.about} onChange={(event) => setDraft({ ...draft, about: event.target.value })} /></label>
                  <label className="grid gap-1.5 text-sm">{t.admin.password}<Input type="password" minLength={8} maxLength={128} autoComplete="new-password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} /><span className="text-xs text-muted-foreground">{t.admin.passwordHint}</span></label>
                  <div className="flex flex-wrap gap-2 border-t pt-4">
                    <Button type="submit" disabled={saving}>{saving ? t.admin.saving : t.admin.save}</Button>
                    <Button type="button" variant="destructive" disabled={saving || selectedUser.id === currentUserId} onClick={() => void deleteUser(selectedUser)}><Trash2 className="me-2 size-4" />{t.admin.deleteAccount}</Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t.admin.deleteAccountHint}</p>
                  <div className="grid gap-3 rounded-xl border p-4">
                    <h2 className="font-semibold">{t.admin.banAccount}</h2>
                    {selectedUser.accountBan ? (
                      <>
                        <p className="text-sm text-destructive">{t.admin.banActive}{selectedUser.accountBan.expiresAt ? ` · ${t.admin.banUntil} ${new Date(selectedUser.accountBan.expiresAt).toLocaleString(locale)}` : ''}</p>
                        <p className="text-sm text-muted-foreground">{selectedUser.accountBan.reason}</p>
                        <Button type="button" variant="secondary" disabled={saving} onClick={() => void setAccountBan(false)}>{t.admin.liftBan}</Button>
                      </>
                    ) : (
                      <>
                        <label className="grid gap-1.5 text-sm">{t.admin.banDuration}<select className="h-10 rounded-lg border bg-background px-3" value={banDuration} onChange={(event) => setBanDuration(event.target.value)}><option value="1">{t.admin.banOneHour}</option><option value="24">{t.admin.banOneDay}</option><option value="168">{t.admin.banSevenDays}</option><option value="720">{t.admin.banThirtyDays}</option><option value="until_lifted">{t.admin.banUntilLifted}</option></select></label>
                        <label className="grid gap-1.5 text-sm">{t.admin.banReason}<Input maxLength={200} placeholder={t.admin.banReasonPlaceholder} value={banReason} onChange={(event) => setBanReason(event.target.value)} /></label>
                        <Button type="button" variant="secondary" disabled={saving} onClick={() => void setAccountBan(true)}>{t.admin.applyBan}</Button>
                      </>
                    )}
                  </div>
                  <div className="grid gap-3 rounded-xl border p-4">
                    <h2 className="font-semibold">{t.admin.devices}</h2>
                    {devices.length === 0 ? <p className="text-sm text-muted-foreground">{t.admin.noDevices}</p> : devices.map((device) => (
                      <div key={device.device_id} className="flex flex-wrap items-center gap-2 border-t pt-3">
                        <div className="min-w-0 flex-1 overflow-hidden" title={device.device_id}>
                          <p className="max-w-full break-all text-sm leading-5">{device.user_agent || device.device_id.slice(0, 8)}</p>
                          <p className="break-words text-xs text-muted-foreground">{t.admin.deviceSeen}: {new Date(device.last_seen_at).toLocaleString(locale)}</p>
                          <p className={`break-words text-xs ${device.blockedAt ? 'text-destructive' : 'text-muted-foreground'}`}>{device.blockedAt ? t.admin.blockedDevice : t.admin.activeDevice}</p>
                        </div>
                        <Button type="button" size="sm" variant={device.blockedAt ? 'secondary' : 'destructive'} onClick={() => void setDeviceBan(device)}>{device.blockedAt ? t.admin.unblockDevice : t.admin.blockDevice}</Button>
                      </div>
                    ))}
                  </div>
                </form>
              )}
            </section>
          </div>
        ) : section === 'conversations' ? (
          <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(250px,0.8fr)_minmax(0,1.5fr)]">
            <aside className="max-h-64 overflow-y-auto border-b p-2 md:max-h-none md:border-b-0 md:border-e">
              {conversations.length === 0 ? <p className="p-4 text-center text-sm text-muted-foreground">{t.admin.noReportedConversations}</p> : conversations.map((conversation) => <div key={conversation.id} className={`mb-1 flex items-center gap-1 rounded-xl p-2 ${selectedConversation === conversation.id ? 'bg-accent' : 'hover:bg-muted'}`}>
                <button type="button" className="min-w-0 flex-1 p-1 text-start" onClick={() => void selectConversation(conversation.id)}>
                  <span className="block truncate text-sm font-medium">{conversation.name || `${conversation.kind === 'group' ? t.chat.tabs.groups : t.admin.conversations} #${conversation.id}`}</span>
                  <span className="text-xs text-muted-foreground">{conversation.participantCount} · {conversation.messageCount} · {new Date(conversation.lastMessageAt).toLocaleDateString(locale)}</span>
                </button>
                <button type="button" onClick={() => void deleteConversation(conversation)} className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={t.admin.deleteConversation} title={t.admin.deleteConversation}><Trash2 className="size-4" /></button>
              </div>)}
            </aside>
            <section className="min-h-0 overflow-y-auto p-3 sm:p-5">
              {selectedConversation === null ? <p className="py-10 text-center text-sm text-muted-foreground">{t.admin.selectConversation}</p> : messages.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">{t.admin.noMessages}</p> : (
                <ol className="mx-auto flex max-w-3xl flex-col gap-2">
                  {messages.map((message) => <li key={message.id} className="flex items-start gap-3 rounded-xl border bg-card p-3">
                    <div className="min-w-0 flex-1"><p className="mb-1 text-[11px] text-muted-foreground" dir="ltr">{message.senderId.slice(0, 8)} · {new Date(message.createdAt).toLocaleString(locale)}</p><p className="break-words text-sm">{message.deletedAt ? t.chat.deletedMessage : message.body || message.mediaName || message.messageType}</p></div>
                    {!message.deletedAt && <div className="flex shrink-0 gap-1"><button type="button" className="rounded-lg px-2 py-1 text-xs text-primary hover:bg-primary/10" onClick={() => void changeMessage(message, 'pin-message')}>{message.pinned ? t.admin.unpinMessage : t.admin.pinMessage}</button><button type="button" className="rounded-lg px-2 py-1 text-xs text-destructive hover:bg-destructive/10" onClick={() => void changeMessage(message, 'delete-message')}>{t.admin.deleteMessage}</button></div>}
                  </li>)}
                </ol>
              )}
            </section>
          </div>
        ) : section === 'requests' ? (
          <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(250px,0.8fr)_minmax(0,1.5fr)]">
            <aside className="max-h-64 overflow-y-auto border-b p-2 md:max-h-none md:border-b-0 md:border-e">
              {messageRequests.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t.admin.noMessageRequests}</p> : messageRequests.map((request) => (
                <button key={request.conversationId} type="button" onClick={() => void selectMessageRequest(request)} className={`mb-1 flex w-full items-center gap-3 rounded-xl p-3 text-start hover:bg-muted ${selectedRequestId === request.conversationId ? 'bg-accent' : ''}`}>
                  <UserAvatar name={request.requester?.name ?? request.requesterId} image={request.requester?.image ?? null} className="size-10" />
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{request.requester?.name || t.admin.requestFrom}</span><span className="block truncate text-xs text-muted-foreground" dir="ltr">@{request.requester?.username || request.requesterId.slice(0, 8)}</span><span className="text-xs text-muted-foreground">{new Date(request.createdAt).toLocaleDateString(locale)}</span></span>
                </button>
              ))}
            </aside>
            <section className="min-h-0 overflow-y-auto p-3 sm:p-5">
              {!selectedRequest ? <p className="py-10 text-center text-sm text-muted-foreground">{t.admin.noMessageRequests}</p> : (
                <div className="mx-auto grid max-w-3xl gap-4">
                  <div className="flex flex-wrap items-center gap-3 rounded-xl border p-4">
                    <UserAvatar name={selectedRequest.requester?.name ?? selectedRequest.requesterId} image={selectedRequest.requester?.image ?? null} />
                    <div className="min-w-0 flex-1"><p className="font-semibold">{t.admin.requestFrom} {selectedRequest.requester?.name || selectedRequest.requesterId.slice(0, 8)}</p><p className="text-xs text-muted-foreground" dir="ltr">@{selectedRequest.requester?.username || selectedRequest.requesterId}</p></div>
                    <Button type="button" disabled={saving} onClick={() => void decideMessageRequest(selectedRequest, 'accepted')}>{t.admin.acceptRequest}</Button>
                    <Button type="button" variant="secondary" disabled={saving} onClick={() => void decideMessageRequest(selectedRequest, 'declined')}>{t.admin.declineRequest}</Button>
                  </div>
                  {messages.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">{t.admin.noMessages}</p> : <ol className="flex flex-col gap-2">{messages.map((message) => <li key={message.id} className="rounded-xl border bg-card p-3"><p className="mb-1 text-[11px] text-muted-foreground" dir="ltr">{message.senderId === selectedRequest.requesterId ? selectedRequest.requester?.name || message.senderId.slice(0, 8) : t.admin.title} · {new Date(message.createdAt).toLocaleString(locale)}</p><p className="break-words text-sm">{message.deletedAt ? t.chat.deletedMessage : message.body || message.mediaName || message.messageType}</p></li>)}</ol>}
                </div>
              )}
            </section>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.5fr)]">
            <aside className="max-h-64 overflow-y-auto border-b p-2 md:max-h-none md:border-b-0 md:border-e">
              {reports.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t.admin.noReports}</p> : reports.map((report) => (
                <button key={report.id} type="button" onClick={() => void selectReport(report)} className={`mb-1 w-full rounded-xl p-3 text-start hover:bg-muted ${selectedReportId === report.id ? 'bg-accent' : ''}`}>
                  <span className="block truncate text-sm font-medium">{report.reportedUser?.name || (report.conversation_id ? `${t.admin.reportConversation} #${report.conversation_id}` : t.admin.reportPerson)}</span>
                  <span className="block truncate text-xs text-muted-foreground">{t.admin.reportBy}: {report.reporter?.name || report.reporter?.username || '—'} · {new Date(report.created_at).toLocaleDateString(locale)}</span>
                  <span className="text-xs text-primary">{report.status === 'open' ? t.admin.reportOpen : report.status === 'reviewed' ? t.admin.reportReviewed : t.admin.reportDismissed}</span>
                </button>
              ))}
            </aside>
            <section className="min-h-0 overflow-y-auto p-4 sm:p-6">
              {!selectedReport ? <p className="py-10 text-center text-sm text-muted-foreground">{t.admin.noReports}</p> : (
                <div className="mx-auto grid max-w-3xl gap-4">
                  <div className="rounded-xl border p-4">
                    <p className="text-xs text-muted-foreground">{t.admin.reportBy}: {selectedReport.reporter?.name || selectedReport.reporter?.username || '—'}</p>
                    <p className="mt-1 text-sm">{t.admin.reportPerson}: {selectedReport.reportedUser?.name || selectedReport.reportedUser?.username || '—'}</p>
                    {selectedReport.conversation_id && <p className="text-sm">{t.admin.reportConversation}: #{selectedReport.conversation_id}</p>}
                    <p className="mt-3 text-xs font-semibold text-muted-foreground">{t.admin.reportReason}</p>
                    <p className="whitespace-pre-wrap text-sm">{selectedReport.details}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {selectedReport.status !== 'reviewed' && <Button type="button" size="sm" onClick={() => void updateReportStatus(selectedReport, 'reviewed')}>{t.admin.markReviewed}</Button>}
                      {selectedReport.status !== 'dismissed' && <Button type="button" size="sm" variant="secondary" onClick={() => void updateReportStatus(selectedReport, 'dismissed')}>{t.admin.dismissReport}</Button>}
                    </div>
                  </div>
                  {selectedReport.conversation_id !== null && (
                    messages.length === 0 ? <p className="text-center text-sm text-muted-foreground">{t.admin.noMessages}</p> : (
                      <ol className="flex flex-col gap-2">
                        {messages.map((message) => <li key={message.id} className="rounded-xl border bg-card p-3"><p className="mb-1 text-[11px] text-muted-foreground" dir="ltr">{message.senderId.slice(0, 8)} · {new Date(message.createdAt).toLocaleString(locale)}</p><p className="break-words text-sm">{message.deletedAt ? t.chat.deletedMessage : message.body || message.mediaName || message.messageType}</p></li>)}
                      </ol>
                    )
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  )
}

