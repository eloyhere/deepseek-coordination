/**
 * Docked coordination workspace panels (client half).
 *
 * A fixed right-hand column stacks two collapseable Material UI panels: the
 * relationship panel on top and the workspace panel below. The column is
 * anchored to the bottom (`justify-content: flex-end`), so the workspace panel
 * sits at the bottom under the relationship panel; expanding the workspace
 * pushes the relationship panel up, while expanding the relationship panel
 * grows downward into the freed space. That push/pull is flex layout only.
 * When both panels are expanded they use the same zero flex-basis/grow and
 * therefore split the column height exactly in half; a collapsed panel is
 * pinned to its 48 px title bar. Every panel is a bounded column, so its
 * scrolling content can never spill past the bottom-navigation divider.
 * The column is mounted as a sibling of the composer row (see `./index.ts`) and
 * portaled to `document.body`, so its `position: fixed` inset is measured
 * against the viewport even though the DSH shell has transformed ancestors.
 * Neither a keystroke nor a panel toggle ever re-renders the composer itself.
 * Minimizing keeps only the 48 px title bar; there is no floating button and no
 * free dragging/resizing.
 *
 * # Title bar and search
 *
 * The 48 px title bar is the plugin's blue `primary.main` bar with contrast
 * text. Clicking the search button grows a MUI `Autocomplete` combobox out of
 * the right edge (width 0 → 240 px, leftwards, 220 ms MUI standard easing);
 * the title stays on the left and ellipsizes instead of wrapping or pushing the
 * buttons. Clicking the button again, the title area, or `Esc` shrinks the field
 * back to zero and unmounts it (query and hits cleared); `prefers-reduced-motion`
 * makes the open/close instant. Typing runs the existing `/graph/search`
 * endpoint (debounced), the listbox renders the host's hits, Enter selects the
 * highlighted hit (or runs the search immediately), and `Esc` closes the search.
 * Errors keep a retry action inside the listbox. The listbox hides its native
 * scrollbar and uses the local {@link ScrollBar} React component instead: a
 * transparent groove with a light-grey, draggable thumb (MUI `sx` only, no CSS
 * file, no new dependency).
 *
 * # Routing and scope
 *
 * Both panels are always routed, and each tab (plus each detail page) is its
 * own hash route. Component state is the source of truth for a panel's
 * view/selection; the URL only carries a deep link:
 *
 *   #coordination/panel/right/files
 *   #coordination/panel/right/outline?path=src%2Fa.ts
 *   #coordination/panel/right/dependencies?path=src%2Fa.ts
 *   #coordination/panel/right/imports?path=src%2Fa.ts
 *   #coordination/panel/right/exports?path=src%2Fa.ts
 *   #coordination/panel/right/preview?path=src%2Fa.ts
 *   #coordination/panel/left/files
 *   #coordination/panel/left/agents
 *   #coordination/panel/left/agent?id=…
 *   #coordination/panel/left/dependencies?path=src%2Fa.ts
 *   #coordination/panel/left/imports?path=src%2Fa.ts
 *   #coordination/panel/left/exports?path=src%2Fa.ts
 *
 * The two panels route different sets: the bottom panel's tabs are Files,
 * Outline, Dependencies, Imports and Exports, and `preview` is a routed detail
 * page that is not a tab; the top panel's tabs are Files, Agents,
 * Dependencies, Imports and Exports, and `agent` is its routed detail page.
 * Imports and Exports render the WebGL relationship canvas on both sides, so
 * the same `?path=` file/workspace scope applies everywhere. Only `tabs` are
 * mounted in the BottomNavigation; `routes` additionally validates deep links,
 * which is what makes `right/preview?path=…` and `left/agent?id=…` work
 * without listing them as tabs.
 *
 * The Outline route is itself two modes: no `path` shows the workspace-wide
 * outline grouped by file (collapsed, with structure-node counts; clicking a
 * group opens that file), and `?path=…` shows only that file's structure tree
 * with a scope-bar back button. The view stays mounted across the flip so the
 * global collapse state and scroll offset survive; Escape returns as well.
 * The agent detail route (`left/agent?id=…`) is a read-only, virtualized
 * Markdown transcript with a back button and no composer.
 *
 * Each panel reads `location.hash` exactly once, when it mounts, then keeps its
 * own `useReducer` navigation state. A click changes that state directly and
 * only *mirrors* the hash through `history.replaceState` (best-effort, wrapped
 * in try/catch). No `hashchange` listener feeds the hash back into a panel:
 * DSH's own router rewrites the hash and would otherwise clobber the view.
 * The `path` parameter is the selected file and survives view switches: no
 * `path` means workspace mode. Minimized content is unmounted but the view/path
 * state stays, so restoring a panel returns to the same view.
 *
 * # Persistence
 *
 * `localStorage["coordination.panel.right"]` holds exactly
 * `{ openLeft, openRight, width }`; there are no coordinates. The relationship
 * panel defaults minimized and the workspace panel defaults expanded. The column
 * width is budgeted at `min(440px, calc(100vw - 32px))` so it always stays
 * inside the right-hand inset. Views and paths live in component state; the hash
 * only mirrors the latest selection for deep links.
 *
 * # Failure containment
 *
 * The column, each panel and the lazily loaded preview renderer own separate
 * error boundaries. A failure logs `[coordination] panel failed` with its
 * component stack, renders nothing in that layer, and never escapes into the
 * host tree; the last error is shown as a title-bar chip when a panel survives.
 * `localStorage["coordination.panel.disabled"]` set to `1` (or `true`) mounts
 * nothing at all, which is the no-restart recovery path for a bad build.
 *
 * # Host contract
 *
 * All reads are `{ ok, value }` envelopes under `/deepseek-coordination` and are
 * narrowed before rendering:
 *
 *   GET /graph/tree
 *       `{ root, entries: [{ path, name, kind: 'file'|'directory', children? }] }`
 *   GET /graph/outline[?path=…]
 *       file: `{ scope: 'file', path, family, nodes: OutlineNode[] }`
 *       all:  `{ scope: 'workspace', groups: [{ path, family, nodes }] }`
 *   GET /graph/dependencies[?path=…][&level=file|intra]
 *       `{ scope, links: [{ from, to, relation, cyclic }], cycles: string[][] }`
 *   GET /graph/intra?path=…
 *       `{ path, family, nodes: [{ id, kind, name, depth }], edges, truncated }`
 *   GET /graph/imports[?path=…]
 *       `{ scope, rows: [{ path, imported, exported, cyclic? }], cycles? }`
 *   GET /graph/agents, /graph/agents/messages?id=…
 *   GET /graph/search?q=…
 *       `{ hits: [{ handle, kind, name, path, line }] }`
 *   GET /graph/preview?path=…
 *       `{ path, kind, content, truncated, bytes, sheets?, slides? }`
 *   POST /graph/rebuild
 *       `{ files, nodes, durationMs, truncated }`
 *   POST /graph/index
 *       `{ indexed, skipped, nodes, durationMs, truncated }`
 *
 * A fresh profile's graph is legitimately empty (only paths the file tools have
 * already parsed are indexed), so the Files view's empty state offers the
 * explicit `/graph/index` scan; it re-requests the current view when it
 * finishes. `/graph/rebuild` stays as the re-index-known-paths action.
 *
 * Every list owns its loading, empty and error state. The whole surface is
 * read-only: views navigate and select, previews render (Markdown without raw
 * HTML, sanitized HTML, highlighted read-only code, tables and slide cards) and
 * nothing ever writes a workspace file. The relationship panel additionally
 * projects the intra-file symbol graph and the dependency/import/export edges
 * onto a native canvas with a deterministic layout and a text alternative.
 *
 * # Accessibility and motion
 *
 * Each panel is a non-modal `role="dialog"`; every control carries an
 * `aria-label` and a `Tip` tooltip; the title is a toggle button with
 * `aria-expanded`. `Esc` clears a live search first, leaves a preview, returns
 * from the local outline to the global one, returns from an agent detail page
 * to the roster, clears a canvas selection, and otherwise minimizes. Height
 * changes are animated as one Material transition: the panel's
 * `flex-grow`/`flex-basis` use MUI's `theme.transitions.create` timing (220 ms,
 * MUI standard easing), the body is a MUI `Collapse` (same 220 ms/easing) and
 * its content fades with MUI `Fade`; the header icon cross-fades (150 ms). The
 * flex transition is what produces the push-up, never a transform. Everything
 * collapses to `timeout={0}` and no flex transition when
 * `prefers-reduced-motion` is set. Panel heights are clamped by
 * {@link splitPanelHeights}: below 200 px of column height both panels are
 * forced to their 48 px title bars. Canvas repaints are scheduled on the
 * plugin-wide three-queue {@link Task} pump (high = interaction, medium =
 * animation, low = layout) and an idle canvas schedules no callback at all.
 */
import * as React from 'react'
// @ts-ignore react-dom 18 ships no declarations here and @types/react-dom is not a dependency.
import { createPortal } from 'react-dom'
import IconButton from '@mui/material/IconButton'
import TextField from '@mui/material/TextField'
import Autocomplete from '@mui/material/Autocomplete'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import BottomNavigation from '@mui/material/BottomNavigation'
import BottomNavigationAction from '@mui/material/BottomNavigationAction'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import ListItemButton from '@mui/material/ListItemButton'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import Accordion from '@mui/material/Accordion'
import AccordionSummary from '@mui/material/AccordionSummary'
import AccordionDetails from '@mui/material/AccordionDetails'
import Tooltip from '@mui/material/Tooltip'
import Paper from '@mui/material/Paper'
import Avatar from '@mui/material/Avatar'
import ListItem from '@mui/material/ListItem'
import LinearProgress from '@mui/material/LinearProgress'
import Skeleton from '@mui/material/Skeleton'
import Grow from '@mui/material/Grow'
import Fade from '@mui/material/Fade'
import Collapse from '@mui/material/Collapse'
import Snackbar from '@mui/material/Snackbar'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableRow from '@mui/material/TableRow'
import useMediaQuery from '@mui/material/useMediaQuery'
import MenuIcon from '@mui/icons-material/Menu'
import SearchIcon from '@mui/icons-material/Search'
import MinimizeIcon from '@mui/icons-material/Minimize'
import RefreshIcon from '@mui/icons-material/Refresh'
import AutorenewIcon from '@mui/icons-material/Autorenew'
import SettingsBackupRestoreIcon from '@mui/icons-material/SettingsBackupRestore'
import CloseIcon from '@mui/icons-material/Close'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import ArticleIcon from '@mui/icons-material/Article'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import CallSplitIcon from '@mui/icons-material/CallSplit'
import CallReceivedIcon from '@mui/icons-material/CallReceived'
import VisibilityIcon from '@mui/icons-material/Visibility'
import CallMadeIcon from '@mui/icons-material/CallMade'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import PeopleIcon from '@mui/icons-material/People'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import OpenInFullIcon from '@mui/icons-material/OpenInFull'
import { alpha, ThemeProvider, useTheme } from '@mui/material/styles'
import type { Theme } from '@mui/material/styles'
import type { PrismTheme, RenderProps } from 'prism-react-renderer'
import { theme } from './theme.js'
import { useCopy } from './i18n.js'
import { fetchGraph, indexGraph, rebuildGraph } from './bridge.js'
import { PANEL_FAMILIES, PANEL_VIEW_IDS, fillTemplate } from '../shared/i18n.js'
import type { PanelCopy, PanelFamily, PanelView } from '../shared/i18n.js'

/* MUI's generics describe every overload; this module passes one narrow shape. */
type Loose = React.ComponentType<Record<string, unknown>>
const MuiIconButton = IconButton as unknown as Loose
const MuiTextField = TextField as unknown as Loose
const MuiAutocomplete = Autocomplete as unknown as Loose
const MuiMenu = Menu as unknown as Loose
const MuiMenuItem = MenuItem as unknown as Loose
const MuiCard = Card as unknown as Loose
const MuiCardContent = CardContent as unknown as Loose
const MuiBottomNavigation = BottomNavigation as unknown as Loose
const MuiBottomNavigationAction = BottomNavigationAction as unknown as Loose
const MuiBox = Box as unknown as Loose
const MuiTypography = Typography as unknown as Loose
const MuiListItemButton = ListItemButton as unknown as Loose
const MuiChip = Chip as unknown as Loose
const MuiCircularProgress = CircularProgress as unknown as Loose
const MuiButton = Button as unknown as Loose
const MuiAlert = Alert as unknown as Loose
const MuiAccordion = Accordion as unknown as Loose
const MuiAccordionSummary = AccordionSummary as unknown as Loose
const MuiAccordionDetails = AccordionDetails as unknown as Loose
const MuiTooltip = Tooltip as unknown as Loose
const MuiPaper = Paper as unknown as Loose
const MuiAvatar = Avatar as unknown as Loose
const MuiListItem = ListItem as unknown as Loose
const MuiLinearProgress = LinearProgress as unknown as Loose
const MuiSkeleton = Skeleton as unknown as Loose
const MuiGrow = Grow as unknown as Loose
const MuiFade = Fade as unknown as Loose
const MuiCollapse = Collapse as unknown as Loose
const MuiSnackbar = Snackbar as unknown as Loose
const MuiListItemIcon = ListItemIcon as unknown as Loose
const MuiListItemText = ListItemText as unknown as Loose
const MuiTabs = Tabs as unknown as Loose
const MuiTab = Tab as unknown as Loose
const MuiTable = Table as unknown as Loose
const MuiTableBody = TableBody as unknown as Loose
const MuiTableCell = TableCell as unknown as Loose
const MuiTableRow = TableRow as unknown as Loose
const MuiThemeProvider = ThemeProvider as unknown as Loose

/* Icon components accept SvgIcon props; the loose alias keeps one call shape. */
const IconMenu = MenuIcon as unknown as Loose
const IconSearch = SearchIcon as unknown as Loose
const IconMinimize = MinimizeIcon as unknown as Loose
const IconRefresh = RefreshIcon as unknown as Loose
const IconRebuild = AutorenewIcon as unknown as Loose
const IconReset = SettingsBackupRestoreIcon as unknown as Loose
const IconClose = CloseIcon as unknown as Loose
const IconExpand = ExpandMoreIcon as unknown as Loose
const IconChevron = ChevronRightIcon as unknown as Loose
const IconWarning = WarningAmberIcon as unknown as Loose
const IconArticle = ArticleIcon as unknown as Loose
const IconOutline = AccountTreeIcon as unknown as Loose
const IconDependencies = CallSplitIcon as unknown as Loose
const IconImports = CallReceivedIcon as unknown as Loose
const IconExports = CallMadeIcon as unknown as Loose
const IconPreview = VisibilityIcon as unknown as Loose
const IconZoomIn = AddIcon as unknown as Loose
const IconZoomOut = RemoveIcon as unknown as Loose
const IconFit = CenterFocusStrongIcon as unknown as Loose
const IconResetLayout = RestartAltIcon as unknown as Loose
const IconAgents = PeopleIcon as unknown as Loose
const IconBack = ArrowBackIcon as unknown as Loose
const IconRestore = OpenInFullIcon as unknown as Loose

const h = React.createElement

/* ------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------- */

/** Hash namespace; the column itself owns the persisted expansion state. */
const HASH_ROOT = '#coordination/panel/'

/** The fixed right-hand column and its two stacked panels. */
const COLUMN_STORAGE_KEY = 'coordination.panel.right'
const COLUMN_DEFAULT_WIDTH = 420
const COLUMN_MIN_WIDTH = 320
const COLUMN_MAX_WIDTH = 720
const COLUMN_GAP = 8
const COLUMN_TOP = 72
/** Clear the composer/bottom bar: the column must never cover it. */
const COLUMN_BOTTOM = 120
const COLUMN_RIGHT = 16
const HEADER_HEIGHT = 48
const NAV_HEIGHT = 56
/** Below this the two title bars no longer both fit; force both collapsed. */
const PANEL_MIN_CONTAINER_HEIGHT = 200
/** Column height budget: top 72 + bottom 120. */
const COLUMN_HEIGHT_OFFSET = COLUMN_TOP + COLUMN_BOTTOM

/**
 * Expanded panels all use zero flex-basis and grow, so two expanded panels
 * split the remaining column height exactly in half (minus the 8 px gap); a
 * collapsed panel is pinned to its 48 px title bar instead. `minHeight: 0` on
 * the item lets flex shrink them below their content height.
 */
export const PANEL_EXPANDED_FLEX = '1 1 0'
export const PANEL_COLLAPSED_FLEX = `0 0 ${HEADER_HEIGHT}px`

/**
 * No-restart recovery switch: `localStorage['coordination.panel.disabled']`
 * set to `1` (or `true`) mounts nothing at all. Reading is fail-closed: a
 * blocked storage access keeps the panel enabled.
 */
const PANEL_DISABLED_STORAGE_KEY = 'coordination.panel.disabled'

/** `panel.crashed` copy. Kept identical for zh/en, matching the shared copy style. */
const PANEL_CRASHED_LABEL = 'Panel crashed'

/** Error tooltips are capped so a huge stack-bearing message cannot fill the header. */
const PANEL_ERROR_MAX_CHARS = 200

/** Title-bar chip for the last boundary failure; small enough for the 48 px bar. */
const CRASH_CHIP_SX = {
  flex: 'none',
  height: 22,
  maxWidth: 132,
  backgroundColor: 'background.paper',
  '& .MuiChip-label': {
    paddingLeft: 0.75,
    paddingRight: 0.75,
    fontSize: 10,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
}

/* ------------------------------------------------------------------------- *
 * Failure containment
 *
 * React unmounts the whole tree when a render throws without a boundary, and
 * the host renders the composer in the same root. Every panel layer therefore
 * gets its own boundary, and the last failure is kept module-level so a
 * surviving title bar can show it.
 * ------------------------------------------------------------------------- */

let lastPanelError: Error | null = null
const panelErrorListeners = new Set<() => void>()

function rememberPanelError(error: unknown): void {
  lastPanelError = error instanceof Error ? error : new Error(String(error))
  for (const listener of [...panelErrorListeners]) listener()
}

/** The last failure caught by any panel boundary (diagnostics/test hook). */
export function getPanelError(): Error | null {
  return lastPanelError
}

/** Subscribe to boundary failures; used by every panel title bar. */
export function subscribePanelError(listener: () => void): () => void {
  panelErrorListeners.add(listener)
  return () => {
    panelErrorListeners.delete(listener)
  }
}

/** Tooltip for the crash chip: the error message, capped at 200 characters. */
export function panelErrorTooltip(error: Error): string {
  const message = error.message.trim()
  return (message.length > 0 ? message : String(error)).slice(0, PANEL_ERROR_MAX_CHARS)
}

/**
 * Whether the operator disabled the panel through `localStorage`.
 *
 * This is deliberately read at mount time only: the flag is a recovery path
 * that takes effect after the next page load, not a reactive control.
 */
export function isPanelDisabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const storage = window.localStorage
    if (storage === undefined) return false
    const value = storage.getItem(PANEL_DISABLED_STORAGE_KEY)
    return value === '1' || value === 'true'
  } catch {
    return false
  }
}

/** Never rethrows: a boundary failure must not escape into the host tree. */
export class PanelErrorBoundary extends React.Component<
  { children?: React.ReactNode },
  { failed: boolean }
> {
  state: { failed: boolean } = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    rememberPanelError(error)
    console.error('[coordination] panel failed', error, info?.componentStack)
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/**
 * The bottom (workspace) panel: its BottomNavigation tabs and its routed pages.
 *
 * `preview` is a routed detail page reachable from a file/outline row and from
 * search, never a tab, so `#coordination/panel/right/preview?path=…` deep-links
 * without adding a sixth tab.
 */
export const RIGHT_PANEL_TABS: readonly PanelView[] = [
  'files',
  'outline',
  'dependencies',
  'imports',
  'exports',
]
export const RIGHT_PANEL_ROUTES: readonly PanelView[] = [...RIGHT_PANEL_TABS, 'preview']

/**
 * The top (relationship) panel: its own tab set and routed pages.
 *
 * `agent` is the detail page of the Agents tab (`id` parameter), not a tab.
 */
export const LEFT_PANEL_TABS: readonly PanelView[] = [
  'files',
  'agents',
  'dependencies',
  'imports',
  'exports',
]
export const LEFT_PANEL_ROUTES: readonly PanelView[] = [...LEFT_PANEL_TABS, 'agent']

/** Cycle paths rendered in a warning block before the overflow line. */
const MAX_CYCLE_LINES = 5

/* Transition budgets, chosen per interaction (see the panel header). */
const PANEL_TOGGLE_MS = 220
const VIEW_FADE_MS = 180
const SCOPE_GROW_MS = 150
const SEARCH_DEBOUNCE_MS = 250
const PREVIEW_FADE_MS = 200
const PANEL_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)'

/**
 * The panel's height change uses the same MUI duration/easing as its Collapse,
 * so restore/collapse reads as one Material height transition (the push-up
 * itself is still pure flex layout, never a transform).
 */
export const PANEL_RESIZE_TRANSITION = theme.transitions.create(
  ['flex-grow', 'flex-basis'],
  { duration: PANEL_TOGGLE_MS, easing: PANEL_EASING },
)

/** Client-side cap for the syntax-highlighted code preview. */
const MAX_CODE_LINES = 2000
const MAX_CODE_BYTES = 64 * 1024

/** File extension → Prism language; unknown extensions render as `plain`. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'tsx',
  tsx: 'tsx',
  js: 'jsx',
  jsx: 'jsx',
  java: 'java',
  py: 'python',
  rs: 'rust',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
}

const TAB_ICONS: Readonly<Record<PanelView, Loose>> = {
  files: IconArticle,
  outline: IconOutline,
  dependencies: IconDependencies,
  imports: IconImports,
  preview: IconPreview,
  exports: IconExports,
  agents: IconAgents,
  agent: IconAgents,
}

function tabLabel(view: PanelView, copy: PanelCopy): string {
  if (view === 'preview') return copy.preview
  if (view === 'exports') return copy.exports
  if (view === 'agents' || view === 'agent') return copy.agents
  return copy.tabs[view]
}

function tabTip(view: PanelView, copy: PanelCopy): string {
  switch (view) {
    case 'files':
      return copy.tip.tabFiles
    case 'outline':
      return copy.tip.tabOutline
    case 'dependencies':
      return copy.tip.tabDependencies
    case 'imports':
      return copy.tip.tabImportsGraph
    case 'preview':
      return copy.tip.tabPreview
    case 'exports':
      return copy.tip.tabExportsGraph
    default:
      return copy.tip.tabAgents
  }
}

/* ------------------------------------------------------------------------- *
 * Styles
 *
 * Hoisted so a drag, a keystroke or a poll never regenerates an emotion rule.
 * Dynamic values (one item's indentation) use `style` instead of `sx`.
 * ------------------------------------------------------------------------- */

/**
 * One docked panel: a bounded flex column. `minHeight: 0` is what keeps two
 * expanded panels inside the fixed column instead of stretching it past its
 * declared bottom edge. `width: 100%` + `boxSizing: border-box` keep the card
 * (and its 1 px border) inside the column, and `minWidth: 0` lets long paths
 * ellipsize instead of widening the whole column off the right edge of the
 * viewport. Bottom anchoring happens on {@link COLUMN_SX}.
 */
export const PANEL_ITEM_SX = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  minHeight: 0,
  minWidth: 0,
  maxHeight: '100%',
  overflow: 'hidden',
  boxSizing: 'border-box',
  backgroundColor: 'background.paper',
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: 1,
  boxShadow: 2,
  pointerEvents: 'auto',
}

/**
 * Title bar: exactly 48 px, never grows or shrinks. It is the plugin's blue bar
 * (`primary.main`; the local MUI theme keeps the default blue primary) with
 * contrast text, and every control inherits the bar colour.
 */
export const HEADER_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.5,
  flex: 'none',
  height: HEADER_HEIGHT,
  minHeight: HEADER_HEIGHT,
  maxHeight: HEADER_HEIGHT,
  paddingLeft: 0.5,
  paddingRight: 0.5,
  borderBottom: '1px solid',
  borderColor: 'primary.dark',
  backgroundColor: 'primary.main',
  color: 'primary.contrastText',
  borderTopLeftRadius: 4,
  borderTopRightRadius: 4,
  '& .MuiIconButton-root': { color: 'inherit' },
  '& .MuiTypography-root': { color: 'inherit' },
}

/**
 * The visible body under the title bar: scope bar (fixed), scrolling content
 * (`flex: 1` + `min-height: 0`) and bottom navigation (fixed). It must own
 * `overflow: hidden` so the inner scroll never paints over the navigation.
 */
export const PANEL_CONTENT_SX = {
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

/**
 * MUI transitions clone their single child and attach a ref to it. Fade and
 * Grow then call `reflow(node)` — `node.scrollTop` — when the enter animation
 * starts, so the direct child must be a plain DOM element that always accepts a
 * ref. Wrapping a context provider, an error boundary or even a styled wrapper
 * in the transition left that ref null and crashed the whole panel; these plain
 * layout styles are applied to the host element instead.
 */
const TRANSITION_SURFACE_STYLE: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
}

/** {@link PANEL_CONTENT_SX} as inline style for a transition's DOM child. */
const PANEL_CONTENT_STYLE: React.CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

/** Scope-chip row layout as inline style for the Grow transition's DOM child. */
const SCOPE_CHIP_WRAP_STYLE: React.CSSProperties = {
  display: 'flex',
  minWidth: 0,
  maxWidth: '100%',
  flex: 1,
}

/**
 * Fill chain for the collapsing body.
 *
 * MUI `Collapse` measures the natural height of its inner wrapper while the
 * transition runs, so the wrapper must stay auto-sized during `entering`/
 * `exiting`. Only once the transition has *entered* do the wrapper layers
 * become flex items that fill the panel's remaining height; that keeps the
 * 220 ms height animation intact without letting long content stretch the
 * panel (or push the bottom navigation out of view).
 */
export const COLLAPSE_FILL_SX = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  width: '100%',
}

export const COLLAPSE_BODY_SX = {
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  overflow: 'hidden',
  '&.MuiCollapse-entered': {
    display: 'flex',
    flexDirection: 'column',
  },
  '&.MuiCollapse-entered > .MuiCollapse-wrapper': COLLAPSE_FILL_SX,
  '&.MuiCollapse-entered > .MuiCollapse-wrapper > .MuiCollapse-wrapperInner': COLLAPSE_FILL_SX,
}

const HEADER_TITLE_SX = {
  display: 'flex',
  alignItems: 'center',
  flex: 1,
  minWidth: 0,
  height: '100%',
  paddingLeft: 0.5,
  paddingRight: 0.5,
  borderRadius: 0.5,
  cursor: 'pointer',
  outline: 'none',
  '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.12)' },
  '&:focus-visible': { boxShadow: 'inset 0 0 0 2px currentColor' },
}

/** The header search expands from the right, left of the search button. */
const SEARCH_INPUT_ID = 'coordination-panel-search'
/** Final width of the expanded search field (the design budget). */
const SEARCH_SLOT_WIDTH = 240
/** 220 ms MUI-standard open/close; reduced motion makes it instant. */
const SEARCH_ANIMATION_MS = 220

/**
 * Horizontal MUI Collapse wrapper. `flex: 0 0 auto` and `minWidth: 0` keep the
 * field from squeezing the title bar's buttons out while it grows/shrinks;
 * the title keeps its `flex: 1; minWidth: 0` slot and ellipsizes instead.
 */
const SEARCH_COLLAPSE_SX = {
  flex: '0 0 auto',
  minWidth: 0,
  maxWidth: '100%',
  overflow: 'hidden',
  alignSelf: 'center',
  '& .MuiCollapse-wrapper, & .MuiCollapse-wrapperInner': { minWidth: 0 },
}

/** Fixed-width field inside the Collapse; never shrinks below its budget. */
const SEARCH_SLOT_SX = {
  width: SEARCH_SLOT_WIDTH,
  maxWidth: '100%',
  minWidth: 0,
  flex: '0 0 auto',
}

/** The header search is a combobox; it grows leftwards beside the title. */
const SEARCH_AUTOCOMPLETE_SX = {
  flex: 1,
  minWidth: 0,
  marginLeft: 0.5,
  marginRight: 0.5,
}

const SEARCH_FIELD_SX = {
  width: '100%',
  minWidth: 0,
  '& .MuiInputBase-root': {
    height: 32,
    fontSize: 12,
    borderRadius: 1,
    backgroundColor: 'background.paper',
  },
  '& .MuiInputBase-input': { padding: '4px 8px' },
  '& .MuiInputAdornment-root': { marginRight: 0.5 },
}

/** The result popup is portaled to the body, so it must out-rank the column. */
const SEARCH_POPPER_SX = { zIndex: theme.zIndex.tooltip }

/** Height cap shared by the dropdown listbox and its custom scrollbar. */
const SEARCH_LISTBOX_MAX_HEIGHT = 280

const SEARCH_LISTBOX_WRAP_SX = {
  position: 'relative',
  width: '100%',
  minWidth: 0,
}

const SEARCH_LISTBOX_SX = {
  width: '100%',
  // The native bar is replaced by <ScrollBar> (transparent track, grey thumb).
  '&::-webkit-scrollbar': { display: 'none', width: 0, height: 0 },
  // `&.MuiAutocomplete-listbox ...` out-ranks MUI's own option paddings.
  '&.MuiAutocomplete-listbox .MuiAutocomplete-option': {
    minHeight: 0,
    paddingTop: 0.5,
    paddingBottom: 0.5,
    paddingLeft: 1,
    paddingRight: 1,
  },
  '&.MuiAutocomplete-listbox .MuiAutocomplete-option.Mui-focused': {
    backgroundColor: 'action.hover',
  },
}

const SEARCH_OPTION_SX = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 0.25,
  paddingTop: 0.5,
  paddingBottom: 0.5,
  paddingLeft: 1,
  paddingRight: 1,
}

const SEARCH_STATUS_SX = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 1,
  paddingLeft: 1,
  paddingRight: 1,
  paddingTop: 0.5,
  paddingBottom: 0.5,
}

const MENU_SX = { zIndex: theme.zIndex.tooltip - 1 }

const MENU_ITEM_CONTENT_SX = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  pointerEvents: 'auto',
}

const CARD_SX = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  boxShadow: 'none',
}

/** The one scrolling surface of a panel; bounded by the flex stack above it. */
export const CARD_CONTENT_SX = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: 1.5,
  '&:last-child': { paddingBottom: 1.5 },
}

/** Bottom navigation: a fixed 56 px strip that never overlaps the scroller. */
export const NAV_SX = {
  flex: 'none',
  height: NAV_HEIGHT,
  minHeight: NAV_HEIGHT,
  maxHeight: NAV_HEIGHT,
  overflow: 'hidden',
  borderTop: '1px solid',
  borderColor: 'divider',
  '& .MuiBottomNavigationAction-root': { flex: 1, minWidth: 0, maxWidth: 'none', padding: '5px 0 3px' },
  '& .MuiBottomNavigationAction-label': { fontSize: 11, whiteSpace: 'nowrap' },
}

const NAV_ACTION_SX = { minWidth: 0 }

const STATE_BOX_SX = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 1,
  minHeight: 120,
  padding: 2,
  textAlign: 'center',
}

const ERROR_BOX_SX = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 1,
  minHeight: 120,
  padding: 2,
  textAlign: 'center',
}

/** Empty graph: the explanation plus the one explicit indexing button. */
const INDEX_EMPTY_SX = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 1,
  minHeight: 180,
  padding: 2,
  textAlign: 'center',
}

const INDEX_ACTION_SX = { marginTop: 0.5 }

const LIST_SX = { width: '100%' }

/* ------------------------------------------------------------------------- *
 * Virtual list plumbing
 *
 * Every list-shaped panel view renders only the rows inside the panel's scroll
 * viewport (plus a small overscan) and replaces the rest with two exact-height
 * spacers, so the scrollbar, total height and scroll position stay identical
 * while a 2,000-entry tree keeps only ~20 rows in the DOM.
 * ------------------------------------------------------------------------- */

/** Fixed height of one virtualized panel row (icon + two-line label). */
export const PANEL_ROW_HEIGHT = 48
/** Rows kept mounted above/below the viewport while scrolling. */
const VIRTUAL_OVERSCAN = 8

/** Pin one virtual row to the exact height the window arithmetic assumes. */
const VIRTUAL_ROW_SX = {
  height: PANEL_ROW_HEIGHT,
  minHeight: PANEL_ROW_HEIGHT,
  maxHeight: PANEL_ROW_HEIGHT,
  overflow: 'hidden',
  boxSizing: 'border-box',
}

/**
 * Visual root of every panel list/tree row: MUI's dense `ListItemButton`.
 *
 * The row is a fixed 48 px flex line, hover/selected colours come from the
 * button (`action.hover` / `action.selected`), focus-visible gets the 2 px
 * primary ring inset by -2, and the opacity transition of the trailing action
 * lives here so hovering the row reveals it. Reduced motion keeps the same
 * states but drops both transitions; the MUI ripple is deliberately untouched.
 */
export const PANEL_ROW_SX = {
  height: PANEL_ROW_HEIGHT,
  minHeight: PANEL_ROW_HEIGHT,
  maxHeight: PANEL_ROW_HEIGHT,
  padding: '4px 8px',
  borderRadius: theme.shape.borderRadius,
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  boxSizing: 'border-box',
  transition: 'background-color 150ms',
  '&:hover': { backgroundColor: 'action.hover' },
  '&.Mui-selected': { backgroundColor: 'action.selected' },
  '&.Mui-selected:hover': { backgroundColor: 'action.selected' },
  '&:focus-visible': {
    outline: '2px solid',
    outlineColor: 'primary.main',
    outlineOffset: -2,
  },
  '&:hover .coordination-row-action, &:focus-within .coordination-row-action': {
    opacity: 1,
  },
  '@media (prefers-reduced-motion: reduce)': {
    transition: 'none',
  },
}

/** Leading icon column of a row: 32 px, with an 18–20 px glyph. */
export const PANEL_ROW_ICON_SX = {
  minWidth: 32,
  color: 'text.secondary',
  '& svg': { fontSize: 20 },
}

/** `secondaryAction` position: pinned right, revealed by the row's hover. */
export const PANEL_ROW_ACTION_SX = {
  position: 'absolute',
  right: 8,
  top: '50%',
  transform: 'translateY(-50%)',
  opacity: 0,
  transition: 'opacity 120ms',
  '@media (prefers-reduced-motion: reduce)': {
    transition: 'none',
  },
}

/** Primary row line: the item name, one line, body2. */
export const PANEL_ROW_PRIMARY_PROPS = { variant: 'body2', noWrap: true }

/** Secondary row line: path/kind/count, one line, caption. */
export const PANEL_ROW_SECONDARY_PROPS = {
  variant: 'caption',
  noWrap: true,
  color: 'text.secondary',
}

/** Relative shell that owns the absolutely positioned trailing action. */
const PANEL_ROW_SHELL_SX = {
  position: 'relative',
  height: PANEL_ROW_HEIGHT,
  minHeight: PANEL_ROW_HEIGHT,
  maxHeight: PANEL_ROW_HEIGHT,
}

interface PanelScrollState {
  readonly top: number
  readonly height: number
  /** The measured scroller; virtualized views offset themselves against it. */
  readonly element: HTMLElement | null
}

/** The panel card's single scroll surface, shared with virtualized views. */
const PanelScrollContext = React.createContext<PanelScrollState>({
  top: 0,
  height: 0,
  element: null,
})

function PanelScrollProvider(props: {
  target: { readonly current: HTMLElement | null }
  children?: React.ReactNode
}): React.ReactElement {
  const [scroller, setScroller] = React.useState<PanelScrollState>({
    top: 0,
    height: 0,
    element: null,
  })
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const element = props.target.current
    if (element === null) return
    let frame = 0
    const read = (): void => {
      frame = 0
      setScroller((previous) => {
        const next = { top: element.scrollTop, height: element.clientHeight, element }
        return previous.top === next.top &&
          previous.height === next.height &&
          previous.element === next.element
          ? previous
          : next
      })
    }
    const schedule = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(read)
    }
    read()
    element.addEventListener('scroll', schedule, { passive: true })
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule)
      observer.observe(element)
    }
    return () => {
      element.removeEventListener('scroll', schedule)
      if (observer !== undefined) observer.disconnect()
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [props.target])
  return h(PanelScrollContext.Provider, { value: scroller }, props.children)
}

/**
 * Distance from the scroller's content top to a virtualized list's own top.
 *
 * A view may render fixed content above its list (the dependencies cycle
 * banner), so the window arithmetic must start at the list, not at the
 * scroller. Measuring the live rects keeps the offset right across a panel
 * resize and the banner's Collapse transition.
 */
function useVirtualOffset(ref: React.RefObject<HTMLElement | null>): number {
  const viewport = React.useContext(PanelScrollContext)
  const [offset, setOffset] = React.useState(0)
  // No dependency array: the offset is re-read after every render (a scroll
  // frame, a scope change or a resized banner), and a stable read bails out.
  React.useLayoutEffect(() => {
    const scroller = viewport.element
    const node = ref.current
    if (scroller === null || node === null) return
    const next = node.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop
    setOffset((previous) => (Math.abs(previous - next) < 0.5 ? previous : next))
  })
  return offset
}

/**
 * Window one fixed-height row list into the panel scroller.
 *
 * `offset` is the height of any fixed content rendered above the list inside
 * the same scroller, so the first visible row is computed from the list's own
 * top. Returns the slice to render plus the heights of the unrendered leading
 * and trailing rows. Before the scroller is measured (first paint) a small
 * initial window is returned; the measuring effect immediately corrects it.
 */
function useVirtualRange(
  rowCount: number,
  rowHeight: number = PANEL_ROW_HEIGHT,
  overscan: number = VIRTUAL_OVERSCAN,
  offset: number = 0,
): {
  start: number
  end: number
  topPad: number
  bottomPad: number
} {
  const viewport = React.useContext(PanelScrollContext)
  const height = Math.max(1, rowHeight)
  const pad = Math.max(0, Math.floor(overscan))
  if (rowCount <= 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0 }
  const visible = viewport.height > 0
    ? Math.ceil(viewport.height / height)
    : 16
  const scrolled = Math.max(0, viewport.top - Math.max(0, offset))
  const first = Math.max(0, Math.floor(scrolled / height))
  const start = Math.max(0, first - pad)
  const end = Math.min(rowCount, first + visible + pad)
  return {
    start,
    end,
    topPad: start * height,
    bottomPad: (rowCount - end) * height,
  }
}

