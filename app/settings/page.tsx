'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SettingsView } from '@/components/settings-view'
import { edgeRequest, SupabaseError, type Profile } from '@/lib/supabase'
import { Button } from '@/components/ui/button'

export default function SettingsPage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    edgeRequest<Profile>({ action: 'me' })
      .then((result) => {
        if (!cancelled) setProfile(result)
      })
      .catch((error) => {
        if (cancelled) return
        if (error instanceof SupabaseError && error.status === 401) router.replace('/sign-in')
        else setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [router])

  if (!profile) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-canvas text-sm text-muted-foreground">
        {failed ? <><p>تعذّر تحميل الإعدادات. تحقق من الإنترنت وحاول مجددًا.</p><Button onClick={() => window.location.reload()}>إعادة المحاولة</Button></> : 'جارٍ تحميل الإعدادات…'}
      </main>
    )
  }
  return <SettingsView {...profile} />
}
