/**
 * Organization process (v23 §9.6 + v24 writing scene): the deterministic
 * bridge from a Comprehension to a Plan.
 *
 * The pipeline calls `organize` exactly once per turn, after comprehension
 * finished. Every plan field is composed from the comprehension text, so the
 * same comprehension always yields the same plan; no model call is made,
 * because a model-composed plan would be non-deterministic and would leave no
 * auditable trail inside the trace.
 *
 * v24 delta: the `writing` scene (between `dialogue` and `office`) always
 * composes the 大纲 → 草稿 → 修订 sequence — an outline step, a draft step, then
 * a revision step — for both the flat step array and the orchestration drafts.
 * The shared `Scene` union and configuration schema do not carry `writing`
 * yet, so `organize` reads the persisted scene string from the turn row and
 * narrows it through `readOrganizationScene`; the plan scorer applies the
 * scene's 0.6 pass threshold from `plan.ts`.
 *
 * `plan.step` is always a JSON string (v23 §9.2). The accepted shapes are:
 *
 * - `orchestrate` interaction: a JSON array of subtask drafts
 *   `{ task, acceptance, groundTruth?, profession, model?, tools?, context?,
 *   blockedBy? }`. Every draft carries a non-empty acceptance string and one
 *   of the three draft professions (`execution` | `outcome` | `decision`).
 *   `tools`, `model`, `context`, `groundTruth` and `blockedBy` stay optional:
 *   the orchestrator fills them when it expands a draft into a `subtask` row.
 * - every other interaction: a JSON array of `{ step, acceptance? }` objects.
 *   `decodePlanStep` in `plan.ts` also accepts `{ steps: [...] }`, but
 *   `organize` always emits the flat array form.
 *
 * The organization row and the plan row are written in one transaction. The
 * plan row is inserted first because `organization.plan` is a `NOT NULL`
 * foreign key: the pointer cannot be known before the plan exists. The turn
 * then points at both rows, so a half-finished organization is impossible.
 */
import type { ModuleHost } from './module.js'
import type { Comprehension, Organization, Plan } from '../shared/entity.js'
import type { Interaction, Scene } from '../shared/enum.js'
import { InvalidStateError } from '../shared/error.js'
import { mapComprehension, mapPlan, mapTurn } from './row.js'
import type { Row } from './row.js'
import { number, text } from './row.js'

/** The professions an orchestrated subtask draft may bind (v23 §9.6). */
export type SubtaskDraftProfession = 'execution' | 'outcome' | 'decision'

export const SubtaskDraftProfessions: readonly SubtaskDraftProfession[] = [
  'execution',
  'outcome',
  'decision',
]

/** One `{ step, acceptance? }` entry of a non-orchestration plan. */
export interface PlanStepDraft {
  step: string
  acceptance?: string
}

/** One subtask draft of an orchestration plan; `acceptance` is mandatory. */
export interface PlanSubtaskDraft {
  task: string
  acceptance: string
  groundTruth?: string
  profession: SubtaskDraftProfession
  model?: string
  tools?: string[]
  context?: string
  blockedBy?: number[]
}

/** Every shape `plan.step` may carry; the column stores it as a JSON string. */
export type PlanStepShape = PlanStepDraft[] | { steps: PlanStepDraft[] }

/**
 * v24 delta: `writing` joins the shared scene union between `dialogue` and
 * `office`. Until `src/shared/enum.ts` learns the value, this local union keeps
 * the module honest; it collapses to `Scene` once the shared type is updated.
 */
export type OrganizationScene = Scene | 'writing'

/** The three writing stages, in their mandated order: 大纲 → 草稿 → 修订. */
export const WritingStages = ['outline', 'draft', 'revision'] as const

export type WritingStage = (typeof WritingStages)[number]

/**
 * The literal marker each writing stage step or subtask draft starts with, so
 * the pipeline, the UI and the tests can recognise the stage without parsing
 * prose. The Chinese term is the design-document name of the stage.
 */
export const WritingStageMarkers: Readonly<Record<WritingStage, string>> = {
  outline: 'Outline (大纲)',
  draft: 'Draft (草稿)',
  revision: 'Revision (修订)',
}

/** The knobs composition needs from configuration; keeps the function pure. */
export interface OrganizationOptions {
  interaction: Interaction
  scene: OrganizationScene
  maxSubtask: number
  groundTruth: boolean
}

