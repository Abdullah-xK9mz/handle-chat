export const SEND_ON_ENTER_KEY = 'message.send-on-enter.v1'
export const NOTIFICATION_PREVIEW_KEY = 'message.notification-preview.v1'

export function readBooleanPreference(key: string, fallback = true) {
  if (typeof window === 'undefined') return fallback
  const value = window.localStorage.getItem(key)
  return value === null ? fallback : value === 'true'
}

export function writeBooleanPreference(key: string, value: boolean) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, String(value))
}
