import { readStoredValue, writeStoredValue } from './safe-storage'

export const SEND_ON_ENTER_KEY = 'message.send-on-enter.v1'
export const NOTIFICATION_PREVIEW_KEY = 'message.notification-preview.v1'
export const AI_SPEECH_VOICE_KEY = 'message.ai.speech-voice.v1'

export function readBooleanPreference(key: string, fallback = true) {
  if (typeof window === 'undefined') return fallback
  const value = readStoredValue(key)
  return value === null ? fallback : value === 'true'
}

export function writeBooleanPreference(key: string, value: boolean) {
  if (typeof window === 'undefined') return
  writeStoredValue(key, String(value))
}
