/**
 * Model-facing coordination tools (v23 §18.2).
 *
 * The plugin exposes three tools to the model: the composer selection, the
 * profession, and the profession lock. Names stay English and stable; the
 * description and every parameter description come from the shared copy table
 * (`src/shared/i18n.ts`), so switching the host locale changes what the model
 * sees without forking the tool surface.
 *
 * The definitions are authored in the registry's canonical `ToolDefinition`
 * shape: a JSON-Schema `parameters` object, an `output` with its own schema and
 * a `render` that turns the value into model-facing text blocks, and an
 * `execute` that returns only the declared value. They are plain objects (the
 * registry does not require `defineTool`), which also keeps this module free of
 * the Cordis runtime: `test/integration.test.ts` can exercise the tools without
 * a host context, and `src/index.ts` only supplies `ctx.tools`.
 */
import type { ProfessionRecord, Selection, Turn } from '../shared/entity.js'
import type {
  CommandType,
  Interaction,
  Profession,
  Scene,
  Validation,
} from '../shared/enum.js'
import {
  CommandValues,
  InteractionValues,
  ProfessionValues,
  SceneValues,
  ValidationValues,
  isOneOf,
} from '../shared/enum.js'
import { InvalidArgumentError } from '../shared/error.js'
import { copyFor, normaliseLocale, type Locale, type ToolCopy, type ToolName } from '../shared/i18n.js'
import type { SelectionLockView, SelectionPatch, SelectionState } from '../shared/selection.js'
import { assertProfession } from './profession.js'

/* ------------------------------------------------------------------------- *
 * Registry shape (structural, so the module needs no dsh-tools dependency)
 * ------------------------------------------------------------------------- */

/** One model-facing text block, the only content shape `render` returns here. */
export interface CoordinationToolTextBlock {
  readonly type: 'text'
  readonly text: string
}

/** The `output` contract every registry-ready tool declares. */
export interface CoordinationToolOutput<T = unknown> {
  readonly schema: Record<string, unknown>
  render(args: Record<string, unknown>, value: T): CoordinationToolTextBlock[]
}

/** The registry's definition shape, narrowed to the fields this plugin uses. */
export interface CoordinationToolDefinition<T = unknown> {
  readonly name: ToolName
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: CoordinationToolOutput<T>
  execute(args: Record<string, unknown>, exec?: ToolExecution): Promise<T> | T
}

/** The part of one DSH tool call this module reads. `agent.id` is the session id. */
export interface ToolExecution {
  readonly agent?: { readonly id?: string }
}

/** The `ctx.tools` surface: register one definition, get one disposer. */
export interface CoordinationToolRegistry {
  register(definition: CoordinationToolDefinition): () => void
}

/**
 * Resolve `ctx.tools` from a Cordis context without importing its type (the
 * package is not a dependency of this plugin). A missing registry is a hard
 * failure: silently dropping the tools would make the documented tool surface
 * disappear from the model while the rest of the plugin still works.
 */
export function toolRegistryOf(context: unknown): CoordinationToolRegistry {
  const registry = (context as { tools?: CoordinationToolRegistry }).tools
  if (registry === undefined || typeof registry.register !== 'function') {
    throw new Error('coordination tools require ctx.tools (the dsh-tools registry)')
  }
  return registry
}

/**
 * The host methods the tools call. `CoordinationService` satisfies this
 * interface; the tests compose it from `SelectionModule` and `ProfessionModule`.
 */
export interface CoordinationToolService {
  /** Current host copy locale (`zh-CN` / `en-US`). */
  readonly locale: string
  state(session: string): SelectionState
  setSelection(session: string, patch: SelectionPatch): SelectionState
  activeTurn(session: string): SelectionLockView | undefined
  getProfessionRecord(turn: number): ProfessionRecord
  turnByOrdinal(session: string, ordinal: number): Turn | undefined
}

/* ------------------------------------------------------------------------- *
 * Tool values
 * ------------------------------------------------------------------------- */

/** Value of `coordination_profession`. */
export interface ProfessionToolValue {
  session: string
  ok: boolean
  locked: boolean
  selection: Selection
  record?: ProfessionRecord
  /**
   * Present only when a requested profession change was refused. The selection
   * is not mutated in that case; the model gets the stable code as text.
   */
  error?: { code: 'PROFESSION_LOCKED'; message: string }
}

