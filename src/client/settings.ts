/**
 * The `协调` settings page — four switches, two everyday blocks, one closed
 * accordion per group.
 *
 * The catalog is unchanged (`SETTINGS_CONTROLS`, MUI end to end); what changed
 * is the page around it, because 13 groups and 139 rows is a cognitive-load
 * problem, not a data problem:
 *
 *  - **Four switches first.** `权限接管` and `工作流下拉框` are this browser's
 *    local preferences; `接管宿主弹窗` and `接管文件读写` are the two host
 *    gates the plugin executes itself. They are the only controls visible on
 *    load, so the page opens with four decisions instead of a wall of settings.
 *  - **One column, no side rail.** Nothing is split left/right. `新任务默认值`
 *    and `显示` follow as compact accordions, and every catalog group is its
 *    own accordion under one `高级设置` label.
 *  - **Closed by default.** Every accordion starts closed and its body is not
 *    mounted until opened, so a fresh visit costs four switches plus a list of
 *    one-line headers — not 139 rows.
 *  - **One row per item.** Label, one-sentence hint and control share a row;
 *    the config key and numeric range live in the row tooltip. Read-only rows
 *    keep one light `只读` badge instead of a paragraph each.
 *  - **No save button, no staging.** Every host row writes itself through
 *    `POST /config` as soon as it changes; a refusal rolls that row back and
 *    prints one inline line. Local display switches keep writing the local
 *    store immediately. `恢复默认` (one row) and `恢复全部默认` (top action)
 *    still confirm once, then write immediately.
 *  - **MUI selects, never native ones.** Every enum row and the scene picker
 *    render a MUI `Select` of `MenuItem`s, with a concrete value, a `labelId`
 *    and an `aria-label`, so keyboard and screen-reader use match the rest of
 *    the plugin.
 *  - **Search.** It matches label/hint/config key only. Every section with a
 *    hit is rendered open with only its matching rows; an empty query renders
 *    no collapsed shell for the advanced groups.
 *  - **The read-only tail stays accurate.** `关于 / 参考文献 / 作者` keep
 *    rendering every entry from `src/shared/about.ts`, with counts in their
 *    headers, and never gain an input.
 */
import * as React from 'react'
import CloseIcon from '@mui/icons-material/Close'
import EmailIcon from '@mui/icons-material/Email'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import GitHubIcon from '@mui/icons-material/GitHub'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import Inventory2Icon from '@mui/icons-material/Inventory2'
import PersonIcon from '@mui/icons-material/Person'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import SearchIcon from '@mui/icons-material/Search'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import Link from '@mui/material/Link'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import type { SelectChangeEvent } from '@mui/material/Select'
import Switch from '@mui/material/Switch'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { theme } from './theme.js'
import { currentLocale, useCopy } from './i18n.js'
import { setTakeover, setWorkflow, takeoverStore, workflowStore } from './store.js'
import {
  compactStore,
  localSettingsBlocked,
  refreshStore,
  selectionFeed,
  setCompact,
  setRefreshSeconds,
  setTooltips,
  subscribeSelectionFeed,
  tooltipsStore,
} from './controls.js'
import { loadConfig, saveConfig } from './bridge.js'
import type { ConfigSaveOutcome } from './bridge.js'
import { settingsPageCopy } from './settingsCopy.js'
import type { SettingsPageCopy } from './settingsCopy.js'
import {
  SETTINGS_CATALOG_GROUPS,
  SETTINGS_CONTROLS,
  SETTINGS_CONTROLS_BY_KEY,
  formatConfigNumber,
  readConfigPath,
  settingsControlsOf,
  settingsSceneControls,
  writeConfigPath,
} from '../shared/selection.js'
import type {
  ConfigPatch,
  ConfigScalar,
  ConfigValues,
  ConfigView,
  SettingsCatalogGroupId,
  SettingsControl,
} from '../shared/selection.js'
import { settingsControlCopy, fillTemplate } from '../shared/i18n.js'
import { ABOUT } from '../shared/about.js'
import type { AboutDependency, AboutReference } from '../shared/about.js'
import { CommandValues, InteractionValues, ProfessionValues, SceneValues, ValidationValues, isOneOf } from '../shared/enum.js'
import type { Scene } from '../shared/enum.js'
import type { Copy } from '../shared/i18n.js'

/* MUI's generics describe every overload; the plugin passes one narrow shape. */
type Loose = React.ComponentType<Record<string, unknown>>

const MuiAccordion = Accordion as unknown as Loose
const MuiAccordionDetails = AccordionDetails as unknown as Loose
const MuiAccordionSummary = AccordionSummary as unknown as Loose
const MuiButton = Button as unknown as Loose
const MuiChip = Chip as unknown as Loose
const MuiDialog = Dialog as unknown as Loose
const MuiDialogActions = DialogActions as unknown as Loose
const MuiDialogContent = DialogContent as unknown as Loose
const MuiDialogContentText = DialogContentText as unknown as Loose
const MuiDialogTitle = DialogTitle as unknown as Loose
const MuiIconButton = IconButton as unknown as Loose
const MuiInputAdornment = InputAdornment as unknown as Loose
const MuiLink = Link as unknown as Loose
const MuiList = List as unknown as Loose
const MuiListItem = ListItem as unknown as Loose
const MuiListItemIcon = ListItemIcon as unknown as Loose
const MuiListItemText = ListItemText as unknown as Loose
const MuiMenuItem = MenuItem as unknown as Loose
const MuiSelect = Select as unknown as Loose
const MuiSwitch = Switch as unknown as Loose
const MuiTable = Table as unknown as Loose
const MuiTableBody = TableBody as unknown as Loose
const MuiTableCell = TableCell as unknown as Loose
const MuiTableHead = TableHead as unknown as Loose
const MuiTableRow = TableRow as unknown as Loose
const MuiTextField = TextField as unknown as Loose
const MuiTooltip = Tooltip as unknown as Loose
const MuiTypography = Typography as unknown as Loose
const MuiCloseIcon = CloseIcon as unknown as Loose
const MuiEmailIcon = EmailIcon as unknown as Loose
const MuiExpandIcon = ExpandMoreIcon as unknown as Loose
const MuiGitHubIcon = GitHubIcon as unknown as Loose
const MuiInfoIcon = InfoOutlinedIcon as unknown as Loose
const MuiInventory2Icon = Inventory2Icon as unknown as Loose
const MuiPersonIcon = PersonIcon as unknown as Loose
const MuiRestartIcon = RestartAltIcon as unknown as Loose
const MuiSearchIcon = SearchIcon as unknown as Loose

/* ------------------------------------------------------------------------- *
 * Quick-switch copy overrides
 * ------------------------------------------------------------------------- */

/** One page-owned label/hint pair; `host: true` marks a host gate, never local. */
export interface QuickSwitchCopyOverride {
  readonly label: string
  readonly hint: string
  readonly host: true
}

/**
 * Page-level copy overrides, keyed by control id.
 *
 * `setting:ui.takeoverFiles` reuses the `takeoverDialogs` copy id in the shared
 * catalog (the shared i18n dictionary is a closed record, so a dedicated id is
 * a follow-up there). This table names the gate on this page instead of showing
 * the dialog title twice. An id absent here falls back to the shared catalog
 * copy, so no other row duplicates a translation.
 */
const QUICK_SWITCH_COPY: Readonly<
  Record<string, (copy: SettingsPageCopy) => QuickSwitchCopyOverride>
> = {
  'setting:ui.takeoverFiles': (copy) => ({
    label: copy.takeoverFilesLabel,
    hint: copy.takeoverFilesHint,
    host: true,
  }),
}

/**
 * The page-owned copy for one control, or `undefined` when the row should fall
 * back to the shared catalog copy. Pure, so the page test can pin both the
 * override and the fallback rule.
 */
export function quickSwitchCopyFor(
  controlId: string,
  copy: SettingsPageCopy,
): QuickSwitchCopyOverride | undefined {
  return QUICK_SWITCH_COPY[controlId]?.(copy)
}

/* ------------------------------------------------------------------------- *
 * The page plan — pure, testable
 * ------------------------------------------------------------------------- */

/**
 * The four switches pinned at the top of the page.
 *
 * Two are this browser's preferences (`local` rows, applied immediately); the
 * last two are host gates the plugin executes itself (normal host writes).
 * Their ids are used because local rows own no config key.
 *
 * `setting:ui.takeoverFiles` is newer than the rest of the catalog: an older
 * host build may not carry the row yet, so the lookup below filters missing ids
 * instead of rendering an undefined row.
 */
export const SETTINGS_QUICK_SWITCH_IDS = [
  'setting:local.takeoverPermission',
  'setting:local.composerWorkflow',
  'setting:ui.takeover',
  'setting:ui.takeoverFiles',
] as const

/** The three new-task defaults kept on the first screen. */
export const SETTINGS_TASK_DEFAULT_KEYS = [
  'defaults.profession',
  'defaults.interaction',
  'defaults.scene',
] as const