/** The five plan texts plus the orchestration flag, before persistence. */
export interface OrganizationFields {
  goal: string
  approach: string
  step: string
  constraint: string
  assumption: string
  orchestration: boolean
}

/**
 * One deterministic approach sentence per interaction. The interaction picks
 * the reasoning shape; the constraint sentence below is shared by all of them.
 */
const ApproachByInteraction: Readonly<Record<Interaction, string>> = {
  emotion: 'Listen first, name the feeling, then answer the practical need in one short pass.',
  think: 'Break the question into facts and inferences, weigh the options, then answer with the reasoning shown.',
  heuristic: 'Rank the success routes by evidence, take the highest-probability route, then answer with its trade-offs.',
  converge: 'Rank the failure routes by evidence, define the boundary that must not be crossed, then answer inside it.',
  orchestrate:
    'Split the goal into independently verifiable subtasks, dispatch each under its locked profession, verify every acceptance, then synthesise one answer.',
}

/** Stated when the comprehension left the constraint empty. */
const DefaultConstraint = 'No explicit constraint was stated; the stated requirement is the only boundary.'

/** Stated when the comprehension left the assumption empty. */
const DefaultAssumption = 'The request as written is accurate and complete.'

/** Map one `organization` row; `row.ts` has no mapper for this entity. */
export function mapOrganization(row: Row): Organization {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    comprehension: number(row, 'comprehension'),
    plan: number(row, 'plan'),
    goal: text(row, 'goal'),
    approach: text(row, 'approach'),
    step: text(row, 'step'),
    constraint: text(row, 'constraint'),
    assumption: text(row, 'assumption'),
    ...(row.model === null || row.model === undefined ? {} : { model: text(row, 'model') }),
    created: number(row, 'created'),
    ...(row.finished === null || row.finished === undefined ? {} : { finished: number(row, 'finished') }),
  }
}

/**
 * Read the persisted scene from a turn row. The v24 `writing` value is
 * recognised before the shared `Scene` union carries it, so the module reads
 * the raw column instead of comparing the narrowed `Turn.scene` field.
 */
export function readOrganizationScene(row: Row): OrganizationScene {
  const raw = text(row, 'scene', 'dialogue')
  return raw === 'writing' ? 'writing' : (raw as Scene)
}

/**
 * Compose the goal, approach, constraint, assumption and step of one plan from
 * the comprehension. Pure: no host, no clock, no database.
 */
export function composeOrganization(
  comprehension: Comprehension,
  options: OrganizationOptions,
): OrganizationFields {
  const intent = comprehension.intent.trim()
  const requirement = comprehension.requirement.trim()
  const ambiguity = comprehension.ambiguity.trim()
  const constraint = comprehension.constraint.trim() || DefaultConstraint
  const assumption = comprehension.assumption.trim() || DefaultAssumption
  const orchestration = options.interaction === 'orchestrate'
  const writing = options.scene === 'writing'

  const goal = composeGoal(intent, requirement)
  const approach = writing ? composeWritingApproach() : composeApproach(options.interaction)
  const step = writing
    ? JSON.stringify(
        orchestration
          ? composeWritingSubtaskDrafts({
              intent,
              requirement,
              ambiguity,
              maxSubtask: options.maxSubtask,
              groundTruth: options.groundTruth,
            })
          : composeWritingSteps({ intent, requirement, ambiguity }),
      )
    : JSON.stringify(
        orchestration
          ? composeSubtaskDrafts({
              intent,
              requirement,
              ambiguity,
              constraint,
              maxSubtask: options.maxSubtask,
              groundTruth: options.groundTruth,
            })
          : composeSteps({ intent, requirement, ambiguity }),
      )

  return { goal, approach, step, constraint, assumption, orchestration }
}

/** `intent`, then the requirement as its own sentence; never empty. */
function composeGoal(intent: string, requirement: string): string {
  if (intent === '' && requirement === '') return 'Complete the request.'
  if (requirement === '') return intent
  if (intent === '') return requirement
  return `${intent}. ${requirement}`
}

/** The interaction approach plus the shared constraint/assumption sentence. */
function composeApproach(interaction: Interaction): string {
  const base = ApproachByInteraction[interaction]
  return `${base} Every step stays inside the stated constraints, and every stated assumption is checked before execution.`
}

