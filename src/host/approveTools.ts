/**
 * `coordination_approve` — the model-facing consent dialog.
 *
 * The tool asks the human one explicit approve/reject question through a modal
 * dialog in the DSH Web GUI and **waits** for the answer. This is the blocking
 * counterpart of `coordination_notification`:
 *
 *  - `coordination_notification` is one-way; use it for "this finished";
 *  - `coordination_approve` is two-way; use it before a side effect the human
 *    should consent to;
 *  - `ask_user_question` is DSH's own multi-question tool and is the right choice
 *    when several structured answers are needed.
 *
 * The tool never turns silence into consent. A timeout, a withdrawn window, an
 * aborted turn or an unloaded plugin resolves to `expired` / `cancelled`, and
 * the result says so. Only an explicit click on the approve button produces
 * `approved`.
 */
import { APPROVAL_LIMITS } from '../shared/approve.js'
import type { ApprovalCenter } from './approve.js'
import type { CoordinationToolDefinition, CoordinationToolTextBlock, ToolExecution } from './tools.js'
import { normaliseLocale, type Locale } from '../shared/i18n.js'

/** The registered tool name. */
export type ApprovalToolName = 'coordination_approve'

/** Every successful and failing shape this tool returns, closed for the model. */
export interface ApprovalToolResult {
  ok: boolean
  id?: string
  session?: string
  outcome?: 'approved' | 'rejected' | 'cancelled' | 'expired'
  /** `true` when the window expired without an answer. */
  timedOut?: boolean
  error?: { code: string; message: string }
}

const RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    id: { type: 'string' },
    session: { type: 'string' },
    outcome: { type: 'string', enum: ['approved', 'rejected', 'cancelled', 'expired'] },
    timedOut: { type: 'boolean' },
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
    throw new Error('approval arguments must be a JSON object')
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

function failure(error: unknown): ApprovalToolResult {
  const code = typeof (error as { code?: unknown } | null)?.code === 'string'
    ? String((error as { code?: unknown }).code)
    : 'INVALID_ARGUMENT'
  const message = error instanceof Error ? error.message : 'approval call failed'
  return { ok: false, error: { code, message } }
}

function textBlocks(value: unknown): CoordinationToolTextBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Build the definition. The centre is injected so the tool is unit-testable
 * without a Cordis context, a webserver or a browser.
 */
export function coordinationApproveToolDefinition(
  center: ApprovalCenter,
  locale: Locale = 'zh-CN',
): CoordinationToolDefinition<ApprovalToolResult> {
  const zh = normaliseLocale(locale) === 'zh-CN'
  return {
    name: 'coordination_approve',
    description: zh
      ? [
        '通过 DSH Web GUI 模态框请用户批准/拒绝并等待点击；适合有副作用、需要同意的操作。',
        '超时或取消返回 expired/cancelled，绝不视为批准。只需通知用 coordination_notification；',
        '多个结构化问题用 ask_user_question。',
      ].join(' ')
      : [
        'Ask the human to approve or reject through a DSH Web GUI modal and wait for the click;',
        'use it before a side effect that needs consent. A timeout or withdrawal returns',
        'expired/cancelled and is never approval. For a one-way notice use coordination_notification;',
        'for structured answers use ask_user_question.',
      ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: {
        message: {
          type: 'string',
          description: zh
            ? `要问用户的问题，1–${APPROVAL_LIMITS.message} 个字符（对话框正文）。`
            : `The question shown in the dialog body, 1–${APPROVAL_LIMITS.message} characters.`,
        },
        title: {
          type: 'string',
          description: zh
            ? `可选标题，最多 ${APPROVAL_LIMITS.title} 个字符。`
            : `Optional title, at most ${APPROVAL_LIMITS.title} characters.`,
        },
        detail: {
          type: 'string',
          description: zh
            ? `可选的第二段说明（影响范围、代价、diff 摘要），最多 ${APPROVAL_LIMITS.detail} 个字符。`
            : `Optional second paragraph (scope, cost, a diff summary), at most ${APPROVAL_LIMITS.detail} characters.`,
        },
        approveLabel: {
          type: 'string',
          description: zh
            ? `批准按钮文字，最多 ${APPROVAL_LIMITS.label} 个字符；省略用本地化默认值。`
            : `Approve button label, at most ${APPROVAL_LIMITS.label} characters; omit for the localized default.`,
        },
        rejectLabel: {
          type: 'string',
          description: zh
            ? `拒绝按钮文字，最多 ${APPROVAL_LIMITS.label} 个字符；省略用本地化默认值。`
            : `Reject button label, at most ${APPROVAL_LIMITS.label} characters; omit for the localized default.`,
        },
        timeout: {
          type: 'integer',
          minimum: APPROVAL_LIMITS.minTimeout,
          maximum: APPROVAL_LIMITS.maxTimeout,
          description: zh
            ? `等待毫秒数，${APPROVAL_LIMITS.minTimeout}–${APPROVAL_LIMITS.maxTimeout}，默认 ${APPROVAL_LIMITS.defaultTimeout}。`
            : `Wait in milliseconds, ${APPROVAL_LIMITS.minTimeout}–${APPROVAL_LIMITS.maxTimeout}; defaults to ${APPROVAL_LIMITS.defaultTimeout}.`,
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
    async execute(rawArgs: unknown, exec?: ToolExecution): Promise<ApprovalToolResult> {
      try {
        const args = asArguments(rawArgs)
        const session = resolveSession(args, exec)
        const opened = center.open(session, args)
        const signal = exec?.signal
        let onAbort: (() => void) | undefined
        if (signal !== undefined) {
          if (signal.aborted) {
            // The turn is already over: withdraw the window instead of leaving a
            // dialog the user could answer for a call nobody is waiting on.
            center.cancel(session, opened.id)
          } else {
            onAbort = () => { center.cancel(session, opened.id) }
            signal.addEventListener('abort', onAbort, { once: true })
          }
        }
        try {
          const outcome = await opened.promise
          return {
            ok: true,
            id: opened.id,
            session,
            outcome,
            timedOut: outcome === 'expired',
          }
        } finally {
          if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
        }
      } catch (error) {
        return failure(error)
      }
    },
  }
}
