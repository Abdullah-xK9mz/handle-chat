'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SettingsView } from '@/components/settings-view'
import { edgeRequest, type Profile } from '@/lib/supabase'

export default function SettingsPage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)

  useEffect(() => {
    let cancelled = false
    edgeRequest<Profile>({ action: 'me' })
      .then((result) => {
        if (!cancelled) setProfile(result)
      })
      .catch(() => router.replace('/sign-in'))
    return () => {
      cancelled = true
    }
  }, [router])

  if (!profile) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-canvas text-sm text-muted-foreground">
        جارٍ تحميل الإعدادات…
      </main>
    )
  }
  return <SettingsView {...profile} />
}
