/** Model-facing registration of the AMP module surface on `ctx.tools`. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { compileDiscoveryPatterns, normalizeDiscoveryQuery } from 'attention-manifest-protocol/agent'
import type { AmpHost } from './amp.js'
import { createProjectFileProvider, parseProjectSearchArguments } from './search.js'
import { HarnessBridge } from './bridge.js'
import { jsonSafe } from './json.js'
import { AMP_DISCOVER } from './names.js'
import type { AmpModule } from './types.js'

function describe(module: AmpModule): string {
  const verbs = module.verbs
    .map((verb) => `${verb.verb}${verb.mutating ? ' (mutating)' : ''}: ${verb.summary}`)
    .join('; ')
  return `AMP ${module.module} — ${module.summary} Verbs: ${verbs}. Call ${AMP_DISCOVER} to inspect the whole protocol surface.`
}

/** Register one module tool per agent-tier AMP module. */
export function registerAmpModuleTools(ctx: Context, host: AmpHost): void {
  for (const module of host.agentModules) {
    const verbs = module.verbs.map((verb) => verb.verb)
    ctx.tools.register(defineTool({
      name: `attention_manifest_protocol_${module.module}`,
      description: describe(module),
      parameters: {
        verb: {
          type: 'string',
          required: true,
          enum: verbs,
          description: `The ${module.module} verb to run.`,
        },
        arguments: {
          type: 'json',
          description: 'Lossless JSON arguments for the selected verb; inspect the module through the discover tool first.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        return jsonSafe(await host.call(module.module, args.verb, args.arguments ?? {}, exec))
      },
    }))
  }
}

/** One native bridge for AMP → harness goal/mission/plan/todos/feedback writes. */
export function registerHarnessTool(ctx: Context, host: AmpHost): void {
  ctx.tools.register(defineTool({
    name: 'attention_manifest_protocol_harness',
    description: [
      "Write harness state from the AMP side through the harness's own commands and tools.",
      'operation=goal (action create|edit|pause|resume|clear, text), mission (text → current goal objective),',
      'plan (action enter|leave), todos (todos array), or feedback (text, category).',
    ].join(' '),
    parameters: {
      operation: { type: 'string', required: true, enum: ['goal', 'mission', 'plan', 'todos', 'feedback'] },
      action: { type: 'string', description: 'goal: create|edit|pause|resume|clear; plan: enter|leave.' },
      text: { type: 'string', description: 'Goal/mission objective or feedback text.' },
      category: { type: 'string', description: 'Feedback category; defaults to task-result.' },
      todos: {
        type: 'array',
        description: 'Whole harness todo list for operation=todos.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'] },
          },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) return jsonSafe({ ok: false, error: { code: 'binding_invalid', message: 'the harness bridge needs an agent session' } })
      const bridge = host.bridge
      if (bridge === undefined) return jsonSafe({ ok: false, error: { code: 'not_available', message: 'the harness bridge is not attached' } })
      try {
        switch (args.operation) {
          case 'goal':
            return jsonSafe({ ok: true, value: await bridge.goal(agent, args.action ?? 'create', args.text) })
          case 'mission':
            return jsonSafe({ ok: true, value: await bridge.mission(agent, args.text ?? '') })
          case 'plan':
            return jsonSafe({ ok: true, value: await bridge.plan(agent, (args.action ?? 'enter') !== 'leave') })
          case 'todos':
            return jsonSafe({ ok: true, value: await bridge.todos(agent, HarnessBridge.todosFrom(args.todos)) })
          case 'feedback':
            return jsonSafe({ ok: true, value: await bridge.feedback(agent, args.text ?? '', args.category) })
          default:
            return jsonSafe({ ok: false, error: { code: 'invalid_parameters', message: `unknown operation ${String(args.operation)}` } })
        }
      } catch (error) {
        return jsonSafe({ ok: false, error: { code: 'handler_failed', message: error instanceof Error ? error.message : String(error) } })
      }
    },
  }))
}

