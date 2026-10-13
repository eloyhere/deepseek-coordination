/**
 * dsh-os workflow: one request in, a decided plan out, and a context that does not grow with the work.
 *
 * WHY THIS EXISTS
 *
 * The failure mode is a request that was never a specification. The model is handed an instruction,
 * starts editing files, and the divergence is only discovered at review time — after the tokens have
 * been spent. Three things are missing, and each is cheap if it happens BEFORE execution and expensive
 * afterwards: knowing what the user actually wants, knowing the shape of the work, and knowing which
 * trade-off the user prefers.
 *
 * This row makes those three things gates rather than advice:
 *
 *     start -> clarify -> design -> options -> choose -> execute -> finish
 *
 * Each phase is a tool call. A phase whose entry has not been recorded is refused, and the refusal names
 * the phase that must run first. `choose` cannot be answered by the model: it asks the human through
 * `ctx.userQuestions` inside the same call, so the decision is the user's by construction rather than by
 * instruction.
 *
 * THE COMPRESSION, WHICH IS THE OTHER HALF
 *
 * Narrating a plan into the conversation is what makes a short task expensive: the detail enters the
 * request history and is re-sent with every later step. So the detail never enters it. Each phase writes
 * a real document under the workflow directory and returns a compact envelope — phase, one-line summary,
 * file path, and the single next call. Later steps read what they need from the file. Measured by
 * `tests/workflow.test.mjs`, a design document of a few thousand characters costs the conversation about
 * one line.
 *
 * `checkpoint` is the deliberate exception: it is asked for at a phase boundary, it records everything
 * decided so far in one small file, and that file is what a compacted or resumed session reads to know
 * where it stands. `autoCompact` lists each boundary in `state.json` so a compaction that follows has a
 * record of what it may drop.
 *
 * The prompt section is empty until a workflow is started. A deployment that never uses this feature
 * pays nothing for it.
 *
 * STATE LOCATION. `$DSH_HOME/dsh-os/workflows/<session>/`, beside the settings document and for the same
 * reason: the package directory is replaced on upgrade, and the workspace belongs to the user rather
 * than to this plugin. `state.json` holds the compact record; every other file holds the detail.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { PKG_ROOT } from './invoke.js'

export const name = 'dsh-os-workflow'

/** The tool registry and the human answerer are both required; the prompt registry is optional. */
export const inject = ['tools', 'userQuestions']

/** The phases, in order. The index of a phase is its rank, and the rank is the gate. */
export const PHASES = ['clarify', 'design', 'options', 'choose', 'execute', 'done']

/** How many history entries and plan steps are kept: enough to review, bounded so the file cannot grow. */
const HISTORY_LIMIT = 200
const STEP_LIMIT = 200

/** Order used when the prompt registry does not recognise a name. Resolved defensively; see sectionOrder(). */
const SECTION_ORDER_FALLBACK = 500

/** One summary line is all a later step needs from a long document. */
const SUMMARY_MAX = 280

/** The bucket a stored session id is filed under. See sessionKeyOf(). */
function sessionKeyOf(raw) {
  const text = String(raw ?? '')
    .replace(/^[A-Za-z]+\((.*)\)$/, '$1') // branded ids appear either as `SessionId('x')` or as `x`
    .replace(/^['"]|['"]$/g, '')
    .trim()
  return text.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'unknown'
}

/**
 * The session this call belongs to.
 *
 * Both spellings are accepted because the two are separately evidenced in the runtime: `dsh-tool-fs`
 * reads `exec.agent.session.header.cwd`, while `dsh-tool-subagent` and friends use `exec.agent.id` for
 * ownership. Taking either means the workflow still works if one of them moves.
 */
function sessionKeyOfExecution(exec) {
  const agent = exec?.agent
  const id = agent?.session?.header?.id ?? agent?.id
  if (id === undefined || id === null || String(id).trim() === '') {
    throw new Error(
      'the workflow tool needs an owning agent session: it keys its state, its artifacts and its prompt ' +
      'section by session, and a call with no session would share one plan with every other caller',
    )
  }
  return sessionKeyOf(id)
}

/** Where the workflow documents live, with the same fallback order the settings service documents. */
export function workflowRoot(env = process.env) {
  const home = env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return join(home, 'dsh-os', 'workflows')
  return join(PKG_ROOT, '.dsh-os-workflows')
}

export function sessionDirectory(root, key) {
  return join(root, key)
}

export function statePathOf(root, key) {
  return join(sessionDirectory(root, key), 'state.json')
}

/** A fresh state document: intent is the root of everything recorded later. */
export function emptyState(intent, now = new Date().toISOString()) {
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    intent,
    // Where the work happens, so a resumed or compacted session still knows the tree it was planning for.
    cwd: null,
    phase: 'clarify',
    answers: [],
    decisions: [],
    steps: [],
    evidence: [],
    checkpoints: [],
    artifacts: {},
    history: [{ at: now, phase: 'intent', summary: summarize(intent) }],
  }
}

/**
 * Read a session's state, or `null`.
 *
 * Never throws. A half-written or hand-edited document is treated as absent, because the alternative is
 * a plugin that cannot answer a tool call at all — and `writeJson` below makes a half-written document
 * unreachable in the first place.
 */
export function readState(file) {
  try {
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
    if (raw.trim() === '') return null
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    if (typeof parsed.phase !== 'string') return null
    return normalizeState(parsed)
  } catch {
    return null
  }
}

/** Keep only known keys and known shapes, so a hand-edited file cannot change what the plugin does. */
function normalizeState(parsed) {
  const state = emptyState(typeof parsed.intent === 'string' ? parsed.intent : '')
  state.version = 1
  state.createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : state.createdAt
  state.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : state.updatedAt
  state.cwd = typeof parsed.cwd === 'string' ? parsed.cwd : null
  state.phase = PHASES.includes(parsed.phase) ? parsed.phase : 'clarify'
  state.answers = Array.isArray(parsed.answers) ? parsed.answers : []
  state.decisions = Array.isArray(parsed.decisions) ? parsed.decisions.filter((d) => typeof d === 'string') : []
  state.steps = Array.isArray(parsed.steps)
    ? parsed.steps
      .filter((s) => s !== null && typeof s === 'object' && typeof s.text === 'string')
      .map((s) => ({ text: s.text, status: s.status === 'done' ? 'done' : 'pending' }))
    : []
  state.evidence = Array.isArray(parsed.evidence) ? parsed.evidence.filter((e) => typeof e === 'string') : []
  state.checkpoints = Array.isArray(parsed.checkpoints) ? parsed.checkpoints : []
  state.artifacts = parsed.artifacts !== null && typeof parsed.artifacts === 'object' ? { ...parsed.artifacts } : {}
  state.history = Array.isArray(parsed.history)
    ? parsed.history.filter((h) => h !== null && typeof h === 'object' && typeof h.phase === 'string')
    : state.history
  // The fields that carry one phase's output into the next one. They are re-read from disk on every
  // call, so a field dropped here is a field `choose` or `execute` would no longer see.
  if (typeof parsed.goal === 'string') state.goal = parsed.goal
  if (typeof parsed.outcome === 'string') state.outcome = parsed.outcome
  if (Array.isArray(parsed.files)) state.files = parsed.files.filter((f) => typeof f === 'string')
  if (Array.isArray(parsed.constraints)) state.constraints = parsed.constraints.filter((c) => typeof c === 'string')
  if (Array.isArray(parsed.plan)) state.plan = parsed.plan.filter((p) => typeof p === 'string')
  if (Array.isArray(parsed.options)) {
    state.options = parsed.options
      .filter((option) => option !== null && typeof option === 'object' && typeof option.title === 'string')
      .map((option) => ({
        id: typeof option.id === 'string' ? option.id : '',
        title: option.title,
        pros: Array.isArray(option.pros) ? option.pros.filter((p) => typeof p === 'string') : [],
        cons: Array.isArray(option.cons) ? option.cons.filter((c) => typeof c === 'string') : [],
        recommended: option.recommended === true,
      }))
  }
  if (parsed.choice !== null && typeof parsed.choice === 'object' && typeof parsed.choice.title === 'string') {
    state.choice = {
      id: typeof parsed.choice.id === 'string' ? parsed.choice.id : null,
      title: parsed.choice.title,
      verbatim: typeof parsed.choice.verbatim === 'string' ? parsed.choice.verbatim : parsed.choice.title,
      options: Array.isArray(parsed.choice.options) ? parsed.choice.options.filter((o) => typeof o === 'string') : [],
    }
  }
  return state
}

/** Write a document atomically: sibling temporary file, then rename. */
export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* the original failure is the one that matters */ }
    throw error
  }
}

