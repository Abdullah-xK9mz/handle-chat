'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChatApp } from '@/components/chat/chat-app'
import { edgeRequest, SupabaseError, type Profile } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { writeStoredValue } from '@/lib/safe-storage'

export default function HomePage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    edgeRequest<Profile>({ action: 'me' })
      .then((result) => {
        if (!cancelled) setProfile(result)
      })
      .catch((error) => {
        if (cancelled) return
        setFailed(true)
        if (error instanceof SupabaseError && error.status === 401) {
          const params = new URLSearchParams(window.location.search)
          const pending = new URLSearchParams()
          const chat = params.get('chat')
          const groupInvite = params.get('groupInvite')
          if (chat) pending.set('chat', chat)
          if (groupInvite) pending.set('groupInvite', groupInvite)
          const pendingValue = pending.toString()
          if (pendingValue) writeStoredValue('handle.pending.deepLink.v1', pendingValue)
          router.replace('/sign-in')
        }
      })
    return () => {
      cancelled = true
    }
  }, [router, attempt])


  if (!profile && !failed) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-canvas text-sm text-muted-foreground">
        جارٍ تحميل المحادثات…
      </main>
    )
  }
  if (!profile) return failed ? (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-canvas px-5 text-center">
      <p className="text-sm text-destructive">تعذّر الاتصال بالمحادثات. تحقق من الإنترنت وحاول مجددًا.</p>
      <Button onClick={() => { setFailed(false); setAttempt((value) => value + 1) }}>إعادة المحاولة</Button>
    </main>
  ) : null

  return (
    <ChatApp
      currentUser={{
        id: profile.id,
        name: profile.name,
        username: profile.username,
        image: profile.image,
        about: profile.about,
        isAdmin: profile.isAdmin,
      }}
    />
  )
}

