/**
 * Resource module tests: the append-only version DAG, per-session vision,
 * resource locks, and the request/result thread ledger.
 *
 * Everything runs against an in-memory coordination database and a manual
 * clock: no DSH process, no network, no compiled bundle. Sessions and turns are
 * created with plain SQL inserts, which is exactly what the module may assume
 * about rows another owner writes.
 *
 * The merge tests pin the documented limitation rather than a wish: the schema
 * has no second content source, so `theirs` writes nothing and names the real
 * divergence the ledger can see (the caller's last observed version).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { ResourceModule } from '../src/host/resource.js'
import type { CoordinationConfig } from '../src/host/config.js'
import { CoordinationDatabase } from '../src/host/database.js'
import { ManualClock } from '../src/host/handle.js'
import { createModuleHost } from '../src/host/module.js'
import type { ModuleHost, TraceWriter } from '../src/host/module.js'
import type { Row } from '../src/host/row.js'
import { InvalidArgumentError, InvalidStateError, NotFoundError, NotImplementedError } from '../src/shared/error.js'

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

/** The schema-mirroring defaults, written out so tests never load schemastery. */
function testConfig(defaultLease = 30_000): CoordinationConfig {
  return {
    database: 'coordination',
    databasePath: '',
    maxTurnPerSession: 1000,
    defaultLease,
    clarifyTimeout: 30_000,
    profession: {
      enabled: true,
      lock: true,
      default: 'execution',
      rebuildCanReselect: true,
      abandonCanReselect: true,
      audit: true,
      errorHint: true,
    },
    plan: {
      threshold: 0.5,
      maxRebuild: 3,
      weights: {
        feasibility: 0.15,
        coverage: 0.15,
        clarity: 0.1,
        specificity: 0.1,
        alignment: 0.2,
        risk: 0.1,
        cost: 0.1,
        efficiency: 0.1,
      },
      dimensions: {
        feasibility: 0.5,
        coverage: 0.6,
        clarity: 0.5,
        specificity: 0.5,
        alignment: 0.7,
        risk: 0.7,
        cost: 0.8,
        efficiency: 0.5,
      },
    },
    orchestration: {
      maxReject: 2,
      maxSubTask: 32,
      groundTruth: true,
      groundTruthTimeout: 5000,
      allowShellGroundTruth: false,
      modelRouting: true,
    },
    cache: { enabled: true, ttl: 60_000, fingerprintWindow: 50, effortWarning: true },
    bayesian: { prior: 0.5, stopEntropy: 0.05, infoGain: 0.01, maxRoutes: 12, calibrationFloor: 0.1 },
    comprehension: { stageTimeout: 30_000, searchEnabled: true, maxEvidence: 8, highHistoryWindow: 50 },
    ui: { toolbar: true, showTooltip: true, takeover: false, refreshInterval: 5000, compact: true },
    defaults: { profession: 'execution', interaction: 'think', scene: 'dialogue', validation: 'medium', command: 'none' },
  }
}

/** The resource module never writes the governance trace (no turn argument). */
const unusedTrace: TraceWriter = {
  append: () => {
    throw new Error('resource module does not append trace events')
  },
  list: () => [],
  verify: () => ({ ok: true }),
}

function makeHost(options: { clock?: ManualClock; defaultLease?: number } = {}): {
  host: ModuleHost
  clock: ManualClock
  resources: ResourceModule
} {
  const clock = options.clock ?? new ManualClock()
  const host = createModuleHost({
    db: new CoordinationDatabase(':memory:'),
    config: testConfig(options.defaultLease),
    trace: unusedTrace,
    clock,
  })
  return { host, clock, resources: new ResourceModule(host) }
}

/** One coordination session row, created exactly as another module would. */
function addSession(host: ModuleHost, id: string): number {
  return host.db.insert('session', {
    handle: id,
    principal: 'local',
    sandbox: '',
    interaction: 'think',
    scene: 'dialogue',
    validation: 'medium',
    profile: '',
    generation: 1,
    status: 'active',
    created: host.clock.now(),
  })
}

