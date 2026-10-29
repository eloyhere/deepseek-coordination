/**
 * Model-facing coordination tools (v23 §18.2, v24 §3 + §2.5).
 *
 * The plugin exposes eleven tools to the model:
 *
 *  - `coordination_selection`, `coordination_profession`,
 *    `coordination_profession_lock` — the composer surface (v0.7/v0.8);
 *  - `coordination_parse`, `coordination_describe`, `coordination_chain`,
 *    `coordination_read` — the file layer wired in v0.9 (the P0 parser, the
 *    `NodeCard` projection, the host-only `Chain` projection and the single
 *    authorized content path);
 *  - `coordination_file`, `coordination_outline`, `coordination_importation`,
 *    `coordination_exportation` — four **read-only** workspace-graph tools that
 *    project the persisted graph: a bounded directory tree, the structure
 *    outline, and the import/export rows.
 *
 * Names stay English and stable. The seven composer/file tools take their
 * description and parameter copy from the shared tables (`src/shared/i18n.ts`):
 * the composer tools from `copy.tools`, the file layer from `copy.fileTools`.
 * The four graph tools keep their EN + zh-CN copy **inline** in this module
 * ({@link GRAPH_TOOL_COPY}) so the shared locale table needed no new keys.
 * Switching the host locale therefore changes what the model sees without
 * forking the tool surface.
 *
 * The definitions are authored in the registry's canonical `ToolDefinition`
 * shape: a JSON-Schema `parameters` object, an `output` with its own schema and
 * a `render` that turns the value into model-facing text blocks, and an
 * `execute` that returns only the declared value. They are plain objects (the
 * registry does not require `defineTool`), which also keeps this module free of
 * the Cordis runtime: `test/integration.test.ts` can exercise the tools without
 * a host context, and `src/index.ts` only supplies `ctx.tools`.
 *
 * # No write tool, on purpose
 *
 * `coordination_write` is **not** implemented. The v24 blueprint
 * (`docs/domain-model-v24.md` §2.7) requires optimistic concurrency:
 * `expectedFingerprint` must be compared against the file at write time, every
 * affected fragment's byte/line ranges and fingerprint must be recomputed in the
 * same transactional step, an actual charset/BOM change must be explicit, and a
 * mismatch must return `CONFLICT` without writing. This plugin has no file
 * watcher, no transactional read-modify-write path and no `.tmp` rename policy
 * yet, so shipping a writer would either overwrite concurrent edits or return
 * stale fragment coordinates. The read side (`coordination_read`) and the
 * fingerprint/staleness contract (`coordination_describe`, chain `stale`) are
 * wired; the write path is documented as remaining work in
 * `docs/feature-wiring-audit-v24.md` §5.
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
import { InvalidArgumentError, InvalidStateError, NotFoundError } from '../shared/error.js'
import { copyFor, normaliseLocale, type FileToolName, type Locale, type ToolCopy, type ToolName } from '../shared/i18n.js'
import type { SelectionLockView, SelectionPatch, SelectionState } from '../shared/selection.js'
import { assertProfession } from './profession.js'
import { ChainEngine, MAX_CHAIN_DEPTH, MAX_CHAIN_LINKS, MAX_CHAIN_TOKENS } from './chain.js'
import type {
  ChainAction,
  ChainEdgeSnapshot,
  ChainNodeSnapshot,
  ChainProjection,
  ChainQueryOptions,
  ChainRelation,
  ChainRetuneOptions,
} from './chain.js'
import { NodeRegistry } from './node-registry.js'
import type { DescribeResult, NodeCard } from './node-registry.js'
import { ParseService, viewReference } from './parse-service.js'
import type {
  DependencyGraphSummary,
  ParsedFile,
  ParseServiceOptions,
  ReferenceView,
} from './parse-service.js'
import { GraphStore } from './graph-store.js'
import type { CoordinationDatabase } from './database.js'
import {
  buildImports,
  buildTree,
  createGraphQuery,
  familyOf,
  graphVersionOf,
  isManifestPath,
  MAX_IMPORT_ROWS,
  MAX_TREE_DEPTH,
  normaliseGraphPath,
  type GraphEdge,
  type GraphFamily,
  type GraphNode,
  type GraphQuery,
  type GraphScope,
  type ImportRow,
  type OutlineNode,
  type TreeNode,
} from './graph-view.js'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

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

/** File-layer tool names added by the v0.9 wiring. */
export type CoordinationFileToolName = FileToolName

/** The four read-only workspace-graph tool names added by the graph surface. */
export type CoordinationGraphToolName =
  | 'coordination_file'
  | 'coordination_outline'
  | 'coordination_importation'
  | 'coordination_exportation'

/** Every tool name this module can register. */
export type CoordinationAnyToolName = ToolName | CoordinationFileToolName | CoordinationGraphToolName

