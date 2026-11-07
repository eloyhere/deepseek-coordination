/** Native top-layer modal; MUI supplies its content, the browser makes the page inert. */
import * as React from 'react'
import { createPortal } from 'react-dom'
import Paper from '@mui/material/Paper'

const h = React.createElement
const MuiPaper = Paper as unknown as React.ComponentType<Record<string, unknown>>
let openDialogs = 0
let previousOverflow = ''

export interface BlockingDialogProps {
  titleId: string
  children?: React.ReactNode
}

export function BlockingDialog({ titleId, children }: BlockingDialogProps): React.ReactElement | null {
  const ref = React.useRef<HTMLDialogElement>(null)
  React.useLayoutEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    if (openDialogs++ === 0) previousOverflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
    dialog.showModal()
    return () => {
      dialog.close()
      if (--openDialogs === 0) document.documentElement.style.overflow = previousOverflow
    }
  }, [])
  if (typeof document === 'undefined') return null
  return createPortal(h(React.Fragment, null,
    h('style', null, '.amp-blocking-dialog::backdrop{background:rgb(0 0 0 / 50%)}'),
    h('dialog', {
      ref,
      className: 'amp-blocking-dialog',
      'data-amp-dialog': true,
      'aria-labelledby': titleId,
      'aria-modal': true,
      // Both light-dismiss and Escape must leave the request pending. Only an
      // explicit action in the dialog may settle it.
      onCancel: (event: React.SyntheticEvent) => event.preventDefault(),
      onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation(),
      style: {
        padding: 0, border: 0, borderRadius: 12, margin: 'auto',
        width: 'min(600px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 48px)',
        color: 'var(--dsw-alias-label-primary, #202124)',
        background: 'var(--dsw-alias-bg-base, #fff)',
      },
    }, h(MuiPaper, {
      elevation: 0,
      sx: { color: 'inherit', bgcolor: 'inherit', p: 3, overflowWrap: 'anywhere' },
    }, children)),
  ), document.body)
}