/** Zero-height spacer that preserves the height of unrendered rows. */
function virtualSpacer(height: number, key: string): React.ReactElement | null {
  return height > 0 ? h(MuiBox, { key, sx: { height, flex: 'none' } }) : null
}

/* ------------------------------------------------------------------------- *
 * VirtualList / VirtualTree + adapters
 *
 * Both primitives are data-shape agnostic: a view supplies a small adapter
 * (count/key/read access, or roots/key/children) plus an item slot. Only the
 * rows inside the panel viewport are mounted. A tree slot receives the row's
 * depth and the adapter's node value; a flat list slot receives the row index
 * and the value. Leading/trailing spacers keep the scroll height exact.
 * ------------------------------------------------------------------------- */

/** One tree node handed to {@link VirtualTree}; `value` is the caller's item. */
export interface VirtualTreeEntry<T> {
  /** Stable identity across renders (also the expansion-state key). */
  key: string
  value: T
  children?: readonly VirtualTreeEntry<T>[]
}

/** Adapter for {@link VirtualList}: a random-access, keyed flat sequence. */
export interface VirtualListAdapter<T> {
  readonly size: number
  key(index: number): string
  at(index: number): T
}

/** Adapter for {@link VirtualTree}: roots plus the node key/children accessors. */
export interface VirtualTreeAdapter<T> {
  readonly roots: readonly T[]
  key(value: T): string
  /** Always returns an array, so a leaf is simply empty. */
  children(value: T): readonly T[]
}

/** One flattened, currently visible tree row. `index` is its array position. */
export interface VirtualTreeRow<T> {
  readonly depth: number
  readonly index: number
  readonly value: T
}

/** Adapt any array to the flat list; keys default to the row index. */
export function createVirtualListAdapter<T>(
  items: readonly T[],
  key?: (value: T, index: number) => string,
): VirtualListAdapter<T> {
  return {
    size: items.length,
    key: (index) => key?.(items[index] as T, index) ?? String(index),
    at: (index) => items[index] as T,
  }
}

/** Adapt roots + accessors to the virtual tree; leaves need no children callback. */
export function createVirtualTreeAdapter<T>(
  roots: readonly T[],
  key: (value: T) => string,
  children?: (value: T) => readonly T[],
): VirtualTreeAdapter<T> {
  return { roots, key, children: children ?? (() => []) }
}

/** Adapter for the `{ key, value, children }` tree shape used by views. */
export function entryTreeAdapter<T>(
  entries: readonly VirtualTreeEntry<T>[],
): VirtualTreeAdapter<VirtualTreeEntry<T>> {
  return {
    roots: entries,
    key: (entry) => entry.key,
    children: (entry) => entry.children ?? [],
  }
}

/**
 * Flatten a tree to its visible rows in pre-order.
 *
 * Pure: an adapter plus a collapsed-key set always yields the same rows. A
 * collapsed node is still emitted (as its branch's row) but its children are
 * skipped; `index` is always the row's own array index, continuous across
 * depths and exactly what the window arithmetic and the row slot use.
 */
export function visibleTreeRows<T>(
  adapter: VirtualTreeAdapter<T>,
  collapsed: ReadonlySet<string>,
): VirtualTreeRow<T>[] {
  const rows: VirtualTreeRow<T>[] = []
  const walk = (nodes: readonly T[], depth: number): void => {
    for (const value of nodes) {
      const key = adapter.key(value)
      rows.push({ depth, index: rows.length, value })
      if (collapsed.has(key)) continue
      const children = adapter.children(value)
      if (children.length > 0) walk(children, depth + 1)
    }
  }
  walk(adapter.roots, 0)
  return rows
}

export interface VirtualTreeProps<T> {
  adapter: VirtualTreeAdapter<T>
  /** Controlled expansion state, owned by the view (not the component). */
  collapsed: ReadonlySet<string>
  /** Toggle one branch; `key` comes from `adapter.key(value)`. */
  onToggle: (key: string) => void
  /** Row slot: (depth, flattened row index, adapter value). */
  slot: (depth: number, index: number, value: T) => React.ReactNode
  /** Accessible name for the virtualized tree surface. */
  'aria-label'?: string
}

/**
 * Row-height strategy for {@link VirtualList}.
 *
 * A number keeps the strict fixed-row window (48 px by default, used by every
 * tree/flat panel list). A function opts into estimated variable rows, which is
 * what the agent transcript needs: a bubble's height depends on its Markdown
 * content. Estimates are cumulative and the scroll offset is mapped onto that
 * cumulative height, so the scrollbar still represents the whole transcript.
 */
export type VirtualRowHeight<T> = number | ((index: number, value: T) => number)

interface VariableRowLayout {
  readonly tops: readonly number[]
  readonly sizes: readonly number[]
  readonly total: number
}

const EMPTY_ROW_LAYOUT: VariableRowLayout = { tops: [], sizes: [], total: 0 }

function clampRowHeight(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1
}

/** Cumulative top offsets for estimated rows; pure and deterministic. */
function variableRowLayout<T>(
  adapter: VirtualListAdapter<T>,
  estimate: (index: number, value: T) => number,
): VariableRowLayout {
  const tops = new Array<number>(adapter.size)
  const sizes = new Array<number>(adapter.size)
  let top = 0
  for (let index = 0; index < adapter.size; index += 1) {
    const height = clampRowHeight(estimate(index, adapter.at(index)))
    tops[index] = top
    sizes[index] = height
    top += height
  }
  return { tops, sizes, total: top }
}

/** First index whose cumulative top is >= target (array is non-decreasing). */
function lowerBound(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = (low + high) >> 1
    if ((values[middle] as number) < target) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * Window variable-height rows: binary-search the cumulative offsets for the
 * first/last row intersecting the visible band, then add the overscan.
 */
function useVariableRange(
  layout: VariableRowLayout,
  offset: number,
): { start: number; end: number } {
  const viewport = React.useContext(PanelScrollContext)
  const count = layout.tops.length
  if (count === 0) return { start: 0, end: 0 }
  const top = Math.max(0, viewport.top - Math.max(0, offset))
  const height = viewport.height > 0 ? viewport.height : 720
  const first = Math.max(0, lowerBound(layout.tops, top) - 1)
  const last = Math.min(count - 1, lowerBound(layout.tops, top + height))
  return {
    start: Math.max(0, first - VIRTUAL_OVERSCAN),
    end: Math.min(count, last + VIRTUAL_OVERSCAN + 1),
  }
}

export interface VirtualListProps<T> {
  adapter: VirtualListAdapter<T>
  /** Row slot: (row index, adapter value). */
  slot: (index: number, value: T) => React.ReactNode
  /** Fixed row height (default 48), or an estimated height per row. */
  rowHeight?: VirtualRowHeight<T>
  /** Accessible name for the virtualized list surface. */
  'aria-label'?: string
}

/** Virtualized flat list: the slot receives (index, value). */
export function VirtualList<T>(props: VirtualListProps<T>): React.ReactElement {
  const containerRef = React.useRef<HTMLElement | null>(null)
  const offset = useVirtualOffset(containerRef)
  const rowHeight = props.rowHeight
  const variable = typeof rowHeight === 'function'
  const layout = React.useMemo(
    () => (typeof rowHeight === 'function'
      ? variableRowLayout(props.adapter, rowHeight)
      : EMPTY_ROW_LAYOUT),
    [props.adapter, rowHeight],
  )
  // Both windows are computed unconditionally (hooks order); only the one the
  // row-height strategy selects is rendered.
  const range = useVirtualRange(
    variable ? 0 : props.adapter.size,
    PANEL_ROW_HEIGHT,
    VIRTUAL_OVERSCAN,
    offset,
  )
  const variableRange = useVariableRange(layout, offset)
  if (variable) {
    return h(
      MuiBox,
      {
        ref: containerRef,
        role: 'listbox',
        'aria-label': props['aria-label'],
        sx: { ...LIST_SX, position: 'relative', height: layout.total },
      },
      ...Array.from({ length: variableRange.end - variableRange.start }, (_unused, position) => {
        const index = variableRange.start + position
        return h(
          MuiBox,
          {
            key: props.adapter.key(index),
            style: {
              position: 'absolute',
              left: 0,
              right: 0,
              top: layout.tops[index],
              height: layout.sizes[index],
              overflow: 'hidden',
            },
          },
          props.slot(index, props.adapter.at(index)),
        )
      }),
    )
  }
  return h(
    MuiBox,
    {
      ref: containerRef,
      role: 'listbox',
      'aria-label': props['aria-label'],
      sx: LIST_SX,
    },
    virtualSpacer(range.topPad, 'virtual-list-top'),
    ...Array.from({ length: range.end - range.start }, (_unused, position) => {
      const index = range.start + position
      return h(
        MuiBox,
        { key: props.adapter.key(index), sx: VIRTUAL_ROW_SX },
        props.slot(index, props.adapter.at(index)),
      )
    }),
    virtualSpacer(range.bottomPad, 'virtual-list-bottom'),
  )
}

/** Virtualized tree: the slot receives (depth, flattened index, value). */
export function VirtualTree<T>(props: VirtualTreeProps<T>): React.ReactElement {
  // Expansion is controlled by the view; the component only flattens, windows
  // rows and provides keyboard collapse/expand through `onToggle`.
  const rows = React.useMemo(
    () => visibleTreeRows(props.adapter, props.collapsed),
    [props.adapter, props.collapsed],
  )
  const containerRef = React.useRef<HTMLElement | null>(null)
  const offset = useVirtualOffset(containerRef)
  const range = useVirtualRange(rows.length, PANEL_ROW_HEIGHT, VIRTUAL_OVERSCAN, offset)
  const rowInfo = React.useMemo(() => {
    const info = new Map<string, boolean>()
    for (const row of rows) info.set(props.adapter.key(row.value), props.adapter.children(row.value).length > 0)
    return info
  }, [props.adapter, rows])
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const target = event.target as unknown as {
      closest?: (selector: string) => HTMLElement | null
    } | null
    const row = target?.closest?.('[data-coordination-tree-key]') ?? null
    const key = row?.dataset.coordinationTreeKey
    if (key === undefined || rowInfo.get(key) !== true) return
    const expanded = !props.collapsed.has(key)
    if (event.key === 'ArrowLeft' ? expanded : !expanded) {
      event.preventDefault()
      props.onToggle(key)
    }
  }
  return h(
    MuiBox,
    {
      ref: containerRef,
      role: 'tree',
      'aria-label': props['aria-label'],
      onKeyDown,
      sx: LIST_SX,
    },
    virtualSpacer(range.topPad, 'virtual-tree-top'),
    ...rows.slice(range.start, range.end).map(({ depth, index, value }) => {
      const key = props.adapter.key(value)
      return h(
        MuiBox,
        {
          key,
          'data-coordination-tree-key': key,
          sx: VIRTUAL_ROW_SX,
        },
        props.slot(depth, index, value),
      )
    }),
    virtualSpacer(range.bottomPad, 'virtual-tree-bottom'),
  )
}

/** Scope bar: fixed row under the title bar. */
export const SCOPE_BAR_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  flex: 'none',
  paddingLeft: 1,
  paddingRight: 1,
  paddingTop: 0.5,
  paddingBottom: 0.5,
  borderBottom: '1px solid',
  borderColor: 'divider',
  backgroundColor: 'background.paper',
}

const READ_ONLY_SX = { flex: 'none', fontSize: 11, paddingLeft: 1 }

const SCOPE_CHIP_SX = {
  maxWidth: '100%',
  '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
  '& .MuiChip-deleteIcon': { marginLeft: 0.5, marginRight: 0.5 },
}

const ALERT_SX = { marginBottom: 1.5, alignItems: 'flex-start' }
const ALERT_TITLE_SX = { fontWeight: 600 }
const CYCLE_BOX_SX = { marginTop: 0.5 }

const MONO_SX = {
  fontFamily: 'monospace',
  fontSize: 11,
  lineHeight: 1.6,
  overflowWrap: 'anywhere',
}

const MORE_SX = { display: 'block', marginTop: 0.25 }

const DEP_LABEL_SX = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 0.75,
  minWidth: 0,
  flex: 1,
}

const DEP_ENDPOINT_SX = { minWidth: 0 }

const DEP_ARROW_SX = { flex: 'none' }

const DEP_CHIPS_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.5,
  flex: 'none',
}

/** One hit inside the header combobox's result listbox. */
const SEARCH_HIT_TOP_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.75,
  minWidth: 0,
}

const SEARCH_HIT_NAME_SX = { minWidth: 0, flex: 1 }

const SEARCH_HIT_META_SX = { fontFamily: 'monospace', fontSize: 11 }

/** Shared prose styling for rendered Markdown and sanitized HTML. */
const PREVIEW_PROSE_SX = {
  fontSize: 12,
  lineHeight: 1.6,
  overflowWrap: 'anywhere',
  '& p': { margin: '0 0 8px' },
  '& h1': { fontSize: 18, margin: '8px 0' },
  '& h2': { fontSize: 16, margin: '8px 0' },
  '& h3': { fontSize: 14, margin: '8px 0' },
  '& h4, & h5, & h6': { fontSize: 13, margin: '8px 0' },
  '& ul, & ol': { paddingLeft: 3, margin: '0 0 8px' },
  '& li': { marginBottom: 2 },
  '& a': { color: 'primary.main' },
  '& img': { maxWidth: '100%' },
  '& blockquote': {
    margin: '0 0 8px',
    paddingLeft: 1.5,
    borderLeft: '3px solid',
    borderColor: 'divider',
    color: 'text.secondary',
  },
  '& code': { fontFamily: 'monospace', fontSize: 11 },
  '& pre': {
    margin: '0 0 8px',
    padding: 1,
    overflowX: 'auto',
    borderRadius: 1,
    backgroundColor: 'action.hover',
  },
  '& pre code': { padding: 0, backgroundColor: 'transparent' },
  '& table': { width: '100%', borderCollapse: 'collapse', marginBottom: 1 },
  '& th, & td': {
    border: '1px solid',
    borderColor: 'divider',
    padding: '2px 6px',
    textAlign: 'left',
  },
}

const PREVIEW_BOX_SX = { ...PREVIEW_PROSE_SX, paddingBottom: 1 }

const PREVIEW_PRE_SX = {
  margin: 0,
  padding: 1,
  overflowX: 'auto',
  borderRadius: 1,
  backgroundColor: 'action.hover',
  fontFamily: 'monospace',
  fontSize: 11,
  lineHeight: 1.5,
  whiteSpace: 'pre',
  tabSize: 2,
}

const PREVIEW_CODE_BOX_SX = {
  overflow: 'hidden',
  borderRadius: 1,
  backgroundColor: 'action.hover',
}

const TABS_SX = { minHeight: 36, borderBottom: '1px solid', borderColor: 'divider' }

const TABLE_SX = {
  '& td, & th': { padding: '3px 8px', fontSize: 11, borderBottom: '1px solid', borderColor: 'divider' },
}

const TABLE_HEAD_CELL_SX = { fontWeight: 600, backgroundColor: 'action.hover' }

const SLIDE_CARD_SX = { marginBottom: 1.5 }

const SLIDE_CONTENT_SX = { padding: 1.5, '&:last-child': { paddingBottom: 1.5 } }

const SLIDE_TITLE_SX = { fontWeight: 600, marginTop: 0.25 }

const SLIDE_LINE_SX = { whiteSpace: 'pre-wrap' }

/* Agent list / message view */
const AGENTS_VIEW_SX = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
}

const AGENTS_LIST_SX = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
}

const AGENT_ITEM_SX = {
  display: 'flex',
  alignItems: 'stretch',
  borderBottom: '1px solid',
  borderColor: 'divider',
}

const AGENT_BUTTON_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  flex: 1,
  minWidth: 0,
  paddingTop: 0.75,
  paddingBottom: 0.75,
  paddingLeft: 1,
  paddingRight: 0.5,
}

const AGENT_TEXT_SX = { minWidth: 0, flex: 1 }

const AGENT_OBJECTIVE_SX = { display: 'block' }

const AGENT_RING_SX = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
}

const AGENT_RING_VALUE_SX = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 9,
  lineHeight: 1,
}

const AGENT_CHIP_WRAP_SX = { flex: 'none', marginLeft: 0.5 }

const AGENT_EXPAND_SX = { flex: 'none', alignSelf: 'center', marginRight: 0.5 }

const AGENT_CHILD_SX = { paddingLeft: 3 }

const AGENTS_FOOTER_SX = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  height: 38,
  maxHeight: 40,
  paddingLeft: 1,
  paddingRight: 1,
  borderTop: '1px solid',
  borderColor: 'divider',
}

const AGENTS_FOOTER_TEXT_SX = { flex: 'none', fontSize: 11, whiteSpace: 'nowrap' }

const AGENT_SKELETON_ROW_SX = { display: 'flex', alignItems: 'center', gap: 1, padding: 1 }

const MESSAGES_VIEW_SX = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
}

const MESSAGES_HEADER_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  flex: 'none',
  paddingBottom: 0.5,
  marginBottom: 0.5,
  borderBottom: '1px solid',
  borderColor: 'divider',
}

const MESSAGES_TITLE_SX = { minWidth: 0, flex: 1 }

const MESSAGES_SKELETON_SX = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0.75,
  paddingTop: 0.5,
  paddingBottom: 1,
}

/** One chat row: a full-width flex line that aligns its bubble. */
const MESSAGE_ROW_SX = {
  display: 'flex',
  width: '100%',
  paddingLeft: 0.5,
  paddingRight: 0.5,
  boxSizing: 'border-box',
}

/**
 * Bubble shell. `textAlign`/alignment is supplied per role; the body Markdown
 * uses {@link MESSAGE_PROSE_SX}. The estimated virtual row height is enforced
 * by the list; long text scrolls inside an expanded bubble.
 */
const MESSAGE_BUBBLE_SX = {
  maxWidth: '88%',
  borderRadius: 1,
  paddingTop: 0.75,
  paddingBottom: 0.75,
  paddingLeft: 1,
  paddingRight: 1,
  fontSize: 12,
  lineHeight: 1.5,
  overflowWrap: 'anywhere',
  border: '1px solid',
  borderColor: 'divider',
  boxSizing: 'border-box',
}

/** User: right aligned, light `primary.main` tint. */
const MESSAGE_USER_SX = {
  ...MESSAGE_BUBBLE_SX,
  marginLeft: 'auto',
  backgroundColor: alpha(theme.palette.primary.main, 0.12),
  borderColor: alpha(theme.palette.primary.main, 0.35),
  color: 'text.primary',
}

/** Assistant: left aligned on the paper background. */
const MESSAGE_ASSISTANT_SX = {
  ...MESSAGE_BUBBLE_SX,
  marginRight: 'auto',
  backgroundColor: 'background.paper',
}

/** Tool / system: centred, small grey notice with no bubble chrome. */
const MESSAGE_NOTICE_SX = {
  ...MESSAGE_BUBBLE_SX,
  marginLeft: 'auto',
  marginRight: 'auto',
  maxWidth: '100%',
  backgroundColor: 'transparent',
  borderColor: 'transparent',
  color: 'text.secondary',
  fontSize: 11,
}

const MESSAGE_META_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.75,
  flexWrap: 'wrap',
  marginBottom: 0.25,
  fontSize: 10,
  lineHeight: 1.2,
  color: 'text.secondary',
}

const MESSAGE_META_USER_SX = { justifyContent: 'flex-end' }
const MESSAGE_ROLE_SX = { fontWeight: 600, fontSize: 10 }
const MESSAGE_TIME_SX = { fontSize: 10, opacity: 0.75 }
const MESSAGE_NOTICE_TEXT_SX = { fontStyle: 'italic', textAlign: 'center' }

/** Expanded bubble body: capped at the virtual row's max estimated height. */
const MESSAGE_BODY_SX = {
  maxHeight: 216,
  overflowY: 'auto',
  overflowX: 'hidden',
}

/* Canvas view */
const CANVAS_STACK_SX = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  minHeight: 0,
}

const CANVAS_FRAME_SX = {
  position: 'relative',
  width: '100%',
  height: 320,
  minHeight: 240,
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: 1,
  overflow: 'hidden',
  backgroundColor: 'action.hover',
}

const CANVAS_SX = {
  display: 'block',
  width: '100%',
  height: '100%',
  cursor: 'grab',
  outline: 'none',
  touchAction: 'none',
}

/** Transparent 2D overlay for labels/ripple above the WebGL geometry canvas. */
const CANVAS_LABEL_SX = {
  ...CANVAS_SX,
  position: 'absolute',
  inset: 0,
  cursor: 'default',
  pointerEvents: 'none',
}

const CANVAS_CONTROLS_SX = {
  position: 'absolute',
  top: 6,
  right: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 0.25,
  zIndex: 2,
  backgroundColor: 'background.paper',
  borderRadius: 1,
  boxShadow: 1,
  padding: 0.25,
}

const CANVAS_TOOLTIP_SX = {
  position: 'absolute',
  zIndex: 3,
  pointerEvents: 'none',
  maxWidth: 300,
  paddingTop: 0.5,
  paddingBottom: 0.5,
  paddingLeft: 1,
  paddingRight: 1,
  border: '1px solid',
  borderColor: 'divider',
}

const GRAPH_STATUS_SX = {
  display: 'flex',
  alignItems: 'center',
  minHeight: 22,
  paddingLeft: 0.5,
  paddingRight: 0.5,
}

const GRAPH_TEXT_SX = {
  flex: 'none',
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: 1,
  '&:before': { display: 'none' },
}

const GRAPH_TEXT_SUMMARY_SX = { minHeight: 32, paddingLeft: 1, paddingRight: 1 }

const GRAPH_TEXT_DETAILS_SX = {
  paddingLeft: 1,
  paddingRight: 1,
  paddingTop: 0,
  paddingBottom: 1,
  maxHeight: 180,
  overflow: 'auto',
}

const TRUNCATED_SX = { marginBottom: 1 }

const SKELETON_BOX_SX = { display: 'flex', flexDirection: 'column', gap: 1, paddingTop: 0.5 }

const PREVIEW_STACK_SX = { position: 'relative', minHeight: 160 }

const SKELETON_OVERLAY_SX = {
  ...SKELETON_BOX_SX,
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
}

const PREVIEW_INFO_SX = { marginBottom: 1 }

const SNACKBAR_SX = { zIndex: theme.zIndex.tooltip }

const SNACKBAR_ALERT_SX = { alignItems: 'center' }

/* ------------------------------------------------------------------------- *
 * Docked column state
 * ------------------------------------------------------------------------- */

/** Which stacked panel a view belongs to. */
type PanelSide = 'left' | 'right'

/** The only persisted panel state: no coordinates, only expansion and width. */
interface ColumnState {
  openLeft: boolean
  openRight: boolean
  width: number
}

const DEFAULT_COLUMN_STATE: ColumnState = {
  openLeft: false,
  openRight: true,
  width: COLUMN_DEFAULT_WIDTH,
}

function readColumnState(): ColumnState {
  if (typeof window === 'undefined') return { ...DEFAULT_COLUMN_STATE }
  try {
    const raw = window.localStorage.getItem(COLUMN_STORAGE_KEY)
    if (raw === null) return { ...DEFAULT_COLUMN_STATE }
    const record = asRecord(JSON.parse(raw) as unknown)
    if (record === undefined) return { ...DEFAULT_COLUMN_STATE }
    return {
      openLeft: typeof record.openLeft === 'boolean' ? record.openLeft : DEFAULT_COLUMN_STATE.openLeft,
      openRight: typeof record.openRight === 'boolean' ? record.openRight : DEFAULT_COLUMN_STATE.openRight,
      width: Math.max(
        COLUMN_MIN_WIDTH,
        Math.min(COLUMN_MAX_WIDTH, Math.round(finiteNumber(record.width) ?? COLUMN_DEFAULT_WIDTH)),
      ),
    }
  } catch {
    return { ...DEFAULT_COLUMN_STATE }
  }
}

function writeColumnState(state: ColumnState): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      COLUMN_STORAGE_KEY,
      JSON.stringify({ openLeft: state.openLeft, openRight: state.openRight, width: state.width }),
    )
  } catch {
    // Blocked storage only loses the remembered expansion state.
  }
}

/* ------------------------------------------------------------------------- *
 * Hash route
 * ------------------------------------------------------------------------- */

interface PanelRoute {
  panel: boolean
  side: PanelSide
  view: PanelView
  path: string | null
  /** Selected agent id for the left panel's `agent` detail view. */
  id: string | null
}

interface RouteParams {
  path?: string | null
  id?: string | null
}

function readHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash
}

function isPanelView(value: unknown): value is PanelView {
  return typeof value === 'string' && (PANEL_VIEW_IDS as readonly string[]).indexOf(value) !== -1
}

function isPanelFamily(value: unknown): value is PanelFamily {
  return typeof value === 'string' && (PANEL_FAMILIES as readonly string[]).indexOf(value) !== -1
}

function outsideRoute(): PanelRoute {
  return { panel: false, side: 'right', view: 'files', path: null, id: null }
}

/**
 * `#coordination/panel/<left|right>/<view>[?path=…]`.
 *
 * The hash is a **deep link only**. Each panel resolves it once on mount and
 * from then on its own component state is authoritative; DSH's router is known
 * to rewrite `location.hash`, so no `hashchange` listener may feed state back
 * into the panels.
 */
function parseHash(hash: string): PanelRoute {
  if (!hash.startsWith(HASH_ROOT)) return outsideRoute()
  const rest = hash.slice(HASH_ROOT.length)
  const queryIndex = rest.indexOf('?')
  const routePart = queryIndex === -1 ? rest : rest.slice(0, queryIndex)
  const query = queryIndex === -1 ? '' : rest.slice(queryIndex + 1)
  const segments = routePart.split('/')
  const rawSide = segments[0] ?? ''
  if (rawSide !== 'left' && rawSide !== 'right') return outsideRoute()
  const viewPart = segments[1] ?? ''
  const params = new URLSearchParams(query)
  const path = params.get('path')
  const id = params.get('id')
  return {
    panel: true,
    side: rawSide,
    view: isPanelView(viewPart) ? viewPart : 'files',
    path: path !== null && path.length > 0 ? path : null,
    id: id !== null && id.length > 0 ? id : null,
  }
}

function buildHash(side: PanelSide, view: PanelView, params?: RouteParams): string {
  const base = `${HASH_ROOT}${side}/${view}`
  const query = new URLSearchParams()
  const path = params?.path?.trim() ?? ''
  const id = params?.id?.trim() ?? ''
  if (path.length > 0) query.set('path', path)
  if (id.length > 0) query.set('id', id)
  const suffix = query.toString()
  return suffix.length === 0 ? base : `${base}?${suffix}`
}

/* ------------------------------------------------------------------------- *
 * Panel navigation: component state is the source of truth
 * ------------------------------------------------------------------------- */

/** One panel's selected view and selection; the only navigation state. */
export interface PanelNavigationState {
  view: PanelView
  path: string | null
  id: string | null
}

/** The only transition: select a view, optionally with a path/agent id. */
export type PanelNavigationAction = {
  type: 'navigate'
  view: PanelView
  path?: string | null
  id?: string | null
}

/**
 * Pure view/selection transition.
 *
 * It never reads the location: a click changes this state directly, which is
 * what makes switching work even when the host router rewrites the hash.
 */
export function panelNavigationReducer(
  state: PanelNavigationState,
  action: PanelNavigationAction,
): PanelNavigationState {
  const path = action.path ?? null
  const id = action.id ?? null
  if (state.view === action.view && state.path === path && state.id === id) return state
  return { view: action.view, path, id }
}

/**
 * Resolve a panel's initial state from the hash.
 *
 * This is the **only** read of `location.hash` in the panel's lifetime. A hash
 * that names the other panel, or a view this side does not route, leaves the
 * panel on its default view with no selection.
 */
export function initialPanelNavigation(
  hash: string,
  side: PanelSide,
  routedViews: readonly PanelView[],
  fallbackView: PanelView,
): PanelNavigationState {
  const route = parseHash(hash)
  if (!route.panel || route.side !== side || !routedViews.includes(route.view)) {
    return { view: fallbackView, path: null, id: null }
  }
  return { view: route.view, path: route.path, id: route.id }
}

/** Per-side navigator installed by the mounted panel; child views call it. */
const panelNavigators = new Map<PanelSide, (view: PanelView, params?: RouteParams) => void>()

/**
 * Route a child view's navigation intent to its panel's local state.
 *
 * Both panels stay mounted for the column's lifetime, so the map has one entry
 * per side whenever a control can be clicked. A missing entry is a harmless
 * no-op (the panel is not mounted, so nothing visible could have sent it).
 */
function navigate(side: PanelSide, view: PanelView, params?: RouteParams): void {
  panelNavigators.get(side)?.(view, params)
}

/**
 * Best-effort deep-link mirror.
 *
 * Component state already changed; this only keeps a reloadable URL in sync.
 * `history.replaceState` fires no event and is wrapped so a host router that
 * throws (or a blocked history object) can never undo a local view switch.
 */
function mirrorHash(side: PanelSide, view: PanelView, params?: RouteParams): void {
  if (typeof window === 'undefined') return
  try {
    const hash = buildHash(side, view, params)
    if (window.location.hash !== hash) {
      window.history.replaceState(window.history.state, '', hash)
    }
  } catch {
    // Deep link only; the panel keeps working from its local state.
  }
}

/* ------------------------------------------------------------------------- *
 * Narrowing helpers
 * ------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function firstArray(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): unknown[] | undefined {
  if (record === undefined) return undefined
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return undefined
}

/** Strings or `{ name, path, label, handle }` objects, de-duplicated. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const text = endpointLabel(entry)
    if (text.length === 0 || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

function canonicalPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function baseName(value: string): string {
  const parts = canonicalPath(value).split('/')
  return parts[parts.length - 1] ?? value
}

function pathSegmentCount(value: string): number {
  return canonicalPath(value).split('/').filter((part) => part.length > 0).length
}

function samePath(left: string, right: string): boolean {
  const a = canonicalPath(left)
  const b = canonicalPath(right)
  return a === b || baseName(a) === baseName(b)
}

/** The shared leading directory depth of a set of workspace paths. */
function commonPathDepth(paths: readonly string[]): number {
  if (paths.length === 0) return 0
  const split = paths.map((path) => canonicalPath(path).split('/').filter((part) => part.length > 0))
  const first = split[0] ?? []
  let common = first.length
  for (const parts of split) {
    let index = 0
    while (index < common && index < parts.length && parts[index] === first[index]) index += 1
    common = index
  }
  return common
}

/** Add the selected file to a graph route when one is selected. */
function withPath(route: string, path: string | null): string {
  return path === null || path.length === 0 ? route : `${route}?path=${encodeURIComponent(path)}`
}

/* ------------------------------------------------------------------------- *
 * Host payload parsers
 * ------------------------------------------------------------------------- */

interface TreeEntry {
  path: string
  name: string
  directory: boolean
  depth: number
  /** Synthetic project-root rows carry the manifest caption. */
  manifest?: string
}

/** One outermost manifest project of `/graph/tree` (host roots are absolute). */
export interface TreeProject {
  root: string
  manifest: string
}

/**
 * The `/graph/tree` value the Files view renders.
 *
 * `root` is the absolute workspace root the host actually scanned; the empty
 * state shows it so a wrong root (a desktop install directory, say) is visible
 * instead of looking like an ordinary empty workspace. `projects` are the
 * outermost manifest scopes only; a nested manifest never appears separately.
 */
interface TreeData {
  root: string
  entries: TreeEntry[]
  projects: TreeProject[]
}

function parseTree(value: unknown): TreeData {
  const record = asRecord(value)
  const entries: TreeEntry[] = []
  let explicitDepth = false
  let nested = false

  const walk = (items: readonly unknown[], depth: number): void => {
    for (const item of items) {
      const itemRecord = asRecord(item)
      const path = itemRecord === undefined
        ? asString(item)
        : asString(itemRecord.path) ?? asString(itemRecord.file) ?? asString(itemRecord.name)
      if (path === undefined) continue
      const depthValue = itemRecord === undefined ? undefined : finiteNumber(itemRecord.depth)
      if (depthValue !== undefined) explicitDepth = true
      const ownDepth = depthValue === undefined ? depth : Math.max(0, Math.floor(depthValue))
      const directory = itemRecord !== undefined && (
        itemRecord.directory === true ||
        itemRecord.kind === 'directory' ||
        itemRecord.kind === 'dir' ||
        itemRecord.type === 'directory' ||
        itemRecord.type === 'dir'
      )
      entries.push({
        path,
        name: (itemRecord === undefined ? undefined : asString(itemRecord.name)) ?? baseName(path),
        directory,
        depth: ownDepth,
      })
      const children = itemRecord === undefined
        ? undefined
        : Array.isArray(itemRecord.children)
          ? itemRecord.children
          : Array.isArray(itemRecord.nodes)
            ? itemRecord.nodes
            : undefined
      if (children !== undefined) {
        if (children.length > 0) nested = true
        walk(children, ownDepth + 1)
      }
    }
  }

  if (Array.isArray(value)) {
    walk(value, 0)
  } else {
    const rootRecord = asRecord(record?.root)
    if (rootRecord !== undefined) walk([rootRecord], 0)
    const list = firstArray(record, ['entries', 'nodes', 'tree', 'files', 'items'])
    if (list !== undefined) walk(list, 0)
  }

  if (!explicitDepth && !nested && entries.length > 0) {
    const baseDepth = commonPathDepth(entries.map((entry) => entry.path))
    for (const entry of entries) {
      entry.depth = Math.max(0, pathSegmentCount(entry.path) - baseDepth)
    }
  }
  const rawProjects = Array.isArray(record?.projects) ? record.projects : []
  const projects: TreeProject[] = []
  for (const rawProject of rawProjects) {
    const projectRecord = asRecord(rawProject)
    const root = projectRecord === undefined
      ? undefined
      : asString(projectRecord.root) ?? asString(projectRecord.path)
    if (root === undefined || root.trim().length === 0) continue
    projects.push({
      root,
      manifest: projectRecord === undefined
        ? ''
        : asString(projectRecord.manifest) ?? asString(projectRecord.manifestFile) ?? '',
    })
  }
  return { root: asString(record?.root) ?? '', entries, projects }
}

interface OutlineNode {
  name: string
  kind: string
  depth: number
  path: string | null
}

/** One file outline group (workspace mode) or family group (legacy file mode). */
export interface OutlineFileGroup {
  path: string | null
  family: string
  nodes: OutlineNode[]
  /** Outermost manifest scope that claims this file, when the host echoes one. */
  project?: OutlineProject
}

/**
 * Optional npm/maven project scope of a workspace outline.
 *
 * The host may report `projects: [{ root, name?, files? }]`; when it does not,
 * every file group is a direct child of the workspace root. `files` is the
 * explicit membership list when the host can provide one (a file can belong to
 * a project without living under its root).
 */
export interface OutlineProject {
  root: string
  name: string
  /** Manifest filename reported by the host (`package.json`, `pom.xml`, …). */
  manifest: string
  files: string[]
}

type Scope = 'file' | 'workspace'

interface OutlineData {
  scope: Scope
  /** Workspace root when the host includes it (otherwise fetched separately). */
  root: string
  /** The requested file of a file-scope response. */
  path: string | null
  /** Project scopes of a workspace response; empty when none are reported. */
  projects: OutlineProject[]
  /** Workspace file groups; empty for a file-scope response. */
  groups: OutlineFileGroup[]
  /** The structure nodes of the one requested file (file scope only). */
  nodes: OutlineNode[]
}

function parseOutlineNode(value: unknown): OutlineNode | null {
  const record = asRecord(value)
  if (record === undefined) {
    const name = asString(value)
    return name === undefined ? null : { name, kind: '', depth: 0, path: null }
  }
  const name = asString(record.name) ?? asString(record.label) ?? asString(record.title)
  if (name === undefined) return null
  const depthValue = finiteNumber(record.depth) ?? finiteNumber(record.level)
  return {
    name,
    kind: asString(record.kind) ?? asString(record.type) ?? '',
    depth: depthValue === undefined ? 0 : Math.max(0, Math.floor(depthValue)),
    path: asString(record.path) ?? asString(record.file) ?? null,
  }
}

function parseOutlineNodes(value: unknown): OutlineNode[] {
  if (!Array.isArray(value)) return []
  return value
    .map(parseOutlineNode)
    .filter((node): node is OutlineNode => node !== null)
}

/** Parse the optional project scopes of a workspace outline. */
function parseOutlineProjects(value: unknown): OutlineProject[] {
  if (!Array.isArray(value)) return []
  const projects: OutlineProject[] = []
  for (const raw of value) {
    const record = asRecord(raw)
    if (record === undefined) continue
    const root = asString(record.root) ?? asString(record.path) ?? asString(record.dir)
    if (root === undefined || root.trim().length === 0) continue
    projects.push({
      root: canonicalPath(root),
      name: asString(record.name) ?? baseName(root),
      manifest: asString(record.manifest) ?? asString(record.manifestFile) ?? asString(record.file) ?? '',
      files: stringList(record.files ?? record.paths).map(canonicalPath),
    })
  }
  return projects
}

/**
 * File scope and workspace scope are different payloads:
 *
 *  - `{ scope: 'file', path, family, nodes }` — the one file's structure; this
 *    is the only thing the local outline may render.
 *  - `{ scope: 'workspace', groups, projects?, root? }` — per-file groups; only
 *    the global outline may render these.
 *
 * A file response that (defensively) contains `groups` instead of `nodes` is
 * flattened into this file's nodes; a workspace response never leaks into the
 * local mode (`OutlineView` rejects a non-`file` scope explicitly).
 */