/** The registry's definition shape, narrowed to the fields this plugin uses. */
export interface CoordinationToolDefinition<T = unknown> {
  readonly name: CoordinationAnyToolName
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
 *
 * The three optional fields are the host-kernel marker: the file-backed tools
 * need a workspace root and a stable lifetime, which only the composed
 * `CoordinationService` owns. The narrow selection/profession facade used by
 * existing tests is therefore still a three-tool surface, while the real host
 * registers all seven (or pass `{ fileTools: true }` explicitly).
 */
export interface CoordinationToolService {
  /** Current host copy locale (`zh-CN` / `en-US`). */
  readonly locale: string
  state(session: string): SelectionState
  setSelection(session: string, patch: SelectionPatch): SelectionState
  activeTurn(session: string): SelectionLockView | undefined
  getProfessionRecord(turn: number): ProfessionRecord
  turnByOrdinal(session: string, ordinal: number): Turn | undefined
  /** Present on the composed host service; marks the service host-capable. */
  readonly db?: unknown
  /**
   * Present on the composed host service. Read *structurally* (no `config.ts`
   * import) for the file-layer budgets (`parser.*`, `chain.*`, `tools.*`) and
   * for the `parser.enabled` master switch; host config can only tighten the
   * hard caps. A live `/config` change is applied to the lazy runtime on the
   * next file-tool call (see `ToolRuntime.retune`).
   */
  readonly config?: unknown
  /**
   * Explicit workspace root override (tests / alternate profiles). This is the
   * best source; when absent the host's sandbox policy is asked (see
   * {@link resolveToolWorkspaceRoot}).
   */
  readonly workspaceRoot?: string
  /**
   * The composed `ModuleHost`, when the service exposes it. Read structurally:
   * `host.workspaceRoot` is preferred, and `host.sandboxPolicy.resolve()`
   * supplies DSH's actual workspace root for the common default-mode case.
   */
  readonly host?: {
    readonly workspaceRoot?: string
    readonly sandboxPolicy?: {
      resolve(request?: { session?: unknown; mode?: string }): { workspaceRoot?: string }
    }
  }
}

/** Options for the file-backed tools; every field is optional. */
export interface CoordinationToolOptions {
  /** Absolute workspace root; overrides the service/host root (tests, profiles). */
  workspaceRoot?: string
  /** Force-register the file tools even for a narrow (non-kernel) service. */
  fileTools?: boolean
  /** Extra budgets for the parse service (tests use small caches). */
  parseService?: ParseServiceOptions
  /** Chain projection cache capacity (tests use a small value). */
  chainCacheCapacity?: number
  /** Node registry capacity (tests use a small value). */
  registryCapacity?: number
  /**
   * The Cordis context, read structurally by the request-scoped workspace-root
   * resolver. `src/index.ts` passes its apply-time context so a graph tool call
   * resolves the same session workspace the `/graph/*` routes use. Tests omit it
   * and pass `workspaceRoot` instead.
   */
  context?: unknown
  /**
   * Source of the body-free graph snapshot the four graph tools read. The host
   * default reads the persisted `GraphStore` of `service.db`; tests inject a
   * stub so the projection is exercised without a database.
   */
  graphSnapshot?: CoordinationGraphSnapshotProvider
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

/** Value of `coordination_profession_lock`. */
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
    // The token-governor projection the settings page and the composer read.
    // DSH validates tool output with `additionalProperties: false`, so a field
    // that exists in the value but not here fails the whole call.
    compaction: {
      type: 'object',
      additionalProperties: false,
      required: ['auto', 'soft', 'hard', 'reserve', 'recentTurns', 'cooldown', 'maxPerSession'],
      properties: {
        auto: { type: 'boolean' },
        soft: { type: 'number' },
        hard: { type: 'number' },
        reserve: { type: 'number' },
        recentTurns: { type: 'number' },
        cooldown: { type: 'number' },
        maxPerSession: { type: 'number' },
      },
    },
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
    // Frozen composer dimensions, keyed by dimension; present only while a
    // turn / plan / goal is open.
    frozen: { type: 'object', additionalProperties: true },
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
 * Build the three composer definitions for one locale. Pure: no registry and no
 * host context touched, which is what makes the locale switch testable. The
 * file-backed tools live in {@link coordinationFileToolDefinitions}; keeping the
 * two sets separate preserves the documented three-tool composer surface (and
 * the narrow test facade that only implements it).
 */
export function coordinationToolDefinitions(
  service: CoordinationToolService,
  locale: Locale = normaliseLocale(service.locale),
): CoordinationToolDefinition[] {
  const copy = copyFor(locale)
  return [
    professionTool(service, copy.tools.coordination_profession),
    professionLockTool(service, copy.tools.coordination_profession_lock),
    selectionTool(service, copy.tools.coordination_selection),
  ]
}

/**
 * Register every coordination tool and return one disposer for the whole set.
 * The caller owns the lifetime: `src/index.ts` installs it through
 * `ctx.effect` and recreates it when `POST /locale` changes the language.
 *
 * The four file-backed tools are registered when the service is the composed
 * host (`db`/`config` present, which `CoordinationService` always has) and the
 * host config has not disabled the parser (`parser.enabled !== false`), or when
 * the caller passes `fileTools: true`. A narrow facade — the selection and
 * profession modules composed for a unit test — keeps exactly the three
 * composer tools, so the existing integration contract is unchanged while the
 * real host gets all seven. `parser.enabled` is read at registration time;
 * toggling it live takes effect on the next tool re-registration (locale
 * switch) because the tool set itself changes.
 *
 * The four read-only graph tools are registered separately by
 * {@link registerCoordinationGraphTools}: the documented seven-tool file surface
 * stays unchanged, while the host installs both sets in one effect.
 */
export function registerCoordinationTools(
  registry: CoordinationToolRegistry,
  service: CoordinationToolService,
  locale: Locale = normaliseLocale(service.locale),
  options: CoordinationToolOptions = {},
): () => void {
  const withFileTools = options.fileTools ?? (
    isHostKernelService(service) && fileLayerConfig(service).parser?.enabled !== false
  )
  const definitions = coordinationToolDefinitions(service, locale)
  if (withFileTools) definitions.push(...coordinationFileToolDefinitions(service, locale, options))
  const disposers: Array<() => void> = []
  try {
    for (const definition of definitions) {
      disposers.push(registry.register(definition))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
    disposers.length = 0
    if (withFileTools) disposeCoordinationToolRuntime(service)
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
      render: (_args, value) => renderJson(value, toolResultMaxBytes(service)),
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
 * coordination_profession_lock
 * ------------------------------------------------------------------------- */

function professionLockTool(
  service: CoordinationToolService,
  copy: ToolCopy,
): CoordinationToolDefinition<ProfessionLockToolValue> {
  return {
    name: 'coordination_profession_lock',
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
      render: (_args, value) => renderJson(value, toolResultMaxBytes(service)),
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
      render: (_args, value) => renderJson(value, toolResultMaxBytes(service)),
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

/** Marker value that explains why a rendered tool value was shortened. */
export const TOOL_RESULT_MARKER = 'tools.maxResultBytes'
/** Smallest JSON carrying an explicit truncation marker (19 bytes). */
const MINIMAL_MARKER = '{"truncated":true}'

/**
 * The configured `tools.maxResultBytes` cap for model-facing tool text.
 *
 * `0` (the schema default) or an absent/invalid value keeps the historical
 * unbounded render. The value is read on every `render`, not captured at
 * registration, so a live `/config` change takes effect on the next tool result.
 */
export function toolResultMaxBytes(service: CoordinationToolService): number {
  const tools = fileLayerConfig(service).tools
  const value = tools?.maxResultBytes
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

/**
 * One JSON text block: the value is data, never a locale-sensitive sentence.
 *
 * With `maxBytes > 0` the full rendering is emitted when it fits. Otherwise the
 * text becomes a **valid JSON envelope** with `truncated: true`, the marker, the
 * original/returned byte counts, the top-level keys and a `preview` string that
 * ends in `…`. Nothing is silently cut: the model can always tell that a cap
 * applied and how much was dropped. A cap smaller than the minimal marker
 * returns the minimal marker even though it exceeds the cap — an explicit,
 * documented safe exception rather than an invalid or empty result.
 */
function renderJson(value: unknown, maxBytes = 0): CoordinationToolTextBlock[] {
  const serialised = JSON.stringify(value, null, 2)
  const text = serialised === undefined ? String(value) : serialised
  const originalBytes = Buffer.byteLength(text, 'utf8')
  if (maxBytes <= 0 || originalBytes <= maxBytes) return [{ type: 'text', text }]
  return [{ type: 'text', text: truncationEnvelope(value, text, originalBytes, maxBytes) }]
}

function truncationEnvelope(
  value: unknown,
  text: string,
  originalBytes: number,
  maxBytes: number,
): string {
  const envelope: Record<string, unknown> = {
    truncated: true,
    marker: TOOL_RESULT_MARKER,
    maxResultBytes: maxBytes,
    originalBytes,
    returnedBytes: 0,
    ...(typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { keys: Object.keys(value).slice(0, 50) }
      : {}),
    preview: '',
  }
  let cut = Math.max(0, maxBytes - Buffer.byteLength(JSON.stringify(envelope, null, 2), 'utf8') - 16)
  let preview = cut > 0 ? `${text.slice(0, cut)}…` : '…'
  for (let attempt = 0; attempt < 32; attempt += 1) {
    envelope.preview = preview
    envelope.returnedBytes = Buffer.byteLength(JSON.stringify(envelope, null, 2), 'utf8')
    const candidate = JSON.stringify(envelope, null, 2)
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) return candidate
    if (cut === 0) break
    cut = Math.floor(cut * 0.8)
    preview = cut > 0 ? `${text.slice(0, cut)}…` : '…'
  }
  // The envelope cannot fit even with an empty preview: shrink to an explicit
  // marker that is still valid JSON, then to the minimal marker.
  const compact = JSON.stringify({ truncated: true, marker: TOOL_RESULT_MARKER, maxResultBytes: maxBytes, originalBytes })
  if (Buffer.byteLength(compact, 'utf8') <= maxBytes) return compact
  const minimal = JSON.stringify({ truncated: true, marker: TOOL_RESULT_MARKER })
  if (Buffer.byteLength(minimal, 'utf8') <= maxBytes) return minimal
  return MINIMAL_MARKER
}

/* ------------------------------------------------------------------------- *
 * File layer: lazy runtime (parse service + node registry + chain engine)
 * ------------------------------------------------------------------------- */

/**
 * The workspace root the file tools resolve paths against, best source first:
 *
 *  1. `options.workspaceRoot` (tests, alternate profiles);
 *  2. `service.workspaceRoot` (an explicit service-side root);
 *  3. `service.host.workspaceRoot` (the composed `ModuleHost`);
 *  4. `service.host.sandboxPolicy.resolve().workspaceRoot` — DSH's own sandbox
 *     policy is the authority for the actual workspace in the common case;
 *  5. `process.cwd()` **only** when none of the above yields a root.
 *
 * Reading the host structurally keeps this module free of a `dsh.ts` import (and
 * of an edit to that file). A missing/blank root is never treated as "the
 * workspace is the filesystem root".
 */
export function resolveToolWorkspaceRoot(
  service: CoordinationToolService,
  options: CoordinationToolOptions = {},
): string {
  const explicit = nonEmptyRoot(options.workspaceRoot) ??
    nonEmptyRoot(service.workspaceRoot) ??
    hostWorkspaceRoot(service)
  return resolve(explicit ?? process.cwd())
}

function hostWorkspaceRoot(service: CoordinationToolService): string | undefined {
  const host = service.host
  if (host === undefined) return undefined
  const declared = nonEmptyRoot(host.workspaceRoot)
  if (declared !== undefined) return declared
  try {
    return nonEmptyRoot(host.sandboxPolicy?.resolve()?.workspaceRoot)
  } catch {
    // A host whose sandbox policy is not ready yet is not a workspace answer.
    return undefined
  }
}

function nonEmptyRoot(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/* ------------------------------------------------------------------------- *
 * Request-scoped workspace root (the `/graph/*` routes)
 * ------------------------------------------------------------------------- */

/** Bound on `workingDirectory.ensure` while resolving one request's root. */
export const WORKSPACE_ROOT_ENSURE_TIMEOUT_MS = 1_500

/**
 * Minimal service surface the request-scoped resolver reads.
 *
 * `CoordinationService` satisfies it structurally, but the narrow shape keeps
 * the resolver testable without a host kernel: only the two optional root
 * declarations and the sandbox-policy port are consulted.
 */
export interface ToolWorkspaceRootService {
  /** An explicit service-side root (tests / alternate profiles). */
  readonly workspaceRoot?: string
  /** The composed host, when the service exposes it. */
  readonly host?: {
    readonly workspaceRoot?: string
    readonly sandboxPolicy?: {
      resolve(request?: { session?: unknown; mode?: string }): { workspaceRoot?: string }
    }
  }
}

/** One request's root inputs; every field is optional. */
export interface ToolWorkspaceRootRequest {
  /**
   * The raw `root` query parameter. When present it must be absolute and name
   * an existing directory, otherwise the resolver throws
   * `InvalidArgumentError` (the route answers 400) — silence would hide a
   * typo as "the workspace is empty".
   */
  root?: string | null
  /** The active session object, when the caller already resolved it. */
  session?: unknown
  /**
   * The Cordis context, read structurally for `agents`, `workingDirectory`,
   * `sessionQuery` and `sessionProjections`. Absent in tests that only
   * exercise the static sources.
   */
  context?: unknown
}

/** Options the request-scoped resolver honours (a test/profile root override). */
export interface ToolWorkspaceRootOptions {
  workspaceRoot?: string
}

/**
 * Resolve the workspace root for one `/graph/*` request, best source first:
 *
 *  1. an explicit `root` query parameter — absolute, normalised, existing
 *     directory; anything else is `InvalidArgumentError` (→ 400);
 *  2. `options.workspaceRoot` / `service.workspaceRoot`;
 *  3. `service.host.workspaceRoot`;
 *  4. `service.host.sandboxPolicy.resolve({ session }).workspaceRoot` — DSH's
 *     sandbox policy resolves the active session's recorded cwd, which is the
 *     session workspace rather than the desktop install directory;
 *  5. `workingDirectory.ensure(rootAgent, signal)` — the live session's
 *     effective directory, guarded by a short timeout and a try/catch;
 *  6. the root agent's session observation `workingDirectory` (read
 *     structurally from `session.workingDirectory`,
 *     `observation.projections.values.workingDirectory`, or the projection
 *     registry's `stateOf`; a recorded `null` is not a root);
 *  7. `process.cwd()` only when nothing else yields a usable directory.
 *
 * Every candidate is `stat`-validated and must be an existing directory; a
 * non-directory candidate is skipped rather than returned. The resolved root
 * is cached on this instance, so several reads in one request resolve once —
 * the instance must never outlive the request (no process-wide cache).
 *
 * Reading the host and context structurally keeps this module free of a
 * `dsh.ts`/Cordis runtime import, exactly like {@link resolveToolWorkspaceRoot}.
 */
export class ToolWorkspaceRootResolver {
  private pending: Promise<string> | undefined
  private readonly service: ToolWorkspaceRootService
  private readonly options: ToolWorkspaceRootOptions
  private readonly request: ToolWorkspaceRootRequest

  constructor(
    service: ToolWorkspaceRootService,
    options: ToolWorkspaceRootOptions = {},
    request: ToolWorkspaceRootRequest = {},
  ) {
    this.service = service
    this.options = options
    this.request = request
  }

  /** Resolve once per request; concurrent callers share the same promise. */
  resolve(): Promise<string> {
    this.pending ??= this.computeRoot()
    return this.pending
  }

  private async computeRoot(): Promise<string> {
    const explicit = await this.explicitRoot()
    if (explicit !== undefined) return explicit

    const context = this.request.context
    const agent = rootAgentOf(context)
    const session = this.activeSession(agent)
    const candidates = [
      nonEmptyRoot(this.options.workspaceRoot),
      nonEmptyRoot(this.service.workspaceRoot),
      nonEmptyRoot(this.service.host?.workspaceRoot),
      await this.sessionCwd(session),
      this.sandboxRoot(session),
    ]
    for (const candidate of candidates) {
      const root = await existingDirectoryRoot(candidate)
      if (root !== undefined) return root
    }

    const ensured = await ensuredWorkingDirectoryRoot(context, agent)
    if (ensured !== undefined) return ensured

    const observed = await observedWorkingDirectoryRoot(context, agent)
    if (observed !== undefined) return observed

    // The final fallback is the only unresolvable case; `resolve` keeps the
    // return absolute even if a caller replaced the process cwd.
    return (await existingDirectoryRoot(process.cwd())) ?? resolve(process.cwd())
  }

  /**
   * The session's recorded working directory, read through `ctx.sessionQuery`.
   *
   * The sandbox policy, asked with a bare session id, answers the process-wide
   * default workspace; the session's own `header.cwd` is the directory the user
   * actually opened, so it outranks the policy answer.
   */
  private async sessionCwd(session: unknown): Promise<string | undefined> {
    if (typeof session !== 'string' || session.length === 0) return undefined
    const query = contextGet(this.request.context, 'sessionQuery')
    const observe = callableOf(query, 'observeSession')
    if (observe === undefined) return undefined
    let observation: unknown
    try {
      observation = await observe.call(query, session)
      const header = recordOfValue(recordOfValue(observation)?.['header'])
      return nonEmptyRoot(header?.['cwd'])
    } catch {
      return undefined
    } finally {
      const disposable = recordOfValue(observation)?.[Symbol.dispose as unknown as string]
      if (typeof disposable === 'function') {
        try {
          disposable.call(observation)
        } catch {
          // A failed dispose never changes the resolved root.
        }
      }
    }
  }

  /** Validate the explicit query parameter, or `undefined` when absent. */
  private async explicitRoot(): Promise<string | undefined> {
    const raw = this.request.root
    if (raw === undefined || raw === null) return undefined
    const trimmed = raw.trim()
    if (trimmed.length === 0 || !isAbsolute(trimmed)) {
      throw new InvalidArgumentError('root must be an absolute directory path', { root: raw })
    }
    const root = await existingDirectoryRoot(trimmed)
    if (root === undefined) {
      throw new InvalidArgumentError('root must name an existing directory', { root: raw })
    }
    return root
  }

  /** The explicit session, else the root agent's live session. */
  private activeSession(agent: unknown): unknown {
    if (this.request.session !== undefined) return this.request.session
    return recordOfValue(agent)?.['session']
  }

  /** DSH's sandbox policy, resolved with the active session when available. */
  private sandboxRoot(session: unknown): string | undefined {
    const policy = this.service.host?.sandboxPolicy
    if (policy === undefined) return undefined
    try {
      const request = session === undefined ? undefined : { session }
      return nonEmptyRoot(policy.resolve(request)?.workspaceRoot)
    } catch {
      // A policy that is not ready yet is not a workspace answer.
      return undefined
    }
  }
}

/** One-shot form of {@link ToolWorkspaceRootResolver}. */
export async function resolveToolWorkspaceRootForRequest(
  service: ToolWorkspaceRootService,
  options: ToolWorkspaceRootOptions = {},
  request: ToolWorkspaceRootRequest = {},
): Promise<string> {
  return new ToolWorkspaceRootResolver(service, options, request).resolve()
}

/** Create the request-scoped resolver the `/graph/*` routes use. */
export function createToolWorkspaceRootResolver(
  service: ToolWorkspaceRootService,
  options: ToolWorkspaceRootOptions = {},
  request: ToolWorkspaceRootRequest = {},
): ToolWorkspaceRootResolver {
  return new ToolWorkspaceRootResolver(service, options, request)
}

type WorkspaceRootRecord = Record<string, unknown>

function recordOfValue(value: unknown): WorkspaceRootRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as WorkspaceRootRecord)
    : undefined
}

/** Resolve one method of a structurally-read service, if it is callable. */
function callableOf(
  service: unknown,
  name: string,
): ((this: unknown, ...args: unknown[]) => unknown) | undefined {
  const record = recordOfValue(service)
  const value = record?.[name]
  return typeof value === 'function'
    ? (value as (this: unknown, ...args: unknown[]) => unknown)
    : undefined
}

/** Read one Cordis service without tripping its context proxy. */
function contextGet(context: unknown, name: string): unknown {
  const get = callableOf(context, 'get')
  if (get === undefined) return undefined
  try {
    return get.call(context, name)
  } catch {
    return undefined
  }
}

/** The first live top-level agent (`agents.roots()[0]`), structurally. */
function rootAgentOf(context: unknown): unknown {
  const agents = contextGet(context, 'agents')
  const roots = callableOf(agents, 'roots')
  if (roots === undefined) return undefined
  try {
    const list = roots.call(agents)
    return Array.isArray(list) ? list[0] : undefined
  } catch {
    return undefined
  }
}

/** The agent/session id from a live agent record, structurally. */
function sessionIdOf(agent: unknown): string | undefined {
  const record = recordOfValue(agent)
  if (record === undefined) return undefined
  const direct = nonEmptyRoot(record['id'])
  if (direct !== undefined) return direct
  const session = recordOfValue(record['session'])
  return nonEmptyRoot(session?.['id']) ?? nonEmptyRoot(recordOfValue(session?.['header'])?.['id'])
}

/** Normalise a candidate and keep it only when `stat` says it is a directory. */
async function existingDirectoryRoot(candidate: string | undefined): Promise<string | undefined> {
  const value = nonEmptyRoot(candidate)
  if (value === undefined) return undefined
  const root = resolve(value)
  try {
    const info = await stat(root)
    return info.isDirectory() ? root : undefined
  } catch {
    return undefined
  }
}

/**
 * Step 5: the live session's effective directory.
 *
 * `workingDirectory.ensure` validates and may restore the directory, so it is
 * the most accurate live answer; a missing service/agent, a throw or a timeout
 * simply contributes nothing.
 */
async function ensuredWorkingDirectoryRoot(
  context: unknown,
  agent: unknown,
): Promise<string | undefined> {
  if (agent === undefined) return undefined
  const directories = contextGet(context, 'workingDirectory')
  const ensure = callableOf(directories, 'ensure')
  if (ensure === undefined) return undefined
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<undefined>((resolveTimeout) => {
      timer = setTimeout(() => {
        controller.abort()
        resolveTimeout(undefined)
      }, WORKSPACE_ROOT_ENSURE_TIMEOUT_MS)
    })
    const candidate = await Promise.race([
      Promise.resolve(ensure.call(directories, agent, controller.signal)).catch(() => undefined),
      timeout,
    ])
    return existingDirectoryRoot(typeof candidate === 'string' ? candidate : undefined)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Step 6: the recorded `workingDirectory` of the root agent's session.
 *
 * Read in the order the host exposes it: the live session field
 * (`session.workingDirectory`), the observation lease's
 * `projections.values.workingDirectory`, then the projection registry's
 * `stateOf(session, 'workingDirectory')`. A recorded `null` is ignored.
 */
async function observedWorkingDirectoryRoot(
  context: unknown,
  agent: unknown,
): Promise<string | undefined> {
  const session = recordOfValue(agent)?.['session']
  const direct = recordedWorkingDirectory(session)
  if (direct !== undefined) {
    const root = await existingDirectoryRoot(direct)
    if (root !== undefined) return root
  }

  const id = sessionIdOf(agent)
  const query = contextGet(context, 'sessionQuery')
  const observe = callableOf(query, 'observeSession')
  if (observe !== undefined && id !== undefined) {
    let lease: unknown
    try {
      lease = await observe.call(query, id, { projectionMode: 'all' })
      const observed = recordedWorkingDirectory(lease)
      if (observed !== undefined) {
        const root = await existingDirectoryRoot(observed)
        if (root !== undefined) return root
      }
    } catch {
      // An unreadable observation contributes nothing.
    } finally {
      disposeSessionObservation(lease)
    }
  }

  const projections = contextGet(context, 'sessionProjections')
  const stateOf = callableOf(projections, 'stateOf')
  if (stateOf !== undefined && session !== undefined) {
    try {
      const projected = nonEmptyRoot(stateOf.call(projections, session, 'workingDirectory'))
      if (projected !== undefined) {
        const root = await existingDirectoryRoot(projected)
        if (root !== undefined) return root
      }
    } catch {
      // Fall through to the process cwd.
    }
  }
  return undefined
}

/** Structural read of a recorded `workingDirectory` (string or null). */
function recordedWorkingDirectory(value: unknown): string | undefined {
  const record = recordOfValue(value)
  if (record === undefined) return undefined
  const direct = nonEmptyRoot(record['workingDirectory'])
  if (direct !== undefined) return direct
  const values = recordOfValue(record['values'])
  const fromValues = nonEmptyRoot(values?.['workingDirectory'])
  if (fromValues !== undefined) return fromValues
  const projections = recordOfValue(record['projections'])
  const projected = nonEmptyRoot(recordOfValue(projections?.['values'])?.['workingDirectory'])
  if (projected !== undefined) return projected
  return nonEmptyRoot(recordOfValue(record['session'])?.['workingDirectory'])
}

/** Release one observation lease without requiring the ES2023 `using` syntax. */
function disposeSessionObservation(lease: unknown): void {
  if (lease === null || typeof lease !== 'object') return
  const disposeSymbol = (Symbol as unknown as { dispose?: symbol }).dispose
  if (disposeSymbol !== undefined) {
    try {
      const dispose = Reflect.get(lease as object, disposeSymbol)
      if (typeof dispose === 'function') {
        dispose.call(lease)
        return
      }
    } catch {
      // A failing lease release must never change the resolved root.
    }
  }
  const dispose = callableOf(lease, 'dispose')
  if (dispose === undefined) return
  try {
    dispose.call(lease)
  } catch {
    // A failing lease release must never change the resolved root.
  }
}

/**
 * One lazily-built runtime per `CoordinationToolService`. The services are
 * constructed on the first file-tool call, shared by all four tools (so a
 * `coordination_parse` handle can be described and chained), and released by
 * the registration disposer. Nothing is read or constructed at registration
 * time: a host that never calls a file tool pays nothing.
 *
 * Two cross-cutting contracts live here:
 *
 *  - **Live retune.** `toolRuntimeOf` compares the file-layer config signature on
 *    every call and re-applies parser/chain budgets in place. Handles and
 *    fingerprints therefore survive a `/config` change; only the caps change.
 *    A workspace-root change is the one case that recreates the runtime.
 *  - **Persistence.** When the service exposes a real `CoordinationDatabase`,
 *    cards and chain edges are written to the v24 tables and the first file-tool
 *    call rehydrates the bounded newest set, so handles survive a restart.
 */
class ToolRuntime {
  private parseValue: ParseService | undefined
  private registryValue: NodeRegistry | undefined
  private chainValue: ChainEngine | undefined
  private readonly storeValue: GraphStore | undefined
  private prepared = false
  private disposed = false
  private signature: string
  private parseOptions: ParseServiceOptions
  private chainDepth: number
  private chainLinks: number
  private chainTokenBudget: number
  private readonly chainCapacity: number | undefined
  private readonly registryCapacity: number | undefined
  readonly workspaceRoot: string
  private enabled: boolean

  constructor(service: CoordinationToolService, options: CoordinationToolOptions, workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot
    this.signature = fileLayerSignature(service, options, workspaceRoot)
    this.parseOptions = parseOptionsOf(service, options)
    this.chainDepth = chainDepthOf(service)
    this.chainLinks = chainLinksOf(service)
    this.chainTokenBudget = chainTokenBudgetOf(service)
    this.chainCapacity = options.chainCacheCapacity
    this.registryCapacity = options.registryCapacity
    this.enabled = fileLayerConfig(service).parser?.enabled !== false
    const database = coordinationDatabaseOf(service.db)
    this.storeValue = database === undefined
      ? undefined
      : new GraphStore(database, { workspaceRoot })
  }

  /** True when the runtime still answers for this signature/root. */
  matches(signature: string, workspaceRoot: string): boolean {
    return this.signature === signature && this.workspaceRoot === workspaceRoot
  }

  /**
   * Apply a live config change without discarding indexed nodes or handles.
   * Parse caches are dropped inside `ParseService.retune` (their key does not
   * encode the changed budgets); chain projections are dropped because the
   * token budget is not part of the cache key.
   */
  retune(service: CoordinationToolService, options: CoordinationToolOptions, signature: string): void {
    this.assertLive()
    this.signature = signature
    this.parseOptions = parseOptionsOf(service, options)
    this.chainDepth = chainDepthOf(service)
    this.chainLinks = chainLinksOf(service)
    this.chainTokenBudget = chainTokenBudgetOf(service)
    this.enabled = fileLayerConfig(service).parser?.enabled !== false
    this.parseValue?.retune(this.parseOptions)
    const retune: ChainRetuneOptions = {
      maxDepth: this.chainDepth,
      maxLinks: this.chainLinks,
      tokenBudget: this.chainTokenBudget,
      ...(this.chainCapacity === undefined ? {} : { cacheCapacity: this.chainCapacity }),
    }
    this.chainValue?.retune(retune)
  }

  get parseService(): ParseService {
    this.assertLive()
    this.assertEnabled()
    const service = this.ensureParse()
    this.hydrate()
    return service
  }

  get registry(): NodeRegistry {
    this.assertLive()
    this.assertEnabled()
    const registry = this.ensureRegistry()
    this.hydrate()
    return registry
  }

  get chain(): ChainEngine {
    this.assertLive()
    this.assertEnabled()
    const chain = this.ensureChain()
    this.hydrate()
    return chain
  }

  /**
   * Register + index one parse, persisting nodes/edges and the snapshot in one
   * transaction when a database is present. Returns the bounded card list the
   * tool projects.
   */
  recordParse(parsed: ParsedFile): NodeCard[] {
    this.prepareForUse()
    const apply = (): NodeCard[] => {
      if (parsed.path !== undefined) this.storeValue?.beginParse(parsed.path)
      const cards = this.ensureRegistry().register(parsed)
      if (parsed.path !== undefined) this.ensureChain().index(parsed)
      this.storeValue?.saveSnapshot(parsed, { nodeCount: cards.length })
      return cards
    }
    return this.storeValue === undefined ? apply() : this.storeValue.transaction(apply)
  }

  /** Bounded dependency summary of the files this runtime has parsed. */
  dependencySummary(): DependencyGraphSummary {
    return this.parseService.dependencyGraph()
  }

  dispose(): void {
    this.parseValue?.clear()
    this.registryValue?.clear()
    this.chainValue?.clear()
    this.parseValue = undefined
    this.registryValue = undefined
    this.chainValue = undefined
    this.disposed = true
  }

  private prepareForUse(): void {
    this.assertLive()
    this.assertEnabled()
    this.hydrate()
  }

  private ensureParse(): ParseService {
    this.parseValue ??= new ParseService({ ...this.parseOptions, workspaceRoot: this.workspaceRoot })
    return this.parseValue
  }

  private ensureRegistry(): NodeRegistry {
    this.registryValue ??= new NodeRegistry({
      ...(this.registryCapacity === undefined ? {} : { capacity: this.registryCapacity }),
      ...(this.storeValue === undefined ? {} : { persist: this.storeValue }),
    })
    return this.registryValue
  }

  private ensureChain(): ChainEngine {
    this.chainValue ??= new ChainEngine({
      ...(this.chainCapacity === undefined ? {} : { cacheCapacity: this.chainCapacity }),
      maxDepth: this.chainDepth,
      maxLinks: this.chainLinks,
      tokenBudget: this.chainTokenBudget,
      ...(this.storeValue === undefined
        ? {}
        : {
            persist: {
              saveNode: (node: ChainNodeSnapshot) => this.storeValue?.saveChainNode(node),
              saveEdge: (edge: ChainEdgeSnapshot) => this.storeValue?.saveEdge(edge),
              deleteEdge: (edge: { relation: ChainRelation; from: string; to: string }) =>
                this.storeValue?.deleteEdge(edge),
            },
          }),
    })
    return this.chainValue
  }

  /**
   * Rehydrate the bounded newest nodes/edges once, the first time any file tool
   * touches this runtime. No store (tests, a non-kernel facade) means no work.
   */
  private hydrate(): void {
    if (this.prepared) return
    this.prepared = true
    if (this.storeValue === undefined) return
    const records = this.storeValue.loadNodes()
    this.ensureRegistry().restore(records)
    this.ensureChain().hydrate(this.storeValue.loadChainNodes(), this.storeValue.loadEdges())
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new InvalidStateError(
        'the parser was disabled by the live coordination config; re-register the file tools (locale change or restart) to remove or restore them',
      )
    }
  }

  private assertLive(): void {
    if (this.disposed) {
      // A tool captured by a stale registration must not resurrect a runtime
      // whose caches were released; the registry disposer owns the lifetime.
      throw new InvalidArgumentError('the coordination file tools were disposed; re-register them')
    }
  }
}

const toolRuntimes = new WeakMap<CoordinationToolService, ToolRuntime>()

/**
 * The file-tool runtime for one call, rooted at the calling session's
 * workspace. The runtime cache already recreates itself when the root changes,
 * so a workspace switch between calls is handled without leaking the old graph.
 */
async function toolRuntimeFor(
  service: CoordinationToolService,
  options: CoordinationToolOptions,
  exec?: ToolExecution,
): Promise<ToolRuntime> {
  const root = await toolRequestRoot(service, options, exec)
  return toolRuntimeOf(service, options.workspaceRoot === root ? options : { ...options, workspaceRoot: root })
}
function toolRuntimeOf(service: CoordinationToolService, options: CoordinationToolOptions): ToolRuntime {
  const workspaceRoot = resolveToolWorkspaceRoot(service, options)
  const signature = fileLayerSignature(service, options, workspaceRoot)
  const existing = toolRuntimes.get(service)
  if (existing === undefined) {
    const runtime = new ToolRuntime(service, options, workspaceRoot)
    toolRuntimes.set(service, runtime)
    return runtime
  }
  if (existing.matches(signature, workspaceRoot)) return existing
  if (existing.workspaceRoot !== workspaceRoot) {
    // A different workspace is a different graph: recreate rather than re-root
    // nodes that were indexed against the old root.
    existing.dispose()
    const runtime = new ToolRuntime(service, options, workspaceRoot)
    toolRuntimes.set(service, runtime)
    return runtime
  }
  existing.retune(service, options, signature)
  return existing
}

/** Release the file-tool runtime of one service (called by the disposer/tests). */
export function disposeCoordinationToolRuntime(service: CoordinationToolService): void {
  const runtime = toolRuntimes.get(service)
  if (runtime === undefined) return
  toolRuntimes.delete(service)
  runtime.dispose()
}

/** True when the service is the composed host (`CoordinationService`). */
function isHostKernelService(service: CoordinationToolService): boolean {
  return (
    service.db !== undefined ||
    service.config !== undefined ||
    service.workspaceRoot !== undefined ||
    service.host !== undefined
  )
}

/**
 * Structural view of the host config groups this layer consumes. `config.ts` is
 * another agent's file during this change, so the module never imports it: the
 * resolved object is read by shape and every field falls back to the hard cap.
 * Host config can only *tighten* a budget — `MAX_*` stays the ceiling.
 */
interface FileLayerConfigView {
  parser?: {
    enabled?: boolean
    maxFileBytes?: number
    maxTokens?: number
    maxAstDepth?: number
    timeoutMs?: number
    cacheCapacity?: number
    dependencyGraphMaxVertices?: number
    dependencyGraphMaxEdges?: number
  }
  chain?: {
    depth?: number
    links?: number
    tokenBudget?: number
  }
  tools?: {
    maxResultBytes?: number
  }
}

function fileLayerConfig(service: CoordinationToolService): FileLayerConfigView {
  const config = service.config
  if (typeof config !== 'object' || config === null) return {}
  return config as FileLayerConfigView
}

/** A positive integer config value, or `undefined` when absent/invalid. */
function configNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function parseOptionsOf(service: CoordinationToolService, options: CoordinationToolOptions): ParseServiceOptions {
  const parser = fileLayerConfig(service).parser ?? {}
  const fromConfig: ParseServiceOptions = {
    ...(configNumber(parser.maxFileBytes) === undefined ? {} : { maxFileBytes: configNumber(parser.maxFileBytes) }),
    ...(configNumber(parser.maxTokens) === undefined ? {} : { maxTokens: configNumber(parser.maxTokens) }),
    ...(configNumber(parser.maxAstDepth) === undefined ? {} : { maxAstDepth: configNumber(parser.maxAstDepth) }),
    ...(configNumber(parser.timeoutMs) === undefined ? {} : { timeoutMs: configNumber(parser.timeoutMs) }),
    ...(configNumber(parser.cacheCapacity) === undefined ? {} : { cacheCapacity: configNumber(parser.cacheCapacity) }),
    ...(configNumber(parser.dependencyGraphMaxVertices) === undefined
      ? {}
      : { maxGraphVertices: configNumber(parser.dependencyGraphMaxVertices) }),
    ...(configNumber(parser.dependencyGraphMaxEdges) === undefined
      ? {}
      : { maxGraphEdges: configNumber(parser.dependencyGraphMaxEdges) }),
  }
  // Explicit test options win over config; config still tightens the hard caps.
  return { ...fromConfig, ...(options.parseService ?? {}) }
}

function chainDepthOf(service: CoordinationToolService): number {
  return configNumber(fileLayerConfig(service).chain?.depth) ?? MAX_CHAIN_DEPTH
}

function chainLinksOf(service: CoordinationToolService): number {
  return configNumber(fileLayerConfig(service).chain?.links) ?? MAX_CHAIN_LINKS
}

function chainTokenBudgetOf(service: CoordinationToolService): number {
  return configNumber(fileLayerConfig(service).chain?.tokenBudget) ?? MAX_CHAIN_TOKENS
}

/** Stable signature of every value the lazy runtime captures. */
function fileLayerSignature(
  service: CoordinationToolService,
  options: CoordinationToolOptions,
  workspaceRoot: string,
): string {
  const config = fileLayerConfig(service)
  return JSON.stringify([
    workspaceRoot,
    config.parser ?? {},
    config.chain ?? {},
    options.parseService ?? {},
    options.chainCacheCapacity ?? null,
    options.registryCapacity ?? null,
  ])
}

/** Narrow a structurally-exposed `db` to the coordination database wrapper. */
function coordinationDatabaseOf(value: unknown): CoordinationDatabase | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  return typeof candidate.insert === 'function' &&
    typeof candidate.get === 'function' &&
    typeof candidate.run === 'function' &&
    typeof candidate.all === 'function' &&
    typeof candidate.transaction === 'function'
    ? (value as CoordinationDatabase)
    : undefined
}

/* ------------------------------------------------------------------------- *
 * File-layer tool values
 * ------------------------------------------------------------------------- */

/** Value of `coordination_parse` (metadata only; never a body). */
export interface ParseToolValue {
  path?: string
  parserId: string
  charset: string
  bomBytes: number
  truncated: boolean
  status: string
  tokens: number
  size: number
  cached: boolean
  document?: { form: string; title?: string; author?: string; source: string }
  references: ReferenceView[]
  referencesTruncated: boolean
  diagnostics: Array<{
    code: string
    message: string
    severity: string
    line?: number
    column?: number
  }>
  diagnosticsTruncated: boolean
  cards: NodeCard[]
  cardsTruncated: boolean
  /** Bounded workspace dependency summary (counts only; no graph/edges). */
  dependencies: DependencyGraphSummary
  counts: { nodes: number; references: number; diagnostics: number; external: number }
}

/** Value of `coordination_chain`: a ChainProjection, nothing else. */
export type ChainToolValue = ChainProjection

/** Value of `coordination_read`: the only tool value with real file text. */
export interface ReadToolValue {
  path: string
  mode: 'bytes' | 'lines'
  requested: { start: number; end: number }
  returned: { start: number; end: number }
  content: string
  truncated: boolean
  charset: string
  bom: boolean
  bomBytes: number
  hash: string
  fileBytes: number
  mtime: number
  byteRange: { start: number; end: number }
  lineRange?: { start: number; end: number }
  nextStart?: number
  nextLine?: number
}

/** A chunk of a `coordination_parse` result: bounded and body-free. */
const PARSE_REFERENCE_LIMIT = 200
const PARSE_DIAGNOSTIC_LIMIT = 100
const PARSE_CARD_LIMIT = 100

const CHAIN_ACTIONS: readonly ChainAction[] = [
  'dependencies',
  'dependents',
  'satisfies',
  'satisfied_by',
  'baseline',
  'prerequisites',
  'unmet',
  'path',
  'cycle',
]

/* ------------------------------------------------------------------------- *
 * File-layer tool definitions
 * ------------------------------------------------------------------------- */

/**
 * Build the four file-layer definitions for one locale. Pure: the services are
 * still lazy (`ToolRuntime` is created on the first execution), so a definition
 * is just schema plus closures.
 */
export function coordinationFileToolDefinitions(
  service: CoordinationToolService,
  locale: Locale = normaliseLocale(service.locale),
  options: CoordinationToolOptions = {},
): CoordinationToolDefinition[] {
  // Keep the pre-i18n fallback: an unsupported tag still gets the zh-CN table.
  const copy = (copyFor(locale) ?? copyFor('zh-CN')).fileTools
  return [
    parseTool(service, copy.coordination_parse, options),
    describeTool(service, copy.coordination_describe, options),
    chainDefinition(service, copy.coordination_chain, options),
    readTool(service, copy.coordination_read, options),
  ]
}

function parseTool(
  service: CoordinationToolService,
  copy: ToolCopy,
  options: CoordinationToolOptions,
): CoordinationToolDefinition<ParseToolValue> {
  return {
    name: 'coordination_parse',
    description: copy.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: fileStringParameter(copy, 'path'),
        text: fileStringParameter(copy, 'text'),
        parserId: fileStringParameter(copy, 'parserId'),
      },
    },
    output: {
      schema: PARSE_TOOL_SCHEMA,
      render: (_args, value) => renderJson(value, toolResultMaxBytes(service)),
    },
    async execute(rawArgs, exec) {
      const args = asArguments(rawArgs)
      const path = optionalToken(args, 'path')
      const text = optionalText(args, 'text')
      const parserId = optionalToken(args, 'parserId')
      if ((path === undefined) === (text === undefined)) {
        throw new InvalidArgumentError('coordination_parse requires exactly one of path or text')
      }
      const runtime = await toolRuntimeFor(service, options, exec)
      const parsed = runtime.parseService.parse({
        ...(path === undefined ? {} : { path }),
        ...(text === undefined ? {} : { text }),
        ...(parserId === undefined ? {} : { parserId }),
      })
      // Register + index + persist in one step; a text-only parse has no
      // workspace identity, so only the registry sees it.
      const cards = runtime.recordParse(parsed)
      return parseValue(parsed, cards, runtime.dependencySummary())
    },
  }
}

function describeTool(
  service: CoordinationToolService,
  copy: ToolCopy,
  options: CoordinationToolOptions,
): CoordinationToolDefinition<DescribeResult> {
  return {
    name: 'coordination_describe',
    description: copy.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['handle'],
      properties: {
        handle: fileStringParameter(copy, 'handle'),
        fields: {
          type: 'array',
          description: fileParameter(copy, 'fields'),
          items: { type: 'string', enum: ['summary', 'description', 'usage', 'purpose'] },
        },
      },
    },
    output: {
      schema: DESCRIBE_TOOL_SCHEMA,
      render: (_args, value) => renderJson(value, toolResultMaxBytes(service)),
    },
    async execute(rawArgs, exec) {
      const args = asArguments(rawArgs)
      const handle = requiredToken(args, 'handle')
      const fields = optionalStringList(args, 'fields')
      return (await toolRuntimeFor(service, options, exec)).registry.describe(handle, fields)
    },
  }
}

function chainDefinition(
  service: CoordinationToolService,
  copy: ToolCopy,
  options: CoordinationToolOptions,
): CoordinationToolDefinition<ChainToolValue> {
  return {
    name: 'coordination_chain',
    description: copy.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['handle', 'action'],
      properties: {
        handle: fileStringParameter(copy, 'handle'),
        action: {
          type: 'string',
          description: fileParameter(copy, 'action'),
          enum: [...CHAIN_ACTIONS],
        },
        depth: { type: 'integer', description: fileParameter(copy, 'depth') },
        limit: { type: 'integer', description: fileParameter(copy, 'limit') },
        target: fileStringParameter(copy, 'target'),
        relation: fileStringParameter(copy, 'relation'),
        kind: fileStringParameter(copy, 'kind'),
      },
    },
    output: {
      schema: CHAIN_TOOL_SCHEMA,
      render: (_args, value) => renderJson(value, toolResultMaxBytes(service)),
    },
    async execute(rawArgs, exec) {
      const args = asArguments(rawArgs)
      const handle = requiredToken(args, 'handle')
      const action = requiredAction(args)
      const query: ChainQueryOptions = {
        ...(args.depth === undefined ? {} : { depth: nonNegativeInteger(args, 'depth') }),
        ...(args.limit === undefined ? {} : { limit: nonNegativeInteger(args, 'limit') }),
        ...(args.relation === undefined
          ? {}
          : { relation: requiredToken(args, 'relation') as ChainRelation }),
        ...(args.kind === undefined ? {} : { kind: requiredToken(args, 'kind') }),
      }
      const engine = (await toolRuntimeFor(service, options, exec)).chain
      switch (action) {
        case 'dependencies':
          return engine.dependenciesOf(handle, query)
        case 'dependents':
          return engine.dependentsOf(handle, query)
        case 'satisfies':
          return engine.satisfiesOf(handle, query)
        case 'satisfied_by':
          return engine.satisfiedBy(handle, query)
        case 'baseline':
          return engine.baselineOf(handle, query)
        case 'prerequisites':
          return engine.prerequisitesOf(handle, query)
        case 'unmet':
          return engine.unmet(handle, query)
        case 'path':
          return engine.path(handle, requiredToken(args, 'target'), query)
        case 'cycle':
          return engine.cycleAt(handle, query)
      }
    },
  }
}

function readTool(
  service: CoordinationToolService,
  copy: ToolCopy,
  options: CoordinationToolOptions,
): CoordinationToolDefinition<ReadToolValue> {
  return {
    name: 'coordination_read',
    description: copy.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'mode', 'start'],
      properties: {
        path: fileStringParameter(copy, 'path'),
        mode: {
          type: 'string',
          description: fileParameter(copy, 'mode'),
          enum: ['bytes', 'lines'],
        },
        start: { type: 'integer', description: fileParameter(copy, 'start') },
        end: { type: 'integer', description: fileParameter(copy, 'end') },
        maxBytes: { type: 'integer', description: fileParameter(copy, 'maxBytes') },
        maxLines: { type: 'integer', description: fileParameter(copy, 'maxLines') },
      },
    },
    output: {
      schema: READ_TOOL_SCHEMA,
      render: (_args, value) => renderJson(value, toolResultMaxBytes(service)),
    },
    async execute(rawArgs, exec) {
      const args = asArguments(rawArgs)
      const mode = requiredMode(args)
      const request = {
        path: requiredToken(args, 'path'),
        mode,
        start: nonNegativeInteger(args, 'start'),
        ...(args.end === undefined ? {} : { end: nonNegativeInteger(args, 'end') }),
        ...(args.maxBytes === undefined ? {} : { maxBytes: nonNegativeInteger(args, 'maxBytes') }),
        ...(args.maxLines === undefined ? {} : { maxLines: nonNegativeInteger(args, 'maxLines') }),
      }
      return (await toolRuntimeFor(service, options, exec)).parseService.readContent(request)
    },
  }
}

