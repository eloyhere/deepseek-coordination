/** Pure post-input intake model: expand, bound and map popup questions without host imports. */
import type { QuestionKind } from 'attention-manifest-protocol/question'

export interface IntakeOptionInput {
  readonly label: string
  readonly description?: string
}

export interface IntakeQuestionInput {
  readonly id?: string
  readonly header?: string
  readonly question: string
  readonly detail?: string
  readonly options?: readonly (string | IntakeOptionInput)[]
  readonly multiSelect?: boolean
  readonly kind?: QuestionKind
}

export interface IntakeProposalInput {
  readonly id?: string
  readonly title: string
  readonly summary?: string
  readonly tradeoffs?: string
  readonly recommended?: boolean
}

export interface IntakeExpansionInput {
  readonly goal?: string
  readonly summary?: string
  readonly assumptions?: readonly string[]
  readonly unknowns?: readonly string[]
  readonly approaches?: readonly IntakeProposalInput[]
}

export interface IntakeOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

export interface IntakeQuestion {
  readonly id: string
  readonly header?: string
  readonly question: string
  readonly detail?: string
  readonly options: readonly IntakeOption[]
  readonly multiSelect: boolean
  readonly kind: QuestionKind
}

export interface IntakeProposal {
  readonly id: string
  readonly title: string
  readonly summary?: string
  readonly tradeoffs?: string
  readonly recommended: boolean
}

export interface IntakeExpansion {
  readonly goal?: string
  readonly summary?: string
  readonly assumptions: readonly string[]
  readonly unknowns: readonly string[]
}

export interface NormalizedIntake {
  readonly topic?: string
  readonly expansion?: IntakeExpansion
  readonly questions: readonly IntakeQuestion[]
  readonly proposals: readonly IntakeProposal[]
}

export interface IntakeAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
  readonly optionIds: readonly string[]
  readonly text: string
  readonly skipped: boolean
}

export interface IntakeResult {
  readonly topic?: string
  readonly expansion?: IntakeExpansion
  readonly answers: readonly IntakeAnswer[]
  readonly proposals: readonly IntakeProposal[]
  readonly selectedProposal?: IntakeProposal
  readonly next: 'plan'
}

/** A typed validation failure the tool projects as `invalid_parameters`. */
export class IntakeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IntakeError'
  }
}

const MAX_QUESTIONS = 3
const MAX_OPTIONS = 5
const MAX_PROPOSALS = 4
const MAX_TEXT = 800

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function clean(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed.slice(0, max)
}

function stringList(value: unknown, max = 8): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => clean(entry, 300))
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, max)
}

function normalizeOptions(raw: unknown, questionId: string): IntakeOption[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const options: IntakeOption[] = []
  raw.forEach((candidate, index) => {
    const record = asRecord(candidate)
    const label = typeof candidate === 'string' ? clean(candidate, 120) : clean(record?.label, 120)
    if (label === undefined || seen.has(label)) return
    seen.add(label)
    const description = typeof candidate === 'string' ? undefined : clean(record?.description, 300)
    options.push({
      id: `${questionId}:o${index + 1}`,
      label,
      ...(description === undefined ? {} : { description }),
    })
  })
  return options.slice(0, MAX_OPTIONS)
}

function normalizeQuestion(raw: unknown, index: number): IntakeQuestion {
  const record = asRecord(raw)
  const question = clean(record?.question, 300)
  if (question === undefined) throw new IntakeError(`questions[${index}].question is required`)
  const id = clean(record?.id, 60) ?? `q${index + 1}`
  const options = normalizeOptions(record?.options, id)
  if (options.length < 2) throw new IntakeError(`questions[${index}] needs at least two options`)
  const header = clean(record?.header, 60)
  const detail = clean(record?.detail, 1000)
  const kind = record?.kind
  return {
    id,
    question,
    options,
    multiSelect: record?.multiSelect === true,
    kind: kind === 'decision' || kind === 'confirmation' ? kind : 'clarification',
    ...(header === undefined ? {} : { header }),
    ...(detail === undefined ? {} : { detail }),
  }
}

function normalizeProposal(raw: unknown, index: number): IntakeProposal {
  const record = asRecord(raw)
  const title = clean(record?.title, 120)
  if (title === undefined) throw new IntakeError(`proposals[${index}].title is required`)
  const summary = clean(record?.summary, 400)
  const tradeoffs = clean(record?.tradeoffs, 400)
  return {
    id: clean(record?.id, 60) ?? `p${index + 1}`,
    title,
    recommended: record?.recommended === true,
    ...(summary === undefined ? {} : { summary }),
    ...(tradeoffs === undefined ? {} : { tradeoffs }),
  }
}

function normalizeExpansion(raw: unknown): IntakeExpansion | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const goal = clean(record.goal, 500)
  const summary = clean(record.summary, 1000)
  const assumptions = stringList(record.assumptions)
  const unknowns = stringList(record.unknowns)
  if (goal === undefined && summary === undefined && assumptions.length === 0 && unknowns.length === 0) return undefined
  return {
    assumptions,
    unknowns,
    ...(goal === undefined ? {} : { goal }),
    ...(summary === undefined ? {} : { summary }),
  }
}

