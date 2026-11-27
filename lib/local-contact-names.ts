import { readStoredValue, writeStoredValue } from './safe-storage'

const STORAGE_KEY = 'handle.contact-names.v1'
export const CONTACT_NAMES_CHANGED = 'handle-contact-names-changed'

export function getLocalContactNames(): Record<string, string> {
  try {
    const value = JSON.parse(readStoredValue(STORAGE_KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string',
      ),
    )
  } catch {
    return {}
  }
}

export function setLocalContactName(userId: string, name: string) {
  const names = getLocalContactNames()
  const cleaned = name.trim().slice(0, 50)
  if (cleaned) names[userId] = cleaned
  else delete names[userId]
  writeStoredValue(STORAGE_KEY, JSON.stringify(names))
  window.dispatchEvent(new CustomEvent(CONTACT_NAMES_CHANGED, { detail: names }))
  return names
}