function parseOutline(value: unknown): OutlineData {
  const record = asRecord(value)
  const scopeValue = asString(record?.scope)
  const rawGroups = record?.groups
  const scope: Scope = scopeValue === 'workspace' || (scopeValue === undefined && Array.isArray(rawGroups))
    ? 'workspace'
    : 'file'
  const root = asString(record?.root) ?? ''

  if (scope === 'workspace') {
    const groups: OutlineFileGroup[] = []
    if (Array.isArray(rawGroups)) {
      for (const rawGroup of rawGroups) {
        const groupRecord = asRecord(rawGroup)
        if (groupRecord === undefined) continue
        const nodes = parseOutlineNodes(groupRecord.nodes)
        if (nodes.length === 0) continue
        const projectRecord = asRecord(groupRecord.project)
        const projectRoot = projectRecord === undefined
          ? undefined
          : asString(projectRecord.root) ?? asString(projectRecord.path)
        const group: OutlineFileGroup = {
          path: asString(groupRecord.path) ?? asString(groupRecord.file) ?? null,
          family: asString(groupRecord.family) ?? asString(groupRecord.kind) ?? '',
          nodes,
        }
        if (projectRoot !== undefined && projectRoot.trim().length > 0) {
          group.project = {
            root: projectRoot,
            name: projectRecord === undefined
              ? baseName(projectRoot)
              : asString(projectRecord.name) ?? baseName(projectRoot),
            manifest: projectRecord === undefined
              ? ''
              : asString(projectRecord.manifest) ?? asString(projectRecord.manifestFile) ?? '',
            files: [],
          }
        }
        groups.push(group)
      }
    } else {
      // No `groups` array: group a flat node list by each node's own path.
      for (const node of parseOutlineNodes(firstArray(record, ['nodes', 'outline', 'entries', 'items']))) {
        const previous = groups[groups.length - 1]
        if (previous !== undefined && previous.path === node.path) {
          previous.nodes.push(node)
        } else {
          groups.push({ path: node.path, family: '', nodes: [node] })
        }
      }
    }
    return {
      scope,
      root,
      path: null,
      projects: parseOutlineProjects(record?.projects),
      groups,
      nodes: [],
    }
  }

  let nodes: OutlineNode[] = []
  if (Array.isArray(record?.nodes)) nodes = parseOutlineNodes(record?.nodes)
  else if (Array.isArray(rawGroups)) {
    // Defensive: some hosts spell the file response with `groups`.
    for (const rawGroup of rawGroups) {
      const groupRecord = asRecord(rawGroup)
      if (groupRecord === undefined) continue
      nodes = nodes.concat(parseOutlineNodes(groupRecord.nodes))
    }
  } else {
    nodes = parseOutlineNodes(firstArray(record, ['outline', 'entries', 'items']))
  }
  return {
    scope,
    root,
    path: asString(record?.path) ?? null,
    projects: [],
    groups: [],
    nodes,
  }
}

interface DependencyLink {
  from: string
  to: string
  relation: string
  cyclic: boolean
}

interface DependencyData {
  scope: Scope
  links: DependencyLink[]
  cycles: string[][]
}

function scopeOf(value: unknown): Scope {
  const record = asRecord(value)
  return asString(record?.scope) === 'file' ? 'file' : 'workspace'
}

/** A path, name, label or handle from a string-or-object endpoint. */
function endpointLabel(value: unknown): string {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  if (record === undefined) return ''
  return asString(record.path)
    ?? asString(record.name)
    ?? asString(record.label)
    ?? asString(record.handle)
    ?? ''
}

function parseCycles(value: unknown): string[][] {
  if (!Array.isArray(value)) return []
  const cycles: string[][] = []
  for (const raw of value) {
    if (!Array.isArray(raw)) continue
    const cycle = raw.map(endpointLabel).filter((entry) => entry.length > 0)
    if (cycle.length >= 2) cycles.push(cycle)
  }
  return cycles
}

function parseDependencies(value: unknown): DependencyData {
  const record = asRecord(value)
  const rawLinks = Array.isArray(value)
    ? value
    : firstArray(record, ['links', 'dependencies', 'edges', 'items', 'rows'])
  const links: DependencyLink[] = []
  for (const rawLink of rawLinks ?? []) {
    const linkRecord = asRecord(rawLink)
    if (linkRecord === undefined) continue
    const from = endpointLabel(linkRecord.from)
    const to = endpointLabel(linkRecord.to)
    if (from.length === 0 || to.length === 0) continue
    links.push({
      from,
      to,
      relation: asString(linkRecord.relation) ?? asString(linkRecord.kind) ?? asString(linkRecord.type) ?? '',
      cyclic: linkRecord.cyclic === true || linkRecord.cycle === true,
    })
  }
  return { scope: scopeOf(value), links, cycles: parseCycles(record?.cycles) }
}

interface ImportRow {
  path: string
  imported: string[]
  exported: string[]
  cyclic: boolean
  cycles: string[][]
}

interface ImportData {
  scope: Scope
  rows: ImportRow[]
  cycles: string[][]
}

interface IntraNodeData {
  id: string
  label: string
  depth: number
}

interface IntraEdgeData {
  from: string
  to: string
  relation: string
}

interface IntraData {
  path: string
  nodes: IntraNodeData[]
  edges: IntraEdgeData[]
  truncated: boolean
}

function parseIntra(value: unknown): IntraData {
  const record = asRecord(value)
  const nodes: IntraNodeData[] = []
  const rawNodes = firstArray(record, ['nodes'])
  for (const raw of rawNodes ?? []) {
    const nodeRecord = asRecord(raw)
    if (nodeRecord === undefined) continue
    const id = asString(nodeRecord.id) ?? asString(nodeRecord.handle)
    if (id === undefined) continue
    nodes.push({
      id,
      label: asString(nodeRecord.name) ?? asString(nodeRecord.label) ?? id,
      depth: Math.max(0, Math.floor(finiteNumber(nodeRecord.depth) ?? 0)),
    })
  }
  const edges: IntraEdgeData[] = []
  const rawEdges = firstArray(record, ['edges'])
  for (const raw of rawEdges ?? []) {
    const edgeRecord = asRecord(raw)
    if (edgeRecord === undefined) continue
    const from = asString(edgeRecord.from)
    const to = asString(edgeRecord.to)
    if (from === undefined || to === undefined) continue
    edges.push({ from, to, relation: asString(edgeRecord.relation) ?? 'depends' })
  }
  return {
    path: asString(record?.path) ?? '',
    nodes: nodes.slice(0, CANVAS_MAX_NODES),
    edges: edges.slice(0, CANVAS_MAX_EDGES),
    truncated: record?.truncated === true
      || nodes.length > CANVAS_MAX_NODES
      || edges.length > CANVAS_MAX_EDGES,
  }
}

function parseImports(value: unknown): ImportData {
  const record = asRecord(value)
  const rawRows = Array.isArray(value)
    ? value
    : firstArray(record, ['files', 'rows', 'imports', 'items', 'entries'])
  const rows: ImportRow[] = []
  for (const rawRow of rawRows ?? []) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === undefined) continue
    const path = asString(rowRecord.path) ?? asString(rowRecord.file) ?? asString(rowRecord.name)
    if (path === undefined) continue
    rows.push({
      path,
      imported: stringList(rowRecord.imported ?? rowRecord.imports),
      exported: stringList(rowRecord.exported ?? rowRecord.exports),
      cyclic: rowRecord.cyclic === true || rowRecord.cycle === true,
      cycles: parseCycles(rowRecord.cycles ?? rowRecord.cyclePaths),
    })
  }
  return { scope: scopeOf(value), rows, cycles: parseCycles(record?.cycles) }
}

interface SearchHit {
  kind: string
  name: string
  path: string | null
  line: number | null
  view: PanelView | null
  params: Record<string, string>
}

function parseSearch(value: unknown): SearchHit[] {
  const record = asRecord(value)
  const rawHits = Array.isArray(value)
    ? value
    : firstArray(record, ['results', 'hits', 'items', 'matches'])
  const hits: SearchHit[] = []
  for (const raw of rawHits ?? []) {
    const hitRecord = asRecord(raw)
    if (hitRecord === undefined) continue
    const path = asString(hitRecord.path) ?? asString(hitRecord.file) ?? null
    const kind = asString(hitRecord.kind) ?? asString(hitRecord.type) ?? ''
    const name = asString(hitRecord.name)
      ?? asString(hitRecord.label)
      ?? (path === null ? '' : baseName(path))
    if (name.length === 0 && kind.length === 0) continue
    const lineValue = finiteNumber(hitRecord.line) ?? finiteNumber(hitRecord.lineStart)
    const line = lineValue !== undefined && lineValue >= 1 ? Math.floor(lineValue) : null
    const viewValue = hitRecord.view
    const params: Record<string, string> = {}
    const rawParams = asRecord(hitRecord.params)
    if (rawParams !== undefined) {
      for (const [key, rawValue] of Object.entries(rawParams)) {
        const text = asString(rawValue)
        if (text !== undefined) params[key] = text
      }
    }
    if (path !== null && params.path === undefined) params.path = path
    hits.push({
      kind,
      name,
      path,
      line,
      view: isPanelView(viewValue) ? viewValue : null,
      params,
    })
  }
  return hits
}

interface SheetData {
  name: string
  rows: string[][]
}

interface SlideData {
  index: number
  title: string
  lines: string[]
}

interface PreviewData {
  path: string
  kind: string
  content: string
  truncated: boolean
  bytes: number | null
  sheets: SheetData[]
  slides: SlideData[]
}

function cellText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

function parseSheets(value: unknown): SheetData[] {
  if (!Array.isArray(value)) return []
  const sheets: SheetData[] = []
  for (const raw of value) {
    const record = asRecord(raw)
    if (record === undefined) continue
    const rows: string[][] = []
    if (Array.isArray(record.rows)) {
      for (const rawRow of record.rows) {
        if (!Array.isArray(rawRow)) continue
        rows.push(rawRow.map(cellText))
      }
    }
    sheets.push({
      name: asString(record.name) ?? String(sheets.length + 1),
      rows,
    })
  }
  return sheets
}

function parseSlides(value: unknown): SlideData[] {
  if (!Array.isArray(value)) return []
  const slides: SlideData[] = []
  for (const raw of value) {
    const record = asRecord(raw)
    if (record === undefined) continue
    const lines: string[] = []
    if (Array.isArray(record.lines)) {
      for (const rawLine of record.lines) lines.push(cellText(rawLine))
    }
    slides.push({
      index: Math.max(1, Math.floor(finiteNumber(record.index) ?? slides.length + 1)),
      title: asString(record.title) ?? '',
      lines,
    })
  }
  return slides
}

function parsePreview(value: unknown): PreviewData {
  const record = asRecord(value)
  return {
    path: asString(record?.path) ?? '',
    kind: (asString(record?.kind) ?? 'text').toLowerCase(),
    content: typeof record?.content === 'string' ? record.content : '',
    truncated: record?.truncated === true,
    bytes: finiteNumber(record?.bytes) ?? null,
    sheets: parseSheets(record?.sheets),
    slides: parseSlides(record?.slides),
  }
}

type ProgressBasis = 'completed' | 'turns' | 'unknown'

interface AgentProgressData {
  value: number
  estimated: boolean
  basis: ProgressBasis
}

interface AgentInfoData {
  id: string
  label: string
  status: string
  objective: string
  parentId: string | null
  startedAt: number | null
  completedAt: number | null
  progress: AgentProgressData
}

interface AgentListData {
  agents: AgentInfoData[]
  progress: AgentProgressData & { running: number; total: number }
}

interface AgentMessageData {
  role: string
  at: number | null
  text: string
}

/** The four roles the transcript maps to a bubble layout. */
export type MessageRoleKind = 'user' | 'assistant' | 'tool' | 'system'

/**
 * Normalise a transcript role. Unknown/missing roles become `assistant` so a
 * message is never dropped or rendered as a system notice by accident.
 */
export function messageRoleKind(role: string): MessageRoleKind {
  const value = role.trim().toLowerCase()
  if (value === 'user') return 'user'
  if (value === 'tool') return 'tool'
  if (value === 'system') return 'system'
  return 'assistant'
}

/**
 * Bubble alignment: the user sits right, the assistant left, and tool/system
 * messages are centred notices. Pure, so the chat layout is directly testable.
 */
export function messageAlignment(role: string): 'flex-end' | 'flex-start' | 'center' {
  const kind = messageRoleKind(role)
  if (kind === 'user') return 'flex-end'
  if (kind === 'assistant') return 'flex-start'
  return 'center'
}

/** ISO (host) or epoch-millisecond timestamps both become epoch milliseconds. */
function messageTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

interface AgentMessagesData {
  id: string
  messages: AgentMessageData[]
  truncated: boolean
}

function progressOf(value: unknown): AgentProgressData {
  const record = asRecord(value)
  const basisValue = asString(record?.basis)
  const basis: ProgressBasis = basisValue === 'completed' || basisValue === 'turns'
    ? basisValue
    : 'unknown'
  const valueNumber = finiteNumber(record?.value) ?? 0
  return {
    value: Math.max(0, Math.min(100, Math.round(valueNumber))),
    estimated: record?.estimated === true,
    basis,
  }
}

function parseAgents(value: unknown): AgentListData {
  const record = asRecord(value)
  const rawAgents = Array.isArray(value) ? value : firstArray(record, ['agents'])
  const agents: AgentInfoData[] = []
  for (const raw of rawAgents ?? []) {
    const agentRecord = asRecord(raw)
    if (agentRecord === undefined) continue
    const id = asString(agentRecord.id)
    if (id === undefined) continue
    agents.push({
      id,
      label: asString(agentRecord.label) ?? id,
      status: (asString(agentRecord.status) ?? 'inactive').toLowerCase(),
      objective: typeof agentRecord.objective === 'string' ? agentRecord.objective : '',
      parentId: asString(agentRecord.parentId) ?? null,
      startedAt: finiteNumber(agentRecord.startedAt) ?? null,
      completedAt: finiteNumber(agentRecord.completedAt) ?? null,
      progress: progressOf(agentRecord.progress),
    })
  }
  const topRecord = asRecord(record?.progress)
  const topBasisValue = asString(topRecord?.basis)
  const knownAgents = agents.filter((agent) => agent.progress.basis !== 'unknown')
  const estimatedAverage = knownAgents.length === 0
    ? 0
    : Math.round(knownAgents.reduce((sum, agent) => sum + agent.progress.value, 0) / knownAgents.length)
  const topBasis: ProgressBasis = topBasisValue === 'completed' || topBasisValue === 'turns'
    ? topBasisValue
    : knownAgents.length > 0 || topRecord !== undefined
      ? 'turns'
      : 'unknown'
  const running = agents.filter((agent) => agent.status === 'running').length
  return {
    agents,
    progress: {
      value: Math.max(0, Math.min(100, Math.round(finiteNumber(topRecord?.value) ?? estimatedAverage))),
      estimated: typeof topRecord?.estimated === 'boolean' ? topRecord.estimated : true,
      basis: topBasis,
      running: Math.max(0, Math.floor(finiteNumber(topRecord?.running) ?? running)),
      total: Math.max(0, Math.floor(finiteNumber(topRecord?.total) ?? agents.length)),
    },
  }
}

function parseAgentMessages(value: unknown): AgentMessagesData {
  const record = asRecord(value)
  const rawMessages = firstArray(record, ['messages']) ?? []
  const messages: AgentMessageData[] = []
  for (const raw of rawMessages) {
    const messageRecord = asRecord(raw)
    if (messageRecord === undefined) continue
    const text = typeof messageRecord.text === 'string' ? messageRecord.text : ''
    const role = (asString(messageRecord.role) ?? 'system').toLowerCase()
    const at = messageTimestamp(messageRecord.at) ?? messageTimestamp(messageRecord.time)
    if (text.length === 0) continue
    messages.push({ role, at, text })
  }
  return {
    id: asString(record?.id) ?? '',
    messages: messages.slice(0, 200),
    truncated: record?.truncated === true,
  }
}

type GraphState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; httpStatus: number | null }

/** Fetch one graph route for a view; `refresh` forces a new request. */
function useGraph<T>(
  path: string | null,
  parse: (value: unknown) => T,
  refresh: number,
  onSettled?: () => void,
): { state: GraphState<T>; retry: () => void } {
  const [state, setState] = React.useState<GraphState<T>>({ status: 'loading' })
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    if (path === null) {
      setState({ status: 'idle' })
      if (onSettled !== undefined) onSettled()
      return
    }
    let alive = true
    setState({ status: 'loading' })
    void fetchGraph(path).then((outcome) => {
      if (!alive) return
      setState(outcome.ok
        ? { status: 'ready', value: parse(outcome.value) }
        : { status: 'error', httpStatus: outcome.status })
      if (onSettled !== undefined) onSettled()
    })
    return () => {
      alive = false
    }
  }, [path, refresh, attempt, parse, onSettled])

  const retry = React.useCallback((): void => {
    setAttempt((previous) => previous + 1)
  }, [])

  return { state, retry }
}

/* ------------------------------------------------------------------------- *
 * Small shared components
 * ------------------------------------------------------------------------- */

/**
 * One tooltip wrapper for every interactive control. `describeChild` adds the
 * tooltip text as the child's `aria-describedby`, on top of its `aria-label`.
 */
function Tip(props: { label: string; children?: React.ReactElement }): React.ReactElement {
  return h(
    MuiTooltip,
    { title: props.label, arrow: true, enterDelay: 300, describeChild: true },
    props.children,
  )
}

function LoadingState(props: { copy: PanelCopy }): React.ReactElement {
  return h(
    MuiBox,
    { sx: STATE_BOX_SX },
    h(MuiCircularProgress, { size: 20 }),
    h(MuiTypography, { variant: 'body2', color: 'text.secondary' }, props.copy.states.loading),
  )
}

function EmptyState(props: { message: string }): React.ReactElement {
  return h(
    MuiBox,
    { sx: STATE_BOX_SX },
    h(MuiTypography, { variant: 'body2', color: 'text.secondary' }, props.message),
  )
}

/**
 * Empty graph state with the one explicit indexing entry point.
 *
 * A fresh profile has no persisted graph because the file tools only index the
 * paths they are asked to parse; this button asks the host to scan the
 * workspace once. Progress reuses the panel's shared `actionBusy` spinner and
 * Snackbar notice; the successful run refreshes the Files view.
 */
function IndexEmptyState(props: {
  copy: PanelCopy
  busy: boolean
  onIndex: (() => void) | undefined
  /** Absolute workspace root the host resolved for `/graph/tree`. */
  root: string
}): React.ReactElement {
  return h(
    MuiBox,
    { sx: INDEX_EMPTY_SX },
    h(MuiTypography, { variant: 'body2', color: 'text.secondary' }, props.copy.files.empty),
    h(MuiTypography, { variant: 'caption', color: 'text.secondary' }, props.copy.indexHint),
    // The resolved root is the one diagnostic that makes a wrong root visible:
    // a valid but unexpected path here explains the empty tree immediately.
    props.root.length === 0
      ? null
      : h(
        MuiTypography,
        {
          variant: 'caption',
          color: 'text.secondary',
          component: 'div',
          title: props.root,
          sx: MONO_SX,
        },
        `${props.copy.scopeWorkspace}: ${props.root}`,
      ),
    h(
      MuiButton,
      {
        variant: 'outlined',
        size: 'small',
        sx: INDEX_ACTION_SX,
        disabled: props.busy || props.onIndex === undefined,
        'aria-label': props.copy.tip.indexWorkspace,
        onClick: props.onIndex,
        startIcon: props.busy
          ? h(MuiCircularProgress, { size: 16 })
          : undefined,
      },
      props.copy.indexWorkspace,
    ),
  )
}

function ErrorState(props: { copy: PanelCopy; onRetry: () => void }): React.ReactElement {
  return h(
    MuiBox,
    { sx: ERROR_BOX_SX },
    h(MuiTypography, { variant: 'body2', color: 'text.secondary' }, props.copy.states.error),
    h(
      MuiButton,
      { size: 'small', variant: 'outlined', onClick: props.onRetry },
      props.copy.states.retry,
    ),
  )
}

/** Up to five cycle paths plus an overflow line; nothing when there are none. */
function CycleLines(props: { copy: PanelCopy; cycles: readonly string[][] }): React.ReactElement | null {
  if (props.cycles.length === 0) return null
  const visible = props.cycles.slice(0, MAX_CYCLE_LINES)
  const more = props.cycles.length - visible.length
  const children: React.ReactNode[] = visible.map((cycle, index) =>
    h(
      MuiTypography,
      { key: `cycle-${index}`, variant: 'caption', component: 'div', sx: MONO_SX },
      cycle.join(' → '),
    ),
  )
  if (more > 0) {
    children.push(h(
      MuiTypography,
      { key: 'more', variant: 'caption', color: 'text.secondary', sx: MORE_SX },
      fillTemplate(props.copy.moreCycles, { count: String(more) }),
    ))
  }
  return h(MuiBox, { sx: CYCLE_BOX_SX }, ...children)
}

/** The warning summary above a list that contains cyclic links. */
function CycleAlert(props: { copy: PanelCopy; cycles: readonly string[][] }): React.ReactElement | null {
  if (props.cycles.length === 0) return null
  return h(
    MuiAlert,
    { severity: 'warning', sx: ALERT_SX, icon: h(IconWarning, { fontSize: 'small' }) },
    h(
      MuiTypography,
      { variant: 'body2', sx: ALERT_TITLE_SX },
      fillTemplate(props.copy.cyclesFound, { count: String(props.cycles.length) }),
    ),
    h(CycleLines, { copy: props.copy, cycles: props.cycles }),
  )
}

/* ------------------------------------------------------------------------- *
 * Routed views
 * ------------------------------------------------------------------------- */

interface ViewProps {
  side: PanelSide
  copy: PanelCopy
  path: string | null
  /** Agent id for the left panel's `agent` detail view. */
  id: string | null
  refresh: number
  /** Report that the view's current load finished (menu spinner bookkeeping). */
  onSettled: () => void
  /** True while the empty Files view's indexing request is in flight. */
  indexBusy?: boolean
  /** Run the explicit `/graph/index` workspace scan (empty Files view). */
  onIndexWorkspace?: () => void
}

/** Build the virtual tree from `parseTree`'s depth-ordered flat entries. */
function buildFileTree(entries: readonly TreeEntry[]): VirtualTreeEntry<TreeEntry>[] {
  const roots: VirtualTreeEntry<TreeEntry>[] = []
  const open: Array<{ depth: number; children: VirtualTreeEntry<TreeEntry>[] }> = [
    { depth: -1, children: roots },
  ]
  entries.forEach((entry, index) => {
    while (open.length > 1 && (open[open.length - 1] as { depth: number }).depth >= entry.depth) open.pop()
    const parent = open[open.length - 1] as { children: VirtualTreeEntry<TreeEntry>[] }
    const node: VirtualTreeEntry<TreeEntry> = {
      key: `${index}:${entry.path}`,
      value: entry,
      children: [],
    }
    parent.children.push(node)
    open.push({ depth: entry.depth, children: node.children as VirtualTreeEntry<TreeEntry>[] })
  })
  return roots
}

function FilesView(props: ViewProps): React.ReactElement {
  const { state, retry } = useGraph('/graph/tree', parseTree, props.refresh, props.onSettled)
  // The file tree's root is the workspace root the host actually scanned; the
  // entries below it are never re-rooted on a common path prefix such as `src`.
  // Outermost manifest projects (when the host reports them) become one-level
  // project rows; every other file stays directly under the workspace root.
  const entries = React.useMemo(() => {
    if (state.status !== 'ready') return []
    const raw = state.value.entries
    if (raw.length === 0) return []
    const root = state.value.root
    const inside = (path: string, projectRoot: string): boolean =>
      projectRoot.length > 0 &&
      (path === projectRoot || path.startsWith(`${projectRoot}/`))
    const converted = state.value.projects
      .map((project) => ({
        root: workspaceRelativeRoot(project.root, root),
        manifest: project.manifest,
      }))
      .filter((project) => project.root.length > 0)
    // One project level only: drop a project nested inside another project.
    const projects = converted.filter((project) => !converted.some((other) =>
      other.root.length < project.root.length && inside(project.root, other.root)))
    const projectRows: Array<VirtualTreeEntry<TreeEntry>> = []
    let loose = raw
    for (const [index, project] of projects.entries()) {
      const owned = raw.filter((entry) => inside(entry.path, project.root))
      loose = loose.filter((entry) => !inside(entry.path, project.root))
      if (owned.length === 0) continue
      const rootDepth = project.root.split('/').length
      const relative = owned
        .filter((entry) => entry.path !== project.root)
        .map((entry) => ({ ...entry, depth: Math.max(0, entry.depth - rootDepth) }))
      projectRows.push({
        key: `project-root:${index}:${project.root}`,
        value: {
          path: project.root,
          name: project.root,
          directory: true,
          depth: -1,
          manifest: project.manifest,
        },
        children: buildFileTree(relative),
      })
    }
    return [{
      key: `workspace-root:${root}`,
      value: {
        path: root,
        name: root.length > 0 ? root : props.copy.scopeWorkspace,
        directory: true,
        depth: -1,
      },
      children: [...projectRows, ...buildFileTree(loose)],
    }]
  }, [state, props.copy])
  const adapter = React.useMemo(() => entryTreeAdapter(entries), [entries])
  // The Files view owns the tree's expansion state; `VirtualTree` is controlled.
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set())
  const onToggle = React.useCallback((key: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  if (state.status === 'loading' || state.status === 'idle') {
    return h(LoadingState, { copy: props.copy })
  }
  if (state.status === 'error') return h(ErrorState, { copy: props.copy, onRetry: retry })
  if (state.value.entries.length === 0) {
    return h(IndexEmptyState, {
      copy: props.copy,
      busy: props.indexBusy === true,
      onIndex: props.onIndexWorkspace,
      root: state.value.root,
    })
  }

  return h(VirtualTree<VirtualTreeEntry<TreeEntry>>, {
    adapter,
    collapsed,
    onToggle,
    'aria-label': props.copy.tabs.files,
    slot: (depth, _index, node) => {
      const entry = node.value
      const hasChildren = (node.children ?? []).length > 0
      const expanded = !collapsed.has(node.key)
      const projectRoot = node.key.startsWith('project-root:')
      if (node.key.startsWith('workspace-root:') || projectRoot) {
        // Workspace/project root headings: fold, never navigate or select.
        return h(
          MuiBox,
          { sx: PANEL_ROW_SHELL_SX },
          h(
            MuiListItemButton,
            {
              role: 'treeitem',
              'aria-level': depth + 1,
              'aria-expanded': hasChildren ? expanded : undefined,
              sx: PANEL_ROW_SX,
              style: { paddingLeft: 8 + depth * 16 },
              title: entry.path,
              onClick: hasChildren ? (): void => { onToggle(node.key) } : undefined,
            },
            h(
              MuiListItemIcon,
              { sx: PANEL_ROW_ICON_SX },
              h(projectRoot ? IconArticle : IconOutline, { fontSize: 'small' }),
            ),
            h(MuiListItemText, {
              primary: entry.name,
              secondary: entry.manifest ?? (projectRoot ? undefined : props.copy.scopeWorkspace),
              primaryTypographyProps: {
                ...PANEL_ROW_PRIMARY_PROPS,
                sx: { fontWeight: projectRoot ? 500 : 600 },
              },
              secondaryTypographyProps: PANEL_ROW_SECONDARY_PROPS,
            }),
          ),
        )
      }
      const selected = props.path === entry.path
      const preview = entry.directory || props.side !== 'right'
        ? null
        : h(
          Tip,
          { label: props.copy.tip.previewFile },
          h(
            MuiIconButton,
            {
              size: 'small',
              className: 'coordination-row-action',
              sx: PANEL_ROW_ACTION_SX,
              'aria-label': props.copy.tip.previewFile,
              onClick: (event: React.MouseEvent): void => {
                event.stopPropagation()
                navigate(props.side, 'preview', { path: entry.path })
              },
            },
            h(IconPreview, { fontSize: 'small' }),
          ),
        )
      return h(
        MuiBox,
        { sx: PANEL_ROW_SHELL_SX },
        h(
          MuiListItemButton,
          {
            selected,
            role: 'treeitem',
            'aria-level': depth + 1,
            'aria-expanded': hasChildren ? expanded : undefined,
            sx: PANEL_ROW_SX,
            style: {
              paddingLeft: 8 + depth * 16,
              paddingRight: preview === null ? undefined : 40,
            },
            title: entry.path,
            onClick: hasChildren
              ? (): void => { onToggle(node.key) }
              : (): void => {
                // Clicking the selected file again clears the selection. The
                // right panel opens the outline; the left panel only selects.
                if (selected) {
                  navigate(props.side, 'files')
                  return
                }
                navigate(props.side, props.side === 'right' ? 'outline' : 'files', { path: entry.path })
              },
          },
          h(
            MuiListItemIcon,
            { sx: PANEL_ROW_ICON_SX },
            h(hasChildren ? (expanded ? IconExpand : IconChevron) : IconArticle, {
              fontSize: 'small',
            }),
          ),
          h(MuiListItemText, {
            primary: entry.name,
            secondary: entry.path,
            primaryTypographyProps: {
              ...PANEL_ROW_PRIMARY_PROPS,
              sx: hasChildren ? { fontWeight: 500 } : undefined,
            },
            secondaryTypographyProps: PANEL_ROW_SECONDARY_PROPS,
          }),
        ),
        preview,
      )
    },
  })
}

function familyLabel(family: string, copy: PanelCopy): string {
  if (family === 'unknown') return ''
  return isPanelFamily(family) ? copy.families[family] : family
}

/** One row value handed to the outline's virtual tree slot. */
type OutlineRowValue =
  | { kind: 'root'; title: string; subtitle: string | null }
  | { kind: 'project'; title: string; manifest: string }
  | { kind: 'group'; group: OutlineFileGroup; title: string; nodeCount: number }
  | { kind: 'node'; node: OutlineNode; fallbackPath: string | null }

/**
 * Node kinds kept out of the local (file) outline.
 *
 * The local page is a document-structure tree: modules, classes, functions,
 * methods, interfaces, types, enumerations and namespaces. Variable/property/
 * static members, imports/exports and line/sentence leaves are noise there and
 * are filtered out. The global outline counts the same structure-only set.
 */
const OUTLINE_EXCLUDED_KINDS: readonly string[] = [
  'variable',
  'property',
  'static',
  'import',
  'export',
  'line',
  'sentence',
]

/** Pure structure filter, shared by both outline modes and the tests. */
export function isOutlineStructureKind(kind: string): boolean {
  return OUTLINE_EXCLUDED_KINDS.indexOf(kind.trim().toLowerCase()) === -1
}

function structureNodes(nodes: readonly OutlineNode[]): OutlineNode[] {
  return nodes.filter((node) => isOutlineStructureKind(node.kind))
}

const EMPTY_OUTLINE_NODES: readonly OutlineNode[] = []
const EMPTY_OUTLINE_GROUPS: readonly OutlineFileGroup[] = []
const EMPTY_OUTLINE_PROJECTS: readonly OutlineProject[] = []
const EMPTY_TREE_PROJECTS: readonly TreeProject[] = []

/** True when `path` is `root` itself or lives under it; `''` is the workspace. */
function isOutlinePathInside(path: string, root: string): boolean {
  if (root.length === 0) return true
  return path === root || path.startsWith(`${root}/`)
}

/**
 * Convert an absolute host project root to a workspace-relative one.
 *
 * Group titles and prefix matching are relative; the workspace root itself
 * becomes `''`. Paths that are already relative (or outside the workspace) are
 * returned unchanged.
 */
export function workspaceRelativeRoot(root: string, workspaceRoot: string): string {
  const path = canonicalPath(root)
  const base = canonicalPath(workspaceRoot)
  if (base.length === 0) return path
  const lowerPath = path.toLowerCase()
  const lowerBase = base.toLowerCase()
  if (lowerPath === lowerBase) return ''
  if (lowerPath.startsWith(`${lowerBase}/`)) return path.slice(base.length + 1)
  return path
}

/**
 * Only the outermost manifest project of a subtree survives.
 *
 * The document tree has exactly one project level: a nested `package.json` /
 * `pom.xml` inside an outer project never creates a child project or a nested
 * group. Projects whose root sits under another project's root are folded into
 * that outer project. The workspace root (`''`) is the outermost of all.
 */
export function outermostOutlineProjects(
  projects: readonly OutlineProject[],
): OutlineProject[] {
  const visible: OutlineProject[] = []
  const seen = new Set<string>()
  for (const project of projects) {
    const key = canonicalPath(project.root).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    // Keep the caller's object identity: `groupOutlineByProject` buckets by it.
    visible.push(project)
  }
  return visible.filter((project) => {
    const root = canonicalPath(project.root)
    return !visible.some((other) => {
      if (other === project) return false
      const otherRoot = canonicalPath(other.root)
      return otherRoot.length < root.length && isOutlinePathInside(root, otherRoot)
    })
  })
}

/**
 * The outer project that owns `path`, or `undefined` for workspace-root files.
 *
 * The shallowest matching root wins, so a file under a nested manifest is
 * attributed to the outer project rather than to the nested one.
 */
export function outlineProjectOf(
  path: string | null,
  projects: readonly OutlineProject[],
): OutlineProject | undefined {
  const target = path === null ? '' : canonicalPath(path)
  if (target.length === 0) return undefined
  let best: OutlineProject | undefined
  let bestLength = Number.POSITIVE_INFINITY
  for (const project of outermostOutlineProjects(projects)) {
    const root = canonicalPath(project.root)
    const explicit = project.files.some((file) => canonicalPath(file) === target)
    if (!explicit && !isOutlinePathInside(target, root)) continue
    if (root.length < bestLength) {
      best = project
      bestLength = root.length
    }
  }
  return best
}

/** One project bucket plus the file groups that belong to it. */
export interface OutlineProjectGroups {
  readonly project: OutlineProject
  readonly groups: OutlineFileGroup[]
}

/**
 * Bucket file groups by outermost manifest project.
 *
 * `loose` holds every file with no manifest owner; those are rendered directly
 * under the workspace root. When `projects` is empty every group is `loose`, so
 * the UI shows the workspace root plus file groups and never invents a project.
 */
export function groupOutlineByProject(
  groups: readonly OutlineFileGroup[],
  projects: readonly OutlineProject[],
): { readonly projects: OutlineProjectGroups[]; readonly loose: OutlineFileGroup[] } {
  const visible = outermostOutlineProjects(projects)
  const buckets: OutlineProjectGroups[] = visible.map((project) => ({
    project,
    groups: [],
  }))
  const loose: OutlineFileGroup[] = []
  for (const group of groups) {
    const owner = outlineProjectOf(group.path, visible)
    const bucket = owner === undefined
      ? undefined
      : buckets.find((entry) => entry.project === owner)
    if (bucket === undefined) loose.push(group)
    else bucket.groups.push(group)
  }
  return { projects: buckets, loose }
}

/**
 * Turn one outline group's depth-ordered nodes into a virtual tree.
 *
 * `depth` is the family nesting order, so the host list is already a pre-order
 * traversal: a node belongs to the last deeper node and a same/shallower node
 * closes the branch.
 */
function buildOutlineNodeTree(
  nodes: readonly OutlineNode[],
  prefix: string,
): VirtualTreeEntry<OutlineRowValue>[] {
  const roots: VirtualTreeEntry<OutlineRowValue>[] = []
  const open: Array<{ depth: number; key: string; children: VirtualTreeEntry<OutlineRowValue>[] }> = [
    { depth: -1, key: prefix, children: roots },
  ]
  nodes.forEach((node, index) => {
    while (open.length > 1 && (open[open.length - 1] as { depth: number }).depth >= node.depth) open.pop()
    const parent = open[open.length - 1] as { key: string; children: VirtualTreeEntry<OutlineRowValue>[] }
    const key = `${parent.key}.${index}`
    const entry: VirtualTreeEntry<OutlineRowValue> = {
      key,
      value: { kind: 'node', node, fallbackPath: null },
      children: [],
    }
    parent.children.push(entry)
    open.push({ depth: node.depth, key, children: entry.children as VirtualTreeEntry<OutlineRowValue>[] })
  })
  return roots
}

interface OutlineGroupContext {
  readonly fallbackPath: string | null
  readonly keyPrefix: string
}

/** One file group row: path title, family chip and structure-node count. */
function outlineGroupEntry(
  group: OutlineFileGroup,
  index: number,
  context: OutlineGroupContext,
): VirtualTreeEntry<OutlineRowValue> {
  const nodes = structureNodes(group.nodes)
  const key = `${context.keyPrefix}:file:${index}:${group.path ?? group.family}`
  const fill = (entry: VirtualTreeEntry<OutlineRowValue>): VirtualTreeEntry<OutlineRowValue> => {
    if (entry.value.kind !== 'node') return entry
    return {
      ...entry,
      value: { kind: 'node', node: entry.value.node, fallbackPath: context.fallbackPath },
      children: (entry.children ?? []).map(fill),
    }
  }
  return {
    key,
    value: { kind: 'group', group, title: group.path ?? group.family, nodeCount: nodes.length },
    children: buildOutlineNodeTree(nodes, key).map(fill),
  }
}

/**
 * The Outline tab is two routed modes under one hash route.
 *
 *  - `right/outline` (no `path`): one workspace-root row, then either outermost
 *    manifest projects (project root + manifest caption) or the file groups
 *    directly. Groups default collapsed; clicking a group opens that file.
 *  - `right/outline?path=…`: one root row for the current file (name + relative
 *    path) and only its structure nodes. A response that is not file-scoped is
 *    treated as an error state, never rendered as the global group list.
 *
 * Both modes render the same controlled {@link VirtualTree}; the component
 * stays mounted across `path` changes (see DockedPanel's Fade key), so the
 * global collapse state survives the round trip.
 */
function OutlineView(props: ViewProps): React.ReactElement {
  const local = props.path !== null
  const { state, retry } = useGraph(withPath('/graph/outline', props.path), parseOutline, props.refresh, props.onSettled)
  // The workspace root is part of the global tree only; the tree route is the
  // authoritative fallback when the outline payload does not include `root`.
  const treeGraph = useGraph(local ? null : '/graph/tree', parseTree, props.refresh)
  const data = state.status === 'ready' ? state.value : null
  const scope = data?.scope ?? 'workspace'
  const groups = data !== null && data.scope === 'workspace' ? data.groups : EMPTY_OUTLINE_GROUPS
  const declaredProjects = data !== null && data.scope === 'workspace' ? data.projects : EMPTY_OUTLINE_PROJECTS
  const treeProjects = treeGraph.state.status === 'ready'
    ? treeGraph.state.value.projects
    : EMPTY_TREE_PROJECTS
  const fileNodes = data !== null && data.scope === 'file' ? structureNodes(data.nodes) : EMPTY_OUTLINE_NODES
  const workspaceRoot = (data?.root ?? '').length > 0
    ? (data?.root ?? '')
    : treeGraph.state.status === 'ready'
      ? treeGraph.state.value.root
      : ''
  /**
   * The effective project list for the global outline.
   *
   * 1. `/graph/tree.projects` is authoritative (outermost manifests only): its
   *    absolute roots are converted to workspace-relative titles.
   * 2. If the tree has no manifest projects, a future outline-level `projects`
   *    array is honoured.
   * 3. Otherwise the `project` echoed on each outline group is used.
   *
   * Empty means "no manifest": every file group hangs directly off the single
   * workspace root, and no project row is invented.
   */
  const effectiveProjects = React.useMemo(() => {
    const collected: OutlineProject[] = []
    for (const project of treeProjects) {
      const root = workspaceRelativeRoot(project.root, workspaceRoot)
      collected.push({
        root,
        name: root.length > 0 ? baseName(root) : props.copy.scopeWorkspace,
        manifest: project.manifest,
        files: [],
      })
    }
    if (collected.length === 0) {
      for (const project of declaredProjects) {
        collected.push({
          ...project,
          root: workspaceRelativeRoot(project.root, workspaceRoot),
        })
      }
    }
    if (collected.length === 0) {
      for (const group of groups) {
        if (group.project === undefined) continue
        collected.push({
          ...group.project,
          root: workspaceRelativeRoot(group.project.root, workspaceRoot),
        })
      }
    }
    const byRoot = new Map<string, OutlineProject>()
    for (const project of collected) {
      const key = project.root.toLowerCase()
      if (!byRoot.has(key)) byRoot.set(key, project)
    }
    return [...byRoot.values()]
  }, [treeProjects, declaredProjects, groups, workspaceRoot, props.copy.scopeWorkspace])
  const entries = React.useMemo(() => {
    if (local) {
      const path = props.path
      if (path === null || fileNodes.length === 0) return []
      const key = `outline-file:${path}`
      const fill = (entry: VirtualTreeEntry<OutlineRowValue>): VirtualTreeEntry<OutlineRowValue> => {
        if (entry.value.kind !== 'node') return entry
        return {
          ...entry,
          value: { kind: 'node', node: entry.value.node, fallbackPath: path },
          children: (entry.children ?? []).map(fill),
        }
      }
      const children = buildOutlineNodeTree(fileNodes, key).map(fill)
      return [{
        key: `file-root:${path}`,
        value: { kind: 'root' as const, title: baseName(path), subtitle: path },
        children,
      }]
    }
    const rootTitle = workspaceRoot.length > 0 ? workspaceRoot : props.copy.scopeWorkspace
    const bucketed = groupOutlineByProject(groups, effectiveProjects)
    const projectEntries: Array<VirtualTreeEntry<OutlineRowValue>> = bucketed.projects.map((bucket, index) => ({
      key: `project:${index}:${bucket.project.root}`,
      value: { kind: 'project', title: bucket.project.root, manifest: bucket.project.manifest },
      children: bucket.groups.map((group, groupIndex) => outlineGroupEntry(group, groupIndex, {
        fallbackPath: group.path,
        keyPrefix: `root:${rootTitle}:project:${index}:${bucket.project.root}`,
      })),
    }))
    const looseEntries = bucketed.loose.map((group, index) => outlineGroupEntry(group, index, {
      fallbackPath: group.path,
      keyPrefix: `root:${rootTitle}:loose`,
    }))
    // Exactly one workspace-root grouping; files without a manifest stay
    // directly under it and nested manifests never create a second level.
    return [{
      key: `workspace-root:${rootTitle}`,
      value: { kind: 'root' as const, title: rootTitle, subtitle: null },
      children: [...projectEntries, ...looseEntries],
    }]
  }, [local, fileNodes, groups, effectiveProjects, workspaceRoot, props.path, props.copy])
  const adapter = React.useMemo(() => entryTreeAdapter(entries), [entries])
  // The Outline view owns the tree's expansion state. The global mode starts
  // with every file group collapsed; the state is not reset when the route
  // flips to the local mode and back.
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set())
  const collapsedWorkspace = React.useRef(false)
  const groupKeys = React.useMemo(() => {
    const keys: string[] = []
    const walk = (items: readonly VirtualTreeEntry<OutlineRowValue>[]): void => {
      for (const item of items) {
        if (item.value.kind === 'group') keys.push(item.key)
        walk(item.children ?? [])
      }
    }
    walk(entries)
    return keys
  }, [entries])
  React.useEffect(() => {
    if (scope !== 'workspace' || collapsedWorkspace.current || groupKeys.length === 0) return
    collapsedWorkspace.current = true
    setCollapsed(new Set(groupKeys))
  }, [groupKeys, scope])
  const onToggle = React.useCallback((key: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  if (state.status === 'loading' || state.status === 'idle') {
    return h(LoadingState, { copy: props.copy })
  }
  if (state.status === 'error') return h(ErrorState, { copy: props.copy, onRetry: retry })
  // A local outline must be file-scoped. Never fall back to the workspace list.
  if (local && state.value.scope !== 'file') {
    return h(EmptyState, { message: props.copy.outline.empty })
  }
  const total = local
    ? fileNodes.length
    : groups.reduce((sum, group) => sum + structureNodes(group.nodes).length, 0)
  if (total === 0) return h(EmptyState, { message: props.copy.outline.empty })

  return h(VirtualTree<VirtualTreeEntry<OutlineRowValue>>, {
    adapter,
    collapsed,
    onToggle,
    'aria-label': props.copy.tabs.outline,
    slot: (depth, _index, node) => {
      const value = node.value
      const hasChildren = (node.children ?? []).length > 0
      const expanded = !collapsed.has(node.key)
      if (value.kind === 'root' || value.kind === 'project') {
        // Root and project rows are section headings: clicking them folds the
        // section, they never navigate away.
        const heading = value.title.length > 0 ? value.title : props.copy.scopeWorkspace
        const caption = value.kind === 'project' ? value.manifest : ''
        return h(
          MuiBox,
          { sx: PANEL_ROW_SHELL_SX },
          h(
            MuiListItemButton,
            {
              role: 'treeitem',
              'aria-level': depth + 1,
              'aria-expanded': hasChildren ? expanded : undefined,
              sx: PANEL_ROW_SX,
              style: { paddingLeft: 8 + depth * 16 },
              title: heading,
              onClick: hasChildren ? (): void => { onToggle(node.key) } : undefined,
            },
            h(
              MuiListItemIcon,
              { sx: PANEL_ROW_ICON_SX },
              h(value.kind === 'root' ? IconOutline : IconArticle, { fontSize: 'small' }),
            ),
            h(MuiListItemText, {
              primary: h(
                MuiBox,
                { component: 'span', sx: { display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0 } },
                h(
                  MuiTypography,
                  {
                    component: 'span',
                    variant: 'body2',
                    noWrap: true,
                    sx: { fontWeight: value.kind === 'root' ? 600 : 500 },
                  },
                  heading,
                ),
                caption.length > 0
                  ? h(
                    MuiTypography,
                    { component: 'span', variant: 'caption', noWrap: true, color: 'text.secondary' },
                    caption,
                  )
                  : null,
              ),
              primaryTypographyProps: { component: 'div' },
            }),
          ),
        )
      }
      if (value.kind === 'group') {
        const family = familyLabel(value.group.family, props.copy)
        const title = value.title.length > 0 ? value.title : (family.length > 0 ? family : props.copy.scopeWorkspace)
        // Global mode: click opens the file's local outline; the trailing
        // chevron is the separate expand/collapse affordance.
        const toggleAction = hasChildren
          ? h(
            Tip,
            { label: expanded ? props.copy.outlineCollapse : props.copy.outlineExpand },
            h(
              MuiIconButton,
              {
                size: 'small',
                className: 'coordination-row-action',
                sx: PANEL_ROW_ACTION_SX,
                'aria-label': expanded ? props.copy.outlineCollapse : props.copy.outlineExpand,
                onClick: (event: React.MouseEvent): void => {
                  event.stopPropagation()
                  onToggle(node.key)
                },
              },
              h(expanded ? IconExpand : IconChevron, { fontSize: 'small' }),
            ),
          )
          : null
        return h(
          MuiBox,
          { sx: PANEL_ROW_SHELL_SX },
          h(
            MuiListItemButton,
            {
              role: 'treeitem',
              'aria-level': depth + 1,
              'aria-expanded': hasChildren ? expanded : undefined,
              sx: PANEL_ROW_SX,
              style: {
                paddingLeft: 8 + depth * 16,
                paddingRight: toggleAction === null ? undefined : 40,
              },
              title,
              onClick: value.group.path === null
                ? undefined
                : (): void => { navigate(props.side, 'outline', { path: value.group.path }) },
            },
            h(MuiListItemIcon, { sx: PANEL_ROW_ICON_SX }, h(IconArticle, { fontSize: 'small' })),
            h(MuiListItemText, {
              primary: title,
              secondary: h(
                MuiBox,
                {
                  component: 'span',
                  sx: { display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 },
                },
                family.length > 0
                  ? h(MuiChip, {
                    size: 'small',
                    variant: 'outlined',
                    label: family,
                    sx: { height: 18, fontSize: 10 },
                  })
                  : null,
                h(
                  MuiTypography,
                  { component: 'span', variant: 'caption', noWrap: true, color: 'text.secondary' },
                  fillTemplate(props.copy.outlineNodeCount, { count: String(value.nodeCount) }),
                ),
              ),
              primaryTypographyProps: {
                ...PANEL_ROW_PRIMARY_PROPS,
                sx: { fontWeight: 500 },
              },
              secondaryTypographyProps: { component: 'div' },
            }),
          ),
          toggleAction,
        )
      }
      const target = value.node.path ?? value.fallbackPath
      const kindLabel = value.node.kind.length > 0
        ? fillTemplate(props.copy.outlineKind, { kind: value.node.kind })
        : value.node.name
      const preview = props.side !== 'right' || target === null
        ? null
        : h(
          Tip,
          { label: props.copy.tip.previewFile },
          h(
            MuiIconButton,
            {
              size: 'small',
              className: 'coordination-row-action',
              sx: PANEL_ROW_ACTION_SX,
              'aria-label': props.copy.tip.previewFile,
              onClick: (event: React.MouseEvent): void => {
                event.stopPropagation()
                navigate(props.side, 'preview', { path: target })
              },
            },
            h(IconPreview, { fontSize: 'small' }),
          ),
        )
      return h(
        MuiBox,
        { sx: PANEL_ROW_SHELL_SX },
        h(
          MuiListItemButton,
          {
            role: 'treeitem',
            'aria-level': depth + 1,
            'aria-expanded': hasChildren ? expanded : undefined,
            sx: PANEL_ROW_SX,
            style: {
              paddingLeft: 8 + depth * 16,
              paddingRight: preview === null ? undefined : 40,
            },
            title: kindLabel,
            onClick: hasChildren
              ? (): void => { onToggle(node.key) }
              : target === null
                ? undefined
                : (): void => { navigate(props.side, 'files', { path: target }) },
          },
          h(
            MuiListItemIcon,
            { sx: PANEL_ROW_ICON_SX },
            h(hasChildren ? (expanded ? IconExpand : IconChevron) : IconArticle, {
              fontSize: 'small',
            }),
          ),
          h(MuiListItemText, {
            primary: value.node.name,
            secondary: value.node.kind.length > 0 ? value.node.kind : undefined,
            primaryTypographyProps: PANEL_ROW_PRIMARY_PROPS,
            secondaryTypographyProps: PANEL_ROW_SECONDARY_PROPS,
          }),
        ),
        preview,
      )
    },
  })
}

/** Adapter input while the dependencies request is loading or failed. */
const EMPTY_DEPENDENCY_LINKS: readonly DependencyLink[] = []

/**
 * Dependency list (bottom panel).
 *
 * The cycle warning is the list's header: it stays above the virtual list in
 * the same panel scroller, and {@link useVirtualOffset} measures the list's own
 * top so the window arithmetic starts below it. `collapseTick` remounts the
 * list after the banner's Collapse transition so that offset is re-measured at
 * its final height, not mid-animation.
 */
function DependenciesView(props: ViewProps): React.ReactElement {
  const { state, retry } = useGraph(withPath('/graph/dependencies', props.path), parseDependencies, props.refresh, props.onSettled)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [collapseTick, setCollapseTick] = React.useState(0)
  // Keep the last non-empty cycle list so the Collapse has content to animate
  // out when a refresh reports no cycles.
  const lastCycles = React.useRef<readonly string[][]>([])
  if (state.status === 'ready' && state.value.cycles.length > 0) lastCycles.current = state.value.cycles
  const links = state.status === 'ready' ? state.value.links : EMPTY_DEPENDENCY_LINKS
  const adapter = React.useMemo(
    () => createVirtualListAdapter(
      links,
      (link, index) => `${link.from}->${link.to}#${index}`,
    ),
    [links],
  )

  if (state.status === 'loading' || state.status === 'idle') {
    return h(LoadingState, { copy: props.copy })
  }
  if (state.status === 'error') return h(ErrorState, { copy: props.copy, onRetry: retry })
  if (state.value.links.length === 0 && state.value.cycles.length === 0) {
    return h(EmptyState, { message: props.copy.dependencies.empty })
  }

  const visibleCycles = state.value.cycles.length > 0 ? state.value.cycles : lastCycles.current
  return h(
    MuiBox,
    null,
    h(
      MuiCollapse,
      {
        in: state.value.cycles.length > 0,
        timeout: reducedMotion ? 0 : 'auto',
        unmountOnExit: true,
        onEntered: (): void => { setCollapseTick((tick) => tick + 1) },
        onExited: (): void => { setCollapseTick((tick) => tick + 1) },
      },
      visibleCycles.length > 0 ? h(CycleAlert, { copy: props.copy, cycles: visibleCycles }) : null,
    ),
    h(VirtualList<DependencyLink>, {
      key: `dependencies:${collapseTick}`,
      adapter,
      'aria-label': props.copy.tabs.dependencies,
      slot: (_index, link) => {
        const selected = props.path !== null &&
          (samePath(link.from, props.path) || samePath(link.to, props.path))
        return h(
          MuiListItemButton,
          {
            role: 'option',
            'aria-selected': selected,
            selected,
            sx: PANEL_ROW_SX,
            title: `${link.from} → ${link.to}`,
          },
          h(
            MuiListItemIcon,
            { sx: PANEL_ROW_ICON_SX },
            h(IconDependencies, { fontSize: 'small' }),
          ),
          h(MuiListItemText, {
            primary: h(
              MuiBox,
              { component: 'span', sx: DEP_LABEL_SX },
              h(MuiTypography, { variant: 'body2', noWrap: true, sx: DEP_ENDPOINT_SX }, link.from),
              h(MuiTypography, { variant: 'caption', color: 'text.secondary', sx: DEP_ARROW_SX }, '→'),
              h(MuiTypography, { variant: 'body2', noWrap: true, sx: DEP_ENDPOINT_SX }, link.to),
            ),
            secondary: link.relation.length > 0 || link.cyclic
              ? h(
                MuiBox,
                { component: 'span', sx: DEP_CHIPS_SX },
                link.relation.length > 0
                  ? h(MuiChip, { size: 'small', variant: 'outlined', label: link.relation })
                  : null,
                link.cyclic
                  ? h(MuiChip, {
                    size: 'small',
                    color: 'warning',
                    icon: h(IconWarning, { fontSize: 'small' }),
                    label: props.copy.cycle,
                  })
                  : null,
              )
              : undefined,
            primaryTypographyProps: { component: 'div' },
            secondaryTypographyProps: { component: 'div' },
          }),
        )
      },
    }),
  )
}

/** Read-only HTML: no forms, media, frames or event handlers survive. */
const FORBIDDEN_HTML_TAGS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'textarea',
  'select',
  'button',
  'video',
  'audio',
  'link',
  'meta',
]

const FORBIDDEN_HTML_ATTRS = [
  'contenteditable',
  'style',
  'srcset',
  'onerror',
  'onload',
  'onclick',
  'oninput',
  'onchange',
  'onsubmit',
  'onfocus',
  'onblur',
  'onmouseover',
]

const HTML_SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: FORBIDDEN_HTML_TAGS,
  FORBID_ATTR: FORBIDDEN_HTML_ATTRS,
}

