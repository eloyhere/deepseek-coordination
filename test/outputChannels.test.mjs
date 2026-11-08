/**
 * P2 output-channel tests: spill, retention, prune, compaction, sources and the
 * optimizer's step/scope merge helpers.
 *
 * The TypeScript modules are imported directly with Node 24 type stripping.
 * Their runtime imports use the repository's `.js` specifier convention, which
 * type stripping does not rewrite, so the same small resolve hook as the P1
 * suite maps a relative `.js` specifier to its `.ts` sibling. No clock, network
 * or store is mocked beyond plain session-event fixtures.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
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

const { parseSpillNotice, SpillIndex, MAX_SPILL_RECORDS } = await import('../src/host/spill.ts')
const { parseRetentionNotice, RetentionLedger, MAX_RETENTION_RECORDS } = await import('../src/host/retention.ts')
const { PruneTracker } = await import('../src/host/prune.ts')
const { CompactionTracker } = await import('../src/host/compaction.ts')
const { AmpCompactionBackend, createAmpCompactionBackend } = await import('../src/host/compactionBackend.ts')
const { OutputSources } = await import('../src/host/sources.ts')
const { MAX_WIRE_ID_LENGTH, compileScopedItem, stepScopedWireId } = await import('../src/host/context.ts')
const { CompactionEngine } = await import('@deepseek-ai/dsh-compaction')

const SESSION = 'session-1'
const OTHER_SESSION = 'session-2'

/** A minimal agent stand-in; only `id` and `session.header.cwd` are read. */
function agentFor(sessionId = SESSION) {
  return { id: sessionId, session: { header: { cwd: process.cwd() } } }
}

/** One `tool/result` event with a text block and the tool source shape. */
function toolResult(seq, text, callId = 'call-1', extra = {}) {
  return {
    type: 'tool/result',
    seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text }],
      },
    },
    ...extra,
  }
}

/** One `tool/call` event carrying the call id → tool name mapping. */
function toolCall(seq, callId, name) {
  return { type: 'tool/call', seq, data: { turn: 1, step: 1, callId, name, arguments: '{}' } }
}

/** The exact spill-policy notice shape, without the optional image clause. */
function spillNotice(bytes, locator, hint) {
  return `(Omitted ${bytes} bytes. Full formatted result stored at: ${locator}. ${hint})`
}

test('spill notice parser reads locator, hint, bytes and the optional image count', () => {
  assert.deepEqual(
    parseSpillNotice(
      `prefix text\n${spillNotice(12345, 'C:\\spill\\result.txt', 'Read the spill file to inspect the full result.')}\nsuffix`,
    ),
    {
      locator: 'C:\\spill\\result.txt',
      retrievalHint: 'Read the spill file to inspect the full result.',
      omittedBytes: 12345,
    },
  )

  assert.deepEqual(
    parseSpillNotice(
      '(Omitted 900 bytes. Full formatted result stored at: /tmp/out.txt. Use read on the locator. Omitted 2 images.)',
    ),
    {
      locator: '/tmp/out.txt',
      retrievalHint: 'Use read on the locator.',
      omittedBytes: 900,
      omittedImages: 2,
    },
  )

  // The exact notice text the DSH host emitted for a spilled command output.
  assert.deepEqual(
    parseSpillNotice(
      '(Omitted 12179 bytes. Full formatted result stored at: C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\dsh-spill-Zw66F6\\session-8f9925174048\\9e21e1137ab2-pwsh.txt. Use read with offset/limit, or grep this path to search within it.)',
    ),
    {
      locator: 'C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\dsh-spill-Zw66F6\\session-8f9925174048\\9e21e1137ab2-pwsh.txt',
      retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
      omittedBytes: 12179,
    },
  )

  // Truncated or unrelated text is not guessed at.
  assert.equal(parseSpillNotice('Omitted 900 bytes.'), undefined)
  assert.equal(parseSpillNotice('Full formatted result stored at: /tmp/out.txt. hint)'), undefined)
  assert.equal(parseSpillNotice('(Omitted 9 bytes. Full formatted result stored at: . hint)'), undefined)
  assert.equal(parseSpillNotice(''), undefined)
  assert.equal(parseSpillNotice(undefined), undefined)
})

