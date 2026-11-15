'use client'

import { useRef, useState } from 'react'
import { SendHorizontal } from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { Button } from '@/components/ui/button'

const MAX_LENGTH = 4000

export function MessageComposer({
  onSend,
  error,
}: {
  onSend: (body: string) => Promise<boolean>
  error: string | null
}) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const canSend = value.trim().length > 0 && !pending

  function resize() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  async function submit() {
    const body = value.trim()
    if (!body || pending) return
    setPending(true)
    setValue('')
    requestAnimationFrame(resize)
    try {
      const ok = await onSend(body)
      if (!ok) setValue(body)
    } finally {
      setPending(false)
      textareaRef.current?.focus()
    }
  }

  return (
    <div className="border-t bg-background px-3 py-3 md:px-4">
      {error && (
        <p role="alert" className="mx-auto mb-2 max-w-3xl text-xs text-destructive">
          {error}
        </p>
      )}
      <form
        className="mx-auto flex max-w-3xl items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
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
          placeholder={t.chat.messagePlaceholder}
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
