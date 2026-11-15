'use client'

import { Languages } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useI18n } from './i18n-provider'

export function LanguageToggle({
  compact = false,
  className,
}: {
  compact?: boolean
  className?: string
}) {
  const { locale, t, setLocale } = useI18n()

  function toggle() {
    setLocale(locale === 'ar' ? 'en' : 'ar')
  }

  return (
    <Button
      type="button"
      variant="outline"
      size={compact ? 'icon' : 'default'}
      onClick={toggle}
      aria-label={t.language.switchToLabel}
      title={t.language.switchToLabel}
      className={cn(!compact && 'gap-2 rounded-full', className)}
    >
      <Languages aria-hidden="true" />
      {!compact && (
        <span lang={locale === 'ar' ? 'en' : 'ar'}>{t.language.switchTo}</span>
      )}
    </Button>
  )
}
