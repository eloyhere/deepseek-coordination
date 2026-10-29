/**
 * The composer selection (v23 §6, §15.1).
 *
 * One row of the `selection` table holds the five dropdown choices for the
 * *next* turn of one DSH session. The profession is writable only while the
 * session has no active turn: once a turn exists its profession is locked and
 * the only lawful changes are `rebuildTurn` / `abandonTurn`.
 *
 * The permission dropdown is not persisted here. DSH owns the preset, so the
 * module reads the live preset back through `PermissionPresetPort` and applies
 * a new one through the same port; the plugin never keeps a second copy of a
 * sandbox or approval value.
 */
import type { ModuleHost, PermissionPresetOption } from './module.js'
import type { Selection, Turn } from '../shared/entity.js'
import type {
  CommandType,
  Interaction,
  Profession,
  Scene,
  Validation,
} from '../shared/enum.js'
import {
  CommandValues,
  InteractionLabel,
  InteractionValues,
  PermissionLabel,
  ProfessionValues,
  SceneValues,
  ValidationValues,
  isOneOf,
  toCommandType,
  toInteraction,
  toProfession,
  toScene,
  toValidation,
} from '../shared/enum.js'
import type {
  ConfigPatch,
  ConfigValues,
  ConfigView,
  PermissionPresetView,
  SelectionLockView,
  SelectionPatch,
  SelectionFreezeMap,
  SelectionFreezeView,
  SelectionPhase,
  SelectionState,
  SelectionStateConfig,
  SettingsControl,
} from '../shared/selection.js'
import {
  EDITABLE_CONFIG_KEYS,
  SETTINGS_CONTROLS_BY_KEY,
  isEditableControl,
  validateConfigScalar,
  writeConfigPath,
} from '../shared/selection.js'
import { Config, resolveCompaction, resolveConfig, type CoordinationConfig } from './config.js'
import {
  InvalidArgumentError,
  InvalidStateError,
  NotImplementedError,
  ProfessionLockedError,
} from '../shared/error.js'
import { assertProfession, type ProfessionModule } from './profession.js'
import { mapSelection, mapTurn, number, text } from './row.js'
import type { Row } from './row.js'

const ACTIVE_TURN = `status NOT IN ('done', 'failed', 'cancelled', 'abandoned')`

/** Plan statuses that keep the plan (and therefore `validation`) frozen. */
const ACTIVE_PLAN: ReadonlySet<string> = new Set(['draft', 'scored', 'active'])

/** A goal row that is not a `cleared` tombstone keeps `interaction` frozen. */
const CLEARED_GOAL = 'cleared'

/** The active turn plus the status of the plan/goal it points at. */
interface PhaseRow {
  ordinal: number
  status: string
  created: number
  planHandle?: string
  planStatus?: string
  planCreated?: number
  goalHandle?: string
  goalStatus?: string
  goalCreated?: number
}

