/**
 * P1 input-channel tests.
 *
 * The channel modules are TypeScript and are imported directly with Node 24's
 * type stripping. Their runtime imports use the repository's `.js` specifier
 * convention (`../wire.js`), which type stripping does not rewrite, so a small
 * synchronous resolve hook maps a relative `.js` specifier to its `.ts` sibling
 * when that sibling exists. Nothing else is mocked: the file channel stats real
 * temporary files and the capture integration uses the real `WireCapture`.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL !== undefined &&
      specifier.endsWith('.js') &&
      (specifier.startsWith('./') || specifier.startsWith('../'))
    ) {
      const mapped = `${specifier.slice(0, -3)}.ts`
      try {
        if (existsSync(fileURLToPath(new URL(mapped, context.parentURL)))) {
          return nextResolve(mapped, context)
        }
      } catch {
        // Fall through to the original specifier.
      }
    }
    return nextResolve(specifier, context)
  },
})

const shared = await import('../src/host/channels/shared.ts')
const { fileExtractor, parseFileMentions, resolveMention } = await import('../src/host/channels/file.ts')
const { attachmentExtractor } = await import('../src/host/channels/attachment.ts')
const { sessionExtractor, sessionUri } = await import('../src/host/channels/session.ts')
const { HOST_INJECTED_SOURCES, messageExtractor } = await import('../src/host/channels/message.ts')
const { INPUT_EXTRACTORS, registerInputExtractors } = await import('../src/host/channels/index.ts')
const { WireCapture } = await import('../src/host/prestep.ts')

const TURN_WINDOW = 60 * 60 * 1000
const SESSION_WINDOW = 24 * 60 * 60 * 1000

/** Run one test body against a fresh temporary workspace, then remove it. */
function withWorkspace(run) {
  const base = mkdtempSync(path.join(tmpdir(), 'dsh-channels-'))
  const root = path.join(base, 'workspace')
  mkdirSync(root)
  try {
    return run({ base, root })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

/** A minimal live-agent stand-in: only `id` and `session.header.cwd` are read. */
function agentFor(root) {
  return { id: 'session-1', session: { header: { cwd: root } } }
}

/** One user-authored text message. */
function userMessage(text, id = undefined, source = { kind: 'user' }) {
  return {
    ...(id === undefined ? {} : { id }),
    role: 'user',
    source,
    content: [{ type: 'text', text }],
  }
}

/** One image content block with only durable reference metadata. */
function imageBlock(id, name, bytes, width, height, extra = {}) {
  return {
    type: 'image',
    attachment: { attachmentId: id, name, bytes, width, height, mediaType: 'image/png' },
    ...extra,
  }
}

/** One file content block with only durable reference metadata. */
function fileBlock(id, name, bytes) {
  return { type: 'file', attachment: { attachmentId: id, name, bytes } }
}

/** A `session-reference` source exactly as DSH 0.2.2-rc.1 emits it. */
function sessionReferenceSource(references) {
  return { kind: 'session-reference', form: 'recall', version: 1, references }
}

/** A `session-reference` message carrying an opaque snapshot body. */
function sessionReferenceMessage(source) {
  return {
    role: 'user',
    source,
    content: [{ type: 'text', text: '[untrusted session snapshot body]' }],
  }
}

/** Package a message batch into the extractor input shape. */
function captureInput(agent, messages, overrides = {}) {
  return {
    agent,
    sessionId: 'session-1',
    turn: 3,
    step: 1,
    messages,
    prompt: '',
    ...overrides,
  }
}

test('@file parses bare and quoted mentions but not an email-local @', () => {
  assert.deepEqual([...parseFileMentions('@a')], ['a'])
  assert.deepEqual([...parseFileMentions('see @"a b" now')], ['a b'])
  assert.deepEqual([...parseFileMentions('mail me at a@b.example')], [])
  assert.deepEqual([...parseFileMentions('@a @b')], ['a', 'b'])
  assert.deepEqual([...parseFileMentions('not@a')], [])
  assert.deepEqual([...parseFileMentions('@a\u0000b')], [])
  assert.deepEqual([...parseFileMentions('@a"b')], [])
  assert.deepEqual([...parseFileMentions('')], [])
  assert.deepEqual([...parseFileMentions(undefined)], [])
})

test('@file produces stat-only items, dedupes paths and rejects escapes', () => {
  withWorkspace(({ base, root }) => {
    writeFileSync(path.join(root, 'a'), 'alpha')
    writeFileSync(path.join(root, 'a b'), 'beta')
    const outside = path.join(base, 'outside.txt')
    writeFileSync(outside, 'outside')
    const agent = agentFor(root)
    const messages = [
      userMessage('see @a and @"a b" and @a again', 'm1'),
      userMessage('mail me at a@b.example', 'm2'),
      userMessage('@a', 'm3'),
      userMessage(`@"${outside}"`, 'm4'),
      userMessage('@../outside.txt', 'm5'),
      userMessage('@missing-file', 'm6'),
    ]
    const items = fileExtractor.extract(captureInput(agent, messages, {
      prompt: 'see @a and @"a b" and @a again',
    }))
    assert.equal(items.length, 2)

    const stat = statSync(path.join(root, 'a'))
    assert.equal(items[0].id, 'dsh:file:session-1:3:file-1')
    assert.equal(items[0].channel, 'file')
    assert.deepEqual(items[0].pointer, {
      kind: 'file',
      id: 'a',
      version: `stat:${String(stat.mtimeMs)}:${String(stat.size)}`,
      uri: 'dsh-file:a',
    })
    assert.equal(items[0].summary, '@a — path reference only; not read (5 bytes)')
    assert.deepEqual(items[0].scores, { relevance: 0.9, urgency: 0.5, confidence: 0.9, importance: 0.7 })
    assert.deepEqual(items[0].budget, { tokens: 256 })
    assert.equal(items[0].trust, 'user')
    assert.equal(items[0].scope.sessionId, 'session-1')
    const turnLeft = Date.parse(items[0].expiresAt) - Date.now()
    assert.ok(turnLeft > TURN_WINDOW - 60_000 && turnLeft <= TURN_WINDOW, String(turnLeft))

    assert.equal(items[1].pointer.id, 'a b')
    assert.equal(items[1].pointer.uri, 'dsh-file:a b')
    assert.equal(items[1].summary, '@a b — path reference only; not read (4 bytes)')
    assert.equal(new Set(items.map((item) => item.pointer.id)).size, 2)
    assert.equal(items.some((item) => item.summary.includes('outside')), false)
    assert.equal(items.some((item) => item.summary.includes('missing-file')), false)

    const insideAbsolute = path.join(root, 'a')
    assert.equal(resolveMention(root, insideAbsolute), 'a')
    assert.equal(resolveMention(root, outside), undefined)
    assert.equal(resolveMention(root, '../outside.txt'), undefined)
    assert.equal(resolveMention(root, '.'), undefined)
  })
})

test('@file is limited to user-sourced messages and eight items', () => {
  withWorkspace(({ root }) => {
    const agent = agentFor(root)
    for (let index = 0; index < 10; index += 1) writeFileSync(path.join(root, `f${index}`), 'x')
    const hostMessage = userMessage('@f0', 'host', { kind: 'time-context' })
    const userMentions = userMessage(Array.from({ length: 10 }, (_, index) => `@f${index}`).join(' '), 'u1')
    const items = fileExtractor.extract(captureInput(agent, [hostMessage, userMentions]))
    assert.equal(items.length, 8)
    assert.deepEqual(items.map((item) => item.pointer.id), Array.from({ length: 8 }, (_, index) => `f${index}`))
  })
})

test('attachment groups one item per message and marks offloaded images', () => {
  const agent = { id: 'session-1' }
  const messages = [
    {
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'two attachments' },
        imageBlock('att-img-1', 'foo.png', 86016, 800, 600, { data: 'AAAA'.repeat(16) }),
        fileBlock('att-file-1', 'spec.pdf', 2202010),
      ],
    },
    {
      role: 'user',
      source: { kind: 'user' },
      content: [imageBlock('att-img-2', 'bar.png', 1024, 10, 20, { offloaded: true })],
    },
    {
      role: 'assistant',
      content: [imageBlock('att-img-3', 'ignored.png', 1024, 1, 1)],
    },
  ]
  const items = attachmentExtractor.extract(captureInput(agent, messages, { turn: 4, step: 2 }))
  assert.equal(items.length, 2)

  assert.equal(items[0].id, 'dsh:attachment:session-1:4:attachment-1')
  assert.equal(items[0].channel, 'attachment')
  assert.deepEqual(items[0].pointer, {
    kind: 'attachment',
    id: 'att-img-1',
    version: 'bytes:86016',
    uri: 'dsh-attachment:att-img-1',
  })
  assert.equal(items[0].summary, 'attachments: image foo.png 800x600 84 KB; file spec.pdf 2.1 MB')
  assert.deepEqual(items[0].scores, { relevance: 0.9, urgency: 0.6, confidence: 1, importance: 0.8 })
  assert.deepEqual(items[0].budget, { tokens: 256 })
  assert.equal(items[0].trust, 'user')
  const sessionLeft = Date.parse(items[0].expiresAt) - Date.now()
  assert.ok(sessionLeft > SESSION_WINDOW - 60_000 && sessionLeft <= SESSION_WINDOW, String(sessionLeft))

  assert.equal(items[1].summary, 'attachments: image bar.png 10x20 1 KB (offloaded)')
  assert.deepEqual(items[1].pointer, {
    kind: 'attachment',
    id: 'att-img-2',
    version: 'bytes:1024',
    uri: 'dsh-attachment:att-img-2',
  })
  assert.equal(JSON.stringify(items).includes('AAAAAAAA'), false)
  assert.deepEqual(attachmentExtractor.extract(captureInput(agent, [])), [])
})

