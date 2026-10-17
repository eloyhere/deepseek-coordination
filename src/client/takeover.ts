/**
 * Service-level takeover windows (v24 §16): approval and question forms.
 *
 * This is a plugin-owned React/Material UI dialog, not a takeover of DSH's own
 * dialogs. `conversation.takeover` is not available in this DSH build, and no
 * CSS/DOM hiding is involved: the host records the pending windows, this module
 * polls its own route and answers them.
 *
 * Behaviour:
 *  - polling runs only while the `权限接管` switch is on, the session id is a
 *    real DSH session, and `document.visibilityState === 'visible'`; the timer
 *    is cleared on hide and on unmount;
 *  - the poll updates state only when the first pending handle/type/payload
 *    changes (or the queue length changes), so a quiet poll causes no render;
 *  - the first pending request is rendered; a `1 / N` badge appears when more
 *    are queued;
 *  - approval: 仅本次允许 / 拒绝 / 取消; only `allowed-once` and `rejected` are
 *    sent as answers — 取消, `Esc` and a backdrop click cancel through the
 *    cancel route, and `unavailable` is never sent;
 *  - question: radios for single-select, checkboxes for multi-select, an
 *    optional free-text answer per question; submit stays disabled until every
 *    question is answered; 取消 posts the cancel route;
 *  - a host failure never throws into render: the dialog stays open with the
 *    localized error and the next poll can recover.
 *
 * MUI supplies the dialog's `role="dialog"`, focus trap, initial focus and
 * `Esc` handling; the title is linked with `aria-labelledby`.
 */
import * as React from 'react'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import Tooltip from '@mui/material/Tooltip'
import { currentLocale, useCopy } from './i18n.js'
import { takeoverStore } from './store.js'
import {
  answerTakeover,
  buildQuestionAnswers,
  cancelTakeover,
  isQuestionAnswerComplete,
  listPendingTakeover,
  usableSession,
} from './bridge.js'
import type {
  QuestionSelection,
  TakeoverAnswer,
  TakeoverApprovalView,
  TakeoverOptionView,
  TakeoverPendingView,
  TakeoverQuestionView,
} from './bridge.js'
import { fillTemplate } from '../shared/i18n.js'
import type { Copy, Locale } from '../shared/i18n.js'

/* MUI's generics describe every overload; this module passes one narrow shape. */
const MuiDialog: React.ComponentType<Record<string, unknown>> =
  Dialog as unknown as React.ComponentType<Record<string, unknown>>
const MuiDialogTitle: React.ComponentType<Record<string, unknown>> =
  DialogTitle as unknown as React.ComponentType<Record<string, unknown>>
const MuiDialogContent: React.ComponentType<Record<string, unknown>> =
  DialogContent as unknown as React.ComponentType<Record<string, unknown>>
const MuiDialogActions: React.ComponentType<Record<string, unknown>> =
  DialogActions as unknown as React.ComponentType<Record<string, unknown>>
const MuiButton: React.ComponentType<Record<string, unknown>> =
  Button as unknown as React.ComponentType<Record<string, unknown>>
const MuiTextField: React.ComponentType<Record<string, unknown>> =
  TextField as unknown as React.ComponentType<Record<string, unknown>>
const MuiRadio: React.ComponentType<Record<string, unknown>> =
  Radio as unknown as React.ComponentType<Record<string, unknown>>
const MuiRadioGroup: React.ComponentType<Record<string, unknown>> =
  RadioGroup as unknown as React.ComponentType<Record<string, unknown>>
const MuiCheckbox: React.ComponentType<Record<string, unknown>> =
  Checkbox as unknown as React.ComponentType<Record<string, unknown>>
const MuiFormControlLabel: React.ComponentType<Record<string, unknown>> =
  FormControlLabel as unknown as React.ComponentType<Record<string, unknown>>
const MuiTooltip: React.ComponentType<Record<string, unknown>> =
  Tooltip as unknown as React.ComponentType<Record<string, unknown>>

/** How often the pending list is polled while visible. */
const POLL_INTERVAL = 1000

/** Stable id linking the dialog's accessible name to its title. */
const TAKEOVER_TITLE_ID = 'deepseek-coordination-takeover-title'

