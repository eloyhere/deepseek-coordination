/**
 * AMP v0.1 A-surface runtime: one sealed envelope for the seven performatives.
 *
 * The signature covers the canonical envelope except `sig`. Ordering, replay,
 * dedupe and cancellation are receiver-local decisions; no peer promise is
 * trusted. FIFO is scoped to `(from, to, thread)`; cross-thread ordering is not
 * guaranteed.
 *
 * Ported from `attention-manifest-protocol/src/protocol/envelope.ts`. The wire
 * shape, defaults and rejection reasons are normative and must not drift.
 */
import type { Digest, Id, Ref, Timestamp } from './types.js'
import { canonical, digestOf } from './canonical.js'
import type { KeyPair } from './manifest.js'

/** One of the seven performatives; the A-surface is closed over these. */
export type Performative = 'inform' | 'request' | 'propose' | 'commit' | 'decline' | 'cancel' | 'release'

const Encoder = new TextEncoder()

const PERFORMATIVES: ReadonlySet<string> = new Set([
  'inform',
  'request',
  'propose',
  'commit',
  'decline',
  'cancel',
  'release',
])

type VersionTuple = readonly [number, number]

/** Inclusive `major.minor` version window. Comparison is numeric, not lexical. */
export interface VersionRange {
  min: string
  max: string
}

/** The wire form of an authenticated AMP A-surface message. */
export interface SealedEnvelope<T = unknown> {
  amp: '0.1'
  kind: 'envelope'
  id: Id
  from: Ref
  to: Ref
  thread: Id
  seq: number
  type: Performative
  sent: Timestamp
  expires?: Timestamp
  nonce: string
  version: VersionRange
  payload: T
  kid: string
  sig: string
}

/** Caller-supplied fields; {@link sealEnvelope} fills every omitted default. */
export interface EnvelopeInput<T> {
  id?: Id
  from: Ref
  to: Ref
  thread: Id
  seq?: number
  type: Performative
  sent?: Timestamp
  ttlMs?: number
  nonce?: string
  version?: VersionRange
  payload: T
  kid?: string
}

/** Receiver outcome. `ok` is true only for `status: 'accepted'`. */
export interface EnvelopeVerdict {
  ok: boolean
  status: 'accepted' | 'duplicate' | 'out_of_order' | 'cancelled' | 'invalid'
  reasons: string[]
  envelope?: SealedEnvelope
}

/** Runtime clock, local version window and tolerated clock skew. */
export interface EnvelopeRuntimeOptions {
  now: () => Timestamp
  version: VersionRange
  clockSkewMs?: number
}

/** Optional receiver settings for {@link verifyEnvelope}. */
export interface EnvelopeVerifyOptions {
  now?: Timestamp
  expectedVersion?: VersionRange
  clockSkewMs?: number
  seenNonces?: Set<string>
}

type EnvelopeVerification = Pick<EnvelopeVerdict, 'ok' | 'reasons'>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isRef = (value: unknown): value is Ref =>
  isRecord(value) && typeof value.kind === 'string' && typeof value.id === 'string' && value.id.length > 0