test('attachment keeps at most four message groups and file pointers use sha256 ids', () => {
  const agent = { id: 'session-1' }
  const messages = Array.from({ length: 5 }, (_, index) => ({
    role: 'user',
    source: { kind: 'user' },
    content: [
      index === 0 ? fileBlock('file-attachment-0', 'a.txt', 2048) : imageBlock(`img-${index}`, `i${index}.png`, 2048, 2, 2),
    ],
  }))
  const items = attachmentExtractor.extract(captureInput(agent, messages))
  assert.equal(items.length, 4)
  assert.equal(items[0].summary, 'attachments: file a.txt 2 KB')
  assert.equal(items[0].pointer.version, 'sha256:file-attachment-0')
  assert.deepEqual(items.map((item) => item.id), [
    'dsh:attachment:session-1:3:attachment-1',
    'dsh:attachment:session-1:3:attachment-2',
    'dsh:attachment:session-1:3:attachment-3',
    'dsh:attachment:session-1:3:attachment-4',
  ])
})

test('session-reference reads the exact DSH source shape and uses base64url', () => {
  const agent = { id: 'session-1' }
  const sourceId = 'session-src-1'
  const messages = [
    sessionReferenceMessage(sessionReferenceSource([
      {
        sessionId: sourceId,
        label: 'prior-work',
        capturedFormatVersion: 1,
        capturedThroughSeq: 42,
        stats: { bytes: 1234, digest: 'sha256:abcd' },
        inputIndex: 0,
      },
    ])),
  ]
  const items = sessionExtractor.extract(captureInput(agent, messages, { turn: 2, prompt: 'recall' }))
  assert.equal(items.length, 1)
  const item = items[0]
  assert.equal(item.id, 'dsh:session-ref:session-1:2:session-0')
  assert.equal(item.channel, 'session-ref')
  assert.deepEqual(item.pointer, {
    kind: 'session',
    id: sourceId,
    version: 'seq:42',
    uri: `dsh-session:${Buffer.from(sourceId).toString('base64url')}`,
  })
  assert.equal(sessionUri(sourceId), `dsh-session:${Buffer.from(sourceId, 'utf8').toString('base64url')}`)
  assert.equal(item.summary, `@prior-work (session ${sourceId}) captured through seq 42; untrusted background`)
  assert.deepEqual(item.scores, { relevance: 0.7, urgency: 0.3, confidence: 0.6, importance: 0.6 })
  assert.deepEqual(item.budget, { tokens: 256 })
  assert.equal(item.trust, 'derived')
  const turnLeft = Date.parse(item.expiresAt) - Date.now()
  assert.ok(turnLeft > TURN_WINDOW - 60_000 && turnLeft <= TURN_WINDOW)
})