/* ------------------------------------------------------------------------- *
 * Styles
 * ------------------------------------------------------------------------- */

const TITLE_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 14,
  fontWeight: 600,
  paddingBottom: 4,
}
const QUEUE_STYLE: React.CSSProperties = {
  marginLeft: 'auto',
  fontSize: 11,
  fontWeight: 400,
  padding: '1px 6px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-separator, #d0d0d0)',
  color: 'var(--dsw-alias-label-secondary, #666)',
}
const HEADING_STYLE: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 6 }
const TOOL_STYLE: React.CSSProperties = {
  display: 'inline-block',
  fontSize: 11,
  padding: '1px 6px',
  borderRadius: 4,
  backgroundColor: 'var(--dsw-alias-fill-secondary, rgba(0, 0, 0, 0.06))',
  marginBottom: 4,
}
const REASON_STYLE: React.CSSProperties = { fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap' }
const ERROR_STYLE: React.CSSProperties = { margin: '8px 0 0', fontSize: 12, color: '#a15c00' }
const QUESTION_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  paddingTop: 8,
  marginTop: 8,
  borderTop: '1px solid var(--dsw-alias-separator, #e0e0e0)',
}
const QUESTION_HEADER_STYLE: React.CSSProperties = { fontSize: 11, opacity: 0.7 }
const QUESTION_TEXT_STYLE: React.CSSProperties = { fontSize: 13, fontWeight: 600 }
const DETAIL_STYLE: React.CSSProperties = { fontSize: 12, opacity: 0.8, whiteSpace: 'pre-wrap' }
const OPTIONS_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 0 }
const OPTION_DESCRIPTION_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  opacity: 0.7,
  whiteSpace: 'pre-wrap',
}
const CUSTOM_STYLE: React.CSSProperties = { marginTop: 4 }

/* ------------------------------------------------------------------------- *
 * Payload narrowing (the host payload is untrusted shape)
 * ------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Narrow an approval payload; a payload with nothing to show returns null. */
function approvalView(payload: unknown): TakeoverApprovalView | null {
  const record = asRecord(payload)
  if (record === undefined) return null
  const toolName = asString(record.toolName) ?? ''
  const reason = asString(record.reason) ?? ''
  const displayReason = asRecord(record.displayReason)
  const callId = asString(record.callId)
  if (toolName.length === 0 && reason.length === 0 && displayReason === undefined) return null
  return {
    toolName,
    reason,
    ...(displayReason === undefined ? {} : { displayReason }),
    ...(callId === undefined ? {} : { callId }),
  }
}

/** Narrow a question payload into the list the form renders. */
function questionViews(payload: unknown): TakeoverQuestionView[] {
  const record = asRecord(payload)
  const raw = record?.questions
  if (!Array.isArray(raw)) return []
  const questions: TakeoverQuestionView[] = []
  for (const entry of raw) {
    const question = asRecord(entry)
    if (question === undefined) continue
    const id = asString(question.id)
    const text = asString(question.question)
    if (id === undefined || text === undefined) continue
    const options: TakeoverOptionView[] = []
    if (Array.isArray(question.options)) {
      for (const entryOption of question.options) {
        const option = asRecord(entryOption)
        const label = option === undefined ? undefined : asString(option.label)
        if (label === undefined) continue
        const description = asString(option?.description)
        options.push({ label, ...(description === undefined ? {} : { description }) })
      }
    }
    const detail = asString(question.detail)
    const header = asString(question.header)
    questions.push({
      id,
      question: text,
      options,
      multiSelect: question.multiSelect === true,
      ...(detail === undefined ? {} : { detail }),
      ...(header === undefined ? {} : { header }),
    })
  }
  return questions
}

/**
 * The reason shown for an approval: `displayReason[locale]`, then its language
 * subtag, then `en`, then the raw `reason`. Never shows an empty line while
 * another candidate exists.
 */
export function localizedReason(approval: TakeoverApprovalView, locale: Locale): string {
  const display = approval.displayReason
  if (display !== undefined) {
    const language = locale.startsWith('zh') ? 'zh' : 'en'
    for (const key of [locale, language, 'en']) {
      const value = display[key]
      if (typeof value === 'string' && value.trim().length > 0) return value
    }
  }
  return approval.reason
}