/** One coordination turn row, needed because `thread` takes a turn. */
function addTurn(host: ModuleHost, session: number, ordinal: number): number {
  return host.db.insert('turn', {
    handle: `turn-${session}-${ordinal}`,
    session,
    ordinal,
    interaction: 'think',
    scene: 'dialogue',
    validation: 'medium',
    profession: 'execution',
    command: 'none',
    created: host.clock.now(),
  })
}

/** UTF-8 bytes, the common case for a text resource. */
function bytesOf(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/* ------------------------------------------------------------------------- *
 * Resource identity
 * ------------------------------------------------------------------------- */

test('register creates one resource per (session, path) and resolve finds it by handle', (t) => {
  const { host, resources } = makeHost()
  t.after(() => host.db.close())
  const session = addSession(host, 'dsh-session-a')
  const other = addSession(host, 'dsh-session-b')

  const resource = resources.register(session, '/work/plan.md', 'text/markdown', 'text')
  assert.equal(resource.session, session)
  assert.equal(resource.path, '/work/plan.md')
  assert.equal(resource.kind, 'text')
  assert.equal(resource.media, 'text/markdown')
  assert.equal(resource.bytes, 0, 'a fresh resource has no content yet')
  assert.equal(resource.created, host.clock.now())
  assert.equal(resource.changed, resource.created)
  assert.match(resource.handle, /^coordination-resource-/)

  const again = resources.register(session, '/work/plan.md', '', 'file')
  assert.equal(again.identity, resource.identity, 'the path is the register key')
  assert.equal(again.kind, 'text', 'a second register never rewrites the classification')
  assert.equal(again.media, 'text/markdown')
  assert.equal(host.db.count('resource'), 1)

  const separate = resources.register(other, '/work/plan.md', 'text/markdown', 'text')
  assert.notEqual(separate.identity, resource.identity, 'the same path in another session is another resource')
  assert.equal(host.db.count('resource'), 2)

  assert.deepEqual(resources.resolve(resource.handle), resource)
  assert.equal(resources.current(resource.identity), undefined, 'no versions yet')
  assert.deepEqual(resources.versions(resource.identity), [])

  assert.throws(() => resources.resolve('missing'), (error: unknown) => error instanceof NotFoundError)
  assert.throws(() => resources.resolve('  '), (error: unknown) => error instanceof InvalidArgumentError)
  assert.throws(() => resources.register(session + 99, '/x', '', 'text'), (error: unknown) => error instanceof NotFoundError)
  assert.throws(() => resources.register(session, '   ', '', 'text'), (error: unknown) => error instanceof InvalidArgumentError)
  assert.throws(
    () => resources.register(session, '/x', '', 'video' as never),
    (error: unknown) => error instanceof InvalidArgumentError,
  )
})

/* ------------------------------------------------------------------------- *
 * Version DAG
 * ------------------------------------------------------------------------- */

test('write appends an immutable version chain, moves current and records the hash', (t) => {
  const { host, clock, resources } = makeHost()
  t.after(() => host.db.close())
  const session = addSession(host, 'dsh-session-a')
  const resource = resources.register(session, '/work/plan.md', 'text/markdown', 'text')

  const first = resources.write(session, resource.identity, bytesOf('# plan\n'))
  assert.equal(first.version, 1)
  assert.equal(first.resource, resource.identity)
  assert.equal(first.content, '# plan\n', 'a text resource stores its UTF-8 text')
  assert.equal(first.author, 'dsh-session-a', 'the writing session is the author')
  assert.equal(first.created, clock.now())
  assert.equal(resources.current(resource.identity)?.identity, first.identity)
  assert.deepEqual(resources.versions(resource.identity).map((version) => version.version), [1])
  assert.equal(resources.base(first.identity), undefined, 'the first version is a root')
  assert.equal(resources.size(first.identity), 7)
  assert.equal(resources.hash(first.identity), sha256(bytesOf('# plan\n')))
  assert.equal(host.db.get<Row>('SELECT bytes FROM resource WHERE identity = ?', resource.identity)?.bytes, 7)

  clock.advance(1000)
  const second = resources.write(session, resource.identity, bytesOf('# plan v2\n'))
  assert.equal(second.version, 2, 'the DAG number advances by one')
  assert.equal(second.created, first.created + 1000)
  assert.equal(resources.base(second.identity)?.identity, first.identity, 'the default base is the current version')
  assert.deepEqual(resources.versions(resource.identity).map((version) => version.version), [1, 2])
  assert.equal(resources.current(resource.identity)?.identity, second.identity)
  assert.equal(resources.hash(second.identity), sha256(bytesOf('# plan v2\n')))

  // The first row was not touched: append-only is a fact, not a convention.
  const storedFirst = host.db.get<Row>('SELECT * FROM version WHERE identity = ?', first.identity)
  assert.equal(storedFirst?.version, 1)
  assert.equal(storedFirst?.content, '# plan\n')
  assert.equal(storedFirst?.author, 'dsh-session-a')
  assert.equal(storedFirst?.created, first.created)
  assert.equal(host.db.count('version'), 2)

  // The resource points at the current version's size and last change.
  const resourceRow = host.db.get<Row>('SELECT * FROM resource WHERE identity = ?', resource.identity)
  assert.equal(resourceRow?.bytes, 10, 'resource.bytes mirrors the current version')
  assert.equal(resourceRow?.changed, second.created)

  assert.throws(() => resources.current(resource.identity + 99), (error: unknown) => error instanceof NotFoundError)
  assert.throws(() => resources.versions(resource.identity + 99), (error: unknown) => error instanceof NotFoundError)
  assert.throws(() => resources.hash(9999), (error: unknown) => error instanceof NotFoundError)
})

test('an explicit stale base records a branch without rewriting history', (t) => {
  const { host, resources } = makeHost()
  t.after(() => host.db.close())
  const session = addSession(host, 'dsh-session-a')
  const resource = resources.register(session, '/work/plan.md', 'text/markdown', 'text')

  const first = resources.write(session, resource.identity, bytesOf('one'))
  const second = resources.write(session, resource.identity, bytesOf('two'))
  const branch = resources.write(session, resource.identity, bytesOf('three'), 1)

  assert.equal(branch.version, 3, 'the append is still linear in numbers')
  assert.equal(resources.base(branch.identity)?.identity, first.identity, 'the branch remembers the older base')
  assert.equal(resources.base(second.identity)?.identity, first.identity)
  assert.deepEqual(resources.versions(resource.identity).map((version) => version.version), [1, 2, 3])
  assert.equal(resources.current(resource.identity)?.identity, branch.identity, 'the last writer owns the pointer')
  assert.equal(host.db.count('version'), 3)
  assert.equal(host.db.get<Row>('SELECT content FROM version WHERE identity = ?', second.identity)?.content, 'two')

  assert.throws(
    () => resources.write(session, resource.identity, bytesOf('four'), 4),
    (error: unknown) => error instanceof InvalidArgumentError,
    'a base that does not exist is refused',
  )
  assert.throws(
    () => resources.write(session, resource.identity, bytesOf('four'), -1),
    (error: unknown) => error instanceof InvalidArgumentError,
  )
  assert.throws(
    () => resources.write(session, resource.identity, bytesOf('four'), 1.5),
    (error: unknown) => error instanceof InvalidArgumentError,
  )
  assert.throws(
    () => resources.write(session, resource.identity, 'text' as never),
    (error: unknown) => error instanceof InvalidArgumentError,
  )
  assert.throws(() => resources.write(session, resource.identity + 99, bytesOf('x')), NotFoundError)
  assert.throws(() => resources.write(session + 99, resource.identity, bytesOf('x')), NotFoundError)
  assert.throws(() => resources.base(9999), (error: unknown) => error instanceof NotFoundError)
})

test('a non-text resource stores base64 and round-trips its bytes exactly', (t) => {
  const { host, resources } = makeHost()
  t.after(() => host.db.close())
  const session = addSession(host, 'dsh-session-a')
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xfa, 0xfb, 0xfc])

  const binary = resources.register(session, '/work/blob.bin', 'application/octet-stream', 'binary')
  const binaryVersion = resources.write(session, binary.identity, bytes)
  assert.match(binaryVersion.content, /^[A-Za-z0-9+/]+=*$/, 'binary content is stored as base64')
  assert.deepEqual([...resources.bytes(binaryVersion.identity)], [...bytes], 'bytes round-trip')
  assert.equal(resources.size(binaryVersion.identity), 6)
  assert.equal(resources.hash(binaryVersion.identity), sha256(bytes))

  // A BOM is content, not something to normalise away.
  const text = resources.register(session, '/work/note.txt', 'text/plain', 'text')
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x41])
  const bomVersion = resources.write(session, text.identity, bom)
  assert.equal(bomVersion.content, '\uFEFFA')
  assert.deepEqual([...resources.bytes(bomVersion.identity)], [...bom])
  assert.equal(resources.size(bomVersion.identity), 4)

  // `kind: 'file'` with a text media type is text; invalid UTF-8 is refused, never corrupted.
  const file = resources.register(session, '/work/readme', 'text/plain', 'file')
  const fileVersion = resources.write(session, file.identity, bytesOf('hello'))
  assert.equal(fileVersion.content, 'hello')
  assert.throws(
    () => resources.write(session, file.identity, new Uint8Array([0xff, 0xfe])),
    (error: unknown) => error instanceof InvalidArgumentError,
  )
  assert.equal(resources.current(file.identity)?.identity, fileVersion.identity, 'the failed write changed nothing')
  assert.equal(host.db.count('version'), 3)
})