const timestampMs = (value: unknown): number | null => {
  if (typeof value !== 'string') {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const parseVersion = (value: string): VersionTuple | null => {
  const match = /^([0-9]+)\.([0-9]+)$/.exec(value)
  if (!match) {
    return null
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    return null
  }
  return [major, minor]
}

const compareVersions = (left: VersionTuple, right: VersionTuple): number => {
  if (left[0] !== right[0]) {
    return left[0] < right[0] ? -1 : 1
  }
  if (left[1] !== right[1]) {
    return left[1] < right[1] ? -1 : 1
  }
  return 0
}

const formatVersion = (version: VersionTuple): string => `${version[0]}.${version[1]}`

/** Rejects malformed, inverted and non-`major.minor` ranges. */
const normalizeVersionRange = (value: unknown): VersionRange | null => {
  if (!isRecord(value)) {
    return null
  }
  if (typeof value.min !== 'string' || typeof value.max !== 'string') {
    return null
  }
  const min = parseVersion(value.min)
  const max = parseVersion(value.max)
  if (!min || !max) {
    return null
  }
  if (compareVersions(min, max) > 0) {
    return null
  }
  return { min: formatVersion(min), max: formatVersion(max) }
}

/**
 * Intersects two inclusive `major.minor` windows.
 *
 * Versions compare numerically (`0.10` is newer than `0.9`), with no prerelease
 * or patch semantics. Malformed or inverted ranges yield `null`, as does a
 * disjoint pair such as `0.1` with `0.2`.
 */
export function negotiateVersion(local: VersionRange, remote: VersionRange): VersionRange | null {
  const left = normalizeVersionRange(local)
  const right = normalizeVersionRange(remote)
  if (!left || !right) {
    return null
  }
  const leftMin = parseVersion(left.min) as VersionTuple
  const leftMax = parseVersion(left.max) as VersionTuple
  const rightMin = parseVersion(right.min) as VersionTuple
  const rightMax = parseVersion(right.max) as VersionTuple
  const min = compareVersions(leftMin, rightMin) >= 0 ? leftMin : rightMin
  const max = compareVersions(leftMax, rightMax) <= 0 ? leftMax : rightMax
  if (compareVersions(min, max) > 0) {
    return null
  }
  return { min: formatVersion(min), max: formatVersion(max) }
}

const toBase64Url = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes)
  let binary = ''
  for (let index = 0; index < view.length; index += 1) {
    binary += String.fromCharCode(view[index])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (text: string): BufferSource => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) {
    throw new Error('invalid base64url')
  }
  const pad = padded.length % 4 ? '='.repeat(4 - (padded.length % 4)) : ''
  const binary = atob(padded + pad)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)) as unknown as BufferSource
}

const signingBytes = (value: unknown): BufferSource =>
  Encoder.encode(canonical(value)) as unknown as BufferSource

const withoutSignature = (envelope: Record<string, unknown>): Record<string, unknown> => {
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(envelope)) {
    if (key !== 'sig') {
      body[key] = value
    }
  }
  return body
}

const randomHex = (bytes: number): string => {
  const values = crypto.getRandomValues(new Uint8Array(bytes))
  let hex = ''
  for (let index = 0; index < values.length; index += 1) {
    hex += values[index].toString(16).padStart(2, '0')
  }
  return hex
}

const normalizedSkew = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : 0

/**
 * Content digest of the signed envelope body (everything except `sig`).
 * Useful for logs and idempotency indexes; it is not a substitute for a
 * signature check.
 */
export function envelopeDigest(envelope: SealedEnvelope): Digest {
  return digestOf(withoutSignature(envelope as unknown as Record<string, unknown>))
}

/**
 * Seals one A-surface envelope with Ed25519.
 *
 * Defaults: a fresh random `id`, a 16-byte hex `nonce`, `seq` 0, an `amp` 0.1
 * version window, `kid` from the key unless explicitly supplied, `sent` from
 * the real clock and no expiry. A supplied `ttlMs` is added to `sent` to
 * produce `expires`; negative or non-finite TTLs are rejected. The signature
 * covers the canonical envelope excluding only `sig`.
 */
export async function sealEnvelope<T>(input: EnvelopeInput<T>, key: KeyPair): Promise<SealedEnvelope<T>> {
  const ttl = input.ttlMs
  if (ttl !== undefined && (!Number.isFinite(ttl) || ttl < 0)) {
    throw new RangeError('ttlMs must be a non-negative finite number')
  }

  const sent = input.sent ?? new Date().toISOString()
  const sentMs = timestampMs(sent)
  if (sentMs === null) {
    throw new Error('sent must be a valid timestamp')
  }

  const seq = input.seq ?? 0
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new RangeError('seq must be a non-negative safe integer')
  }

  const id = input.id ?? `m.${randomHex(16)}`
  const nonce = input.nonce ?? randomHex(16)
  const version: VersionRange = input.version
    ? { min: input.version.min, max: input.version.max }
    : { min: '0.1', max: '0.1' }

  let expires: Timestamp | undefined
  if (ttl !== undefined) {
    const expiresMs = sentMs + ttl
    if (!Number.isFinite(expiresMs) || Math.abs(expiresMs) > 8_640_000_000_000_000) {
      throw new RangeError('expires is outside the supported timestamp range')
    }
    expires = new Date(expiresMs).toISOString()
  }

  const unsigned: Omit<SealedEnvelope<T>, 'sig'> = {
    amp: '0.1',
    kind: 'envelope',
    id,
    from: input.from,
    to: input.to,
    thread: input.thread,
    seq,
    type: input.type,
    sent,
    ...(expires === undefined ? {} : { expires }),
    nonce,
    version,
    payload: input.payload,
    kid: input.kid ?? key.kid,
  }

  const signature = await crypto.subtle.sign('Ed25519', key.privateKey, signingBytes(unsigned))
  return { ...unsigned, sig: toBase64Url(signature) }
}

