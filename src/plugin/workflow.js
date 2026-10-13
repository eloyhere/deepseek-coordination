/**
 * dsh-os workflow: one request in, a decided plan out, and a context that does not grow with the work.
 *
 * WHY THIS EXISTS
 *
 * The failure mode is a request that was never a specification. The model is handed an instruction,
 * starts editing files, and the divergence is discovered at review time — after the tokens are spent.
 * Three things are missing, and each is cheap before execution and expensive after it: what the user
 * actually wants, the shape of the work, and which trade-off the user prefers.
 *
 * THE PHASES
 *
 *     intake -> plan -> choose -> run -> done
 *
 * `intake` records the request verbatim and asks at most three questions about intent. `plan` writes the
 * design-space record: approach, process, alternatives, criteria, recommendation. `choose` asks the USER
 * and records their decision — the model cannot answer it. `run` executes the chosen option.
 *
 * All four steps the feature was asked for are here — ask the real intent, organise the architecture and
 * process, list the options with pros and cons, let the user choose, then execute. They are four calls
 * rather than seven because steps that share a decision were fused, and that fusion is the optimisation:
 *
 *   * the design and its alternatives are ONE decision, so they are ONE call and ONE record. This is the
 *     QOC shape (Questions, Options, Criteria) and the ADR shape (Context, Decision, Consequences): a
 *     decision record holds the alternatives it was chosen between and the criteria it was judged
 *     against. Splitting them into `design` then `options` made the second call re-derive the first and
 *     made the user read the same architecture twice.
 *   * a clear intent is not worth a question. `intake` accepts `assumptions` instead of `questions`, so an
 *     unambiguous request costs zero human interactions instead of one — and the assumption is on record
 *     where the user can correct it, which is cheaper than the question it replaced.
 *   * a single-step execution is not worth a separate call: `run` takes the outcome and closes the
 *     workflow when one step finished it.
 *
 * Measured by `tests/workflow.test.mjs`, the unavoidable path went from eight tool calls and two human
 * interactions to four and one, for the same recorded phases and the same gate on execution.
 *
 * THE COMPRESSION, WHICH IS THE OTHER HALF
 *
 * Narrating a plan into the conversation is what makes a short task expensive: the detail enters the
 * request history and is re-sent with every later step. So it never enters it. Each phase writes a real
 * document and returns a compact envelope — phase, one line, file path, the single next call. Later steps
 * read what they need from the file. The evidence for this shape is measured, not stylistic: pruning plus
 * summarisation has been shown to improve completion while cutting tokens and runtime
 * (https://export.arxiv.org/pdf/2608.16370), and a planner/executor split matches interleaved reasoning at
 * a fraction of the token cost (https://zenodo.org/records/22904595).
 *
 * COST, STATED AS COMPLEXITY, BECAUSE THAT IS WHAT IT IS
 *
 *   * one `readState` per call, cached on the file's mtime. The prompt section also reads state, on every
 *     model step, so the cache is what keeps that from being a parse per step.
 *   * one `writeAtomic` per state transition. The first version wrote state three times per action,
 *     because each phase appended to its own document and then re-saved.
 *   * appends that grow linearly, not quadratically: a note during execution is ONE appended journal
 *     line, and the journal is folded into `state.json` only on a checkpoint or when it outgrows its
 *     bound. Re-reading and rewriting the whole state on every note was O(n^2) in the number of notes.
 *   * a bounded prompt section that does not change within a phase. It is re-sent with every step, so it
 *     is the one part of this feature that has to earn its tokens — and a stable prefix is also what lets
 *     the provider's prompt cache hit (https://arxiv.org/pdf/2601.06007v1).
 *
 * STATE LOCATION. `$DSH_HOME/dsh-os/workflows/<session>/`, beside the settings document and for the same
 * reason: the package directory is replaced on upgrade, and the workspace belongs to the user rather
 * than to this plugin. `state.json` is the compact record; every other file is the detail.
 */

import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { PKG_ROOT } from './invoke.js'

export const name = 'dsh-os-workflow'

/** The tool registry and the human answerer are both required; the prompt registry is optional. */
export const inject = ['tools', 'userQuestions']

/**
 * The phases, in order, and the ranks the gates compare.
 *
 * `intake` -> `plan` -> `choose` -> `run` -> `done`. Kept deliberately short: every phase boundary is a
 * gate a caller can be refused at, and a process with more gates than decisions is ceremony.
 */
export const PHASES = ['intake', 'plan', 'choose', 'run', 'done']

/** Bounds. Every list that can grow has one, because part of this state is re-read on every model step. */
const HISTORY_LIMIT = 100
const STEP_LIMIT = 100
const JOURNAL_LIMIT = 60
const JOURNAL_BYTES_LIMIT = 24 * 1024
const SUMMARY_MAX = 280
const INTENT_MAX = 4000

/** The version written into every state document, so a future change can migrate rather than guess. */
const STATE_VERSION = 2

/**
 * One state document per session, cached on the file's modification time.
 *
 * The prompt section reads state on every model step and a tool call reads it once; without the cache
 * that is a read and a `JSON.parse` per step for a value that changes only when this plugin changes it.
 * The mtime check is what keeps the cache honest when the document is edited by hand between steps.
 */
const stateCache = new Map()

/** Bytes currently in each session's journal, so the append path can stay O(1) and still be bounded. */
const journalBytes = new Map()

/** Drop a session's cached state. Called after every write, so a stale read is not possible. */
function invalidate(file) {
  stateCache.delete(file)
}

// ---------------------------------------------------------------------------
// identity and location
// ---------------------------------------------------------------------------

/**
 * The bucket a session id is filed under.
 *
 * A session id reaches the filesystem as a directory name, so everything outside a conservative set is
 * replaced. Two ids can therefore collide in principle; the cost of a collision is a shared workflow,
 * while the alternative — trusting a caller-supplied id as a path segment — is a traversal.
 */
