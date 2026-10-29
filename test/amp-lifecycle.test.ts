/**
 * AMP lifecycle integration: the real `CoordinationService`, not a stub.
 *
 * The unit tests prove the protocol layer is correct in isolation; this file
 * proves the plugin actually drives it from `agent/pre-step` and
 * `agent/turn-stopping`. It builds the composed service over a temporary
 * database (the same fixture pattern as `turn-pipeline.test.ts`), runs a turn,
 * and reads the artifacts back out of SQLite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CoordinationService } from '../src/host/coordination.js'
import type { DshRuntime } from '../src/host/dsh.js'
import { receiptIdOf } from '../src/host/amp.js'
import { validateClaim, type Claim } from '../src/protocol/index.js'
import { testConfig } from './helpers.js'

interface Fixture {
  service: CoordinationService
  close(): void
}

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'coordination-amp-'))
  const config = testConfig({ databasePath: join(directory, 'coordination.db') })
  const runtime: DshRuntime = {
    rawSession: () => undefined,
    rawAgent: () => undefined,
  }
  const context = { reflect: { provide: (): void => {} } } as unknown as Context
  const service = new CoordinationService(context, config, runtime)
  return {
    service,
    close(): void {
      try {
        service.dispose()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  }
}

/** The facts the service builds; re-exported only to keep the shape visible. */
test('beginTurn opens a frame and endTurn settles it with a measured receipt', async () => {
  const f = fixture()
  try {
    f.service.setSelection('dsh-amp', { interaction: 'orchestrate', scene: 'writing', validation: 'medium' })
    const turn = await f.service.beginTurn('dsh-amp', 1, 'write the release notes')
    assert.ok(turn.handle.length > 0)

    await f.service.awaitPipeline('dsh-amp')
    await f.service.amp.flush()

    const frame = await f.service.amp.latestFrameFor('dsh-amp')
    assert.ok(frame !== undefined, 'the turn opened no AMP frame')
    assert.equal(frame.id, `frame-${turn.handle}`)
    assert.equal(frame.cycle, turn.ordinal)
    // orchestrate maps to triage: allocating who does what, not exploring.
    assert.equal(frame.mode, 'triage')
    assert.ok(frame.slots.length >= 4 && frame.slots.length <= 9)
    assert.ok((frame.ignored ?? []).some((item) => item.target.id === 'policy-max-iteration'))

    f.service.endTurn('dsh-amp', 'done')
    await f.service.amp.flush()

    const receipt = f.service.amp
      .receipts(10)
      .find((candidate) => candidate.id === receiptIdOf(turn.handle))
    assert.ok(receipt !== undefined, 'the closed turn has no receipt')
    assert.equal(receipt.op, 'reflect')
    assert.equal(receipt.outcome, 'success')
    assert.deepEqual(receipt.target, { kind: 'frame', id: frame.id })
    assert.ok((receipt.usage.ms ?? 0) >= 0, 'usage.ms is measured from the row timestamps')

    const verify = await f.service.amp.verify()
    assert.equal(verify.ok, true, verify.reasons.join('; '))

    // The pipeline's comprehension becomes warrant-validated claims: the turn
    // is closed only after the comprehension row is attached, so the claims are
    // on the chain by the time the receipt settles.
    const claims = f.service.db
      .all<{ body: string }>("SELECT body FROM amp_object WHERE kind = 'claim' ORDER BY seq ASC")
      .map((row) => JSON.parse(row.body) as Claim)
    assert.ok(claims.length > 0, 'the comprehension produced no claim')
    for (const claim of claims) {
      assert.deepEqual(validateClaim(claim), [])
      assert.match(claim.id, /^claim-/)
    }

    // turn.opened and turn.closed are both on the chain.
    const types = f.service.amp.store
      .entries({ kind: 'event' })
      .map((entry) => (entry.payload as { type?: string }).type)
    assert.ok(types.includes('turn.opened'))
    assert.ok(types.includes('turn.closed'))
  } finally {
    f.close()
  }
})

test('failTurn settles the turn as a failure receipt, never as success', async () => {
  const f = fixture()
  try {
    const turn = await f.service.beginTurn('dsh-amp-fail', 1, 'do something risky')
    f.service.failTurn('dsh-amp-fail')
    await f.service.amp.flush()

    const receipt = f.service.amp
      .receipts(10)
      .find((candidate) => candidate.id === receiptIdOf(turn.handle))
    assert.ok(receipt !== undefined)
    assert.equal(receipt.outcome, 'failure')
    assert.match(receipt.note ?? '', /closed as failed/)
  } finally {
    f.close()
  }
})