/* ------------------------------------------------------------------------- *
 * Vision
 * ------------------------------------------------------------------------- */

test('vision upserts one row per (session, resource) and follows current', (t) => {
  const { host, clock, resources } = makeHost()
  t.after(() => host.db.close())
  const session = addSession(host, 'dsh-session-a')
  const other = addSession(host, 'dsh-session-b')
  const resource = resources.register(session, '/work/plan.md', 'text/markdown', 'text')

  assert.throws(
    () => resources.vision(session, resource.identity),
    (error: unknown) => error instanceof InvalidStateError,
    'there is no version to observe yet',
  )

  const first = resources.write(session, resource.identity, bytesOf('one'))
  // write observes its own version, so the first vision read is already current.
  const seen = resources.vision(session, resource.identity)
  assert.equal(seen.session, session)
  assert.equal(seen.resource, resource.identity)
  assert.equal(seen.version, first.identity, 'vision.version is the version identity')
  assert.equal(seen.created, clock.now())

  clock.advance(500)
  const second = resources.write(session, resource.identity, bytesOf('two'))
  clock.advance(500)
  const refreshed = resources.vision(session, resource.identity)
  assert.equal(refreshed.identity, seen.identity, 'one row per (session, resource)')
  assert.equal(refreshed.version, second.identity)
  assert.equal(refreshed.created, clock.now(), 'created is the last observation time')
  assert.equal(host.db.count('vision'), 1)

  const foreign = resources.vision(other, resource.identity)
  assert.notEqual(foreign.identity, seen.identity, 'a session owns its own view')
  assert.equal(foreign.version, second.identity)
  assert.equal(host.db.count('vision'), 2)

  assert.throws(() => resources.vision(session + 99, resource.identity), (error: unknown) => error instanceof NotFoundError)
  assert.throws(() => resources.vision(session, resource.identity + 99), (error: unknown) => error instanceof NotFoundError)
  assert.throws(
    () => resources.vision(session, 9999),
    (error: unknown) => error instanceof NotFoundError,
  )
  assert.throws(() => resources.vision(0, resource.identity), (error: unknown) => error instanceof InvalidArgumentError)
})