/**
 * DOMPurify whitelist for rendered transcript messages.
 *
 * Same deny lists as every other sanitized surface, plus the two attributes the
 * link renderer sets (`target="_blank"`, `rel="noreferrer"`). Inline `style` is
 * still forbidden: Prism token colours are expressed as classes instead.
 */
export const MESSAGE_SANITIZE_CONFIG = {
  ...HTML_SANITIZE_CONFIG,
  ADD_ATTR: ['target', 'rel'],
}

/** The small DOMPurify surface the transcript renderer needs. */
export interface MessageHtmlSanitizer {
  sanitize(html: string, config?: Record<string, unknown>): unknown
}

/** Elements whose whole subtree is removed before the string reaches the DOM. */
const SCRUBBED_HTML_TAGS = FORBIDDEN_HTML_TAGS.filter((tag) => tag !== 'link' && tag !== 'meta')

/**
 * Defence-in-depth string scrub applied after DOMPurify (and on its own in the
 * DOM-less unit-test environment).
 *
 * DOMPurify is the primary sanitizer. This pass exists so a sanitizer failure
 * or a future config regression cannot let a script/event handler/`javascript:`
 * URL through: every forbidden element is removed with its content, every
 * `on*`/`style`/`srcset`/`contenteditable` attribute is stripped, and
 * `javascript:`/`data:`/`vbscript:` URLs are dropped. It is intentionally
 * conservative — losing a styling attribute beats executing one.
 */
export function scrubMessageHtml(html: string): string {
  let clean = html
  for (const tag of SCRUBBED_HTML_TAGS) {
    clean = clean.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '')
    clean = clean.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '')
  }
  clean = clean.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  clean = clean.replace(
    /\s+(?:style|srcset|contenteditable|srcdoc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    '',
  )
  clean = clean.replace(
    /\s+(?:href|src|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
    (match: string, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
      const value = doubleQuoted ?? singleQuoted ?? ''
      return /^\s*(?:javascript|data|vbscript):/i.test(value) ? '' : match
    },
  )
  clean = clean.replace(
    /\s+(?:href|src|xlink:href)\s*=\s*([^\s"'>]+)/gi,
    (match: string, value: string) =>
      /^\s*(?:javascript|data|vbscript):/i.test(value) ? '' : match,
  )
  return clean
}

/**
 * Sanitize one rendered message before `dangerouslySetInnerHTML`.
 *
 * The runtime always passes the lazily loaded DOMPurify instance; the tests
 * omit it and exercise the DOM-free scrub, so the policy is verifiable without
 * a browser DOM. Output is always a fresh string.
 */
export function sanitizeMessageHtml(html: string, purify?: MessageHtmlSanitizer): string {
  const purified = purify === undefined ? html : String(purify.sanitize(html, MESSAGE_SANITIZE_CONFIG))
  return scrubMessageHtml(purified)
}

function SheetsPreview(props: {
  copy: PanelCopy
  sheets: readonly SheetData[]
}): React.ReactElement {
  const [active, setActive] = React.useState(0)
  const sheetCount = props.sheets.length
  if (sheetCount === 0) return h(EmptyState, { message: props.copy.states.empty })
  const activeIndex = Math.min(active, sheetCount - 1)
  const sheet = props.sheets[activeIndex] ?? props.sheets[0]
  if (sheet === undefined) return h(EmptyState, { message: props.copy.states.empty })

  return h(
    MuiBox,
    null,
    h(
      MuiTabs,
      {
        value: activeIndex,
        variant: 'scrollable',
        scrollButtons: 'auto',
        sx: TABS_SX,
        onChange: (_event: React.SyntheticEvent, value: number): void => {
          setActive(value)
        },
      },
      ...props.sheets.map((entry, index) =>
        h(MuiTab, {
          key: `${entry.name}#${index}`,
          label: fillTemplate(props.copy.sheetTab, { name: entry.name }),
        }),
      ),
    ),
    sheet.rows.length === 0
      ? h(EmptyState, { message: props.copy.states.empty })
      : h(
        MuiTable,
        { size: 'small', sx: TABLE_SX },
        h(
          MuiTableBody,
          null,
          ...sheet.rows.map((row, rowIndex) =>
            h(
              MuiTableRow,
              { key: `row:${rowIndex}` },
              ...row.map((cell, cellIndex) =>
                h(
                  MuiTableCell,
                  {
                    key: `cell:${cellIndex}`,
                    sx: rowIndex === 0 ? TABLE_HEAD_CELL_SX : undefined,
                  },
                  cell,
                ),
              ),
            ),
          ),
        ),
      ),
  )
}

function SlidesPreview(props: {
  copy: PanelCopy
  slides: readonly SlideData[]
}): React.ReactElement {
  if (props.slides.length === 0) return h(EmptyState, { message: props.copy.states.empty })
  return h(
    MuiBox,
    null,
    ...props.slides.map((slide, index) =>
      h(
        MuiCard,
        { key: `slide:${slide.index}#${index}`, variant: 'outlined', sx: SLIDE_CARD_SX },
        h(
          MuiCardContent,
          { sx: SLIDE_CONTENT_SX },
          h(
            MuiTypography,
            { variant: 'caption', color: 'text.secondary' },
            fillTemplate(props.copy.slideN, { n: String(slide.index) }),
          ),
          slide.title.length > 0
            ? h(MuiTypography, { variant: 'subtitle2', sx: SLIDE_TITLE_SX }, slide.title)
            : null,
          ...slide.lines.map((line, lineIndex) =>
            h(
              MuiTypography,
              { key: `line:${lineIndex}`, variant: 'body2', sx: SLIDE_LINE_SX },
              line,
            ),
          ),
        ),
      ),
    ),
  )
}

interface PreviewRendererProps {
  copy: PanelCopy
  data: PreviewData
}

/**
 * Preview libraries are deferred behind `React.lazy`.
 *
 * react-markdown, KaTeX, Prism and DOMPurify are large and their module
 * evaluation is the riskiest part of this bundle. Loading them only when a
 * preview is actually rendered keeps the initial panel render independent of
 * any failure in those libraries; the boundary around this subtree contains a
 * failed load or render.
 */

/* ------------------------------------------------------------------------- *
 * Markdown pipeline shared by the file preview and the agent transcript
 * ------------------------------------------------------------------------- */

interface MarkdownModules {
  MarkdownView: Loose
  remarkGfm: unknown
  remarkMath: unknown
  rehypeKatex: (options: { readonly output: 'mathml' }) => unknown
  DOMPurify: {
    sanitize(html: string, config?: Record<string, unknown>): unknown
    addHook?: (
      hook: string,
      callback: (node: unknown, data: { attrName: string; keepAttr: boolean }) => void,
    ) => void
  }
}

/** KaTeX renders MathML only: the panel ships no stylesheet/font assets. */
const KATEX_OPTIONS = { output: 'mathml' as const }

let markdownModulesPromise: Promise<MarkdownModules> | null = null

/**
 * Lazily load the Markdown stack exactly once and share it between the preview
 * and the transcript. A failed load rejects the shared promise; both callers
 * degrade to a skeleton/plain text instead of taking the panel down.
 */
function loadMarkdownModules(): Promise<MarkdownModules> {
  if (markdownModulesPromise === null) {
    markdownModulesPromise = (async (): Promise<MarkdownModules> => {
      const [markdownModule, remarkGfmModule, remarkMathModule, rehypeKatexModule, purifyModule] =
        await Promise.all([
          import('react-markdown'),
          import('remark-gfm'),
          import('remark-math'),
          import('rehype-katex'),
          import('dompurify'),
        ])
      const DOMPurify = purifyModule.default as unknown as MarkdownModules['DOMPurify']
      // DOMPurify's attribute allowlist already drops `on*`; this hook makes the
      // guarantee explicit for every future attribute name as well. The factory
      // export used outside a browser has no hooks, so guard the registration.
      if (typeof DOMPurify.addHook === 'function') {
        DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
          const name = data.attrName.toLowerCase()
          if (
            name.startsWith('on') ||
            name === 'contenteditable' ||
            name === 'style' ||
            name === 'srcset'
          ) {
            data.keepAttr = false
          }
        })
      }
      return {
        MarkdownView: markdownModule.default as unknown as Loose,
        remarkGfm: remarkGfmModule.default,
        remarkMath: remarkMathModule.default,
        rehypeKatex: rehypeKatexModule.default as unknown as MarkdownModules['rehypeKatex'],
        DOMPurify,
      }
    })()
  }
  return markdownModulesPromise
}

/** GFM task-list checkboxes become static glyphs (no `<input>` in the DOM). */
function MarkdownTaskCheckbox(props: { checked?: boolean }): React.ReactElement {
  const checked = props.checked === true
  return h(
    'span',
    { role: 'img', 'aria-label': checked ? '☑' : '☐', 'data-task': checked ? 'done' : 'open' },
    checked ? '☑' : '☐',
  )
}

/** Two high-contrast token sets derived from the MUI palette. */
function prismThemeFor(muiTheme: Theme): PrismTheme {
  const palette = muiTheme.palette
  const dark = palette.mode === 'dark'
  return {
    plain: { color: palette.text.primary, backgroundColor: 'transparent' },
    styles: [
      {
        types: ['comment', 'prolog', 'doctype', 'cdata'],
        style: { color: palette.text.disabled, fontStyle: 'italic' },
      },
      {
        types: ['punctuation', 'operator'],
        style: { color: dark ? palette.grey[400] : palette.grey[700] },
      },
      {
        types: ['keyword', 'builtin', 'tag', 'important', 'atrule'],
        style: { color: palette.primary.main, fontWeight: '600' },
      },
      {
        types: ['string', 'char', 'attr-value', 'regex', 'url'],
        style: { color: palette.success.main },
      },
      {
        types: ['number', 'boolean', 'constant', 'symbol', 'deleted'],
        style: { color: palette.warning.main },
      },
      {
        types: ['function', 'class-name', 'function-variable'],
        style: { color: palette.info.main },
      },
      {
        types: ['variable', 'parameter', 'property', 'attr-name'],
        style: { color: palette.text.primary },
      },
      {
        types: ['selector', 'rule'],
        style: { color: palette.secondary.main },
      },
    ],
  }
}

/** Prefix a token type's theme entry as an emotion selector for sanitized HTML. */
function messageTokenSelectors(): Record<string, Record<string, unknown>> {
  const selectors: Record<string, Record<string, unknown>> = {}
  for (const entry of prismThemeFor(theme).styles) {
    for (const type of entry.types) {
      selectors[`& .token.${type}`] = { ...entry.style }
    }
  }
  return selectors
}

/** Rendered Markdown prose inside a chat bubble, Prism token classes included. */
const MESSAGE_PROSE_SX = {
  ...PREVIEW_PROSE_SX,
  fontSize: 12,
  lineHeight: 1.55,
  '& p:last-of-type': { marginBottom: 0 },
  '& pre': {
    margin: '0 0 6px',
    padding: 0.75,
    borderRadius: 1,
    backgroundColor: 'action.hover',
    overflowX: 'auto',
    fontSize: 11,
  },
  '& .coordination-code-line': { minHeight: '1.4em', whiteSpace: 'pre' },
  ...messageTokenSelectors(),
}

/* ------------------------------------------------------------------------- *
 * Markdown → sanitized HTML (agent transcript bubbles)
 * ------------------------------------------------------------------------- */

type MessageHtmlRenderer = (markdown: string) => string

let messageHtmlRendererPromise: Promise<MessageHtmlRenderer> | null = null

/** Concatenate the text content of a React node tree. */
function reactNodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(reactNodeText).join('')
  if (React.isValidElement(node)) {
    return reactNodeText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}

/** The prism-react-renderer `Highlight` shape used for transcript code fences. */
type HighlightComponent = (props: {
  code: string
  language: string
  theme: PrismTheme
  children: (props: RenderProps) => React.ReactElement
}) => React.ReactElement

/**
 * Components applied inside every transcript message.
 *
 * Links always open a new tab with `noreferrer`; fenced code goes through Prism
 * with class-based token spans (the message sanitizer strips inline `style`, so
 * token colours come from {@link MESSAGE_PROSE_SX} instead).
 */
function messageMarkdownComponents(
  Highlight: HighlightComponent,
  prismTheme: PrismTheme,
): Record<string, Loose> {
  function MessagePre(props: { children?: React.ReactNode }): React.ReactElement {
    const child = React.Children.toArray(props.children)[0]
    if (!React.isValidElement(child)) return h('pre', null, props.children)
    const childProps = child.props as { className?: string; children?: React.ReactNode }
    const code = reactNodeText(childProps.children)
    const language = /language-([\w-]+)/.exec(childProps.className ?? '')?.[1] ?? 'plain'
    return h(Highlight, {
      code,
      language,
      theme: prismTheme,
      children: (renderProps: RenderProps): React.ReactElement =>
        h(
          'pre',
          { className: 'coordination-code' },
          ...renderProps.tokens.map((line, lineIndex) =>
            h(
              'div',
              { className: 'coordination-code-line', key: `line:${lineIndex}` },
              ...line.map((token, tokenIndex) =>
                h(
                  'span',
                  {
                    className: `token ${token.types.join(' ')}`,
                    key: `token:${tokenIndex}`,
                  },
                  token.content,
                ),
              ),
            ),
          ),
        ),
    })
  }

  function MessageLink(props: { href?: string; children?: React.ReactNode }): React.ReactElement {
    return h(
      'a',
      { href: props.href, target: '_blank', rel: 'noreferrer' },
      props.children,
    )
  }

  return {
    pre: MessagePre as unknown as Loose,
    a: MessageLink as unknown as Loose,
    input: MarkdownTaskCheckbox as unknown as Loose,
  }
}

/**
 * Lazily build the Markdown → sanitized-HTML renderer used by every bubble.
 *
 * `react-markdown` produces React nodes, so they are serialised with
 * `renderToStaticMarkup`; the resulting fragment then goes through DOMPurify's
 * whitelist before it may be inserted with `dangerouslySetInnerHTML`. Any
 * load/render/sanitize failure rejects or throws and the bubble falls back to
 * plain text (the caller catches and logs with the `[coordination]` prefix).
 */
function loadMessageHtmlRenderer(): Promise<MessageHtmlRenderer> {
  if (messageHtmlRendererPromise === null) {
    messageHtmlRendererPromise = (async (): Promise<MessageHtmlRenderer> => {
      const [markdown, prismModule, serverModule] = await Promise.all([
        loadMarkdownModules(),
        import('prism-react-renderer'),
        // The explicit browser entry keeps Node's `stream`/`util` out of the
        // browser bundle (the bare `react-dom/server` specifier resolves to the
        // node build under this bundler even with platform: 'browser').
        // @ts-ignore react-dom 18 ships no declarations for its server entry.
        import('react-dom/server.browser'),
      ])
      const renderToStaticMarkup = serverModule.renderToStaticMarkup as (
        node: React.ReactElement,
      ) => string
      const components = messageMarkdownComponents(
        prismModule.Highlight as unknown as HighlightComponent,
        prismThemeFor(theme),
      )
      return (source: string): string => {
        const element = h(
          markdown.MarkdownView,
          {
            remarkPlugins: [markdown.remarkGfm, markdown.remarkMath],
            rehypePlugins: [markdown.rehypeKatex(KATEX_OPTIONS)],
            components,
          },
          source,
        )
        return sanitizeMessageHtml(
          renderToStaticMarkup(element),
          markdown.DOMPurify as unknown as MessageHtmlSanitizer,
        )
      }
    })()
  }
  return messageHtmlRendererPromise
}

const LazyPreviewRenderer = React.lazy(async (): Promise<{
  default: React.ComponentType<PreviewRendererProps>
}> => {
  const [markdown, prismModule] = await Promise.all([
    loadMarkdownModules(),
    import('prism-react-renderer'),
  ])
  const { MarkdownView, remarkGfm, remarkMath, rehypeKatex, DOMPurify } = markdown
  const MuiHighlight = prismModule.Highlight as unknown as Loose

  const MARKDOWN_COMPONENTS = { input: MarkdownTaskCheckbox }

  function MarkdownPreview(props: {
    copy: PanelCopy
    content: string
    math: boolean
  }): React.ReactElement {
    const remarkPlugins = props.math ? [remarkGfm, remarkMath] : [remarkGfm]
    const rehypePlugins = props.math ? [rehypeKatex(KATEX_OPTIONS)] : []
    return h(
      MuiBox,
      { sx: PREVIEW_BOX_SX, role: 'region', 'aria-label': props.copy.preview },
      h(
        MarkdownView,
        { remarkPlugins, rehypePlugins, components: MARKDOWN_COMPONENTS },
        props.content,
      ),
    )
  }

  /** Two high-contrast token sets derived from the MUI palette. */
  function prismThemeFor(muiTheme: Theme): PrismTheme {
    const palette = muiTheme.palette
    const dark = palette.mode === 'dark'
    return {
      plain: { color: palette.text.primary, backgroundColor: 'transparent' },
      styles: [
        {
          types: ['comment', 'prolog', 'doctype', 'cdata'],
          style: { color: palette.text.disabled, fontStyle: 'italic' },
        },
        {
          types: ['punctuation', 'operator'],
          style: { color: dark ? palette.grey[400] : palette.grey[700] },
        },
        {
          types: ['keyword', 'builtin', 'tag', 'important', 'atrule'],
          style: { color: palette.primary.main, fontWeight: '600' },
        },
        {
          types: ['string', 'char', 'attr-value', 'regex', 'url'],
          style: { color: palette.success.main },
        },
        {
          types: ['number', 'boolean', 'constant', 'symbol', 'deleted'],
          style: { color: palette.warning.main },
        },
        {
          types: ['function', 'class-name', 'function-variable'],
          style: { color: palette.info.main },
        },
        {
          types: ['variable', 'parameter', 'property', 'attr-name'],
          style: { color: palette.text.primary },
        },
        {
          types: ['selector', 'rule'],
          style: { color: palette.secondary.main },
        },
      ],
    }
  }

  function languageOf(path: string | null): string {
    if (path === null) return 'plain'
    const dot = path.lastIndexOf('.')
    if (dot === -1) return 'plain'
    return LANGUAGE_BY_EXTENSION[path.slice(dot + 1).toLowerCase()] ?? 'plain'
  }

  /** Cap highlighting work; the notice always states the shown line count. */
  function clipCode(content: string): { code: string; truncated: boolean; lines: number } {
    const allLines = content.split('\n')
    if (allLines.length <= MAX_CODE_LINES && content.length <= MAX_CODE_BYTES) {
      return { code: content, truncated: false, lines: allLines.length }
    }
    const shown = allLines.slice(0, MAX_CODE_LINES)
    return { code: shown.join('\n'), truncated: true, lines: shown.length }
  }

  function CodePreview(props: {
    copy: PanelCopy
    path: string
    content: string
  }): React.ReactElement {
    const muiTheme = useTheme()
    const prismTheme = React.useMemo(() => prismThemeFor(muiTheme), [muiTheme])
    const clipped = React.useMemo(() => clipCode(props.content), [props.content])
    const language = languageOf(props.path)

    const render = (renderProps: RenderProps): React.ReactElement =>
      h(
        'pre',
        {
          className: renderProps.className,
          style: {
            ...renderProps.style,
            margin: 0,
            padding: 8,
            overflowX: 'auto',
            background: 'transparent',
            fontFamily: 'monospace',
            fontSize: 11,
            lineHeight: 1.5,
            whiteSpace: 'pre',
            tabSize: 2,
          },
        },
        ...renderProps.tokens.map((line, lineIndex) =>
          h(
            'div',
            { ...renderProps.getLineProps({ line }), key: `line:${lineIndex}` },
            ...line.map((token, tokenIndex) =>
              h('span', { ...renderProps.getTokenProps({ token }), key: `token:${tokenIndex}` }),
            ),
          ),
        ),
      )

    return h(
      MuiBox,
      { sx: PREVIEW_CODE_BOX_SX, role: 'region', 'aria-label': props.copy.preview, 'data-language': language },
      h(MuiHighlight, { code: clipped.code, language, theme: prismTheme, children: render }),
      clipped.truncated
        ? h(
          MuiTypography,
          { variant: 'caption', color: 'text.secondary', sx: MORE_SX },
          fillTemplate(props.copy.codeTruncated, { lines: String(clipped.lines) }),
        )
        : null,
    )
  }

  function PreviewContent(props: {
    copy: PanelCopy
    data: PreviewData
    sanitized: string
  }): React.ReactElement {
    const { copy, data } = props
    if (data.kind === 'xlsx') return h(SheetsPreview, { copy, sheets: data.sheets })
    if (data.kind === 'pptx') return h(SlidesPreview, { copy, slides: data.slides })
    if (data.kind === 'markdown' || data.kind === 'tex') {
      if (data.content.length === 0) return h(EmptyState, { message: copy.states.empty })
      return h(MarkdownPreview, { copy, content: data.content, math: true })
    }
    if (data.kind === 'html' || data.kind === 'docx') {
      if (data.content.length === 0) return h(EmptyState, { message: copy.states.empty })
      return h(MuiBox, {
        sx: PREVIEW_BOX_SX,
        role: 'region',
        'aria-label': copy.preview,
        dangerouslySetInnerHTML: { __html: props.sanitized },
      })
    }
    if (data.kind === 'code') {
      if (data.content.length === 0) return h(EmptyState, { message: copy.states.empty })
      return h(CodePreview, { copy, path: data.path, content: data.content })
    }
    if (data.content.length === 0) return h(EmptyState, { message: copy.states.empty })
    // `text` stays plain: no tokenizer, no highlighting.
    return h(
      MuiBox,
      { component: 'pre', sx: PREVIEW_PRE_SX, role: 'region', 'aria-label': copy.preview },
      h('code', null, data.content),
    )
  }

  function PreviewRenderer(props: PreviewRendererProps): React.ReactElement {
    const { data } = props
    const sanitized = React.useMemo(
      () => (data.kind === 'html' || data.kind === 'docx'
        ? String(DOMPurify.sanitize(data.content, HTML_SANITIZE_CONFIG))
        : ''),
      [data.kind, data.content],
    )
    return h(PreviewContent, { copy: props.copy, data, sanitized })
  }

  return { default: PreviewRenderer }
})

function PreviewView(props: ViewProps): React.ReactElement {
  const path = props.path ?? ''
  const graphPath = path.length === 0 ? null : `/graph/preview?path=${encodeURIComponent(path)}`
  const { state, retry } = useGraph(graphPath, parsePreview, props.refresh, props.onSettled)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

  const ready = state.status === 'ready'
  const kind = ready ? state.value.kind : ''

  if (path.length === 0) return h(EmptyState, { message: props.copy.previewPickFile })
  if (state.status === 'error') {
    if (state.httpStatus === 415) return h(EmptyState, { message: props.copy.previewUnsupported })
    if (state.httpStatus === 404) return h(EmptyState, { message: props.copy.previewNotFound })
    return h(ErrorState, { copy: props.copy, onRetry: retry })
  }

  const skeleton = h(
    MuiBox,
    { sx: SKELETON_OVERLAY_SX },
    ...Array.from({ length: 6 }, (_entry, index) =>
      h(MuiSkeleton, {
        key: index,
        variant: 'text',
        width: index === 5 ? '55%' : '100%',
      }),
    ),
  )

  const office = kind === 'docx' || kind === 'xlsx' || kind === 'pptx'
  return h(
    MuiBox,
    null,
    ready && state.value.truncated
      ? h(
        MuiAlert,
        { severity: 'info', sx: PREVIEW_INFO_SX },
        office ? props.copy.previewOfficeTruncated : props.copy.previewTruncated,
      )
      : null,
    h(
      MuiBox,
      { sx: PREVIEW_STACK_SX },
      h(
        MuiFade,
        { in: !ready, timeout: reducedMotion ? 0 : PREVIEW_FADE_MS, unmountOnExit: true },
        h('div', { style: TRANSITION_SURFACE_STYLE }, skeleton),
      ),
      ready
        ? h(
          MuiFade,
          {
            key: `preview:${kind}:${path}`,
            in: true,
            appear: true,
            timeout: reducedMotion ? 0 : PREVIEW_FADE_MS,
          },
          h(
            'div',
            { style: TRANSITION_SURFACE_STYLE },
            h(
              PanelErrorBoundary,
              null,
              h(
                React.Suspense,
                { fallback: skeleton },
                h(LazyPreviewRenderer, { copy: props.copy, data: state.value }),
              ),
            ),
          ),
        )
        : null,
    ),
  )
}

/* ------------------------------------------------------------------------- *
 * Left-panel relationship canvas
 * ------------------------------------------------------------------------- */

type CanvasRelation = 'depends' | 'imports' | 'exports' | 'contains' | 'part_of'
type CanvasLayoutMode = 'ring' | 'layered' | 'star'

interface CanvasNode {
  id: string
  /** Short display label (a path for file-level nodes, a symbol name intra). */
  label: string
  /** Target passed to the files view when the node is clicked. */
  path: string
  /** In-file nesting depth; 0 for all file-level graphs. */
  depth: number
}

interface CanvasEdge {
  id: string
  from: string
  to: string
  relation: CanvasRelation
  cyclic: boolean
}

interface CanvasGraphData {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  truncated: boolean
}

interface CanvasPoint {
  x: number
  y: number
}

type CanvasHover = { kind: 'node'; id: string } | { kind: 'edge'; id: string }

const CANVAS_MAX_NODES = 200
const CANVAS_MAX_EDGES = 2000
const CANVAS_FLOW_EDGES = 500
const CANVAS_NODE_RADIUS = 7
const CANVAS_NODE_SLOP = 4
const CANVAS_EDGE_SLOP = 6
const CANVAS_MIN_SCALE = 0.15
const CANVAS_MAX_SCALE = 3
const CANVAS_RELAX_STEPS = 90
const CANVAS_LAYER_CAP = 8
/** Breathing room around the graph when auto-fitting, in screen pixels. */
const CANVAS_FIT_PAD = 48
/** Below this zoom an inactive node is a dot instead of a dot + label. */
const CANVAS_LABEL_SCALE = 0.55
/** Below this zoom edges lose their arrowheads and draw at 1 screen pixel. */
const CANVAS_LOW_DETAIL_SCALE = 0.3
/** Ring/star radius base and per-sqrt(node) growth, both in world pixels. */
const CANVAS_RADIUS_BASE = 48
const CANVAS_RADIUS_PER_SQRT_NODE = 40
const CANVAS_RADIUS_CAP = 640

/* ------------------------------------------------------------------------- *
 * Render scheduling: one plugin-wide, three-queue task pump
 *
 * The canvas never runs a free-running frame loop. Interaction redraws go to
 * `high`, decorative animation frames (dash flow, ring pulse, ripple) to
 * `medium`, and layout/data redraws (fit, relayout, post-load paint) to `low`.
 * High runs one task per animation frame; medium and low drain one task per
 * idle callback. An idle plugin therefore schedules zero callbacks.
 * ------------------------------------------------------------------------- */

/** User-visible priority of one scheduled task. */
export type Priority = 'high' | 'medium' | 'low'

interface Entry {
  key: string
  run: () => void
}

interface IdleDeadlineLike {
  readonly didTimeout: boolean
  timeRemaining(): number
}

/** Higher rank wins when the same key is scheduled again. */
const PRIORITY_RANK: Readonly<Record<Priority, number>> = {
  high: 3,
  medium: 2,
  low: 1,
}

/** Continuous animation is capped at ~30 fps; interaction still paints at once. */
const CANVAS_ANIMATION_INTERVAL_MS = 30

/** `performance.now` with a Node-safe fallback (module evaluation stays inert). */
function renderNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

/**
 * Three independent priority queues on one lazily started pump.
 *
 * Drain rules:
 *  - each `requestAnimationFrame` callback runs exactly one `high` task; if
 *    `high` is empty it may run one `medium` task in that same frame;
 *  - each `requestIdleCallback` callback runs exactly one `medium` (then `low`)
 *    task and yields when the deadline has less than 4 ms left;
 *  - `medium` is never touched until `high` is empty and `low` never until
 *    `medium` is empty, so ordering is strict across priorities;
 *  - one throwing task is logged and the pump continues.
 *
 * A queue empty everywhere cancels the pending callback, so an idle plugin has
 * no timers/frames outstanding. `dispose()` only marks the queue unusable;
 * `reset()` (tests) restores it.
 */
export class Task {
  readonly #queues: { high: Entry[]; medium: Entry[]; low: Entry[] } = {
    high: [],
    medium: [],
    low: [],
  }
  /** key -> current queue, used for the same-key merge/upgrade rule. */
  readonly #index = new Map<string, Priority>()
  #handle: number | ReturnType<typeof setTimeout> | null = null
  #handleKind: 'frame' | 'idle' | 'timeout' | null = null
  #disposed = false
  #warned = false

  /** Number of tasks currently waiting in all three queues. */
  get pending(): number {
    return this.#queues.high.length + this.#queues.medium.length + this.#queues.low.length
  }

  /**
   * Queue (or upgrade) one task.
   *
   * Scheduling an existing key only takes effect when the new priority is
   * strictly higher: the entry moves to the higher queue; otherwise the call is
   * ignored. The pump starts lazily, never from module evaluation.
   */
  schedule(priority: Priority, key: string, run: () => void): void {
    if (this.#disposed) {
      if (!this.#warned) {
        this.#warned = true
        console.warn('[coordination] task queue disposed')
      }
      return
    }
    const current = this.#index.get(key)
    if (current !== undefined) {
      if (PRIORITY_RANK[priority] <= PRIORITY_RANK[current]) return
      this.#remove(current, key)
    }
    this.#queues[priority].push({ key, run })
    this.#index.set(key, priority)
    this.#ensurePump()
  }

  /** Drop one queued task; the pending callback stops if nothing remains. */
  cancel(key: string): void {
    const priority = this.#index.get(key)
    if (priority === undefined) return
    this.#remove(priority, key)
    if (this.pending === 0) this.#cancelHandle()
  }

  /**
   * Permanently stop this queue: pending callbacks are cancelled and the three
   * queues cleared. Later `schedule()` calls are no-ops (one warning) instead
   * of throwing, which keeps a hot-reloaded component harmless.
   */
  dispose(): void {
    this.#disposed = true
    this.#clearQueues()
    this.#cancelHandle()
  }

  /** Test-only re-arm: cancel callbacks, clear queues, allow scheduling again. */
  reset(): void {
    this.#cancelHandle()
    this.#clearQueues()
    this.#disposed = false
    this.#warned = false
  }

  #clearQueues(): void {
    this.#queues.high.length = 0
    this.#queues.medium.length = 0
    this.#queues.low.length = 0
    this.#index.clear()
  }

  #remove(priority: Priority, key: string): void {
    const queue = this.#queues[priority]
    const index = queue.findIndex((entry) => entry.key === key)
    if (index !== -1) queue.splice(index, 1)
    this.#index.delete(key)
  }

  #run(entry: Entry): void {
    try {
      entry.run()
    } catch (error) {
      // One failed render task must never stop the other tasks' pump.
      console.error('[coordination] task failed', error)
    }
  }

  /** Schedule the next callback only when work actually remains. */
  #ensurePump(): void {
    if (this.#disposed) return
    if (this.pending === 0) {
      this.#cancelHandle()
      return
    }
    if (this.#handle !== null) {
      // A higher-priority arrival preempts a pending idle pump with a frame;
      // an already pending frame stays as it is.
      if (this.#queues.high.length > 0 && this.#handleKind !== 'frame') {
        this.#cancelHandle()
      } else {
        return
      }
    }
    if (this.#queues.high.length > 0) this.#scheduleFrame()
    else this.#scheduleIdle()
  }

  #scheduleFrame(): void {
    if (typeof requestAnimationFrame === 'function') {
      this.#handleKind = 'frame'
      this.#handle = requestAnimationFrame(this.#onFrame)
      return
    }
    this.#handleKind = 'timeout'
    this.#handle = setTimeout(() => {
      this.#handle = null
      this.#handleKind = null
      this.#onFrame()
    }, 16)
  }

  #scheduleIdle(): void {
    if (typeof requestIdleCallback === 'function') {
      this.#handleKind = 'idle'
      this.#handle = requestIdleCallback(this.#onIdle, { timeout: 100 })
      return
    }
    this.#handleKind = 'timeout'
    this.#handle = setTimeout(() => {
      this.#handle = null
      this.#handleKind = null
      // A timeout has no idle budget; run one task so the queue cannot starve.
      this.#onIdle({ didTimeout: true, timeRemaining: () => 0 })
    }, 16)
  }

  #cancelHandle(): void {
    if (this.#handle === null) return
    const handle = this.#handle
    if (this.#handleKind === 'frame' && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(handle as number)
    } else if (this.#handleKind === 'idle' && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(handle as number)
    } else {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    }
    this.#handle = null
    this.#handleKind = null
  }

  /** One high task per frame; the transition frame may run one medium task. */
  readonly #onFrame = (): void => {
    this.#handle = null
    this.#handleKind = null
    if (this.#disposed) return
    const high = this.#queues.high.shift()
    if (high !== undefined) {
      this.#index.delete(high.key)
      this.#run(high)
    } else {
      const medium = this.#queues.medium.shift()
      if (medium !== undefined) {
        this.#index.delete(medium.key)
        this.#run(medium)
      }
    }
    this.#ensurePump()
  }

  /** One medium (else low) task per idle callback, strictly after `high`. */
  readonly #onIdle = (deadline: IdleDeadlineLike): void => {
    this.#handle = null
    this.#handleKind = null
    if (this.#disposed) return
    if (this.#queues.high.length > 0) {
      this.#ensurePump()
      return
    }
    if (!deadline.didTimeout && deadline.timeRemaining() < 4) {
      this.#scheduleIdle()
      return
    }
    const next = this.#queues.medium.shift() ?? this.#queues.low.shift()
    if (next !== undefined) {
      this.#index.delete(next.key)
      this.#run(next)
    }
    this.#ensurePump()
  }
}