function parseValue(
  parsed: ParsedFile,
  cards: readonly NodeCard[],
  dependencies: DependencyGraphSummary,
): ParseToolValue {
  const references = parsed.references.slice(0, PARSE_REFERENCE_LIMIT).map((reference) =>
    viewReference(reference, parsed.path),
  )
  const diagnostics = parsed.diagnostics.slice(0, PARSE_DIAGNOSTIC_LIMIT).map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    ...(diagnostic.span === undefined
      ? {}
      : { line: diagnostic.span.line, column: diagnostic.span.column }),
  }))
  const boundedCards = cards.slice(0, PARSE_CARD_LIMIT)
  return {
    ...(parsed.path === undefined ? {} : { path: parsed.path }),
    parserId: parsed.parserId,
    charset: parsed.charset,
    bomBytes: parsed.bomBytes,
    truncated: parsed.truncated,
    status: parsed.status,
    tokens: parsed.tokens,
    size: parsed.size,
    cached: parsed.cached,
    ...(parsed.document === undefined
      ? {}
      : {
          document: {
            form: parsed.document.form,
            source: parsed.document.source,
            ...(parsed.document.title === undefined ? {} : { title: parsed.document.title }),
            ...(parsed.document.author === undefined ? {} : { author: parsed.document.author }),
          },
        }),
    references,
    referencesTruncated: parsed.references.length > references.length,
    diagnostics,
    diagnosticsTruncated: parsed.diagnostics.length > diagnostics.length,
    cards: boundedCards,
    cardsTruncated: cards.length > boundedCards.length,
    dependencies,
    counts: {
      nodes: cards.length,
      references: parsed.references.length,
      diagnostics: parsed.diagnostics.length,
      external: parsed.references.filter((reference) => reference.external).length,
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Workspace-graph tools (`coordination_file` / `_outline` / `_importation` /
 * `_exportation`)
 *
 * Read-only projections of the graph the file layer already persisted. They
 * never parse, write, execute or read file content: a call resolves the
 * workspace root through the same request-scoped resolver as the `/graph/*`
 * routes, loads one body-free `GraphStore` snapshot, and projects it through
 * the pure builders in `graph-view.ts` (`buildTree`, `buildImports`) plus the
 * small adapters below. Every successful value is paths/names/kinds only.
 *
 * Invalid user input never throws: each `execute` catches the typed error and
 * returns `{ error: { code: 'INVALID_ARGUMENT', message } }`, which is part of
 * the tool's declared `oneOf` output schema.
 * ------------------------------------------------------------------------- */

/** One body-free snapshot of the persisted workspace graph a graph tool reads. */
export interface CoordinationGraphSnapshot {
  /** Absolute workspace root the snapshot's paths are relative to. */
  root: string
  /** Changes whenever the graph changes; keys the graph-view L2 cache. */
  version: string
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
}

/**
 * Read the persisted graph for one resolved workspace root.
 *
 * The host default ({@link graphSnapshotOf}) reads the `GraphStore` the file
 * tools already wrote: no parse, no write, no file read. Tests pass a stub.
 */
export type CoordinationGraphSnapshotProvider = (
  root: string,
) => CoordinationGraphSnapshot | Promise<CoordinationGraphSnapshot>

/** Typed, non-throwing failure every graph tool returns for invalid input. */
export interface CoordinationGraphToolError {
  error: { code: 'INVALID_ARGUMENT'; message: string }
}

/** One entry of `coordination_file`. */
export interface WorkspaceTreeEntry {
  /** Workspace-relative path. */
  path: string
  /** Last path segment. */
  name: string
  kind: 'directory' | 'file'
  /** Present only when the entry is a directory with returned children. */
  children?: WorkspaceTreeEntry[]
}

/** Value of `coordination_file`. */
export interface CoordinationFileValue {
  /** Resolved absolute workspace root the tree describes. */
  root: string
  entries: WorkspaceTreeEntry[]
  /** True when the depth, entry or graph-tree cap cut the result. */
  truncated: boolean
}

/** One structure-outline node (path/name/kind metadata only, never a body). */
export type StructureOutlineNode = OutlineNode

/** Value of `coordination_outline` with `path` (one file). */
export interface CoordinationFileOutlineValue {
  scope: 'file'
  path: string
  family: GraphFamily
  nodes: StructureOutlineNode[]
  /** True when `limit` cut the node list. */
  truncated: boolean
}

/** One workspace-scope outline group. */
export interface CoordinationOutlineGroupValue {
  path: string
  family: GraphFamily
  nodes: StructureOutlineNode[]
}

/** Value of `coordination_outline` without `path` (the whole workspace). */
export interface CoordinationWorkspaceOutlineValue {
  scope: 'workspace'
  groups: CoordinationOutlineGroupValue[]
  /** True when the node budget cut the workspace view. */
  truncated: boolean
}

export type CoordinationOutlineValue = CoordinationFileOutlineValue | CoordinationWorkspaceOutlineValue

/** One `coordination_importation` row. */
export interface CoordinationImportationRow {
  path: string
  imported: string[]
  /** Present only when the file participates in a `depends` cycle. */
  cyclic?: boolean
}

/** Value of `coordination_importation`. */
export interface CoordinationImportationValue {
  rows: CoordinationImportationRow[]
  /** True when `limit` or the route projection's 2,000-row cap cut the rows. */
  truncated: boolean
}

/** One `coordination_exportation` row. */
export interface CoordinationExportationRow {
  path: string
  exported: string[]
  /** Present only when the file participates in a `depends` cycle. */
  cyclic?: boolean
}

/** Value of `coordination_exportation`. */
export interface CoordinationExportationValue {
  rows: CoordinationExportationRow[]
  /** True when `limit` or the route projection's 2,000-row cap cut the rows. */
  truncated: boolean
}

/** Deepest directory level `coordination_file` returns (root children = 1). */
export const MAX_FILE_TOOL_DEPTH = 4
/** Hard entry cap of `coordination_file`. */
export const MAX_FILE_TOOL_ENTRIES = 500
/** Default entry budget of `coordination_file`. */
export const DEFAULT_FILE_TOOL_ENTRIES = 200
/** Hard node cap of `coordination_outline`. */
export const MAX_OUTLINE_TOOL_NODES = 500
/** Default node budget of `coordination_outline`. */
export const DEFAULT_OUTLINE_TOOL_NODES = 200
/** Hard row cap of the import/export tools. */
export const MAX_RELATION_TOOL_ROWS = 2_000
/** Default row budget of the import/export tools. */
export const DEFAULT_RELATION_TOOL_ROWS = 500

/** File-backed node kinds `buildTree` accepts as file entries. */
const FILE_TREE_NODE_KINDS: ReadonlySet<string> = new Set(['module', 'document', 'book', 'article', 'file'])

/**
 * Structure-only depth order per family; the array index is `depth`.
 *
 * Document structure plus module/class/interface/type/enumeration/namespace/
 * method/function. Leaf and symbol noise (`line`, `sentence`, `property`,
 * `variable`, `static`, `importation`, `exportation`) has no slot, so it can
 * never appear. `enumeration` and `namespace` are included here even though the
 * `/graph/outline` route omits them: its project order has no slot for either,
 * while the model-facing structure outline must report both.
 */
const STRUCTURE_KIND_ORDERS: Readonly<Record<Exclude<GraphFamily, 'unknown'>, readonly string[]>> = {
  book: ['book', 'chapter', 'page', 'paragraph'],
  article: ['article', 'chapter', 'page', 'paragraph'],
  tex: ['document', 'chapter', 'preface', 'preamble', 'part', 'section', 'paragraph'],
  document: ['document', 'heading', 'paragraph'],
  project: ['module', 'class', 'interface', 'type', 'enumeration', 'namespace', 'method', 'function'],
}

/** One inline copy block; EN and zh-CN live side by side in this module. */
interface GraphToolCopy {
  description: string
  parameters: Readonly<Record<string, string>>
}

/**
 * Inline EN + zh-CN copy for the four graph tools.
 *
 * Deliberately not in `src/shared/i18n.ts`: the shared table is owned by the
 * locale surface and this read-only tool set must not force new keys into it.
 */
const GRAPH_TOOL_COPY: Readonly<Record<Locale, Readonly<Record<CoordinationGraphToolName, GraphToolCopy>>>> = {
  'en-US': {
    coordination_file: {
      description:
        'Read-only directory tree of the persisted workspace graph: workspace-relative paths, names and directory/file kinds only, never file content. Omit path for the workspace root; absolute paths, UNC paths and ".." are refused with INVALID_ARGUMENT.',
      parameters: {
        path: 'Workspace-relative directory; omit for the workspace root. Absolute/UNC paths and ".." are refused.',
        depth: 'Directory depth to return, 1-4 (default 2).',
        limit: 'Maximum tree entries, 1-500 (default 200).',
      },
    },
    coordination_outline: {
      description:
        'Read-only structure outline of the indexed workspace: document headings/sections and code module/class/function/method/interface/type/enumeration/namespace nodes with handle, name, depth and line. Variables, properties, statics, imports/exports, lines and sentences are filtered out. With path one file; without it every indexed file, grouped by path. Never file content.',
      parameters: {
        path: 'Workspace-relative file; omit for the whole workspace.',
        limit: 'Maximum outline nodes, 1-500 (default 200).',
      },
    },
    coordination_importation: {
      description:
        'Read-only import relationships of the indexed workspace: each file\'s imported module specifiers in source order, never the imported module body. With path only that file\'s row. A file in a dependency cycle carries cyclic: true.',
      parameters: {
        path: 'Workspace-relative file; omit for every indexed file.',
        limit: 'Maximum rows, 1-2000 (default 500).',
      },
    },
    coordination_exportation: {
      description:
        'Read-only export relationships of the indexed workspace: each file\'s exported names in source order, never the exported declaration body. With path only that file\'s row. A file in a dependency cycle carries cyclic: true.',
      parameters: {
        path: 'Workspace-relative file; omit for every indexed file.',
        limit: 'Maximum rows, 1-2000 (default 500).',
      },
    },
  },
  'zh-CN': {
    coordination_file: {
      description:
        '以只读目录树列出已持久化的工作区图：仅返回工作区相对路径、名称以及目录/文件类型，绝不返回文件内容。省略 path 表示工作区根目录；绝对路径、UNC 路径和 ".." 一律以 INVALID_ARGUMENT 拒绝。',
      parameters: {
        path: '工作区相对目录；省略表示工作区根目录。拒绝绝对路径、UNC 路径和 ".."。',
        depth: '返回的目录深度，1-4（默认 2）。',
        limit: '最大目录树条目数，1-500（默认 200）。',
      },
    },
    coordination_outline: {
      description:
        '以只读结构大纲列出已索引的工作区：文档标题/章节，以及代码的 module/class/function/method/interface/type/enumeration/namespace 节点，含 handle、名称、深度和行号。变量、属性、静态成员、导入/导出、行与句子会被过滤。提供 path 时只看一个文件；省略时按路径分组列出所有已索引文件。绝不返回文件内容。',
      parameters: {
        path: '工作区相对文件；省略表示整个工作区。',
        limit: '最大大纲节点数，1-500（默认 200）。',
      },
    },
    coordination_importation: {
      description:
        '以只读方式列出已索引工作区的导入关系：每个文件按源码顺序返回导入的模块说明符，绝不返回被导入模块的内容。提供 path 时只返回该文件的一行。处于依赖环中的文件带有 cyclic: true。',
      parameters: {
        path: '工作区相对文件；省略表示所有已索引文件。',
        limit: '最大行数，1-2000（默认 500）。',
      },
    },
    coordination_exportation: {
      description:
        '以只读方式列出已索引工作区的导出关系：每个文件按源码顺序返回导出的名称，绝不返回被导出声明的内容。提供 path 时只返回该文件的一行。处于依赖环中的文件带有 cyclic: true。',
      parameters: {
        path: '工作区相对文件；省略表示所有已索引文件。',
        limit: '最大行数，1-2000（默认 500）。',
      },
    },
  },
}

/**
 * Build the four graph definitions for one locale. Pure: the snapshot is only
 * read when `execute` runs, so a definition is just schema plus closures.
 */
export function coordinationGraphToolDefinitions(
  service: CoordinationToolService,
  locale: Locale = normaliseLocale(service.locale),
  options: CoordinationToolOptions = {},
): CoordinationToolDefinition[] {
  const copy = GRAPH_TOOL_COPY[normaliseLocale(locale)]
  return [
    fileTreeTool(service, copy.coordination_file, options),
    outlineTool(service, copy.coordination_outline, options),
    importationTool(service, copy.coordination_importation, options),
    exportationTool(service, copy.coordination_exportation, options),
  ]
}

/**
 * Register the four graph tools and return one disposer for the set.
 *
 * Kept separate from {@link registerCoordinationTools} so the documented
 * seven-tool file surface is unchanged: `src/index.ts` installs both sets in
 * the same effect and disposes them together.
 */
export function registerCoordinationGraphTools(
  registry: CoordinationToolRegistry,
  service: CoordinationToolService,
  locale: Locale = normaliseLocale(service.locale),
  options: CoordinationToolOptions = {},
): () => void {
  const disposers: Array<() => void> = []
  try {
    for (const definition of coordinationGraphToolDefinitions(service, locale, options)) {
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

function fileTreeTool(
  service: CoordinationToolService,
  copy: GraphToolCopy,
  options: CoordinationToolOptions,
): CoordinationToolDefinition<CoordinationFileValue | CoordinationGraphToolError> {
  return {
    name: 'coordination_file',
    description: copy.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: graphParameter(copy, 'path') },
        depth: { type: 'integer', description: graphParameter(copy, 'depth') },
        limit: { type: 'integer', description: graphParameter(copy, 'limit') },
      },
    },
    output: {
      schema: FILE_TOOL_SCHEMA,
      render: (_args, value) => renderJson(value, toolResultMaxBytes(service)),
    },
    async execute(rawArgs, exec) {
      try {
        const args = asArguments(rawArgs)
        const depth = boundedGraphInteger(args, 'depth', 2, MAX_FILE_TOOL_DEPTH)
        const limit = boundedGraphInteger(args, 'limit', DEFAULT_FILE_TOOL_ENTRIES, MAX_FILE_TOOL_ENTRIES)
        const requested = optionalGraphPath(args)
        // "." and "./" are how callers spell "the workspace root"; they mean
        // the same thing as omitting `path`, not an invalid argument.
        const rootAlias = requested !== undefined &&
          (requested.trim() === '.' || requested.trim() === './' || requested.trim() === '.\\')
        const scope = requested === undefined || rootAlias ? undefined : normaliseGraphPath(requested)
        if (requested !== undefined && !rootAlias && scope === undefined) {
          throw new InvalidArgumentError(
            'path must be a workspace-relative directory without absolute paths or ".."',
            { path: requested },
          )
        }
        const read = await graphReadOf(service, options, exec, scope)
        return fileTreeValue(read.snapshot, read.root, scope, depth, limit)
      } catch (error) {
        return graphToolFailure(error)
      }
    },
  }
}

function outlineTool(
  service: CoordinationToolService,
  copy: GraphToolCopy,
  options: CoordinationToolOptions,
): CoordinationToolDefinition<CoordinationOutlineValue | CoordinationGraphToolError> {
  return {
    name: 'coordination_outline',
    description: copy.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: graphParameter(copy, 'path') },
        limit: { type: 'integer', description: graphParameter(copy, 'limit') },
      },
    },
    output: {
      schema: OUTLINE_TOOL_SCHEMA,
      render: (_args, value) => renderJson(value, toolResultMaxBytes(service)),
    },
    async execute(rawArgs, exec) {
      try {
        const args = asArguments(rawArgs)
        const limit = boundedGraphInteger(args, 'limit', DEFAULT_OUTLINE_TOOL_NODES, MAX_OUTLINE_TOOL_NODES)
        const requested = optionalGraphPath(args)
        // Push the file scope into SQL so only that subtree is hydrated.
        const readScope = requested === undefined ? undefined : normaliseGraphPath(requested)
        const read = await graphReadOf(service, options, exec, readScope)
        const query = graphQueryOf(read.snapshot, read.root, requested === undefined ? 'workspace' : 'file')
        return structureOutlineValue(query, requested, limit)
      } catch (error) {
        return graphToolFailure(error)
      }
    },
  }
}

