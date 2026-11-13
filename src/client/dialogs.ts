/** Presentation of the host-owned approval/question waterfall, without native fall-through. */
import * as React from 'react'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Alert from '@mui/material/Alert'
import Radio from '@mui/material/Radio'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import TextField from '@mui/material/TextField'
import { BlockingDialog } from './modal.js'
import { useAmpPreferences } from './preferences.js'
import { currentLocale, useCopy } from './i18n.js'
import { usableSession } from './bridge.js'
import { Markdown } from './markdown.js'

const h = React.createElement
const cast = (component: unknown): React.ComponentType<Record<string, unknown>> => component as React.ComponentType<Record<string, unknown>>
const M = { Typography: cast(Typography), Button: cast(Button), Stack: cast(Stack), Alert: cast(Alert), Radio: cast(Radio), Checkbox: cast(Checkbox), Label: cast(FormControlLabel), TextField: cast(TextField) }
interface Question { id: string; header?: string; question: string; detail?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] }
interface Pending { id: string; kind: 'approval' | 'questions'; toolName?: string; reason?: string; displayReason?: Record<string, string>; questions?: Question[] }
interface Selection { selected: string[]; custom: string }
const ROUTE = '/deepseek-coordination/dialogs'

/** UI action labels cover all shipped host locales. */
const COPY = {
  zh: ['确认', '仅本次允许', '拒绝', '取消', '提交回答', '其他回答', '请求处理失败，请重试。'],
  en: ['Confirmation', 'Allow once', 'Reject', 'Cancel', 'Submit answers', 'Other answer', 'Could not settle the request. Please retry.'],
  ja: ['確認', '今回のみ許可', '拒否', 'キャンセル', '回答を送信', 'その他の回答', '処理に失敗しました。再試行してください。'],
  es: ['Confirmación', 'Permitir una vez', 'Rechazar', 'Cancelar', 'Enviar respuestas', 'Otra respuesta', 'No se pudo procesar. Inténtalo de nuevo.'],
  fr: ['Confirmation', 'Autoriser une fois', 'Refuser', 'Annuler', 'Envoyer les réponses', 'Autre réponse', 'Échec du traitement. Réessayez.'],
  de: ['Bestätigung', 'Einmal erlauben', 'Ablehnen', 'Abbrechen', 'Antworten senden', 'Andere Antwort', 'Anfrage fehlgeschlagen. Bitte erneut versuchen.'],
  ru: ['Подтверждение', 'Разрешить один раз', 'Отклонить', 'Отмена', 'Отправить ответы', 'Другой ответ', 'Не удалось обработать запрос. Повторите попытку.'],
  pt: ['Confirmação', 'Permitir uma vez', 'Rejeitar', 'Cancelar', 'Enviar respostas', 'Outra resposta', 'Falha ao processar. Tente novamente.'],
} as const

