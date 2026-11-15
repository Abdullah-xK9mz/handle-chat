'use client'

import { useDeferredValue, useState } from 'react'
import useSWR from 'swr'
import { Search } from 'lucide-react'
import { useI18n } from '@/components/i18n-provider'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/i18n/dictionaries'
import { normalizeUsername } from '@/lib/username'
import { chatRequest, edgeRequest } from '@/lib/supabase'
import { fetcher } from './types'
import { UserAvatar } from './user-avatar'

type FoundUser = { username: string; name: string; image: string | null }

export function NewChat({ onStarted }: { onStarted: (id: number) => void }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  const [groupMode, setGroupMode] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [selectedUsers, setSelectedUsers] = useState<FoundUser[]>([])
  const [creatingGroup, setCreatingGroup] = useState(false)
  const deferred = normalizeUsername(useDeferredValue(query))

  const { data } = useSWR<{ users: FoundUser[] }>(
    deferred ? `/api/users?q=${encodeURIComponent(deferred)}` : null,
    fetcher,
    { keepPreviousData: true },
  )
  const results = deferred ? (data?.users ?? []) : []

  async function start(username: string) {
    if (starting) return
    setError(null)
    setStarting(username)
    try {
      const result = await chatRequest<{ id: number }>('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      })
      if (!Number.isInteger(result?.id) || result.id <= 0) {
        setError(errorMessage(t, 'GENERIC'))
        return
      }
      setQuery('')
      onStarted(result.id)
    } catch (caught) {
      const code =
        typeof caught === 'object' && caught && 'code' in caught
          ? caught.code
          : 'GENERIC'
      setError(errorMessage(t, code))
    } finally {
      setStarting(null)
    }
  }

  async function createGroup() {
    if (creatingGroup) return
    if (!selectedUsers.length) {
      setError(t.errors.INVALID_GROUP_MEMBERS)
      return
    }
    setError(null)
    setCreatingGroup(true)
    try {
      const result = await edgeRequest<{ id: number }>({
        action: 'create-group',
        name: groupName,
        usernames: selectedUsers.map((user) => user.username),
      })
      setGroupName('')
      setSelectedUsers([])
      setQuery('')
      setGroupMode(false)
      onStarted(result.id)
    } catch (caught) {
      const code = typeof caught === 'object' && caught && 'code' in caught ? caught.code : 'GENERIC'
      setError(errorMessage(t, code))
    } finally {
      setCreatingGroup(false)
    }
  }

  function toggleSelected(user: FoundUser) {
    setSelectedUsers((current) => current.some((item) => item.username === user.username)
      ? current.filter((item) => item.username !== user.username)
      : current.length < 49 ? [...current, user] : current)
  }

  return (
    <div className="relative border-b px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {groupMode ? t.chat.groupMembers : t.chat.searchLabel}
        </span>
        <button
          type="button"
          className="text-xs font-medium text-primary hover:underline"
          onClick={() => {
            setGroupMode((value) => !value)
            setError(null)
          }}
        >
          {groupMode ? t.chat.conversations : t.chat.newGroup}
        </button>
      </div>
      {groupMode && (
        <div className="mb-2 space-y-2">
          <Input
            value={groupName}
            maxLength={50}
            onChange={(event) => setGroupName(event.target.value)}
            placeholder={t.chat.groupNamePlaceholder}
            aria-label={t.chat.groupName}
            className="h-9 rounded-xl bg-background"
          />
          {selectedUsers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {selectedUsers.map((user) => (
                <button
                  key={user.username}
                  type="button"
                  className="rounded-full bg-secondary px-2.5 py-1 text-xs"
                  onClick={() => toggleSelected(user)}
                  aria-label={`${user.name} @${user.username}`}
                >
                  @{user.username} ×
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          const username = normalizeUsername(query)
            if (!username) return
            if (groupMode) {
              const match = results.find((user) => user.username === username)
              if (match) toggleSelected(match)
            } else {
              start(username)
            }
        }}
      >
        <label htmlFor="new-chat" className="sr-only">
          {t.chat.searchLabel}
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="new-chat"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setError(null)
            }}
        placeholder={t.chat.searchPlaceholder}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="h-10 rounded-full bg-muted ps-9"
          />
        </div>
      </form>

      {error && (
        <p role="alert" className="mt-2 px-1 text-xs text-destructive">
          {error}
        </p>
      )}

      {results.length > 0 && (
        <ul
          aria-label={t.chat.matchingPeople}
          className="absolute inset-x-4 top-full z-10 mt-1 flex flex-col gap-0.5 rounded-xl border bg-popover p-1 shadow-lg"
        >
          {results.map((u) => (
            <li key={u.username}>
              <button
                type="button"
                onClick={() => groupMode ? toggleSelected(u) : start(u.username)}
                disabled={starting !== null}
                aria-pressed={groupMode && selectedUsers.some((item) => item.username === u.username)}
                className="flex w-full items-center gap-3 rounded-lg p-2 text-start hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
              >
                <UserAvatar
                  name={u.name}
                  image={u.image}
                  className="size-8 text-xs"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {u.name}
                  </span>
                  <span
                    className="block truncate text-xs text-muted-foreground"
                    dir="ltr"
                  >
                    @{u.username}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {groupMode && (
        <Button
          type="button"
          onClick={createGroup}
          disabled={creatingGroup || !groupName.trim() || selectedUsers.length === 0}
          className="mt-2 h-9 w-full rounded-xl"
        >
          {creatingGroup ? t.chat.groupCreating : t.chat.groupCreate}
        </Button>
      )}
    </div>
  )
}

