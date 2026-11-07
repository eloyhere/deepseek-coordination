/**
 * AMP → DSH bridge.
 *
 * The AMP surface is deliberately read-mostly, so this host exposes one native
 * harness tool and one `/amp` command family that write DSH state through the
 * harness's own command/tool paths:
 *  - goal/mission → `/goal …` (the harness owns durable goal state)
 *  - plan → `/plan` (plan mode) plus `todo_write` (the harness plan list)
 *  - feedback → `ctx.sessionFeedback.record` (durable feedback/record event)
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { asRecord, jsonSafe } from './json.js'

export interface HarnessTodo {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

export class HarnessBridge {
  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  /** Execute one human command through the harness registry. */
  async command(agent: Agent, line: string): Promise<unknown> {
    const commands = this.ctx.get('commands') as
      | { execute(agent: Agent, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<unknown> }
      | undefined
    if (commands === undefined) throw new Error('the harness command registry is unavailable')
    return commands.execute(agent, line, [], new AbortController().signal)
  }

  /** Create/edit/pause/resume/complete/clear the session goal. */
  async goal(agent: Agent, action: string, text?: string): Promise<unknown> {
    const objective = text?.trim()
    switch (action) {
      case 'create':
      case 'edit':
        if (objective === undefined || objective.length === 0) throw new Error('goal text is required')
        return this.command(agent, action === 'edit' ? `/goal edit ${objective}` : `/goal ${objective}`)
      case 'pause':
        return this.command(agent, '/goal pause')
      case 'resume':
        return this.command(agent, '/goal resume')
      case 'clear':
        return this.command(agent, '/goal clear')
      default:
        throw new Error(`unknown goal action "${action}"`)
    }
  }

  /** Mission is the strategic objective; DSH records it as the current goal. */
  async mission(agent: Agent, objective: string): Promise<unknown> {
    const text = objective.trim()
    if (text.length === 0) throw new Error('mission objective is required')
    const current = (this.ctx.get('goals') as { get(agent: Agent): { objective?: string } | undefined } | undefined)?.get(agent)
    return this.command(agent, current === undefined ? `/goal ${text}` : `/goal edit ${text}`)
  }

  /** Enter or leave plan mode. */
  async plan(agent: Agent, active: boolean): Promise<unknown> {
    return this.command(agent, active ? '/plan' : '/plan off')
  }

  /** Replace the harness todo list; this is the DSH-side plan projection. */
  async todos(agent: Agent, todos: readonly HarnessTodo[]): Promise<unknown> {
    const normalized = todos
      .filter((todo) => typeof todo.content === 'string' && todo.content.trim().length > 0)
      .map((todo) => ({ content: todo.content.trim(), status: todo.status }))
    if (normalized.length === 0) throw new Error('at least one todo is required')
    const callId = `amp-todo-${Date.now().toString(36)}`
    const batch = await this.ctx.tools.execute({
      calls: [{
        type: 'tool-call' as const,
        id: callId as never,
        name: 'todo_write',
        arguments: JSON.stringify({ todos: normalized }),
      }],
      signal: new AbortController().signal,
      agent,
    })
    const result = batch.results[0]?.result
    if (result === undefined) throw new Error('todo_write produced no result')
    if (result.isError) throw new Error(result.error.message)
    return jsonSafe(result.value)
  }

  /** Record a durable session-level feedback entry. */
  async feedback(agent: Agent, text: string, category = 'task-result'): Promise<unknown> {
    const service = this.ctx.get('sessionFeedback') as
      | { record(request: Record<string, unknown>): Promise<unknown> }
      | undefined
    if (service === undefined) throw new Error('the session feedback service is unavailable')
    return service.record({ sessionId: agent.id, text, category })
  }

  /** Mirror an AMP draft plan into the harness todo list and enter plan mode. */
  async planFromDraft(agent: Agent, tasks: readonly { intent?: string; acceptance?: string }[]): Promise<unknown> {
    const todos: HarnessTodo[] = tasks.map((task) => ({
      content: task.intent ?? task.acceptance ?? 'plan task',
      status: 'pending',
    }))
    const enter = await this.plan(agent, true)
    const written = todos.length === 0 ? null : await this.todos(agent, todos)
    return { enter, written }
  }

  /** Accept the loose record shapes handlers receive. */
  static todosFrom(value: unknown): HarnessTodo[] {
    if (!Array.isArray(value)) return []
    const todos: HarnessTodo[] = []
    for (const raw of value) {
      const record = asRecord(raw)
      if (record === undefined) continue
      const content = typeof record.content === 'string' ? record.content.trim() : ''
      if (content.length === 0) continue
      const status = record.status === 'completed' || record.status === 'in_progress' ? record.status : 'pending'
      todos.push({ content, status })
    }
    return todos
  }
}
