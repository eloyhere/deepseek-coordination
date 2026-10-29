/**
 * AMP v0.1 — append-only ledger, snapshot chain and signed checkpoints.
 *
 * Three guarantees, each separately checkable:
 *  - **X-1 append-only**: nothing is deleted or rewritten; a revision adds a
 *    row that references its predecessor.
 *  - **X-2 hash chain**: `hash = digestOf({seq, kind, payload, prev})` over a
 *    single chronological order, genesis `sha256:` + 64 zeros. Changing,
 *    reordering or dropping an entry breaks every hash after it.
 *  - **X-5 checkpoint**: an Ed25519 signature over a domain-separated canonical
 *    body, so a valid checkpoint signature cannot be replayed onto another
 *    object kind.
 *
 * Ported from `attention-manifest-protocol/src/ledger/{ledger,persistence,checkpoint}.ts`
 * and `src/storage/appendLog.ts`.
 */
import type { Digest, Timestamp } from './types.js'
import type { Frame } from './frame.js'
import type { Claim, Hypothesis, UnknownItem } from './warrant.js'
import type { AmpEvent, Receipt } from './receipt.js'
import type { KeyPair } from './manifest.js'
import { canonical, digestOf, isDigest } from './canonical.js'
import { ProtocolIntegrityError } from './errors.js'

const GENESIS: Digest = `sha256:${'0'.repeat(64)}`

export type EntryKind =
  | 'event'
  | 'frame'
  | 'receipt'
  | 'claim'
  | 'hypothesis'
  | 'unknown'
  | 'goal'
  | 'plan'

export const EntryKinds: readonly EntryKind[] = [
  'event',
  'frame',
  'receipt',
  'claim',
  'hypothesis',
  'unknown',
  'goal',
  'plan',
]

/**
 * The tie-break order for the snapshot chain. It is normative for reproducible
 * tips and deliberately differs from the declaration order above; copy this
 * constant, not the enum.
 */
const KIND_ORDER: readonly EntryKind[] = [
  'event',
  'frame',
  'claim',
  'hypothesis',
  'unknown',
  'goal',
  'plan',
  'receipt',
]

export interface ChainEntry {
  seq: number
  kind: EntryKind
  payload: unknown
  prev: string
  hash: string
}

export interface LedgerSnapshot {
  amp: '0.1'
  kind: 'ledger-snapshot'
  agent: string
  tip: string
  count: number
  entries: ChainEntry[]
}

export interface SnapshotVerdict {
  ok: boolean
  reasons: string[]
}

const hashOf = (seq: number, kind: EntryKind, payload: unknown, prev: string): string =>
  digestOf({ seq, kind, payload, prev })

const timestampOf = (item: Record<string, unknown>): string => {
  const candidate = item.at ?? item.ts ?? item.created ?? item.since
  return typeof candidate === 'string' ? candidate : ''
}

/** What {@link exportSnapshot} reads; matches the {@link Ledger} getters. */
export interface LedgerContents {
  events: readonly AmpEvent[]
  frames: readonly Frame[]
  receipts: readonly Receipt[]
  claims: readonly Claim[]
  hypotheses: readonly Hypothesis[]
  unknowns: readonly UnknownItem[]
  goals: readonly unknown[]
  plans: readonly unknown[]
}

/**
 * Snapshot = a single chronological chain over the whole ledger.
 *
 * Sort key is `at|ts|created|since`, tie-broken by KIND_ORDER. An item with no
 * timestamp sorts first, which keeps an untyped legacy row visible instead of
 * silently shuffling it.
 */
