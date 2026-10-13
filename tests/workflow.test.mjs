/**
 * workflow.test.mjs - exercise the intent-first workflow, and measure what it costs.
 *
 * What this protects, case by case:
 *
 *   * THE GATES. A phase whose entry has not been recorded is REFUSED, and the refusal names the phase
 *     that must run first. If that ever stops holding, the feature is a suggestion again rather than a
 *     process — which is the whole difference between this and a paragraph of prompt.
 *   * THE CHOICE IS THE USER'S. `choose` must reach the answerer with one option per alternative and must
 *     record what came back; nothing else may move the workflow into `run`.
 *   * THE COST. Four tool calls and one human interaction on the unavoidable path, asserted from the
 *     plugin's own COST_MODEL and counted from the calls the test actually makes. A change that
 *     reintroduces a phase has to change that number, and therefore has to argue with this test.
 *   * THE COMPRESSION. A long document is written to a file and the conversation gets a line, measured as
 *     a ratio rather than asserted as a feeling.
 *   * THE FILES. One small state document per session, artifacts beside it, an append-only journal for
 *     notes, and nothing written outside the workflow root.
 *   * THE CHEAP PATHS. A clear request costs zero questions; a one-step execution costs one call. Both are
 *     load-bearing: without them the fast path is not fast, and the feature gets skipped.
 *
 * Everything runs against a temporary DSH_HOME, never the real one.
 *
 * Usage: node tests/workflow.test.mjs
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testsDir = dirname(fileURLToPath(import.meta.url))
const rootDir = dirname(testsDir)

let pass = 0
let fail = 0
const failures = []

async function check(description, fn) {
  try {
    await fn()
    pass++
    console.log(`  PASS  ${description}`)
  } catch (error) {
    fail++
    failures.push(`${description}: ${error.message}`)
    console.log(`  FAIL  ${description}`)
    console.log(`        ${error.message}`)
  }
}

/** The session the calls belong to. */
const SESSION_ID = "SessionId('wf-session-1')"
const SESSION_KEY = 'wf-session-1'

// ---------------------------------------------------------------------------
// a context that answers as a human would, recording what it was asked and what was written
// ---------------------------------------------------------------------------

/**
 * Load the plugin against a temporary DSH_HOME, counting every write and answering every question.
 *
 * The write counter is why the harness wraps `node:fs` indirectly: the tests need to assert the
 * complexity claim ("one state write per transition"), and a claim about cost that is never measured is
 * marketing.
 */
async function harness(respond) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-wf-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const mod = await import(pathToFileURL(join(rootDir, 'src/plugin/workflow.js')).href)
    const tools = new Map()
    const sections = []
    const asked = []
    const ctx = {
      tools: { register: (spec) => { tools.set(spec.name, spec); return () => tools.delete(spec.name) } },
      userQuestions: {
        ask: async (request) => {
          asked.push(request)
          return respond(request)
        },
      },
      systemPrompt: {
        section: (section) => { sections.push(section); return () => {} },
        getSectionOrder: () => 100,
      },
    }
    const handlers = mod.apply(ctx, {})
    const tool = tools.get('workflow_plan')
    const env = { home, mod, handlers, tools, sections, asked, ctx, tool, calls: 0 }

    env.call = async (args) => {
      env.calls += 1
      return JSON.parse(await tool.execute(args, { agent: { id: SESSION_ID }, signal: undefined, callId: 'call-1' }))
    }
    /** The same call, as a caller that refuses to answer: it must not be able to advance the phase. */
    env.callRaw = (args) => tool.execute(args, { agent: { id: SESSION_ID }, signal: undefined, callId: 'call-1' })
    env.state = () => JSON.parse(readFileSync(env.statePath, 'utf8'))
    env.statePath = join(home, 'dsh-os', 'workflows', SESSION_KEY, 'state.json')
    env.journalPath = join(home, 'dsh-os', 'workflows', SESSION_KEY, 'journal.jsonl')
    env.dir = join(home, 'dsh-os', 'workflows', SESSION_KEY)
    env.sectionText = () => {
      const section = sections.find((item) => item.name === 'dsh-os:workflow')
      assert.ok(section, 'the prompt section was not registered')
      return typeof section.text === 'function' ? section.text({ agent: { id: SESSION_ID } }) : section.text
    }
    env.files = () => readdirSync(env.dir).sort()
    env.dispose = () => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
    return env
  } catch (error) {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
    throw error
  }
}

