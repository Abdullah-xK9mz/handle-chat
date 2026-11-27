'use client'

import { useEffect } from 'react'

export function PreventPullToRefresh() {
  useEffect(() => {
    let startY: number | null = null
    let startTarget: EventTarget | null = null

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        startY = null
        startTarget = null
        return
      }
      startY = event.touches[0]?.clientY ?? null
      startTarget = event.target
    }

    const canScrollTowardTop = (target: EventTarget | null) => {
      let element = target instanceof Element ? target : null
      while (element && element !== document.documentElement) {
        const style = window.getComputedStyle(element)
        if (
          /(auto|scroll|overlay)/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight &&
          element.scrollTop > 0
        ) return true
        element = element.parentElement
      }
      return (document.scrollingElement?.scrollTop ?? 0) > 0
    }

    const onTouchMove = (event: TouchEvent) => {
      if (startY === null || event.touches.length !== 1) return
      const currentY = event.touches[0]?.clientY
      if (currentY === undefined || currentY <= startY) return
      const target = startTarget instanceof Element ? startTarget : null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (!canScrollTowardTop(startTarget)) event.preventDefault()
    }

    const resetTouch = () => {
      startY = null
      startTarget = null
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true })
    document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
    document.addEventListener('touchend', resetTouch, { passive: true, capture: true })
    document.addEventListener('touchcancel', resetTouch, { passive: true, capture: true })
    return () => {
      document.removeEventListener('touchstart', onTouchStart, true)
      document.removeEventListener('touchmove', onTouchMove, true)
      document.removeEventListener('touchend', resetTouch, true)
      document.removeEventListener('touchcancel', resetTouch, true)
    }
  }, [])

  return null
}