/** The two display switches kept on the first screen. */
export const SETTINGS_DISPLAY_SWITCH_KEYS = ['ui.showTooltip', 'ui.compact'] as const

const CONTROL_BY_ID: ReadonlyMap<string, SettingsControl> = new Map(
  SETTINGS_CONTROLS.map((control) => [control.id, control]),
)

function isControl(value: SettingsControl | undefined): value is SettingsControl {
  return value !== undefined
}

/** The four always-visible switches, in reading order; unknown ids are skipped. */
export function settingsQuickSwitches(): readonly SettingsControl[] {
  return SETTINGS_QUICK_SWITCH_IDS.map((id) => CONTROL_BY_ID.get(id)).filter(isControl)
}

/** The three new-task defaults, in reading order. */
export function settingsTaskDefaults(): readonly SettingsControl[] {
  return SETTINGS_TASK_DEFAULT_KEYS.map((key) => SETTINGS_CONTROLS_BY_KEY.get(key)).filter(isControl)
}

/** The two display switches, in reading order. */
export function settingsDisplaySwitches(): readonly SettingsControl[] {
  return SETTINGS_DISPLAY_SWITCH_KEYS.map((key) => SETTINGS_CONTROLS_BY_KEY.get(key)).filter(isControl)
}

/** Ids shown on the first screen; their groups do not repeat them. */
const HOISTED_IDS: ReadonlySet<string> = new Set(
  [...settingsQuickSwitches(), ...settingsTaskDefaults(), ...settingsDisplaySwitches()]
    .map((control) => control.id),
)

/** True for a control that lives on the first screen rather than in a group. */
export function isHoistedSetting(control: SettingsControl): boolean {
  return HOISTED_IDS.has(control.id)
}

/** What the page knows about one catalog group before planning the accordions. */
export interface SettingsGroupInput {
  readonly group: SettingsCatalogGroupId
  /** Rows left after the first-screen controls are hoisted out. */
  readonly rows: number
}

/** One accordion: a catalog group and the rows it owns. */
export interface SettingsGroupPage {
  readonly key: string
  readonly group: SettingsCatalogGroupId
  readonly rows: number
}

/** Count the rows of every group after hoisting the first-screen controls. */
export function settingsGroupInputs(): readonly SettingsGroupInput[] {
  return SETTINGS_CATALOG_GROUPS.map((group) => ({
    group,
    rows: settingsControlsOf(group).filter((control) => !HOISTED_IDS.has(control.id)).length,
  }))
}

/** One accordion per non-empty group, in catalog order. */
export function settingsAdvancedPages(
  groups: readonly SettingsGroupInput[],
): readonly SettingsGroupPage[] {
  return groups
    .filter((entry) => entry.rows > 0)
    .map((entry) => ({ key: entry.group, group: entry.group, rows: entry.rows }))
}

/** The rows an accordion owns; first-screen controls are never repeated here. */
export function settingsPageControls(page: SettingsGroupPage): readonly SettingsControl[] {
  return settingsControlsOf(page.group).filter((control) => !HOISTED_IDS.has(control.id))
}

/** Is one accordion open? A search hit forces it open. */
export function settingsSectionExpanded(input: {
  readonly open: boolean
  readonly searching: boolean
}): boolean {
  return input.searching || input.open
}

/** One row's searchable text: label, one-sentence hint and config key only. */
export interface SettingsSearchEntry {
  readonly label: string
  readonly hint: string
  readonly keys: readonly string[]
}

/** Case-insensitive substring match; an empty query matches everything. */
export function matchesSettingQuery(entry: SettingsSearchEntry, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  if (entry.label.toLowerCase().includes(needle)) return true
  if (entry.hint.toLowerCase().includes(needle)) return true
  return entry.keys.some((key) => key.toLowerCase().includes(needle))
}

/**
 * The write for one `恢复默认` click: exactly the keys of that one control.
 *
 * Pure, so a test can prove a reset can never touch a neighbouring row.
 */
export function resetPatchFor(
  control: Pick<SettingsControl, 'keys'>,
  defaultValue: ConfigScalar,
): ConfigPatch {
  const patch: Record<string, ConfigScalar> = {}
  for (const key of control.keys) patch[key] = defaultValue
  return patch
}

const QUICK_SWITCHES = settingsQuickSwitches()
const TASK_DEFAULTS = settingsTaskDefaults()
const DISPLAY_SWITCHES = settingsDisplaySwitches()
const ADVANCED_PAGES = settingsAdvancedPages(settingsGroupInputs())
const ADVANCED_ROWS = ADVANCED_PAGES.reduce((count, page) => count + page.rows, 0)

const EMPTY_SEARCH_ENTRY: SettingsSearchEntry = { label: '', hint: '', keys: [] }

/* ------------------------------------------------------------------------- *
 * Row primitives
 * ------------------------------------------------------------------------- */

/** A labelled switch: `role="switch"` plus the input id the row label points at. */
function SwitchControl(props: {
  inputId: string
  label: string
  checked: boolean
  disabled?: boolean
  onChange?: (value: boolean) => void
}): React.ReactElement {
  return React.createElement(MuiSwitch, {
    size: 'small',
    checked: props.checked,
    disabled: props.disabled === true,
    slotProps: {
      input: {
        id: props.inputId,
        role: 'switch',
        'aria-checked': props.checked,
        'aria-label': props.label,
      },
    },
    onChange: (event: { target: { checked: boolean } }) => {
      if (props.onChange !== undefined) props.onChange(event.target.checked)
    },
  })
}

/**
 * A MUI dropdown for one enum value.
 *
 * The displayed text comes from `renderValue` (the same localised label the
 * menu shows), the combobox is named through `labelId` plus `aria-label`, and
 * `value` is always a concrete string: the host value when it is one of the
 * options, the first option otherwise, and the raw value as an extra option
 * when an old host reports something outside the catalog. It therefore never
 * renders uncontrolled and never overflows its row.
 */
function SelectControl(props: {
  inputId: string
  labelId: string
  label: string
  value: string
  options: readonly string[]
  disabled: boolean
  optionLabel: (value: string) => string
  onCommit: (value: string) => void
}): React.ReactElement {
  const options = props.options ?? []
  const current = props.value ?? ''
  // A concrete value even before the catalog lines up; an unknown value stays
  // visible as its own option rather than silently showing the first entry.
  const choices = current.length > 0 && !options.includes(current) ? [current, ...options] : options
  const selected = current.length > 0 ? current : (options[0] ?? '')
  return React.createElement(
    MuiSelect,
    {
      id: props.inputId,
      labelId: props.labelId,
      value: selected,
      size: 'small',
      variant: 'outlined',
      disabled: props.disabled,
      inputProps: { 'aria-label': props.label },
      renderValue: (value: unknown) => props.optionLabel(String(value ?? '')),
      onChange: (event: SelectChangeEvent<unknown>) => {
        props.onCommit(String(event.target.value))
      },
      sx: SELECT_SX,
    },
    ...choices.map((option) => React.createElement(
      MuiMenuItem,
      { key: option, value: option },
      props.optionLabel(option),
    )),
  )
}

/**
 * A MUI number field for a number (turns, milliseconds, bytes, ratios and
 * weights). The inline error is the local parse/min/max check; the host is
 * still the authority and its rejection lands on the row.
 */
function NumberFieldControl(props: {
  inputId: string
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  disabled: boolean
  onCommit: (value: number) => void
  messages: { invalid: string; range: string }
}): React.ReactElement {
  const [draft, setDraft] = React.useState<string>(formatConfigNumber(props.value, props.step))
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    setDraft(formatConfigNumber(props.value, props.step))
    setError(null)
  }, [props.value, props.step])
  const commit = (): void => {
    const trimmed = draft.trim()
    const parsed = Number(trimmed)
    if (trimmed === '' || !Number.isFinite(parsed)) {
      setError(props.messages.invalid)
      setDraft(formatConfigNumber(props.value, props.step))
      return
    }
    const below = props.min !== undefined && parsed < props.min
    const above = props.max !== undefined && parsed > props.max
    if (below || above) {
      setError(props.messages.range)
      setDraft(formatConfigNumber(props.value, props.step))
      return
    }
    if (parsed !== props.value) props.onCommit(parsed)
  }
  return React.createElement(MuiTextField, {
    type: 'number',
    size: 'small',
    variant: 'outlined',
    value: draft,
    disabled: props.disabled,
    error: error !== null,
    helperText: error ?? undefined,
    sx: NUMBER_SX,
    slotProps: {
      htmlInput: {
        id: props.inputId,
        'aria-label': props.label,
        min: props.min,
        max: props.max,
        step: props.step,
      },
    },
    onChange: (event: { target: { value: string } }) => {
      setDraft(event.target.value)
      setError(null)
    },
    onBlur: commit,
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commit()
      }
    },
  })
}