export function exportSnapshot(ledger: LedgerContents, agent: string): LedgerSnapshot {
  type Item = { kind: EntryKind; at: string; order: number; payload: unknown }
  const items: Item[] = []

  const add = (kind: EntryKind, list: readonly unknown[]): void => {
    for (const payload of list) {
      const record = payload as Record<string, unknown>
      items.push({ kind, at: timestampOf(record), order: KIND_ORDER.indexOf(kind), payload })
    }
  }

  add('event', ledger.events)
  add('frame', ledger.frames)
  add('claim', ledger.claims)
  add('hypothesis', ledger.hypotheses)
  add('unknown', ledger.unknowns)
  add('goal', ledger.goals)
  add('plan', ledger.plans)
  add('receipt', ledger.receipts)

  items.sort((a, b) => (a.at === b.at ? a.order - b.order : a.at < b.at ? -1 : 1))

  const entries: ChainEntry[] = []
  let prev = GENESIS
  for (const item of items) {
    const seq = entries.length
    const hash = hashOf(seq, item.kind, item.payload, prev)
    entries.push({ seq, kind: item.kind, payload: item.payload, prev, hash })
    prev = hash
  }

  return { amp: '0.1', kind: 'ledger-snapshot', agent, tip: prev, count: entries.length, entries }
}

/** Structural + cryptographic verification, without trusting `count` or `tip`. */
export function verifySnapshot(snapshot: LedgerSnapshot): SnapshotVerdict {
  const reasons: string[] = []
  if (snapshot.amp !== '0.1' || snapshot.kind !== 'ledger-snapshot') {
    reasons.push('not a ledger snapshot')
  }

  let prev = GENESIS
  snapshot.entries.forEach((entry, index) => {
    if (entry.seq !== index) {
      reasons.push(`entry ${index}: seq ${entry.seq} is out of order`)
    }
    if (entry.prev !== prev) {
      reasons.push(`entry ${index}: prev does not match the previous hash`)
    }
    const expected = hashOf(entry.seq, entry.kind, entry.payload, entry.prev)
    if (entry.hash !== expected) {
      reasons.push(`entry ${index}: hash does not cover its payload`)
    }
    prev = entry.hash
  })

  if (snapshot.count !== snapshot.entries.length) {
    reasons.push(`count ${snapshot.count} does not match ${snapshot.entries.length} entries`)
  }
  if (snapshot.tip !== prev) {
    reasons.push('tip does not match the last entry')
  }

  return { ok: reasons.length === 0, reasons }
}

export interface RestoredLedger {
  events: AmpEvent[]
  frames: Frame[]
  receipts: Receipt[]
  claims: Claim[]
  hypotheses: Hypothesis[]
  unknowns: UnknownItem[]
  goals: unknown[]
  plans: unknown[]
}

/** Restores only a verified snapshot; a tampered one throws instead of loading. */
export function restoreSnapshot(snapshot: LedgerSnapshot): RestoredLedger {
  const verdict = verifySnapshot(snapshot)
  if (!verdict.ok) {
    throw new ProtocolIntegrityError('ledger', [
      `refusing to restore a broken snapshot: ${verdict.reasons.join('; ')}`,
    ])
  }

  const restored: RestoredLedger = {
    events: [],
    frames: [],
    receipts: [],
    claims: [],
    hypotheses: [],
    unknowns: [],
    goals: [],
    plans: [],
  }
  const bucket: Record<EntryKind, unknown[]> = {
    event: restored.events,
    frame: restored.frames,
    receipt: restored.receipts,
    claim: restored.claims,
    hypothesis: restored.hypotheses,
    unknown: restored.unknowns,
    goal: restored.goals,
    plan: restored.plans,
  }
  for (const entry of snapshot.entries) {
    bucket[entry.kind].push(entry.payload)
  }
  return restored
}

/* ------------------------------------------------------------------------- *
 * In-memory ledger
 * ------------------------------------------------------------------------- */

/**
 * The reference ledger.
 *
 * Unlike the reference implementation's public mutable arrays, this one keeps
 * the collections private: append is the only mutation path, so X-1 is enforced
 * by the type rather than by convention. Readers get copies.
 */
export class Ledger {
  private readonly eventRows: AmpEvent[] = []
  private readonly frameRows: Frame[] = []
  private readonly receiptRows: Receipt[] = []
  private readonly claimRows: Claim[] = []
  private readonly hypothesisRows: Hypothesis[] = []
  private readonly unknownRows: UnknownItem[] = []
  private readonly goalRows: unknown[] = []
  private readonly planRows: unknown[] = []

  get events(): readonly AmpEvent[] {
    return [...this.eventRows]
  }

