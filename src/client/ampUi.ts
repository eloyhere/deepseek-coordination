/**
 * Shared MUI building blocks for the AMP surfaces.
 *
 * DSH ships its own design tokens as CSS custom properties rather than an MUI
 * theme, so every visible colour is read from a `--dsw-alias-*` token with a
 * neutral fallback. Components stay plain MUI (Paper, Stack, Chip, Typography,
 * …) and only the token mapping lives here.
 */
import * as React from 'react'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import Paper from '@mui/material/Paper'
import Chip from '@mui/material/Chip'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import Divider from '@mui/material/Divider'
import Skeleton from '@mui/material/Skeleton'
import Alert from '@mui/material/Alert'
import AlertTitle from '@mui/material/AlertTitle'
import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import TextField from '@mui/material/TextField'
import InputAdornment from '@mui/material/InputAdornment'
import Accordion from '@mui/material/Accordion'
import AccordionSummary from '@mui/material/AccordionSummary'
import AccordionDetails from '@mui/material/AccordionDetails'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Switch from '@mui/material/Switch'
import CircularProgress from '@mui/material/CircularProgress'
import SmartToy from '@mui/icons-material/SmartToy'
import Dns from '@mui/icons-material/Dns'
import VisibilityOff from '@mui/icons-material/VisibilityOff'
import Hub from '@mui/icons-material/Hub'
import ErrorIcon from '@mui/icons-material/Error'
import Inbox from '@mui/icons-material/Inbox'
import RefreshIcon from '@mui/icons-material/Refresh'
import FolderOpen from '@mui/icons-material/FolderOpen'
import EditNote from '@mui/icons-material/EditNote'
import NotificationsActive from '@mui/icons-material/NotificationsActive'
import Tune from '@mui/icons-material/Tune'
import DensitySmall from '@mui/icons-material/DensitySmall'
import Autorenew from '@mui/icons-material/Autorenew'
import Memory from '@mui/icons-material/Memory'
import SearchIcon from '@mui/icons-material/Search'

type Loose = React.ComponentType<Record<string, unknown>>
type Icon = React.ComponentType<Record<string, unknown>>

const cast = <T,>(value: T): Loose => value as unknown as Loose

/**
 * MUI v9's Stack no longer forwards system props such as `alignItems` to the
 * style engine; they would land on the DOM as lowercase attributes. Consume the
 * three layout props this plugin uses and fold them into `sx` so every Stack in
 * both surfaces keeps its intended alignment.
 */
const StackBase = cast(Stack)
const StackCompat = (props: Record<string, unknown>): React.ReactElement => {
  const { alignItems, justifyContent, flexWrap, sx, ...rest } = props
  const base = typeof sx === 'object' && sx !== null ? sx as Record<string, unknown> : {}
  return h(StackBase, {
    ...rest,
    sx: {
      ...(flexWrap === undefined ? {} : { flexWrap }),
      ...(alignItems === undefined ? {} : { alignItems }),
      ...(justifyContent === undefined ? {} : { justifyContent }),
      ...base,
    },
  })
}

/** Trimmed MUI surface used by both client components. */
export const M = {
  Box: cast(Box),
  Stack: StackCompat,
  Typography: cast(Typography),
  Paper: cast(Paper),
  Chip: cast(Chip),
  Button: cast(Button),
  ButtonBase: cast(ButtonBase),
  IconButton: cast(IconButton),
  Tooltip: cast(Tooltip),
  Divider: cast(Divider),
  Skeleton: cast(Skeleton),
  Alert: cast(Alert),
  AlertTitle: cast(AlertTitle),
  Tabs: cast(Tabs),
  Tab: cast(Tab),
  TextField: cast(TextField),
  InputAdornment: cast(InputAdornment),
  Accordion: cast(Accordion),
  AccordionSummary: cast(AccordionSummary),
  AccordionDetails: cast(AccordionDetails),
  List: cast(List),
  ListItem: cast(ListItem),
  ListItemIcon: cast(ListItemIcon),
  ListItemText: cast(ListItemText),
  Dialog: cast(Dialog),
  DialogTitle: cast(DialogTitle),
  DialogContent: cast(DialogContent),
  DialogActions: cast(DialogActions),
  ToggleButton: cast(ToggleButton),
  ToggleButtonGroup: cast(ToggleButtonGroup),
  Switch: cast(Switch),
  CircularProgress: cast(CircularProgress),
}

const iconCast = (value: unknown): Icon => value as unknown as Icon

