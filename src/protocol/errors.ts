/**
 * AMP error family.
 *
 * A boundary constructor never returns a partially valid object: it fails as a
 * whole and carries every problem it found. That lets a caller log one
 * machine-readable code and one receipt instead of an object a later checker
 * may or may not notice.
 *
 * Ported from `attention-manifest-protocol/src/error/{ampError,boundaryRejection}.ts`.
 */

/** Shared base for AMP errors that carry a machine-readable code. */
export class AmpError<Code extends string = string> extends Error {
  readonly code: Code
  readonly problems: readonly string[]

  constructor(name: string, code: Code, problems: readonly string[]) {
    super(`${code}: ${problems.join('; ')}`)
    this.name = name
    this.code = code
    this.problems = [...problems]
  }
}

/**
 * Stable machine-readable boundary reasons; callers may switch on these.
 */
export type BoundaryCode =
  | 'invalid_frame'
  | 'invalid_tool_args'
  | 'unresolvable_ref'
  | 'duplicate_ref'
  | 'invalid_id'

/** The only error a `src/protocol` constructor may throw. */
export class BoundaryRejection extends AmpError<BoundaryCode> {
  constructor(code: BoundaryCode, problems: readonly string[]) {
    super('BoundaryRejection', code, problems)
  }
}

/** A persisted artifact failed verification (digest, chain link or signature). */
export class ProtocolIntegrityError extends AmpError<'ledger' | 'manifest' | 'envelope' | 'checkpoint'> {
  constructor(code: 'ledger' | 'manifest' | 'envelope' | 'checkpoint', problems: readonly string[]) {
    super('ProtocolIntegrityError', code, problems)
  }
}