  get frames(): readonly Frame[] {
    return [...this.frameRows]
  }

  get receipts(): readonly Receipt[] {
    return [...this.receiptRows]
  }

  get claims(): readonly Claim[] {
    return [...this.claimRows]
  }

  get hypotheses(): readonly Hypothesis[] {
    return [...this.hypothesisRows]
  }

  get unknowns(): readonly UnknownItem[] {
    return [...this.unknownRows]
  }

  get goals(): readonly unknown[] {
    return [...this.goalRows]
  }

  get plans(): readonly unknown[] {
    return [...this.planRows]
  }

  appendEvent(event: AmpEvent): void {
    this.eventRows.push(event)
  }

  appendFrame(frame: Frame): void {
    this.frameRows.push(frame)
  }

  appendReceipt(receipt: Receipt): void {
    this.receiptRows.push(receipt)
  }

  appendClaim(claim: Claim): void {
    this.claimRows.push(claim)
  }

  appendHypothesis(hypothesis: Hypothesis): void {
    this.hypothesisRows.push(hypothesis)
  }

  appendUnknown(item: UnknownItem): void {
    this.unknownRows.push(item)
  }

  appendGoal(goal: unknown): void {
    this.goalRows.push(goal)
  }

  appendPlan(plan: unknown): void {
    this.planRows.push(plan)
  }

  findClaim(id: string): Claim | undefined {
    return this.claimRows.find((claim) => claim.id === id)
  }

  findUnknown(id: string): UnknownItem | undefined {
    return this.unknownRows.find((item) => item.id === id)
  }

