'use client'

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowLeft, LoaderCircle, Send, Sparkles, Trash2, X } from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { edgeRequest } from '@/lib/supabase'

type AiMessage = {
  id: number | string
  role: 'user' | 'assistant'
  body: string
  pending?: boolean
  failed?: boolean
}

type HordeChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
type HordeChunk = { choices?: Array<{ delta?: { content?: string | null } }> }

const HORDE_CHAT_URL = 'https://oai.aihorde.net/v1/chat/completions'
const HORDE_GUEST_KEY = '0000000000'
const HORDE_MODEL = 'koboldcpp/Llama-3.2-3B-Instruct'
const MAX_QUESTION_LENGTH = 2000
const GENERAL_ASSISTANT_INSTRUCTIONS = [
  'You are Message’s general text assistant. Answer general-knowledge questions, explain everyday topics, and help with simple translations in the language the user used.',
  'This assistant is text-only and for general questions. Do not write or debug code, create websites or apps, or generate images. Briefly explain that those tasks are not available here if asked.',
  'You have no web-search tool. Do not claim you searched the internet or know breaking news. If a question depends on current events or you are uncertain, say so clearly.',
  'Keep answers concise, usually one to three short sentences.',
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
      max_tokens: 384,
      temperature: 0.6,
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

export function GeneralAssistant({ onBack, userId }: { onBack: () => void; userId: string }) {
  const { t } = useI18n()
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [draft, setDraft] = useState('')
  const [historyLoading, setHistoryLoading] = useState(true)
  const [hasMoreHistory, setHasMoreHistory] = useState(false)
  const [olderHistoryLoading, setOlderHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const historySaveRef = useRef<Promise<void>>(Promise.resolve())
  const preserveScrollRef = useRef(false)

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

  function queueHistorySave(userMessage: string, assistantMessage: string) {
    historySaveRef.current = historySaveRef.current
      .then(() => edgeRequest({ action: 'save-general-ai-exchange', userMessage, assistantMessage }))
      .then(() => undefined)
      .catch(() => setSaveError(true))
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
    const previousHistory = messages
      .filter((message) => !message.pending && !message.failed)
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.body }))

    setMessages((current) => [
      ...current,
      { id: userId, role: 'user', body: question },
      { id: answerId, role: 'assistant', body: '', pending: true },
    ])
    setBusy(true)

    try {
      const answer = await streamHordeAnswer(
        [...previousHistory, { role: 'user', content: question }],
        (body) => setMessages((current) => current.map((message) => message.id === answerId ? { ...message, body } : message)),
        controller.signal,
      )
      setMessages((current) => current.map((message) => message.id === answerId ? { ...message, body: answer, pending: false } : message))
      queueHistorySave(question, answer)
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
      setSaveError(false)
      setHistoryError(false)
    } catch {
      setSaveError(true)
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t.chat.ai.title}>
      <header className="flex shrink-0 items-center gap-3 border-b bg-background px-3 py-2.5 md:px-5">
        <Button type="button" variant="ghost" size="icon" onClick={onBack} className="md:hidden" aria-label={t.chat.back}>
          <ArrowLeft className="size-5 rtl:rotate-180" />
        </Button>
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{t.chat.ai.title}</h1>
          <p className="truncate text-xs text-muted-foreground">{t.chat.ai.subtitle}</p>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={() => void clearHistory()} disabled={busy || messages.length === 0} aria-label={t.chat.ai.clear} title={t.chat.ai.clear}>
          <Trash2 className="size-4" />
        </Button>
      </header>

      <aside className="flex shrink-0 flex-col gap-1 border-b bg-background/70 px-4 py-2 text-[11px] leading-relaxed text-muted-foreground md:px-6">
        <p>{t.chat.ai.privacy}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span>{t.chat.ai.noExtraAccount}</span>
          <a href="https://aihorde.net/privacy/" target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">{t.chat.ai.privacyLink}</a>
        </div>
      </aside>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6" role="log" aria-live="polite" aria-relevant="additions text">
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
              <div key={message.id} className={cn('flex w-full', message.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={cn(
                  'max-w-[min(88%,42rem)] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm',
                  message.role === 'user' ? 'rounded-ee-md bg-primary text-primary-foreground' : 'rounded-es-md border bg-background text-foreground',
                  message.failed && 'border-destructive/40 text-destructive',
                )}>
                  {message.body || (message.pending ? <span className="inline-flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{t.chat.ai.thinking}</span> : null)}
                </div>
              </div>
            ))}
            {historyError && <p role="status" className="text-center text-xs text-destructive">{t.chat.ai.loadError}</p>}
            {saveError && <p role="status" className="text-center text-xs text-destructive">{t.chat.ai.saveError}</p>}
          </div>
        )}
      </div>

      <form onSubmit={(event) => void sendQuestion(event)} className="flex shrink-0 items-end gap-2 border-t bg-background px-3 py-2.5 pb-[max(0.65rem,env(safe-area-inset-bottom))] md:px-5 md:pb-3">
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
      </form>
    </section>
  )
}