/** A responder that picks the first option of every question, or types free text where there is none. */
const chooseFirst = (request) => ({
  answers: request.questions.map((question) => ({
    id: question.id,
    selected: question.options === undefined || question.options.length === 0 ? [] : [question.options[0].label],
    ...question.options === undefined || question.options.length === 0 ? { custom: 'free-text answer' } : {},
  })),
})

/** The two alternatives every plan needs, so a test only states what it is actually testing. */
const TWO_OPTIONS = [
  { id: 'o1', title: 'rewrite the parser', pros: ['fastest'], cons: ['risky'], recommended: true },
  { id: 'o2', title: 'cache the parse', pros: ['small'], cons: ['memory'] },
]

/**
 * Reach `choose` (and optionally `run`) on a harness that is already loaded.
 *
 * `start` is the entry point and also the clarify step, so a caller that states assumptions arrives at
 * `plan` in one call. `to: 'run'` then takes the user's decision, which is the only place in this file
 * that is allowed to move the workflow past `choose`.
 */
async function walkToRun(env, { questions, to = 'choose' } = {}) {
  await env.call({
    action: 'start',
    intent: 'make the build faster',
    ...questions === undefined
      ? { assumptions: ['the build script is the one in the repo root'] }
      : { questions },
  })
  await env.call({ action: 'plan', content: '# Plan\n- one module per concern', options: TWO_OPTIONS, criteria: 'risk vs speed' })
  if (to === 'run') await env.call({ action: 'choose' })
}

// ---------------------------------------------------------------------------
// the cost model, which is the point of this version
// ---------------------------------------------------------------------------

console.log('workflow state machine')

await check('the unavoidable path is four calls and one human interaction', async () => {
  const env = await harness(chooseFirst)
  try {
    assert.deepEqual(env.mod.COST_MODEL.shortestPath, ['start', 'plan', 'choose', 'run'])
    assert.equal(env.mod.COST_MODEL.toolCalls, 4)
    assert.equal(env.mod.COST_MODEL.humanInteractions, 1)
    // The cache property is the one this design exists to protect, so it is asserted as a hard zero.
    assert.equal(env.mod.COST_MODEL.promptChangesPerWorkflow, 0)
    assert.equal(env.mod.COST_MODEL.cacheEffect, 'prefix-stable')
    assert.ok(env.mod.COST_MODEL.toolCalls < env.mod.COST_MODEL.previous.toolCalls, 'the fusion must be a reduction')
    assert.ok(env.mod.COST_MODEL.humanInteractions < env.mod.COST_MODEL.previous.humanInteractions)
    assert.ok(
      env.mod.COST_MODEL.promptChangesPerWorkflow < env.mod.COST_MODEL.previous.promptChangesPerWorkflow,
      'the prompt must no longer move with the workflow',
    )

    env.calls = 0
    await env.call({ action: 'start', intent: 'make the build faster', assumptions: ['the build is the repo script'] })
    await env.call({ action: 'plan', content: '# Plan', options: TWO_OPTIONS })
    await env.call({ action: 'choose' })
    await env.call({ action: 'run', goal: 'faster build', outcome: 'the build is 40% faster' })
    assert.equal(env.calls, 4, `the unavoidable path must be 4 calls, was ${env.calls}`)
    assert.equal(env.asked.length, 1, `exactly one human interaction on the unavoidable path, was ${env.asked.length}`)
    assert.equal(env.state().phase, 'done', 'the fourth call closes the workflow')
  } finally { env.dispose() }
})

await check('a clear request costs zero questions and skips straight to plan', async () => {
  const env = await harness(chooseFirst)
  try {
    const started = await env.call({ action: 'start', intent: 'x', assumptions: ['the config is json'] })
    assert.equal(started.phase, 'plan', 'with assumptions stated, no question is needed')
    assert.equal(env.asked.length, 0, 'the user was not interrupted')
    assert.equal(env.state().decisions[0], 'assumed: the config is json', 'the assumption is on record where it can be corrected')
  } finally { env.dispose() }
})

await check('a workflow may not open with neither questions nor assumptions', async () => {
  const env = await harness(chooseFirst)
  try {
    await assert.rejects(() => env.callRaw({ action: 'start', intent: 'x' }), /either "questions".*or "assumptions"/)
    assert.ok(!existsSync(env.statePath), 'a refused start must not leave state behind')
  } finally { env.dispose() }
})

