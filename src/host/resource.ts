/**
 * Resources, their append-only version DAG, per-session vision, resource locks,
 * and the request/result thread ledger (v23 §11.17, §18.1).
 *
 * The schema is the boundary: this module only uses the columns that
 * `database.ts` actually declares for `resource`, `version`, `vision`, `lock`,
 * `thread`, `request` and `result`, and returns exactly the entity shapes from
 * `shared/entity.ts`. Several columns the design implies do not exist, so the
 * gaps are handled explicitly instead of being papered over:
 *
 * | Missing column            | What this module does                                          |
 * |---------------------------|----------------------------------------------------------------|
 * | `version.base`            | `write` accepts and validates a base; edges are kept in memory |
 * | `resource.current`        | current = row with the highest `version` number, appended under |
 * |                           | one transaction; no version row is ever updated                 |
 * | `version.size/hash`       | `resource.bytes` mirrors the current version; `size`/`hash`     |
 * |                           | derive them from the stored content                             |
 * | `lock.resource`           | the durable key is `resource:<identity>:<subject>`              |
 * | `thread.resource/turn`    | both are validated when a thread is opened, not persisted       |
 * | `request.resource`        | carried in `method` + the JSON `payload`                        |
 * | `result.thread`           | `result(thread, ...)` links the pending request to the thread   |
 *
 * Versioning
 * ----------
 * A resource owns a linear sequence of immutable `version` rows numbered
 * 1..n. `write` computes `n + 1` from the highest existing number inside the
 * same transaction, so it never rewrites an old row: the DAG is append-only by
 * construction. `current` is the highest-numbered version (the pointer is
 * derived, not stored). A caller may pass an explicit `base`; it must name an
 * existing version number of that resource and is allowed to be older than
 * current, which records a *branch*: the new version's base is that older
 * version, while the current pointer still advances to the new row. The base
 * edge lives in this process's memory because `version` has no `base` column —
 * after a restart an older version's base is reported as absent, never guessed.
 *
 * Bytes
 * -----
 * `version.content` is TEXT, so bytes are encoded once, by the resource's
 * declared kind/media: a text resource (`kind = 'text'` or a `text/*` media
 * type) stores its UTF-8 text and *refuses* bytes that are not valid UTF-8
 * rather than corrupting them; every other resource stores standard base64.
 * `bytes`, `size` and `hash` decode with the same rule, so a version round-trips
 * exactly and its sha256 is stable.
 *
 * Merge
 * -----
 * `MergeStrategy` names two sides, but the schema has no second content source:
 * no column stores "their" bytes and no call passes them. Therefore:
 *
 * - `ours` answers with the current version and no conflicts — nothing is
 *   rewritten, and nothing is claimed to have been merged.
 * - `theirs` **writes nothing**: it reports the conflict `theirs has no source
 *   version`, plus the real divergence the ledger can see (the calling
 *   session's last observed version differs from current), and returns the
 *   version that is still current. No version is invented.
 * - `manual` needs an operator-supplied result, which this module has no input
 *   for, so it throws `NotImplementedError`.
 *
 * Vision
 * ------
 * `vision` upserts one row per (session, resource): the session's last observed
 * version. `write` also observes the version it wrote (a writer has seen its
 * own output), so `merge` divergence means "this session is behind", not "this
 * session happened to write last". `vision.created` is the only timestamp the
 * table has and is therefore the time of the last observation.
 *
 * Locks
 * -----
 * A resource lock is exclusive, is attributed to the session that registered the
 * resource (the table requires a session and the API has none), and its lease is
 * capped by `config.defaultLease` — a caller may ask for a shorter lease, never a
 * longer one. Expired locks are released before every acquisition and by
 * `cleanupExpired()`, which the service lifecycle calls; a lock that outlived its
 * lease is never treated as active. Re-locking with the same subject is
 * idempotent (the existing row is returned), a different subject on the same
 * resource fails closed with `InvalidStateError`.
 *
 * Requests, threads, results
 * --------------------------
 * `thread` opens an active session-scoped thread (the originating resource and
 * turn are validated but not stored: no columns exist). `request` files a
 * pending `request` row whose payload names the resource and the reason; it is
 * not yet part of a thread. `result(thread, content)` is the step that links a
 * thread: it finds the pending request of that thread's session (preferring one
 * already linked to the thread), marks it `done`, stamps `finished`, links it to
 * the thread and stores one `ok` result row — all in one transaction. Without a
 * pending request it refuses instead of inventing one.
 *
 * Every multi-row change runs in `db.transaction`. Failures are typed
 * (`InvalidArgumentError`, `InvalidStateError`, `NotFoundError`,
 * `NotImplementedError`); no domain failure is a bare `Error`.
 *
 * Events on `host.events`: `resource/registered`, `resource/written`,
 * `resource/locked`, `resource/released`, `resource/thread`,
 * `resource/requested`, `resource/resulted`.
 */
