/** AMP execution verbs: discover DSH tools, inspect them, run them through the pipeline. */
import { createHash } from 'node:crypto'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { RetrievalHandleStore } from 'attention-manifest-protocol/retrieval'
import { AMP_PREFIX } from '../names.js'
import type { AmpHost } from '../amp.js'
import { jsonSafe } from '../json.js'
import { agentOf, execOf, failure, ok, sessionOf } from './shared.js'
import type { HandlerMap, Params } from './shared.js'

function key(module: string, verb: string): string {
  return `${AMP_PREFIX}_${module}.${verb}`
}

const HANDLE_THRESHOLD = 16_000

/**
 * AMP retrieval handle index, one per host. Handles live in the AMP
 * `RetrievalHandleStore`, so every read is scope-checked (tenant/session) and
 * expires instead of being an unmanaged entry in a host map.
 */
const handleIndexes = new WeakMap<object, RetrievalHandleStore<string>>()

function handleIndex(host: AmpHost): RetrievalHandleStore<string> {
  const existing = handleIndexes.get(host)
  if (existing !== undefined) return existing
  const created = new RetrievalHandleStore<string>(() => new Date().toISOString())
  handleIndexes.set(host, created)
  return created
}

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function score(tool: ToolDefinition, terms: readonly string[]): number {
  const haystack = `${tool.name} ${tool.description}`.toLowerCase()
  let total = 0
  for (const term of terms) {
    if (tool.name.toLowerCase() === term) total += 10
    else if (tool.name.toLowerCase().includes(term)) total += 4
    if (haystack.includes(term)) total += 1
  }
  return total
}

export function executionHandlers(host: AmpHost): HandlerMap {
  return {
    [key('execution', 'find_tools')]: (parameters: Params) => {
      const query = typeof parameters.query === 'string' ? parameters.query : ''
      const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0)
      const limit = typeof parameters.limit === 'number' ? Math.min(Math.max(1, parameters.limit), 50) : 15
      const tools = host.ctx.tools.definitions(agentOf(host))
      const ranked = tools
        .map((tool) => ({ tool, score: terms.length === 0 ? 1 : score(tool, terms) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
        .slice(0, limit)
        .map((entry) => ({
          name: entry.tool.name,
          description: entry.tool.description,
          score: entry.score,
        }))
      return ok({ query, tools: ranked, total: ranked.length })
    },

    [key('execution', 'inspect_tool')]: (parameters: Params) => {
      const name = parameters.name
      if (typeof name !== 'string' || name.trim().length === 0) return failure('invalid_parameters', 'name is required')
      const tool = host.ctx.tools.get(name, agentOf(host))
      if (tool === undefined) return failure('not_found', `tool ${name} is not visible`)
      return ok({
        name: tool.name,
        description: tool.description,
        parameters: jsonSafe(tool.parameters),
        timeoutMs: tool.timeoutMs ?? null,
      })
    },

    [key('execution', 'run')]: async (parameters: Params) => {
      const supplied = Array.isArray(parameters.calls)
        ? parameters.calls
        : typeof parameters.tool === 'string' || typeof parameters.name === 'string'
          ? [{ name: parameters.tool ?? parameters.name, arguments: parameters.arguments ?? {} }]
          : []
      if (supplied.length === 0) return failure('invalid_parameters', 'calls or tool is required')
      if (supplied.length > 8) return failure('capacity_exceeded', 'at most 8 child calls per execution.run')
      // Validate without throwing: these used to escape the execute try/catch as
      // an unhandled rejection instead of a structured invalid_parameters failure.
      const calls: { type: 'tool-call'; id: never; name: string; arguments: string }[] = []
      for (const [index, raw] of supplied.entries()) {
        const call = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
        const name = typeof call.name === 'string' ? call.name : ''
        if (name.length === 0) return failure('invalid_parameters', `calls[${index}].name is required`)
        if (name.startsWith(AMP_PREFIX)) {
          return failure('invalid_parameters', 'execution.run cannot dispatch AMP protocol tools; call them directly')
        }
        const callId = typeof call.callId === 'string' && call.callId.length > 0
          ? call.callId
          : `amp-${Date.now().toString(36)}-${index}`
        calls.push({
          type: 'tool-call' as const,
          id: callId as never,
          name,
          arguments: JSON.stringify(call.arguments ?? {}),
        })
      }
      try {
        const exec = execOf(host)
        const batch = await host.ctx.tools.execute({
          calls,
          signal: exec.signal,
          agent: exec.agent,
        })
        const results = batch.results.map((entry) => {
          const result = entry.result
          const value = result.isError ? null : result.value
          const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
          return {
            callId: entry.callId,
            isError: result.isError,
            ...(result.isError ? { error: jsonSafe(result.error) } : { value: jsonSafe(value) }),
            text: text.slice(0, 4000),
          }
        })
        // One AMP behaviour observation per batch; recording never mutates state.
        host.behaviour.recordRun({
          runId: `${sessionOf(host)}:${Date.now().toString(36)}:${results.length}`,
          successes: results.filter((entry) => !entry.isError).length,
          total: results.length,
        })
        const serialized = JSON.stringify(results)
        if (serialized.length <= HANDLE_THRESHOLD) return ok({ results })
        const handleId = `handle:${sessionOf(host)}:${Date.now().toString(36)}`
        const scope = { tenantId: host.config.tenantId, ownerId: sessionOf(host), sessionId: sessionOf(host) }
        handleIndex(host).create({
          ...scope,
          id: handleId,
          sourceDigest: digestOf(serialized),
          ttlMilliseconds: 15 * 60_000,
          revocationEpoch: 0,
          records: [serialized],
        })
        return ok({
          results: results.map((result) => ({ callId: result.callId, isError: result.isError, preview: result.text.slice(0, 500) })),
          handle: handleId,
          totalCharacters: serialized.length,
        })
      } catch (error) {
        return failure('execution_failed', error instanceof Error ? error.message : String(error))
      }
    },

    [key('execution', 'read_handle')]: async (parameters: Params) => {
      const handle = parameters.handle ?? parameters.id
      if (typeof handle !== 'string' || handle.length === 0) return failure('invalid_parameters', 'handle is required')
      const scope = { tenantId: host.config.tenantId, ownerId: sessionOf(host), sessionId: sessionOf(host) }
      const now = new Date().toISOString()
      let text: string
      try {
        // AMP authorizes every read: tenant/session must match and the handle
        // must not be expired or revoked.
        const page = await handleIndex(host).read(handle, {
          ...scope,
          limit: 1,
          now,
          expectedRevocationEpoch: 0,
        }, (indexed, request) => indexed.tenantId === request.tenantId
          && indexed.sessionId === request.sessionId
          && request.now <= indexed.expiresAt)
        text = page.items[0] ?? ''
      } catch (error) {
        return failure('not_found', error instanceof Error ? error.message : `handle ${handle} was not found`)
      }
      const offset = typeof parameters.offset === 'number' && parameters.offset >= 0 ? Math.floor(parameters.offset) : 0
      const limit = typeof parameters.limit === 'number' && parameters.limit > 0 ? Math.min(Math.floor(parameters.limit), 20_000) : 12_000
      return ok({ handle, content: text.slice(offset, offset + limit), offset, limit, total: text.length })
    },
  }
}

