/**
 * AMP v0.1 — Frame (注意帧) and its construction boundary.
 *
 * A frame is one immutable attention snapshot. Two fields carry the protocol's
 * point: every slot must say **why** it is attended to (A-1), and every
 * deliberate exclusion is recorded with a `revisit_if` trigger — "no classical
 * architecture records this".
 *
 * `frameFrom` is the only constructor. It:
 *  - accumulates every problem and throws one `BoundaryRejection`,
 *  - computes `digest` itself over the frame body (never trusts a supplied one),
 *  - caps slots at 9 (may lower, never raise),
 *  - returns exclusions beyond the cap as `deferred` instead of dropping them,
 *  - refuses refs that do not resolve in the supplied scope.
 *
 * Ported from `attention-manifest-protocol/src/{frame/frame,boundary/frame,boundary/refTable}.ts`.
 * `additionalProperties: false` is the schema rule: no field may be added here.
 */
import type { Budget, Confidence, Digest, Id, Ref, RefKind, Tier, Timestamp, Usage } from './types.js'
import { BudgetDimensions } from './types.js'
import { digestOf } from './canonical.js'
import { isId } from './ids.js'
import { BoundaryRejection } from './errors.js'

export type FrameMode = 'explore' | 'exploit' | 'triage' | 'reflect' | 'rest'

export type SlotRole =
  | 'goal'
  | 'question'
  | 'evidence'
  | 'concept'
  | 'process'
  | 'tool'
  | 'memory'
  | 'self'
  | 'other'
  | 'threat'
  | 'artifact'

export type IgnoredReason =
  | 'low_voi'
  | 'out_of_scope'
  | 'untrusted'
  | 'budget'
  | 'blocked'
  | 'habituated'
  | 'deferred'

export type ImpasseState =
  | 'TIE'
  | 'STUCK'
  | 'STALLED'
  | 'CONFLICT'
  | 'INFEASIBLE'
  | 'UNKNOWN'
  | 'UNVERIFIED'
  | 'DRIFT'
  | 'BUDGET'

/** Why something is being attended to — required, not decorative (A-1). */
export interface Slot {
  target: Ref
  role: SlotRole
  tier?: Tier
  salience: Confidence
  voi?: Confidence
  cost: Budget
  budget?: Budget
  why: string
  ttl_turns?: number
  state: 'active' | 'released' | 'evicted' | 'done'
}

/** Deliberate exclusion. The distinctive field: no classical architecture records this. */
export interface Ignored {
  target: Ref
  reason: IgnoredReason
  revisit_if: string
}

export interface FrameBudget {
  allocated: Budget
  spent: Usage
}

export interface Impasse {
  state: ImpasseState
  detail?: string
}

export interface Frame {
  amp: '0.1'
  kind: 'frame'
  id: Id
  agent: Id
  cycle: number
  ts: Timestamp
  parent?: Ref
  digest: Digest
  mode: FrameMode
  goal?: Ref
  /** At most 9 slots. Capacity is the point, not a limitation. */
  slots: Slot[]
  ignored?: Ignored[]
  budget: FrameBudget
  open_questions?: Ref[]
  impasse?: Impasse
  note?: string
}

/* ------------------------------------------------------------------------- *
 * Reference resolution
 * ------------------------------------------------------------------------- */

/** Where a reference is expected to resolve. */
export type RefScope = 'run' | 'ledger' | 'bundle'

/**
 * Kinds that name something outside the ledger. They still need a valid id and
 * a kind, but they cannot be required to resolve here: a human, an org or an
 * external entity lives in a directory the host owns, not in the run.
 */
const DefaultOpaqueKinds: readonly RefKind[] = ['human', 'org', 'entity', 'other']

const stripToolPrefix = (id: string): string => (id.startsWith('mcp.') ? id.slice(4) : id)

const canonicalRefId = (kind: RefKind, id: string): string =>
  `${kind}:${kind === 'tool' ? stripToolPrefix(id) : id}`

/**
 * Reference resolution for the construction boundary.
 *
 * A `Ref` is only a pointer. Until it is resolved against a scope, nothing
 * prevents it from naming an object that does not exist — which is how a frame
 * ends up citing a tool, concept or claim that the ledger never held.
 *
 * Canonicalisation: `tool` and `capability` share one namespace (`mcp.` is
 * transport detail, not identity), and `self` resolves to the scope's agent id.
 */
export class RefTable {
  readonly scope: RefScope
  readonly opaqueKinds: ReadonlySet<RefKind>
  private readonly entries: Map<string, unknown>