export class SelectionModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  /** The persisted choice, materialised from config defaults when absent. */
  get(session: string): Selection {
    assertSessionId(session)
    const row = this.host.db.get<Row>('SELECT * FROM selection WHERE session = ?', session)
    if (row !== undefined) return mapSelection(row)
    return {
      session,
      profession: toProfession(this.host.config.defaults.profession),
      interaction: toInteraction(this.host.config.defaults.interaction),
      scene: toScene(this.host.config.defaults.scene),
      validation: toValidation(this.host.config.defaults.validation),
      command: toCommandType(this.host.config.defaults.command),
      locked: false,
      changed: this.host.clock.now(),
    }
  }

  /** Everything the five composer dropdowns need for one session. */
  state(session: string): SelectionState {
    assertSessionId(session)
    const selection = this.get(session)
    const turn = this.activeTurn(session)
    const frozen = this.frozenPhases(session)
    const presets = this.listPreset()
    const preset = this.currentPreset(session)
    const config = this.configuration()
    return {
      session,
      selection: { ...selection, locked: turn !== undefined },
      locked: turn !== undefined,
      ...(turn === undefined ? {} : { turn }),
      presets,
      ...(preset === undefined ? {} : { preset }),
      // The live port is typed `string`, but a foreign object can omit it; a
      // present-but-undefined key would make the tool result non-lossless.
      ...(this.host.sandboxPolicy === undefined ||
      typeof this.host.sandboxPolicy.defaultMode !== 'string' ||
      this.host.sandboxPolicy.defaultMode.length === 0
        ? {}
        : { defaultMode: this.host.sandboxPolicy.defaultMode }),
      tooltip: config.showTooltip,
      config,
      ...(Object.keys(frozen).length === 0 ? {} : { frozen }),
    }
  }

  /**
   * Project the resolved host config for the composer and the settings page
   * (v24 §15.2). This is the only place the selection wire shape reads config;
   * the database path and every DSH credential stay out of the projection.
   */
  configuration(): SelectionStateConfig {
    const config = this.host.config
    return {
      defaultProfession: toProfession(config.defaults.profession),
      defaultInteraction: toInteraction(config.defaults.interaction),
      defaultScene: toScene(config.defaults.scene),
      defaultValidation: toValidation(config.defaults.validation),
      showTooltip: config.ui.showTooltip,
      takeover: config.ui.takeover,
      // `ui.toolbar` is the deprecated host-side alias of the composer workflow
      // flag; projecting it here keeps the legacy key meaningful (v24 §3).
      workflow: config.ui.toolbar,
      locale: config.ui.locale,
      refreshInterval: config.ui.refreshInterval,
      cacheEnabled: config.cache.enabled,
      searchEnabled: config.comprehension.searchEnabled,
      audit: config.profession.audit,
      errorHint: config.profession.errorHint,
      rebuildCanReselect: config.profession.rebuildCanReselect,
      abandonCanReselect: config.profession.abandonCanReselect,
      // Whitelist projection of the token-governor policy (v24 §5): the
      // settings page renders exactly these seven fields and may patch only
      // auto/soft/hard. Nothing else from `compaction` is exposed.
      compaction: {
        auto: config.compaction.auto,
        soft: config.compaction.soft,
        hard: config.compaction.hard,
        reserve: config.compaction.reserve,
        recentTurns: config.compaction.recentTurns,
        cooldown: config.compaction.cooldown,
        maxPerSession: config.compaction.maxPerSession,
      },
    }
  }

  /**
   * Store one patch. The running phases are enforced here, not only in the
   * composer: a profession change against an active turn is refused, a
   * `validation` change while the turn's plan is open is refused, and an
   * `interaction` change while the turn's goal is set is refused. The other
   * dimensions are preferences for the next turn and stay writable.
   *
   * The phase check compares against the stored value: replaying an unchanged
   * value is not an edit and stays lawful, so an offline replay cannot get
   * stuck behind a freeze it never actually crossed.
   */
  set(session: string, patch: SelectionPatch): SelectionState {
    assertSessionId(session)
    const current = this.get(session)
    const active = this.activeTurn(session)

    if (patch.profession !== undefined) {
      assertOneOf('profession', patch.profession, ProfessionValues)
      if (active !== undefined && active.profession !== patch.profession) {
        throw new ProfessionLockedError({
          turn: active.identity,
          current: active.profession,
          requested: patch.profession,
          hint: this.host.config.profession.errorHint
            ? 'use rebuildTurn or abandonTurn to change profession'
            : '',
        })
      }
    }
    if (patch.interaction !== undefined) assertOneOf('interaction', patch.interaction, InteractionValues)
    if (patch.scene !== undefined) assertOneOf('scene', patch.scene, SceneValues)
    if (patch.validation !== undefined) assertOneOf('validation', patch.validation, ValidationValues)
    if (patch.command !== undefined) assertOneOf('command', patch.command, CommandValues)

    const phases = this.phaseRow(session)
    if (
      patch.interaction !== undefined
      && patch.interaction !== current.interaction
      && phases?.goalStatus !== undefined
      && phases.goalStatus !== CLEARED_GOAL
    ) {
      throw new InvalidStateError('interaction is frozen until the current goal is cleared', {
        setting: 'interaction',
        phase: 'goal',
        turn: phases.ordinal,
        ...(phases.goalHandle === undefined ? {} : { goal: phases.goalHandle }),
      })
    }
    if (
      patch.validation !== undefined
      && patch.validation !== current.validation
      && phases?.planStatus !== undefined
      && ACTIVE_PLAN.has(phases.planStatus)
    ) {
      throw new InvalidStateError('validation is frozen until the current plan ends', {
        setting: 'validation',
        phase: 'plan',
        turn: phases.ordinal,
        ...(phases.planHandle === undefined ? {} : { plan: phases.planHandle }),
      })
    }

    if (patch.preset !== undefined) this.applyPermission(session, patch.preset)

    const next: Selection = {
      session,
      profession: patch.profession ?? current.profession,
      interaction: patch.interaction ?? current.interaction,
      scene: patch.scene ?? current.scene,
      validation: patch.validation ?? current.validation,
      command: patch.command ?? current.command,
      locked: active !== undefined,
      changed: this.host.clock.now(),
    }
    this.host.db.transaction(() => {
      const existing = this.host.db.get<Row>('SELECT identity FROM selection WHERE session = ?', session)
      if (existing === undefined) {
        this.host.db.insert('selection', {
          session,
          profession: next.profession,
          interaction: next.interaction,
          scene: next.scene,
          validation: next.validation,
          command: next.command,
          changed: next.changed,
        })
      } else {
        this.host.db.update(
          'selection',
          {
            profession: next.profession,
            interaction: next.interaction,
            scene: next.scene,
            validation: next.validation,
            command: next.command,
            changed: next.changed,
          },
          'session = ?',
          session,
        )
      }
      this.host.events.emit('selection/changed', {
        session,
        profession: next.profession,
        interaction: next.interaction,
        scene: next.scene,
        validation: next.validation,
      })
    })
    return this.state(session)
  }

  /**
   * Remember the profession of a task that has just been created by
   * `rebuildTurn`. The new task may lawfully hold a different profession from
   * the abandoned one, so the lock check does not apply here; callers that are
   * not rebuilding must use {@link set} instead. The row is created when the
   * session has never stored a selection.
   */
  rememberProfession(session: string, profession: Profession): void {
    assertSessionId(session)
    assertProfession(profession)
    const current = this.get(session)
    const changed = this.host.clock.now()
    this.host.db.transaction(() => {
      const existing = this.host.db.get<Row>('SELECT identity FROM selection WHERE session = ?', session)
      if (existing === undefined) {
        this.host.db.insert('selection', {
          session,
          profession,
          interaction: current.interaction,
          scene: current.scene,
          validation: current.validation,
          command: current.command,
          changed,
        })
      } else {
        this.host.db.update('selection', { profession, changed }, 'session = ?', session)
      }
      this.host.events.emit('selection/changed', {
        session,
        profession,
        interaction: current.interaction,
        scene: current.scene,
        validation: current.validation,
      })
    })
  }

  /**
   * Run the two writes of a profession route (the turn rebuild/abandon plus the
   * selection projection) in one transaction. Nested calls reuse the enclosing
   * transaction, so `ProfessionModule`'s own transaction stays atomic with this
   * one.
   */
  transaction<T>(operation: () => T): T {
    return this.host.db.transaction(operation)
  }

  /** One turn of this session by its ordinal; used by the lock tool. */
  turnByOrdinal(session: string, ordinal: number): Turn | undefined {
    assertSessionId(session)
    if (!Number.isInteger(ordinal) || ordinal <= 0) {
      throw new InvalidArgumentError('turn ordinal must be a positive integer', { turn: ordinal })
    }
    const row = this.host.db.get<Row>(
      `SELECT t.* FROM turn t
       JOIN session s ON s.identity = t.session
       WHERE s.handle = ? AND t.ordinal = ?
       ORDER BY t.identity DESC LIMIT 1`,
      session,
      ordinal,
    )
    return row === undefined ? undefined : mapTurn(row)
  }

  /** True while a non-terminal turn holds the profession of this session. */
  isLocked(session: string): boolean {
    return this.activeTurn(session) !== undefined
  }

  /** The active turn reduced to the fields the composer shows. */
  activeTurn(session: string): SelectionLockView | undefined {
    const row = this.host.db.get<Row>(
      `SELECT t.* FROM turn t
       JOIN session s ON s.identity = t.session
       WHERE s.handle = ? AND ${ACTIVE_TURN.replaceAll('status', 't.status')}
       ORDER BY t.identity DESC LIMIT 1`,
      session,
    )
    if (row === undefined) return undefined
    const turn: Turn = mapTurn(row)
    return {
      identity: turn.identity,
      handle: turn.handle,
      ordinal: turn.ordinal,
      status: turn.status,
      profession: turn.profession,
      locked: turn.locked,
    }
  }

  /**
   * Composer dimensions frozen by the session's running turn / plan / goal.
   *
   * Mapping (v24 §15.1): turn → `profession`, plan → `validation`,
   * goal → `interaction`. The map is re-derived from the rows on every call —
   * there is no stored flag and no client latch — so a finished plan, a cleared
   * goal or a closed turn unfreezes the dropdown on the next poll, and every
   * newly created plan/goal freezes it again for as long as that row is open.
   */
  frozenPhases(session: string): SelectionFreezeMap {
    const row = this.phaseRow(session)
    if (row === undefined) return {}
    const frozen: SelectionFreezeMap = {
      profession: {
        phase: 'turn',
        turn: row.ordinal,
        status: row.status,
        since: row.created,
      },
    }
    if (row.planStatus !== undefined && ACTIVE_PLAN.has(row.planStatus)) {
      const plan: SelectionFreezeView = {
        phase: 'plan',
        turn: row.ordinal,
        status: row.planStatus,
        ...(row.planHandle === undefined ? {} : { handle: row.planHandle }),
        ...(row.planCreated === undefined ? {} : { since: row.planCreated }),
      }
      frozen.validation = plan
    }
    if (row.goalStatus !== undefined && row.goalStatus !== CLEARED_GOAL) {
      const goal: SelectionFreezeView = {
        phase: 'goal',
        turn: row.ordinal,
        status: row.goalStatus,
        ...(row.goalHandle === undefined ? {} : { handle: row.goalHandle }),
        ...(row.goalCreated === undefined ? {} : { since: row.goalCreated }),
      }
      frozen.interaction = goal
    }
    return frozen
  }

  /** One read for {@link frozenPhases}: active turn + its plan/goal status. */
  private phaseRow(session: string): PhaseRow | undefined {
    const row = this.host.db.get<Row>(
      `SELECT t.ordinal, t.status, t.created,
              p.handle AS plan_handle, p.status AS plan_status, p.created AS plan_created,
              g.handle AS goal_handle, g.status AS goal_status, g.created AS goal_created
         FROM turn t
         JOIN session s ON s.identity = t.session
         LEFT JOIN plan p ON p.identity = t.plan
         LEFT JOIN goal g ON g.identity = t.goal
        WHERE s.handle = ? AND ${ACTIVE_TURN.replaceAll('status', 't.status')}
        ORDER BY t.identity DESC LIMIT 1`,
      session,
    )
    if (row === undefined) return undefined
    const planHandle = optionalText(row, 'plan_handle')
    const planStatus = optionalText(row, 'plan_status')
    const planCreated = optionalNumber(row, 'plan_created')
    const goalHandle = optionalText(row, 'goal_handle')
    const goalStatus = optionalText(row, 'goal_status')
    const goalCreated = optionalNumber(row, 'goal_created')
    return {
      ordinal: number(row, 'ordinal', 0),
      status: text(row, 'status', 'pending'),
      created: number(row, 'created', 0),
      ...(planHandle === undefined ? {} : { planHandle }),
      ...(planStatus === undefined ? {} : { planStatus }),
      ...(planCreated === undefined ? {} : { planCreated }),
      ...(goalHandle === undefined ? {} : { goalHandle }),
      ...(goalStatus === undefined ? {} : { goalStatus }),
      ...(goalCreated === undefined ? {} : { goalCreated }),
    }
  }

  /** DSH's permission preset catalog projected for the dropdown. */
  listPreset(): PermissionPresetView[] {
    const port = this.host.permissionPresets
    if (port === undefined) return []
    let catalog: PermissionPresetOption[]
    try {
      catalog = port.catalog().options ?? []
    } catch {
      return []
    }
    return catalog.map((option) => {
      let spec: { sandbox?: string; approval?: string; name?: string; description?: string } = {}
      try {
        spec = port.resolve?.(option.value) ?? {}
      } catch {
        spec = {}
      }
      // Some catalogs echo the key back as the name (`name: "read-only"`). That
      // is a value, not a label: the dropdown must show the shipped wording,
      // never the raw id. A genuine DSH label still wins when it differs.
      const rawName = typeof option.name === 'string' ? option.name.trim() : ''
      const name = rawName.length > 0 && rawName !== option.value
        ? rawName
        : option.value in PermissionLabel
          ? PermissionLabel[option.value as keyof typeof PermissionLabel]
          : option.value
      const description = option.description ?? spec.description
      // A key whose value is `undefined` is dropped by JSON, which makes the
      // tool result non-lossless and DSH rejects it at the boundary. Omit
      // absent fields instead of carrying them as holes.
      return {
        value: option.value,
        name,
        ...(description === undefined ? {} : { description }),
        ...(spec.sandbox === undefined ? {} : { sandbox: spec.sandbox }),
        ...(spec.approval === undefined ? {} : { approval: spec.approval }),
      }
    })
  }

  /** The preset DSH currently reports for the session, when resolvable. */
  currentPreset(session: string): string | undefined {
    const port = this.host.permissionPresets
    const live = this.host.sessions?.get(session)
    if (port === undefined || live === undefined) return undefined
    try {
      return port.current(live)
    } catch {
      return undefined
    }
  }

  /**
   * Apply a DSH permission preset. The value may be a preset key or the label
   * shown in the menu; unknown values are refused rather than guessed.
   */
  applyPermission(session: string, preset: string): string {
    assertSessionId(session)
    const port = this.host.permissionPresets
    if (port === undefined) {
      throw new NotImplementedError('permission presets (DSH did not expose ctx.permissionPresets)')
    }
    const catalog = this.listPreset()
    const match = catalog.find((option) => option.value === preset || option.name === preset)
    if (match === undefined) {
      throw new InvalidArgumentError(`unknown permission preset: ${preset}`, {
        allowed: catalog.map((option) => option.value),
      })
    }
    const live = this.host.sessions?.get(session)
    if (live === undefined) {
      throw new InvalidStateError('session is not live in DSH; cannot change its permission preset', { session })
    }
    try {
      port.set(live, match.value)
    } catch (error) {
      throw new InvalidStateError(
        `DSH refused permission preset ${match.value}: ${error instanceof Error ? error.message : String(error)}`,
        { session, preset: match.value },
      )
    }
    this.host.events.emit('selection/permission', { session, preset: match.value })
    return match.value
  }

  /** Labels used by the settings page and the docs. */
  describe(): {
    interaction: Readonly<Record<Interaction, string>>
    permission: Readonly<Record<string, string>>
  } {
    return { interaction: InteractionLabel, permission: PermissionLabel }
  }

  /**
   * The full redacted configuration view (v24 §19) the settings page reads.
   *
   * `defaults` is `resolveConfig(undefined)`, so the page never carries a
   * second copy of a default literal and can tell "changed" from "schema
   * default". The projection is derived on every call: there is no cached
   * second source of truth to fall out of sync after a patch.
   */
  configView(): ConfigView {
    return buildConfigView(this.host.config)
  }
}

