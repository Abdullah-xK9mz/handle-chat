'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { dictionaries, type Dictionary, type Locale } from '@/lib/i18n/dictionaries'

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
    const saved = window.localStorage.getItem('handle-locale')
    if (saved === 'ar' || saved === 'en') setLocale(saved)
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  }, [locale])

  function updateLocale(nextLocale: Locale) {
    window.localStorage.setItem('handle-locale', nextLocale)
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