/**
 * Append one section to a phase document.
 *
 * Append and not replace, deliberately: a design that was revised after review still shows what was
 * rejected, which is the single most useful thing a later reader can know.
 */
export function appendSection(file, title, body, now = new Date().toISOString()) {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const header = existing === '' ? `# ${title}\n` : ''
  const section = `\n## ${now}\n\n${String(body).trim()}\n`
  writeAtomic(file, `${existing}${header}${section}`)
  return file
}

/** One line for a summary field: first non-empty line, collapsed and cut. */
export function summarize(text, max = SUMMARY_MAX) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Distil a longer document into the lines that are worth carrying forward.
 *
 * Headings and list items are preferred over prose because, in a design document, they are where the
 * decisions are; falling back to the first sentences keeps a plain paragraph usable.
 */
export function bulletsOf(text, limit = 6) {
  const lines = String(text ?? '').split(/\r?\n/)
  const picked = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (/^#{1,6}\s+/.test(trimmed)) {
      picked.push(trimmed.replace(/^#{1,6}\s+/, ''))
      continue
    }
    if (/^([-*+]\s+|\d+[.)]\s+)/.test(trimmed)) {
      picked.push(summarize(trimmed.replace(/^([-*+]\s+|\d+[.)]\s+)/, ''), 160))
      continue
    }
    if (picked.length === 0) picked.push(summarize(trimmed, 160))
  }
  return [...new Set(picked)].slice(0, limit)
}

/** Take the phase order from the state and refuse anything that would skip a gate. */
export function assertPhase(state, required) {
  const order = [...PHASES]
  if (state === null) {
    throw new Error(
      required === 'start'
        ? 'a workflow is already required to be started'
        : `no workflow is active for this session: call workflow with action "start" and the user's own prompt before "${required}"`,
    )
  }
  const current = order.indexOf(state.phase)
  const wanted = order.indexOf(required)
  if (current < 0) throw new Error(`this session's workflow is in an unknown phase '${state.phase}'`)
  if (current > wanted) {
    throw new Error(
      `phase "${required}" is already behind this workflow (it is at "${state.phase}"): ` +
      `continue with "${state.phase}", or reset and start a new one`,
    )
  }
  if (current < wanted) {
    throw new Error(
      `phase "${required}" is out of order: this workflow is at "${state.phase}", so "${state.phase}" must be ` +
      `recorded first, and "${required}" comes after it — a later phase is refused rather than silently reordered`,
    )
  }
  return state
}

/** Whether this state is in the phase where a checkpoint is worth taking. */
export function boundaryReached(state) {
  return state !== null && state.phase === 'execute'
}

// ---------------------------------------------------------------------------
// the action handlers
// ---------------------------------------------------------------------------

/** Replace the last history entry's summary when a phase is recorded, and bound the log. */
function record(state, phase, summary, now) {
  state.history.push({ at: now, phase, summary: summarize(summary) })
  if (state.history.length > HISTORY_LIMIT) state.history.splice(0, state.history.length - HISTORY_LIMIT)
  state.updatedAt = now
}

