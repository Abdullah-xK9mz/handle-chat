'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/components/i18n-provider'
import { signOut } from '@/lib/supabase'

export default function AccessBlockedPage() {
  const { t, locale } = useI18n()
  const [type, setType] = useState<'account' | 'device'>('account')
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    setType(params.get('type') === 'device' ? 'device' : 'account')
    setExpiresAt(params.get('expiresAt'))
  }, [])

  async function leaveAccount() {
    setSigningOut(true)
    await signOut()
    window.location.replace('/sign-in')
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-5 py-8">
      <section className="w-full max-w-md rounded-3xl border bg-background p-7 text-center shadow-xl">
        <span className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <ShieldAlert className="size-7" aria-hidden="true" />
        </span>
        <h1 className="text-xl font-semibold">{t.blocked.title}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {type === 'device' ? t.blocked.device : t.blocked.account}
        </p>
        {expiresAt && (
          <p className="mt-3 text-xs text-muted-foreground">
            {t.blocked.until}: {new Date(expiresAt).toLocaleString(locale)}
          </p>
        )}
        <Button className="mt-6 w-full" disabled={signingOut} onClick={() => void leaveAccount()}>
          {signingOut ? '…' : t.blocked.signOut}
        </Button>
        {type === 'account' && (
          <Link className="mt-4 inline-block text-sm text-primary underline-offset-4 hover:underline" href="/sign-up">
            {t.blocked.createAccount}
          </Link>
        )}
      </section>
    </main>
  )
}