export function sessionKeyOf(raw) {
  const text = String(raw ?? '')
    .replace(/^[A-Za-z]+\((.*)\)$/, '$1') // branded ids appear either as `SessionId('x')` or as `x`
    .replace(/^['"]|['"]$/g, '')
    .trim()
  return text.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'unknown'
}

/**
 * The session this call belongs to.
 *
 * Both spellings are accepted because both are separately evidenced in the runtime: `dsh-tool-fs` reads
 * `exec.agent.session.header.cwd`, while the subagent tools use `exec.agent.id` for ownership.
 */
export function sessionKeyOfExecution(exec) {
  const agent = exec?.agent
  const id = agent?.session?.header?.id ?? agent?.id
  if (id === undefined || id === null || String(id).trim() === '') {
    throw new Error(
      'the workflow_plan tool needs an owning agent session: it keys its state, its artifacts and its prompt ' +
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

/** The append-only journal: one JSON object per line, for entries that must not cost a state rewrite. */
export function journalPathOf(root, key) {
  return join(sessionDirectory(root, key), 'journal.jsonl')
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** A fresh state document. `intent` is the root of everything recorded later. */
export function emptyState(intent, now = new Date().toISOString()) {
  return {
    version: STATE_VERSION,
    createdAt: now,
    updatedAt: now,
    intent,
    cwd: null,
    phase: 'intake',
    answers: [],
    assumptions: [],
    decisions: [],
    steps: [],
    evidence: [],
    notes: [],
    checkpoints: [],
    artifacts: {},
    history: [{ at: now, phase: 'intent', summary: summarize(intent) }],
  }
}

/**
 * Read a session's state, or `null`.
 *
 * Never throws, and never re-parses an unchanged document. A half-written or hand-edited document is
 * treated as absent, because the alternative is a plugin that cannot answer a tool call at all — and
 * `writeAtomic` makes a half-written document unreachable in the first place.
 */
export function readState(file) {
  try {
    const stamp = statSync(file)
    const cached = stateCache.get(file)
    if (cached !== undefined && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) return cached.state
    const raw = readFileSync(file, 'utf8')
    if (raw.trim() === '') {
      stateCache.set(file, { mtimeMs: stamp.mtimeMs, size: stamp.size, state: null })
      return null
    }
    const parsed = JSON.parse(raw)
    const state = parsed === null || typeof parsed !== 'object' || typeof parsed.phase !== 'string'
      ? null
      : normalizeState(parsed)
    stateCache.set(file, { mtimeMs: stamp.mtimeMs, size: stamp.size, state })
    return state
  } catch {
    // A missing document, a permission failure and malformed JSON all mean the same thing to a caller:
    // there is no usable state here. The cache entry is dropped so the next call re-reads rather than
    // repeating a stale answer.
    stateCache.delete(file)
    return null
  }
}

/** Keep only known keys and known shapes, so a hand-edited file cannot change what the plugin does. */
export function normalizeState(parsed) {
  const state = emptyState(typeof parsed.intent === 'string' ? parsed.intent : '')
  state.version = STATE_VERSION
  state.createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : state.createdAt
  state.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : state.updatedAt
  state.cwd = typeof parsed.cwd === 'string' ? parsed.cwd : null
  state.phase = PHASES.includes(parsed.phase) ? parsed.phase : 'intake'
  state.answers = Array.isArray(parsed.answers) ? parsed.answers : []
  state.assumptions = Array.isArray(parsed.assumptions) ? parsed.assumptions.filter(isText) : []
  state.decisions = Array.isArray(parsed.decisions) ? parsed.decisions.filter(isText) : []
  state.steps = Array.isArray(parsed.steps)
    ? parsed.steps
      .filter((step) => step !== null && typeof step === 'object' && typeof step.text === 'string')
      .map((step) => ({ text: step.text, status: step.status === 'done' ? 'done' : 'pending' }))
    : []
  state.evidence = Array.isArray(parsed.evidence) ? parsed.evidence.filter(isText) : []
  state.notes = Array.isArray(parsed.notes) ? parsed.notes.filter(isText) : []
  state.checkpoints = Array.isArray(parsed.checkpoints) ? parsed.checkpoints : []
  state.artifacts = parsed.artifacts !== null && typeof parsed.artifacts === 'object' ? { ...parsed.artifacts } : {}
  state.history = Array.isArray(parsed.history)
    ? parsed.history.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.phase === 'string')
    : state.history
  // The fields that carry one phase's output into the next one. They are re-read from disk on every
  // call, so a field dropped here is a field `choose` or `run` would no longer see.
  if (typeof parsed.goal === 'string') state.goal = parsed.goal
  if (typeof parsed.outcome === 'string') state.outcome = parsed.outcome
  if (typeof parsed.criteria === 'string') state.criteria = parsed.criteria
  if (typeof parsed.recommendation === 'string') state.recommendation = parsed.recommendation
  if (Array.isArray(parsed.files)) state.files = parsed.files.filter(isText)
  if (Array.isArray(parsed.constraints)) state.constraints = parsed.constraints.filter(isText)
  if (Array.isArray(parsed.plan)) state.plan = parsed.plan.filter(isText)
  if (Array.isArray(parsed.options)) {
    state.options = parsed.options
      .filter((option) => option !== null && typeof option === 'object' && typeof option.title === 'string')
      .map((option) => ({
        id: typeof option.id === 'string' ? option.id : '',
        title: option.title,
        pros: Array.isArray(option.pros) ? option.pros.filter(isText) : [],
        cons: Array.isArray(option.cons) ? option.cons.filter(isText) : [],
        criteria: typeof option.criteria === 'string' ? option.criteria : '',
        recommended: option.recommended === true,
      }))
  }
  if (parsed.choice !== null && typeof parsed.choice === 'object' && typeof parsed.choice.title === 'string') {
    state.choice = {
      id: typeof parsed.choice.id === 'string' ? parsed.choice.id : null,
      title: parsed.choice.title,
      verbatim: typeof parsed.choice.verbatim === 'string' ? parsed.choice.verbatim : parsed.choice.title,
      options: Array.isArray(parsed.choice.options) ? parsed.choice.options.filter(isText) : [],
    }
  }
  return state
}

function isText(value) {
  return typeof value === 'string'
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

/** Replace a whole document. One call per phase; a note never goes through here. */
export function writeDocument(file, title, body) {
  writeAtomic(file, `# ${title}\n\n${String(body).trim()}\n`)
  return file
}

/** Append one section. Used at most once per phase, so growth stays linear in phases. */
export function appendSection(file, title, body, now = new Date().toISOString()) {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const header = existing === '' ? `# ${title}\n` : ''
  writeAtomic(file, `${existing}${header}\n## ${now}\n\n${String(body).trim()}\n`)
  return file
}

// ---------------------------------------------------------------------------
// text distillation
// ---------------------------------------------------------------------------

/** One line for a summary field: whitespace collapsed and cut. */
export function summarize(text, max = SUMMARY_MAX) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Distil a longer document into the lines worth carrying forward.
 *
 * Headings and list items are preferred over prose because in a design document that is where the
 * decisions are; a plain paragraph falls back to its opening sentence. Bounded by `limit`, and the `Set`
 * removes the repetition a heading and its first bullet usually produce.
 */
export function bulletsOf(text, limit = 6) {
  const picked = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (/^#{1,6}\s+/.test(trimmed)) {
      picked.push(summarize(trimmed.replace(/^#{1,6}\s+/, ''), 120))
      continue
    }
    if (/^([-*+]\s+|\d+[.)]\s+)/.test(trimmed)) {
      picked.push(summarize(trimmed.replace(/^([-*+]\s+|\d+[.)]\s+)/, ''), 160))
      continue
    }
    if (picked.length === 0) picked.push(summarize(trimmed, 160))
    if (picked.length >= limit) break
  }
  return [...new Set(picked)].slice(0, limit)
}

/** Keep a list of short strings, bounded, so no empty entry reaches a document. */
export function trimList(value, limit = 24) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = summarize(item, 200)
    if (text !== '') out.push(text)
    if (out.length >= limit) break
  }
  return out
}

// ---------------------------------------------------------------------------
// gates
// ---------------------------------------------------------------------------

/**
 * Take the phase order from the state and refuse anything that would skip a gate.
 *
 * The message names the phase at hand AND the phase being asked for: a caller that has lost its place
 * should learn the next call from the refusal, not from a list of phases.
 */
export function assertPhase(state, required) {
  if (state === null) {
    throw new Error(
      required === 'intake'
        ? 'this session has no workflow yet'
        : `no workflow is active for this session: call workflow_plan with action "start" and the user's own prompt before "${required}"`,
    )
  }
  const current = PHASES.indexOf(state.phase)
  const wanted = PHASES.indexOf(required)
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
  return state !== null && state.phase === 'run'
}

// ---------------------------------------------------------------------------
// the handlers
// ---------------------------------------------------------------------------

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
  if (parts.options !== undefined && parts.options.length > 0) value.options = parts.options
  if (parts.note !== undefined && parts.note !== null) value.note = parts.note
  return value
}

/**
 * The single next call, which is what keeps the model from re-deriving the process.
 *
 * The key is the phase the workflow HOLDS, and the value is the call that records it — not the phase
 * after it. `plan` means "the plan has not been recorded yet, call plan", which is the reading a caller
 * arriving at a phase name actually needs.
 */
function nextInstruction(state) {
  switch (state?.phase) {
    case 'intake':
      return 'call workflow_plan with action "start": the user\'s prompt verbatim, plus 1-3 questions about intent or the assumptions you are making'
    case 'plan':
      return 'call workflow_plan with action "plan": the approach and process, at least two alternatives with pros and cons, and which one you recommend'
    case 'choose':
      return 'call workflow_plan with action "choose": the user picks, and their answer is recorded — do not decide for them'
    case 'run':
      return 'call workflow_plan with action "run" with the outcome to close it, or "note" for a decision worth keeping'
    default:
      return null
  }
}

export function makeHandlers({ root, ask, compact, logger = () => {} }) {
  const stateFile = (key) => statePathOf(root, key)
  const journalFile = (key) => journalPathOf(root, key)
  const artifact = (key, file) => join(sessionDirectory(root, key), file)

  function load(key) {
    return readState(stateFile(key))
  }

  /** One write per transition: persist, drop the cache entry, tell the logger. */
  function save(key, state) {
    const file = stateFile(key)
    writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`)
    invalidate(file)
    logger({ phase: state.phase, session: key })
    return state
  }

  function record(state, phase, summary, now) {
    state.history.push({ at: now, phase, summary: summarize(summary) })
    if (state.history.length > HISTORY_LIMIT) state.history.splice(0, state.history.length - HISTORY_LIMIT)
    state.updatedAt = now
  }

  /**
   * Append one line to the journal in O(1), instead of rewriting the state.
   *
   * `appendFileSync` is a real append — the operating system positions the write at the end — so a note
   * costs one line regardless of how many lines came before it. The first version read the whole journal,
   * pushed, and rewrote it, which is O(n) per note and O(n^2) over a workflow.
   *
   * The bound is enforced by compaction rather than by trimming on every write: a byte counter tracks how
   * much has accumulated, and the file is rewritten from its tail only once it has grown past twice the
   * limit. That keeps the append path amortised O(1) while the file stays bounded — the same trade a
   * write-ahead log makes, and for the same reason.
   */
  function appendJournal(key, entry) {
    const file = journalFile(key)
    const line = `${JSON.stringify(entry)}\n`
    try {
      appendFileSync(file, line, 'utf8')
      journalBytes.set(file, (journalBytes.get(file) ?? 0) + Buffer.byteLength(line, 'utf8'))
    } catch {
      // A directory that does not exist yet, or a transient failure: fall back to an atomic rewrite so the
      // note is never silently lost.
      let existing = ''
      try { existing = existsSync(file) ? readFileSync(file, 'utf8') : '' } catch { existing = '' }
      writeAtomic(file, `${existing}${line}`)
      journalBytes.set(file, (journalBytes.get(file) ?? 0) + Buffer.byteLength(line, 'utf8'))
    }
    if ((journalBytes.get(file) ?? 0) > JOURNAL_BYTES_LIMIT) compactJournal(file)
  }

  /** Rewrite the journal from its bounded tail. Called only when the append path has grown it too far. */
  function compactJournal(file) {
    try {
      const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
      const tail = lines.slice(-JOURNAL_LIMIT)
      writeAtomic(file, tail.length === 0 ? '' : `${tail.join('\n')}\n`)
      journalBytes.set(file, Buffer.byteLength(tail.join('\n'), 'utf8'))
    } catch {
      journalBytes.set(file, 0)
    }
  }

  /** Read the journal's tail, bounded, for a human-readable status. */
  function readJournal(key, limit = 8) {
    try {
      const file = journalFile(key)
      if (!existsSync(file)) return []
      const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
      const out = []
      for (const line of lines.slice(-limit)) {
        try { out.push(JSON.parse(line)) } catch { /* a torn line is skipped, not fatal */ }
      }
      return out
    } catch {
      return []
    }
  }

  /**
   * Ask the human and normalise the batch.
   *
   * One item per asked question is kept, including a skipped one: "the user was asked and skipped it" is
   * a fact a later step must not lose, and an empty array would erase the difference between skipped and
   * never asked. Each option keeps its label AND its one-line trade-off — dropping the description was
   * how the trade-offs reached nobody.
   */
  async function askBatch(questions, exec, onAnswer) {
    const asked = questions.map((question, index) => ({
      id: typeof question.id === 'string' && question.id.trim() !== '' ? question.id : `q${index + 1}`,
      question: String(question.question ?? '').trim(),
      ...question.header === undefined ? {} : { header: String(question.header) },
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

  /** What an answer says, as one line a later step can be held to. */
  function answerLine(asked, answer) {
    const question = asked.find((item) => item.id === answer.id)?.question ?? answer.id
    const given = answer.custom !== undefined && answer.custom !== ''
      ? answer.custom
      : (answer.selected.join(', ') || '(skipped)')
    return `${summarize(question, 100)} -> ${summarize(given, 120)}`
  }

  // ---- start: the intent, and at most three questions about it ------------------------------------

  /**
   * `start` is the entry point, and it is also the clarify step.
   *
   * Merging them removes a round-trip that produced no information: the model had to call `start` with the
   * prompt and then `clarify` with the questions it could already have written. The gate is preserved —
   * `plan` is still refused until the intent is on record and either questions were asked or assumptions
   * stated.
   *
   * A clear request costs ZERO human interactions: `assumptions` records what the model took for granted
   * instead of spending the user's attention on a question whose answer was implied. The evidence for
   * "minimal, relevant questions" over interrogation is the Ask-to-Act line of work
   * (https://arxiv.org/abs/2504.00907).
   */
  async function start({ intent, questions, assumptions, cwd, key, reset }, exec) {
    if (reset === true) removeSession(root, key)
    // The basis is checked BEFORE the "already active" gate, and the order matters: `start` is the one
    // action allowed on a finished workflow, so a start with no questions and no assumptions used to
    // fail with "no workflow is active" — a message that describes neither the real problem nor the fix.
    const asking = Array.isArray(questions) && questions.length > 0
    const stated = trimList(assumptions, 12)
    if (asking && questions.length > 3) {
      throw new Error(
        'ask at most 3 questions in one batch: minimal and relevant is the standard, and a longer ' +
        'interrogation is a sign the intent is not understood yet',
      )
    }
    if (!asking && stated.length === 0) {
      throw new Error(
        'start needs either "questions" (1-3, about intent, the binding constraint, and what "done" means) ' +
        'or "assumptions" (what you are taking for granted if you ask nothing): a workflow may not open ' +
        'with neither, because then nothing about the request has been established',
      )
    }

    const existing = load(key)
    if (existing !== null && existing.phase !== 'done') {
      throw new Error(
        `a workflow is already active for this session (phase "${existing.phase}"): ` +
        'pass reset: true to discard it and start a new one, or finish it first',
      )
    }
    // A finished workflow's documents are archived rather than overwritten: the next workflow writes the
    // same file names, and "what did we decide last time" is what a fresh start wants to read.
    if (existing !== null) {
      const directory = sessionDirectory(root, key)
      // The stamp must be legal as a directory name on every platform. `toISOString()` is not: it contains
      // colons, so on Windows the rename failed and was swallowed by the catch below — the archive claimed
      // by the README never happened, and the next workflow silently inherited the finished one's files.
      const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]/g, '').slice(0, 15)
      try {
        renameSync(directory, `${directory}.done-${stamp}`)
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          // A missing directory is the benign case (nothing to archive yet). Anything else means the
          // previous workflow's documents are about to be mixed with this one's, so it is reported.
          throw new Error(`could not archive the previous workflow at ${directory}: ${error.message}`)
        }
      }
      invalidate(stateFile(key))
    }

    const state = emptyState(summarize(intent, INTENT_MAX))
    state.cwd = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null
    state.assumptions = stated
    // The user's own words are on disk before anything is asked or planned: every later artifact is a
    // derivative of this one, and a paraphrase — or a whitespace-collapsed copy — is not a substitute.
    // The verbatim text goes to the document; the collapsed form is only ever used for summaries.
    state.artifacts.intent = writeDocument(artifact(key, '01-intent.md'), 'Original prompt', String(intent).trim())

    if (!asking) {
      state.decisions = state.assumptions.map((item) => `assumed: ${item}`)
      state.phase = 'plan'
      record(state, 'intake', `assumptions recorded: ${state.assumptions[0]}`, new Date().toISOString())
      state.artifacts.intent = appendSection(
        state.artifacts.intent,
        'Assumptions (no questions asked)',
        state.assumptions.map((item) => `- ${item}`).join('\n'),
      )
      save(key, state)
      return envelope({
        phase: state.phase,
        summary: `intent recorded with ${state.assumptions.length} assumption(s), no questions asked`,
        next: nextInstruction(state),
        files: { intent: state.artifacts.intent },
        note: 'the assumptions are on record and the user can correct them at the next step, which is cheaper than a question whose answer was implied',
      })
    }

    await askBatch(questions, exec, (asked, answers) => {
      state.answers = answers.map((answer) => ({ ...answer, question: asked.find((q) => q.id === answer.id)?.question }))
      state.decisions = [...state.decisions, ...answers.map((answer) => answerLine(asked, answer))]
      state.phase = 'plan'
      state.artifacts.intent = appendSection(
        state.artifacts.intent,
        'Clarified intent',
        [
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
      record(state, 'intake', state.decisions.slice(-answers.length).join('; '), new Date().toISOString())
      // The single write for this transition, after the ask resolves: a failed ask leaves no half state.
      save(key, state)
    })
    return envelope({
      phase: state.phase,
      summary: `intent clarified with ${state.answers.length} answer(s)`,
      next: nextInstruction(state),
      files: { intent: state.artifacts.intent },
      decisions: state.decisions.slice(-3),
      note: 'the full record is in the intent file; the conversation carries the short version',
    })
  }

  // ---- plan: the design space, in ONE record ------------------------------------------------------

  /**
   * The design and its alternatives are one call, because they are one decision.
   *
   * `replace: true` records a revision after the user pushed back, which is the one legitimate way to
   * re-enter this phase. A rejected plan is a new plan rather than a loop, so the old one stays in the
   * document with the reason it was replaced.
   */
  function plan({ content, options, criteria, summary, recommendation, replace, key }) {
    const current = load(key)
    // A revision is the ONE legitimate re-entry into this phase, so it is checked before the gate: a plan
    // the user pushed back on is a new plan, not an out-of-order call.
    if (replace === true && current !== null && current.phase === 'choose') {
      // allowed: the workflow stays at `choose` and will be re-decided after the revision lands
    } else {
      assertPhase(current, 'plan')
    }
    const state = current
    const body = String(content ?? '').trim()
    if (body === '') {
      throw new Error(
        'plan needs "content": the approach and process, as markdown — components, flow, files touched, ' +
        'and how it will be verified',
      )
    }
    if (!Array.isArray(options) || options.length < 2) {
      throw new Error(
        'plan needs at least two "options": "list the options and their pros and cons" is the point of the ' +
        'phase, and one option is not a choice',
      )
    }
    const normalized = options.map((option, index) => {
      const id = typeof option.id === 'string' && option.id.trim() !== '' ? option.id.trim() : `o${index + 1}`
      const title = summarize(option.title, 160)
      const pros = trimList(option.pros)
      const cons = trimList(option.cons)
      if (title === '') throw new Error('every option needs a "title"')
      if (pros.length === 0 && cons.length === 0) {
        throw new Error(`option "${title}" has neither pros nor cons: an option that cannot be argued for or against is not a choice`)
      }
      return { id, title, pros, cons, criteria: summarize(option.criteria ?? '', 240), recommended: option.recommended === true }
    })
    const wanted = typeof recommendation === 'string' ? recommendation.trim() : ''
    const recommended = normalized.find((option) => option.recommended === true)
      ?? (wanted === '' ? undefined : normalized.find((option) => option.id === wanted || option.title.startsWith(wanted)))
    if (recommended !== undefined) recommended.recommended = true

    const planFile = artifact(key, '02-plan.md')
    const section = [
      '## Approach and process',
      body,
      '',
      '## Options and criteria',
      criteria === undefined || String(criteria).trim() === '' ? '' : `Criteria: ${summarize(criteria, 400)}\n`,
      ...normalized.map((option) => [
        `### ${option.id}. ${option.title}${option.recommended ? ' — recommended' : ''}`,
        option.criteria === '' ? '' : `- criteria: ${option.criteria}`,
        option.pros.length > 0 ? `- pros: ${option.pros.join('; ')}` : '- pros: (none recorded)',
        option.cons.length > 0 ? `- cons: ${option.cons.join('; ')}` : '- cons: (none recorded)',
      ].filter((part) => part !== '').join('\n')),
    ].join('\n')
    state.artifacts.plan = replace === true
      ? appendSection(planFile, 'Plan (revised)', `Reason for revision: ${summarize(summary ?? 'user feedback', 300)}\n\n${section}`)
      : writeDocument(planFile, 'Plan', section)

    state.options = normalized
    state.plan = bulletsOf(body)
    state.criteria = summarize(criteria ?? '', 400)
    if (wanted !== '') state.recommendation = summarize(wanted, 240)

    const line = summarize(summary ?? `${normalized.length} options: ${normalized.map((o) => o.title).join(' / ')}`, 200)
    state.phase = 'choose'
    record(state, replace === true ? 'plan-revised' : 'plan', line, new Date().toISOString())
    save(key, state)
    return envelope({
      phase: state.phase,
      summary: line,
      next: nextInstruction(state),
      files: { plan: state.artifacts.plan },
      // The alternatives are echoed back here and ONLY here: the next call asks the user to choose between
      // them, so a caller that has not read the plan file would otherwise re-read it just to name them.
      // The prose stays in the file — echoing it on every later call would be a cost with no reader.
      options: normalized.map((option) => ({
        id: option.id,
        title: option.title,
        recommended: option.recommended === true,
      })),
      note: `${body.length} chars stored on disk; the trade-offs and criteria are in the plan file`,
    })
  }

  // ---- choose: the user decides ------------------------------------------------------------------

  async function choose({ question, key }, exec) {
    const state = assertPhase(load(key), 'choose')
    const listed = Array.isArray(state.options) ? state.options : []
    if (listed.length === 0) throw new Error('no options are recorded, so there is nothing to choose between')
    // The recommendation goes first, which is the order the ask-user contract reads as "recommended".
    const ordered = [...listed].sort((a, b) => Number(b.recommended === true) - Number(a.recommended === true))
    const asked = typeof question === 'string' && question.trim() !== ''
      ? question.trim()
      : `Which option should I execute?${state.criteria === '' ? '' : ` (${summarize(state.criteria, 160)})`}`

    const chosen = await askBatch(
      [{
        id: 'choice',
        header: 'Choose',
        question: asked,
        options: ordered.map((option) => ({
          label: option.recommended === true ? `${option.title} (Recommended)` : option.title,
          ...option.cons.length > 0
            ? { description: `cost: ${option.cons.slice(0, 2).join('; ')}` }
            : (option.pros.length > 0 ? { description: `gain: ${option.pros.slice(0, 2).join('; ')}` } : {}),
        })),
      }],
      exec,
      (askedQuestions, answers) => {
        const answer = answers[0] ?? { id: 'choice', selected: [] }
        const spoken = answer.custom !== undefined && answer.custom !== ''
          ? answer.custom
          : (answer.selected[0] ?? '')
        const matched = listed.find((option) => spoken === option.title || spoken.startsWith(option.title))
        const decision = summarize(matched?.title ?? spoken, 200)
        if (decision === '') {
          throw new Error('the user did not choose an option, so run cannot be entered: ask again with a clearer question')
        }
        state.choice = {
          id: matched?.id ?? null,
          title: decision,
          verbatim: spoken,
          options: listed.map((option) => option.title),
        }
        state.decisions = [...state.decisions, `chosen option: ${summarize(decision, 120)}`]
        appendSection(
          artifact(key, '02-plan.md'),
          'Decision',
          [
            `The user chose **${decision}**${askedQuestions[0] === undefined ? '' : ` in answer to: ${askedQuestions[0].question}`}`,
            '',
            matched === undefined
              ? 'This was not one of the listed options; it is recorded verbatim.'
              : `Alternatives offered: ${listed.map((option) => option.title).join(' / ')}`,
          ].join('\n'),
        )
        state.phase = 'run'
        record(state, 'choose', decision, new Date().toISOString())
        save(key, state)
        return decision
      },
    )
    return envelope({
      phase: state.phase,
      summary: `user chose: ${summarize(chosen, 140)}`,
      next: nextInstruction(state),
      decisions: state.decisions.slice(-3),
      note: 'execute only this option; a different option is a new workflow',
    })
  }

  // ---- run: execute, and close it in the same call when one step finishes it -----------------------

  /**
   * `run` opens execution, records progress, and closes the workflow.
   *
   * One action rather than `execute` + `progress` + `finish`, because the three differ only in whether
   * the work is opening, continuing, or over — and the caller knows which from what it passes. The
   * common case (one step, done) is one call instead of three.
   *
   * Every mutation happens in memory and is written once, so a run that records its steps and its
   * outcome costs two writes: the execution document and one state document.
   */
  function run({ goal, steps, outcome, files, evidence, constraints, status, note, key }) {
    const state = load(key)
    if (state === null) {
      throw new Error('no workflow is active for this session: call action "start" and then "plan" and "choose" first')
    }
    // A finished workflow is terminal for NEW work, but its journal may still be written to: a note or a
    // late step from a resumed session is a record-keeping call, not a new execution. So the gate is
    // applied to what the call asks for rather than to the phase alone — the first version refused
    // everything after `done`, including a note that only appended to the journal.
    const finishing = typeof outcome === 'string' && outcome.trim() !== ''
    // WHICH CALL OPENS EXECUTION is decided by whether an execution document exists, not by the phase:
    // `choose` sets the phase to `run`, so a phase test would call every later step "the opening one" and
    // let a bare `run` through with nothing to record.
    const opening = state.artifacts.execution === undefined
    if (state.phase === 'done') {
      if (finishing) {
        throw new Error(
          'this workflow is already done, so it cannot take another outcome: a new unit of work needs its ' +
          'own workflow — call action "start"',
        )
      }
      if (status === undefined) {
        throw new Error(
          'this workflow is already done: a new unit of work needs its own workflow (action "start"); pass ' +
          '"status" and "note" only to record a late step in the finished one',
        )
      }
    } else if (state.phase === 'intake' || state.phase === 'plan') {
      // The refusal is the gate: execution cannot begin before the user has chosen.
      assertPhase(state, 'choose')
    } else {
      assertPhase(state, 'run')
    }
    if (state.choice === undefined) {
      throw new Error(
        'run without a recorded choice is refused: the user has not picked an option yet, so call action "plan" ' +
        'and then "choose"',
      )
    }
    // Opening execution without a plan of what it will do is how an execution record becomes a note.
    if (opening && steps === undefined && outcome === undefined) {
      throw new Error(
        'the first "run" needs "steps" (what execution will do) or "outcome" (work this single call ' +
        'finishes): an execution record with neither says nothing',
      )
    }

    const now = new Date().toISOString()
    const plan = trimList(steps)
    if (plan.length > 0) state.steps = plan.slice(0, STEP_LIMIT).map((text) => ({ text, status: 'pending' }))
    if (typeof goal === 'string' && goal.trim() !== '') state.goal = summarize(goal, 400)
    if (Array.isArray(files)) state.files = trimList(files)
    if (Array.isArray(constraints)) state.constraints = trimList(constraints)
    if (typeof evidence === 'string' && evidence.trim() !== '') {
      state.evidence = [...state.evidence, summarize(evidence, 240)].slice(-STEP_LIMIT)
    }

    let executionFile = state.artifacts.execution
    if (executionFile === undefined) {
      executionFile = writeDocument(
        artifact(key, '03-execution.md'),
        `Execution: ${state.choice.title}`,
        [
          `Chosen option: **${state.choice.title}**`,
          state.goal === undefined ? '' : `\n## Goal\n${state.goal}`,
          state.steps.length === 0 ? '' : `\n## Steps\n${state.steps.map((step, index) => `${index + 1}. ${step.text}`).join('\n')}`,
          state.files === undefined || state.files.length === 0 ? '' : `\n## Files in scope\n${state.files.map((f) => `- ${f}`).join('\n')}`,
          state.constraints === undefined || state.constraints.length === 0 ? '' : `\n## Constraints\n${state.constraints.map((c) => `- ${c}`).join('\n')}`,
        ].filter((part) => part !== '').join('\n'),
      )
      state.artifacts.execution = executionFile
    }

    // `status` + `note` is the multi-step form: it records one step without closing anything.
    const stepText = status === undefined ? '' : summarize(note ?? '', 200)
    if (stepText !== '') {
      const done = status !== 'pending'
      const existing = state.steps.find((item) => item.text === stepText)
      if (existing !== undefined) existing.status = done ? 'done' : 'pending'
      else state.steps.push({ text: stepText, status: done ? 'done' : 'pending' })
      if (state.steps.length > STEP_LIMIT) state.steps.splice(0, state.steps.length - STEP_LIMIT)
      appendJournal(key, { at: now, kind: 'step', text: stepText, done })
    } else if (status !== undefined) {
      throw new Error('run with "status" also needs "note": the step it is marking')
    }

    // Only a workflow in flight can be opened. A `done` one may take the late step recorded above, but the
    // phase must not move backwards: the first version fell through and set it to `run` again, so a
    // finished workflow reported itself as executing.
    if (state.phase === 'done') {
      save(key, state)
      return envelope({
        phase: 'done',
        summary: `late step recorded: ${stepText}`,
        next: null,
        steps: state.steps.map((item) => `${item.status === 'done' ? '[x]' : '[ ]'} ${item.text}`).slice(0, 8),
        note: 'the workflow is finished; this was recorded in its journal without reopening it',
      })
    }

    if (finishing) {
      const open = state.steps.filter((item) => item.status !== 'done')
      state.outcome = summarize(outcome, 400)
      state.artifacts.outcome = appendSection(
        artifact(key, '04-outcome.md'),
        'Outcome',
        `${state.outcome}${open.length === 0 ? '' : `\n\nStill open: ${open.map((item) => item.text).join('; ')}`}`,
        now,
      )
      state.phase = 'done'
      record(state, 'run', state.outcome, now)
      save(key, state)
      return envelope({
        phase: state.phase,
        summary: state.outcome,
        next: null,
        files: { outcome: state.artifacts.outcome, ...executionFile === undefined ? {} : { execution: executionFile } },
        // The final result lists only what is NOT finished: a closed step's text has no reader left, and
        // this is the last message of the workflow, so it is the one place where that omission is free.
        steps: open.map((item) => `[ ] ${item.text}`).slice(0, 8),
        note: open.length === 0
          ? 'every recorded step is closed: the workflow is finished'
          : `still open: ${open.length} step(s) — reported as such rather than hidden`,
      })
    }

    state.phase = 'run'
    record(state, 'run', `execution started on: ${summarize(state.choice.title, 120)}`, now)
    save(key, state)
    return envelope({
      phase: state.phase,
      summary: `executing: ${summarize(state.choice.title, 120)}`,
      next: nextInstruction(state),
      files: { execution: executionFile },
      // `steps` is echoed here and on progress, and nowhere else: this result is the plan the model works
      // from, and repeating it on every later call would grow the request history for no reader.
      steps: state.steps.map((item) => `${item.status === 'done' ? '[x]' : '[ ]'} ${item.text}`).slice(0, 8),
      note: 'record a step with status + note, a decision with action "note", and close it with "outcome"',
    })
  }

  /**
   * `note` records a remark, or a decision, made during execution.
   *
   * It appends one journal line and does not rewrite `state.json` for a plain note, which is what makes
   * it cheap enough to use freely: the previous shape re-read and rewrote the whole state for every
   * entry, which is O(n^2) in the number of entries. A decision IS written back, because it changes what
   * `status` and the prompt report.
   */
  function note({ text, kind, key }) {
    const state = load(key)
    if (state === null) throw new Error('no workflow is active for this session')
    if (state.phase !== 'run' && state.phase !== 'done') {
      throw new Error(`"note" belongs to execution, but this workflow is at "${state.phase}"`)
    }
    const body = summarize(text, 400)
    if (body === '') throw new Error('note needs "text": what is worth remembering about this step')
    const decision = kind === 'decision'
    appendJournal(key, { at: new Date().toISOString(), kind: decision ? 'decision' : 'note', text: body })
    state.notes = [...state.notes, body].slice(-STEP_LIMIT)
    state.updatedAt = new Date().toISOString()
    if (decision) {
      state.decisions = [...state.decisions, body].slice(-STEP_LIMIT)
      save(key, state)
    }
    return envelope({
      phase: state.phase,
      summary: body,
      next: nextInstruction(state),
      note: decision
        ? 'recorded as a decision: it is carried in the state, not only in the journal'
        : 'recorded in the journal for this session',
    })
  }

  // ---- checkpoint --------------------------------------------------------------------------------

  /**
   * The compression, made explicit and inspectable.
   *
   * Everything decided so far goes to `05-checkpoint.md`, and the response carries one line — the shape a
   * compacted or resumed session needs, and nothing more. The fold also merges the journal into the
   * state, which is the moment a note's own size is all it ever cost.
   */
  function checkpoint({ key, reason }) {
    const state = load(key)
    if (state === null) throw new Error('no workflow is active for this session, so there is nothing to checkpoint')
    const now = new Date().toISOString()
    const journal = readJournal(key, JOURNAL_LIMIT)
    const body = [
      `Phase: ${state.phase}`,
      `- original prompt: ${state.intent}`,
      `- cwd: ${state.cwd ?? '(unknown)'}`,
      ...state.assumptions.length === 0 ? [] : [`- assumptions: ${state.assumptions.join('; ')}`],
      ...state.decisions.length === 0 ? [] : ['', '## Decisions', ...state.decisions.map((d) => `- ${d}`)],
      ...state.choice === undefined ? [] : ['', '## Chosen option', `- ${state.choice.title}`],
      ...state.steps.length === 0 ? [] : ['', '## Steps', ...state.steps.map((s) => `- [${s.status === 'done' ? 'x' : ' '}] ${s.text}`)],
      ...state.evidence.length === 0 ? [] : ['', '## Evidence', ...state.evidence.map((e) => `- ${e}`)],
      ...journal.length === 0 ? [] : ['', '## Recent activity', ...journal.map((entry) => `- ${entry.text}`)],
      ...Object.keys(state.artifacts).length === 0 ? [] : ['', '## Artifacts', ...Object.entries(state.artifacts).map(([name, file]) => `- ${name}: ${file}`)],
      ...typeof reason === 'string' && reason.trim() !== '' ? ['', `Reason: ${summarize(reason, 400)}`] : [],
    ].join('\n')
    state.artifacts.checkpoint = appendSection(artifact(key, '05-checkpoint.md'), 'Checkpoint', body, now)
    state.checkpoints = [...state.checkpoints, { at: now, phase: state.phase, reason: summarize(reason ?? '', 160) }].slice(-STEP_LIMIT)
    state.updatedAt = now
    save(key, state)
    return envelope({
      phase: state.phase,
      summary: `checkpoint at ${state.phase}: ${state.history.length} history entries compressed`,
      next: nextInstruction(state),
      files: { checkpoint: state.artifacts.checkpoint },
      decisions: state.decisions.slice(-3),
      note: compact(state),
    })
  }

  // ---- status / reset ----------------------------------------------------------------------------

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
      summary: state.outcome ?? state.goal ?? state.intent,
      next: nextInstruction(state),
      files: state.artifacts,
      decisions: state.decisions.slice(-3),
      steps: state.steps.map((item) => `${item.status === 'done' ? '[x]' : '[ ]'} ${item.text}`).slice(0, 8),
      note: `updated ${state.updatedAt}`,
    })
  }

  function reset({ key }) {
    const state = load(key)
    if (state === null) {
      return envelope({ phase: 'none', summary: 'no workflow was active', next: nextInstruction({ phase: 'intake' }) })
    }
    removeSession(root, key)
    logger({ phase: 'reset', session: key })
    return envelope({
      phase: 'none',
      summary: `workflow discarded (was at "${state.phase}")`,
      next: 'call workflow_plan with action "start" and the user\'s own prompt to begin again',
    })
  }

  return { start, plan, choose, run, note, checkpoint, status, reset }
}

