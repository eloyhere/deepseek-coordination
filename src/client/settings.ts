/**
 * The `协调` settings page (v23 §15.2).
 *
 * Two independent switches keep their old behaviour (takeover hides the host's
 * access-mode control; workflow shows or hides the composer selectors), plus
 * the new 职能 group. The 职能锁定 switch is forced on and cannot be turned
 * off: it is the plugin's core safety constraint, so the page states that fact
 * rather than offering a control that would lie.
 *
 * All copy comes from the locale store; a language change re-renders the page
 * without touching the two switch values. Rows whose switch mirrors a config
 * default that *can* be turned off in configuration (audit, lock error hint)
 * say so in their tooltip instead of pretending the value is immutable.
 */
import * as React from 'react'
import Switch from '@mui/material/Switch'
import Tooltip from '@mui/material/Tooltip'
import { ThemeProvider } from '@mui/material/styles'
import { theme } from './theme.js'
import { useCopy } from './i18n.js'
import { setTakeover, setWorkflow, takeoverStore, workflowStore } from './store.js'

const MuiSwitch: React.ComponentType<Record<string, unknown>> =
  Switch as unknown as React.ComponentType<Record<string, unknown>>
const MuiTooltip: React.ComponentType<Record<string, unknown>> =
  Tooltip as unknown as React.ComponentType<Record<string, unknown>>

const SECTION_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const HEADING_STYLE: React.CSSProperties = { margin: 0, fontSize: 15 }
const GROUP_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginTop: 4,
  paddingTop: 8,
  borderTop: '1px solid var(--dsw-alias-separator, #e0e0e0)',
}
const GROUP_TITLE_STYLE: React.CSSProperties = { margin: 0, fontSize: 13, fontWeight: 600 }
const ROW_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  cursor: 'help',
}
const HINT_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary, #666)',
}
const VALUE_STYLE: React.CSSProperties = { fontSize: 13, opacity: 0.85 }
const FOOTER_STYLE: React.CSSProperties = { margin: '6px 0 0', fontSize: 11, opacity: 0.7 }

function SwitchRow(props: {
  label: string
  checked: boolean
  disabled?: boolean
  hint: string
  onChange?: (value: boolean) => void
}): React.ReactElement {
  const control = React.createElement(
    MuiSwitch,
    {
      size: 'small',
      checked: props.checked,
      disabled: props.disabled === true,
      inputProps: { 'aria-label': props.label },
      onChange: (event: { target: { checked: boolean } }) => {
        if (props.onChange !== undefined) props.onChange(event.target.checked)
      },
    },
  )
  return React.createElement(
    MuiTooltip,
    { title: props.hint, placement: 'right', describeChild: true },
    React.createElement(
      'span',
      { style: ROW_STYLE, tabIndex: 0 },
      control,
      React.createElement('span', null, props.label),
    ),
  )
}

function ValueRow(props: { label: string; value: string; hint: string }): React.ReactElement {
  return React.createElement(
    MuiTooltip,
    { title: props.hint, placement: 'right', describeChild: true },
    React.createElement(
      'span',
      { style: ROW_STYLE, tabIndex: 0 },
      React.createElement('span', null, props.label),
      React.createElement('span', { style: VALUE_STYLE }, props.value),
    ),
  )
}

export function CoordinationSettings(): React.ReactElement {
  const copy = useCopy()
  const takeoverOn = React.useSyncExternalStore(takeoverStore.subscribe, takeoverStore.snapshot, takeoverStore.snapshot)
  const workflowOn = React.useSyncExternalStore(workflowStore.subscribe, workflowStore.snapshot, workflowStore.snapshot)

  const settings = copy.settings
  const group = settings.professionGroup
  // Disabled rows that mirror a config default must say the default is switchable
  // in configuration, so the disabled control never implies a hard rule.
  const displayOnlyHint = (hint: string): string => `${hint} ${group.displayOnly}`

  return React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(
      'section',
      { style: SECTION_STYLE },
      React.createElement('h2', { style: HEADING_STYLE }, settings.title),
      React.createElement(SwitchRow, {
        label: settings.takeover.label,
        checked: takeoverOn,
        hint: settings.takeover.hint,
        onChange: (value: boolean) => { setTakeover(value) },
      }),
      React.createElement('p', { style: HINT_STYLE }, takeoverOn ? settings.takeover.onLine : settings.takeover.offLine),
      React.createElement(SwitchRow, {
        label: settings.workflow.label,
        checked: workflowOn,
        hint: settings.workflow.hint,
        onChange: (value: boolean) => { setWorkflow(value) },
      }),
      React.createElement('p', { style: HINT_STYLE }, workflowOn ? settings.workflow.onLine : settings.workflow.offLine),

      React.createElement(
        'div',
        { style: GROUP_STYLE },
        React.createElement('h3', { style: GROUP_TITLE_STYLE }, group.title),
        React.createElement(SwitchRow, {
          label: group.lock.label,
          checked: true,
          disabled: true,
          hint: group.lock.hint,
        }),
        React.createElement(ValueRow, {
          label: group.defaultProfession.label,
          // The host exposes no config route to the client, so the page states
          // the truth — it follows profession.default — instead of hardcoding a
          // value that configuration may have changed.
          value: group.defaultProfessionValue,
          hint: group.defaultProfession.hint,
        }),
        React.createElement(SwitchRow, {
          label: group.rebuildReselect.label,
          checked: true,
          disabled: true,
          hint: group.rebuildReselect.hint,
        }),
        React.createElement(SwitchRow, {
          label: group.abandonReselect.label,
          checked: true,
          disabled: true,
          hint: group.abandonReselect.hint,
        }),
        React.createElement(SwitchRow, {
          label: group.audit.label,
          checked: true,
          disabled: true,
          hint: displayOnlyHint(group.audit.hint),
        }),
        React.createElement(SwitchRow, {
          label: group.lockErrorHint.label,
          checked: true,
          disabled: true,
          hint: displayOnlyHint(group.lockErrorHint.hint),
        }),
      ),

      React.createElement('p', { style: FOOTER_STYLE }, settings.footer),
    ),
  )
}