/**
 * Verifies an envelope's structure, amp/kind, expiry (with skew), version
 * intersection, optional nonce uniqueness and Ed25519 signature.
 *
 * A nonce is added to `seenNonces` only after every check passes, so a forged
 * or expired copy cannot burn a legitimate nonce. Expiry is accepted up to and
 * including `expires + clockSkewMs`.
 */
export async function verifyEnvelope(
  envelope: SealedEnvelope,
  publicKey: CryptoKey,
  options: EnvelopeVerifyOptions = {},
): Promise<EnvelopeVerification> {
  if (!isRecord(envelope)) {
    return { ok: false, reasons: ['envelope is not an object'] }
  }

  const record = envelope as unknown as Record<string, unknown>
  const reasons: string[] = []

  if (record.amp !== '0.1') {
    reasons.push('amp must be "0.1"')
  }
  if (record.kind !== 'envelope') {
    reasons.push('kind must be "envelope"')
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    reasons.push('id must be a non-empty string')
  }
  if (!isRef(record.from)) {
    reasons.push('from must be a Ref with a non-empty id')
  }
  if (!isRef(record.to)) {
    reasons.push('to must be a Ref with a non-empty id')
  }
  if (typeof record.thread !== 'string' || record.thread.length === 0) {
    reasons.push('thread must be a non-empty string')
  }
  if (!Number.isSafeInteger(record.seq) || (record.seq as number) < 0) {
    reasons.push('seq must be a non-negative safe integer')
  }
  if (typeof record.type !== 'string' || !PERFORMATIVES.has(record.type)) {
    reasons.push('type must be one of the seven performatives')
  }
  if (timestampMs(record.sent) === null) {
    reasons.push('sent must be a valid timestamp')
  }
  if (record.expires !== undefined && timestampMs(record.expires) === null) {
    reasons.push('expires must be a valid timestamp')
  }
  if (typeof record.nonce !== 'string' || record.nonce.length === 0) {
    reasons.push('nonce must be a non-empty string')
  }
  if (!Object.hasOwn(record, 'payload') || record.payload === undefined) {
    reasons.push('payload is required')
  }
  if (typeof record.kid !== 'string' || record.kid.length === 0) {
    reasons.push('kid must be a non-empty string')
  }

  const version = normalizeVersionRange(record.version)
  if (!version) {
    reasons.push('version must be an inclusive major.minor range')
  }

  if (options.expectedVersion !== undefined) {
    const expected = normalizeVersionRange(options.expectedVersion)
    if (!expected) {
      reasons.push('expectedVersion must be an inclusive major.minor range')
    } else if (version && negotiateVersion(version, expected) === null) {
      reasons.push('version ranges do not intersect')
    }
  }

  if (record.expires !== undefined) {
    const expiresMs = timestampMs(record.expires)
    if (expiresMs !== null) {
      const now = timestampMs(options.now ?? new Date().toISOString())
      if (now === null) {
        reasons.push('now must be a valid timestamp')
      } else if (now > expiresMs + normalizedSkew(options.clockSkewMs)) {
        reasons.push('envelope has expired')
      }
    }
  }

  const nonce = typeof record.nonce === 'string' && record.nonce.length > 0 ? record.nonce : null
  if (nonce !== null && options.seenNonces?.has(nonce)) {
    reasons.push('nonce has already been seen')
  }

  if (typeof record.sig !== 'string' || record.sig.length === 0) {
    reasons.push('signature is missing')
  } else {
    try {
      const valid = await crypto.subtle.verify(
        'Ed25519',
        publicKey,
        fromBase64Url(record.sig),
        signingBytes(withoutSignature(record)),
      )
      if (!valid) {
        reasons.push('signature does not verify')
      }
    } catch {
      reasons.push('signature is malformed')
    }
  }

  if (reasons.length === 0 && nonce !== null) {
    options.seenNonces?.add(nonce)
  }
  return { ok: reasons.length === 0, reasons }
}