/** A single-line text field (the free-form reasoning-effort value). */
function TextFieldControl(props: {
  inputId: string
  label: string
  value: string
  disabled: boolean
  onCommit: (value: string) => void
}): React.ReactElement {
  const [draft, setDraft] = React.useState(props.value)
  React.useEffect(() => { setDraft(props.value) }, [props.value])
  const commit = (): void => {
    const next = draft.trim()
    if (next.length === 0 || next === props.value) {
      setDraft(props.value)
      return
    }
    props.onCommit(next)
  }
  return React.createElement(MuiTextField, {
    type: 'text',
    size: 'small',
    variant: 'outlined',
    value: draft,
    disabled: props.disabled,
    sx: TEXT_SX,
    slotProps: { htmlInput: { id: props.inputId, 'aria-label': props.label, maxLength: 200 } },
    onChange: (event: { target: { value: string } }) => { setDraft(event.target.value) },
    onBlur: commit,
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commit()
      }
    },
  })
}

/* ------------------------------------------------------------------------- *
 * Value formatting and path helpers — never invent a value
 * ------------------------------------------------------------------------- */

type OptionDomain = 'profession' | 'interaction' | 'scene' | 'validation' | 'command' | 'locale'

/** Which label table an enum control's options use. */
function optionDomain(control: SettingsControl): OptionDomain {
  const key = control.keys[0] ?? ''
  if (key === 'defaults.profession' || key === 'profession.default') return 'profession'
  if (key === 'defaults.interaction') return 'interaction'
  if (key === 'defaults.scene') return 'scene'
  if (key === 'defaults.validation') return 'validation'
  if (key === 'defaults.command') return 'command'
  return 'locale'
}

function optionLabel(copy: Copy, control: SettingsControl, value: string): string {
  const values = copy.settings.catalog.values
  switch (optionDomain(control)) {
    case 'profession':
      return isOneOf(value, ProfessionValues) ? copy.professions[value].label : value
    case 'interaction':
      return isOneOf(value, InteractionValues) ? copy.interactions[value].label : value
    case 'scene':
      return isOneOf(value, SceneValues) ? copy.scenes[value].label : value
    case 'validation':
      return isOneOf(value, ValidationValues) ? copy.validations[value].label : value
    case 'command':
      return isOneOf(value, CommandValues) ? values.commandOptions[value] : value
    case 'locale':
      if (value === 'auto') return copy.settings.values.followHost
      if (value === 'zh-CN') return copy.settings.values.chinese
      if (value === 'en-US') return copy.settings.values.english
      return value
  }
}

/** Human text for a value the host reported. Booleans are on/off in the copy. */
function displayConfigValue(copy: Copy, control: SettingsControl, value: unknown): string {
  if (typeof value === 'boolean') return value ? copy.settings.values.on : copy.settings.values.off
  // Renormalised weights carry float noise (`0.15000000000000002`); the row
  // rounds to the control's own step, never to a hard-coded precision.
  if (typeof value === 'number' && Number.isFinite(value)) return formatConfigNumber(value, control.step)
  if (typeof value === 'string') {
    return control.kind === 'enum' ? optionLabel(copy, control, value) : value
  }
  return copy.settings.values.unavailable
}

/**
 * Is a value different from another value?
 *
 * Numbers compare at the control's own step precision, so the float noise a
 * renormalised weight picks up is not reported as a user change. Everything else
 * is an identity comparison.
 */
function sameScalar(current: unknown, fallback: unknown, control: SettingsControl): boolean {
  if (typeof current === 'number' && typeof fallback === 'number') {
    return formatConfigNumber(current, control.step) === formatConfigNumber(fallback, control.step)
  }
  return Object.is(current, fallback)
}

/**
 * Does this row differ from the host's schema default?
 *
 * Pure and exported so a test can prove which rows `恢复全部默认` would write:
 * only editable host rows whose live value is not the schema default.
 */
export function isModifiedSetting(
  view: { readonly values: unknown; readonly defaults: unknown },
  control: SettingsControl,
): boolean {
  if (control.chip !== 'host' || control.keys.length === 0) return false
  const current = readConfigPath(view.values, control.keys[0] as string)
  const fallback = readConfigPath(view.defaults, control.keys[0] as string)
  if (current === undefined || fallback === undefined) return false
  return !sameScalar(current, fallback, control)
}

/**
 * The write for one `恢复全部默认` click: every changed editable row, and only
 * its default value. Pure, so a test can prove an unchanged row is untouched.
 */
export function resetAllPatchFor(
  view: { readonly values: unknown; readonly defaults: unknown },
  controls: readonly SettingsControl[] = SETTINGS_CONTROLS,
): ConfigPatch {
  const patch: Record<string, ConfigScalar> = {}
  for (const control of controls) {
    if (control.chip !== 'host' || control.keys.length === 0) continue
    if (!isModifiedSetting(view, control)) continue
    const fallback = readConfigPath(view.defaults, control.keys[0] as string)
    if (fallback === undefined) continue
    for (const key of control.keys) patch[key] = fallback as ConfigScalar
  }
  return patch
}

/** Deep-copy the live values so an optimistic update never mutates the host tree. */
function copyValues(values: ConfigValues): ConfigValues {
  return JSON.parse(JSON.stringify(values)) as ConfigValues
}

/** Apply one flat patch to a copy of the values. */
function withPatchValues(values: ConfigValues, patch: ConfigPatch): ConfigValues {
  const copy = copyValues(values)
  for (const [key, value] of Object.entries(patch)) {
    writeConfigPath(copy as unknown as Record<string, unknown>, key, value)
  }
  return copy
}

/** Apply one control's scalar to a copy of the values. */
function withControlValue(view: ConfigView, control: SettingsControl, value: ConfigScalar): ConfigView {
  const values = copyValues(view.values)
  for (const key of control.keys) {
    writeConfigPath(values as unknown as Record<string, unknown>, key, value)
  }
  return { values, defaults: view.defaults }
}

/** Display preference a host interval maps onto (`2 / 5 / 10` seconds). */
function refreshOption(milliseconds: number): number {
  if (milliseconds <= 2000) return 2
  if (milliseconds <= 5000) return 5
  return 10
}

/* ------------------------------------------------------------------------- *
 * Page state
 * ------------------------------------------------------------------------- */

type LoadState = 'loading' | 'ready' | 'offline' | 'unsupported' | 'invalid'

/** The pending confirmation, so one dialog serves both restore actions. */
type Confirmation =
  | { readonly kind: 'one'; readonly control: SettingsControl }
  | { readonly kind: 'all' }

/** One block of the page: a switch row or an accordion body. */
interface SectionBlock {
  readonly key: string
  readonly title: string
  readonly controls: readonly SettingsControl[]
  readonly desc?: string
  readonly helper?: string
  readonly scenePicker?: boolean
  readonly prefixScene?: boolean
  readonly status?: React.ReactNode
}

/**
 * Settings-only type scale.
 *
 * The host settings shell renders its menus at 14px with a 12px minimum; the
 * composer's compact 12px theme must stay untouched, so the page derives its
 * own theme and pins every variant in pixels.
 */
const settingsTheme = createTheme(theme, {
  typography: {
    fontSize: 14,
    body1: { fontSize: 14 },
    body2: { fontSize: 14 },
    subtitle1: { fontSize: 15, fontWeight: 600 },
    subtitle2: { fontSize: 14, fontWeight: 600 },
    caption: { fontSize: 12 },
    h6: { fontSize: 16, fontWeight: 600 },
    button: { fontSize: 13, textTransform: 'none' },
  },
  components: {
    MuiChip: { styleOverrides: { root: { height: 22 }, label: { fontSize: 12 } } },
    MuiFormControlLabel: { styleOverrides: { label: { fontSize: 12 } } },
    MuiInputBase: { styleOverrides: { input: { fontSize: 13 } } },
    MuiTableCell: { styleOverrides: { root: { fontSize: 12 } } },
  },
})

