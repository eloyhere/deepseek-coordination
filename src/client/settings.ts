/**
 * The `协调` settings page (v24 §3, `docs/ui-copy-v24.md` §5.9).
 *
 * Six groups, 24 rows, one page: permission & takeover, workflow & selectors,
 * profession & audit, scene & validation defaults, language & display, advanced.
 * Every row always shows its explanation — no rule lives only in a tooltip.
 *
 * Row types, and why each is honest:
 *  - editable rows write only local storage (`:takeover`, `:workflow`,
 *    `:tooltips`, `:compact`, `:refresh`) and carry the `本机` chip;
 *  - forced rows (profession lock / reselect after rebuild / after abandon) show
 *    a disabled "on" switch and the `强制` chip — not a control that could lie;
 *  - host-config rows show the value only when the host sent
 *    `SelectionState.config`; without it they say `跟随主机配置` instead of
 *    pretending to read a deployment default;
 *  - session-backed rows (default profession / scene / interaction /
 *    validation) show the current session's accepted selection with the
 *    `当前会话` chip when a composer selection is known;
 *  - derived rows (the taken-over control, the DSH catalog, the current
 *    language) are read-only and say where they come from.
 *
 * The local rows persist through the composer's preference stores; the two
 * original switches keep using `store.ts`. Language is read-only: DSH is the
 * authority (`ctx.locale`), and this page never calls `setLocale`.
 *
 * There is no save button: switches apply immediately (v24 §3.1).
 */
import * as React from 'react'
import Switch from '@mui/material/Switch'
import Select, { type SelectChangeEvent } from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import Tooltip from '@mui/material/Tooltip'
import { ThemeProvider } from '@mui/material/styles'
import { theme } from './theme.js'
import { currentLocale, useCopy } from './i18n.js'
import { setTakeover, setWorkflow, takeoverStore, workflowStore } from './store.js'
import {
  applyLocalCompaction,
  compactStore,
  localSettingsBlocked,
  readBoolean,
  readNumber,
  refreshStore,
  selectionConfig,
  selectionFeed,
  setCompact,
  setRefreshSeconds,
  setTooltips,
  subscribeSelectionFeed,
  tooltipsStore,
} from './controls.js'
import type { CompactionConfigView } from './controls.js'
import {
  COMPACTION_THRESHOLD_OPTIONS,
  compactionPercent,
  compactionRatio,
  isValidCompactionThreshold,
  saveCompaction,
} from './bridge.js'
import {
  InteractionValues,
  ProfessionValues,
  SceneValues,
  ValidationValues,
  isOneOf,
} from '../shared/enum.js'
import type { Copy } from '../shared/i18n.js'
import type { SettingsChipId, SettingsFieldId } from '../shared/i18n.js'

const MuiSwitch: React.ComponentType<Record<string, unknown>> =
  Switch as unknown as React.ComponentType<Record<string, unknown>>
const MuiSelect: React.ComponentType<Record<string, unknown>> =
  Select as unknown as React.ComponentType<Record<string, unknown>>
const MuiTooltip: React.ComponentType<Record<string, unknown>> =
  Tooltip as unknown as React.ComponentType<Record<string, unknown>>

/* ------------------------------------------------------------------------- *
 * Styles
 * ------------------------------------------------------------------------- */