/* ------------------------------------------------------------------------- *
 * Locks
 * ------------------------------------------------------------------------- */

test('a resource lock is exclusive, honours config.defaultLease and expires', (t) => {
  const { host, clock, resources } = makeHost({ defaultLease: 30_000 })
  t.after(() => host.db.close())
  const session = addSession(host, 'dsh-session-a')
  const resource = resources.register(session, '/work/plan.md', 'text/markdown', 'text')
  const otherResource = resources.register(session, '/work/other.md', 'text/markdown', 'text')

  const lock = resources.lockResource(resource.identity, 'agent-a', 999_999)
  assert.equal(lock.subject, `resource:${resource.identity}:agent-a`, 'the key scopes the subject to the resource')
  assert.equal(lock.mode, 'exclusive')
  assert.equal(lock.lease, 30_000, 'config.defaultLease is the ceiling')
  assert.equal(lock.session, session, 'the lock is attributed to the resource session')
  assert.equal(lock.heartbeat, clock.now())
  assert.equal(lock.created, clock.now())
  assert.equal(lock.ended, undefined)

  const sameHolder = resources.lockResource(resource.identity, 'agent-a', 1_000)
  assert.equal(sameHolder.identity, lock.identity, 'the same subject re-locks idempotently')
  assert.equal(sameHolder.lease, 30_000, 'a re-lock never rewrites the recorded lease')

  assert.throws(
    () => resources.lockResource(resource.identity, 'agent-b', 5_000),
    (error: unknown) => {
      assert.ok(error instanceof InvalidStateError)
      assert.equal(error.details.subject, 'agent-a')
      assert.equal(error.details.resource, resource.identity)
      return true
    },
  )

  // Another resource is independent: the lock key is not the subject alone.
  const independent = resources.lockResource(otherResource.identity, 'agent-b', 5_000)
  assert.equal(independent.subject, `resource:${otherResource.identity}:agent-b`)
  assert.equal(independent.lease, 5_000, 'a shorter lease is honoured as asked')

  clock.advance(4_999)
  assert.equal(resources.cleanupExpired(), 0, 'both leases are still running')
  clock.advance(1)
  assert.equal(resources.cleanupExpired(), 1, 'exactly the five-second lease expired')
  const independentRow = host.db.get<Row>('SELECT * FROM lock WHERE identity = ?', independent.identity)
  assert.equal(independentRow?.ended, clock.now(), 'ended is the sweep time')
  assert.equal(resources.cleanupExpired(), 0, 'an already released lock is never counted twice')

  clock.advance(25_000)
  assert.equal(resources.cleanupExpired(), 1, 'the thirty-second lease expired at its deadline')
  const expired = host.db.get<Row>('SELECT * FROM lock WHERE identity = ?', lock.identity)
  assert.equal(expired?.ended, clock.now())
  assert.equal(resources.cleanupExpired(), 0)

  const next = resources.lockResource(resource.identity, 'agent-b', 0)
  assert.equal(next.lease, 30_000, 'an absent lease falls back to config.defaultLease')
  assert.throws(
    () => resources.lockResource(resource.identity, 'agent-c', 1_000),
    (error: unknown) => error instanceof InvalidStateError,
    'a freshly taken lease is still active',
  )
  resources.releaseLock(next.identity)
  resources.releaseLock(next.identity)
  const released = host.db.get<Row>('SELECT * FROM lock WHERE identity = ?', next.identity)
  assert.equal(released?.ended, clock.now())
  assert.throws(() => resources.releaseLock(9999), (error: unknown) => error instanceof NotFoundError)
  assert.throws(() => resources.releaseLock(0), (error: unknown) => error instanceof InvalidArgumentError)

  assert.equal(host.db.count('lock'), 3, 'released locks are kept for audit')

  // A lease that can never expire would fail open, so an unusable configured
  // default is refused rather than accepted.
  host.config.defaultLease = Number.NaN
  assert.throws(
    () => resources.lockResource(resource.identity, 'agent-d', 1_000),
    (error: unknown) => error instanceof InvalidStateError,
  )
  host.config.defaultLease = 30_000
})

