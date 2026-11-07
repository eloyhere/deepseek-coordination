/**
 * Client half of `coordination_notification`: the surface host.
 *
 * It polls `/deepseek-coordination/notify/pending?session=<id>` once per
 * {@link POLL_INTERVAL} while the document is visible, keeps a short local
 * queue, and renders exactly one notification at a time:
 *
 *  - `snackbar` — a transient bottom-right toast with an MUI `Alert` inside;
 *  - `alert`    — a fixed top banner that stays until its delay ends;
 *  - `dialog`   — a modal that waits for the user (no auto-close by default);
 *  - `popover`  — a small card anchored to one viewport corner.
 *
 * Rules kept deliberately:
 *  - delivery is one-way: a button only dismisses, no answer is sent back, so
 *    nothing here can block the agent loop;
 *  - `close(id)` is idempotent per item: the MUI `onClose` and the local
 *    auto-close timer can both fire, and a second call must not skip the next
 *    queued notification;
 *  - auto-close runs on the component's own timer, not on Snackbar's
 *    `autoHideDuration`, so every surface shares one scheduling rule;
 *  - a host without the route (an older build) stops polling after the first
 *    404 instead of retrying forever;
 *  - a fetch failure never throws into render: the next tick simply retries.
 */
import * as React from 'react'
import Alert from '@mui/material/Alert'
import Snackbar from '@mui/material/Snackbar'
import { BlockingDialog } from './modal.js'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogActions from '@mui/material/DialogActions'
import Popover from '@mui/material/Popover'
import Paper from '@mui/material/Paper'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useCopy } from './i18n.js'
import { useAmpPreferences } from './preferences.js'
import { usableSession } from './bridge.js'
import type { Copy } from '../shared/i18n.js'

import type { NotificationAnchor, NotificationItem, NotificationSeverity } from '../shared/notification.js'

const h = React.createElement

/* MUI's generics describe every overload; this module passes one narrow shape. */
type MuiComponent = React.ComponentType<Record<string, unknown>>
const MuiSnackbar = Snackbar as unknown as MuiComponent
const MuiAlert = Alert as unknown as MuiComponent
const MuiDialogTitle = DialogTitle as unknown as MuiComponent
const MuiDialogContent = DialogContent as unknown as MuiComponent
const MuiDialogContentText = DialogContentText as unknown as MuiComponent
const MuiDialogActions = DialogActions as unknown as MuiComponent
const MuiPopover = Popover as unknown as MuiComponent
const MuiPaper = Paper as unknown as MuiComponent
const MuiButton = Button as unknown as MuiComponent
const MuiTypography = Typography as unknown as MuiComponent

const ROUTE = '/deepseek-coordination/notify/pending'
/** One poll every 1.2 s: the tool call lands in the GUI within a beat. */
const POLL_INTERVAL = 1200
/** A slow host must not stack requests. */
const POLL_TIMEOUT = 2000
/** Client-side bound on the local queue; the host already bounds its own. */
const MAX_LOCAL_QUEUE = 16

const ALERT_HOST_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: 16,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 1400,
  width: 'min(560px, calc(100vw - 32px))',
}

const BODY_STYLE: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
const ACTIONS_STYLE: React.CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }

/** One parsed notification from the wire; anything else is dropped. */
function isNotificationItem(value: unknown): value is NotificationItem {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.surface === 'string'
    && typeof record.message === 'string'
    && typeof record.duration === 'number'
}

/**
 * Read and drain the pending items for one session.
 *
 * `stopped` is set by the caller when the route answers 404 (an older host
 * build): the polling loop then stays idle instead of hammering a missing
 * endpoint. Any other failure returns an empty list and retries next tick.
 */
