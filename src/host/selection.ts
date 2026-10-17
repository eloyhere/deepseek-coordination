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
  PermissionPresetView,
  SelectionLockView,
  SelectionPatch,
  SelectionState,
  SelectionStateConfig,
} from '../shared/selection.js'
import {
  InvalidArgumentError,
  InvalidStateError,
  NotImplementedError,
  ProfessionLockedError,
} from '../shared/error.js'
import { assertProfession, type ProfessionModule } from './profession.js'
import { mapSelection, mapTurn } from './row.js'
import type { Row } from './row.js'

const ACTIVE_TURN = `status NOT IN ('done', 'failed', 'cancelled', 'abandoned')`

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
      ...(this.host.sandboxPolicy === undefined
        ? {}
        : { defaultMode: this.host.sandboxPolicy.defaultMode }),
      tooltip: config.showTooltip,
      config,
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
   * Store one patch. A profession change against an active turn is refused;
   * every other dimension is a preference for the next turn and stays writable.
   * The permission preset is applied to DSH immediately and never persisted.
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
      return {
        value: option.value,
        name: option.name || PermissionLabel[option.value as keyof typeof PermissionLabel] || option.value,
        description: option.description ?? spec.description,
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
export type { CommandType, Interaction, Profession, Scene, Validation }
