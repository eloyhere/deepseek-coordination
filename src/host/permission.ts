/**
 * Permission grants and the `permission` command face (v23 §6.4, §16, §17.1).
 *
 * The plugin keeps its own grant ledger: one `permission` row per
 * (session, subject, grant, status). DSH stays the authority for the live
 * sandbox and the approval policy. This module therefore never applies a
 * sandbox preset when a grant is recorded (§15.2 / §16): a row is a
 * coordination-side decision, not a silent widening of the process sandbox.
 * The only DSH state this module may touch is the approval policy, and only
 * when the caller explicitly asks for it (`approval=never` / `approval=ask`).
 *
 * Fail-closed rules:
 *
 * - `check` allows a permission only when at least one `granted` row exists for
 *   that (subject, grant); a revoked or `pending` row never counts. Rows are
 *   scoped per session but the capability question has no session argument, so
 *   a grant remains usable while any session still holds it.
 * - An empty request (`grant: []`) asks for nothing and is allowed; it is the
 *   only path that does not require a grant row.
 * - `request` records what it can and reports `allowed: false` with a reason
 *   when it cannot record the grant (unknown session, malformed input) or
 *   when a requested approval policy could not be applied. Such rows are
 *   stored as `pending`, so `check` still denies them.
 *
 * Three statuses are meaningful in the table:
 *
 * | status    | meaning                                                        |
 * |-----------|----------------------------------------------------------------|
 * | `granted` | recorded and effective for `check`                             |
 * | `pending` | recorded but not honoured (an un-appliable approval policy)    |
 * | `revoked` | withdrawn; the row is kept for audit, never for a check     |
 *
 * Command face (`execute`), parsed after the `permission` command type was
 * selected in the composer:
 *
 * ```text
 * allow <subject> <grant...>   允许 <subject> <grant...>
 * deny [subject]               拒绝 [subject]
 * revoke <subject> [grant...]  撤销 <subject> [grant...]
 * status [subject]             查看 [subject]
 * ```
 *
 * An optional `--approval never|ask` / `approval=never|ask` directive on
 * `allow` is forwarded to `host.approval.setPolicy`; without the port or a
 * live agent for the session the grant is parked as `pending` and refused.
 */
import type { AgentView, ModuleHost } from './module.js'
import type { PermissionResult } from '../shared/entity.js'
import { InvalidArgumentError } from '../shared/error.js'
import { number, text } from './row.js'
import type { Row } from './row.js'

/** Answer to a permission question; mirrors `CheckResult` in `shared/service.ts`. */
export interface PermissionCheck {
  allowed: boolean
  reason?: string
}

/** One subject's current grants, grouped by the status of their latest row. */
export interface PermissionGrantView {
  subject: string
  grant: string[]
  status: string
}

const Granted = 'granted'
const Pending = 'pending'
const Revoked = 'revoked'

type PermissionStatus = typeof Granted | typeof Pending | typeof Revoked
type RecordableStatus = typeof Granted | typeof Pending


const AllowVerb = new Set(['allow', '允许'])
const DenyVerb = new Set(['deny', '拒绝'])
const RevokeVerb = new Set(['revoke', '撤销'])
const StatusVerb = new Set(['status', '查看'])

