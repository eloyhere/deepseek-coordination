/** Guards that make the read/write/search takeover switches effective, not advisory. */
import type { AmpHost } from './amp.js'

/** Native file tools redirected to AMP while their takeover switch is on. */
export const FILE_READ_TOOL_NAMES: readonly string[] = ['read']
export const FILE_SEARCH_TOOL_NAMES: readonly string[] = ['glob', 'grep']
export const FILE_WRITE_TOOL_NAMES: readonly string[] = ['write', 'replace', 'edit', 'apply_patch']

export interface GuardedExecution {
  readonly name: string
  readonly agent?: unknown
}

/** Localized denial text; defaults keep source-level tests import-free. */
export interface TakeoverReasons {
  readonly readReason: string
  readonly writeReason: string
  readonly searchReason: string
}

const EN_REASONS: TakeoverReasons = {
  readReason: 'File-read takeover is enabled. Use AMP workspace.list, workspace.outline, then workspace.read with startLine/endLine or a byte range. Native read is disabled.',
  writeReason: 'File-write takeover is enabled. Use AMP workspace.write, or workspace.replace with expectedBaseHash/expectedBufferVersion. Native write/replace is disabled.',
  searchReason: 'Search takeover is enabled. Use attention_manifest_protocol_discover with action="search", then outline and read only the relevant ranges. Native glob/grep are disabled.',
}

/**
 * Deny a native file tool when its matching takeover switch is enabled.
 * AMP tools do not pass through `ctx.tools`, so they remain the single path.
 */
export function fileTakeoverGuard(host: AmpHost, reasons: TakeoverReasons = EN_REASONS): (execution: GuardedExecution) => string | undefined {
  return (execution) => {
    const isWrite = FILE_WRITE_TOOL_NAMES.includes(execution.name)
    const isRead = FILE_READ_TOOL_NAMES.includes(execution.name)
    const isSearch = FILE_SEARCH_TOOL_NAMES.includes(execution.name)
    if (!isWrite && !isRead && !isSearch) return undefined
    const root = host.rootOfAgent(execution.agent)
    const preferences = host.preferencesFor(root).get()
    if (isWrite) return preferences.takeoverFileWrite ? reasons.writeReason : undefined
    if (isRead) return preferences.takeoverFileRead ? reasons.readReason : undefined
    return preferences.takeoverSearch ? reasons.searchReason : undefined
  }
}

/** Backwards-compatible name used by older callers and tests. */
export const fileWriteTakeoverGuard = fileTakeoverGuard

/** Minimal live-agent shape needed to install an agent-scoped guard. */
export interface GuardAgent {
  readonly id?: string
  readonly ctx?: {
    readonly tools?: {
      guard?: (guard: (execution: GuardedExecution) => string | undefined) => () => void
    }
  }
}

/** Live registry and lifecycle hooks exposed by the host context. */
export interface GuardRegistrar {
  readonly root?: GuardRegistrar
  readonly agents?: { list?: () => readonly GuardAgent[] }
  on?: (name: string, listener: (payload: { agent?: GuardAgent }) => void) => (() => void) | undefined
}

/**
 * Install the guard on every live agent and on every future agent.
 *
 * `ctx.tools.guard()` binds to the calling context. Called once at plugin
 * start it can land in one agent's scope, leaving sibling sessions (for
 * example another project's long-running chat) unguarded. Registering through
 * `agent.ctx.tools` makes the denial apply to every session in this process.
 */
export function installFileTakeoverGuards(
  ctx: GuardRegistrar,
  host: AmpHost,
  reasonsFor: () => TakeoverReasons = () => EN_REASONS,
): () => void {
  const installed = new Map<GuardAgent, () => void>()
  const guard = (execution: GuardedExecution): string | undefined => fileTakeoverGuard(host, reasonsFor())(execution)
  const attach = (agent: GuardAgent | undefined): void => {
    if (agent === undefined || installed.has(agent)) return
    const tools = agent.ctx?.tools
    if (typeof tools?.guard !== 'function') return
    try {
      installed.set(agent, tools.guard(guard))
    } catch {
      // The agent may be disposing between the event and this registration.
    }
  }
  // A plugin loaded from a session is scoped to that agent; its own `on` and
  // `agents` only observe that subtree. The application root observes sibling
  // sessions and newly created subagents, so subscribe there.
  const root = ctx.root ?? ctx
  const registry = root.agents ?? ctx.agents
  const subscribe = root.on ?? ctx.on
  for (const agent of registry?.list?.() ?? []) attach(agent)
  const offCreated = subscribe?.('agent/created', (payload) => attach(payload.agent)) ?? (() => {})
  const offDisposed = subscribe?.('agent/disposed', (payload) => {
    if (payload.agent === undefined) return
    installed.get(payload.agent)?.()
    installed.delete(payload.agent)
  }) ?? (() => {})
  return () => {
    offCreated()
    offDisposed()
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }
}