  /** The contents {@link exportSnapshot} reads. */
  contents(): LedgerContents {
    return {
      events: this.eventRows,
      frames: this.frameRows,
      receipts: this.receiptRows,
      claims: this.claimRows,
      hypotheses: this.hypothesisRows,
      unknowns: this.unknownRows,
      goals: this.goalRows,
      plans: this.planRows,
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Durable append log
 * ------------------------------------------------------------------------- */

/**
 * Pluggable destination for JSONL lines.
 *
 * `append` must not resolve until the line is accepted by the storage medium;
 * `readAll` returns the lines in write order. Each element is one complete JSON
 * object; blank lines are treated as corruption by {@link AppendLog.open}.
 */
export interface AppendSink {
  append(line: string): void | Promise<void>
  readAll(): string[] | Promise<string[]>
}

/** In-memory sink for tests, demos, and deterministic replays. */
export class MemoryAppendSink implements AppendSink {
  private readonly items: string[]

  constructor(lines: readonly string[] = []) {
    this.items = [...lines]
  }

  append(line: string): void {
    this.items.push(line)
  }

  readAll(): string[] {
    return [...this.items]
  }

  /** Live view of the stored lines for test harnesses; `readAll()` returns the copy. */
  get lines(): string[] {
    return this.items
  }
}

/**
 * One entry in the append-only log.
 *
 * Shape-compatible with {@link ChainEntry}; `at` is advisory metadata and is
 * deliberately not covered by `hash`.
 */
export interface LogEntry {
  seq: number
  kind: EntryKind
  payload: unknown
  prev: Digest
  hash: Digest
  at?: Timestamp
}

/** Thrown when a sink contains data that fails structural or hash verification. */
export class AppendLogError extends Error {
  /** Individual failures, in the order they were found. */
  readonly reasons: string[]

  constructor(message: string, reasons: readonly string[] = []) {
    super(message)
    this.name = 'AppendLogError'
    this.reasons = [...reasons]
  }
}

const isEntryKind = (value: unknown): value is EntryKind =>
  typeof value === 'string' && (EntryKinds as readonly string[]).includes(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * JSONL stores JSON, not JavaScript values. Normalizing before hashing keeps
 * the line self-consistent for `undefined` properties, `Date`, and other values
 * that `JSON.stringify` would otherwise rewrite or drop.
 */
const jsonValue = (value: unknown): unknown => {
  const text = JSON.stringify(value)
  return text === undefined ? null : JSON.parse(text)
}

const verifyEntries = (entries: readonly LogEntry[]): string[] => {
  const reasons: string[] = []
  let prev: Digest = GENESIS

  entries.forEach((entry, index) => {
    if (!Number.isSafeInteger(entry.seq) || entry.seq !== index) {
      reasons.push(`entry ${index}: seq ${`${entry.seq}`} is out of order`)
    }
    if (!isEntryKind(entry.kind)) {
      reasons.push(`entry ${index}: kind ${`${entry.kind}`} is not a supported entry kind`)
    }
    if (entry.prev !== prev) {
      reasons.push(`entry ${index}: prev does not match the previous hash`)
    }
    const expected = hashOf(entry.seq, entry.kind, entry.payload, entry.prev)
    if (entry.hash !== expected) {
      reasons.push(`entry ${index}: hash does not cover its canonical fields`)
    }
    prev = entry.hash
  })

  return reasons
}

/** Parses one JSONL line without trusting its `seq`, `prev`, or `hash` fields. */
const entryFromLine = (line: unknown, index: number, reasons: string[]): LogEntry | undefined => {
  if (typeof line !== 'string') {
    reasons.push(`line ${index}: expected a string`)
    return undefined
  }
  if (line.trim().length === 0) {
    reasons.push(`line ${index}: empty line`)
    return undefined
  }

  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    reasons.push(`line ${index}: not valid JSON`)
    return undefined
  }
  if (!isRecord(value)) {
    reasons.push(`line ${index}: expected a JSON object`)
    return undefined
  }

  const { seq, kind, prev, hash, at } = value
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) {
    reasons.push(`line ${index}: seq is not an integer`)
    return undefined
  }
  if (!isEntryKind(kind)) {
    reasons.push(`line ${index}: unknown entry kind ${`${kind}`}`)
    return undefined
  }
  if (!isDigest(prev)) {
    reasons.push(`line ${index}: prev is not a sha256 digest`)
    return undefined
  }
  if (!isDigest(hash)) {
    reasons.push(`line ${index}: hash is not a sha256 digest`)
    return undefined
  }
  if (at !== undefined && typeof at !== 'string') {
    reasons.push(`line ${index}: at is not a timestamp string`)
    return undefined
  }

  const entry: LogEntry = { seq, kind, payload: value.payload, prev, hash }
  if (typeof at === 'string') {
    entry.at = at
  }
  return entry
}

/**
 * A verified, append-only hash chain over a pluggable {@link AppendSink}.
 *
 * Every line is one JSON entry; `append` writes exactly one line and only
 * advances the in-memory tip after the sink resolves. Durability and atomicity
 * are properties of the sink, not of this class.
 */
export class AppendLog {
  private readonly sink: AppendSink
  private readonly items: LogEntry[]
  private tail: Promise<void> = Promise.resolve()

  /** Owner of the ledger; required when sealing a checkpoint. */
  agent: string

  private constructor(sink: AppendSink, entries: LogEntry[], agent: string) {
    this.sink = sink
    this.items = entries
    this.agent = agent
  }

  /**
   * Reads every line, parses it, and verifies the chain before returning.
   *
   * An empty sink opens as an empty log with the genesis tip. Any malformed
   * line, gap, bad link, or hash mismatch throws {@link AppendLogError}; the log
   * is never returned in a partially trusted state.
   */
  static async open(sink: AppendSink, agent = ''): Promise<AppendLog> {
    const lines = await sink.readAll()
    if (!Array.isArray(lines)) {
      throw new AppendLogError('append sink readAll() did not return an array of lines', [
        'readAll() did not return an array',
      ])
    }

    const reasons: string[] = []
    const entries: LogEntry[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const entry = entryFromLine(lines[index], index, reasons)
      if (entry === undefined) {
        break
      }
      entries.push(entry)
    }
    if (reasons.length === 0) {
      reasons.push(...verifyEntries(entries))
    }
    if (reasons.length > 0) {
      throw new AppendLogError(`append log failed verification: ${reasons.join('; ')}`, reasons)
    }

    return new AppendLog(sink, entries, agent)
  }

  /** Number of entries currently committed. */
  get count(): number {
    return this.items.length
  }

  /** Hash of the last entry, or the genesis hash for an empty log. */
  get tip(): Digest {
    return this.items.at(-1)?.hash ?? GENESIS
  }

  entries(): readonly LogEntry[] {
    return [...this.items]
  }

  /** Rechecks the in-memory chain; a mutation since `open`/`append` fails closed. */
  verify(): { ok: boolean; reasons: string[] } {
    const reasons = verifyEntries(this.items)
    return { ok: reasons.length === 0, reasons }
  }

  /**
   * Appends one entry and one JSONL line.
   *
   * Calls are serialized so concurrent appends get distinct, contiguous
   * sequence numbers. In-memory `count`/`tip` advance only after `sink.append`
   * resolves; if it rejects, this instance is unchanged and the same sequence
   * number can be retried.
   */
  async append(kind: EntryKind, payload: unknown, options: { at?: Timestamp } = {}): Promise<LogEntry> {
    const operation = this.tail.then(() => this.write(kind, payload, options))
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async write(kind: EntryKind, payload: unknown, options: { at?: Timestamp }): Promise<LogEntry> {
    const seq = this.items.length
    const prev = this.tip
    const stored = jsonValue(payload)
    const hash = hashOf(seq, kind, stored, prev)
    const entry: LogEntry = { seq, kind, payload: stored, prev, hash }
    if (options.at !== undefined) {
      entry.at = options.at
    }

    await this.sink.append(JSON.stringify(entry))
    this.items.push(entry)
    return entry
  }

  /**
   * Signs the current tip through {@link sealCheckpoint}.
   *
   * Refuses to sign a log whose in-memory chain no longer verifies.
   */
  async seal(
    key: KeyPair,
    options: CheckpointOptions & { agent?: string },
  ): Promise<LedgerCheckpoint> {
    await this.tail
    const verdict = this.verify()
    if (!verdict.ok) {
      throw new AppendLogError('refusing to seal a broken append log', verdict.reasons)
    }

    const agent = options.agent ?? this.agent
    if (agent.trim().length === 0) {
      throw new AppendLogError(
        'cannot seal a checkpoint without an agent: pass one to AppendLog.open or in the seal options',
        ['agent is empty'],
      )
    }

    const snapshot: LedgerSnapshot = {
      amp: '0.1',
      kind: 'ledger-snapshot',
      agent,
      tip: this.tip,
      count: this.count,
      entries: this.items.map((entry) => ({
        seq: entry.seq,
        kind: entry.kind,
        payload: entry.payload,
        prev: entry.prev,
        hash: entry.hash,
      })),
    }
    return sealCheckpoint(snapshot, key, options)
  }
}

/* ------------------------------------------------------------------------- *
 * Checkpoints
 * ------------------------------------------------------------------------- */

const Encoder = new TextEncoder()

/**
 * Domain separator mixed into every checkpoint signature. It keeps an Ed25519
 * signature over a checkpoint body from being replayed as a signature over any
 * other AMP object that happens to contain the same fields.
 */
export const CheckpointDomain = 'amp:ledger-checkpoint:0.1'

const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * A signed commitment to the tip of an append-only ledger.
 *
 * `prev` is the {@link checkpointDigest} of the previous checkpoint — the digest
 * of that checkpoint's canonical signed body, not a ledger entry hash. It makes
 * the sequence of checkpoints a chain of its own.
 */
export interface LedgerCheckpoint {
  amp: '0.1'
  kind: 'ledger-checkpoint'
  tenant: string
  agent: string
  /** Position in the checkpoint chain; `0` for the first, then one more each time. */
  seq: number
  /** Number of entries in the snapshot at `tip`. */
  count: number
  /** Entry hash at the tip of the witnessed chain. */
  tip: Digest
  /** Digest of the previous checkpoint's signed body, or absent for the first. */
  prev?: Digest
  issued: Timestamp
  kid: string
  /** base64url Ed25519 signature over the domain-separated canonical body. */
  sig: string
}

export interface CheckpointOptions {
  tenant: string
  /** Defaults to `new Date().toISOString()`. */
  issued?: Timestamp
  /** The checkpoint this one extends; its `seq` and digest are committed to. */
  previous?: LedgerCheckpoint
}

export interface CheckpointVerdict {
  ok: boolean
  reasons: string[]
}

type CheckpointBody = Omit<LedgerCheckpoint, 'sig'>

const toBase64Url = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (text: string): BufferSource => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 ? '='.repeat(4 - (padded.length % 4)) : ''
  const binary = atob(padded + pad)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)) as unknown as BufferSource
}