export class PermissionModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  /**
   * Whether `subject` currently holds every named grant. A request that names
   * no grant asks for nothing and is allowed; anything else must be covered by
   * an active `granted` row. The ledger rows are per session, but this
   * capability question has no session argument, so a grant counts while any
   * session still holds it (the per-session `list` view shows the detail).
   */
  check(subject: string, grant: string[]): PermissionCheck {
    const name = typeof subject === 'string' ? subject.trim() : ''
    if (name.length === 0) return { allowed: false, reason: 'subject must be a non-empty string' }
    if (!Array.isArray(grant)) return { allowed: false, reason: 'grant must be an array of permission names' }
    const requested: string[] = []
    for (const value of grant) {
      const cleaned = typeof value === 'string' ? value.trim() : ''
      if (cleaned.length === 0) return { allowed: false, reason: 'every grant must be a non-empty name' }
      requested.push(cleaned)
    }
    if (requested.length === 0) return { allowed: true }
    const active = this.activeGrants(name)
    for (const value of requested) {
      if (active.has(value)) continue
      return { allowed: false, reason: `permission "${value}" is not granted to "${name}"` }
    }
    return { allowed: true }
  }

  /**
   * Record a grant request. `session` is the coordination session identity the
   * grant belongs to; without it the row cannot be written and the request is
   * refused instead of being applied implicitly. The sandbox preset is never
   * changed here, even when `host.permissionPresets` is available.
   */
  request(subject: string, grant: string[], reason: string, session?: number): PermissionResult {
    const name = typeof subject === 'string' ? subject.trim() : ''
    if (name.length === 0) return { allowed: false, reason: 'subject must be a non-empty string' }
    const requested = normaliseGrant(grant)
    if (typeof requested === 'string') return { allowed: false, reason: requested }
    if (requested.length === 0) {
      return { allowed: false, reason: 'a permission request must name at least one grant' }
    }
    if (session === undefined) {
      return {
        allowed: false,
        reason: 'session is required to record a permission grant; pass the coordination session identity',
      }
    }
    if (!Number.isInteger(session) || session <= 0) {
      return { allowed: false, reason: 'session must be a positive coordination session identity' }
    }
    if (this.sessionHandle(session) === undefined) {
      return { allowed: false, reason: `session ${session} is not recorded in coordination; the grant was not saved` }
    }

    const policy = approvalDirective(reason)
    const recorded = typeof reason === 'string' ? reason.trim() : ''
    const already = this.grantedSet(session, name, requested)
    const missing = requested.filter((value) => !already.has(value))
    const parked = missing.length === 0 ? '' : '; recorded as pending'

    if (policy !== undefined) {
      // The one DSH-side effect a request may cause, and only when asked for.
      const agent = this.liveAgent(session)
      if (this.host.approval === undefined) {
        this.record(name, missing, session, Pending, recorded)
        return {
          allowed: false,
          reason: `approval policy "${policy}" cannot be applied: DSH exposed no approval port${parked}`,
        }
      }
      if (agent === undefined) {
        this.record(name, missing, session, Pending, recorded)
        return {
          allowed: false,
          reason: `approval policy "${policy}" cannot be applied: no live agent for session ${session}${parked}`,
        }
      }
      try {
        this.host.approval.setPolicy(agent, policy)
      } catch (error) {
        this.record(name, missing, session, Pending, recorded)
        return {
          allowed: false,
          reason: `approval policy "${policy}" was refused: ${errorMessage(error)}${parked}`,
        }
      }
    }

    this.record(name, missing, session, Granted, recorded)
    if (policy !== undefined) return { allowed: true, reason: `approval policy set to "${policy}"` }
    if (missing.length === 0) return { allowed: true, reason: 'permission was already granted' }
    return { allowed: true }
  }

  /**
   * Withdraw grants for one subject. `grant` narrows the withdrawal to the
   * named permissions; omitting it revokes every grant of the subject. The
   * optional `session` narrows the update to one session. Idempotent: already
   * revoked rows keep their original `finished`.
   */
  revoke(subject: string, grant?: string[], session?: number): void {
    const name = requireSubject(subject)
    let grants: string[] | undefined
    if (grant !== undefined) {
      const cleaned = normaliseGrant(grant)
      if (typeof cleaned === 'string') throw new InvalidArgumentError(cleaned)
      if (cleaned.length === 0) {
        throw new InvalidArgumentError('revoke grant list must not be empty; omit it to revoke every grant')
      }
      grants = cleaned
    }
    if (session !== undefined && (!Number.isInteger(session) || session <= 0)) {
      throw new InvalidArgumentError('session must be a positive coordination session identity')
    }

    const now = this.host.clock.now()
    this.host.db.transaction(() => {
      const clauses = ['subject = ?', `status <> '${Revoked}'`]
      const params: unknown[] = [now, name]
      if (session !== undefined) {
        clauses.push('session = ?')
        params.push(session)
      }
      if (grants !== undefined) {
        clauses.push(`grant IN (${grants.map(() => '?').join(', ')})`)
        params.push(...grants)
      }
      this.host.db.run(
        `UPDATE permission SET status = '${Revoked}', finished = ? WHERE ${clauses.join(' AND ')}`,
        ...params,
      )
    })
  }

  /**
   * Current state of one session's grants. The latest row of each
   * (subject, grant) pair wins; rows are then grouped by subject and status so
   * a revoked or pending grant is never reported as if it were granted.
   */
  list(session: number): PermissionGrantView[] {
    assertIdentity('session', session)
    const rows = this.host.db.all<Row>(
      'SELECT subject, grant, status FROM permission WHERE session = ? ORDER BY identity ASC',
      session,
    )
    const latest = new Map<string, { subject: string; grant: string; status: string }>()
    for (const row of rows) {
      const subject = text(row, 'subject')
      const grant = text(row, 'grant')
      const status = text(row, 'status')
      if (subject.length === 0 || grant.length === 0) continue
      latest.set(`${subject}\u0000${grant}`, { subject, grant, status })
    }
    const groups = new Map<string, PermissionGrantView>()
    for (const entry of latest.values()) {
      const key = `${entry.subject}\u0000${entry.status}`
      const group = groups.get(key)
      if (group === undefined) {
        groups.set(key, { subject: entry.subject, grant: [entry.grant], status: entry.status })
      } else {
        group.grant.push(entry.grant)
      }
    }
    return [...groups.values()]
  }

  /**
   * Command face. The turn supplies the session the command writes to.
   * `allowed` reports the resulting permission state: true after a recorded
   * `allow`, false after `deny`/`revoke`, and for `status` whether the queried
   * scope holds at least one effective grant. `reason` carries the explanation
   * (or the JSON listing for `status`) either way.
   */
  execute(turn: number, content: string): PermissionResult {
    const raw = typeof content === 'string' ? content.trim() : ''
    if (raw.length === 0) return { allowed: false, reason: 'permission command is empty' }
    if (!Number.isInteger(turn) || turn <= 0) {
      return { allowed: false, reason: 'turn must be a positive coordination turn identity' }
    }
    const turnRow = this.host.db.get<Row>('SELECT session FROM turn WHERE identity = ?', turn)
    if (turnRow === undefined) {
      return { allowed: false, reason: `turn ${turn} is not recorded in coordination` }
    }
    const session = number(turnRow, 'session')

    const tokens = tokenize(raw)
    let verb = stripPrefix((tokens.shift() ?? '').toLowerCase())
    if (verb === 'permission' || verb === '权限') {
      verb = stripPrefix((tokens.shift() ?? '').toLowerCase())
    }

    if (AllowVerb.has(verb)) return this.commandAllow(session, tokens, raw)
    if (DenyVerb.has(verb)) return this.commandDeny(tokens)
    if (RevokeVerb.has(verb)) return this.commandRevoke(session, tokens)
    if (StatusVerb.has(verb)) return this.commandStatus(session, tokens)
    return { allowed: false, reason: `unknown permission command: ${verb.length === 0 ? '(empty)' : verb}` }
  }

  /* ----------------------------------------------------------------------- *
   * Command helpers
   * ----------------------------------------------------------------------- */

  private commandAllow(session: number, tokens: string[], raw: string): PermissionResult {
    const parsed = extractApproval(tokens)
    if (parsed.error !== undefined) return { allowed: false, reason: parsed.error }
    const subject = parsed.tokens.shift()?.trim() ?? ''
    if (subject.length === 0) {
      return { allowed: false, reason: 'allow needs a subject: allow <subject> <grant...>' }
    }
    if (parsed.tokens.length === 0) {
      return { allowed: false, reason: `allow for "${subject}" needs at least one grant` }
    }
    const reason =
      parsed.policy === undefined
        ? `permission command: ${raw}`
        : `permission command: ${raw} (approval=${parsed.policy})`
    return this.request(subject, parsed.tokens, reason, session)
  }

  private commandDeny(tokens: string[]): PermissionResult {
    const subject = tokens.shift()?.trim() ?? ''
    return {
      allowed: false,
      reason: subject.length === 0 ? 'permission denied by command' : `permission denied by command for "${subject}"`,
    }
  }

  private commandRevoke(session: number, tokens: string[]): PermissionResult {
    const subject = tokens.shift()?.trim() ?? ''
    if (subject.length === 0) {
      return { allowed: false, reason: 'revoke needs a subject: revoke <subject> [grant...]' }
    }
    const grants = tokens.length === 0 ? undefined : tokens
    this.revoke(subject, grants, session)
    return {
      allowed: false,
      reason:
        grants === undefined
          ? `revoked every permission of "${subject}" in session ${session}`
          : `revoked ${grants.map((value) => `"${value}"`).join(', ')} from "${subject}" in session ${session}`,
    }
  }

  private commandStatus(session: number, tokens: string[]): PermissionResult {
    const subject = tokens.shift()?.trim() ?? ''
    const entries =
      subject.length === 0
        ? this.list(session)
        : this.list(session).filter((entry) => entry.subject === subject)
    const label = subject.length === 0 ? `session ${session}` : `"${subject}"`
    if (entries.length === 0) {
      return { allowed: false, reason: `no permission recorded for ${label}` }
    }
    const active = entries.filter((entry) => entry.status === Granted).length
    return { allowed: active > 0, reason: `${label}: ${JSON.stringify(entries)}` }
  }

  /* ----------------------------------------------------------------------- *
   * Ledger helpers
   * ----------------------------------------------------------------------- */

  /** Grants of one subject that at least one session currently holds. */
  private activeGrants(subject: string): Set<string> {
    const rows = this.host.db.all<Row>(
      'SELECT DISTINCT grant FROM permission WHERE subject = ? AND status = ?',
      subject,
      Granted,
    )
    const active = new Set<string>()
    for (const row of rows) active.add(text(row, 'grant'))
    return active
  }

  /** Grants of one subject that are already effective in one session. */
  private grantedSet(session: number, subject: string, grants: string[]): Set<string> {
    const rows = this.host.db.all<Row>(
      'SELECT grant, status FROM permission WHERE session = ? AND subject = ? ORDER BY identity ASC',
      session,
      subject,
    )
    const latest = new Map<string, string>()
    for (const row of rows) latest.set(text(row, 'grant'), text(row, 'status'))
    const granted = new Set<string>()
    for (const grant of grants) {
      if (latest.get(grant) === Granted) granted.add(grant)
    }
    return granted
  }

  /** Append one row per grant; `finished` stays open until a revoke. */
  private record(
    subject: string,
    grants: string[],
    session: number,
    status: RecordableStatus,
    reason: string,
  ): void {
    if (grants.length === 0) return
    const now = this.host.clock.now()
    this.host.db.transaction(() => {
      for (const grant of grants) {
        this.host.db.insert('permission', {
          handle: this.host.handles.next('permission'),
          session,
          subject,
          grant,
          reason: reason.length === 0 ? undefined : reason,
          status,
          created: now,
        })
      }
    })
  }

  /** The coordination session row's public handle, which is the DSH session id. */
  private sessionHandle(session: number): string | undefined {
    const row = this.host.db.get<Row>('SELECT handle FROM session WHERE identity = ?', session)
    if (row === undefined) return undefined
    const handle = text(row, 'handle')
    return handle.length === 0 ? undefined : handle
  }

  /**
   * Resolve the live DSH agent for one coordination session. The ports are
   * structural: the session may be found by agent id, by the session value the
   * agent carries, or by the live session object itself. When none match, the
   * caller must not touch DSH (fail-closed).
   */
  private liveAgent(session: number): AgentView | undefined {
    const agents = this.host.agents
    if (agents === undefined) return undefined
    const handle = this.sessionHandle(session)
    if (handle === undefined) return undefined
    try {
      const direct = agents.get(handle)
      if (direct !== undefined) return direct
    } catch {
      // An agent port that rejects the lookup falls through to the scan below.
    }
    let live: unknown
    try {
      live = this.host.sessions?.get(handle)
    } catch {
      live = undefined
    }
    try {
      for (const agent of agents.list()) {
        if (agentMatchesSession(agent, handle, live)) return agent
      }
    } catch {
      return undefined
    }
    return undefined
  }
}

