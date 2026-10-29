/**
 * AMP v0.1 — planning objects: `goal` and `plan`.
 *
 * "Process answers 'how does the world work'; Plan answers 'what will I do'."
 * The rule that makes a plan auditable rather than a wish list: **every task
 * carries an `expect`** (the observation that shows it worked), and a goal
 * carries at least one observable success criterion. Both are checked here, not
 * assumed by the emitter.
 *
 * Ported from `attention-manifest-protocol/src/goal/plan.ts`. `Process` is not
 * ported: this plugin has no process authoring surface.
 */
import type { Budget, Confidence, Criterion, Id, Ref, Timestamp } from './types.js'
import { BudgetDimensions } from './types.js'
import { isId } from './ids.js'
import { BoundaryRejection } from './errors.js'

export interface Goal {
  amp: '0.1'
  kind: 'goal'
  id: Id
  statement: string
  /** At least one observable success criterion. A goal without one is a wish. */
  success: Criterion[]
  value: Confidence
  priority: number
  deadline?: Timestamp
  horizon?: 'task' | 'session' | 'long'
}

/** An observable success / abandonment condition; `check` must be executable. */
export interface Expectation {
  observation: string
  check: string
}

export interface PlanTask {
  id: Id
  intent: string
  actor: 'self' | 'tool' | 'other'
  ref?: Ref
  pre: string[]
  /** Mandatory: a task without an expected observation cannot be monitored. */
  expect: Expectation
  /** 0 = free to undo · 3 = irreversible. Drives the minimum required tier. */
  irreversibility: 0 | 1 | 2 | 3
  budget?: Budget
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
}

export interface MonitorTrigger {
  when: string
  action: 'retry' | 'adjust' | 'recompose' | 'replan' | 'abandon'
}

export interface PlanMonitor {
  triggers?: MonitorTrigger[]
}