const SECTION_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
}
const HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
}
const HEADING_STYLE: React.CSSProperties = { margin: 0, fontSize: 15 }
const INTRO_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary, #666)',
}
const GROUP_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  paddingTop: 10,
  borderTop: '1px solid var(--dsw-alias-separator, #e0e0e0)',
}
const GROUP_TITLE_STYLE: React.CSSProperties = { margin: 0, fontSize: 13, fontWeight: 600 }
const GROUP_DESC_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary, #666)',
}
const GROUP_ROWS_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 }
const GROUP_HELPER_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: 11,
  opacity: 0.7,
}
const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  paddingLeft: 6,
}
const ROW_READONLY_STYLE: React.CSSProperties = {
  borderLeft: '2px solid var(--dsw-alias-separator, #d9d9d9)',
}
const ROW_FORCED_STYLE: React.CSSProperties = { borderLeft: '2px solid #a15c00' }
const ROW_HEAD_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 24,
}
const LABEL_STYLE: React.CSSProperties = { fontSize: 13, flex: 1 }
const HINT_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary, #666)',
}
const NOTE_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: '#a15c00',
}
const SAVED_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: 'var(--dsw-alias-label-secondary, #666)',
}
const VALUE_STYLE: React.CSSProperties = { fontSize: 12, opacity: 0.85 }
const CHIP_STYLE: React.CSSProperties = {
  fontSize: 10,
  padding: '1px 6px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-separator, #d0d0d0)',
  color: 'var(--dsw-alias-label-secondary, #666)',
  whiteSpace: 'nowrap',
}
const STATUS_CHIP_STYLE: React.CSSProperties = {
  ...CHIP_STYLE,
  fontSize: 11,
  padding: '2px 8px',
}
const HELP_STYLE: React.CSSProperties = {
  width: 18,
  height: 18,
  lineHeight: '16px',
  padding: 0,
  borderRadius: 9,
  border: '1px solid var(--dsw-alias-separator, #c9c9c9)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 11,
  cursor: 'help',
}
const FOOTER_STYLE: React.CSSProperties = {
  margin: '6px 0 0',
  fontSize: 11,
  opacity: 0.7,
}
const BANNER_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '4px 8px',
  borderLeft: '2px solid #a15c00',
  fontSize: 12,
  color: '#a15c00',
}
const SELECT_SX = { width: 116, fontSize: 12, height: 28, backgroundColor: 'transparent' }

/* ------------------------------------------------------------------------- *
 * Row primitives
 * ------------------------------------------------------------------------- */

/** A row-local `?` affordance: click/tap or keyboard focus shows the reason. */
function HelpButton(props: { label: string; title: string }): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  return React.createElement(
    MuiTooltip,
    {
      title: props.title,
      placement: 'left',
      open,
      onClose: () => { setOpen(false) },
      describeChild: true,
    },
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

/**
 * One setting row: label, control, chip, always-visible hint, optional note.
 * Read-only and forced rows are visually distinct (left rule + chip) and their
 * `?` button carries the reason, so a locked row explains itself on keyboard
 * focus, not only on hover.
 */
function SettingRow(props: {
  copy: Copy
  id: SettingsFieldId
  chip: SettingsChipId
  control: React.ReactNode
  note?: string
}): React.ReactElement {
  const settings = props.copy.settings
  const field = settings.fields[props.id]
  const chipLabel = settings.values[props.chip]
  const reason = [field.hint, props.note, chipReason(settings, props.chip)]
    .filter((line): line is string => line !== undefined && line.length > 0)
    .join(' ')
  const rowStyle = props.chip === 'forced'
    ? { ...ROW_STYLE, ...ROW_FORCED_STYLE }
    : props.chip === 'local'
      ? ROW_STYLE
      : { ...ROW_STYLE, ...ROW_READONLY_STYLE }
  return React.createElement(
    'div',
    { style: rowStyle, 'data-setting': props.id },
    React.createElement(
      'div',
      { style: ROW_HEAD_STYLE },
      React.createElement('span', { style: LABEL_STYLE }, field.label),
      props.control,
      React.createElement('span', { style: CHIP_STYLE }, chipLabel),
      React.createElement(HelpButton, { label: settings.values.help, title: reason }),
    ),
    React.createElement('p', { style: HINT_STYLE }, field.hint),
    props.note === undefined ? null : React.createElement('p', { style: NOTE_STYLE }, props.note),
  )
}

/** The why-line a chip adds to the row's explanation. */
function chipReason(settings: Copy['settings'], chip: SettingsChipId): string {
  switch (chip) {
    case 'forced':
      return settings.values.forced
    case 'readOnlyHost':
      return settings.states.readOnlyHost
    case 'readOnlyPolicy':
      return settings.values.readOnlyPolicy
    case 'session':
      return settings.values.session
    case 'local':
      return settings.values.localOnly
    case 'host':
      return settings.values.host
    default:
      return ''
  }
}

/** An editable or forced switch. A disabled switch keeps its reason reachable. */
function SwitchControl(props: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange?: (value: boolean) => void
}): React.ReactElement {
  return React.createElement(MuiSwitch, {
    size: 'small',
    checked: props.checked,
    disabled: props.disabled === true,
    // MUI 9 forwards html-input props through `slotProps`; `inputProps` would be
    // spread onto the root span and leave the switch without an accessible name.
    slotProps: { input: { 'aria-label': props.label } },
    onChange: (event: { target: { checked: boolean } }) => {
      if (props.onChange !== undefined) props.onChange(event.target.checked)
    },
  })
}

