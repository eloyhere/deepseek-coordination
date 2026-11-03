/**
 * `coordination_notification` — one model-facing tool that pops a notification
 * in the DSH Web GUI.
 *
 * The tool only enqueues: `NotificationCenter.push` validates the request and
 * the client half polls it out. That keeps the tool non-blocking by design — a
 * modal dialog nobody closes can never stall the agent loop, and a headless
 * profile still returns a truthful `ok` for the queued item.
 *
 * Four surfaces are offered because they answer four different attention
 * questions: `snackbar` for "this finished", `alert` for "look at this now",
 * `dialog` for "acknowledge before continuing", `popover` for "here is a small
 * card next to the corner". Severity carries the meaning; the surface carries
 * the interruption level.
 */
import {
  NOTIFICATION_ANCHORS,
  NOTIFICATION_LIMITS,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_SURFACES,
  type NotificationSurface,
} from '../shared/notification.js'
import { normaliseLocale, type Locale } from '../shared/i18n.js'
import type { CoordinationToolDefinition, CoordinationToolTextBlock, ToolExecution } from './tools.js'
import type { NotificationCenter } from './notify.js'

/** The tool name; registered on `ctx.tools` like every other coordination tool. */
export type NotificationToolName = 'coordination_notification'

/** Every successful and failing shape this tool returns, closed for the model. */
export interface NotificationToolResult {
  ok: boolean
  id?: string
  sequence?: number
  session?: string
  surface?: NotificationSurface
  severity?: string
  queued?: number
  dropped?: number
  error?: { code: string; message: string }
}

const RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    id: { type: 'string' },
    sequence: { type: 'number' },
    session: { type: 'string' },
    surface: { type: 'string' },
    severity: { type: 'string' },
    queued: { type: 'number' },
    dropped: { type: 'number' },
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
}

function asArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('notification arguments must be a JSON object')
  }
  return value as Record<string, unknown>
}

/** `session` argument, falling back to the calling agent's id (the DSH session). */
function resolveSession(args: Record<string, unknown>, exec: ToolExecution | undefined): string {
  const supplied = args.session
  if (supplied !== undefined) {
    if (typeof supplied !== 'string' || supplied.trim().length === 0) {
      throw new Error('session must be a non-empty DSH session id')
    }
    return supplied.trim()
  }
  const agentId = exec?.agent?.id
  if (typeof agentId === 'string' && agentId.trim().length > 0) return agentId.trim()
  throw new Error('session is required: pass session or call the tool from an agent')
}

function failure(error: unknown): NotificationToolResult {
  const code = typeof (error as { code?: unknown } | null)?.code === 'string'
    ? String((error as { code?: unknown }).code)
    : 'INVALID_ARGUMENT'
  const message = error instanceof Error ? error.message : 'notification call failed'
  return { ok: false, error: { code, message } }
}

function textBlocks(value: unknown): CoordinationToolTextBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Build the definition. The centre is passed in rather than reached through the
 * composed service so the tool can be unit-tested without a database.
 */
export function coordinationNotificationToolDefinition(
  center: NotificationCenter,
  locale: Locale = 'zh-CN',
): CoordinationToolDefinition<NotificationToolResult> {
  const zh = normaliseLocale(locale) === 'zh-CN'
  return {
    name: 'coordination_notification',
    description: zh
      ? [
        '在当前 DSH Web GUI 弹一条通知（只显示，不等待回答）。',
        'surface 选 snackbar/alert/dialog/popover，severity 定颜色，duration 为自动关闭毫秒',
        '（0 等待；dialog 默认等待），actions 最多四个按钮且点击只关闭通知。',
        '需要用户回答请用 ask_user_question。',
      ].join(' ')
      : [
        'Pop a notification in this session\'s DSH Web GUI (display only; never waits).',
        'surface picks snackbar/alert/dialog/popover, severity sets the colour, duration is the',
        'auto-close delay in ms (0 waits; dialogs default to waiting), and actions adds up to four',
        'dismiss-only buttons. Use ask_user_question when you need an answer.',
      ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['surface', 'message'],
      properties: {
        surface: {
          type: 'string',
          enum: [...NOTIFICATION_SURFACES],
          description: zh
            ? '弹出方式：snackbar（右下角 toast）、alert（顶部横幅）、dialog（模态框）、popover（角落卡片）。'
            : 'Presentation: snackbar (bottom-right toast), alert (top banner), dialog (modal), popover (corner card).',
        },
        message: {
          type: 'string',
          description: zh
            ? `通知正文，1–${NOTIFICATION_LIMITS.message} 个字符；保留换行。`
            : `Notification body, 1–${NOTIFICATION_LIMITS.message} characters; newlines are preserved.`,
        },
        severity: {
          type: 'string',
          enum: [...NOTIFICATION_SEVERITIES],
          description: zh
            ? '颜色语义：success / info / warning / error；默认 info。'
            : 'Colour semantics: success / info / warning / error; defaults to info.',
        },
        title: {
          type: 'string',
          description: zh
            ? `可选标题，最多 ${NOTIFICATION_LIMITS.title} 个字符。`
            : `Optional title, at most ${NOTIFICATION_LIMITS.title} characters.`,
        },
        duration: {
          type: 'integer',
          minimum: 0,
          maximum: NOTIFICATION_LIMITS.maxDuration,
          description: zh
            ? `自动关闭毫秒数：0 表示等用户关闭；非零范围 ${NOTIFICATION_LIMITS.minDuration}–${NOTIFICATION_LIMITS.maxDuration}。`
            : `Auto-close delay in ms: 0 waits for the user; otherwise ${NOTIFICATION_LIMITS.minDuration}–${NOTIFICATION_LIMITS.maxDuration}.`,
        },
        anchor: {
          type: 'string',
          enum: [...NOTIFICATION_ANCHORS],
          description: zh
            ? '锚点位置（snackbar / alert / popover 适用）：top-left、top-center、top-right、bottom-left、bottom-center、bottom-right。'
            : 'Attachment point (snackbar / alert / popover): top-left, top-center, top-right, bottom-left, bottom-center, bottom-right.',
        },
        actions: {
          type: 'array',
          maxItems: NOTIFICATION_LIMITS.actions,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'label'],
            properties: {
              id: { type: 'string', description: zh ? '按钮标识（同一通知内唯一）。' : 'Button id (unique within the notification).' },
              label: { type: 'string', description: zh ? '按钮文字。' : 'Button label.' },
            },
          },
          description: zh
            ? '最多四个按钮；点击只关闭通知，不返回答案。'
            : 'Up to four buttons; clicking only dismisses the notification — no answer is returned.',
        },
        session: {
          type: 'string',
          description: zh
            ? '可选 DSH 会话 id；默认是调用本工具的 agent 会话。'
            : 'Optional DSH session id; defaults to the calling agent session.',
        },
      },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => textBlocks(value),
    },
    async execute(rawArgs: unknown, exec?: ToolExecution): Promise<NotificationToolResult> {
      try {
        const args = asArguments(rawArgs)
        const session = resolveSession(args, exec)
        const { item, queued, dropped } = center.push(session, args)
        return {
          ok: true,
          id: item.id,
          sequence: item.sequence,
          session: item.session,
          surface: item.surface,
          severity: item.severity,
          queued,
          ...(dropped > 0 ? { dropped } : {}),
        }
      } catch (error) {
        return failure(error)
      }
    },
  }
}
