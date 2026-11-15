'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChatApp } from '@/components/chat/chat-app'
import { edgeRequest, type Profile } from '@/lib/supabase'

export default function HomePage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    edgeRequest<Profile>({ action: 'me' })
      .then((result) => {
        if (!cancelled) setProfile(result)
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
          router.replace('/sign-in')
        }
      })
    return () => {
      cancelled = true
    }
  }, [router])

  if (!profile && !failed) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-canvas text-sm text-muted-foreground">
        جارٍ تحميل المحادثات…
      </main>
    )
  }
  if (!profile) return null

  return (
    <ChatApp
      currentUser={{
        id: profile.id,
        name: profile.name,
        username: profile.username,
        image: profile.image,
      }}
    />
  )
}
