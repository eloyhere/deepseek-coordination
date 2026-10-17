/**
 * The Client ↔ Host selection wire contract (v23 §6, §15.1).
 *
 * The five composer dropdowns never touch the database directly: they read and
 * write one `SelectionState` through the host's HTTP route. The host projects
 * the persisted `Selection`, the lock state of the session's active turn, and
 * DSH's live permission-preset catalog into this single shape.
 */
import type { Selection, Turn } from './entity.js'
import type { ControlName, Interaction, Profession, SandboxMode, Scene, Validation } from './enum.js'

/** One DSH permission preset, projected for the dropdown. */
export interface PermissionPresetView {
  /** Preset key accepted by `POST /selection` and `POST /permission`. */
  value: string
  /** Human label, exactly as DSH's own access-mode menu shows it. */
  name: string
  description?: string
  /** Effective sandbox mode of the preset, when DSH exposes it. */
  sandbox?: SandboxMode | string
  /** Effective approval policy of the preset, when DSH exposes it. */
  approval?: string
}

/**
 * The automatic compaction policy, projected read-only for the settings page.
 *
 * The same thresholds the host-side token governor reads: `soft`/`hard` are
 * utilisation ratios against the effective window (`contextWindow - reserve`),
 * `reserve` is the output headroom in tokens, `recentTurns` counts verbatim
 * recent turns, and `cooldown`/`maxPerSession` bound automatic compaction.
 * The settings page may patch only `auto`, `soft` and `hard`; the structural
 * fields are deployment configuration.
 */
export interface SelectionCompactionView {
  auto: boolean
  soft: number
  hard: number
  reserve: number
  recentTurns: number
  cooldown: number
  maxPerSession: number
}

/** The active turn, reduced to the fields the composer needs. */
export interface SelectionLockView {
  identity: number
  handle: string
  ordinal: number
  status: string
  profession: Turn['profession']
  locked: boolean
}

/**
 * The resolved host config the composer and the settings page need, projected
 * into the selection response (v24 §15.2, `docs/ui-copy-v24.md` §3).
 *
 * This is a deliberately small, read-only projection: it carries the host
 * defaults and the forced switches, never the database path, DSH credentials or
 * any other deployment secret. Every field is derived from the resolved
 * `CoordinationConfig`; nothing here is a second source of truth.
 */
export interface SelectionStateConfig {
  /** `defaults.profession`: the profession used before a choice is stored. */
  defaultProfession: Profession
  /** `defaults.interaction`: the interaction used before a choice is stored. */
  defaultInteraction: Interaction
  /** `defaults.scene`: the scene used before a choice is stored. */
  defaultScene: Scene
  /** `defaults.validation`: the validation level used before a choice is stored. */
  defaultValidation: Validation
  /** `ui.showTooltip`: whether the composer may render tooltips at all. */
  showTooltip: boolean
  /** `ui.takeover`: whether the coordination permission dropdown replaces DSH's. */
  takeover: boolean
  /**
   * `ui.toolbar`: the deprecated host-side alias of the composer workflow flag.
   * When false the four coordination dropdowns should not be contributed.
   */
  workflow: boolean
  /** `ui.locale`: the configured host copy locale (`auto` follows DSH). */
  locale: string
  /** `ui.refreshInterval`: how often the client should resynchronise, in ms. */
  refreshInterval: number
  /** `cache.enabled`: whether the comprehension result cache is active. */
  cacheEnabled: boolean
  /** `comprehension.searchEnabled`: whether every level may search the web. */
  searchEnabled: boolean
  /**
   * `profession.audit`: reserved for a future trace-audit policy switch; the
   * profession module always writes its trace events today.
   */
  audit: boolean
  /** `profession.errorHint`: whether lock rejections carry the escape hatch. */
  errorHint: boolean
  /** `profession.rebuildCanReselect` (forced true): rebuild permits a new choice. */
  rebuildCanReselect: boolean
  /** `profession.abandonCanReselect` (forced true): the next turn may choose anew. */
  abandonCanReselect: boolean
  /**
   * `compaction`: the automatic token-governor thresholds (v24 §5). Read by the
   * settings page to render the policy; a patch may change only auto/soft/hard.
   * Distinct from the per-session `compact` records.
   */
  compaction: SelectionCompactionView
}

/** Everything the composer needs to render one session's five dropdowns. */
export interface SelectionState {
  /** DSH session id; the coordination selection is keyed by this string. */
  session: string
  /** The persisted choice for the next turn. */
  selection: Selection
  /** True while the session has a non-terminal turn: profession is read-only. */
  locked: boolean
  /** The turn that holds the lock, when there is one. */
  turn?: SelectionLockView
  /** DSH's live permission presets; empty when the host exposes none. */
  presets: PermissionPresetView[]
  /** The preset currently in force for the session, when known. */
  preset?: string
  /** The deployment default sandbox mode, used to explain an empty catalog. */
  defaultMode?: string
  /** Host config: whether the tooltip copy should be shown at all. */
  tooltip: boolean
  /**
   * The resolved config projection (v24 §15.2). Optional on the wire so a
   * client built before this field existed still typechecks and renders: an
   * absent projection means "use local defaults", never "config is empty".
   */
  config?: SelectionStateConfig
}

/** Fields the composer may patch. Absent fields keep their stored value. */
export interface SelectionPatch {
  profession?: Selection['profession']
  interaction?: Selection['interaction']
  scene?: Selection['scene']
  validation?: Selection['validation']
  command?: Selection['command']
  /** DSH permission preset key; applied through `permissionPresets.set`. */
  preset?: string
}

/** Runtime description of one dropdown, used by docs and copy audits. */
export interface ControlDescriptor {
  name: ControlName
  label: string
  hint: string
  options: ReadonlyArray<{ value: string; label: string; hint: string }>
}