function importationTool(
  service: CoordinationToolService,
  copy: GraphToolCopy,
  options: CoordinationToolOptions,
): CoordinationToolDefinition<CoordinationImportationValue | CoordinationGraphToolError> {
  return {
    name: 'coordination_importation',
    description: copy.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: graphParameter(copy, 'path') },
        limit: { type: 'integer', description: graphParameter(copy, 'limit') },
      },
    },
    output: {
      schema: IMPORTATION_TOOL_SCHEMA,
      render: (_args, value) => renderJson(value, toolResultMaxBytes(service)),
    },
    async execute(rawArgs, exec) {
      try {
        const args = asArguments(rawArgs)
        const limit = boundedGraphInteger(args, 'limit', DEFAULT_RELATION_TOOL_ROWS, MAX_RELATION_TOOL_ROWS)
        const requested = optionalGraphPath(args)
        // Push the file scope into SQL so only that subtree is hydrated.
        const readScope = requested === undefined ? undefined : normaliseGraphPath(requested)
        const read = await graphReadOf(service, options, exec, readScope)
        const query = graphQueryOf(read.snapshot, read.root, requested === undefined ? 'workspace' : 'file')
        return importationValue(query, requested, limit)
      } catch (error) {
        return graphToolFailure(error)
      }
    },
  }
}

