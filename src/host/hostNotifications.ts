/**
 * Best-effort DSH host-event notification bridge.
 *
 * DSH 0.2.2-rc.1 does not expose a general native Toast/notification bus to
 * third-party plugins. We therefore do not monkey-patch private UI state or
 * shadow actionable dialogs. When takeoverNotifications is enabled, this
 * adapter projects host-owned error/status events that are safe to reproduce
 * (agent errors, failed tool results, and terminal turn errors) into AMP's
 * bounded notification queue. Disabling the preference immediately restores
 * the native host path; the adapter never consumes or suppresses DSH events.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { NotificationCenter } from './notify.js'
import type { AmpHost } from './amp.js'
import { asRecord } from './json.js'

function textOf(value: unknown, fallback: string): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  const record = asRecord(value)
  for (const key of ['message', 'reason', 'text']) {
    if (typeof record?.[key] === 'string' && String(record[key]).trim().length > 0) return String(record[key]).trim()
  }
  return fallback
}

export class HostNotificationBridge {
  private readonly seen = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly host: AmpHost,
    private readonly center: NotificationCenter,
    private readonly enabled: () => boolean,
  ) {}

  attach(): void {
    const on = this.ctx.on.bind(this.ctx) as unknown as (name: string, handler: (...args: unknown[]) => void) => void
    on('agent/error', (payload) => {
      const record = asRecord(payload)
      const agent = asRecord(record?.agent)
      const session = typeof agent?.id === 'string' ? agent.id : undefined
      if (session === undefined) return
      this.push(session, 'agent-error', 'error', textOf(record?.error, 'The agent reported an error.'))
    })
    on('tools/result', (exec, result) => {
      const execution = asRecord(exec)
      const outcome = asRecord(result)
      const agent = asRecord(execution?.agent)
      const session = typeof agent?.id === 'string' ? agent.id : undefined
      if (session === undefined || outcome?.isError !== true) return
      const name = typeof execution?.name === 'string' ? execution.name : 'tool'
      this.push(session, `tool-error:${String(execution?.callId ?? name)}`, 'error', `${name}: ${textOf(outcome.error, 'The tool call failed.')}`)
    })
    on('session/event', (session, event) => {
      const source = asRecord(session)
      const item = asRecord(event)
      const data = asRecord(item?.data)
      if (item?.type !== 'turn/end' || typeof source?.id !== 'string') return
      const reason = data?.reason
      const reasonRecord = asRecord(reason)
      const kind = typeof reason === 'string' ? reason : reasonRecord?.kind
      if (kind !== 'error' && kind !== 'aborted') return
      this.push(source.id, `turn-end:${String(data?.turn ?? '')}:${String(kind)}`, 'error', `Turn ended: ${textOf(reason, String(kind))}`)
    })
  }

  private push(session: string, key: string, severity: 'info' | 'error', message: string): void {
    if (!this.enabled() || this.seen.has(`${session}:${key}`)) return
    this.seen.add(`${session}:${key}`)
    if (this.seen.size > 2048) {
      const first = this.seen.values().next().value
      if (typeof first === 'string') this.seen.delete(first)
    }
    try {
      this.center.push(session, {
        surface: 'snackbar',
        severity,
        message,
        duration: severity === 'error' ? 8000 : 6000,
      })
    } catch {
      // Notification projection must never affect the host event pipeline.
    }
  }
}