/** Value of `coordination_professionlock`. */
export interface ProfessionLockToolValue {
  locked: boolean
  profession?: Profession
}

/* ------------------------------------------------------------------------- *
 * JSON Schemas (the registry's enforced subset: no $ref, no min/max)
 * ------------------------------------------------------------------------- */

const PROFESSION_ENUM: readonly string[] = ProfessionValues
const INTERACTION_ENUM: readonly string[] = InteractionValues
const SCENE_ENUM: readonly string[] = SceneValues
const VALIDATION_ENUM: readonly string[] = ValidationValues
const COMMAND_ENUM: readonly string[] = CommandValues

const SELECTION_VIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['session', 'profession', 'interaction', 'scene', 'validation', 'command', 'locked', 'changed'],
  properties: {
    session: { type: 'string' },
    profession: { type: 'string', enum: PROFESSION_ENUM },
    interaction: { type: 'string', enum: INTERACTION_ENUM },
    scene: { type: 'string', enum: SCENE_ENUM },
    validation: { type: 'string', enum: VALIDATION_ENUM },
    command: { type: 'string', enum: COMMAND_ENUM },
    locked: { type: 'boolean' },
    changed: { type: 'number' },
  },
}

const SELECTION_CONFIG_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'defaultProfession',
    'defaultInteraction',
    'defaultScene',
    'defaultValidation',
    'showTooltip',
    'takeover',
    'workflow',
    'locale',
    'refreshInterval',
    'cacheEnabled',
    'searchEnabled',
    'audit',
    'errorHint',
    'rebuildCanReselect',
    'abandonCanReselect',
  ],
  properties: {
    defaultProfession: { type: 'string', enum: PROFESSION_ENUM },
    defaultInteraction: { type: 'string', enum: INTERACTION_ENUM },
    defaultScene: { type: 'string', enum: SCENE_ENUM },
    defaultValidation: { type: 'string', enum: VALIDATION_ENUM },
    showTooltip: { type: 'boolean' },
    takeover: { type: 'boolean' },
    workflow: { type: 'boolean' },
    locale: { type: 'string' },
    refreshInterval: { type: 'number' },
    cacheEnabled: { type: 'boolean' },
    searchEnabled: { type: 'boolean' },
    audit: { type: 'boolean' },
    errorHint: { type: 'boolean' },
    rebuildCanReselect: { type: 'boolean' },
    abandonCanReselect: { type: 'boolean' },
  },
}

const SELECTION_STATE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['session', 'selection', 'locked', 'presets', 'tooltip'],
  properties: {
    session: { type: 'string' },
    selection: SELECTION_VIEW_SCHEMA,
    locked: { type: 'boolean' },
    turn: { type: 'object', additionalProperties: true },
    presets: { type: 'array', items: { type: 'object', additionalProperties: true } },
    preset: { type: 'string' },
    defaultMode: { type: 'string' },
    tooltip: { type: 'boolean' },
    config: SELECTION_CONFIG_SCHEMA,
  },
}

const PROFESSION_RECORD_SCHEMA: Record<string, unknown> = { type: 'object', additionalProperties: true }

const PROFESSION_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['session', 'ok', 'locked', 'selection'],
  properties: {
    session: { type: 'string' },
    ok: { type: 'boolean' },
    locked: { type: 'boolean' },
    selection: SELECTION_VIEW_SCHEMA,
    record: PROFESSION_RECORD_SCHEMA,
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', const: 'PROFESSION_LOCKED' },
        message: { type: 'string' },
      },
    },
  },
}

const PROFESSION_LOCK_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['locked'],
  properties: {
    locked: { type: 'boolean' },
    profession: { type: 'string', enum: PROFESSION_ENUM },
  },
}

/* ------------------------------------------------------------------------- *
 * Definitions
 * ------------------------------------------------------------------------- */

/**
 * Build the three definitions for one locale. Pure: no registry and no host
 * context touched, which is what makes the locale switch testable.
 */
