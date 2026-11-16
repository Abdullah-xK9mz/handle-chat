'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AdminView } from '@/components/admin-view'
import { Button } from '@/components/ui/button'
import { edgeRequest, SupabaseError, type Profile } from '@/lib/supabase'

export default function AdminPage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    edgeRequest<Profile>({ action: 'me' }).then((result) => {
      if (cancelled) return
      if (!result.isAdmin) {
        router.replace('/')
        return
      }
      setProfile(result)
    }).catch((error) => {
      if (cancelled) return
      if (error instanceof SupabaseError && error.status === 401) router.replace('/sign-in')
      else setFailed(true)
    })
    return () => { cancelled = true }
  }, [router])

  if (profile) return <AdminView currentUserId={profile.id} />
  return <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-canvas px-5 text-center text-sm text-muted-foreground">
    {failed ? <><p>تعذّر فتح لوحة الإدارة.</p><Button onClick={() => window.location.reload()}>إعادة المحاولة</Button></> : 'جارٍ التحقق من صلاحية الإدارة…'}
  </main>
}