/**
 * The plugin-wide queue. Module evaluation is inert: it allocates three empty
 * arrays and starts no frame/idle callback until the first `schedule()`.
 */
export const taskQueue = new Task()

/** The single queue every panel task schedules through (tests included). */
export function getTaskQueue(): Task {
  return taskQueue
}

/* ------------------------------------------------------------------------- *
 * WebGL canvas painter
 *
 * The graph geometry is the expensive part of a dense canvas (thousands of
 * edges, hundreds of nodes, arrows and dash phases). It is drawn on a WebGL2
 * canvas with instanced quads/triangles: node positions and edge lengths live
 * in world space, while every mark (stroke width, node radius, arrowhead) is
 * expanded in screen space so zoom never bloats the marks. Labels stay on a
 * transparent 2D overlay canvas because text rendering in WebGL needs a glyph
 * atlas and is not the bottleneck.
 *
 * A machine without WebGL2 keeps the original 2D renderer (the caller falls
 * back to it), so this is an accelerator, never a hard dependency.
 * ------------------------------------------------------------------------- */

/** Parsed straight-alpha color used by the WebGL shaders. */
type CanvasRgba = readonly [number, number, number, number]

const CANVAS_SHADER_EDGE_VERTEX = `
attribute vec2 aCorner;
attribute vec2 aFrom;
attribute vec2 aTo;
attribute float aWidth;
attribute float aDash;
attribute float aPulse;
attribute vec4 aColor;
uniform vec2 uResolution;
uniform float uScale;
uniform vec2 uTranslate;
varying vec4 vColor;
varying float vDistance;
varying float vDash;
varying float vPulse;
void main() {
  vec2 delta = aTo - aFrom;
  float lengthPx = length(delta);
  vec2 dir = lengthPx > 0.0001 ? delta / lengthPx : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float t = aCorner.x * 0.5 + 0.5;
  vec2 world = mix(aFrom, aTo, t) + normal * aCorner.y * (aWidth * 0.5 / uScale);
  vec2 screen = world * uScale + uTranslate;
  vec2 clip = (screen / uResolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vColor = aColor;
  vDistance = t * lengthPx * uScale;
  vDash = aDash;
  vPulse = aPulse;
}
`

const CANVAS_SHADER_EDGE_FRAGMENT = `
precision mediump float;
varying vec4 vColor;
varying float vDistance;
varying float vDash;
varying float vPulse;
uniform float uTime;
uniform float uAnimate;
uniform float uPulse;
void main() {
  if (vDash > 0.5 && mod(vDistance - uAnimate * uTime * 30.0, 12.0) > 6.0) discard;
  float alpha = vColor.a;
  if (vPulse > 0.5 && uPulse > 0.5) {
    alpha *= 0.55 + 0.45 * (0.5 + 0.5 * sin(uTime * 3.9));
  }
  if (alpha <= 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * alpha, alpha);
}
`

const CANVAS_SHADER_ARROW_VERTEX = `
attribute vec2 aCorner;
attribute vec2 aFrom;
attribute vec2 aTo;
attribute vec4 aColor;
uniform vec2 uResolution;
uniform float uScale;
uniform vec2 uTranslate;
varying vec4 vColor;
void main() {
  vec2 fromScreen = aFrom * uScale + uTranslate;
  vec2 toScreen = aTo * uScale + uTranslate;
  vec2 delta = toScreen - fromScreen;
  float lengthPx = length(delta);
  vec2 dir = lengthPx > 0.0001 ? delta / lengthPx : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  // Constant screen size: gap = node radius + 4 px, head = 7 x 3.5 px.
  vec2 tip = toScreen - dir * 11.0;
  vec2 point = tip - dir * (aCorner.x * 7.0) + normal * (aCorner.y * 3.5);
  vec2 clip = (point / uResolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vColor = aColor;
}
`

const CANVAS_SHADER_ARROW_FRAGMENT = `
precision mediump float;
varying vec4 vColor;
void main() {
  if (vColor.a <= 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a);
}
`

const CANVAS_SHADER_NODE_VERTEX = `
attribute vec2 aCorner;
attribute vec2 aCenter;
attribute float aRadius;
attribute vec4 aFill;
attribute vec4 aStroke;
attribute float aSolid;
uniform vec2 uResolution;
uniform float uScale;
uniform vec2 uTranslate;
varying vec2 vCorner;
varying vec4 vFill;
varying vec4 vStroke;
varying float vSolid;
void main() {
  vec2 world = aCenter + aCorner * (aRadius / uScale);
  vec2 screen = world * uScale + uTranslate;
  vec2 clip = (screen / uResolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vCorner = aCorner;
  vFill = aFill;
  vStroke = aStroke;
  vSolid = aSolid;
}
`

const CANVAS_SHADER_NODE_FRAGMENT = `
precision mediump float;
varying vec2 vCorner;
varying vec4 vFill;
varying vec4 vStroke;
varying float vSolid;
void main() {
  float distanceToCenter = length(vCorner);
  if (distanceToCenter > 1.0) discard;
  // smoothstep arguments must be increasing; invert for an inside-to-edge fade.
  float edge = 1.0 - smoothstep(0.88, 1.0, distanceToCenter);
  vec3 rgb = vFill.rgb;
  float alpha = vFill.a;
  if (vSolid < 0.5) {
    float ring = smoothstep(0.74, 0.86, distanceToCenter);
    rgb = mix(vFill.rgb, vStroke.rgb, ring);
    alpha = mix(vFill.a, vStroke.a, ring);
  }
  alpha *= edge;
  if (alpha <= 0.004) discard;
  gl_FragColor = vec4(rgb * alpha, alpha);
}
`

/** One frame of visual state the painter needs besides the scene geometry. */
export interface WebGlCanvasPaintInput {
  hover: CanvasHover | null
  selectedEdge: string | null
  selectedNode: string | null
  trace: { upstream: ReadonlySet<string>; downstream: ReadonlySet<string> } | null
  /** Nodes touched by the hovered node's trace (precomputed by the caller). */
  tracedNodes: ReadonlySet<string>
  viewport: { scale: number; x: number; y: number }
  palette: {
    primary: string
    secondary: string
    success: string
    warning: string
    paper: string
    text: string
  }
  /** Milliseconds from the frame callback; drives the dash phase and pulse. */
  time: number
  reducedMotion: boolean
  lowDetail: boolean
}

/** Edge instance data assembled once per layout. */
interface WebGlEdgeItem {
  edge: CanvasEdge
  from: CanvasPoint
  to: CanvasPoint
}

/** Parse the MUI palette strings (`#rgb`, `#rrggbb`, `rgb()`, `rgba()`). */
function parseCanvasColor(value: string, alpha = 1): CanvasRgba {
  const text = value.trim().toLowerCase()
  if (text.startsWith('#')) {
    const raw = text.slice(1)
    const hex = raw.length === 3 || raw.length === 4
      ? raw.split('').map((part) => `${part}${part}`).join('')
      : raw
    if (hex.length === 6 || hex.length === 8) {
      const red = Number.parseInt(hex.slice(0, 2), 16) / 255
      const green = Number.parseInt(hex.slice(2, 4), 16) / 255
      const blue = Number.parseInt(hex.slice(4, 6), 16) / 255
      const opacity = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1
      return [red, green, blue, opacity * alpha]
    }
  }
  const match = /^rgba?\(([^)]+)\)$/.exec(text)
  if (match !== null) {
    const parts = (match[1] as string).split(/[,\s/]+/).filter((part) => part.length > 0)
    if (parts.length >= 3) {
      const channel = (part: string): number => {
        const parsed = Number.parseFloat(part)
        if (!Number.isFinite(parsed)) return 0
        return Math.max(0, Math.min(1, part.endsWith('%') ? parsed / 100 : parsed / 255))
      }
      const opacity = parts.length >= 4 ? Number.parseFloat(parts[3] as string) : 1
      return [
        channel(parts[0] as string),
        channel(parts[1] as string),
        channel(parts[2] as string),
        (Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1) * alpha,
      ]
    }
  }
  return [0.5, 0.5, 0.5, alpha]
}

function compileCanvasShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type)
  if (shader === null) throw new Error('webgl: could not create a shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown compile error'
    gl.deleteShader(shader)
    throw new Error(`webgl: shader compile failed: ${log}`)
  }
  return shader
}

function linkCanvasProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const program = gl.createProgram()
  if (program === null) throw new Error('webgl: could not create a program')
  const vertex = compileCanvasShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = compileCanvasShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown link error'
    gl.deleteProgram(program)
    throw new Error(`webgl: program link failed: ${log}`)
  }
  return program
}

function canvasAttribute(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): number {
  const location = gl.getAttribLocation(program, name)
  if (location < 0) throw new Error(`webgl: missing attribute ${name}`)
  return location
}

function canvasUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation | null {
  return gl.getUniformLocation(program, name)
}

function setCanvasUniform1f(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation | null,
  value: number,
): void {
  if (location !== null) gl.uniform1f(location, value)
}

function setCanvasUniform2f(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation | null,
  x: number,
  y: number,
): void {
  if (location !== null) gl.uniform2f(location, x, y)
}

/** Instanced WebGL2 painter for the relationship canvas geometry. */
export class WebGlCanvasPainter {
  private readonly gl: WebGL2RenderingContext
  private readonly edgeProgram: WebGLProgram
  private readonly arrowProgram: WebGLProgram
  private readonly nodeProgram: WebGLProgram
  private readonly edgeVao: WebGLVertexArrayObject
  private readonly arrowVao: WebGLVertexArrayObject
  private readonly nodeVao: WebGLVertexArrayObject
  private readonly quadBuffer: WebGLBuffer
  private readonly arrowBuffer: WebGLBuffer
  private readonly edgeStaticBuffer: WebGLBuffer
  private readonly edgeStyleBuffer: WebGLBuffer
  private readonly nodeStaticBuffer: WebGLBuffer
  private readonly nodeStyleBuffer: WebGLBuffer
  private readonly edgeUniforms: Record<'resolution' | 'scale' | 'translate' | 'time' | 'animate' | 'pulse', WebGLUniformLocation | null>
  private readonly arrowUniforms: Record<'resolution' | 'scale' | 'translate', WebGLUniformLocation | null>
  private readonly nodeUniforms: Record<'resolution' | 'scale' | 'translate', WebGLUniformLocation | null>
  private readonly colorCache = new Map<string, CanvasRgba>()
  private edges: WebGlEdgeItem[] = []
  private nodes: CanvasNode[] = []
  private edgeCount = 0
  private nodeCount = 0
  private styleKey = ''
  private styleDirty = true
  private disposed = false
  private width = 0
  private height = 0

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.edgeProgram = linkCanvasProgram(gl, CANVAS_SHADER_EDGE_VERTEX, CANVAS_SHADER_EDGE_FRAGMENT)
    this.arrowProgram = linkCanvasProgram(gl, CANVAS_SHADER_ARROW_VERTEX, CANVAS_SHADER_ARROW_FRAGMENT)
    this.nodeProgram = linkCanvasProgram(gl, CANVAS_SHADER_NODE_VERTEX, CANVAS_SHADER_NODE_FRAGMENT)

    this.edgeUniforms = {
      resolution: canvasUniform(gl, this.edgeProgram, 'uResolution'),
      scale: canvasUniform(gl, this.edgeProgram, 'uScale'),
      translate: canvasUniform(gl, this.edgeProgram, 'uTranslate'),
      time: canvasUniform(gl, this.edgeProgram, 'uTime'),
      animate: canvasUniform(gl, this.edgeProgram, 'uAnimate'),
      pulse: canvasUniform(gl, this.edgeProgram, 'uPulse'),
    }
    this.arrowUniforms = {
      resolution: canvasUniform(gl, this.arrowProgram, 'uResolution'),
      scale: canvasUniform(gl, this.arrowProgram, 'uScale'),
      translate: canvasUniform(gl, this.arrowProgram, 'uTranslate'),
    }
    this.nodeUniforms = {
      resolution: canvasUniform(gl, this.nodeProgram, 'uResolution'),
      scale: canvasUniform(gl, this.nodeProgram, 'uScale'),
      translate: canvasUniform(gl, this.nodeProgram, 'uTranslate'),
    }

    this.quadBuffer = this.createBuffer(new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1,
    ]))
    this.arrowBuffer = this.createBuffer(new Float32Array([
      0, 0, 1, 1, 1, -1,
    ]))
    this.edgeStaticBuffer = this.createBuffer(new Float32Array(0))
    this.edgeStyleBuffer = this.createBuffer(new Float32Array(0))
    this.nodeStaticBuffer = this.createBuffer(new Float32Array(0))
    this.nodeStyleBuffer = this.createBuffer(new Float32Array(0))
    this.edgeVao = this.createEdgeVao()
    this.arrowVao = this.createArrowVao()
    this.nodeVao = this.createNodeVao()
  }

  /** Replace the scene geometry; called on layout/data/node-drag changes. */
  setScene(graph: CanvasGraphData, positions: ReadonlyMap<string, CanvasPoint>): void {
    const edges: WebGlEdgeItem[] = []
    const edgeData: number[] = []
    for (const edge of graph.edges) {
      const from = positions.get(edge.from)
      const to = positions.get(edge.to)
      if (from === undefined || to === undefined) continue
      edges.push({ edge, from, to })
      edgeData.push(from.x, from.y, to.x, to.y)
    }
    this.edges = edges
    this.edgeCount = edges.length
    this.upload(this.edgeStaticBuffer, edgeData)

    const nodes: CanvasNode[] = []
    const nodeData: number[] = []
    for (const node of graph.nodes) {
      const point = positions.get(node.id)
      if (point === undefined) continue
      nodes.push(node)
      nodeData.push(point.x, point.y)
    }
    this.nodes = nodes
    this.nodeCount = nodes.length
    this.upload(this.nodeStaticBuffer, nodeData)
    this.styleDirty = true
  }

  resize(width: number, height: number, dpr: number): void {
    const canvas = this.gl.canvas as HTMLCanvasElement
    const nextWidth = Math.max(1, Math.round(width * dpr))
    const nextHeight = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== nextWidth) canvas.width = nextWidth
    if (canvas.height !== nextHeight) canvas.height = nextHeight
    this.width = width
    this.height = height
    this.gl.viewport(0, 0, nextWidth, nextHeight)
  }

  draw(input: WebGlCanvasPaintInput): void {
    const gl = this.gl
    if (this.width <= 0 || this.height <= 0) return
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (this.edgeCount === 0 && this.nodeCount === 0) return
    this.applyStyle(input)

    const seconds = input.time / 1000
    const scale = Math.max(0.0001, input.viewport.scale)
    const translateX = input.viewport.x
    const translateY = input.viewport.y

    if (this.edgeCount > 0) {
      gl.useProgram(this.edgeProgram)
      setCanvasUniform2f(gl, this.edgeUniforms.resolution, this.width, this.height)
      setCanvasUniform1f(gl, this.edgeUniforms.scale, scale)
      setCanvasUniform2f(gl, this.edgeUniforms.translate, translateX, translateY)
      setCanvasUniform1f(gl, this.edgeUniforms.time, seconds)
      setCanvasUniform1f(gl, this.edgeUniforms.animate, input.reducedMotion ? 0 : 1)
      setCanvasUniform1f(gl, this.edgeUniforms.pulse, input.reducedMotion ? 0 : 1)
      gl.bindVertexArray(this.edgeVao)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.edgeCount)

      // Arrowheads are pure overdraw below the low-detail threshold.
      if (!input.lowDetail) {
        gl.useProgram(this.arrowProgram)
        setCanvasUniform2f(gl, this.arrowUniforms.resolution, this.width, this.height)
        setCanvasUniform1f(gl, this.arrowUniforms.scale, scale)
        setCanvasUniform2f(gl, this.arrowUniforms.translate, translateX, translateY)
        gl.bindVertexArray(this.arrowVao)
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, this.edgeCount)
      }
    }

    if (this.nodeCount > 0) {
      gl.useProgram(this.nodeProgram)
      setCanvasUniform2f(gl, this.nodeUniforms.resolution, this.width, this.height)
      setCanvasUniform1f(gl, this.nodeUniforms.scale, scale)
      setCanvasUniform2f(gl, this.nodeUniforms.translate, translateX, translateY)
      gl.bindVertexArray(this.nodeVao)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.nodeCount)
    }
    gl.bindVertexArray(null)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const gl = this.gl
    gl.deleteBuffer(this.quadBuffer)
    gl.deleteBuffer(this.arrowBuffer)
    gl.deleteBuffer(this.edgeStaticBuffer)
    gl.deleteBuffer(this.edgeStyleBuffer)
    gl.deleteBuffer(this.nodeStaticBuffer)
    gl.deleteBuffer(this.nodeStyleBuffer)
    gl.deleteVertexArray(this.edgeVao)
    gl.deleteVertexArray(this.arrowVao)
    gl.deleteVertexArray(this.nodeVao)
    gl.deleteProgram(this.edgeProgram)
    gl.deleteProgram(this.arrowProgram)
    gl.deleteProgram(this.nodeProgram)
  }

  private createBuffer(data: Float32Array): WebGLBuffer {
    const gl = this.gl
    const buffer = gl.createBuffer()
    if (buffer === null) throw new Error('webgl: could not create a buffer')
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
    return buffer
  }

  private upload(buffer: WebGLBuffer, data: ArrayLike<number>): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW)
  }

  /** Enable one float attribute and mark it per-instance. */
  private instanceAttribute(location: number, size: number, strideBytes: number, offsetBytes: number): void {
    const gl = this.gl
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, strideBytes, offsetBytes)
    gl.vertexAttribDivisor(location, 1)
  }

  private vertexAttribute(location: number, size: number): void {
    const gl = this.gl
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0)
    gl.vertexAttribDivisor(location, 0)
  }

  private createEdgeVao(): WebGLVertexArrayObject {
    const gl = this.gl
    const vao = gl.createVertexArray()
    if (vao === null) throw new Error('webgl: could not create a vertex array')
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer)
    this.vertexAttribute(canvasAttribute(gl, this.edgeProgram, 'aCorner'), 2)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeStaticBuffer)
    this.instanceAttribute(canvasAttribute(gl, this.edgeProgram, 'aFrom'), 2, 16, 0)
    this.instanceAttribute(canvasAttribute(gl, this.edgeProgram, 'aTo'), 2, 16, 8)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeStyleBuffer)
    this.instanceAttribute(canvasAttribute(gl, this.edgeProgram, 'aWidth'), 1, 28, 0)
    this.instanceAttribute(canvasAttribute(gl, this.edgeProgram, 'aDash'), 1, 28, 4)
    this.instanceAttribute(canvasAttribute(gl, this.edgeProgram, 'aPulse'), 1, 28, 8)
    this.instanceAttribute(canvasAttribute(gl, this.edgeProgram, 'aColor'), 4, 28, 12)
    gl.bindVertexArray(null)
    return vao
  }

  private createArrowVao(): WebGLVertexArrayObject {
    const gl = this.gl
    const vao = gl.createVertexArray()
    if (vao === null) throw new Error('webgl: could not create a vertex array')
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowBuffer)
    this.vertexAttribute(canvasAttribute(gl, this.arrowProgram, 'aCorner'), 2)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeStaticBuffer)
    this.instanceAttribute(canvasAttribute(gl, this.arrowProgram, 'aFrom'), 2, 16, 0)
    this.instanceAttribute(canvasAttribute(gl, this.arrowProgram, 'aTo'), 2, 16, 8)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeStyleBuffer)
    this.instanceAttribute(canvasAttribute(gl, this.arrowProgram, 'aColor'), 4, 28, 12)
    gl.bindVertexArray(null)
    return vao
  }

  private createNodeVao(): WebGLVertexArrayObject {
    const gl = this.gl
    const vao = gl.createVertexArray()
    if (vao === null) throw new Error('webgl: could not create a vertex array')
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer)
    this.vertexAttribute(canvasAttribute(gl, this.nodeProgram, 'aCorner'), 2)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeStaticBuffer)
    this.instanceAttribute(canvasAttribute(gl, this.nodeProgram, 'aCenter'), 2, 8, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeStyleBuffer)
    this.instanceAttribute(canvasAttribute(gl, this.nodeProgram, 'aRadius'), 1, 40, 0)
    this.instanceAttribute(canvasAttribute(gl, this.nodeProgram, 'aFill'), 4, 40, 4)
    this.instanceAttribute(canvasAttribute(gl, this.nodeProgram, 'aStroke'), 4, 40, 20)
    this.instanceAttribute(canvasAttribute(gl, this.nodeProgram, 'aSolid'), 1, 40, 36)
    gl.bindVertexArray(null)
    return vao
  }

  /** Compose the per-frame style key; a change rebuilds the style buffers. */
  private styleKeyOf(input: WebGlCanvasPaintInput): string {
    return [
      input.hover === null ? '' : `${input.hover.kind}:${input.hover.id}`,
      input.selectedEdge ?? '',
      input.selectedNode ?? '',
      input.lowDetail ? 'low' : 'full',
      input.viewport.scale >= CANVAS_LABEL_SCALE ? 'label' : 'dot',
      input.reducedMotion ? 'still' : 'motion',
      input.palette.primary,
      input.palette.secondary,
      input.palette.success,
      input.palette.warning,
      input.palette.paper,
      input.palette.text,
    ].join('|')
  }

  private color(value: string, alpha = 1): CanvasRgba {
    const key = `${value}|${alpha}`
    const cached = this.colorCache.get(key)
    if (cached !== undefined) return cached
    const parsed = parseCanvasColor(value, alpha)
    this.colorCache.set(key, parsed)
    return parsed
  }

  private applyStyle(input: WebGlCanvasPaintInput): void {
    const key = this.styleKeyOf(input)
    if (!this.styleDirty && key === this.styleKey) return
    this.styleKey = key
    this.styleDirty = false

    const gl = this.gl
    const primary = this.color(input.palette.primary)
    const secondary = this.color(input.palette.secondary)
    const success = this.color(input.palette.success)
    const warning = this.color(input.palette.warning)
    const paper = this.color(input.palette.paper)
    const text = this.color(input.palette.text)

    const edgeStyle = new Float32Array(this.edgeCount * 7)
    for (let index = 0; index < this.edgeCount; index += 1) {
      const item = this.edges[index] as WebGlEdgeItem
      const edge = item.edge
      const isSelected = input.selectedEdge === edge.id
      const isHovered = input.hover !== null && input.hover.kind === 'edge' && input.hover.id === edge.id
      const isUpstream = input.trace !== null && input.trace.upstream.has(edge.id)
      const isDownstream = input.trace !== null && input.trace.downstream.has(edge.id)
      const isTraced = isUpstream || isDownstream

      let alpha = 1
      if (input.selectedEdge !== null) alpha = isSelected ? 1 : 0.15
      else if (isHovered) alpha = 1
      else if (input.hover !== null && input.hover.kind === 'edge') alpha = 0.35
      else if (input.trace !== null) alpha = isTraced ? 1 : 0.15

      let color: CanvasRgba = edge.relation === 'imports' || edge.relation === 'part_of'
        ? secondary
        : edge.relation === 'exports'
          ? success
          : primary
      if (edge.cyclic) color = warning
      if (isUpstream && !edge.cyclic) color = [0.149, 0.776, 0.855, 1]
      else if (isDownstream && !edge.cyclic) color = primary

      const width = input.lowDetail
        ? 1
        : isSelected ? 2.5 : isHovered ? 3 : 1.2
      const offset = index * 7
      edgeStyle[offset] = width
      edgeStyle[offset + 1] = isSelected ? 0 : 1
      edgeStyle[offset + 2] = edge.cyclic && !isSelected ? 1 : 0
      edgeStyle[offset + 3] = color[0]
      edgeStyle[offset + 4] = color[1]
      edgeStyle[offset + 5] = color[2]
      edgeStyle[offset + 6] = color[3] * alpha
    }
    this.upload(this.edgeStyleBuffer, edgeStyle)

    const nodeStyle = new Float32Array(this.nodeCount * 10)
    for (let index = 0; index < this.nodeCount; index += 1) {
      const node = this.nodes[index] as CanvasNode
      const isHovered = input.hover !== null && input.hover.kind === 'node' && input.hover.id === node.id
      const isSelected = input.selectedNode === node.id
      const onTrace = input.tracedNodes.has(node.id)
      const active = isHovered || isSelected || onTrace
      let alpha = 1
      if (input.selectedEdge !== null) alpha = 0.4
      else if (input.trace !== null && input.hover !== null && input.hover.kind === 'node' && !isHovered) {
        alpha = onTrace ? 0.75 : 0.35
      }

      const radius = isHovered ? CANVAS_NODE_RADIUS + 3 : CANVAS_NODE_RADIUS
      const solid = !shouldDrawLabel(input.viewport.scale, active)
      const fill = solid || isSelected || isHovered ? primary : paper
      const offset = index * 10
      nodeStyle[offset] = radius
      nodeStyle[offset + 1] = fill[0]
      nodeStyle[offset + 2] = fill[1]
      nodeStyle[offset + 3] = fill[2]
      nodeStyle[offset + 4] = fill[3] * alpha
      nodeStyle[offset + 5] = primary[0]
      nodeStyle[offset + 6] = primary[1]
      nodeStyle[offset + 7] = primary[2]
      nodeStyle[offset + 8] = solid ? 0 : primary[3] * alpha
      nodeStyle[offset + 9] = solid ? 1 : 0
    }
    this.upload(this.nodeStyleBuffer, nodeStyle)
  }
}

/** Create the WebGL2 painter, or `null` when this browser has no WebGL2. */
export function createWebGlCanvasPainter(canvas: HTMLCanvasElement): WebGlCanvasPainter | null {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    desynchronized: true,
  })
  if (gl === null) return null
  try {
    return new WebGlCanvasPainter(gl)
  } catch (error) {
    // Release the failed context; the caller remounts the canvas for the 2D
    // fallback because one canvas element can only ever have one context kind.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    throw error
  }
}

/** Everything the 2D label/ripple overlay needs; labels never live in WebGL. */
interface CanvasLabelPaintInput {
  graph: CanvasGraphData
  positions: ReadonlyMap<string, CanvasPoint>
  viewport: { scale: number; x: number; y: number }
  hover: CanvasHover | null
  selectedEdge: string | null
  selectedNode: string | null
  tracedNodes: ReadonlySet<string>
  textColor: string
  primaryColor: string
  width: number
  height: number
  dpr: number
  time: number
  ripple: { x: number; y: number; start: number } | null
}

/**
 * Paint only node labels and the click ripple on the transparent 2D overlay.
 *
 * Text in WebGL would need a glyph atlas and buys little: the overlay is cheap
 * (≤200 short labels) and keeps the labels crisp and selectable-free while the
 * heavy geometry is drawn by the GPU underneath.
 */