/** The result envelope. Omitted keys are omitted rather than nulled: a smaller payload is the point. */
function envelope(parts) {
  const value = { ok: true, phase: parts.phase }
  if (parts.summary !== undefined && parts.summary !== null && parts.summary !== '') value.summary = parts.summary
  // `next` is kept even when it is null: "there is no next phase" is a fact the caller acts on, and
  // dropping the key would leave it looking like a field the plugin forgot to fill in.
  if (parts.next !== undefined) value.next = parts.next
  if (parts.files !== undefined && Object.keys(parts.files).length > 0) value.files = parts.files
  if (parts.decisions !== undefined && parts.decisions.length > 0) value.decisions = parts.decisions
  if (parts.steps !== undefined && parts.steps.length > 0) value.steps = parts.steps
  if (parts.note !== undefined && parts.note !== null) value.note = parts.note
  return value
}

/**
 * The instruction the next step reads.
 *
 * This is the whole discipline of the feature in one string: the phase after this one, what it needs,
 * and — when a file was written — that the file rather than the conversation is where the detail lives.
 */
function nextInstruction(state, file) {
  switch (state.phase) {
    case 'clarify':
      return 'call workflow with action "clarify" and 1-3 questions about the real intent, the constraint that matters, and what "done" means'
    case 'design':
      return 'call workflow with action "design" and the architecture and process: components, data or control flow, files to touch, and how it will be verified'
    case 'options':
      return 'call workflow with action "options" and at least two real alternatives, each with its pros and cons'
    case 'choose':
      return 'call workflow with action "choose": the user picks, and the choice is recorded — do not decide for them'
    case 'execute':
      return 'execute the chosen option, then call workflow with action "progress" after each step and "finish" when done'
    case 'done':
      return null
    default:
      return file === undefined ? null : `read ${file} for the full record`
  }
}

