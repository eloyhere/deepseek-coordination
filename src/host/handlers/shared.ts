/** Shared helpers for the host-authored AMP verb handlers. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AmpHost } from '../amp.js'
import { asRecord, jsonSafe } from '../json.js'

export type Params = Readonly<Record<string, unknown>>
export type Handler = (parameters: Params) => unknown
export type HandlerMap = Record<string, Handler>

export interface Failure {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

export function failure(code: string, message: string): Failure {
  return { ok: false, error: { code, message } }
}

export function ok(value: unknown): unknown {
  return { ok: true, value: jsonSafe(value) }
}

export function execOf(host: AmpHost): ToolRunContext {
  const exec = host.currentExec()
  if (exec === undefined) throw new Error('AMP handler ran outside a tool call')
  return exec
}

export function agentOf(host: AmpHost): Agent {
  const agent = execOf(host).agent
  if (agent === undefined) throw new Error('AMP handler requires an agent session')
  return agent
}

export function sessionOf(host: AmpHost): string {
  return agentOf(host).id
}

/** Session cwd from the durable header, falling back to the host cwd. */
export function rootOf(host: AmpHost): string {
  const agent = execOf(host).agent
  const cwd = agent?.session.header.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

export function objectArg(value: unknown, name: string): Record<string, unknown> {
  const record = asRecord(value)
  if (record === undefined) throw new Error(`${name} must be a JSON object`)
  return record
}

export function arrayArg(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

/** Resolve an entity id argument, defaulting to the first entity in scope. */
export function entityId(parameters: Params, key = 'id'): string | undefined {
  const value = parameters[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function pageOf(parameters: Params, fallbackLimit = 20): { offset: number; limit: number } {
  const offset = typeof parameters.offset === 'number' && Number.isInteger(parameters.offset) && parameters.offset >= 0
    ? parameters.offset
    : 0
  const limit = typeof parameters.limit === 'number' && Number.isInteger(parameters.limit) && parameters.limit > 0
    ? Math.min(parameters.limit, 200)
    : fallbackLimit
  return { offset, limit }
}

export function page<T>(items: readonly T[], parameters: Params, fallbackLimit = 20): { items: T[]; total: number; offset: number; limit: number } {
  const { offset, limit } = pageOf(parameters, fallbackLimit)
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit }
}