async function fetchPending(session: string): Promise<{ items: NotificationItem[]; unsupported: boolean }> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), POLL_TIMEOUT)
  try {
    const response = await fetch(`${ROUTE}?session=${encodeURIComponent(session)}`, {
      signal: controller.signal,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (response.status === 404) return { items: [], unsupported: true }
    if (!response.ok) return { items: [], unsupported: false }
    const text = await response.text()
    if (text.length === 0) return { items: [], unsupported: false }
    let body: { ok?: boolean; value?: { items?: unknown } }
    try {
      body = JSON.parse(text) as { ok?: boolean; value?: { items?: unknown } }
    } catch {
      return { items: [], unsupported: false }
    }
    if (body.ok !== true || !Array.isArray(body.value?.items)) return { items: [], unsupported: false }
    return { items: body.value.items.filter(isNotificationItem), unsupported: false }
  } catch {
    return { items: [], unsupported: false }
  } finally {
    window.clearTimeout(timer)
  }
}

/** MUI Snackbar `anchorOrigin` for one anchor id. */
function snackbarOrigin(anchor: NotificationAnchor): { vertical: 'top' | 'bottom'; horizontal: 'left' | 'center' | 'right' } {
  const [vertical, horizontal] = anchor.split('-')
  return {
    vertical: vertical === 'top' ? 'top' : 'bottom',
    horizontal: horizontal === 'left' ? 'left' : horizontal === 'right' ? 'right' : 'center',
  }
}

/** Viewport coordinates MUI's `anchorPosition` expects, in pixels. */
function anchorPosition(anchor: NotificationAnchor): { top: number; left: number } {
  const width = typeof window === 'undefined' ? 1280 : window.innerWidth
  const height = typeof window === 'undefined' ? 800 : window.innerHeight
  const margin = 24
  const [vertical, horizontal] = anchor.split('-')
  return {
    top: vertical === 'top' ? margin : height - margin,
    left: horizontal === 'left' ? margin : horizontal === 'right' ? width - margin : width / 2,
  }
}

/** The `transformOrigin` that grows the card away from its anchor corner. */
function transformOrigin(anchor: NotificationAnchor): { vertical: 'top' | 'bottom'; horizontal: 'left' | 'center' | 'right' } {
  return snackbarOrigin(anchor)
}

/** Title plus body, shared by every surface. */
function bodyOf(item: NotificationItem): React.ReactElement {
  return h(
    React.Fragment,
    null,
    item.title === undefined
      ? null
      : h(MuiTypography, { component: 'div', sx: { fontWeight: 600, fontSize: 13, marginBottom: 2 } }, item.title),
    h(MuiTypography, { component: 'div', sx: { ...BODY_STYLE, fontSize: 13 } }, item.message),
  )
}

/** One surface element; the caller owns open/close state. */
function renderSurface(item: NotificationItem, labels: Copy, dismiss: () => void): React.ReactElement {
  const severity = item.severity as NotificationSeverity
  const body = bodyOf(item)

  if (item.surface === 'dialog') {
    return h(
      BlockingDialog,
      { key: item.id, titleId: `amp-notice-${item.id}` },
      h(MuiDialogTitle, { id: `amp-notice-${item.id}` }, item.title ?? labels.notification),
      h(
        MuiDialogContent,
        null,
        h(MuiDialogContentText, { component: 'div', sx: BODY_STYLE }, item.message),
      ),
      h(
        MuiDialogActions,
        null,
        ...item.actions.map((action) => h(MuiButton, { key: action.id, onClick: dismiss }, action.label)),
        h(MuiButton, { variant: 'contained', onClick: dismiss }, labels.dismiss),
      ),
    )
  }

  if (item.surface === 'alert') {
    return h(
      'div',
      { key: item.id, style: ALERT_HOST_STYLE },
      h(
        MuiAlert,
        { severity, variant: 'filled', onClose: dismiss, elevation: 6 },
        item.title === undefined
          ? h('div', { style: BODY_STYLE }, item.message)
          : h(
            'div',
            null,
            h('div', { style: { fontWeight: 600, marginBottom: 2 } }, item.title),
            h('div', { style: BODY_STYLE }, item.message),
          ),
      ),
    )
  }

  if (item.surface === 'popover') {
    return h(
      MuiPopover,
      {
        key: item.id,
        open: true,
        anchorReference: 'anchorPosition',
        anchorPosition: anchorPosition(item.anchor),
        transformOrigin: transformOrigin(item.anchor),
        onClose: dismiss,
      },
      h(
        MuiPaper,
        { sx: { maxWidth: 420, padding: 1.5 } },
        body,
        h(
          'div',
          { style: ACTIONS_STYLE },
          ...item.actions.map((action) => h(MuiButton, { key: action.id, size: 'small', onClick: dismiss }, action.label)),
          h(MuiButton, { size: 'small', variant: 'text', onClick: dismiss }, labels.close),
        ),
      ),
    )
  }

  // snackbar (the declared fallback for an unknown surface from a newer host).
  return h(
    MuiSnackbar,
    {
      key: item.id,
      open: true,
      onClose: dismiss,
      anchorOrigin: snackbarOrigin(item.anchor),
      sx: { maxWidth: 520 },
    },
    h(MuiAlert, { severity, variant: 'filled', onClose: dismiss, elevation: 6 }, body),
  )
}

export interface NotificationHostProps {
  sessionId?: string
}

/**
 * Poll and render notifications for one session.
 *
 * Mounted as a sibling of the takeover dialog in the composer slot, so it
 * exists exactly where the plugin's client half is loaded and the session id is
 * known.
 */
export function NotificationHost(props: NotificationHostProps): React.ReactElement | null {
  // Subscribe to locale changes for the button labels; the copy is the
  // re-render trigger and the labels the active surface reads.
  const copy = useCopy()
  const { preferences } = useAmpPreferences()
  const session = usableSession(props.sessionId) ? props.sessionId.trim() : null
  const [queue, setQueue] = React.useState<readonly NotificationItem[]>([])

  React.useEffect(() => {
    if (session === null) return
    if (!preferences.takeoverNotifications) {
      setQueue([])
      return
    }
    let stopped = false
    const tick = async (): Promise<void> => {
      if (stopped) return
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      const outcome = await fetchPending(session)
      if (stopped) return
      if (outcome.unsupported) {
        // An older host build has no route: stop polling, keep the plugin quiet.
        stopped = true
        return
      }
      if (outcome.items.length === 0) return
      setQueue((current) => [...current, ...outcome.items].slice(-MAX_LOCAL_QUEUE))
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, POLL_INTERVAL)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [session, preferences.takeoverNotifications])

  const current = queue[0]

  /**
   * Remove the first item only when it is still the one being closed. Both the
   * local timer and MUI's own `onClose` call this, and a second call for an item
   * that already left must not remove its successor.
   */
  const close = React.useCallback((id: string): void => {
    setQueue((current) => (current[0] !== undefined && current[0].id === id ? current.slice(1) : current))
  }, [])

  // Auto-close for every surface that has a delay; `0` waits for the user.
  React.useEffect(() => {
    if (current === undefined || current.surface === 'dialog' || current.duration <= 0) return undefined
    const timer = window.setTimeout(() => { close(current.id) }, current.duration)
    return () => { window.clearTimeout(timer) }
  }, [current, close])

  if (!preferences.takeoverNotifications) return null
  if (current === undefined) return null
  return renderSurface(current, copy, () => { close(current.id) })
}