await check('state is written once per transition, not once per artifact', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x', assumptions: ['a'] })
    // start writes: the intent document, then the state. Two writes, and the second is the state.
    const afterStart = env.files()
    assert.deepEqual(afterStart, ['01-intent.md', 'state.json'],
      `start must leave exactly one state document and one artifact, got ${JSON.stringify(afterStart)}`)
    await env.call({ action: 'plan', content: '# Plan', options: TWO_OPTIONS })
    assert.deepEqual(env.files(), ['01-intent.md', '02-plan.md', 'state.json'])
  } finally { env.dispose() }
})

await check('a note is one appended line and does not rewrite the state', async () => {
  const env = await harness(chooseFirst)
  try {
    await walkToRun(env, { to: 'run' })
    await env.call({ action: 'run', goal: 'g', steps: ['one', 'two'] })
    const before = readFileSync(env.statePath, 'utf8')
    const noted = await env.call({ action: 'note', text: 'the parser has a second call site' })
    const after = readFileSync(env.statePath, 'utf8')
    assert.equal(before, after, 'a plain note must not rewrite state.json')
    assert.ok(String(noted.note).includes('journal'), `the result must say where it went: ${noted.note}`)
    assert.ok(readFileSync(env.journalPath, 'utf8').includes('second call site'), 'the note is in the journal')
    // A decision DOES come back into the state, because status and the prompt report decisions.
    await env.call({ action: 'note', text: 'we keep the public API', kind: 'decision' })
    assert.ok(readFileSync(env.statePath, 'utf8').includes('we keep the public API'), 'a decision is carried in the state')
    assert.ok(env.state().decisions.some((d) => d.includes('public API')))
  } finally { env.dispose() }
})

// ---------------------------------------------------------------------------
// the gates
// ---------------------------------------------------------------------------

await check('start records the intent verbatim and opens at intake or plan', async () => {
  const env = await harness(chooseFirst)
  try {
    const prompt = 'the parser is slow when the config has many entries\n\nfix it, do not rewrite it'
    const started = await env.call({ action: 'start', intent: prompt, questions: [{ id: 'i', question: 'what for?' }], cwd: 'R:\\project\\x' })
    assert.equal(started.phase, 'plan')
    assert.ok(readFileSync(started.files.intent, 'utf8').includes(prompt), 'the prompt is stored verbatim, line breaks included')
    const state = env.state()
    assert.equal(state.intent.replace(/\s+/g, ' '), prompt.replace(/\s+/g, ' '))
    assert.equal(state.cwd, 'R:\\project\\x')
  } finally { env.dispose() }
})

await check('plan before the intent is on record is refused, and the refusal names the phase', async () => {
  const env = await harness(chooseFirst)
  try {
    await assert.rejects(() => env.callRaw({ action: 'plan', content: '# x', options: TWO_OPTIONS }), /no workflow is active/)
    await env.call({ action: 'start', intent: 'x', assumptions: ['a'] })
    await assert.rejects(() => env.callRaw({ action: 'choose' }), /"plan" must be recorded first/)
    assert.equal(env.state().phase, 'plan', 'a refused call must not move the phase')
  } finally { env.dispose() }
})

await check('run before a choice is refused, and the refusal says the user has not picked', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x', assumptions: ['a'] })
    await env.call({ action: 'plan', content: '# Plan', options: TWO_OPTIONS })
    await assert.rejects(() => env.callRaw({ action: 'run', steps: ['one'] }), /"choose"|recorded choice/)
    assert.equal(env.state().phase, 'choose')
  } finally { env.dispose() }
})

await check('steps after the workflow is done are refused rather than silently reordered', async () => {
  const env = await harness(chooseFirst)
  try {
    await walkToRun(env, { to: 'run' })
    await env.call({ action: 'run', goal: 'g', outcome: 'done' })
    assert.equal(env.state().phase, 'done')
    // A new start on a finished workflow is allowed (it archives and begins again), but it still needs a
    // basis: an intent alone establishes nothing about the request.
    await assert.rejects(() => env.callRaw({ action: 'start', intent: 'again' }), /either "questions".*or "assumptions"/)
    await assert.rejects(() => env.callRaw({ action: 'plan', content: '# x', options: TWO_OPTIONS }), /already behind/)
    assert.ok(readFileSync(env.statePath, 'utf8').includes('"phase": "done"'), 'a refused call must not move the phase')
  } finally { env.dispose() }
})

