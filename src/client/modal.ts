/** Modal shell shared by takeover dialogs and model notifications.
 *
 * This deliberately uses MUI's `Dialog` rather than a native `<dialog>`:
 * takeover can open a notification while an approval/question modal is already
 * open, and two native top-layer dialogs made the second one unreliable (and a
 * `showModal()` exception unmounted the whole dock entry). MUI's portal stacks
 * modals in one z-index ladder, which is also the host's own pattern.
 */
import * as React from 'react'
import Dialog from '@mui/material/Dialog'
import Paper from '@mui/material/Paper'

const h = React.createElement
const MuiDialog = Dialog as unknown as React.ComponentType<Record<string, unknown>>
const MuiPaper = Paper as unknown as React.ComponentType<Record<string, unknown>>

export interface BlockingDialogProps {
  titleId: string
  children?: React.ReactNode
}

export function BlockingDialog({ titleId, children }: BlockingDialogProps): React.ReactElement {
  return h(
    MuiDialog,
    {
      open: true,
      onClose: (event: { preventDefault?: () => void }) => {
        // Light-dismiss and Escape leave the request pending. Only an explicit
        // action in the dialog may settle it.
        event.preventDefault?.()
      },
      disableEscapeKeyDown: true,
      maxWidth: 'sm',
      fullWidth: true,
      'aria-labelledby': titleId,
      slotProps: {
        paper: {
          sx: {
            borderRadius: 3,
            color: 'var(--dsw-alias-label-primary, #202124)',
            background: 'var(--dsw-alias-bg-base, #fff)',
            overflow: 'hidden',
          },
        },
      },
    },
    h(
      MuiPaper,
      {
        elevation: 0,
        sx: {
          color: 'inherit',
          bgcolor: 'inherit',
          p: 3,
          overflowWrap: 'anywhere',
          maxHeight: 'calc(100dvh - 64px)',
          overflowY: 'auto',
        },
      },
      children,
    ),
  )
}