export function coordinationToolDefinitions(
  service: CoordinationToolService,
  locale: Locale = normaliseLocale(service.locale),
): CoordinationToolDefinition[] {
  const copy = copyFor(locale)
  return [
    professionTool(service, copy.tools.coordination_profession),
    professionLockTool(service, copy.tools.coordination_professionlock),
    selectionTool(service, copy.tools.coordination_selection),
  ]
}

/**
 * Register every coordination tool and return one disposer for the whole set.
 * The caller owns the lifetime: `src/index.ts` installs it through
 * `ctx.effect` and recreates it when `POST /locale` changes the language.
 */
export function registerCoordinationTools(
  registry: CoordinationToolRegistry,
  service: CoordinationToolService,
  locale: Locale = normaliseLocale(service.locale),
): () => void {
  const disposers: Array<() => void> = []
  try {
    for (const definition of coordinationToolDefinitions(service, locale)) {
      disposers.push(registry.register(definition))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
    disposers.length = 0
  }
}

/* ------------------------------------------------------------------------- *
 * coordination_profession
 * ------------------------------------------------------------------------- */

function professionTool(service: CoordinationToolService, copy: ToolCopy): CoordinationToolDefinition<ProfessionToolValue> {
  return {
    name: 'coordination_profession',
    description: copy.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session: stringParameter(copy, 'session'),
        profession: { ...stringParameter(copy, 'profession'), enum: PROFESSION_ENUM },
      },
    },
    output: {
      schema: PROFESSION_TOOL_SCHEMA,
      render: (_args, value) => renderJson(value),
    },
    async execute(rawArgs, exec) {
      const args = asArguments(rawArgs)
      const session = resolveSession(args, exec)
      const state = service.state(session)
      const requested = optionalProfession(args)
      const active = service.activeTurn(session)

      if (requested === undefined) {
        const record = active === undefined ? undefined : service.getProfessionRecord(active.identity)
        return {
          session,
          ok: true,
          locked: state.locked,
          selection: state.selection,
          ...(record === undefined ? {} : { record }),
        }
      }

      /*
       * Fail closed: while a task holds the profession, the only lawful way to
       * pick another one is rebuild/abandon. Returning the code (instead of
       * silently accepting the same value) keeps the documented rule simple.
       */
      if (state.locked) {
        return {
          session,
          ok: false,
          locked: true,
          selection: state.selection,
          error: {
            code: 'PROFESSION_LOCKED',
            message:
              'PROFESSION_LOCKED: this turn is already running; rebuild or abandon the task to choose another profession',
          },
        }
      }

      const next = service.setSelection(session, { profession: requested })
      return { session, ok: true, locked: next.locked, selection: next.selection }
    },
  }
}

/* ------------------------------------------------------------------------- *
 * coordination_professionlock
 * ------------------------------------------------------------------------- */

function professionLockTool(
  service: CoordinationToolService,
  copy: ToolCopy,
): CoordinationToolDefinition<ProfessionLockToolValue> {
  return {
    name: 'coordination_professionlock',
    description: copy.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session: stringParameter(copy, 'session'),
        turn: {
          type: 'integer',
          description: parameterDescription(copy, 'turn'),
        },
      },
    },
    output: {
      schema: PROFESSION_LOCK_TOOL_SCHEMA,
      render: (_args, value) => renderJson(value),
    },
    async execute(rawArgs, exec) {
      const args = asArguments(rawArgs)
      const session = resolveSession(args, exec)
      const ordinal = optionalOrdinal(args)
      if (ordinal === undefined) {
        const active = service.activeTurn(session)
        return active === undefined
          ? { locked: false }
          : { locked: active.locked, profession: active.profession }
      }
      const turn = service.turnByOrdinal(session, ordinal)
      if (turn === undefined) {
        throw new InvalidArgumentError(`turn ${ordinal} was not found in session ${session}`, {
          session,
          turn: ordinal,
        })
      }
      return { locked: turn.locked, profession: turn.profession }
    },
  }
}

/* ------------------------------------------------------------------------- *
 * coordination_selection
 * ------------------------------------------------------------------------- */