/* ------------------------------------------------------------------------- *
 * Threads, requests, results
 * ------------------------------------------------------------------------- */

test('request stays pending until a result links it to the thread', (t) => {
  const { host, clock, resources } = makeHost()
  t.after(() => host.db.close())
  const session = addSession(host, 'dsh-session-a')
  const turn = addTurn(host, session, 1)
  const resource = resources.register(session, '/work/plan.md', 'text/markdown', 'text')
  resources.write(session, resource.identity, bytesOf('draft'))

  const thread = resources.thread(resource.identity, turn, 'plan review')
  assert.equal(thread.session, session)
  assert.equal(thread.name, 'plan review')
  assert.equal(thread.status, 'active')
  assert.equal(thread.ended, undefined)
  assert.equal(thread.created, clock.now())

  const request = resources.request(resource.identity, session, 'need the approved plan')
  assert.equal(request.session, session)
  assert.equal(request.method, 'resource')
  assert.equal(request.status, 'pending')
  assert.equal(request.thread, undefined, 'a pending request is not part of a thread yet')
  assert.equal(request.finished, undefined)
  const payload = JSON.parse(request.payload) as Record<string, unknown>
  assert.equal(payload.resource, resource.identity)
  assert.equal(payload.handle, resource.handle)
  assert.equal(payload.path, '/work/plan.md')
  assert.equal(payload.reason, 'need the approved plan')

  clock.advance(250)
  const result = resources.result(thread.identity, 'approved')
  assert.equal(result.request, request.identity)
  assert.equal(result.status, 'ok')
  assert.equal(result.content, 'approved')
  assert.equal(result.created, clock.now())

  const requestRow = host.db.get<Row>('SELECT * FROM request WHERE identity = ?', request.identity)
  assert.equal(requestRow?.status, 'done')
  assert.equal(requestRow?.thread, thread.identity, 'the result links the request to the thread')
  assert.equal(requestRow?.finished, result.created)

  // The thread now has no pending request to answer, and nothing is invented.
  assert.throws(() => resources.result(thread.identity, 'again'), (error: unknown) => error instanceof InvalidStateError)
  assert.equal(host.db.count('result'), 1)
})