/* ------------------------------------------------------------------------- *
 * Full configuration view and patch (v24 §19, GET/POST /config)
 * ------------------------------------------------------------------------- */

/** Memoised schema defaults; `resolveConfig(undefined)` is deterministic. */
let schemaDefaults: ConfigValues | undefined

/** Project the resolved config into the redacted, wire-safe view. */
export function buildConfigView(config: CoordinationConfig): ConfigView {
  schemaDefaults ??= configValuesOf(resolveConfig(undefined))
  return { values: configValuesOf(config), defaults: schemaDefaults }
}

/** The schema defaults alone, for tests and the docs catalog. */
export function defaultConfigValues(): ConfigValues {
  schemaDefaults ??= configValuesOf(resolveConfig(undefined))
  return schemaDefaults
}

/** Copy every group; the view never aliases a live config object. */
function configValuesOf(config: CoordinationConfig): ConfigValues {
  return {
    maxTurnPerSession: config.maxTurnPerSession,
    defaultLease: config.defaultLease,
    clarifyTimeout: config.clarifyTimeout,
    profession: {
      enabled: config.profession.enabled,
      lock: config.profession.lock,
      default: toProfession(config.profession.default),
      rebuildCanReselect: config.profession.rebuildCanReselect,
      abandonCanReselect: config.profession.abandonCanReselect,
      audit: config.profession.audit,
      errorHint: config.profession.errorHint,
    },
    plan: {
      threshold: config.plan.threshold,
      maxRebuild: config.plan.maxRebuild,
      weights: { ...config.plan.weights },
      dimensions: { ...config.plan.dimensions },
    },
    orchestration: { ...config.orchestration },
    cache: { ...config.cache },
    compaction: { ...config.compaction },
    bayesian: { ...config.bayesian },
    comprehension: { ...config.comprehension },
    ui: { ...config.ui },
    parser: { ...config.parser },
    chain: { ...config.chain },
    tools: { ...config.tools },
    scenes: {
      dialogue: { ...config.scenes.dialogue },
      writing: { ...config.scenes.writing },
      office: { ...config.scenes.office },
      research: { ...config.scenes.research },
      engineering: { ...config.scenes.engineering },
      iterate: { ...config.scenes.iterate },
    },
    defaults: {
      profession: toProfession(config.defaults.profession),
      interaction: toInteraction(config.defaults.interaction),
      scene: toScene(config.defaults.scene),
      validation: toValidation(config.defaults.validation),
      command: toCommandType(config.defaults.command),
    },
  }
}