  constructor(scope: RefScope, agentId?: string, opaqueKinds: readonly RefKind[] = DefaultOpaqueKinds) {
    this.scope = scope
    this.opaqueKinds = new Set<RefKind>(opaqueKinds)
    this.entries = new Map<string, unknown>()
    if (agentId !== undefined) {
      this.entries.set(`agent:${agentId}`, { kind: 'self', id: agentId })
    }
  }

  static forScope(scope: RefScope, agentId?: string, opaqueKinds?: readonly RefKind[]): RefTable {
    return new RefTable(scope, agentId, opaqueKinds)
  }

  /**
   * Register an object under its reference key.
   *
   * @throws BoundaryRejection `invalid_id` when the id cannot be referenced,
   * `duplicate_ref` when the same key is registered twice.
   */
  add(kind: RefKind, id: Id, value: unknown): this {
    if (!isId(id)) {
      throw new BoundaryRejection('invalid_id', [`${kind}:${id} is not a valid AMP id`])
    }
    const key = canonicalRefId(kind, id)
    if (this.entries.has(key)) {
      throw new BoundaryRejection('duplicate_ref', [`${key} is already registered in scope ${this.scope}`])
    }
    this.entries.set(key, value)
    return this
  }

  resolve(ref: Ref): unknown | undefined {
    if (!isId(ref.id)) {
      return undefined
    }
    const direct = this.entries.get(canonicalRefId(ref.kind, ref.id))
    if (direct !== undefined) {
      return direct
    }
    if (ref.kind === 'tool') {
      return this.entries.get(`capability:${stripToolPrefix(ref.id)}`)
    }
    if (ref.kind === 'self') {
      return this.entries.get(`agent:${ref.id}`)
    }
    return undefined
  }

  /** Resolve or reject. The message names the scope so a host can tell the cases apart. */
  require(ref: Ref): unknown {
    const hit = this.resolve(ref)
    if (hit === undefined) {
      throw new BoundaryRejection('unresolvable_ref', [
        `${ref.kind}:${ref.id} is not present in scope ${this.scope}`,
      ])
    }
    return hit
  }

  has(ref: Ref): boolean {
    return this.resolve(ref) !== undefined
  }

  /**
   * Resolution verdict used by {@link frameFrom}.
   *
   * Opaque kinds pass on shape alone; every other kind must be present in the
   * scope. Returns a problem string instead of throwing so callers can report
   * every dangling reference at once.
   */
  check(ref: Ref): string | undefined {
    if (this.opaqueKinds.has(ref.kind)) {
      return undefined
    }
    if (this.resolve(ref) !== undefined) {
      return undefined
    }
    return `${ref.kind}:${ref.id} is not present in scope ${this.scope}`
  }

  get size(): number {
    return this.entries.size
  }
}

/* ------------------------------------------------------------------------- *
 * Construction boundary
 * ------------------------------------------------------------------------- */

/** Draft accepted by {@link frameFrom}; `digest` is computed here, never supplied. */
export interface FrameDraft {
  id: Id
  agent: Id
  cycle: number
  ts?: Timestamp
  parent?: Ref
  mode: FrameMode
  goal?: Ref
  slots: Slot[]
  ignored?: Ignored[]
  budget: FrameBudget
  open_questions?: Ref[]
  impasse?: Impasse
  note?: string
}

export interface FrameBoundaryOptions {
  /** May lower the schema ceiling of 9, never raise it. Defaults to 9. */
  maxSlots?: number
  /** Visible exclusions kept on the frame; the rest is returned as `deferred`. Defaults to 50. */
  maxIgnored?: number
  /** Clock for `ts` when the draft omits it. Hosts should pass their ledger clock. */
  now?: () => Timestamp
}

export interface FrameBoundaryResult {
  frame: Frame
  /** Exclusions beyond `maxIgnored`, in input order. Never silently dropped. */
  deferred: Ignored[]
}

const SchemaMaxSlots = 9
const DefaultMaxIgnored = 50

const FrameModes: readonly FrameMode[] = ['explore', 'exploit', 'triage', 'reflect', 'rest']
const SlotRoles: readonly Slot['role'][] = [
  'goal',
  'question',
  'evidence',
  'concept',
  'process',
  'tool',
  'memory',
  'self',
  'other',
  'threat',
  'artifact',
]
const SlotStates: readonly Slot['state'][] = ['active', 'released', 'evicted', 'done']
const IgnoredReasons: readonly Ignored['reason'][] = [
  'low_voi',
  'out_of_scope',
  'untrusted',
  'budget',
  'blocked',
  'habituated',
  'deferred',
]
const ImpasseStates: readonly Impasse['state'][] = [
  'TIE',
  'STUCK',
  'STALLED',
  'CONFLICT',
  'INFEASIBLE',
  'UNKNOWN',
  'UNVERIFIED',
  'DRIFT',
  'BUDGET',
]
const Tiers: readonly Tier[] = ['T0', 'T1', 'T2', 'T3', 'T4']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const checkBudget = (value: unknown, at: string, problems: string[]): void => {
  if (!isRecord(value)) {
    problems.push(`${at} must be an object`)
    return
  }
  for (const key of Object.keys(value)) {
    const amount = value[key]
    if (!(BudgetDimensions as readonly string[]).includes(key)) {
      problems.push(`${at}.${key} is not a budget dimension`)
      continue
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      problems.push(`${at}.${key} must be a non-negative finite number`)
      continue
    }
    if (key !== 'money' && !Number.isInteger(amount)) {
      problems.push(`${at}.${key} must be an integer`)
    }
  }
}

