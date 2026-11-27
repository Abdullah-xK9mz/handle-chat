'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { dictionaries, type Dictionary, type Locale } from '@/lib/i18n/dictionaries'
import { readStoredValue, writeStoredValue } from '@/lib/safe-storage'

type I18nValue = {
  locale: Locale
  t: Dictionary
  setLocale: (locale: Locale) => void
}

const I18nContext = createContext<I18nValue>({
  locale: 'en',
  t: dictionaries.en,
  setLocale: () => undefined,
})

export function I18nProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [locale, setLocale] = useState<Locale>('en')

  useEffect(() => {
    const saved = readStoredValue('handle-locale')
    if (saved === 'ar' || saved === 'en') setLocale(saved)
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  }, [locale])

  useEffect(() => {
    const size = readStoredValue('handle.chat.message-size.v1')
    document.documentElement.dataset.chatMessageSize =
      size === 'small' || size === 'large' ? size : 'normal'
  }, [])

  function updateLocale(nextLocale: Locale) {
    writeStoredValue('handle-locale', nextLocale)
    setLocale(nextLocale)
  }

  return (
    <I18nContext.Provider
      value={{ locale, t: dictionaries[locale], setLocale: updateLocale }}
    >
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  return useContext(I18nContext)
}
