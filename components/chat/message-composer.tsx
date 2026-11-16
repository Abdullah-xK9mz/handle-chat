'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  CalendarPlus,
  FileText,
  ImagePlus,
  ListPlus,
  MapPin,
  Mic,
  Plus,
  SendHorizontal,
  StopCircle,
  UserRound,
  Reply,
  X,
} from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { Button } from '@/components/ui/button'
import type { ChatMessage } from './types'

const MAX_LENGTH = 4000
const MAX_FILE_SIZE = 50 * 1024 * 1024
const SUPPORTED_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav',
  'application/pdf', 'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]

type StructuredType = 'location' | 'contact' | 'poll' | 'event'

export function MessageComposer({
  onSend,
  onSendStructured,
  replyMessage,
  onCancelReply,
  error,
}: {
  onSend: (body: string, file: File | null, replyToId?: number) => Promise<boolean>
  onSendStructured: (type: StructuredType, payload: Record<string, unknown>) => Promise<boolean>
  replyMessage: ChatMessage | null
  onCancelReply: () => void
  error: string | null
}) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [uploadingMedia, setUploadingMedia] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialogType, setDialogType] = useState<StructuredType | null>(null)
  const [recording, setRecording] = useState(false)
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [pollQuestion, setPollQuestion] = useState('')
  const [pollOptions, setPollOptions] = useState(['', ''])
  const [eventTitle, setEventTitle] = useState('')
  const [eventTime, setEventTime] = useState('')
  const [eventLocation, setEventLocation] = useState('')
  const [eventDetails, setEventDetails] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mediaRef = useRef<HTMLInputElement>(null)
  const documentRef = useRef<HTMLInputElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const canSend = (value.trim().length > 0 || file !== null) && !pending

  useEffect(() => {
    if (!menuOpen) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-attachment-menu], [data-attachment-menu-trigger]')) return
      setMenuOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [menuOpen])

  function resize() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  async function submit() {
    const body = value.trim()
    if ((!body && !file) || pending) return
    const attachment = file
    setPending(true)
    setUploadingMedia(Boolean(attachment))
    setValue('')
    setFile(null)
    setLocalError(null)
    requestAnimationFrame(resize)
    try {
      const ok = await onSend(body, attachment, replyMessage?.id)
      if (!ok) {
        setValue(body)
        setFile(attachment)
      }
    } finally {
      setPending(false)
      setUploadingMedia(false)
      textareaRef.current?.focus()
    }
  }

  function handleFile(selected: File | null) {
    if (!selected) return
    if (selected.size > MAX_FILE_SIZE) {
      setLocalError(t.errors.MEDIA_TOO_LARGE)
      return
    }
    if (!SUPPORTED_TYPES.includes(selected.type)) {
      setLocalError(t.errors.INVALID_MEDIA)
      return
    }
    setLocalError(null)
    setFile(selected)
    setMenuOpen(false)
  }

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop()
      setRecording(false)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const supportedMime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
        .find((mime) => MediaRecorder.isTypeSupported(mime))
      const recorder = supportedMime
        ? new MediaRecorder(stream, { mimeType: supportedMime })
        : new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const mime = recorder.mimeType.split(';')[0] || 'audio/webm'
        const extension = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm'
        const blob = new Blob(chunksRef.current, { type: mime })
        if (blob.size) handleFile(new File([blob], `voice-message.${extension}`, { type: mime }))
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        recorderRef.current = null
      }
      recorder.start()
      recorderRef.current = recorder
      setLocalError(null)
      setRecording(true)
    } catch {
      setLocalError(t.errors.MICROPHONE_PERMISSION)
    }
  }

  async function shareLocation() {
    if (!navigator.geolocation) {
      setLocalError(t.errors.LOCATION_PERMISSION)
      return
    }
    setMenuOpen(false)
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        const sent = await onSendStructured('location', {
          latitude: coords.latitude,
          longitude: coords.longitude,
        })
        if (sent) setLocalError(null)
      },
      () => setLocalError(t.errors.LOCATION_PERMISSION),
      { enableHighAccuracy: true, timeout: 15_000 },
    )
  }

  async function submitStructured(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!dialogType || pending) return
    let payload: Record<string, unknown>
    if (dialogType === 'contact') {
      payload = { name: contactName.trim(), phone: contactPhone.trim(), email: contactEmail.trim() }
    } else if (dialogType === 'poll') {
      payload = { question: pollQuestion.trim(), options: pollOptions.map((option) => option.trim()).filter(Boolean) }
    } else {
      payload = {
        title: eventTitle.trim(),
        startsAt: eventTime ? new Date(eventTime).toISOString() : '',
        location: eventLocation.trim(),
        details: eventDetails.trim(),
      }
    }
    setPending(true)
    setLocalError(null)
    try {
      if (await onSendStructured(dialogType, payload)) {
        setDialogType(null)
        setContactName('')
        setContactPhone('')
        setContactEmail('')
        setPollQuestion('')
        setPollOptions(['', ''])
        setEventTitle('')
        setEventTime('')
        setEventLocation('')
        setEventDetails('')
      }
    } finally {
      setPending(false)
    }
  }

  const activeError = localError ?? error

  return (
    <div className="chat-composer border-t bg-background px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4">
      {activeError && <p role="alert" className="mx-auto mb-2 max-w-3xl text-xs text-destructive">{activeError}</p>}
      {uploadingMedia && <p className="mx-auto mb-2 max-w-3xl text-xs text-muted-foreground" role="status">{t.chat.uploadingMedia}</p>}
      {recording && <p className="mx-auto mb-2 max-w-3xl animate-pulse text-xs text-destructive" role="status">● {t.chat.recording}</p>}
      {replyMessage && <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-xl border-s-2 border-primary bg-muted/60 px-3 py-2 text-xs"><Reply className="size-4 shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="font-medium text-primary">{t.chat.replyTo(replyMessage.replySenderName || t.chat.reply)}</p><p className="truncate text-muted-foreground">{replyMessage.deletedAt ? t.chat.replyDeleted : replyMessage.body || replyMessage.mediaName || t.chat.document}</p></div><button type="button" onClick={onCancelReply} className="rounded-full p-1 text-muted-foreground hover:bg-background" aria-label={t.chat.cancel}><X className="size-4" /></button></div>}
      {file && (
        <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-xl border bg-muted/60 px-3 py-2 text-sm">
          {file.type.startsWith('video/') ? <FileText className="size-4 shrink-0 text-muted-foreground" /> : <ImagePlus className="size-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{(file.size / (1024 * 1024)).toFixed(1)} MB</span>
          <button type="button" className="rounded-full p-1 text-muted-foreground hover:bg-background" aria-label={t.chat.removeAttachment} onClick={() => setFile(null)}><X className="size-4" /></button>
        </div>
      )}
      <form className="mx-auto flex max-w-3xl items-end gap-2" onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <input ref={mediaRef} type="file" accept="image/*,video/*,audio/*" className="sr-only" tabIndex={-1} onChange={(event) => { handleFile(event.target.files?.[0] ?? null); event.target.value = '' }} />
        <input ref={documentRef} type="file" accept=".pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,application/pdf,text/plain,text/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation" className="sr-only" tabIndex={-1} onChange={(event) => { handleFile(event.target.files?.[0] ?? null); event.target.value = '' }} />
        <div className="relative shrink-0">
          <Button type="button" variant="outline" size="icon-lg" disabled={pending || recording} className="size-10 rounded-full" aria-label={t.chat.attachmentMenu} title={t.chat.attachmentMenu} data-attachment-menu-trigger onClick={() => setMenuOpen((open) => !open)}><Plus /></Button>
          {menuOpen && (
            <div data-attachment-menu className="absolute bottom-full start-0 z-20 mb-2 grid min-w-52 gap-1 rounded-xl border bg-popover p-2 shadow-xl">
              <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => { setMenuOpen(false); mediaRef.current?.click() }}><ImagePlus className="size-4" />{t.chat.attachMedia}</button>
              <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => { setMenuOpen(false); documentRef.current?.click() }}><FileText className="size-4" />{t.chat.document}</button>
              <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => void shareLocation()}><MapPin className="size-4" />{t.chat.location}</button>
              <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => { setDialogType('contact'); setMenuOpen(false) }}><UserRound className="size-4" />{t.chat.contact}</button>
              <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => { setDialogType('poll'); setMenuOpen(false) }}><ListPlus className="size-4" />{t.chat.poll}</button>
              <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => { setDialogType('event'); setMenuOpen(false) }}><CalendarPlus className="size-4" />{t.chat.event}</button>
            </div>
          )}
        </div>
        <Button type="button" variant={recording ? 'destructive' : 'outline'} size="icon-lg" disabled={pending} className="size-10 shrink-0 rounded-full" aria-label={recording ? t.chat.stopRecording : t.chat.recordVoice} title={recording ? t.chat.stopRecording : t.chat.recordVoice} onClick={() => void toggleRecording()}>
          {recording ? <StopCircle /> : <Mic />}
        </Button>
        <label htmlFor="message" className="sr-only">{t.chat.messageLabel}</label>
        <textarea
          id="message"
          ref={textareaRef}
          value={value}
          disabled={pending || recording}
          rows={1}
          maxLength={MAX_LENGTH}
          dir="auto"
          placeholder={file ? t.chat.mediaCaptionPlaceholder : t.chat.messagePlaceholder}
          onChange={(event) => { setValue(event.target.value); resize() }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
            event.preventDefault()
            void submit()
          }}
          className="max-h-40 min-h-10 flex-1 resize-none rounded-2xl border border-input bg-muted px-4 py-2.5 text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
        />
        <Button type="submit" size="icon-lg" disabled={!canSend} className="size-10 shrink-0 rounded-full" aria-label={t.chat.send}>
          <SendHorizontal className="rtl:rotate-180" />
        </Button>
      </form>

      {dialogType && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-labelledby="structured-title">
          <form onSubmit={(event) => void submitStructured(event)} className="w-full max-w-md rounded-2xl bg-background p-5 shadow-2xl">
            <header className="mb-4 flex items-center gap-2">
              <h2 id="structured-title" className="flex-1 font-semibold">{t.chat[dialogType]}</h2>
              <Button type="button" size="icon" variant="ghost" onClick={() => setDialogType(null)} aria-label={t.chat.back}><X /></Button>
            </header>
            {dialogType === 'contact' ? (
              <div className="grid gap-3">
                <input required value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder={t.chat.contactName} className="h-10 rounded-xl border bg-muted px-3 text-sm" />
                <input value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} placeholder={t.chat.contactPhone} dir="ltr" className="h-10 rounded-xl border bg-muted px-3 text-sm" />
                <input type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} placeholder={t.chat.contactEmail} dir="ltr" className="h-10 rounded-xl border bg-muted px-3 text-sm" />
              </div>
            ) : dialogType === 'poll' ? (
              <div className="grid gap-3">
                <input required value={pollQuestion} onChange={(event) => setPollQuestion(event.target.value)} placeholder={t.chat.pollQuestion} className="h-10 rounded-xl border bg-muted px-3 text-sm" />
                {pollOptions.map((option, index) => (
                  <input key={index} required value={option} onChange={(event) => setPollOptions((current) => current.map((item, i) => i === index ? event.target.value : item))} placeholder={t.chat.pollOption(index + 1)} className="h-10 rounded-xl border bg-muted px-3 text-sm" />
                ))}
                {pollOptions.length < 10 && <Button type="button" variant="outline" onClick={() => setPollOptions((current) => [...current, ''])}>{t.chat.addPollOption}</Button>}
              </div>
            ) : (
              <div className="grid gap-3">
                <input required value={eventTitle} onChange={(event) => setEventTitle(event.target.value)} placeholder={t.chat.eventTitle} className="h-10 rounded-xl border bg-muted px-3 text-sm" />
                <input required type="datetime-local" value={eventTime} onChange={(event) => setEventTime(event.target.value)} aria-label={t.chat.eventTime} className="h-10 rounded-xl border bg-muted px-3 text-sm" />
                <input value={eventLocation} onChange={(event) => setEventLocation(event.target.value)} placeholder={t.chat.eventLocation} className="h-10 rounded-xl border bg-muted px-3 text-sm" />
                <textarea value={eventDetails} onChange={(event) => setEventDetails(event.target.value)} placeholder={t.chat.eventDetails} className="min-h-20 rounded-xl border bg-muted p-3 text-sm" />
              </div>
            )}
            <Button type="submit" disabled={pending} className="mt-4 w-full">{pending ? t.chat.sending : t.chat.send}</Button>
          </form>
        </div>
      )}
    </div>
  )
}

