/**
 * Client half of `coordination_approve`: the consent dialog.
 *
 * It polls `/deepseek-coordination/approve/pending?session=<id>` once per
 * second while the document is visible and renders the oldest waiting request
 * as a modal MUI dialog. Unlike the takeover dialog it is **not** gated by a
 * local switch: the model asked for a specific human decision and the tool call
 * is blocked until that decision arrives (or the window expires).
 *
 * Rules kept deliberately:
 *
 *  - the answer is explicit: 批准 / 拒绝 are separate buttons and Esc, the
 *    backdrop and 取消 all mean `cancelled` — never "approved";
 *  - one POST at a time (`busy` plus a ref), so a double click cannot send two
 *    decisions;
 *  - a failed POST keeps the dialog open with an inline error; the next poll can
 *    still recover;
 *  - the countdown is derived from the host's `expires`, so it agrees with the
 *    timer the tool actually awaits;
 *  - an older host without the route stops the poll instead of retrying forever.
 */
import * as React from 'react'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import Typography from '@mui/material/Typography'
import { currentLocale, useCopy } from './i18n.js'
import { usableSession } from './bridge.js'
import { fillTemplate } from '../shared/i18n.js'
import type { Locale } from '../shared/i18n.js'
import type { ApprovalView } from '../shared/approve.js'

const h = React.createElement

type MuiComponent = React.ComponentType<Record<string, unknown>>
const MuiButton = Button as unknown as MuiComponent
const MuiDialog = Dialog as unknown as MuiComponent
const MuiDialogActions = DialogActions as unknown as MuiComponent
const MuiDialogContent = DialogContent as unknown as MuiComponent
const MuiDialogContentText = DialogContentText as unknown as MuiComponent
const MuiDialogTitle = DialogTitle as unknown as MuiComponent
const MuiTypography = Typography as unknown as MuiComponent

const ROUTE = '/deepseek-coordination/approve'
const POLL_INTERVAL = 1000
const REQUEST_TIMEOUT = 2500
/** Stable id linking the dialog's accessible name to its title. */
const TITLE_ID = 'deepseek-coordination-approval-title'

const LABELS: Readonly<Record<Locale, {
  title: string
  approve: string
  reject: string
  cancel: string
  expires: string
  failed: string
}>> = {
  'zh-CN': {
    title: '需要你的确认',
    approve: '批准',
    reject: '拒绝',
    cancel: '取消',
    expires: '剩余 {seconds} 秒后自动取消',
    failed: '提交失败，请重试。',
  },
  'en-US': {
    title: 'Confirmation required',
    approve: 'Approve',
    reject: 'Reject',
    cancel: 'Cancel',
    expires: 'Auto-cancels in {seconds}s',
    failed: 'Could not submit; try again.',
  },
}

function labelsOf(locale: Locale): (typeof LABELS)[Locale] {
  return LABELS[locale] ?? LABELS['en-US']
}

const BODY_STYLE: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
const DETAIL_STYLE: React.CSSProperties = { ...BODY_STYLE, marginTop: 8, opacity: 0.8 }

/** One parsed approval from the wire; anything else is dropped. */
function isApprovalView(value: unknown): value is ApprovalView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.session === 'string'
    && typeof record.message === 'string'
    && typeof record.expires === 'number'
}

interface Wire<T> {
  ok?: boolean
  value?: T
  error?: { code?: string; message?: string }
}

async function call<T>(path: string, init?: RequestInit): Promise<{ status: number | null; wire: Wire<T> | null }> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await fetch(`${ROUTE}${path}`, {
      ...init,
      signal: controller.signal,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const text = await response.text()
    if (text.length === 0) return { status: response.status, wire: null }
    try {
      return { status: response.status, wire: JSON.parse(text) as Wire<T> }
    } catch {
      return { status: response.status, wire: null }
    }
  } catch {
    return { status: null, wire: null }
  } finally {
    window.clearTimeout(timer)
  }
}

/** Pending requests for one session; `unsupported` marks an older host build. */
async function fetchPending(session: string): Promise<{ items: ApprovalView[]; unsupported: boolean }> {
  const { status, wire } = await call<{ items?: unknown }>(`/pending?session=${encodeURIComponent(session)}`)
  if (status === 404) return { items: [], unsupported: true }
  if (wire === null || wire.ok !== true) return { items: [], unsupported: false }
  const items = wire.value?.items
  if (!Array.isArray(items)) return { items: [], unsupported: false }
  return { items: items.filter(isApprovalView), unsupported: false }
}