/** Turn the model's intake request into bounded, stable popup data. */
export function normalizeIntake(input: unknown): NormalizedIntake {
  const record = asRecord(input) ?? {}
  const rawQuestions = Array.isArray(record.questions)
    ? record.questions
    : record.question === undefined ? [] : [{ question: record.question, options: record.options }]
  if (rawQuestions.length === 0) throw new IntakeError('at least one question is required')
  if (rawQuestions.length > MAX_QUESTIONS) throw new IntakeError(`at most ${MAX_QUESTIONS} questions are allowed`)
  const questions = rawQuestions.map(normalizeQuestion)
  const ids = new Set<string>()
  for (const question of questions) {
    if (ids.has(question.id)) throw new IntakeError(`duplicate question id ${question.id}`)
    ids.add(question.id)
  }

  const rawProposals = Array.isArray(record.proposals) ? record.proposals : []
  let proposals = rawProposals.map(normalizeProposal)
  if (proposals.length > MAX_PROPOSALS) proposals = proposals.slice(0, MAX_PROPOSALS)
  if (proposals.length === 1) throw new IntakeError('proposals need at least two approaches')

  const expansion = normalizeExpansion(record.expansion)
  const expansionApproaches = asRecord(record.expansion)?.approaches
  if (proposals.length === 0 && Array.isArray(expansionApproaches)) {
    proposals = expansionApproaches.map(normalizeProposal).slice(0, MAX_PROPOSALS)
    if (proposals.length === 1) throw new IntakeError('proposals need at least two approaches')
  }

  if (proposals.length >= 2) {
    if (questions.length >= MAX_QUESTIONS) throw new IntakeError('proposals need room for a decision question; use at most two questions')
    if (questions.some((question) => question.id === 'proposal')) {
      throw new IntakeError('question id proposal is reserved for the generated decision question')
    }
    const ordered = [...proposals].sort((a, b) => Number(b.recommended) - Number(a.recommended))
    if (new Set(ordered.map((proposal) => proposal.title)).size !== ordered.length) {
      throw new IntakeError('proposal titles must be unique')
    }
    proposals = ordered
    const options: IntakeOption[] = ordered.map((proposal, index) => ({
      id: `proposal:o${index + 1}`,
      label: proposal.title,
      ...(proposal.summary === undefined && proposal.tradeoffs === undefined
        ? {}
        : { description: [proposal.summary, proposal.tradeoffs].filter(Boolean).join(' — ').slice(0, 300) }),
    }))
    const detail = [expansion?.summary, expansion === undefined ? undefined : expansionText(expansion)]
      .filter(Boolean)
      .join('\n')
    questions.push({
      id: 'proposal',
      header: '方案选择 / Approach',
      question: '选择一个方案方向 / Choose an approach',
      ...(detail.length === 0 ? {} : { detail }),
      options,
      multiSelect: false,
      kind: 'decision',
    })
  }

  const topic = clean(record.topic, 300)
  return {
    questions,
    proposals,
    ...(topic === undefined ? {} : { topic }),
    ...(expansion === undefined ? {} : { expansion }),
  }
}

export function expansionText(expansion: IntakeExpansion): string {
  const lines: string[] = []
  if (expansion.goal !== undefined) lines.push(`Goal: ${expansion.goal}`)
  if (expansion.assumptions.length > 0) lines.push(`Assumptions: ${expansion.assumptions.join('; ')}`)
  if (expansion.unknowns.length > 0) lines.push(`Open questions: ${expansion.unknowns.join('; ')}`)
  return lines.join('\n')
}

/** DSH-native popup shape; ids stay equal to the AMP question ids. */
export function popupQuestions(intake: NormalizedIntake): readonly Record<string, unknown>[] {
  return intake.questions.map((question) => ({
    id: question.id,
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.detail === undefined ? {} : { detail: question.detail }),
    options: question.options.map((option) => ({
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
    ...(question.multiSelect ? { multiSelect: true } : {}),
  }))
}

/** Project the DSH answer payload back onto the normalized intake. */
export function mapAnswers(intake: NormalizedIntake, raw: unknown): IntakeAnswer[] {
  const record = asRecord(raw)
  const rows = Array.isArray(record?.answers) ? record.answers : []
  const byId = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const item = asRecord(row)
    if (item !== undefined && typeof item.id === 'string') byId.set(item.id, item)
  }
  return intake.questions.map((question) => {
    const item = byId.get(question.id)
    const offered = new Map(question.options.map((option) => [option.label, option.id]))
    const selected: string[] = []
    if (Array.isArray(item?.selected)) {
      for (const label of item.selected) {
        if (typeof label !== 'string' || !offered.has(label) || selected.includes(label)) continue
        selected.push(label)
      }
    }
    const custom = clean(item?.custom, 1000)
    const optionIds = selected.map((label) => offered.get(label)!).filter(Boolean)
    const text = [selected.join('; '), custom].filter((part): part is string => part !== undefined && part.length > 0).join(' — ')
    return {
      id: question.id,
      selected,
      optionIds,
      text,
      skipped: text.length === 0,
      ...(custom === undefined ? {} : { custom }),
    }
  })
}