/**
 * Selects exactly the signed fields, dropping `sig` and any runtime extras.
 * Conditional inclusion keeps `prev` absent (rather than `null`) on the first
 * checkpoint, so its canonical form is stable across implementations.
 */
const checkpointFields = (checkpoint: CheckpointBody): CheckpointBody => {
  const fields: CheckpointBody = {
    amp: checkpoint.amp,
    kind: checkpoint.kind,
    tenant: checkpoint.tenant,
    agent: checkpoint.agent,
    seq: checkpoint.seq,
    count: checkpoint.count,
    tip: checkpoint.tip,
    issued: checkpoint.issued,
    kid: checkpoint.kid,
  }
  if (checkpoint.prev !== undefined) {
    fields.prev = checkpoint.prev
  }
  return fields
}

/**
 * Canonical JSON of the checkpoint body: every signed field, `sig` excluded,
 * keys sorted. The signature is over `CheckpointDomain + '\n' + body`.
 */
export function checkpointBody(checkpoint: CheckpointBody): string {
  return canonical(checkpointFields(checkpoint))
}

/**
 * Digest of the signed checkpoint body (everything except `sig`).
 *
 * Used as the `prev` link between checkpoints and safe to log or index. It is
 * not a ledger entry hash and must not be compared with `snapshot.tip`.
 */
