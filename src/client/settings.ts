/**
 * The `协调` settings page (v24 §3, §19).
 *
 * One page, one row per feature, driven entirely by `SETTINGS_CONTROLS` in
 * `src/shared/selection.ts`. The layout is Material UI end to end:
 *
 *  - one `Accordion` per catalog group, with a `List` of rows inside;
 *  - a `Table` per scene for the eleven scene-scoped fields — there is no scene
 *    dropdown, every scene is visible as its own table;
 *  - `Checkbox` for booleans, `RadioGroup` for enums, and
 *    `TextField type="number"` for every number — weights, ratios, counts,
 *    bytes and milliseconds alike;
 *  - `Typography` for titles, hints, defaults and errors, and `Chip` for the
 *    `主机` / `本机` / `强制` / `只读` / `计划中` status.
 *
 * Every row has a unique id (`setting:<config path>`), a label, the value the
 * host reports, the schema default the host reports, its range/step, a hint and
 * a tooltip. Writes are optimistic: the control moves immediately, then only
 * the host's answer is kept; a refusal or an old host reverts it and says why.
 * A row whose value the shipped runtime does not read says so instead of
 * pretending to work, and a file-layer row says its limits are captured when
 * the lazy tool runtime is created (not live).
 */
import * as React from 'react'
import EmailIcon from '@mui/icons-material/Email'
import GitHubIcon from '@mui/icons-material/GitHub'
import Inventory2Icon from '@mui/icons-material/Inventory2'
import PersonIcon from '@mui/icons-material/Person'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormLabel from '@mui/material/FormLabel'
import Link from '@mui/material/Link'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
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
import {
  SETTINGS_CATALOG_GROUPS,
  formatConfigNumber,
  settingsControlsOf,
  settingsSceneControls,
  settingsSharedSceneControls,
  writeConfigPath,
} from '../shared/selection.js'
import type { ConfigScalar, ConfigValues, ConfigView, SettingsControl } from '../shared/selection.js'
import { settingsControlCopy, fillTemplate } from '../shared/i18n.js'
import { ABOUT } from '../shared/about.js'
import type { AboutDependency } from '../shared/about.js'
import {
  CommandValues,
  InteractionValues,
  ProfessionValues,
  SceneValues,
  ValidationValues,
  isOneOf,
} from '../shared/enum.js'
import type { Copy } from '../shared/i18n.js'

/* MUI's generics describe every overload; the plugin passes one narrow shape. */
type Loose = React.ComponentType<Record<string, unknown>>

const MuiAccordion = Accordion as unknown as Loose
const MuiAccordionDetails = AccordionDetails as unknown as Loose
const MuiAccordionSummary = AccordionSummary as unknown as Loose
const MuiButton = Button as unknown as Loose
const MuiCheckbox = Checkbox as unknown as Loose
const MuiChip = Chip as unknown as Loose
const MuiFormControl = FormControl as unknown as Loose
const MuiFormControlLabel = FormControlLabel as unknown as Loose
const MuiFormLabel = FormLabel as unknown as Loose
const MuiLink = Link as unknown as Loose
const MuiList = List as unknown as Loose
const MuiListItem = ListItem as unknown as Loose
const MuiListItemIcon = ListItemIcon as unknown as Loose
const MuiListItemText = ListItemText as unknown as Loose
const MuiRadio = Radio as unknown as Loose
const MuiRadioGroup = RadioGroup as unknown as Loose
const MuiTable = Table as unknown as Loose
const MuiTableBody = TableBody as unknown as Loose
const MuiTableCell = TableCell as unknown as Loose
const MuiTableHead = TableHead as unknown as Loose
const MuiTableRow = TableRow as unknown as Loose
const MuiTextField = TextField as unknown as Loose
const MuiTooltip = Tooltip as unknown as Loose
const MuiTypography = Typography as unknown as Loose
const MuiEmailIcon = EmailIcon as unknown as Loose
const MuiGitHubIcon = GitHubIcon as unknown as Loose
const MuiInventory2Icon = Inventory2Icon as unknown as Loose
const MuiPersonIcon = PersonIcon as unknown as Loose