export function CoordinationSettings(): React.ReactElement {
  const copy = useCopy()
  const settings = copy.settings
  const catalog = settings.catalog
  const values = settings.values
  const layout = settings.layout
  const pageCopy = settingsPageCopy(currentLocale())
  const [view, setView] = React.useState<ConfigView | null>(null)
  const [load, setLoad] = React.useState<LoadState>('loading')
  /** Page-level failure line; a single-row refusal stays on its own row. */
  const [writeError, setWriteError] = React.useState<string | null>(null)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  /** True while one immediate POST /config is in flight; inputs stay disabled. */
  const [writing, setWriting] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [openSections, setOpenSections] = React.useState<Record<string, boolean>>({})
  const [activeScene, setActiveScene] = React.useState<Scene>(SceneValues[0])
  const [confirming, setConfirming] = React.useState<Confirmation | null>(null)
  const takeoverOn = React.useSyncExternalStore(takeoverStore.subscribe, takeoverStore.snapshot, takeoverStore.snapshot)
  const workflowOn = React.useSyncExternalStore(workflowStore.subscribe, workflowStore.snapshot, workflowStore.snapshot)
  const feed = React.useSyncExternalStore(subscribeSelectionFeed, selectionFeed, selectionFeed)
  const storageBlocked = localSettingsBlocked()

  const refresh = React.useCallback((): void => {
    setLoad('loading')
    setErrors({})
    setWriteError(null)
    setConfirming(null)
    void (async () => {
      const outcome = await loadConfig()
      if (outcome.config === null) {
        setView(null)
        setLoad(outcome.unsupported ? 'unsupported' : outcome.reached ? 'invalid' : 'offline')
        return
      }
      setView(outcome.config)
      setLoad('ready')
      // Adopt the host display defaults only while the operator has never
      // chosen locally; an explicit local choice keeps priority.
      compactStore.adopt(outcome.config.values.ui.compact)
      tooltipsStore.adopt(outcome.config.values.ui.showTooltip)
      refreshStore.adopt(refreshOption(outcome.config.values.ui.refreshInterval))
    })()
  }, [])

  React.useEffect(() => { refresh() }, [refresh])

  /* ---- Values, comparison and immediate writes -------------------------- */

  const valueOf = (source: ConfigValues | null, control: SettingsControl): unknown =>
    source === null || control.keys.length === 0
      ? undefined
      : readConfigPath(source, control.keys[0] as string)

  /** Does this row differ from the host's schema default? */
  const modifiedOf = (control: SettingsControl): boolean =>
    view === null ? false : isModifiedSetting(view, control)

  const defaultValueOf = (control: SettingsControl): unknown =>
    view === null ? undefined : valueOf(view.defaults, control)

  /** Clear one row's inline error; an absent entry keeps the same object. */
  const clearError = (id: string): void => {
    setErrors((current) => {
      if (!(id in current)) return current
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  /**
   * Push display controls into the local stores after the host confirms them,
   * so the composer reflects the change without waiting for a remount.
   */
  const previewLocal = (controls: readonly SettingsControl[], config: ConfigView): void => {
    for (const control of controls) {
      if (control.keys.includes('ui.showTooltip')) setTooltips(config.values.ui.showTooltip)
      if (control.keys.includes('ui.compact')) setCompact(config.values.ui.compact)
      if (control.keys.includes('ui.refreshInterval')) {
        setRefreshSeconds(refreshOption(config.values.ui.refreshInterval))
      }
    }
  }

  /** One line explaining a refused write; the caller has already rolled back. */
  const failureReason = (outcome: ConfigSaveOutcome, all: boolean): string => {
    if (outcome.unsupported) return settings.states.configUnsupported
    if (!outcome.reached) return all ? pageCopy.restoreAllOffline : pageCopy.writeOffline
    if (outcome.code === 'INVALID_ARGUMENT') return copy.errors.INVALID_ARGUMENT
    return all ? pageCopy.restoreAllRejected : pageCopy.writeRejected
  }

  /**
   * Send one patch immediately and reconcile the page with the host's answer.
   *
   * `rollback` restores exactly what the operator saw before the optimistic
   * update: one row for a row edit, the whole value tree for a restore-all.
   */
  const writePatch = (
    patch: ConfigPatch,
    targets: readonly SettingsControl[],
    rollback: () => void,
  ): void => {
    if (writing) return
    setWriting(true)
    setWriteError(null)
    for (const control of targets) clearError(control.id)
    void (async () => {
      const outcome = await saveConfig(patch)
      setWriting(false)
      if (outcome.config === null) {
        rollback()
        const reason = failureReason(outcome, targets.length > 1)
        if (targets.length === 1) {
          setErrors((current) => ({ ...current, [targets[0].id]: reason }))
        } else {
          setWriteError(reason)
        }
        return
      }
      setView(outcome.config)
      previewLocal(targets, outcome.config)
    })()
  }

  /** One row edit: optimistic update, POST, and a row-level rollback on refusal. */
  const commitControl = (control: SettingsControl, value: ConfigScalar): void => {
    if (control.local === 'takeover') {
      setTakeover(value === true)
      return
    }
    if (control.local === 'workflow') {
      setWorkflow(value === true)
      return
    }
    if (view === null || load !== 'ready' || control.keys.length === 0 || writing) return
    const previous = valueOf(view.values, control)
    if (previous === undefined) return
    setView(withControlValue(view, control, value))
    setWriteError(null)
    writePatch(resetPatchFor(control, value), [control], () => {
      setView((current) => (current === null
        ? current
        : withControlValue(current, control, previous as ConfigScalar)))
    })
  }

  /** Restore one row's schema default immediately. The confirm dialog calls it. */
  const resetControl = (control: SettingsControl): void => {
    if (view === null || load !== 'ready' || writing) return
    const fallback = defaultValueOf(control)
    if (fallback === undefined) return
    const previous = view.values
    const patch = resetPatchFor(control, fallback as ConfigScalar)
    setView(withControlValue(view, control, fallback as ConfigScalar))
    setWriteError(null)
    writePatch(patch, [control], () => {
      setView((current) => (current === null
        ? current
        : { values: copyValues(previous), defaults: current.defaults }))
    })
  }

  /** Restore every changed editable row immediately. */
  const resetAll = (): void => {
    if (view === null || load !== 'ready' || writing) return
    const targets = SETTINGS_CONTROLS.filter(modifiedOf)
    const patch = resetAllPatchFor(view, targets)
    if (targets.length === 0 || Object.keys(patch).length === 0) return
    const previous = view.values
    setView({ values: withPatchValues(view.values, patch), defaults: view.defaults })
    setWriteError(null)
    writePatch(patch, targets, () => {
      setView((current) => (current === null
        ? current
        : { values: copyValues(previous), defaults: current.defaults }))
    })
  }

  const modifiedControls = SETTINGS_CONTROLS.filter(modifiedOf)
  const modifiedCount = modifiedControls.length

  const applyConfirmation = (): void => {
    const pending = confirming
    setConfirming(null)
    if (pending === null || writing) return
    if (pending.kind === 'one') resetControl(pending.control)
    else resetAll()
  }

  const toggleSection = (key: string): void => {
    setOpenSections((current) => ({ ...current, [key]: !current[key] }))
  }

  /**
   * Copy for one row.
   *
   * A row listed in `QUICK_SWITCH_COPY` uses the page's own words (the shared
   * catalog row may borrow another row's copy id); every other row falls back
   * to the shared catalog and only uses the control id when no copy exists.
   */
  const fieldCopyOf = (control: SettingsControl): { readonly label: string; readonly hint: string } => {
    const override = quickSwitchCopyFor(control.id, pageCopy)
    if (override !== undefined) return { label: override.label, hint: override.hint }
    return settingsControlCopy(settings, control.copy) ?? { label: control.id, hint: '' }
  }

  /* ---- Search ----------------------------------------------------------- */

  /**
   * One searchable entry per row. Built from the label, the hint and the config
   * keys only, so a group title never keeps a row alive after a query.
   */
  const searchEntries = React.useMemo(() => {
    const index = new Map<string, SettingsSearchEntry>()
    for (const control of SETTINGS_CONTROLS) {
      const field = fieldCopyOf(control)
      const sceneLabel = control.scene === undefined ? '' : copy.scenes[control.scene].label
      const label = field.label
      index.set(control.id, {
        label: sceneLabel === '' ? label : `${sceneLabel} · ${label}`,
        hint: field.hint,
        keys: control.keys,
      })
    }
    return index
  }, [settings, copy.scenes, pageCopy])

  const queryText = query.trim()
  const searching = queryText.length > 0
  const matches = (control: SettingsControl): boolean =>
    !searching || matchesSettingQuery(searchEntries.get(control.id) ?? EMPTY_SEARCH_ENTRY, query)

  const matchingQuick = QUICK_SWITCHES.filter(matches)
  const matchingDefaults = TASK_DEFAULTS.filter(matches)
  const matchingDisplay = DISPLAY_SWITCHES.filter(matches)
  const matchingAdvanced = ADVANCED_PAGES.filter((page) => settingsPageControls(page).some(matches))
  const totalMatches = matchingQuick.length
    + matchingDefaults.length
    + matchingDisplay.length
    + matchingAdvanced.reduce(
      (count, page) => count + settingsPageControls(page).filter(matches).length,
      0,
    )
  const advancedVisibleRows = searching
    ? matchingAdvanced.reduce((count, page) => count + settingsPageControls(page).filter(matches).length, 0)
    : ADVANCED_ROWS
  const advancedVisibleGroups = searching ? matchingAdvanced.length : ADVANCED_PAGES.length

  const groupTitle = (page: SettingsGroupPage): string => {
    const title = catalog.groups[page.group].title
    return page.group === 'scenes' ? `${title} · ${pageCopy.sceneAll}` : title
  }

  /* ---- Rows ------------------------------------------------------------- */

  const badgeOf = (control: SettingsControl): string | null => {
    if (control.chip === 'readOnly' || control.chip === 'forced') return catalog.values.chips.readOnly
    if (control.chip === 'local') return catalog.values.chips.local
    if (control.chip === 'planned') return catalog.values.chips.planned
    return null
  }

  /** Tooltip text: key, default, range and the stored-but-unread caveat. */
  const metaOf = (control: SettingsControl, fallback: unknown): string => {
    const parts: string[] = []
    if (control.keys.length > 0) parts.push(control.keys.join(', '))
    if (fallback !== undefined) {
      parts.push(`${catalog.values.defaultValue} ${displayConfigValue(copy, control, fallback)}`)
    }
    if (control.kind === 'number' && (control.min !== undefined || control.max !== undefined)) {
      parts.push(`${control.min ?? '−∞'}–${control.max ?? '∞'}`)
    }
    if (control.wired === false && control.derived !== true) parts.push(catalog.values.notWired)
    return parts.join(' · ')
  }

  const labelOf = (control: SettingsControl): string => {
    const label = fieldCopyOf(control).label
    return control.scene === undefined ? label : `${copy.scenes[control.scene].label} · ${label}`
  }

  /** A derived row's text value (never a config value it did not read). */
  const derivedText = (control: SettingsControl): string => {
    switch (control.id) {
      case 'setting:derived.currentLocale':
        return currentLocale() === 'en-US' ? values.english : values.chinese
      case 'setting:derived.takeoverControl':
        return takeoverOn ? values.pluginPermission : values.hostAccessMode
      case 'setting:derived.permissionCatalog':
        return feed.state === null ? values.unavailable : values.dshCatalog
      case 'setting:policy.writingFlow':
        return values.writingFlow
      case 'setting:local.takeoverPermission':
        return takeoverOn ? values.on : values.off
      case 'setting:local.composerWorkflow':
        return workflowOn ? values.on : values.off
      default:
        return values.unavailable
    }
  }

  /** The input for one control; the final fallback is a read-only value. */
  const renderInput = (control: SettingsControl, label: string): React.ReactNode => {
    const inputId = `${control.id}:input`
    const rawValue = valueOf(view === null ? null : view.values, control)
    const editable = control.chip === 'host' && control.keys.length > 0 && load === 'ready'
    const disabled = !editable || writing

    if (control.local !== undefined) {
      const checked = control.local === 'takeover' ? takeoverOn : workflowOn
      return React.createElement(SwitchControl, {
        inputId,
        label,
        checked,
        onChange: (next: boolean) => { commitControl(control, next) },
      })
    }
    if (editable && control.kind === 'boolean' && rawValue !== undefined) {
      return React.createElement(SwitchControl, {
        inputId,
        label,
        checked: rawValue === true,
        disabled,
        onChange: (next: boolean) => { commitControl(control, next) },
      })
    }
    if (editable && control.kind === 'enum' && typeof rawValue === 'string') {
      return React.createElement(SelectControl, {
        inputId,
        labelId: `${control.id}:label`,
        label,
        value: rawValue,
        options: control.options ?? [],
        disabled,
        optionLabel: (option: string) => optionLabel(copy, control, option),
        onCommit: (next: string) => { commitControl(control, next) },
      })
    }
    if (editable && control.kind === 'number' && typeof rawValue === 'number') {
      return React.createElement(NumberFieldControl, {
        inputId,
        label,
        value: rawValue,
        ...(control.min === undefined ? {} : { min: control.min }),
        ...(control.max === undefined ? {} : { max: control.max }),
        ...(control.step === undefined ? {} : { step: control.step }),
        disabled,
        onCommit: (next: number) => { commitControl(control, next) },
        messages: { invalid: catalog.values.invalidNumber, range: catalog.values.outOfRange },
      })
    }
    if (editable && control.kind === 'text' && typeof rawValue === 'string') {
      return React.createElement(TextFieldControl, {
        inputId,
        label,
        value: rawValue,
        disabled,
        onCommit: (next: string) => { commitControl(control, next) },
      })
    }
    if (rawValue !== undefined) {
      return React.createElement(
        MuiTypography,
        { variant: 'body2', color: 'text.secondary', sx: VALUE_SX },
        displayConfigValue(copy, control, rawValue),
      )
    }
    return React.createElement(
      MuiTypography,
      { variant: 'body2', color: 'text.secondary', sx: VALUE_SX },
      control.derived === true ? derivedText(control) : values.unavailable,
    )
  }

  /** One compact row: label + hint + control, tooltip for the key and range. */
  const renderRow = (control: SettingsControl, prefixScene: boolean): React.ReactElement => {
    const field = fieldCopyOf(control)
    const inputId = `${control.id}:input`
    const editable = control.chip === 'host' && control.keys.length > 0 && load === 'ready'
    // A MUI Select is a combobox div, so its visible label is a plain span and
    // the accessible name comes from the select's labelId/aria-label pair.
    const labelled = control.local !== undefined || (editable && control.kind !== 'enum')
    const fallback = defaultValueOf(control)
    const modified = modifiedOf(control)
    const badge = badgeOf(control)
    const displayLabel = prefixScene && control.scene !== undefined
      ? `${copy.scenes[control.scene].label} · ${field.label}`
      : field.label
    const resetValue = fallback === undefined ? values.unavailable : displayConfigValue(copy, control, fallback)
    const resetLabel = fillTemplate(layout.resetTo, { value: resetValue })
    return React.createElement(
      'div',
      {
        key: control.id,
        id: control.id,
        'data-setting': control.id,
        'data-config-key': control.keys.join(','),
        'data-control-type': control.kind,
        'data-control-copy': control.copy,
        'data-control-chip': control.chip,
        role: 'group',
        'aria-labelledby': `${control.id}:label`,
        style: ROW_STYLE,
      },
      React.createElement(
        'div',
        { style: ROW_MAIN_STYLE },
        React.createElement(
          'div',
          { style: ROW_TEXT_STYLE },
          React.createElement(
            'div',
            { style: ROW_LABEL_LINE_STYLE },
            React.createElement(
              MuiTypography,
              {
                id: `${control.id}:label`,
                component: labelled ? 'label' : 'span',
                ...(labelled ? { htmlFor: inputId } : {}),
                variant: 'body2',
                sx: LABEL_SX,
                title: metaOf(control, fallback),
              },
              displayLabel,
            ),
            badge === null
              ? null
              : React.createElement(MuiChip, { size: 'small', variant: 'outlined', label: badge, sx: BADGE_SX }),
            control.wired === false && control.derived !== true
              ? React.createElement(
                MuiTooltip,
                { title: pageCopy.notAppliedTitle },
                React.createElement(MuiChip, {
                  size: 'small',
                  variant: 'outlined',
                  color: 'warning',
                  label: pageCopy.notApplied,
                  sx: BADGE_SX,
                }),
              )
              : null,
          ),
          field.hint.length === 0
            ? null
            : React.createElement(
              MuiTypography,
              { variant: 'caption', color: 'text.secondary', component: 'p', sx: HINT_SX },
              field.hint,
            ),
        ),
        React.createElement(
          'div',
          { style: ROW_CONTROL_STYLE },
          renderInput(control, labelOf(control)),
          modified && editable && !writing
            ? React.createElement(
              MuiTooltip,
              { title: layout.reset },
              React.createElement(
                MuiIconButton,
                {
                  size: 'small',
                  'aria-label': resetLabel,
                  onClick: () => { setConfirming({ kind: 'one', control }) },
                },
                React.createElement(MuiRestartIcon, { fontSize: 'small' }),
              ),
            )
            : null,
        ),
      ),
      errors[control.id] === undefined
        ? null
        : React.createElement(
          MuiTypography,
          { role: 'alert', variant: 'caption', color: 'error', component: 'p', sx: ROW_ERROR_SX },
          errors[control.id],
        ),
    )
  }

  /** The first screen's three switches: always visible, never an accordion. */
  const renderQuick = (controls: readonly SettingsControl[]): React.ReactElement | null => {
    if (controls.length === 0) return null
    return React.createElement(
      'section',
      {
        key: 'quick-switches',
        'data-settings-page': 'quick-switches',
        'aria-labelledby': 'settings-quick-title',
        style: QUICK_SECTION_STYLE,
      },
      React.createElement(
        'div',
        { style: SECTION_HEAD_STYLE },
        React.createElement(
          MuiTypography,
          { id: 'settings-quick-title', variant: 'subtitle1', component: 'h3', sx: SECTION_TITLE_SX },
          pageCopy.quickTitle,
        ),
        React.createElement(
          MuiTypography,
          { variant: 'caption', color: 'text.secondary', sx: SECTION_COUNT_SX },
          fillTemplate(layout.items, { count: String(controls.length) }),
        ),
      ),
      ...controls.map((control) => renderRow(control, false)),
    )
  }

  /** One accordion; its body is not mounted while closed. */
  const renderSection = (block: SectionBlock): React.ReactElement => {
    const expanded = settingsSectionExpanded({ open: openSections[block.key] === true, searching })
    return React.createElement(
      MuiAccordion,
      {
        key: block.key,
        'data-settings-page': block.key,
        expanded,
        onChange: () => { if (!searching) toggleSection(block.key) },
        disableGutters: true,
        elevation: 0,
        sx: SETTINGS_ACCORDION_SX,
      },
      React.createElement(
        MuiAccordionSummary,
        {
          expandIcon: React.createElement(MuiExpandIcon, { fontSize: 'small' }),
          'aria-controls': `settings-acc-body:${block.key}`,
          id: `settings-acc-head:${block.key}`,
          sx: SETTINGS_SUMMARY_SX,
        },
        React.createElement(
          MuiTypography,
          { variant: 'subtitle2', component: 'span', sx: SECTION_TITLE_SX },
          block.title,
        ),
        React.createElement(
          MuiTypography,
          { variant: 'caption', color: 'text.secondary', sx: SECTION_COUNT_SX },
          fillTemplate(layout.items, { count: String(block.controls.length) }),
        ),
      ),
      expanded
        ? React.createElement(
          MuiAccordionDetails,
          { id: `settings-acc-body:${block.key}`, 'data-settings-body': block.key, sx: SETTINGS_DETAILS_SX },
          !searching && block.desc !== undefined
            ? React.createElement(
              MuiTypography,
              { variant: 'caption', color: 'text.secondary', component: 'p', sx: SECTION_DESC_SX },
              block.desc,
            )
            : null,
          !searching && block.helper !== undefined
            ? React.createElement(
              MuiTypography,
              { variant: 'caption', color: 'text.secondary', component: 'p', sx: SECTION_HELPER_SX },
              block.helper,
            )
            : null,
          !searching && block.scenePicker === true
            ? React.createElement(ScenePicker, {
              scene: activeScene,
              label: catalog.values.scene,
              optionLabel: (scene: Scene) => copy.scenes[scene].label,
              onChange: (scene: Scene) => { setActiveScene(scene) },
            })
            : null,
          ...block.controls.map((control) => renderRow(control, block.prefixScene === true)),
          block.status === undefined ? null : block.status,
        )
        : null,
    )
  }

  /** One catalog group's accordion; the scene page keeps a scene picker. */
  const renderGroup = (page: SettingsGroupPage): React.ReactElement => {
    const all = settingsPageControls(page)
    const controls = searching
      ? all.filter(matches)
      : page.group === 'scenes'
        ? settingsSceneControls(activeScene)
        : all
    return renderSection({
      key: page.key,
      title: groupTitle(page),
      controls,
      desc: catalog.groups[page.group].desc,
      helper: catalog.groups[page.group].helper,
      scenePicker: page.group === 'scenes',
      prefixScene: searching,
      status: page.group === 'profession' && feed.state !== null && feed.state.locked
        ? React.createElement(
          MuiTypography,
          { role: 'status', variant: 'caption', color: 'warning.main', component: 'p', sx: { m: 0, mt: 0.5 } },
          settings.states.settingsLocked,
        )
        : null,
    })
  }

  const renderAdvancedHeading = (): React.ReactElement => React.createElement(
    'div',
    { style: ADVANCED_HEADING_STYLE },
    React.createElement(
      MuiTypography,
      { variant: 'caption', color: 'text.secondary', component: 'h3', sx: ADVANCED_TITLE_SX },
      pageCopy.advanced,
    ),
    React.createElement(
      MuiTypography,
      { variant: 'caption', color: 'text.secondary', sx: { flex: 'none' } },
      fillTemplate(pageCopy.advancedCount, {
        groups: String(advancedVisibleGroups),
        rows: String(advancedVisibleRows),
      }),
    ),
  )

  /** Closed accordions by default: the page opens as three switches + headers. */
  const renderBrowse = (): React.ReactElement => React.createElement(
    React.Fragment,
    null,
    renderQuick(QUICK_SWITCHES),
    renderSection({
      key: 'task-defaults',
      title: pageCopy.defaultsTitle,
      controls: TASK_DEFAULTS,
    }),
    renderSection({
      key: 'display-switches',
      title: pageCopy.displayTitle,
      controls: DISPLAY_SWITCHES,
    }),
    renderAdvancedHeading(),
    ...ADVANCED_PAGES.map(renderGroup),
  )

  /** Search renders every hit open; an empty query never renders a shell. */
  const renderSearch = (): React.ReactElement => {
    if (totalMatches === 0) {
      return React.createElement(
        'div',
        { role: 'status', style: EMPTY_STYLE },
        React.createElement(
          MuiTypography,
          { variant: 'body2', color: 'text.secondary', component: 'p', sx: { m: 0 } },
          layout.noResults,
        ),
        React.createElement(
          MuiButton,
          { size: 'small', variant: 'outlined', onClick: () => { setQuery('') } },
          layout.clearSearch,
        ),
      )
    }
    return React.createElement(
      React.Fragment,
      null,
      renderQuick(matchingQuick),
      matchingDefaults.length === 0
        ? null
        : renderSection({
          key: 'task-defaults',
          title: pageCopy.defaultsTitle,
          controls: matchingDefaults,
        }),
      matchingDisplay.length === 0
        ? null
        : renderSection({
          key: 'display-switches',
          title: pageCopy.displayTitle,
          controls: matchingDisplay,
        }),
      matchingAdvanced.length === 0
        ? null
        : React.createElement(
          React.Fragment,
          null,
          renderAdvancedHeading(),
          ...matchingAdvanced.map(renderGroup),
        ),
    )
  }

  /* ---- Chrome ----------------------------------------------------------- */

  const statusChip = load === 'ready'
    ? values.connected
    : load === 'loading'
      ? values.loading
      : values.disconnected
  const banner = load === 'offline'
    ? settings.states.offline
    : load === 'unsupported'
      ? settings.states.configUnsupported
      : load === 'invalid'
        ? catalog.values.loadFailed
        : null
  const aboutSummary = fillTemplate(pageCopy.aboutSummary, {
    version: ABOUT.version,
    dependencies: String(ABOUT.dependencies.length),
    tooling: String(ABOUT.tooling.length),
  })
  const referencesSummary = fillTemplate(pageCopy.referencesSummary, { count: String(ABOUT.references.length) })
  const authorSummary = fillTemplate(pageCopy.authorSummary, { name: ABOUT.author.name })

  const dialog = ((): React.ReactElement => {
    const one = confirming !== null && confirming.kind === 'one' ? confirming.control : null
    const title = one !== null ? pageCopy.restoreOneTitle : pageCopy.restoreAllTitle
    const body = one !== null
      ? fillTemplate(pageCopy.restoreOneBody, {
        label: labelOf(one),
        value: defaultValueOf(one) === undefined
          ? values.unavailable
          : displayConfigValue(copy, one, defaultValueOf(one)),
      })
      : fillTemplate(pageCopy.restoreAllBody, { count: String(modifiedCount) })
    return React.createElement(
      MuiDialog,
      {
        open: confirming !== null,
        onClose: () => { setConfirming(null) },
        maxWidth: 'xs',
        fullWidth: true,
        'aria-labelledby': 'settings-confirm-title',
      },
      React.createElement(MuiDialogTitle, { id: 'settings-confirm-title' }, title),
      React.createElement(
        MuiDialogContent,
        null,
        React.createElement(MuiDialogContentText, null, body),
      ),
      React.createElement(
        MuiDialogActions,
        null,
        React.createElement(
          MuiButton,
          { size: 'small', onClick: () => { setConfirming(null) } },
          pageCopy.cancel,
        ),
        React.createElement(
          MuiButton,
          {
            size: 'small',
            variant: 'contained',
            onClick: applyConfirmation,
            disabled: writing,
          },
          pageCopy.confirmRestore,
        ),
      ),
    )
  })()

  return React.createElement(
    ThemeProvider,
    { theme: settingsTheme },
    React.createElement(
      'section',
      { style: SECTION_STYLE },
      React.createElement(
        'div',
        { style: HEADER_STYLE },
        React.createElement(MuiTypography, { variant: 'h6', component: 'h2', sx: { m: 0 } }, settings.title),
        React.createElement(MuiChip, {
          size: 'small',
          variant: 'outlined',
          color: load === 'ready' ? 'success' : 'default',
          label: statusChip,
        }),
        React.createElement(
          MuiTooltip,
          { title: pageCopy.applyHint, placement: 'bottom' },
          React.createElement(
            'button',
            { type: 'button', 'aria-label': pageCopy.applyHint, style: INFO_BUTTON_STYLE },
            React.createElement(MuiInfoIcon, { fontSize: 'small' }),
          ),
        ),
      ),
      React.createElement(
        MuiTypography,
        { variant: 'body2', color: 'text.secondary', component: 'p', sx: INTRO_SX },
        settings.intro,
      ),
      banner === null
        ? null
        : React.createElement(
          'div',
          { role: 'status', style: BANNER_STYLE },
          React.createElement(MuiTypography, { variant: 'caption', color: 'warning.main' }, banner),
          React.createElement(MuiButton, { size: 'small', variant: 'outlined', onClick: refresh }, catalog.values.retry),
        ),
      load === 'loading'
        ? React.createElement(
          MuiTypography,
          { variant: 'caption', role: 'status', component: 'p', sx: { m: 0 } },
          settings.states.loading,
        )
        : null,
      storageBlocked
        ? React.createElement(
          MuiTypography,
          { variant: 'caption', color: 'warning.main', role: 'status', component: 'p', sx: { m: 0 } },
          settings.states.storageBlocked,
        )
        : null,
      writeError === null
        ? null
        : React.createElement(
          MuiTypography,
          { variant: 'caption', color: 'error', role: 'alert', component: 'p', sx: { m: 0 } },
          writeError,
        ),
      React.createElement(
        'div',
        { style: TOOLBAR_STYLE },
        React.createElement(MuiTextField, {
          size: 'small',
          type: 'text',
          value: query,
          placeholder: layout.searchPlaceholder,
          sx: SEARCH_SX,
          slotProps: {
            htmlInput: { id: 'settings-search', 'aria-label': layout.search },
            input: {
              startAdornment: React.createElement(
                MuiInputAdornment,
                { position: 'start' },
                React.createElement(MuiSearchIcon, { fontSize: 'small' }),
              ),
              endAdornment: query.length === 0
                ? null
                : React.createElement(
                  MuiInputAdornment,
                  { position: 'end' },
                  React.createElement(
                    MuiIconButton,
                    {
                      size: 'small',
                      'aria-label': layout.clearSearch,
                      title: layout.clearSearch,
                      onClick: () => { setQuery('') },
                    },
                    React.createElement(MuiCloseIcon, { fontSize: 'small' }),
                  ),
                ),
            },
          },
          onChange: (event: { target: { value: string } }) => { setQuery(event.target.value) },
          onKeyDown: (event: { key: string }) => {
            if (event.key === 'Escape') setQuery('')
          },
        }),
        searching
          ? React.createElement(
            MuiTypography,
            { variant: 'caption', color: 'text.secondary', role: 'status', sx: MATCH_SX },
            fillTemplate(layout.matches, { count: String(totalMatches) }),
          )
          : null,
        React.createElement(
          MuiButton,
          {
            size: 'small',
            onClick: () => { setConfirming({ kind: 'all' }) },
            disabled: view === null || load !== 'ready' || modifiedCount === 0 || writing,
            sx: BULK_BUTTON_SX,
          },
          pageCopy.restoreAll,
        ),
      ),
      React.createElement(
        'div',
        { style: CONTENT_STYLE },
        searching ? renderSearch() : renderBrowse(),
      ),
      React.createElement(
        MuiTypography,
        { variant: 'caption', color: 'text.secondary', component: 'p', sx: { m: 0 } },
        pageCopy.footer,
      ),
      React.createElement(AboutAccordion, { copy, summary: aboutSummary }),
      React.createElement(ReferencesAccordion, { copy, summary: referencesSummary }),
      React.createElement(AuthorAccordion, { copy, summary: authorSummary }),
      dialog,
    ),
  )
}

/**
 * The scene picker: a MUI dropdown whose value is always one of `SceneValues`.
 *
 * The visible scene name and every menu entry come from `renderValue` /
 * `optionLabel`, so the picker follows the locale even though the wire value
 * stays canonical. The label owns the id `settings-scene:label`, which is the
 * select's accessible name alongside its `aria-label`.
 */
function ScenePicker(props: {
  scene: Scene
  label: string
  optionLabel: (scene: Scene) => string
  onChange: (scene: Scene) => void
}): React.ReactElement {
  const selected = isOneOf(props.scene, SceneValues) ? props.scene : SceneValues[0]
  return React.createElement(
    'div',
    { style: PICKER_ROW_STYLE },
    React.createElement(
      MuiTypography,
      {
        id: 'settings-scene:label',
        variant: 'caption',
        color: 'text.secondary',
        component: 'span',
      },
      props.label,
    ),
    React.createElement(
      MuiSelect,
      {
        id: 'settings-scene',
        labelId: 'settings-scene:label',
        value: selected,
        size: 'small',
        variant: 'outlined',
        inputProps: { 'aria-label': props.label },
        renderValue: (value: unknown) => {
          const text = String(value ?? '')
          return props.optionLabel(isOneOf(text, SceneValues) ? text : selected)
        },
        onChange: (event: SelectChangeEvent<unknown>) => {
          const next = String(event.target.value)
          if (isOneOf(next, SceneValues)) props.onChange(next)
        },
        sx: SCENE_SELECT_SX,
      },
      ...SceneValues.map((scene) => React.createElement(
        MuiMenuItem,
        { key: scene, value: scene },
        props.optionLabel(scene),
      )),
    ),
  )
}

/* ------------------------------------------------------------------------- *
 * About / References / Author — the read-only page tail
 * ------------------------------------------------------------------------- */

/**
 * One citation line: authors, year, title and venue from the template.
 *
 * Exported so a test can prove every `ABOUT.references` entry renders without a
 * missing author, year or venue — the tail has to stay accurate, not decorative.
 */
export function referenceLine(template: string, reference: AboutReference): string {
  return fillTemplate(template, {
    authors: reference.authors,
    year: String(reference.year),
    title: reference.title,
    venue: reference.venue,
  })
}

/** One collapsed section whose body is static data; no input is ever built. */
function SectionAccordion(props: {
  title: string
  summary: string
  children?: React.ReactNode
}): React.ReactElement {
  // A React element is not iterable: spreading `props.children` directly throws
  // "Spread syntax requires ...iterable" when a caller passes exactly one child.
  // `Children.toArray` normalises one child, many children and none.
  const children = React.Children.toArray(props.children)
  return React.createElement(
    MuiAccordion,
    { defaultExpanded: false, disableGutters: true, elevation: 0, sx: ACCORDION_SX },
    React.createElement(
      MuiAccordionSummary,
      { expandIcon: React.createElement(MuiExpandIcon, { fontSize: 'small' }), sx: SUMMARY_SX },
      React.createElement(MuiTypography, { variant: 'subtitle2', component: 'h3', sx: SUMMARY_TITLE_SX }, props.title),
      React.createElement(
        MuiTypography,
        { variant: 'caption', color: 'text.secondary', sx: SUMMARY_COUNT_SX },
        props.summary,
      ),
    ),
    React.createElement(
      MuiAccordionDetails,
      { sx: DETAILS_SX },
      React.createElement('div', { style: PAGE_TAIL_STACK_STYLE }, ...children),
    ),
  )
}

/** Label for one dependency scope (runtime / development / peer). */
function scopeLabel(copy: Copy, scope: AboutDependency['scope']): string {
  if (scope === 'runtime') return copy.about.scopeRuntime
  if (scope === 'development') return copy.about.scopeDevelopment
  return copy.about.scopePeer
}

/** One static dependency or tooling table; same cell styles as everywhere else. */
function AboutTable(props: {
  label: string
  copy: Copy
  rows: readonly AboutDependency[]
}): React.ReactElement {
  const about = props.copy.about
  return React.createElement(
    MuiTable,
    { size: 'small', 'aria-label': props.label },
    React.createElement(
      MuiTableHead,
      null,
      React.createElement(
        MuiTableRow,
        null,
        React.createElement(MuiTableCell, { sx: TABLE_HEAD_SX }, about.package),
        React.createElement(MuiTableCell, { sx: TABLE_HEAD_SX }, about.version),
        React.createElement(MuiTableCell, { sx: TABLE_HEAD_SX }, about.scope),
        React.createElement(MuiTableCell, { sx: TABLE_HEAD_SX }, about.purpose),
      ),
    ),
    React.createElement(
      MuiTableBody,
      null,
      ...props.rows.map((row) => React.createElement(
        MuiTableRow,
        { key: row.name, 'data-about-dependency': row.name },
        React.createElement(
          MuiTableCell,
          { sx: TABLE_CELL_SX },
          React.createElement(MuiTypography, { variant: 'caption', component: 'div' }, row.name),
          React.createElement(MuiTypography, { variant: 'caption', color: 'text.secondary', component: 'div' }, row.role),
        ),
        React.createElement(
          MuiTableCell,
          { sx: TABLE_CELL_SX },
          React.createElement(MuiTypography, { variant: 'caption' }, row.version),
        ),
        React.createElement(
          MuiTableCell,
          { sx: TABLE_CELL_SX },
          React.createElement(MuiTypography, { variant: 'caption' }, scopeLabel(props.copy, row.scope)),
        ),
        React.createElement(
          MuiTableCell,
          { sx: TABLE_CELL_SX },
          React.createElement(MuiTypography, { variant: 'caption' }, row.reason),
        ),
      )),
    ),
  )
}

/** Project metadata plus the dependency and tooling inventories. */
function AboutAccordion(props: { copy: Copy; summary: string }): React.ReactElement {
  const about = props.copy.about
  return React.createElement(
    SectionAccordion,
    { title: about.title, summary: props.summary },
    React.createElement(MuiTypography, { variant: 'subtitle2', component: 'p', sx: { m: 0 } }, ABOUT.name),
    React.createElement(
      MuiTypography,
      { variant: 'caption', color: 'text.secondary', component: 'p', sx: { m: 0 } },
      ABOUT.summary,
    ),
    React.createElement(MuiTypography, { variant: 'body2', component: 'p', sx: { m: 0 } }, `${about.version}: ${ABOUT.version}`),
    React.createElement(MuiTypography, { variant: 'body2', component: 'p', sx: { m: 0 } }, `${about.license}: ${ABOUT.license}`),
    React.createElement(MuiTypography, { variant: 'body2', component: 'p', sx: { m: 0 } }, `${about.runtime}: ${ABOUT.runtime}`),
    React.createElement(MuiTypography, { variant: 'subtitle2', component: 'h4', sx: { m: 0, mt: 1 } }, about.dependencies),
    React.createElement(AboutTable, { label: about.dependencies, copy: props.copy, rows: ABOUT.dependencies }),
    React.createElement(MuiTypography, { variant: 'subtitle2', component: 'h4', sx: { m: 0, mt: 1 } }, about.tooling),
    React.createElement(AboutTable, { label: about.tooling, copy: props.copy, rows: ABOUT.tooling }),
  )
}

/** Every citation, one read-only block each; URLs render as external links. */
function ReferencesAccordion(props: { copy: Copy; summary: string }): React.ReactElement {
  const about = props.copy.about
  return React.createElement(
    SectionAccordion,
    { title: props.copy.references.title, summary: props.summary },
    React.createElement(
      MuiList,
      { dense: true, disablePadding: true, component: 'div' },
      ...ABOUT.references.map((reference) => React.createElement(
        MuiListItem,
        { key: reference.id, component: 'div', disableGutters: true, sx: { display: 'block', py: 0.5, px: 0 } },
        React.createElement(
          MuiTypography,
          { variant: 'caption', component: 'p', sx: { m: 0 } },
          referenceLine(about.referenceItem, reference),
          reference.url === undefined ? null : ' ',
          reference.url === undefined
            ? null
            : React.createElement(
              MuiLink,
              {
                href: reference.url,
                target: '_blank',
                rel: 'noreferrer',
                variant: 'caption',
                sx: { wordBreak: 'break-all' },
              },
              reference.url,
            ),
        ),
        React.createElement(
          MuiTypography,
          { variant: 'caption', color: 'text.secondary', component: 'p', sx: { m: 0 } },
          reference.reason,
        ),
      )),
    ),
  )
}

/** One author row: a Material icon, a label and a read-only value or link. */
function AuthorRow(props: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
}): React.ReactElement {
  return React.createElement(
    MuiListItem,
    { disableGutters: true, sx: { py: 0.25, px: 0, alignItems: 'flex-start' } },
    React.createElement(MuiListItemIcon, { sx: { minWidth: 28, mt: 0.25 } }, props.icon),
    React.createElement(MuiListItemText, {
      primary: props.label,
      secondary: props.value,
      slotProps: {
        primary: { variant: 'caption', color: 'text.secondary' },
        secondary: { variant: 'body2', color: 'text.primary' },
      },
      sx: { m: 0 },
    }),
  )
}

/** The maintainer: name, email, GitHub and npm, all read-only. */
function AuthorAccordion(props: { copy: Copy; summary: string }): React.ReactElement {
  const author = props.copy.author
  const githubLabel = ABOUT.author.github.replace(/^https:\/\/github\.com\//, '')
  return React.createElement(
    SectionAccordion,
    { title: author.title, summary: props.summary },
    React.createElement(
      MuiList,
      { dense: true, disablePadding: true, component: 'div' },
      React.createElement(AuthorRow, {
        icon: React.createElement(MuiPersonIcon, { fontSize: 'small' }),
        label: author.name,
        value: ABOUT.author.name,
      }),
      React.createElement(AuthorRow, {
        icon: React.createElement(MuiEmailIcon, { fontSize: 'small' }),
        label: author.email,
        value: React.createElement(MuiLink, { href: `mailto:${ABOUT.author.email}` }, ABOUT.author.email),
      }),
      React.createElement(AuthorRow, {
        icon: React.createElement(MuiGitHubIcon, { fontSize: 'small' }),
        label: author.github,
        value: React.createElement(
          MuiLink,
          { href: ABOUT.author.github, target: '_blank', rel: 'noreferrer' },
          githubLabel,
        ),
      }),
      React.createElement(AuthorRow, {
        icon: React.createElement(MuiInventory2Icon, { fontSize: 'small' }),
        label: author.npm,
        value: React.createElement(
          MuiLink,
          { href: ABOUT.author.npm, target: '_blank', rel: 'noreferrer' },
          ABOUT.name,
        ),
      }),
    ),
  )
}

/* ------------------------------------------------------------------------- *
 * Styles
 * ------------------------------------------------------------------------- */

const SECTION_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const CONTENT_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
const PAGE_TAIL_STACK_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
const HEADER_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const INTRO_SX = { m: 0 }
const INFO_BUTTON_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'inherit',
  cursor: 'help',
  opacity: 0.6,
}
const TOOLBAR_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  paddingBottom: 2,
}
const SEARCH_SX = { flex: '1 1 240px', minWidth: 200, maxWidth: 420 }
const MATCH_SX = { ml: 'auto' }
const BULK_BUTTON_SX = { flex: 'none', whiteSpace: 'nowrap' }
const QUICK_SECTION_STYLE: React.CSSProperties = { display: 'block' }
const SECTION_HEAD_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
}
const SECTION_TITLE_SX = { m: 0, flex: 'none', fontSize: 14, fontWeight: 600 }
const SECTION_COUNT_SX = { ml: 'auto', whiteSpace: 'nowrap', flex: 'none' }
const SETTINGS_ACCORDION_SX = {
  borderTop: '1px solid var(--dsw-alias-separator, #e0e0e0)',
  background: 'transparent',
  '&:before': { display: 'none' },
}
const SETTINGS_SUMMARY_SX = { minHeight: 40, px: 0, py: 0 }
const SETTINGS_DETAILS_SX = { px: 0, pb: 0.5, display: 'block' }
const SECTION_DESC_SX = { m: 0, mb: 0.5 }
const SECTION_HELPER_SX = { m: 0, mb: 0.5 }
const ADVANCED_HEADING_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  marginTop: 10,
  paddingTop: 8,
  borderTop: '1px solid var(--dsw-alias-separator, #e0e0e0)',
}
const ADVANCED_TITLE_SX = { m: 0, flex: '1 1 auto', textTransform: 'uppercase', letterSpacing: 0.5 }
const PICKER_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 0 6px',
}
/**
 * One enum row's MUI Select. `maxWidth: 100%` is the overflow guard: the row
 * already wraps its control column, and the select can never grow past it.
 */
