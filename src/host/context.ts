/**
 * AMP attention → DSH prompt context.
 *
 * AMP's Context module compiles a bounded model payload from attention items and
 * records every exclusion. This adapter builds the items from the live harness
 * state (prompt, goal, todo plan, recent tool outcome, workspace) and injects the
 * compiled text as a dynamic runtime context, so attention selection actually
 * changes what the model sees rather than remaining a read-only panel value.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { AmpHost } from './amp.js'
import type { Config } from './config.js'
import { asRecord } from './json.js'

const ACTOR = 'dsh-attention'

interface ContextStats {
  compilations: number
  failures: number
  excluded: number
  lastTokens: number
  lastCharacters: number
  lastItems: number
  lastPreview: string
}

function textOfMessage(value: unknown, limit: number): string {
  const message = asRecord(value)
  const content = Array.isArray(message?.content) ? message.content : []
  const text = content
    .map((block) => asRecord(block))
    .filter((block): block is Record<string, unknown> => block !== undefined && block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

export class AmpContextOptimizer {
  private readonly ctx: Context
  private readonly host: AmpHost
  private readonly config: Config
  private readonly prompts = new Map<string, string>()
  private readonly todos = new Map<string, string>()
  private readonly tools = new Map<string, string[]>()
  private readonly cache = new Map<string, string>()
  private readonly stats: ContextStats = { compilations: 0, failures: 0, excluded: 0, lastTokens: 0, lastCharacters: 0, lastItems: 0, lastPreview: '' }

  constructor(ctx: Context, host: AmpHost, config: Config) {
    this.ctx = ctx
    this.host = host
    this.config = config
  }

  status(): ContextStats & { enabled: boolean; budgetTokens: number } {
    return { ...this.stats, enabled: this.enabled(), budgetTokens: this.config.contextBudgetTokens }
  }

  /** Config is the deployment ceiling; the runtime switch can only narrow it. */
  private enabled(root?: string): boolean {
    if (!this.config.contextOptimization) return false
    try {
      return this.host.preferencesFor(root).get().contextOptimization
    } catch {
      return true
    }
  }

  onSessionEvent(session: { id: string }, event: { type: string; data?: unknown }): void {
    const data = asRecord(event.data)
    if (data === undefined) return
    if (event.type === 'user/message') {
      const text = textOfMessage(data, 2000).trim()
      if (text.length > 0) {
        this.prompts.set(session.id, text)
        this.cache.clear()
      }
    } else if (event.type === 'todo/write') {
      const todos = Array.isArray(data.todos) ? data.todos : []
      const summary = todos
        .map((raw) => asRecord(raw))
        .filter((todo): todo is Record<string, unknown> => todo !== undefined)
        .map((todo) => `${todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]'} ${String(todo.content ?? '')}`)
        .join('\n')
      this.todos.set(session.id, summary.slice(0, 2000))
      this.cache.clear()
    } else if (event.type === 'tool/result') {
      const text = textOfMessage(data.message, 300).trim()
      if (text.length > 0) {
        const list = this.tools.get(session.id) ?? []
        list.push(text)
        this.tools.set(session.id, list.slice(-3))
        this.cache.clear()
      }
    } else if (event.type === 'turn/start') {
      this.tools.delete(session.id)
    }
  }

  /** Compiled AMP context for one agent's current turn, or an empty string. */
  contextFor(agent: Agent): string {
    const root = agent.session.header?.cwd
    if (!this.enabled(root)) return ''
    const sessionId = agent.id
    let turn = this.host.currentTurn(sessionId)
    if (turn === undefined) {
      try {
        turn = this.ctx.agents.turnBoundaryOf(agent.session).lastTurn
      } catch {
        turn = 0
      }
    }
    const key = `${sessionId}:${turn}`
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    try {
      const turnId = this.host.ensureTurn(sessionId, turn, root)
      const kernel = this.host.kernel(root)
      const scope = {
        tenantId: this.config.tenantId,
        principalId: sessionId,
        sessionId,
        turnId,
      }
      const budgetPerItem = { tokens: Math.max(256, Math.floor(this.config.contextBudgetTokens / 2)) }
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      const item = (name: string, summary: string, kind: string, scores: Record<string, number>): Record<string, unknown> | null => {
        const text = summary.trim()
        if (text.length === 0) return null
        return {
          id: `dsh:attention:${sessionId}:${turn}:${name}`,
          summary: text,
          pointer: { kind, id: `${kind}:${sessionId}:${turn}:${name}`, version: '1' },
          scope,
          scores,
          budget: budgetPerItem,
          expiresAt,
          reason: `${name} is relevant to the current turn`,
        }
      }
      const goal = (this.ctx.get('goals') as { get(agent: Agent): { objective?: string } | undefined } | undefined)?.get(agent)
      const items = [
        item('prompt', this.prompts.get(sessionId)?.slice(0, 600) ?? '', 'prompt', { relevance: 1, urgency: 1, confidence: 1, importance: 1 }),
        item('goal', (goal?.objective ?? '').slice(0, 300), 'goal', { relevance: 1, urgency: 0.9, confidence: 0.9, importance: 1 }),
        item('plan', (this.todos.get(sessionId) ?? '').slice(0, 600), 'plan', { relevance: 0.9, urgency: 0.8, confidence: 0.9, importance: 0.8 }),
        item('tools', (this.tools.get(sessionId) ?? []).join('\n---\n').slice(0, 400), 'tool', { relevance: 0.8, urgency: 0.6, confidence: 0.8, importance: 0.7 }),
        item('workspace', `workspace: ${agent.session.header?.cwd ?? process.cwd()}`.slice(0, 160), 'workspace', { relevance: 0.6, urgency: 0.4, confidence: 1, importance: 0.5 }),
      ].filter((value): value is Record<string, unknown> => value !== null)

      if (items.length === 0) return ''
      const compiled = kernel.flow.compileTurnContext({
        turnId,
        sessionId,
        principalId: sessionId,
        budget: { tokens: this.config.contextBudgetTokens },
        create: items as never,
        // The attention objects are host-created in this call; accepting their
        // declared pointer version avoids the workflow-kind lookup, which only
        // knows DSH's own entity names.
        currentVersion: (pointer: { version: string }) => pointer.version,
        countTokens: (text: string) => Math.ceil(text.length / 4),
      })
      const text = compiled.compiled.items
        .map((entry) => `- [${entry.id}] ${entry.summary}`)
        .join('\n')
      this.stats.compilations += 1
      this.stats.excluded = compiled.compiled.exclusions.length
      this.stats.lastItems = compiled.compiled.items.length
      this.stats.lastCharacters = text.length
      this.stats.lastTokens = Math.ceil(text.length / 4)
      this.stats.lastPreview = text.slice(0, 300)
      this.cache.set(key, text)
      return text
    } catch (error) {
      this.stats.failures += 1
      this.cache.set(key, '')
      return ''
    }
  }

  /** Register the compiled package as a dynamic runtime context. */
  register(): void {
    if (!this.config.contextOptimization) return
    this.ctx.systemPrompt.context({
      name: 'deepseek-coordination:amp-attention',
      order: this.ctx.systemPrompt.getContextOrder('HARNESS_SOURCE') + 30,
      required: false,
      interpolate: false,
      text: (assembly) => {
        const agent = (assembly as { agent?: Agent }).agent
        if (agent === undefined) return ''
        const compiled = this.contextFor(agent)
        if (compiled.length === 0) return ''
        return [
          '<amp_attention budget="' + String(this.config.contextBudgetTokens) + ' tokens">',
          compiled,
          '</amp_attention>',
          'Items excluded by the AMP attention budget remain in the AMP ledger as exclusions; do not assume they were read.',
        ].join('\n')
      },
    })
  }
}

export { ACTOR }