test('session-reference falls back to source fields, dedupes sessions and caps at three', () => {
  const agent = { id: 'session-1' }
  const fallback = sessionReferenceMessage({
    kind: 'session-reference',
    sessionId: 'session-fallback',
    label: 'fallback-label',
    capturedThroughSeq: 7,
  })
  const fallbackItems = sessionExtractor.extract(captureInput(agent, [fallback]))
  assert.equal(fallbackItems.length, 1)
  assert.equal(fallbackItems[0].pointer.id, 'session-fallback')
  assert.equal(fallbackItems[0].pointer.version, 'seq:7')
  assert.equal(fallbackItems[0].id, 'dsh:session-ref:session-1:3:session-1')

  const noLabel = sessionExtractor.extract(captureInput(agent, [sessionReferenceMessage({
    kind: 'session-reference',
    sessionId: 'session-anon',
  })]))
  assert.equal(noLabel[0].summary, '@session-anon (session session-anon) captured through seq 0; untrusted background')

  const many = sessionReferenceSource([
    { sessionId: 'session-a', label: 'A', capturedThroughSeq: 1, inputIndex: 0 },
    { sessionId: 'session-a', label: 'A', capturedThroughSeq: 1, inputIndex: 0 },
    { sessionId: 'session-b', label: 'B', capturedThroughSeq: 2, inputIndex: 1 },
    { sessionId: 'session-c', label: 'C', capturedThroughSeq: 3, inputIndex: 2 },
    { sessionId: 'session-d', label: 'D', capturedThroughSeq: 4, inputIndex: 3 },
  ])
  const items = sessionExtractor.extract(captureInput(agent, [sessionReferenceMessage(many)]))
  assert.equal(items.length, 3)
  assert.deepEqual(items.map((item) => item.pointer.id), ['session-a', 'session-b', 'session-c'])
  assert.deepEqual(items.map((item) => item.id), [
    'dsh:session-ref:session-1:3:session-0',
    'dsh:session-ref:session-1:3:session-1',
    'dsh:session-ref:session-1:3:session-2',
  ])

  const malformed = sessionReferenceMessage({ kind: 'session-reference', references: [null, 42, { label: 'x' }] })
  assert.deepEqual(sessionExtractor.extract(captureInput(agent, [malformed])), [])
})

