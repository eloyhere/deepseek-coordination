/**
 * workflow.test.mjs - exercise the intent-first workflow state machine.
 *
 * What this protects, case by case:
 *
 *   * the gates. A phase whose entry has not been recorded is REFUSED, and the refusal names the phase
 *     that must run first. If that ever stops holding, the feature is a suggestion again rather than a
 *     process, which is the whole difference between this and a paragraph of prompt.
 *   * the choice is the user's. `choose` must reach the answerer with one option per alternative and
 *     must record what came back; nothing else may move the phase to `execute`.
 *   * the compression. A long document is written to a file and the conversation gets a line. This is
 *     measured as a ratio, because "it felt smaller" is not a measurement.
 *   * the files. State is one small JSON document per session, artifacts are markdown beside it, and
 *     nothing is written outside the workflow root.
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
// a context that answers as a human would, recording what it was asked
// ---------------------------------------------------------------------------

/**
 * Load the plugin against a temporary DSH_HOME and answer every question with `respond`.
 *
 * `respond` receives the questions exactly as the plugin hands them to the answerer, which is the only
 * way to assert what the user is actually shown.
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
    const tool = tools.get('workflow')
    const env = { home, mod, handlers, tools, sections, asked, ctx, tool }

    env.call = async (args) => JSON.parse(await tool.execute(args, { agent: { id: SESSION_ID }, signal: undefined, callId: 'call-1' }))
    /** The same call, as a caller that refuses to answer: it must not be able to advance the phase. */
    env.callRaw = (args) => tool.execute(args, { agent: { id: SESSION_ID }, signal: undefined, callId: 'call-1' })
    env.state = () => JSON.parse(readFileSync(join(home, 'dsh-os', 'workflows', SESSION_KEY, 'state.json'), 'utf8'))
    env.statePath = join(home, 'dsh-os', 'workflows', SESSION_KEY, 'state.json')
    env.dir = join(home, 'dsh-os', 'workflows', SESSION_KEY)
    env.sectionText = () => {
      const section = sections.find((s) => s.name === 'dsh-os:workflow')
      assert.ok(section, 'the prompt section was not registered')
      return typeof section.text === 'function' ? section.text({ agent: { id: SESSION_ID } }) : section.text
    }
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

/** A responder that picks the first option of every question, or types free text when asked to. */
const chooseFirst = (request) => ({
  answers: request.questions.map((question) => ({
    id: question.id,
    selected: question.options === undefined || question.options.length === 0 ? [] : [question.options[0].label],
    ...question.options === undefined || question.options.length === 0 ? { custom: 'free-text answer' } : {},
  })),
})

// ---------------------------------------------------------------------------
// the gates
// ---------------------------------------------------------------------------

console.log('workflow state machine')

await check('start records the intent and opens at clarify', async () => {
  const env = await harness(chooseFirst)
  try {
    const started = await env.call({ action: 'start', intent: 'make the build faster', cwd: 'R:\\project\\x' })
    assert.equal(started.phase, 'clarify')
    assert.equal(started.ok, true)
    assert.ok(String(started.next).includes('clarify'), `next must name the clarify phase, got: ${started.next}`)
    const state = env.state()
    assert.equal(state.phase, 'clarify')
    assert.equal(state.intent, 'make the build faster')
    assert.equal(state.cwd, 'R:\\project\\x')
  } finally { env.dispose() }
})

await check('design before clarify is refused, and the refusal names the phase that must run first', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x' })
    await assert.rejects(() => env.callRaw({ action: 'design', content: '# plan' }), /clarify/)
    assert.equal(env.state().phase, 'clarify', 'a refused call must not move the phase')
  } finally { env.dispose() }
})

await check('options before design is refused, and choose before options is refused', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x' })
    await assert.rejects(() => env.callRaw({ action: 'options', options: [{ title: 'a' }, { title: 'b' }] }), /design/)
    await env.call({ action: 'clarify', questions: [{ id: 'i', question: 'what for?' }] })
    await assert.rejects(() => env.callRaw({ action: 'choose' }), /options/)
    assert.equal(env.state().phase, 'design')
  } finally { env.dispose() }
})