export const Icons = {
  agent: iconCast(SmartToy),
  host: iconCast(Dns),
  hidden: iconCast(VisibilityOff),
  other: iconCast(Hub),
  fileRead: iconCast(FolderOpen),
  fileWrite: iconCast(EditNote),
  search: iconCast(SearchIcon),
  notifications: iconCast(NotificationsActive),
  context: iconCast(Memory),
  otherSwitches: iconCast(Tune),
  autoRefresh: iconCast(Autorenew),
  compact: iconCast(DensitySmall),
  error: iconCast(ErrorIcon),
  empty: iconCast(Inbox),
}

export const h = React.createElement

/**
 * DSH token aliases. The fallbacks are only a last resort for a host that has
 * not mounted the theme provider; both light and dark hosts supply the vars.
 */
export const T = {
  text: 'var(--dsw-alias-label-primary, currentColor)',
  secondary: 'var(--dsw-alias-label-secondary, currentColor)',
  tertiary: 'var(--dsw-alias-label-tertiary, currentColor)',
  caption: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, currentColor))',
  border: 'var(--dsw-alias-border-l1, rgba(127,127,127,.22))',
  borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,.34))',
  surface: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))',
  raised: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.09))',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1))',
  accent: 'var(--dsw-alias-state-business-primary, #2563eb)',
  success: 'var(--dsw-alias-state-success-primary, #16a34a)',
  warning: 'var(--dsw-alias-state-warning-primary, #d97706)',
  error: 'var(--dsw-alias-state-error-primary, #dc2626)',
  radius: 'var(--dsw-radius-md, 8px)',
  radiusSm: 'var(--dsw-radius-sm, 6px)',
  radiusLg: 'var(--dsw-radius-lg, 12px)',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  elevation: 'var(--dsw-elevation-prominent, 0 18px 48px rgba(0,0,0,.18))',
  focus: 'var(--dsw-focus-ring-color, #2563eb)',
} as const

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'error'

const toneColor: Record<Tone, string> = {
  neutral: T.secondary,
  accent: T.accent,
  success: T.success,
  warning: T.warning,
  error: T.error,
}

/** Outlined chip with token-driven ink and a soft tinted fill. */
export function chipSx(tone: Tone = 'neutral', height = 20): Record<string, unknown> {
  const color = toneColor[tone]
  return {
    height,
    maxWidth: '100%',
    fontSize: 10.5,
    lineHeight: 1.2,
    fontWeight: 600,
    letterSpacing: '.01em',
    color,
    borderRadius: '999px',
    border: '1px solid',
    borderColor: tone === 'neutral' ? T.border : `color-mix(in srgb, ${color} 34%, transparent)`,
    backgroundColor: tone === 'neutral' ? 'transparent' : `color-mix(in srgb, ${color} 10%, transparent)`,
    '& .MuiChip-label': { px: 0.75, overflow: 'hidden', textOverflow: 'ellipsis' },
    '& .MuiChip-icon': { color, ml: 0.5, mr: -0.25, fontSize: 12 },
  }
}

export const surfaceSx: Record<string, unknown> = {
  border: `1px solid ${T.border}`,
  borderRadius: T.radius,
  backgroundColor: T.surface,
  backgroundImage: 'none',
  boxShadow: 'none',
}

export const raisedSx: Record<string, unknown> = {
  border: `1px solid ${T.border}`,
  borderRadius: T.radius,
  backgroundColor: T.raised,
  backgroundImage: 'none',
  boxShadow: 'none',
}

export const dialogPaperSx: Record<string, unknown> = {
  backgroundImage: 'none',
  backgroundColor: 'var(--dsw-alias-bg-layer-2, #ffffff)',
  color: T.text,
  border: `1px solid ${T.borderStrong}`,
  borderRadius: T.radiusLg,
  boxShadow: T.elevation,
}

export const fieldSx: Record<string, unknown> = {
  '& .MuiOutlinedInput-root': {
    minHeight: 32,
    borderRadius: T.radiusSm,
    backgroundColor: 'transparent',
    fontSize: 12.5,
    color: T.text,
    '& fieldset': { borderColor: T.border },
    '&:hover fieldset': { borderColor: T.borderStrong },
    '&.Mui-focused fieldset': { borderColor: T.accent, borderWidth: 1 },
  },
  '& .MuiInputBase-input::placeholder': { color: T.tertiary, opacity: 1 },
}

export const tabSx: Record<string, unknown> = {
  minHeight: 34,
  borderBottom: `1px solid ${T.border}`,
  '& .MuiTabs-indicator': { backgroundColor: T.accent, height: 2 },
  '& .MuiTab-root': {
    minHeight: 34,
    minWidth: 0,
    px: 1.5,
    py: 0.5,
    textTransform: 'none',
    fontSize: 12.5,
    fontWeight: 600,
    color: T.secondary,
  },
  '& .MuiTab-root.Mui-selected': { color: `${T.text} !important` },
  '& .MuiTab-root.Mui-focusVisible': { outline: `2px solid ${T.focus}`, outlineOffset: -2 },
}