/**
 * v24: the writing scene always outlines, drafts, then revises. The scene picks
 * this working form; the interaction still shapes the rest of the pipeline.
 */
function composeWritingApproach(): string {
  return `Outline the structure first (大纲), write a complete draft from the outline (草稿), then revise the draft against every acceptance criterion (修订). Every step stays inside the stated constraints, and every stated assumption is checked before execution.`
}

/** Prefix comprehension uses for a broad-task finding. */
const BROAD_TASK_PREFIX = '任务描述过于宽泛（'

/**
 * The task fragments comprehension flagged as too broad.
 *
 * A broad request is a decomposition input, not a blocker to plan around: the
 * fragments between the brackets are the user's own words, so each becomes a
 * sub-task with its own acceptance check instead of one generic "resolve the
 * ambiguity" step.
 */
export function broadTaskMarkers(ambiguity: string): string[] {
  const start = ambiguity.indexOf(BROAD_TASK_PREFIX)
  if (start < 0) return []
  const close = ambiguity.indexOf('）', start)
  if (close < 0) return []
  return ambiguity
    .slice(start + BROAD_TASK_PREFIX.length, close)
    .split(' / ')
    .map((marker) => marker.trim())
    .filter((marker) => marker.length > 0)
}

/** The ambiguity text with the broad-task finding removed. */
export function ambiguityWithoutBroadTask(ambiguity: string): string {
  return ambiguity
    .split('；')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith(BROAD_TASK_PREFIX))
    .join('；')
}

function broadTaskSteps(markers: readonly string[], prefix: string): PlanStepDraft[] {
  return markers.map((marker) => ({
    step: `${prefix}: ${marker}`,
    acceptance: `"${marker}" has an observable done condition and its evidence is recorded`,
  }))
}
interface StepDraftInput {
  intent: string
  requirement: string
  ambiguity: string
}

/** Deterministic `{ step, acceptance }` array for a non-orchestration plan. */
function composeSteps(input: StepDraftInput): PlanStepDraft[] {
  const goalText = input.intent === '' ? 'the stated request' : input.intent
  const steps: PlanStepDraft[] = [
    {
      step: `Restate the goal and confirm it with the requester: ${goalText}`,
      acceptance: 'the restatement matches the stated intent',
    },
  ]
  if (input.requirement !== '') {
    steps.push({
      step: `Deliver the required outcome: ${input.requirement}`,
      acceptance: 'every stated requirement is satisfied',
    })
  }
  if (input.ambiguity !== '') {
    const markers = broadTaskMarkers(input.ambiguity)
    const restAmbiguity = ambiguityWithoutBroadTask(input.ambiguity)
    if (markers.length > 0) {
      steps.push(...broadTaskSteps(markers, 'Turn the broad request into a verifiable sub-task'))
    }
    if (restAmbiguity !== '') {
      steps.push({
        step: `Resolve the open ambiguity: ${restAmbiguity}`,
        acceptance: 'every ambiguity item is answered or explicitly accepted',
      })
    }
  }
  steps.push({
    step: 'Carry out the work inside the stated constraints',
    acceptance: 'no stated constraint is violated',
  })
  steps.push({
    step: 'Verify the result against every acceptance criterion',
    acceptance: 'every acceptance criterion passes',
  })
  steps.push({
    step: 'Report the result, the evidence, and the residual risk',
    acceptance: 'the report lists the evidence and the residual risk',
  })
  return steps
}

/**
 * v24: the writing step array always carries outline → draft → revision, in
 * that order, each with an acceptance statement. Ambiguity resolution (when
 * the comprehension flagged one) leads the array; proofreading and delivery
 * follow the mandated trio.
 */