function paintCanvasLabels(canvas: HTMLCanvasElement, input: CanvasLabelPaintInput): void {
  const context = canvas.getContext('2d')
  if (context === null) return
  const pixelWidth = Math.max(1, Math.round(input.width * input.dpr))
  const pixelHeight = Math.max(1, Math.round(input.height * input.dpr))
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight
  context.setTransform(input.dpr, 0, 0, input.dpr, 0, 0)
  context.clearRect(0, 0, input.width, input.height)
  const scale = input.viewport.scale
  if (!(scale > 0)) return

  context.font = '10px ui-sans-serif, system-ui, sans-serif'
  context.textBaseline = 'alphabetic'
  for (const node of input.graph.nodes) {
    const point = input.positions.get(node.id)
    if (point === undefined) continue
    const isHovered = input.hover !== null && input.hover.kind === 'node' && input.hover.id === node.id
    const isSelected = input.selectedNode === node.id
    const onTrace = input.tracedNodes.has(node.id)
    if (!shouldDrawLabel(scale, isHovered || isSelected || onTrace)) continue
    let alpha = 1
    if (input.selectedEdge !== null) alpha = 0.4
    else if (input.hover !== null && input.hover.kind === 'node' && !isHovered) {
      alpha = onTrace ? 0.75 : 0.35
    }
    const x = point.x * scale + input.viewport.x
    const y = point.y * scale + input.viewport.y
    // Off-screen labels cost a full text-shaping pass for nothing.
    if (x < -240 || y < -40 || x > input.width + 40 || y > input.height + 40) continue
    const label = node.label.length > 28 ? `…${node.label.slice(-27)}` : node.label
    context.globalAlpha = alpha
    context.fillStyle = input.textColor
    context.fillText(label, x + 11, y + 3)
  }
  context.globalAlpha = 1

  const ripple = input.ripple
  if (ripple !== null) {
    const age = input.time - ripple.start
    if (age >= 0 && age < 300) {
      context.globalAlpha = Math.max(0, 1 - age / 300)
      context.strokeStyle = input.primaryColor
      context.lineWidth = 2
      context.beginPath()
      context.arc(
        ripple.x * scale + input.viewport.x,
        ripple.y * scale + input.viewport.y,
        24 * (age / 300),
        0,
        Math.PI * 2,
      )
      context.stroke()
      context.globalAlpha = 1
    }
  }
}

/** Axis-aligned bounding box of every laid-out node position. */
export interface CanvasBBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** CSS-pixel size of the canvas viewport. */
export interface CanvasViewportSize {
  width: number
  height: number
}

/**
 * Zoom that makes `bbox` fit the viewport with `pad` px of breathing room.
 * The result never exceeds 1:1 and never falls below the interactive zoom
 * floor, so a 200-node graph stays reachable in a narrow panel. A degenerate
 * box (a single node) and no box at all (empty graph) keep the neutral view.
 */
export function fitScale(
  bbox: CanvasBBox | null,
  viewport: CanvasViewportSize,
  pad: number = CANVAS_FIT_PAD,
): number {
  if (bbox === null) return 1
  if (!(viewport.width > 0) || !(viewport.height > 0)) return 1
  const width = bbox.maxX - bbox.minX
  const height = bbox.maxY - bbox.minY
  if (!(width > 0) && !(height > 0)) return 1
  const padding = Number.isFinite(pad) ? Math.max(0, pad) : CANVAS_FIT_PAD
  const scale = Math.min(viewport.width / (width + padding), viewport.height / (height + padding))
  if (!Number.isFinite(scale)) return 1
  return Math.max(CANVAS_MIN_SCALE, Math.min(1, scale))
}

/**
 * Labels are the expensive part of a dense canvas: below the threshold an
 * inactive node collapses to a dot, while hover, selection and traced paths
 * keep their labels regardless of zoom.
 */
export function shouldDrawLabel(scale: number, active: boolean): boolean {
  return active || scale >= CANVAS_LABEL_SCALE
}

/**
 * Ring/star radius for a node count. Growing with sqrt(n) keeps the per-node
 * arc spacing at O(1/sqrt(n)) instead of O(1/n); the cap keeps a full 200-node
 * graph finite before auto-fit shrinks it to the viewport.
 */
export function layoutRadius(nodeCount: number): number {
  const count = Number.isFinite(nodeCount)
    ? Math.min(CANVAS_MAX_NODES, Math.max(0, Math.floor(nodeCount)))
    : 0
  const radius = CANVAS_RADIUS_BASE + Math.sqrt(count) * CANVAS_RADIUS_PER_SQRT_NODE
  return Math.min(CANVAS_RADIUS_CAP, radius)
}

/** Bounding box of the current node positions, or null for an empty graph. */
function canvasBBox(positions: ReadonlyMap<string, CanvasPoint>): CanvasBBox | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of positions.values()) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY }
}

function canvasRelationOf(value: string | undefined): CanvasRelation {
  return value === 'imports' || value === 'exports' || value === 'contains' || value === 'part_of'
    ? value
    : 'depends'
}

function canvasRelationLabel(relation: CanvasRelation, copy: PanelCopy): string {
  if (relation === 'depends' || relation === 'imports' || relation === 'exports') {
    return copy.relation[relation]
  }
  return relation.replace('_', ' ')
}

/** Directed pairs of every reported cycle (`a → b → a` counts as two pairs). */
function cycleEdgeKeys(cycles: readonly (readonly string[])[]): Set<string> {
  const keys = new Set<string>()
  for (const cycle of cycles) {
    for (let index = 0; index + 1 < cycle.length; index += 1) {
      keys.add(`${cycle[index]}\u0000${cycle[index + 1]}`)
    }
  }
  return keys
}

function buildDependencyCanvas(data: DependencyData): CanvasGraphData {
  const ids = new Set<string>()
  for (const link of data.links) {
    ids.add(link.from)
    ids.add(link.to)
  }
  const sorted = [...ids].sort()
  const kept = new Set(sorted.slice(0, CANVAS_MAX_NODES))
  const cycleKeys = cycleEdgeKeys(data.cycles)
  const seen = new Set<string>()
  const edges: CanvasEdge[] = []
  for (const link of data.links) {
    if (!kept.has(link.from) || !kept.has(link.to)) continue
    const relation = canvasRelationOf(link.relation)
    const id = `${relation}|${link.from}|${link.to}`
    if (seen.has(id)) continue
    seen.add(id)
    edges.push({
      id,
      from: link.from,
      to: link.to,
      relation,
      cyclic: link.cyclic || cycleKeys.has(`${link.from}\u0000${link.to}`),
    })
  }
  edges.sort((left, right) => left.id.localeCompare(right.id))
  return {
    nodes: sorted.slice(0, CANVAS_MAX_NODES).map((id) => ({ id, label: id, path: id, depth: 0 })),
    edges: edges.slice(0, CANVAS_MAX_EDGES),
    truncated: sorted.length > CANVAS_MAX_NODES || edges.length > CANVAS_MAX_EDGES,
  }
}

/** In-file symbol graph from `/graph/intra`, annotated from the intra link set. */
function buildIntraCanvas(intra: IntraData, dependencies: DependencyData): CanvasGraphData {
  const kept = new Set(intra.nodes.slice(0, CANVAS_MAX_NODES).map((node) => node.id))
  const cyclicLinks = new Map<string, boolean>()
  for (const link of dependencies.links) {
    cyclicLinks.set(`${link.from}\u0000${link.to}`, link.cyclic)
  }
  const cycleKeys = cycleEdgeKeys(dependencies.cycles)
  const seen = new Set<string>()
  const edges: CanvasEdge[] = []
  for (const edge of intra.edges) {
    if (!kept.has(edge.from) || !kept.has(edge.to)) continue
    const relation = canvasRelationOf(edge.relation)
    const id = `${relation}|${edge.from}|${edge.to}`
    if (seen.has(id)) continue
    seen.add(id)
    edges.push({
      id,
      from: edge.from,
      to: edge.to,
      relation,
      cyclic: cyclicLinks.get(`${edge.from}\u0000${edge.to}`) === true
        || cycleKeys.has(`${edge.from}\u0000${edge.to}`),
    })
  }
  edges.sort((left, right) => left.id.localeCompare(right.id))
  return {
    nodes: intra.nodes.slice(0, CANVAS_MAX_NODES).map((node) => ({
      id: node.id,
      label: node.label,
      path: intra.path.length > 0 ? intra.path : node.label,
      depth: node.depth,
    })),
    edges: edges.slice(0, CANVAS_MAX_EDGES),
    truncated: intra.truncated || intra.nodes.length > CANVAS_MAX_NODES || edges.length > CANVAS_MAX_EDGES,
  }
}

function buildImportsCanvas(data: ImportData, relation: 'imports' | 'exports'): CanvasGraphData {  const pairs: Array<{ from: string; to: string }> = []
  for (const row of data.rows) {
    const items = relation === 'imports' ? row.imported : row.exported
    for (const item of items) {
      if (row.path.length === 0 || item.length === 0) continue
      pairs.push({ from: row.path, to: item })
    }
  }
  const ids = new Set<string>()
  for (const pair of pairs) {
    ids.add(pair.from)
    ids.add(pair.to)
  }
  const sorted = [...ids].sort()
  const kept = new Set(sorted.slice(0, CANVAS_MAX_NODES))
  const cycleKeys = cycleEdgeKeys(data.cycles)
  const seen = new Set<string>()
  const edges: CanvasEdge[] = []
  for (const pair of pairs) {
    if (!kept.has(pair.from) || !kept.has(pair.to)) continue
    const id = `${relation}|${pair.from}|${pair.to}`
    if (seen.has(id)) continue
    seen.add(id)
    edges.push({
      id,
      from: pair.from,
      to: pair.to,
      relation,
      cyclic: cycleKeys.has(`${pair.from}\u0000${pair.to}`),
    })
  }
  edges.sort((left, right) => left.id.localeCompare(right.id))
  return {
    nodes: sorted.slice(0, CANVAS_MAX_NODES).map((id) => ({ id, label: id, path: id, depth: 0 })),
    edges: edges.slice(0, CANVAS_MAX_EDGES),
    truncated: sorted.length > CANVAS_MAX_NODES || edges.length > CANVAS_MAX_EDGES,
  }
}

/** Deterministic layered, star or ring layout with one bounded relaxation. */
function layoutCanvasGraph(
  graph: CanvasGraphData,
  width: number,
  height: number,
  mode: CanvasLayoutMode,
  centerId: string | null,
): Map<string, CanvasPoint> {
  const positions = new Map<string, CanvasPoint>()
  const nodes = graph.nodes
  const count = nodes.length
  if (count === 0 || width <= 0 || height <= 0) return positions
  const cx = width / 2
  const cy = height / 2
  const padding = 28

  if (mode === 'layered') {
    const useNodeDepth = nodes.some((node) => node.depth > 0)
    const layers = new Map<string, number>(nodes.map((node) => [node.id, Math.min(CANVAS_LAYER_CAP, node.depth)]))
    if (!useNodeDepth) {
      for (const node of nodes) layers.set(node.id, 0)
      for (let round = 0; round < 24; round += 1) {
        let changed = false
        for (const edge of graph.edges) {
          const from = layers.get(edge.from)
          const to = layers.get(edge.to)
          if (from === undefined || to === undefined) continue
          const next = Math.min(CANVAS_LAYER_CAP, from + 1)
          if (next > to) {
            layers.set(edge.to, next)
            changed = true
          }
        }
        if (!changed) break
      }
    }
    const groups = new Map<number, string[]>()
    for (const node of nodes) {
      const layer = layers.get(node.id) ?? 0
      const list = groups.get(layer)
      if (list === undefined) groups.set(layer, [node.id])
      else list.push(node.id)
    }
    let maxLayer = 0
    for (const layer of groups.keys()) maxLayer = Math.max(maxLayer, layer)
    for (const [layer, ids] of groups) {
      ids.sort()
      const y = padding + (maxLayer === 0 ? (height - 2 * padding) / 2 : ((height - 2 * padding) * layer) / maxLayer)
      ids.forEach((id, index) => {
        const x = padding + ((width - 2 * padding) * (index + 1)) / (ids.length + 1)
        positions.set(id, { x, y })
      })
    }
    return positions
  }

  // Density-aware ring: sqrt(n) growth widens the arc as the graph fills up,
  // while the viewport floor keeps small graphs from collapsing into a knot.
  const radius = Math.max(layoutRadius(count), Math.min(width, height) * 0.36)
  nodes.forEach((node, index) => {
    if (mode === 'star' && node.id === centerId) {
      positions.set(node.id, { x: cx, y: cy })
      return
    }
    const angle = (2 * Math.PI * index) / Math.max(1, count)
    positions.set(node.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius })
  })

  const indexOf = new Map(nodes.map((node, index) => [node.id, index]))
  const springs: Array<{ a: number; b: number }> = []
  for (const edge of graph.edges) {
    const a = indexOf.get(edge.from)
    const b = indexOf.get(edge.to)
    if (a !== undefined && b !== undefined) springs.push({ a, b })
  }
  const fixed = new Set<string>()
  if (mode === 'star' && centerId !== null && positions.has(centerId)) fixed.add(centerId)

  // The relaxation used to clamp every node inside the viewport, which would
  // collapse a density-grown ring back onto the border before auto-fit ran.
  // Allow the ring's own extent (plus padding) and let fitScale shrink it.
  const limitX = Math.max(width / 2 - padding, radius + padding)
  const limitY = Math.max(height / 2 - padding, radius + padding)

  for (let step = 0; step < CANVAS_RELAX_STEPS; step += 1) {
    const forceX = new Array<number>(count).fill(0)
    const forceY = new Array<number>(count).fill(0)
    for (let left = 0; left < count; left += 1) {
      const pointLeft = positions.get(nodes[left].id)
      if (pointLeft === undefined) continue
      for (let right = left + 1; right < count; right += 1) {
        const pointRight = positions.get(nodes[right].id)
        if (pointRight === undefined) continue
        let dx = pointLeft.x - pointRight.x
        let dy = pointLeft.y - pointRight.y
        let distanceSquared = dx * dx + dy * dy
        if (distanceSquared < 1) {
          const angle = (((left + 1) * 37 + (right + 1) * 53) % 360) * (Math.PI / 180)
          dx = Math.cos(angle)
          dy = Math.sin(angle)
          distanceSquared = 1
        }
        const distance = Math.sqrt(distanceSquared)
        const force = 900 / distanceSquared
        const fx = (dx / distance) * force
        const fy = (dy / distance) * force
        forceX[left] += fx
        forceY[left] += fy
        forceX[right] -= fx
        forceY[right] -= fy
      }
    }
    for (const spring of springs) {
      const pointA = positions.get(nodes[spring.a].id)
      const pointB = positions.get(nodes[spring.b].id)
      if (pointA === undefined || pointB === undefined) continue
      const dx = pointB.x - pointA.x
      const dy = pointB.y - pointA.y
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy))
      const target = mode === 'star' ? 150 : 130
      const force = (distance - target) * 0.02
      const fx = (dx / distance) * force
      const fy = (dy / distance) * force
      forceX[spring.a] += fx
      forceY[spring.a] += fy
      forceX[spring.b] -= fx
      forceY[spring.b] -= fy
    }
    const cooling = 0.45 * (1 - step / CANVAS_RELAX_STEPS) + 0.05
    for (let index = 0; index < count; index += 1) {
      const node = nodes[index]
      const point = positions.get(node.id)
      if (point === undefined || fixed.has(node.id)) continue
      forceX[index] += (cx - point.x) * 0.0025
      forceY[index] += (cy - point.y) * 0.0025
      const stepX = Math.max(-14, Math.min(14, forceX[index] * cooling))
      const stepY = Math.max(-14, Math.min(14, forceY[index] * cooling))
      point.x = Math.min(cx + limitX, Math.max(cx - limitX, point.x + stepX))
      point.y = Math.min(cy + limitY, Math.max(cy - limitY, point.y + stepY))
    }
  }
  return positions
}

/** Depth-3 upstream/downstream edge sets for the hovered node. */
function traceCanvasEdges(
  graph: CanvasGraphData,
  nodeId: string,
): { upstream: Set<string>; downstream: Set<string> } {
  const upstream = new Set<string>()
  const downstream = new Set<string>()
  let frontier = new Set<string>([nodeId])
  for (let depth = 0; depth < 3 && frontier.size > 0; depth += 1) {
    const next = new Set<string>()
    for (const edge of graph.edges) {
      if (frontier.has(edge.from)) {
        downstream.add(edge.id)
        next.add(edge.to)
      }
    }
    frontier = next
  }
  frontier = new Set<string>([nodeId])
  for (let depth = 0; depth < 3 && frontier.size > 0; depth += 1) {
    const next = new Set<string>()
    for (const edge of graph.edges) {
      if (frontier.has(edge.to)) {
        upstream.add(edge.id)
        next.add(edge.from)
      }
    }
    frontier = next
  }
  return { upstream, downstream }
}

function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(px - x1, py - y1)
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

interface CanvasSurfaceProps {
  copy: PanelCopy
  side: PanelSide
  graph: CanvasGraphData
  layoutMode: CanvasLayoutMode
  centerId: string | null
}

function CanvasSurface(props: CanvasSurfaceProps): React.ReactElement {
  const copy = props.copy
  const muiTheme = useTheme()
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const frameRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  /** Transparent text overlay; only the WebGL path uses it. */
  const labelCanvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const positionsRef = React.useRef<Map<string, CanvasPoint>>(new Map())
  const viewportRef = React.useRef({ scale: 1, x: 0, y: 0 })
  const hoverRef = React.useRef<CanvasHover | null>(null)
  const dragRef = React.useRef<
    | { kind: 'node'; id: string; offsetX: number; offsetY: number }
    | { kind: 'pan'; startX: number; startY: number; originX: number; originY: number }
    | null
  >(null)
  const movedRef = React.useRef(false)
  const pressRef = React.useRef({ x: 0, y: 0 })
  const rippleRef = React.useRef<{ x: number; y: number; start: number } | null>(null)
  /** WebGL2 accelerator; `null` means the 2D renderer is in use. */
  const painterRef = React.useRef<WebGlCanvasPainter | null>(null)
  const paintRef = React.useRef<(time: number) => void>(() => {})
  const schedulePaintRef = React.useRef<(priority: Priority) => void>(() => {})
  /** True while the dash/pulse animation should keep requesting frames. */
  const animateRef = React.useRef(false)
  const lastPaintRef = React.useRef(0)
  /** Bumped when node positions change, so the label overlay knows to redraw. */
  const sceneRevisionRef = React.useRef(0)
  const labelKeyRef = React.useRef('')
  const webglBlockedRef = React.useRef(false)
  const [canvasEpoch, setCanvasEpoch] = React.useState(0)
  const [webglReady, setWebglReady] = React.useState(false)
  const [size, setSize] = React.useState({ width: 0, height: 0 })
  const [selectedEdge, setSelectedEdge] = React.useState<string | null>(null)
  const [selectedNode, setSelectedNode] = React.useState<string | null>(null)
  const [tooltip, setTooltip] = React.useState<{ left: number; top: number; lines: string[] } | null>(null)
  const [visible, setVisible] = React.useState(typeof document === 'undefined' ? true : !document.hidden)
  animateRef.current = !reducedMotion && visible && props.graph.edges.length > 0

  /** True once the user zooms/pans; later resizes then keep their viewport. */
  const userAdjustedRef = React.useRef(false)
  const lastCanvasViewRef = React.useRef<{
    graph: CanvasGraphData
    layoutMode: CanvasLayoutMode
    centerId: string | null
  } | null>(null)

  /**
   * One auto-fit path shared by data loads, panel resizes and the fit button:
   * centre the laid-out bounding box and clamp the zoom to [0.15, 1].
   */
  const fitViewport = (): void => {
    const bbox = canvasBBox(positionsRef.current)
    const width = size.width
    const height = size.height
    if (bbox === null || width <= 0 || height <= 0) {
      viewportRef.current = { scale: 1, x: 0, y: 0 }
      userAdjustedRef.current = false
      return
    }
    const scale = fitScale(bbox, { width, height }, CANVAS_FIT_PAD)
    viewportRef.current = {
      scale,
      x: width / 2 - ((bbox.minX + bbox.maxX) / 2) * scale,
      y: height / 2 - ((bbox.minY + bbox.maxY) / 2) * scale,
    }
    userAdjustedRef.current = false
  }

  /** The canvas element only mounts for a non-empty graph (see the JSX below). */
  const hasGraph = props.graph.nodes.length > 0

  React.useEffect(() => {
    const frame = frameRef.current
    if (frame === null) return
    const update = (): void => {
      setSize({ width: Math.max(1, frame.clientWidth), height: Math.max(1, frame.clientHeight) })
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(frame)
    return () => {
      observer.disconnect()
    }
    // The measured frame only mounts for a non-empty graph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasGraph])

  React.useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisibility = (): void => {
      setVisible(!document.hidden)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // One plugin-wide queue; this canvas owns a stable key so two canvases in the
  // two panels never merge each other's paint. The pump stops when both idle.
  const paintTaskKey = `canvas:paint:${React.useId()}`
  const paintPriorityRef = React.useRef<Priority>('high')
  React.useEffect(() => {
    const queue = getTaskQueue()
    return () => {
      queue.cancel(paintTaskKey)
    }
  }, [paintTaskKey])

  schedulePaintRef.current = (priority: Priority): void => {
    // Remember the highest request since the last paint even when the queue
    // merges the schedule into an already-pending entry.
    if (PRIORITY_RANK[priority] > PRIORITY_RANK[paintPriorityRef.current]) {
      paintPriorityRef.current = priority
    }
    getTaskQueue().schedule(priority, paintTaskKey, () => {
      const effective = paintPriorityRef.current
      paintPriorityRef.current = 'high'
      const time = renderNow()
      // Interaction feedback paints immediately; dashboard-style animation is
      // capped at ~30 fps so the label overlay never runs twice per display
      // frame for a purely decorative dash phase.
      const interactive = effective === 'high'
      if (interactive || time - lastPaintRef.current >= CANVAS_ANIMATION_INTERVAL_MS) {
        lastPaintRef.current = time
        paintRef.current(time)
      }
      // The dash/pulse animation and an unexpired click ripple keep the pump
      // alive; every other change is a one-shot paint.
      if (animateRef.current || rippleRef.current !== null) {
        schedulePaintRef.current('medium')
      }
    })
  }

  /** Request one paint at a queue priority (interaction feedback by default). */
  const requestPaint = (priority: Priority = 'high'): void => {
    schedulePaintRef.current(priority)
  }

  // WebGL2 accelerator, created once per canvas element. A setup failure
  // remounts the element (one canvas can only ever own one context kind) and
  // falls back to the 2D renderer; a browser without WebGL2 keeps the element.
  React.useEffect(() => {
    if (webglBlockedRef.current) {
      // A remounted canvas after a WebGL failure: paint the 2D fallback.
      schedulePaintRef.current('high')
      return
    }
    const canvas = canvasRef.current
    if (canvas === null) return
    let painter: WebGlCanvasPainter | null = null
    try {
      painter = createWebGlCanvasPainter(canvas)
    } catch {
      webglBlockedRef.current = true
      setCanvasEpoch((value) => value + 1)
      return
    }
    if (painter === null) return
    painterRef.current = painter
    painter.setScene(props.graph, positionsRef.current)
    labelKeyRef.current = ''
    setWebglReady(true)
    schedulePaintRef.current('high')
    return () => {
      painterRef.current = null
      setWebglReady(false)
      painter.dispose()
    }
    // A new epoch means a fresh canvas element; hasGraph mounts/unmounts it.
    // The scene is re-seeded from the refs above, so props.graph must not
    // re-create the painter on every graph change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasEpoch, hasGraph])

  React.useEffect(() => {
    const previous = lastCanvasViewRef.current
    const viewChanged = previous === null
      || previous.graph !== props.graph
      || previous.layoutMode !== props.layoutMode
      || previous.centerId !== props.centerId
    lastCanvasViewRef.current = {
      graph: props.graph,
      layoutMode: props.layoutMode,
      centerId: props.centerId,
    }
    positionsRef.current = layoutCanvasGraph(
      props.graph,
      size.width,
      size.height,
      props.layoutMode,
      props.centerId,
    )
    if (viewChanged) {
      userAdjustedRef.current = false
      hoverRef.current = null
      setTooltip(null)
      setSelectedEdge(null)
      setSelectedNode(null)
    }
    // A fresh data load/view refits unconditionally; a resize refits only
    // while the user has not manually zoomed or panned.
    if (viewChanged || !userAdjustedRef.current) fitViewport()
    painterRef.current?.setScene(props.graph, positionsRef.current)
    sceneRevisionRef.current += 1
    requestPaint('low')
  }, [props.graph, props.layoutMode, props.centerId, size.width, size.height])

  const palette = muiTheme.palette

  const relationColor = (relation: CanvasRelation): string => {
    if (relation === 'imports' || relation === 'part_of') return palette.secondary.main
    if (relation === 'exports') return palette.success.main
    return palette.primary.main
  }

  const relationText = (relation: CanvasRelation): string => canvasRelationLabel(relation, copy)

  const edgeLabel = (edge: CanvasEdge): string => {
    const suffix = edge.cyclic ? ` · ${copy.cyclic}` : ''
    return `${edge.from} → ${edge.to} · ${relationText(edge.relation)}${suffix}`
  }

  /**
   * The collapsed text alternative is up to 500 rows; rebuilding those React
   * elements on every hover/tooltip render would dominate the frame. Its
   * elements only change with the graph or the copy locale.
   */
  const graphTextRows = React.useMemo(() => {
    const rows: React.ReactNode[] = []
    props.graph.edges.slice(0, 300).forEach((edge, index) => {
      rows.push(h(
        MuiTypography,
        { key: `edge:${edge.id}#${index}`, variant: 'caption', component: 'div', sx: MONO_SX },
        edgeLabel(edge),
      ))
    })
    props.graph.nodes.slice(0, CANVAS_MAX_NODES).forEach((node) => {
      rows.push(h(
        MuiTypography,
        { key: `node:${node.id}`, variant: 'caption', component: 'div', sx: MONO_SX },
        node.label === node.path ? node.path : `${node.label} · ${node.path}`,
      ))
    })
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.graph, copy])

  /**
   * The one paint entry point.
   *
   * WebGL2 draws the heavy geometry (edges, arrowheads, nodes) and the 2D
   * overlay draws only labels and the click ripple. A browser without WebGL2
   * falls through to the original 2D renderer below, unchanged.
   */
  paintRef.current = (time: number): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const width = size.width
    const height = size.height
    if (width <= 0 || height <= 0) return
    const dpr = Math.max(1, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)

    const viewport = viewportRef.current
    const positions = positionsRef.current
    const hovered = hoverRef.current
    const trace = hovered !== null && hovered.kind === 'node'
      ? traceCanvasEdges(props.graph, hovered.id)
      : null
    // Nodes touched by the hovered node's depth-3 upstream/downstream path:
    // their labels stay visible at every zoom so the trace remains readable.
    const tracedNodes = new Set<string>()
    if (trace !== null) {
      for (const edge of props.graph.edges) {
        if (trace.upstream.has(edge.id) || trace.downstream.has(edge.id)) {
          tracedNodes.add(edge.from)
          tracedNodes.add(edge.to)
        }
      }
    }
    const seconds = time / 1000
    const frameOffset = time / (1000 / 60)
    // Semantic zoom: the viewport transform scales node *positions* and edge
    // lengths, but marks stay readable at a constant screen size. Every mark
    // (stroke width, node radius, label font, arrowhead, ripple) is therefore
    // counter-scaled by the zoom factor.
    const inverseScale = 1 / viewport.scale
    // Below the low-detail threshold the per-edge arrowheads and thicker
    // strokes are pure overdraw: one screen pixel per edge, no arrowheads.
    const lowDetail = viewport.scale < CANVAS_LOW_DETAIL_SCALE

    const painter = painterRef.current
    if (painter !== null) {
      try {
        painter.resize(width, height, dpr)
        painter.draw({
          hover: hovered,
          selectedEdge,
          selectedNode,
          trace,
          tracedNodes,
          viewport,
          palette: {
            primary: palette.primary.main,
            secondary: palette.secondary.main,
            success: palette.success.main,
            warning: palette.warning.main,
            paper: palette.background.paper,
            text: palette.text.secondary,
          },
          time,
          reducedMotion,
          lowDetail,
        })
      } catch {
        // A runtime GPU/driver failure must not leave a blank canvas: retire
        // the WebGL element and remount it for the 2D fallback.
        webglBlockedRef.current = true
        painterRef.current = null
        painter.dispose()
        setCanvasEpoch((value) => value + 1)
        return
      }
      const overlay = labelCanvasRef.current
      if (overlay !== null) {
        // Text-shaping is the one non-GPU cost: only redraw when something the
        // labels depend on changed. A pure dash/pulse frame therefore touches
        // no 2D context at all.
        const labelKey = [
          String(width), String(height), String(dpr),
          String(viewport.scale), String(viewport.x), String(viewport.y),
          hovered === null ? '' : `${hovered.kind}:${hovered.id}`,
          selectedEdge ?? '', selectedNode ?? '',
          String(tracedNodes.size), String(sceneRevisionRef.current),
          palette.text.secondary, palette.primary.main,
          rippleRef.current === null ? '0' : '1',
        ].join('|')
        if (rippleRef.current !== null || labelKey !== labelKeyRef.current) {
          labelKeyRef.current = labelKey
          paintCanvasLabels(overlay, {
            graph: props.graph,
            positions,
            viewport,
            hover: hovered,
            selectedEdge,
            selectedNode,
            tracedNodes,
            textColor: palette.text.secondary,
            primaryColor: palette.primary.main,
            width,
            height,
            dpr,
            time,
            ripple: rippleRef.current,
          })
        }
      }
      if (rippleRef.current !== null && time - rippleRef.current.start >= 300) {
        rippleRef.current = null
      }
      return
    }

    // ---- 2D fallback: the complete original renderer, used when WebGL2 is
    // unavailable or its setup failed. ----
    const context = canvas.getContext('2d')
    if (context === null) return
    const pixelWidth = Math.max(1, Math.round(width * dpr))
    const pixelHeight = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)

    context.save()
    context.translate(viewport.x, viewport.y)
    context.scale(viewport.scale, viewport.scale)
    context.lineCap = 'round'

    props.graph.edges.forEach((edge, index) => {
      const from = positions.get(edge.from)
      const to = positions.get(edge.to)
      if (from === undefined || to === undefined) return
      const isSelected = selectedEdge === edge.id
      const isHovered = hovered !== null && hovered.kind === 'edge' && hovered.id === edge.id
      const isUpstream = trace !== null && trace.upstream.has(edge.id)
      const isDownstream = trace !== null && trace.downstream.has(edge.id)
      const isTraced = isUpstream || isDownstream

      let alpha = 1
      if (selectedEdge !== null) alpha = isSelected ? 1 : 0.15
      else if (isHovered) alpha = 1
      else if (hovered !== null && hovered.kind === 'edge') alpha = 0.35
      else if (trace !== null) alpha = isTraced ? 1 : 0.15
      if (edge.cyclic && !reducedMotion && !isSelected) {
        alpha *= 0.55 + 0.45 * (0.5 + 0.5 * Math.sin((seconds / 1.6) * Math.PI * 2))
      }

      let color = relationColor(edge.relation)
      if (edge.cyclic) color = palette.warning.main
      if (isUpstream && !edge.cyclic) color = '#26c6da'
      else if (isDownstream && !edge.cyclic) color = palette.primary.main

      const lineWidth = lowDetail
        ? inverseScale
        : (isSelected ? 2.5 : isHovered ? 3 : 1.2) * inverseScale
      context.save()
      context.globalAlpha = alpha
      context.strokeStyle = color
      context.fillStyle = color
      context.lineWidth = lineWidth
      if (edge.cyclic || isHovered) {
        context.shadowColor = color
        context.shadowBlur = isHovered ? 6 : 8
      }
      if (isSelected) {
        context.setLineDash([])
        context.lineDashOffset = 0
      } else {
        const length = Math.hypot(to.x - from.x, to.y - from.y)
        const speed = (1.5 + 1.5 * Math.min(1, 160 / Math.max(length, 40))) * (isHovered ? 2 : 1)
        context.setLineDash([6 * inverseScale, 6 * inverseScale])
        context.lineDashOffset = reducedMotion || index >= CANVAS_FLOW_EDGES
          ? 0
          : -(((frameOffset * speed) % 12) * inverseScale)
      }
      context.beginPath()
      context.moveTo(from.x, from.y)
      context.lineTo(to.x, to.y)
      context.stroke()

      // Direction arrow, tied to the from → to order. The gap and head keep a
      // constant screen size, so the arrow never sinks under a zoomed node.
      // At low zoom the heads are skipped entirely to cut overdraw.
      if (!lowDetail) {
        const angle = Math.atan2(to.y - from.y, to.x - from.x)
        const arrowGap = (CANVAS_NODE_RADIUS + 4) * inverseScale
        const arrowLength = 7 * inverseScale
        const arrowX = to.x - Math.cos(angle) * arrowGap
        const arrowY = to.y - Math.sin(angle) * arrowGap
        context.beginPath()
        context.moveTo(arrowX, arrowY)
        context.lineTo(arrowX - Math.cos(angle - 0.45) * arrowLength, arrowY - Math.sin(angle - 0.45) * arrowLength)
        context.lineTo(arrowX - Math.cos(angle + 0.45) * arrowLength, arrowY - Math.sin(angle + 0.45) * arrowLength)
        context.closePath()
        context.fill()
      }

      if (isSelected) {
        context.beginPath()
        context.arc(from.x, from.y, 3.5 * inverseScale, 0, Math.PI * 2)
        context.arc(to.x, to.y, 3.5 * inverseScale, 0, Math.PI * 2)
        context.fill()
      }
      context.restore()
    })

    props.graph.nodes.forEach((node) => {
      const point = positions.get(node.id)
      if (point === undefined) return
      const isHovered = hovered !== null && hovered.kind === 'node' && hovered.id === node.id
      const isSelected = selectedNode === node.id
      const onTrace = tracedNodes.has(node.id)
      const active = isHovered || isSelected || onTrace
      const radius = (isHovered ? CANVAS_NODE_RADIUS + 3 : CANVAS_NODE_RADIUS) * inverseScale
      let alpha = 1
      if (selectedEdge !== null) alpha = 0.4
      else if (trace !== null && hovered !== null && hovered.kind === 'node' && !isHovered) {
        alpha = onTrace ? 0.75 : 0.35
      }
      context.save()
      context.globalAlpha = alpha
      if (!shouldDrawLabel(viewport.scale, active)) {
        // Dense zoom: an inactive node is a solid status dot, no outline/text.
        // The radius still counter-scales, so the dot stays 7 screen pixels.
        context.beginPath()
        context.arc(point.x, point.y, radius, 0, Math.PI * 2)
        context.fillStyle = palette.primary.main
        context.fill()
        context.restore()
        return
      }
      context.beginPath()
      context.arc(point.x, point.y, radius, 0, Math.PI * 2)
      context.fillStyle = isSelected || isHovered ? palette.primary.main : palette.background.paper
      context.fill()
      context.lineWidth = (isSelected ? 2 : 1.2) * inverseScale
      context.strokeStyle = palette.primary.main
      context.stroke()
      context.fillStyle = palette.text.secondary
      context.font = `${10 * inverseScale}px ui-sans-serif, system-ui, sans-serif`
      const label = node.label.length > 28 ? `…${node.label.slice(-27)}` : node.label
      context.fillText(label, point.x + 11 * inverseScale, point.y + 3 * inverseScale)
      context.restore()
    })

    const ripple = rippleRef.current
    if (ripple !== null) {
      const age = time - ripple.start
      if (age < 300) {
        context.save()
        context.globalAlpha = Math.max(0, 1 - age / 300)
        context.strokeStyle = palette.primary.main
        context.lineWidth = 2 * inverseScale
        context.beginPath()
        context.arc(ripple.x, ripple.y, 24 * (age / 300) * inverseScale, 0, Math.PI * 2)
        context.stroke()
        context.restore()
      } else {
        rippleRef.current = null
      }
    }
    context.restore()
  }

  // The scheduler owns the frame loop: a visibility or animation-mode change
  // only kicks one paint. `animateRef` is refreshed on every render, and the
  // paint task requeues itself while the animation/ripple is active.
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    requestPaint(visible ? 'medium' : 'low')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reducedMotion, props.graph, size.width, size.height])

  const worldOf = (clientX: number, clientY: number): CanvasPoint => {
    const canvas = canvasRef.current
    if (canvas === null) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const viewport = viewportRef.current
    return {
      x: (clientX - rect.left - viewport.x) / viewport.scale,
      y: (clientY - rect.top - viewport.y) / viewport.scale,
    }
  }

  /** One traversal per frame; edges win over nodes when both are in range. */
  const hitTest = (point: CanvasPoint): CanvasHover | null => {
    const scale = viewportRef.current.scale
    const edgeLimit = CANVAS_EDGE_SLOP / scale
    const positions = positionsRef.current
    for (const edge of props.graph.edges) {
      const from = positions.get(edge.from)
      const to = positions.get(edge.to)
      if (from === undefined || to === undefined) continue
      if (distanceToSegment(point.x, point.y, from.x, from.y, to.x, to.y) <= edgeLimit) {
        return { kind: 'edge', id: edge.id }
      }
    }
    const nodeLimit = (CANVAS_NODE_RADIUS + CANVAS_NODE_SLOP) / scale
    for (const node of props.graph.nodes) {
      const position = positions.get(node.id)
      if (position === undefined) continue
      if (Math.hypot(point.x - position.x, point.y - position.y) <= nodeLimit) {
        return { kind: 'node', id: node.id }
      }
    }
    return null
  }

  const tooltipLines = (target: CanvasHover): string[] => {
    if (target.kind === 'node') {
      const node = props.graph.nodes.find((entry) => entry.id === target.id)
      if (node === undefined) return [target.id]
      return node.label === node.path ? [node.path] : [node.label, node.path]
    }
    const edge = props.graph.edges.find((entry) => entry.id === target.id)
    if (edge === undefined) return []
    const relation = relationText(edge.relation)
    return [
      `${edge.from} → ${edge.to}`,
      `${relation}${edge.cyclic ? ` · ${copy.cyclic}` : ''}`,
    ]
  }

  const updateHover = (target: CanvasHover | null, clientX: number, clientY: number): void => {
    const previous = hoverRef.current
    if ((previous === null && target !== null)
      || (previous !== null && target === null)
      || (previous !== null && target !== null && (previous.kind !== target.kind || previous.id !== target.id))) {
      hoverRef.current = target
    }
    if (target === null) {
      setTooltip(null)
      return
    }
    const frame = frameRef.current
    if (frame === null) return
    const rect = frame.getBoundingClientRect()
    const width = 260
    const height = 54
    let left = clientX - rect.left + 12
    let top = clientY - rect.top + 12
    if (left + width > rect.width) left = Math.max(4, rect.width - width)
    if (top + height > rect.height) top = Math.max(4, rect.height - height)
    setTooltip({ left, top, lines: tooltipLines(target) })
  }

  const zoomAt = (nextScale: number, screenX: number, screenY: number): void => {
    const viewport = viewportRef.current
    const scale = Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, nextScale))
    viewport.x = screenX - (screenX - viewport.x) * (scale / viewport.scale)
    viewport.y = screenY - (screenY - viewport.y) * (scale / viewport.scale)
    viewport.scale = scale
    // Wheel and +/- are manual zooms: stop auto-fit from overriding them on
    // the next resize. A data/view change clears this flag again.
    userAdjustedRef.current = true
    requestPaint()
  }
  const zoomAtRef = React.useRef(zoomAt)
  zoomAtRef.current = zoomAt

  // React's synthetic wheel listener is passive; a native non-passive one keeps
  // the page behind the panel from scrolling while the canvas zooms.
  React.useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
      zoomAtRef.current(
        viewportRef.current.scale * factor,
        event.clientX - rect.left,
        event.clientY - rect.top,
      )
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', onWheel)
    }
    // A remounted canvas (WebGL fallback) is a new DOM node with no listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.graph, canvasEpoch])

  const resetLayout = (): void => {
    positionsRef.current = layoutCanvasGraph(
      props.graph,
      size.width,
      size.height,
      props.layoutMode,
      props.centerId,
    )
    fitViewport()
    painterRef.current?.setScene(props.graph, positionsRef.current)
    sceneRevisionRef.current += 1
    requestPaint('low')
  }

  const selected = selectedEdge === null
    ? null
    : props.graph.edges.find((edge) => edge.id === selectedEdge) ?? null

  const selectEdge = (edgeId: string | null): void => {
    setSelectedEdge(edgeId)
    setSelectedNode(null)
    requestPaint()
  }

  const control = (label: string, icon: Loose, onClick: () => void): React.ReactElement =>
    h(
      Tip,
      { label },
      h(
        MuiIconButton,
        { size: 'small', 'aria-label': label, onClick },
        h(icon, { fontSize: 'small' }),
      ),
    )

  const empty = !hasGraph

  return h(
    MuiBox,
    { sx: CANVAS_STACK_SX },
    props.graph.truncated
      ? h(
        MuiAlert,
        { severity: 'info', sx: TRUNCATED_SX },
        fillTemplate(copy.graphTruncated, { count: String(props.graph.nodes.length) }),
      )
      : null,
    empty
      ? h(EmptyState, { message: copy.graphEmpty })
      : h(
        MuiBox,
        { sx: CANVAS_FRAME_SX, ref: frameRef },
        h(
          'canvas',
          {
            key: canvasEpoch,
            ref: canvasRef,
            tabIndex: 0,
            role: 'application',
            'aria-label': copy.zoomHint,
            style: CANVAS_SX,
            onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>): void => {
              const point = worldOf(event.clientX, event.clientY)
              const hit = hitTest(point)
              movedRef.current = false
              pressRef.current = { x: event.clientX, y: event.clientY }
              event.currentTarget.focus()
              event.currentTarget.setPointerCapture(event.pointerId)
              if (!reducedMotion) rippleRef.current = { x: point.x, y: point.y, start: performance.now() }
              if (hit !== null && hit.kind === 'node') {
                const position = positionsRef.current.get(hit.id)
                dragRef.current = position === undefined
                  ? null
                  : { kind: 'node', id: hit.id, offsetX: point.x - position.x, offsetY: point.y - position.y }
                selectEdge(null)
                setSelectedNode(hit.id)
              } else {
                const viewport = viewportRef.current
                dragRef.current = {
                  kind: 'pan',
                  startX: event.clientX,
                  startY: event.clientY,
                  originX: viewport.x,
                  originY: viewport.y,
                }
              }
              requestPaint()
            },
            onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>): void => {
              const drag = dragRef.current
              if (drag !== null) {
                if (Math.hypot(event.clientX - pressRef.current.x, event.clientY - pressRef.current.y) > 4) {
                  movedRef.current = true
                }
                if (drag.kind === 'node') {
                  const point = worldOf(event.clientX, event.clientY)
                  const position = positionsRef.current.get(drag.id)
                  if (position !== undefined) {
                    position.x = point.x - drag.offsetX
                    position.y = point.y - drag.offsetY
                    // The GPU scene holds the endpoint/centre buffers: a moved
                    // node must update them before the paint runs.
                    painterRef.current?.setScene(props.graph, positionsRef.current)
                    sceneRevisionRef.current += 1
                  }
                } else {
                  const viewport = viewportRef.current
                  viewport.x = drag.originX + (event.clientX - drag.startX)
                  viewport.y = drag.originY + (event.clientY - drag.startY)
                  userAdjustedRef.current = true
                }
                requestPaint()
                return
              }
              const hit = hitTest(worldOf(event.clientX, event.clientY))
              updateHover(hit, event.clientX, event.clientY)
              const canvas = event.currentTarget
              canvas.style.cursor = hit === null ? 'grab' : 'pointer'
              requestPaint()
            },
            onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>): void => {
              const drag = dragRef.current
              dragRef.current = null
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
              if (movedRef.current) return
              const hit = hitTest(worldOf(event.clientX, event.clientY))
              if (hit !== null && hit.kind === 'edge') {
                selectEdge(selectedEdge === hit.id ? null : hit.id)
                return
              }
              if (hit !== null && hit.kind === 'node') {
                const node = props.graph.nodes.find((entry) => entry.id === hit.id)
                if (node !== undefined) navigate(props.side, 'files', { path: node.path })
                return
              }
              if (drag === null || drag.kind !== 'node') {
                setSelectedEdge(null)
                setSelectedNode(null)
                requestPaint()
              }
            },
            onPointerLeave: (): void => {
              if (dragRef.current !== null) return
              updateHover(null, 0, 0)
              requestPaint()
            },
            onDoubleClick: (event: React.MouseEvent<HTMLCanvasElement>): void => {
              const hit = hitTest(worldOf(event.clientX, event.clientY))
              if (hit === null || hit.kind !== 'edge') return
              const edge = props.graph.edges.find((entry) => entry.id === hit.id)
              if (edge !== undefined) navigate(props.side, 'files', { path: edge.from })
            },
            onKeyDown: (event: React.KeyboardEvent<HTMLCanvasElement>): void => {
              const nodes = props.graph.nodes
              if (event.key === 'Tab' && nodes.length > 0) {
                event.preventDefault()
                const current = selectedNode === null
                  ? -1
                  : nodes.findIndex((node) => node.id === selectedNode)
                const direction = event.shiftKey ? -1 : 1
                const next = (current + direction + nodes.length) % nodes.length
                setSelectedNode(nodes[next].id)
                setSelectedEdge(null)
                requestPaint()
                return
              }
              if (event.key === 'Enter' && selectedNode !== null) {
                event.preventDefault()
                setSelectedEdge(null)
                requestPaint()
                return
              }
              if (event.key === 'Escape') {
                if (selectedEdge !== null || selectedNode !== null) {
                  event.stopPropagation()
                  setSelectedEdge(null)
                  setSelectedNode(null)
                  setTooltip(null)
                  requestPaint()
                }
              }
            },
          },
        ),
        h('canvas', {
          ref: labelCanvasRef,
          'aria-hidden': true,
          tabIndex: -1,
          style: { ...CANVAS_LABEL_SX, display: webglReady ? 'block' : 'none' },
        }),
        h(
          MuiBox,
          { sx: CANVAS_CONTROLS_SX },
          control(copy.tip.zoomIn, IconZoomIn, () => {
            zoomAt(viewportRef.current.scale * 1.2, size.width / 2, size.height / 2)
          }),
          control(copy.tip.zoomOut, IconZoomOut, () => {
            zoomAt(viewportRef.current.scale / 1.2, size.width / 2, size.height / 2)
          }),
          control(copy.tip.fit, IconFit, () => {
            fitViewport()
            requestPaint()
          }),
          control(copy.tip.resetLayout, IconResetLayout, resetLayout),
        ),
        tooltip === null
          ? null
          : h(
            MuiPaper,
            { elevation: 6, sx: { ...CANVAS_TOOLTIP_SX, left: tooltip.left, top: tooltip.top } },
            ...tooltip.lines.map((line, index) =>
              h(
                MuiTypography,
                { key: index, variant: 'caption', component: 'div', sx: MONO_SX },
                line,
              ),
            ),
          ),
      ),
    !empty
      ? h(
        MuiAccordion,
        { disableGutters: true, sx: GRAPH_TEXT_SX },
        h(
          MuiAccordionSummary,
          { expandIcon: h(IconExpand, { fontSize: 'small' }), sx: GRAPH_TEXT_SUMMARY_SX },
          h(MuiTypography, { variant: 'caption', color: 'text.secondary' }, copy.graphText),
        ),
        h(
          MuiAccordionDetails,
          { sx: GRAPH_TEXT_DETAILS_SX },
          ...graphTextRows,
        ),
      )
      : null,
    h(
      MuiBox,
      { sx: GRAPH_STATUS_SX, 'aria-live': 'polite' },
      h(
        MuiTypography,
        {
          variant: 'caption',
          color: 'text.secondary',
          noWrap: true,
          title: selected === null ? copy.zoomHint : edgeLabel(selected),
        },
        selected === null ? copy.zoomHint : edgeLabel(selected),
      ),
    ),
  )
}

