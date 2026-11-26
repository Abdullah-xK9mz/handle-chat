'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  CalendarPlus,
  Clock,
  FileAudio,
  FileText,
  ImagePlus,
  ListPlus,
  MapPin,
  Mic,
  Plus,
  RotateCw,
  Video,
  SendHorizontal,
  StopCircle,
  UserRound,
  Reply,
  X,
} from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { Button } from '@/components/ui/button'
import { closeChatPage, pushChatPage } from '@/lib/chat-pages'
import { readBooleanPreference, SEND_ON_ENTER_KEY } from '@/lib/chat-preferences'
import { edgeRequest } from '@/lib/supabase'
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
  conversationId,
  onSend,
  onSchedule,
  onRestoreDraftReply,
  onSendStructured,
  replyMessage,
  onCancelReply,
  error,
}: {
  conversationId: number
  onSend: (body: string, file: File | null, replyToId?: number, viewOnce?: boolean) => Promise<boolean>
  onSchedule: (body: string, sendAt: string, replyToId?: number) => Promise<boolean>
  onRestoreDraftReply: (id: number | null) => void
  onSendStructured: (type: StructuredType, payload: Record<string, unknown>) => Promise<boolean>
  replyMessage: ChatMessage | null
  onCancelReply: () => void
  error: string | null
}) {
  const { t, locale } = useI18n()
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [uploadingMedia, setUploadingMedia] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [viewOnce, setViewOnce] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduledFor, setScheduledFor] = useState('')
  const [imageEditOpen, setImageEditOpen] = useState(false)
  const [imageEditFile, setImageEditFile] = useState<File | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)
  const [imageRotation, setImageRotation] = useState(0)
  const [imageAspect, setImageAspect] = useState<'original' | 'square' | 'wide'>('original')
  const [imageQuality, setImageQuality] = useState(82)
  const [draftReady, setDraftReady] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sendOnEnter, setSendOnEnter] = useState(true)
  const [dialogType, setDialogType] = useState<StructuredType | null>(null)
  const [recording, setRecording] = useState(false)
  const [sharingLocation, setSharingLocation] = useState(false)
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
  const recordingGenerationRef = useRef(0)
  const draftLoadGeneration = useRef(0)
  const restoreDraftReplyRef = useRef(onRestoreDraftReply)
  const canSend = (value.trim().length > 0 || file !== null) && !pending

  useEffect(() => {
    restoreDraftReplyRef.current = onRestoreDraftReply
  }, [onRestoreDraftReply])

  useEffect(() => {
    setSendOnEnter(readBooleanPreference(SEND_ON_ENTER_KEY, true))
  }, [])

  useEffect(() => {
    const generation = ++draftLoadGeneration.current
    setDraftReady(false)
    setValue('')
    setViewOnce(false)
    restoreDraftReplyRef.current(null)
    void edgeRequest<{ draft: { body: string; replyTo: number | null } }>({ action: 'get-message-draft', conversationId })
      .then(({ draft }) => {
        if (draftLoadGeneration.current !== generation) return
        setValue(draft.body ?? '')
        restoreDraftReplyRef.current(draft.replyTo == null ? null : Number(draft.replyTo))
      })
      .catch(() => undefined)
      .finally(() => {
        if (draftLoadGeneration.current === generation) setDraftReady(true)
      })
  }, [conversationId])

  useEffect(() => {
    if (!draftReady) return
    const timer = window.setTimeout(() => {
      void edgeRequest({ action: 'save-message-draft', conversationId, body: value, replyToId: replyMessage?.id ?? null }).catch(() => undefined)
    }, 450)
    return () => window.clearTimeout(timer)
  }, [conversationId, draftReady, replyMessage?.id, value])

  useEffect(() => {
    if (!imageEditFile) {
      setImagePreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(imageEditFile)
    setImagePreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [imageEditFile])

  useEffect(() => () => {
    recordingGenerationRef.current += 1
    const recorder = recorderRef.current
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      if (recorder.state !== 'inactive') {
        try { recorder.stop() } catch { /* The recorder may already have stopped. */ }
      }
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    recorderRef.current = null
  }, [])

  useEffect(() => {
    const handlePageBack = (event: PopStateEvent) => {
      const page = event.state && typeof event.state === 'object'
        ? (event.state as { handleChatPage?: string }).handleChatPage
        : undefined
      if (page !== 'structured-message') setDialogType(null)
    }
    window.addEventListener('popstate', handlePageBack)
    return () => window.removeEventListener('popstate', handlePageBack)
  }, [])

  function openStructured(type: StructuredType) {
    setDialogType(type)
    setMenuOpen(false)
    pushChatPage('structured-message')
  }

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
    const sendViewOnce = viewOnce
    setPending(true)
    setUploadingMedia(Boolean(attachment))
    setValue('')
    setFile(null)
    setLocalError(null)
    requestAnimationFrame(resize)
    try {
      const ok = await onSend(body, attachment, replyMessage?.id, sendViewOnce)
      if (!ok) {
        setValue(body)
        setFile(attachment)
        setViewOnce(sendViewOnce)
      } else {
        setViewOnce(false)
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
    setViewOnce(false)
    if (['image/jpeg', 'image/png', 'image/webp'].includes(selected.type)) {
      setImageEditFile(selected)
      setImageRotation(0)
      setImageAspect('original')
      setImageQuality(82)
      setImageEditOpen(true)
    }
    setMenuOpen(false)
  }

  async function applyImageEdits() {
    if (!imageEditFile) return
    try {
      const image = new Image()
      const sourceUrl = URL.createObjectURL(imageEditFile)
      image.src = sourceUrl
      await new Promise<void>((resolve, reject) => { image.onload = () => { URL.revokeObjectURL(sourceUrl); resolve() }; image.onerror = () => { URL.revokeObjectURL(sourceUrl); reject(new Error('image')) } })
      const ratio = imageAspect === 'square' ? 1 : imageAspect === 'wide' ? 16 / 9 : image.width / image.height
      const cropWidth = image.width / image.height > ratio ? image.height * ratio : image.width
      const cropHeight = image.width / image.height > ratio ? image.height : image.width / ratio
      const maxSide = 2560
      const scale = Math.min(1, maxSide / Math.max(cropWidth, cropHeight))
      const source = document.createElement('canvas')
      source.width = Math.max(1, Math.round(cropWidth * scale))
      source.height = Math.max(1, Math.round(cropHeight * scale))
      source.getContext('2d')?.drawImage(image, (image.width - cropWidth) / 2, (image.height - cropHeight) / 2, cropWidth, cropHeight, 0, 0, source.width, source.height)
      const rotated = document.createElement('canvas')
      const quarterTurn = Math.abs(imageRotation) % 180 === 90
      rotated.width = quarterTurn ? source.height : source.width
      rotated.height = quarterTurn ? source.width : source.height
      const context = rotated.getContext('2d')
      if (!context) throw new Error('canvas')
      context.translate(rotated.width / 2, rotated.height / 2)
      context.rotate(imageRotation * Math.PI / 180)
      context.drawImage(source, -source.width / 2, -source.height / 2)
      const blob = await new Promise<Blob>((resolve, reject) => rotated.toBlob((value) => value ? resolve(value) : reject(new Error('image')), 'image/jpeg', imageQuality / 100))
      setFile(new File([blob], imageEditFile.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }))
      setImageEditOpen(false)
    } catch {
      setLocalError(t.errors.INVALID_MEDIA)
    }
  }

  async function scheduleMessage() {
    if (!value.trim() || !scheduledFor || pending || file) return
    const sendAt = new Date(scheduledFor)
    if (!Number.isFinite(sendAt.getTime()) || sendAt.getTime() < Date.now() + 60_000) {
      setLocalError(locale === 'ar' ? 'اختَر موعدًا بعد دقيقة على الأقل.' : 'Choose a time at least one minute from now.')
      return
    }
    setPending(true)
    try {
      if (await onSchedule(value.trim(), sendAt.toISOString(), replyMessage?.id ?? undefined)) {
        setValue('')
        setScheduledFor('')
        setScheduleOpen(false)
        onCancelReply()
      }
    } finally {
      setPending(false)
    }
  }

  function pickAttachment(kind: 'media' | 'document') {
    setMenuOpen(false)
    setLocalError(null)
    if (kind === 'document') {
      documentRef.current?.click()
      return
    }
    // Let Android/iOS open their native photo and video gallery through the
    // browser file input. The APK bridge returns base64 data and stalls on large media.
    mediaRef.current?.click()
  }

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop()
      setRecording(false)
      return
    }
    const generation = ++recordingGenerationRef.current
    let stream: MediaStream | null = null
    try {
      const activeStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream = activeStream
      if (recordingGenerationRef.current !== generation) {
        activeStream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = activeStream
      const supportedMime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
        .find((mime) => MediaRecorder.isTypeSupported(mime))
      const recorder = supportedMime
        ? new MediaRecorder(activeStream, { mimeType: supportedMime })
        : new MediaRecorder(activeStream)
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (recordingGenerationRef.current === generation && event.data.size) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        if (recordingGenerationRef.current === generation) {
          setRecording(false)
          const mime = recorder.mimeType.split(';')[0] || 'audio/webm'
          const extension = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm'
          const blob = new Blob(chunksRef.current, { type: mime })
          if (blob.size) handleFile(new File([blob], `voice-message.${extension}`, { type: mime }))
        }
        activeStream.getTracks().forEach((track) => track.stop())
        if (streamRef.current === activeStream) streamRef.current = null
        if (recorderRef.current === recorder) recorderRef.current = null
      }
      recorder.start()
      recorderRef.current = recorder
      setLocalError(null)
      setRecording(true)
    } catch {
      if (recordingGenerationRef.current === generation) {
        recordingGenerationRef.current += 1
        stream?.getTracks().forEach((track) => track.stop())
        if (streamRef.current === stream) streamRef.current = null
        recorderRef.current = null
        setRecording(false)
        setLocalError(t.errors.MICROPHONE_PERMISSION)
      }
    }
  }

  async function shareLocation() {
    if (!navigator.geolocation) {
      setLocalError(t.errors.LOCATION_PERMISSION)
      return
    }
    setMenuOpen(false)
    setSharingLocation(true)
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const sent = await onSendStructured('location', {
            latitude: coords.latitude,
            longitude: coords.longitude,
          })
          if (sent) setLocalError(null)
        } catch {
          setLocalError(t.errors.GENERIC)
        } finally {
          setSharingLocation(false)
        }
      },
      () => {
        setLocalError(t.errors.LOCATION_PERMISSION)
        setSharingLocation(false)
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 60_000 },
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
        closeChatPage('structured-message')
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
      {scheduleOpen && <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-xl border bg-muted/50 p-2"><Clock className="size-4 shrink-0 text-primary" /><input type="datetime-local" value={scheduledFor} min={(() => { const date = new Date(Date.now() + 60_000); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16) })()} onChange={(event) => setScheduledFor(event.target.value)} aria-label={locale === 'ar' ? 'موعد الإرسال' : 'Send time'} className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2 text-sm" /><Button type="button" size="sm" disabled={!value.trim() || !scheduledFor || pending || Boolean(file)} onClick={() => void scheduleMessage()}>{locale === 'ar' ? 'جدولة' : 'Schedule'}</Button><Button type="button" size="icon" variant="ghost" aria-label={t.chat.cancel} onClick={() => setScheduleOpen(false)}><X className="size-4" /></Button></div>}
      {recording && <p className="mx-auto mb-2 max-w-3xl animate-pulse text-xs text-destructive" role="status">● {t.chat.recording}</p>}
      {replyMessage && <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-xl border-s-2 border-primary bg-muted/60 px-3 py-2 text-xs"><Reply className="size-4 shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="font-medium text-primary">{t.chat.replyTo(replyMessage.replySenderName || t.chat.reply)}</p><p className="truncate text-muted-foreground">{replyMessage.deletedAt ? t.chat.replyDeleted : replyMessage.body || replyMessage.mediaName || t.chat.document}</p></div><button type="button" onClick={onCancelReply} className="rounded-full p-1 text-muted-foreground hover:bg-background" aria-label={t.chat.cancel}><X className="size-4" /></button></div>}
      {file && (
        <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-xl border bg-muted/60 px-3 py-2 text-sm">
          {file.type.startsWith('audio/') ? <FileAudio className="size-4 shrink-0 text-muted-foreground" /> : file.type.startsWith('video/') ? <Video className="size-4 shrink-0 text-muted-foreground" /> : file.type.startsWith('image/') ? <ImagePlus className="size-4 shrink-0 text-muted-foreground" /> : <FileText className="size-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{(file.size / (1024 * 1024)).toFixed(1)} MB</span>
          {file.type.startsWith('image/') && <Button type="button" size="sm" variant="ghost" onClick={() => { setImageEditFile(file); setImageEditOpen(true) }}>{locale === 'ar' ? 'تعديل' : 'Edit'}</Button>}
          {file.type.startsWith('image/') || file.type.startsWith('video/') ? <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={viewOnce} onChange={(event) => setViewOnce(event.target.checked)} className="size-4 accent-primary" />{locale === 'ar' ? 'عرض مرة واحدة' : 'View once'}</label> : null}
          <button type="button" className="rounded-full p-1 text-muted-foreground hover:bg-background" aria-label={t.chat.removeAttachment} onClick={() => { setFile(null); setViewOnce(false) }}><X className="size-4" /></button>
        </div>
      )}
      <form className="mx-auto flex max-w-3xl items-end gap-2" onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <input ref={mediaRef} type="file" accept="image/*,video/*" className="sr-only" tabIndex={-1} onChange={(event) => { handleFile(event.target.files?.[0] ?? null); event.target.value = '' }} />
        <input ref={documentRef} type="file" accept=".pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,application/pdf,text/plain,text/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation" className="sr-only" tabIndex={-1} onChange={(event) => { handleFile(event.target.files?.[0] ?? null); event.target.value = '' }} />
        <div className="relative shrink-0">
          <Button type="button" variant="outline" size="icon-lg" disabled={pending || recording || sharingLocation} className="size-10 rounded-full" aria-label={t.chat.attachmentMenu} title={t.chat.attachmentMenu} data-attachment-menu-trigger onClick={() => setMenuOpen((open) => !open)}><Plus /></Button>
          {menuOpen && (
            <div data-attachment-menu className="absolute bottom-full start-0 z-20 mb-2 grid min-w-52 gap-1 rounded-xl border bg-popover p-2 shadow-xl">
              <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => pickAttachment('media')}><ImagePlus className="size-4" />{t.chat.attachMedia}</button>
              <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => pickAttachment('document')}><FileText className="size-4" />{t.chat.document}</button>
              <button type="button" disabled={sharingLocation} className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted disabled:opacity-60" onClick={() => void shareLocation()}><MapPin className="size-4" />{sharingLocation ? t.chat.gettingLocation : t.chat.location}</button>
              <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => openStructured('contact')}><UserRound className="size-4" />{t.chat.contact}</button>
              <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => openStructured('poll')}><ListPlus className="size-4" />{t.chat.poll}</button>
              <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => openStructured('event')}><CalendarPlus className="size-4" />{t.chat.event}</button>
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
            if (!sendOnEnter || event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
            event.preventDefault()
            void submit()
          }}
          className="max-h-40 min-h-10 flex-1 resize-none rounded-2xl border border-input bg-muted px-4 py-2.5 text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
        />
        <Button type="button" variant={scheduleOpen ? 'default' : 'outline'} size="icon-lg" disabled={!value.trim() || Boolean(file) || pending} className="size-10 shrink-0 rounded-full" aria-label={locale === 'ar' ? 'جدولة الرسالة' : 'Schedule message'} title={locale === 'ar' ? 'جدولة الرسالة' : 'Schedule message'} onClick={() => setScheduleOpen((open) => !open)}><Clock /></Button>
        <Button type="submit" size="icon-lg" disabled={!canSend} className="size-10 shrink-0 rounded-full" aria-label={t.chat.send}>
          <SendHorizontal className="rtl:rotate-180" />
        </Button>
      </form>

      {imageEditOpen && imageEditFile && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-3" role="dialog" aria-modal="true" aria-label={locale === 'ar' ? 'تعديل الصورة' : 'Edit photo'}>
          <section className="flex max-h-[92dvh] w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-2xl border bg-background p-4 shadow-2xl">
            <header className="flex items-center gap-2"><h2 className="flex-1 font-semibold">{locale === 'ar' ? 'تعديل الصورة قبل الإرسال' : 'Edit photo before sending'}</h2><Button type="button" size="icon" variant="ghost" onClick={() => setImageEditOpen(false)} aria-label={t.chat.cancel}><X /></Button></header>
            <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-xl bg-black/80 p-3">{imagePreviewUrl && <img src={imagePreviewUrl} alt="" style={{ transform: `rotate(${imageRotation}deg)`, maxHeight: '48dvh' }} className="max-w-full object-contain" />}</div>
            <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" onClick={() => setImageRotation((rotation) => (rotation + 90) % 360)}><RotateCw className="me-2 size-4" />{locale === 'ar' ? 'تدوير' : 'Rotate'}</Button><select value={imageAspect} onChange={(event) => setImageAspect(event.target.value as typeof imageAspect)} aria-label={locale === 'ar' ? 'قص الصورة' : 'Crop ratio'} className="h-10 rounded-xl border bg-background px-3 text-sm"><option value="original">{locale === 'ar' ? 'الأصلية' : 'Original'}</option><option value="square">1:1</option><option value="wide">16:9</option></select><label className="flex flex-1 items-center gap-2 text-xs text-muted-foreground">{locale === 'ar' ? 'الجودة' : 'Quality'}<input type="range" min="45" max="95" value={imageQuality} onChange={(event) => setImageQuality(Number(event.target.value))} className="min-w-20 flex-1 accent-primary" /><span>{imageQuality}%</span></label></div>
            <footer className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setImageEditOpen(false)}>{t.chat.cancel}</Button><Button type="button" onClick={() => void applyImageEdits()}>{t.chat.saveEdit}</Button></footer>
          </section>
        </div>
      )}

      {dialogType && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background" role="dialog" aria-modal="true" aria-labelledby="structured-title">
          <form onSubmit={(event) => void submitStructured(event)} className="flex min-h-full w-full flex-col overflow-y-auto">
            <header className="sticky top-0 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3">
              <Button type="button" size="icon" variant="ghost" onClick={() => closeChatPage('structured-message')} aria-label={t.chat.back}><ArrowLeft className="rtl:rotate-180" /></Button>
              <h2 id="structured-title" className="flex-1 font-semibold">{t.chat[dialogType]}</h2>
            </header>
            <div className="flex w-full flex-1 flex-col gap-3 p-4 sm:p-6">
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
            <Button type="submit" disabled={pending} className="mt-auto w-full">{pending ? t.chat.sending : t.chat.send}</Button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