/* ------------------------------------------------------------------------- *
 * Polling
 * ------------------------------------------------------------------------- */

function pendingSignature(item: TakeoverPendingView | undefined): string {
  if (item === undefined) return ''
  return JSON.stringify([item.handle, item.type, item.session ?? '', item.payload])
}

interface PendingState {
  items: TakeoverPendingView[]
  clear: () => void
}

/**
 * Poll the pending takeover list while `enabled` and visible.
 *
 * The state setter compares the request signature first, so a poll that returns
 * the same request does not re-render the dialog, and it never touches the
 * composer row (this hook is owned by the dialog component).
 */
function usePendingTakeover(session: string | null, enabled: boolean): PendingState {
  const [items, setItems] = React.useState<TakeoverPendingView[]>([])
  const clear = React.useCallback((): void => {
    setItems((previous) => (previous.length === 0 ? previous : []))
  }, [])

  React.useEffect(() => {
    if (!enabled || session === null) {
      setItems((previous) => (previous.length === 0 ? previous : []))
      return
    }
    let alive = true
    let timer: number | null = null
    const tick = async (): Promise<void> => {
      if (!alive || document.visibilityState !== 'visible') return
      const next = await listPendingTakeover(session)
      if (!alive || next === null) return
      setItems((previous) => {
        if (
          previous.length === next.length &&
          pendingSignature(previous[0]) === pendingSignature(next[0])
        ) {
          return previous
        }
        return next
      })
    }
    const start = (): void => {
      if (timer === null) timer = window.setInterval(() => { void tick() }, POLL_INTERVAL)
    }
    const stop = (): void => {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }
    void tick()
    if (document.visibilityState === 'visible') start()
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void tick()
        start()
      } else {
        stop()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, session])

  return { items, clear }
}

/* ------------------------------------------------------------------------- *
 * Dialog
 * ------------------------------------------------------------------------- */

export interface TakeoverDialogProps {
  sessionId?: string
}

/**
 * The takeover dialog barrel: subscribes to the lane switch, polls, and renders
 * the first pending request. Rendered as a sibling of `ComposerControls` in the
 * `conversation.input.left` component, so it exists wherever the composer does.
 */
export function TakeoverDialog(props: TakeoverDialogProps): React.ReactElement | null {
  const copy = useCopy()
  const takeoverOn = React.useSyncExternalStore(takeoverStore.subscribe, takeoverStore.snapshot, takeoverStore.snapshot)
  const session = usableSession(props.sessionId) ? props.sessionId : null
  const pending = usePendingTakeover(session, takeoverOn)
  const current = pending.items[0]
  if (current === undefined) return null
  // Re-key on the payload too: if DSH replaces the content of the same handle
  // (e.g. an edited question), the form must start from a clean draft rather
  // than send labels from the previous payload.
  const requestKey = `${current.handle}:${JSON.stringify(current.payload)}`
  return React.createElement(TakeoverRequest, {
    key: requestKey,
    copy,
    locale: currentLocale(),
    item: current,
    queueIndex: 1,
    queueTotal: pending.items.length,
    onResolved: pending.clear,
  })
}