test('SpillIndex scans a result once, dedupes and projects one bounded item', () => {
  const index = new SpillIndex()
  const locator = '/ws/.dsh-spill/web_fetch-1.txt'
  const notice = spillNotice(4096, locator, 'Read the spill file to view the full result.')
  index.observe(SESSION, toolCall(1, 'call-1', 'web_fetch'))
  index.observe(SESSION, toolResult(2, `preview line\n${notice}\nmore preview`, 'call-1'))
  // The same committed result observed twice must not duplicate the record.
  index.observe(SESSION, toolResult(2, `preview line\n${notice}\nmore preview`, 'call-1'))
  assert.equal(index.status().records, 1)
  assert.equal(index.status().parsed, 1)
  assert.equal(index.status().duplicates, 1)
  assert.equal(index.list(SESSION).length, 1)
  assert.equal(index.list(OTHER_SESSION).length, 0)

  const items = index.itemsFor(agentFor())
  assert.equal(items.length, 1)
  const [item] = items
  assert.equal(item.channel, 'spill')
  assert.equal(item.pointer.kind, 'spill')
  assert.equal(item.pointer.id, locator)
  assert.equal(item.pointer.version, 'bytes:4096')
  assert.equal(item.pointer.uri, locator)
  assert.equal(item.budget.tokens, 256)
  assert.equal(item.trust, 'host')
  assert.deepEqual(item.scores, { relevance: 0.8, urgency: 0.5, confidence: 0.6, importance: 1 })
  assert.equal(item.scope.sessionId, SESSION)
  // The id carries the current turn: AMP reuses an object by id and would
  // otherwise keep the previous turn's scope and exclude the item.
  assert.match(item.id, /^dsh:spill:session-1:1:spill-0$/)
  assert.ok(Date.parse(item.expiresAt) > Date.now())
  assert.match(item.summary, /^web_fetch output spilled: 4096 bytes;/)
  // The full spilled text never enters the summary.
  assert.ok(!item.summary.includes('preview line'))
  assert.ok(item.summary.length <= 300)

  // Only tool/result text is scanned; a bare notice in another event is inert.
  const quiet = new SpillIndex()
  quiet.observe(SESSION, { type: 'user/message', seq: 3, data: { message: { content: [{ type: 'text', text: notice }] } } })
  assert.equal(quiet.status().records, 0)
})

test('SpillIndex keeps at most the per-session record cap', () => {
  const index = new SpillIndex()
  for (let seq = 0; seq <= MAX_SPILL_RECORDS; seq += 1) {
    index.observe(
      SESSION,
      toolResult(seq, spillNotice(10 + seq, `/tmp/spill-${seq}.txt`, 'Read it.'), `call-${seq}`),
    )
  }
  assert.equal(index.status().records, MAX_SPILL_RECORDS)
  assert.ok(index.status().evicted >= 1)
  assert.equal(index.itemsFor(agentFor()).length, MAX_SPILL_RECORDS)
})

test('retention notice parser separates items/bytes clauses from a spill notice', () => {
  assert.deepEqual(parseRetentionNotice('Omitted 3 items. Narrow the pattern.'), { unit: 'items', count: 3 })
  assert.deepEqual(parseRetentionNotice('...\nOmitted 4096 bytes. Fetch a more specific URL.'), { unit: 'bytes', count: 4096 })
  assert.deepEqual(parseRetentionNotice('Omitted 0 items.'), { unit: 'items', count: 0 })

  // The spill-policy clause is a spill size, not a retention omission.
  assert.equal(
    parseRetentionNotice('Omitted 4096 bytes. Full formatted result stored at: /tmp/a.txt. Read it.'),
    undefined,
  )
  assert.equal(parseRetentionNotice('nothing was omitted'), undefined)
  assert.equal(parseRetentionNotice('Omitted many items.'), undefined)
  assert.equal(parseRetentionNotice(''), undefined)
  assert.equal(parseRetentionNotice(42), undefined)
})

