'use client'

import { useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { ArrowLeft, ArrowRight, Plus, Trash2, X } from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { Button } from '@/components/ui/button'
import { edgeRequest, uploadStatusMedia } from '@/lib/supabase'
import { errorMessage } from '@/lib/i18n/dictionaries'
import { fetcher, type CurrentUser, type StatusEntry } from './types'
import { UserAvatar } from './user-avatar'

export function StatusStrip({ currentUser }: { currentUser: CurrentUser }) {
  const { t } = useI18n()
  const { data, mutate } = useSWR<{ statuses: StatusEntry[] }>('/api/statuses', fetcher, {
    refreshInterval: 15_000,
  })
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<StatusEntry | null>(null)
  const [statusText, setStatusText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewUrl, setViewUrl] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const statuses = data?.statuses ?? []
  const grouped = useMemo(() => {
    const groups = new Map<string, StatusEntry[]>()
    for (const status of [...statuses].reverse()) {
      groups.set(status.userId, [...(groups.get(status.userId) ?? []), status])
    }
    return [...groups.values()].map((items) => items.at(-1)!)
  }, [statuses])

  const viewedList = viewing
    ? statuses.filter((status) => status.userId === viewing.userId).slice().reverse()
    : []
  const viewedIndex = viewing ? viewedList.findIndex((status) => status.id === viewing.id) : -1

  async function publishStatus() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const mediaPath = file ? await uploadStatusMedia(file, currentUser.id) : null
      await edgeRequest({
        action: 'create-status',
        body: statusText,
        mediaPath,
        mediaType: file?.type ?? null,
        mediaName: file?.name ?? null,
      })
      setStatusText('')
      setFile(null)
      setCreating(false)
      await mutate()
    } catch (caught) {
      const code = typeof caught === 'object' && caught && 'code' in caught ? caught.code : 'GENERIC'
      setError(errorMessage(t, code))
    } finally {
      setBusy(false)
    }
  }

  async function openStatus(status: StatusEntry) {
    setViewing(status)
    setViewUrl(null)
    if (!status.mediaPath) return
    try {
      const result = await edgeRequest<{ url: string }>({
        action: 'get-media-url',
        scope: 'status',
        statusId: status.id,
        mediaPath: status.mediaPath,
      })
      setViewUrl(result.url)
    } catch {
      setViewUrl(null)
    }
  }

  async function removeStatus() {
    if (!viewing || viewing.userId !== currentUser.id || busy) return
    setBusy(true)
    try {
      await edgeRequest({ action: 'delete-status', statusId: viewing.id })
      setViewing(null)
      await mutate()
    } finally {
      setBusy(false)
    }
  }

  function moveStatus(direction: -1 | 1) {
    if (!viewing || viewedIndex < 0 || !viewedList.length) return
    const next = viewedList[(viewedIndex + direction + viewedList.length) % viewedList.length]
    void openStatus(next)
  }

  return (
    <>
      <section className="border-b px-3 py-3" aria-label={t.chat.statusTitle}>
        <div className="flex gap-3 overflow-x-auto pb-1">
          <button type="button" className="flex w-16 shrink-0 flex-col items-center gap-1" onClick={() => setCreating(true)}>
            <span className="relative rounded-full border-2 border-dashed border-primary p-0.5">
              <UserAvatar name={currentUser.name} image={currentUser.image} className="size-11" />
              <span className="absolute -bottom-1 -end-1 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Plus className="size-3.5" />
              </span>
            </span>
            <span className="w-full truncate text-center text-[11px]">{t.chat.myStatus}</span>
          </button>
          {grouped.filter((status) => status.userId !== currentUser.id).map((status) => (
            <button key={status.userId} type="button" className="flex w-16 shrink-0 flex-col items-center gap-1" onClick={() => void openStatus(status)}>
              <span className="rounded-full bg-primary p-0.5">
                <span className="block rounded-full border-2 border-background p-0.5">
                  <UserAvatar name={status.name} image={status.image} className="size-10" />
                </span>
              </span>
              <span className="w-full truncate text-center text-[11px]">{status.name}</span>
            </button>
          ))}
        </div>
      </section>

      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="status-dialog-title">
          <section className="w-full max-w-md rounded-2xl bg-background p-5 shadow-2xl">
            <header className="mb-4 flex items-center gap-2">
              <h2 id="status-dialog-title" className="flex-1 font-semibold">{t.chat.addStatus}</h2>
              <Button type="button" variant="ghost" size="icon" onClick={() => setCreating(false)} aria-label={t.chat.back}><X /></Button>
            </header>
            <textarea
              value={statusText}
              maxLength={700}
              onChange={(event) => setStatusText(event.target.value)}
              placeholder={t.chat.statusPlaceholder}
              className="min-h-28 w-full resize-y rounded-xl border bg-muted p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
              className="sr-only"
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null
                event.target.value = ''
                if (selected) setFile(selected)
              }}
            />
            <div className="mt-3 flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>{t.chat.attachMedia}</Button>
              {file && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{file.name}</span>}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t.chat.statusExpires}</p>
            {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
            <Button type="button" className="mt-4 w-full" disabled={busy || (!statusText.trim() && !file)} onClick={() => void publishStatus()}>
              {busy ? t.chat.uploadingMedia : t.chat.publishStatus}
            </Button>
          </section>
        </div>
      )}

      {viewing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black p-3 text-white sm:p-6" role="dialog" aria-modal="true" aria-label={t.chat.statusTitle}>
          <div className="absolute inset-x-0 top-0 flex gap-1 p-3">
            {viewedList.map((status) => <span key={status.id} className={`h-1 flex-1 rounded-full ${status.id === viewing.id ? 'bg-white' : 'bg-white/40'}`} />)}
          </div>
          <header className="absolute inset-x-3 top-6 z-10 flex items-center gap-3 sm:inset-x-6">
            <UserAvatar name={viewing.name} image={viewing.image} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{viewing.name}</span>
            {viewing.userId === currentUser.id && <Button type="button" variant="ghost" size="icon" className="text-white hover:bg-white/15" onClick={() => void removeStatus()} aria-label={t.chat.deleteStatus}><Trash2 /></Button>}
            <Button type="button" variant="ghost" size="icon" className="text-white hover:bg-white/15" onClick={() => setViewing(null)} aria-label={t.chat.back}><X /></Button>
          </header>
          <Button type="button" variant="ghost" size="icon" className="absolute start-2 z-10 text-white hover:bg-white/15" onClick={() => moveStatus(-1)} aria-label={t.chat.previousStatus}><ArrowLeft className="rtl:rotate-180" /></Button>
          <div className="flex max-h-full w-full max-w-2xl flex-col items-center justify-center gap-4 pt-16">
            {viewing.mediaPath && viewUrl && (
              viewing.mediaType?.startsWith('video/')
                ? <video src={viewUrl} controls autoPlay playsInline className="max-h-[70dvh] max-w-full rounded-xl" />
                : <img src={viewUrl} alt={viewing.mediaName ?? t.chat.statusTitle} className="max-h-[70dvh] max-w-full rounded-xl object-contain" />
            )}
            {viewing.body && <p dir="auto" className="max-w-xl whitespace-pre-wrap text-center text-lg">{viewing.body}</p>}
            <time className="text-xs text-white/70">{new Date(viewing.createdAt).toLocaleString()}</time>
          </div>
          <Button type="button" variant="ghost" size="icon" className="absolute end-2 z-10 text-white hover:bg-white/15" onClick={() => moveStatus(1)} aria-label={t.chat.nextStatus}><ArrowRight className="rtl:rotate-180" /></Button>
        </div>
      )}
    </>
  )
}