const identityKey = (envelope: SealedEnvelope): string | null => {
  if (typeof envelope.id !== 'string' || envelope.id.length === 0) {
    return null
  }
  if (!isRef(envelope.from)) {
    return null
  }
  return JSON.stringify([envelope.from.id, envelope.id])
}

const sequenceKey = (envelope: SealedEnvelope): string => {
  const fromId = isRef(envelope.from) ? envelope.from.id : null
  const toId = isRef(envelope.to) ? envelope.to.id : null
  return JSON.stringify([fromId, toId, envelope.thread])
}

const tombstoneKey = (fromId: string, targetId: string): string => JSON.stringify([fromId, targetId])

const cancelTargetId = (payload: unknown): string | null => {
  if (!isRecord(payload)) {
    return null
  }
  if (typeof payload.targetId === 'string' && payload.targetId.length > 0) {
    return payload.targetId
  }
  if (typeof payload.request === 'string' && payload.request.length > 0) {
    return payload.request
  }
  return null
}

const verdictOf = (
  status: EnvelopeVerdict['status'],
  reasons: string[],
  envelope?: SealedEnvelope,
): EnvelopeVerdict => ({
  ok: status === 'accepted',
  status,
  reasons,
  ...(envelope === undefined ? {} : { envelope }),
})

/**
 * Authenticated receiver for one A-surface participant.
 *
 * `receive` verifies signature, TTL, version intersection and nonce replay
 * before touching sequence state. It enforces `(from, to, thread)` FIFO, global
 * `(from, id)` dedupe within this runtime, and sticky `(from, targetId)` cancel
 * tombstones. A cancel is subject to the same sequence ordering as every other
 * performative. An envelope whose `seq` is ahead of the next expected value is
 * queued as `out_of_order` and becomes deliverable when the gap closes. Threads
 * and recipient pairs advance independently.
 */
export class EnvelopeRuntime {
  private readonly now: () => Timestamp
  private readonly version: VersionRange
  private readonly clockSkewMs: number
  private readonly nextByThread = new Map<string, number>()
  private readonly queueByThread = new Map<string, Map<number, SealedEnvelope>>()
  private readonly seenIds = new Set<string>()
  private readonly seenNonces = new Set<string>()
  private readonly tombstones = new Set<string>()
  private readonly deliveredEnvelopes: SealedEnvelope[] = []
  private readonly cancelledEnvelopes: SealedEnvelope[] = []

  constructor(options: EnvelopeRuntimeOptions) {
    this.now = options.now
    this.version = { min: options.version.min, max: options.version.max }
    this.clockSkewMs = normalizedSkew(options.clockSkewMs)
  }