test('RetentionLedger records, bounds, reports and creates budget exclusions', () => {
  const ledger = new RetentionLedger()
  const at = new Date().toISOString()
  assert.equal(
    ledger.record({
      callId: 'call-1',
      tool: 'grep',
      scope: 'grep',
      strategy: 'head',
      limit: 10,
      kept: 10,
      omitted: { kind: 'exact', count: 3 },
      at,
    }, SESSION),
    true,
  )
  assert.equal(ledger.record({ callId: '', tool: 'x', scope: 'x', strategy: 'head', limit: 0, kept: 0, omitted: { kind: 'unknown' }, at }), false)
  assert.equal(ledger.get('call-1').tool, 'grep')
  assert.equal(ledger.list(SESSION).length, 1)
  assert.equal(ledger.list(OTHER_SESSION).length, 0)

  const exclusions = ledger.exclusionsFor(SESSION)
  assert.equal(exclusions.length, 1)
  assert.equal(exclusions[0].id, 'dsh:retention:call-1:1')
  assert.equal(exclusions[0].version, 1)
  assert.equal(exclusions[0].reason, 'budget')
  assert.match(exclusions[0].note, /3 omitted/)

  for (let index = 0; index <= MAX_RETENTION_RECORDS; index += 1) {
    ledger.record({
      callId: `bulk-${index}`,
      tool: 'glob',
      scope: 'glob',
      strategy: 'head',
      limit: 1,
      kept: 1,
      omitted: { kind: 'exact', count: 1 },
      at,
    }, SESSION)
  }
  assert.equal(ledger.status().records, MAX_RETENTION_RECORDS)
  assert.equal(ledger.get('call-1'), undefined)
  assert.ok(ledger.status().evicted >= 1)
})

test('RetentionLedger observes a tool result without creating attention items', () => {
  const ledger = new RetentionLedger()
  ledger.observe(SESSION, toolCall(1, 'call-9', 'grep'))
  ledger.observe(SESSION, toolResult(2, 'match one\nOmitted 4 items. Narrow the pattern.', 'call-9'))
  const record = ledger.get('call-9')
  assert.equal(record.callId, 'call-9')
  assert.equal(record.tool, 'grep')
  assert.deepEqual(record.omitted, { kind: 'exact', count: 4 })
  // The notice does not carry these, so they stay neutral rather than guessed.
  assert.equal(record.strategy, 'head')
  assert.equal(record.limit, 0)
  assert.equal(record.kept, 0)

  const exclusions = ledger.exclusionsFor(SESSION)
  assert.equal(exclusions.length, 1)
  assert.equal(exclusions[0].id, 'dsh:retention:call-9:1')

  // A pure spill notice must not create a retention record.
  ledger.observe(SESSION, toolResult(3, spillNotice(100, '/tmp/x.txt', 'Read it.'), 'call-10'))
  assert.equal(ledger.get('call-10'), undefined)
  assert.equal(ledger.status().records, 1)
})

