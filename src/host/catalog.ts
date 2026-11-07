/**
 * Locale-aware registration of the AMP skill catalog and human commands.
 *
 * DSH owns the interface language on the client and exposes no host-side locale
 * service, so the host starts from the process locale and re-registers the
 * catalog whenever a client reports a different active language.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AmpHost } from './amp.js'
import { registerAmpCommands } from './commands.js'
import { registerAmpSkills } from './skills.js'
import { DEFAULT_LOCALE, normaliseLocale, type Locale } from '../shared/i18n.js'

export interface LocalizedCatalogOptions {
  /** Register the AMP skills when the deployment enables them. */
  readonly skills: boolean
  /** Register the `/amp` and `/amp-modules` commands when the deployment enables them. */
  readonly commands: boolean
}

export interface LocalizedCatalog {
  /** The language the currently registered catalog copy uses. */
  readonly locale: Locale
  /**
   * Re-register the catalog when `value` names a different shipped locale.
   * @returns whether the catalog was rebuilt.
   */
  setLocale(value: unknown): boolean
  /** Remove every skill and command this catalog registered. */
  dispose(): void
}

/**
 * Register the AMP catalog in `initialLocale` and keep it aligned with the
 * active host language.
 * @param ctx - plugin context owning the registrations.
 * @param host - AMP host whose modules feed the skill bodies.
 * @param initialLocale - language used before any client reports one.
 * @param options - which registries the deployment enables.
 * @returns the switchable catalog handle.
 */
export function openLocalizedCatalog(
  ctx: Context,
  host: AmpHost,
  initialLocale: Locale,
  options: LocalizedCatalogOptions,
): LocalizedCatalog {
  let locale = initialLocale
  let closeCurrent: (() => void) | undefined

  const register = (): void => {
    closeCurrent?.()
    const disposers: Array<() => void> = []
    if (options.skills) disposers.push(registerAmpSkills(ctx, host, locale))
    if (options.commands) disposers.push(registerAmpCommands(ctx, host, locale))
    closeCurrent = () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }

  register()

  return {
    get locale(): Locale {
      return locale
    },
    setLocale(value: unknown): boolean {
      const next = normaliseLocale(value)
      if (next === locale) return false
      locale = next
      register()
      return true
    },
    dispose(): void {
      closeCurrent?.()
      closeCurrent = undefined
    },
  }
}

/** Guess the host language before a client reports its own. */
export function hostLocale(): Locale {
  try {
    return normaliseLocale(Intl.DateTimeFormat().resolvedOptions().locale)
  } catch {
    return DEFAULT_LOCALE
  }
}