/* ------------------------------------------------------------------------- *
 * Local helpers
 * ------------------------------------------------------------------------- */

/** Trimmed, de-duplicated grant names, or a reason the list is unusable. */
function normaliseGrant(value: unknown): string[] | string {
  if (!Array.isArray(value)) return 'grant must be an array of permission names'
  const seen = new Set<string>()
  const grants: string[] = []
  for (const item of value) {
    const cleaned = typeof item === 'string' ? item.trim() : ''
    if (cleaned.length === 0) return 'every grant must be a non-empty name'
    if (seen.has(cleaned)) continue
    seen.add(cleaned)
    grants.push(cleaned)
  }
  return grants
}

function requireSubject(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError('subject must be a non-empty string')
  }
  return value.trim()
}

function assertIdentity(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentError(`${name} must be a positive integer identity`)
  }
}

/** Split a command line into tokens, honouring simple single/double quotes. */
function tokenize(command: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of command.matchAll(pattern)) {
    const token = match[1] ?? match[2] ?? match[3] ?? ''
    if (token.length > 0) tokens.push(token)
  }
  return tokens
}

/** Drop a leading slash so `/permission` and `permission` behave the same. */
function stripPrefix(token: string): string {
  return token.startsWith('/') ? token.slice(1) : token
}

