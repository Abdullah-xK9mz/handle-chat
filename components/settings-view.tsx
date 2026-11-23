'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Camera, Check, LogOut, QrCode, Save, ScanLine } from 'lucide-react'
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
import { closeChatPage, pushChatPage } from '@/lib/chat-pages'
import { getNativeApp, pickNativeFileAsFile } from '@/lib/native-app'

export function SettingsView({
  id,
  name,
  username,
  image,
  about = '',
}: {
  id: string
  name: string
  username: string | null
  image: string | null
  about?: string
}) {
  const router = useRouter()
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState(name)
  const [profileAbout, setProfileAbout] = useState(about)
  const [profileImage, setProfileImage] = useState(image)
  const [photo, setPhoto] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [removePhoto, setRemovePhoto] = useState(false)
  const [saved, setSaved] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [copiedLink, setCopiedLink] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scannerMessage, setScannerMessage] = useState<string | null>(null)
  const [scannerUsername, setScannerUsername] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const scannerRunning = useRef(false)
  const photoRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setNotificationsEnabled(localStorage.getItem('handle.notifications.enabled.v1') === 'true')
  }, [])

  useEffect(() => {
    const base = new URL('../', window.location.href)
    base.search = ''
    base.searchParams.set('chat', username ?? '')
    setShareUrl(base.toString())
  }, [username])

  useEffect(() => () => {
    scannerRunning.current = false
    streamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  useEffect(() => {
    const handlePageBack = (event: PopStateEvent) => {
      const page = event.state && typeof event.state === 'object'
        ? (event.state as { handleChatPage?: string }).handleChatPage
        : undefined
      if (page !== 'qr-scanner') {
        stopScanner()
        setScannerOpen(false)
      }
    }
    window.addEventListener('popstate', handlePageBack)
    return () => window.removeEventListener('popstate', handlePageBack)
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

  async function toggleNotifications() {
    setError(null)
    if (notificationsEnabled) {
      localStorage.setItem('handle.notifications.enabled.v1', 'false')
      setNotificationsEnabled(false)
      return
    }

    const nativeApp = getNativeApp()
    if (nativeApp?.requestPermission) {
      try {
        const granted = await nativeApp.requestPermission('notifications')
        if (!granted) {
          setError(t.settings.notificationsDenied)
          return
        }
        localStorage.setItem('handle.notifications.enabled.v1', 'true')
        setNotificationsEnabled(true)
        return
      } catch {
        setError(t.settings.notificationsDenied)
        return
      }
    }

    if (typeof Notification === 'undefined') {
      setError(t.settings.notificationsUnavailable)
      return
    }
    if (Notification.permission === 'denied') {
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

  function selectPhoto(selected: File | null) {
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
  }

  async function changePhoto() {
    const nativeApp = getNativeApp()
    if (nativeApp?.pickFile) {
      try {
        selectPhoto(await pickNativeFileAsFile(['image/*']))
      } catch {
        setError(t.errors.GENERIC)
      }
      return
    }
    photoRef.current?.click()
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
        about: profileAbout,
        avatarPath,
        updateImage: Boolean(photo || removePhoto),
      })
      setDisplayName(updated.name)
      setProfileAbout(updated.about ?? '')
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

  function openScannedValue(raw: string) {
    let candidate = raw.trim()
    try {
      const parsed = new URL(candidate)
      candidate = parsed.searchParams.get('chat') ?? candidate
    } catch {
      // A plain username is accepted as well as a full profile URL.
    }
    candidate = candidate.replace(/^@/, '').toLowerCase()
    if (!/^[a-z0-9_.]{3,20}$/.test(candidate)) {
      setScannerMessage(t.errors.INVALID_USERNAME)
      return
    }
    stopScanner()
    setScannerOpen(false)
    router.push(`/?chat=${encodeURIComponent(candidate)}`)
  }

  async function startScanner() {
    setScannerMessage(null)
    const Detector = (window as unknown as { BarcodeDetector?: new (options?: { formats: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector
    if (!Detector) {
      setScannerMessage(t.settings.scannerUnsupported)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      scannerRunning.current = true
      setScanning(true)
      const detector = new Detector({ formats: ['qr_code'] })
      const scan = async () => {
        if (!scannerRunning.current || !videoRef.current) return
        try {
          const codes = await detector.detect(videoRef.current)
          if (codes[0]?.rawValue) {
            openScannedValue(codes[0].rawValue)
            return
          }
        } catch {
          setScannerMessage(t.settings.scannerCameraError)
          stopScanner()
          return
        }
        window.setTimeout(() => void scan(), 250)
      }
      void scan()
    } catch {
      setScannerMessage(t.settings.scannerCameraError)
    }
  }

  function stopScanner() {
    scannerRunning.current = false
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setScanning(false)
  }

  async function copyProfileLink() {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopiedLink(true)
    } catch {
      setError(t.errors.GENERIC)
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

        <section className="mb-4 rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
          <div className="flex items-center gap-2"><QrCode className="size-5 text-primary" aria-hidden="true" /><h2 className="font-semibold">{t.settings.qrTitle}</h2></div>
          <p className="mt-1 text-sm text-muted-foreground">{t.settings.qrHint}</p>
          <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row">
            {shareUrl && <img src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&format=svg&margin=8&data=${encodeURIComponent(shareUrl)}`} width={180} height={180} alt={t.settings.qrTitle} className="rounded-xl bg-white p-2" />}
            <div className="flex w-full flex-col gap-2 sm:w-auto">
              <Button type="button" variant="outline" className="gap-2" onClick={() => { setScannerMessage(null); setScannerOpen(true); pushChatPage('qr-scanner') }}><ScanLine className="size-4" />{t.settings.scanQr}</Button>
              <Button type="button" variant="ghost" className="gap-2" onClick={() => void copyProfileLink()} disabled={!shareUrl}><Check className="size-4" />{copiedLink ? t.chat.copiedMessage : t.settings.copyProfileLink}</Button>
            </div>
          </div>
        </section>

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
            accept="image/*"
            className="sr-only"
            tabIndex={-1}
            aria-label={t.settings.photo}
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null
              event.target.value = ''
              selectPhoto(selected)
            }}
          />
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              disabled={pending}
              onClick={() => void changePhoto()}
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
          <label htmlFor="profile-about" className="mt-5 block text-sm font-medium">{t.settings.about}</label>
          <textarea id="profile-about" value={profileAbout} maxLength={150} disabled={pending} onChange={(event) => { setProfileAbout(event.target.value); setSaved(false) }} placeholder={t.settings.aboutPlaceholder} className="mt-2 min-h-20 w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30" />
          <p className="mt-1 text-xs text-muted-foreground">{t.settings.aboutHint}</p>
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
          <Button type="button" variant={notificationsEnabled ? 'default' : 'outline'} onClick={() => void toggleNotifications()} className="mt-4">
            {notificationsEnabled ? t.settings.disableNotifications : t.settings.enableNotifications}
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

      {scannerOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background" role="dialog" aria-modal="true" aria-labelledby="qr-scanner-title">
          <section className="flex h-full w-full flex-col">
            <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3"><Button type="button" variant="ghost" size="icon" onClick={() => closeChatPage('qr-scanner')} aria-label={t.chat.back}><ArrowLeft className="rtl:rotate-180" /></Button><h2 id="qr-scanner-title" className="flex-1 font-semibold">{t.settings.scanQr}</h2></header>
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4 sm:p-6">
            <p className="text-sm text-muted-foreground">{t.settings.scanQrHint}</p>
            <video ref={videoRef} playsInline muted className={`mx-auto max-h-[60dvh] w-full max-w-2xl flex-1 rounded-xl bg-black object-cover ${scanning ? 'block' : 'hidden'}`} />
            {scannerMessage && <p role="status" className="text-sm text-muted-foreground">{scannerMessage}</p>}
            <div className="mt-auto flex flex-wrap gap-2">
              {scanning ? <Button type="button" variant="outline" onClick={stopScanner}>{t.settings.stopScanner}</Button> : <Button type="button" variant="outline" onClick={() => void startScanner()}>{t.settings.startScanner}</Button>}
              <input value={scannerUsername} onChange={(event) => setScannerUsername(event.target.value)} placeholder={t.auth.usernamePlaceholder} dir="ltr" className="h-10 min-w-0 flex-1 rounded-xl border bg-background px-3 text-sm" />
              <Button type="button" onClick={() => openScannedValue(scannerUsername)} disabled={!scannerUsername.trim()}>{t.settings.openChat}</Button>
            </div>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