test('threads and results fail closed across sessions and without a request', (t) => {
  const { host, clock, resources } = makeHost()
  t.after(() => host.db.close())
  const session = addSession(host, 'dsh-session-a')
  const outsider = addSession(host, 'dsh-session-b')
  const turn = addTurn(host, session, 1)
  const foreignTurn = addTurn(host, outsider, 1)
  const resource = resources.register(session, '/work/plan.md', 'text/markdown', 'text')
  resources.write(session, resource.identity, bytesOf('draft'))

  assert.throws(() => resources.thread(resource.identity, 9999, 'x'), (error: unknown) => error instanceof NotFoundError)
  assert.throws(
    () => resources.thread(resource.identity, foreignTurn, 'x'),
    (error: unknown) => error instanceof InvalidStateError,
    'a thread cannot span sessions',
  )
  assert.throws(() => resources.thread(resource.identity, turn, '   '), (error: unknown) => error instanceof InvalidArgumentError)

  assert.throws(
    () => resources.request(resource.identity, session, ' '),
    (error: unknown) => error instanceof InvalidArgumentError,
  )
  assert.throws(
    () => resources.request(resource.identity + 99, session, 'x'),
    (error: unknown) => error instanceof NotFoundError,
  )
  assert.throws(
    () => resources.request(resource.identity, outsider + 99, 'x'),
    (error: unknown) => error instanceof NotFoundError,
  )

  const thread = resources.thread(resource.identity, turn, 'session a review')
  // A pending request from another session is never stolen by this thread.
  const foreignRequest = resources.request(resource.identity, outsider, 'from b')
  assert.throws(() => resources.result(thread.identity, 'x'), (error: unknown) => error instanceof InvalidStateError)
  const foreignRow = host.db.get<Row>('SELECT * FROM request WHERE identity = ?', foreignRequest.identity)
  assert.equal(foreignRow?.status, 'pending')
  assert.equal(foreignRow?.thread, null)

  assert.throws(() => resources.result(9999, 'x'), (error: unknown) => error instanceof NotFoundError)

  // An ended thread accepts no result even when a request is waiting.
  const pending = resources.request(resource.identity, session, 'from a')
  host.db.update('thread', { status: 'ended', ended: clock.now() }, 'identity = ?', thread.identity)
  assert.throws(() => resources.result(thread.identity, 'x'), (error: unknown) => error instanceof InvalidStateError)
  assert.equal(
    host.db.get<Row>('SELECT status FROM request WHERE identity = ?', pending.identity)?.status,
    'pending',
    'a refused result leaves the request pending',
  )
})