export function checkpointDigest(checkpoint: LedgerCheckpoint): Digest {
  return digestOf(checkpointFields(checkpoint))
}

const signingBytes = (body: string): BufferSource =>
  Encoder.encode(`${CheckpointDomain}\n${body}`) as unknown as BufferSource

/**
 * Signs the snapshot's chain tip as a new checkpoint.
 *
 * `seq` is `(previous?.seq ?? -1) + 1`, and `prev` — when a previous checkpoint
 * is supplied — is `checkpointDigest(previous)`. The seal does not verify the
 * snapshot first: callers should pass a snapshot that has already been checked.
 */
export async function sealCheckpoint(
  snapshot: LedgerSnapshot,
  key: KeyPair,
  options: CheckpointOptions,
): Promise<LedgerCheckpoint> {
  const previous = options.previous
  let body: CheckpointBody = {
    amp: '0.1',
    kind: 'ledger-checkpoint',
    tenant: options.tenant,
    agent: snapshot.agent,
    seq: (previous?.seq ?? -1) + 1,
    count: snapshot.count,
    tip: snapshot.tip,
    issued: options.issued ?? new Date().toISOString(),
    kid: key.kid,
  }
  if (previous !== undefined) {
    body = { ...body, prev: checkpointDigest(previous) }
  }

  const signature = await crypto.subtle.sign(
    'Ed25519',
    key.privateKey,
    signingBytes(checkpointBody(body)),
  )
  return { ...body, sig: toBase64Url(signature) }
}

const isEmpty = (value: unknown): boolean => typeof value !== 'string' || value.trim().length === 0

/**
 * Verifies a checkpoint without trusting any field in it.
 *
 * Checks the envelope, non-empty tenant/agent/kid/issued, non-negative integer
 * `seq`/`count`, digest formats, then recomputes the canonical body and verifies
 * the Ed25519 signature. If `previous` is supplied, the checkpoint must be
 * linked to it: `seq` exactly `previous.seq + 1`, matching `prev` digest, and
 * constant tenant/agent.
 */