import { createHash } from 'node:crypto'
import type { ModuleHost } from './module.js'
import type {
  Lock,
  MergeResult,
  MergeStrategy,
  Request,
  Resource,
  ResourceVision,
  Result,
  Thread,
  Version,
} from '../shared/entity.js'
import type { ResourceKind } from '../shared/enum.js'
import { InvalidArgumentError, InvalidStateError, NotFoundError, NotImplementedError } from '../shared/error.js'
import { number, optionalNumber, text } from './row.js'
import type { Row } from './row.js'

/** The `request.method` a resource request is filed under. */
export const RequestMethod = 'resource'

/** Every `ResourceKind` `register` accepts. */
const ResourceKindRegistry: Readonly<Record<ResourceKind, true>> = {
  file: true,
  image: true,
  text: true,
  binary: true,
}

/** `MergeStrategy` values `merge` recognises. */
const MergeStrategies: readonly MergeStrategy[] = ['ours', 'theirs', 'manual']

/**
 * A lock row has no resource column, so a resource lock's durable key is
 * `resource:<identity>:<subject>` (see the module header).
 */
const LockPrefix = 'resource'

/* ------------------------------------------------------------------------- *
 * Row mappers (the shared row module has no mappers for these tables)
 * ------------------------------------------------------------------------- */

export function mapResource(row: Row): Resource {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    session: number(row, 'session'),
    kind: text(row, 'kind', 'file') as ResourceKind,
    path: text(row, 'path'),
    ...(row.media === null || row.media === undefined ? {} : { media: text(row, 'media') }),
    bytes: number(row, 'bytes'),
    created: number(row, 'created'),
    changed: number(row, 'changed'),
  }
}

export function mapVersion(row: Row): Version {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    resource: number(row, 'resource'),
    version: number(row, 'version'),
    content: text(row, 'content'),
    author: text(row, 'author'),
    created: number(row, 'created'),
  }
}

export function mapVision(row: Row): ResourceVision {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    session: number(row, 'session'),
    resource: number(row, 'resource'),
    version: number(row, 'version'),
    created: number(row, 'created'),
  }
}

export function mapLock(row: Row): Lock {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    session: number(row, 'session'),
    subject: text(row, 'subject'),
    mode: text(row, 'mode', 'exclusive') as Lock['mode'],
    lease: number(row, 'lease'),
    heartbeat: number(row, 'heartbeat'),
    created: number(row, 'created'),
    ...(row.ended === null || row.ended === undefined ? {} : { ended: number(row, 'ended') }),
  }
}

export function mapRequest(row: Row): Request {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    session: number(row, 'session'),
    ...(row.thread === null || row.thread === undefined ? {} : { thread: number(row, 'thread') }),
    method: text(row, 'method'),
    payload: text(row, 'payload'),
    status: text(row, 'status', 'pending') as Request['status'],
    created: number(row, 'created'),
    ...(row.finished === null || row.finished === undefined ? {} : { finished: number(row, 'finished') }),
  }
}

export function mapThread(row: Row): Thread {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    session: number(row, 'session'),
    name: text(row, 'name'),
    status: text(row, 'status', 'active') as Thread['status'],
    created: number(row, 'created'),
    ...(row.ended === null || row.ended === undefined ? {} : { ended: number(row, 'ended') }),
  }
}

export function mapResult(row: Row): Result {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    request: number(row, 'request'),
    status: text(row, 'status', 'ok') as Result['status'],
    content: text(row, 'content'),
    created: number(row, 'created'),
  }
}

/* ------------------------------------------------------------------------- *
 * Resource module
 * ------------------------------------------------------------------------- */

export class ResourceModule {
  private readonly host: ModuleHost
  /**
   * Base edges this process recorded: version identity -> base version
   * identity, or 0 for a root. `version` has no `base` column, so the DAG edge
   * cannot be persisted (module header).
   */
  private readonly baseEdges = new Map<number, number>()

