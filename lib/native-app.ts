export type NativePickedFile = {
  name: string
  mime: string
  size: number
  dataUrl: string
}

export type NativePermission =
  | 'camera'
  | 'microphone'
  | 'location'
  | 'notifications'

export type FreeAppBridge = {
  requestPermission?: (name: NativePermission) => Promise<boolean>
  notify?: (title: string, body?: string) => void
  pickFile?: (options?: {
    accept?: string[]
    multiple?: boolean
  }) => Promise<NativePickedFile | null>
}

declare global {
  interface Window {
    FreeApp?: FreeAppBridge
  }
}

export function getNativeApp(): FreeAppBridge | null {
  if (typeof window === 'undefined') return null
  return window.FreeApp ?? null
}

export async function pickNativeFileAsFile(
  accept: string[],
): Promise<File | null> {
  const nativeApp = getNativeApp()
  if (!nativeApp?.pickFile) return null

  const picked = await nativeApp.pickFile({ accept, multiple: false })
  if (!picked?.dataUrl) return null

  const response = await fetch(picked.dataUrl)
  if (!response.ok) throw new Error('FILE_PICK_FAILED')
  const blob = await response.blob()
  return new File([blob], picked.name || 'upload', {
    type: picked.mime || blob.type || 'application/octet-stream',
  })
}