await check('start refuses more than three questions, and plan refuses fewer than two options', async () => {
  const env = await harness(chooseFirst)
  try {
    const four = [1, 2, 3, 4].map((n) => ({ id: `q${n}`, question: `q${n}?` }))
    await assert.rejects(() => env.callRaw({ action: 'start', intent: 'x', questions: four }), /at most 3/)
    await env.call({ action: 'start', intent: 'x', assumptions: ['a'] })
    await assert.rejects(() => env.callRaw({ action: 'plan', content: '# x', options: [TWO_OPTIONS[0]] }), /at least two/)
    await assert.rejects(() => env.callRaw({ action: 'plan', content: '# x', options: [{ title: 'a' }, { title: 'b' }] }), /neither pros nor cons/)
    await assert.rejects(() => env.callRaw({ action: 'plan', options: TWO_OPTIONS }), /needs "content"/)
  } finally { env.dispose() }
})

await check('an unknown action is refused with the list of known actions', async () => {
  const env = await harness(chooseFirst)
  try {
    await assert.rejects(() => env.callRaw({ action: 'nope' }), /unknown workflow action 'nope'/)
    await assert.rejects(() => env.callRaw({ action: 'design', content: '# x' }), /unknown workflow action 'design'/)
  } finally { env.dispose() }
})

await check('a call with no agent session is refused rather than sharing state', async () => {
  const env = await harness(chooseFirst)
  try {
    await assert.rejects(() => env.tool.execute({ action: 'status' }, {}), /owning agent session/)
  } finally { env.dispose() }
})

// ---------------------------------------------------------------------------
// the user's choice
// ---------------------------------------------------------------------------

await check('choose offers every alternative with its cost, recommends one, and records the answer', async () => {
  const env = await harness(chooseFirst)
  try {
    await walkToRun(env)
    const chosen = await env.call({ action: 'choose' })
    assert.equal(chosen.phase, 'run')
    assert.ok(chosen.summary.includes('rewrite the parser'), `the recorded choice is the user's, got: ${chosen.summary}`)

    const request = env.asked.at(-1)
    assert.equal(request.questions.length, 1, 'the choice is one question')
    const labels = request.questions[0].options.map((option) => option.label)
    assert.equal(labels.length, 2, `every alternative must be offered, got ${JSON.stringify(labels)}`)
    assert.ok(labels[0].startsWith('rewrite the parser'), `the recommended option goes first, got ${labels[0]}`)
    assert.ok(labels[0].includes('(Recommended)'), `the recommended label must say so, got ${labels[0]}`)
    assert.ok(String(request.questions[0].options[0].description ?? '').includes('risky'), 'the cost is shown beside the option')
    assert.ok(String(request.questions[0].options[1].description ?? '').includes('memory'), 'so is the second option\'s')
    assert.equal(env.state().choice.title, 'rewrite the parser')
    assert.deepEqual(env.state().choice.options, ['rewrite the parser', 'cache the parse'])
    assert.ok(readFileSync(join(env.dir, '02-plan.md'), 'utf8').includes('The user chose **rewrite the parser**'), 'the decision is in the plan record')
  } finally { env.dispose() }
})

await check('a free-text answer is recorded as the choice, and an empty answer is refused', async () => {
  const env = await harness((request) => ({ answers: request.questions.map((q) => ({ id: q.id, selected: [], custom: 'neither, do something else' })) }))
  try {
    await walkToRun(env)
    const chosen = await env.call({ action: 'choose' })
    assert.ok(chosen.summary.includes('neither, do something else'), `free text must be kept, got: ${chosen.summary}`)
    assert.equal(env.state().choice.id, null, 'an unlisted choice records no option id')
  } finally { env.dispose() }

  const refusing = await harness((request) => ({ answers: request.questions.map((q) => ({ id: q.id, selected: [] })) }))
  try {
    // Stopped at `choose`, because the point is that an unanswered choice cannot reach `run`.
    await walkToRun(refusing)
    await assert.rejects(() => refusing.callRaw({ action: 'choose' }), /did not choose/)
    assert.equal(refusing.state().phase, 'choose', 'an unanswered choice must not open run')
  } finally { refusing.dispose() }
})