export function StatusDot(props: {
  readonly online: boolean
  readonly size?: number
  readonly label?: string
}): React.ReactElement {
  const size = props.size ?? 7
  return h(M.Box, {
    component: 'span',
    role: props.label === undefined ? undefined : 'img',
    'aria-label': props.label,
    'aria-hidden': props.label === undefined ? true : undefined,
    sx: {
      display: 'inline-block',
      flex: '0 0 auto',
      width: size,
      height: size,
      borderRadius: '50%',
      backgroundColor: props.online ? T.success : T.tertiary,
      boxShadow: props.online ? `0 0 0 3px color-mix(in srgb, ${T.success} 16%, transparent)` : 'none',
    },
  })
}

export function tierLabelKey(tier: string): string {
  if (tier === 'agent') return 'agents'
  if (tier === 'host') return 'host'
  if (tier === 'hidden') return 'hidden'
  return 'all'
}

export function tierIcon(tier: string): Icon {
  if (tier === 'agent') return Icons.agent
  if (tier === 'host') return Icons.host
  if (tier === 'hidden') return Icons.hidden
  return Icons.other
}

export function tierTone(tier: string): Tone {
  if (tier === 'agent') return 'accent'
  if (tier === 'host') return 'neutral'
  if (tier === 'hidden') return 'warning'
  return 'neutral'
}

/** Small square tier glyph used in list rows. */
export function TierGlyph(props: { readonly tier: string }): React.ReactElement {
  const Icon = tierIcon(props.tier)
  const tone = tierTone(props.tier)
  return h(M.Box, {
    sx: {
      width: 26,
      height: 26,
      flex: '0 0 auto',
      display: 'grid',
      placeItems: 'center',
      borderRadius: T.radiusSm,
      color: toneColor[tone],
      backgroundColor: `color-mix(in srgb, ${toneColor[tone]} 10%, transparent)`,
      border: `1px solid color-mix(in srgb, ${toneColor[tone]} 22%, transparent)`,
    },
  }, h(Icon, { sx: { fontSize: 15 } }))
}

export function SectionTitle(props: {
  readonly title: string
  readonly hint?: string
  readonly action?: React.ReactNode
}): React.ReactElement {
  return h(
    M.Stack,
    { direction: 'row', alignItems: 'baseline', justifyContent: 'space-between', spacing: 1, sx: { mb: 1 } },
    h(
      M.Stack,
      { direction: 'row', alignItems: 'baseline', spacing: 1, sx: { minWidth: 0 } },
      h(M.Typography, { variant: 'subtitle2', sx: { fontSize: 12.5, fontWeight: 700, color: T.text } }, props.title),
      props.hint === undefined
        ? null
        : h(M.Typography, { variant: 'caption', sx: { color: T.tertiary, whiteSpace: 'nowrap' } }, props.hint),
    ),
    props.action ?? null,
  )
}

/** Compact statistic tile: label, value, one explanatory line. */
export function MetricTile(props: {
  readonly label: string
  readonly value: string
  readonly hint?: string
  readonly icon?: Icon
  readonly tone?: Tone
}): React.ReactElement {
  const Icon = props.icon
  const tone = props.tone ?? 'accent'
  return h(
    M.Paper,
    { variant: 'outlined', sx: { ...surfaceSx, px: 1.25, py: 1, minWidth: 0 } },
    h(
      M.Stack,
      { direction: 'row', alignItems: 'center', spacing: 0.75, sx: { minWidth: 0 } },
      Icon === undefined
        ? null
        : h(M.Box, { sx: { color: toneColor[tone], display: 'flex' } }, h(Icon, { sx: { fontSize: 14 } })),
      h(
        M.Typography,
        {
          variant: 'caption',
          noWrap: true,
          sx: { color: T.secondary, fontWeight: 600, fontSize: 10.5, letterSpacing: '.03em' },
        },
        props.label,
      ),
    ),
    h(
      M.Typography,
      { variant: 'h6', sx: { mt: 0.5, fontSize: 21, lineHeight: 1.1, fontWeight: 700, color: T.text } },
      props.value,
    ),
    props.hint === undefined
      ? null
      : h(
        M.Typography,
        { variant: 'caption', noWrap: true, sx: { display: 'block', mt: 0.25, color: T.tertiary, fontSize: 10.5 } },
        props.hint,
      ),
  )
}