/** The bootstrap entry: the full AMP module catalog, filtered by a query. */
export function registerDiscoverTool(ctx: Context, host: AmpHost): void {  ctx.tools.register(defineTool({
    name: AMP_DISCOVER,
    description: 'AMP discovery bootstrap. Use action=catalog to inspect modules, verbs and authority; use action=search to find project files or matching file content using AMP discovery ranking. query accepts a string or an array of strings; set regex=true to match each entry as a case-insensitive regular expression.',
    parameters: {
      action: { type: 'string', enum: ['catalog', 'search'], description: 'catalog (default) inspects the AMP protocol; search searches files or content in the current project.' },
      query: { type: 'json', description: 'Catalog filter, or a required search query when action=search. Accepts a string or an array of strings.' },
      regex: { type: 'boolean', description: 'Treat each query entry as a case-insensitive regular expression instead of word matching.' },
      module: { type: 'string', description: 'Catalog: return one module by name.' },
      tier: { type: 'string', enum: ['agent', 'host', 'hidden'], description: 'Catalog: filter modules by tier.' },
      scope: { type: 'string', enum: ['files', 'content', 'both'], description: 'Search: match file paths, file contents, or both. Defaults to both.' },
      path: { type: 'string', description: 'Search root relative to the workspace, for example ., src or packages.' },
      include: { type: 'json', description: 'Optional path glob string or array of strings, such as **/*.{ts,tsx,js,mjs}.' },
      exclude: { type: 'json', description: 'Additional path glob string or array of strings to skip.' },
      maxFiles: { type: 'integer', description: 'Maximum project files to inspect, capped at 5000.' },
      maxFileBytes: { type: 'integer', description: 'Maximum bytes read per text file, capped at 1000000.' },
      limit: { type: 'integer', description: 'Maximum AMP discovery results, capped at 50.' },
      maxPerModule: { type: 'integer', description: 'Maximum results per file, capped at 50.' },
      minimumScore: { type: 'number', description: 'Minimum AMP discovery score from 0 to 1.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const action = args.action ?? 'catalog'
      if (action === 'search') {
        if (!host.preferencesFor(host.rootOfAgent(exec.agent)?.toString()).get().takeoverSearch) {
          return jsonSafe({ ok: false, error: { code: 'disabled', message: 'project search takeover is disabled; enable the Search takeover preference first' } })
        }
        try {
          if (exec.agent === undefined) throw new Error('project search requires an agent session')
          const { action: _action, ...searchArgs } = args as Record<string, unknown>
          const request = parseProjectSearchArguments(searchArgs)
          const provider = createProjectFileProvider(host, request, exec.agent.session.header?.cwd)
          const binding = host.bindingFor(exec.agent)
          const collection = await host.protocol.agent.collectDiscoveryCandidates({ providers: [provider] }, request.options, binding)
          const result = host.protocol.agent.discover(collection.candidates, request.options)
          return jsonSafe({ ...result, unavailableSources: collection.unavailable, scope: request.scope, path: request.path })
        } catch (error) {
          return jsonSafe({ ok: false, error: { code: 'invalid_search', message: error instanceof Error ? error.message : String(error) } })
        }
      }
      if (action !== 'catalog') {
        return jsonSafe({ ok: false, error: { code: 'invalid_action', message: `unknown discover action ${String(action)}` } })
      }
      const rawQuery = args.query
      if (rawQuery !== undefined && typeof rawQuery !== 'string' && !Array.isArray(rawQuery)) {
        return jsonSafe({ ok: false, error: { code: 'invalid_parameters', message: 'query must be a string or an array of strings' } })
      }
      const hasQuery = rawQuery !== undefined && (typeof rawQuery === 'string' ? rawQuery.trim().length > 0 : Array.isArray(rawQuery) && rawQuery.length > 0)
      if (args.regex !== undefined && typeof args.regex !== 'boolean') {
        return jsonSafe({ ok: false, error: { code: 'invalid_parameters', message: 'regex must be a boolean' } })
      }
      let terms: string[] = []
      let patterns: readonly RegExp[] = []
      if (hasQuery) {
        try {
          terms = normalizeDiscoveryQuery(rawQuery as string | readonly string[]).toLowerCase().split(/\s+/).filter(Boolean)
          if (args.regex === true) patterns = compileDiscoveryPatterns(rawQuery as string | readonly string[])
        } catch (error) {
          return jsonSafe({ ok: false, error: { code: 'invalid_query', message: error instanceof Error ? error.message : String(error) } })
        }
      }
      const tier = args.tier
      const selected = host.modules
        .filter((module) => args.module === undefined || module.module === args.module)
        .filter((module) => tier === undefined || module.tier === tier)
        .filter((module) => {
          if (!hasQuery) return true
          const haystack = `${module.module} ${module.summary} ${module.verbs.map((verb) => `${verb.verb} ${verb.summary}`).join(' ')}`.toLowerCase()
          return patterns.length > 0
            ? patterns.some((pattern) => pattern.test(haystack))
            : terms.some((term) => haystack.includes(term))
        })
        .map((module) => ({
          module: module.module,
          tier: module.tier,
          summary: module.summary,
          registration: module.tier === 'agent' ? 'tool' : module.tier === 'host' ? 'service' : 'internal',
          registered: module.tier === 'hidden'
            ? false
            : module.tier === 'agent'
              ? ctx.tools.get(`attention_manifest_protocol_${module.module}`) !== undefined
              : true,
          verbs: module.verbs.map((verb) => ({
            verb: verb.verb,
            mutating: verb.mutating,
            authority: [...verb.authority],
            summary: verb.summary,
            tool: `attention_manifest_protocol_${module.module}`,
          })),
          withheld: module.withheld,
        }))
      return jsonSafe({
        protocol: 'attention-manifest-protocol',
        version: '0.9.1',
        prefix: 'attention_manifest_protocol',
        discovered: selected.length,
        modules: selected,
      })
    },
  }))
}