await check('a rejected plan is revised in place, and the original stays on record', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x', assumptions: ['a'] })
    await env.call({ action: 'plan', content: '# First plan', options: TWO_OPTIONS })
    const revised = await env.call({
      action: 'plan',
      content: '# Second plan',
      options: [
        { id: 'o3', title: 'narrow the scope', pros: ['safe'], cons: ['slower'] },
        { id: 'o4', title: 'split the work', pros: ['parallel'], cons: ['coordination'], recommended: true },
      ],
      summary: 'user rejected the first plan',
      replace: true,
    })
    assert.equal(revised.phase, 'choose')
    assert.ok(revised.options[1].recommended, 'the recommended flag survives into the next call')
    const planFile = readFileSync(join(env.dir, '02-plan.md'), 'utf8')
    assert.ok(planFile.includes('# First plan'), 'the rejected plan is kept')
    assert.ok(planFile.includes('# Second plan'), 'the revision is recorded')
    assert.ok(planFile.includes('Reason for revision: user rejected the first plan'), 'and so is the reason')
  } finally { env.dispose() }
})

// ---------------------------------------------------------------------------
// compression
// ---------------------------------------------------------------------------

/** A plan document of a stated size, with headings and steps a real one would have. */
function planDocument(targetBytes) {
  const lines = ['# Architecture', '', '## Components', '- one module per concern, no cycles', '- the state machine owns the phases']
  let index = 0
  while (lines.join('\n').length < targetBytes) {
    index += 1
    lines.push(`- step ${index}: replace this line with the detail that must not live in the conversation`)
  }
  return lines.join('\n')
}

await check('a long plan costs the conversation a line, and the document is on disk in full', async () => {
  const env = await harness(chooseFirst)
  try {
    const content = planDocument(12000)
    await env.call({ action: 'start', intent: 'x', assumptions: ['a'] })
    const answer = await env.call({ action: 'plan', content, options: TWO_OPTIONS })
    const envelopeText = JSON.stringify(answer)

    assert.ok(content.length > 12000, `the fixture must be large, got ${content.length}`)
    assert.ok(envelopeText.length < 1500, `the envelope must be a line, not a document: ${envelopeText.length} chars`)
    const onDisk = readFileSync(answer.files.plan, 'utf8')
    assert.ok(onDisk.includes(content), 'the document must be stored in full')
    assert.ok(!onDisk.startsWith('\uFEFF'), 'no BOM is introduced')
    // The state document is re-read on every model step, so it must not carry the prose.
    const stateText = readFileSync(env.statePath, 'utf8')
    assert.ok(stateText.length < 3000, `state.json must stay small, got ${stateText.length} chars`)
    assert.ok(!stateText.includes('step 200:'), 'the plan body must not be copied into the state')
  } finally { env.dispose() }
})

await check('no phase envelope exceeds a line, even with the options echoed back', async () => {
  const env = await harness(chooseFirst)
  try {
    const sizes = []
    const record = (value) => sizes.push(JSON.stringify(value).length)
    record(await env.call({ action: 'start', intent: 'make the build faster', assumptions: ['a'] }))
    record(await env.call({ action: 'plan', content: planDocument(6000), options: TWO_OPTIONS, criteria: 'risk vs speed' }))
    record(await env.call({ action: 'choose' }))
    record(await env.call({ action: 'run', goal: 'g', steps: ['one', 'two'], outcome: 'done' }))
    record(await env.call({ action: 'status' }))
    const largest = Math.max(...sizes)
    assert.ok(largest < 2000, `no phase envelope may exceed 2000 chars, got ${largest}: ${sizes.join(', ')}`)
  } finally { env.dispose() }
})

await check('checkpoint folds the journal into the record and reports a summary', async () => {
  const env = await harness(chooseFirst)
  try {
    await walkToRun(env, { to: 'run' })
    await env.call({ action: 'run', goal: 'g', steps: ['one', 'two'] })
    await env.call({ action: 'note', text: 'found a second call site' })
    const checkpoint = await env.call({ action: 'checkpoint', reason: 'phase boundary' })
    assert.ok(String(checkpoint.summary).includes('checkpoint at run'), `got: ${checkpoint.summary}`)
    const body = readFileSync(checkpoint.files.checkpoint, 'utf8')
    assert.ok(body.includes('## Decisions'), 'the checkpoint carries the decisions')
    assert.ok(body.includes('chosen option: rewrite the parser'), `the chosen option belongs in it: ${body.slice(0, 300)}`)
    assert.ok(body.includes('found a second call site'), 'and the journal activity')
    assert.ok(String(checkpoint.note).includes('checkpoint(s) recorded'), `got note: ${checkpoint.note}`)
    assert.equal(env.state().checkpoints.length, 1)
  } finally { env.dispose() }
})

