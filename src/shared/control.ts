/**
 * Scoped control contract (AMP 0.5.0 scoped-control surface).
 *
 * AMP 0.5.0 introduces eight canonical control tools that adjust registry
 * metadata, defaults, interaction and scenario settings across a
 * `global → workspace → session` scope chain, with host-bound identities, CAS
 * versions, `dryRun` and atomic batches. This module is the shared half of that
 * contract: the enumerations, the view shapes and the pure validation rules.
 *
 * It deliberately holds **no runtime code**: the host store owns persistence,
 * the tools own argument parsing and the client owns presentation. Keeping the
 * vocabulary in `shared/` is what lets the tool schema, the HTTP route and the
 * panel agree without importing host modules into the browser bundle.
 */

/* ------------------------------------------------------------------------- *
 * Scopes
 * ------------------------------------------------------------------------- */

/** The three control scopes, most specific last. */
export const CONTROL_SCOPES = ['global', 'workspace', 'session'] as const
export type ControlScope = (typeof CONTROL_SCOPES)[number]

/** Inheritance order: a later scope overrides an earlier one. */
export const CONTROL_SCOPE_ORDER: readonly ControlScope[] = ['global', 'workspace', 'session']

/* ------------------------------------------------------------------------- *
 * Registries
 * ------------------------------------------------------------------------- */

/** Registry domains a control call may address (`knowledge` is file-backed). */
export const CONTROL_REGISTRIES = [
  'modules',
  'environments',
  'tools',
  'cognition',
  'capabilities',
  'abilities',
  'progress',
  'skills',
  'knowledge',
  'protocols',
  'concepts',
] as const
export type ControlRegistry = (typeof CONTROL_REGISTRIES)[number]

/** Registry actions, exactly the set AMP 0.5.0 documents plus the toggle pair. */
export const CONTROL_REGISTRY_ACTIONS = [
  'list',
  'get',
  'register',
  'update',
  'remove',
  'enable',
  'disable',
  'default_get',
  'default_set',
  'default_reset',
  'link',
  'unlink',
] as const
export type ControlRegistryAction = (typeof CONTROL_REGISTRY_ACTIONS)[number]

/** Actions that mutate state and therefore honour `expectedVersion`/`dryRun`. */
export const CONTROL_MUTATING_ACTIONS: ReadonlySet<ControlRegistryAction> = new Set([
  'register',
  'update',
  'remove',
  'enable',
  'disable',
  'default_set',
  'default_reset',
  'link',
  'unlink',
])

/* ------------------------------------------------------------------------- *
 * Settings domains
 * ------------------------------------------------------------------------- */

/** The two configurable domains. */
export const CONTROL_DOMAINS = ['interaction', 'scenario'] as const
export type ControlDomain = (typeof CONTROL_DOMAINS)[number]

/** Interaction modes (the `interaction` domain selector). */
export const INTERACTION_MODES = ['affect', 'think', 'inspire', 'converge', 'orchestrate'] as const
export type InteractionMode = (typeof INTERACTION_MODES)[number]

/** Scenario keys (the `scenario` domain selector). */
export const SCENARIO_KINDS = [
  'chat',
  'writing',
  'office',
  'collaboration',
  'investigation',
  'research',
  'engineering',
  'iteration',
] as const
export type ScenarioKind = (typeof SCENARIO_KINDS)[number]

/** Settings actions. */
export const CONTROL_SETTING_ACTIONS = ['get', 'set', 'reset'] as const
export type ControlSettingAction = (typeof CONTROL_SETTING_ACTIONS)[number]

/** Where a global/workspace write applies: only defaults, only sessions, or both. */
export const CONTROL_APPLY_TO = ['defaults', 'existing', 'all'] as const
export type ControlApplyTo = (typeof CONTROL_APPLY_TO)[number]

/* ------------------------------------------------------------------------- *
 * Views
 * ------------------------------------------------------------------------- */

/** One effective registry entry after inheritance and deletion markers. */
export interface ControlRecordView {
  scope: ControlScope
  registry: ControlRegistry
  id: string
  /** Registry value (JSON metadata only; never executable). */
  value: Record<string, unknown>
  /** Version of the record in the scope that supplied it. */
  version: number
  /** Version the caller must pass to overwrite this entry. */
  effectiveVersion: number
  /** Scope whose row supplied the value. */
  source: ControlScope
  /** False when the entry is marked disabled; callers hide it but keep the row. */
  enabled: boolean
  /** True when a more specific scope deleted an inherited entry. */
  deleted?: boolean
  created: number
  updated: number
}