const checkRef = (value: unknown, refs: RefTable, at: string, problems: string[]): void => {
  if (!isRecord(value)) {
    problems.push(`${at} must be a Ref object`)
    return
  }
  if (typeof value.kind !== 'string' || !isId(value.id)) {
    problems.push(`${at} must have a string kind and a valid id`)
    return
  }
  if (!refs.has(value as unknown as Ref)) {
    const problem = refs.check(value as unknown as Ref)
    if (problem !== undefined) {
      problems.push(`${at} ${problem}`)
    }
  }
}

const checkSlot = (value: unknown, refs: RefTable, at: string, problems: string[]): void => {
  if (!isRecord(value)) {
    problems.push(`${at} must be an object`)
    return
  }
  checkRef(value.target, refs, `${at}.target`, problems)
  if (typeof value.role !== 'string' || !SlotRoles.includes(value.role as Slot['role'])) {
    problems.push(`${at}.role is not a slot role`)
  }
  const salience = value.salience
  if (typeof salience !== 'number' || salience < 0 || salience > 1) {
    problems.push(`${at}.salience must be in [0,1]`)
  }
  if (typeof value.why !== 'string' || value.why.trim().length === 0) {
    problems.push(`${at}.why is empty`)
  }
  checkBudget(value.cost, `${at}.cost`, problems)
  if (typeof value.state !== 'string' || !SlotStates.includes(value.state as Slot['state'])) {
    problems.push(`${at}.state is not a slot state`)
  }
  if (value.tier !== undefined && (typeof value.tier !== 'string' || !Tiers.includes(value.tier as Tier))) {
    problems.push(`${at}.tier is not a tier`)
  }
  if (value.voi !== undefined && (typeof value.voi !== 'number' || value.voi < 0 || value.voi > 1)) {
    problems.push(`${at}.voi must be in [0,1]`)
  }
  if (value.budget !== undefined) {
    checkBudget(value.budget, `${at}.budget`, problems)
  }
  if (
    value.ttl_turns !== undefined &&
    (typeof value.ttl_turns !== 'number' || !Number.isInteger(value.ttl_turns) || value.ttl_turns < 0)
  ) {
    problems.push(`${at}.ttl_turns must be a non-negative integer`)
  }
}

const checkIgnored = (value: unknown, refs: RefTable, at: string, problems: string[]): void => {
  if (!isRecord(value)) {
    problems.push(`${at} must be an object`)
    return
  }
  checkRef(value.target, refs, `${at}.target`, problems)
  if (typeof value.reason !== 'string' || !IgnoredReasons.includes(value.reason as Ignored['reason'])) {
    problems.push(`${at}.reason is not an ignored reason`)
  }
  if (typeof value.revisit_if !== 'string' || value.revisit_if.trim().length === 0) {
    problems.push(`${at}.revisit_if is empty`)
  }
}

const checkImpasse = (value: unknown, at: string, problems: string[]): void => {
  if (!isRecord(value)) {
    problems.push(`${at} must be an object`)
    return
  }
  if (typeof value.state !== 'string' || !ImpasseStates.includes(value.state as Impasse['state'])) {
    problems.push(`${at}.state is not an impasse state`)
  }
  if (value.detail !== undefined && typeof value.detail !== 'string') {
    problems.push(`${at}.detail must be a string`)
  }
}

/**
 * Validate a draft and return the only frame it permits.
 *
 * @throws BoundaryRejection `invalid_frame` with every problem found.
 */
