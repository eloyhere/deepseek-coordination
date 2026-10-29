/**
 * AMP conformance service: turns coordination state into protocol artifacts.
 *
 * The plugin keeps its relational domain model (sessions, turns, plans, scores);
 * this service is the only place where that state becomes AMP v0.1. It builds
 * three artifacts and never fabricates a fourth:
 *
 *  - **Manifest** — a signed self-declaration. Capability confidence and tier are
 *    derived from recorded receipts (M-1), never from configuration; calibration
 *    reports the worst error (`ece: 1`) while no receipt carries both a
 *    predicted and a realized VOI, and says so in `self.limits`.
 *  - **Frame** — one immutable attention snapshot per turn: at most five slots,
 *    each with a required `why` (A-1), and an explicit `ignored` list built from
 *    the scene policy knobs this host deliberately does not enforce. Excluding a
 *    knob is recorded with a `revisit_if` trigger instead of being silent.
 *  - **Receipt / Event** — the settlement objects. A turn closes with one
 *    `reflect` receipt whose `usage.ms` is the measured turn duration; each tool
 *    call closes with a `read`/`attend`/`act` receipt. Both are appended to the
 *    hash-chained ledger, so calibration has ground truth.
 *
 * Everything here is append-only: no method updates or deletes an artifact.
 */
import type { CoordinationConfig } from './config.js'
import type { CoordinationDatabase } from './database.js'
import type { Clock, HandleGenerator } from './handle.js'
import type { CoordinationEventBus } from './module.js'
import type {
  Interaction,
  Profession,
  Scene,
  SceneProfile,
  TurnStatus,
  Validation,
} from '../shared/enum.js'
import type {
  AmpEvent,
  AttentionRequest,
  Budget,
  Capability,
  Claim,
  EvidenceItem,
  Frame,
  FrameDraft,
  FrameMode,
  Goal,
  Ignored,
  InterruptClass,
  InterruptRecord,
  InterruptStatus,
  KeyPair,
  LedgerCheckpoint,
  LedgerSnapshot,
  Manifest,
  Plan,
  Receipt,
  ReceiptOp,
  Ref,
  Slot,
  SnapshotVerdict,
  UnknownItem,
} from '../protocol/index.js'
import {
  GENESIS,
  RefTable,
  buildAttentionRequest,
  buildInterruptRecord,
  canonical,
  deriveConfidence,
  digestOf,
  exportPrivateKey,
  exportPublicKey,
  frameFrom,
  generateSigningKey,
  idFrom,
  importPrivateKey,
  importPublicKey,
  interruptOutcome,
  isId,
  makeEvent,
  makeReceipt,
  sealCheckpoint,
  signManifest,
  validateClaim,
  validateGoal,
  validatePlan,
  verifyCheckpoint,
  verifyManifest,
  verifySnapshotAgainstCheckpoint,
} from '../protocol/index.js'
import { AmpStore, type StoredManifest } from './amp-store.js'
import { decodePlanStep } from './plan.js'
import type { CoordinationToolDefinition, CoordinationToolRegistry } from './tools.js'
import { jsonSafe } from '../shared/json-safe.js'

/** The agent id every artifact in this installation is issued under. */
export const AMP_AGENT_ID = 'deepseek-coordination'

/** Default tenant label for a single-host install. */
export const AMP_TENANT_DEFAULT = 'local'

/** The single human principal this install has; AMP refs need an id. */
export const AMP_HUMAN_ID = 'local-user'

/** How long one signed manifest stays valid before it is reissued. */
const ManifestTtlMs = 12 * 60 * 60 * 1000

/** How many recent receipts one manifest build aggregates. */
const ReceiptScan = 2000

/** A capability this host advertises; its tier/confidence are derived, not given. */
export interface AmpCapabilityInput {
  /** Model-facing tool name, e.g. `coordination_read`. */
  name: string
  label: string
  kind: Capability['kind']
}

/**
 * The eleven model-facing tools, declared once.
 *
 * The names must match `src/host/tools.ts`; `test/amp-protocol.test.ts` asserts
 * that every registered capability id is a legal AMP id and that the list has no
 * duplicates. A capability's `tier`/`confidence` are NOT written here — they are
 * derived from recorded receipts in {@link AmpService.manifest}.
 */
export const COORDINATION_CAPABILITIES: readonly AmpCapabilityInput[] = [
  { name: 'coordination_selection', label: 'read or patch the five composer choices', kind: 'tool' },
  { name: 'coordination_profession', label: 'read or set the locked profession', kind: 'tool' },
  { name: 'coordination_profession_lock', label: 'inspect the profession lock of a turn', kind: 'tool' },
  { name: 'coordination_parse', label: 'body-free parse projection of one file', kind: 'tool' },
  { name: 'coordination_describe', label: 'one node card and its requested fields', kind: 'tool' },
  { name: 'coordination_chain', label: 'bounded relationship projection', kind: 'tool' },
  { name: 'coordination_read', label: 'the single authorized content read', kind: 'tool' },
  { name: 'coordination_file', label: 'bounded workspace tree', kind: 'tool' },
  { name: 'coordination_outline', label: 'structure outline of a file or workspace', kind: 'tool' },
  { name: 'coordination_importation', label: 'import rows of a file or workspace', kind: 'tool' },
  { name: 'coordination_exportation', label: 'export rows of a file or workspace', kind: 'tool' },
]

/** Concrete facts behind the panel narrative; not a protocol object. */
export interface AmpStory {
  session: string
  turn: {
    ordinal: number
    status: string
    created: number
    profession: string
    interaction: string
    scene: string
    validation: string
  } | null
  /** The turn's own prompt, bounded; `truncated` says whether it was cut. */
  prompt: { excerpt: string; truncated: boolean } | null
  goal: { content: string } | null
  plan: { steps: Array<{ intent: string; expect: string }> } | null
  ignored: Array<{ target: string; reason: string; revisit: string }>
}
/** What a frame/receipt needs to know about one turn, without any content. */
export interface AmpTurnFacts {
  /** DSH session id (opaque, safe to store). */
  session: string
  /** Turn handle; the frame and receipt ids derive from it. */
  turn: string
  ordinal: number
  profession: Profession
  interaction: Interaction
  scene: Scene
  validation: Validation
  sceneProfile: SceneProfile
  created: number
  goal?: { handle: string }
  plan?: { handle: string }
  status: TurnStatus
  finished?: number
  diagnostics?: readonly { code: string }[]
  /** The comprehension row, when the turn ran one; the only claim source. */
  cognition?: AmpCognitionInput
  /** The plan row and its decoded steps; emitted only when every step has an expectation. */
  planFacts?: AmpPlanFacts
}

/**
 * The comprehension facts a claim can be built from.
 *
 * `prompt` is passed so the claim's evidence can be anchored **verbatim**: a
 * claim is promoted to T1 only when its statement appears literally in the
 * user's prompt, which is the one entailment this host can actually check. A
 * paraphrase stays T0. Nothing else is inferred.
 */
export interface AmpCognitionInput {
  /** Comprehension row handle; part of every claim's provenance. */
  id: string
  prompt: string
  intent: string
  requirement: string
  constraint: string
  assumption: string
  ambiguity: string
  confidence: number
  created: number
}

/** The four comprehension fields that become claims, in a stable order. */
export const CognitionFields = ['intent', 'requirement', 'constraint', 'assumption'] as const