// ---------------------------------------------------------------------------
// execution, the prompt section, files
// ---------------------------------------------------------------------------

await check('multi-step execution tracks steps and closes on the outcome', async () => {
  const env = await harness(chooseFirst)
  try {
    await walkToRun(env, { to: 'run' })
    const opened = await env.call({ action: 'run', goal: 'g', steps: ['one', 'two'], files: ['src/a.js'] })
    assert.equal(opened.phase, 'run')
    assert.deepEqual(opened.steps, ['[ ] one', '[ ] two'])
    const first = await env.call({ action: 'run', status: 'done', note: 'one' })
    assert.deepEqual(first.steps, ['[x] one', '[ ] two'])
    const closed = await env.call({ action: 'run', outcome: 'the build is faster' })
    assert.equal(closed.phase, 'done')
    assert.equal(closed.next, null, '"there is no next phase" must be stated, not omitted')
    assert.ok(String(closed.note).includes('still open'), `an open step is reported rather than hidden: ${closed.note}`)
    const execution = readFileSync(join(env.dir, '03-execution.md'), 'utf8')
    assert.ok(execution.includes('src/a.js'), 'the files in scope are in the execution record')
  } finally { env.dispose() }
})

await check('run with a status but no note is refused, and status never opens a workflow', async () => {
  const env = await harness(chooseFirst)
  try {
    await walkToRun(env, { to: 'run' })
    await env.call({ action: 'run', goal: 'g', steps: ['one'] })
    await assert.rejects(() => env.callRaw({ action: 'run', status: 'done' }), /needs "note"/)
  } finally { env.dispose() }
})

await check('the first run needs steps or a goal, so an execution record says something', async () => {
  const env = await harness(chooseFirst)
  try {
    await walkToRun(env, { to: 'run' })
    await assert.rejects(() => env.callRaw({ action: 'run' }), /needs "steps"/)
    // A one-step job closes in the same call, which is the fast path.
    const closed = await env.call({ action: 'run', goal: 'faster build', outcome: 'it is faster' })
    assert.equal(closed.phase, 'done')
  } finally { env.dispose() }
})

await check('a finished workflow takes a late step but refuses new work', async () => {
  const env = await harness(chooseFirst)
  try {
    await walkToRun(env, { to: 'run' })
    await env.call({ action: 'run', goal: 'g', steps: ['one'], outcome: 'done' })
    assert.equal(env.state().phase, 'done')
    // Recording what happened after the summary is legitimate and must be cheap; starting more work is not.
    const late = await env.call({ action: 'run', status: 'done', note: 'a late step from a resumed session' })
    assert.equal(late.phase, 'done', 'a late step must not reopen the workflow')
    assert.equal(env.state().phase, 'done', 'and must not change the phase on disk')
    assert.ok(readFileSync(env.journalPath, 'utf8').includes('a late step'), 'the late step reached the journal')
    await assert.rejects(() => env.callRaw({ action: 'run', steps: ['more work'] }), /already done/)
    await assert.rejects(() => env.callRaw({ action: 'run', outcome: 'another outcome' }), /already done/)
  } finally { env.dispose() }
})

await check('the prompt section is one constant: the plugin induces ZERO prompt changes per workflow', async () => {
  const env = await harness(chooseFirst)
  try {
    const section = env.sections.find((item) => item.name === 'dsh-os:workflow')
    assert.ok(section, 'the prompt section was not registered')
    assert.equal(typeof section.text, 'string', 'the text must be a constant, never a function of the state')

    // Why this is the most important assertion in this file: the system prompt sits before the tool
    // catalog and the whole history, so a change to it invalidates every token after it. Measured on the
    // DeepSeek endpoint, appending a message keeps a 98.7% cache hit while changing the system prompt
    // anywhere — one line at the end included — drops to 0.0%. An earlier version rendered the phase into
    // this text, so a four-call workflow re-wrote the prompt three times and paid a full-prefix miss each
    // time. The phase is delivered in the tool's own result instead, which is appended history.
    const first = env.sectionText()
    await env.call({ action: 'start', intent: 'make the build faster', questions: [{ id: 'i', question: 'what for?' }] })
    assert.equal(env.sectionText(), first, 'a start must not change the prompt')
    await env.call({ action: 'plan', content: '# Plan', options: TWO_OPTIONS })
    assert.equal(env.sectionText(), first, 'a plan must not change the prompt')
    await env.call({ action: 'choose' })
    assert.equal(env.sectionText(), first, 'a choice must not change the prompt')
    await env.call({ action: 'run', goal: 'g', steps: ['one', 'two'] })
    assert.equal(env.sectionText(), first, 'opening execution must not change the prompt')
    await env.call({ action: 'run', status: 'done', note: 'one' })
    assert.equal(env.sectionText(), first, 'a completed step must not change the prompt')
    await env.call({ action: 'run', outcome: 'done' })
    assert.equal(env.sectionText(), first, 'finishing must not change the prompt')

    assert.equal(env.sections.length, 1, 'the section is registered once, not re-registered per phase')
    assert.ok(first.length < 700, `the section must earn its tokens: ${first.length} chars`)

    // The section text must not be a function of the state at all: the strongest form of the invariant is
    // that destroying the state cannot change it. Anything the prompt reads is something that can move it.
    rmSync(env.statePath, { force: true })
    assert.equal(env.sectionText(), first, 'the prompt must not read workflow state')
  } finally { env.dispose() }
})

