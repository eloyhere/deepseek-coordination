/**
 * Composer selection: the wire-config projection, the poll signature, and the
 * two bounded caches the composer uses.
 *
 * Kept free of React, MUI and DOM imports on purpose: the rules here are pure
 * functions over the `SelectionState` wire shape, so they can be unit-tested
 * under plain Node and reused by any future surface without pulling the UI in.
 *
 * Three properties matter for the complexity audit:
 *
 *  - `selectionStateSignature` is the cheapest exact comparison of the rendered
 *    state that was measured: one `JSON.stringify` of the same JSON array the
 *    composer always used, memoised by state identity. The alternatives the
 *    audit measured (a field walk and `stableHash`) were 2.7-3.2x slower and the
 *    hash also introduced a collision risk, so the encoding did not change —
 *    only the number of serialisations per poll (three or four -> one; zero when
 *    the state is unchanged). See `docs/complexity-audit-v24.md` §3.7.
 *  - `SelectionStateCache` is bounded: one browser page only ever renders one
 *    session, but the old `Map` grew with every DSH session the page was
 *    mounted under. Evicting a cached state only costs one poll (the composer
 *    shows its loading line until the host answers); it never loses a choice,
 *    because writes go to the host and the offline copy in localStorage.
 *  - `selectStyle` is bounded and pure: it memoises the small `sx` object by
 *    (width, compact) and returns the same frozen-shape object for the same
 *    input, exactly as the previous module-level map did.
 */
import type { SelectionState, SelectionStateConfig } from '../shared/selection.js'
import { LruList } from '../shared/lru.js'

/* ------------------------------------------------------------------------- *
 * Host config projection (added to SelectionState by the host owner)
 * ------------------------------------------------------------------------- */

/** The host config projection (compaction included when the host sends it). */
export type SelectionConfigView = Partial<SelectionStateConfig>

const EMPTY_CONFIG: SelectionConfigView = {}

/**
 * Read the host config projection (v24 §15.2).
 *
 * `SelectionState.config` stays optional on the wire so a client built against
 * an older host typechecks and renders. An absent or non-object projection is
 * "unknown", never "all defaults off": the settings page then says
 * "跟随主机配置" instead of inventing a value.
 */
export function selectionConfig(state: SelectionState | null): SelectionConfigView {
  if (state === null) return EMPTY_CONFIG
  const config: unknown = state.config
  return typeof config === 'object' && config !== null
    ? (config as SelectionConfigView)
    : EMPTY_CONFIG
}

/* ------------------------------------------------------------------------- *
 * Poll signature
 * ------------------------------------------------------------------------- */

/**
 * Identity memo for the poll signature.
 *
 * `SelectionState` objects are treated as immutable by this module: the host
 * sends a fresh object per answer, `applyPatch` and `applyLocalCompaction`
 * build new objects, and no code mutates one after it has been applied. That
 * makes object identity a safe cache key, and it turns the common case — the
 * previous state, the feed's state and the freshly accepted state in one poll —
 * from three or four serialisations into one.
 *
 * The `WeakMap` does not retain a state: a state that is no longer rendered is
 * collected with its signature.
 */
const signatureByState = new WeakMap<SelectionState, string>()

/**
 * The serialised state the composer and the settings feed compare.
 *
 * One `JSON.stringify` over the rendered fields, memoised by state identity.
 *
 * Two alternatives were measured and rejected (see
 * `docs/complexity-audit-v24.md`): a length-prefixed field walk took 4.2 µs per
 * call against 1.5 µs here, and `stableHash` over the same payload took 5.1 µs
 * while introducing a 32-bit collision risk. `JSON.stringify` is the cheapest
 * exact comparison for this payload; the audit's win is the identity memo
 * (4 calls -> 1 per poll) and the bounded caches, not a different encoding.
 */
export function selectionStateSignature(state: SelectionState): string {
  const memoised = signatureByState.get(state)
  if (memoised !== undefined) return memoised
  const signature = JSON.stringify([
    state.locked,
    state.preset ?? '',
    state.selection.profession,
    state.selection.interaction,
    state.selection.scene,
    state.selection.validation,
    state.selection.command,
    state.turn?.identity ?? 0,
    state.turn?.profession ?? '',
    state.presets.map((preset) => [preset.value, preset.name, preset.description ?? '', preset.sandbox ?? '']),
    state.tooltip,
    // The optional config projection travels with the host answer; a change in
    // it must reach the settings page even when the selection itself is equal.
    selectionConfig(state),
  ])
  signatureByState.set(state, signature)
  return signature
}

/* ------------------------------------------------------------------------- *
 * Bounded caches
 * ------------------------------------------------------------------------- */

/**
 * Sessions whose last host-confirmed selection is kept in memory.
 *
 * A page renders one session; the cache exists so a remount does not flash the
 * loading line. Thirty-two sessions is far above the realistic mount history
 * and bounds the retained `SelectionState` objects (each includes the preset
 * catalog).
 */
export const SelectionStateCacheCapacity = 32

/**
 * Last known selection per session, bounded by `SelectionStateCacheCapacity`.
 *
 * Reads promote the session so the one being polled is the last to be evicted.
 */
export class SelectionStateCache {
  private readonly store: LruList<string, SelectionState>

  /**
   * @param capacity Maximum remembered sessions; defaults to
   *   `SelectionStateCacheCapacity` and exists as a parameter so the cap is
   *   testable without mounting thirty-two sessions.
   */
  constructor(capacity: number = SelectionStateCacheCapacity) {
    this.store = new LruList<string, SelectionState>(capacity)
  }

  /** Live entries; at most `capacity`. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /** Configured maximum number of live entries. Time O(1). */
  get capacity(): number {
    return this.store.capacity
  }

  /** Read a session's cached state and mark it recently used. Time O(1). */
  get(session: string): SelectionState | undefined {
    return this.store.get(session)
  }

  /** Remember a session's state. Time O(1) amortized. */
  set(session: string, state: SelectionState): void {
    this.store.set(session, state)
  }

  /** Drop every cached state; used when the plugin unmounts. Time O(n). */
  clear(): void {
    this.store.clear()
  }
}

/**
 * Distinct (width, compact) select styles kept at once.
 *
 * Widths come from a handful of layout constants, so the keys are structurally
 * capped long before this bound; the cap only protects against a layout that
 * reports a new width every render.
 */
export const SelectStyleCacheCapacity = 64

const styleCache = new LruList<number, Record<string, unknown>>(SelectStyleCacheCapacity)

/** The `sx` object for one select width, memoised by width and density. */
export function selectStyle(width: number, compact: boolean): Record<string, unknown> {
  const key = width * 2 + (compact ? 1 : 0)
  const cached = styleCache.get(key)
  if (cached !== undefined) return cached
  const style = {
    width,
    fontSize: compact ? 12 : 13,
    height: compact ? 28 : 32,
    backgroundColor: 'transparent',
  }
  styleCache.set(key, style)
  return style
}

/** Drop every memoised select style; used when the plugin unmounts. */
export function clearSelectStyles(): void {
  styleCache.clear()
}