test('prune tracker pairs the adjacent replacement and keeps the original record', () => {
  const tracker = new PruneTracker()
  tracker.observe(SESSION, {
    type: 'compaction/prune',
    seq: 10,
    data: { shadowedRange: { start: 7, end: 7 }, shadowedSeqs: [7], shadowedTokenCount: 1234 },
  })
  assert.equal(tracker.status().records, 1)
  assert.equal(tracker.status().linked, 0)
  assert.equal(tracker.list(SESSION)[0].replacementSeq, undefined)

  const replacementText = 'head\n\n[... tool result middle pruned ...]\n\ntail'
  tracker.observe(SESSION, toolResult(11, replacementText, 'call-7', {
    surfaceOp: { op: 'replace', startSeq: 7, endSeq: 7 },
    sourceEventSeqs: [7],
  }))
  const record = tracker.list(SESSION)[0]
  assert.equal(record.replacementSeq, 11)
  assert.equal(record.callId, 'call-7')
  assert.equal(record.charsAfter, replacementText.length)
  assert.equal(tracker.status().linked, 1)

  const items = tracker.itemsFor(agentFor())
  assert.equal(items.length, 1)
  const [item] = items
  assert.equal(item.channel, 'prune')
  assert.equal(item.pointer.kind, 'tool')
  assert.equal(item.pointer.id, 'call-7')
  assert.equal(item.pointer.version, 'seq:11')
  assert.equal(item.summary, `pruned to ${replacementText.length} chars (head/tail); original at seq 7`)
  assert.equal(item.budget.tokens, 256)
  assert.equal(item.trust, 'host')
  assert.deepEqual(item.scores, { relevance: 0.6, urgency: 0.4, confidence: 0.6, importance: 1 })

  const exclusions = tracker.hostExclusions()
  assert.equal(exclusions.length, 1)
  assert.equal(exclusions[0].id, 'dsh:prune:session-1:7')
  assert.equal(exclusions[0].version, 1)
  assert.equal(exclusions[0].reason, 'version')
  assert.equal(exclusions[0].pointer.kind, 'tool')
  assert.equal(exclusions[0].pointer.version, 'seq:11')
})

test('prune tracker never guesses a replacement after an intervening event', () => {
  const tracker = new PruneTracker()
  tracker.observe(SESSION, {
    type: 'compaction/prune',
    seq: 10,
    data: { shadowedRange: { start: 7, end: 7 }, shadowedSeqs: [7], shadowedTokenCount: 10 },
  })
  tracker.observe(SESSION, { type: 'assistant/message', seq: 11, data: { message: { content: [] } } })
  assert.equal(tracker.list(SESSION)[0].replacementSeq, undefined)
  assert.equal(tracker.status().unlinked, 1)

  // A later result, even one citing the shadowed seq, is not the adjacent one.
  tracker.observe(SESSION, toolResult(12, 'replacement', 'call-7', { sourceEventSeqs: [7] }))
  assert.equal(tracker.list(SESSION)[0].replacementSeq, undefined)
  assert.equal(tracker.status().linked, 0)

  const item = tracker.itemsFor(agentFor())[0]
  assert.equal(item.pointer.id, 'seq:7')
  assert.equal(item.pointer.version, 'seq:7')
  assert.equal(item.summary, 'pruned (head/tail); original at seq 7')
})

test('prune tracker requires sourceEventSeqs coverage before linking', () => {
  const tracker = new PruneTracker()
  tracker.observe(SESSION, {
    type: 'compaction/prune',
    seq: 20,
    data: { shadowedRange: { start: 4, end: 6 }, shadowedSeqs: [4, 5, 6], shadowedTokenCount: 30 },
  })
  tracker.observe(SESSION, toolResult(21, 'unrelated', 'call-4', { sourceEventSeqs: [9] }))
  assert.equal(tracker.list(SESSION)[0].replacementSeq, undefined)
  assert.equal(tracker.status().unlinked, 1)
  assert.equal(tracker.hostExclusions().length, 3)
})