/** One effective default value. */
export interface ControlDefaultView {
  scope: ControlScope
  key: string
  value: unknown
  version: number
  effectiveVersion: number
  source: ControlScope
  updated: number
}

/** One effective interaction/scenario setting. */
export interface ControlSettingView {
  scope: ControlScope
  domain: ControlDomain
  /** Selected mode/scenario for a single-choice setting. */
  value: string | null
  /** Weighted mix when the setting is a mix instead of a single choice. */
  mix: Record<string, number> | null
  /** The mix after inheritance is applied. */
  effectiveMix: Record<string, number> | null
  source: ControlScope
  version: number
  effectiveVersion: number
  /** Resolution plan, most specific scope first. */
  plan: Array<{ scope: ControlScope; value: string | null; mix: Record<string, number> | null; version: number }>
  updated: number
}

/** Result envelope of one control mutation. */
export interface ControlMutationResult {
  ok: true
  action: ControlRegistryAction | ControlSettingAction
  scope: ControlScope
  registry?: ControlRegistry
  domain?: ControlDomain
  /** Target id/key, when the action addressed one. */
  id?: string
  key?: string
  /** Version after the write (or the unchanged version for a dry run). */
  version: number
  /** True when the call validated a change without committing it. */
  dryRun: boolean
  /** Number of rows the call wrote (defaults plus inherited sessions). */
  changed: number
  /** The effective value after the change. */
  value?: unknown
}

/* ------------------------------------------------------------------------- *
 * Validation (pure)
 * ------------------------------------------------------------------------- */

/** Is `value` one of the declared control scopes? */
export function isControlScope(value: unknown): value is ControlScope {
  return typeof value === 'string' && (CONTROL_SCOPES as readonly string[]).includes(value)
}

/** Is `value` one of the declared registries? */
export function isControlRegistry(value: unknown): value is ControlRegistry {
  return typeof value === 'string' && (CONTROL_REGISTRIES as readonly string[]).includes(value)
}

/** Is `value` one of the declared registry actions? */
export function isControlRegistryAction(value: unknown): value is ControlRegistryAction {
  return typeof value === 'string' && (CONTROL_REGISTRY_ACTIONS as readonly string[]).includes(value)
}

/** Is `value` one of the declared settings actions? */
export function isControlSettingAction(value: unknown): value is ControlSettingAction {
  return typeof value === 'string' && (CONTROL_SETTING_ACTIONS as readonly string[]).includes(value)
}

/** Is `value` one of the declared settings domains? */
export function isControlDomain(value: unknown): value is ControlDomain {
  return typeof value === 'string' && (CONTROL_DOMAINS as readonly string[]).includes(value)
}

/** Is `value` a legal selector for `domain`? */
export function isControlSelector(domain: ControlDomain, value: unknown): boolean {
  if (typeof value !== 'string') return false
  const allowed: readonly string[] = domain === 'interaction' ? INTERACTION_MODES : SCENARIO_KINDS
  return allowed.includes(value)
}

/** Legal selectors for one domain, as a stable copy. */
export function controlSelectors(domain: ControlDomain): readonly string[] {
  return domain === 'interaction' ? INTERACTION_MODES : SCENARIO_KINDS
}

/**
 * Normalise a weighted mix.
 *
 * Returns `undefined` when the mix is not a non-empty object of finite,
 * non-negative numbers with at least one positive weight (the AMP 0.5.0 rule),
 * or when it names a key outside the domain's selector list.
 */
export function normaliseControlMix(
  domain: ControlDomain,
  raw: unknown,
): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const allowed = new Set(controlSelectors(domain))
  const mix: Record<string, number> = {}
  let positive = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(key)) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
    if (value > 0) positive += 1
    mix[key] = value
  }
  if (Object.keys(mix).length === 0 || positive === 0) return undefined
  return mix
}

/** Registry metadata must be a plain JSON object (no executable values). */
export function isControlRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
