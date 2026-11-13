/** The AMP operating contract injected into every agent's system prompt. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { AmpHost } from './amp.js'

/** A prompt variable provider; the assembly context is narrowed structurally. */
type PromptVariableProvider = (context: unknown) => string | undefined

/** The subset of `systemPrompt.variable()` this plugin relies on. */
type PromptVariableRegistrar = (name: string, provider: PromptVariableProvider) => () => void

/** Read a non-empty agent id from an opaque assembly context. */
function agentIdOf(context: unknown): string | undefined {
  const agent = (context as { agent?: { id?: unknown } } | undefined)?.agent
  return typeof agent?.id === 'string' && agent.id.length > 0 ? agent.id : undefined
}

/**
 * Register the AMP scalar prompt variables.
 *
 * `systemPrompt.variable()` is absent from the minimal contexts used by older
 * compositions, so a missing method is a silent no-op. Each registration is
 * isolated: a duplicate name or an unsupported provider must not fail plugin
 * activation or skip the remaining variables.
 */
function registerAmpPromptVariables(ctx: Context, host: AmpHost): void {
  const register = (ctx.systemPrompt as unknown as { variable?: PromptVariableRegistrar }).variable
  if (typeof register !== 'function') return
  const define = (name: string, provider: PromptVariableProvider): void => {
    try {
      register.call(ctx.systemPrompt, name, provider)
    } catch {
      // The variable is optional; a failed registration only means templates
      // cannot reference it.
    }
  }
  define('amp_tenant', () => host.config.tenantId)
  define('amp_contract', () => 'AMP 0.9.1')
  define('amp_budget_tokens', () => String(host.config.contextBudgetTokens))
  define('amp_module_count', () => String(host.agentModules.length))
  define('amp_session', (context) => agentIdOf(context) ?? 'unbound')
}