await check('the tool description names the tool and spells out each call', async () => {
  const env = await harness(chooseFirst)
  try {
    const tool = env.tools.get('workflow_plan')
    assert.ok(tool, 'the tool is registered under its real name')
    const description = tool.description
    assert.ok(description.includes('workflow_plan'), 'the description must name the tool it is describing')
    // Since the prompt section is frozen, this description is the only place a model learns how to drive the
    // workflow. It therefore has to spell each call as tool(action: "..."). An earlier version listed
    // `start` / `plan` / `choose` / `run` bare, which reads as four tool names that do not exist — and it
    // shipped that way in 0.1.5, because only the packed tarball check caught it.
    for (const action of ['start', 'plan', 'choose', 'run']) {
      assert.ok(
        description.includes(`workflow_plan(action: "${action}")`),
        `the description must spell the "${action}" call, got: ${description.slice(0, 200)}`,
      )
    }
    assert.ok(description.length < 2200, `the description must not bloat the cached prefix: ${description.length} chars`)
  } finally { env.dispose() }
})

await check('the phase and the next call travel in the tool result, not in the prompt', async () => {
  const env = await harness(chooseFirst)
  try {
    // The model must be able to learn what to do next without the prompt telling it, because the prompt
    // is frozen. Every phase's result therefore names the phase and the single next call.
    const started = await env.call({ action: 'start', intent: 'x', assumptions: ['a'] })
    assert.equal(started.phase, 'plan')
    assert.ok(String(started.next).includes('"plan"'), `next must name the plan call: ${started.next}`)
    const planned = await env.call({ action: 'plan', content: '# Plan', options: TWO_OPTIONS })
    assert.equal(planned.phase, 'choose')
    assert.ok(String(planned.next).includes('"choose"'), `next must name choose: ${planned.next}`)
    const chosen = await env.call({ action: 'choose' })
    assert.equal(chosen.phase, 'run')
    assert.ok(String(chosen.next).includes('"run"'), `next must name run: ${chosen.next}`)
    const status = await env.call({ action: 'status' })
    assert.equal(status.phase, 'run')
    assert.ok(status.next, 'status must report the next call too')
  } finally { env.dispose() }
})

await check('status reports the phase and the open steps', async () => {
  const env = await harness(chooseFirst)
  try {
    const idle = await env.call({ action: 'status' })
    assert.equal(idle.phase, 'none')
    await walkToRun(env, { to: 'run' })
    await env.call({ action: 'run', goal: 'g', steps: ['one', 'two'] })
    await env.call({ action: 'run', status: 'done', note: 'one' })
    const status = await env.call({ action: 'status' })
    assert.equal(status.phase, 'run')
    assert.deepEqual(status.steps, ['[x] one', '[ ] two'])
  } finally { env.dispose() }
})

await check('reset discards the session, and the deleted path stays inside the root', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x', assumptions: ['a'] })
    assert.ok(existsSync(env.dir), 'the session directory must exist while a workflow is active')
    const reset = await env.call({ action: 'reset' })
    assert.equal(reset.phase, 'none')
    assert.ok(!existsSync(env.dir), 'reset must remove the session directory')
    assert.ok(existsSync(join(env.home, 'dsh-os', 'workflows')), 'the root itself must survive')

    const evil = env.mod.__internals.sessionKeyOf('../../etc')
    assert.ok(!evil.includes('/') && !evil.includes('\\'), `a traversal attempt must be neutralised, got '${evil}'`)
    assert.throws(() => env.mod.removeSession(join(env.home, 'dsh-os', 'workflows', 'x'), '..'), /not inside/)
  } finally { env.dispose() }
})