function RequestDialog({ item, session, settled }: { item: Pending; session: string; settled: (id: string) => void }): React.ReactElement {
  useCopy()
  const locale = currentLocale()
  const labels = COPY[locale]
  const [answers, setAnswers] = React.useState<Record<string, Selection>>({})
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(false)
  const act = async (action: 'answer' | 'cancel', value: Record<string, unknown> = {}): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(false)
    try {
      const response = await fetch(`${ROUTE}/${action}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session, id: item.id, ...value }),
      })
      const body = await response.json() as { ok?: boolean }
      if (!response.ok || body.ok !== true) throw new Error('settlement failed')
      settled(item.id)
    } catch { setError(true) } finally { setBusy(false) }
  }
  const choose = (question: Question, label: string, checked: boolean): void => {
    setAnswers((current) => {
      const previous = current[question.id] ?? { selected: [], custom: '' }
      const selected = question.multiSelect
        ? checked ? [...previous.selected.filter((entry) => entry !== label), label] : previous.selected.filter((entry) => entry !== label)
        : [label]
      return { ...current, [question.id]: { ...previous, selected, custom: question.multiSelect ? previous.custom : '' } }
    })
  }
  const titleId = `amp-dialog-${item.id}`
  const title = item.kind === 'approval' ? `${labels[0]} · ${item.toolName ?? ''}` : item.questions?.[0]?.header ?? labels[4]
  return h(BlockingDialog, { titleId },
    h(M.Typography, { id: titleId, variant: 'h6', component: 'h2', sx: { mb: 2 } }, title),
    error ? h(M.Alert, { severity: 'error', sx: { mb: 2 } }, labels[6]) : null,
    item.kind === 'approval'
      ? h(Markdown, { text: item.displayReason?.[locale] ?? item.displayReason?.en ?? item.reason ?? item.toolName ?? '', compact: true, style: { marginBottom: 16 } })
      : h('div', null, ...(item.questions ?? []).map((question) => {
        const selection = answers[question.id] ?? { selected: [], custom: '' }
        return h('fieldset', { key: question.id, disabled: busy, 'aria-label': question.question, style: { border: 0, margin: '0 0 24px', padding: 0, minWidth: 0 } },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, h(Markdown, { text: question.question, compact: true })),
          question.detail ? h(Markdown, { text: question.detail, compact: true, style: { marginBottom: 8 } }) : null,
          h('div', { role: question.multiSelect ? 'group' : 'radiogroup', 'aria-label': question.question },
            ...(question.options ?? []).map((option) => h(M.Label, {
              key: option.label, sx: { display: 'flex', alignItems: 'flex-start', m: 0 },
              control: h(question.multiSelect ? M.Checkbox : M.Radio, {
                name: `${item.id}-${question.id}`, checked: selection.selected.includes(option.label),
                onChange: (_event: unknown, checked: boolean) => choose(question, option.label, checked),
              }),
              label: h('span', null,
                h('span', null, h(Markdown, { text: option.label, inline: true })),
                option.description
                  ? h('div', { style: { fontSize: '0.75rem', opacity: 0.82, marginTop: 2 } },
                    h(Markdown, { text: option.description, inline: true }))
                  : null),
            }))),
          h(M.TextField, {
            label: labels[5], fullWidth: true, multiline: true, minRows: 2, value: selection.custom,
            sx: { mt: 1 },
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              const custom = event.target.value
              setAnswers((current) => ({ ...current, [question.id]: { selected: question.multiSelect ? current[question.id]?.selected ?? [] : [], custom } }))
            },
          }),
        )
      })),
    h(M.Stack, { direction: 'row', spacing: 1, sx: { justifyContent: 'flex-end', flexWrap: 'wrap', gap: 1 } },
      h(M.Button, { disabled: busy, onClick: () => { void act('cancel') } }, labels[3]),
      item.kind === 'approval'
        ? h(React.Fragment, null,
          h(M.Button, { disabled: busy, color: 'error', variant: 'outlined', onClick: () => { void act('answer', { outcome: 'rejected' }) } }, labels[2]),
          h(M.Button, { disabled: busy, variant: 'contained', onClick: () => { void act('answer', { outcome: 'allowed-once' }) } }, labels[1]))
        : h(M.Button, {
          disabled: busy, variant: 'contained', onClick: () => {
            void act('answer', { answers: (item.questions ?? []).map((question) => ({
              id: question.id, selected: answers[question.id]?.selected ?? [],
              ...(answers[question.id]?.custom.trim() ? { custom: answers[question.id]?.custom.trim() } : {}),
            })) })
          },
        }, labels[4]),
    ),
  )
}

export function DialogHost({ sessionId }: { sessionId?: string }): React.ReactElement | null {
  const { preferences } = useAmpPreferences()
  const session = usableSession(sessionId) ? sessionId.trim() : null
  const [items, setItems] = React.useState<Pending[]>([])
  React.useEffect(() => {
    setItems([])
    if (session === null) return
    let disposed = false
    const controller = new AbortController()
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(`${ROUTE}/pending?session=${encodeURIComponent(session)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
        if (response.status === 404) return
        if (response.ok) {
          const body = await response.json() as { ok?: boolean; value?: { items?: Pending[] } }
          if (!disposed && body.ok && Array.isArray(body.value?.items)) setItems(body.value.items)
        }
      } catch { /* Preserve a pending dialog while the host reconnects. */ }
      finally { if (!disposed) timer = window.setTimeout(() => { void tick() }, 800) }
    }
    void tick()
    return () => { disposed = true; controller.abort(); window.clearTimeout(timer) }
  }, [session, preferences.takeoverNotifications])
  const item = items[0]
  // Claimed requests stay visible until host settlement, even if the setting
  // changes. Dropping a modal locally must never leave the agent waiting.
  if (!item || !session) return null
  return h(RequestDialog, { key: item.id, item, session, settled: (id) => setItems((current) => current.filter((entry) => entry.id !== id)) })
}
