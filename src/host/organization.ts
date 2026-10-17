/**
 * Organization process (v23 §9.6): the deterministic bridge from a
 * Comprehension to a Plan.
 *
 * The pipeline calls `organize` exactly once per turn, after comprehension
 * finished. Every plan field is composed from the comprehension text, so the
 * same comprehension always yields the same plan; no model call is made,
 * because a model-composed plan would be non-deterministic and would leave no
 * auditable trail inside the trace.
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
import type { Interaction } from '../shared/enum.js'
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

/** The knobs composition needs from configuration; keeps the function pure. */
export interface OrganizationOptions {
  interaction: Interaction
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

  const goal = composeGoal(intent, requirement)
  const approach = composeApproach(options.interaction)
  const step = orchestration
    ? JSON.stringify(
        composeSubtaskDrafts({
          intent,
          requirement,
          ambiguity,
          constraint,
          maxSubtask: options.maxSubtask,
          groundTruth: options.groundTruth,
        }),
      )
    : JSON.stringify(composeSteps({ intent, requirement, ambiguity }))

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
    steps.push({
      step: `Resolve the open ambiguity: ${input.ambiguity}`,
      acceptance: 'every ambiguity item is answered or explicitly accepted',
    })
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
    drafts.push({
      task: `Resolve the open ambiguity: ${input.ambiguity}`,
      acceptance: 'every ambiguity item is answered or explicitly accepted',
      profession: 'outcome',
    })
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
    const turn = mapTurn(this.host.db.require<Row>('turn', comprehension.turn, 'turn'))
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