async function sendAnswer(session: string, id: string, approved: boolean): Promise<boolean> {
  const { wire } = await call<{ answered?: boolean }>('/answer', {
    method: 'POST',
    body: JSON.stringify({ session, id, approved }),
  })
  return wire !== null && wire.ok === true && wire.value?.answered === true
}

async function sendCancel(session: string, id: string): Promise<boolean> {
  const { wire } = await call<{ cancelled?: boolean }>('/cancel', {
    method: 'POST',
    body: JSON.stringify({ session, id }),
  })
  return wire !== null && wire.ok === true && wire.value?.cancelled === true
}

export interface ApprovalDialogProps {
  sessionId?: string
}

/**
 * Poll and render the oldest pending approval for one session.
 *
 * Mounted beside the takeover dialog in the composer slot, so it exists exactly
 * where the plugin's client half is loaded and the session id is known.
 */
export function ApprovalDialog(props: ApprovalDialogProps): React.ReactElement | null {
  useCopy()
  const locale = currentLocale()
  const labels = labelsOf(locale)
  const session = usableSession(props.sessionId) ? props.sessionId.trim() : null
  const [items, setItems] = React.useState<readonly ApprovalView[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [now, setNow] = React.useState(() => Date.now())
  const actionRef = React.useRef(false)

  React.useEffect(() => {
    if (session === null) return
    let stopped = false
    const tick = async (): Promise<void> => {
      if (stopped) return
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      const outcome = await fetchPending(session)
      if (stopped) return
      if (outcome.unsupported) {
        stopped = true
        return
      }
      setItems((previous) => {
        if (previous.length === outcome.items.length && previous[0]?.id === outcome.items[0]?.id) {
          return previous
        }
        return outcome.items
      })
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, POLL_INTERVAL)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [session])

  // Keep the countdown honest while a window is open.
  React.useEffect(() => {
    if (items.length === 0) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [items.length])

  const current = items[0]

  /** Settle the current window; the dialog clears only after the host agrees. */
  const settle = React.useCallback(async (approved: boolean | null): Promise<void> => {
    if (session === null || current === undefined || actionRef.current) return
    actionRef.current = true
    setBusy(true)
    setError(null)
    try {
      const ok = approved === null
        ? await sendCancel(session, current.id)
        : await sendAnswer(session, current.id, approved)
      if (!ok) {
        setError(labels.failed)
        return
      }
      setItems((previous) => previous.filter((item) => item.id !== current.id))
    } finally {
      actionRef.current = false
      setBusy(false)
    }
  }, [current, labels.failed, session])

  if (current === undefined) return null
  const remaining = Math.max(0, Math.ceil((current.expires - now) / 1000))
  const queue = items.length > 1 ? `${items.length}` : null

  return h(
    MuiDialog,
    {
      open: true,
      onClose: () => { void settle(null) },
      fullWidth: true,
      maxWidth: 'sm',
      'aria-labelledby': TITLE_ID,
    },
    h(
      MuiDialogTitle,
      { id: TITLE_ID, sx: { display: 'flex', alignItems: 'center', gap: 1 } },
      h('span', { style: { flex: 1 } }, current.title ?? labels.title),
      queue === null ? null : h(MuiTypography, { variant: 'caption', color: 'text.secondary' }, `1 / ${queue}`),
    ),
    h(
      MuiDialogContent,
      null,
      h(MuiDialogContentText, { component: 'div', sx: BODY_STYLE }, current.message),
      current.detail === undefined
        ? null
        : h(MuiDialogContentText, { component: 'div', sx: DETAIL_STYLE }, current.detail),
      h(
        MuiTypography,
        { variant: 'caption', color: 'text.secondary', component: 'p', sx: { mt: 1, mb: 0 } },
        fillTemplate(labels.expires, { seconds: String(remaining) }),
      ),
      error === null
        ? null
        : h(
          MuiTypography,
          { role: 'alert', variant: 'caption', color: 'error', component: 'p', sx: { mt: 1, mb: 0 } },
          error,
        ),
    ),
    h(
      MuiDialogActions,
      null,
      h(MuiButton, { onClick: () => { void settle(null) }, disabled: busy }, labels.cancel),
      h(
        MuiButton,
        { color: 'inherit', onClick: () => { void settle(false) }, disabled: busy },
        current.rejectLabel ?? labels.reject,
      ),
      h(
        MuiButton,
        { variant: 'contained', color: 'primary', onClick: () => { void settle(true) }, disabled: busy },
        current.approveLabel ?? labels.approve,
      ),
    ),
  )
}
