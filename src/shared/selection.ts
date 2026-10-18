/**
 * The Client ↔ Host selection wire contract (v23 §6, §15.1).
 *
 * The five composer dropdowns never touch the database directly: they read and
 * write one `SelectionState` through the host's HTTP route. The host projects
 * the persisted `Selection`, the lock state of the session's active turn, and
 * DSH's live permission-preset catalog into this single shape.
 */
import type { Selection, Turn } from './entity.js'
import type {
  CommandType,
  ControlName,
  Interaction,
  Profession,
  SandboxMode,
  Scene,
  SceneProfile,
  Validation,
} from './enum.js'
import {
  CommandValues,
  InteractionValues,
  ProfessionValues,
  SceneValues,
  ValidationValues,
} from './enum.js'

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
 * A running phase that freezes one composer dimension (v24 §15.1).
 *
 * Mapping: the active **turn** freezes `profession`, a running **plan** freezes
 * `validation`, and a set **goal** freezes `interaction`. A phase is over when
 * its row reaches a terminal status (turn done/failed/cancelled/abandoned, plan
 * done/failed/abandoned/rebuilt) or the goal is cleared; the host re-derives
 * this on every poll, so the freeze lifts automatically.
 */
export type SelectionPhase = 'turn' | 'plan' | 'goal'

/** One live freeze, with enough detail to explain when it lifts. */
export interface SelectionFreezeView {
  phase: SelectionPhase
  /** Ordinal of the turn that owns the phase. */
  turn: number
  /** Plan / goal handle when the phase owns a row. */
  handle?: string
  /** Raw status that keeps the phase open. */
  status: string
  /** Epoch ms when the phase row started, when known. */
  since?: number
}

/**
 * Every frozen composer dimension. Absent keys are editable; an old host build
 * omits the whole map, and the client then only applies the legacy `locked`
 * profession rule.
 */