export function makeHandlers({ root, ask, compact, logger = () => {} }) {
  /** Read, unless there is nothing to read: `start` is the only action valid without state. */
  function load(key) {
    return readState(statePathOf(root, key))
  }

  function save(key, state) {
    writeAtomic(statePathOf(root, key), `${JSON.stringify(state, null, 2)}\n`)
    logger({ phase: state.phase, session: key })
    return state
  }

  function artifact(key, file) {
    return join(sessionDirectory(root, key), file)
  }

  /**
   * Ask the human and normalise the batch.
   *
   * One question object per asked question, always in the state, including a question the user skipped:
   * "the user was asked and skipped it" is a fact a later step must not lose, and an empty array would
   * erase the difference between skipped and never asked.
   */
  async function askBatch(questions, exec, onAnswer) {
    const asked = questions.map((question, index) => ({
      id: typeof question.id === 'string' && question.id.trim() !== '' ? question.id : `q${index + 1}`,
      question: String(question.question ?? '').trim(),
      ...question.header === undefined ? {} : { header: String(question.header) },
      // Each choice keeps its label AND its one-line trade-off: the description is the part that makes a
      // long option list readable, and dropping it here was how the trade-offs reached nobody.
      ...question.options === undefined ? {} : {
        options: question.options.map((option) => ({
          label: String(option.label),
          ...typeof option.description === 'string' && option.description !== ''
            ? { description: String(option.description) }
            : {},
        })),
      },
    }))
    for (const question of asked) {
      if (question.question === '') throw new Error('every question needs a "question" string')
    }
    const answer = await ask(asked, exec)
    const answers = (answer?.answers ?? []).map((item) => ({
      id: item.id,
      selected: Array.isArray(item.selected) ? item.selected.map(String) : [],
      ...item.custom === undefined ? {} : { custom: String(item.custom) },
    }))
    return onAnswer(asked, answers)
  }

  // ---- start ------------------------------------------------------------------------------------

  function start({ intent, cwd, key, reset }) {
    if (reset === true) removeSession(root, key)
    const existing = load(key)
    if (existing !== null && existing.phase !== 'done') {
      throw new Error(
        `a workflow is already active for this session (phase "${existing.phase}"): ` +
        'pass reset: true to discard it and start a new one, or finish it first',
      )
    }
    // A finished workflow's documents are archived rather than overwritten: the next workflow appends to
    // the same file names, and "what did we decide last time" is exactly what a fresh start wants to read.
    if (existing !== null) {
      const directory = sessionDirectory(root, key)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      try { renameSync(directory, `${directory}.done-${stamp}`) } catch { /* an archive failure must not block a start */ }
    }
    const state = emptyState(String(intent).trim())
    state.cwd = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null
    record(state, 'intent', `intent recorded: ${summarize(state.intent, 120)}`, new Date().toISOString())
    // The user's own words are written to disk immediately, verbatim, before anything is asked or
    // planned: every later artifact is a derivative of this one, and a paraphrase is not a substitute.
    state.artifacts.intent = appendSection(
      artifact(key, '02-intent.md'),
      'Original prompt',
      state.intent,
    )
    save(key, state)
    return envelope({
      phase: state.phase,
      summary: `intent recorded: ${summarize(state.intent, 120)}`,
      next: nextInstruction(state),
      files: { intent: state.artifacts.intent },
      note: 'ask about intent before reading the repository: a question that inspection cannot answer is the only kind worth asking here',
    })
  }

  // ---- clarify ----------------------------------------------------------------------------------

  async function clarify({ questions, key }, exec) {
    const state = assertPhase(load(key), 'clarify')
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('clarify needs at least one question: "what do you actually want" is the phase\'s whole point')
    }
    if (questions.length > 3) {
      throw new Error('ask at most 3 questions in one batch: a longer interrogation is a sign the intent is not understood yet')
    }
    await askBatch(questions, exec, (asked, answers) => {
      state.answers = answers.map((answer) => ({ ...answer, question: asked.find((q) => q.id === answer.id)?.question }))
      const file = appendSection(
        artifact(key, '02-intent.md'),
        'Clarified intent',
        [
          '## Original prompt',
          state.intent,
          '',
          '## Questions and answers',
          ...answers.map((answer) => {
            const question = asked.find((q) => q.id === answer.id)?.question ?? answer.id
            const given = answer.custom !== undefined && answer.custom !== ''
              ? answer.custom
              : (answer.selected.join(', ') || '(skipped)')
            return `- **${question}** -> ${given}`
          }),
        ].join('\n'),
      )
      state.artifacts.intent = file
      // The selected labels and free text become the decisions a later step is held to.
      state.decisions = [
        ...state.decisions,
        ...answers.map((answer) => {
          const question = asked.find((q) => q.id === answer.id)?.question ?? answer.id
          const given = answer.custom !== undefined && answer.custom !== ''
            ? answer.custom
            : (answer.selected.join(', ') || '(skipped)')
          return `${summarize(question, 100)} -> ${summarize(given, 120)}`
        }),
      ]
      state.phase = 'design'
      record(state, 'clarify', state.decisions.slice(-answers.length).join('; '), new Date().toISOString())
      save(key, state)
    })
    return envelope({
      phase: state.phase,
      summary: `intent clarified; ${state.answers.length} answer(s) recorded`,
      next: nextInstruction(state),
      files: { intent: state.artifacts.intent },
      decisions: state.decisions.slice(-3),
      note: 'the full record is in the intent file; the conversation carries the short version',
    })
  }

  // ---- design -----------------------------------------------------------------------------------

  function design({ content, summary, key }) {
    const state = assertPhase(load(key), 'design')
    const body = String(content ?? '').trim()
    if (body === '') throw new Error('design needs "content": the architecture and process, as markdown')
    const file = appendSection(artifact(key, '03-design.md'), 'Architecture and process', body)
    state.artifacts.design = file
    const derived = bulletsOf(body)
    state.plan = derived
    const line = summarize(summary ?? derived[0] ?? body)
    state.phase = 'options'
    record(state, 'design', line, new Date().toISOString())
    save(key, state)
    return envelope({
      phase: state.phase,
      summary: line,
      next: nextInstruction(state),
      files: { design: file },
      decisions: state.decisions.slice(-3),
      note: `design stored (${body.length} chars on disk); ${derived.length} step(s) distilled for the remaining context`,
    })
  }

  // ---- options ----------------------------------------------------------------------------------

  function options({ options: listed, summary, key }) {
    const state = assertPhase(load(key), 'options')
    if (!Array.isArray(listed) || listed.length < 2) {
      throw new Error(
        'options needs at least two alternatives: "list the options and their pros and cons" is the phase\'s ' +
        'whole point, and one option is not a choice',
      )
    }
    const normalized = listed.map((option, index) => ({
      id: typeof option.id === 'string' && option.id.trim() !== '' ? option.id.trim() : `o${index + 1}`,
      title: String(option.title ?? '').trim(),
      pros: trimList(option.pros),
      cons: trimList(option.cons),
      recommended: option.recommended === true,
    }))
    for (const option of normalized) {
      if (option.title === '') throw new Error('every option needs a "title"')
      if (option.pros.length === 0 && option.cons.length === 0) {
        throw new Error(`option "${option.title}" has neither pros nor cons: an option that cannot be argued for or against is not a choice`)
      }
    }
    const file = appendSection(
      artifact(key, '04-options.md'),
      'Options and trade-offs',
      normalized
        .map((option) => [
          `### ${option.id}. ${option.title}${option.recommended ? ' (recommended)' : ''}`,
          option.pros.length > 0 ? `- pros: ${option.pros.join('; ')}` : '- pros: (none recorded)',
          option.cons.length > 0 ? `- cons: ${option.cons.join('; ')}` : '- cons: (none recorded)',
        ].join('\n'))
        .join('\n\n'),
    )
    state.artifacts.options = file
    state.options = normalized
    const line = summarize(summary ?? `${normalized.length} options: ${normalized.map((o) => o.title).join(' / ')}`)
    state.phase = 'choose'
    record(state, 'options', line, new Date().toISOString())
    save(key, state)
    return envelope({
      phase: state.phase,
      summary: line,
      next: nextInstruction(state),
      files: { options: file },
      note: 'the next call asks the user which one; it does not proceed on its own',
    })
  }

  // ---- choose -----------------------------------------------------------------------------------

  async function choose({ question, key }, exec) {
    const state = assertPhase(load(key), 'choose')
    const listed = Array.isArray(state.options) ? state.options : []
    if (listed.length === 0) throw new Error('no options are recorded, so there is nothing to choose between')
    // The recommendation goes first, which is the order the ask-user contract reads as "recommended".
    const ordered = [...listed].sort((a, b) => Number(b.recommended === true) - Number(a.recommended === true))
    const asked = typeof question === 'string' && question.trim() !== ''
      ? question.trim()
      : 'Which option should be executed?'
    const decision = await askBatch(
      [{
        id: 'choice',
        header: 'Choose',
        question: asked,
        options: ordered.map((option) => ({
          label: option.recommended === true ? `${option.title} (Recommended)` : option.title,
          ...option.cons.length > 0 ? { description: `cost: ${option.cons.join('; ')}` } : {},
        })),
      }],
      exec,
      (askedQuestions, answers) => {
        const answer = answers[0] ?? { id: 'choice', selected: [] }
        const chosenLabel = answer.custom !== undefined && answer.custom !== ''
          ? answer.custom
          : (answer.selected[0] ?? '')
        const matched = listed.find((option) => chosenLabel === option.title || chosenLabel.startsWith(option.title))
        const chosen = matched?.title ?? chosenLabel
        if (chosen === '') {
          throw new Error('the user did not choose an option, so execute cannot be entered: ask again with a clearer question')
        }
        state.choice = {
          id: matched?.id ?? null,
          title: chosen,
          verbatim: chosenLabel,
          options: listed.map((option) => option.title),
        }
        state.decisions = [...state.decisions, `chosen option: ${summarize(chosen, 120)}`]
        appendSection(
          artifact(key, '04-options.md'),
          'Decision',
          `The user chose **${chosen}**${askedQuestions[0] === undefined ? '' : ` in answer to: ${askedQuestions[0].question}`}.`,
        )
        state.phase = 'execute'
        record(state, 'decide', chosen, new Date().toISOString())
        save(key, state)
        return chosen
      },
    )
    return envelope({
      phase: state.phase,
      summary: `user chose: ${summarize(decision, 140)}`,
      next: nextInstruction(state),
      decisions: state.decisions.slice(-3),
      note: 'execute only this option; a different option is a new workflow',
    })
  }

  // ---- execute ----------------------------------------------------------------------------------

  function execute({ goal, steps, files, evidence, constraints, key }) {
    const state = assertPhase(load(key), 'execute')
    const chosen = state.choice?.title
    if (typeof chosen !== 'string' || chosen === '') {
      throw new Error('execute without a recorded choice is refused: run "options" and then "choose" first')
    }
    const plan = trimList(steps)
    const derived = plan.length > 0 ? plan : bulletsOf(goal ?? '', 8)
    if (typeof goal === 'string' && goal.trim() !== '') state.goal = summarize(goal, 400)
    if (derived.length > 0) state.steps = derived.slice(0, STEP_LIMIT).map((text) => ({ text, status: 'pending' }))
    if (Array.isArray(files)) state.files = files.filter((f) => typeof f === 'string').slice(0, STEP_LIMIT)
    // `evidence` is a string in the tool schema and a list in the checkpoint document: both spellings
    // are accepted so a caller that passes one entry per line is not silently ignored.
    if (typeof evidence === 'string' && evidence.trim() !== '') state.evidence = [summarize(evidence, 240)]
    else if (Array.isArray(evidence)) state.evidence = evidence.filter((e) => typeof e === 'string').slice(0, STEP_LIMIT)
    if (Array.isArray(constraints)) state.constraints = constraints.filter((c) => typeof c === 'string').slice(0, STEP_LIMIT)
    const file = appendSection(
      artifact(key, '05-execution.md'),
      `Execution: ${chosen}`,
      [
        `Chosen option: **${chosen}**`,
        '',
        '## Goal',
        state.goal ?? '(not recorded)',
        '',
        '## Steps',
        ...(state.steps.length > 0 ? state.steps.map((step, index) => `${index + 1}. ${step.text}`) : ['(not recorded)']),
        ...(state.files === undefined || state.files.length === 0 ? [] : ['', '## Files in scope', ...state.files.map((f) => `- ${f}`)]),
        ...(state.constraints === undefined || state.constraints.length === 0 ? [] : ['', '## Constraints', ...state.constraints.map((c) => `- ${c}`)]),
      ].join('\n'),
    )
    state.artifacts.execution = file
    state.phase = 'execute'
    record(state, 'execute', `execution started on: ${summarize(chosen, 120)}`, new Date().toISOString())
    save(key, state)
    return envelope({
      phase: state.phase,
      summary: `executing: ${summarize(chosen, 120)}`,
      next: nextInstruction(state),
      files: { execution: file },
      steps: state.steps.map((step) => step.text).slice(0, 8),
      note: 'ad-hoc work is what the option was chosen against: follow the steps, and vary them only by asking',
    })
  }

  // ---- progress ---------------------------------------------------------------------------------

  function progress({ step, status, note, evidence, key }) {
    const state = load(key)
    if (state === null) throw new Error('no workflow is active for this session')
    if (state.phase !== 'execute' && state.phase !== 'done') {
      throw new Error(`progress is a phase of execution, but this workflow is at "${state.phase}"`)
    }
    const text = summarize(step ?? note ?? '', 200)
    if (text === '') throw new Error('progress needs "step": what was actually done')
    const done = status !== 'pending'
    const existing = state.steps.find((s) => s.text === text)
    if (existing !== undefined) existing.status = done ? 'done' : 'pending'
    else state.steps.push({ text, status: done ? 'done' : 'pending' })
    if (state.steps.length > STEP_LIMIT) state.steps.splice(0, state.steps.length - STEP_LIMIT)
    if (typeof evidence === 'string' && evidence.trim() !== '') {
      state.evidence = [...(state.evidence ?? []), summarize(evidence, 240)].slice(-STEP_LIMIT)
    }
    const line = `${done ? 'done' : 'open'}: ${text}`
    record(state, 'progress', line, new Date().toISOString())
    appendSection(artifact(key, '05-execution.md'), 'Progress', `- ${line}${typeof note === 'string' && note.trim() !== '' ? ` — ${summarize(note, 400)}` : ''}`)
    save(key, state)
    const open = state.steps.filter((s) => s.status !== 'done').length
    return envelope({
      phase: state.phase,
      summary: line,
      next: open === 0 ? 'call workflow with action "finish"' : nextInstruction(state),
      steps: state.steps.map((s) => `${s.status === 'done' ? '[x]' : '[ ]'} ${s.text}`).slice(0, 8),
      note: `${open} step(s) still open`,
    })
  }

  // ---- checkpoint -------------------------------------------------------------------------------

  /**
   * The compression the feature is asked for, made explicit and inspectable.
   *
   * Everything decided so far is written to `01-checkpoint.md`, and the response carries a one-line
   * summary per phase — the shape a compacted or resumed session needs, and nothing more. The list of
   * boundaries is kept in `state.json` so a compaction that runs afterwards has a record of what it may
   * drop.
   */
  function checkpointAction({ key, reason }) {
    const state = load(key)
    if (state === null) throw new Error('no workflow is active for this session, so there is nothing to checkpoint')
    const now = new Date().toISOString()
    const body = [
      `# Checkpoint (${state.phase})`,
      '',
      `- original prompt: ${state.intent}`,
      `- cwd: ${state.cwd ?? '(unknown)'}`,
      ...state.decisions.length === 0 ? [] : ['', '## Decisions', ...state.decisions.map((d) => `- ${d}`)],
      ...(state.choice === undefined ? [] : ['', `## Chosen option`, `- ${state.choice.title}`]),
      ...(state.steps.length === 0 ? [] : ['', '## Steps', ...state.steps.map((s) => `- [${s.status === 'done' ? 'x' : ' '}] ${s.text}`)]),
      ...(state.evidence === undefined || state.evidence.length === 0 ? [] : ['', '## Evidence', ...state.evidence.map((e) => `- ${e}`)]),
      ...(Object.keys(state.artifacts).length === 0 ? [] : ['', '## Artifacts', ...Object.entries(state.artifacts).map(([k, v]) => `- ${k}: ${v}`)]),
      ...(typeof reason === 'string' && reason.trim() !== '' ? ['', `Reason: ${summarize(reason, 400)}`] : []),
    ].join('\n')
    const file = appendSection(artifact(key, '01-checkpoint.md'), 'Checkpoint', body, now)
    state.artifacts.checkpoint = file
    state.checkpoints = [...(state.checkpoints ?? []), { at: now, phase: state.phase, reason: summarize(reason ?? '', 160) }].slice(-STEP_LIMIT)
    state.updatedAt = now
    save(key, state)
    const compression = compact(state)
    return envelope({
      phase: state.phase,
      summary: `checkpoint at ${state.phase}: ${state.history.length} history entries compressed`,
      next: nextInstruction(state),
      files: { checkpoint: file },
      decisions: state.decisions.slice(-3),
      note: compression.note,
    })
  }

  // ---- finish / status / reset ------------------------------------------------------------------

  function finish({ outcome, evidence, key }) {
    const state = load(key)
    if (state === null) throw new Error('no workflow is active for this session')
    if (state.phase !== 'execute' && state.phase !== 'done') {
      throw new Error(`finish is a phase of execution, but this workflow is at "${state.phase}"`)
    }
    const text = summarize(outcome ?? '', 400)
    if (text === '') throw new Error('finish needs "outcome": what was actually delivered, in one or two sentences')
    const open = state.steps.filter((s) => s.status !== 'done')
    state.outcome = text
    if (typeof evidence === 'string' && evidence.trim() !== '') {
      state.evidence = [...(state.evidence ?? []), summarize(evidence, 240)].slice(-STEP_LIMIT)
    }
    state.phase = 'done'
    record(state, 'done', text, new Date().toISOString())
    appendSection(artifact(key, '06-outcome.md'), 'Outcome', `${text}${open.length === 0 ? '' : `\n\nStill open: ${open.map((s) => s.text).join('; ')}`}`)
    state.artifacts.outcome = artifact(key, '06-outcome.md')
    save(key, state)
    return envelope({
      phase: state.phase,
      summary: text,
      next: null,
      files: { outcome: state.artifacts.outcome },
      steps: state.steps.map((s) => `${s.status === 'done' ? '[x]' : '[ ]'} ${s.text}`).slice(0, 8),
      note: open.length === 0
        ? 'every recorded step is closed: the workflow is finished and the prompt section is now empty'
        : `${open.length} step(s) are still open and are reported as such rather than hidden`,
    })
  }

  function status({ key }) {
    const state = load(key)
    if (state === null) {
      return envelope({
        phase: 'none',
        summary: 'no workflow is active for this session',
        next: 'start one with the user\'s own prompt when the request is more than a single obvious step',
      })
    }
    return envelope({
      phase: state.phase,
      summary: state.outcome ?? state.goal ?? state.intent ?? '',
      next: nextInstruction(state),
      files: state.artifacts,
      decisions: state.decisions.slice(-3),
      steps: state.steps.map((s) => `${s.status === 'done' ? '[x]' : '[ ]'} ${s.text}`).slice(0, 8),
      note: `updated ${state.updatedAt}`,
    })
  }

  function reset({ key }) {
    const state = load(key)
    if (state === null) {
      return envelope({ phase: 'none', summary: 'no workflow was active', next: nextInstruction(emptyState('')) })
    }
    removeSession(root, key)
    logger({ phase: 'reset', session: key })
    return envelope({
      phase: 'none',
      summary: `workflow discarded (was at "${state.phase}")`,
      next: 'call workflow with action "start" and the user\'s own prompt to begin again',
    })
  }

  return {
    start,
    clarify,
    design,
    options,
    choose,
    execute,
    progress,
    checkpoint: checkpointAction,
    finish,
    status,
    reset,
  }
}