const SELECT_SX = {
  width: 190,
  maxWidth: '100%',
  flex: 'none',
  fontSize: 13,
  '& .MuiSelect-select': { py: 0.75, pl: 1 },
}
/** The scene picker's select: a little narrower than a full enum row. */
const SCENE_SELECT_SX = {
  minWidth: 150,
  maxWidth: 200,
  fontSize: 13,
  '& .MuiSelect-select': { py: 0.75, pl: 1 },
}
const ROW_STYLE: React.CSSProperties = {
  padding: '7px 2px',
  borderTop: '1px solid var(--dsw-alias-separator, #f0f0f0)',
}
const ROW_MAIN_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
}
const ROW_TEXT_STYLE: React.CSSProperties = { flex: '1 1 300px', minWidth: 0 }
const ROW_LABEL_LINE_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  flexWrap: 'wrap',
}
const ROW_CONTROL_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  justifyContent: 'flex-end',
  flex: '0 0 auto',
  marginLeft: 'auto',
  minHeight: 32,
  maxWidth: '100%',
}
const LABEL_SX = { flex: '0 1 auto', minWidth: 0, fontSize: 14, fontWeight: 500 }
const HINT_SX = { m: 0, mt: 0.25 }
const BADGE_SX = { height: 18, flex: 'none' }
const ROW_ERROR_SX = { m: 0, mt: 0.5 }
const VALUE_SX = { opacity: 0.85, maxWidth: 280, wordBreak: 'break-word' }
const BANNER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 8px',
  borderLeft: '2px solid #a15c00',
}
const EMPTY_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '12px 4px',
}
const NUMBER_SX = { width: 132, flex: 'none' }
const TEXT_SX = { width: 150, flex: 'none' }
const ACCORDION_SX = {
  borderTop: '1px solid var(--dsw-alias-separator, #e0e0e0)',
  background: 'transparent',
  '&:before': { display: 'none' },
}
const SUMMARY_SX = { minHeight: 40, px: 1 }
const SUMMARY_TITLE_SX = { m: 0, flex: 'none' }
const SUMMARY_COUNT_SX = { ml: 'auto', mr: 1, whiteSpace: 'nowrap' }
const DETAILS_SX = { px: 1, pt: 0 }
const TABLE_HEAD_SX = { fontSize: 12, fontWeight: 600, py: 0.25, px: 0.5 }
const TABLE_CELL_SX = { py: 0.25, px: 0.5, verticalAlign: 'middle' }