function DependenciesCanvasView(props: ViewProps): React.ReactElement {
  const hasPath = props.path !== null
  const graphPath = hasPath
    ? `/graph/dependencies?path=${encodeURIComponent(props.path ?? '')}&level=intra`
    : '/graph/dependencies'
  const deps = useGraph(graphPath, parseDependencies, props.refresh, props.onSettled)
  // The intra route carries symbol names/depths; `level=intra` carries cycles.
  const intra = useGraph(
    hasPath ? `/graph/intra?path=${encodeURIComponent(props.path ?? '')}` : null,
    parseIntra,
    props.refresh,
  )
  const graph = React.useMemo(() => {
    if (deps.state.status !== 'ready') return null
    if (hasPath && intra.state.status === 'ready') {
      return buildIntraCanvas(intra.state.value, deps.state.value)
    }
    return buildDependencyCanvas(deps.state.value)
  }, [deps.state, intra.state, hasPath])
  if (deps.state.status === 'loading' || deps.state.status === 'idle') {
    return h(LoadingState, { copy: props.copy })
  }
  if (deps.state.status === 'error') {
    return h(ErrorState, {
      copy: props.copy,
      onRetry: (): void => {
        deps.retry()
        intra.retry()
      },
    })
  }
  if (hasPath && (intra.state.status === 'loading' || intra.state.status === 'idle')) {
    return h(LoadingState, { copy: props.copy })
  }
  if (graph === null) return h(LoadingState, { copy: props.copy })
  return h(CanvasSurface, {
    copy: props.copy,
    side: props.side,
    graph,
    layoutMode: hasPath ? 'layered' : 'ring',
    centerId: null,
  })
}

function ImportsCanvasView(props: ViewProps): React.ReactElement {
  const { state, retry } = useGraph(withPath('/graph/imports', props.path), parseImports, props.refresh, props.onSettled)
  const graph = React.useMemo(
    () => (state.status === 'ready' ? buildImportsCanvas(state.value, 'imports') : null),
    [state],
  )
  if (state.status === 'loading' || state.status === 'idle') {
    return h(LoadingState, { copy: props.copy })
  }
  if (state.status === 'error') return h(ErrorState, { copy: props.copy, onRetry: retry })
  if (graph === null) return h(LoadingState, { copy: props.copy })
  return h(CanvasSurface, {
    copy: props.copy,
    side: props.side,
    graph,
    layoutMode: props.path === null ? 'ring' : 'star',
    centerId: props.path,
  })
}

function ExportsCanvasView(props: ViewProps): React.ReactElement {
  const { state, retry } = useGraph(withPath('/graph/imports', props.path), parseImports, props.refresh, props.onSettled)
  const graph = React.useMemo(
    () => (state.status === 'ready' ? buildImportsCanvas(state.value, 'exports') : null),
    [state],
  )
  if (state.status === 'loading' || state.status === 'idle') {
    return h(LoadingState, { copy: props.copy })
  }
  if (state.status === 'error') return h(ErrorState, { copy: props.copy, onRetry: retry })
  if (graph === null) return h(LoadingState, { copy: props.copy })
  return h(CanvasSurface, {
    copy: props.copy,
    side: props.side,
    graph,
    layoutMode: props.path === null ? 'ring' : 'star',
    centerId: props.path,
  })
}

/* ------------------------------------------------------------------------- *
 * Left-panel agents
 * ------------------------------------------------------------------------- */

function StatusPulse(props: { enabled: boolean }): React.ReactElement {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [on, setOn] = React.useState(true)
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    if (!props.enabled || reducedMotion) {
      setOn(true)
      return
    }
    const timer = window.setInterval(() => {
      setOn((previous) => !previous)
    }, 700)
    return () => {
      window.clearInterval(timer)
    }
  }, [props.enabled, reducedMotion])
  const dot = h('span', {
    style: {
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: '50%',
      backgroundColor: theme.palette.success.main,
    },
  })
  if (!props.enabled || reducedMotion) return dot
  return h(MuiFade, { in: on, timeout: 300 }, dot)
}

function AgentStatusChip(props: { copy: PanelCopy; status: string }): React.ReactElement {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const running = props.status === 'running'
  return h(
    MuiFade,
    { key: props.status, in: true, appear: true, timeout: reducedMotion ? 0 : 180 },
    h(
      'span',
      { style: { display: 'inline-flex' } },
      h(
        Tip,
        { label: props.copy.tip.agentStatus },
        h(MuiChip, {
          size: 'small',
          color: running ? 'success' : 'default',
          label: running ? props.copy.agentRunning : props.copy.agentInactive,
          icon: running ? h(StatusPulse, { enabled: true }) : undefined,
        }),
      ),
    ),
  )
}

function AgentProgressRing(props: {
  copy: PanelCopy
  agent: AgentInfoData
  reducedMotion: boolean
}): React.ReactElement {
  const unknown = props.agent.progress.basis === 'unknown'
  const value = unknown ? 0 : props.agent.progress.value
  const color = unknown || props.agent.status === 'inactive'
    ? 'inherit'
    : props.agent.status === 'completed'
      ? 'success'
      : 'primary'
  const basis = unknown
    ? props.copy.progressBasisUnknown
    : props.agent.progress.basis === 'completed'
      ? props.copy.progressBasisCompleted
      : props.copy.progressBasisTurns
  const label = unknown
    ? basis
    : `${fillTemplate(props.copy.progress, { value: String(value) })} · ${basis}`
  return h(
    Tip,
    { label },
    h(
      MuiBox,
      { sx: AGENT_RING_SX },
      h(MuiCircularProgress, {
        variant: 'determinate',
        value,
        size: 28,
        thickness: 4,
        color,
        sx: {
          ...(unknown || props.agent.status === 'inactive' ? { color: 'text.disabled' } : {}),
          '& .MuiCircularProgress-circle': {
            transition: props.reducedMotion ? 'none' : 'stroke-dashoffset 400ms',
          },
        },
      }),
      h(
        MuiBox,
        { sx: AGENT_RING_VALUE_SX },
        h(
          MuiTypography,
          { variant: 'caption', sx: { fontSize: 9, lineHeight: 1, color: unknown ? 'text.disabled' : 'text.secondary' } },
          unknown ? '—' : `${value}%`,
        ),
      ),
    ),
  )
}

function agentInitial(label: string): string {
  const trimmed = label.trim()
  if (trimmed.length === 0) return '?'
  const first = Array.from(trimmed)[0] ?? '?'
  return first.toUpperCase()
}

function AgentsView(props: ViewProps): React.ReactElement {
  const { state, retry } = useGraph('/graph/agents', parseAgents, props.refresh, props.onSettled)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set())

  if (state.status === 'loading' || state.status === 'idle') {
    return h(
      MuiBox,
      { sx: AGENTS_VIEW_SX },
      ...Array.from({ length: 4 }, (_entry, index) =>
        h(
          MuiBox,
          { key: index, sx: AGENT_SKELETON_ROW_SX },
          h(MuiSkeleton, { variant: 'circular', width: 28, height: 28 }),
          h(
            MuiBox,
            { sx: { flex: 1, minWidth: 0 } },
            h(MuiSkeleton, { variant: 'text', width: '45%' }),
            h(MuiSkeleton, { variant: 'text', width: '75%' }),
          ),
        ),
      ),
    )
  }
  if (state.status === 'error') return h(ErrorState, { copy: props.copy, onRetry: retry })
  if (state.value.agents.length === 0) return h(EmptyState, { message: props.copy.agentEmpty })

  const agents = state.value.agents
  const known = new Set(agents.map((agent) => agent.id))
  const childrenOf = new Map<string, AgentInfoData[]>()
  for (const agent of agents) {
    if (agent.parentId === null || !known.has(agent.parentId)) continue
    const list = childrenOf.get(agent.parentId)
    if (list === undefined) childrenOf.set(agent.parentId, [agent])
    else list.push(agent)
  }
  const roots = agents.filter((agent) => agent.parentId === null || !known.has(agent.parentId))
  const toggle = (id: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const row = (agent: AgentInfoData, child: boolean): React.ReactElement => {
    const children = child ? [] : childrenOf.get(agent.id) ?? []
    const expanded = !collapsed.has(agent.id)
    return h(
      MuiListItem,
      { disablePadding: true, sx: child ? AGENT_CHILD_SX : undefined },
      h(
        MuiListItemButton,
        {
          sx: AGENT_BUTTON_SX,
          role: 'option',
          'aria-selected': false,
          onClick: (): void => {
            navigate(props.side, 'agent', { id: agent.id })
          },
        },
        h(
          Tip,
          { label: props.copy.tip.agentStatus },
          h(
            MuiAvatar,
            {
              sx: {
                width: 28,
                height: 28,
                fontSize: 12,
                backgroundColor: agent.status === 'running' || agent.status === 'completed'
                  ? 'success.main'
                  : 'grey.500',
              },
            },
            agentInitial(agent.label),
          ),
        ),
        h(
          MuiBox,
          { sx: AGENT_TEXT_SX },
          h(MuiTypography, { variant: 'body2', noWrap: true }, agent.label),
          h(
            MuiTypography,
            { variant: 'caption', color: 'text.secondary', noWrap: true, sx: AGENT_OBJECTIVE_SX },
            agent.objective.length > 0 ? agent.objective : props.copy.agentObjectiveEmpty,
          ),
        ),
        h(AgentProgressRing, { copy: props.copy, agent, reducedMotion }),
        h(
          MuiBox,
          { sx: AGENT_CHIP_WRAP_SX },
          h(AgentStatusChip, { copy: props.copy, status: agent.status }),
        ),
      ),
      children.length === 0
        ? null
        : h(
          Tip,
          { label: expanded ? props.copy.tip.agentCollapse : props.copy.tip.agentExpand },
          h(
            MuiIconButton,
            {
              size: 'small',
              sx: AGENT_EXPAND_SX,
              'aria-label': expanded ? props.copy.tip.agentCollapse : props.copy.tip.agentExpand,
              onClick: (event: React.MouseEvent<HTMLButtonElement>): void => {
                event.stopPropagation()
                toggle(agent.id)
              },
            },
            h(expanded ? IconExpand : IconChevron, { fontSize: 'small' }),
          ),
        ),
    )
  }

  const flatRows: Array<{ agent: AgentInfoData; child: boolean }> = []
  for (const root of roots) {
    flatRows.push({ agent: root, child: false })
    if (collapsed.has(root.id)) continue
    for (const child of childrenOf.get(root.id) ?? []) flatRows.push({ agent: child, child: true })
  }

  const total = state.value.progress
  const totalUnknown = total.basis === 'unknown'
  const totalText = [
    totalUnknown ? '—' : `${total.value}%`,
    fillTemplate(props.copy.runningCount, {
      running: String(total.running),
      total: String(total.total),
    }),
    props.copy.estimated,
  ].join(' · ')

  return h(
    MuiBox,
    { sx: AGENTS_VIEW_SX },
    h(
      MuiBox,
      { sx: AGENTS_LIST_SX },
      h(VirtualList<{ agent: AgentInfoData; child: boolean }>, {
        adapter: createVirtualListAdapter(flatRows, (value) => `${value.agent.id}:${value.child ? 'child' : 'root'}`),
        'aria-label': props.copy.agents,
        slot: (_index, value) => h(
          MuiBox,
          { sx: { height: '100%' } },
          row(value.agent, value.child),
        ),
      }),
    ),
    h(
      MuiBox,
      { sx: AGENTS_FOOTER_SX },
      h(
        Tip,
        { label: props.copy.tip.progressTotal },
        h(
          MuiBox,
          { sx: { flex: 1, minWidth: 0 } },
          h(MuiLinearProgress, {
            variant: 'determinate',
            value: totalUnknown ? 0 : total.value,
            'aria-label': props.copy.tip.progressTotal,
            sx: { height: 6, borderRadius: 3 },
          }),
        ),
      ),
      h(MuiTypography, { variant: 'caption', color: 'text.secondary', sx: AGENTS_FOOTER_TEXT_SX }, totalText),
    ),
  )
}

function formatAgentTime(at: number | null): string {
  if (at === null) return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Stable transcript row identity; role is part of the key, not the text. */
function agentMessageKey(index: number, message: AgentMessageData): string {
  return `${index}:${message.role}`
}

/**
 * Estimated height of one transcript row (48–240 px).
 *
 * The transcript uses {@link VirtualList}'s variable-row mode: the estimate is
 * derived from the source length (≈72 characters per line, 18 px per line plus
 * padding), collapsed to two lines and expanded to the full text. The estimate
 * decides the cumulative scroll geometry; the row itself stays exact because
 * the bubble clips/scrolls inside the row.
 */
export function estimateMessageHeight(
  message: Pick<AgentMessageData, 'text'>,
  expanded: boolean,
): number {
  const lines = Math.max(1, Math.ceil(message.text.length / 72))
  const shown = expanded ? Math.min(lines, 12) : Math.min(lines, 2)
  return Math.max(48, Math.min(240, 48 + shown * 18))
}

/** True when the collapsed transcript row hides part of the message. */
export function messageCanExpand(message: Pick<AgentMessageData, 'text'>): boolean {
  return estimateMessageHeight(message, true) > estimateMessageHeight(message, false)
}

/** Read-only chat bubble: provenance meta, sanitized Markdown, no composer. */
function MessageBubble(props: {
  copy: PanelCopy
  message: AgentMessageData
  index: number
  renderer: MessageHtmlRenderer | null
  expanded: boolean
  onToggle: (key: string) => void
}): React.ReactElement {
  const kind = messageRoleKind(props.message.role)
  // The sanitized HTML is produced once per message text / renderer generation.
  const html = React.useMemo(() => {
    if (props.renderer === null) return null
    try {
      return props.renderer(props.message.text)
    } catch (error) {
      // A Markdown/sanitize failure degrades to plain text; never a white screen.
      console.error('[coordination] message markdown failed', error)
      return null
    }
  }, [props.renderer, props.message.text])
  const bubble = kind === 'user'
    ? MESSAGE_USER_SX
    : kind === 'assistant'
      ? MESSAGE_ASSISTANT_SX
      : MESSAGE_NOTICE_SX
  const canExpand = messageCanExpand(props.message)
  const key = agentMessageKey(props.index, props.message)
  const time = formatAgentTime(props.message.at) || '—'
  const toggle = (): void => {
    props.onToggle(key)
  }
  const body = html === null
    ? h(
      MuiTypography,
      {
        component: 'span',
        variant: 'inherit',
        sx: kind === 'tool'
          ? { fontFamily: 'monospace', whiteSpace: 'pre-wrap' }
          : { whiteSpace: 'pre-wrap' },
      },
      props.message.text,
    )
    : h(MuiBox, {
      // Sanitized by DOMPurify + scrubMessageHtml before it reaches this point.
      dangerouslySetInnerHTML: { __html: html },
      sx: {
        ...MESSAGE_PROSE_SX,
        ...(kind === 'tool' ? { fontFamily: 'monospace' } : {}),
        ...(kind === 'tool' || kind === 'system' ? MESSAGE_NOTICE_TEXT_SX : {}),
      },
    })
  return h(
    MuiBox,
    {
      sx: { ...MESSAGE_ROW_SX, justifyContent: messageAlignment(props.message.role) },
      'data-message-role': kind,
    },
    h(
      MuiBox,
      {
        sx: { ...bubble, cursor: canExpand ? 'pointer' : 'auto' },
        onClick: (event: React.MouseEvent): void => {
          // Links inside the sanitized HTML keep their own navigation.
          const target = event.target as unknown as {
            closest?: (selector: string) => unknown
          } | null
          const link = target?.closest?.('a')
          if (link !== null && link !== undefined) return
          if (canExpand) toggle()
        },
      },
      h(
        MuiBox,
        {
          sx: {
            ...MESSAGE_META_SX,
            ...(kind === 'assistant'
              ? {}
              : kind === 'user'
                ? MESSAGE_META_USER_SX
                : { justifyContent: 'center' }),
          },
        },
        h(MuiTypography, { component: 'span', sx: MESSAGE_ROLE_SX }, props.copy.messageRoles[kind]),
        h(MuiTypography, { component: 'span', sx: MESSAGE_TIME_SX }, time),
      ),
      h(MuiBox, { sx: props.expanded ? MESSAGE_BODY_SX : undefined }, body),
      canExpand
        ? h(
          MuiButton,
          {
            size: 'small',
            variant: 'text',
            'aria-expanded': props.expanded,
            sx: {
              minWidth: 0,
              padding: '0 4px',
              fontSize: 10,
              marginTop: 0.25,
              alignSelf: kind === 'user' ? 'flex-end' : 'flex-start',
            },
            onClick: (event: React.MouseEvent): void => {
              event.stopPropagation()
              toggle()
            },
          },
          props.expanded ? props.copy.messageCollapse : props.copy.messageExpand,
        )
        : null,
    ),
  )
}

const EMPTY_AGENT_MESSAGES: readonly AgentMessageData[] = []

/**
 * Agent (profession) detail page: a read-only, virtualized Markdown transcript.
 *
 * There is deliberately no composer, retry or send control. Each message is
 * rendered once through the shared lazy Markdown pipeline, sanitized, and only
 * then inserted; until the pipeline resolves (or if it fails) bubbles show the
 * raw text. Expansion is per message and drives the variable row height.
 */
function AgentMessagesView(props: ViewProps): React.ReactElement {
  const id = props.id ?? ''
  const messagesGraph = useGraph(
    id.length === 0 ? null : `/graph/agents/messages?id=${encodeURIComponent(id)}`,
    parseAgentMessages,
    props.refresh,
    props.onSettled,
  )
  const agentsGraph = useGraph('/graph/agents', parseAgents, props.refresh)
  const agent = agentsGraph.state.status === 'ready'
    ? agentsGraph.state.value.agents.find((entry) => entry.id === id) ?? null
    : null
  const messages = messagesGraph.state.status === 'ready'
    ? messagesGraph.state.value.messages
    : EMPTY_AGENT_MESSAGES
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set())
  const [renderer, setRenderer] = React.useState<MessageHtmlRenderer | null>(null)
  const adapter = React.useMemo(
    () => createVirtualListAdapter(
      messages,
      (message, index) => agentMessageKey(index, message),
    ),
    [messages],
  )
  const rowHeight = React.useMemo(
    () => (index: number, message: AgentMessageData): number =>
      estimateMessageHeight(message, expanded.has(agentMessageKey(index, message))),
    [expanded],
  )
  const toggleExpanded = React.useCallback((key: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  React.useEffect(() => {
    let active = true
    void loadMessageHtmlRenderer()
      .then((render) => {
        if (active) setRenderer(() => render)
      })
      .catch((error: unknown) => {
        console.error('[coordination] message markdown pipeline failed', error)
      })
    return () => {
      active = false
    }
  }, [])

  const header = h(
    MuiBox,
    { sx: MESSAGES_HEADER_SX },
    h(
      Tip,
      { label: props.copy.agentBack },
      h(
        MuiIconButton,
        {
          size: 'small',
          'aria-label': props.copy.agentBack,
          onClick: (): void => {
            navigate(props.side, 'agents')
          },
        },
        h(IconBack, { fontSize: 'small' }),
      ),
    ),
    h(
      MuiBox,
      { sx: MESSAGES_TITLE_SX },
      h(MuiTypography, { variant: 'body2', noWrap: true }, agent?.label ?? id),
      agent !== null && agent.objective.length > 0
        ? h(MuiTypography, { variant: 'caption', color: 'text.secondary', noWrap: true, sx: AGENT_OBJECTIVE_SX }, agent.objective)
        : null,
    ),
    agent === null ? null : h(AgentStatusChip, { copy: props.copy, status: agent.status }),
  )

  if (messagesGraph.state.status === 'error') {
    return h(
      MuiBox,
      { sx: MESSAGES_VIEW_SX },
      header,
      // Read-only transcript: no retry/send action here.
      h(EmptyState, { message: props.copy.states.error }),
    )
  }
  if (id.length === 0) {
    return h(
      MuiBox,
      { sx: MESSAGES_VIEW_SX },
      header,
      h(EmptyState, { message: props.copy.agentEmpty }),
    )
  }
  if (messagesGraph.state.status === 'loading' || messagesGraph.state.status === 'idle') {
    return h(
      MuiBox,
      { sx: MESSAGES_VIEW_SX },
      header,
      h(
        MuiBox,
        { sx: MESSAGES_SKELETON_SX },
        ...Array.from({ length: 4 }, (_entry, index) =>
          h(
            MuiBox,
            {
              key: index,
              sx: {
                alignSelf: index % 2 === 0 ? 'flex-start' : 'flex-end',
                width: index % 2 === 0 ? '62%' : '52%',
              },
            },
            h(MuiSkeleton, { variant: 'rounded', height: 44 }),
          ),
        ),
      ),
    )
  }

  const data = messagesGraph.state.value
  return h(
    MuiBox,
    { sx: MESSAGES_VIEW_SX },
    header,
    data.truncated
      ? h(MuiAlert, { severity: 'info', sx: PREVIEW_INFO_SX }, props.copy.agentTruncated)
      : null,
    h(
      MuiTypography,
      { variant: 'caption', color: 'text.secondary', sx: { display: 'block', marginBottom: 0.5 } },
      props.copy.agentMessages,
    ),
    data.messages.length === 0
      ? h(EmptyState, { message: props.copy.states.empty })
      : h(VirtualList<AgentMessageData>, {
        adapter,
        rowHeight,
        'aria-label': props.copy.agentMessages,
        slot: (index, message) => h(MessageBubble, {
          copy: props.copy,
          message,
          index,
          renderer,
          expanded: expanded.has(agentMessageKey(index, message)),
          onToggle: toggleExpanded,
        }),
      }),
  )
}

const RIGHT_VIEW_REGISTRY: Readonly<Partial<Record<PanelView, React.ComponentType<ViewProps>>>> = {
  files: FilesView,
  outline: OutlineView,
  dependencies: DependenciesView,
  // Imports and exports are independent WebGL canvas pages on both sides.
  imports: ImportsCanvasView,
  exports: ExportsCanvasView,
  preview: PreviewView,
}

const LEFT_VIEW_REGISTRY: Readonly<Partial<Record<PanelView, React.ComponentType<ViewProps>>>> = {
  files: FilesView,
  agents: AgentsView,
  agent: AgentMessagesView,
  dependencies: DependenciesCanvasView,
  imports: ImportsCanvasView,
  exports: ExportsCanvasView,
}

/* ------------------------------------------------------------------------- *
 * Search
 * ------------------------------------------------------------------------- */

type SearchStatus = 'idle' | 'loading' | 'ready' | 'error'

interface SearchState {
  status: SearchStatus
  hits: SearchHit[]
}

/** The compact TextField MUI's Autocomplete renders inside the title bar. */
function renderSearchInput(
  params: Record<string, unknown>,
  copy: PanelCopy,
  inputRef: React.RefObject<HTMLInputElement>,
): React.ReactElement {
  const slots = asRecord(params.slotProps)
  const htmlInput = asRecord(slots?.htmlInput)
  return h(MuiTextField, {
    ...params,
    size: 'small',
    variant: 'outlined',
    placeholder: copy.search.placeholder,
    sx: SEARCH_FIELD_SX,
    inputRef,
    slotProps: {
      ...(slots ?? {}),
      htmlInput: {
        ...(htmlInput ?? {}),
        id: SEARCH_INPUT_ID,
        'aria-label': copy.search.label,
      },
    },
  })
}

/** One listbox row: kind chip, node name, then the file:line meta line. */
function renderSearchOption(
  optionProps: Record<string, unknown>,
  hit: SearchHit,
): React.ReactElement {
  const { key, ...rest } = optionProps
  return h(
    MuiBox,
    { ...rest, key: key as React.Key, component: 'li', sx: SEARCH_OPTION_SX },
    h(
      MuiBox,
      { sx: SEARCH_HIT_TOP_SX },
      hit.kind.length > 0
        ? h(MuiChip, { size: 'small', variant: 'outlined', label: hit.kind })
        : null,
      h(MuiTypography, { variant: 'body2', noWrap: true, sx: SEARCH_HIT_NAME_SX }, hit.name),
    ),
    hit.path !== null || hit.line !== null
      ? h(
        MuiTypography,
        {
          variant: 'caption',
          color: 'text.secondary',
          sx: SEARCH_HIT_META_SX,
          title: hit.path ?? undefined,
        },
        `${hit.path ?? ''}${hit.line === null ? '' : `:${hit.line}`}`,
      )
      : null,
  )
}

/** One measured scrollbar geometry, in the target element's pixels. */
interface ScrollBarMetrics {
  visible: boolean
  trackHeight: number
  thumbHeight: number
  thumbTop: number
}

const HIDDEN_SCROLL_BAR: ScrollBarMetrics = {
  visible: false,
  trackHeight: 0,
  thumbHeight: 0,
  thumbTop: 0,
}

/** A thumb never gets thinner than this, however long the content is. */
const SCROLL_BAR_MIN_THUMB = 24
/** Overlay width; the track itself is transparent, only the thumb is painted. */
const SCROLL_BAR_WIDTH = 6

/** Transparent groove; the light-grey thumb is the only visible part. */
export const SCROLL_TRACK_SX = {
  position: 'absolute',
  top: 0,
  right: 2,
  bottom: 0,
  width: SCROLL_BAR_WIDTH,
  borderRadius: SCROLL_BAR_WIDTH / 2,
  backgroundColor: 'transparent',
  pointerEvents: 'none',
  zIndex: 2,
}

/** Light-grey thumb; drag to scroll, hovering darkens it slightly. */
export const SCROLL_THUMB_SX = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  borderRadius: SCROLL_BAR_WIDTH / 2,
  backgroundColor: 'rgba(0, 0, 0, 0.22)',
  pointerEvents: 'auto',
  cursor: 'grab',
  touchAction: 'none',
  '&:hover': { backgroundColor: 'rgba(0, 0, 0, 0.32)' },
  '&:active': { cursor: 'grabbing' },
}

/**
 * A small standalone React scrollbar for an existing scrolling element.
 *
 * The native bar on `targetRef` must be hidden by the caller (`scrollbar-width:
 * none` + `::-webkit-scrollbar`). This component measures the target on scroll,
 * resize and content mutation, then overlays a transparent track with a
 * light-grey thumb. Dragging the thumb scrolls the target; the track never
 * paints a background. It renders nothing when the target has no overflow.
 *
 * No dependency is added and no CSS file is used: geometry is inline style and
 * the appearance is MUI `sx`.
 */
export function ScrollBar(props: {
  targetRef: React.RefObject<HTMLElement | null>
  /** Changes when the target's content height may have changed. */
  refreshKey?: unknown
}): React.ReactElement | null {
  const [metrics, setMetrics] = React.useState<ScrollBarMetrics>(HIDDEN_SCROLL_BAR)
  const dragRef = React.useRef<{ startY: number; startTop: number } | null>(null)

  const measure = React.useCallback((): void => {
    const target = props.targetRef.current
    if (target === null) {
      setMetrics(HIDDEN_SCROLL_BAR)
      return
    }
    const trackHeight = target.clientHeight
    const scrollHeight = target.scrollHeight
    if (trackHeight <= 0 || scrollHeight <= trackHeight) {
      setMetrics((previous) => (previous.visible ? HIDDEN_SCROLL_BAR : previous))
      return
    }
    const thumbHeight = Math.max(
      SCROLL_BAR_MIN_THUMB,
      Math.round((trackHeight * trackHeight) / scrollHeight),
    )
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight)
    const maxScroll = scrollHeight - trackHeight
    const thumbTop = maxScroll <= 0
      ? 0
      : Math.round((target.scrollTop / maxScroll) * maxThumbTop)
    setMetrics((previous) => (
      previous.visible
      && previous.trackHeight === trackHeight
      && previous.thumbHeight === thumbHeight
      && previous.thumbTop === thumbTop
        ? previous
        : { visible: true, trackHeight, thumbHeight, thumbTop }
    ))
  }, [props.targetRef])

  React.useEffect(() => {
    const target = props.targetRef.current
    if (target === null || typeof window === 'undefined') return
    measure()
    target.addEventListener('scroll', measure, { passive: true })
    let resize: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resize = new ResizeObserver(() => {
        measure()
      })
      resize.observe(target)
    }
    let mutation: MutationObserver | null = null
    if (typeof MutationObserver !== 'undefined') {
      mutation = new MutationObserver(() => {
        measure()
      })
      mutation.observe(target, { childList: true, subtree: true })
    }
    return () => {
      target.removeEventListener('scroll', measure)
      resize?.disconnect()
      mutation?.disconnect()
    }
  }, [measure, props.targetRef, props.refreshKey])

  const onThumbPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const target = props.targetRef.current
    if (target === null) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = { startY: event.clientY, startTop: target.scrollTop }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onThumbPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    const target = props.targetRef.current
    if (drag === null || target === null) return
    const maxThumbTop = Math.max(0, metrics.trackHeight - metrics.thumbHeight)
    const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight)
    if (maxThumbTop <= 0 || maxScroll <= 0) return
    const offset = ((event.clientY - drag.startY) / maxThumbTop) * maxScroll
    target.scrollTop = Math.max(0, Math.min(maxScroll, drag.startTop + offset))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  if (!metrics.visible) return null

  return h(
    MuiBox,
    {
      sx: SCROLL_TRACK_SX,
      'aria-hidden': true,
      onMouseDown: (event: React.MouseEvent<HTMLDivElement>): void => {
        // Keep the combobox input focused while the thumb is used.
        event.preventDefault()
      },
    },
    h(MuiBox, {
      sx: SCROLL_THUMB_SX,
      style: {
        height: `${metrics.thumbHeight}px`,
        transform: `translateY(${metrics.thumbTop}px)`,
      },
      onPointerDown: onThumbPointerDown,
      onPointerMove: onThumbPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture: (): void => {
        dragRef.current = null
      },
    }),
  )
}

