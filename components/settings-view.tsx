'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowLeft, LogOut } from 'lucide-react'
import { LanguageToggle } from '@/components/language-toggle'
import { UserAvatar } from '@/components/chat/user-avatar'
import { Button, buttonVariants } from '@/components/ui/button'
import { useI18n } from '@/components/i18n-provider'
import { signOut as supabaseSignOut } from '@/lib/supabase'

export function SettingsView({
  name,
  username,
  image,
}: {
  name: string
  username: string | null
  image: string | null
}) {
  const router = useRouter()
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
            <UserAvatar name={name} image={image} className="size-14 text-base" />
            <div className="min-w-0">
              <h2 className="truncate font-semibold">{name}</h2>
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
        </section>

        <section className="mt-4 rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
          <h2 className="font-semibold">{t.settings.account}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.settings.accountHint}
          </p>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
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
