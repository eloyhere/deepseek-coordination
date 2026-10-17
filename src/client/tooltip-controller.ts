/**
 * One global tooltip host for the composer dropdowns.
 *
 * The five dropdowns do not own Tooltip instances. They only publish one
 * "active tooltip" request (id + title + anchor rectangle); this host renders
 * the single MUI Tooltip. That removes the per-control open/close state machine,
 * guarantees at most one tooltip exists, and makes "close on click / selection /
 * mouseleave / menu open" a single store operation.
 *
 * Closing is immediate in state, with a short Fade exit. The popper is
 * pointer-transparent, so even the exit animation can never cover a Select menu.
 */
import * as React from 'react'
import Tooltip from '@mui/material/Tooltip'
import Fade from '@mui/material/Fade'

/** The part of an anchor element the tooltip needs; DOMRect is copied. */
export interface TooltipAnchorRect {
  left: number
  top: number
  width: number
  height: number
}

export interface ActiveTooltip {
  id: string
  title: React.ReactNode
  rect: TooltipAnchorRect
  placement: 'left' | 'right'
}

/** MUI's generics describe every overload; this host passes one narrow shape. */
const MuiTooltip: React.ComponentType<Record<string, unknown>> =
  Tooltip as unknown as React.ComponentType<Record<string, unknown>>
const MuiFade: React.ComponentType<Record<string, unknown>> =
  Fade as unknown as React.ComponentType<Record<string, unknown>>

const EXIT_MS = 160

let active: ActiveTooltip | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function rectOf(anchor: HTMLElement): TooltipAnchorRect {
  const rect = anchor.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

export const tooltipController = {
  /** Show (or replace) the one active tooltip. Hover replaces, never queues. */
  show(input: { id: string; title: React.ReactNode; anchor: HTMLElement; placement?: 'left' | 'right' }): void {
    if (typeof document === 'undefined') return
    active = {
      id: input.id,
      title: input.title,
      rect: rectOf(input.anchor),
      placement: input.placement ?? 'right',
    }
    emit()
  },

  /** Hide the active tooltip, or only when `id` still owns it. */
  hide(id?: string): void {
    if (active === null) return
    if (id !== undefined && active.id !== id) return
    active = null
    emit()
  },

  hideAll(): void {
    if (active === null) return
    active = null
    emit()
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },

  getSnapshot(): ActiveTooltip | null {
    return active
  },
}

/** The single tooltip renderer. Mount once per composer, not once per control. */
export function TooltipHost(): React.ReactElement | null {
  const current = React.useSyncExternalStore(
    tooltipController.subscribe,
    tooltipController.getSnapshot,
    tooltipController.getSnapshot,
  )
  const [rendered, setRendered] = React.useState<ActiveTooltip | null>(current)
  const [open, setOpen] = React.useState(current !== null)

  React.useEffect(() => {
    if (current !== null) {
      setRendered(current)
      setOpen(true)
      return
    }
    setOpen(false)
    const timer = window.setTimeout(() => { setRendered(null) }, EXIT_MS)
    return () => { window.clearTimeout(timer) }
  }, [current])

  React.useEffect(() => {
    const hide = (): void => { tooltipController.hideAll() }
    // A pointer down anywhere, a menu opening, or a scroll invalidates the
    // anchor rectangle; hiding is the only state that cannot be stale.
    document.addEventListener('pointerdown', hide, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      document.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [])

  if (rendered === null) return null

  const anchor = React.createElement('span', {
    style: {
      position: 'fixed',
      left: `${rendered.rect.left}px`,
      top: `${rendered.rect.top}px`,
      width: `${Math.max(1, rendered.rect.width)}px`,
      height: `${Math.max(1, rendered.rect.height)}px`,
      pointerEvents: 'none',
    },
  })

  return React.createElement(
    MuiTooltip,
    {
      open,
      title: rendered.title,
      placement: rendered.placement,
      describeChild: true,
      disableInteractive: true,
      leaveDelay: 0,
      TransitionComponent: MuiFade,
      slotProps: {
        transition: {
          timeout: { enter: 90, exit: EXIT_MS },
          easing: {
            enter: 'cubic-bezier(0.2, 0, 0, 1)',
            exit: 'cubic-bezier(0.4, 0, 1, 1)',
          },
        },
        popper: { style: { pointerEvents: 'none' } },
      },
    },
    anchor,
  )
}