/** Result of applying one settings patch to the live config. */
export interface ConfigPatchOutcome {
  /** Paths written to the live config. */
  applied: string[]
  /** Known but non-editable paths (forced/read-only/planned); not written. */
  ignored: string[]
  /** `plan.weights.*` paths the resolver re-normalised. */
  normalised: string[]
  /** The triple the caller must hand to `applyCompactionPolicy`, when touched. */
  compaction: { auto: boolean; soft: number; hard: number } | null
  /** The config after the write, projected for the wire. */
  config: ConfigView
}

/**
 * Apply one flat config patch to a live config object.
 *
 * Validation happens before a single field is written:
 *  - `databasePath` / `database` are refused outright (deployment secret);
 *  - an unknown path is `INVALID_ARGUMENT`, never silently dropped;
 *  - a known but non-editable path (forced/read-only/planned/local) is
 *    reported in `ignored` and left untouched;
 *  - the scalar must satisfy the catalog type/range/options;
 *  - the nested patch must satisfy the real Schemastery schema, so the rules
 *    are the same ones `resolveConfig` enforces for a config file.
 *
 * The write re-resolves the whole config, which re-applies every invariant:
 * plan weights normalise to 1, the forced profession flags stay true,
 * `profession.default` mirrors `defaults.profession`, and the compaction policy
 * is clamped. Callers that own a token governor must pass
 * {@link ConfigPatchOutcome.compaction} back to `CoordinationService` so the
 * governor snapshot is rebuilt (a plain field mutation cannot reach it).
 */
