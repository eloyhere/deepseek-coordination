/** Minimal typed error vocabulary kept for the notification centre. */
export type CoordinationErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'INVALID_STATE' | 'DATABASE' | 'NOT_IMPLEMENTED'

export class CoordinationError extends Error {
  readonly code: CoordinationErrorCode
  readonly details: Record<string, unknown>

  constructor(code: CoordinationErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.details = details
  }

  toJson(): { code: CoordinationErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details }
  }
}

export class InvalidArgumentError extends CoordinationError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('INVALID_ARGUMENT', message, details)
  }
}

export class NotFoundError extends CoordinationError {
  constructor(message: string) {
    super('NOT_FOUND', message)
  }
}