/** A read-only value: no switch is drawn, so it cannot look clickable. */
function ValueControl(props: { value: string }): React.ReactElement {
  return React.createElement('span', { style: VALUE_STYLE }, props.value)
}

/** The one settings dropdown (auto-refresh interval), local-only. */
function IntervalSelect(props: {
  label: string
  value: number
  copy: Copy
  onChange: (value: number) => void
}): React.ReactElement {
  const values = props.copy.settings.values
  const options = [
    { value: '2', label: values.refresh2 },
    { value: '5', label: values.refresh5 },
    { value: '10', label: values.refresh10 },
    { value: '0', label: values.refreshPaused },
  ]
  const current = options.find((option) => option.value === String(props.value)) ?? options[1]
  return React.createElement(
    MuiSelect,
    {
      value: String(props.value),
      displayEmpty: false,
      renderValue: () => current.label,
      inputProps: { 'aria-label': props.label },
      sx: SELECT_SX,
      onChange: (event: SelectChangeEvent<unknown>) => {
        props.onChange(Number(String(event.target.value)))
      },
    },
    options.map((option) => React.createElement(
      MenuItem,
      { key: option.value, value: option.value, sx: { fontSize: 12, minHeight: 28 } },
      option.label,
    )),
  )
}

/**
 * The compaction trigger dropdown: the four offered shares plus the current
 * host value when it is a valid percentage outside that set (never lie about
 * what the host reports). With no host config the control is disabled and says
 * "跟随主机配置".
 */
function CompactionSelect(props: {
  label: string
  value: number | undefined
  unknownLabel: string
  disabled: boolean
  onChange: (value: number) => void
}): React.ReactElement {
  const offered = props.value !== undefined
    && !COMPACTION_THRESHOLD_OPTIONS.includes(props.value)
    && isValidCompactionThreshold(props.value)
    ? [...COMPACTION_THRESHOLD_OPTIONS, props.value].sort((left, right) => left - right)
    : COMPACTION_THRESHOLD_OPTIONS
  const display = props.value === undefined ? props.unknownLabel : `${props.value}%`
  return React.createElement(
    MuiSelect,
    {
      value: props.value === undefined ? '' : String(props.value),
      displayEmpty: true,
      renderValue: () => display,
      disabled: props.disabled || props.value === undefined,
      inputProps: { 'aria-label': props.label },
      sx: SELECT_SX,
      onChange: (event: SelectChangeEvent<unknown>) => {
        const next = Number(String(event.target.value))
        if (isValidCompactionThreshold(next)) props.onChange(next)
      },
    },
    offered.map((option) => React.createElement(
      MenuItem,
      { key: String(option), value: String(option), sx: { fontSize: 12, minHeight: 28 } },
      `${option}%`,
    )),
  )
}

function Group(props: {
  title: string
  desc: string
  helper: string
  children?: React.ReactNode
}): React.ReactElement {
  return React.createElement(
    'section',
    { style: GROUP_STYLE },
    React.createElement('h3', { style: GROUP_TITLE_STYLE }, props.title),
    React.createElement('p', { style: GROUP_DESC_STYLE }, props.desc),
    React.createElement('div', { style: GROUP_ROWS_STYLE }, props.children),
    React.createElement('p', { style: GROUP_HELPER_STYLE }, props.helper),
  )
}

/* ------------------------------------------------------------------------- *
 * Value derivation — never claim a value that was not read
 * ------------------------------------------------------------------------- */

function professionValue(copy: Copy, value: unknown): string {
  return isOneOf(value, ProfessionValues) ? copy.professions[value].label : copy.settings.values.followHostConfig
}

function interactionValue(copy: Copy, value: unknown): string {
  return isOneOf(value, InteractionValues) ? copy.interactions[value].label : copy.settings.values.followHostConfig
}

function sceneValue(copy: Copy, value: unknown): string {
  return isOneOf(value, SceneValues) ? copy.scenes[value].label : copy.settings.values.followHostConfig
}

function validationValue(copy: Copy, value: unknown): string {
  return isOneOf(value, ValidationValues) ? copy.validations[value].label : copy.settings.values.followHostConfig
}