test('compaction tracker folds start/summary/end idempotently into a record', () => {
  const tracker = new CompactionTracker()
  tracker.observe(SESSION, { type: 'compaction/start', seq: 20, data: { compactionId: 'cmp-1', turn: 3 } })
  const summary = {
    type: 'compaction/summary',
    seq: 21,
    data: {
      compactionId: 'cmp-1',
      summary: [{ type: 'text', text: 'first part' }, { type: 'text', text: 'second part' }],
      shadowedRange: { start: 5, end: 9 },
      shadowedSeqs: [5, 6, 7, 8, 9],
      shadowedTokenCount: 2500,
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTokens: 512,
      usage: { inputTokens: 120, outputTokens: 30 },
    },
  }
  tracker.observe(SESSION, summary)
  // A repeated summary event must not create or replace the record.
  tracker.observe(SESSION, summary)
  tracker.observe(SESSION, { type: 'compaction/end', seq: 22, data: { compactionId: 'cmp-1', turn: 3 } })

  const records = tracker.records(SESSION)
  assert.equal(records.length, 1)
  const [record] = records
  assert.equal(record.compactionId, 'cmp-1')
  assert.equal(record.sessionId, SESSION)
  assert.equal(record.startSeq, 20)
  assert.equal(record.summarySeq, 21)
  assert.equal(record.endSeq, 22)
  assert.equal(record.summary, 'first part\nsecond part')
  assert.match(record.summaryDigest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(record.shadowedRange.start, 5)
  assert.equal(record.shadowedRange.end, 9)
  assert.deepEqual(record.shadowedSeqs, [5, 6, 7, 8, 9])
  assert.equal(record.shadowedTokenCount, 2500)
  assert.equal(record.provider, 'deepseek')
  assert.equal(record.model, 'deepseek-chat')
  assert.deepEqual(record.usage, { inputTokens: 120, outputTokens: 30 })
  assert.equal(record.error, undefined)
  assert.equal(tracker.status().summaries, 1)
  assert.equal(tracker.status().ends, 1)
  assert.equal(tracker.status().open, 0)

  const items = tracker.itemsFor(agentFor())
  assert.equal(items.length, 1)
  const [item] = items
  assert.equal(item.channel, 'compaction')
  assert.equal(item.pointer.kind, 'compaction')
  assert.equal(item.pointer.id, '21')
  assert.equal(item.pointer.version, '1')
  assert.equal(item.summary, 'compacted 5 events into a summary (2500 tokens); detail at seq 21')
  assert.equal(item.budget.tokens, 400)
  assert.equal(item.trust, 'host')
  assert.deepEqual(item.scores, { relevance: 0.8, urgency: 0.5, confidence: 0.9, importance: 0.9 })
  assert.equal(tracker.records(OTHER_SESSION).length, 0)
})

test('compaction tracker: summary without start, error end, and failed compaction', () => {
  const tracker = new CompactionTracker()
  // A cold-start summary still records, using its own seq as the start fallback.
  tracker.observe(SESSION, {
    type: 'compaction/summary',
    seq: 30,
    data: {
      compactionId: 'cmp-cold',
      summary: [{ type: 'text', text: 'cold summary' }],
      shadowedRange: { start: 2, end: 3 },
      shadowedSeqs: [2, 3],
      shadowedTokenCount: 100,
      provider: 'p',
      model: 'm',
    },
  })
  assert.equal(tracker.records(SESSION)[0].startSeq, 30)

  tracker.observe(SESSION, { type: 'compaction/start', seq: 40, data: { compactionId: 'cmp-fail', turn: 4 } })
  tracker.observe(SESSION, { type: 'compaction/end', seq: 41, data: { compactionId: 'cmp-fail', turn: 4, error: 'summary failed' } })
  // A failed compaction leaves no record and therefore no attention item.
  assert.equal(tracker.records(SESSION).length, 1)
  assert.equal(tracker.status().open, 0)

  // An end error on a completed record is retained.
  tracker.observe(SESSION, { type: 'compaction/start', seq: 50, data: { compactionId: 'cmp-late', turn: 5 } })
  tracker.observe(SESSION, {
    type: 'compaction/summary',
    seq: 51,
    data: {
      compactionId: 'cmp-late',
      summary: [{ type: 'text', text: 'late summary' }],
      shadowedRange: { start: 6, end: 7 },
      shadowedSeqs: [6, 7],
      shadowedTokenCount: 50,
      provider: 'p',
      model: 'm',
    },
  })
  tracker.observe(SESSION, { type: 'compaction/end', seq: 52, data: { compactionId: 'cmp-late', turn: 5, error: 'commit failed' } })
  const late = tracker.records(SESSION).find((record) => record.compactionId === 'cmp-late')
  assert.equal(late.endSeq, 52)
  assert.equal(late.error, 'commit failed')
})

test('source item ids are turn-qualified so a later turn cannot reuse an old object', () => {
  const spill = new SpillIndex()
  spill.observe(SESSION, toolResult(1, spillNotice(10, '/tmp/a.txt', 'Read it.'), 'call-a'))
  const spillFirst = spill.itemsFor(agentFor())[0]
  assert.match(spillFirst.id, /^dsh:spill:session-1:1:/)
  spill.observe(SESSION, { type: 'turn/start', seq: 2, data: { turn: 2 } })
  const spillSecond = spill.itemsFor(agentFor())[0]
  assert.match(spillSecond.id, /^dsh:spill:session-1:2:/)
  assert.notEqual(spillSecond.id, spillFirst.id)

  const prune = new PruneTracker()
  prune.observe(SESSION, {
    type: 'compaction/prune',
    seq: 3,
    data: { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 20 },
  })
  prune.observe(SESSION, toolResult(4, 'head...tail', 'call-p', { sourceEventSeqs: [2] }))
  assert.match(prune.itemsFor(agentFor())[0].id, /^dsh:prune:session-1:1:prune-0$/)
  prune.observe(SESSION, { type: 'turn/start', seq: 5, data: { turn: 2 } })
  assert.match(prune.itemsFor(agentFor())[0].id, /^dsh:prune:session-1:2:prune-0$/)

  const compaction = new CompactionTracker()
  compaction.observe(SESSION, { type: 'compaction/start', seq: 6, data: { compactionId: 'cmp-t', turn: 1 } })
  compaction.observe(SESSION, {
    type: 'compaction/summary',
    seq: 7,
    data: {
      compactionId: 'cmp-t',
      summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: 1, end: 5 },
      shadowedSeqs: [1, 2, 3, 4, 5],
      shadowedTokenCount: 100,
      provider: 'p',
      model: 'm',
    },
  })
  assert.match(compaction.itemsFor(agentFor())[0].id, /^dsh:compaction:session-1:1:compaction-7$/)
  compaction.observe(SESSION, { type: 'turn/start', seq: 8, data: { turn: 2 } })
  assert.match(compaction.itemsFor(agentFor())[0].id, /^dsh:compaction:session-1:2:compaction-7$/)
})