test('steer and inject are classified without copying host-injected context', () => {
  const agent = { id: 'session-1' }
  const messages = [
    userMessage('  focus on host only  ', 'm-steer'),
    userMessage('Current time: 2026-01-01', 'm-host', { kind: 'time-context' }),
    userMessage('plugin note\nsecond line', 'm-inject', { kind: 'plugin-x' }),
    userMessage('first prompt', 'm-dup', { kind: 'plugin-x' }),
    userMessage('   ', 'm-empty', { kind: 'plugin-x' }),
    userMessage('self injection', 'm-amp', { kind: 'amp:context' }),
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'assistant note' }] },
  ]
  const items = messageExtractor.extract(captureInput(agent, messages, { turn: 5, step: 2, prompt: 'first prompt' }))
  assert.equal(items.length, 2)

  const [steer, inject] = items
  assert.equal(steer.channel, 'steer')
  assert.equal(steer.id, 'dsh:steer:session-1:5:steer-0')
  assert.deepEqual(steer.pointer, { kind: 'message', id: 'm-steer', version: 'turn:5:step:2' })
  assert.equal(steer.summary, 'steer: focus on host only')
  assert.deepEqual(steer.scores, { relevance: 1, urgency: 1, confidence: 1, importance: 0.9 })
  assert.equal(steer.trust, 'user')
  const steerLeft = Date.parse(steer.expiresAt) - Date.now()
  assert.ok(steerLeft > TURN_WINDOW - 60_000 && steerLeft <= TURN_WINDOW)

  assert.equal(inject.channel, 'inject')
  assert.equal(inject.id, 'dsh:inject:session-1:5:inject-2')
  assert.deepEqual(inject.pointer, { kind: 'message', id: 'm-inject', version: 'turn:5:step:2' })
  assert.equal(inject.summary, 'injected by plugin-x: plugin note second line')
  assert.deepEqual(inject.scores, { relevance: 0.7, urgency: 0.2, confidence: 0.8, importance: 0.6 })
  assert.equal(inject.trust, 'derived')
  const injectLeft = Date.parse(inject.expiresAt) - Date.now()
  assert.ok(injectLeft > TURN_WINDOW - 60_000 && injectLeft <= TURN_WINDOW)

  assert.equal(HOST_INJECTED_SOURCES.includes('runtime-context'), true)
  assert.equal(HOST_INJECTED_SOURCES.includes('reminder'), true)
})