export interface Plan {
  amp: '0.1'
  kind: 'plan'
  id: Id
  goal: Ref
  process?: Ref
  tasks: PlanTask[]
  edges: Array<[string, string]>
  /** How many steps to run before deliberating again. */
  commitment_window: number
  budget: Budget
  abandon_if: Criterion[]
  monitor?: PlanMonitor
  rollback?: string
  warrant?: Ref
  status: 'draft' | 'committed' | 'executing' | 'done' | 'abandoned'
  created: Timestamp
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const checkBudget = (value: unknown, at: string, problems: string[]): void => {
  if (!isRecord(value)) {
    problems.push(`${at} must be an object`)
    return
  }
  for (const key of Object.keys(value)) {
    const amount = value[key]
    if (!(BudgetDimensions as readonly string[]).includes(key)) {
      problems.push(`${at}.${key} is not a budget dimension`)
      continue
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      problems.push(`${at}.${key} must be a non-negative finite number`)
    }
  }
}

const checkCriterion = (value: unknown, at: string, problems: string[]): void => {
  if (!isRecord(value)) {
    problems.push(`${at} must be a criterion object`)
    return
  }
  if (!isId(value.id)) problems.push(`${at}.id is not a valid AMP id`)
  if (typeof value.statement !== 'string' || value.statement.trim().length === 0) {
    problems.push(`${at}.statement is empty`)
  }
  if (typeof value.check !== 'string' || value.check.trim().length === 0) {
    problems.push(`${at}.check is empty`)
  }
  if (value.kind !== undefined && value.kind !== 'observe' && value.kind !== 'query' && value.kind !== 'assert') {
    problems.push(`${at}.kind is not observe|query|assert`)
  }
}

/** Every problem that makes a `Goal` unstorable. */
export function validateGoal(goal: Goal): string[] {
  const problems: string[] = []
  if (goal.amp !== '0.1' || goal.kind !== 'goal') problems.push('not an AMP v0.1 goal')
  if (!isId(goal.id)) problems.push('id is not a valid AMP id')
  if (typeof goal.statement !== 'string' || goal.statement.trim().length === 0) {
    problems.push('statement is empty')
  }
  if (!Array.isArray(goal.success) || goal.success.length === 0) {
    problems.push('a goal needs at least one observable success criterion')
  } else {
    goal.success.forEach((criterion, index) => checkCriterion(criterion, `success[${index}]`, problems))
  }
  if (typeof goal.value !== 'number' || goal.value < 0 || goal.value > 1) {
    problems.push('value must be in [0,1]')
  }
  if (typeof goal.priority !== 'number' || !Number.isFinite(goal.priority)) {
    problems.push('priority must be a finite number')
  }
  if (goal.deadline !== undefined && (typeof goal.deadline !== 'string' || Number.isNaN(Date.parse(goal.deadline)))) {
    problems.push('deadline is not a date-time')
  }
  if (goal.horizon !== undefined && goal.horizon !== 'task' && goal.horizon !== 'session' && goal.horizon !== 'long') {
    problems.push('horizon is not task|session|long')
  }
  return problems
}

/** Every problem that makes a `Plan` unstorable. */
export function validatePlan(plan: Plan): string[] {
  const problems: string[] = []
  if (plan.amp !== '0.1' || plan.kind !== 'plan') problems.push('not an AMP v0.1 plan')
  if (!isId(plan.id)) problems.push('id is not a valid AMP id')
  if (plan.goal === undefined || typeof plan.goal !== 'object' || !isId(plan.goal.id)) {
    problems.push('goal must be a Ref with a valid id')
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    problems.push('plan requires at least one task')
  } else {
    const ids = new Set<string>()
    plan.tasks.forEach((task, index) => {
      const at = `tasks[${index}]`
      if (!isId(task.id)) problems.push(`${at}.id is not a valid AMP id`)
      if (ids.has(task.id)) problems.push(`${at}.id is duplicated`)
      ids.add(task.id)
      if (typeof task.intent !== 'string' || task.intent.trim().length === 0) {
        problems.push(`${at}.intent is empty`)
      }
      if (task.actor !== 'self' && task.actor !== 'tool' && task.actor !== 'other') {
        problems.push(`${at}.actor is not self|tool|other`)
      }
      if (!Array.isArray(task.pre)) {
        problems.push(`${at}.pre must be an array`)
      }
      // The rule that makes the plan monitorable.
      if (!isRecord(task.expect) || typeof task.expect.observation !== 'string' || task.expect.observation.trim().length === 0) {
        problems.push(`${at} lacks an expected observation`)
      } else if (typeof task.expect.check !== 'string' || task.expect.check.trim().length === 0) {
        problems.push(`${at}.expect.check is empty`)
      }
      if (![0, 1, 2, 3].includes(task.irreversibility)) {
        problems.push(`${at}.irreversibility must be 0..3`)
      }
      if (task.budget !== undefined) checkBudget(task.budget, `${at}.budget`, problems)
      if (!['pending', 'running', 'done', 'failed', 'skipped'].includes(task.status)) {
        problems.push(`${at}.status is not a task status`)
      }
    })
  }
  if (!Array.isArray(plan.edges)) {
    problems.push('edges must be an array')
  } else {
    for (const edge of plan.edges) {
      if (!Array.isArray(edge) || edge.length !== 2 || typeof edge[0] !== 'string' || typeof edge[1] !== 'string') {
        problems.push('every edge must be a [from, to] pair')
      }
    }
  }
  if (!Number.isInteger(plan.commitment_window) || plan.commitment_window < 1) {
    problems.push('commitment_window must be a positive integer')
  }
  checkBudget(plan.budget, 'budget', problems)
  if (!Array.isArray(plan.abandon_if) || plan.abandon_if.length === 0) {
    problems.push('plan requires abandon_if')
  } else {
    plan.abandon_if.forEach((criterion, index) => checkCriterion(criterion, `abandon_if[${index}]`, problems))
  }
  if (!['draft', 'committed', 'executing', 'done', 'abandoned'].includes(plan.status)) {
    problems.push('status is not a plan status')
  }
  if (typeof plan.created !== 'string' || Number.isNaN(Date.parse(plan.created))) {
    problems.push('created is not a date-time')
  }
  return problems
}

/** Throws `BoundaryRejection` with every problem when the goal is malformed. */
export function assertGoal(goal: Goal): Goal {
  const problems = validateGoal(goal)
  if (problems.length > 0) throw new BoundaryRejection('invalid_tool_args', problems)
  return goal
}

/** Throws `BoundaryRejection` with every problem when the plan is malformed. */
export function assertPlan(plan: Plan): Plan {
  const problems = validatePlan(plan)
  if (problems.length > 0) throw new BoundaryRejection('invalid_tool_args', problems)
  return plan
}
