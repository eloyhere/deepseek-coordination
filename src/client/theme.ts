/**
 * The plugin's own Material UI theme.
 *
 * The plugin must not reach into the host's theme, so it builds one compact
 * palette locally. `sx`/style objects stay hoisted at call sites so an
 * unrelated composer render never regenerates an emotion rule (the host closes
 * its popovers on outside `<head>` mutation).
 */
import { createTheme } from '@mui/material/styles'

export const theme = createTheme({
  typography: { fontSize: 12 },
  components: {
    MuiSelect: { defaultProps: { size: 'small' } },
    MuiMenuItem: { styleOverrides: { root: { fontSize: 12, minHeight: 28 } } },
    MuiTooltip: {
      defaultProps: { arrow: true, enterDelay: 300, enterNextDelay: 150 },
      styleOverrides: {
        tooltip: {
          fontSize: 12,
          lineHeight: 1.55,
          maxWidth: 340,
          padding: '6px 10px',
          whiteSpace: 'normal',
        },
        arrow: { fontSize: 12 },
      },
    },
  },
})