await check('execute without a recorded choice is refused', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x' })
    await env.call({ action: 'clarify', questions: [{ id: 'i', question: 'what for?' }] })
    await env.call({ action: 'design', content: '# Plan\n- a\n- b' })
    await env.call({ action: 'options', options: [{ title: 'a', pros: ['p'] }, { title: 'b', cons: ['c'] }] })
    await assert.rejects(() => env.callRaw({ action: 'execute', goal: 'g' }), /choose|choice/)
    assert.equal(env.state().phase, 'choose')
  } finally { env.dispose() }
})

await check('a second start while a workflow is active is refused, and reset allows it', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'first' })
    await assert.rejects(() => env.callRaw({ action: 'start', intent: 'second' }), /reset: true/)
    const again = await env.call({ action: 'start', intent: 'second', reset: true })
    assert.equal(again.phase, 'clarify')
    assert.equal(env.state().intent, 'second')
  } finally { env.dispose() }
})

await check('clarify needs questions and refuses more than three', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x' })
    await assert.rejects(() => env.callRaw({ action: 'clarify', questions: [] }), /at least one question/)
    const four = [1, 2, 3, 4].map((n) => ({ id: `q${n}`, question: `q${n}?` }))
    await assert.rejects(() => env.callRaw({ action: 'clarify', questions: four }), /at most 3/)
  } finally { env.dispose() }
})

await check('options needs at least two alternatives, each with a pro or a con', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x' })
    await env.call({ action: 'clarify', questions: [{ id: 'i', question: 'what for?' }] })
    await env.call({ action: 'design', content: '# Plan' })
    await assert.rejects(() => env.callRaw({ action: 'options', options: [{ title: 'only one' }] }), /at least two/)
    await assert.rejects(
      () => env.callRaw({ action: 'options', options: [{ title: 'a' }, { title: 'b' }] }),
      /neither pros nor cons/,
    )
  } finally { env.dispose() }
})