function exportationTool(
  service: CoordinationToolService,
  copy: GraphToolCopy,
  options: CoordinationToolOptions,
): CoordinationToolDefinition<CoordinationExportationValue | CoordinationGraphToolError> {
  return {
    name: 'coordination_exportation',
    description: copy.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: graphParameter(copy, 'path') },
        limit: { type: 'integer', description: graphParameter(copy, 'limit') },
      },
    },
    output: {
      schema: EXPORTATION_TOOL_SCHEMA,
      render: (_args, value) => renderJson(value, toolResultMaxBytes(service)),
    },
    async execute(rawArgs, exec) {
      try {
        const args = asArguments(rawArgs)
        const limit = boundedGraphInteger(args, 'limit', DEFAULT_RELATION_TOOL_ROWS, MAX_RELATION_TOOL_ROWS)
        const requested = optionalGraphPath(args)
        // Push the file scope into SQL so only that subtree is hydrated.
        const readScope = requested === undefined ? undefined : normaliseGraphPath(requested)
        const read = await graphReadOf(service, options, exec, readScope)
        const query = graphQueryOf(read.snapshot, read.root, requested === undefined ? 'workspace' : 'file')
        return exportationValue(query, requested, limit)
      } catch (error) {
        return graphToolFailure(error)
      }
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Workspace-graph tool internals
 * ------------------------------------------------------------------------- */

/** One resolved graph read: the workspace root plus its body-free snapshot. */
interface GraphRead {
  root: string
  snapshot: CoordinationGraphSnapshot
}

/**
 * Resolve the workspace root with the same request-scoped resolver the
 * `/graph/*` routes use. The registration-time Cordis context lets the resolver
 * ask the sandbox policy / working directory / session projection, so a model
 * call inside a session resolves that session's workspace instead of the
 * process cwd. An explicit `options.workspaceRoot` (tests, profiles) wins.
 */
async function graphWorkspaceRootOf(
  service: CoordinationToolService,
  options: CoordinationToolOptions,
  exec?: ToolExecution,
): Promise<string> {
  const session = toolSessionOf(exec)
  const resolver = createToolWorkspaceRootResolver(
    service,
    options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot },
    {
      ...(options.context === undefined ? {} : { context: options.context }),
      ...(session === undefined ? {} : { session }),
    },
  )
  return resolver.resolve()
}