/* ------------------------------------------------------------------------- *
 * Merge limitation (documented, tested)
 * ------------------------------------------------------------------------- */

test('merge never invents a second version: "ours" keeps current and "theirs" writes nothing', (t) => {
  const { host, clock, resources } = makeHost()
  t.after(() => host.db.close())
  const session = addSession(host, 'dsh-session-a')
  const other = addSession(host, 'dsh-session-b')
  const resource = resources.register(session, '/work/plan.md', 'text/markdown', 'text')

  assert.throws(
    () => resources.merge(session, resource.identity, 'ours'),
    (error: unknown) => error instanceof InvalidStateError,
    'there is nothing to merge yet',
  )

  const first = resources.write(session, resource.identity, bytesOf('one'))
  const ours = resources.merge(session, resource.identity, 'ours')
  assert.equal(ours.version.identity, first.identity)
  assert.deepEqual(ours.conflicts, [], '"ours" keeps the current version unchanged')

  const theirs = resources.merge(session, resource.identity, 'theirs')
  assert.equal(theirs.version.identity, first.identity)
  assert.deepEqual(theirs.conflicts, ['theirs has no source version'])
  assert.equal(host.db.count('version'), 1, '"theirs" writes nothing: the schema has no second content')

  // The only divergence the ledger can observe: this session last saw version 1
  // while another session has since written version 2.
  clock.advance(1000)
  const second = resources.write(other, resource.identity, bytesOf('two'))
  const diverged = resources.merge(session, resource.identity, 'theirs')
  assert.equal(diverged.version.identity, second.identity, 'the version that remains current is returned')
  assert.equal(diverged.conflicts[0], 'theirs has no source version')
  assert.match(diverged.conflicts[1] ?? '', /last observed version 1; current is version 2; nothing was merged/)
  assert.equal(host.db.count('version'), 2, 'no merge row was fabricated')

  // The session that wrote last is not diverged.
  const fresh = resources.merge(other, resource.identity, 'theirs')
  assert.deepEqual(fresh.conflicts, ['theirs has no source version'])

  assert.throws(
    () => resources.merge(session, resource.identity, 'manual'),
    (error: unknown) => error instanceof NotImplementedError,
  )
  assert.throws(
    () => resources.merge(session, resource.identity, 'union' as never),
    (error: unknown) => error instanceof InvalidArgumentError,
  )
  assert.throws(() => resources.merge(session, resource.identity + 99, 'ours'), (error: unknown) => error instanceof NotFoundError)
  assert.throws(() => resources.merge(session + 99, resource.identity, 'ours'), (error: unknown) => error instanceof NotFoundError)
})