function composeWritingSteps(input: StepDraftInput): PlanStepDraft[] {
  const goalText = input.intent === '' ? 'the stated request' : input.intent
  const deliverable = input.requirement === '' ? goalText : input.requirement
  const steps: PlanStepDraft[] = []
  if (input.ambiguity !== '') {
    const markers = broadTaskMarkers(input.ambiguity)
    const restAmbiguity = ambiguityWithoutBroadTask(input.ambiguity)
    if (markers.length > 0) {
      steps.push(...broadTaskSteps(markers, 'Turn the broad request into a verifiable sub-task before outlining'))
    }
    if (restAmbiguity !== '') {
      steps.push({
        step: `Resolve the open ambiguity before outlining: ${restAmbiguity}`,
        acceptance: 'every ambiguity item is answered or explicitly accepted',
      })
    }
  }
  steps.push(
    {
      step: `${WritingStageMarkers.outline}: list the sections of "${goalText}" and the acceptance of each section`,
      acceptance: 'the outline lists every section in order with its purpose',
    },
    {
      step: `${WritingStageMarkers.draft}: write the draft from the outline for "${deliverable}"`,
      acceptance: 'the draft covers every outline section',
    },
    {
      step: `${WritingStageMarkers.revision}: revise the draft against the stated constraints and the acceptance criteria`,
      acceptance: 'every review note and any violated constraint is resolved in the revision',
    },
  )
  steps.push({
    step: 'Proofread the revised draft against every acceptance criterion',
    acceptance: 'every acceptance criterion passes on the revised draft',
  })
  steps.push({
    step: 'Deliver the revised draft together with the revision notes and the residual risk',
    acceptance: 'the delivery contains the revised draft and its revision notes',
  })
  return steps
}

interface SubtaskDraftInput {
  intent: string
  requirement: string
  ambiguity: string
  constraint: string
  maxSubtask: number
  groundTruth: boolean
}

/**
 * Deterministic subtask drafts for an orchestration plan. Each draft binds one
 * of the three draft professions and states its acceptance; the independent
 * verification draft is last so dependency order is the array order.
 */
function composeSubtaskDrafts(input: SubtaskDraftInput): PlanSubtaskDraft[] {
  const goalText = input.intent === '' ? 'the stated request' : input.intent
  const deliverable = input.requirement === '' ? goalText : input.requirement
  const drafts: PlanSubtaskDraft[] = [
    {
      task: `Analyse the goal and fix the acceptance basis: ${goalText}`,
      acceptance: 'the analysis names every requirement, constraint, and assumption',
      profession: 'decision',
    },
    {
      task: `Produce the required outcome: ${deliverable}`,
      acceptance: 'the outcome satisfies every stated requirement',
      profession: 'outcome',
    },
    {
      task: `Execute the work inside the stated constraints: ${input.constraint}`,
      acceptance: 'no stated constraint is violated',
      profession: 'execution',
    },
  ]
  if (input.ambiguity !== '') {
    const markers = broadTaskMarkers(input.ambiguity)
    const restAmbiguity = ambiguityWithoutBroadTask(input.ambiguity)
    for (const marker of markers) {
      drafts.push({
        task: `Turn the broad request into a verifiable subtask: ${marker}`,
        acceptance: `"${marker}" has an observable done condition and its evidence is recorded`,
        profession: 'execution',
      })
    }
    if (restAmbiguity !== '') {
      drafts.push({
        task: `Resolve the open ambiguity: ${restAmbiguity}`,
        acceptance: 'every ambiguity item is answered or explicitly accepted',
        profession: 'outcome',
      })
    }
  }
  drafts.push({
    task: `Independently verify every subtask against its acceptance: ${deliverable}`,
    acceptance: 'every other subtask has a recorded pass verdict',
    profession: 'decision',
    ...(input.groundTruth ? { groundTruth: 'a pass verdict is recorded for every other subtask' } : {}),
  })
  if (drafts.length > input.maxSubtask) drafts.length = input.maxSubtask
  return drafts
}

interface WritingSubtaskDraftInput {
  intent: string
  requirement: string
  ambiguity: string
  maxSubtask: number
  groundTruth: boolean
}

/**
 * v24: the writing scene's orchestration drafts follow the same mandated
 * sequence — outline (大纲), draft (草稿), revision (修订) — with the
 * independent verification draft kept last so array order stays dispatch
 * order.
 */