function TakeoverRequest(props: {
  copy: Copy
  locale: Locale
  item: TakeoverPendingView
  queueIndex: number
  queueTotal: number
  onResolved: () => void
}): React.ReactElement {
  const copy = props.copy
  const takeover = copy.takeover
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [selection, setSelection] = React.useState<Record<string, QuestionSelection>>({})
  const aliveRef = React.useRef(true)
  /** One POST at a time, even if a click lands before React re-renders. */
  const actionRef = React.useRef(false)

  React.useEffect(() => () => { aliveRef.current = false }, [])

  const item = props.item
  const approval = item.type === 'approval' ? approvalView(item.payload) : null
  const questions = item.type === 'question' ? questionViews(item.payload) : []
  const complete = isQuestionAnswerComplete(questions, selection)

  const submit = async (answer: TakeoverAnswer): Promise<void> => {
    if (actionRef.current) return
    actionRef.current = true
    setBusy(true)
    setError(null)
    try {
      const outcome = await answerTakeover(item.handle, answer)
      if (!aliveRef.current) return
      setBusy(false)
      if (outcome === null) {
        setError(takeover.hostError)
        return
      }
      if (!outcome.answered) {
        // A vanished window is "expired"; an invalid answer keeps the dialog for
        // another attempt, which the host allows (it does not close the window).
        setError(outcome.expired ? takeover.expired : takeover.hostError)
        return
      }
      props.onResolved()
    } finally {
      actionRef.current = false
    }
  }

  const cancel = async (): Promise<void> => {
    if (actionRef.current) return
    actionRef.current = true
    setBusy(true)
    setError(null)
    try {
      const outcome = await cancelTakeover(item.handle)
      if (!aliveRef.current) return
      setBusy(false)
      if (outcome === null) {
        setError(takeover.hostError)
        return
      }
      if (!outcome.cancelled) {
        setError(takeover.expired)
        return
      }
      props.onResolved()
    } finally {
      actionRef.current = false
    }
  }

  const close = (): void => {
    if (busy || actionRef.current) return
    void cancel()
  }

  const answerApproval = (outcome: 'allowed-once' | 'rejected'): void => {
    void submit({ kind: 'approval', outcome })
  }

  const submitQuestions = (): void => {
    try {
      void submit({ kind: 'question', answers: buildQuestionAnswers(questions, selection) })
    } catch {
      setError(takeover.hostError)
    }
  }

  const button = (label: string, onClick: () => void, disabled: boolean): React.ReactElement =>
    React.createElement(MuiButton, { size: 'small', onClick, disabled }, label)

  const actions: React.ReactElement[] = []
  if (item.type === 'approval' && approval !== null) {
    actions.push(
      button(takeover.allowOnce, () => { answerApproval('allowed-once') }, busy),
      button(takeover.reject, () => { answerApproval('rejected') }, busy),
      button(takeover.cancel, close, busy),
    )
  } else if (item.type === 'question' && questions.length > 0) {
    actions.push(
      button(takeover.submit, submitQuestions, busy || !complete),
      button(takeover.cancel, close, busy),
    )
  } else {
    // A payload this build cannot render still gets a way out.
    actions.push(button(takeover.cancel, close, busy))
  }

  const heading = item.type === 'approval' ? takeover.approvalTitle : takeover.questionTitle
  const content: React.ReactNode[] = [
    React.createElement('div', { key: 'heading', style: HEADING_STYLE }, heading),
  ]
  if (item.type === 'approval') {
    content.push(React.createElement(ApprovalBody, {
      key: 'approval',
      copy,
      locale: props.locale,
      approval,
    }))
  } else {
    if (questions.length === 0) {
      content.push(React.createElement('p', { key: 'empty', style: ERROR_STYLE }, takeover.hostError))
    }
    for (const question of questions) {
      content.push(React.createElement(QuestionBlock, {
        key: question.id,
        copy,
        question,
        disabled: busy,
        draft: selection[question.id] ?? { selected: [], custom: '' },
        onChange: (next: QuestionSelection) => {
          setSelection((previous) => ({ ...previous, [question.id]: next }))
        },
      }))
    }
  }
  if (error !== null) {
    content.push(React.createElement('p', { key: 'error', style: ERROR_STYLE, role: 'alert' }, error))
  }

  return React.createElement(
    MuiDialog,
    {
      open: true,
      onClose: close,
      maxWidth: 'sm',
      fullWidth: true,
      'aria-labelledby': TAKEOVER_TITLE_ID,
    },
    React.createElement(
      MuiDialogTitle,
      { id: TAKEOVER_TITLE_ID, sx: TITLE_STYLE },
      takeover.title,
      props.queueTotal > 1
        ? React.createElement(
          'span',
          { style: QUEUE_STYLE },
          fillTemplate(takeover.queueLabel, {
            index: String(props.queueIndex),
            total: String(props.queueTotal),
          }),
        )
        : null,
    ),
    React.createElement(MuiDialogContent, null, ...content),
    React.createElement(MuiDialogActions, null, ...actions),
  )
}