/** The session that is executing one tool call, when the host supplied one. */
function toolSessionOf(exec?: ToolExecution): string | undefined {
  const id = exec?.agent?.id
  if (typeof id !== 'string') return undefined
  const trimmed = id.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Root for one tool call: the **calling session's** workspace, not the root
 * agent's.
 *
 * Graph routes always pass `?session=`, so they resolve per request; tools used
 * to fall back to `host.sandboxPolicy.resolve()` with no session, which returns
 * the process-wide default workspace (the desktop's last project). When a
 * session is known, resolve through the same request-scoped path the routes
 * use; an unresolvable session keeps the legacy fallback.
 */
async function toolRequestRoot(
  service: CoordinationToolService,
  options: CoordinationToolOptions,
  exec?: ToolExecution,
): Promise<string> {
  const session = toolSessionOf(exec)
  if (session !== undefined) {
    try {
      return await resolveToolWorkspaceRootForRequest(
        service,
        options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot },
        {
          session,
          ...(options.context === undefined ? {} : { context: options.context }),
        },
      )
    } catch {
      // A session whose cwd cannot be resolved falls back to the cached root.
    }
  }
  return resolveToolWorkspaceRoot(service, options)
}

/** Resolve the root and load one body-free snapshot for it. */
async function graphReadOf(
  service: CoordinationToolService,
  options: CoordinationToolOptions,
  exec?: ToolExecution,
  scope?: string,
): Promise<GraphRead> {
  const root = await graphWorkspaceRootOf(service, options, exec)
  return { root, snapshot: await graphSnapshotOf(service, options, root, scope) }
}

/**
 * Load one graph snapshot, or the injected stub.
 *
 * The default path is the read half of `GraphStore` only: no parse is
 * triggered, no snapshot is written and no file is opened. An absent/foreign
 * `db` (a narrow test facade) yields the empty graph, never a fabricated one.
 */
async function graphSnapshotOf(
  service: CoordinationToolService,
  options: CoordinationToolOptions,
  root: string,
  scope?: string,
): Promise<CoordinationGraphSnapshot> {
  if (options.graphSnapshot !== undefined) {
    const snapshot = await options.graphSnapshot(root)
    const snapshotRoot = nonEmptyRoot(snapshot.root) ?? root
    return {
      root: snapshotRoot,
      version: nonEmptyRoot(snapshot.version) ?? graphVersionOf(snapshot.nodes, snapshot.edges),
      nodes: snapshot.nodes,
      edges: snapshot.edges,
    }
  }
  const database = coordinationDatabaseOf(service.db)
  if (database === undefined) {
    return { root, version: graphVersionOf([], []), nodes: [], edges: [] }
  }
  const store = new GraphStore(database, { workspaceRoot: root })
  const nodes: GraphNode[] = store.loadNodes(scope).map((record) => ({
    handle: record.handle,
    kind: record.kind,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.label === undefined ? {} : { label: record.label }),
    ...(record.path === undefined ? {} : { path: record.path }),
    ...(record.lineStart === undefined ? {} : { line: record.lineStart }),
    ...(record.ordinal === undefined ? {} : { ordinal: record.ordinal }),
    ...(record.changed === undefined ? {} : { changed: record.changed }),
  }))
  const edges: GraphEdge[] = store.loadEdges().map((edge) => ({
    relation: edge.relation,
    from: edge.from,
    to: edge.to,
    changed: edge.changed,
  }))
  return { root, version: graphVersionOf(nodes, edges), nodes, edges }
}

/** One scoped graph query over a snapshot; the scope is part of the L2 key. */
function graphQueryOf(snapshot: CoordinationGraphSnapshot, fallbackRoot: string, scope: GraphScope): GraphQuery {
  return createGraphQuery({
    version: snapshot.version,
    scope,
    workspaceRoot: nonEmptyRoot(snapshot.root) ?? fallbackRoot,
    nodes: snapshot.nodes,
    edges: snapshot.edges,
  })
}

/**
 * Project the persisted tree into `coordination_file`'s value.
 *
 * Reuses `buildTree` on the nodes below the requested directory, locates that
 * directory in the built tree, then bounds its subtree by `depth`/`limit`.
 * `truncated` is true when the local depth/entry cap cut the result **or** the
 * graph tree itself was capped (`MAX_TREE_ENTRIES`/`MAX_TREE_DEPTH`), detected
 * by comparing the returned entry count with the count the snapshot implies.
 */