  /**
   * Verifies and admits one envelope.
   *
   * Invalid envelopes leave the message id, nonce and sequence state untouched.
   * A duplicate id short-circuits to `duplicate`; a stale sequence is also
   * reported as `duplicate`; a future sequence is queued without delivery. A
   * cancelled target consumes its sequence slot so the FIFO can continue.
   */
  async receive(envelope: SealedEnvelope, publicKey: CryptoKey): Promise<EnvelopeVerdict> {
    if (!isRecord(envelope)) {
      return verdictOf('invalid', ['envelope is not an object'])
    }

    const initialIdentity = identityKey(envelope)
    if (initialIdentity !== null && this.seenIds.has(initialIdentity)) {
      return verdictOf('duplicate', ['envelope id has already been received'], envelope)
    }

    const nonces = new Set(this.seenNonces)
    const verification = await verifyEnvelope(envelope, publicKey, {
      now: this.now(),
      expectedVersion: this.version,
      clockSkewMs: this.clockSkewMs,
      seenNonces: nonces,
    })
    if (!verification.ok) {
      return verdictOf('invalid', [...verification.reasons], envelope)
    }

    const identity = identityKey(envelope)
    if (identity === null) {
      return verdictOf('invalid', ['envelope has no usable (from, id) identity'], envelope)
    }
    if (this.seenIds.has(identity)) {
      return verdictOf('duplicate', ['envelope id has already been received'], envelope)
    }

    const cancelTarget = envelope.type === 'cancel' ? cancelTargetId(envelope.payload) : null
    if (envelope.type === 'cancel' && cancelTarget === null) {
      return verdictOf('invalid', ['cancel payload must include a non-empty targetId or request'], envelope)
    }

    if (this.seenNonces.has(envelope.nonce)) {
      return verdictOf('invalid', ['nonce has already been seen'], envelope)
    }

    this.seenNonces.add(envelope.nonce)
    this.seenIds.add(identity)

    const key = sequenceKey(envelope)
    const next = this.nextByThread.get(key) ?? 0

    if (envelope.seq > next) {
      const queue = this.queueByThread.get(key) ?? new Map<number, SealedEnvelope>()
      if (queue.has(envelope.seq)) {
        return verdictOf('duplicate', [`sequence ${envelope.seq} is already queued`], envelope)
      }
      queue.set(envelope.seq, envelope)
      this.queueByThread.set(key, queue)
      return verdictOf('out_of_order', [`sequence ${envelope.seq} arrived before expected ${next}`], envelope)
    }

    if (envelope.seq < next) {
      return verdictOf('duplicate', [`sequence ${envelope.seq} is stale; expected ${next}`], envelope)
    }

    const outcome = this.settle(envelope)
    this.nextByThread.set(key, envelope.seq + 1)
    this.drain(key)

    if (outcome === 'cancelled') {
      return verdictOf('cancelled', [`envelope ${envelope.id} was cancelled`], envelope)
    }
    return verdictOf('accepted', [], envelope)
  }

  /** Delivered envelopes in sequence order, including cancel performatives. */
  get delivered(): readonly SealedEnvelope[] {
    return [...this.deliveredEnvelopes]
  }

  /** Convenience alias for `delivered`; both exclude cancelled targets. */
  get accepted(): readonly SealedEnvelope[] {
    return [...this.deliveredEnvelopes]
  }

  /** Verified envelopes suppressed by a previously delivered cancel tombstone. */
  get cancelled(): readonly SealedEnvelope[] {
    return [...this.cancelledEnvelopes]
  }

  /** Verified envelopes still waiting behind an earlier sequence gap. */
  get pending(): readonly SealedEnvelope[] {
    const queued: SealedEnvelope[] = []
    for (const queue of this.queueByThread.values()) {
      queued.push(...queue.values())
    }
    return queued.sort((left, right) => left.seq - right.seq)
  }

  private settle(envelope: SealedEnvelope): 'accepted' | 'cancelled' {
    if (envelope.type === 'cancel') {
      const target = cancelTargetId(envelope.payload)
      if (target !== null) {
        this.tombstones.add(tombstoneKey(envelope.from.id, target))
      }
      this.deliveredEnvelopes.push(envelope)
      return 'accepted'
    }

    if (this.tombstones.has(tombstoneKey(envelope.from.id, envelope.id))) {
      this.cancelledEnvelopes.push(envelope)
      return 'cancelled'
    }

    this.deliveredEnvelopes.push(envelope)
    return 'accepted'
  }

  /** Consumes every contiguous queued sequence after an accepted envelope. */
  private drain(key: string): void {
    const queue = this.queueByThread.get(key)
    if (!queue) {
      return
    }

    let next = this.nextByThread.get(key) ?? 0
    for (;;) {
      const queued = queue.get(next)
      if (!queued) {
        break
      }
      queue.delete(next)
      this.settle(queued)
      next += 1
    }
    this.nextByThread.set(key, next)
    if (queue.size === 0) {
      this.queueByThread.delete(key)
    }
  }
}
