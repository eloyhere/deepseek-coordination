/**
 * AMP v0.1 — Manifest (心智清单): the durable, signable self-declaration.
 *
 * Ported from `attention-manifest-protocol/src/manifest/{manifest,sign}.ts`.
 *
 * Signing coverage differs from every other artifact and must not be
 * generalised: **everything except `signatures` is signed, `digest` included**.
 * The digest is recomputed at signing time and again at verification time, so a
 * caller can neither sign a stale digest nor reuse a valid old signature over a
 * tampered body.
 */
import type {
  Budget,
  Confidence,
  Digest,
  Id,
  Ref,
  Signature,
  Tier,
  Timestamp,
} from './types.js'
import { canonical, digestOf } from './canonical.js'

export interface AgentIdentity {
  id: Id
  name?: string
  version?: string
  role?: string
}

export interface ValueStatement {
  id: Id
  statement: string
  weight?: Confidence
}

/** Hard constraints are never traded off; soft ones may be. */
export interface Constraint {
  id: Id
  statement: string
  enforcement?: 'hard' | 'soft'
}

export interface Identity {
  values?: ValueStatement[]
  constraints?: Constraint[]
}

export interface Capability {
  id: Id
  label?: string
  kind: 'tool' | 'skill' | 'knowledge' | 'perception' | 'action'
  /** Must derive from receipts (M-1), not from self-assessment. */
  confidence: Confidence
  /** Evidence tier actually earned by this capability. New capabilities start at T0. */
  tier: Tier
  cost?: Budget
  limits?: string[]
  evidence?: Ref[]
}

export interface Commitment {
  id: Id
  to: Ref
  promise: string
  due?: Timestamp
  status: 'open' | 'kept' | 'broken' | 'released'
  created?: Timestamp
}

export interface ManifestUnknown {
  id: Id
  question: string
  importance: Confidence
  blocking: boolean
  since?: Timestamp
}

export interface AttentionConfig {
  policy_digest: Digest
  frame?: Ref
  budget: Budget
}

export interface CalibrationBucket {
  lo: number
  hi: number
  predicted: number
  observed: number
  n: number
}

/** MEASURED block: every number here is computed from receipts, never self-reported. */
export interface Calibration {
  ece: Confidence
  buckets?: CalibrationBucket[]
}

export interface SelfModel {
  calibration: Calibration
  limits?: string[]
  state?: {
    load?: Confidence
    mode?: 'explore' | 'exploit' | 'triage' | 'reflect' | 'rest'
  }
}

export interface Manifest {
  amp: '0.1'
  kind: 'manifest'
  agent: AgentIdentity
  issued: Timestamp
  expires: Timestamp
  digest: Digest
  identity?: Identity
  capabilities: Capability[]
  concepts?: Ref[]
  commitments?: Commitment[]
  unknowns?: ManifestUnknown[]
  attention: AttentionConfig
  self: SelfModel
  signatures: Signature[]
}

/* ------------------------------------------------------------------------- *
 * Keys and signatures
 * ------------------------------------------------------------------------- */

const Encoder = new TextEncoder()

export interface KeyPair {
  kid: Id
  publicKey: CryptoKey
  privateKey: CryptoKey
}

export interface VerifyResult {
  ok: boolean
  reasons: string[]
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
  const pad = padded.length % 4 ? '='.repeat(4 - (padded.length % 4)) : ''
  const binary = atob(padded + pad)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)) as unknown as BufferSource
}

/** Generates one extractable Ed25519 pair under a caller-supplied key id. */
export async function generateSigningKey(kid: Id): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  return { kid, publicKey: pair.publicKey, privateKey: pair.privateKey }
}

/** base64url of the raw (SPKI/PKCS8-independent) Ed25519 public key bytes. */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toBase64Url(await crypto.subtle.exportKey('raw', key))
}

/** Re-imports a raw Ed25519 public key previously exported by {@link exportPublicKey}. */
export async function importPublicKey(raw: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', fromBase64Url(raw), { name: 'Ed25519' }, true, [
    'verify',
  ])
}

/** PKCS8 bytes of a private key, base64url. Never put this on a wire object. */
export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  return toBase64Url(await crypto.subtle.exportKey('pkcs8', key))
}

/** Re-imports a PKCS8 Ed25519 private key previously exported by {@link exportPrivateKey}. */
export async function importPrivateKey(pkcs8: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey('pkcs8', fromBase64Url(pkcs8), { name: 'Ed25519' }, true, [
    'sign',
  ])
}

type UnsignedManifest = Omit<Manifest, 'digest' | 'signatures'>

const signingBytes = (manifest: Omit<Manifest, 'signatures'>): BufferSource =>
  Encoder.encode(canonical(manifest)) as unknown as BufferSource

/** Digest of the manifest body (everything except `digest` and `signatures`). */
export function contentDigest(manifest: UnsignedManifest): Digest {
  return digestOf(manifest)
}

/**
 * Signs the canonical manifest. The digest is recomputed here, so a caller
 * cannot sign a stale digest.
 */
export async function signManifest(unsigned: UnsignedManifest, key: KeyPair): Promise<Manifest> {
  const digest = contentDigest(unsigned)
  const withDigest = { ...unsigned, digest }
  const signature = await crypto.subtle.sign('Ed25519', key.privateKey, signingBytes(withDigest))
  return {
    ...withDigest,
    signatures: [{ role: 'self', alg: 'ed25519', kid: key.kid, sig: toBase64Url(signature) }],
  }
}

/**
 * Recomputes the digest before verifying: a tampered body fails even with a
 * valid old signature.
 */
export async function verifyManifest(manifest: Manifest, publicKey: CryptoKey): Promise<VerifyResult> {
  const reasons: string[] = []
  const { digest, signatures, ...rest } = manifest

  if (contentDigest(rest) !== digest) {
    reasons.push('digest does not cover the manifest content')
  }

  const signature = signatures.find((entry) => entry.role === 'self')
  if (!signature) {
    reasons.push('missing self signature')
    return { ok: false, reasons }
  }

  const valid = await crypto.subtle.verify(
    'Ed25519',
    publicKey,
    fromBase64Url(signature.sig),
    signingBytes({ ...rest, digest }),
  )
  if (!valid) {
    reasons.push('signature does not verify')
  }

  return { ok: reasons.length === 0, reasons }
}

/** Key distribution + revocation. Revoked keys must not verify anything. */
export class KeyRegistry {
  private readonly keys = new Map<string, CryptoKey>()
  private readonly revoked = new Set<string>()

  add(kid: Id, publicKey: CryptoKey): void {
    this.keys.set(kid, publicKey)
  }

  revoke(kid: Id): void {
    this.revoked.add(kid)
  }

  get(kid: Id): CryptoKey | undefined {
    return this.revoked.has(kid) ? undefined : this.keys.get(kid)
  }
}

/** Verifies a manifest through a registry, refusing unknown and revoked keys. */
export async function verifyWithRegistry(
  manifest: Manifest,
  registry: KeyRegistry,
): Promise<VerifyResult> {
  const signature = manifest.signatures.find((entry) => entry.role === 'self')
  if (!signature) {
    return { ok: false, reasons: ['missing self signature'] }
  }
  const key = registry.get(signature.kid)
  if (!key) {
    return { ok: false, reasons: [`unknown or revoked key: ${signature.kid}`] }
  }
  return verifyManifest(manifest, key)
}
