/**
 * The `协调` settings page (v23 §15.2).
 *
 * Two independent switches keep their old behaviour (takeover hides the host's
 * access-mode control; workflow shows or hides the composer selectors), plus
 * the new 职能 group. The 职能锁定 switch is forced on and cannot be turned
 * off: it is the plugin's core safety constraint, so the page states that fact
 * rather than offering a control that would lie.
 */
import * as React from 'react'
import Switch from '@mui/material/Switch'
import Tooltip from '@mui/material/Tooltip'
import { ThemeProvider } from '@mui/material/styles'
import { theme } from './theme.js'
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
  const takeoverOn = React.useSyncExternalStore(takeoverStore.subscribe, takeoverStore.snapshot, takeoverStore.snapshot)
  const workflowOn = React.useSyncExternalStore(workflowStore.subscribe, workflowStore.snapshot, workflowStore.snapshot)

  return React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(
      'section',
      { style: SECTION_STYLE },
      React.createElement('h2', { style: HEADING_STYLE }, '协调'),
      React.createElement(SwitchRow, {
        label: '权限接管',
        checked: takeoverOn,
        hint: '已接管时隐藏 DSH 输入框的访问模式控件，改用协调面板的权限下拉；未接管时保留 DSH 自带控件。',
        onChange: (value: boolean) => { setTakeover(value) },
      }),
      React.createElement('p', { style: HINT_STYLE }, takeoverOn
        ? '已接管：输入框中的权限下拉已被隐藏，替换为协调面板的权限下拉。'
        : '未接管：输入框保留宿主自带的权限下拉。'),
      React.createElement(SwitchRow, {
        label: '工作流',
        checked: workflowOn,
        hint: '显示或隐藏输入框中的职能 / 交互 / 情景 / 验证四个下拉框；关闭后该位置不贡献任何控件。',
        onChange: (value: boolean) => { setWorkflow(value) },
      }),
      React.createElement('p', { style: HINT_STYLE }, workflowOn
        ? '工作流开启：输入框显示职能 / 交互 / 情景 / 验证四个下拉框。'
        : '工作流关闭：输入框隐藏职能 / 交互 / 情景 / 验证四个下拉框。'),

      React.createElement(
        'div',
        { style: GROUP_STYLE },
        React.createElement('h3', { style: GROUP_TITLE_STYLE }, '职能 Profession'),
        React.createElement(SwitchRow, {
          label: '职能锁定',
          checked: true,
          disabled: true,
          hint: '强制开关：每个任务只能有一个职能，Turn 内不可切换。关闭它等于放弃问责链，因此不提供关闭入口。',
        }),
        React.createElement(ValueRow, {
          label: '默认职能',
          value: '执行',
          hint: '配置项 profession.default；agent 在任务开始时可以改选，但本 Turn 开始后即锁定。',
        }),
        React.createElement(SwitchRow, {
          label: '重建时可重选',
          checked: true,
          disabled: true,
          hint: '重建任务（rebuild）结束旧任务并创建新任务，新任务可以重新选择职能。',
        }),
        React.createElement(SwitchRow, {
          label: '丢弃时可重选',
          checked: true,
          disabled: true,
          hint: '丢弃任务（abandon）不创建新任务；下一个任务可以重新选择职能。',
        }),
        React.createElement(SwitchRow, {
          label: '职能审计',
          checked: true,
          disabled: true,
          hint: '每次锁定、重建、丢弃写入 OrchestrationTrace，形成不可篡改的哈希链。',
        }),
        React.createElement(SwitchRow, {
          label: '锁定错误提示',
          checked: true,
          disabled: true,
          hint: '拒绝修改已锁定职能时，错误会带上重建（rebuild）或丢弃（abandon）的提示。',
        }),
      ),

      React.createElement('p', { style: FOOTER_STYLE },
        '下拉框的选项提示来自 v23 §15.1；权限预设目录由 DSH 提供，本插件只读展示并写回所选预设。'),
    ),
  )
}