test('steer requires a later step and summaries are bounded', () => {
  const agent = { id: 'session-1' }
  const firstStep = messageExtractor.extract(captureInput(agent, [
    userMessage('the prompt', 'm1'),
    userMessage('plugin notice', 'm2', { kind: 'notice' }),
  ], { step: 1, prompt: 'the prompt' }))
  assert.deepEqual(firstStep.map((item) => item.channel), ['inject'])

  const longSteer = 'x'.repeat(260)
  const items = messageExtractor.extract(captureInput(agent, [
    userMessage(longSteer, 'm-long'),
    userMessage('x'.repeat(200), 'm-inject', { kind: 'plugin-y' }),
  ], { step: 3, prompt: 'different prompt' }))
  assert.equal(items.length, 2)
  assert.equal(items[0].summary, `steer: ${'x'.repeat(200)}`)
  assert.equal(items[1].summary, `injected by plugin-y: ${'x'.repeat(160)}`)
  assert.equal(items[0].pointer.id, 'm-long')

  // P0 promotes the newly claimed later-step message itself to `prompt` when a
  // batch has no other user text; that must not silence the steer.
  const selfPromoted = messageExtractor.extract(captureInput(agent, [
    userMessage('same text', 'm-same'),
  ], { step: 2, prompt: 'same text' }))
  assert.equal(selfPromoted.length, 1)
  assert.equal(selfPromoted[0].channel, 'steer')
})