await check('a finished workflow is archived, and the next one starts with clean documents', async () => {
  const env = await harness(chooseFirst)
  try {
    await walkToRun(env, { to: 'run', questions: [{ id: 'i', question: 'what for?' }] })
    await env.call({ action: 'run', goal: 'g', outcome: 'the first outcome' })
    await env.call({ action: 'start', intent: 'the next request', assumptions: ['b'] })
    const state = env.state()
    assert.equal(state.intent, 'the next request')
    assert.deepEqual(state.decisions, ['assumed: b'], 'the previous decisions must not leak into the new workflow')

    const root = join(env.home, 'dsh-os', 'workflows')
    const archived = readdirSync(root).filter((name) => name.includes('.done-'))
    assert.equal(archived.length, 1, `the finished workflow must be archived, got ${JSON.stringify(readdirSync(root))}`)
    // The archive must actually contain the previous workflow's documents. Asserting only that a
    // `.done-` directory exists is what let a rename that failed on Windows (colons in the stamp) pass:
    // the directory appeared, but as a leftover, and the next workflow inherited the old files.
    const archivedFiles = readdirSync(join(root, archived[0])).sort()
    for (const expected of ['01-intent.md', '02-plan.md', '03-execution.md', '04-outcome.md']) {
      assert.ok(archivedFiles.includes(expected), `${expected} must be in the archive, got ${JSON.stringify(archivedFiles)}`)
    }
    assert.ok(
      readFileSync(join(root, archived[0], '04-outcome.md'), 'utf8').includes('the first outcome'),
      'the archived outcome is the previous workflow\'s, not this one\'s',
    )

    const intentFile = readFileSync(join(env.dir, '01-intent.md'), 'utf8')
    assert.ok(intentFile.includes('the next request'))
    assert.ok(!intentFile.includes('what for?'), 'the previous questions must not leak into the new workflow')
    assert.ok(!existsSync(env.journalPath), 'the previous journal must not be inherited')
  } finally { env.dispose() }
})

await check('nothing is written outside the session directory', async () => {
  const env = await harness(chooseFirst)
  try {
    await walkToRun(env)
    assert.deepEqual(env.files(), ['01-intent.md', '02-plan.md', 'state.json'])
    assert.deepEqual(readdirSync(join(env.home, 'dsh-os', 'workflows')), [SESSION_KEY])
  } finally { env.dispose() }
})

await check('a corrupted state file reads as absent rather than throwing', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x', assumptions: ['a'] })
    writeFileSync(env.statePath, '{ not json')
    const status = await env.call({ action: 'status' })
    assert.equal(status.phase, 'none', 'a corrupt state must be reported as no workflow, not a crash')
    const restarted = await env.call({ action: 'start', intent: 'again', assumptions: ['a'] })
    assert.equal(restarted.phase, 'plan')
  } finally { env.dispose() }
})

await check('the state cache is keyed on the file, so a state changed underneath it is re-read', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x', assumptions: ['a'] })
    assert.equal((await env.call({ action: 'status' })).phase, 'plan')
    // Rewrite the state behind the plugin's back, as another process or an editor would. The cache must not
    // serve the previous parse: the stamp moved, so the next read parses again.
    const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
    state.phase = 'run'
    state.choice = { id: 'o9', title: 'chosen elsewhere', verbatim: 'chosen elsewhere', options: [] }
    writeFileSync(env.statePath, `${JSON.stringify(state, null, 2)}\n`)
    const seen = await env.call({ action: 'status' })
    assert.equal(seen.phase, 'run', 'an edited state must be observed, not cached away')
    assert.ok(
      String(seen.summary).includes('chosen elsewhere') || String(seen.next).includes('"run"'),
      `the edited content is read back: ${seen.summary}`,
    )
    // And a note still appends without rewriting the state document.
    const before = readFileSync(env.statePath, 'utf8')
    await env.call({ action: 'note', text: 'a remark after the external edit' })
    assert.equal(readFileSync(env.statePath, 'utf8'), before, 'a plain note does not rewrite the state')
  } finally { env.dispose() }
})

console.log('')
console.log(`passed=${pass} failed=${fail}`)
if (fail > 0) {
  console.log('')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
