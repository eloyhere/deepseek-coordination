/** AMP goal, plan, task and action verbs. */
import { AMP_PREFIX } from '../names.js'
import type { AmpHost } from '../amp.js'
import { agentOf, entityId, failure, objectArg, ok, page, sessionOf } from './shared.js'
import type { HandlerMap, Params } from './shared.js'

function key(module: string, verb: string): string {
  return `${AMP_PREFIX}_${module}.${verb}`
}

function serviceOf(host: AmpHost, name: 'goal' | 'plan' | 'task' | 'action'): {
  get(id: string): unknown
  list(sessionId?: string): unknown[]
} {
  return host.kernel().ports.services[name] as never
}

function defaultsBounds(host: AmpHost): Record<string, unknown> {
  return {
    maxAttempts: 3,
    deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    progressMetric: 'tasks',
    deadLetterOwner: `${host.config.tenantId}:host`,
  }
}

export function planningHandlers(host: AmpHost): HandlerMap {
  return {
    [key('goal', 'get')]: (parameters: Params) => {
      const id = entityId(parameters)
      if (id === undefined) return failure('invalid_parameters', 'id is required')
      try {
        return ok(serviceOf(host, 'goal').get(id))
      } catch {
        return failure('not_found', `goal ${id} was not found`)
      }
    },

    [key('goal', 'list')]: (parameters: Params) => {
      const sessionId = entityId(parameters, 'sessionId') ?? sessionOf(host)
      return ok(page(serviceOf(host, 'goal').list(sessionId), parameters))
    },

    [key('goal', 'submit_evidence')]: async (parameters: Params) => {
      const goalId = entityId(parameters, 'goalId') ?? entityId(parameters)
      if (goalId === undefined) return failure('invalid_parameters', 'goalId is required')
      const evidence = parameters.evidence ?? parameters.claim ?? parameters.notes
      const sessionId = sessionOf(host)
      const notes = host.notes.get(sessionId) ?? []
      notes.push({ kind: 'goal-evidence', goalId, evidence, at: new Date().toISOString() })
      host.notes.set(sessionId, notes.slice(-100))
      let feedback: unknown = null
      try {
        feedback = await host.bridge?.feedback(
          agentOf(host),
          `AMP goal ${goalId} evidence: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`,
          'task-result',
        )
      } catch {
        feedback = null
      }
      return ok({ submitted: true, goalId, evidence: evidence ?? null, verified: false, feedback })
    },

    [key('plan', 'get')]: (parameters: Params) => {
      const id = entityId(parameters)
      if (id === undefined) return failure('invalid_parameters', 'id is required')
      try {
        return ok(serviceOf(host, 'plan').get(id))
      } catch {
        return failure('not_found', `plan ${id} was not found`)
      }
    },

    [key('plan', 'list')]: (parameters: Params) => {
      const sessionId = entityId(parameters, 'sessionId') ?? sessionOf(host)
      return ok(page(serviceOf(host, 'plan').list(sessionId), parameters))
    },

    [key('plan', 'ready_tasks')]: (parameters: Params) => {
      const planId = entityId(parameters, 'planId') ?? entityId(parameters)
      if (planId === undefined) return failure('invalid_parameters', 'planId is required')
      try {
        return ok(host.kernel().flow.readyTasks({ planId, actor: 'dsh-model' }))
      } catch (error) {
        return failure('invalid_state', error instanceof Error ? error.message : String(error))
      }
    },

    [key('plan', 'propose_draft')]: async (parameters: Params) => {
      try {
        const sessionId = sessionOf(host)
        const objective = typeof parameters.objective === 'string' ? parameters.objective.trim() : ''
        const tasksRaw = Array.isArray(parameters.tasks) ? parameters.tasks : []
        if (tasksRaw.length === 0) return failure('invalid_parameters', 'at least one task is required')
        const turn = host.currentTurn(sessionId) ?? 0
        host.ensureSession(sessionId)
        const turnId = host.ensureTurn(sessionId, turn)

        let goalId = entityId(parameters, 'goalId')
        let missionId: string | undefined
        if (goalId === undefined) {
          if (objective.length === 0) return failure('invalid_parameters', 'goalId or objective is required')
          const suffix = `${turn}-${Date.now().toString(36)}`
          const intentId = `intent:${sessionId}:${suffix}`
          host.kernel().flow.captureIntent({ intentId, turnId, text: objective, actor: 'dsh-model' })
          host.kernel().flow.confirmIntent({ intentId, actor: 'dsh-model' })
          missionId = `mission:${sessionId}:${suffix}`
          host.kernel().flow.createMission({ missionId, intentId, actor: 'dsh-model' })
          goalId = `goal:${sessionId}:${suffix}`
          const criteria = tasksRaw
            .map((raw) => objectArg(raw, 'tasks[]'))
            .map((task, index) => String(task.acceptance ?? task.expect ?? `task ${index + 1} completes`))
          host.kernel().flow.createGoal({
            goalId,
            missionId,
            contractVersion: typeof parameters.contractVersion === 'string' ? parameters.contractVersion : 'dsh-1',
            acceptanceCriteria: criteria,
            actor: 'dsh-model',
          })
        }

        const planId = entityId(parameters, 'planId') ?? `plan:${sessionId}:${Date.now().toString(36)}`
        const bounds = parameters.bounds === undefined
          ? defaultsBounds(host)
          : objectArg(parameters.bounds, 'bounds')
        const tasks = tasksRaw.map((raw, index) => {
          const task = objectArg(raw, `tasks[${index}]`)
          return {
            taskId: typeof task.taskId === 'string' ? task.taskId : `task:${planId}:${index + 1}`,
            ...(Array.isArray(task.dependsOn) ? { dependsOn: task.dependsOn.filter((id): id is string => typeof id === 'string') } : {}),
            ...(task.required === false ? { required: false } : {}),
          }
        })
        const result = host.kernel().flow.createPlan({
          planId,
          goalId,
          bounds: bounds as never,
          tasks,
          actor: 'dsh-model',
        })
        const drafted = tasksRaw.map((raw, index) => {
          const task = objectArg(raw, `tasks[${index}]`)
          return {
            intent: String(task.intent ?? task.text ?? `task ${index + 1}`),
            acceptance: String(task.acceptance ?? task.expect ?? ''),
          }
        })
        let mirrored: unknown = null
        try {
          mirrored = await host.bridge?.planFromDraft(agentOf(host), drafted)
        } catch {
          mirrored = null
        }
        return ok({ ...result, goalId, missionId: missionId ?? null, draft: true, mirrored })
      } catch (error) {
        return failure('invalid_state', error instanceof Error ? error.message : String(error))
      }
    },

    [key('task', 'get')]: (parameters: Params) => {
      const id = entityId(parameters)
      if (id === undefined) return failure('invalid_parameters', 'id is required')
      try {
        return ok(serviceOf(host, 'task').get(id))
      } catch {
        return failure('not_found', `task ${id} was not found`)
      }
    },

    [key('task', 'list_ready')]: (parameters: Params) => {
      const planId = entityId(parameters, 'planId')
      if (planId !== undefined) {
        try {
          return ok(host.kernel().flow.readyTasks({ planId, actor: 'dsh-model' }))
        } catch (error) {
          return failure('invalid_state', error instanceof Error ? error.message : String(error))
        }
      }
      const sessionId = sessionOf(host)
      return ok(page(serviceOf(host, 'task').list(sessionId), parameters))
    },

    [key('task', 'report_progress')]: (parameters: Params) => {
      const taskId = entityId(parameters, 'taskId') ?? entityId(parameters)
      if (taskId === undefined) return failure('invalid_parameters', 'taskId is required')
      const sessionId = sessionOf(host)
      const notes = host.notes.get(sessionId) ?? []
      notes.push({ kind: 'task-progress', taskId, progress: parameters.progress ?? parameters.message ?? null, at: new Date().toISOString() })
      host.notes.set(sessionId, notes.slice(-100))
      return ok({ reported: true, taskId })
    },

    [key('action', 'get')]: (parameters: Params) => {
      const id = entityId(parameters)
      if (id === undefined) return failure('invalid_parameters', 'id is required')
      try {
        return ok(serviceOf(host, 'action').get(id))
      } catch {
        return failure('not_found', `action ${id} was not found`)
      }
    },

    [key('action', 'list')]: (parameters: Params) => {
      const sessionId = entityId(parameters, 'sessionId') ?? sessionOf(host)
      return ok(page(serviceOf(host, 'action').list(sessionId), parameters))
    },
  }
}


