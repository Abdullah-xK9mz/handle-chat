'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Camera, Check, Laptop, LogOut, QrCode, Save, ScanLine, Shield, Smartphone, Tablet, UserRoundX } from 'lucide-react'
import { LanguageToggle } from '@/components/language-toggle'
import { UserAvatar } from '@/components/chat/user-avatar'
import { Button, buttonVariants } from '@/components/ui/button'
import { useI18n } from '@/components/i18n-provider'
import {
  createRealtimeClient,
  edgeRequest,
  signOutOtherSessions,
  signOut as supabaseSignOut,
  SupabaseError,
  uploadAvatar,
  type Profile,
} from '@/lib/supabase'
import { errorMessage } from '@/lib/i18n/dictionaries'
import { closeChatPage, pushChatPage } from '@/lib/chat-pages'
import { NOTIFICATION_PREVIEW_KEY, readBooleanPreference, SEND_ON_ENTER_KEY, writeBooleanPreference } from '@/lib/chat-preferences'
import { getNativeApp, pickNativeFileAsFile } from '@/lib/native-app'

type KnownDevice = {
  deviceId: string
  lastSeenAt: string
  userAgent: string | null
  isCurrent: boolean
}

type BlockedUser = {
  id: string
  name: string
  username: string
  image: string | null
}