export function applyConfigPatch(config: CoordinationConfig, patch: ConfigPatch): ConfigPatchOutcome {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new InvalidArgumentError('config patch must be an object', { received: typeof patch })
  }
  const applied: string[] = []
  const ignored: string[] = []
  const nested: Record<string, unknown> = {}
  const compaction: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'databasePath' || key === 'database') {
      throw new InvalidArgumentError(`config key ${key} is not writable from settings`, {
        key,
        reason: 'deployment secret',
      })
    }
    const entry: SettingsControl | undefined = SETTINGS_CONTROLS_BY_KEY.get(key)
    if (entry === undefined) {
      throw new InvalidArgumentError(`unknown config key: ${key}`, { key, allowed: [...EDITABLE_CONFIG_KEYS] })
    }
    if (!isEditableControl(entry)) {
      ignored.push(key)
      continue
    }
    const problem = validateConfigScalar(entry, value)
    if (problem !== undefined) {
      throw new InvalidArgumentError(`invalid value for ${key}: ${problem}`, { key, problem })
    }
    if (key.startsWith('compaction.')) compaction[key.slice('compaction.'.length)] = value
    else writeConfigPath(nested, key, value)
    applied.push(key)
  }

  try {
    // The schema is the authority for types and ranges; the catalog checks
    // above only reproduce its bounds for the settings page.
    Config(nested)
  } catch (error) {
    throw new InvalidArgumentError(`config patch rejected: ${messageOf(error)}`, {
      reason: messageOf(error),
    })
  }

  const resolved = resolveConfig(mergeConfig(config, nested) as Partial<CoordinationConfig>)
  Object.assign(config, resolved)

  let compactionTriple: { auto: boolean; soft: number; hard: number } | null = null
  if (Object.keys(compaction).length > 0) {
    config.compaction = resolveCompaction({ ...config.compaction, ...compaction } as CoordinationConfig['compaction'])
    compactionTriple = {
      auto: config.compaction.auto,
      soft: config.compaction.soft,
      hard: config.compaction.hard,
    }
  }

  return {
    applied,
    ignored,
    normalised: applied.filter((key) => key.startsWith('plan.weights.')),
    compaction: compactionTriple,
    config: buildConfigView(config),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Deep merge a nested patch over the current config, never mutating either. */
function mergeConfig(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch === undefined ? base : patch
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    result[key] = key in result ? mergeConfig(result[key], value) : value
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The two modules the profession routes need. Kept structural so the route
 * bodies can be exercised without a Cordis context (test/integration.test.ts).
 */
export interface ProfessionRouteDeps {
  readonly selection: SelectionModule
  readonly profession: ProfessionModule
}

/**
 * `POST /deepseek-coordination/profession/rebuild` business body.
 *
 * Rebuild ends the session's active task and creates its replacement, which is
 * the one lawful way to choose a different profession mid-session. The
 * selection row follows the new task so the next `state()` call reports the new
 * choice. A session without an active turn is an invalid state: rebuilding the
 * *latest* turn would silently manufacture a task the caller did not ask for,
 * so it is refused with a message that names the lawful path.
 */
export function rebuildProfession(
  deps: ProfessionRouteDeps,
  session: string,
  profession: Profession,
): SelectionState {
  assertSessionId(session)
  assertProfession(profession)
  if (!deps.selection.configuration().rebuildCanReselect) {
    throw new InvalidStateError(
      'profession rebuild is disabled: profession.rebuildCanReselect is false in the resolved config',
      { session, setting: 'profession.rebuildCanReselect' },
    )
  }
  return deps.selection.transaction(() => {
    const active = deps.selection.activeTurn(session)
    if (active === undefined) {
      throw new InvalidStateError(
        `session ${session} has no active turn to rebuild; rebuild requires a running task, ` +
          'use POST /selection to choose a profession before the next turn starts',
        { session },
      )
    }
    deps.profession.rebuildTurn(active.identity, profession)
    deps.selection.rememberProfession(session, profession)
    return deps.selection.state(session)
  })
}

/**
 * `POST /deepseek-coordination/profession/abandon` business body.
 *
 * Abandon closes the active task without a replacement. The profession of the
 * closed task stays in the trace; the next turn can choose again, which is what
 * `profession.abandonCanReselect` (forced true by the resolver) promises. A
 * session without an active turn is refused for the same reason as rebuild.
 */
export function abandonProfession(deps: ProfessionRouteDeps, session: string): SelectionState {
  assertSessionId(session)
  if (!deps.selection.configuration().abandonCanReselect) {
    throw new InvalidStateError(
      'profession abandon is disabled: profession.abandonCanReselect is false in the resolved config',
      { session, setting: 'profession.abandonCanReselect' },
    )
  }
  return deps.selection.transaction(() => {
    const active = deps.selection.activeTurn(session)
    if (active === undefined) {
      throw new InvalidStateError(
        `session ${session} has no active turn to abandon; there is no task to close`,
        { session },
      )
    }
    deps.profession.abandonTurn(active.identity)
    return deps.selection.state(session)
  })
}

/** Read an optional TEXT column from a LEFT JOIN (NULL means "no row"). */
function optionalText(row: Row, key: string): string | undefined {
  const value = row[key]
  return typeof value === 'string' ? value : undefined
}

/** Read an optional INTEGER column from a LEFT JOIN (NULL means "no row"). */
function optionalNumber(row: Row, key: string): number | undefined {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function assertSessionId(session: unknown): asserts session is string {
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new InvalidArgumentError('session must be a non-empty DSH session id')
  }
}

function assertOneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): asserts value is T {
  if (!isOneOf(value, allowed)) {
    throw new InvalidArgumentError(`unknown ${field}: ${String(value)}`, { allowed })
  }
}

/* Re-exported for callers that build a patch from a form. */
export type { SelectionPatch, SelectionState, SelectionStateConfig }
export type {
  CommandType,
  Interaction,
  Profession,
  Scene,
  SelectionFreezeMap,
  SelectionFreezeView,
  SelectionPhase,
  Validation,
}
