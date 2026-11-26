'use client'

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowLeft, Copy, Forward, Info, LoaderCircle, Pin, Reply, Send, Sparkles, Star, Trash2, X } from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { edgeRequest } from '@/lib/supabase'
import type { ConversationSummary } from './types'

type AiMessage = {
  id: number | string
  role: 'user' | 'assistant'
  body: string
  client_id?: string | null
  deleted_at?: string | null
  starred?: boolean
  pinned?: boolean
  reply_to_id?: number | null
  reply_body?: string | null
  pending?: boolean
  failed?: boolean
}

type HordeChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
type HordeChunk = { choices?: Array<{ delta?: { content?: string | null } }> }

const HORDE_CHAT_URL = 'https://oai.aihorde.net/v1/chat/completions'
const HORDE_GUEST_KEY = '0000000000'
const HORDE_MODEL = 'koboldcpp/Qwen3-14B'
const MAX_QUESTION_LENGTH = 2000
const AI_CONTACT_NAME_PREFIX = 'message.ai-contact-name.v1'
const GENERAL_ASSISTANT_INSTRUCTIONS = [
  'You are Message’s helpful AI assistant. Answer questions and help with explanations, writing, translation, brainstorming, math, and coding in the language the user used.',
  'This chat has no live web-search, image, audio, or video generation tools. Do not claim to have used a tool that is unavailable.',
  'You have no web-search tool. Do not claim you searched the internet or know breaking news. If a question depends on current events or you are uncertain, say so clearly.',
  'Give enough detail to solve the request. Keep simple answers short and use clear steps for more complex requests.',
  'Be kind, concise, and age-appropriate. Do not ask for or repeat passwords, account credentials, or other private information.',
].join(' ')

async function streamHordeAnswer(
  history: HordeChatMessage[],
  onText: (text: string) => void,
  signal: AbortSignal,
) {
  const response = await fetch(HORDE_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HORDE_GUEST_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: HORDE_MODEL,
      messages: [{ role: 'system', content: GENERAL_ASSISTANT_INSTRUCTIONS }, ...history],
      max_tokens: 768,
      temperature: 0.4,
      stream: true,
    }),
    signal,
  })

  if (!response.ok) throw new Error(`HORDE_${response.status}`)
  if (!response.body) throw new Error('HORDE_NO_STREAM')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''

  const consumeLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    try {
      const chunk = JSON.parse(payload) as HordeChunk
      const addition = chunk.choices?.[0]?.delta?.content
      if (typeof addition === 'string' && addition) {
        answer += addition
        onText(answer)
      }
    } catch {
      // Ignore non-JSON keep-alive lines from the streaming endpoint.
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) consumeLine(line)
      if (done) break
    }
    if (buffer) consumeLine(buffer)
  } finally {
    reader.releaseLock()
  }

  if (!answer.trim()) throw new Error('HORDE_EMPTY_REPLY')
  return answer.trim()
}