await check('an unknown action is refused with the list of known actions', async () => {
  const env = await harness(chooseFirst)
  try {
    await assert.rejects(() => env.callRaw({ action: 'nope' }), /unknown workflow action 'nope'/)
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

await check('choose asks the user, offers every alternative, and records the answer', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x' })
    await env.call({ action: 'clarify', questions: [{ id: 'i', question: 'what for?' }] })
    await env.call({ action: 'design', content: '# Plan' })
    await env.call({
      action: 'options',
      options: [
        { id: 'o1', title: 'rewrite the parser', pros: ['fastest'], cons: ['risky'], recommended: true },
        { id: 'o2', title: 'cache the parse', pros: ['small'], cons: ['memory'] },
      ],
    })
    const chosen = await env.call({ action: 'choose' })
    assert.equal(chosen.phase, 'execute')
    assert.ok(chosen.summary.includes('rewrite the parser'), `the recorded choice must be the user's, got: ${chosen.summary}`)

    const request = env.asked.at(-1)
    assert.equal(request.questions.length, 1, 'the choice is one question')
    const labels = request.questions[0].options.map((o) => o.label)
    assert.equal(labels.length, 2, `every alternative must be offered, got ${JSON.stringify(labels)}`)
    assert.ok(labels[0].startsWith('rewrite the parser'), `the recommended option goes first, got ${labels[0]}`)
    assert.ok(labels[0].includes('(Recommended)'), `the recommended label must say so, got ${labels[0]}`)
    assert.ok(labels[1].includes('cache the parse'), `the second alternative must be offered, got ${labels[1]}`)
    assert.ok(String(request.questions[0].options[1].description ?? '').includes('memory'), 'the cost is shown beside the option')

    const state = env.state()
    assert.equal(state.choice.title, 'rewrite the parser')
    assert.deepEqual(state.choice.options, ['rewrite the parser', 'cache the parse'])
  } finally { env.dispose() }
})

await check('a free-text answer is recorded as the choice, and an empty answer is refused', async () => {
  const env = await harness((request) => ({ answers: request.questions.map((q) => ({ id: q.id, selected: [], custom: 'neither, do something else' })) }))
  try {
    await env.call({ action: 'start', intent: 'x' })
    await env.call({ action: 'clarify', questions: [{ id: 'i', question: 'what for?' }] })
    await env.call({ action: 'design', content: '# Plan' })
    await env.call({ action: 'options', options: [{ title: 'a', pros: ['p'] }, { title: 'b', pros: ['p'] }] })
    const chosen = await env.call({ action: 'choose' })
    assert.ok(chosen.summary.includes('neither, do something else'), `free text must be kept, got: ${chosen.summary}`)
  } finally { env.dispose() }

  const refusing = await harness((request) => ({ answers: request.questions.map((q) => ({ id: q.id, selected: [] })) }))
  try {
    await refusing.call({ action: 'start', intent: 'x' })
    await refusing.call({ action: 'clarify', questions: [{ id: 'i', question: 'what for?' }] })
    await refusing.call({ action: 'design', content: '# Plan' })
    await refusing.call({ action: 'options', options: [{ title: 'a', pros: ['p'] }, { title: 'b', pros: ['p'] }] })
    await assert.rejects(() => refusing.callRaw({ action: 'choose' }), /did not choose/)
    assert.equal(refusing.state().phase, 'choose', 'an unanswered choice must not open execute')
  } finally { refusing.dispose() }
})

// ---------------------------------------------------------------------------
// compression
// ---------------------------------------------------------------------------

/** A design document of a stated size, with headings and steps a real one would have. */
function designDocument(targetBytes) {
  const lines = ['# Architecture', '', '## Components', '- one module per concern, no cycles', '- the state machine owns the phases']
  let index = 0
  while (lines.join('\n').length < targetBytes) {
    index += 1
    lines.push(`- step ${index}: replace this line with the detail that must not live in the conversation`)
  }
  return lines.join('\n')
}

await check('a long design costs the conversation one line, and the document is on disk in full', async () => {
  const env = await harness(chooseFirst)
  try {
    const content = designDocument(12000)
    await env.call({ action: 'start', intent: 'x' })
    await env.call({ action: 'clarify', questions: [{ id: 'i', question: 'what for?' }] })
    const answer = await env.call({ action: 'design', content })
    const envelopeText = JSON.stringify(answer)

    assert.ok(content.length > 12000, `the fixture must be large, got ${content.length}`)
    assert.ok(
      envelopeText.length < 1500,
      `the envelope must be a line, not a document: ${envelopeText.length} chars`,
    )
    const file = answer.files.design
    assert.ok(existsSync(file), `the design file must exist at ${file}`)
    const onDisk = readFileSync(file, 'utf8')
    assert.ok(onDisk.includes(content), 'the document must be stored in full')
    assert.ok(!onDisk.startsWith('\uFEFF'), 'no BOM is introduced')
    // The state document carries the plan, not the prose: it is re-read on every model step.
    const stateText = readFileSync(env.statePath, 'utf8')
    assert.ok(stateText.length < 3000, `state.json must stay small, got ${stateText.length} chars`)
    assert.ok(!stateText.includes('step 200:'), 'the design body must not be copied into the state')
  } finally { env.dispose() }
})

await check('every phase result is small, and the largest is still a small object', async () => {
  const env = await harness(chooseFirst)
  try {
    const sizes = []
    const record = (value) => sizes.push(JSON.stringify(value).length)
    record(await env.call({ action: 'start', intent: 'make the build faster' }))
    record(await env.call({ action: 'clarify', questions: [{ id: 'i', question: 'what for?' }] }))
    record(await env.call({ action: 'design', content: designDocument(6000) }))
    record(await env.call({
      action: 'options',
      options: [
        { title: 'a', pros: ['p'], cons: ['c'] },
        { title: 'b', pros: ['p'], cons: ['c'] },
      ],
    }))
    record(await env.call({ action: 'choose' }))
    record(await env.call({ action: 'execute', goal: 'g', steps: ['one', 'two'] }))
    record(await env.call({ action: 'progress', step: 'one' }))
    record(await env.call({ action: 'status' }))
    const largest = Math.max(...sizes)
    assert.ok(largest < 2000, `no phase envelope may exceed 2000 chars, got ${largest}: ${sizes.join(', ')}`)
  } finally { env.dispose() }
})

await check('checkpoint writes the record to a file and reports a summary, not the record', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x' })
    await env.call({ action: 'clarify', questions: [{ id: 'i', question: 'what for?' }] })
    await env.call({ action: 'design', content: designDocument(4000) })
    await env.call({ action: 'options', options: [{ title: 'a', pros: ['p'] }, { title: 'b', pros: ['p'] }] })
    await env.call({ action: 'choose' })
    const checkpoint = await env.call({ action: 'checkpoint', reason: 'phase boundary' })
    assert.ok(String(checkpoint.summary).includes('checkpoint at execute'), `got: ${checkpoint.summary}`)
    const file = checkpoint.files.checkpoint
    const body = readFileSync(file, 'utf8')
    assert.ok(body.includes('## Decisions'), 'the checkpoint must carry the decisions')
    assert.ok(body.includes('chosen option: a'), `the chosen option belongs in the checkpoint: ${body.slice(0, 300)}`)
    assert.ok(String(checkpoint.note).includes('checkpoint(s) recorded'), `got note: ${checkpoint.note}`)
    assert.equal(env.state().checkpoints.length, 1)
  } finally { env.dispose() }
})