export interface SelectionFreezeMap {
  profession?: SelectionFreezeView
  interaction?: SelectionFreezeView
  validation?: SelectionFreezeView
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
  /**
   * Composer dimensions frozen by the running turn / plan / goal.
   *
   * Optional on the wire: an old host build omits it and the client then only
   * applies the legacy `locked` profession rule. A new host re-derives it on
   * every poll, so a finished phase unfreezes without any client-side state.
   */
  frozen?: SelectionFreezeMap
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

/* ========================================================================= *
 * Full resolved configuration view (v24 §19)
 *
 * `SelectionStateConfig` above is the small composer projection. The settings
 * page needs every deployment knob, so this section declares the complete,
 * redacted view plus the flat patch contract `POST /config` accepts. Nothing
 * here carries `databasePath`, the database file name or a DSH credential.
 * ========================================================================= */

/** The eight plan dimensions, in the order the scorer uses them. */
export type PlanDimension =
  | 'feasibility'
  | 'coverage'
  | 'clarity'
  | 'specificity'
  | 'alignment'
  | 'risk'
  | 'cost'
  | 'efficiency'

export const PLAN_DIMENSIONS: readonly PlanDimension[] = [
  'feasibility',
  'coverage',
  'clarity',
  'specificity',
  'alignment',
  'risk',
  'cost',
  'efficiency',
]

/** Eight numbers keyed by dimension (weights or per-dimension thresholds). */
export type PlanDimensionValues = Record<PlanDimension, number>

/** `profession` config group, including the documented alias. */
export interface ConfigProfessionValues {
  enabled: boolean
  lock: boolean
  /** Alias of `defaults.profession`; the resolver always mirrors it. */
  default: Profession
  rebuildCanReselect: boolean
  abandonCanReselect: boolean
  audit: boolean
  errorHint: boolean
}

/** `plan` config group. */
export interface ConfigPlanValues {
  threshold: number
  maxRebuild: number
  weights: PlanDimensionValues
  dimensions: PlanDimensionValues
}

/** `orchestration` config group. */
export interface ConfigOrchestrationValues {
  maxReject: number
  maxSubTask: number
  groundTruth: boolean
  groundTruthTimeout: number
  allowShellGroundTruth: boolean
  modelRouting: boolean
}

/** `cache` config group. */
export interface ConfigCacheValues {
  enabled: boolean
  ttl: number
  fingerprintWindow: number
  effortWarning: boolean
}

/** `compaction` config group (automatic token-governor policy). */
export interface ConfigCompactionValues {
  auto: boolean
  soft: number
  hard: number
  reserve: number
  recentTurns: number
  cooldown: number
  maxPerSession: number
}

/** `bayesian` config group. */
export interface ConfigBayesianValues {
  prior: number
  stopEntropy: number
  infoGain: number
  maxRoutes: number
  calibrationFloor: number
}

/** `comprehension` config group. */
export interface ConfigComprehensionValues {
  stageTimeout: number
  searchEnabled: boolean
  maxEvidence: number
  highHistoryWindow: number
}

/** `ui` config group. */
export interface ConfigUiValues {
  /** @deprecated legacy alias of the composer workflow flag. */
  toolbar: boolean
  showTooltip: boolean
  takeover: boolean
  refreshInterval: number
  compact: boolean
  locale: string
}

/** `parser` config group (`docs/file-processing-v24.md` §4). */
export interface ConfigParserValues {
  enabled: boolean
  maxFileBytes: number
  maxTokens: number
  maxAstDepth: number
  timeoutMs: number
  cacheCapacity: number
  dependencyGraphMaxVertices: number
  dependencyGraphMaxEdges: number
}

/** `chain` config group (domain model §3/§7; read by the file-tool runtime). */
export interface ConfigChainValues {
  depth: number
  links: number
  tokenBudget: number
}

/** `tools` config group (model-facing output budget). */
export interface ConfigToolValues {
  maxResultBytes: number
}

/** `defaults` config group. */
export interface ConfigDefaultsValues {
  profession: Profession
  interaction: Interaction
  scene: Scene
  validation: Validation
  command: CommandType
}

/**
 * Every deployment knob, nested exactly like `CoordinationConfig`, minus the
 * database path, the database file name and every DSH credential.
 */
export interface ConfigValues {
  maxTurnPerSession: number
  defaultLease: number
  clarifyTimeout: number
  profession: ConfigProfessionValues
  plan: ConfigPlanValues
  orchestration: ConfigOrchestrationValues
  cache: ConfigCacheValues
  compaction: ConfigCompactionValues
  bayesian: ConfigBayesianValues
  comprehension: ConfigComprehensionValues
  ui: ConfigUiValues
  parser: ConfigParserValues
  chain: ConfigChainValues
  tools: ConfigToolValues
  scenes: Record<Scene, SceneProfile>
  defaults: ConfigDefaultsValues
}

/**
 * The wire shape of `GET /deepseek-coordination/config`:
 *  - `values`   — the live resolved config;
 *  - `defaults` — `resolveConfig(undefined)`, so the page can show a true
 *                 default without the client duplicating a single literal.
 */
export interface ConfigView {
  values: ConfigValues
  defaults: ConfigValues
}

/** One scalar a settings control may write. */
export type ConfigScalar = boolean | number | string

/** Flat patch: dotted config path -> scalar. `{ "plan.threshold": 0.6 }`. */
export type ConfigPatch = Readonly<Record<string, ConfigScalar>>

/** Answer body of `POST /deepseek-coordination/config`. */
export interface ConfigPatchResult {
  /** Paths that were written to the live config. */
  applied: string[]
  /** Known but non-editable paths (forced/read-only/planned); not written. */
  ignored: string[]
  /** True when the host persisted the patch through DSH settings. */
  persisted: boolean
  config: ConfigView
}

/* ========================================================================= *
 * Settings catalog — one descriptor per feature / config key
 * ========================================================================= */

/** Catalog groups, in render order. Distinct from the legacy page groups. */
export const SETTINGS_CATALOG_GROUPS = [
  'session',
  'profession',
  'scenes',
  'plan',
  'orchestration',
  'cache',
  'bayesian',
  'comprehension',
  'compaction',
  'ui',
  'parser',
  'chain',
  'tools',
] as const

export type SettingsCatalogGroupId = (typeof SETTINGS_CATALOG_GROUPS)[number]

/** The state chip a row shows (labels live in `settings.catalog.values.chips`). */
export const SETTINGS_CONTROL_CHIPS = ['host', 'local', 'forced', 'readOnly', 'planned'] as const

export type SettingsControlChip = (typeof SETTINGS_CONTROL_CHIPS)[number]

/** Local preference stores a `local` row writes (owned by `client/controls`). */
export type SettingsLocalStore = 'takeover' | 'workflow'

/** The input a row renders. */
export type SettingsControlKind = 'boolean' | 'number' | 'enum' | 'text'

/** One settings row: the single control for one feature or config key. */
export interface SettingsControl {
  /** Unique DOM id, e.g. `setting:plan.threshold`. */
  readonly id: string
  readonly group: SettingsCatalogGroupId
  /** Copy key: a legacy `settings.fields` id or a `settings.catalog.fields` id. */
  readonly copy: string
  readonly kind: SettingsControlKind
  readonly chip: SettingsControlChip
  /** Config paths this control writes; empty for local and derived rows. */
  readonly keys: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly options?: readonly string[]
  /** Present only for a scene-scoped row. */
  readonly scene?: Scene
  /**
   * True when the shipped runtime reads the value. False means the row is
   * honest about being stored-but-not-wired (the page shows that note).
   */
  readonly wired: boolean
  /** Local preference store for a `local` row. */
  readonly local?: SettingsLocalStore
  /** True for a row whose value is derived at render time (no config key). */
  readonly derived?: boolean
}

interface ControlSpec {
  readonly id?: string
  readonly group: SettingsCatalogGroupId
  readonly copy: string
  readonly kind: SettingsControlKind
  readonly chip?: SettingsControlChip
  readonly key?: string
  readonly keys?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly options?: readonly string[]
  readonly scene?: Scene
  readonly wired?: boolean
  readonly local?: SettingsLocalStore
  readonly derived?: boolean
}

function control(spec: ControlSpec): SettingsControl {
  const keys = spec.keys ?? (spec.key === undefined ? [] : [spec.key])
  const id = spec.id ?? (keys.length === 1 ? `setting:${keys[0]}` : `setting:${spec.copy}`)
  const chip = spec.chip ?? (keys.length === 0 ? 'readOnly' : 'host')
  return {
    id,
    group: spec.group,
    copy: spec.copy,
    kind: spec.kind,
    chip,
    keys,
    wired: spec.wired ?? keys.length > 0,
    ...(spec.min === undefined ? {} : { min: spec.min }),
    ...(spec.max === undefined ? {} : { max: spec.max }),
    ...(spec.step === undefined ? {} : { step: spec.step }),
    ...(spec.options === undefined ? {} : { options: spec.options }),
    ...(spec.scene === undefined ? {} : { scene: spec.scene }),
    ...(spec.local === undefined ? {} : { local: spec.local }),
    ...(spec.derived === true ? { derived: true } : {}),
  }
}

/* ---- Session and defaults ------------------------------------------------ */

const SESSION_CONTROLS: readonly SettingsControl[] = [
  control({ group: 'session', copy: 'maxTurnPerSession', key: 'maxTurnPerSession', kind: 'number', min: 1, max: 1_000_000, step: 1, wired: true }),
  control({ group: 'session', copy: 'defaultLease', key: 'defaultLease', kind: 'number', min: 1000, max: 86_400_000, step: 1000, wired: true }),
  // `clarifyTimeout` is the effective takeover/compaction timeout; there is no
  // second `takeover.timeout` key, so this one row is the only control for it.
  control({ group: 'session', copy: 'clarifyTimeout', key: 'clarifyTimeout', kind: 'number', min: 1000, max: 600_000, step: 1000, wired: true }),
  control({ group: 'session', copy: 'professionDefault', key: 'defaults.profession', kind: 'enum', options: ProfessionValues, wired: true }),
  control({ group: 'session', copy: 'defaultInteraction', key: 'defaults.interaction', kind: 'enum', options: InteractionValues, wired: true }),
  control({ group: 'session', copy: 'defaultScene', key: 'defaults.scene', kind: 'enum', options: SceneValues, wired: true }),
  control({ group: 'session', copy: 'defaultValidation', key: 'defaults.validation', kind: 'enum', options: ValidationValues, wired: true }),
  control({ group: 'session', copy: 'defaultCommand', key: 'defaults.command', kind: 'enum', options: CommandValues, wired: true }),
]

/* ---- Profession ---------------------------------------------------------- */

const PROFESSION_CONTROLS: readonly SettingsControl[] = [
  control({ group: 'profession', copy: 'professionEnabled', key: 'profession.enabled', kind: 'boolean', chip: 'forced', wired: true }),
  control({ group: 'profession', copy: 'professionLock', key: 'profession.lock', kind: 'boolean', chip: 'forced', wired: true }),
  // `profession.default` is the documented alias of `defaults.profession`. One
  // editable control exists (the `defaults.profession` row); this row only
  // shows the mirrored value, so the key is covered without a second write path.
  control({ group: 'profession', copy: 'professionDefaultAlias', key: 'profession.default', kind: 'enum', options: ProfessionValues, chip: 'readOnly', wired: false }),
  control({ group: 'profession', copy: 'professionRebuild', key: 'profession.rebuildCanReselect', kind: 'boolean', chip: 'forced', wired: true }),
  control({ group: 'profession', copy: 'professionAbandon', key: 'profession.abandonCanReselect', kind: 'boolean', chip: 'forced', wired: true }),
  control({ group: 'profession', copy: 'professionAudit', key: 'profession.audit', kind: 'boolean', wired: false }),
  control({ group: 'profession', copy: 'professionErrorHint', key: 'profession.errorHint', kind: 'boolean', wired: true }),
]

/* ---- Scenes (six scenes x eleven fields + two shared fields) ------------- */

interface SceneFieldSpec {
  readonly field: keyof SceneProfile
  readonly copy: string
  readonly kind: SettingsControlKind
  /** True when the turn pipeline or plan scorer reads this field today. */
  readonly wired?: boolean
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly options?: readonly string[]
}

/** Fields whose six defaults differ, therefore one row per scene. */
const SCENE_FIELDS: readonly SceneFieldSpec[] = [
  // Neither `thinking` nor `reasoningEffort` is a row: the host's main page owns
  // the model's reasoning controls, and this catalog must not duplicate them.
  { field: 'requirePlan', copy: 'scene.requirePlan', kind: 'boolean', wired: true },
  { field: 'requireScore', copy: 'scene.requireScore', kind: 'boolean', wired: true },
  { field: 'requireOutline', copy: 'scene.requireOutline', kind: 'boolean', wired: true },
  { field: 'requireRevision', copy: 'scene.requireRevision', kind: 'boolean', wired: true },
  { field: 'requirePredict', copy: 'scene.requirePredict', kind: 'boolean', wired: true },
  { field: 'requireCitation', copy: 'scene.requireCitation', kind: 'boolean', wired: true },
  // No execution-policy port; never rewrites the human permission preset.
  { field: 'allowBash', copy: 'scene.allowBash', kind: 'boolean' },
  { field: 'sandboxOnly', copy: 'scene.sandboxOnly', kind: 'boolean', wired: true },
  // No iterative consumer yet.
  { field: 'maxIteration', copy: 'scene.maxIteration', kind: 'number', min: 1, max: 1000, step: 1 },
]

/**
 * Fields whose six defaults are identical, therefore ONE shared control that
 * writes all six keys instead of six duplicate rows.
 */
const SCENE_SHARED_FIELDS: readonly SceneFieldSpec[] = [
  { field: 'allowWeb', copy: 'scene.allowWeb', kind: 'boolean', wired: true },
  { field: 'scoreThreshold', copy: 'scene.scoreThreshold', kind: 'number', wired: true, min: 0, max: 1, step: 0.01 },
]

const SCENE_CONTROLS: readonly SettingsControl[] = [
  ...SceneValues.flatMap((scene) =>
    SCENE_FIELDS.map((spec) =>
      control({
        group: 'scenes',
        copy: spec.copy,
        key: `scenes.${scene}.${spec.field}`,
        kind: spec.kind,
        scene,
        // The turn pipeline reads the policy fields marked `wired`; the
        // remaining knobs are saved and explicitly labelled as not consumed.
        wired: spec.wired === true,
        ...(spec.min === undefined ? {} : { min: spec.min }),
        ...(spec.max === undefined ? {} : { max: spec.max }),
        ...(spec.step === undefined ? {} : { step: spec.step }),
        ...(spec.options === undefined ? {} : { options: spec.options }),
      }),
    ),
  ),
  ...SCENE_SHARED_FIELDS.map((spec) =>
    control({
      id: `setting:scene.all.${spec.field}`,
      group: 'scenes',
      copy: spec.copy,
      keys: SceneValues.map((scene) => `scenes.${scene}.${spec.field}`),
      kind: spec.kind,
      // allowWeb reaches the comprehension search gate; the threshold row
      // reaches `plan.ts` (writing scene only, as documented).
      wired: spec.wired === true,
      ...(spec.min === undefined ? {} : { min: spec.min }),
      ...(spec.max === undefined ? {} : { max: spec.max }),
      ...(spec.step === undefined ? {} : { step: spec.step }),
      ...(spec.options === undefined ? {} : { options: spec.options }),
    }),
  ),
]

/* ---- Plan ---------------------------------------------------------------- */

const PLAN_CONTROLS: readonly SettingsControl[] = [
  control({ group: 'plan', copy: 'planThreshold', key: 'plan.threshold', kind: 'number', min: 0, max: 1, step: 0.01, wired: true }),
  control({ group: 'plan', copy: 'planMaxRebuild', key: 'plan.maxRebuild', kind: 'number', min: 0, max: 100, step: 1, wired: true }),
  ...PLAN_DIMENSIONS.map((dimension) =>
    control({
      group: 'plan',
      copy: `planWeight.${dimension}`,
      key: `plan.weights.${dimension}`,
      kind: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      wired: true,
    }),
  ),
  ...PLAN_DIMENSIONS.map((dimension) =>
    control({
      group: 'plan',
      copy: `planDimension.${dimension}`,
      key: `plan.dimensions.${dimension}`,
      kind: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      wired: true,
    }),
  ),
]

/* ---- Orchestration, cache, bayesian, comprehension ----------------------- */

const ORCHESTRATION_CONTROLS: readonly SettingsControl[] = [
  control({ group: 'orchestration', copy: 'maxReject', key: 'orchestration.maxReject', kind: 'number', min: 0, max: 100, step: 1, wired: true }),
  control({ group: 'orchestration', copy: 'maxSubTask', key: 'orchestration.maxSubTask', kind: 'number', min: 1, max: 1000, step: 1, wired: true }),
  control({ group: 'orchestration', copy: 'groundTruth', key: 'orchestration.groundTruth', kind: 'boolean', wired: true }),
  control({ group: 'orchestration', copy: 'groundTruthTimeout', key: 'orchestration.groundTruthTimeout', kind: 'number', min: 100, max: 600_000, step: 100, wired: false }),
  control({ group: 'orchestration', copy: 'allowShellGroundTruth', key: 'orchestration.allowShellGroundTruth', kind: 'boolean', wired: true }),
  control({ group: 'orchestration', copy: 'modelRouting', key: 'orchestration.modelRouting', kind: 'boolean', wired: true }),
]

const CACHE_CONTROLS: readonly SettingsControl[] = [
  control({ group: 'cache', copy: 'cacheEnabled', key: 'cache.enabled', kind: 'boolean', wired: true }),
  control({ group: 'cache', copy: 'cacheTtl', key: 'cache.ttl', kind: 'number', min: 0, max: 2_592_000_000, step: 1000, wired: true }),
  control({ group: 'cache', copy: 'cacheFingerprintWindow', key: 'cache.fingerprintWindow', kind: 'number', min: 1, max: 10_000, step: 1, wired: false }),
  control({ group: 'cache', copy: 'cacheEffortWarning', key: 'cache.effortWarning', kind: 'boolean', wired: true }),
]

const BAYESIAN_CONTROLS: readonly SettingsControl[] = [
  control({ group: 'bayesian', copy: 'prior', key: 'bayesian.prior', kind: 'number', min: 0, max: 1, step: 0.01, wired: true }),
  control({ group: 'bayesian', copy: 'stopEntropy', key: 'bayesian.stopEntropy', kind: 'number', min: 0, max: 10, step: 0.01, wired: true }),
  control({ group: 'bayesian', copy: 'infoGain', key: 'bayesian.infoGain', kind: 'number', min: 0, max: 10, step: 0.01, wired: true }),
  control({ group: 'bayesian', copy: 'maxRoutes', key: 'bayesian.maxRoutes', kind: 'number', min: 1, max: 1000, step: 1, wired: true }),
  control({ group: 'bayesian', copy: 'calibrationFloor', key: 'bayesian.calibrationFloor', kind: 'number', min: 0, max: 1, step: 0.01, wired: false }),
]

const COMPREHENSION_CONTROLS: readonly SettingsControl[] = [
  control({ group: 'comprehension', copy: 'stageTimeout', key: 'comprehension.stageTimeout', kind: 'number', min: 100, max: 600_000, step: 100, wired: true }),
  control({ group: 'comprehension', copy: 'webSearch', key: 'comprehension.searchEnabled', kind: 'boolean', wired: true }),
  control({ group: 'comprehension', copy: 'maxEvidence', key: 'comprehension.maxEvidence', kind: 'number', min: 1, max: 1000, step: 1, wired: true }),
  control({ group: 'comprehension', copy: 'highHistoryWindow', key: 'comprehension.highHistoryWindow', kind: 'number', min: 0, max: 100_000, step: 1, wired: true }),
]

/* ---- Compaction ---------------------------------------------------------- */

const COMPACTION_CONTROLS: readonly SettingsControl[] = [
  control({ group: 'compaction', copy: 'autoCompact', key: 'compaction.auto', kind: 'boolean', wired: true }),
  control({ group: 'compaction', copy: 'compactionThreshold', key: 'compaction.soft', kind: 'number', min: 0.3, max: 0.9, step: 0.01, wired: true }),
  control({ group: 'compaction', copy: 'hardPrune', key: 'compaction.hard', kind: 'number', min: 0.3, max: 0.98, step: 0.01, wired: true }),
  // Structural fields: the live token governor snapshots them at construction,
  // and the shipped `/config/compaction` patch path refuses to change them, so
  // the settings page only shows the resolved values.
  control({ group: 'compaction', copy: 'reserve', key: 'compaction.reserve', kind: 'number', min: 512, max: 10_000_000, step: 512, chip: 'readOnly', wired: true }),
  control({ group: 'compaction', copy: 'recentTurns', key: 'compaction.recentTurns', kind: 'number', min: 2, max: 20, step: 1, chip: 'readOnly', wired: true }),
  control({ group: 'compaction', copy: 'cooldown', key: 'compaction.cooldown', kind: 'number', min: 5000, max: 600_000, step: 1000, chip: 'readOnly', wired: true }),
  control({ group: 'compaction', copy: 'maxPerSession', key: 'compaction.maxPerSession', kind: 'number', min: 1, max: 10_000, step: 1, chip: 'readOnly', wired: true }),
]

/* ---- UI and display ------------------------------------------------------ */

const UI_CONTROLS: readonly SettingsControl[] = [
  control({ group: 'ui', copy: 'toolbarDeprecated', key: 'ui.toolbar', kind: 'boolean', chip: 'readOnly', wired: false }),
  control({ group: 'ui', copy: 'composerTooltips', key: 'ui.showTooltip', kind: 'boolean', wired: true }),
  control({ group: 'ui', copy: 'takeoverDialogs', key: 'ui.takeover', kind: 'boolean', wired: true }),
  control({ group: 'ui', copy: 'refreshInterval', key: 'ui.refreshInterval', kind: 'number', min: 500, max: 86_400_000, step: 500, wired: true }),
  control({ group: 'ui', copy: 'compact', key: 'ui.compact', kind: 'boolean', wired: true }),
  control({ group: 'ui', copy: 'defaultLocale', key: 'ui.locale', kind: 'enum', options: ['auto', 'zh-CN', 'en-US'], chip: 'readOnly', wired: true }),
  // The two genuinely local preferences: they live in this browser's storage,
  // not in host config, and are the effective switches for the composer.
  control({ group: 'ui', id: 'setting:local.takeoverPermission', copy: 'takeoverPermission', kind: 'boolean', chip: 'local', local: 'takeover', wired: true, derived: true }),
  control({ group: 'ui', id: 'setting:local.composerWorkflow', copy: 'composerWorkflow', kind: 'boolean', chip: 'local', local: 'workflow', wired: true, derived: true }),
  control({ group: 'ui', id: 'setting:derived.takeoverControl', copy: 'takeoverControl', kind: 'boolean', chip: 'readOnly', wired: false, derived: true }),
  control({ group: 'ui', id: 'setting:derived.permissionCatalog', copy: 'permissionCatalog', kind: 'text', chip: 'readOnly', wired: false, derived: true }),
  control({ group: 'ui', id: 'setting:derived.currentLocale', copy: 'currentLocale', kind: 'text', chip: 'readOnly', wired: false, derived: true }),
]

/** The fixed writing flow the writing scene enforces; shown as policy. */
const SCENE_POLICY_CONTROLS: readonly SettingsControl[] = [
  control({ group: 'scenes', id: 'setting:policy.writingFlow', copy: 'writingFlow', kind: 'text', chip: 'readOnly', wired: true, derived: true }),
]

/* ---- File layer: parser and chain projection ----------------------------- */

/**
 * The file tools (`src/host/tools.ts`) read the parser/chain config.
 *
 * All limits are consumed by the file tools: `parser.enabled` gates
 * registration, the parser/chain budgets are applied by the live `ToolRuntime`
 * and re-applied on config change, and `tools.maxResultBytes` caps every tool
 * render. The page still names the restart-only edge: disabling the parser
 * after registration removes tools only on the next registration.
 */
const PARSER_CONTROLS: readonly SettingsControl[] = [
  control({ group: 'parser', copy: 'parserEnabled', key: 'parser.enabled', kind: 'boolean' }),
  control({ group: 'parser', copy: 'maxFileBytes', key: 'parser.maxFileBytes', kind: 'number', min: 1024, max: 16_777_216, step: 1024 }),
  control({ group: 'parser', copy: 'maxTokens', key: 'parser.maxTokens', kind: 'number', min: 1, max: 2_000_000, step: 1000 }),
  control({ group: 'parser', copy: 'maxAstDepth', key: 'parser.maxAstDepth', kind: 'number', min: 1, max: 4096, step: 1 }),
  control({ group: 'parser', copy: 'timeoutMs', key: 'parser.timeoutMs', kind: 'number', min: 50, max: 60_000, step: 50 }),
  control({ group: 'parser', copy: 'cacheCapacity', key: 'parser.cacheCapacity', kind: 'number', min: 1, max: 100_000, step: 1 }),
  control({ group: 'parser', copy: 'dependencyGraphMaxVertices', key: 'parser.dependencyGraphMaxVertices', kind: 'number', min: 1, max: 1_000_000, step: 1000 }),
  control({ group: 'parser', copy: 'dependencyGraphMaxEdges', key: 'parser.dependencyGraphMaxEdges', kind: 'number', min: 1, max: 5_000_000, step: 1000 }),
]

const CHAIN_CONTROLS: readonly SettingsControl[] = [
  control({ group: 'chain', copy: 'chainDepth', key: 'chain.depth', kind: 'number', min: 1, max: 8, step: 1 }),
  control({ group: 'chain', copy: 'chainLinks', key: 'chain.links', kind: 'number', min: 1, max: 50, step: 1 }),
  control({ group: 'chain', copy: 'chainTokenBudget', key: 'chain.tokenBudget', kind: 'number', min: 100, max: 100_000, step: 100 }),
]

const TOOL_CONTROLS: readonly SettingsControl[] = [
  control({ group: 'tools', copy: 'toolMaxResultBytes', key: 'tools.maxResultBytes', kind: 'number', min: 0, max: 16_777_216, step: 1024 }),
]

/**
 * Every settings row, in render order. Exactly one row per config key; shared
 * scene fields write six keys from one row and are the only exception.
 */
export const SETTINGS_CONTROLS: readonly SettingsControl[] = [
  ...SESSION_CONTROLS,
  ...PROFESSION_CONTROLS,
  ...SCENE_CONTROLS,
  ...SCENE_POLICY_CONTROLS,
  ...PLAN_CONTROLS,
  ...ORCHESTRATION_CONTROLS,
  ...CACHE_CONTROLS,
  ...BAYESIAN_CONTROLS,
  ...COMPREHENSION_CONTROLS,
  ...COMPACTION_CONTROLS,
  ...UI_CONTROLS,
  ...PARSER_CONTROLS,
  ...CHAIN_CONTROLS,
  ...TOOL_CONTROLS,
]

/** True when a row can be written through `POST /config`. */
export function isEditableControl(value: SettingsControl): boolean {
  return value.chip === 'host' && value.keys.length > 0
}

/** All config paths the patch route accepts. */
export const EDITABLE_CONFIG_KEYS: ReadonlySet<string> = new Set(
  SETTINGS_CONTROLS.flatMap((value) => (isEditableControl(value) ? [...value.keys] : [])),
)

/** One control per config path; a shared scene row owns six paths. */
export const SETTINGS_CONTROLS_BY_KEY: ReadonlyMap<string, SettingsControl> = new Map(
  SETTINGS_CONTROLS.flatMap((value) => value.keys.map((key) => [key, value] as const)),
)

/**
 * Copy ids that live under `settings.catalog.fields`.
 *
 * The 28 ids of the pre-catalog page stay in `settings.fields`; these are the
 * new rows. `src/shared/i18n.ts` types its two dictionaries with this union, so
 * a missing translation is a type error, not a runtime fallback.
 */
export const SETTINGS_CATALOG_FIELD_IDS = [
  'maxTurnPerSession',
  'defaultLease',
  'clarifyTimeout',
  'defaultCommand',
  'professionEnabled',
  'professionDefaultAlias',
  'planThreshold',
  'planMaxRebuild',
  'planWeight.feasibility',
  'planWeight.coverage',
  'planWeight.clarity',
  'planWeight.specificity',
  'planWeight.alignment',
  'planWeight.risk',
  'planWeight.cost',
  'planWeight.efficiency',
  'planDimension.feasibility',
  'planDimension.coverage',
  'planDimension.clarity',
  'planDimension.specificity',
  'planDimension.alignment',
  'planDimension.risk',
  'planDimension.cost',
  'planDimension.efficiency',
  'maxReject',
  'maxSubTask',
  'groundTruthTimeout',
  'allowShellGroundTruth',
  'cacheTtl',
  'cacheFingerprintWindow',
  'cacheEffortWarning',
  'prior',
  'stopEntropy',
  'infoGain',
  'maxRoutes',
  'calibrationFloor',
  'stageTimeout',
  'maxEvidence',
  'highHistoryWindow',
  'recentTurns',
  'cooldown',
  'maxPerSession',
  'toolbarDeprecated',
  'parserEnabled',
  'maxFileBytes',
  'maxTokens',
  'maxAstDepth',
  'timeoutMs',
  'cacheCapacity',
  'dependencyGraphMaxVertices',
  'dependencyGraphMaxEdges',
  'chainDepth',
  'chainLinks',
  'chainTokenBudget',
  'toolMaxResultBytes',
  'scene.requirePlan',
  'scene.requireScore',
  'scene.requireOutline',
  'scene.requireRevision',
  'scene.requirePredict',
  'scene.requireCitation',
  'scene.allowBash',
  'scene.sandboxOnly',
  'scene.maxIteration',
  'scene.allowWeb',
  'scene.scoreThreshold',
] as const

export type SettingsCatalogFieldId = (typeof SETTINGS_CATALOG_FIELD_IDS)[number]

/** Rows grouped in render order. */
export function settingsControlsOf(group: SettingsCatalogGroupId): readonly SettingsControl[] {
  return SETTINGS_CONTROLS.filter((value) => value.group === group)
}

/** The scene rows of one scene (shared rows have no `scene`). */
export function settingsSceneControls(scene: Scene): readonly SettingsControl[] {
  return SETTINGS_CONTROLS.filter((value) => value.group === 'scenes' && value.scene === scene)
}

/** The rows that write all six scenes at once. */
export function settingsSharedSceneControls(): readonly SettingsControl[] {
  return SETTINGS_CONTROLS.filter((value) => value.group === 'scenes' && value.scene === undefined && value.keys.length > 1)
}

/* ---- Path helpers -------------------------------------------------------- */

/**
 * Decimal places a catalog step implies.
 *
 * `0.01` → 2, `0.001` → 3, `1` → 0. The cap keeps a pathological step from
 * producing a wall of digits; every real step in this catalog is ≤ 3 places.
 */
export function stepDecimals(step: number | undefined): number {
  if (step === undefined || !Number.isFinite(step) || step <= 0) return 0
  const text = step.toFixed(12).replace(/0+$/, '')
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : Math.min(6, text.length - dot - 1)
}

/**
 * Format one config number for display, rounded to the row's step precision.
 *
 * Resolvers renormalise the eight plan weights, so a stored `0.15` comes back as
 * `0.15000000000000002`; the row must show `0.15`. Rounding happens only for
 * display — the wire still carries the exact value the host reported, and a
 * write sends whatever the operator typed.
 */
export function formatConfigNumber(value: number, step?: number): string {
  if (!Number.isFinite(value)) return String(value)
  // `Number` drops trailing zeros, so 0.5 with a 0.01 step shows as "0.5".
  return String(Number(value.toFixed(stepDecimals(step))))
}

/** Read one dotted config path; `undefined` when any segment is missing. */
export function readConfigPath(source: unknown, path: string): unknown {
  let cursor: unknown = source
  for (const part of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

/** Write one dotted config path into a plain object tree (creating nodes). */
export function writeConfigPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor = target
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      cursor[part] = {}
    }
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1] as string] = value
}

/**
 * Validate one scalar against a control's type/range/options.
 *
 * Pure and locale-free: the client turns a non-`undefined` answer into its own
 * localised inline error, while the host maps it to `INVALID_ARGUMENT`.
 */
export function validateConfigScalar(value: SettingsControl, input: unknown): string | undefined {
  switch (value.kind) {
    case 'boolean':
      return typeof input === 'boolean' ? undefined : 'expected a boolean'
    case 'number': {
      if (typeof input !== 'number' || !Number.isFinite(input)) return 'expected a finite number'
      if (value.min !== undefined && input < value.min) return `must be at least ${value.min}`
      if (value.max !== undefined && input > value.max) return `must be at most ${value.max}`
      return undefined
    }
    case 'enum': {
      const options = value.options ?? []
      return typeof input === 'string' && options.includes(input)
        ? undefined
        : `must be one of ${options.join(', ')}`
    }
    case 'text':
      if (typeof input !== 'string' || input.trim().length === 0) return 'expected a non-empty string'
      return input.length > 200 ? 'must be at most 200 characters' : undefined
  }
}