export function GeneralAssistant({ onBack, userId, availableConversations }: { onBack: () => void; userId: string; availableConversations: ConversationSummary[] }) {
  const { t } = useI18n()
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [draft, setDraft] = useState('')
  const [historyLoading, setHistoryLoading] = useState(true)
  const [hasMoreHistory, setHasMoreHistory] = useState(false)
  const [olderHistoryLoading, setOlderHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [replyTo, setReplyTo] = useState<AiMessage | null>(null)
  const [activeMessageId, setActiveMessageId] = useState<number | string | null>(null)
  const [forwarding, setForwarding] = useState<AiMessage | null>(null)
  const [forwardingBusy, setForwardingBusy] = useState(false)
  const [showPrivacyInfo, setShowPrivacyInfo] = useState(false)
  const [showContactInfo, setShowContactInfo] = useState(false)
  const [contactName, setContactName] = useState(t.chat.ai.title)
  const [actionNotice, setActionNotice] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const historySaveRef = useRef<Promise<void>>(Promise.resolve())
  const preserveScrollRef = useRef(false)
  const contactNameKey = `${AI_CONTACT_NAME_PREFIX}:${userId}`

  useEffect(() => {
    try {
      setContactName(window.localStorage.getItem(contactNameKey)?.trim() || t.chat.ai.title)
    } catch {
      setContactName(t.chat.ai.title)
    }
  }, [contactNameKey, t.chat.ai.title])

  useEffect(() => {
    let disposed = false
    void edgeRequest<{ messages: AiMessage[]; hasMore: boolean }>({ action: 'list-general-ai-history' })
      .then(({ messages: saved, hasMore }) => {
        if (!disposed) setMessages(Array.isArray(saved) ? saved : [])
        if (!disposed) setHasMoreHistory(Boolean(hasMore))
      })
      .catch(() => {
        if (!disposed) setHistoryError(true)
      })
      .finally(() => {
        if (!disposed) setHistoryLoading(false)
      })
    return () => {
      disposed = true
      controllerRef.current?.abort()
    }
  }, [userId])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    if (preserveScrollRef.current) {
      preserveScrollRef.current = false
      return
    }
    container.scrollTop = container.scrollHeight
  }, [messages, busy])

  async function loadOlderHistory() {
    const beforeId = Number(messages[0]?.id)
    if (!Number.isSafeInteger(beforeId) || beforeId <= 0 || olderHistoryLoading) return

    setOlderHistoryLoading(true)
    const previousHeight = scrollRef.current?.scrollHeight ?? 0
    try {
      const { messages: older, hasMore } = await edgeRequest<{ messages: AiMessage[]; hasMore: boolean }>({
        action: 'list-general-ai-history',
        beforeId,
      })
      if (older.length) {
        preserveScrollRef.current = true
        setMessages((current) => [...older, ...current])
        requestAnimationFrame(() => {
          const container = scrollRef.current
          if (container) container.scrollTop += container.scrollHeight - previousHeight
        })
      }
      setHasMoreHistory(Boolean(hasMore))
    } catch {
      setHistoryError(true)
    } finally {
      setOlderHistoryLoading(false)
    }
  }

  function queueHistorySave(
    userMessageId: string,
    assistantMessageId: string,
    userMessage: string,
    assistantMessage: string,
    selectedReply: AiMessage | null,
  ) {
    historySaveRef.current = historySaveRef.current
      .then(async () => {
        const { messages: saved } = await edgeRequest<{ messages: AiMessage[] }>({
          action: 'save-general-ai-exchange',
          userMessageId,
          assistantMessageId,
          userMessage,
          assistantMessage,
          replyToId: selectedReply && Number.isSafeInteger(Number(selectedReply.id)) ? Number(selectedReply.id) : null,
          replyBody: selectedReply?.body ?? null,
        })
        const savedByClientId = new Map(saved.flatMap((message) => message.client_id ? [[message.client_id, message] as const] : []))
        setMessages((current) => current.map((message) => {
          const persisted = savedByClientId.get(String(message.id))
          return persisted ? { ...message, ...persisted } : message
        }))
      })
      .then(() => undefined)
      .catch(() => setSaveError(true))
  }

  async function copyMessage(message: AiMessage) {
    if (!message.body || message.pending || message.failed || message.deleted_at) return
    try {
      await navigator.clipboard.writeText(message.body)
      setActionNotice(t.chat.copiedMessage)
      setActiveMessageId(null)
    } catch {
      setSaveError(true)
    }
  }

  async function setMessageFlag(message: AiMessage, flag: 'starred' | 'pinned') {
    const id = Number(message.id)
    if (!Number.isSafeInteger(id) || id <= 0 || message.deleted_at) return
    const value = message[flag] !== true
    try {
      await edgeRequest({ action: 'set-general-ai-message-flags', messageId: id, [flag]: value })
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, [flag]: value } : item))
      setActiveMessageId(null)
    } catch {
      setSaveError(true)
    }
  }

  async function deleteMessage(message: AiMessage) {
    const id = Number(message.id)
    if (!Number.isSafeInteger(id) || id <= 0 || message.deleted_at) return
    try {
      await edgeRequest({ action: 'delete-general-ai-message', messageId: id })
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, deleted_at: new Date().toISOString(), starred: false, pinned: false } : item))
      setActiveMessageId(null)
    } catch {
      setSaveError(true)
    }
  }

  async function forwardMessageTo(conversationId: number) {
    if (!forwarding?.body || forwardingBusy) return
    setForwardingBusy(true)
    try {
      await edgeRequest({ action: 'send-message', conversationId, body: forwarding.body })
      setForwarding(null)
      setActionNotice(t.chat.ai.forwarded)
    } catch {
      setSaveError(true)
    } finally {
      setForwardingBusy(false)
    }
  }

  function renameContact() {
    const nextName = window.prompt(t.chat.ai.renamePrompt, contactName)
    const trimmed = nextName?.trim().slice(0, 40)
    if (!trimmed) return
    setContactName(trimmed)
    try {
      window.localStorage.setItem(contactNameKey, trimmed)
    } catch {
      // The nickname remains available for this mounted session.
    }
  }

  async function sendQuestion(event?: FormEvent) {
    event?.preventDefault()
    const question = draft.trim()
    if (!question || historyLoading || busy || question.length > MAX_QUESTION_LENGTH) return

    setDraft('')
    setHistoryError(false)
    setSaveError(false)
    const userId = crypto.randomUUID()
    const answerId = crypto.randomUUID()
    const controller = new AbortController()
    controllerRef.current = controller
    const selectedReply = replyTo
    const previousHistory = messages
      .filter((message) => !message.pending && !message.failed && !message.deleted_at)
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.body }))
    const replyReference = selectedReply?.body ? `${t.chat.ai.replyContext}: ${selectedReply.body}\n\n` : ''
    const modelQuestion = `${replyReference}${question}`

    setMessages((current) => [
      ...current,
      { id: userId, role: 'user', body: question, reply_to_id: selectedReply && Number.isSafeInteger(Number(selectedReply.id)) ? Number(selectedReply.id) : null, reply_body: selectedReply?.body ?? null },
      { id: answerId, role: 'assistant', body: '', pending: true },
    ])
    setReplyTo(null)
    setBusy(true)

    try {
      const answer = await streamHordeAnswer(
        [...previousHistory, { role: 'user', content: modelQuestion }],
        (body) => setMessages((current) => current.map((message) => message.id === answerId ? { ...message, body } : message)),
        controller.signal,
      )
      setMessages((current) => current.map((message) => message.id === answerId ? { ...message, body: answer, pending: false } : message))
      queueHistorySave(userId, answerId, question, answer, selectedReply)
    } catch {
      if (controller.signal.aborted) {
        setMessages((current) => current.filter((message) => message.id !== answerId))
      } else {
        setMessages((current) => current.map((message) => message.id === answerId ? { ...message, body: t.chat.ai.replyError, pending: false, failed: true } : message))
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      setBusy(false)
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendQuestion()
    }
  }

  async function clearHistory() {
    if (busy || !messages.length || !window.confirm(t.chat.ai.clearConfirm)) return
    try {
      await historySaveRef.current
      await edgeRequest({ action: 'clear-general-ai-history' })
      setMessages([])
      setHasMoreHistory(false)
      setReplyTo(null)
      setActiveMessageId(null)
      setSaveError(false)
      setHistoryError(false)
    } catch {
      setSaveError(true)
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t.chat.ai.title} onClick={() => setActiveMessageId(null)}>
      <header className="flex shrink-0 items-center gap-3 border-b bg-background px-3 py-2.5 md:px-5">
        <Button type="button" variant="ghost" size="icon" onClick={onBack} className="md:hidden" aria-label={t.chat.back}>
          <ArrowLeft className="size-5 rtl:rotate-180" />
        </Button>
        <button type="button" onClick={() => setShowContactInfo(true)} className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-label={t.chat.ai.contactInfo} title={t.chat.ai.contactInfo}>
          <Sparkles className="size-5" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{contactName}</h1>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={() => setShowPrivacyInfo(true)} aria-label={t.chat.ai.privacyTitle} title={t.chat.ai.privacyTitle}>
          <Info className="size-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" onClick={() => void clearHistory()} disabled={busy || messages.length === 0} aria-label={t.chat.ai.clear} title={t.chat.ai.clear}>
          <Trash2 className="size-4" />
        </Button>
      </header>

      <div ref={scrollRef} onClick={() => setActiveMessageId(null)} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6" role="log" aria-live="polite" aria-relevant="additions text">
        {historyLoading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t.chat.loadingMessages}</div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center">
            <div className="flex size-16 items-center justify-center rounded-3xl bg-primary/10 text-primary"><Sparkles className="size-8" aria-hidden="true" /></div>
            <p className="max-w-sm text-sm text-muted-foreground">{t.chat.ai.intro}</p>
            {historyError && <p role="status" className="max-w-sm text-xs text-destructive">{t.chat.ai.loadError}</p>}
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {hasMoreHistory && (
              <div className="flex justify-center">
                <Button type="button" variant="ghost" size="sm" onClick={() => void loadOlderHistory()} disabled={olderHistoryLoading}>
                  {olderHistoryLoading && <LoaderCircle className="size-3.5 animate-spin" />}
                  {t.chat.ai.loadOlder}
                </Button>
              </div>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn('relative flex w-full', message.role === 'user' ? 'justify-end' : 'justify-start')}
                onClick={(event) => { event.stopPropagation(); setActiveMessageId((current) => current === message.id ? null : message.id) }}
                onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setActiveMessageId(message.id) }}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActiveMessageId((current) => current === message.id ? null : message.id) } }}
                tabIndex={0}
                aria-label={t.chat.ai.messageActions}
              >
                <div className={cn(
                  'max-w-[min(88%,42rem)] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm select-none',
                  message.role === 'user' ? 'rounded-ee-md bg-primary text-primary-foreground' : 'rounded-es-md border bg-background text-foreground',
                  message.failed && 'border-destructive/40 text-destructive',
                  message.deleted_at && 'italic text-muted-foreground',
                )}>
                  {message.reply_body && <div className="mb-1 rounded-lg border-s-2 border-primary/70 bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground">{message.reply_body}</div>}
                  {message.deleted_at ? t.chat.deletedMessage : message.body || (message.pending ? <span className="inline-flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{t.chat.ai.thinking}</span> : null)}
                  {(message.starred || message.pinned) && <div className="mt-1 flex justify-end gap-1 opacity-80">{message.pinned && <Pin className="size-3" aria-label={t.chat.pinMessage} />}{message.starred && <Star className="size-3" aria-label={t.chat.starMessage} />}</div>}
                </div>
                {activeMessageId === message.id && !message.pending && !message.failed && !message.deleted_at && (
                  <div className={cn('absolute top-full z-30 mt-1 flex max-w-[min(94vw,24rem)] flex-wrap gap-1 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg', message.role === 'user' ? 'end-1' : 'start-1')} onClick={(event) => event.stopPropagation()}>
                    <button type="button" className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs hover:bg-muted" onClick={() => void copyMessage(message)}><Copy className="size-3.5" />{t.chat.copyMessage}</button>
                    <button type="button" disabled={typeof message.id !== 'number'} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-50" onClick={() => { setReplyTo(message); setActiveMessageId(null) }}><Reply className="size-3.5" />{t.chat.reply}</button>
                    <button type="button" disabled={typeof message.id !== 'number'} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-50" onClick={() => void setMessageFlag(message, 'starred')}><Star className="size-3.5" />{message.starred ? t.chat.unstarMessage : t.chat.starMessage}</button>
                    <button type="button" disabled={typeof message.id !== 'number'} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-50" onClick={() => void setMessageFlag(message, 'pinned')}><Pin className="size-3.5" />{message.pinned ? t.chat.unpinMessage : t.chat.pinMessage}</button>
                    <button type="button" className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs hover:bg-muted" onClick={() => { setForwarding(message); setActiveMessageId(null) }}><Forward className="size-3.5" />{t.chat.forwardMessage}</button>
                    <button type="button" disabled={typeof message.id !== 'number'} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-destructive hover:bg-muted disabled:opacity-50" onClick={() => void deleteMessage(message)}><Trash2 className="size-3.5" />{t.chat.deleteMessage}</button>
                  </div>
                )}
              </div>
            ))}
            {historyError && <p role="status" className="text-center text-xs text-destructive">{t.chat.ai.loadError}</p>}
            {saveError && <p role="status" className="text-center text-xs text-destructive">{t.chat.ai.saveError}</p>}
            {actionNotice && <p role="status" className="text-center text-xs text-muted-foreground">{actionNotice}</p>}
          </div>
        )}
      </div>

      <form onSubmit={(event) => void sendQuestion(event)} className="flex shrink-0 flex-col gap-2 border-t bg-background px-3 py-2.5 pb-[max(0.65rem,env(safe-area-inset-bottom))] md:px-5 md:pb-3">
        {replyTo && <div className="flex items-center gap-2 rounded-xl border-s-2 border-primary bg-muted/60 px-3 py-2 text-xs"><Reply className="size-4 shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate text-muted-foreground">{t.chat.ai.replyContext}: {replyTo.deleted_at ? t.chat.deletedMessage : replyTo.body}</span><button type="button" onClick={() => setReplyTo(null)} className="rounded-full p-1 hover:bg-background" aria-label={t.chat.cancel}><X className="size-4" /></button></div>}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value.slice(0, MAX_QUESTION_LENGTH))}
            onKeyDown={handleComposerKeyDown}
            placeholder={t.chat.ai.placeholder}
            maxLength={MAX_QUESTION_LENGTH}
            rows={1}
            disabled={historyLoading || busy}
            className="max-h-32 min-h-11 flex-1 rounded-2xl border bg-background px-3 py-3 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t.chat.ai.placeholder}
          />
          {busy ? (
            <Button type="button" variant="secondary" size="icon" className="size-11 shrink-0 rounded-full" onClick={() => controllerRef.current?.abort()} aria-label={t.chat.ai.stop} title={t.chat.ai.stop}>
              <X className="size-4" />
            </Button>
          ) : (
            <Button type="submit" size="icon" className="size-11 shrink-0 rounded-full" disabled={historyLoading || !draft.trim()} aria-label={t.chat.ai.send} title={t.chat.ai.send}>
              <Send className="size-4 rtl:rotate-180" />
            </Button>
          )}
        </div>
      </form>

      {forwarding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="ai-forward-title" onClick={() => { if (!forwardingBusy) setForwarding(null) }}>
          <div className="flex max-h-[80vh] w-full max-w-md flex-col gap-3 rounded-2xl border bg-background p-4 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <h2 id="ai-forward-title" className="font-semibold">{t.chat.ai.forwardTitle}</h2>
            <p className="line-clamp-3 rounded-xl bg-muted p-3 text-sm text-muted-foreground">{forwarding.body}</p>
            <div className="min-h-0 overflow-y-auto">
              {availableConversations.map((conversation) => (
                <button key={conversation.id} type="button" disabled={forwardingBusy} onClick={() => void forwardMessageTo(conversation.id)} className="w-full rounded-lg px-3 py-2 text-start text-sm hover:bg-muted disabled:opacity-50">
                  {conversation.isGroup ? conversation.groupName || t.chat.tabs.groups : conversation.otherName}
                </button>
              ))}
              {availableConversations.length === 0 && <p className="p-3 text-sm text-muted-foreground">{t.chat.ai.noForwardConversations}</p>}
            </div>
            <div className="flex justify-end"><Button type="button" variant="outline" onClick={() => setForwarding(null)} disabled={forwardingBusy}>{t.chat.cancel}</Button></div>
          </div>
        </div>
      )}

      {showPrivacyInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="ai-privacy-title" onClick={() => setShowPrivacyInfo(false)}>
          <div className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border bg-background p-4 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <h2 id="ai-privacy-title" className="font-semibold">{t.chat.ai.privacyTitle}</h2>
            <p className="text-sm text-muted-foreground">{t.chat.ai.privacy}</p>
            <div className="flex justify-end"><Button type="button" variant="outline" onClick={() => setShowPrivacyInfo(false)}>{t.chat.cancel}</Button></div>
          </div>
        </div>
      )}

      {showContactInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="ai-contact-title" onClick={() => setShowContactInfo(false)}>
          <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl border bg-background p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex size-20 items-center justify-center rounded-full bg-primary/10 text-primary"><Sparkles className="size-9" aria-hidden="true" /></div>
            <h2 id="ai-contact-title" className="font-semibold">{contactName}</h2>
            <p className="text-sm text-muted-foreground">{t.chat.ai.contactRole}</p>
            <div className="flex w-full justify-end gap-2"><Button type="button" variant="outline" onClick={() => setShowContactInfo(false)}>{t.chat.cancel}</Button><Button type="button" onClick={renameContact}>{t.chat.ai.rename}</Button></div>
          </div>
        </div>
      )}
    </section>
  )
}