// ---------------------------------------------------------------------------
// execution, finish, prompt section, files
// ---------------------------------------------------------------------------

await check('progress tracks steps and names finish when none are open', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x' })
    await env.call({ action: 'clarify', questions: [{ id: 'i', question: 'what for?' }] })
    await env.call({ action: 'design', content: '# Plan' })
    await env.call({ action: 'options', options: [{ title: 'a', pros: ['p'] }, { title: 'b', pros: ['p'] }] })
    await env.call({ action: 'choose' })
    await env.call({ action: 'execute', goal: 'g', steps: ['one', 'two'], files: ['src/a.js'] })
    const first = await env.call({ action: 'progress', step: 'one', evidence: 'suite passes' })
    assert.ok(first.note.includes('1 step(s) still open'), `got: ${first.note}`)
    assert.ok(String(first.next).includes('progress'), `next must stay on progress, got: ${first.next}`)
    const second = await env.call({ action: 'progress', step: 'two' })
    assert.ok(String(second.next).includes('finish'), `next must name finish, got: ${second.next}`)
    const state = env.state()
    assert.deepEqual(state.steps.map((s) => s.status), ['done', 'done'])
    assert.ok(state.evidence.includes('suite passes'), 'evidence must be recorded')
  } finally { env.dispose() }
})

await check('finish closes the workflow, and the prompt section goes empty', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x' })
    assert.ok(env.sectionText().includes('clarify'), 'the section must point at the current phase')
    await env.call({ action: 'clarify', questions: [{ id: 'i', question: 'what for?' }] })
    await env.call({ action: 'design', content: '# Plan' })
    await env.call({ action: 'options', options: [{ title: 'a', pros: ['p'] }, { title: 'b', pros: ['p'] }] })
    await env.call({ action: 'choose' })
    await env.call({ action: 'execute', goal: 'g', steps: ['one'] })
    const finished = await env.call({ action: 'finish', outcome: 'the build is faster now' })
    assert.equal(finished.phase, 'done')
    assert.equal(finished.next, null, '"there is no next phase" must be stated, not omitted')
    assert.equal(env.sectionText(), '', 'a finished workflow must stop costing prompt tokens')
  } finally { env.dispose() }
})

await check('the prompt section is useful before start and empty while no workflow exists', async () => {
  const env = await harness(chooseFirst)
  try {
    const idle = env.sectionText()
    assert.ok(idle.includes('workflow'), `an idle session is told the tool exists: ${idle}`)
    assert.ok(idle.length < 700, `the idle section must stay short, got ${idle.length}`)
    await env.call({ action: 'start', intent: 'a'.repeat(2000) })
    const active = env.sectionText()
    assert.ok(active.length < 900, `the active section must stay short, got ${active.length}`)
    assert.ok(active.includes('a'.repeat(100)), 'the intent is carried, shortened if needed')
  } finally { env.dispose() }
})

