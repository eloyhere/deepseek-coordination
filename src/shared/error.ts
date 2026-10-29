/**
 * Typed failures raised by the coordination service.
 *
 * Every failure carries a stable `code` so the Client, tools, and audit trail
 * never parse prose. `toJson()` is the wire projection used by the HTTP RPC.
 */
import type { Profession } from './enum.js'

export type CoordinationErrorCode =
  | 'PROFESSION_LOCKED'
  | 'PROFESSION_REQUIRED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'INVALID_ARGUMENT'
  | 'ORCHESTRATION'
  | 'VERIFICATION'
  | 'TAKEOVER'
  | 'PERMISSION'
  | 'DATABASE'
  | 'CONFIG'
  | 'UPSTREAM'
  | 'NOT_IMPLEMENTED'
  /** One bounded background action is already running (`409`). */
  | 'BUSY'
  /** The payload is binary, undecodable or an unreadable Office package (`415`). */
  | 'UNSUPPORTED_MEDIA'

export interface ErrorJson {
  code: CoordinationErrorCode
  message: string
  details?: Record<string, unknown>
}

export class CoordinationError extends Error {
  readonly code: CoordinationErrorCode
  readonly details: Record<string, unknown>

  constructor(code: CoordinationErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.details = details
  }

  toJson(): ErrorJson {
    return { code: this.code, message: this.message, details: this.details }
  }
}

export class NotFoundError extends CoordinationError {
  constructor(kind: string, identity: string | number) {
    super('NOT_FOUND', `${kind} ${String(identity)} was not found`, { kind, identity })
  }
}

export class InvalidStateError extends CoordinationError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('INVALID_STATE', message, details)
  }
}

export class InvalidArgumentError extends CoordinationError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('INVALID_ARGUMENT', message, details)
  }
}

/**
 * Raised when a caller tries to change a profession after the task locked it.
 * Rebuilding or abandoning the task is the only lawful way to choose a new one.
 */
export class ProfessionLockedError extends CoordinationError {
  readonly turn: number
  readonly current: Profession
  readonly requested: Profession
  readonly reason: string
  readonly hint: string

  constructor(input: {
    turn: number
    current: Profession
    requested: Profession
    reason?: string
    hint?: string
    subtask?: number
  }) {
    super(
      'PROFESSION_LOCKED',
      `profession "${input.current}" is locked for task ${input.turn}; requested "${input.requested}"`,
      {
        turn: input.turn,
        ...(input.subtask === undefined ? {} : { subtask: input.subtask }),
        current: input.current,
        requested: input.requested,
      },
    )
    this.turn = input.turn
    this.current = input.current
    this.requested = input.requested
    this.reason = input.reason ?? 'profession is locked for the duration of the task'
    this.hint = input.hint ?? 'use rebuildTurn/rebuildSubTask or abandonTurn/abandonSubTask to change profession'
  }

  override toJson(): ErrorJson {
    return {
      ...super.toJson(),
      details: {
        ...this.details,
        reason: this.reason,
        hint: this.hint,
      },
    }
  }
}

/** Raised when a task would execute without a selected profession. */
export class ProfessionRequiredError extends CoordinationError {
  readonly turn: number
  readonly reason: string

  constructor(input: { turn: number; subtask?: number; reason?: string }) {
    super('PROFESSION_REQUIRED', `profession must be selected before task ${input.turn} executes`, {
      turn: input.turn,
      ...(input.subtask === undefined ? {} : { subtask: input.subtask }),
    })
    this.turn = input.turn
    this.reason = input.reason ?? 'profession must be selected before task execution'
  }
}

export class OrchestrationError extends CoordinationError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('ORCHESTRATION', message, details)
  }
}

export class VerificationError extends CoordinationError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('VERIFICATION', message, details)
  }
}

export class TakeoverError extends CoordinationError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('TAKEOVER', message, details)
  }
}

export class PermissionError extends CoordinationError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PERMISSION', message, details)
  }
}

export class DatabaseError extends CoordinationError {
  constructor(message: string, cause?: unknown) {
    super('DATABASE', message, { cause: cause instanceof Error ? cause.message : String(cause ?? '') })
  }
}

export class UpstreamError extends CoordinationError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('UPSTREAM', message, details)
  }
}

export class NotImplementedError extends CoordinationError {
  constructor(feature: string) {
    super('NOT_IMPLEMENTED', `${feature} is not available in this composition`, { feature })
  }
}

/** Normalise any thrown value to the wire error shape. */
export function toErrorJson(error: unknown): ErrorJson {
  if (error instanceof CoordinationError) return error.toJson()
  if (error instanceof Error) {
    return { code: 'INVALID_STATE', message: error.message, details: { name: error.name } }
  }
  return { code: 'INVALID_STATE', message: String(error) }
}
