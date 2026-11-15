'use client'

import { useRef, useState } from 'react'
import { FileVideo, ImagePlus, SendHorizontal, X } from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { Button } from '@/components/ui/button'

const MAX_LENGTH = 4000

export function MessageComposer({
  onSend,
  error,
}: {
  onSend: (body: string, file: File | null) => Promise<boolean>
  error: string | null
}) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [uploadingMedia, setUploadingMedia] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const canSend = (value.trim().length > 0 || file !== null) && !pending

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
      const ok = await onSend(body, attachment)
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

  return (
    <div className="border-t bg-background px-3 py-3 md:px-4">
      {(localError ?? error) && (
        <p role="alert" className="mx-auto mb-2 max-w-3xl text-xs text-destructive">
          {localError ?? error}
        </p>
      )}
      {uploadingMedia && (
        <p className="mx-auto mb-2 max-w-3xl text-xs text-muted-foreground" role="status">
          {t.chat.uploadingMedia}
        </p>
      )}
      {file && (
        <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-xl border bg-muted/60 px-3 py-2 text-sm">
          {file.type.startsWith('video/') ? (
            <FileVideo className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ImagePlus className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {(file.size / (1024 * 1024)).toFixed(1)} MB
          </span>
          <button
            type="button"
            className="rounded-full p-1 text-muted-foreground hover:bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label={t.chat.removeAttachment}
            onClick={() => setFile(null)}
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      <form
        className="mx-auto flex max-w-3xl items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
          className="sr-only"
          tabIndex={-1}
          aria-label={t.chat.attachMedia}
          onChange={(event) => {
            const selected = event.target.files?.[0] ?? null
            event.target.value = ''
            if (!selected) return
            if (selected.size > 50 * 1024 * 1024) {
              setLocalError(t.errors.MEDIA_TOO_LARGE)
              return
            }
            const supported = [
              'image/jpeg', 'image/png', 'image/webp', 'image/gif',
              'video/mp4', 'video/webm', 'video/quicktime',
            ].includes(selected.type)
            if (!supported) {
              setLocalError(t.errors.INVALID_MEDIA)
              return
            }
            setLocalError(null)
            setFile(selected)
          }}
        />
        <label htmlFor="message" className="sr-only">
          {t.chat.messageLabel}
        </label>
        <textarea
          id="message"
          ref={textareaRef}
          value={value}
          disabled={pending}
          rows={1}
          maxLength={MAX_LENGTH}
          dir="auto"
          placeholder={file ? t.chat.mediaCaptionPlaceholder : t.chat.messagePlaceholder}
          onChange={(e) => {
            setValue(e.target.value)
            resize()
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            e.preventDefault()
            submit()
          }}
          className="max-h-40 min-h-10 flex-1 resize-none rounded-2xl border border-input bg-muted px-4 py-2.5 text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
        />
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          disabled={pending}
          className="size-10 shrink-0 rounded-full"
          aria-label={t.chat.attachMedia}
          title={t.chat.attachMedia}
          onClick={() => fileRef.current?.click()}
        >
          <ImagePlus aria-hidden="true" />
        </Button>
        <Button
          type="submit"
          size="icon-lg"
          disabled={!canSend}
          className="size-10 rounded-full"
          aria-label={t.chat.send}
        >
          <SendHorizontal className="rtl:rotate-180" />
        </Button>
      </form>
    </div>
  )
}

