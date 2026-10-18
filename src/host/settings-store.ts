/**
 * Durable settings edits for the host's own knobs (v24 §19).
 *
 * DSH's settings service only persists fields whose schema node is volatile,
 * and a volatile node changes every parsed value into a reference wrapper —
 * which this host cannot adopt without rewriting every config reader. The
 * settings page therefore persists through this module instead: one small JSON
 * document beside the coordination database, holding only the paths the page
 * actually wrote.
 *
 * Contract:
 *  - the document is a flat `{ "<dotted.path>": scalar }` map, the same shape
 *    the `POST /config` route speaks, so nothing is nested twice;
 *  - a missing, unreadable or malformed file means "no overrides", never an
 *    error: a deployment that never opened the page has no state to load;
 *  - writes are atomic enough for one process (temp file + rename), so a crash
 *    mid-write cannot truncate the previous document;
 *  - the two deployment secrets are never stored: `applyConfigPatch` refuses
 *    them before this module is reached, and the filter is repeated here so a
 *    hand-edited file cannot smuggle them in.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConfigScalar } from '../shared/selection.js'

/** File name placed beside the coordination database. */
export const SETTINGS_FILE = 'config.overrides.json'

/** Paths this module must never persist, even when a patch names them. */
const REFUSED_KEYS: ReadonlySet<string> = new Set(['database', 'databasePath'])

/** The override document beside one database file. */
export function settingsPath(databasePath: string): string {
  return join(dirname(databasePath), SETTINGS_FILE)
}

/**
 * Read the stored overrides of one profile.
 *
 * Non-scalar entries and refused keys are dropped rather than surfaced: a
 * corrupt document must degrade to "no overrides", so the resolved config stays
 * exactly what the deployment patch describes.
 */
export function readOverrides(file: string): Record<string, ConfigScalar> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const overrides: Record<string, ConfigScalar> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (REFUSED_KEYS.has(key)) continue
    if (typeof value === 'string' || typeof value === 'boolean') overrides[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) overrides[key] = value
  }
  return overrides
}

/**
 * Merge one applied patch into the stored overrides.
 *
 * @returns true when the document now holds the patch; false when the directory
 * or file could not be written (the caller then reports `persisted: false`).
 */
export function writeOverrides(file: string, patch: Readonly<Record<string, ConfigScalar>>): boolean {
  const merged = readOverrides(file)
  for (const [key, value] of Object.entries(patch)) {
    if (REFUSED_KEYS.has(key)) continue
    merged[key] = value
  }
  const temporary = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
    return true
  } catch {
    return false
  }
}
