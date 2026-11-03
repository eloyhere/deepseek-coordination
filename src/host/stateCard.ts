/**
 * The per-session state card: a compact, durable summary of what matters now.
 *
 * Compaction rewrites chat history; it does not touch this plugin's records. The
 * card is therefore rebuilt from durable AMP rows on every step, which is what
 * makes it survive compaction — the history may lose the tool calls that created
 * a plan, but the card still names the plan and its next task.
 *
 * It is deliberately small (a handful of ids and one next action) and is carried
 * twice: as the last field of the per-turn AMP block (`stateCard`), so it is the
 * freshest thing the model reads, and via `GET /amp/state-card` for the host and
 * the operator.
 */
import type { Duty } from './ampCollaboration.js'
import type { AmpPlanning } from './ampPlanning.js'

export type PlanningView = ReturnType<AmpPlanning['view']>

/** One open duty as the card reports it (id/status/role only). */
export interface StateCardDuty {
  readonly id: string
  readonly status: string
  readonly role: string
}

/** The active plan task the model should act on next. */
export interface StateCardTask {
  readonly id: string
  readonly status: string
  readonly intent: string
}

/** The plan projection carried by the card. */
export interface StateCardPlan {
  readonly id: string
  readonly status: string
  readonly done: number
  readonly total: number
  readonly next?: StateCardTask
}

/** Compact state carried across compaction boundaries. */
export interface StateCard {
  readonly session: string
  /** Goal statement the session is working toward, when one is active. */
  readonly objective?: string
  readonly duties?: {
    readonly open: number
    readonly items: readonly StateCardDuty[]
  }
  readonly plan?: StateCardPlan
  /** One imperative sentence; absent when nothing is actionable. */
  readonly next?: string
  /** Effective interaction/scenario constraints, when known. */
  readonly constraints: readonly string[]
  /** True: the card is derived from durable records on every step. */
  readonly durable: true
}

/** Structural service subset the card needs; every piece is optional. */
export interface StateCardSource {
  readonly collaboration?: Pick<import('./ampCollaboration.js').AmpCollaboration, 'view'>
  readonly planning?: Pick<AmpPlanning, 'view'>
  readonly contextDigest?: (session: string) => {
    knowledge?: readonly string[]
    interaction?: string
    scenario?: string
  } | undefined
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`
}

/** Open duties relevant to this session, in a stable order. */
function openDuties(duties: readonly Duty[], session: string): Duty[] {
  return duties
    .filter((duty) => duty.ownerSession === session || duty.assigneeSession === session)
    .filter((duty) => duty.status !== 'verified' && duty.status !== 'cancelled')
    .sort((left, right) => left.id.localeCompare(right.id))
}

/** Build a card from already-fetched records; `undefined` when nothing is worth carrying. */
export function buildStateCard(input: {
  session: string
  duties: readonly Duty[]
  planning?: PlanningView
  digest?: { interaction?: string; scenario?: string }
}): StateCard | undefined {
  const duties = openDuties(input.duties, input.session)
  const missions = input.planning?.missions ?? []
  const goals = input.planning?.goals ?? []
  const plans = input.planning?.plans ?? []

  const activeMission = missions.find((mission) => mission.session === input.session && mission.status === 'active')
  const activeGoal = activeMission === undefined
    ? goals.find((entry) => entry.state === 'active')
    : goals.find((entry) => entry.goal.id === activeMission.goal)
  const objective = activeGoal === undefined ? undefined : clip(activeGoal.goal.statement, 160)

  const plan = plans.find((entry) => entry.status === 'executing') ?? plans.find((entry) => entry.status === 'committed')
  let planCard: StateCardPlan | undefined
  let next: string | undefined
  if (plan !== undefined) {
    const tasks = plan.tasks
    const done = tasks.filter((task) => task.status === 'done').length
    const candidate = tasks.find((task) => task.status === 'running') ?? tasks.find((task) => task.status === 'pending')
    planCard = {
      id: plan.id,
      status: plan.status,
      done,
      total: tasks.length,
      ...(candidate === undefined ? {} : { next: { id: candidate.id, status: candidate.status, intent: clip(candidate.intent, 120) } }),
    }
    if (candidate !== undefined) next = `Run task ${candidate.id}: ${clip(candidate.intent, 90)}`
  }

  if (next === undefined) {
    const submitted = duties.find((duty) => duty.ownerSession === input.session && duty.status === 'submitted')
    const other = duties[0]
    if (submitted !== undefined) next = `Review duty ${submitted.id}`
    else if (other !== undefined) next = `Advance duty ${other.id} (${other.status})`
    else if (activeMission !== undefined) next = `Continue mission ${activeMission.id}`
    else if (activeGoal !== undefined) next = `Advance goal ${activeGoal.goal.id}`
  }

  const constraints: string[] = []
  if (input.digest?.interaction !== undefined) constraints.push(`interaction=${input.digest.interaction}`)
  if (input.digest?.scenario !== undefined) constraints.push(`scenario=${input.digest.scenario}`)

  if (objective === undefined && planCard === undefined && duties.length === 0 && constraints.length === 0) {
    return undefined
  }
  return {
    session: input.session,
    ...(objective === undefined ? {} : { objective }),
    ...(duties.length === 0
      ? {}
      : {
          duties: {
            open: duties.length,
            items: duties.slice(0, 3).map((duty) => ({ id: duty.id, status: duty.status, role: duty.role })),
          },
        }),
    ...(planCard === undefined ? {} : { plan: planCard }),
    ...(next === undefined ? {} : { next }),
    constraints,
    durable: true,
  }
}

/** Fetch the records the card needs and build it; every backend is optional. */
export function stateCardOf(source: StateCardSource, session: string): StateCard | undefined {
  if (session.trim().length === 0) return undefined
  const duties = source.collaboration?.view(session) ?? []
  const planning = source.planning?.view(session)
  const digest = source.contextDigest?.(session)
  return buildStateCard({
    session,
    duties,
    ...(planning === undefined ? {} : { planning }),
    ...(digest === undefined ? {} : { digest }),
  })
}
