'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Camera, LogOut, Save } from 'lucide-react'
import { LanguageToggle } from '@/components/language-toggle'
import { UserAvatar } from '@/components/chat/user-avatar'
import { Button, buttonVariants } from '@/components/ui/button'
import { useI18n } from '@/components/i18n-provider'
import {
  edgeRequest,
  signOut as supabaseSignOut,
  SupabaseError,
  uploadAvatar,
  type Profile,
} from '@/lib/supabase'
import { errorMessage } from '@/lib/i18n/dictionaries'

export function SettingsView({
  id,
  name,
  username,
  image,
}: {
  id: string
  name: string
  username: string | null
  image: string | null
}) {
  const router = useRouter()
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState(name)
  const [profileImage, setProfileImage] = useState(image)
  const [photo, setPhoto] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [removePhoto, setRemovePhoto] = useState(false)
  const [saved, setSaved] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const photoRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setNotificationsEnabled(localStorage.getItem('handle.notifications.enabled.v1') === 'true')
  }, [])

  useEffect(() => {
    if (!photo) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(photo)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])

  async function enableNotifications() {
    setError(null)
    if (typeof Notification === 'undefined') {
      setError(t.settings.notificationsDenied)
      return
    }
    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission()
    if (permission !== 'granted') {
      setError(t.settings.notificationsDenied)
      return
    }
    localStorage.setItem('handle.notifications.enabled.v1', 'true')
    setNotificationsEnabled(true)
  }

  async function saveProfile() {
    if (pending) return
    setPending(true)
    setError(null)
    setSaved(false)
    try {
      const avatarPath = photo ? await uploadAvatar(photo, id) : null
      const updated = await edgeRequest<Profile>({
        action: 'update-profile',
        name: displayName,
        avatarPath,
        updateImage: Boolean(photo || removePhoto),
      })
      setDisplayName(updated.name)
      setProfileImage(updated.image)
      setPhoto(null)
      setRemovePhoto(false)
      setSaved(true)
    } catch (err) {
      const code = err instanceof SupabaseError ? err.code : 'GENERIC'
      setError(errorMessage(t, code))
    } finally {
      setPending(false)
    }
  }

  async function signOut() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await supabaseSignOut()
      router.replace('/sign-in')
      router.refresh()
    } catch {
      setError(t.errors.GENERIC)
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="min-h-dvh bg-canvas p-4 sm:p-6">
      <div className="mx-auto max-w-xl">
        <header className="mb-5 flex items-center gap-3">
          <Link
            href="/"
            className={buttonVariants({ variant: 'ghost', size: 'icon' })}
            aria-label={t.settings.back}
          >
            <ArrowLeft className="rtl:rotate-180" />
          </Link>
          <h1 className="flex-1 text-lg font-semibold">{t.settings.title}</h1>
          <LanguageToggle compact />
        </header>

        <section className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
          <div className="flex items-center gap-4">
            <UserAvatar
              name={displayName || name}
              image={preview ?? (removePhoto ? null : profileImage)}
              className="size-14 text-base"
            />
            <div className="min-w-0">
              <h2 className="truncate font-semibold">{displayName || name}</h2>
              {username && (
                <p className="truncate text-sm text-muted-foreground" dir="ltr">
                  <span className="inline-block">@{username}</span>
                </p>
              )}
            </div>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            {t.settings.profileHint}
          </p>
          <input
            ref={photoRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            tabIndex={-1}
            aria-label={t.settings.photo}
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null
              event.target.value = ''
              if (!selected) return
              if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type)) {
                setError(t.errors.INVALID_IMAGE)
                return
              }
              if (selected.size > 5 * 1024 * 1024) {
                setError(t.errors.IMAGE_TOO_LARGE)
                return
              }
              setError(null)
              setSaved(false)
              setRemovePhoto(false)
              setPhoto(selected)
            }}
          />
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              disabled={pending}
              onClick={() => photoRef.current?.click()}
            >
              <Camera aria-hidden="true" />
              {t.settings.changePhoto}
            </Button>
            {(profileImage || photo) && (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setPhoto(null)
                  setRemovePhoto(true)
                  setError(null)
                  setSaved(false)
                }}
              >
                {t.settings.removePhoto}
              </Button>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t.settings.photoHint}</p>
          <label htmlFor="display-name" className="mt-5 block text-sm font-medium">
            {t.settings.name}
          </label>
          <input
            id="display-name"
            value={displayName}
            maxLength={50}
            disabled={pending}
            onChange={(event) => {
              setDisplayName(event.target.value)
              setSaved(false)
            }}
            className="mt-2 h-10 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
          {username && (
            <>
              <label htmlFor="account-username" className="mt-4 block text-sm font-medium">
                {t.settings.username}
              </label>
              <input
                id="account-username"
                value={`@${username}`}
                readOnly
                dir="ltr"
                className="mt-2 h-10 w-full rounded-xl border bg-muted px-3 text-sm text-muted-foreground"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t.settings.usernameHint}
              </p>
            </>
          )}
          <div className="mt-4 flex items-center gap-3">
            <Button
              type="button"
              disabled={pending || !displayName.trim()}
              onClick={saveProfile}
              className="gap-2"
            >
              <Save aria-hidden="true" />
              {pending ? t.settings.saving : t.settings.save}
            </Button>
            {saved && (
              <span role="status" className="text-sm text-muted-foreground">
                {t.settings.saved}
              </span>
            )}
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </section>

        <section className="mt-4 rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
          <h2 className="font-semibold">{t.settings.notifications}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t.settings.notificationsHint}</p>
          <Button type="button" variant="outline" disabled={notificationsEnabled} onClick={() => void enableNotifications()} className="mt-4">
            {notificationsEnabled ? t.settings.notificationsEnabled : t.settings.enableNotifications}
          </Button>
        </section>

        <section className="mt-4 rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
          <h2 className="font-semibold">{t.settings.account}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.settings.accountHint}
          </p>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={signOut}
            className="mt-4 gap-2"
          >
            <LogOut aria-hidden="true" />
            {t.chat.signOut}
          </Button>
        </section>
      </div>
    </main>
  )
}