/**
 * Pull an explicit `approval=never|ask` directive out of the allow arguments.
 * The value must be written with `=` or `:` (the command face canonicalises it
 * that way), so free prose such as "approval never needed" is not misread.
 */
function extractApproval(tokens: string[]): {
  tokens: string[]
  policy?: 'never' | 'ask'
  error?: string
} {
  const rest: string[] = []
  let policy: 'never' | 'ask' | undefined
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    const match = /^(?:--?)?approval(?:[=:](.+))?$/i.exec(token)
    if (match === null) {
      rest.push(token)
      continue
    }
    const inline = match[1]
    const raw = inline === undefined ? tokens[index + 1] : inline
    if (raw === undefined) {
      return { tokens: rest, error: 'approval directive needs a policy: never or ask' }
    }
    const value = raw.trim().toLowerCase()
    if (value !== 'never' && value !== 'ask') {
      return { tokens: rest, error: `unknown approval policy: ${raw}` }
    }
    if (inline === undefined) index += 1
    policy = value
  }
  return { tokens: rest, ...(policy === undefined ? {} : { policy }) }
}

/** The approval policy a request's prose explicitly asks for, if any. */
function approvalDirective(value: unknown): 'never' | 'ask' | undefined {
  if (typeof value !== 'string') return undefined
  const match = /(?:^|[^a-z0-9_])(?:--?)?approval\s*[=:]\s*(never|ask)\b/i.exec(value)
  const policy = match?.[1]?.toLowerCase()
  return policy === 'never' || policy === 'ask' ? policy : undefined
}

function agentMatchesSession(agent: AgentView, handle: string, live: unknown): boolean {
  const session = agent.session
  if (session === undefined || session === null) return false
  if (live !== undefined && session === live) return true
  if (typeof session === 'string') return session === handle
  if (typeof session === 'object') {
    const record = session as Record<string, unknown>
    for (const key of ['id', 'handle', 'session']) {
      if (record[key] === handle) return true
    }
  }
  return false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