test('OutputSources merges channels and keeps exclusion ledgers separate', () => {
  const spill = new SpillIndex()
  spill.observe(SESSION, toolResult(1, spillNotice(2048, '/tmp/spill.txt', 'Read it.'), 'call-s'))
  const retention = new RetentionLedger()
  retention.observe(SESSION, toolResult(2, 'Omitted 2 items. Narrow the pattern.', 'call-r'))
  const prune = new PruneTracker()
  prune.observe(SESSION, {
    type: 'compaction/prune',
    seq: 3,
    data: { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 20 },
  })
  prune.observe(SESSION, toolResult(4, 'head...tail', 'call-r', { sourceEventSeqs: [2] }))
  const compaction = new CompactionTracker()
  compaction.observe(SESSION, {
    type: 'compaction/summary',
    seq: 5,
    data: {
      compactionId: 'cmp-1',
      summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: 1, end: 4 },
      shadowedSeqs: [1, 2, 3, 4],
      shadowedTokenCount: 400,
      provider: 'p',
      model: 'm',
    },
  })

  const sources = new OutputSources({ spill, retention, prune, compaction })
  const items = sources.itemsFor(agentFor())
  assert.deepEqual(items.map((item) => item.channel).sort(), ['compaction', 'prune', 'spill'])
  assert.equal(new Set(items.map((item) => item.id)).size, items.length)
  assert.equal(sources.itemsFor(agentFor(OTHER_SESSION)).length, 0)

  const exclusions = sources.exclusions()
  assert.equal(exclusions.length, 2)
  assert.deepEqual(exclusions.map((exclusion) => exclusion.reason).sort(), ['budget', 'version'])
  assert.equal(new Set(exclusions.map((exclusion) => exclusion.id)).size, 2)

  const status = sources.status()
  assert.equal(status.spill.records, 1)
  assert.equal(status.retention.records, 1)
  assert.equal(status.prune.records, 1)
  assert.equal(status.compaction.records, 1)
  assert.equal(status.failures, 0)
})