test('channel helpers and extractors never throw on malformed input', () => {
  const hostileAgent = { get id() { throw new Error('bad agent') }, get session() { throw new Error('bad session') } }
  const hostileMessage = {
    get role() { throw new Error('bad role') },
    get source() { throw new Error('bad source') },
    get content() { throw new Error('bad content') },
  }
  const hostileInput = {
    get sessionId() { throw new Error('bad session id') },
    get turn() { throw new Error('bad turn') },
    get step() { throw new Error('bad step') },
    get messages() { throw new Error('bad messages') },
    get prompt() { throw new Error('bad prompt') },
    get agent() { throw new Error('bad agent') },
  }
  for (const extractor of INPUT_EXTRACTORS) {
    assert.doesNotThrow(() => extractor.extract(undefined))
    assert.doesNotThrow(() => extractor.extract(hostileInput))
    assert.deepEqual(extractor.extract(undefined), [])
  }

  const agent = { id: 'session-1', session: { header: { cwd: process.cwd() } } }
  const junk = [null, 42, 'text', hostileMessage, { role: 'user', source: { kind: 'user' }, content: [null, 7, { type: 'text', text: 9 }] }]
  for (const extractor of INPUT_EXTRACTORS) {
    assert.doesNotThrow(() => extractor.extract(captureInput(agent, junk)))
  }

  assert.equal(shared.textOfMessage(hostileMessage), '')
  assert.equal(shared.textOfMessage(undefined), '')
  assert.equal(shared.cwdOf(hostileAgent), undefined)
  assert.equal(shared.cwdOf(undefined), undefined)
  assert.equal(shared.sourceKindOf(hostileMessage), '')
  assert.equal(shared.roleOf(hostileMessage), '')
  assert.equal(shared.safeSlot('bad prefix!', -1), 'item-0')
  assert.equal(shared.safeSlot('file', 2.9), 'file-2')
  assert.equal(shared.formatBytes(Number.NaN), '0 B')
  assert.equal(shared.formatBytes(2 * 1024 * 1024), '2.0 MB')
  assert.ok(Number.isFinite(Date.parse(shared.turnExpiry(Number.NaN))))
  assert.ok(Number.isFinite(Date.parse(shared.sessionExpiry())))
  assert.equal(shared.isInside(process.cwd(), path.join(process.cwd(), 'src')), true)
  assert.equal(shared.isInside(process.cwd(), path.dirname(process.cwd())), false)
  assert.equal(shared.asRecord(null), undefined)
  assert.equal(shared.oneLine('a\r\nb'), 'a  b')

  const newlineLabel = sessionReferenceMessage({
    kind: 'session-reference',
    references: [{ sessionId: 'session-1', label: 'a\nb', capturedThroughSeq: 1, inputIndex: 0 }],
  })
  const [labelItem] = sessionExtractor.extract(captureInput(agent, [newlineLabel]))
  assert.equal(labelItem.summary.includes('\n'), false)

  const newlineAttachment = attachmentExtractor.extract(captureInput(agent, [{
    role: 'user',
    source: { kind: 'user' },
    content: [imageBlock('att-newline', 'a\r\nb.png', 1024, 2, 2)],
  }]))
  assert.equal(newlineAttachment[0].summary.includes('\n'), false)
})

test('registerInputExtractors is idempotent and feeds the real capture', () => {
  withWorkspace(({ root }) => {
    writeFileSync(path.join(root, 'a'), 'alpha')
    const agent = agentFor(root)
    const capture = new WireCapture()
    registerInputExtractors(capture)
    registerInputExtractors(capture)
    registerInputExtractors(undefined)
    assert.deepEqual(capture.extractors.map((extractor) => extractor.name), ['file', 'attachment', 'session', 'message'])
    assert.deepEqual(INPUT_EXTRACTORS.map((extractor) => extractor.name), ['file', 'attachment', 'session', 'message'])

    const messages = [
      {
        role: 'user',
        id: 'm-attachment',
        source: { kind: 'user' },
        content: [imageBlock('att-1', 'shot.png', 2048, 64, 32)],
      },
      sessionReferenceMessage(sessionReferenceSource([
        { sessionId: 'session-other', label: 'other', capturedThroughSeq: 9, inputIndex: 0 },
      ])),
      userMessage('steer this @a', 'm-steer'),
    ]
    const pending = capture.capture(agent, messages, { turn: 6, step: 2 })
    assert.deepEqual(pending.errors, [])
    assert.deepEqual(pending.items.map((item) => item.channel), ['file', 'attachment', 'session-ref', 'steer'])
    assert.equal(pending.items[0].pointer.id, 'a')
    assert.equal(pending.items[1].summary, 'attachments: image shot.png 64x32 2 KB')
    assert.equal(pending.items[2].pointer.id, 'session-other')
    assert.equal(pending.items[3].pointer.id, 'm-steer')
    assert.equal(pending.items[3].summary, 'steer: steer this @a')
    assert.equal(capture.status().captured, 1)
    assert.equal(capture.status().lastCapture?.items, 4)
  })
})