/** Keep a list of strings short and non-empty, so a `[]` never reaches a document. */
function trimList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item !== '')
    .slice(0, 24)
    .map((item) => summarize(item, 200))
}

/**
 * Delete one session's directory, after proving it is inside the root.
 *
 * Same lesson as this repository's protected-path boundary: a join is not a containment check, and a
 * session key that reached the filesystem unchecked would be a path traversal. The check is on the
 * resolved path, and it fails closed.
 */
export function removeSession(root, key) {
  const directory = sessionDirectory(root, key)
  const normalizedRoot = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root
  const separator = process.platform === 'win32' ? '\\' : '/'
  if (directory !== normalizedRoot && !directory.startsWith(`${normalizedRoot}${separator}`)) {
    throw new Error(`refusing to remove '${directory}': it is not inside '${root}'`)
  }
  rmSync(directory, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// the prompt section
// ---------------------------------------------------------------------------

/**
 * Placement of the section, resolved defensively.
 *
 * `getSectionOrder` takes a name from a centrally owned table, so an unknown name may be a throw or an
 * `undefined` — and an `undefined` order would put `NaN` into the sort and could reorder the whole
 * prompt. Falling back to a fixed number keeps an unrecognised name harmless.
 */
function sectionOrder(prompt) {
  try {
    const order = prompt?.getSectionOrder?.('TOOL_READ')
    return Number.isFinite(order) ? order + 1 : SECTION_ORDER_FALLBACK
  } catch {
    return SECTION_ORDER_FALLBACK
  }
}

/**
 * The prompt text for one assembly.
 *
 * Empty while no workflow is active, which is what keeps an inactive feature free: the section is
 * registered, but it contributes nothing until `start` records an intent. The text is deliberately a
 * few short lines — it is re-sent with every step, so it is the one part of this feature that has to
 * earn its tokens.
 */
export function workflowSectionText(state) {
  if (state === null) {
    return [
      '## Workflow',
      'For a request that is more than one obvious step, or whose shape you would have to guess: call the',
      '`workflow` tool with action "start" and the user\'s own prompt. It records the intent, asks the user',
      'what they actually want, and gates execution behind a plan the user has chosen. For a single obvious',
      'step, skip it.',
    ].join(' ')
  }
  if (state.phase === 'done') return ''
  const chosen = state.choice?.title
  switch (state.phase) {
    case 'clarify':
      return [
        '## Workflow: clarify',
        `Intent recorded: ${summarize(state.intent, 200)}.`,
        'Before reading the repository or writing anything: call `workflow` action "clarify" with 1-3 questions',
        'about the real intent, the constraint that matters, and what "done" means. Inspect for facts you can',
        'find yourself; ask only what the user owns.',
      ].join(' ')
    case 'design':
      return [
        '## Workflow: design',
        `Intent (clarified): ${summarize(state.intent, 200)}.`,
        state.answers.length === 0 ? '' : `Answers so far: ${state.answers.map(answerText).join(' | ')}.`,
        'Call `workflow` action "design" with the architecture and process — components, flow, files, and how',
        'it will be verified — before proposing any option.',
      ].filter(Boolean).join(' ')
    case 'options':
      return [
        '## Workflow: options',
        `Design recorded at ${state.artifacts.design ?? 'the design file'}.`,
        'Call `workflow` action "options" with at least two real alternatives, each with pros and cons; the',
        'user chooses in the next step. Do not start executing.',
      ].join(' ')
    case 'choose':
      return [
        '## Workflow: choose',
        `${state.options?.length ?? 0} option(s) are recorded and the user has not chosen yet.`,
        'Call `workflow` action "choose": it asks the user and records the decision. Do not pick for them and',
        'do not begin the work.',
      ].join(' ')
    case 'execute':
      return [
        '## Workflow: execute',
        `Chosen option: ${summarize(chosen ?? '(not recorded)', 160)}.`,
        state.goal === undefined ? '' : `Goal: ${summarize(state.goal, 200)}.`,
        state.steps.length === 0 ? '' : `Steps: ${state.steps.filter((s) => s.status !== 'done').map((s) => s.text).join('; ') || 'all done'}.`,
        'Call `workflow` action "progress" after each step, "checkpoint" at a phase boundary, and "finish" with',
        'the outcome when done. Execute only the chosen option; a change of course goes back to the user.',
      ].filter(Boolean).join(' ')
    default:
      return ''
  }
}

/** One recorded answer, as the prompt shows it. */
function answerText(answer) {
  const given = answer.custom !== undefined && answer.custom !== '' ? answer.custom : answer.selected.join(', ')
  return `${summarize(answer.question ?? answer.id, 80)} -> ${summarize(given === '' ? '(skipped)' : given, 100)}`
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/** The tool's own description: the phases, in one paragraph the model reads before it needs them. */
const TOOL_DESCRIPTION = [
  'Run one phase of the intent-first workflow: start -> clarify -> design -> options -> choose -> execute -> finish.',
  'Call it when a request is more than one obvious step, or when you would have to guess what the user wants,',
  'which approach they prefer, or where the work belongs. "start" records the request verbatim; "clarify"',
  'asks the user 1-3 questions; "design" stores the architecture and process as a file; "options" lists at',
  'least two alternatives with pros and cons; "choose" ASKS THE USER and records their decision; "execute"',
  'locks the plan; "progress" records one step; "checkpoint" compresses the record so far; "finish" closes it.',
  'Long documents are written to files and only a one-line summary returns, so the conversation stays small;',
  'the files are listed in each result. A phase called out of order is refused, and the refusal names the',
  'phase that must run first. Also available: "status" and "reset".',
].join(' ')

const QUESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'Stable id, echoed in the answer. Defaults to q1, q2, ...' },
    header: { type: 'string', description: 'Short heading, e.g. "Intent" or "Constraint".' },
    question: { type: 'string', description: 'The question itself, in the user\'s own terms.' },
    options: {
      type: 'array',
      description: 'Optional choices to offer. If you recommend one, put it first and append " (Recommended)".',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', description: 'Short user-facing label.' },
          description: { type: 'string', description: 'One sentence on the trade-off.' },
        },
        required: ['label'],
      },
    },
  },
  required: ['question'],
}

const OPTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'Short id, e.g. o1. Defaults to the position.' },
    title: { type: 'string', description: 'The approach, named in a way the user will recognise.' },
    pros: { type: 'array', items: { type: 'string' }, description: 'What this approach buys.' },
    cons: { type: 'array', items: { type: 'string' }, description: 'What it costs, including what it rules out.' },
    recommended: { type: 'boolean', description: 'Set on exactly one option to put it first for the user.' },
  },
  required: ['title'],
}

/** Exported so a test can assert the tool contract without a live registry. */
export function workflowToolDefinition(handlers) {
  return {
    name: 'workflow',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'clarify', 'design', 'options', 'choose', 'execute', 'progress', 'checkpoint', 'finish', 'status', 'reset'],
          description: 'The phase to record. Phases are gated: a later phase is refused until the earlier one is recorded.',
        },
        intent: { type: 'string', description: 'start: the user\'s request, in their own words. Required by start.' },
        cwd: { type: 'string', description: 'start: absolute path the work happens in. Defaults to the session working directory.' },
        reset: { type: 'boolean', description: 'start: discard an active workflow for this session and begin a new one.' },
        questions: { type: 'array', items: QUESTION_SCHEMA, description: 'clarify: 1-3 questions for the user. Required by clarify.' },
        content: { type: 'string', description: 'design: the architecture and process, as markdown. Required by design.' },
        summary: { type: 'string', description: 'design/options: the one line this phase contributes to later context.' },
        options: { type: 'array', items: OPTION_SCHEMA, description: 'options: at least two alternatives, each with pros and cons. Required by options.' },
        question: { type: 'string', description: 'choose: the question shown to the user. Defaults to asking which option to run.' },
        goal: { type: 'string', description: 'execute: what this execution must achieve.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'execute: the ordered steps.' },
        files: { type: 'array', items: { type: 'string' }, description: 'execute: files in scope.' },
        evidence: { type: 'string', description: 'execute/progress/finish: how the step will be or was verified.' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'execute: what must not change.' },
        step: { type: 'string', description: 'progress: what was just done. Required by progress.' },
        status: { type: 'string', enum: ['done', 'pending'], description: 'progress: whether that step is finished. Defaults to done.' },
        note: { type: 'string', description: 'progress/checkpoint: an optional remark kept in the detail file.' },
        reason: { type: 'string', description: 'checkpoint: why the compression is happening now.' },
        outcome: { type: 'string', description: 'finish: what was actually delivered. Required by finish.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const key = sessionKeyOfExecution(exec)
      const action = String(args.action ?? '').trim()
      const handlersFor = handlers
      let value
      switch (action) {
        case 'start':
          if (typeof args.intent !== 'string' || args.intent.trim() === '') {
            throw new Error('start needs "intent": the user\'s request in their own words, not a paraphrase of it')
          }
          value = handlersFor.start({
            intent: args.intent,
            cwd: args.cwd ?? exec?.agent?.session?.header?.cwd,
            key,
            reset: args.reset === true,
          })
          break
        case 'clarify':
          value = await handlersFor.clarify({ questions: args.questions, key }, exec)
          break
        case 'design':
          value = handlersFor.design({ content: args.content, summary: args.summary, key })
          break
        case 'options':
          value = handlersFor.options({ options: args.options, summary: args.summary, key })
          break
        case 'choose':
          value = await handlersFor.choose({ question: args.question, key }, exec)
          break
        case 'execute':
          value = handlersFor.execute({
            goal: args.goal,
            steps: args.steps,
            files: args.files,
            evidence: args.evidence,
            constraints: args.constraints,
            key,
          })
          break
        case 'progress':
          value = handlersFor.progress({
            step: args.step,
            status: args.status,
            note: args.note,
            evidence: args.evidence,
            key,
          })
          break
        case 'checkpoint':
          value = handlersFor.checkpoint({ key, reason: args.reason })
          break
        case 'finish':
          value = handlersFor.finish({ outcome: args.outcome, evidence: args.evidence, key })
          break
        case 'status':
          value = handlersFor.status({ key })
          break
        case 'reset':
          value = handlersFor.reset({ key })
          break
        default:
          throw new Error(
            `unknown workflow action '${action}': expected one of ${['start', 'clarify', 'design', 'options', 'choose', 'execute', 'progress', 'checkpoint', 'finish', 'status', 'reset'].join(', ')}`,
          )
      }
      return JSON.stringify(value)
    },
    // A workflow step rewrites one session's own documents; two of them touching the same state would
    // interleave their appends.
    isConcurrencySafe: () => false,
  }
}