/**
 * Delete one session's directory, after proving it is inside the root.
 *
 * Same lesson as this repository's protected-path boundary: a join is not a containment check, and a
 * session key that reached the filesystem unchecked would be a path traversal. The check is on the path,
 * and it fails closed.
 */
export function removeSession(root, key) {
  const directory = sessionDirectory(root, key)
  const normalizedRoot = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root
  const separator = process.platform === 'win32' ? '\\' : '/'
  if (directory !== normalizedRoot && !directory.startsWith(`${normalizedRoot}${separator}`)) {
    throw new Error(`refusing to remove '${directory}': it is not inside '${root}'`)
  }
  rmSync(directory, { recursive: true, force: true })
  invalidate(statePathOf(root, key))
  journalBytes.delete(journalPathOf(root, key))
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
export function sectionOrder(prompt) {
  try {
    const order = prompt?.getSectionOrder?.('TOOL_READ')
    return Number.isFinite(order) ? order + 1 : 500
  } catch {
    return 500
  }
}

/**
 * The plugin's contribution to the system prompt. It is a CONSTANT, and that is the whole design.
 *
 * WHY THIS TEXT MUST NOT DEPEND ON THE WORKFLOW STATE
 *
 * DeepSeek's context cache matches complete prefix units byte for byte, and the system prompt sits before
 * the tool catalog and the whole message history — so a change to it invalidates everything that follows.
 * Measured on the live endpoint, ten variants of one 7,384-token request: appending a message kept a 98.7%
 * hit, while changing the system prompt ANYWHERE — one line at the end included — produced a 0.0% hit
 * (https://github.com/diguike/book-deepseek-harness/blob/main/book/11-prefix-stability.md).
 *
 * The first version of this plugin rendered the current phase into this text, so a four-call workflow
 * re-wrote the system prompt 3-4 times and paid a full-prefix miss each time. The harness itself hit the
 * same trap with the sandbox policy: one permission switch dropped cache reads from ~14.7k tokens to 256,
 * and the fix was to move the changing fact out of the prompt entirely
 * (https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-09-02-in-history-system-prompt-replacement.md).
 *
 * So the phase is NOT here. The single next call is returned in the `workflow_plan` tool's own result, which is
 * appended history and therefore free — and a call made out of order is refused with the phase named. The
 * prompt only has to say that the tool exists and when to reach for it.
 *
 * `tests/workflow.test.mjs` asserts the invariant directly: this string is byte-identical at every phase,
 * so the plugin induces zero prompt changes per workflow. Under the harness's own README taxonomy
 * (`#### KV Cache effect`) this plugin is **prefix-stable**, with one named exception: the text changes
 * once, at registration, if a deployment edits it.
 */
export const SECTION_TEXT = [
  '## Workflow',
  'For a request that is more than one obvious step, or whose shape you would have to guess, use the',
  '`workflow_plan` tool: it records the request, asks the user what they actually want, lays out the alternatives',
  'with their pros and cons, has the user choose, and only then executes. Its own results carry what to do',
  'next, and a step taken out of order is refused with the phase that must run first. For a single obvious',
  'step, skip it.',
].join(' ')

/** The section text. A function of nothing, deliberately: see SECTION_TEXT. */
export function workflowSectionText() {
  return SECTION_TEXT
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/**
 * The tool description.
 *
 * This is now the ONLY discovery path, because the prompt section is a frozen constant and cannot carry
 * guidance. It is in the tool catalog, which sits inside the cached prefix and is sent once — so clarity
 * here is cheaper than brevity, but it still has to be short enough not to bloat the prefix.
 */
const TOOL_DESCRIPTION = [
  'Intent-first workflow: agree on what is wanted and how it will be done, before doing it. Use it when a',
  'request is more than one obvious step, or when you would have to guess the user\'s intent, their',
  'preferred approach, or where the work belongs. Four calls:',
  '"start" (the prompt verbatim, plus 1-3 questions about intent OR the assumptions you are making) ->',
  '"plan" (approach and process, at least two alternatives with pros and cons, your recommendation) ->',
  '"choose" (ASKS THE USER; you cannot answer it for them) ->',
  '"run" (execute the chosen option; add "outcome" to close the workflow in the same call).',
  'Then "note" for a decision, "checkpoint" at a boundary. Long documents go to files and only a line',
  'returns, so the conversation stays small; results list the files. A step out of order is refused, and the',
  'refusal names the phase to record first. Every result carries "next", the one call to make. Also "status", "reset".',
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
    criteria: { type: 'string', description: 'The criterion this option does best or worst on.' },
    recommended: { type: 'boolean', description: 'Set on exactly one option to put it first for the user.' },
  },
  required: ['title'],
}

/** The action list, in the order the description explains them. */
export const ACTIONS = ['start', 'plan', 'choose', 'run', 'note', 'checkpoint', 'status', 'reset']

/**
 * The cost model, asserted by the tests.
 *
 * It exists as data rather than prose because the whole point of the fused phases is a number. `toolCalls`
 * and `humanInteractions` are the round-trips; `promptChangesPerWorkflow` is the cache property, and it is
 * zero: the system prompt is a constant, so no phase of any workflow can invalidate the provider's cached
 * prefix. A change that reintroduces a phase, or that lets state reach the prompt, has to change this
 * object and therefore fail a test.
 */
export const COST_MODEL = {
  shortestPath: ['start', 'plan', 'choose', 'run'],
  toolCalls: 4,
  humanInteractions: 1,
  // The number of times the plugin's system-prompt contribution changes over one whole workflow. Not
  // "small" — zero, because anything else costs the entire prefix.
  promptChangesPerWorkflow: 0,
  cacheEffect: 'prefix-stable',
  previous: { toolCalls: 8, humanInteractions: 2, promptChangesPerWorkflow: 3 },
}

/**
 * The model-facing tool name.
 *
 * NOT `workflow`. A host composition already exposes a built-in tool by that name — the JavaScript
 * multi-agent orchestrator from `@deepseek-ai/dsh-tool-workflow` — and two tools sharing one name within a
 * scope collide: whoever registers second aborts, or both resolve and the model is offered two unrelated
 * `workflow` tools. `_plan` also says what this one is: the planning half of a workflow, leaving
 * `workflow` for the orchestrator.
 */
export const TOOL_NAME = 'workflow_plan'

/** Exported so a test can assert the tool contract without a live registry. */
export function workflowToolDefinition(handlers) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'The phase to record. A later phase is refused until the earlier one is recorded.' },
        intent: { type: 'string', description: 'start: the user\'s request, verbatim. Required by start.' },
        questions: { type: 'array', items: QUESTION_SCHEMA, description: 'start: 1-3 questions for the user about intent. Give this or "assumptions".' },
        assumptions: { type: 'array', items: { type: 'string' }, description: 'start: what you are taking for granted, when the request is clear enough to ask nothing.' },
        cwd: { type: 'string', description: 'start: absolute path the work happens in. Defaults to the session working directory.' },
        reset: { type: 'boolean', description: 'start: discard an active workflow for this session and begin a new one.' },
        content: { type: 'string', description: 'plan: the approach and process, as markdown. Required by plan.' },
        options: { type: 'array', items: OPTION_SCHEMA, description: 'plan: at least two alternatives with pros and cons. Required by plan.' },
        criteria: { type: 'string', description: 'plan: the criteria the alternatives were judged against.' },
        recommendation: { type: 'string', description: 'plan: the id or title of the option you recommend.' },
        summary: { type: 'string', description: 'plan: the one line this phase contributes to later context.' },
        replace: { type: 'boolean', description: 'plan: record a revision after the user rejected the plan, keeping the original.' },
        question: { type: 'string', description: 'choose: the question shown to the user. Defaults to asking which option to run.' },
        goal: { type: 'string', description: 'run: what this execution must achieve.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'run: the ordered steps.' },
        outcome: { type: 'string', description: 'run: what was delivered. Passing it closes the workflow in the same call.' },
        files: { type: 'array', items: { type: 'string' }, description: 'run: files in scope.' },
        evidence: { type: 'string', description: 'run: how the work will be, or was, verified.' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'run: what must not change.' },
        status: { type: 'string', enum: ['done', 'pending'], description: 'run: with "note", marks that step done or leaves it open.' },
        note: { type: 'string', description: 'run: the step being marked. In "note", the remark to record.' },
        text: { type: 'string', description: 'note: the decision or remark to record.' },
        kind: { type: 'string', enum: ['note', 'decision'], description: 'note: a decision is carried in the state; a note stays in the journal.' },
        reason: { type: 'string', description: 'checkpoint: why the compression is happening now.' },
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
      let value
      switch (action) {
        case 'start':
          if (typeof args.intent !== 'string' || args.intent.trim() === '') {
            throw new Error('start needs "intent": the user\'s request in their own words, not a paraphrase of it')
          }
          value = await handlers.start({
            intent: args.intent,
            questions: args.questions,
            assumptions: args.assumptions,
            cwd: args.cwd ?? exec?.agent?.session?.header?.cwd,
            key,
            reset: args.reset === true,
          }, exec)
          break
        case 'plan':
          value = handlers.plan({
            content: args.content,
            options: args.options,
            criteria: args.criteria,
            summary: args.summary,
            recommendation: args.recommendation,
            replace: args.replace === true,
            key,
          })
          break
        case 'choose':
          value = await handlers.choose({ question: args.question, key }, exec)
          break
        case 'run':
          value = handlers.run({
            goal: args.goal,
            steps: args.steps,
            outcome: args.outcome,
            files: args.files,
            evidence: args.evidence,
            constraints: args.constraints,
            status: args.status,
            note: args.note ?? args.text,
            key,
          })
          break
        case 'note':
          value = handlers.note({ text: args.text ?? args.note, kind: args.kind, key })
          break
        case 'checkpoint':
          value = handlers.checkpoint({ key, reason: args.reason })
          break
        case 'status':
          value = handlers.status({ key })
          break
        case 'reset':
          value = handlers.reset({ key })
          break
        default:
          throw new Error(`unknown workflow action '${action}': expected one of ${ACTIONS.join(', ')}`)
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
    const boundaries = state.checkpoints.length
    if (!autoCompact) {
      return `${boundaries} checkpoint(s) recorded; automatic compaction is disabled by configuration`
    }
    return `${boundaries} checkpoint(s) recorded (limit ${maxCheckpoints}); the full record is on disk, so the conversation can drop it and keep the summary`
  }

  const handlers = makeHandlers({
    root,
    compact,
    logger: () => { /* reserved for a future activity feed; kept so the seam exists in one place */ },
    ask: async (questions, exec) => {
      const userQuestions = ctx.userQuestions
      if (userQuestions === undefined) {
        throw new Error('the workflow_plan tool needs the userQuestions service to ask the user, and this deployment has none')
      }
      const request = {
        questions,
        ...exec?.agent === undefined ? {} : { agent: exec.agent },
        ...exec?.signal === undefined ? {} : { signal: exec.signal },
      }
      // `wait.callId` is what keeps the question answerable in the transcript after the call returns,
      // and it exists only for a real tool call.
      return userQuestions.ask(exec?.callId === undefined ? request : { ...request, wait: { callId: exec.callId } })
    },
  })

  if (typeof ctx.tools?.register === 'function') ctx.tools.register(workflowToolDefinition(handlers))

  // The prompt half is registered only when the registry is present, so a deployment without it loses
  // the section rather than the feature. The text is a constant: no state is read, nothing is looked up,
  // and the model's cached prefix survives every phase of every workflow. See SECTION_TEXT.
  if (typeof ctx.systemPrompt?.section === 'function') {
    ctx.systemPrompt.section({
      name: 'dsh-os:workflow',
      order: sectionOrder(ctx.systemPrompt),
      text: SECTION_TEXT,
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
  invalidate,
  stateCache,
}