/* ------------------------------------------------------------------------- *
 * Row primitives
 * ------------------------------------------------------------------------- */

/** A row-local `?` affordance: click/tap or keyboard focus shows the reason. */
function HelpButton(props: { label: string; title: string }): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  return React.createElement(
    MuiTooltip,
    { title: props.title, placement: 'left', open, onClose: () => { setOpen(false) }, describeChild: true },
    React.createElement(
      'button',
      {
        type: 'button',
        'aria-label': props.label,
        'aria-expanded': open,
        style: HELP_STYLE,
        onMouseEnter: () => { setOpen(true) },
        onMouseLeave: () => { setOpen(false) },
        onFocus: () => { setOpen(true) },
        onBlur: () => { setOpen(false) },
        onClick: () => { setOpen((previous) => !previous) },
      },
      '?',
    ),
  )
}

/** A checkbox for one boolean config value (labelled by the row's label). */
function CheckControl(props: {
  inputId: string
  label: string
  checked: boolean
  disabled?: boolean
  onChange?: (value: boolean) => void
}): React.ReactElement {
  return React.createElement(MuiCheckbox, {
    size: 'small',
    checked: props.checked,
    disabled: props.disabled === true,
    slotProps: { input: { id: props.inputId, 'aria-label': props.label } },
    onChange: (event: { target: { checked: boolean } }) => {
      if (props.onChange !== undefined) props.onChange(event.target.checked)
    },
  })
}

/** A radio group for one enum config value — no dropdown anywhere on the page. */
function RadioControl(props: {
  label: string
  value: string
  options: readonly string[]
  disabled: boolean
  optionLabel: (value: string) => string
  onCommit: (value: string) => void
}): React.ReactElement {
  return React.createElement(
    MuiFormControl,
    { component: 'fieldset', sx: FIELD_SET_SX },
    React.createElement(MuiFormLabel, { component: 'legend', sx: VISUALLY_HIDDEN_SX }, props.label),
    React.createElement(
      MuiRadioGroup,
      {
        row: true,
        value: props.value,
        'aria-label': props.label,
        onChange: (event: { target: { value: string } }) => { props.onCommit(event.target.value) },
      },
      props.options.map((option) => React.createElement(MuiFormControlLabel, {
        key: option,
        value: option,
        disabled: props.disabled,
        control: React.createElement(MuiRadio, { size: 'small' }),
        label: React.createElement(MuiTypography, { variant: 'caption' }, props.optionLabel(option)),
        sx: { mr: 1 },
      })),
    ),
  )
}

/**
 * A MUI number field for a number (turns, milliseconds, bytes, ratios and
 * weights). The inline error is the local parse/min/max check; the host is
 * still the authority and its rejection lands on the row below.
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
 * Value formatting — never invent a value
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

/** `kind · 默认 X · min–max · step` for one row, from the host's real defaults. */
function metaLine(copy: Copy, control: SettingsControl, defaultValue: unknown): string {
  const values = copy.settings.catalog.values
  const parts: string[] = [control.kind]
  if (defaultValue !== undefined) {
    parts.push(`${values.defaultValue} ${displayConfigValue(copy, control, defaultValue)}`)
  }
  if (control.kind === 'number') {
    if (control.min !== undefined || control.max !== undefined) {
      parts.push(`${control.min ?? '−∞'}–${control.max ?? '∞'}`)
    }
    if (control.step !== undefined) parts.push(String(control.step))
  }
  return parts.join(' · ')
}

/* ------------------------------------------------------------------------- *
 * Page
 * ------------------------------------------------------------------------- */

type LoadState = 'loading' | 'ready' | 'offline' | 'unsupported' | 'invalid'