function composeWritingSubtaskDrafts(input: WritingSubtaskDraftInput): PlanSubtaskDraft[] {
  const goalText = input.intent === '' ? 'the stated request' : input.intent
  const deliverable = input.requirement === '' ? goalText : input.requirement
  const drafts: PlanSubtaskDraft[] = []
  if (input.ambiguity !== '') {
    const markers = broadTaskMarkers(input.ambiguity)
    const restAmbiguity = ambiguityWithoutBroadTask(input.ambiguity)
    for (const marker of markers) {
      drafts.push({
        task: `Turn the broad request into a verifiable subtask before outlining: ${marker}`,
        acceptance: `"${marker}" has an observable done condition and its evidence is recorded`,
        profession: 'decision',
      })
    }
    if (restAmbiguity !== '') {
      drafts.push({
        task: `Resolve the open ambiguity before outlining: ${restAmbiguity}`,
        acceptance: 'every ambiguity item is answered or explicitly accepted',
        profession: 'decision',
      })
    }
  }
  drafts.push(
    {
      task: `${WritingStageMarkers.outline}: list the sections of "${goalText}" and each section's acceptance`,
      acceptance: 'the outline lists every section in order with its purpose',
      profession: 'decision',
    },
    {
      task: `${WritingStageMarkers.draft}: write the draft from the outline for "${deliverable}"`,
      acceptance: 'the draft covers every outline section',
      profession: 'outcome',
    },
    {
      task: `${WritingStageMarkers.revision}: revise the draft against the stated constraints and the acceptance criteria`,
      acceptance: 'every review note and any violated constraint is resolved in the revision',
      profession: 'execution',
    },
  )
  drafts.push({
    task: `Independently verify the revised draft against its acceptance: ${deliverable}`,
    acceptance: 'every outline and revision acceptance is recorded as passed',
    profession: 'decision',
    ...(input.groundTruth ? { groundTruth: 'a pass verdict is recorded for the revised draft' } : {}),
  })
  if (drafts.length > input.maxSubtask) drafts.length = input.maxSubtask
  return drafts
}

/**
 * Compose and persist one Organization plus its initial Plan.
 *
 * The pipeline owns the cadence: it calls `organize` once per turn, then
 * scores the returned plan. Calling it twice for the same turn is a state
 * error rather than a silent overwrite, because a second plan would orphan the
 * first score history and break the single-plan-per-turn invariant.
 */
export class OrganizationModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  organize(comprehensionIdentity: number): Plan {
    const comprehension = mapComprehension(
      this.host.db.require<Row>('comprehension', comprehensionIdentity, 'comprehension'),
    )
    const turnRow = this.host.db.require<Row>('turn', comprehension.turn, 'turn')
    const turn = mapTurn(turnRow)
    const existing = this.host.db.get<Row>(
      'SELECT identity FROM plan WHERE turn = ? ORDER BY identity ASC LIMIT 1',
      turn.identity,
    )
    if (existing !== undefined) {
      throw new InvalidStateError(
        `turn ${turn.identity} already has a plan; organization runs once per turn`,
        { turn: turn.identity, plan: number(existing, 'identity') },
      )
    }

    const composed = composeOrganization(comprehension, {
      interaction: turn.interaction,
      scene: readOrganizationScene(turnRow),
      maxSubtask: this.host.config.orchestration.maxSubTask,
      groundTruth: this.host.config.orchestration.groundTruth,
    })
    const now = this.host.clock.now()

    const planIdentity = this.host.db.transaction(() => {
      const identity = this.host.db.insert('plan', {
        handle: this.host.handles.next('plan'),
        turn: turn.identity,
        goal: composed.goal,
        approach: composed.approach,
        step: composed.step,
        constraint: composed.constraint,
        assumption: composed.assumption,
        status: 'draft',
        rebuild: 0,
        mode: 'auto',
        orchestration: composed.orchestration,
        created: now,
      })
      const organizationIdentity = this.host.db.insert('organization', {
        handle: this.host.handles.next('organization'),
        turn: turn.identity,
        comprehension: comprehensionIdentity,
        plan: identity,
        goal: composed.goal,
        approach: composed.approach,
        step: composed.step,
        constraint: composed.constraint,
        assumption: composed.assumption,
        model: comprehension.model,
        created: now,
        finished: now,
      })
      this.host.db.update(
        'turn',
        { organization: organizationIdentity, plan: identity },
        'identity = ?',
        turn.identity,
      )
      return identity
    })

    return mapPlan(this.host.db.require<Row>('plan', planIdentity, 'plan'))
  }

  get(identity: number): Organization {
    return mapOrganization(this.host.db.require<Row>('organization', identity, 'organization'))
  }

  /** The organization that produced a plan, if the plan came from one. */
  forPlan(plan: number): Organization | undefined {
    const row = this.host.db.get<Row>(
      'SELECT * FROM organization WHERE plan = ? ORDER BY identity DESC LIMIT 1',
      plan,
    )
    return row === undefined ? undefined : mapOrganization(row)
  }
}