test('step-qualified ids stay unique and within the 200-character wire limit', () => {
  assert.equal(stepScopedWireId('dsh:file:s:1:file-1', 2), 'dsh:file:s:1:file-1-s2')
  // Already qualified ids are left alone.
  assert.equal(stepScopedWireId('dsh:file:s:1:file-1-s2', 2), 'dsh:file:s:1:file-1-s2')
  assert.equal(stepScopedWireId('dsh:file:s:1:file-1-s2', 12), 'dsh:file:s:1:file-1-s2-s12')

  const longBase = `dsh:file:${'x'.repeat(180)}:0:file-1`
  const short = stepScopedWireId(longBase, 12)
  assert.equal(short.length, MAX_WIRE_ID_LENGTH)
  assert.match(short, /-[0-9a-f]{12}$/)
  assert.notEqual(short, stepScopedWireId(longBase, 13))
  assert.notEqual(short, stepScopedWireId(longBase, 2))
  assert.ok(short.startsWith(longBase.slice(0, 100)))
})

test('compileScopedItem overrides the full scope and clones nested fields', () => {
  const item = {
    id: 'dsh:file:s:1:file-1',
    channel: 'file',
    scope: { tenantId: 'guessed-tenant', principalId: 's', sessionId: 's', turnId: 'turn:s:1' },
    pointer: { kind: 'file', id: 'a.ts', version: 'mtime:1' },
    summary: 'a.ts',
    scores: { relevance: 0.8, urgency: 0.6, confidence: 0.8, importance: 0.7 },
    budget: { tokens: 256 },
    expiresAt: '2099-01-01T00:00:00.000Z',
    reason: 'mentioned file',
    trust: 'host',
  }
  const compileScope = { tenantId: 'deployed-tenant', principalId: 's', sessionId: 's', turnId: 'amp-turn-9' }
  const scoped = compileScopedItem(item, compileScope, 2)

  assert.equal(scoped.id, 'dsh:file:s:1:file-1-s2')
  // Tenant, principal, session and turn all come from the compile scope.
  assert.deepEqual(scoped.scope, compileScope)
  assert.notEqual(scoped.scope, compileScope)
  assert.equal(scoped.scope.tenantId, 'deployed-tenant')
  assert.equal(scoped.scope.turnId, 'amp-turn-9')
  assert.notEqual(scoped.pointer, item.pointer)
  assert.deepEqual(scoped.pointer, item.pointer)
  assert.notEqual(scoped.scores, item.scores)
  assert.deepEqual(scoped.scores, item.scores)
  assert.notEqual(scoped.budget, item.budget)
  assert.deepEqual(scoped.budget, item.budget)
  assert.equal(scoped.trust, 'host')
  // The captured item is not mutated.
  assert.equal(item.id, 'dsh:file:s:1:file-1')
  assert.equal(item.scope.tenantId, 'guessed-tenant')
})

test('AMP compaction backend is an engine adapter and only forwards', () => {
  assert.equal(typeof createAmpCompactionBackend, 'function')
  assert.ok(Object.getPrototypeOf(AmpCompactionBackend.prototype) === CompactionEngine.prototype)
  const methods = ['compactIfNeeded', 'compactNow', 'compactRegion']
  for (const method of methods) {
    assert.equal(typeof AmpCompactionBackend.prototype[method], 'function')
  }
})