function ApprovalBody(props: {
  copy: Copy
  locale: Locale
  approval: TakeoverApprovalView | null
}): React.ReactElement {
  const approval = props.approval
  if (approval === null) {
    return React.createElement('p', { style: ERROR_STYLE }, props.copy.takeover.hostError)
  }
  const reason = localizedReason(approval, props.locale)
  const reasonNode = reason.length === 0
    ? null
    : approval.reason.length > 0 && approval.reason !== reason
      // The localized sentence is on screen; the original stays available.
      ? React.createElement(MuiTooltip, { title: approval.reason, placement: 'top', describeChild: true },
        React.createElement('span', { style: REASON_STYLE }, reason))
      : React.createElement('span', { style: REASON_STYLE }, reason)
  return React.createElement(
    'div',
    null,
    approval.toolName.length === 0
      ? null
      : React.createElement('div', { style: TOOL_STYLE }, approval.toolName),
    reasonNode,
  )
}

function QuestionBlock(props: {
  copy: Copy
  question: TakeoverQuestionView
  draft: QuestionSelection
  disabled: boolean
  onChange: (next: QuestionSelection) => void
}): React.ReactElement {
  const { copy, question, draft, disabled } = props
  const single = question.multiSelect !== true
  /**
   * The host rejects option + custom together for a question with options, so
   * the two inputs are mutually exclusive: picking an option clears the free
   * text, and typing free text clears the picked options. A disabled field with
   * stale text would be the alternative, but it would trap a single-select
   * operator after one radio click.
   */
  const withSelected = (selected: string[]): void => {
    props.onChange({ selected, custom: '' })
  }
  const optionLabel = (option: TakeoverOptionView): React.ReactNode =>
    React.createElement(
      'span',
      null,
      option.label,
      option.description === undefined
        ? null
        : React.createElement('span', { style: OPTION_DESCRIPTION_STYLE }, option.description),
    )
  const optionNodes = question.options.map((option) => {
    if (single) {
      return React.createElement(
        MuiFormControlLabel,
        {
          key: option.label,
          value: option.label,
          control: React.createElement(MuiRadio, { value: option.label, disabled }),
          label: optionLabel(option),
        },
      )
    }
    const checked = draft.selected.includes(option.label)
    return React.createElement(
      MuiFormControlLabel,
      {
        key: option.label,
        control: React.createElement(MuiCheckbox, {
          checked,
          disabled,
          onChange: (event: { target: { checked: boolean } }) => {
            if (event.target.checked) {
              withSelected([...draft.selected, option.label])
            } else {
              withSelected(draft.selected.filter((label) => label !== option.label))
            }
          },
        }),
        label: optionLabel(option),
      },
    )
  })
  const optionsNode = single
    ? React.createElement(
      MuiRadioGroup,
      {
        value: draft.selected[0] ?? '',
        onChange: (event: { target: { value: string } }) => {
          withSelected([String(event.target.value)])
        },
      },
      ...optionNodes,
    )
    : React.createElement('div', { style: OPTIONS_STYLE }, ...optionNodes)

  return React.createElement(
    'div',
    { style: QUESTION_STYLE },
    question.header === undefined
      ? null
      : React.createElement('div', { style: QUESTION_HEADER_STYLE }, question.header),
    React.createElement('div', { style: QUESTION_TEXT_STYLE }, question.question),
    question.detail === undefined
      ? null
      : React.createElement('div', { style: DETAIL_STYLE }, question.detail),
    question.options.length === 0 ? null : optionsNode,
    React.createElement(MuiTextField, {
      size: 'small',
      variant: 'outlined',
      fullWidth: true,
      value: draft.custom,
      placeholder: copy.takeover.customPlaceholder,
      // MUI 9 forwards html-input props through `slotProps`; `inputProps` would
      // land on the FormControl root and lose the accessible name.
      slotProps: { htmlInput: { 'aria-label': copy.takeover.customPlaceholder } },
      disabled,
      sx: CUSTOM_STYLE,
      onChange: (event: { target: { value: string } }) => {
        const custom = event.target.value
        props.onChange({
          selected: custom.length > 0 ? [] : draft.selected,
          custom,
        })
      },
    }),
  )
}