await check('status reports the phase and the open steps', async () => {
  const env = await harness(chooseFirst)
  try {
    const idle = await env.call({ action: 'status' })
    assert.equal(idle.phase, 'none')
    await env.call({ action: 'start', intent: 'x' })
    await env.call({ action: 'clarify', questions: [{ id: 'i', question: 'what for?' }] })
    await env.call({ action: 'design', content: '# Plan' })
    await env.call({ action: 'options', options: [{ title: 'a', pros: ['p'] }, { title: 'b', pros: ['p'] }] })
    await env.call({ action: 'choose' })
    await env.call({ action: 'execute', goal: 'g', steps: ['one', 'two'] })
    await env.call({ action: 'progress', step: 'one' })
    const status = await env.call({ action: 'status' })
    assert.equal(status.phase, 'execute')
    assert.deepEqual(status.steps, ['[x] one', '[ ] two'])
  } finally { env.dispose() }
})

await check('reset discards the session, and the deleted path stays inside the root', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x' })
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
  const play = async () => {
    await env.call({ action: 'start', intent: 'x' })
    await env.call({ action: 'clarify', questions: [{ id: 'i', question: 'what for?' }] })
    await env.call({ action: 'design', content: '# Plan' })
    await env.call({ action: 'options', options: [{ title: 'a', pros: ['p'] }, { title: 'b', pros: ['p'] }] })
    await env.call({ action: 'choose' })
    await env.call({ action: 'execute', goal: 'g', steps: ['one'] })
    return env.call({ action: 'finish', outcome: 'done' })
  }
  try {
    await play()
    await env.call({ action: 'start', intent: 'the next request' })
    const state = env.state()
    assert.equal(state.intent, 'the next request')
    assert.deepEqual(state.decisions, [], 'the previous decisions must not leak into the new workflow')
    const archived = readdirSync(join(env.home, 'dsh-os', 'workflows')).filter((name) => name.includes('.done-'))
    assert.equal(archived.length, 1, `the finished workflow must be archived, got ${JSON.stringify(archived)}`)
    const intentFile = readFileSync(join(env.dir, '02-intent.md'), 'utf8')
    assert.ok(intentFile.includes('the next request'), 'the new intent file carries the new prompt')
    assert.ok(!intentFile.includes('what for?'), 'the previous questions must not leak into the new workflow')
  } finally { env.dispose() }
})

await check('the original prompt is written verbatim the moment the workflow starts', async () => {
  const env = await harness(chooseFirst)
  try {
    const prompt = 'the parser is slow when the config has many entries\n\nfix it, do not rewrite it'
    const started = await env.call({ action: 'start', intent: prompt })
    const file = started.files.intent
    assert.ok(existsSync(file), `the intent file must exist straight after start: ${file}`)
    assert.ok(readFileSync(file, 'utf8').includes(prompt), 'the prompt is stored verbatim, line breaks included')
  } finally { env.dispose() }
})

await check('nothing is written outside the session directory', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x' })
    await env.call({ action: 'clarify', questions: [{ id: 'i', question: 'what for?' }] })
    await env.call({ action: 'design', content: designDocument(3000) })
    const session = readdirSync(env.dir).sort()
    assert.deepEqual(session, ['02-intent.md', '03-design.md', 'state.json'])
  } finally { env.dispose() }
})

await check('a corrupted state file reads as absent rather than throwing', async () => {
  const env = await harness(chooseFirst)
  try {
    await env.call({ action: 'start', intent: 'x' })
    writeFileSync(env.statePath, '{ not json')
    const status = await env.call({ action: 'status' })
    assert.equal(status.phase, 'none', 'a corrupt state must be reported as no workflow, not a crash')
    const restarted = await env.call({ action: 'start', intent: 'again' })
    assert.equal(restarted.phase, 'clarify')
  } finally { env.dispose() }
})

console.log('')
console.log(`passed=${pass} failed=${fail}`)
if (fail > 0) {
  console.log('')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
