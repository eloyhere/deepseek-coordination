/** MUI session records: readable summaries first, source records on demand. */
import * as React from 'react'
import ExpandMore from '@mui/icons-material/ExpandMore'
import { currentLocale } from './i18n.js'
import type { AmpListItem } from './ampData.js'
import { M, T, chipSx, h } from './ampUi.js'

const STATES: Record<string, string> = {
  active: '进行中', achieved: '已达成', abandoned: '已放弃', blocked: '受阻', unblocked: '已解除阻塞',
  cancelled: '已取消', completed: '已完成', failed: '失败', pending: '待处理', proposed: '待确认',
  draft: '草稿', approved: '已批准', executing: '执行中', ready: '就绪', in_progress: '进行中',
  running: '执行中', succeeded: '成功', completed_after_cancel: '取消后完成', cancel_requested: '已请求取消',
  draining: '收尾中', unknown_outcome: '结果待确认', verification_pending: '等待验证', valid: '有效', invalidated: '已失效',
  mounted: '已纳入上下文', unmounted: '未纳入上下文', stale: '已过期', received: '已收到', interpreting: '理解请求中',
  acting: '执行任务中', responding: '生成回复中', accepted: '已确认', captured: '已记录', fulfilled: '已满足',
  idle: '空闲', closed: '已结束', suspended: '已暂停', expired: '已过期', rejected: '未通过',
}

export function sessionStateLabel(value: string, locale = currentLocale()): string {
  if (locale.startsWith('zh')) return STATES[value] ?? value
  return value.replace(/_/g, ' ')
}

function tone(value?: string): 'success' | 'warning' | 'error' | 'neutral' {
  if (/^(failed|blocked|invalidated|rejected|unknown_outcome)$/.test(value ?? '')) return 'error'
  if (/^(completed|achieved|valid|succeeded|accepted|fulfilled)$/.test(value ?? '')) return 'success'
  if (/^(draft|pending|proposed|verification_pending|stale|cancel_requested)$/.test(value ?? '')) return 'warning'
  return 'neutral'
}

export function sessionTime(value: string, locale = currentLocale()): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)
}

const RecordRow = React.memo(function RecordRow({ item }: { item: AmpListItem }): React.ReactElement {
  const zh = currentLocale().startsWith('zh')
  return h(M.Accordion, {
    disableGutters: true, elevation: 0,
    slotProps: { transition: { unmountOnExit: true } },
    sx: { color: T.text, backgroundColor: 'transparent', backgroundImage: 'none', boxShadow: 'none', '&:before': { display: 'none' }, borderTop: `1px solid ${T.border}` },
  },
  h(M.AccordionSummary, {
    expandIcon: h(ExpandMore, { sx: { fontSize: 17, color: T.secondary } }),
    sx: { px: 0, minHeight: 54, '& .MuiAccordionSummary-content': { minWidth: 0, my: 1 }, '&.Mui-focusVisible': { outline: `2px solid ${T.accent}` } },
  }, h(M.Stack, { spacing: 0.4, sx: { width: '100%', minWidth: 0, pr: 1 } },
    h(M.Stack, { direction: 'row', alignItems: 'flex-start', spacing: 1 },
      h(M.Typography, { sx: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.55, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } }, item.title),
      item.state ? h(M.Chip, { label: sessionStateLabel(item.state), size: 'small', sx: { ...chipSx(tone(item.state), 21), flexShrink: 0 } }) : null,
    ),
    item.detail ? h(M.Typography, { sx: { fontSize: 11.5, lineHeight: 1.5, color: T.secondary, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } }, item.detail) : null,
    item.at ? h(M.Typography, { component: 'time', dateTime: item.at, title: new Date(item.at).toString(), sx: { fontSize: 10.5, color: T.secondary } }, sessionTime(item.at)) : null,
  )),
  h(M.AccordionDetails, { sx: { px: 1.25, py: 1, backgroundColor: T.surface } },
    h(M.Typography, { sx: { fontSize: 11.5, fontWeight: 600, mb: 1 } }, zh ? '原始记录 · 仅供核对' : 'Source record · for inspection'),
    h(M.Typography, { component: 'pre', sx: { m: 0, fontFamily: T.mono, fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 300, overflow: 'auto' } }, JSON.stringify(item.raw ?? { id: item.id, kind: item.kind }, null, 2)),
  ))
})

export function SessionList(props: { title: string; items: readonly AmpListItem[]; empty: string; unavailable?: boolean }): React.ReactElement {
  const zh = currentLocale().startsWith('zh')
  const [showTechnical, setShowTechnical] = React.useState(false)
  const [page, setPage] = React.useState(0)
  const technical = props.items.filter((item) => item.diagnostic).length
  const visible = React.useMemo(() => props.items.filter((item) => showTechnical || !item.diagnostic), [props.items, showTechnical])
  const pageSize = 20
  const activePage = Math.min(page, Math.max(0, Math.ceil(visible.length / pageSize) - 1))
  const from = activePage * pageSize
  const rows = visible.slice(from, from + pageSize)
  return h(M.Box, { sx: { mt: 2 }, 'data-amp-list': props.title },
    h(M.Stack, { direction: 'row', alignItems: 'center', justifyContent: 'space-between', spacing: 1, sx: { mb: 0.5 } },
      h(M.Typography, { component: 'h3', sx: { m: 0, fontSize: 13.5, fontWeight: 700 } }, props.unavailable ? `${props.title} · ${zh ? '未接入' : 'Unavailable'}` : `${props.title} · ${visible.length}`),
      technical ? h(M.Stack, { direction: 'row', alignItems: 'center', spacing: 0.5 },
        h(M.Typography, { sx: { fontSize: 11, color: T.secondary } }, zh ? `技术记录 ${technical}` : `Technical records ${technical}`),
        h(M.Switch, { size: 'small', checked: showTechnical, onChange: (_event: unknown, checked: boolean) => { setShowTechnical(checked); setPage(0) }, slotProps: { input: { 'aria-label': zh ? '显示技术记录' : 'Show technical records' } } }),
      ) : null,
    ),
    rows.length ? rows.map((item) => h(RecordRow, { key: item.id, item }))
      : h(M.Typography, { sx: { py: 1, fontSize: 12, color: T.secondary } }, technical && !showTechnical ? (zh ? '暂无业务关注事项，技术上下文已收起。' : 'No business items; technical context is collapsed.') : props.empty),
    visible.length > pageSize ? h(M.Stack, { direction: 'row', alignItems: 'center', justifyContent: 'space-between', sx: { mt: 1 } },
      h(M.Button, { size: 'small', disabled: activePage === 0, onClick: () => setPage(activePage - 1) }, zh ? '上一页' : 'Previous'),
      h(M.Typography, { sx: { fontSize: 11.5, color: T.secondary } }, `${from + 1}–${Math.min(from + pageSize, visible.length)} / ${visible.length}`),
      h(M.Button, { size: 'small', disabled: from + pageSize >= visible.length, onClick: () => setPage(activePage + 1) }, zh ? '下一页' : 'Next'),
    ) : null,
  )
}