function booleanValue(copy: Copy, value: boolean | undefined): string {
  if (value === undefined) return copy.settings.values.followHostConfig
  return value ? copy.settings.values.on : copy.settings.values.off
}

/** DSH's fallback locale setting; only the three documented values are claimed. */
function localeSettingValue(copy: Copy, value: string | undefined): string {
  if (value === 'zh-CN') return copy.settings.values.chinese
  if (value === 'en-US') return copy.settings.values.english
  if (value === 'auto') return copy.settings.values.followHost
  return copy.settings.values.followHostConfig
}

/* ------------------------------------------------------------------------- *
 * Page
 * ------------------------------------------------------------------------- */

export function CoordinationSettings(): React.ReactElement {
  const copy = useCopy()
  const takeoverOn = React.useSyncExternalStore(takeoverStore.subscribe, takeoverStore.snapshot, takeoverStore.snapshot)
  const workflowOn = React.useSyncExternalStore(workflowStore.subscribe, workflowStore.snapshot, workflowStore.snapshot)
  const tooltipsOn = React.useSyncExternalStore(tooltipsStore.subscribe, tooltipsStore.snapshot, tooltipsStore.snapshot)
  const compactOn = React.useSyncExternalStore(compactStore.subscribe, compactStore.snapshot, compactStore.snapshot)
  const feed = React.useSyncExternalStore(subscribeSelectionFeed, selectionFeed, selectionFeed)
  const settings = copy.settings
  const values = settings.values
  const state = feed.state
  const config = selectionConfig(state)
  // Future host fields (model routing, the compaction block) are read
  // defensively: a config key this build does not know yet is still displayed
  // when the host sends it.
  const rawConfig = config as Record<string, unknown>
  const compaction = config.compaction
  const autoCompact = readBoolean(compaction?.auto)
  // The host stores soft/hard as 0–1 utilisation ratios; the selects speak
  // percent, so both directions go through the bridge's conversion helpers.
  const softRatio = readNumber(compaction?.soft)
  const softPercent = softRatio === undefined ? undefined : compactionPercent(softRatio)
  const hardRatio = readNumber(compaction?.hard)
  const hardPercent = hardRatio === undefined ? undefined : compactionPercent(hardRatio)
  const reserve = readNumber(compaction?.reserve)
  const [compactionBusy, setCompactionBusy] = React.useState(false)
  const [compactionStatus, setCompactionStatus] = React.useState<{ text: string; error: boolean } | null>(null)
  const compactionTimer = React.useRef<number | null>(null)
  React.useEffect(() => () => {
    if (compactionTimer.current !== null) window.clearTimeout(compactionTimer.current)
  }, [])
  const presetCount = state === null ? undefined : state.presets.length
  const resolvedLocale = currentLocale()
  const languageValue = resolvedLocale === 'en-US' ? values.english : values.chinese
  const offline = feed.state !== null && feed.offline
  const statusChip = feed.state === null
    ? null
    : feed.offline
      ? values.disconnected
      : values.connected
  const refreshSeconds = React.useSyncExternalStore(
    // The refresh interval is a local preference owned by the composer module;
    // its store is the same one the poll reads.
    refreshStore.subscribe,
    refreshStore.snapshot,
    refreshStore.snapshot,
  )
  const storageBlocked = localSettingsBlocked()

  /**
   * Write one auto-compaction change to the host.
   *
   * The control moves immediately (optimistic), then only the host's answer is
   * kept: a refusal or an old host build reverts to the previous values and
   * says why. One request per change — no debounce, because the switch fires
   * once and the threshold select fires once per choice.
   */
  const changeCompaction = (patch: { auto?: boolean; soft?: number }): void => {
    if (compactionBusy) return
    setCompactionBusy(true)
    setCompactionStatus(null)
    const previous: Partial<CompactionConfigView> = {
      ...(autoCompact === undefined ? {} : { auto: autoCompact }),
      ...(softRatio === undefined ? {} : { soft: softRatio }),
    }
    applyLocalCompaction(patch)
    void (async () => {
      const outcome = await saveCompaction(patch)
      setCompactionBusy(false)
      if (outcome.values === null) {
        applyLocalCompaction(previous)
        setCompactionStatus({
          text: outcome.unsupported ? settings.states.configUnsupported : settings.states.hostRejected,
          error: true,
        })
        return
      }
      applyLocalCompaction(outcome.values)
      setCompactionStatus({ text: settings.states.saved, error: false })
      if (compactionTimer.current !== null) window.clearTimeout(compactionTimer.current)
      compactionTimer.current = window.setTimeout(() => setCompactionStatus(null), 4000)
    })()
  }

  const permissionRows = [
    React.createElement(SettingRow, {
      key: 'takeoverPermission',
      copy,
      id: 'takeoverPermission',
      chip: 'local',
      control: React.createElement(SwitchControl, {
        label: settings.fields.takeoverPermission.label,
        checked: takeoverOn,
        onChange: (value: boolean) => { setTakeover(value) },
      }),
    }),
    React.createElement(SettingRow, {
      key: 'takeoverControl',
      copy,
      id: 'takeoverControl',
      chip: 'readOnly',
      control: React.createElement(ValueControl, {
        value: takeoverOn ? values.pluginPermission : values.hostAccessMode,
      }),
    }),
    React.createElement(SettingRow, {
      key: 'takeoverDialogs',
      copy,
      id: 'takeoverDialogs',
      chip: 'readOnlyHost',
      control: hostBooleanControl(copy, settings.fields.takeoverDialogs.label, readBoolean(config.takeover)),
    }),
    React.createElement(SettingRow, {
      key: 'permissionCatalog',
      copy,
      id: 'permissionCatalog',
      chip: 'readOnly',
      // An offline/absent projection cannot say whether DSH exposed presets:
      // only a live host answer with an empty catalog earns the no-catalog note.
      ...(state !== null && !offline && presetCount === 0 ? { note: settings.states.noCatalog } : {}),
      control: React.createElement(ValueControl, {
        value: state === null || offline ? values.followHostConfig : values.dshCatalog,
      }),
    }),
  ]

  const composerRows = [
    React.createElement(SettingRow, {
      key: 'composerWorkflow',
      copy,
      id: 'composerWorkflow',
      chip: 'local',
      control: React.createElement(SwitchControl, {
        label: settings.fields.composerWorkflow.label,
        checked: workflowOn,
        onChange: (value: boolean) => { setWorkflow(value) },
      }),
    }),
    React.createElement(SettingRow, {
      key: 'composerTooltips',
      copy,
      id: 'composerTooltips',
      chip: 'local',
      control: React.createElement(SwitchControl, {
        label: settings.fields.composerTooltips.label,
        checked: tooltipsOn,
        onChange: (value: boolean) => { setTooltips(value) },
      }),
    }),
  ]

  const professionRows = [
    React.createElement(SettingRow, {
      key: 'professionLock',
      copy,
      id: 'professionLock',
      chip: 'forced',
      control: React.createElement(SwitchControl, {
        label: settings.fields.professionLock.label,
        checked: true,
        disabled: true,
      }),
    }),
    React.createElement(SettingRow, {
      key: 'professionDefault',
      copy,
      id: 'professionDefault',
      // `defaults.profession` is host config, not the session's live choice: the
      // composer's current profession belongs in the composer, not under a
      // "default" row. Without the projection the row says so instead of guessing.
      chip: 'readOnlyHost',
      control: React.createElement(ValueControl, {
        value: professionValue(copy, config.defaultProfession),
      }),
    }),
    React.createElement(SettingRow, {
      key: 'professionRebuild',
      copy,
      id: 'professionRebuild',
      chip: 'forced',
      control: React.createElement(SwitchControl, {
        label: settings.fields.professionRebuild.label,
        checked: true,
        disabled: true,
      }),
    }),
    React.createElement(SettingRow, {
      key: 'professionAbandon',
      copy,
      id: 'professionAbandon',
      chip: 'forced',
      control: React.createElement(SwitchControl, {
        label: settings.fields.professionAbandon.label,
        checked: true,
        disabled: true,
      }),
    }),
    React.createElement(SettingRow, {
      key: 'professionAudit',
      copy,
      id: 'professionAudit',
      chip: 'readOnlyHost',
      control: hostBooleanControl(copy, settings.fields.professionAudit.label, readBoolean(config.audit)),
    }),
    React.createElement(SettingRow, {
      key: 'professionErrorHint',
      copy,
      id: 'professionErrorHint',
      chip: 'readOnlyHost',
      control: hostBooleanControl(copy, settings.fields.professionErrorHint.label, readBoolean(config.errorHint)),
    }),
  ]

  const sceneRows = [
    React.createElement(SettingRow, {
      key: 'defaultScene',
      copy,
      id: 'defaultScene',
      chip: state === null ? 'readOnlyHost' : 'session',
      control: React.createElement(ValueControl, {
        value: state === null
          ? sceneValue(copy, config.defaultScene)
          : sceneValue(copy, state.selection.scene),
      }),
    }),
    React.createElement(SettingRow, {
      key: 'defaultValidation',
      copy,
      id: 'defaultValidation',
      chip: state === null ? 'readOnlyHost' : 'session',
      note: copy.composer.validationNote,
      control: React.createElement(ValueControl, {
        value: state === null
          ? validationValue(copy, config.defaultValidation)
          : validationValue(copy, state.selection.validation),
      }),
    }),
    React.createElement(SettingRow, {
      key: 'defaultInteraction',
      copy,
      id: 'defaultInteraction',
      chip: state === null ? 'readOnlyHost' : 'session',
      control: React.createElement(ValueControl, {
        value: state === null
          ? interactionValue(copy, config.defaultInteraction)
          : interactionValue(copy, state.selection.interaction),
      }),
    }),
    React.createElement(SettingRow, {
      key: 'writingFlow',
      copy,
      id: 'writingFlow',
      chip: 'readOnlyPolicy',
      control: React.createElement(ValueControl, { value: values.writingFlow }),
    }),
  ]

  const languageRows = [
    React.createElement(SettingRow, {
      key: 'defaultLocale',
      copy,
      id: 'defaultLocale',
      chip: 'readOnlyHost',
      control: React.createElement(ValueControl, {
        value: localeSettingValue(copy, typeof config.locale === 'string' ? config.locale : undefined),
      }),
    }),
    React.createElement(SettingRow, {
      key: 'currentLocale',
      copy,
      id: 'currentLocale',
      chip: 'readOnly',
      control: React.createElement(ValueControl, { value: languageValue }),
    }),
    React.createElement(SettingRow, {
      key: 'compact',
      copy,
      id: 'compact',
      chip: 'local',
      control: React.createElement(SwitchControl, {
        label: settings.fields.compact.label,
        checked: compactOn,
        onChange: (value: boolean) => { setCompact(value) },
      }),
    }),
    React.createElement(SettingRow, {
      key: 'refreshInterval',
      copy,
      id: 'refreshInterval',
      chip: 'local',
      control: React.createElement(IntervalSelect, {
        label: settings.fields.refreshInterval.label,
        value: refreshSeconds,
        copy,
        onChange: (value: number) => { setRefreshSeconds(value) },
      }),
    }),
  ]

  const compactionRows = [
    React.createElement(SettingRow, {
      key: 'autoCompact',
      copy,
      id: 'autoCompact',
      chip: autoCompact === undefined ? 'readOnlyHost' : 'host',
      control: autoCompact === undefined
        ? React.createElement(ValueControl, { value: values.followHostConfig })
        : React.createElement(SwitchControl, {
          label: settings.fields.autoCompact.label,
          checked: autoCompact,
          disabled: compactionBusy,
          onChange: (value: boolean) => { changeCompaction({ auto: value }) },
        }),
    }),
    React.createElement(SettingRow, {
      key: 'compactionThreshold',
      copy,
      id: 'compactionThreshold',
      chip: softPercent === undefined ? 'readOnlyHost' : 'host',
      control: React.createElement(CompactionSelect, {
        label: settings.fields.compactionThreshold.label,
        value: softPercent,
        unknownLabel: values.followHostConfig,
        disabled: compactionBusy,
        // The select offers percent; the host route expects the 0–1 ratio.
        onChange: (value: number) => { changeCompaction({ soft: compactionRatio(value) }) },
      }),
    }),
    React.createElement(SettingRow, {
      key: 'hardPrune',
      copy,
      id: 'hardPrune',
      chip: 'readOnlyHost',
      control: React.createElement(ValueControl, {
        value: hardPercent === undefined ? values.followHostConfig : `${hardPercent}%`,
      }),
    }),
    React.createElement(SettingRow, {
      key: 'reserve',
      copy,
      id: 'reserve',
      chip: 'readOnlyHost',
      control: React.createElement(ValueControl, {
        value: reserve === undefined ? values.followHostConfig : String(reserve),
      }),
    }),
    compactionStatus === null
      ? null
      : React.createElement(
        'p',
        {
          key: 'compaction-status',
          role: 'status',
          style: compactionStatus.error ? NOTE_STYLE : SAVED_STYLE,
        },
        compactionStatus.text,
      ),
  ]

  const advancedRows = [
    React.createElement(SettingRow, {
      key: 'cacheEnabled',
      copy,
      id: 'cacheEnabled',
      chip: 'readOnlyHost',
      control: hostBooleanControl(copy, settings.fields.cacheEnabled.label, readBoolean(config.cacheEnabled)),
    }),
    React.createElement(SettingRow, {
      key: 'webSearch',
      copy,
      id: 'webSearch',
      chip: 'readOnlyHost',
      control: hostBooleanControl(copy, settings.fields.webSearch.label, readBoolean(config.searchEnabled)),
    }),
    React.createElement(SettingRow, {
      key: 'groundTruth',
      copy,
      id: 'groundTruth',
      chip: 'readOnlyHost',
      control: hostBooleanControl(copy, settings.fields.groundTruth.label, readBoolean(rawConfig.groundTruth)),
    }),
    React.createElement(SettingRow, {
      key: 'modelRouting',
      copy,
      id: 'modelRouting',
      chip: 'readOnlyHost',
      control: hostBooleanControl(copy, settings.fields.modelRouting.label, readBoolean(rawConfig.modelRouting)),
    }),
  ]

  return React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(
      'section',
      { style: SECTION_STYLE },
      React.createElement(
        'div',
        { style: HEADER_STYLE },
        React.createElement('h2', { style: HEADING_STYLE }, settings.title),
        statusChip === null
          ? null
          : React.createElement('span', { style: STATUS_CHIP_STYLE }, statusChip),
      ),
      React.createElement('p', { style: INTRO_STYLE }, settings.intro),
      offline ? React.createElement('p', { style: BANNER_STYLE, role: 'status' }, settings.states.offline) : null,
      React.createElement(Group, {
        title: settings.groups.permission.title,
        desc: settings.groups.permission.desc,
        helper: settings.groups.permission.helper,
      }, ...permissionRows),
      React.createElement(Group, {
        title: settings.groups.composer.title,
        desc: settings.groups.composer.desc,
        helper: settings.groups.composer.helper,
      }, ...composerRows),
      React.createElement(
        Group,
        {
          title: settings.groups.profession.title,
          desc: settings.groups.profession.desc,
          helper: settings.groups.profession.helper,
        },
        ...professionRows,
        state !== null && state.locked
          ? React.createElement('p', { style: NOTE_STYLE, role: 'status' }, settings.states.settingsLocked)
          : null,
        React.createElement('p', { style: GROUP_HELPER_STYLE }, settings.whyLock),
      ),
      React.createElement(Group, {
        title: settings.groups.scene.title,
        desc: settings.groups.scene.desc,
        helper: settings.groups.scene.helper,
      }, ...sceneRows),
      React.createElement(
        Group,
        {
          title: settings.groups.language.title,
          desc: settings.groups.language.desc,
          helper: settings.groups.language.helper,
        },
        ...languageRows,
        storageBlocked
          ? React.createElement('p', { style: NOTE_STYLE, role: 'status' }, settings.states.storageBlocked)
          : null,
      ),
      React.createElement(Group, {
        title: settings.groups.compaction.title,
        desc: settings.groups.compaction.desc,
        helper: settings.groups.compaction.helper,
      }, ...compactionRows),
      React.createElement(Group, {
        title: settings.groups.advanced.title,
        desc: settings.groups.advanced.desc,
        helper: settings.groups.advanced.helper,
      }, ...advancedRows),
      React.createElement('p', { style: FOOTER_STYLE }, settings.footer),
      React.createElement('p', { style: FOOTER_STYLE }, settings.applyNote),
    ),
  )
}

/* ------------------------------------------------------------------------- *
 * Local helpers
 * ------------------------------------------------------------------------- */

/** A host boolean: a disabled switch when known, an honest text value otherwise. */
function hostBooleanControl(copy: Copy, label: string, value: boolean | undefined): React.ReactElement {
  if (value === undefined) {
    return React.createElement(ValueControl, { value: booleanValue(copy, undefined) })
  }
  return React.createElement(SwitchControl, { label, checked: value, disabled: true })
}
