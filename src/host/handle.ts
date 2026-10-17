/**
 * Public handles and clocks.
 *
 * A handle is an opaque, stable string stored in the `handle` column. It is
 * never derived from an integer identity: rotating a database or merging two
 * profiles must not change what an operator sees in an audit trail.
 */
import { randomBytes } from 'node:crypto'

export class HandleGenerator {
  private counter = 0
  private readonly prefix: string

  constructor(prefix = 'coordination') {
    this.prefix = prefix
  }

  /** Mint one handle such as `coordination-turn-m3k9-1a2b3c4d`. */
  next(kind: string): string {
    this.counter = (this.counter + 1) % 0xffffff
    const time = Date.now().toString(36)
    const sequence = this.counter.toString(36)
    const random = randomBytes(4).toString('hex')
    return `${this.prefix}-${kind}-${time}-${sequence}-${random}`
  }
}

export interface Clock {
  now(): number
}

export const SystemClock: Clock = { now: () => Date.now() }

/** Deterministic clock for tests. */
export class ManualClock implements Clock {
  private current: number

  constructor(start = 1_700_000_000_000) {
    this.current = start
  }

  now(): number {
    return this.current
  }

  advance(milliseconds: number): number {
    this.current += milliseconds
    return this.current
  }
}