  constructor(host: ModuleHost) {
    this.host = host
  }

  /* ----------------------------------------------------------------------- *
   * Resource identity
   * ----------------------------------------------------------------------- */

  /** One resource by its public handle. */
  resolve(handle: string): Resource {
    const cleaned = typeof handle === 'string' ? handle.trim() : ''
    if (cleaned.length === 0) throw new InvalidArgumentError('resource handle must be a non-empty string')
    const row = this.host.db.get<Row>('SELECT * FROM resource WHERE handle = ?', cleaned)
    if (row === undefined) throw new NotFoundError('resource', cleaned)
    return mapResource(row)
  }

  /**
   * Register one path for a session. `(session, path)` is the identity: a second
   * registration returns the existing resource and never rewrites its kind or
   * media, so a resource keeps the classification it was created with.
   */
  register(session: number, path: string, media: string, kind: ResourceKind): Resource {
    assertIdentity('session', session)
    const resourcePath = requireText('resource path', path)
    if (!isResourceKind(kind)) {
      throw new InvalidArgumentError(`unknown resource kind: ${String(kind)}`, {
        allowed: Object.keys(ResourceKindRegistry),
      })
    }
    this.requireSession(session)
    const mediaType = typeof media === 'string' ? media.trim() : ''
    const now = this.host.clock.now()
    const outcome = this.host.db.transaction(() => {
      const existing = this.host.db.get<Row>(
        'SELECT * FROM resource WHERE session = ? AND path = ? ORDER BY identity ASC LIMIT 1',
        session,
        resourcePath,
      )
      if (existing !== undefined) return { resource: mapResource(existing), created: false }
      const identity = this.host.db.insert('resource', {
        handle: this.host.handles.next('resource'),
        session,
        kind,
        path: resourcePath,
        ...(mediaType.length === 0 ? {} : { media: mediaType }),
        bytes: 0,
        created: now,
        changed: now,
      })
      return { resource: mapResource(this.requireResource(identity)), created: true }
    })
    if (outcome.created) this.host.events.emit('resource/registered', outcome.resource)
    return outcome.resource
  }

  /* ----------------------------------------------------------------------- *
   * Vision
   * ----------------------------------------------------------------------- */

  /**
   * Record this session's view of the resource: one row per (session, resource),
   * refreshed in place to the current version. A resource with no version has
   * nothing to observe and is refused.
   */
  vision(session: number, resource: number): ResourceVision {
    assertIdentity('session', session)
    assertIdentity('resource', resource)
    this.requireSession(session)
    this.requireResource(resource)
    const currentRow = this.currentVersionRow(resource)
    if (currentRow === undefined) {
      throw new InvalidStateError(`resource ${resource} has no version to observe; write a version first`, {
        session,
        resource,
      })
    }
    const now = this.host.clock.now()
    const row = this.host.db.transaction(() => this.observe(session, resource, number(currentRow, 'identity'), now))
    return mapVision(row)
  }

  /* ----------------------------------------------------------------------- *
   * Version DAG
   * ----------------------------------------------------------------------- */

  /**
   * Append one version. `base` defaults to the current version; an explicit base
   * must name an existing version number of this resource and may be older than
   * current, which records a branch. Old rows are never updated.
   */
  write(session: number, resource: number, content: Uint8Array, base?: number): Version {
    assertIdentity('session', session)
    assertIdentity('resource', resource)
    const bytes = asBytes(content)
    const sessionRow = this.requireSession(session)
    const resourceRow = this.requireResource(resource)
    const encoded = this.encode(resourceRow, bytes)
    const author = authorOf(sessionRow, session)
    const now = this.host.clock.now()
    const outcome = this.host.db.transaction(() => {
      const currentRow = this.currentVersionRow(resource)
      const currentNumber = currentRow === undefined ? 0 : number(currentRow, 'version')
      const baseNumber = base === undefined ? currentNumber : requireVersionNumber('base', base)
      if (baseNumber > currentNumber) {
        throw new InvalidArgumentError(
          `base version ${baseNumber} does not exist for resource ${resource}; current version is ${currentNumber}`,
          { resource, base: baseNumber, current: currentNumber },
        )
      }
      const baseIdentity = baseNumber === 0 ? 0 : this.versionIdentityOf(resource, baseNumber)
      const identity = this.host.db.insert('version', {
        handle: this.host.handles.next('version'),
        resource,
        version: currentNumber + 1,
        content: encoded,
        author,
        created: now,
      })
      this.host.db.update('resource', { bytes: bytes.byteLength, changed: now }, 'identity = ?', resource)
      // A writer has observed the version it just produced; keeping the vision
      // in step is what makes `merge` divergence mean "this session is behind".
      this.observe(session, resource, identity, now)
      return { identity, baseIdentity }
    })
    this.baseEdges.set(outcome.identity, outcome.baseIdentity)
    const version = mapVersion(this.requireVersion(outcome.identity))
    this.host.events.emit('resource/written', version)
    return version
  }