/** Display preference a host interval maps onto (`2 / 5 / 10` seconds). */
function refreshOption(milliseconds: number): number {
  if (milliseconds <= 2000) return 2
  if (milliseconds <= 5000) return 5
  return 10
}

/** Deep-copy the live values so an optimistic write never mutates state. */
function copyValues(values: ConfigValues): ConfigValues {
  return JSON.parse(JSON.stringify(values)) as ConfigValues
}

/** Apply one control's scalar to a copy of the values, for the optimistic step. */
function withControlValue(view: ConfigView, control: SettingsControl, value: ConfigScalar): ConfigView {
  const values = copyValues(view.values)
  for (const key of control.keys) {
    writeConfigPath(values as unknown as Record<string, unknown>, key, value)
  }
  return { values, defaults: view.defaults }
}

const CHIP_COLOR: Readonly<Record<string, 'default' | 'warning' | 'success'>> = {
  host: 'default',
  local: 'default',
  forced: 'warning',
  readOnly: 'default',
  planned: 'warning',
}

/**
 * Settings-only type scale.
 *
 * The host settings shell renders its menus at 14px with a 12px minimum; the
 * composer's compact 12px theme must stay untouched, so the page derives its
 * own theme and pins every variant in pixels (a `rem` caption would shrink
 * below the host minimum whenever the host root font is small).
 */