function describeDevice(userAgent: string | null) {
  const ua = userAgent ?? ''
  const browser = ua.includes('Edg/') ? 'Microsoft Edge'
    : ua.includes('Firefox/') ? 'Firefox'
      : ua.includes('Chrome/') ? 'Chrome'
        : ua.includes('Safari/') ? 'Safari'
          : 'Unknown browser'
  const system = /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
      : /Windows/i.test(ua) ? 'Windows'
        : /Mac OS|Macintosh/i.test(ua) ? 'macOS'
          : /Linux/i.test(ua) ? 'Linux'
            : 'Unknown system'
  const type = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ? 'tablet'
    : /Android|iPhone|iPod|Mobile/i.test(ua) ? 'mobile'
      : 'desktop'
  return { browser, system, type }
}

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
  const { t, locale, setLocale } = useI18n()
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
  const [devices, setDevices] = useState<KnownDevice[]>([])
  const [devicesLoading, setDevicesLoading] = useState(true)
  const [devicesError, setDevicesError] = useState(false)
  const [endingOtherSessions, setEndingOtherSessions] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([])
  const [blockedOpen, setBlockedOpen] = useState(false)
  const [blockedLoading, setBlockedLoading] = useState(false)
  const [blockedError, setBlockedError] = useState(false)
  const [messageTextSize, setMessageTextSize] = useState<'small' | 'normal' | 'large'>('normal')
  const [sendOnEnter, setSendOnEnter] = useState(true)
  const [notificationPreview, setNotificationPreview] = useState(true)
  const [shareUrl, setShareUrl] = useState('')
  const [copiedLink, setCopiedLink] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scannerMessage, setScannerMessage] = useState<string | null>(null)
  const [scannerUsername, setScannerUsername] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const scannerRunning = useRef(false)
  const scannerGenerationRef = useRef(0)
  const photoRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setNotificationsEnabled(localStorage.getItem('handle.notifications.enabled.v1') === 'true')
  }, [])

  useEffect(() => {
    let cancelled = false
    let realtimeClient: Awaited<ReturnType<typeof createRealtimeClient>> | null = null
    const refreshDevices = () => {
      void edgeRequest<{ devices: KnownDevice[] }>({ action: 'list-own-devices' })
        .then((result) => { if (!cancelled) setDevices(result.devices) })
        .catch(() => undefined)
    }
    const refreshProfile = () => {
      void edgeRequest<Profile>({ action: 'me' })
        .then((updated) => {
          if (cancelled) return
          setDisplayName(updated.name)
          setProfileAbout(updated.about ?? '')
          setProfileImage(updated.image)
        })
        .catch(() => undefined)
    }

    void createRealtimeClient().then(async (client) => {
      if (cancelled) { await client.removeAllChannels(); return }
      realtimeClient = client
      await client.realtime.setAuth()
      if (cancelled) { await client.removeAllChannels(); return }
      client.channel(`user-updates:${id}`, { config: { private: true } })
        .on('broadcast', { event: 'profile-updated' }, refreshProfile)
        .on('broadcast', { event: 'account-updated' }, () => {
          refreshDevices()
          void loadBlockedContacts()
        })
        .on('broadcast', { event: 'access-updated' }, refreshProfile)
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            refreshProfile()
            refreshDevices()
          }
        })
    }).catch(() => undefined)

    return () => {
      cancelled = true
      if (realtimeClient) void realtimeClient.removeAllChannels()
    }
  }, [id])

  useEffect(() => {
    let cancelled = false
    edgeRequest<{ devices: KnownDevice[] }>({ action: 'list-own-devices' })
      .then((result) => { if (!cancelled) setDevices(result.devices) })
      .catch(() => { if (!cancelled) setDevicesError(true) })
      .finally(() => { if (!cancelled) setDevicesLoading(false) })
    const storedSize = localStorage.getItem('handle.chat.message-size.v1')
    if (storedSize === 'small' || storedSize === 'large') setMessageTextSize(storedSize)
    setSendOnEnter(readBooleanPreference(SEND_ON_ENTER_KEY, true))
    setNotificationPreview(readBooleanPreference(NOTIFICATION_PREVIEW_KEY, true))
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const base = new URL('../', window.location.href)
    base.search = ''
    base.searchParams.set('chat', username ?? '')
    setShareUrl(base.toString())
  }, [username])

  useEffect(() => () => {
    scannerGenerationRef.current += 1
    scannerRunning.current = false
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
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

  async function loadBlockedContacts() {
    setBlockedLoading(true)
    setBlockedError(false)
    try {
      const result = await edgeRequest<{ users: BlockedUser[] }>({ action: 'get-blocked-users' })
      setBlockedUsers(result.users)
    } catch {
      setBlockedError(true)
    } finally {
      setBlockedLoading(false)
    }
  }

  function toggleBlockedContacts() {
    if (blockedOpen) {
      setBlockedOpen(false)
      return
    }
    setBlockedOpen(true)
    if (!blockedUsers.length && !blockedLoading && !blockedError) void loadBlockedContacts()
  }

  async function unblockContact(blockedUser: BlockedUser) {
    setBlockedError(false)
    try {
      await edgeRequest({ action: 'unblock-user', userId: blockedUser.id })
      setBlockedUsers((users) => users.filter((user) => user.id !== blockedUser.id))
    } catch {
      setBlockedError(true)
    }
  }

  async function signOutOtherDevices() {
    if (endingOtherSessions || !window.confirm(t.settings.signOutOtherDevicesConfirm)) return
    setEndingOtherSessions(true)
    setActionNotice(null)
    setSessionError(null)
    try {
      await signOutOtherSessions()
      setActionNotice(t.settings.signedOutOtherDevices)
    } catch (caught) {
      const code = caught instanceof SupabaseError ? caught.code : 'GENERIC'
      setSessionError(errorMessage(t, code))
    } finally {
      setEndingOtherSessions(false)
    }
  }

  function changeMessageTextSize(value: string) {
    if (value !== 'small' && value !== 'normal' && value !== 'large') return
    setMessageTextSize(value)
    localStorage.setItem('handle.chat.message-size.v1', value)
    document.documentElement.dataset.chatMessageSize = value
  }

  function changeSendOnEnter(value: boolean) {
    setSendOnEnter(value)
    writeBooleanPreference(SEND_ON_ENTER_KEY, value)
  }

  function changeNotificationPreview(value: boolean) {
    setNotificationPreview(value)
    writeBooleanPreference(NOTIFICATION_PREVIEW_KEY, value)
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
    stopScanner()
    const generation = ++scannerGenerationRef.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      if (scannerGenerationRef.current !== generation) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      const video = videoRef.current
      if (!video) {
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        return
      }
      video.srcObject = stream
      await video.play()
      if (scannerGenerationRef.current !== generation) {
        stream.getTracks().forEach((track) => track.stop())
        if (streamRef.current === stream) streamRef.current = null
        return
      }
      scannerRunning.current = true
      setScanning(true)
      const detector = new Detector({ formats: ['qr_code'] })
      const scan = async () => {
        if (!scannerRunning.current || scannerGenerationRef.current !== generation || !videoRef.current) return
        try {
          const codes = await detector.detect(videoRef.current)
          if (scannerGenerationRef.current !== generation) return
          if (codes[0]?.rawValue) {
            openScannedValue(codes[0].rawValue)
            return
          }
        } catch {
          if (scannerGenerationRef.current !== generation) return
          setScannerMessage(t.settings.scannerCameraError)
          stopScanner()
          return
        }
        if (scannerGenerationRef.current === generation) window.setTimeout(() => void scan(), 250)
      }
      void scan()
    } catch {
      if (scannerGenerationRef.current === generation) {
        stopScanner()
        setScannerMessage(t.settings.scannerCameraError)
      }
    }
  }

  function stopScanner() {
    scannerGenerationRef.current += 1
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

        <section className="mt-4 rounded-2xl border bg-card p-5 shadow-sm sm:p-6" aria-labelledby="privacy-title">
          <div className="flex items-center gap-2"><Shield className="size-5 text-primary" aria-hidden="true" /><h2 id="privacy-title" className="font-semibold">{t.settings.privacy}</h2></div>
          <p className="mt-1 text-sm text-muted-foreground">{t.settings.privacyHint}</p>
          <p className="mt-3 rounded-xl bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">{t.settings.statusPrivacyNote}</p>
          <Button type="button" variant="outline" className="mt-4 gap-2" onClick={toggleBlockedContacts} aria-expanded={blockedOpen}>
            <UserRoundX className="size-4" />{t.settings.blockedContacts} · {blockedUsers.length}
          </Button>
          {blockedOpen && (
            <div className="mt-3 grid gap-2 border-t pt-3">
              {blockedLoading ? <p className="text-sm text-muted-foreground">{t.settings.loadingBlockedContacts}</p>
                : blockedUsers.length === 0 && !blockedError ? <p className="text-sm text-muted-foreground">{t.settings.noBlockedContacts}</p>
                  : blockedUsers.map((blockedUser) => (
                    <div key={blockedUser.id} className="flex min-w-0 items-center gap-3 rounded-xl bg-muted/50 p-2.5">
                      <UserAvatar name={blockedUser.name} image={blockedUser.image} className="size-10" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{blockedUser.name}</p>
                        <p className="truncate text-xs text-muted-foreground" dir="ltr">@{blockedUser.username}</p>
                      </div>
                      <Button type="button" size="sm" variant="outline" onClick={() => void unblockContact(blockedUser)}>{t.settings.unblockContact}</Button>
                    </div>
                  ))}
              {blockedError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-sm text-destructive"><span>{t.errors.GENERIC}</span><Button type="button" size="sm" variant="outline" onClick={() => void loadBlockedContacts()}>{t.settings.retry}</Button></div>}
            </div>
          )}
        </section>

        <section className="mt-4 rounded-2xl border bg-card p-5 shadow-sm sm:p-6" aria-labelledby="devices-title">
          <div className="flex items-center gap-2"><Smartphone className="size-5 text-primary" aria-hidden="true" /><h2 id="devices-title" className="font-semibold">{t.settings.linkedDevices}</h2></div>
          <p className="mt-1 text-sm text-muted-foreground">{t.settings.linkedDevicesHint}</p>
          <div className="mt-4 grid gap-3">
            {devicesLoading ? <p className="text-sm text-muted-foreground">{t.settings.loadingDevices}</p>
              : devices.length === 0 && !devicesError ? <p className="text-sm text-muted-foreground">{t.settings.noDevices}</p>
                : devices.map((device) => {
                  const details = describeDevice(device.userAgent)
                  const type = details.type === 'mobile' ? t.settings.deviceMobile : details.type === 'tablet' ? t.settings.deviceTablet : t.settings.deviceDesktop
                  return (
                    <div key={device.deviceId} className="flex min-w-0 items-start gap-3 rounded-xl border p-3">
                      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">{details.type === 'mobile' ? <Smartphone className="size-4" aria-hidden="true" /> : details.type === 'tablet' ? <Tablet className="size-4" aria-hidden="true" /> : <Laptop className="size-4" aria-hidden="true" />}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold">{details.browser} · {details.system}</p>
                          {device.isCurrent && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">{t.settings.thisDevice}</span>}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{t.settings.deviceType}: {type}</p>
                        <p className="text-xs text-muted-foreground">{t.settings.deviceBrowser}: {details.browser} · {t.settings.deviceSystem}: {details.system}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{t.settings.lastDeviceActivity}: {new Date(device.lastSeenAt).toLocaleString(locale)}</p>
                        <p className="mt-1 truncate text-[11px] text-muted-foreground" dir="ltr">ID · …{device.deviceId.slice(-8)}</p>
                      </div>
                    </div>
                  )
                })}
            {devicesError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-sm text-destructive"><span>{t.errors.GENERIC}</span><Button type="button" size="sm" variant="outline" onClick={() => { setDevicesError(false); setDevicesLoading(true); void edgeRequest<{ devices: KnownDevice[] }>({ action: 'list-own-devices' }).then((result) => setDevices(result.devices)).catch(() => setDevicesError(true)).finally(() => setDevicesLoading(false)) }}>{t.settings.retry}</Button></div>}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{t.settings.signOutOtherDevicesHint}</p>
          <Button type="button" variant="outline" disabled={endingOtherSessions || devicesLoading} onClick={() => void signOutOtherDevices()} className="mt-3">
            {endingOtherSessions ? t.settings.signingOutOtherDevices : t.settings.signOutOtherDevices}
          </Button>
          {actionNotice && <p role="status" className="mt-2 text-sm text-muted-foreground">{actionNotice}</p>}
          {sessionError && <p role="alert" className="mt-2 text-sm text-destructive">{sessionError}</p>}
        </section>

        <section className="mt-4 rounded-2xl border bg-card p-5 shadow-sm sm:p-6" aria-labelledby="chats-settings-title">
          <div className="flex items-center gap-2"><span className="flex size-5 items-center justify-center text-primary" aria-hidden="true">Aa</span><h2 id="chats-settings-title" className="font-semibold">{t.settings.chats}</h2></div>
          <p className="mt-1 text-sm text-muted-foreground">{t.settings.chatDisplayHint}</p>
          <label htmlFor="message-text-size" className="mt-4 block text-sm font-medium">{t.settings.messageTextSize}</label>
          <select id="message-text-size" value={messageTextSize} onChange={(event) => changeMessageTextSize(event.target.value)} className="mt-2 h-10 w-full rounded-xl border bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
            <option value="small">{t.settings.textSizeSmall}</option>
            <option value="normal">{t.settings.textSizeNormal}</option>
            <option value="large">{t.settings.textSizeLarge}</option>
          </select>
          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border p-3">
            <input type="checkbox" checked={sendOnEnter} onChange={(event) => changeSendOnEnter(event.target.checked)} className="mt-1 size-4 accent-primary" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t.settings.sendOnEnter}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t.settings.sendOnEnterHint}</span>
            </span>
          </label>
        </section>

        <section className="mt-4 rounded-2xl border bg-card p-5 shadow-sm sm:p-6" aria-labelledby="language-title">
          <h2 id="language-title" className="font-semibold">{t.settings.languageSection}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t.settings.languageHint}</p>
          <label htmlFor="settings-language" className="mt-4 block text-sm font-medium">{t.language.label}</label>
          <select id="settings-language" value={locale} onChange={(event) => setLocale(event.target.value === 'ar' ? 'ar' : 'en')} className="mt-2 h-10 w-full rounded-xl border bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </select>
        </section>

        <section className="mt-4 rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
          <h2 className="font-semibold">{t.settings.notifications}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t.settings.notificationsHint}</p>
          <Button type="button" variant={notificationsEnabled ? 'default' : 'outline'} onClick={() => void toggleNotifications()} className="mt-4">
            {notificationsEnabled ? t.settings.disableNotifications : t.settings.enableNotifications}
          </Button>
          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border p-3">
            <input type="checkbox" checked={notificationPreview} onChange={(event) => changeNotificationPreview(event.target.checked)} className="mt-1 size-4 accent-primary" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t.settings.notificationPreview}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t.settings.notificationPreviewHint}</span>
            </span>
          </label>
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