function fileTreeValue(
  snapshot: CoordinationGraphSnapshot,
  fallbackRoot: string,
  scope: string | undefined,
  depth: number,
  limit: number,
): CoordinationFileValue {
  const root = nonEmptyRoot(snapshot.root) ?? fallbackRoot
  const scopedNodes = treeNodesWithin(snapshot.nodes, scope)
  const tree = buildTree(scopedNodes, root)
  const entries = scopedTreeChildren(tree.entries, scope)
  const expected = expectedTreeEntryCount(scopedNodes, scope)
  const actual = countTreeEntries(entries)
  const bounded = boundTreeEntries(entries, depth, limit)
  return {
    root: tree.root,
    entries: bounded.entries,
    truncated: bounded.truncated || actual < expected,
  }
}

/** Nodes under one workspace-relative directory (the whole graph when absent). */
function treeNodesWithin(nodes: readonly GraphNode[], scope: string | undefined): GraphNode[] {
  if (scope === undefined) return [...nodes]
  const prefix = `${scope}/`
  return nodes.filter((node) => {
    if (node.path === undefined) return false
    const path = normaliseGraphPath(node.path)
    return path !== undefined && (path === scope || path.startsWith(prefix))
  })
}

/** Children of one directory in a tree built by `buildTree`. */
function scopedTreeChildren(entries: readonly TreeNode[], scope: string | undefined): TreeNode[] {
  if (scope === undefined) return [...entries]
  let level: readonly TreeNode[] = entries
  let prefix = ''
  for (const segment of scope.split('/')) {
    prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`
    const directory = level.find((entry) => entry.kind === 'directory' && entry.path === prefix)
    if (directory === undefined) {
      throw new InvalidArgumentError('path must name an indexed workspace directory', { path: scope })
    }
    level = directory.children ?? []
  }
  return [...level]
}

/**
 * Entry count the snapshot implies for one scope, capped by the builder's own
 * `MAX_TREE_DEPTH`. `buildTree` reports no truncation flag, so comparing this
 * count with the returned subtree detects an entry/depth cap honestly.
 */
function expectedTreeEntryCount(nodes: readonly GraphNode[], scope: string | undefined): number {
  const depthBase = scope === undefined ? 0 : scope.split('/').length
  const prefix = scope === undefined ? undefined : `${scope}/`
  const expected = new Set<string>()
  for (const node of nodes) {
    if (node.path === undefined) continue
    const path = normaliseGraphPath(node.path)
    if (path === undefined) continue
    if (prefix !== undefined && path !== scope && !path.startsWith(prefix)) continue
    const kind = node.kind.trim().toLowerCase()
    if (kind !== 'directory' && !FILE_TREE_NODE_KINDS.has(kind) && !isManifestPath(path)) continue
    const segments = path.split('/')
    const limit = Math.min(segments.length, MAX_TREE_DEPTH)
    for (let index = depthBase + 1; index <= limit; index += 1) {
      expected.add(segments.slice(0, index).join('/'))
    }
  }
  return expected.size
}

/** Number of directory/file entries in one built subtree. */
function countTreeEntries(entries: readonly TreeNode[]): number {
  let total = 0
  const stack: Array<readonly TreeNode[]> = [entries]
  while (stack.length > 0) {
    const level = stack.pop() as readonly TreeNode[]
    for (const entry of level) {
      total += 1
      if (entry.children !== undefined) stack.push(entry.children)
    }
  }
  return total
}

/**
 * Bound a built subtree by depth (root children = 1) and total entries.
 *
 * Ordering is `buildTree`'s (directories first, then code-point name), so the
 * cap always keeps the same deterministic prefix. Dropping a deeper child or
 * stopping at the entry budget sets `truncated`.
 */
function boundTreeEntries(
  entries: readonly TreeNode[],
  depth: number,
  limit: number,
): { entries: WorkspaceTreeEntry[]; truncated: boolean } {
  let budget = limit
  let truncated = false
  const take = (level: readonly TreeNode[], levelDepth: number): WorkspaceTreeEntry[] => {
    const kept: WorkspaceTreeEntry[] = []
    for (const entry of level) {
      if (budget <= 0) {
        truncated = true
        break
      }
      budget -= 1
      const value: WorkspaceTreeEntry = { path: entry.path, name: entry.name, kind: entry.kind }
      const children = entry.children ?? []
      if (children.length === 0) {
        kept.push(value)
        continue
      }
      if (levelDepth >= depth) {
        truncated = true
        kept.push(value)
        continue
      }
      const bounded = take(children, levelDepth + 1)
      if (bounded.length > 0) value.children = bounded
      kept.push(value)
    }
    return kept
  }
  return { entries: take(entries, 1), truncated }
}

/**
 * Project the structure-only outline.
 *
 * Uses `familyOf` (the same classifier as `/graph/outline`) with the
 * structure-only order in {@link STRUCTURE_KIND_ORDERS}. A file without any
 * structure node contributes no group; groups are path-sorted, and the node
 * budget applies across groups in that order.
 */
function structureOutlineValue(
  query: GraphQuery,
  requestPath: string | undefined,
  limit: number,
): CoordinationOutlineValue {
  if (requestPath !== undefined) {
    const path = normaliseGraphPath(requestPath)
    if (path === undefined) {
      throw new InvalidArgumentError('path must be a workspace-relative path without ".."', { path: requestPath })
    }
    if (!query.paths.includes(path)) throw new NotFoundError('file', path)
    const outline = structureOutlineOfPath(path, graphNodesOfPath(query.nodes, path))
    const nodes = outline.nodes.slice(0, limit)
    return {
      scope: 'file',
      path,
      family: outline.family,
      nodes,
      truncated: nodes.length < outline.nodes.length,
    }
  }

  const byPath = graphNodesByPath(query.nodes)
  const groups: CoordinationOutlineGroupValue[] = []
  for (const path of query.paths) {
    const outline = structureOutlineOfPath(path, byPath.get(path) ?? [])
    if (outline.nodes.length === 0) continue
    groups.push({ path, family: outline.family, nodes: outline.nodes })
  }
  const bounded: CoordinationOutlineGroupValue[] = []
  let remaining = limit
  let truncated = false
  for (const group of groups) {
    if (remaining <= 0) {
      truncated = true
      break
    }
    const nodes = group.nodes.slice(0, remaining)
    if (nodes.length < group.nodes.length) truncated = true
    bounded.push({ path: group.path, family: group.family, nodes })
    remaining -= nodes.length
  }
  return { scope: 'workspace', groups: bounded, truncated }
}

/** Group every path-bearing graph node by its normalized workspace path. */
function graphNodesByPath(nodes: readonly GraphNode[]): Map<string, GraphNode[]> {
  const byPath = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    if (node.path === undefined) continue
    const path = normaliseGraphPath(node.path)
    if (path === undefined) continue
    const list = byPath.get(path)
    if (list === undefined) byPath.set(path, [node])
    else list.push(node)
  }
  return byPath
}

/** All nodes of one already-normalized workspace path. */
function graphNodesOfPath(nodes: readonly GraphNode[], path: string): GraphNode[] {
  return nodes.filter((node) => node.path !== undefined && normaliseGraphPath(node.path) === path)
}

/** Structure family + depth-ordered nodes of one already-resolved path. */
function structureOutlineOfPath(
  path: string,
  fileNodes: readonly GraphNode[],
): { family: GraphFamily; nodes: OutlineNode[] } {
  const kinds = new Set(fileNodes.map((node) => node.kind.trim().toLowerCase()))
  const family = familyOf(path, kinds)
  if (family === 'unknown') return { family, nodes: [] }
  const depthOf = new Map(STRUCTURE_KIND_ORDERS[family].map((kind, index): [string, number] => [kind, index]))
  const nodes: OutlineNode[] = []
  for (const node of fileNodes) {
    const kind = node.kind.trim().toLowerCase()
    const depth = depthOf.get(kind)
    if (depth === undefined) continue
    nodes.push({
      handle: node.handle,
      kind: node.kind,
      name: node.name ?? node.label ?? '',
      depth,
      line: node.line ?? 0,
    })
  }
  nodes.sort(
    (left, right) =>
      left.line - right.line ||
      left.depth - right.depth ||
      compareGraphText(left.name, right.name) ||
      compareGraphText(left.handle, right.handle),
  )
  return { family, nodes }
}

/** Code-point ordering; locale-independent, so output is stable everywhere. */
function compareGraphText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Project the import relationships.
 *
 * `buildImports` is the route's own projection (deduplicated, source-ordered
 * and capped specifier lists). The tool then filters to rows that actually
 * import something, applies its row budget and adds the cycle flag derived from
 * the workspace `depends` graph.
 */
function importationValue(
  query: GraphQuery,
  requestPath: string | undefined,
  limit: number,
): CoordinationImportationValue {
  const view = buildImports(query, requestPath)
  const cyclic = cyclicFilePathsOf(query)
  if (requestPath !== undefined) {
    const row = view.rows[0]
    return {
      rows: row === undefined ? [] : [importationRowValue(row, cyclic)],
      truncated: false,
    }
  }
  const rows = view.rows.filter((row) => row.imported.length > 0)
  const bounded = rows.slice(0, limit)
  return {
    rows: bounded.map((row) => importationRowValue(row, cyclic)),
    truncated: bounded.length < rows.length || view.rows.length >= MAX_IMPORT_ROWS,
  }
}

/** Project the export relationships (the exportation mirror of the above). */
function exportationValue(
  query: GraphQuery,
  requestPath: string | undefined,
  limit: number,
): CoordinationExportationValue {
  const view = buildImports(query, requestPath)
  const cyclic = cyclicFilePathsOf(query)
  if (requestPath !== undefined) {
    const row = view.rows[0]
    return {
      rows: row === undefined ? [] : [exportationRowValue(row, cyclic)],
      truncated: false,
    }
  }
  const rows = view.rows.filter((row) => row.exported.length > 0)
  const bounded = rows.slice(0, limit)
  return {
    rows: bounded.map((row) => exportationRowValue(row, cyclic)),
    truncated: bounded.length < rows.length || view.rows.length >= MAX_IMPORT_ROWS,
  }
}

function importationRowValue(row: ImportRow, cyclic: ReadonlySet<string>): CoordinationImportationRow {
  return {
    path: row.path,
    imported: [...row.imported],
    ...(cyclic.has(row.path) ? { cyclic: true } : {}),
  }
}

function exportationRowValue(row: ImportRow, cyclic: ReadonlySet<string>): CoordinationExportationRow {
  return {
    path: row.path,
    exported: [...row.exported],
    ...(cyclic.has(row.path) ? { cyclic: true } : {}),
  }
}

/**
 * Files that participate in a `depends` cycle (SCC-derived).
 *
 * Iterative Kosaraju over the workspace-relative file dependency graph: a file
 * is cyclic when its strongly connected component has more than one vertex, or
 * when it declares a self-dependency. Iterative on purpose — a deep dependency
 * chain must not overflow the stack — and identical in rule to the
 * `cyclic` flag `/graph/dependencies` derives.
 */
function cyclicFilePathsOf(query: GraphQuery): ReadonlySet<string> {
  const adjacency = new Map<string, string[]>()
  const known = new Set<string>()
  for (const path of query.paths) {
    known.add(path)
    const deps = query.factsOf(path).deps
    if (deps.length === 0) continue
    adjacency.set(path, [...deps])
    for (const dependency of deps) known.add(dependency)
  }
  const nodes = [...known].sort()

  const color = new Map<string, 0 | 1 | 2>()
  const finish: string[] = []
  for (const start of nodes) {
    if (color.has(start)) continue
    color.set(start, 1)
    const stack: Array<{ node: string; index: number }> = [{ node: start, index: 0 }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { node: string; index: number }
      const neighbours = adjacency.get(frame.node) ?? []
      if (frame.index < neighbours.length) {
        const next = neighbours[frame.index] as string
        frame.index += 1
        if (!color.has(next)) {
          color.set(next, 1)
          stack.push({ node: next, index: 0 })
        }
        continue
      }
      color.set(frame.node, 2)
      finish.push(frame.node)
      stack.pop()
    }
  }

  const reverse = new Map<string, string[]>()
  for (const [from, targets] of adjacency) {
    for (const to of targets) {
      const list = reverse.get(to)
      if (list === undefined) reverse.set(to, [from])
      else list.push(from)
    }
  }

  const component = new Map<string, number>()
  const sizes: number[] = []
  for (let index = finish.length - 1; index >= 0; index -= 1) {
    const start = finish[index] as string
    if (component.has(start)) continue
    const identity = sizes.length
    let size = 0
    const stack = [start]
    component.set(start, identity)
    while (stack.length > 0) {
      const node = stack.pop() as string
      size += 1
      for (const previous of reverse.get(node) ?? []) {
        if (component.has(previous)) continue
        component.set(previous, identity)
        stack.push(previous)
      }
    }
    sizes.push(size)
  }

  const cyclic = new Set<string>()
  for (const [from, targets] of adjacency) {
    for (const to of targets) {
      if (from === to) {
        cyclic.add(from)
        continue
      }
      const identity = component.get(from)
      if (identity === undefined || identity !== component.get(to)) continue
      if ((sizes[identity] ?? 0) > 1) {
        cyclic.add(from)
        cyclic.add(to)
      }
    }
  }
  return cyclic
}

/** Read one non-empty path argument (normalization happens in the builder). */
function optionalGraphPath(args: Record<string, unknown>): string | undefined {
  const value = args.path
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError('path must be a non-empty workspace-relative string', { path: value })
  }
  return value.trim()
}

/** Read one bounded integer argument; an out-of-range value is INVALID_ARGUMENT. */
function boundedGraphInteger(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = args[name]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new InvalidArgumentError(`${name} must be an integer between 1 and ${maximum}`, { [name]: value })
  }
  return value
}

/** Parameter copy lookup; a missing entry is a copy bug, not user input. */
function graphParameter(copy: GraphToolCopy, name: string): string {
  const description = copy.parameters[name]
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`missing graph-tool parameter copy for "${name}"`)
  }
  return description
}

/**
 * Typed failure → tool value. Every user-input failure (bad/unknown/escaping
 * path, out-of-range budget) becomes `INVALID_ARGUMENT`; an unexpected internal
 * failure still throws so it is never disguised as user error.
 */
function graphToolFailure(error: unknown): CoordinationGraphToolError {
  if (error instanceof NotFoundError) {
    return {
      error: {
        code: 'INVALID_ARGUMENT',
        message: `${error.message}; the path must be an indexed workspace file`,
      },
    }
  }
  if (error instanceof InvalidArgumentError) {
    return { error: { code: 'INVALID_ARGUMENT', message: error.message } }
  }
  throw error
}

/* ------------------------------------------------------------------------- *
 * File-layer argument parsing
 * ------------------------------------------------------------------------- */

function optionalText(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidArgumentError(`${name} must be a non-empty string`, { [name]: value })
  }
  return value
}

function optionalToken(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError(`${name} must be a non-empty string`, { [name]: value })
  }
  return value.trim()
}

function requiredToken(args: Record<string, unknown>, name: string): string {
  const value = optionalToken(args, name)
  if (value === undefined) throw new InvalidArgumentError(`${name} is required`)
  return value
}

function optionalStringList(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new InvalidArgumentError(`${name} must be an array of non-empty strings`, { [name]: value })
  }
  return value as string[]
}

function nonNegativeInteger(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidArgumentError(`${name} must be a non-negative integer`, { [name]: value })
  }
  return value
}

function requiredAction(args: Record<string, unknown>): ChainAction {
  const value = requiredToken(args, 'action')
  if (!isOneOf(value, CHAIN_ACTIONS)) {
    throw new InvalidArgumentError('unknown chain action', { action: value, allowed: [...CHAIN_ACTIONS] })
  }
  return value
}

function requiredMode(args: Record<string, unknown>): 'bytes' | 'lines' {
  const value = requiredToken(args, 'mode')
  if (value !== 'bytes' && value !== 'lines') {
    throw new InvalidArgumentError('mode must be "bytes" or "lines"', { mode: value })
  }
  return value
}

/* ------------------------------------------------------------------------- *
 * File-layer copy helpers (the copy itself lives in the shared `fileTools` table)
 * ------------------------------------------------------------------------- */

function fileParameter(copy: ToolCopy, name: string): string {
  const description = copy.parameters[name]
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`missing file-tool parameter copy for "${name}"`)
  }
  return description
}

function fileStringParameter(copy: ToolCopy, name: string): Record<string, unknown> {
  return { type: 'string', description: fileParameter(copy, name) }
}

/* ------------------------------------------------------------------------- *
 * File-layer output schemas (the registry's enforced subset: no $ref)
 * ------------------------------------------------------------------------- */

const NODE_CARD_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: ['identity', 'name', 'kind', 'summary', 'brief'],
  properties: {
    identity: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string' },
    summary: { type: 'string' },
    brief: { type: 'string' },
    reference: { type: 'object', additionalProperties: true },
    path: { type: 'string' },
    byteStart: { type: 'number' },
    byteEnd: { type: 'number' },
    lineStart: { type: 'number' },
    lineEnd: { type: 'number' },
    fingerprint: { type: 'string' },
    charset: { type: 'string' },
    status: { type: 'string' },
    usage: { type: 'string' },
    purpose: { type: 'string' },
    domain: { type: 'object', additionalProperties: true },
  },
}

const REFERENCE_VIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: ['kind', 'specifier', 'external', 'typeOnly', 'classification'],
  properties: {
    kind: { type: 'string' },
    specifier: { type: 'string' },
    external: { type: 'boolean' },
    typeOnly: { type: 'boolean' },
    classification: { type: 'string' },
    resolved: { type: 'string' },
    byteStart: { type: 'number' },
    byteEnd: { type: 'number' },
    lineStart: { type: 'number' },
    lineEnd: { type: 'number' },
  },
}

const DIAGNOSTIC_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: ['code', 'message', 'severity'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    severity: { type: 'string' },
    line: { type: 'number' },
    column: { type: 'number' },
  },
}

const PARSE_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'parserId', 'charset', 'bomBytes', 'truncated', 'status', 'tokens', 'size', 'cached',
    'references', 'diagnostics', 'cards', 'dependencies', 'counts',
  ],
  properties: {
    path: { type: 'string' },
    parserId: { type: 'string' },
    charset: { type: 'string' },
    bomBytes: { type: 'number' },
    truncated: { type: 'boolean' },
    status: { type: 'string' },
    tokens: { type: 'number' },
    size: { type: 'number' },
    cached: { type: 'boolean' },
    document: { type: 'object', additionalProperties: true },
    references: { type: 'array', items: REFERENCE_VIEW_SCHEMA },
    referencesTruncated: { type: 'boolean' },
    diagnostics: { type: 'array', items: DIAGNOSTIC_SCHEMA },
    diagnosticsTruncated: { type: 'boolean' },
    cards: { type: 'array', items: NODE_CARD_SCHEMA },
    cardsTruncated: { type: 'boolean' },
    dependencies: { type: 'object', additionalProperties: true },
    counts: { type: 'object', additionalProperties: true },
  },
}

const DESCRIBE_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['handle', 'card', 'status', 'brief', 'fields', 'requested', 'unverifiable'],
  properties: {
    handle: { type: 'string' },
    card: NODE_CARD_SCHEMA,
    status: { type: 'string' },
    brief: { type: 'string' },
    reference: { type: 'object', additionalProperties: true },
    fields: { type: 'object', additionalProperties: true },
    requested: { type: 'object', additionalProperties: true },
    unverifiable: { type: 'array', items: { type: 'string' } },
  },
}

const CHAIN_LINK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: ['handle', 'from', 'to', 'relation', 'direction', 'status', 'depth'],
  properties: {
    handle: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    relation: { type: 'string' },
    direction: { type: 'string' },
    status: { type: 'string' },
    depth: { type: 'number' },
    evidenceHandle: { type: 'string' },
    baselineVersion: { type: 'string' },
    kind: { type: 'string' },
    name: { type: 'string' },
    label: { type: 'string' },
    title: { type: 'string' },
    brief: { type: 'string' },
    path: { type: 'string' },
    byteStart: { type: 'number' },
    byteEnd: { type: 'number' },
    lineStart: { type: 'number' },
    lineEnd: { type: 'number' },
    fingerprint: { type: 'string' },
    charset: { type: 'string' },
    created: { type: 'number' },
    changed: { type: 'number' },
  },
}

const CHAIN_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['root', 'links', 'depth', 'truncated', 'version', 'computedAt', 'counts'],
  properties: {
    root: { type: 'string' },
    links: { type: 'array', items: CHAIN_LINK_SCHEMA },
    depth: { type: 'number' },
    truncated: { type: 'boolean' },
    cycle: { type: 'array', items: { type: 'string' } },
    version: { type: 'string' },
    computedAt: { type: 'number' },
    relation: { type: 'string' },
    found: { type: 'boolean' },
    counts: { type: 'object', additionalProperties: true },
  },
}

const READ_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'path', 'mode', 'requested', 'returned', 'content', 'truncated', 'charset', 'bom',
    'bomBytes', 'hash', 'fileBytes', 'mtime', 'byteRange',
  ],
  properties: {
    path: { type: 'string' },
    mode: { type: 'string' },
    requested: { type: 'object', additionalProperties: true },
    returned: { type: 'object', additionalProperties: true },
    content: { type: 'string' },
    truncated: { type: 'boolean' },
    charset: { type: 'string' },
    bom: { type: 'boolean' },
    bomBytes: { type: 'number' },
    hash: { type: 'string' },
    fileBytes: { type: 'number' },
    mtime: { type: 'number' },
    byteRange: { type: 'object', additionalProperties: true },
    lineRange: { type: 'object', additionalProperties: true },
    nextStart: { type: 'number' },
    nextLine: { type: 'number' },
  },
}

/* ------------------------------------------------------------------------- *
 * Workspace-graph output schemas (the registry's enforced subset: no $ref)
 *
 * Every graph tool is a `oneOf` of its success value and the typed
 * `INVALID_ARGUMENT` value, because invalid input must come back as data
 * instead of a thrown tool error. The tree entry schema is depth-bounded:
 * `coordination_file` never returns deeper than four levels, so no recursive
 * schema (which the enforced subset cannot express) is needed.
 * ------------------------------------------------------------------------- */

const GRAPH_TOOL_ERROR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', const: 'INVALID_ARGUMENT' },
        message: { type: 'string' },
      },
    },
  },
}

const GRAPH_FAMILY_ENUM: readonly string[] = ['book', 'article', 'tex', 'project', 'document', 'unknown']

const FILE_TREE_LEAF_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'name', 'kind'],
  properties: {
    path: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string', enum: ['directory', 'file'] },
  },
}

/** Deepest entry (depth 4) up to the root entry (depth 1), built bottom-up. */
const FILE_TREE_ENTRY_SCHEMA: Record<string, unknown> = (() => {
  let schema = FILE_TREE_LEAF_SCHEMA
  for (let level = 0; level < 3; level += 1) {
    schema = {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'name', 'kind'],
      properties: {
        path: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string', enum: ['directory', 'file'] },
        children: { type: 'array', items: schema },
      },
    }
  }
  return schema
})()

const FILE_TOOL_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['root', 'entries', 'truncated'],
      properties: {
        root: { type: 'string' },
        entries: { type: 'array', items: FILE_TREE_ENTRY_SCHEMA },
        truncated: { type: 'boolean' },
      },
    },
    GRAPH_TOOL_ERROR_SCHEMA,
  ],
}

const STRUCTURE_OUTLINE_NODE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['handle', 'kind', 'name', 'depth', 'line'],
  properties: {
    handle: { type: 'string' },
    kind: { type: 'string' },
    name: { type: 'string' },
    depth: { type: 'number' },
    line: { type: 'number' },
  },
}

const STRUCTURE_OUTLINE_GROUP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'family', 'nodes'],
  properties: {
    path: { type: 'string' },
    family: { type: 'string', enum: GRAPH_FAMILY_ENUM },
    nodes: { type: 'array', items: STRUCTURE_OUTLINE_NODE_SCHEMA },
  },
}

const OUTLINE_TOOL_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['scope', 'path', 'family', 'nodes', 'truncated'],
      properties: {
        scope: { type: 'string', const: 'file' },
        path: { type: 'string' },
        family: { type: 'string', enum: GRAPH_FAMILY_ENUM },
        nodes: { type: 'array', items: STRUCTURE_OUTLINE_NODE_SCHEMA },
        truncated: { type: 'boolean' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['scope', 'groups', 'truncated'],
      properties: {
        scope: { type: 'string', const: 'workspace' },
        groups: { type: 'array', items: STRUCTURE_OUTLINE_GROUP_SCHEMA },
        truncated: { type: 'boolean' },
      },
    },
    GRAPH_TOOL_ERROR_SCHEMA,
  ],
}

const IMPORTATION_ROW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'imported'],
  properties: {
    path: { type: 'string' },
    imported: { type: 'array', items: { type: 'string' } },
    cyclic: { type: 'boolean' },
  },
}

const EXPORTATION_ROW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'exported'],
  properties: {
    path: { type: 'string' },
    exported: { type: 'array', items: { type: 'string' } },
    cyclic: { type: 'boolean' },
  },
}

const IMPORTATION_TOOL_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['rows', 'truncated'],
      properties: {
        rows: { type: 'array', items: IMPORTATION_ROW_SCHEMA },
        truncated: { type: 'boolean' },
      },
    },
    GRAPH_TOOL_ERROR_SCHEMA,
  ],
}

const EXPORTATION_TOOL_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['rows', 'truncated'],
      properties: {
        rows: { type: 'array', items: EXPORTATION_ROW_SCHEMA },
        truncated: { type: 'boolean' },
      },
    },
    GRAPH_TOOL_ERROR_SCHEMA,
  ],
}