  /**
   * Every version of a resource, oldest first. The rows are immutable, so this
   * is the whole history including any branch recorded by a stale `base`.
   */
  versions(resource: number): Version[] {
    assertIdentity('resource', resource)
    this.requireResource(resource)
    return this.host.db
      .all<Row>('SELECT * FROM version WHERE resource = ? ORDER BY version ASC, identity ASC', resource)
      .map(mapVersion)
  }

  /** The version the resource currently points at, or `undefined` when empty. */
  current(resource: number): Version | undefined {
    assertIdentity('resource', resource)
    this.requireResource(resource)
    const row = this.currentVersionRow(resource)
    return row === undefined ? undefined : mapVersion(row)
  }

  /**
   * The version a version was written on top of, as observed by this process.
   * The first version of a resource is a root and has no base; the edge of a
   * version written by an earlier process is not recoverable (no column) and is
   * reported as absent rather than guessed.
   */
  base(version: number): Version | undefined {
    const versionRow = this.requireVersion(version)
    if (number(versionRow, 'version') === 1) return undefined
    const edge = this.baseEdges.get(number(versionRow, 'identity'))
    if (edge === undefined || edge === 0) return undefined
    const row = this.host.db.get<Row>('SELECT * FROM version WHERE identity = ?', edge)
    return row === undefined ? undefined : mapVersion(row)
  }

  /** The bytes one version stored, decoded by the same rule `write` used. */
  bytes(version: number): Uint8Array {
    const { versionRow, resourceRow } = this.versionContext(version)
    return this.decode(resourceRow, text(versionRow, 'content'))
  }

  /** Byte length of one version's content. */
  size(version: number): number {
    return this.bytes(version).byteLength
  }

  /** sha256 (hex) of one version's bytes. */
  hash(version: number): string {
    return createHash('sha256').update(this.bytes(version)).digest('hex')
  }

  /* ----------------------------------------------------------------------- *
   * Merge
   * ----------------------------------------------------------------------- */

  /**
   * Attempt a merge. The schema holds no "their" side, so only `ours` can be
   * honoured; `theirs` writes nothing and reports why (module header). The
   * returned version is always the version that remains current.
   */
  merge(session: number, resource: number, strategy: MergeStrategy): MergeResult {
    assertIdentity('session', session)
    assertIdentity('resource', resource)
    if (!MergeStrategies.includes(strategy)) {
      throw new InvalidArgumentError(`unknown merge strategy: ${String(strategy)}`, {
        allowed: [...MergeStrategies],
      })
    }
    this.requireSession(session)
    this.requireResource(resource)
    const currentRow = this.currentVersionRow(resource)
    if (currentRow === undefined) {
      throw new InvalidStateError(`resource ${resource} has no version to merge`, { session, resource })
    }
    const current = mapVersion(currentRow)
    if (strategy === 'manual') {
      throw new NotImplementedError('manual merge: this module has no operator-supplied second content to apply')
    }
    if (strategy === 'ours') return { version: current, conflicts: [] }

    // `theirs`: no second content exists anywhere in the schema, so nothing is
    // written and the conflict names the truth first, the divergence second.
    const conflicts = ['theirs has no source version']
    const observed = this.viewOf(session, resource)
    if (observed !== undefined) {
      const observedIdentity = number(observed, 'version')
      if (observedIdentity !== current.identity) {
        const observedRow = this.host.db.get<Row>('SELECT * FROM version WHERE identity = ?', observedIdentity)
        const observedLabel =
          observedRow === undefined ? `identity ${observedIdentity}` : `version ${number(observedRow, 'version')}`
        conflicts.push(
          `session ${session} last observed ${observedLabel}; current is version ${current.version}; nothing was merged`,
        )
      }
    }
    return { version: current, conflicts }
  }