/** One comprehension field name. */
export type CognitionField = (typeof CognitionFields)[number]

export interface AmpToolFacts {
  tool: string
  ok: boolean
  ms: number
}

/** What a takeover window announces when it opens. */
export interface AttentionRequestFacts {
  /** Takeover window handle. */
  handle: string
  /** DSH session id, when known. */
  session?: string
  type: 'approval' | 'question'
  /** The tool an approval is about, when the waterfall named one. */
  tool?: string
  requestedAt: number
  expiresAt?: number
}

/**
 * How a takeover window settled.
 *
 * `granted` is a one-time approval, `answered` a question the human answered,
 * `denied` an explicit rejection, `expired` no answer inside the window, and
 * `withdrawn` a cancel or an unload.
 */
export interface InterruptSettlementFacts extends AttentionRequestFacts {
  settledAt: number
  outcome: 'granted' | 'denied' | 'answered' | 'expired' | 'withdrawn'
}

/** One plan step as the plan module decoded it. */
export interface AmpPlanStep {
  /** The step's own text, used as the task intent. */
  statement: string
  /** Recorded acceptance; the plan is emitted only when every step has one. */
  expect: string
}

/** What the plan artifact needs from the relational plan/goal rows. */
export interface AmpPlanFacts {
  plan: {
    handle: string
    created: number
    /** Plugin plan status (`draft` … `abandoned`). */
    status: string
    /** The plan's constraint text; it becomes `abandon_if`. */
    constraint: string
  }
  /** The turn's goal row; without it a plan has no `goal` Ref and is not emitted. */
  goal?: { handle: string; content: string }
  steps: readonly AmpPlanStep[]
}

export interface AmpOptions {
  db: CoordinationDatabase
  config: CoordinationConfig
  handles: HandleGenerator
  clock: Clock
  agentId?: string
  tenant?: string
  capabilities?: readonly AmpCapabilityInput[]
  logger?: { warn(message: string): void; debug?(message: string): void }
}

/** Event types the service mirrors from the module bus into the ledger. */
const MirroredEvents = [
  'selection/changed',
  'selection/permission',
  'takeover/requested',
  'takeover/resolved',
  'takeover/pending',
  'compaction/auto',
  'pipeline/report',
] as const

const iso = (ms: number): string => new Date(ms).toISOString()

/**
 * Frame mode from the composer's interaction choice.
 *
 * The mapping is policy, not measurement: each interaction names the dominant
 * attention posture of the turn (reflect on affect, explore on analysis, exploit
 * on convergence, triage on orchestration).
 */
export function frameModeOf(interaction: Interaction): FrameMode {
  switch (interaction) {
    case 'emotion':
      return 'reflect'
    case 'think':
      return 'explore'
    case 'heuristic':
      return 'explore'
    case 'orchestrate':
      return 'triage'
    case 'converge':
    default:
      return 'exploit'
  }
}

/** Tool name → the AMP verb whose receipt settles it. */
export function receiptOpOf(tool: string): ReceiptOp {
  switch (tool) {
    case 'coordination_read':
    case 'coordination_parse':
    case 'coordination_describe':
    case 'coordination_chain':
    case 'coordination_file':
    case 'coordination_outline':
    case 'coordination_importation':
    case 'coordination_exportation':
      return 'read'
    case 'coordination_selection':
    case 'coordination_profession':
    case 'coordination_profession_lock':
      return 'attend'
    default:
      return 'act'
  }
}

/** Turn status → receipt outcome. A cancelled turn is blocked, not failed. */
export function outcomeOf(status: TurnStatus): Receipt['outcome'] {
  switch (status) {
    case 'done':
      return 'success'
    case 'failed':
      return 'failure'
    case 'cancelled':
      return 'blocked'
    default:
      return 'partial'
  }
}

/**
 * Stable AMP id for a tool.
 *
 * Tool names are already legal AMP ids (`_` is in the id character class), so
 * the name is used unchanged; only a name the grammar rejects is repaired.
 */
export function toolRefId(tool: string): string {
  return isId(tool) ? tool : idFrom(tool, 'tool')
}

/** Stable AMP id for one turn's frame. */
export function frameIdOf(turn: string): string {
  return `frame-${turn}`
}

