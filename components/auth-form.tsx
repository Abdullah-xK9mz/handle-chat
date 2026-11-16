'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { AtSign, LockKeyhole, MessageCircle, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createAccount, getSession, signInWithUsername, SupabaseError } from '@/lib/supabase'
import { USERNAME_PATTERN, normalizeUsername } from '@/lib/username'
import { useI18n } from './i18n-provider'
import { LanguageToggle } from './language-toggle'

type Mode = 'sign-in' | 'sign-up'

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter()
  const { t } = useI18n()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const isSignUp = mode === 'sign-up'

  useEffect(() => {
    let cancelled = false
    void getSession().then((session) => {
      if (cancelled || !session) return
      const pendingChat = localStorage.getItem('handle.pending.deepLink.v1')
      localStorage.removeItem('handle.pending.deepLink.v1')
      router.replace(pendingChat ? `/?chat=${encodeURIComponent(pendingChat)}` : '/')
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

      const pendingChat = localStorage.getItem('handle.pending.deepLink.v1')
      localStorage.removeItem('handle.pending.deepLink.v1')
      router.replace(pendingChat ? `/?chat=${encodeURIComponent(pendingChat)}` : '/')
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
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#101923] px-4 py-12 text-[#eaf2f8]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,_#24455b_0%,_transparent_48%),linear-gradient(135deg,_#101923_0%,_#172b3c_55%,_#0d1823_100%)]" />
      <LanguageToggle className="absolute end-4 top-4 z-10 rounded-full border border-[#456176] bg-[#172736]/90 text-[#eaf2f8] hover:bg-[#223b4e]" />

      <div className="relative w-full max-w-[460px] pt-10">
        <div className="absolute start-1/2 top-0 z-10 flex size-[76px] -translate-x-1/2 items-center justify-center rounded-full border-[5px] border-[#172b3c] bg-gradient-to-br from-[#8fd0dd] to-[#3389a8] text-[#0c202d] shadow-[0_10px_35px_#06121c80]">
          <UserRound className="size-9" strokeWidth={1.7} aria-hidden="true" />
        </div>

        <section className="rounded-[22px] border border-[#344d61] bg-[#122130]/95 px-6 pb-7 pt-12 shadow-[0_24px_80px_#050d1680] sm:px-10">
          <div className="mb-6 text-center">
            <div className="mb-3 inline-flex size-9 items-center justify-center rounded-xl bg-[#287d9f]/20 text-[#85c9dc]">
              <MessageCircle className="size-5" aria-hidden="true" />
            </div>
            <h1 className="text-[25px] font-semibold tracking-tight">{isSignUp ? t.auth.signUpTitle : t.auth.signInTitle}</h1>
            <p className="mt-2 text-sm leading-6 text-[#a8bac8]">{isSignUp ? t.auth.signUpSubtitle : t.auth.signInSubtitle}</p>
          </div>

          <div className="mb-6 grid grid-cols-2 rounded-full border border-[#344d61] bg-[#0e1a26] p-1" role="tablist" aria-label={t.appName}>
            <Link href="/sign-in" replace role="tab" aria-selected={!isSignUp} className={`rounded-full px-4 py-2.5 text-center text-sm font-medium transition-colors ${!isSignUp ? 'bg-gradient-to-r from-[#2389b2] to-[#3c9cc1] text-white shadow-md' : 'text-[#a8bac8] hover:text-white'}`}>
              {t.auth.signIn}
            </Link>
            <Link href="/sign-up" replace role="tab" aria-selected={isSignUp} className={`rounded-full px-4 py-2.5 text-center text-sm font-medium transition-colors ${isSignUp ? 'bg-gradient-to-r from-[#2389b2] to-[#3c9cc1] text-white shadow-md' : 'text-[#a8bac8] hover:text-white'}`}>
              {t.auth.createAccount}
            </Link>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {isSignUp && (
              <div className="flex flex-col gap-2">
                <label htmlFor="name" className="text-sm font-medium text-[#d5e0e8]">{t.auth.displayName}</label>
                <div className="relative">
                  <UserRound className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-[#8296a6]" aria-hidden="true" />
                  <input id="name" name="name" autoComplete="name" placeholder={t.auth.displayNamePlaceholder} maxLength={50} className="h-12 w-full rounded-xl border border-[#344d61] bg-[#1b2d3d] px-4 ps-10 text-sm text-white outline-none transition focus:border-[#51a5c5] focus:ring-2 focus:ring-[#51a5c5]/20 placeholder:text-[#8296a6]" />
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <label htmlFor="username" className="text-sm font-medium text-[#d5e0e8]">{t.auth.username}</label>
              <div className="relative">
                <AtSign className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-[#8296a6]" aria-hidden="true" />
                <input id="username" name="username" required dir="ltr" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder={t.auth.usernamePlaceholder} minLength={3} maxLength={21} aria-describedby={isSignUp ? 'username-hint' : undefined} className="h-12 w-full rounded-xl border border-[#344d61] bg-[#1b2d3d] px-4 ps-10 text-sm text-white outline-none transition focus:border-[#51a5c5] focus:ring-2 focus:ring-[#51a5c5]/20 placeholder:text-[#8296a6]" />
              </div>
              {isSignUp && <p id="username-hint" className="text-xs text-[#91a6b6]">{t.auth.usernameHint}</p>}
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="password" className="text-sm font-medium text-[#d5e0e8]">{t.auth.password}</label>
              <div className="relative">
                <LockKeyhole className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-[#8296a6]" aria-hidden="true" />
                <input id="password" name="password" type="password" required minLength={8} autoComplete={isSignUp ? 'new-password' : 'current-password'} className="h-12 w-full rounded-xl border border-[#344d61] bg-[#1b2d3d] px-4 ps-10 text-sm text-white outline-none transition focus:border-[#51a5c5] focus:ring-2 focus:ring-[#51a5c5]/20" />
              </div>
            </div>

            {error && <p role="alert" className="text-sm text-[#ffaaa6]">{error}</p>}
            <Button type="submit" disabled={pending} className="mt-2 h-12 rounded-xl bg-gradient-to-r from-[#2389b2] to-[#3c9cc1] text-base font-semibold text-white shadow-lg shadow-[#0b718e]/20 hover:brightness-110">
              {pending ? (isSignUp ? t.auth.creatingAccount : t.auth.signingIn) : (isSignUp ? t.auth.createAccount : t.auth.signIn)}
            </Button>
          </form>
        </section>
        <p className="mt-5 text-center text-xs text-[#90a4b4]">{t.appName}</p>
      </div>
    </main>
  )
}