/** Label/value row for the kernel and projection tables. */
export function InfoRow(props: {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
  readonly tone?: Tone
}): React.ReactElement {
  return h(
    M.Stack,
    {
      direction: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      spacing: 2,
      sx: { py: 0.5, minWidth: 0, width: '100%' },
    },
    h(M.Typography, { variant: 'caption', noWrap: true, sx: { color: T.secondary, fontSize: 11.5 } }, props.label),
    h(
      M.Typography,
      {
        variant: 'caption',
        noWrap: true,
        sx: {
          color: props.tone === undefined ? T.text : toneColor[props.tone],
          fontSize: 11.5,
          fontWeight: 600,
          fontFamily: props.mono === true ? T.mono : undefined,
        },
      },
      props.value,
    ),
  )
}

export function EmptyState(props: {
  readonly title: string
  readonly hint?: string
  readonly action?: React.ReactNode
}): React.ReactElement {
  return h(
    M.Stack,
    { alignItems: 'center', spacing: 0.5, sx: { py: 4, px: 2, textAlign: 'center' } },
    h(
      M.Box,
      {
        sx: {
          width: 34,
          height: 34,
          display: 'grid',
          placeItems: 'center',
          borderRadius: '50%',
          color: T.tertiary,
          backgroundColor: T.surface,
          border: `1px solid ${T.border}`,
          mb: 0.5,
        },
      },
      h(Icons.empty, { sx: { fontSize: 18 } }),
    ),
    h(M.Typography, { variant: 'body2', sx: { color: T.text, fontWeight: 600, fontSize: 12.5 } }, props.title),
    props.hint === undefined
      ? null
      : h(M.Typography, { variant: 'caption', sx: { color: T.tertiary, maxWidth: 260 } }, props.hint),
    props.action ?? null,
  )
}

export function LoadingRows(props: { readonly rows?: number; readonly label?: string }): React.ReactElement {
  const rows = props.rows ?? 3
  return h(
    M.Stack,
    { spacing: 1, 'aria-busy': true, 'aria-label': props.label ?? 'Loading' },
    ...Array.from({ length: rows }, (_, index) => h(M.Skeleton, {
      key: index,
      variant: 'rounded',
      height: 42,
      sx: { borderRadius: T.radius },
    })),
  )
}

export function ErrorNotice(props: {
  readonly title: string
  readonly hint?: string
  readonly action?: React.ReactNode
}): React.ReactElement {
  return h(
    M.Alert,
    {
      severity: 'warning',
      variant: 'outlined',
      sx: {
        borderRadius: T.radius,
        borderColor: T.border,
        color: T.text,
        backgroundColor: T.surface,
        '& .MuiAlert-icon': { color: T.warning },
        '& .MuiAlert-message': { minWidth: 0 },
      },
      action: props.action,
    },
    h(M.AlertTitle, { sx: { fontSize: 12.5, fontWeight: 700, mb: 0.25 } }, props.title),
    props.hint === undefined
      ? null
      : h(M.Typography, { variant: 'caption', sx: { color: T.secondary } }, props.hint),
  )
}

export function RefreshButton(props: {
  readonly label: string
  readonly onClick: () => void
  readonly busy?: boolean
}): React.ReactElement {
  return h(
    M.Tooltip,
    { title: props.label },
    h(
      M.IconButton,
      {
        size: 'small',
        onClick: props.onClick,
        'aria-label': props.label,
        sx: {
          width: 28,
          height: 28,
          color: T.secondary,
          border: `1px solid ${T.border}`,
          borderRadius: T.radiusSm,
          '&:hover': { backgroundColor: T.hover, color: T.text },
        },
      },
      props.busy === true
        ? h(M.CircularProgress, { size: 14, sx: { color: T.accent } })
        : h(RefreshIcon, { sx: { fontSize: 16 } }),
    ),
  )
}

/** Tiny labelled horizontal bar used for budget limits, when a limit exists. */
export function BudgetBar(props: {
  readonly label: string
  readonly used: number
  readonly limit: number
}): React.ReactElement {
  const ratio = props.limit <= 0 ? 0 : Math.min(props.used / props.limit, 1)
  return h(
    M.Box,
    { sx: { minWidth: 0, width: '100%' } },
    h(
      M.Stack,
      { direction: 'row', justifyContent: 'space-between', sx: { mb: 0.25 } },
      h(M.Typography, { variant: 'caption', sx: { color: T.secondary, fontSize: 10.5 } }, props.label),
      h(M.Typography, { variant: 'caption', sx: { color: T.tertiary, fontSize: 10.5, fontFamily: T.mono } },
        `${props.used} / ${props.limit}`),
    ),
    h(M.Box, {
      sx: {
        height: 4,
        borderRadius: 2,
        backgroundColor: T.surface,
        overflow: 'hidden',
      },
    }, h(M.Box, {
      sx: {
        width: `${Math.round(ratio * 100)}%`,
        height: '100%',
        backgroundColor: ratio > 0.9 ? T.error : T.accent,
      },
    })),
  )
}
