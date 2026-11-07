/**
 * `coordination_notification` — one model-facing tool that pops a notification
 * in the DSH Web GUI. The tool only enqueues: `NotificationCenter.push`
 * validates the request and the client half polls it out.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  NOTIFICATION_ANCHORS,
  NOTIFICATION_LIMITS,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_SURFACES,
} from '../shared/notification.js'
import { jsonSafe } from './json.js'
import type { NotificationCenter } from './notify.js'

function asArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('notification arguments must be a JSON object')
  }
  return value as Record<string, unknown>
}

export function registerNotificationTool(ctx: Context, center: NotificationCenter, enabled?: (session?: string) => boolean): void {
  ctx.tools.register(defineTool({
    name: 'coordination_notification',
    description: [
      'Pop a notification in this session\'s DSH Web GUI (display only; never waits).',
      'surface picks snackbar/alert/dialog/popover, severity sets the colour, duration is the',
      'auto-close delay in ms (0 waits; dialogs default to waiting), and actions adds up to four',
      'dismiss-only buttons. Use ask_user_question when you need an answer.',
    ].join(' '),
    parameters: {
      surface: {
        type: 'string',
        required: true,
        enum: [...NOTIFICATION_SURFACES],
        description: 'snackbar (bottom-right toast), alert (top banner), dialog (modal that always waits), popover (corner card).',
      },
      message: { type: 'string', required: true, description: `Notification body, 1-${NOTIFICATION_LIMITS.message} characters.` },
      severity: { type: 'string', enum: [...NOTIFICATION_SEVERITIES], description: 'success / info / warning / error; defaults to info.' },
      title: { type: 'string', description: `Optional title, at most ${NOTIFICATION_LIMITS.title} characters.` },
      duration: { type: 'integer', description: `Auto-close delay: 0 waits; otherwise ${NOTIFICATION_LIMITS.minDuration}-${NOTIFICATION_LIMITS.maxDuration} ms.` },
      anchor: { type: 'string', enum: [...NOTIFICATION_ANCHORS], description: 'Attachment point for snackbar / alert / popover.' },
      actions: {
        type: 'array',
        description: 'Up to four buttons; clicking only dismisses the notification.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Button id, unique within the notification.' },
            label: { type: 'string', required: true, description: 'Button label.' },
          },
        },
      },
      session: { type: 'string', description: 'Optional DSH session id; defaults to the calling agent session.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const supplied = asArguments(args)
      const session = typeof supplied.session === 'string' && supplied.session.trim().length > 0
        ? supplied.session.trim()
        : exec.agent?.id
      if (enabled !== undefined && !enabled(session)) {
        return jsonSafe({
          ok: false,
          error: {
            code: 'DISABLED',
            message: 'host notification takeover is disabled; ask the user to enable it in AMP settings',
          },
        })
      }
      if (session === undefined) {
        return jsonSafe({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session is required when no agent is bound' } })
      }
      try {
        const { item, queued, dropped } = center.push(session, supplied)
        return jsonSafe({
          ok: true,
          id: item.id,
          sequence: item.sequence,
          session: item.session,
          surface: item.surface,
          severity: item.severity,
          queued,
          ...(dropped > 0 ? { dropped } : {}),
        })
      } catch (error) {
        return jsonSafe({
          ok: false,
          error: {
            code: typeof (error as { code?: unknown }).code === 'string' ? String((error as { code?: unknown }).code) : 'INVALID_ARGUMENT',
            message: error instanceof Error ? error.message : 'notification call failed',
          },
        })
      }
    },
  }))
}