  /* ----------------------------------------------------------------------- *
   * Locks
   * ----------------------------------------------------------------------- */

  /**
   * Take the exclusive lock on a resource for `subject`. The effective lease is
   * the requested one (or `config.defaultLease` when absent/invalid), capped by
   * `config.defaultLease`; expired locks are released first. A different subject
   * on the same resource fails closed; the same subject re-locks idempotently.
   */
  lockResource(resource: number, subject: string, lease: number): Lock {
    assertIdentity('resource', resource)
    const holder = requireText('lock subject', subject)
    const resourceRow = this.requireResource(resource)
    const configured = this.host.config.defaultLease
    if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
      // A lock whose lease cannot expire would fail open; refuse instead.
      throw new InvalidStateError(
        'config.defaultLease must be a positive number of milliseconds; refusing to take a resource lock',
        { defaultLease: configured },
      )
    }
    const requested =
      typeof lease === 'number' && Number.isFinite(lease) && lease > 0 ? Math.floor(lease) : configured
    const effective = Math.min(requested, configured)
    const now = this.host.clock.now()
    const key = lockKey(resource, holder)
    const prefix = `${LockPrefix}:${resource}:`
    const outcome = this.host.db.transaction(() => {
      this.sweepExpired(now)
      const active = this.host.db.all<Row>('SELECT * FROM lock WHERE ended IS NULL ORDER BY identity ASC')
      for (const row of active) {
        const stored = text(row, 'subject')
        if (stored === key) return { lock: mapLock(row), created: false }
        if (!stored.startsWith(prefix)) continue
        const owner = stored.slice(prefix.length)
        throw new InvalidStateError(`resource ${resource} is already locked by "${owner}"`, {
          resource,
          subject: owner,
          lock: number(row, 'identity'),
          deadline: number(row, 'heartbeat') + number(row, 'lease'),
        })
      }
      const identity = this.host.db.insert('lock', {
        handle: this.host.handles.next('lock'),
        session: number(resourceRow, 'session'),
        subject: key,
        mode: 'exclusive',
        lease: effective,
        heartbeat: now,
        created: now,
      })
      return { lock: mapLock(this.requireLock(identity)), created: true }
    })
    if (outcome.created) this.host.events.emit('resource/locked', outcome.lock)
    return outcome.lock
  }

  /** Release one lock. Releasing an already released lock is a no-op. */
  releaseLock(lock: number): void {
    assertIdentity('lock', lock)
    const row = this.requireLock(lock)
    if (optionalNumber(row, 'ended') !== undefined) return
    const now = this.host.clock.now()
    this.host.db.update('lock', { ended: now }, 'identity = ? AND ended IS NULL', lock)
    this.host.events.emit('resource/released', mapLock(this.requireLock(lock)))
  }

  /**
   * Release every lock whose lease ran out and return how many were released.
   * `ended` is stamped with the sweep time; the lease deadline stays derivable
   * as `heartbeat + lease`. Called by the service lifecycle.
   */
  cleanupExpired(): number {
    const now = this.host.clock.now()
    return this.host.db.transaction(() => this.sweepExpired(now))
  }

  /* ----------------------------------------------------------------------- *
   * Threads, requests, results
   * ----------------------------------------------------------------------- */

  /**
   * Open one active thread about a resource. The turn must exist and belong to
   * the resource's session; `thread` has no resource or turn column, so the
   * thread itself is session-scoped and those two facts are only validated.
   */
  thread(resource: number, turn: number, title: string): Thread {
    assertIdentity('resource', resource)
    assertIdentity('turn', turn)
    const name = requireText('thread title', title)
    const resourceRow = this.requireResource(resource)
    const turnRow = this.host.db.get<Row>('SELECT * FROM turn WHERE identity = ?', turn)
    if (turnRow === undefined) throw new NotFoundError('turn', turn)
    const owner = number(resourceRow, 'session')
    if (number(turnRow, 'session') !== owner) {
      throw new InvalidStateError(
        `turn ${turn} belongs to session ${number(turnRow, 'session')}; resource ${resource} belongs to session ${owner}`,
        { resource, turn, session: owner },
      )
    }
    const now = this.host.clock.now()
    const identity = this.host.db.insert('thread', {
      handle: this.host.handles.next('thread'),
      session: owner,
      name,
      status: 'active',
      created: now,
    })
    const thread = mapThread(this.requireThread(identity))
    this.host.events.emit('resource/thread', thread)
    return thread
  }

  /**
   * File one pending request about a resource. `request` has no resource column,
   * so the resource (identity, handle, path) and the reason travel in the JSON
   * payload under `method = 'resource'`. The row is pending until a result links
   * it to a thread.
   */
  request(resource: number, session: number, reason: string): Request {
    assertIdentity('resource', resource)
    assertIdentity('session', session)
    const why = requireText('request reason', reason)
    const resourceRow = this.requireResource(resource)
    this.requireSession(session)
    const payload = JSON.stringify({
      resource: number(resourceRow, 'identity'),
      handle: text(resourceRow, 'handle'),
      path: text(resourceRow, 'path'),
      reason: why,
    })
    const identity = this.host.db.insert('request', {
      handle: this.host.handles.next('request'),
      session,
      method: RequestMethod,
      payload,
      status: 'pending',
      created: this.host.clock.now(),
    })
    const request = mapRequest(this.requireRequest(identity))
    this.host.events.emit('resource/requested', request)
    return request
  }

  /**
   * Answer the pending request of a thread: link the newest pending request of
   * the thread's session (one already linked to the thread wins) to the thread,
   * mark it `done`, stamp `finished` and store one `ok` result — in one
   * transaction. Without a pending request the call is refused; no request is
   * invented and no other session's request is stolen.
   */
  result(thread: number, content: string): Result {
    assertIdentity('thread', thread)
    if (typeof content !== 'string') throw new InvalidArgumentError('result content must be a string')
    const threadRow = this.requireThread(thread)
    if (text(threadRow, 'status') === 'ended') {
      throw new InvalidStateError(`thread ${thread} has ended; it cannot carry a new result`, { thread })
    }
    const now = this.host.clock.now()
    const identity = this.host.db.transaction(() => {
      const linked = this.host.db.get<Row>(
        "SELECT * FROM request WHERE thread = ? AND status = 'pending' ORDER BY identity DESC LIMIT 1",
        thread,
      )
      const requestRow =
        linked ??
        this.host.db.get<Row>(
          "SELECT * FROM request WHERE session = ? AND status = 'pending' AND thread IS NULL ORDER BY identity DESC LIMIT 1",
          number(threadRow, 'session'),
        )
      if (requestRow === undefined) {
        throw new InvalidStateError(`thread ${thread} has no pending request to carry a result`, {
          thread,
          session: number(threadRow, 'session'),
        })
      }
      const requestIdentity = number(requestRow, 'identity')
      this.host.db.update('request', { thread, status: 'done', finished: now }, 'identity = ?', requestIdentity)
      return this.host.db.insert('result', {
        handle: this.host.handles.next('result'),
        request: requestIdentity,
        status: 'ok',
        content,
        created: now,
      })
    })
    const result = mapResult(this.requireResult(identity))
    this.host.events.emit('resource/resulted', result)
    return result
  }

  /* ----------------------------------------------------------------------- *
   * Internal helpers
   * ----------------------------------------------------------------------- */

  private requireSession(session: number): Row {
    return this.host.db.require<Row>('session', session, 'session')
  }

  private requireResource(resource: number): Row {
    return this.host.db.require<Row>('resource', resource, 'resource')
  }

  private requireVersion(version: number): Row {
    return this.host.db.require<Row>('version', version, 'version')
  }

  private requireLock(lock: number): Row {
    return this.host.db.require<Row>('lock', lock, 'lock')
  }

  private requireThread(thread: number): Row {
    return this.host.db.require<Row>('thread', thread, 'thread')
  }

  private requireRequest(request: number): Row {
    return this.host.db.require<Row>('request', request, 'request')
  }

  private requireResult(result: number): Row {
    return this.host.db.require<Row>('result', result, 'result')
  }

  /** Highest-numbered version of a resource, or `undefined` when it is empty. */
  private currentVersionRow(resource: number): Row | undefined {
    return this.host.db.get<Row>(
      'SELECT * FROM version WHERE resource = ? ORDER BY version DESC, identity DESC LIMIT 1',
      resource,
    )
  }

  /** The identity of one version number of a resource. */
  private versionIdentityOf(resource: number, versionNumber: number): number {
    const row = this.host.db.get<Row>(
      'SELECT identity FROM version WHERE resource = ? AND version = ? ORDER BY identity ASC LIMIT 1',
      resource,
      versionNumber,
    )
    if (row === undefined) {
      throw new InvalidArgumentError(`version ${versionNumber} does not exist for resource ${resource}`, {
        resource,
        version: versionNumber,
      })
    }
    return number(row, 'identity')
  }

  /** One version row plus the resource row its encoding depends on. */
  private versionContext(version: number): { versionRow: Row; resourceRow: Row } {
    assertIdentity('version', version)
    const versionRow = this.requireVersion(version)
    return { versionRow, resourceRow: this.requireResource(number(versionRow, 'resource')) }
  }

  private viewOf(session: number, resource: number): Row | undefined {
    return this.host.db.get<Row>(
      'SELECT * FROM vision WHERE session = ? AND resource = ? ORDER BY identity ASC LIMIT 1',
      session,
      resource,
    )
  }

  /** Upsert the session's view of a resource; one row per (session, resource). */
  private observe(session: number, resource: number, versionIdentity: number, now: number): Row {
    const existing = this.viewOf(session, resource)
    if (existing === undefined) {
      const identity = this.host.db.insert('vision', {
        handle: this.host.handles.next('vision'),
        session,
        resource,
        version: versionIdentity,
        created: now,
      })
      return this.host.db.require<Row>('vision', identity, 'vision')
    }
    const identity = number(existing, 'identity')
    this.host.db.update('vision', { version: versionIdentity, created: now }, 'identity = ?', identity)
    return this.host.db.require<Row>('vision', identity, 'vision')
  }

  /** Release every open lock whose lease ran out; returns the released count. */
  private sweepExpired(now: number): number {
    const rows = this.host.db.all<Row>('SELECT * FROM lock WHERE ended IS NULL')
    let released = 0
    for (const row of rows) {
      const deadline = number(row, 'heartbeat') + number(row, 'lease')
      if (deadline > now) continue
      this.host.db.update('lock', { ended: now }, 'identity = ? AND ended IS NULL', number(row, 'identity'))
      released += 1
    }
    return released
  }

  /** Whether a resource stores readable text (UTF-8) instead of base64. */
  private textLike(resourceRow: Row): boolean {
    if (text(resourceRow, 'kind', 'file') === 'text') return true
    return text(resourceRow, 'media').toLowerCase().startsWith('text/')
  }

  /** Encode bytes for the TEXT `content` column; text resources must be UTF-8. */
  private encode(resourceRow: Row, bytes: Uint8Array): string {
    if (!this.textLike(resourceRow)) return Buffer.from(bytes).toString('base64')
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      throw new InvalidArgumentError(
        'content is not valid UTF-8 for a text resource; register it as binary to store base64',
        { resource: number(resourceRow, 'identity'), kind: text(resourceRow, 'kind'), bytes: bytes.byteLength },
      )
    }
  }

  /** Decode a stored version content back to the exact bytes `write` received. */
  private decode(resourceRow: Row, content: string): Uint8Array {
    if (!this.textLike(resourceRow)) return new Uint8Array(Buffer.from(content, 'base64'))
    return new TextEncoder().encode(content)
  }
}

/* ------------------------------------------------------------------------- *
 * Local helpers
 * ------------------------------------------------------------------------- */

function assertIdentity(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentError(`${name} must be a positive integer identity`)
  }
}

function requireText(name: string, value: unknown): string {
  const cleaned = typeof value === 'string' ? value.trim() : ''
  if (cleaned.length === 0) throw new InvalidArgumentError(`${name} must be a non-empty string`)
  return cleaned
}

function requireVersionNumber(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidArgumentError(`${name} must be a non-negative integer version number`)
  }
  return value
}

function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && Object.hasOwn(ResourceKindRegistry, value)
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  throw new InvalidArgumentError('content must be a Uint8Array (a Buffer is accepted)')
}

/** The version author: the writing session's DSH handle. */
function authorOf(sessionRow: Row, session: number): string {
  const handle = text(sessionRow, 'handle')
  return handle.length === 0 ? `session-${session}` : handle
}

/** The durable lock key that scopes a subject to one resource. */
function lockKey(resource: number, subject: string): string {
  return `${LockPrefix}:${resource}:${subject}`
}
