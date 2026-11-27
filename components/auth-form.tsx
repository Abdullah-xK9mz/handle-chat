'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { AtSign, LockKeyhole, MessageCircle, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createAccount, edgeRequest, getSession, signInWithUsername, SupabaseError } from '@/lib/supabase'
import { USERNAME_PATTERN, normalizeUsername } from '@/lib/username'
import { readStoredValue, removeStoredValue } from '@/lib/safe-storage'
import { useI18n } from './i18n-provider'
import { LanguageToggle } from './language-toggle'

type Mode = 'sign-in' | 'sign-up'

function consumePendingDeepLink() {
  const pending = readStoredValue('handle.pending.deepLink.v1')
  removeStoredValue('handle.pending.deepLink.v1')
  if (!pending) return null

  const params = new URLSearchParams(pending)
  if (params.has('chat') || params.has('groupInvite')) return `/?${params.toString()}`

  // Older releases stored only the username as a plain string.
  return `/?chat=${encodeURIComponent(pending)}`
}

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter()
  const { t } = useI18n()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const isSignUp = mode === 'sign-up'

  useEffect(() => {
    let cancelled = false
    void getSession().then(async (session) => {
      if (cancelled || !session) return
      try {
        await edgeRequest({ action: 'me' })
      } catch {
        return
      }
      if (cancelled) return
      router.replace(consumePendingDeepLink() ?? '/')
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [router])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const form = new FormData(event.currentTarget)
    const username = normalizeUsername(String(form.get('username') ?? ''))
    const password = String(form.get('password') ?? '')
    const name = String(form.get('name') ?? '').trim()

    if (!USERNAME_PATTERN.test(username)) {
      setError(t.auth.invalidUsername)
      return
    }

    setPending(true)
    try {
      if (isSignUp) await createAccount(username, name || username, password)
      else await signInWithUsername(username, password)

      router.replace(consumePendingDeepLink() ?? '/')
      router.refresh()
    } catch (caught) {
      if (isSignUp && caught instanceof SupabaseError && caught.code === 'USERNAME_TAKEN') {
        setError(t.auth.usernameTaken)
      } else {
        setError(isSignUp ? t.auth.signUpFailed : t.auth.signInFailed)
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-y-auto bg-[#100f0d] px-4 py-3 text-[#f2eee5] sm:py-5">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,_#40351e_0%,_transparent_42%),linear-gradient(135deg,_#100f0d_0%,_#191714_55%,_#0c0b0a_100%)]" />
      <LanguageToggle className="absolute end-3 top-3 z-10 rounded-full border border-[#655638] bg-[#1a1813]/90 text-[#f2eee5] hover:bg-[#29251b] sm:end-4 sm:top-4" />

      <div className="relative w-full max-w-[430px] pt-8">
        <div className="absolute start-1/2 top-0 z-10 flex size-[60px] -translate-x-1/2 items-center justify-center rounded-full border-4 border-[#191714] bg-gradient-to-br from-[#dbc787] to-[#987b3f] text-[#17140d] shadow-[0_10px_35px_#050403a0]">
          <UserRound className="size-7" strokeWidth={1.7} aria-hidden="true" />
        </div>

        <section className="rounded-[22px] border border-[#48402d] bg-[#171613]/95 px-5 pb-4 pt-9 shadow-[0_24px_80px_#050403b0] sm:px-8 sm:pb-5">
          <div className="mb-3 text-center">
            <div className="mb-1 inline-flex size-7 items-center justify-center rounded-lg bg-[#b69b5d]/15 text-[#d8c58c]">
              <MessageCircle className="size-5" aria-hidden="true" />
            </div>
            <h1 className="text-[23px] font-semibold tracking-tight">{isSignUp ? t.auth.signUpTitle : t.auth.signInTitle}</h1>
            <p className="mt-1 text-sm leading-5 text-[#b8b1a1]">{isSignUp ? t.auth.signUpSubtitle : t.auth.signInSubtitle}</p>
          </div>

          <div className="mb-3 grid grid-cols-2 rounded-full border border-[#48402d] bg-[#100f0d] p-1" role="tablist" aria-label={t.appName}>
            <Link href="/sign-in" replace role="tab" aria-selected={!isSignUp} className={`rounded-full px-3 py-2 text-center text-sm font-medium transition-colors ${!isSignUp ? 'bg-gradient-to-r from-[#a88c4b] to-[#d2bb78] text-[#17140d] shadow-md' : 'text-[#b8b1a1] hover:text-white'}`}>
              {t.auth.signIn}
            </Link>
            <Link href="/sign-up" replace role="tab" aria-selected={isSignUp} className={`rounded-full px-3 py-2 text-center text-sm font-medium transition-colors ${isSignUp ? 'bg-gradient-to-r from-[#a88c4b] to-[#d2bb78] text-[#17140d] shadow-md' : 'text-[#b8b1a1] hover:text-white'}`}>
              {t.auth.createAccount}
            </Link>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-2.5">
            {isSignUp && (
              <div className="flex flex-col gap-1">
                <label htmlFor="name" className="text-sm font-medium text-[#e0d8c5]">{t.auth.displayName}</label>
                <div className="relative">
                  <UserRound className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-[#a29369]" aria-hidden="true" />
                  <input id="name" name="name" autoComplete="name" placeholder={t.auth.displayNamePlaceholder} maxLength={50} className="h-10 w-full rounded-xl border border-[#48402d] bg-[#211f1a] px-4 ps-10 text-sm text-white outline-none transition focus:border-[#c3a75f] focus:ring-2 focus:ring-[#c3a75f]/20 placeholder:text-[#988f7e]" />
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label htmlFor="username" className="text-sm font-medium text-[#e0d8c5]">{t.auth.username}</label>
              <div className="relative">
                <AtSign className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-[#a29369]" aria-hidden="true" />
                <input id="username" name="username" required dir="ltr" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder={t.auth.usernamePlaceholder} minLength={3} maxLength={21} aria-describedby={isSignUp ? 'username-hint' : undefined} className="h-10 w-full rounded-xl border border-[#48402d] bg-[#211f1a] px-4 ps-10 text-sm text-white outline-none transition focus:border-[#c3a75f] focus:ring-2 focus:ring-[#c3a75f]/20 placeholder:text-[#988f7e]" />
              </div>
              {isSignUp && <p id="username-hint" className="text-[11px] leading-4 text-[#aaa18f]">{t.auth.usernameHint}</p>}
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="password" className="text-sm font-medium text-[#e0d8c5]">{t.auth.password}</label>
              <div className="relative">
                <LockKeyhole className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-[#a29369]" aria-hidden="true" />
                <input id="password" name="password" type="password" required minLength={8} autoComplete={isSignUp ? 'new-password' : 'current-password'} className="h-10 w-full rounded-xl border border-[#48402d] bg-[#211f1a] px-4 ps-10 text-sm text-white outline-none transition focus:border-[#c3a75f] focus:ring-2 focus:ring-[#c3a75f]/20" />
              </div>
            </div>

            {error && <p role="alert" className="text-sm text-[#ffaaa6]">{error}</p>}
            <Button type="submit" disabled={pending} className="mt-1 h-10 rounded-xl bg-gradient-to-r from-[#a88c4b] to-[#d2bb78] text-base font-semibold text-[#17140d] shadow-lg shadow-black/20 hover:brightness-110">
              {pending ? (isSignUp ? t.auth.creatingAccount : t.auth.signingIn) : (isSignUp ? t.auth.createAccount : t.auth.signIn)}
            </Button>
          </form>
        </section>
        <p className="mt-2 text-center text-xs text-[#a49b89]">{t.appName}</p>
      </div>
    </main>
  )
}