/** The AMP operating contract, dynamic contexts and prompt variables for one host. */
export function registerAmpPrompt(ctx: Context, host: AmpHost): void {
  const moduleLines = host.agentModules
    .map((module) => `- attention_manifest_protocol_${module.module}: ${module.summary}`)
    .join('\n')

  ctx.systemPrompt.section({
    name: 'deepseek-coordination:amp-contract',
    order: ctx.systemPrompt.getSectionOrder('MCP_SERVERS') + 10,
    text: [
      '## Attention Manifest Protocol (AMP 0.9.1)',
      '',
      'This host exposes AMP as seventeen module tools named `attention_manifest_protocol_<module>`.',
      'Each tool takes a `verb` and a lossless `arguments` object. Call `attention_manifest_protocol_discover`',
      'first when you do not know a module\'s verbs, authority or mutating status.',
      '',
      moduleLines,
      '- attention_manifest_protocol_replace: replace text in a workspace file by literal string, regular expression, line range, UTF-8 byte range or outline node; mutating and CAS-guarded by expectedBufferVersion/expectedBaseHash.',
      '',
      'Rules:',
      '- Read before you write. `get`/`list`/`read` verbs are safe; verbs marked mutating change durable state and require an idempotency key, which the host supplies from the tool call id.',
      '- Outline before content. Before exploring a project, read its outline with `workspace.list` (or `workspace.read` on the project root). Before reading a file, read its outline with `workspace.outline` or the first `workspace.read`, whose `phase: "outline"` response must be reviewed first. Only then request content ranges; the host enforces the fixed order project outline, then file outline, then content and returns the missing outline instead of content.',
      '- Record uncertainty explicitly: cite evidence ids with `evidence.cite`, report progress with `task.report_progress` or `turn.report`, and propose plans with `plan.propose_draft` instead of silently changing course.',
      '- Workspace tools stay inside the session workspace root; writes use compare-and-swap with the revision returned by the preceding read.',
      '- `execution.run` is the only AMP verb that dispatches another DSH tool. Do not use it to call AMP protocol tools.',
      '- The host owns session, turn, receipt and verification lifecycles; the model never creates or closes them.',
    ].join('\n'),
  })

  ctx.systemPrompt.context({
    name: 'deepseek-coordination:intake',
    order: ctx.systemPrompt.getContextOrder('HARNESS_SOURCE') + 9,
    required: true,
    interpolate: false,
    text: () => {
      // The intake flow is part of the default contract; the user can still
      // opt out per request, and trivial turns are explicitly excluded.
      return [
        '## Intake flow after each user message',
        'After a new substantive user request, run one intake pass before other tools:',
        '1. Expand the request into goal, assumptions, unknowns and 2-3 alternative approaches. For a large request, use `attention_manifest_protocol_elaboration` to build the expansion; otherwise write it directly.',
        '2. Call `deepseek_coordination_intake` exactly once. Pass 1-2 concrete questions (2-4 options each), the expansion, and the proposed approaches. The tool opens the native question popup and adds a decision question so the user picks a direction.',
        '3. When the popup returns, propose the resulting plan with `attention_manifest_protocol_plan` (`propose_draft`) or `attention_manifest_protocol_harness` (`operation: "plan"`, `operation: "todos"`), then continue with the chosen approach.',
        'Skip the intake pass for a pure acknowledgement, when the user explicitly says not to ask, or when this turn already has answers. Never invent the user\'s answer: if the popup is cancelled or unavailable, report it and ask in plain text instead.',
      ].join('\n')
    },
  })

  ctx.systemPrompt.context({
    name: 'deepseek-coordination:takeover',
    order: ctx.systemPrompt.getContextOrder('HARNESS_SOURCE') + 11,
    required: false,
    interpolate: false,
    text: (assembly) => {
      const agent = (assembly as { agent?: { session?: { header?: { cwd?: string } } } }).agent
      return host.preferencesFor(agent?.session?.header?.cwd).get().takeoverFileRead
        ? [
          'File-read takeover is enabled, and every target must be read in outline form first.',
          'For a project: call `attention_manifest_protocol_workspace.list` on the workspace root (or `workspace.read`/`workspace.outline` on the root directory) and review the project outline before opening any file.',
          'For a file: call `attention_manifest_protocol_workspace.outline` first, or rely on the first `workspace.read`, whose `phase: "outline"` response lists the file outline; review it, then repeat the read with `startLine`/`endLine` or a byte range for only the content you need.',
          'The host enforces the order project outline, then file outline, then content; a content request made before the outline returns the outline instead.',
          'Native read is disabled while this switch is on, so every read goes through AMP and is journaled, bounded and CAS-aware.',
          'For a binary document or a path outside the workspace root, use the format-aware tool for that format; do not bypass the guard with a shell command.',
        ].join(' ')
        : ''
    },
  })

  ctx.systemPrompt.context({
    name: 'deepseek-coordination:file-write-takeover',
    order: ctx.systemPrompt.getContextOrder('HARNESS_SOURCE') + 13,
    required: false,
    interpolate: false,
    text: (assembly) => {
      const agent = (assembly as { agent?: { session?: { header?: { cwd?: string } } } }).agent
      if (!host.preferencesFor(agent?.session?.header?.cwd).get().takeoverFileWrite) return ''
      return [
        'File-write takeover is enabled: use `attention_manifest_protocol_workspace.write` for full writes and `attention_manifest_protocol_replace` for targeted replacements inside the session workspace.',
        'Read the file with `attention_manifest_protocol_workspace.read` before changing it. For write, pass `expectedBaseHash` (the returned `baseHash`) and/or `expectedBufferVersion`; set `dryRun: true` to preview. For replace, pass the same `expectedBaseHash`/`expectedBufferVersion`. `expectedRevision` stays accepted as an alias for `expectedBaseHash`.',
        'Replace supports literal string, regular expression, line range, UTF-8 byte range and outline node targets, with `all` or a one-based `occurrence`; use `dryRun: true` on write to preview.',
        'Native write and replace tools are disabled while this takeover is active. If a CAS guard conflicts, read the latest file and reapply the intended edit. Fall back to native file tools only for paths outside the workspace or format-aware binary documents.',
      ].join(' ')
    },
  })

  ctx.systemPrompt.context({
    name: 'deepseek-coordination:search-takeover',
    order: ctx.systemPrompt.getContextOrder('HARNESS_SOURCE') + 12,
    required: false,
    interpolate: false,
    text: (assembly) => {
      const agent = (assembly as { agent?: { session?: { header?: { cwd?: string } } } }).agent
      if (!host.preferencesFor(agent?.session?.header?.cwd).get().takeoverSearch) return ''
      return [
        'Search takeover is enabled: use `attention_manifest_protocol_discover` with `action: "search"` for project file-name or file-content searches instead of native search tools. Native glob/grep are disabled while this switch is on.',
        'AMP discover performs the ranking; choose `scope` as `files`, `content`, or `both`, and pass `path`, `include`, and `exclude` to control the workspace-relative search scope.',
        'Search results only identify matching files and line locations; before reading content, get the file outline with `attention_manifest_protocol_workspace.outline` (or the first `workspace.read` outline phase), then read only the relevant ranges.',
      ].join(' ')
    },
  })

  ctx.systemPrompt.context({
    name: 'deepseek-coordination:bound',
    order: ctx.systemPrompt.getContextOrder('HARNESS_SOURCE') + 10,
    required: false,
    interpolate: false,
    text: (assembly) => {
      const agent = (assembly as { agent?: { id: string; session: { header?: { cwd?: string } } } }).agent
      if (agent === undefined) return ''
      const cwd = agent.session.header?.cwd
      return `AMP binding: session ${agent.id}${cwd === undefined ? '' : `, workspace ${cwd}`}. AMP modules: ${host.agentModules.length}; exposed verbs: ${host.catalog.length}.`
    },
  })

  registerAmpPromptVariables(ctx, host)
}