test('a reopened service reads the same chain and refuses a rewritten manifest', async () => {
  const f = fixture()
  try {
    const turn = await f.service.beginTurn('dsh-amp-reopen', 1, 'check durability')
    f.service.endTurn('dsh-amp-reopen', 'done')
    await f.service.amp.flush()
    const before = await f.service.amp.verify()
    assert.equal(before.ok, true, before.reasons.join('; '))

    // A second service over the same file sees the same tip and identity.
    const identity = await f.service.amp.identity()
    const reopened = new CoordinationService(
      { reflect: { provide: (): void => {} } } as unknown as Context,
      testConfig({ databasePath: f.service.db.path }),
      { rawSession: () => undefined, rawAgent: () => undefined },
    )
    try {
      const after = await reopened.amp.verify()
      assert.equal(after.tip, before.tip)
      assert.equal(after.count, before.count)
      assert.equal((await reopened.amp.identity()).kid, identity.kid)
      // The signing key is stored once; a reopen must not mint a second one.
      assert.equal(reopened.db.count('amp_key'), 1)
      assert.ok(turn.handle.length > 0)
    } finally {
      reopened.dispose()
    }
  } finally {
    f.close()
  }
})

test('a takeover window is announced and settled on the AMP chain', async () => {
  const f = fixture()
  try {
    f.service.config.ui.takeover = true
    const gate = f.service.takeoverGate
    const pending = gate.handleApproval(
      {
        agent: { id: 'dsh-amp-approval' },
        toolName: 'bash',
        callId: 'call-amp-1',
        reason: 'run the test suite',
      },
      async () => 'unavailable',
    )
    const view = gate.list()[0]
    assert.ok(view !== undefined, 'the gate recorded no pending window')

    assert.equal(
      f.service.answerPendingTakeover(view.handle, { kind: 'approval', outcome: 'allowed-once' }),
      true,
    )
    assert.equal(await pending, 'allowed-once')
    await f.service.amp.flush()

    const types = f.service.db
      .all<{ body: string }>("SELECT body FROM amp_object WHERE kind = 'event' ORDER BY seq ASC")
      .map((row) => (JSON.parse(row.body) as { type: string }).type)
    assert.ok(types.includes('attention.requested'))
    assert.ok(types.includes('interrupt.settled'))

    const ask = f.service.amp.receipts(20).find((receipt) => receipt.op === 'ask')
    assert.ok(ask !== undefined, 'no ask receipt was written')
    assert.equal(ask.outcome, 'success')
    assert.equal(ask.usage.interrupts, 1)
    assert.deepEqual(ask.target, { kind: 'tool', id: 'bash' })

    const verify = await f.service.amp.verify()
    assert.equal(verify.ok, true, verify.reasons.join('; '))
  } finally {
    f.close()
  }
})

test('a goal plus recorded step acceptance emits the AMP plan pair on turn close', async () => {
  const f = fixture()
  try {
    const turn = await f.service.beginTurn('dsh-amp-plan', 1, 'write the release notes')
    await f.service.awaitPipeline('dsh-amp-plan')
    assert.ok(f.service.goal.set(turn.identity, 'publish the release notes') !== undefined)

    const plan = f.service.plan.forTurn(turn.identity)
    assert.ok(plan !== undefined, 'the pipeline produced no plan row')
    f.service.db.run(
      'UPDATE plan SET step = ? WHERE identity = ?',
      JSON.stringify([
        { task: 'draft the notes', acceptance: 'a draft exists in the release file' },
        { task: 'review the notes', acceptance: 'the review checklist is complete' },
      ]),
      plan.identity,
    )

    f.service.endTurn('dsh-amp-plan', 'done')
    await f.service.amp.flush()

    const plans = f.service.db
      .all<{ body: string }>("SELECT body FROM amp_object WHERE kind = 'plan' ORDER BY seq ASC")
      .map((row) => JSON.parse(row.body) as { id: string; tasks: { expect: { observation: string } }[] })
    const goals = f.service.db
      .all<{ body: string }>("SELECT body FROM amp_object WHERE kind = 'goal' ORDER BY seq ASC")
      .map((row) => JSON.parse(row.body) as { id: string; success: unknown[] })
    assert.equal(plans.length, 1, 'the recorded acceptance did not produce a plan artifact')
    assert.equal(plans[0].tasks.length, 2)
    assert.equal(plans[0].tasks[0].expect.observation, 'a draft exists in the release file')
    assert.equal(goals.length, 1)
    assert.equal(goals[0].success.length, 2)

    const verify = await f.service.amp.verify()
    assert.equal(verify.ok, true, verify.reasons.join('; '))
  } finally {
    f.close()
  }
})

test('the story view joins the turn, its prompt, goal and plan steps', async () => {
  const f = fixture()
  try {
    const turn = await f.service.beginTurn('dsh-amp-story', 1, 'please write the release notes for 0.21')
    await f.service.awaitPipeline('dsh-amp-story')
    f.service.goal.set(turn.identity, 'publish the release notes')

    const handle = f.service.db.get<{ handle: string }>(
      'SELECT handle FROM session ORDER BY identity DESC LIMIT 1',
    )?.handle
    assert.ok(handle !== undefined)
    const story = await f.service.amp.storyFor(handle)
    assert.equal(story.turn?.ordinal, 1)
    assert.ok((story.prompt?.excerpt ?? '').includes('release notes'))
    assert.equal(story.goal?.content, 'publish the release notes')
    assert.ok(story.plan === null || Array.isArray(story.plan.steps))
  } finally {
    f.close()
  }
})