export function frameFrom(
  draft: FrameDraft,
  refs: RefTable,
  options: FrameBoundaryOptions = {},
): FrameBoundaryResult {
  const problems: string[] = []

  if (!isId(draft.id)) {
    problems.push('id is not a valid AMP id')
  }
  if (!isId(draft.agent)) {
    problems.push('agent is not a valid AMP id')
  }
  if (!Number.isSafeInteger(draft.cycle) || draft.cycle < 0) {
    problems.push('cycle must be a non-negative integer')
  }
  if (!FrameModes.includes(draft.mode)) {
    problems.push('mode is not a frame mode')
  }

  const ts: Timestamp = draft.ts ?? (options.now ? options.now() : new Date().toISOString())
  if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) {
    problems.push('ts is not a date-time')
  }

  const requestedMaxSlots = options.maxSlots ?? SchemaMaxSlots
  if (!Number.isInteger(requestedMaxSlots) || requestedMaxSlots < 0 || requestedMaxSlots > SchemaMaxSlots) {
    problems.push(`maxSlots must be an integer in [0,${SchemaMaxSlots}]`)
  }
  const maxSlots = Math.min(Math.max(0, requestedMaxSlots), SchemaMaxSlots)

  const requestedMaxIgnored = options.maxIgnored ?? DefaultMaxIgnored
  if (!Number.isInteger(requestedMaxIgnored) || requestedMaxIgnored < 0) {
    problems.push('maxIgnored must be a non-negative integer')
  }
  const maxIgnored = Math.max(0, requestedMaxIgnored)

  if (!Array.isArray(draft.slots)) {
    problems.push('slots must be an array')
  } else {
    if (draft.slots.length > maxSlots) {
      problems.push(`slots has ${draft.slots.length} entries, max is ${maxSlots}`)
    }
    draft.slots.forEach((slot, index) => checkSlot(slot, refs, `slots[${index}]`, problems))
  }

  const declaredIgnored: unknown = draft.ignored
  const ignored: Ignored[] = Array.isArray(declaredIgnored) ? declaredIgnored : []
  if (declaredIgnored !== undefined && !Array.isArray(declaredIgnored)) {
    problems.push('ignored must be an array')
  }
  ignored.forEach((item, index) => checkIgnored(item, refs, `ignored[${index}]`, problems))

  const budgetValue: unknown = draft.budget
  if (!isRecord(budgetValue)) {
    problems.push('budget must be an object')
  } else {
    const allocated = budgetValue.allocated
    const spent = budgetValue.spent
    checkBudget(allocated, 'budget.allocated', problems)
    checkBudget(spent, 'budget.spent', problems)
    if (isRecord(allocated) && isRecord(spent)) {
      if (Object.keys(allocated).length === 0) {
        problems.push('budget.allocated must set at least one dimension')
      }
      for (const key of BudgetDimensions) {
        const limit = allocated[key]
        const used = spent[key]
        if (typeof limit === 'number' && typeof used === 'number' && used > limit) {
          problems.push(`budget.spent.${key} exceeds budget.allocated.${key}`)
        }
      }
    }
  }

  if (draft.parent !== undefined) {
    checkRef(draft.parent, refs, 'parent', problems)
  }
  if (draft.goal !== undefined) {
    checkRef(draft.goal, refs, 'goal', problems)
  }
  if (draft.open_questions !== undefined) {
    if (!Array.isArray(draft.open_questions)) {
      problems.push('open_questions must be an array')
    } else {
      draft.open_questions.forEach((ref, index) => checkRef(ref, refs, `open_questions[${index}]`, problems))
    }
  }
  if (draft.impasse !== undefined) {
    checkImpasse(draft.impasse, 'impasse', problems)
  }
  if (draft.note !== undefined && typeof draft.note !== 'string') {
    problems.push('note must be a string')
  }

  if (problems.length > 0) {
    throw new BoundaryRejection('invalid_frame', problems)
  }

  const visible = ignored.slice(0, maxIgnored)
  const deferred = ignored.slice(maxIgnored)
  let body: Omit<Frame, 'digest'> = {
    amp: '0.1',
    kind: 'frame',
    id: draft.id,
    agent: draft.agent,
    cycle: draft.cycle,
    ts,
    mode: draft.mode,
    slots: [...draft.slots],
    budget: { allocated: { ...draft.budget.allocated }, spent: { ...draft.budget.spent } },
  }
  if (draft.parent !== undefined) body = { ...body, parent: draft.parent }
  if (draft.goal !== undefined) body = { ...body, goal: draft.goal }
  if (visible.length > 0) body = { ...body, ignored: visible }
  if (draft.open_questions !== undefined) body = { ...body, open_questions: [...draft.open_questions] }
  if (draft.impasse !== undefined) body = { ...body, impasse: draft.impasse }
  if (draft.note !== undefined) body = { ...body, note: draft.note }

  const frame: Frame = { ...body, digest: digestOf(body) }
  return { frame, deferred }
}

/** Recomputes a persisted frame's digest; `false` means the row was rewritten. */
export function verifyFrameDigest(frame: Frame): boolean {
  const { digest, ...body } = frame
  return digestOf(body) === digest
}
