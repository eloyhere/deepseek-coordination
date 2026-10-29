/**
 * Canonical JSON (RFC 8785 spirit: sorted keys, no whitespace) and its digest.
 *
 * Everything that gets signed or hashed must go through {@link canonical}
 * first. A signature over a JavaScript object's property order is not a
 * signature over the object, because two implementations serialize it
 * differently. Ported unchanged from
 * `attention-manifest-protocol/src/semantic/canonical.ts`.
 */
import { sha256Hex } from './sha256.js'

/**
 * Deterministic JSON: object keys sorted, arrays in order, `undefined` as
 * `null`, no insignificant whitespace.
 */
export function canonical(value: unknown): string {
  if (value === undefined) {
    return 'null'
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

/** `sha256:<64 lowercase hex>` over the canonical form of `value`. */
export function digestOf(value: unknown): string {
  return `sha256:${sha256Hex(canonical(value))}`
}

/** True when `value` is a well-formed AMP digest. */
export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}