/** Stable AMP id for one turn's receipt. */
export function receiptIdOf(turn: string): string {
  return `receipt-${turn}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const idLike = /^[A-Za-z0-9._:-]{1,64}$/

/**
 * Ledger projection of a bus payload.
 *
 * The ledger stores pointers and measured numbers, never prose: an id-shaped
 * string is kept, any other string becomes `[text omitted]`, deep objects are
 * capped. A governance event therefore cannot leak prompt or tool-output text
 * into the append-only chain by accident.
 */
export function ledgerProjection(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return idLike.test(value) ? value : '[text omitted]'
  if (depth >= 4) return '[depth]'
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => ledgerProjection(item, depth + 1))
  if (!isRecord(value)) return '[value]'
  const projected: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    projected[key] = ledgerProjection(item, depth + 1)
  }
  return projected
}

/**
 * The AMP-facing facade over the coordination database.
 *
 * Construct one per service; it is stateless apart from the cached signing key
 * and the cached manifest, and it never owns a timer.
 */
export class AmpService {
  readonly agentId: string
  readonly tenant: string
  readonly store: AmpStore
  private readonly db: CoordinationDatabase
  private readonly config: CoordinationConfig
  private readonly handles: HandleGenerator
  private readonly clock: Clock
  private readonly capabilities: readonly AmpCapabilityInput[]
  private readonly logger: AmpOptions['logger']
  private ready: Promise<void> | undefined
  private keyPair: KeyPair | undefined
  private publicKeyText = ''
  private manifestCache:
    | { manifest: Manifest; expiresMs: number; policyDigest: string }
    | undefined
  private readonly pending = new Set<Promise<unknown>>()

  constructor(options: AmpOptions) {
    this.config = options.config
    this.handles = options.handles
    this.clock = options.clock
    this.agentId = options.agentId ?? AMP_AGENT_ID
    this.tenant = options.tenant ?? AMP_TENANT_DEFAULT
    this.capabilities = options.capabilities ?? []
    this.logger = options.logger
    this.db = options.db
    this.store = new AmpStore(options.db)
  }

  /* --------------------------------------------------------------------- *
   * Identity
   * --------------------------------------------------------------------- */

  /** Loads or creates this installation's Ed25519 identity. Idempotent. */
  async ensure(): Promise<void> {
    if (this.ready === undefined) {
      this.ready = this.loadKey().catch((error: unknown) => {
        this.ready = undefined
        throw error
      })
    }
    await this.ready
  }

  private async loadKey(): Promise<void> {
    const stored = this.store.key()
    if (stored !== undefined) {
      const privateKey = await importPrivateKey(stored.privateKey)
      const publicKey = await importPublicKey(stored.publicKey)
      this.keyPair = { kid: stored.kid, publicKey, privateKey }
      this.publicKeyText = stored.publicKey
      return
    }

    // Generate first, then derive the kid from the public key, so two profiles
    // that copy the database never claim the same key id with different keys.
    const generated = await generateSigningKey('pending')
    const raw = await exportPublicKey(generated.publicKey)
    const kid = `ed25519-${digestOf(raw).slice(7, 23)}`
    const pkcs8 = await exportPrivateKey(generated.privateKey)
    this.store.saveKey({
      kid,
      alg: 'ed25519',
      publicKey: raw,
      privateKey: pkcs8,
      created: this.clock.now(),
    })
    this.keyPair = { kid, publicKey: generated.publicKey, privateKey: generated.privateKey }
    this.publicKeyText = raw
  }

  private key(): KeyPair {
    if (this.keyPair === undefined) {
      throw new Error('AMP identity is not ready; await ensure() first')
    }
    return this.keyPair
  }

  /** Public identity only: the private key never leaves the store. */
  async identity(): Promise<{ kid: string; alg: 'ed25519'; publicKey: string }> {
    await this.ensure()
    return { kid: this.key().kid, alg: 'ed25519', publicKey: this.publicKeyText }
  }

  /* --------------------------------------------------------------------- *
   * Manifest
   * --------------------------------------------------------------------- */

  /**
   * The current signed manifest, reissued when it expires or when the policy
   * digest changes. A manifest is never mutated; a new one is appended.
   */
  async manifest(): Promise<Manifest> {
    await this.ensure()
    const now = this.clock.now()
    const policyDigest = this.policyDigest()
    const cached = this.manifestCache
    if (cached !== undefined && cached.expiresMs > now && cached.policyDigest === policyDigest) {
      return cached.manifest
    }

    const receipts = this.receiptRows()
    const frameRef = this.latestFrameRef()
    const manifest = await signManifest(
      {
        amp: '0.1',
        kind: 'manifest',
        agent: { id: this.agentId, name: 'deepseek-coordination', role: 'coordination' },
        issued: iso(now),
        expires: iso(now + ManifestTtlMs),
        identity: {
          values: [
            { id: 'value-verifiable-amendment', statement: 'state changes are appended, never rewritten', weight: 1 },
            { id: 'value-explicit-exclusion', statement: 'a deliberate exclusion is recorded with its revisit trigger', weight: 0.9 },
            { id: 'value-no-content-in-ledger', statement: 'the ledger stores pointers and measurements, not prompt or file text', weight: 1 },
          ],
          constraints: [
            { id: 'constraint-host-only-approvals', statement: 'a permission preset is applied through the host, never persisted here', enforcement: 'hard' },
            { id: 'constraint-read-only-graph', statement: 'every workspace graph route is read-only', enforcement: 'hard' },
            { id: 'constraint-no-private-key-on-wire', statement: 'the private signing key never crosses the HTTP surface', enforcement: 'hard' },
          ],
        },
        capabilities: this.capabilitiesFrom(receipts),
        concepts: this.conceptRefs(),
        attention: {
          policy_digest: policyDigest,
          ...(frameRef === undefined ? {} : { frame: frameRef }),
          budget: this.attentionBudget(),
        },
        self: {
          calibration: this.calibration(receipts),
          limits: this.selfLimits(receipts),
        },
      },
      this.key(),
    )

    this.store.saveManifest(manifest, canonical(manifest))
    this.manifestCache = { manifest, expiresMs: now + ManifestTtlMs, policyDigest }
    return manifest
  }

  /** Recomputes the manifest digest and signature; `false` means it was altered. */
  async verifyManifestSignature(manifest: Manifest): Promise<{ ok: boolean; reasons: string[] }> {
    await this.ensure()
    return await verifyManifest(manifest, this.key().publicKey)
  }

  private policyDigest(): string {
    return digestOf({
      profession: this.config.profession,
      plan: this.config.plan,
      compaction: this.config.compaction,
      scenes: this.config.scenes,
      tools: this.config.tools,
      chains: this.config.chain,
    })
  }

  private attentionBudget(): Budget {
    // The task lease is the only attention budget this host actually enforces;
    // inventing token or interrupt budgets would make the manifest a wish.
    return { ms: Math.max(1, Math.trunc(this.config.defaultLease)) }
  }

  private conceptRefs(): Ref[] {
    return [
      { kind: 'concept', id: 'profession-decision', label: 'decision' },
      { kind: 'concept', id: 'profession-outcome', label: 'outcome' },
      { kind: 'concept', id: 'profession-resource', label: 'resource' },
      { kind: 'concept', id: 'profession-personnel', label: 'personnel' },
      { kind: 'concept', id: 'profession-qualification', label: 'qualification' },
      { kind: 'concept', id: 'profession-execution', label: 'execution' },
    ]
  }

  /**
   * Capability block derived from receipts (M-1).
   *
   * `tier` is T2 once a successful call observation exists (an observation
   * recorded by this agent), T0 otherwise. `confidence` is the Laplace-smoothed
   * success rate — a declared formula, so it can be recomputed from the ledger
   * rather than trusted.
   */
  private capabilitiesFrom(receipts: readonly Receipt[]): Capability[] {
    return this.capabilities.map((input) => {
      const refId = toolRefId(input.name)
      const calls = receipts.filter((receipt) => receipt.target?.kind === 'tool' && receipt.target.id === refId)
      const successes = calls.filter((receipt) => receipt.outcome === 'success')
      const confidence = (successes.length + 1) / (calls.length + 2)
      return {
        id: refId,
        label: input.label,
        kind: input.kind,
        confidence: Math.round(confidence * 1000) / 1000,
        tier: successes.length > 0 ? 'T2' : 'T0',
        cost: { calls: 1 },
        ...(input.kind === 'tool' ? { limits: ['read-only'] } : {}),
        evidence: successes.slice(0, 3).map((receipt) => ({ kind: 'receipt' as const, id: receipt.id })),
      }
    })
  }

  /**
   * Measured calibration.
   *
   * With no receipt that carries both a predicted and a realized VOI, nothing is
   * measured, and `ece: 1` is the honest upper bound (maximal error) rather than
   * `0`, which would claim perfect calibration from zero evidence.
   */
  private calibration(receipts: readonly Receipt[]): { ece: number; buckets: { lo: number; hi: number; predicted: number; observed: number; n: number }[] } {
    const pairs = receipts.filter(
      (receipt) => typeof receipt.predicted_voi === 'number' && typeof receipt.realized_voi === 'number',
    )
    if (pairs.length === 0) {
      return { ece: 1, buckets: [] }
    }
    const buckets = Array.from({ length: 10 }, (_unused, index) => ({
      lo: index / 10,
      hi: (index + 1) / 10,
      predicted: 0,
      observed: 0,
      n: 0,
    }))
    for (const receipt of pairs) {
      const predicted = receipt.predicted_voi as number
      const index = Math.min(9, Math.max(0, Math.floor(predicted * 10)))
      const bucket = buckets[index]
      bucket.predicted += predicted
      bucket.observed += receipt.realized_voi as number
      bucket.n += 1
    }
    let ece = 0
    const filled = buckets.filter((bucket) => bucket.n > 0)
    for (const bucket of filled) {
      bucket.predicted /= bucket.n
      bucket.observed /= bucket.n
      ece += (bucket.n / pairs.length) * Math.abs(bucket.observed - bucket.predicted)
    }
    return { ece: Math.round(ece * 1000) / 1000, buckets: filled }
  }

  private selfLimits(receipts: readonly Receipt[]): string[] {
    const limits: string[] = []
    const calibrated = receipts.some(
      (receipt) => typeof receipt.predicted_voi === 'number' && typeof receipt.realized_voi === 'number',
    )
    if (!calibrated) {
      limits.push('calibration is not measured: no receipt carries both predicted_voi and realized_voi')
    }
    limits.push('token usage is owned by the host and is not observable per turn; usage.ms is measured')
    return limits
  }

  /* --------------------------------------------------------------------- *
   * Frames
   * --------------------------------------------------------------------- */

  /**
   * Opens the frame for one turn.
   *
   * The ignored list is the point: every scene knob this host does not enforce
   * is named, with the condition that would bring it back.
   */
  async openTurn(facts: AmpTurnFacts): Promise<Frame> {
    await this.ensure()
    const frameId = frameIdOf(facts.turn)
    const refs = this.refTable(facts)
    const slots = this.slotsFor(facts, refs)
    const ignored = this.ignoredFor(facts)
    const draft: FrameDraft = {
      id: frameId,
      agent: this.agentId,
      cycle: Math.max(0, Math.trunc(facts.ordinal)),
      ts: iso(facts.created),
      mode: frameModeOf(facts.interaction),
      ...(facts.goal === undefined ? {} : { goal: { kind: 'goal' as const, id: goalIdOf(facts.goal.handle) } }),
      slots,
      ignored,
      budget: { allocated: this.attentionBudget(), spent: {} },
      note: `frame for turn ${facts.turn} in scene ${facts.scene}`,
    }
    const { frame } = frameFrom(draft, refs, { now: () => iso(this.clock.now()) })
    this.store.append('frame', frame, frame.ts)
    await this.event('turn.opened', {
      session: facts.session,
      turn: facts.turn,
      frame: frame.id,
      ordinal: facts.ordinal,
      scene: facts.scene,
      profession: facts.profession,
    })
    return frame
  }

  /** Latest frame for one session, found through the `turn.opened` events. */
  async latestFrameFor(session: string): Promise<Frame | undefined> {
    const events = this.store.recent('event', 400) as AmpEvent[]
    const frames = this.store.recent('frame', 400) as Frame[]
    const byId = new Map(frames.map((frame) => [frame.id, frame]))
    for (const event of events) {
      if (event.type !== 'turn.opened') continue
      const payload = event.payload
      if (payload === undefined || payload.session !== session) continue
      const frame = byId.get(String(payload.frame))
      if (frame !== undefined) return frame
    }
    return undefined
  }

  /**
   * Concrete facts for the panel narrative.
   *
   * The frame is deliberately content-free (ids and rationale only), so a
   * reader cannot tell what was actually asked or planned from it. This view is
   * not a protocol object: it joins the latest turn row with its prompt excerpt,
   * goal text and decoded plan steps, and the ignored list of the latest frame,
   * all read-only and bounded.
   */
  async storyFor(session: string): Promise<AmpStory> {
    const sessionRow = this.db.get<{ identity: number }>(
      'SELECT identity FROM session WHERE handle = ?',
      session,
    )
    const turn = sessionRow === undefined
      ? undefined
      : this.db.get<{
        ordinal: number
        status: string
        created: number
        profession: string
        interaction: string
        scene: string
        validation: string
        prompt: number | null
        goal: number | null
        plan: number | null
      }>(
        'SELECT ordinal, status, created, profession, interaction, scene, validation, prompt, goal, plan FROM turn WHERE session = ? ORDER BY ordinal DESC LIMIT 1',
        sessionRow.identity,
      )
    if (turn === undefined) {
      return { session, turn: null, prompt: null, goal: null, plan: null, ignored: [] }
    }

    const promptRow = turn.prompt === null
      ? undefined
      : this.db.get<{ content: string }>('SELECT content FROM prompt WHERE identity = ?', turn.prompt)
    const goalRow = turn.goal === null
      ? undefined
      : this.db.get<{ content: string }>('SELECT content FROM goal WHERE identity = ?', turn.goal)
    const planRow = turn.plan === null
      ? undefined
      : this.db.get<{ step: string }>('SELECT step FROM plan WHERE identity = ?', turn.plan)
    const parsed = planRow === undefined ? undefined : decodePlanStep(planRow.step)

    const frame = await this.latestFrameFor(session)
    return {
      session,
      turn: {
        ordinal: turn.ordinal,
        status: turn.status,
        created: turn.created,
        profession: turn.profession,
        interaction: turn.interaction,
        scene: turn.scene,
        validation: turn.validation,
      },
      prompt: promptRow === undefined ? null : promptExcerpt(promptRow.content),
      goal: goalRow === undefined ? null : { content: goalRow.content.trim().slice(0, 800) },
      plan: parsed === undefined
        ? null
        : {
          steps: [
            ...parsed.steps.map((step) => ({ intent: step.step.trim(), expect: (step.acceptance ?? '').trim() })),
            ...parsed.drafts.map((draft) => ({ intent: draft.task.trim(), expect: draft.acceptance.trim() })),
          ].filter((step) => step.intent.length > 0).slice(0, 12),
        },
      ignored: (frame?.ignored ?? []).map((item) => ({
        target: `${item.target.kind}:${item.target.id}`,
        reason: item.reason,
        revisit: item.revisit_if,
      })),
    }
  }


  private refTable(facts: AmpTurnFacts): RefTable {
    const refs = RefTable.forScope('run', this.agentId)
    refs.add('task', facts.turn, { kind: 'task', id: facts.turn })
    refs.add('memory', promptIdOf(facts.turn), { kind: 'memory', id: promptIdOf(facts.turn) })
    refs.add('concept', professionIdOf(facts.profession), { profession: facts.profession })
    refs.add('concept', sceneIdOf(facts.scene), { scene: facts.scene })
    refs.add('concept', interactionIdOf(facts.interaction), { interaction: facts.interaction })
    refs.add('concept', validationIdOf(facts.validation), { validation: facts.validation })
    for (const knob of PolicyKnobs) {
      refs.add('concept', knob, { policy: knob })
    }
    if (facts.goal !== undefined) {
      refs.add('goal', goalIdOf(facts.goal.handle), { goal: facts.goal.handle })
    }
    if (facts.plan !== undefined) {
      refs.add('plan', planIdOf(facts.plan.handle), { plan: facts.plan.handle })
    }
    return refs
  }

  private slotsFor(facts: AmpTurnFacts, refs: RefTable): Slot[] {
    const zero = { tokens: 0 }
    const slots: Slot[] = []
    if (facts.goal !== undefined) {
      slots.push({
        target: { kind: 'goal', id: goalIdOf(facts.goal.handle) },
        role: 'goal',
        salience: 1,
        cost: zero,
        why: 'the goal row attached to this turn is the operative objective',
        state: 'active',
      })
    }
    slots.push({
      target: { kind: 'memory', id: promptIdOf(facts.turn) },
      role: 'question',
      salience: 0.95,
      cost: zero,
      why: 'the user prompt for this turn is the request being served',
      state: 'active',
    })
    slots.push({
      target: { kind: 'task', id: facts.turn },
      role: 'process',
      salience: 0.9,
      cost: zero,
      why: `turn ${facts.ordinal} is the task this frame allocates attention to`,
      state: 'active',
    })
    slots.push({
      target: { kind: 'concept', id: professionIdOf(facts.profession) },
      role: 'concept',
      salience: 0.8,
      cost: zero,
      why: `the locked profession "${facts.profession}" decides which checks this task must pass`,
      state: 'active',
    })
    slots.push({
      target: { kind: 'concept', id: interactionIdOf(facts.interaction) },
      role: 'concept',
      salience: 0.6,
      cost: zero,
      why: `interaction "${facts.interaction}" shapes how the response is delivered`,
      state: 'active',
    })
    if (facts.plan !== undefined) {
      slots.push({
        target: { kind: 'plan', id: planIdOf(facts.plan.handle) },
        role: 'artifact',
        salience: 0.7,
        cost: zero,
        why: 'the plan row carries the steps this turn intends to execute',
        state: 'active',
      })
    }
    // Every target must resolve; `refs` was built for exactly these slots.
    for (const slot of slots) {
      if (!refs.has(slot.target)) {
        throw new Error(`frame slot target ${slot.target.kind}:${slot.target.id} was not registered`)
      }
    }
    return slots
  }

  /**
   * Deliberate exclusions, derived from the resolved scene policy.
   *
   * These are the same knobs `TurnPipeline` reports as deferred; moving them
   * onto the frame means a reader of the ledger sees them *before* the turn, not
   * only inside an in-memory report.
   */
  private ignoredFor(facts: AmpTurnFacts): Ignored[] {
    const profile = facts.sceneProfile
    const ignored: Ignored[] = [
      {
        target: { kind: 'concept', id: 'policy-max-iteration' },
        reason: 'blocked',
        revisit_if: 'a loop driver consumes scene.maxIteration',
      },
      {
        target: { kind: 'concept', id: 'policy-allow-bash' },
        reason: 'out_of_scope',
        revisit_if: 'the host exposes a per-turn bash permission port',
      },
    ]
    if (!profile.allowWeb) {
      ignored.push({
        target: { kind: 'concept', id: 'policy-allow-web' },
        reason: 'out_of_scope',
        revisit_if: 'the scene or config allows web search again',
      })
    }
    return ignored
  }

  /* --------------------------------------------------------------------- *
   * Settlement
   * --------------------------------------------------------------------- */

  /** Closes a turn with one `reflect` receipt and one `turn.closed` event. */
  async closeTurn(facts: AmpTurnFacts): Promise<Receipt> {
    await this.ensure()
    const at = iso(facts.finished ?? this.clock.now())
    const elapsed =
      facts.finished === undefined
        ? undefined
        : Math.max(0, Math.trunc(facts.finished - facts.created))
    const receipt = makeReceipt({
      id: receiptIdOf(facts.turn),
      op: 'reflect',
      outcome: outcomeOf(facts.status),
      at,
      target: { kind: 'frame', id: frameIdOf(facts.turn) },
      ...(elapsed === undefined ? {} : { ms: elapsed }),
      usage: elapsed === undefined ? {} : { ms: elapsed },
      note: `turn ${facts.turn} closed as ${facts.status}${
        facts.diagnostics === undefined || facts.diagnostics.length === 0
          ? ''
          : ` (${facts.diagnostics.map((item) => item.code).join(', ')})`
      }`,
    })
    this.store.append('receipt', receipt, at)
    await this.event('turn.closed', {
      session: facts.session,
      turn: facts.turn,
      receipt: receipt.id,
      status: facts.status,
      outcome: receipt.outcome,
    })
    if (facts.cognition !== undefined) {
      await this.recordCognition(facts)
    }
    if (facts.planFacts !== undefined) {
      await this.recordPlan(facts.planFacts)
    }
    return receipt
  }

  /**
   * Turns one comprehension row into warrant-validated claims and unknowns.
   *
   * The rule that keeps this honest: a claim is promoted to `T1` only when its
   * statement appears **verbatim** in the user's prompt, and the evidence item
   * quotes that anchor with a digest. A paraphrase stays `T0` with no evidence,
   * because this host cannot check an entailment it did not observe. Every claim
   * is passed through `validateClaim`; an invalid one is dropped and logged, not
   * stored.
   */
  private async recordCognition(facts: AmpTurnFacts): Promise<void> {
    const cognition = facts.cognition
    if (cognition === undefined) return
    const at = iso(cognition.created)
    const claims: string[] = []

    for (const field of CognitionFields) {
      const claim = buildClaim(facts, cognition, field, at)
      if (claim === undefined) continue
      this.store.append('claim', claim, claim.created)
      claims.push(claim.id)
    }

    const unknown = buildUnknown(facts, cognition, at)
    if (unknown !== undefined) {
      this.store.append('unknown', unknown, unknown.since)
    }

    if (claims.length === 0 && unknown === undefined) return
    await this.event('cognition.recorded', {
      turn: facts.turn,
      comprehension: cognition.id,
      claims,
      ...(unknown === undefined ? {} : { unknown: unknown.id }),
    })
  }

  /**
   * Emits the `Goal` + `Plan` pair, but only when the plan is actually
   * monitorable.
   *
   * The gate is the protocol's rule: every task needs an `expect`, a plan needs
   * `abandon_if`, and a goal needs at least one observable success criterion.
   * This host can only satisfy those from **recorded acceptance** on each plan
   * step and the plan's own constraint text; when either is missing the pair is
   * not emitted and a `plan.deferred` event names the gap instead. That is the
   * difference between "no plan artifact" and "a plan artifact nobody can check".
   */
  private async recordPlan(facts: AmpPlanFacts): Promise<void> {
    const at = iso(facts.plan.created)
    const goal = facts.goal
    const steps = facts.steps
    const reason = planDeferReason(facts)
    if (reason !== undefined || goal === undefined) {
      await this.event('plan.deferred', {
        plan: facts.plan.handle,
        reason: reason ?? 'missing-goal',
        steps: steps.length,
      })
      return
    }

    const goalId = goalIdOf(goal.handle)
    const planId = planIdOf(facts.plan.handle)
    const criteria = steps.map((step, index) => ({
      id: idFrom(`${facts.plan.handle}-${index}`, 'criterion'),
      statement: collapseWhitespace(step.expect, 500),
      check: collapseWhitespace(step.expect, 500),
      kind: 'assert' as const,
    }))
    const goalObject: Goal = {
      amp: '0.1',
      kind: 'goal',
      id: goalId,
      statement: collapseWhitespace(goal.content, 1000),
      success: criteria,
      // No ranking exists in this plugin: one active goal, neutral value.
      value: 0.5,
      priority: 1,
      horizon: 'task',
    }
    const planObject: Plan = {
      amp: '0.1',
      kind: 'plan',
      id: planId,
      goal: { kind: 'goal', id: goalId },
      tasks: steps.map((step, index) => ({
        id: idFrom(`${facts.plan.handle}-${index}`, 'plan-task'),
        intent: collapseWhitespace(step.statement, 500),
        actor: 'self',
        pre: [],
        expect: {
          observation: collapseWhitespace(step.expect, 500),
          check: collapseWhitespace(step.expect, 500),
        },
        // The plugin has no per-step risk classification; 1 is the
        // conservative "undoable with a clear reversal" default.
        irreversibility: 1,
        status: planTaskStatus(facts.plan.status),
      })),
      edges: steps.slice(1).map((_step, index) => [
        idFrom(`${facts.plan.handle}-${index}`, 'plan-task'),
        idFrom(`${facts.plan.handle}-${index + 1}`, 'plan-task'),
      ]),
      commitment_window: 1,
      budget: this.attentionBudget(),
      abandon_if: [
        {
          id: idFrom(facts.plan.handle, 'abandon'),
          statement: collapseWhitespace(facts.plan.constraint, 500),
          check: collapseWhitespace(facts.plan.constraint, 500),
          kind: 'assert',
        },
      ],
      status: planStatusOf(facts.plan.status),
      created: at,
    }

    const goalProblems = validateGoal(goalObject)
    const planProblems = validatePlan(planObject)
    if (goalProblems.length > 0 || planProblems.length > 0) {
      await this.event('plan.deferred', {
        plan: facts.plan.handle,
        reason: 'invalid-artifact',
        problems: [...goalProblems, ...planProblems].length,
      })
      return
    }

    this.store.append('goal', goalObject, at)
    this.store.append('plan', planObject, at)
    await this.event('plan.recorded', {
      goal: goalObject.id,
      plan: planObject.id,
      tasks: planObject.tasks.length,
    })
  }

  /**
   * Announces one attention request for a takeover window.
   *
   * The request is an AMP object, but an `EntryKind` is closed (event, frame,
   * receipt, claim, hypothesis, unknown, goal, plan), so the document travels as
   * the payload of an `attention.requested` event. Nothing is invented here: the
   * window handle, the class (approval → commitment, question → curiosity) and
   * the urgency are the plugin's fixed policy, and `why_now`/`if_ignored` state
   * what the gate actually does.
   */
  async requestAttention(facts: AttentionRequestFacts): Promise<AttentionRequest> {
    await this.ensure()
    const request = buildAttentionRequest({
      id: attentionRequestIdOf(facts.handle),
      from: { kind: 'agent', id: this.agentId },
      to: { kind: 'human', id: AMP_HUMAN_ID },
      target: attentionTargetOf(facts),
      class: attentionClassOf(facts.type),
      urgency: attentionUrgencyOf(facts.type),
      why_now:
        facts.type === 'approval'
          ? `the host blocked ${facts.tool ?? 'a tool call'} pending a human decision`
          : 'the agent needs a human answer before it can continue',
      if_ignored: 'the call falls back to the host default and cannot proceed as asked',
      cost: { interrupts: 1 },
      ...(facts.expiresAt === undefined ? {} : { expires: iso(facts.expiresAt) }),
      fallback: 'escalate',
    })
    await this.event('attention.requested', {
      request,
      window: facts.handle,
      type: facts.type,
      ...(facts.session === undefined ? {} : { session: facts.session }),
    })
    return request
  }

  /**
   * Settles one window with an `InterruptRecord` and one `ask` receipt.
   *
   * The receipt is the chain settlement (`usage.interrupts` is 1 only when the
   * human actually granted or answered); the record rides in the
   * `interrupt.settled` event for the same closed-enum reason as the request.
   */
  async recordInterrupt(facts: InterruptSettlementFacts): Promise<InterruptRecord> {
    await this.ensure()
    const at = iso(facts.settledAt)
    const ms = Math.max(0, Math.trunc(facts.settledAt - facts.requestedAt))
    const receiptId = askReceiptIdOf(facts.handle)
    const record = buildInterruptRecord({
      id: interruptIdOf(facts.handle),
      request: attentionRequestIdOf(facts.handle),
      class: attentionClassOf(facts.type),
      target: attentionTargetOf(facts),
      urgency: attentionUrgencyOf(facts.type),
      status: facts.outcome,
      at,
      cost: { interrupts: facts.outcome === 'granted' || facts.outcome === 'answered' ? 1 : 0 },
      reason: interruptReasonOf(facts.outcome),
      receipt: receiptId,
    })
    const receipt = makeReceipt({
      id: receiptId,
      op: 'ask',
      outcome: interruptOutcome(facts.outcome),
      at,
      ms,
      usage: { interrupts: record.granted ? 1 : 0, ms },
      target: record.target,
      note: `${facts.type}:${facts.outcome}`,
    })
    this.store.append('receipt', receipt, at)
    await this.event('interrupt.settled', {
      interrupt: record,
      window: facts.handle,
      type: facts.type,
      ...(facts.session === undefined ? {} : { session: facts.session }),
    })
    return record
  }

  /** Records one tool invocation as a receipt plus an event. */
  async recordTool(facts: AmpToolFacts): Promise<Receipt> {
    await this.ensure()
    const ms = Math.max(0, Math.trunc(facts.ms))
    const receipt = makeReceipt({
      id: this.handles.next('receipt'),
      op: receiptOpOf(facts.tool),
      outcome: facts.ok ? 'success' : 'failure',
      ms,
      usage: { calls: 1, ms },
      target: { kind: 'tool', id: toolRefId(facts.tool) },
      note: `tool ${facts.tool}`,
    })
    this.store.append('receipt', receipt, receipt.at)
    await this.event('tool.invoked', {
      tool: facts.tool,
      ok: facts.ok,
      ms,
      receipt: receipt.id,
    })
    return receipt
  }

  /** Appends one typed event. */
  async event(
    type: string,
    payload?: Record<string, unknown>,
    options: { refs?: Ref[]; caused_by?: string; at?: string } = {},
  ): Promise<AmpEvent> {
    await this.ensure()
    const event = makeEvent({
      id: this.handles.next('event'),
      actor: { kind: 'agent', id: this.agentId },
      type,
      at: options.at ?? iso(this.clock.now()),
      ...(payload === undefined ? {} : { payload }),
      ...(options.refs === undefined ? {} : { refs: options.refs }),
      ...(options.caused_by === undefined ? {} : { caused_by: options.caused_by }),
    })
    this.store.append('event', event, event.at)
    return event
  }

  /* --------------------------------------------------------------------- *
   * Reads, verification and checkpoints
   * --------------------------------------------------------------------- */

  frames(limit = 50): Frame[] {
    return this.store.recent('frame', limit) as Frame[]
  }

  receipts(limit = 50): Receipt[] {
    return this.store.recent('receipt', limit) as Receipt[]
  }

  /**
   * Recomputes the chain and cross-checks the last checkpoint.
   *
   * The checkpoint witnesses a *prefix* of the chain, not the whole of it: an
   * entry appended after sealing is legal, so the comparison runs against the
   * first `checkpoint.count` entries. A chain shorter than the checkpoint
   * declares is the interesting failure — it means entries were deleted.
   */
  async verify(): Promise<
    SnapshotVerdict & { tip: string; count: number; checkpoint?: { seq: number; tip: string; count: number } }
  > {
    await this.ensure()
    const snapshot = this.store.snapshot(this.agentId)
    const reasons = [...this.store.verify().reasons]
    const latest = this.store.latestCheckpoint()
    let checkpoint: { seq: number; tip: string; count: number } | undefined

    if (latest !== undefined) {
      const stored: LedgerCheckpoint = {
        amp: '0.1',
        kind: 'ledger-checkpoint',
        tenant: latest.tenant,
        agent: latest.agent,
        seq: latest.seq,
        count: latest.count,
        tip: latest.tip,
        ...(latest.prev === null ? {} : { prev: latest.prev }),
        issued: latest.issued,
        kid: latest.kid,
        sig: latest.sig,
      }
      const signature = await verifyCheckpoint(stored, this.key().publicKey)
      reasons.push(...signature.reasons)

      if (latest.count > snapshot.count) {
        reasons.push(
          `checkpoint ${latest.seq} witnesses ${latest.count} entries but only ${snapshot.count} remain`,
        )
      } else {
        const prefixEntries = snapshot.entries.slice(0, latest.count)
        const prefix: LedgerSnapshot = {
          amp: '0.1',
          kind: 'ledger-snapshot',
          agent: snapshot.agent,
          tip: prefixEntries.at(-1)?.hash ?? GENESIS,
          count: prefixEntries.length,
          entries: prefixEntries,
        }
        reasons.push(...verifySnapshotAgainstCheckpoint(prefix, stored).reasons)
      }
      checkpoint = { seq: latest.seq, tip: latest.tip, count: latest.count }
    }

    const unique = reasons.filter((reason, index) => reasons.indexOf(reason) === index)
    return {
      ok: unique.length === 0,
      reasons: unique,
      tip: snapshot.tip,
      count: snapshot.count,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    }
  }

  /** Seals the current tip as a signed checkpoint. */
  async checkpoint(): Promise<LedgerCheckpoint> {
    await this.ensure()
    const snapshot = this.store.snapshot(this.agentId)
    const latest = this.store.latestCheckpoint()
    const previous: LedgerCheckpoint | undefined =
      latest === undefined
        ? undefined
        : {
            amp: '0.1',
            kind: 'ledger-checkpoint',
            tenant: latest.tenant,
            agent: latest.agent,
            seq: latest.seq,
            count: latest.count,
            tip: latest.tip,
            ...(latest.prev === null ? {} : { prev: latest.prev }),
            issued: latest.issued,
            kid: latest.kid,
            sig: latest.sig,
          }
    const checkpoint = await sealCheckpoint(snapshot, this.key(), {
      tenant: this.tenant,
      ...(previous === undefined ? {} : { previous }),
    })
    this.store.saveCheckpoint(checkpoint)
    return checkpoint
  }

  /** Latest stored manifest body, or `undefined` before the first issue. */
  storedManifest(): StoredManifest | undefined {
    return this.store.latestManifest()
  }

  /* --------------------------------------------------------------------- *
   * Observers and lifecycle
   * --------------------------------------------------------------------- */

  /**
   * Mirrors a whitelist of module-bus events into the ledger.
   *
   * Only structure is copied (`ledgerProjection`), so no prompt, question or
   * tool-output text reaches the append-only chain. Each append is tracked so a
   * test can await {@link flush} instead of racing it.
   */
  observe(bus: CoordinationEventBus): () => void {
    const disposers = MirroredEvents.map((type: string) =>
      bus.on(type, (payload: unknown) => {
        // The event `type` already names the source (`takeover.pending`), so the
        // projection is the payload itself — no wrapper object to nest through.
        const projected = ledgerProjection(payload)
        this.track(
          this.event(type.replace('/', '.'), isRecord(projected) ? projected : { value: projected }).catch(
            (error: unknown) => {
              this.logger?.debug?.(`amp observer failed for ${type}: ${describe(error)}`)
              return undefined
            },
          ),
        )
      }),
    )
    return () => {
      for (const dispose of disposers) dispose()
    }
  }

  /** Fire-and-forget wrapper that keeps the promise awaitable through {@link flush}. */
  track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise as Promise<unknown>
    this.pending.add(tracked)
    void tracked
      .catch(() => undefined)
      .finally(() => {
        this.pending.delete(tracked)
      })
    return promise
  }

  /** Debug log through the host logger, when one was supplied. */
  debug(message: string): void {
    this.logger?.debug?.(message)
  }

  /** Waits for every tracked append (write-behind receipts/events). */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending])
    }
  }

  private receiptRows(): Receipt[] {
    return this.store.recent('receipt', ReceiptScan) as Receipt[]
  }

  private latestFrameRef(): Ref | undefined {
    const frame = this.store.recent('frame', 1)[0] as Frame | undefined
    return frame === undefined ? undefined : { kind: 'frame', id: frame.id }
  }
}

/* ------------------------------------------------------------------------- *
 * Tool receipts
 * ------------------------------------------------------------------------- */

/**
 * Runs one tool call and settles it as a receipt.
 *
 * The receipt is written behind the call: the model gets its value first, and a
 * failed append is swallowed (the ledger then has one entry fewer, never a
 * fabricated one). Timing is measured with the wall clock and is the only
 * quantity recorded — no arguments and no result text.
 */
export async function timedToolCall<T>(
  amp: AmpService,
  tool: string,
  run: () => Promise<T> | T,
): Promise<T> {
  const started = Date.now()
  try {
    const raw = await run()
    // DSH detaches every tool result into plain JSON and rejects the call when
    // that is lossy (nested `undefined`, `NaN`, class instances...). Coerce here
    // once, at the boundary, instead of failing the model's call.
    const safe = jsonSafe(raw)
    if (safe.changed) {
      amp.debug(`tool ${tool} output needed JSON coercion before it could cross the tool boundary`)
    }
    amp.track(amp.recordTool({ tool, ok: true, ms: Date.now() - started })).catch(() => undefined)
    return safe.value
  } catch (error) {
    amp.track(amp.recordTool({ tool, ok: false, ms: Date.now() - started })).catch(() => undefined)
    throw error
  }
}

/**
 * Wraps a tool registry so every registered definition is receipted.
 *
 * The definition itself is passed through unchanged (`name`, `description`,
 * `parameters`, `output`), so this decorator cannot change what the model sees;
 * only `execute` is wrapped.
 */
export function withAmpReceipts(
  registry: CoordinationToolRegistry,
  amp: AmpService,
): CoordinationToolRegistry {
  return {
    register: (definition: CoordinationToolDefinition) =>
      registry.register({
        ...definition,
        execute: (args, exec) =>
          timedToolCall(amp, definition.name, () => definition.execute(args, exec)),
      }),
  }
}

/* ------------------------------------------------------------------------- *
 * Cognition: comprehension → warrant-validated claims
 * ------------------------------------------------------------------------- */

const Placeholders = new Set(['none', 'n/a', 'na', '-', '—', '无', '暂无', '不适用', 'null', 'undefined'])

/** Collapse whitespace and bound a string; the ledger never stores a wall of text. */
function collapseWhitespace(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

/** Case- and whitespace-insensitive form used only to detect a verbatim anchor. */
function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * The longest verbatim piece of `statement` that appears in `prompt`.
 *
 * Tries the whole statement, then each sentence. There is no fuzzy matching on
 * purpose: "the prompt entails this claim" is a checkable statement, while
 * "the prompt is similar to this claim" is not, and only the former may raise a
 * claim above T0.
 */
function verbatimAnchor(prompt: string, statement: string): string | undefined {
  const normalizedPrompt = normalizeForMatch(prompt)
  if (normalizedPrompt.length === 0) return undefined
  if (statement.length >= 8 && normalizedPrompt.includes(normalizeForMatch(statement))) {
    return statement
  }
  for (const segment of statement.split(/[。.;；!?！？\n]/)) {
    const trimmed = segment.trim()
    if (trimmed.length >= 8 && normalizedPrompt.includes(normalizeForMatch(trimmed))) {
      return trimmed
    }
  }
  return undefined
}

export function claimIdOf(turn: string, field: CognitionField): string {
  return idFrom(`${turn}-${field}`, 'claim')
}

export function evidenceIdOf(turn: string, field: CognitionField): string {
  return idFrom(`${turn}-${field}`, 'evidence')
}

export function unknownIdOf(turn: string): string {
  return idFrom(`${turn}-ambiguity`, 'unknown')
}

/**
 * One comprehension field as a claim.
 *
 * Tier `T1` (sourced, entailment) only when the statement is verbatim in the
 * prompt; otherwise `T0` (assumed) with no evidence. `confidence` is always
 * derived from tier + evidence (M-1), never read from the comprehension row.
 * An invalid claim returns `undefined` — it is dropped, never stored.
 */
function buildClaim(
  facts: AmpTurnFacts,
  cognition: AmpCognitionInput,
  field: CognitionField,
  at: string,
): Claim | undefined {
  const raw = cognition[field]
  const statement = collapseWhitespace(raw, 1000)
  if (statement.length < 4 || Placeholders.has(raw.trim().toLowerCase())) return undefined

  const anchor = verbatimAnchor(cognition.prompt, statement)
  const evidence: EvidenceItem[] =
    anchor === undefined
      ? []
      : [
          {
            id: evidenceIdOf(facts.turn, field),
            kind: 'testimony',
            trust: 'asserted',
            independence: 1,
            relation: 'supports',
            entails: true,
            origin: `prompt:${facts.turn}`,
            ref: { kind: 'memory', id: promptIdOf(facts.turn) },
            excerpt: anchor.slice(0, 200),
            digest: digestOf(anchor),
            at,
          },
        ]

  const claim: Claim = {
    amp: '0.1',
    kind: 'claim',
    id: claimIdOf(facts.turn, field),
    statement,
    tier: anchor === undefined ? 'T0' : 'T1',
    status: anchor === undefined ? 'conjecture' : 'held',
    warrant: {
      evidence,
      inference: anchor === undefined ? 'abduction' : 'deduction',
      strength: evidence.length > 0 ? 1 : 0,
    },
    provenance: { source: `comprehension:${cognition.id}`, kind: 'inference', trust: 'self', at },
    created: at,
  }
  claim.confidence = deriveConfidence(claim)
  return validateClaim(claim).length === 0 ? claim : undefined
}

/** The comprehension's ambiguity as an open unknown; importance is measured. */
function buildUnknown(
  facts: AmpTurnFacts,
  cognition: AmpCognitionInput,
  at: string,
): UnknownItem | undefined {
  const question = collapseWhitespace(cognition.ambiguity, 600)
  if (question.length < 4 || Placeholders.has(cognition.ambiguity.trim().toLowerCase())) return undefined
  const confidence = Number.isFinite(cognition.confidence) ? cognition.confidence : 0.5
  const importance = Math.round(Math.max(0, Math.min(1, 1 - confidence)) * 1000) / 1000
  return {
    amp: '0.1',
    kind: 'unknown',
    id: unknownIdOf(facts.turn),
    question,
    importance,
    blocking: false,
    since: at,
    status: 'open',
  }
}

/* ------------------------------------------------------------------------- *
 * Fact helpers (shared with the service that builds the facts)
 * ------------------------------------------------------------------------- */

/** The policy knobs a frame may exclude; registered as concepts per frame. */
export const PolicyKnobs = [
  'policy-allow-bash',
  'policy-allow-web',
  'policy-max-iteration',
] as const

export function professionIdOf(profession: Profession): string {
  return idFrom(profession, 'profession')
}

export function sceneIdOf(scene: Scene): string {
  return idFrom(scene, 'scene')
}

export function interactionIdOf(interaction: Interaction): string {
  return idFrom(interaction, 'interaction')
}

export function validationIdOf(validation: Validation): string {
  return idFrom(validation, 'validation')
}

export function promptIdOf(turn: string): string {
  return idFrom(turn, 'prompt')
}

export function goalIdOf(handle: string): string {
  return idFrom(handle, 'goal')
}

export function planIdOf(handle: string): string {
  return idFrom(handle, 'plan')
}

/* ---- attention-request / interrupt ids and policy ---------------------- */

export function attentionRequestIdOf(handle: string): string {
  return idFrom(handle, 'attention')
}

export function interruptIdOf(handle: string): string {
  return idFrom(handle, 'interrupt')
}

export function askReceiptIdOf(handle: string): string {
  return idFrom(handle, 'ask-receipt')
}

/**
 * Class of an approval/question window.
 *
 * An approval is a `commitment`: the host promised to ask before acting. A
 * question is `curiosity`: the agent needs information, not permission.
 */
export function attentionClassOf(type: 'approval' | 'question'): InterruptClass {
  return type === 'approval' ? 'commitment' : 'curiosity'
}

/** Urgency is fixed policy: a blocked effect outranks a clarification. */
export function attentionUrgencyOf(type: 'approval' | 'question'): 1 | 2 | 3 | 4 | 5 {
  return type === 'approval' ? 4 : 3
}

/** The object whose attention is requested: the tool, or the open question set. */
export function attentionTargetOf(facts: AttentionRequestFacts): Ref {
  return facts.tool === undefined || facts.tool.length === 0
    ? { kind: 'question', id: idFrom(facts.handle, 'takeover') }
    : { kind: 'tool', id: toolRefId(facts.tool) }
}

/** Human-readable settlement reason; the status stays the machine-readable field. */
export function interruptReasonOf(outcome: InterruptSettlementFacts['outcome']): string {
  switch (outcome) {
    case 'granted':
      return 'human granted the call once'
    case 'answered':
      return 'human answered the question'
    case 'denied':
      return 'human rejected the call'
    case 'expired':
      return 'no human answer inside the response window'
    case 'withdrawn':
    default:
      return 'window cancelled or plugin unloaded'
  }
}

/* ---- plan artifact gates ------------------------------------------------- */

/**
 * Why the plan pair cannot be emitted, or `undefined` when it can.
 *
 * Every branch is a missing *recorded* fact, never a judgement: no steps, a step
 * without acceptance, or no constraint to abandon on.
 */
export function planDeferReason(facts: AmpPlanFacts): string | undefined {
  if (facts.goal === undefined) return 'missing-goal'
  if (facts.steps.length === 0) return 'no-steps'
  if (facts.steps.some((step) => step.expect.trim().length === 0)) return 'missing-expect'
  if (facts.plan.constraint.trim().length === 0) return 'missing-abandon-if'
  return undefined
}

/** Plugin plan status → AMP plan status. `scored` is still a draft. */
export function planStatusOf(status: string): Plan['status'] {
  switch (status) {
    case 'active':
      return 'executing'
    case 'done':
      return 'done'
    case 'failed':
    case 'abandoned':
    case 'rebuilt':
      return 'abandoned'
    case 'draft':
    case 'scored':
    default:
      return 'draft'
  }
}

/** Plugin plan status → AMP task status (one status for every task). */
export function planTaskStatus(status: string): Plan['tasks'][number]['status'] {
  switch (status) {
    case 'active':
      return 'running'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'abandoned':
    case 'rebuilt':
      return 'skipped'
    default:
      return 'pending'
  }
}

/** One bounded, single-line prompt excerpt for the panel narrative. */
export function promptExcerpt(content: string, limit: number = 220): { excerpt: string; truncated: boolean } {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return { excerpt: flat, truncated: false }
  return { excerpt: `${flat.slice(0, limit)}…`, truncated: true }
}
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}




