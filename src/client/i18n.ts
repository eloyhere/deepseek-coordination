/**
 * Client-side locale store. DSH owns the language; `apply` pushes the active
 * locale here, and components subscribe through `useCopy`.
 */
import * as React from 'react'
import { copyFor, DEFAULT_LOCALE, normaliseLocale, type Copy, type Locale } from '../shared/i18n.js'

let activeLocale: Locale = DEFAULT_LOCALE
let activeCopy: Copy = copyFor(activeLocale)
const listeners = new Set<() => void>()

export function currentLocale(): Locale {
  return activeLocale
}

export function currentCopy(): Copy {
  return activeCopy
}

export function setLocale(value: unknown): void {
  const next = normaliseLocale(value)
  if (next === activeLocale) return
  activeLocale = next
  activeCopy = copyFor(next)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Re-render the caller when the active locale changes. */
export function useCopy(): Copy {
  return React.useSyncExternalStore(subscribe, currentCopy, currentCopy)
}
