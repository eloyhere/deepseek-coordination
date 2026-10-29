/**
 * Identifier grammar from `docs/schemas/common.schema.json#/$defs/id`.
 *
 * An id that does not match this pattern cannot be referenced by any other AMP
 * object, so the boundary rejects it instead of creating an object nothing can
 * point at.
 */
const IdPattern = /^[a-z][a-z0-9._:-]{0,63}$/

/** True when `value` is an id other AMP objects may cite. */
export function isId(value: unknown): value is string {
  return typeof value === 'string' && IdPattern.test(value)
}

/**
 * Build an id from an uppercase or space-bearing label.
 *
 * Convenience for hosts that mint ids from human text (a profession name, a
 * session handle). The result always satisfies {@link isId}; the empty label
 * becomes a single `x`, which is valid but deliberately uninformative.
 */
export function idFrom(label: string, prefix?: string): string {
  const body = label
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._:]+|[-._:]+$/g, '')
  const head = prefix === undefined ? '' : `${prefix}-`
  const combined = `${head}${body}`.replace(/[^a-z0-9._:-]/g, '-')
  if (combined.length === 0) return 'x'
  const trimmed = combined.slice(0, 64)
  return /^[a-z]/.test(trimmed) ? trimmed : `x${trimmed}`.slice(0, 64)
}
