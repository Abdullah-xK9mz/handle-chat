const memoryFallback = new Map<string, string>()
const pendingMemoryWrites = new Set<string>()

export function readStoredValue(key: string): string | null {
  if (typeof window === 'undefined') return memoryFallback.get(key) ?? null
  try {
    const value = window.localStorage.getItem(key)
    if (value !== null) {
      memoryFallback.set(key, value)
      pendingMemoryWrites.delete(key)
      return value
    }
    if (pendingMemoryWrites.has(key)) return memoryFallback.get(key) ?? null
    memoryFallback.delete(key)
    return null
  } catch {
    return memoryFallback.get(key) ?? null
  }
}

export function writeStoredValue(key: string, value: string) {
  memoryFallback.set(key, value)
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value)
    pendingMemoryWrites.delete(key)
  } catch {
    pendingMemoryWrites.add(key)
    // Keep the current session usable when browser storage is blocked or full.
  }
}

export function removeStoredValue(key: string) {
  memoryFallback.delete(key)
  pendingMemoryWrites.delete(key)
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(key)
  } catch {
    // The in-memory copy is still cleared when browser storage is unavailable.
  }
}
