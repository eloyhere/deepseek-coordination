/**
 * Host-following locale store for the browser half (v23 §22).
 *
 * DSH owns the language: this module reads `ctx.locale.getLocale().active`,
 * subscribes to its revision stream, and normalises the host tag (`zh` / `en`,
 * any region) onto the plugin's two shipped locales. It never calls
 * `setLocale`; switching language in DSH's own settings is the only input.
 *
 * The store is module-level and its snapshot is the frozen `Copy` object for the
 * active locale, so `useSyncExternalStore` returns a stable reference between
 * changes. That matters in the composer: a new snapshot on every render would
 * re-render the dropdowns while the user types, and emotion touching `<head>`
 * closes the host's popover (see `./index.ts`).
 */
import * as React from 'react'
import { DEFAULT_COPY, DEFAULT_LOCALE, copyFor, normaliseLocale } from '../shared/i18n.js'
import type { Copy, Locale } from '../shared/i18n.js'
import { reportLocale as postLocale } from './bridge.js'

/** The slice of `ctx.locale` this plugin needs; keeps the store testable. */
export interface LocaleHost {
  readonly locale: {
    getLocale(): { readonly active?: unknown }
    subscribe(listener: () => void): () => void
  }
}

let activeLocale: Locale = DEFAULT_LOCALE
let activeCopy: Copy = DEFAULT_COPY
let stop: (() => void) | null = null

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The current frozen copy object; stable until the host locale changes. */
function snapshot(): Copy {
  return activeCopy
}

function publish(next: Locale): void {
  if (next === activeLocale) return
  activeLocale = next
  activeCopy = copyFor(next)
  for (const listener of listeners) listener()
}

/** Read the host locale and adopt it, reporting it to the host half. */
function adopt(service: LocaleHost['locale'], forceReport: boolean): void {
  const next = normaliseLocale(service.getLocale().active)
  const changed = next !== activeLocale
  publish(next)
  // The host half rebuilds its tool descriptions from the last report.
  if (changed || forceReport) reportLocale(next)
}

/**
 * Install the store and start following the host. Called once from `apply`,
 * before any slot registration, so the first render already has the right copy.
 *
 * @param ctx - client context carrying the `locale` service.
 * @returns disposer that unsubscribes; the last language stays applied.
 */
export function installLocale(ctx: LocaleHost): () => void {
  if (stop !== null) return stop
  const service = ctx.locale
  adopt(service, true)
  const unsubscribe = service.subscribe(() => {
    adopt(service, false)
  })
  const dispose = (): void => {
    unsubscribe()
    stop = null
  }
  stop = dispose
  return dispose
}

/** Report a locale to the host half; fire-and-forget, normalised first. */
export function reportLocale(locale: unknown): void {
  void postLocale(normaliseLocale(locale))
}

/** The active locale tag, for memoising locale-dependent arrays. */
export function currentLocale(): Locale {
  return activeLocale
}

/** The active copy outside a component (slot labels, diagnostics). */
export function currentCopy(): Copy {
  return activeCopy
}

/** The active copy inside a component; stable between locale changes. */
export function useCopy(): Copy {
  return React.useSyncExternalStore(subscribe, snapshot, snapshot)
}