export function apply(ctx, config = {}) {
  const root = typeof config.workflowRoot === 'string' && config.workflowRoot.trim() !== ''
    ? config.workflowRoot
    : workflowRoot()
  const autoCompact = config.autoCompact !== false
  const maxCheckpoints = Number.isInteger(config.maxCheckpoints) && config.maxCheckpoints > 0 ? config.maxCheckpoints : 20

  // The engine's own automatic compaction is named in the checkpoint result rather than invoked: this
  // plugin holds no session handle, and a call into a service whose context contract is not published
  // would be a guess dressed up as a feature. What it does instead is deterministic — the detail leaves
  // the conversation for a file, and the boundary is recorded where a compaction can see it.
  const compact = (state) => {
    const boundaries = (state.checkpoints ?? []).length
    if (!autoCompact) {
      return { note: `${boundaries} checkpoint(s) recorded; automatic compaction is disabled by configuration` }
    }
    return {
      note: `${boundaries} checkpoint(s) recorded (limit ${maxCheckpoints}); the full record is on disk, so the conversation can drop it and keep the summary`,
    }
  }

  const handlers = makeHandlers({
    root,
    compact,
    logger: () => { /* reserved for a future activity feed; kept so the seam exists in one place */ },
    ask: async (questions, exec) => {
      const userQuestions = ctx.userQuestions
      if (userQuestions === undefined) {
        throw new Error('the workflow tool needs the userQuestions service to ask the user, and this deployment has none')
      }
      const request = {
        questions,
        ...exec?.agent === undefined ? {} : { agent: exec.agent },
        ...exec?.signal === undefined ? {} : { signal: exec.signal },
      }
      // `wait.callId` is what keeps the question answerable in the transcript after the call returns,
      // and it is available only for a real tool call.
      return userQuestions.ask(exec?.callId === undefined ? request : { ...request, wait: { callId: exec.callId } })
    },
  })

  if (typeof ctx.tools?.register === 'function') ctx.tools.register(workflowToolDefinition(handlers))

  // The prompt half is registered only when the registry is present, so a deployment without it loses
  // the section rather than the feature.
  if (typeof ctx.systemPrompt?.section === 'function') {
    ctx.systemPrompt.section({
      name: 'dsh-os:workflow',
      order: sectionOrder(ctx.systemPrompt),
      text: (context) => {
        try {
          const key = sessionKeyOf(context?.agent?.id ?? context?.agent?.session?.header?.id)
          if (key === 'unknown') return workflowSectionText(null)
          return workflowSectionText(readState(statePathOf(root, key)))
        } catch {
          // A prompt section must never be the reason a turn fails.
          return ''
        }
      },
    })
  }

  return handlers
}

/** Exported for tests, so the state machine can be exercised without a live plugin context. */
export const __internals = {
  sessionKeyOf,
  sessionKeyOfExecution,
  normalizeState,
  sectionOrder,
  trimList,
  assertPhase,
  envelope,
  nextInstruction,
}