/**
 * Autocomplete listbox slot: the native scrollbar is hidden and replaced by
 * {@link ScrollBar}, which overlays a transparent track and a light-grey thumb.
 *
 * The `ul` stays the scrolling element and keeps MUI's listbox class (option
 * focus colours); its 40vh cap and 8px padding are overridden inline so the
 * custom thumb measures exactly the visible list. MUI's `ref` is forwarded to
 * the `ul` it queries for keyboard navigation, and `ownerState` is dropped
 * because it is an MUI styling prop that must not reach the DOM.
 */
function AutocompleteScrollListboxBase(
  props: Record<string, unknown>,
  forwardedRef: React.ForwardedRef<HTMLElement>,
): React.ReactElement {
  const {
    children,
    className,
    ownerState: _ownerState,
    style,
    ...rest
  } = props
  const scrollRef = React.useRef<HTMLElement | null>(null)
  const setRef = React.useCallback((node: HTMLElement | null): void => {
    scrollRef.current = node
    if (typeof forwardedRef === 'function') {
      forwardedRef(node)
      return
    }
    if (forwardedRef !== null && typeof forwardedRef === 'object') {
      (forwardedRef as React.MutableRefObject<HTMLElement | null>).current = node
    }
  }, [forwardedRef])

  return h(
    MuiBox,
    { sx: SEARCH_LISTBOX_WRAP_SX },
    h(
      MuiBox,
      {
        component: 'ul',
        ...rest,
        ref: setRef,
        className,
        // Inline geometry wins over MUI's listbox class (40vh cap, 8px pad).
        style: {
          ...(asRecord(style) ?? {}),
          maxHeight: SEARCH_LISTBOX_MAX_HEIGHT,
          overflowY: 'auto',
          overflowX: 'hidden',
          margin: 0,
          padding: 0,
          listStyle: 'none',
          scrollbarWidth: 'none',
        },
        sx: SEARCH_LISTBOX_SX,
      },
      children as React.ReactNode,
    ),
    h(ScrollBar, {
      targetRef: scrollRef,
      refreshKey: React.Children.count(children as React.ReactNode),
    }),
  )
}

/**
 * MUI's listbox slot must be a `forwardRef` component: the autocomplete hands
 * it a ref for keyboard navigation, and React only delivers that ref to a
 * `forwardRef` component. The ref goes to the `ul`; the wrapper only positions
 * the custom scrollbar.
 */
const AutocompleteScrollListbox = React.forwardRef(AutocompleteScrollListboxBase)

/** Loading / no-results / error copy MUI shows when the listbox is empty. */
function searchNoOptionsText(
  search: SearchState,
  copy: PanelCopy,
  onRetry: () => void,
): React.ReactNode {
  if (search.status === 'error') {
    return h(
      MuiBox,
      { sx: SEARCH_STATUS_SX },
      h(MuiTypography, { variant: 'caption', color: 'text.secondary' }, copy.search.error),
      h(
        MuiButton,
        {
          size: 'small',
          variant: 'text',
          // Keep the input focused so the popup does not close before the click.
          onMouseDown: (event: React.MouseEvent<HTMLButtonElement>): void => {
            event.preventDefault()
          },
          onClick: onRetry,
        },
        copy.states.retry,
      ),
    )
  }
  return search.status === 'loading' ? copy.states.loading : copy.search.noResults
}

/** Where a search hit opens: an explicit host view wins, then kind, then path. */
function hitTarget(
  hit: SearchHit,
  views: readonly PanelView[],
): { view: PanelView; params: RouteParams } {
  const params: RouteParams = hit.params.path !== undefined
    ? { path: hit.params.path }
    : hit.path !== null
      ? { path: hit.path }
      : {}
  let view: PanelView
  if (hit.view !== null) view = hit.view
  else if (hit.kind === 'dependency' || hit.kind === 'edge' || hit.kind === 'cycle') view = 'dependencies'
  else if (isPanelFamily(hit.kind)) view = 'outline'
  else view = 'files'
  if (!views.includes(view)) view = views.includes('files') ? 'files' : views[0] ?? 'files'
  return { view, params }
}

/* ------------------------------------------------------------------------- *
 * Panel
 * ------------------------------------------------------------------------- */

interface PanelProps {
  sessionId?: string
}

interface Notice {
  message: string
  severity: 'success' | 'info' | 'warning' | 'error'
}

/** One docked panel inside the fixed right-hand column. */
interface DockedPanelProps {
  side: PanelSide
  /** Tabs rendered in the BottomNavigation, in order. */
  tabs: readonly PanelView[]
  /** Every routable page for this side: `tabs` plus detail routes. */
  routes: readonly PanelView[]
  title: string
  expanded: boolean
  reducedMotion: boolean
  onToggle: () => void
  onResetWidth: () => void
}

function DockedPanel(props: DockedPanelProps): React.ReactElement {
  const copy = useCopy().panel
  const panelError = React.useSyncExternalStore(subscribePanelError, getPanelError, getPanelError)
  const [menuAnchor, setMenuAnchor] = React.useState<HTMLElement | null>(null)
  const [refresh, setRefresh] = React.useState(0)
  const [actionBusy, setActionBusy] = React.useState<'refresh' | 'rebuild' | 'index' | null>(null)
  const [notice, setNotice] = React.useState<Notice | null>(null)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [search, setSearch] = React.useState<SearchState>({ status: 'idle', hits: [] })
  const searchRef = React.useRef<HTMLInputElement | null>(null)
  const searchSeq = React.useRef(0)
  const highlightedHitRef = React.useRef<SearchHit | null>(null)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const pendingScrollRef = React.useRef<number | null>(null)
  /** Global-outline scroll offset, restored after returning from local mode. */
  const outlineScrollRef = React.useRef(0)
  const lastViewRef = React.useRef<PanelView>(props.tabs[0] ?? 'files')
  const lastPathRef = React.useRef<string | null>(null)

  // Component state is authoritative; the hash is read exactly once, here.
  // Only `routes` is validated: `preview` / `agent` deep-link without being tabs.
  const [navigation, dispatchNavigation] = React.useReducer(
    panelNavigationReducer,
    props.routes,
    (routes: readonly PanelView[]): PanelNavigationState =>
      initialPanelNavigation(readHash(), props.side, routes, props.tabs[0] ?? 'files'),
  )
  const view = navigation.view
  const path = navigation.path
  const id = navigation.id
  /**
   * Preview always previews the last picked file. A bottom-nav switch (or a
   * restored panel) can arrive without a path even though the panel still owns
   * a selection, so the preview tab reads the remembered path as its fallback.
   * Other views keep their own file/workspace mode untouched.
   */
  const previewPath = view === 'preview' ? path ?? lastPathRef.current : null
  const viewPath = view === 'preview' ? previewPath : path

  const go = React.useCallback((next: PanelView, params?: RouteParams): void => {
    // The global outline must keep its scroll position across the local-mode
    // round trip; capture it before this navigation replaces the content.
    if (view === 'outline' && path === null) {
      outlineScrollRef.current = scrollRef.current?.scrollTop ?? 0
    }
    dispatchNavigation({
      type: 'navigate',
      view: next,
      path: params?.path ?? null,
      id: params?.id ?? null,
    })
    mirrorHash(props.side, next, params)
  }, [props.side, view, path])

  // Child views (tree rows, canvas, agents) navigate through this panel entry.
  React.useEffect(() => {
    panelNavigators.set(props.side, go)
    return () => {
      if (panelNavigators.get(props.side) === go) panelNavigators.delete(props.side)
    }
  }, [go, props.side])

  // Remember the last non-preview selection for Escape / "leave preview".
  React.useEffect(() => {
    if (navigation.view === 'preview') return
    lastViewRef.current = navigation.view === 'agent' ? 'agents' : navigation.view
    lastPathRef.current = navigation.path
  }, [navigation])

  // Minimized content is unmounted, so abandon any action spinner with it.
  React.useEffect(() => {
    if (!props.expanded) setActionBusy(null)
  }, [props.expanded])

  const clearSearch = React.useCallback((): void => {
    searchSeq.current += 1
    highlightedHitRef.current = null
    setQuery('')
    setSearch({ status: 'idle', hits: [] })
  }, [])

  React.useEffect(() => {
    if (props.expanded) return
    setSearchOpen(false)
    clearSearch()
  }, [props.expanded, clearSearch])

  const togglePanel = (): void => {
    setMenuAnchor(null)
    props.onToggle()
  }

  const resetWidth = (): void => {
    setMenuAnchor(null)
    props.onResetWidth()
  }

  /** Drop the selected file and keep the current view (workspace mode). */
  const clearSelection = (): void => {
    if (view === 'preview') {
      go('files')
      return
    }
    go(view)
  }

  /**
   * `Escape` in preview returns to the last non-preview view of this panel.
   * Navigation is local state, so no history entry has to be unwound.
   */
  const leavePreview = (): void => {
    const target = lastViewRef.current === 'preview' ? 'files' : lastViewRef.current
    go(target, lastPathRef.current !== null ? { path: lastPathRef.current } : undefined)
  }

  /**
   * Leave the local outline: drop `path` (mirrored through replaceState) and
   * queue the remembered global scroll offset for the settle handler.
   */
  const leaveOutlineLocal = (): void => {
    pendingScrollRef.current = outlineScrollRef.current
    go('outline')
  }

  /** One request for one term; `searchSeq` drops stale answers. */
  const requestSearch = React.useCallback((term: string): void => {
    const sequence = searchSeq.current + 1
    searchSeq.current = sequence
    setSearch({ status: 'loading', hits: [] })
    void fetchGraph(`/graph/search?q=${encodeURIComponent(term)}`).then((outcome) => {
      if (searchSeq.current !== sequence) return
      setSearch(
        outcome.ok
          ? { status: 'ready', hits: parseSearch(outcome.value) }
          : { status: 'error', hits: [] },
      )
    })
  }, [])

  /** Immediate search (Enter or the error-state retry); bypasses the debounce. */
  const submitSearch = React.useCallback((): void => {
    const term = query.trim()
    if (term.length === 0) {
      clearSearch()
      return
    }
    requestSearch(term)
  }, [query, clearSearch, requestSearch])

  /**
   * The combobox searches while typing. Debouncing keeps one request per pause
   * while the popup can still show the previous options; a new keystroke
   * invalidates the pending timer through the effect cleanup.
   */
  React.useEffect(() => {
    if (!searchOpen || !props.expanded) return
    const term = query.trim()
    // Invalidate any answer still in flight for the previous term; the
    // debounced request below allocates its own sequence.
    searchSeq.current += 1
    if (term.length === 0) {
      setSearch({ status: 'idle', hits: [] })
      return
    }
    setSearch((previous) => (
      previous.status === 'loading' ? previous : { status: 'loading', hits: [] }
    ))
    const timer = window.setTimeout(() => {
      requestSearch(term)
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [query, searchOpen, props.expanded, requestSearch])

  const activateHit = (hit: SearchHit): void => {
    const target = hitTarget(hit, props.routes)
    go(target.view, target.params)
    clearSearch()
  }

  /** Typing drives the terminal state; a reset comes from a selection. */
  const handleSearchInput = (_event: unknown, value: string, reason: string): void => {
    if (reason === 'reset') return
    highlightedHitRef.current = null
    setQuery(value)
  }

  /** Selecting a listbox row opens the hit and closes the search. */
  const handleSearchSelect = (_event: unknown, value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    activateHit(value as SearchHit)
  }

  const onSearchKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setSearchOpen(false)
      clearSearch()
      return
    }
    // Enter selects a highlighted row (MUI's own handling); with no row
    // highlighted it runs the search immediately.
    if (event.key === 'Enter' && highlightedHitRef.current === null) {
      event.preventDefault()
      submitSearch()
    }
  }

  /** Restore the scroll offset captured before a refresh/rebuild. */
  const handleSettled = React.useCallback((): void => {
    setActionBusy(null)
    const top = pendingScrollRef.current
    if (top === null) return
    pendingScrollRef.current = null
    if (typeof window === 'undefined') return
    window.requestAnimationFrame(() => {
      if (scrollRef.current !== null) scrollRef.current.scrollTop = top
    })
  }, [])

  const captureScroll = (): void => {
    pendingScrollRef.current = scrollRef.current?.scrollTop ?? 0
  }

  const refreshView = (): void => {
    if (actionBusy !== null || !props.expanded) return
    setMenuAnchor(null)
    setActionBusy('refresh')
    captureScroll()
    setRefresh((previous) => previous + 1)
  }

  const rebuild = (): void => {
    if (actionBusy !== null || !props.expanded) return
    setMenuAnchor(null)
    setActionBusy('rebuild')
    captureScroll()
    void rebuildGraph().then((outcome) => {
      if (!outcome.ok) {
        setActionBusy(null)
        if (outcome.status === 409 || outcome.code === 'BUSY') {
          setNotice({ message: copy.rebuildBusy, severity: 'info' })
          return
        }
        setNotice({
          message: fillTemplate(copy.actionFailed, {
            code: outcome.code ?? `HTTP ${outcome.status === null ? '?' : String(outcome.status)}`,
          }),
          severity: 'error',
        })
        return
      }
      const report = outcome.report
      setNotice({
        message: report.truncated
          ? copy.rebuildPartial
          : fillTemplate(copy.rebuildDone, {
            files: String(report.files),
            nodes: String(report.nodes),
            ms: String(report.ms),
          }),
        severity: report.truncated ? 'warning' : 'success',
      })
      // The graph changed: drop stale search hits and re-request the view.
      clearSearch()
      setRefresh((previous) => previous + 1)
    })
  }

  /**
   * The explicit indexing action behind the empty state's button.
   *
   * The host scans the workspace (bounded to 200 files / 10 s), indexes what it
   * can and answers counts; we then re-request the active view. Progress uses
   * the same spinner (`actionBusy`) and Snackbar notice as refresh/rebuild.
   */
  const indexWorkspace = (): void => {
    if (actionBusy !== null || !props.expanded) return
    setActionBusy('index')
    captureScroll()
    void indexGraph().then((outcome) => {
      if (!outcome.ok) {
        setActionBusy(null)
        if (outcome.status === 409 || outcome.code === 'BUSY') {
          setNotice({ message: copy.indexBusy, severity: 'info' })
          return
        }
        setNotice({
          message: fillTemplate(copy.actionFailed, {
            code: outcome.code ?? `HTTP ${outcome.status === null ? '?' : String(outcome.status)}`,
          }),
          severity: 'error',
        })
        return
      }
      const report = outcome.report
      // The resolved root is part of every notice: it turns "nothing worked"
      // into "this is the directory the host looked at". Zero indexed files is
      // a warning, never the success notice, so a wrong root cannot look done.
      const rootSuffix = report.root.length === 0 ? '' : ` · ${report.root}`
      const indexedNothing = report.indexed === 0
      setNotice({
        message: indexedNothing
          ? `${copy.files.empty}${rootSuffix}`
          : report.truncated
            ? `${copy.indexPartial}${rootSuffix}`
            : `${fillTemplate(copy.indexDone, {
              indexed: String(report.indexed),
              nodes: String(report.nodes),
              ms: String(report.ms),
            })}${rootSuffix}`,
        severity: indexedNothing || report.truncated ? 'warning' : 'success',
      })
      // The graph changed: drop stale search hits and re-request the view.
      clearSearch()
      setRefresh((previous) => previous + 1)
    })
  }

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (menuAnchor !== null) return
    event.stopPropagation()
    if (view === 'preview') {
      leavePreview()
      return
    }
    // The agent detail page keeps the title bar and its back button; Escape is
    // the keyboard path back to the roster (deep-linked pages included).
    if (view === 'agent') {
      go('agents')
      return
    }
    // Local outline → global outline (the scope-bar back button's keyboard twin).
    if (view === 'outline' && path !== null) {
      leaveOutlineLocal()
      return
    }
    if (props.expanded) props.onToggle()
  }

  const ActiveView = (props.side === 'left' ? LEFT_VIEW_REGISTRY : RIGHT_VIEW_REGISTRY)[view] ?? FilesView
  const scopeLabel = viewPath === null
    ? copy.scopeWorkspace
    : fillTemplate(copy.scopeFile, { path: viewPath })
  const scopeTip = viewPath === null
    ? copy.tip.scopeWorkspace
    : fillTemplate(copy.tip.scope, { path: viewPath })
  const titleTip = fillTemplate(copy.expandTitle, { title: props.title })
  const errorTip = panelError === null ? '' : panelErrorTooltip(panelError)
  /** Local outline: the scope bar starts with the way back to the global tree. */
  const outlineBack = view === 'outline' && viewPath !== null
    ? h(
      Tip,
      { label: copy.outlineBack },
      h(
        MuiIconButton,
        {
          size: 'small',
          'aria-label': copy.outlineBack,
          onClick: leaveOutlineLocal,
        },
        h(IconBack, { fontSize: 'small' }),
      ),
    )
    : null

  const scopeChip = h(
    MuiGrow,
    {
      key: viewPath ?? 'workspace',
      in: true,
      appear: true,
      timeout: props.reducedMotion ? 0 : SCOPE_GROW_MS,
    },
    h(
      'div',
      { style: SCOPE_CHIP_WRAP_STYLE },
      h(
        Tip,
        { label: scopeTip },
        h(MuiChip, {
          size: 'small',
          variant: 'outlined',
          sx: SCOPE_CHIP_SX,
          label: scopeLabel,
          'aria-label': scopeTip,
          onClick: (): void => {
            go('files', viewPath !== null ? { path: viewPath } : undefined)
          },
          onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>): void => {
            if (viewPath !== null && (event.key === 'Delete' || event.key === 'Backspace')) {
              event.preventDefault()
              clearSelection()
            }
          },
          ...(viewPath === null
            ? {}
            : {
              onDelete: (event: React.MouseEvent<HTMLDivElement>): void => {
                event.stopPropagation()
                clearSelection()
              },
              deleteIcon: h(
                'span',
                {
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': copy.clearSelection,
                  title: copy.tip.clearScope,
                  style: { display: 'inline-flex', alignItems: 'center' },
                  onKeyDown: (event: React.KeyboardEvent<HTMLSpanElement>): void => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      event.stopPropagation()
                      clearSelection()
                    }
                  },
                },
                h(IconClose, { fontSize: 'small' }),
              ),
            }),
        }),
      ),
      viewPath === null
        ? null
        : h(
          Tip,
          { label: copy.tip.clearScope },
          h(
            MuiIconButton,
            {
              size: 'small',
              'aria-label': copy.clearSelection,
              onClick: clearSelection,
            },
            h(IconClose, { fontSize: 'small' }),
          ),
        ),
    ),
  )

  const header = h(
    MuiBox,
    { sx: HEADER_SX },
    h(
      Tip,
      { label: copy.tip.menu },
      h(
        MuiIconButton,
        {
          size: 'small',
          'aria-label': copy.tip.menu,
          'aria-haspopup': 'true',
          'aria-expanded': menuAnchor !== null ? 'true' : 'false',
          onClick: (event: React.MouseEvent<HTMLButtonElement>): void => {
            setMenuAnchor(event.currentTarget)
          },
        },
        h(IconMenu),
      ),
    ),
    h(
      Tip,
      { label: titleTip },
      h(
        MuiBox,
        {
          role: 'button',
          tabIndex: 0,
          'aria-expanded': props.expanded,
          'aria-label': titleTip,
          onClick: (): void => {
            // While search is open, the title area is the "click outside" target:
            // it closes/clears the search before it would toggle the panel.
            if (searchOpen) {
              setSearchOpen(false)
              clearSearch()
              return
            }
            togglePanel()
          },
          onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>): void => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              if (searchOpen) {
                setSearchOpen(false)
                clearSearch()
                return
              }
              togglePanel()
            }
          },
          sx: HEADER_TITLE_SX,
        },
        h(MuiTypography, { variant: 'subtitle2', noWrap: true }, props.title),
      ),
    ),
    h(
      MuiCollapse,
      {
        in: searchOpen && props.expanded,
        orientation: 'horizontal',
        collapsedSize: 0,
        timeout: props.reducedMotion ? 0 : SEARCH_ANIMATION_MS,
        easing: PANEL_EASING,
        unmountOnExit: true,
        onEntered: (): void => {
          // Focus only once the field has finished expanding; a collapse in
          // progress never steals focus from the title bar.
          searchRef.current?.focus()
        },
        sx: SEARCH_COLLAPSE_SX,
      },
      h(
        MuiBox,
        { sx: SEARCH_SLOT_SX },
        h(
          Tip,
          { label: copy.tip.search },
          h(MuiAutocomplete, {
            freeSolo: false,
            options: search.status === 'ready' ? search.hits : [],
            value: null,
            inputValue: query,
            loading: search.status === 'loading',
            loadingText: copy.states.loading,
            noOptionsText: searchNoOptionsText(search, copy, submitSearch),
            // The host already searched: never filter its hits locally.
            filterOptions: (options: SearchHit[]): SearchHit[] => options,
            getOptionLabel: (option: SearchHit): string => option.name,
            isOptionEqualToValue: (option: SearchHit, candidate: SearchHit): boolean =>
              option === candidate,
            onInputChange: handleSearchInput,
            onChange: handleSearchSelect,
            onHighlightChange: (_event: unknown, option: unknown): void => {
              highlightedHitRef.current = option === null || typeof option !== 'object'
                ? null
                : (option as SearchHit)
            },
            onKeyDown: onSearchKeyDown,
            renderInput: (params: Record<string, unknown>): React.ReactElement =>
              renderSearchInput(params, copy, searchRef),
            renderOption: renderSearchOption,
            // The listbox owns the custom scrollbar; the popup must out-rank the
            // fixed panel column (it is portaled to <body>).
            slots: { listbox: AutocompleteScrollListbox },
            slotProps: { popper: { sx: SEARCH_POPPER_SX } },
            sx: SEARCH_AUTOCOMPLETE_SX,
          }),
        ),
      ),
    ),
    panelError === null
      ? null
      : h(
        Tip,
        { label: errorTip },
        h(MuiChip, {
          size: 'small',
          color: 'error',
          variant: 'outlined',
          label: PANEL_CRASHED_LABEL,
          'aria-label': `${PANEL_CRASHED_LABEL}: ${errorTip}`,
          'data-copy-key': 'panel.crashed',
          sx: CRASH_CHIP_SX,
        }),
      ),
    props.expanded
      ? h(
        Tip,
        { label: searchOpen ? copy.tip.closeSearch : copy.tip.search },
        h(
          MuiIconButton,
          {
            size: 'small',
            'aria-label': searchOpen ? copy.tip.closeSearch : copy.search.label,
            'aria-expanded': searchOpen,
            'aria-controls': SEARCH_INPUT_ID,
            onClick: (): void => {
              if (searchOpen) {
                setSearchOpen(false)
                clearSearch()
              } else {
                highlightedHitRef.current = null
                setSearchOpen(true)
              }
            },
          },
          h(IconSearch, { fontSize: 'small' }),
        ),
      )
      : null,
    h(
      MuiFade,
      {
        key: props.expanded ? 'minimize' : 'restore',
        in: true,
        appear: true,
        timeout: props.reducedMotion ? 0 : 150,
      },
      h(
        'span',
        { style: { display: 'inline-flex' } },
        h(
          Tip,
          { label: props.expanded ? copy.minimize : copy.restore },
          h(
            MuiIconButton,
            {
              size: 'small',
              'aria-label': props.expanded ? copy.minimize : copy.restore,
              onClick: togglePanel,
            },
            h(props.expanded ? IconMinimize : IconRestore, { fontSize: 'small' }),
          ),
        ),
      ),
    ),
  )

  const content = h(
    PanelErrorBoundary,
    null,
    h(
      MuiBox,
      { sx: PANEL_CONTENT_SX },
      h(
        MuiBox,
        { sx: SCOPE_BAR_SX },
        outlineBack,
        scopeChip,
        h(
          MuiTypography,
          { variant: 'caption', color: 'text.secondary', noWrap: true, sx: READ_ONLY_SX },
          copy.readOnly,
        ),
      ),
      h(
        MuiCard,
        { elevation: 0, square: true, sx: CARD_SX },
        h(
          MuiCardContent,
          { sx: CARD_CONTENT_SX, ref: scrollRef },
          h(
            MuiFade,
            {
              // The Outline view stays mounted across its global/local path
              // change so the global collapse state and scroll survive the trip;
              // every other view remounts per selection for its fade.
              key: view === 'outline' ? 'view:outline' : `view:${view}:${viewPath ?? ''}:${id ?? ''}`,
              in: true,
              appear: true,
              timeout: props.reducedMotion ? 0 : VIEW_FADE_MS,
            },
            h(
              'div',
              { style: TRANSITION_SURFACE_STYLE },
              h(PanelScrollProvider, { target: scrollRef }, h(MuiBox, { sx: { minWidth: 0 } }, h(ActiveView, {
                side: props.side,
                copy,
                path: viewPath,
                id,
                refresh,
                onSettled: handleSettled,
                indexBusy: actionBusy === 'index',
                onIndexWorkspace: indexWorkspace,
              }))),
            ),
          ),
        ),
      ),
      h(
        MuiBottomNavigation,
        {
          showLabels: true,
          // `agent` belongs to the Agents tab; detail pages such as `preview`
          // are routed but deliberately not tabs, so no tab is selected.
          value: view === 'agent' && props.tabs.includes('agents')
            ? 'agents'
            : props.tabs.includes(view)
              ? view
              : false,
          sx: NAV_SX,
          onChange: (_event: React.SyntheticEvent, value: string): void => {
            if (!isPanelView(value) || !props.tabs.includes(value)) return
            // A tab switch keeps the panel's file selection. Preview additionally
            // falls back to the last picked file, so "select, then Preview"
            // never lands on an empty preview.
            const carryPath = path ?? lastPathRef.current
            go(value, carryPath !== null ? { path: carryPath } : undefined)
          },
        },
        ...props.tabs.map((entry) =>
          h(MuiBottomNavigationAction, {
            key: entry,
            value: entry,
            label: tabLabel(entry, copy),
            title: tabTip(entry, copy),
            icon: h(
              Tip,
              { label: tabTip(entry, copy) },
              h(
                MuiBox,
                { component: 'span', sx: { display: 'inline-flex' } },
                h(TAB_ICONS[entry], { fontSize: 'small' }),
              ),
            ),
          sx: NAV_ACTION_SX,
        }),
      ),
    ),
    ),
  )

  const menu = h(
    MuiMenu,
    {
      anchorEl: menuAnchor,
      open: menuAnchor !== null,
      onClose: (): void => {
        setMenuAnchor(null)
      },
      anchorOrigin: { vertical: 'bottom', horizontal: 'left' },
      transformOrigin: { vertical: 'top', horizontal: 'left' },
      sx: MENU_SX,
    },
    h(
      MuiMenuItem,
      { onClick: refreshView, disabled: actionBusy !== null || !props.expanded },
      h(
        Tip,
        { label: copy.tip.refresh },
        h(
          MuiBox,
          { sx: MENU_ITEM_CONTENT_SX },
          h(
            MuiListItemIcon,
            null,
            actionBusy === 'refresh'
              ? h(MuiCircularProgress, { size: 16 })
              : h(IconRefresh, { fontSize: 'small' }),
          ),
          h(MuiListItemText, null, copy.refresh),
        ),
      ),
    ),
    h(
      MuiMenuItem,
      { onClick: rebuild, disabled: actionBusy !== null || !props.expanded },
      h(
        Tip,
        { label: actionBusy === 'rebuild' ? copy.tip.rebuilding : copy.tip.rebuild },
        h(
          MuiBox,
          { sx: MENU_ITEM_CONTENT_SX },
          h(
            MuiListItemIcon,
            null,
            actionBusy === 'rebuild'
              ? h(MuiCircularProgress, { size: 16 })
              : h(IconRebuild, { fontSize: 'small' }),
          ),
          h(MuiListItemText, null, copy.rebuild),
        ),
      ),
    ),
    h(
      MuiMenuItem,
      { onClick: resetWidth },
      h(
        Tip,
        { label: copy.tip.reset },
        h(
          MuiBox,
          { sx: MENU_ITEM_CONTENT_SX },
          h(MuiListItemIcon, null, h(IconReset, { fontSize: 'small' })),
          h(MuiListItemText, null, copy.menu.reset),
        ),
      ),
    ),
    h(
      MuiMenuItem,
      { onClick: togglePanel, disabled: !props.expanded },
      h(
        Tip,
        { label: copy.tip.collapse },
        h(
          MuiBox,
          { sx: MENU_ITEM_CONTENT_SX },
          h(MuiListItemIcon, null, h(IconClose, { fontSize: 'small' })),
          h(MuiListItemText, null, copy.menu.collapse),
        ),
      ),
    ),
  )

  const snackbar = h(
    MuiSnackbar,
    {
      open: notice !== null,
      autoHideDuration: 4500,
      onClose: (): void => {
        setNotice(null)
      },
      anchorOrigin: { vertical: 'bottom', horizontal: 'center' },
      sx: SNACKBAR_SX,
    },
    notice === null
      ? null
      : h(
        MuiAlert,
        {
          severity: notice.severity,
          variant: 'filled',
          closeText: copy.tip.close,
          onClose: (): void => {
            setNotice(null)
          },
          sx: SNACKBAR_ALERT_SX,
        },
        notice.message,
      ),
  )

  return h(
    MuiBox,
    {
      role: 'dialog',
      'aria-modal': 'false',
      'aria-label': props.title,
      onKeyDown: onPanelKeyDown,
      sx: {
        ...PANEL_ITEM_SX,
        // Equal flex-basis/grow on both panels: two expanded panels split the
        // column height 50/50. `minHeight: 0` on PANEL_ITEM_SX keeps that true
        // even when either body's content is taller than its share.
        flex: props.expanded ? PANEL_EXPANDED_FLEX : PANEL_COLLAPSED_FLEX,
        ...(props.expanded
          ? {}
          : { height: HEADER_HEIGHT, minHeight: HEADER_HEIGHT, maxHeight: HEADER_HEIGHT }),
        transition: props.reducedMotion ? 'none' : PANEL_RESIZE_TRANSITION,
      },
    },
    header,
    h(
      MuiCollapse,
      {
        in: props.expanded,
        timeout: props.reducedMotion ? 0 : PANEL_TOGGLE_MS,
        easing: PANEL_EASING,
        unmountOnExit: true,
        sx: COLLAPSE_BODY_SX,
      },
      // MUI's own fade rides the same 220 ms/easing as the height collapse, so
      // restore/collapse is one Material transition (flex layout handles the
      // push-up; no transform is involved).
      h(
        MuiFade,
        {
          in: props.expanded,
          appear: true,
          timeout: props.reducedMotion ? 0 : PANEL_TOGGLE_MS,
          easing: PANEL_EASING,
        },
        h(
          'div',
          { style: PANEL_CONTENT_STYLE },
          content,
        ),
      ),
    ),
    menu,
    snackbar,
  )
}

/**
 * Deterministic height split for the two docked panels.
 *
 * The two panels plus the 8 px gap must always fit in `containerHeight`:
 *  - below 200 px (or below two title bars) both collapse to 48 px;
 *  - only one expanded: it gets everything except the gap and the other bar;
 *  - both expanded: each gets `(containerHeight - gap) / 2`.
 * Every returned height is at least 48 px, and the sum never exceeds the
 * container. Pure, so the resize/rotation clamp is directly testable.
 */
export interface PanelHeights {
  readonly left: number
  readonly right: number
}

export function splitPanelHeights(
  containerHeight: number,
  collapsedLeft: boolean,
  collapsedRight: boolean,
): PanelHeights {
  const height = Number.isFinite(containerHeight) ? Math.max(0, containerHeight) : 0
  if (height < PANEL_MIN_CONTAINER_HEIGHT) {
    return { left: HEADER_HEIGHT, right: HEADER_HEIGHT }
  }
  const available = Math.max(0, height - COLUMN_GAP)
  if (collapsedLeft && collapsedRight) {
    return { left: HEADER_HEIGHT, right: HEADER_HEIGHT }
  }
  if (collapsedLeft) {
    return {
      left: HEADER_HEIGHT,
      right: Math.max(HEADER_HEIGHT, available - HEADER_HEIGHT),
    }
  }
  if (collapsedRight) {
    return {
      left: Math.max(HEADER_HEIGHT, available - HEADER_HEIGHT),
      right: HEADER_HEIGHT,
    }
  }
  const each = Math.max(HEADER_HEIGHT, available / 2)
  return { left: each, right: each }
}

/**
 * The fixed right-hand column.
 *
 * The column is portaled to `document.body` by
 * {@link CoordinationPanelsColumn}: the DSH shell has transformed ancestors, so
 * a `position: fixed` box rendered inside the composer slot would be positioned
 * against the nearest transform instead of the viewport. The portal restores
 * viewport coordinates for this inset rectangle (72 px from the top, 120 px from
 * the bottom, 16 px from the right).
 *
 * `justifyContent: 'flex-end'` anchors the stack to the bottom: the workspace
 * panel (second child) sits at the bottom and, when it expands, pushes the
 * relationship panel up; when the relationship panel expands it grows back
 * downward into the space. The motion is pure flex layout — no transforms.
 *
 * `top` + `bottom` keep the column clear of the host title bar and the composer
 * row; `width` is capped at 440 px and at the viewport minus the right inset, so
 * the column can never grow past the right edge. `maxHeight` (100dvh with a
 * 100vh fallback) and `overflow: hidden` are a second guard against a
 * rotation/resize ever growing it. Both panels plus the gap therefore always fit
 * inside the column's own box.
 */
export const COLUMN_SX = {
  position: 'fixed',
  top: COLUMN_TOP,
  right: COLUMN_RIGHT,
  bottom: COLUMN_BOTTOM,
  left: 'auto',
  width: 'min(440px, calc(100vw - 32px))',
  maxHeight: `calc(100dvh - ${COLUMN_HEIGHT_OFFSET}px)`,
  '@supports not (height: 100dvh)': {
    maxHeight: `calc(100vh - ${COLUMN_HEIGHT_OFFSET}px)`,
  },
  zIndex: theme.zIndex.tooltip - 1,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  gap: `${COLUMN_GAP}px`,
  overflow: 'hidden',
  pointerEvents: 'none',
}

/** The fixed right-hand column: relationship panel above, workspace below. */
function CoordinationPanelsColumn(_props: PanelProps): React.ReactElement | React.ReactPortal {
  const copy = useCopy().panel
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [column, setColumn] = React.useState<ColumnState>(readColumnState)
  const columnRef = React.useRef<HTMLElement | null>(null)
  const [columnHeight, setColumnHeight] = React.useState(0)

  React.useEffect(() => {
    writeColumnState(column)
  }, [column])

  // Re-clamp on every resize/rotation: a column too short for two title bars
  // forces both panels collapsed rather than showing half content.
  React.useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const element = columnRef.current
    if (element === null) return
    const update = (): void => {
      setColumnHeight(element.clientHeight)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])
  const spaceConstrained = columnHeight > 0 && columnHeight < PANEL_MIN_CONTAINER_HEIGHT

  const toggle = (key: 'openLeft' | 'openRight'): void => {
    setColumn((previous) => ({ ...previous, [key]: !previous[key] }))
  }

  const resetWidth = (): void => {
    setColumn((previous) => ({ ...previous, width: COLUMN_DEFAULT_WIDTH }))
  }

  const fixedColumn = h(
    MuiThemeProvider,
    { theme },
    h(
      MuiBox,
      { ref: columnRef, sx: COLUMN_SX },
      h(
        PanelErrorBoundary,
        null,
        h(DockedPanel, {
          side: 'left',
          tabs: LEFT_PANEL_TABS,
          routes: LEFT_PANEL_ROUTES,
          title: copy.leftTitle,
          expanded: column.openLeft && !spaceConstrained,
          reducedMotion,
          onToggle: (): void => {
            toggle('openLeft')
          },
          onResetWidth: resetWidth,
        }),
      ),
      h(
        PanelErrorBoundary,
        null,
        h(DockedPanel, {
          side: 'right',
          tabs: RIGHT_PANEL_TABS,
          routes: RIGHT_PANEL_ROUTES,
          title: copy.rightTitle,
          expanded: column.openRight && !spaceConstrained,
          reducedMotion,
          onToggle: (): void => {
            toggle('openRight')
          },
          onResetWidth: resetWidth,
        }),
      ),
    ),
  )

  // SSR has no `document` (and no portals): render the column inline there. In
  // the browser the portal is what makes `position: fixed` viewport-relative
  // under the DSH shell's transformed ancestors.
  if (typeof document === 'undefined') return fixedColumn
  return createPortal(fixedColumn, document.body)
}

/**
 * The `panel.enabled` escape hatch: `localStorage['coordination.panel.disabled']`
 * set to `1` (or `true`) mounts nothing at all. This must be a component so the
 * flag is read per mount (a page reload is the documented activation point) and
 * never at module evaluation.
 */
function CoordinationPanelsInner(props: PanelProps): React.ReactElement | null {
  const [disabled] = React.useState(isPanelDisabled)
  if (disabled) return null
  // Outer boundary around the whole fixed column: a failure in the column's own
  // hooks or theme still cannot escape into the composer slot.
  return h(PanelErrorBoundary, null, h(CoordinationPanelsColumn, props))
}

function sameSession(previous: PanelProps, next: PanelProps): boolean {
  return previous.sessionId === next.sessionId
}

/**
 * Mounted once by the composer slot and memoized on `sessionId` only: every
 * other parent prop the slot passes (the composer input changes on each
 * keystroke) must not re-render this column.
 */
export const CoordinationPanels = React.memo(CoordinationPanelsInner, sameSession)
