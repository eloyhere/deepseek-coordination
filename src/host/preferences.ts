/**
 * Runtime preferences for the AMP takeovers.
 *
 * These are deliberately separate from `Config`: config is deployment scope and
 * needs a restart, while a takeover switch is a user decision that must survive
 * a page reload and take effect on the next tool call. The store keeps the
 * shape small, validates every boolean and writes atomically.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface AmpPreferences {
  /** Prefer AMP `workspace.*` reads over the harness' native reader. */
  takeoverFileRead: boolean
  /** Prefer AMP CAS-guarded text writes over native file writes and edits. */
  takeoverFileWrite: boolean
  /** Route host file searches through the AMP-backed discover tool. */
  takeoverSearch: boolean
  /** Route host notifications through the AMP notification centre. */
  takeoverNotifications: boolean
  /** Compile AMP attention into the model context on every turn. */
  contextOptimization: boolean
  /** Client surfaces poll the AMP snapshot automatically. */
  autoRefresh: boolean
  /** Catalog rows hide their summary line until opened. */
  compactCatalog: boolean
}

export const PREFERENCE_KEYS = [
  'takeoverFileRead',
  'takeoverFileWrite',
  'takeoverSearch',
  'takeoverNotifications',
  'contextOptimization',
  'autoRefresh',
  'compactCatalog',
] as const satisfies readonly (keyof AmpPreferences)[]

export const DEFAULT_PREFERENCES: AmpPreferences = {
  takeoverFileRead: false,
  takeoverFileWrite: false,
  takeoverSearch: false,
  takeoverNotifications: true,
  contextOptimization: true,
  autoRefresh: true,
  compactCatalog: false,
}

function readFile(file: string): Partial<AmpPreferences> {
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Partial<AmpPreferences>
  } catch {
    return {}
  }
}

function sanitize(value: Partial<AmpPreferences>, fallback: AmpPreferences): AmpPreferences {
  const next = { ...fallback }
  for (const key of PREFERENCE_KEYS) {
    if (typeof value[key] === 'boolean') next[key] = value[key] as boolean
  }
  return next
}

export class AmpPreferencesStore {
  private readonly file: string
  private state: AmpPreferences

  constructor(file: string, defaults: AmpPreferences = DEFAULT_PREFERENCES) {
    this.file = file
    this.state = sanitize(readFile(file), defaults)
  }

  get(): AmpPreferences {
    return { ...this.state }
  }

  /**
   * Apply a JSON patch. Unknown keys are ignored rather than rejected so an
   * older page can post its whole preference object to a newer host.
   */
  update(patch: unknown): AmpPreferences {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new Error('preferences patch must be a JSON object')
    }
    const next = sanitize(patch as Partial<AmpPreferences>, this.state)
    this.state = next
    this.persist()
    return { ...next }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.file)
    } catch {
      // Preferences are ergonomic state; a read-only home must not fail a call.
    }
  }
}
