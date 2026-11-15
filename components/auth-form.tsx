'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { AtSign, MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  createAccount,
  signInWithUsername,
  SupabaseError,
} from '@/lib/supabase'
import {
  USERNAME_PATTERN,
  normalizeUsername,
} from '@/lib/username'
import { useI18n } from './i18n-provider'
import { LanguageToggle } from './language-toggle'

type Mode = 'sign-in' | 'sign-up'

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter()
  const { t } = useI18n()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const isSignUp = mode === 'sign-up'

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
      if (isSignUp) {
        await createAccount(username, name || username, password)
      } else {
        await signInWithUsername(username, password)
      }

      router.push('/')
      router.refresh()
    } catch (error) {
      if (
        isSignUp &&
        error instanceof SupabaseError &&
        error.code === 'USERNAME_TAKEN'
      ) {
        setError(t.auth.usernameTaken)
      } else {
        setError(isSignUp ? t.auth.signUpFailed : t.auth.signInFailed)
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center bg-canvas px-4 py-16">
      <LanguageToggle className="absolute end-4 top-4" />

      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <MessageCircle className="size-6" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">
            {isSignUp ? t.auth.signUpTitle : t.auth.signInTitle}
          </h1>
          <p className="text-sm text-muted-foreground text-pretty">
            {isSignUp ? t.auth.signUpSubtitle : t.auth.signInSubtitle}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 rounded-2xl border bg-card p-6 shadow-sm"
        >
          {isSignUp && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">{t.auth.displayName}</Label>
              <Input
                id="name"
                name="name"
                autoComplete="name"
                placeholder={t.auth.displayNamePlaceholder}
                maxLength={50}
                className="h-10"
              />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="username">{t.auth.username}</Label>
            <div className="relative">
              <AtSign
                className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="username"
                name="username"
                required
                dir="ltr"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder={t.auth.usernamePlaceholder}
                minLength={3}
                maxLength={21}
                className="h-10 ps-9 rtl:text-right"
                aria-describedby={isSignUp ? 'username-hint' : undefined}
              />
            </div>
            {isSignUp && (
              <p id="username-hint" className="text-xs text-muted-foreground">
                {t.auth.usernameHint}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password">{t.auth.password}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete={isSignUp ? 'new-password' : 'current-password'}
              className="h-10"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={pending} className="mt-2 h-10">
            {pending
              ? isSignUp
                ? t.auth.creatingAccount
                : t.auth.signingIn
              : isSignUp
                ? t.auth.createAccount
                : t.auth.signIn}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          {isSignUp ? t.auth.haveAccount : t.auth.newHere}{' '}
          <Link
            href={isSignUp ? '/sign-in' : '/sign-up'}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {isSignUp ? t.auth.signIn : t.auth.createAnAccount}
          </Link>
        </p>
      </div>
    </main>
  )
}