const settingsTheme = createTheme(theme, {
  typography: {
    fontSize: 14,
    body1: { fontSize: 14 },
    body2: { fontSize: 14 },
    subtitle1: { fontSize: 14, fontWeight: 600 },
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
  const [view, setView] = React.useState<ConfigView | null>(null)
  const [load, setLoad] = React.useState<LoadState>('loading')
  const [status, setStatus] = React.useState<{ text: string; error: boolean } | null>(null)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set())
  const takeoverOn = React.useSyncExternalStore(takeoverStore.subscribe, takeoverStore.snapshot, takeoverStore.snapshot)
  const workflowOn = React.useSyncExternalStore(workflowStore.subscribe, workflowStore.snapshot, workflowStore.snapshot)
  const feed = React.useSyncExternalStore(subscribeSelectionFeed, selectionFeed, selectionFeed)
  const storageBlocked = localSettingsBlocked()

  const refresh = React.useCallback((): void => {
    setLoad('loading')
    setStatus(null)
    void (async () => {
      const outcome = await loadConfig()
      if (outcome.config === null) {
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

  /** Write one row's value: local stores stay local, everything else goes host. */
  const commit = (control: SettingsControl, value: ConfigScalar): void => {
    // Local display preferences are useful offline too, so they commit before
    // the host-readiness guard.
    if (control.local === 'takeover') {
      setTakeover(value === true)
      return
    }
    if (control.local === 'workflow') {
      setWorkflow(value === true)
      return
    }
    if (view === null || load !== 'ready') return
    if (control.keys.length === 0) return
    const patch: Record<string, ConfigScalar> = {}
    for (const key of control.keys) patch[key] = value
    const previous = view
    const wasBusy = busy
    setView(withControlValue(view, control, value))
    setErrors((current) => {
      if (!(control.id in current)) return current
      const next = { ...current }
      delete next[control.id]
      return next
    })
    setBusy(new Set([...busy, control.id]))
    setStatus(null)
    void (async () => {
      const outcome = await saveConfig(patch)
      setBusy(wasBusy)
      if (outcome.config === null) {
        setView(previous)
        const reason = !outcome.reached
          ? settings.states.offline
          : outcome.code === 'INVALID_ARGUMENT'
            ? copy.errors.INVALID_ARGUMENT
            : settings.states.hostRejected
        setErrors((current) => ({ ...current, [control.id]: reason }))
        setStatus({
          text: outcome.unsupported ? settings.states.configUnsupported : settings.states.hostRejected,
          error: true,
        })
        return
      }
      setView(outcome.config)
      // Display controls also move their local preference, so the composer
      // reflects the change immediately instead of waiting for a remount.
      if (control.keys.includes('ui.showTooltip')) setTooltips(value === true)
      if (control.keys.includes('ui.compact')) setCompact(value === true)
      if (control.keys.includes('ui.refreshInterval') && typeof value === 'number') {
        setRefreshSeconds(refreshOption(value))
      }
      setStatus({
        text: outcome.persisted ? settings.states.saved : catalog.values.notPersisted,
        error: false,
      })
    })()
  }

  /** Resolve one row's current/default value from the host view. */
  const valueOf = (control: SettingsControl): unknown => {
    if (view === null || control.keys.length === 0) return undefined
    return readPath(view.values, control.keys[0] as string)
  }
  const defaultOf = (control: SettingsControl): unknown => {
    if (view === null || control.keys.length === 0) return undefined
    return readPath(view.defaults, control.keys[0] as string)
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

  /** The input for one control; the final fallback is a read-only text row. */
  const renderInput = (control: SettingsControl, label: string): React.ReactNode => {
    const inputId = `${control.id}:input`
    const rawValue = valueOf(control)
    const editable = control.chip === 'host' && control.keys.length > 0 && load === 'ready'
    const disabled = !editable || busy.has(control.id)

    if (control.local !== undefined) {
      const checked = control.local === 'takeover' ? takeoverOn : workflowOn
      return React.createElement(CheckControl, {
        inputId,
        label,
        checked,
        onChange: (next: boolean) => { commit(control, next) },
      })
    }
    if (control.kind === 'boolean' && control.keys.length > 0 && rawValue !== undefined) {
      return React.createElement(CheckControl, {
        inputId,
        label,
        checked: rawValue === true,
        disabled,
        ...(control.chip === 'host' ? { onChange: (next: boolean) => { commit(control, next) } } : {}),
      })
    }
    if (control.chip === 'host' && control.kind === 'enum' && typeof rawValue === 'string') {
      return React.createElement(RadioControl, {
        label,
        value: rawValue,
        options: control.options ?? [],
        disabled,
        optionLabel: (option: string) => optionLabel(copy, control, option),
        onCommit: (next: string) => { commit(control, next) },
      })
    }
    if (control.chip === 'host' && control.kind === 'number' && typeof rawValue === 'number') {
      return React.createElement(NumberFieldControl, {
        inputId,
        label,
        value: rawValue,
        ...(control.min === undefined ? {} : { min: control.min }),
        ...(control.max === undefined ? {} : { max: control.max }),
        ...(control.step === undefined ? {} : { step: control.step }),
        disabled,
        onCommit: (next: number) => { commit(control, next) },
        messages: { invalid: catalog.values.invalidNumber, range: catalog.values.outOfRange },
      })
    }
    if (control.chip === 'host' && control.kind === 'text' && typeof rawValue === 'string') {
      return React.createElement(TextFieldControl, {
        inputId,
        label,
        value: rawValue,
        disabled,
        onCommit: (next: string) => { commit(control, next) },
      })
    }
    if (rawValue !== undefined && control.kind !== 'boolean') {
      return React.createElement(
        MuiTypography,
        { variant: 'body2', sx: VALUE_SX },
        displayConfigValue(copy, control, rawValue),
      )
    }
    // Derived rows and an absent host answer never invent a value.
    return React.createElement(
      MuiTypography,
      { variant: 'body2', sx: VALUE_SX },
      control.derived === true ? derivedText(control) : values.unavailable,
    )
  }

  /** One row in a group's `List` (the same layout the shared scene rows use). */
  const renderRow = (control: SettingsControl): React.ReactElement => {
    const field = settingsControlCopy(settings, control.copy) ?? { label: control.id, hint: '' }
    const rawDefault = defaultOf(control)
    const label = control.scene === undefined
      ? field.label
      : `${copy.scenes[control.scene].label} · ${field.label}`
    const inputId = `${control.id}:input`
    const editable = control.chip === 'host' && control.keys.length > 0 && load === 'ready'
    // An enum renders as a radio group or a dropdown with its own `aria-label`;
    // only real inputs get a htmlFor label.
    const labelled = editable && control.kind !== 'enum'
    const meta = metaLine(copy, control, rawDefault)
    const notes: string[] = []
    if (control.copy === 'professionDefaultAlias') notes.push(catalog.values.alias)
    if (control.wired === false && control.derived !== true) notes.push(catalog.values.notWired)
    // The file layer captures its limits when the lazy tool runtime is created:
    // say so instead of implying that an existing runtime picks them up.
    if (control.wired && (control.group === 'parser' || control.group === 'chain') && control.copy !== 'parserEnabled') {
      notes.push(catalog.values.captured)
    }
    if (control.copy.startsWith('planWeight.')) notes.push(catalog.values.normalized)
    const reason = [field.hint, ...notes, catalog.values.chips[control.chip]]
      .filter((line) => line.length > 0)
      .join(' ')

    return React.createElement(
      MuiListItem,
      {
        key: control.id,
        id: control.id,
        component: 'div',
        style: rowStyle(control),
        'data-setting': control.id,
        'data-config-key': control.keys.join(','),
        'data-control-type': control.kind,
        'data-control-copy': control.copy,
        'data-control-chip': control.chip,
        role: 'group',
        'aria-labelledby': `${control.id}:label`,
      },
      React.createElement(
        'div',
        { style: ROW_HEAD_STYLE },
        React.createElement(
          MuiTypography,
          {
            id: `${control.id}:label`,
            component: labelled ? 'label' : 'span',
            ...(labelled ? { htmlFor: inputId } : {}),
            variant: 'body2',
            sx: LABEL_SX,
          },
          label,
        ),
        renderInput(control, label),
        React.createElement(MuiChip, {
          size: 'small',
          variant: 'outlined',
          color: CHIP_COLOR[control.chip] ?? 'default',
          label: catalog.values.chips[control.chip],
          sx: { ml: 'auto' },
        }),
        React.createElement(HelpButton, { label: values.help, title: reason }),
      ),
      React.createElement(MuiTypography, { variant: 'caption', color: 'text.secondary', component: 'p', sx: { m: 0 } }, field.hint),
      meta.length === 0
        ? null
        : React.createElement(MuiTypography, { variant: 'caption', color: 'text.disabled', component: 'p', sx: { m: 0 } }, meta),
      ...notes.map((note) => React.createElement(
        MuiTypography,
        { key: note, variant: 'caption', color: 'warning.main', component: 'p', sx: { m: 0 } },
        note,
      )),
      errors[control.id] === undefined
        ? null
        : React.createElement(
          MuiTypography,
          { role: 'alert', variant: 'caption', color: 'error', component: 'p', sx: { m: 0 } },
          errors[control.id],
        ),
    )
  }

  /** A scene table: one row per scene-scoped field, no dropdown involved. */
  const renderSceneTable = (scene: (typeof SceneValues)[number]): React.ReactElement => {
    const rows = settingsSceneControls(scene)
    return React.createElement(
      'div',
      { key: scene, style: SCENE_BLOCK_STYLE },
      React.createElement(MuiTypography, { variant: 'subtitle2', component: 'h4', sx: { m: 0, mb: 0.5 } }, copy.scenes[scene].label),
      React.createElement(
        MuiTable,
        { size: 'small', 'aria-label': copy.scenes[scene].label },
        React.createElement(
          MuiTableHead,
          null,
          React.createElement(
            MuiTableRow,
            null,
            React.createElement(MuiTableCell, { sx: TABLE_HEAD_SX }, catalog.values.field),
            React.createElement(MuiTableCell, { sx: TABLE_HEAD_SX }, catalog.values.value),
            React.createElement(MuiTableCell, { sx: TABLE_HEAD_SX }, catalog.values.defaultValue),
            React.createElement(MuiTableCell, { sx: TABLE_HEAD_SX }, catalog.values.status),
          ),
        ),
        React.createElement(
          MuiTableBody,
          null,
          rows.map((control) => {
            const field = settingsControlCopy(settings, control.copy) ?? { label: control.id, hint: '' }
            const label = `${copy.scenes[scene].label} · ${field.label}`
            return React.createElement(
              MuiTableRow,
              {
                key: control.id,
                id: control.id,
                'data-setting': control.id,
                'data-config-key': control.keys.join(','),
                'data-control-type': control.kind,
                'data-control-chip': control.chip,
                'aria-label': label,
              },
              React.createElement(
                MuiTableCell,
                { sx: TABLE_CELL_SX },
                React.createElement(MuiTypography, { variant: 'caption', component: 'span' }, field.label),
                React.createElement(HelpButton, { label: values.help, title: field.hint }),
              ),
              React.createElement(MuiTableCell, { sx: TABLE_CELL_SX }, renderInput(control, label)),
              React.createElement(
                MuiTableCell,
                { sx: TABLE_CELL_SX },
                React.createElement(
                  MuiTypography,
                  { variant: 'caption', color: 'text.secondary' },
                  displayConfigValue(copy, control, defaultOf(control)),
                ),
              ),
              React.createElement(
                MuiTableCell,
                { sx: TABLE_CELL_SX },
                React.createElement(MuiChip, {
                  size: 'small',
                  variant: 'outlined',
                  color: CHIP_COLOR[control.chip] ?? 'default',
                  label: catalog.values.chips[control.chip],
                }),
              ),
            )
          }),
        ),
      ),
    )
  }

  const groupChildren = (group: (typeof SETTINGS_CATALOG_GROUPS)[number]): React.ReactNode[] => {
    const controls = settingsControlsOf(group)
    if (group === 'profession') {
      const rows = controls.map(renderRow)
      if (feed.state !== null && feed.state.locked) {
        rows.push(React.createElement(
          MuiListItem,
          { key: 'locked', component: 'div', role: 'status' },
          React.createElement(
            MuiTypography,
            { variant: 'caption', color: 'warning.main', component: 'p', sx: { m: 0 } },
            settings.states.settingsLocked,
          ),
        ))
      }
      // The two-sentence "why lock" paragraph belongs to this group.
      rows.push(React.createElement(
        MuiListItem,
        { key: 'why-lock', component: 'div' },
        React.createElement(
          MuiTypography,
          { variant: 'caption', color: 'text.secondary', component: 'p', sx: { m: 0 } },
          settings.whyLock,
        ),
      ))
      return rows
    }
    if (group === 'scenes') {
      const shared = settingsSharedSceneControls().map(renderRow)
      // The shared rows write all six scenes at once; the policy row is a
      // constant, not a config key.
      const policy = controls
        .filter((control) => control.keys.length === 0 && !control.scene)
        .map(renderRow)
      return [
        // Six Tables, one per scene: the scene selector is gone.
        React.createElement(
          MuiListItem,
          { key: 'scene-tables', component: 'div', style: { display: 'block' } },
          ...SceneValues.map(renderSceneTable),
        ),
        ...shared,
        ...policy,
      ]
    }
    return controls.map(renderRow)
  }

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
      ),
      React.createElement(MuiTypography, { variant: 'body2', color: 'text.secondary', component: 'p', sx: { m: 0 } }, settings.intro),
      React.createElement(MuiTypography, { variant: 'caption', color: 'text.secondary', component: 'p', sx: { m: 0 } }, settings.applyNote),
      banner === null
        ? null
        : React.createElement(
          'div',
          { role: 'status', style: BANNER_STYLE },
          React.createElement(MuiTypography, { variant: 'caption', color: 'warning.main' }, banner),
          React.createElement(MuiButton, { size: 'small', variant: 'outlined', onClick: refresh }, catalog.values.retry),
        ),
      load === 'loading'
        ? React.createElement(MuiTypography, { variant: 'caption', role: 'status', component: 'p', sx: { m: 0 } }, settings.states.loading)
        : null,
      status === null
        ? null
        : React.createElement(
          MuiTypography,
          {
            variant: 'caption',
            role: 'status',
            component: 'p',
            color: status.error ? 'warning.main' : 'text.secondary',
            sx: { m: 0 },
          },
          status.text,
        ),
      storageBlocked
        ? React.createElement(
          MuiTypography,
          { variant: 'caption', color: 'warning.main', role: 'status', component: 'p', sx: { m: 0 } },
          settings.states.storageBlocked,
        )
        : null,
      ...SETTINGS_CATALOG_GROUPS.map((group) => React.createElement(
        GroupAccordion,
        {
          key: group,
          title: catalog.groups[group].title,
          desc: catalog.groups[group].desc,
          helper: catalog.groups[group].helper,
          // The user asked the catalog to open fully: every group is expanded
          // until the operator collapses it.
          initialOpen: true,
        },
        groupChildren(group),
      )),
      React.createElement(MuiTypography, { variant: 'caption', color: 'text.secondary', component: 'p', sx: { m: 0 } }, settings.footer),
      // The page ends with three read-only groups: About, References, Author.
      React.createElement(AboutAccordion, { copy }),
      React.createElement(ReferencesAccordion, { copy }),
      React.createElement(AuthorAccordion, { copy }),
    ),
  )
}

/** One collapsible catalog group: MUI Accordion + List of rows. */
function GroupAccordion(props: {
  title: string
  desc: string
  helper: string
  initialOpen: boolean
  children?: React.ReactNode[]
}): React.ReactElement {
  return React.createElement(
    MuiAccordion,
    { defaultExpanded: props.initialOpen, disableGutters: true, elevation: 0, sx: ACCORDION_SX },
    React.createElement(
      MuiAccordionSummary,
      { sx: SUMMARY_SX },
      React.createElement(MuiTypography, { variant: 'subtitle2', component: 'h3', sx: { m: 0, flex: 1 } }, props.title),
    ),
    React.createElement(
      MuiAccordionDetails,
      { sx: DETAILS_SX },
      React.createElement(MuiTypography, { variant: 'caption', color: 'text.secondary', component: 'p', sx: { m: 0, mb: 0.5 } }, props.desc),
      React.createElement(MuiList, { dense: true, disablePadding: true, component: 'div' }, ...(props.children ?? [])),
      React.createElement(MuiTypography, { variant: 'caption', color: 'text.secondary', component: 'p', sx: { m: 0, mt: 1 } }, props.helper),
    ),
  )
}

/* ------------------------------------------------------------------------- *
 * About / References / Author — the read-only page tail
 * ------------------------------------------------------------------------- */

/** One collapsed section whose body is static data; no input is ever built. */
function SectionAccordion(props: {
  title: string
  children?: React.ReactNode[]
}): React.ReactElement {
  return React.createElement(
    MuiAccordion,
    { defaultExpanded: false, disableGutters: true, elevation: 0, sx: ACCORDION_SX },
    React.createElement(
      MuiAccordionSummary,
      { sx: SUMMARY_SX },
      React.createElement(MuiTypography, { variant: 'subtitle2', component: 'h3', sx: { m: 0, flex: 1 } }, props.title),
    ),
    React.createElement(
      MuiAccordionDetails,
      { sx: DETAILS_SX },
      React.createElement('div', { style: PAGE_TAIL_STACK_STYLE }, ...(props.children ?? [])),
    ),
  )
}

/** Label for one dependency scope (runtime / development / peer). */
function scopeLabel(copy: Copy, scope: AboutDependency['scope']): string {
  if (scope === 'runtime') return copy.about.scopeRuntime
  if (scope === 'development') return copy.about.scopeDevelopment
  return copy.about.scopePeer
}

/** One static dependency or tooling table; same cell styles as the scene tables. */
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

/** The project metadata and the dependency/tooling inventories. */
function AboutAccordion(props: { copy: Copy }): React.ReactElement {
  const about = props.copy.about
  return React.createElement(
    SectionAccordion,
    { title: about.title },
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
    React.createElement(
      MuiTypography,
      { variant: 'caption', color: 'text.secondary', component: 'p', sx: { m: 0 } },
      `${about.license}: ${ABOUT.license}`,
    ),
  )
}

/** The citations, one read-only line each; a URL renders as an external link. */
function ReferencesAccordion(props: { copy: Copy }): React.ReactElement {
  const about = props.copy.about
  return React.createElement(
    SectionAccordion,
    { title: props.copy.references.title },
    React.createElement(
      MuiList,
      { dense: true, disablePadding: true, component: 'div' },
      ...ABOUT.references.map((reference) => {
        const line = fillTemplate(about.referenceItem, {
          authors: reference.authors,
          year: String(reference.year),
          title: reference.title,
          venue: reference.venue,
        })
        return React.createElement(
          MuiListItem,
          { key: reference.id, component: 'div', disableGutters: true, sx: { display: 'block', py: 0.25, px: 0 } },
          React.createElement(
            MuiTypography,
            { variant: 'caption', component: 'p', sx: { m: 0 } },
            line,
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
        )
      }),
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
function AuthorAccordion(props: { copy: Copy }): React.ReactElement {
  const author = props.copy.author
  const githubLabel = ABOUT.author.github.replace(/^https:\/\/github\.com\//, '')
  return React.createElement(
    SectionAccordion,
    { title: author.title },
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
const PAGE_TAIL_STACK_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
const HEADER_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const ROW_HEAD_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  minHeight: 32,
}
const LABEL_SX = { flex: '1 1 140px', minWidth: 120, fontSize: 14 }
const VALUE_SX = { opacity: 0.85 }
const SCENE_BLOCK_STYLE: React.CSSProperties = { marginTop: 8 }
const BANNER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 8px',
  borderLeft: '2px solid #a15c00',
}
const HELP_STYLE: React.CSSProperties = {
  width: 18,
  height: 18,
  lineHeight: '16px',
  padding: 0,
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-separator, #c9c9c9)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  cursor: 'help',
  flex: 'none',
}
const NUMBER_SX = { width: 140 }
const TEXT_SX = { width: 150 }
const FIELD_SET_SX = { border: 0, p: 0, m: 0, minWidth: 0 }
const VISUALLY_HIDDEN_SX = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
}
const ACCORDION_SX = {
  borderTop: '1px solid var(--dsw-alias-separator, #e0e0e0)',
  background: 'transparent',
  '&:before': { display: 'none' },
}
const SUMMARY_SX = { minHeight: 40, px: 1 }
const DETAILS_SX = { px: 1, pt: 0 }
const TABLE_HEAD_SX = { fontSize: 12, fontWeight: 600, py: 0.25, px: 0.5 }
const TABLE_CELL_SX = { py: 0.25, px: 0.5, verticalAlign: 'middle' }

/** Row left rule: forced/planned are amber, unwired rows are read-only grey. */
function rowStyle(control: SettingsControl): React.CSSProperties {
  const base: React.CSSProperties = { display: 'block', padding: '6px 8px' }
  if (control.chip === 'forced') return { ...base, borderLeft: '2px solid #a15c00' }
  if (control.chip === 'planned') return { ...base, borderLeft: '2px dashed #a15c00' }
  if (control.chip === 'host' && control.wired) return base
  return { ...base, borderLeft: '2px solid var(--dsw-alias-separator, #d9d9d9)' }
}

/** Read one dotted path from a plain object tree. */
function readPath(source: unknown, path: string): unknown {
  let cursor: unknown = source
  for (const part of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}