export async function verifyCheckpoint(
  checkpoint: LedgerCheckpoint,
  publicKey: CryptoKey,
  previous?: LedgerCheckpoint,
): Promise<CheckpointVerdict> {
  const reasons: string[] = []

  if (!checkpoint || typeof checkpoint !== 'object') {
    return { ok: false, reasons: ['checkpoint is not an object'] }
  }
  if (checkpoint.amp !== '0.1') {
    reasons.push('unsupported checkpoint amp version')
  }
  if (checkpoint.kind !== 'ledger-checkpoint') {
    reasons.push('not a ledger checkpoint')
  }
  if (isEmpty(checkpoint.tenant)) {
    reasons.push('tenant is empty')
  }
  if (isEmpty(checkpoint.agent)) {
    reasons.push('agent is empty')
  }
  if (isEmpty(checkpoint.kid)) {
    reasons.push('kid is empty')
  }
  if (isEmpty(checkpoint.issued)) {
    reasons.push('issued is empty')
  }
  if (!Number.isSafeInteger(checkpoint.seq) || checkpoint.seq < 0) {
    reasons.push('seq is not a non-negative integer')
  }
  if (!Number.isSafeInteger(checkpoint.count) || checkpoint.count < 0) {
    reasons.push('count is not a non-negative integer')
  }
  if (!isDigest(checkpoint.tip)) {
    reasons.push('tip is not a sha256 digest')
  }
  if (checkpoint.prev !== undefined && !isDigest(checkpoint.prev)) {
    reasons.push('prev is not a sha256 digest')
  }

  if (previous !== undefined) {
    if (!Number.isSafeInteger(previous.seq) || previous.seq < 0) {
      reasons.push('previous checkpoint seq is not a non-negative integer')
    } else if (checkpoint.seq !== previous.seq + 1) {
      reasons.push(`seq ${checkpoint.seq} does not continue from ${previous.seq}`)
    }
    if (checkpoint.agent !== previous.agent) {
      reasons.push('agent does not match the previous checkpoint')
    }
    if (checkpoint.tenant !== previous.tenant) {
      reasons.push('tenant does not match the previous checkpoint')
    }

    if (checkpoint.prev === undefined) {
      reasons.push('missing prev link to the previous checkpoint')
    } else {
      try {
        if (checkpoint.prev !== checkpointDigest(previous)) {
          reasons.push('prev does not match the previous checkpoint digest')
        }
      } catch {
        reasons.push('previous checkpoint cannot be canonicalized')
      }
    }
  }

  let body: string | undefined
  try {
    body = checkpointBody(checkpoint)
  } catch {
    reasons.push('checkpoint body cannot be canonicalized')
  }

  if (isEmpty(checkpoint.sig)) {
    reasons.push('signature is empty')
  } else if (!SIGNATURE_PATTERN.test(checkpoint.sig)) {
    reasons.push('signature is not base64url')
  } else if (body !== undefined) {
    try {
      const valid = await crypto.subtle.verify(
        'Ed25519',
        publicKey,
        fromBase64Url(checkpoint.sig),
        signingBytes(body),
      )
      if (!valid) {
        reasons.push('signature does not verify')
      }
    } catch {
      reasons.push('signature does not verify')
    }
  }

  return { ok: reasons.length === 0, reasons }
}

/**
 * Checks that a snapshot is the exact chain a checkpoint signed.
 *
 * First compares agent/count/tip with the checkpoint, then runs
 * {@link verifySnapshot} so a rewritten middle entry cannot hide behind a
 * matching tip declaration. This does not verify the checkpoint signature;
 * combine it with {@link verifyCheckpoint} for end-to-end assurance.
 */
export function verifySnapshotAgainstCheckpoint(
  snapshot: LedgerSnapshot,
  checkpoint: LedgerCheckpoint,
): CheckpointVerdict {
  const reasons: string[] = []

  if (snapshot.agent !== checkpoint.agent) {
    reasons.push(`snapshot agent ${snapshot.agent} does not match checkpoint agent ${checkpoint.agent}`)
  }
  if (snapshot.count !== checkpoint.count) {
    reasons.push(`snapshot count ${snapshot.count} does not match checkpoint count ${checkpoint.count}`)
  }
  if (snapshot.tip !== checkpoint.tip) {
    reasons.push('snapshot tip does not match checkpoint tip')
  }

  reasons.push(...verifySnapshot(snapshot).reasons)
  return { ok: reasons.length === 0, reasons }
}

export { GENESIS }