function selectionTool(service: CoordinationToolService, copy: ToolCopy): CoordinationToolDefinition<SelectionState> {
  return {
    name: 'coordination_selection',
    description: copy.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session: stringParameter(copy, 'session'),
        profession: { ...stringParameter(copy, 'profession'), enum: PROFESSION_ENUM },
        interaction: { ...stringParameter(copy, 'interaction'), enum: INTERACTION_ENUM },
        scene: { ...stringParameter(copy, 'scene'), enum: SCENE_ENUM },
        validation: { ...stringParameter(copy, 'validation'), enum: VALIDATION_ENUM },
        command: { ...stringParameter(copy, 'command'), enum: COMMAND_ENUM },
        preset: stringParameter(copy, 'preset'),
      },
    },
    output: {
      schema: SELECTION_STATE_SCHEMA,
      render: (_args, value) => renderJson(value),
    },
    async execute(rawArgs, exec) {
      const args = asArguments(rawArgs)
      const session = resolveSession(args, exec)
      const patch = selectionPatchOf(args)
      // A pure read is the common case; a patch is stored for the next turn.
      return Object.keys(patch).length === 0 ? service.state(session) : service.setSelection(session, patch)
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Argument parsing
 * ------------------------------------------------------------------------- */

function asArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidArgumentError('tool arguments must be a JSON object')
  }
  return value as Record<string, unknown>
}

/** `session` argument, falling back to the calling agent's id (the DSH session). */
function resolveSession(args: Record<string, unknown>, exec: ToolExecution | undefined): string {
  const supplied = args.session
  if (supplied !== undefined) {
    if (typeof supplied !== 'string' || supplied.trim().length === 0) {
      throw new InvalidArgumentError('session must be a non-empty DSH session id')
    }
    return supplied.trim()
  }
  const agentId = exec?.agent?.id
  if (typeof agentId === 'string' && agentId.trim().length > 0) return agentId.trim()
  throw new InvalidArgumentError('session is required: pass session or call the tool from an agent')
}

function optionalProfession(args: Record<string, unknown>): Profession | undefined {
  const value = args.profession
  if (value === undefined) return undefined
  assertProfession(value)
  return value
}

function optionalOrdinal(args: Record<string, unknown>): number | undefined {
  const value = args.turn
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentError('turn must be a positive integer ordinal', { turn: value })
  }
  return value
}

/** Build a {@link SelectionPatch} from whichever selection fields were supplied. */
function selectionPatchOf(args: Record<string, unknown>): SelectionPatch {
  const patch: SelectionPatch = {}
  const profession = optionalProfession(args)
  if (profession !== undefined) patch.profession = profession
  const interaction = optionalEnum<Interaction>(args, 'interaction', InteractionValues)
  if (interaction !== undefined) patch.interaction = interaction
  const scene = optionalEnum<Scene>(args, 'scene', SceneValues)
  if (scene !== undefined) patch.scene = scene
  const validation = optionalEnum<Validation>(args, 'validation', ValidationValues)
  if (validation !== undefined) patch.validation = validation
  const command = optionalEnum<CommandType>(args, 'command', CommandValues)
  if (command !== undefined) patch.command = command
  const preset = args.preset
  if (preset !== undefined) {
    if (typeof preset !== 'string' || preset.trim().length === 0) {
      throw new InvalidArgumentError('preset must be a non-empty DSH permission preset key')
    }
    patch.preset = preset.trim()
  }
  return patch
}

function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[field]
  if (value === undefined) return undefined
  if (!isOneOf(value, allowed)) {
    throw new InvalidArgumentError(`unknown ${field}: ${String(value)}`, { allowed })
  }
  return value
}

/* ------------------------------------------------------------------------- *
 * Copy and rendering helpers
 * ------------------------------------------------------------------------- */

function parameterDescription(copy: ToolCopy, name: string): string {
  const description = copy.parameters[name]
  if (typeof description !== 'string' || description.length === 0) {
    // A missing key is a copy-table bug; fail loudly instead of shipping a
    // schema with an undefined description.
    throw new Error(`missing tool parameter copy for "${name}"`)
  }
  return description
}

function stringParameter(copy: ToolCopy, name: string): Record<string, unknown> {
  return { type: 'string', description: parameterDescription(copy, name) }
}

/** One JSON text block: the value is data, never a locale-sensitive sentence. */
function renderJson(value: unknown): CoordinationToolTextBlock[] {
  const text = JSON.stringify(value, null, 2)
  return [{ type: 'text', text: text === undefined ? String(value) : text }]
}
