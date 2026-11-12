/**
 * The AMP strip above the composer.
 *
 * The strip is the protocol's "at a glance" surface: one line, three facts
 * (state, module/verb coverage, active work) and one obvious way to go deeper.
 * Everything else lives in a dialog, so the composer keeps its quiet rhythm;
 * the full catalog remains in Settings. The component is deliberately read-only
 * — AMP authority still belongs to the host and the model, never to this strip.
 */
import * as React from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import ChevronRight from '@mui/icons-material/ChevronRight'
import CloseIcon from '@mui/icons-material/Close'
import CheckCircle from '@mui/icons-material/CheckCircle'
import ErrorIcon from '@mui/icons-material/Error'
import RefreshIcon from '@mui/icons-material/Refresh'
import Hub from '@mui/icons-material/Hub'
import Memory from '@mui/icons-material/Memory'
import Bolt from '@mui/icons-material/Bolt'
import History from '@mui/icons-material/History'
import Savings from '@mui/icons-material/Savings'
import TokenIcon from '@mui/icons-material/Token'
import PriceCheck from '@mui/icons-material/PriceCheck'
import Insights from '@mui/icons-material/Insights'
import InfoOutlined from '@mui/icons-material/InfoOutlined'
import ExpandMore from '@mui/icons-material/ExpandMore'
import {
  COUNT_ORDER,
  formatClock,
  formatCompactCount,
  formatCount,
  formatMoney,
  formatRatio,
  mutatingVerbs,
  shortToolName,
  totalVerbs,
  useAmpData,
  type AmpBenefitBand,
  type AmpJournalEntry,
  type AmpListItem,
  type AmpModule,
  type AmpSnapshot,
} from './ampData.js'
import { ampTranslate } from './ampCopy.js'
import { SessionList } from './sessionList.js'
import { useAmpPreferences } from './preferences.js'
import { currentLocale } from './i18n.js'
import {
  ErrorNotice,
  InfoRow,
  LoadingRows,
  M,
  MetricTile,
  SectionTitle,
  StatusDot,
  T,
  chipSx,
  dialogPaperSx,
  h,
  surfaceSx,
} from './ampUi.js'

export type AmpPanelProps = PropsRuntime<'conversation.input.dock'> & {
  readonly t?: (key: string) => string
}

/** Stable display name for the protocol, independent of the host version. */
const PROTOCOL_VERSION = '0.9.1'

function callRow(entry: AmpJournalEntry, index: number, t: (key: string) => string): React.ReactElement {
  const ok = entry.ok !== false
  return h(
    M.Stack,
    {
      key: `${entry.tool}-${index}`,
      direction: 'row',
      alignItems: 'center',
      spacing: 0.75,
      sx: { py: 0.5, minWidth: 0 },
    },
    h(ok ? CheckCircle : ErrorIcon, { sx: { fontSize: 13, color: ok ? T.success : T.error, flex: '0 0 auto' } }),
    h(
      M.Typography,
      {
        variant: 'caption',
        noWrap: true,
        sx: { flex: 1, minWidth: 0, fontFamily: T.mono, fontSize: 11, color: T.text },
      },
      localToolName(entry.tool),
    ),
    entry.mutating === true
      ? h(M.Chip, { size: 'small', label: t('mutating'), sx: chipSx('warning', 17) })
      : null,
    h(
      M.Typography,
      { variant: 'caption', sx: { flex: '0 0 auto', color: T.tertiary, fontSize: 10.5, fontFamily: T.mono } },
      typeof entry.durationMs === 'number' ? `${Math.round(entry.durationMs)} ms` : '—',
    ),
  )
}

function shortSessionId(value: string): string {
  return value.replace(/^session-/, '').slice(0, 8)
}

const TOOL_LABELS: Readonly<Record<string, string>> = {
  workspace: '工作区',
  read: '读取文件',
  write: '写入文件',
  list: '列出文件',
  outline: '读取文件大纲',
  diff: '比较文件',
  get: '读取信息',
  status: '查看状态',
  current: '读取当前轮次',
  report_status: '汇报状态',
  report_progress: '汇报进度',
  run: '运行工具',
  inspect_tool: '检查工具',
  find_tools: '查找工具',
  read_handle: '读取执行结果',
  set: '更新设置',
  submit_evidence: '提交证据',
  propose_draft: '提出计划草案',
  notification: '宿主通知',
}

function localToolName(tool: string): string {
  const short = shortToolName(tool)
  const separator = short.lastIndexOf('.')
  if (separator < 0) return TOOL_LABELS[short] ?? short
  const module = short.slice(0, separator)
  const verb = short.slice(separator + 1)
  const verbLabel = TOOL_LABELS[verb] ?? verb.replace(/_/g, ' ')
  if (module === 'workspace') return `工作区 · ${verbLabel}`
  if (module === 'session') return `会话 · ${verbLabel}`
  if (module === 'turn') return `轮次 · ${verbLabel}`
  if (module === 'goal') return `目标 · ${verbLabel}`
  if (module === 'mission') return `使命 · ${verbLabel}`
  if (module === 'plan') return `计划 · ${verbLabel}`
  if (module === 'task') return `任务 · ${verbLabel}`
  if (module === 'action') return `动作 · ${verbLabel}`
  if (module === 'attention') return `注意力 · ${verbLabel}`
  if (module === 'project') return `项目 · ${verbLabel}`
  if (module === 'evidence') return `证据 · ${verbLabel}`
  return `${module} · ${verbLabel}`
}

function ModuleRow(props: {
  readonly module: AmpModule
  readonly t: (key: string) => string
}): React.ReactElement {
  const { module, t } = props
  return h(
    M.Stack,
    { direction: 'row', alignItems: 'center', spacing: 1, sx: { py: 0.45, minWidth: 0 } },
    h(M.Typography, {
      variant: 'caption',
      noWrap: true,
      sx: { width: 92, flex: '0 0 auto', fontFamily: T.mono, fontSize: 11, color: T.text },
    }, module.module),
    h(M.Typography, {
      variant: 'caption',
      noWrap: true,
      sx: { flex: 1, minWidth: 0, color: T.tertiary, fontSize: 10.5 },
    }, module.summary ?? ''),
    h(M.Chip, { size: 'small', label: `${(module.verbs?.length ?? 0)} ${t('verbs')}`, sx: chipSx('accent', 16) }),
  )
}

/** Map a quality band onto the tile's icon tone. */
function qualityTone(band: AmpBenefitBand | undefined): 'success' | 'accent' | 'warning' {
  if (band === 'excellent') return 'success'
  if (band === 'good') return 'accent'
  return 'warning'
}

/** Translation key for a quality band. */
function bandLabelKey(band: AmpBenefitBand): string {
  if (band === 'excellent') return 'valueBandExcellent'
  if (band === 'good') return 'valueBandGood'
  if (band === 'fair') return 'valueBandFair'
  return 'valueBandPoor'
}

/** One small pill for the composer strip; text only, never colour-only. */
function ValueChip(props: {
  readonly label: string
  readonly tone: 'neutral' | 'accent' | 'success' | 'warning'
  readonly compactHidden?: boolean
}): React.ReactElement {
  return h(M.Chip, {
    size: 'small',
    label: props.label,
    sx: {
      ...chipSx(props.tone, 17),
      display: props.compactHidden === true ? { xs: 'none', sm: 'inline-flex' } : 'inline-flex',
      flex: '0 0 auto',
    },
  })
}

/**
 * Value quantification: five KPI tiles, an honest saving/injection ledger and
 * a methodology disclosure.
 *
 * The block is read-only and derived entirely from host counters. It never
 * claims a model benchmark: the quality tile is a guardrail index, the token
 * and cost tiles are conservative estimates, and the methodology says so.
 */
function BenefitSection(props: {
  readonly data: AmpSnapshot
  readonly t: (key: string) => string
}): React.ReactElement | null {
  const benefits = props.data.context?.benefits
  if (benefits === undefined) return null
  const { t } = props
  const quality = benefits.quality
  const confidenceKey = benefits.confidence === 'high'
    ? 'valueConfidenceHigh'
    : benefits.confidence === 'medium'
      ? 'valueConfidenceMedium'
      : benefits.confidence === 'low'
        ? 'valueConfidenceLow'
        : 'valueConfidenceNone'
  const confidenceTone = benefits.confidence === 'high'
    ? 'success'
    : benefits.confidence === 'medium'
      ? 'accent'
      : 'warning'
  const qualityHint = quality === null
    ? t('valueAwaitingCompile')
    : `${t(bandLabelKey(quality.band))} · ${quality.delta >= 0 ? '+' : ''}${formatCount(quality.delta)} ${t('valueVsBaseline')}`
  const savingHint = benefits.tokens.saved > 0
    ? `${t('valueToolShort')} ${formatCompactCount(benefits.tokens.spill + benefits.tokens.retention)} · ${t('valuePruneShort')} ${formatCompactCount(benefits.tokens.prune)}`
    : t('valueNoSaving')
  const priced = benefits.cost.priced
  const modelLabel = benefits.model?.model ?? '—'
  const windowKey = benefits.pricing?.window === 'peak'
    ? 'valuePeak'
    : benefits.pricing?.window === 'off-peak'
      ? 'valueOffPeak'
      : 'valueFlat'
  const cachePct = `${Math.round((benefits.cache.hitRate ?? 0) * 100)}%`
  const costHint = !priced
    ? t('valueUnpriced')
    : benefits.tokens.saved > 0
      ? `${t('valuePriceHint')} ${formatMoney(benefits.cost.pricePerMillion)}/M`
      : t('valueNoSaving')
  const saved = benefits.tokens.saved
  const injected = benefits.tokens.injected
  const total = saved + injected
  const savedShare = total <= 0 ? 0 : Math.max(0, Math.min(100, (saved / total) * 100))
  const net = benefits.tokens.net
  const errors = benefits.errors
  const effectiveness = benefits.effectiveness
  const errorPct = errors === null ? '—' : `${(errors.errorRate * 100).toFixed(1)}%`
  const effectivenessHint = effectiveness === null
    ? t('valueEffectivenessPending')
    : `${t('valueQuality')} ${effectiveness.components.quality} · ${t('valueDuration')} ${effectiveness.components.duration} · ${t('valueErrorFree')} ${effectiveness.components.errorFree} · ${t('valueRoi')} ${effectiveness.components.roi}`
  const qualityComponents = quality === null
    ? ''
    : `${quality.components.freshness} / ${quality.components.budget} / ${quality.components.verification} / ${quality.components.reliability}`

  return h(
    M.Box,
    { sx: { mt: props.data.error ? 1.5 : 0 } },
    h(SectionTitle, {
      title: t('value'),
      hint: `${t('valueEstimate')} · ${modelLabel} · ${t(windowKey)}${benefits.history.persisted ? ` · ${t('valueHistory')}` : ''}`,
      action: h(
        M.Stack,
        { direction: 'row', alignItems: 'center', spacing: 0.5 },
        h(M.Chip, {
          size: 'small',
          label: `${t('valueConfidence')} ${t(confidenceKey)}`,
          sx: chipSx(confidenceTone, 17),
        }),
        h(
          M.Tooltip,
          { title: t('valueMethodShort') },
          h(
            M.Box,
            {
              component: 'span',
              tabIndex: 0,
              'aria-label': t('valueMethodShort'),
              sx: { display: 'inline-flex', color: T.tertiary, cursor: 'help', borderRadius: '50%' },
            },
            h(InfoOutlined, { sx: { fontSize: 15 } }),
          ),
        ),
      ),
    }),
    benefits.available
      ? h(
        M.Box,
        { sx: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1 } },
        h(MetricTile, {
          label: t('valueQuality'),
          value: quality === null ? '—' : `${quality.score}%`,
          hint: qualityHint,
          icon: Insights,
          tone: qualityTone(quality?.band),
        }),
        h(MetricTile, {
          label: t('valueBenefit'),
          value: priced ? formatMoney(benefits.cost.net) : '—',
          hint: priced ? t('valueNetBenefitHint') : t('valueUnpricedHint'),
          icon: Savings,
          tone: priced && benefits.cost.net >= 0 ? 'success' : 'warning',
        }),
        h(MetricTile, {
          label: t('valueToken'),
          value: formatCompactCount(saved),
          hint: savingHint,
          icon: TokenIcon,
          tone: 'accent',
        }),
        h(MetricTile, {
          label: t('valueCost'),
          value: priced ? formatMoney(benefits.cost.saved) : '—',
          hint: costHint,
          icon: PriceCheck,
          tone: priced && saved > 0 ? 'success' : 'neutral',
        }),
        h(
          M.Box,
          { sx: { gridColumn: '1 / -1' } },
          h(MetricTile, {
            label: t('valueEffectiveness'),
            value: effectiveness === null ? '—' : `${effectiveness.score}%`,
            hint: effectivenessHint,
            icon: Insights,
            tone: effectiveness === null
              ? 'neutral'
              : effectiveness.score >= 80
                ? 'success'
                : effectiveness.score >= 60
                  ? 'accent'
                  : 'warning',
          }),
        ),
      )
      : h(
        M.Paper,
        { variant: 'outlined', sx: { ...surfaceSx, px: 1.25, py: 1.1 } },
        h(
          M.Stack,
          { direction: 'row', alignItems: 'center', spacing: 1 },
          h(
            M.Box,
            { sx: { width: 32, height: 32, flex: '0 0 auto', display: 'grid', placeItems: 'center', borderRadius: T.radiusSm, color: T.accent, backgroundColor: `color-mix(in srgb, ${T.accent} 10%, transparent)` } },
            h(Savings, { sx: { fontSize: 17 } }),
          ),
          h(
            M.Stack,
            { spacing: 0.25, sx: { minWidth: 0 } },
            h(M.Typography, { variant: 'body2', sx: { fontSize: 12, fontWeight: 600, color: T.text } }, t('valueUnavailable')),
            h(M.Typography, { variant: 'caption', sx: { color: T.tertiary, fontSize: 10.5 } }, t('valueUnavailableHint')),
          ),
        ),
      ),
    benefits.available
      ? h(
        M.Paper,
        { variant: 'outlined', sx: { ...surfaceSx, px: 1.25, py: 1, mt: 1 } },
        h(
          M.Stack,
          { direction: 'row', alignItems: 'baseline', justifyContent: 'space-between', spacing: 1, sx: { mb: 0.4 } },
          h(M.Typography, { variant: 'caption', sx: { color: T.secondary, fontSize: 10.5 } }, `${t('valueSaved')} ${formatCount(saved)} tok`),
          h(M.Typography, { variant: 'caption', sx: { color: T.tertiary, fontSize: 10.5, fontFamily: T.mono } }, `${t('valueInjected')} ${formatCount(injected)} tok`),
        ),
        h(
          M.Box,
          { sx: { display: 'flex', height: 5, borderRadius: 3, overflow: 'hidden', backgroundColor: T.surface, mb: 0.75 }, 'aria-hidden': true },
          h(M.Box, { sx: { width: `${savedShare.toFixed(1)}%`, backgroundColor: T.success } }),
          h(M.Box, { sx: { flex: 1, backgroundColor: `color-mix(in srgb, ${T.accent} 38%, transparent)` } }),
        ),
        h(InfoRow, { label: t('valueSpill'), value: `${formatCount(benefits.tokens.spill)} tok`, mono: true }),
        h(InfoRow, {
          label: t('valueRetention'),
          value: benefits.tokens.omittedItems > 0
            ? `${formatCount(benefits.tokens.retention)} tok · ${formatCount(benefits.tokens.omittedItems)} ${t('valueOmittedItems')}`
            : `${formatCount(benefits.tokens.retention)} tok`,
          mono: true,
        }),
        h(InfoRow, { label: t('valuePrune'), value: `${formatCount(benefits.tokens.prune)} tok`, mono: true }),
        h(InfoRow, {
          label: t('valueContextPrune'),
          value: `${formatCount(benefits.tokens.contextPruneRecords)} ${t('valueItemsShort')} · ${t('valueOriginalTokens')} ${formatCount(benefits.tokens.contextPrune)} tok`,
          mono: true,
        }),
        h(InfoRow, {
          label: t('valueCompaction'),
          value: `${formatCount(benefits.tokens.compactionRecords)} ${t('valueTimesShort')} · ${t('valueOriginalTokens')} ${formatCount(benefits.tokens.compaction)} tok`,
          mono: true,
        }),
        h(InfoRow, { label: t('valueCache'), value: `${formatCount(benefits.tokens.cacheReuse)} tok · ${t('valueCacheNote')}`, mono: true }),
        h(InfoRow, {
          label: t('valueCacheHit'),
          value: `${cachePct} · ${formatCount(benefits.cache.cacheReadTokens)} / ${formatCount(benefits.cache.totalInputTokens)} tok`,
          mono: true,
        }),
        h(InfoRow, {
          label: t('valueEffectiveInput'),
          value: priced ? `${formatMoney(benefits.cost.pricePerMillion)}/M` : t('valueUnpriced'),
          mono: true,
        }),
        h(InfoRow, { label: t('valueRoi'), value: formatRatio(benefits.tokens.roi), mono: true }),
        h(InfoRow, {
          label: t('valueErrorRate'),
          value: errors === null || errors.calls === 0
            ? t('valueNoCalls')
            : `${errorPct} · ${formatCount(errors.failures)} / ${formatCount(errors.calls)} ${t('valueCalls')}`,
          mono: true,
          ...(errors !== null && errors.errorRate > 0 ? { tone: 'warning' as const } : {}),
        }),
        h(InfoRow, {
          label: t('valueExecution'),
          value: errors === null || errors.calls === 0
            ? '—'
            : `p95 ${formatCount(errors.p95DurationMs)}ms · ${t('valueTarget')} ${formatCount(errors.durationTargetMs)}ms`,
          mono: true,
        }),
        h(InfoRow, {
          label: t('valueNet'),
          value: `${net >= 0 ? '+' : ''}${formatCount(net)} tok`,
          mono: true,
          tone: net >= 0 ? 'success' : 'warning',
        }),
      )
      : null,
    h(
      M.Accordion,
      {
        disableGutters: true,
        elevation: 0,
        sx: {
          mt: 1,
          border: `1px solid ${T.border}`,
          borderRadius: T.radius,
          backgroundColor: T.surface,
          backgroundImage: 'none',
          '&:before': { display: 'none' },
        },
      },
      h(
        M.AccordionSummary,
        {
          expandIcon: h(ExpandMore, { sx: { fontSize: 17, color: T.tertiary } }),
          sx: { minHeight: 34, px: 1.25, '& .MuiAccordionSummary-content': { my: 0.5, alignItems: 'center' } },
        },
        h(
          M.Stack,
          { direction: 'row', alignItems: 'center', spacing: 0.5 },
          h(InfoOutlined, { sx: { fontSize: 13, color: T.tertiary } }),
          h(M.Typography, { variant: 'caption', sx: { fontSize: 10.5, fontWeight: 600, color: T.secondary } }, t('valueMethod')),
        ),
      ),
      h(
        M.AccordionDetails,
        { sx: { px: 1.25, pb: 1.25, pt: 0 } },
        h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.secondary, fontSize: 10.5, mb: 0.5 } }, t('valueMethodQuality')),
        qualityComponents.length > 0
          ? h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.tertiary, fontSize: 10.5, mb: 0.5, fontFamily: T.mono } }, `${t('valueQualityComponents')} ${qualityComponents}`)
          : null,
        h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.secondary, fontSize: 10.5, mb: 0.5 } }, t('valueMethodQualityOptimized')),
        h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.secondary, fontSize: 10.5, mb: 0.5 } }, t('valueMethodEffectiveness')),
        effectiveness === null
          ? null
          : h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.tertiary, fontSize: 10.5, mb: 0.5, fontFamily: T.mono } }, effectiveness.formula),
        h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.secondary, fontSize: 10.5, mb: 0.5 } }, t('valueMethodErrors')),
        h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.secondary, fontSize: 10.5, mb: 0.5 } }, t('valueMethodHistory')),
        h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.secondary, fontSize: 10.5, mb: 0.5 } }, t('valueMethodTokens')),
        h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.secondary, fontSize: 10.5, mb: 0.5 } }, priced
          ? `${t('valueMethodCost')} ${formatMoney(benefits.cost.pricePerMillion)}/M · ${t('valueCacheHit')} ${cachePct}`
          : `${t('valueMethodCost')} ${t('valueUnpriced')}`),
        h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.secondary, fontSize: 10.5, mb: 0.5 } }, t('valueMethodPrice')),
        benefits.registry === null
          ? null
          : h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.tertiary, fontSize: 10.5, mb: 0.5, fontFamily: T.mono } }, `${t('valueRegistry')} ${formatCount(benefits.registry.providers)} · ${formatCount(benefits.registry.models)} · ${formatCount(benefits.registry.priced)}`),
        h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.tertiary, fontSize: 10.5 } }, t('valueMethodCaveat')),
      ),
    ),
  )
}

function AmpDetails(props: {
  readonly open: boolean
  readonly onClose: () => void
  readonly data: AmpSnapshot
  readonly t: (key: string) => string
  readonly sessionId?: string
}): React.ReactElement {
  const { data, t } = props
  const counts = data.status?.kernel?.counts ?? {}
  const entities = data.status?.kernel?.store?.entities ?? 0
  const modules = data.status?.agentModules ?? data.modules.filter((module) => module.tier === 'agent').length
  const verbs = data.status?.exposedTools ?? totalVerbs(data.modules)
  const mutating = mutatingVerbs(data.modules)
  const failed = data.journal.filter((entry) => entry.ok === false).length
  const online = data.status !== null && !data.error
  const hasBenefits = data.context?.benefits !== undefined

  return h(
    M.Dialog,
    {
      open: props.open,
      onClose: props.onClose,
      fullWidth: true,
      maxWidth: 'sm',
      'aria-labelledby': 'deepseek-coordination-amp-dialog-title',
      slotProps: { paper: { sx: dialogPaperSx } },
    },
    h(
      M.DialogTitle,
      { component: 'div', sx: { px: 2, pt: 2, pb: 0.5 } },
      h(
        M.Stack,
        { direction: 'row', alignItems: 'center', spacing: 0.75 },
        h(StatusDot, { online, label: online ? t('live') : t('offline') }),
        h(
          M.Typography,
          {
            id: 'deepseek-coordination-amp-dialog-title',
            variant: 'h6',
            sx: { fontSize: 14, fontWeight: 700, color: T.text, letterSpacing: '-.01em' },
          },
          t('protocol'),
        ),
        h(M.Chip, { size: 'small', label: `AMP ${PROTOCOL_VERSION}`, sx: chipSx('neutral', 18) }),
        h(M.Box, { sx: { flex: 1 } }),
        h(
          M.IconButton,
          {
            size: 'small',
            onClick: props.onClose,
            'aria-label': t('close'),
            sx: {
              width: 26,
              height: 26,
              color: T.tertiary,
              '&:hover': { color: T.text, backgroundColor: T.hover },
            },
          },
          h(CloseIcon, { sx: { fontSize: 16 } }),
        ),
      ),
      h(
        M.Typography,
        { variant: 'caption', sx: { display: 'block', mt: 0.5, color: T.tertiary, fontSize: 10.5 } },
        props.sessionId === undefined
          ? t('readOnlyNotice')
          : `${t('currentSession')} · ${shortSessionId(props.sessionId)} · ${t('readOnlyNotice')}`,
      ),
    ),
    h(
      M.DialogContent,
      { sx: { px: 2, py: 1.5, maxHeight: 'min(68vh, 560px)' } },
      data.error
        ? h(ErrorNotice, {
          title: t('unavailable'),
          hint: t('unavailableHint'),
          action: h(
            M.Button,
            {
              size: 'small',
              color: 'inherit',
              onClick: data.refresh,
              sx: { textTransform: 'none', fontSize: 11.5, whiteSpace: 'nowrap' },
            },
            t('retry'),
          ),
        })
        : null,
      h(BenefitSection, { data, t }),
      h(
        M.Box,
        {
          sx: {
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 1,
            mt: hasBenefits ? 1.5 : data.error ? 1.5 : 0,
          },
        },
        h(MetricTile, { label: t('agentModules'), value: formatCount(modules), hint: `${formatCount(data.modules.length)} ${t('modules')}`, icon: Hub }),
        h(MetricTile, { label: t('verbs'), value: formatCount(verbs), hint: `${formatCount(mutating)} ${t('mutating')}`, icon: Bolt, tone: 'warning' }),
        h(MetricTile, { label: t('entities'), value: formatCount(entities), hint: `${formatCount(counts.session)} ${t('sessions')} · ${formatCount(counts.turn)} ${t('turns')}`, icon: Memory }),
        h(MetricTile, { label: t('calls'), value: formatCount(data.journal.length), hint: `${formatCount(failed)} ${t('failures')}`, icon: History, tone: failed > 0 ? 'error' : 'success' }),
      ),
      h(
        M.Box,
        { sx: { mt: 2 } },
        h(SectionTitle, {
          title: t('catalog'),
          hint: `${formatCount(modules)} ${t('agentModules')} · ${formatCount(verbs)} ${t('verbs')}`,
        }),
        h(
          M.Paper,
          { variant: 'outlined', sx: { ...surfaceSx, px: 1, py: 0.5 } },
          ...data.modules
            .filter((module) => module.tier === 'agent')
            .map((module) => h(ModuleRow, { key: module.module, module, t })),
        ),
      ),
      h(M.Box, { sx: { mt: 2 } }, h(SectionTitle, { title: t('kernel'), hint: t('kernelCounts') })),
      h(
        M.Box,
        { sx: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 0.75 } },
        ...COUNT_ORDER.map((kind) => h(
          M.Box,
          {
            key: kind,
            sx: {
              px: 0.75,
              py: 0.6,
              border: `1px solid ${T.border}`,
              borderRadius: T.radiusSm,
              backgroundColor: T.surface,
              minWidth: 0,
            },
          },
          h(M.Typography, {
            variant: 'caption',
            noWrap: true,
            sx: { display: 'block', color: T.secondary, fontSize: 9.5 },
          }, t(kind === 'session' ? 'sessions' : kind === 'turn' ? 'turns' : kind === 'action' ? 'actions' : kind === 'goal' ? 'goals' : kind === 'plan' ? 'plans' : kind === 'task' ? 'tasks' : kind === 'intent' ? 'intents' : 'missions')),
          h(M.Typography, {
            variant: 'subtitle1',
            noWrap: true,
            sx: { display: 'block', fontSize: 15, lineHeight: 1.2, fontWeight: 700, color: T.text, fontFamily: T.mono },
          }, formatCount(counts[kind])),
        )),
      ),
      h(ContextSection, { data, t }),
      h(M.Box, { sx: { mt: 2 } }, h(SectionTitle, {
        title: t('sessionLists'),
        hint: t('currentSession'),
      })),
      data.status?.lists === undefined
        ? (props.open ? h(LoadingRows, { rows: 2 }) : null)
        : [
          ['attention', t('attention')],
          ['action', t('actions')],
          ['action_attempt', t('attempts')],
          ['goal', t('goals')],
          ['mission', t('missions')],
          ['plan', t('plans')],
          ['task', t('tasks')],
          ['profession', t('profession')],
          ['intent', t('intents')],
          ['turn', t('turns')],
          ['session', t('sessions')],
          ['evidence', t('evidence')],
        ].map(([kind, title]) => h(SessionList, {
          key: kind,
          title,
          items: data.status?.lists?.[kind] ?? [],
          unavailable: kind === 'profession',
          empty: kind === 'profession' ? (currentLocale().startsWith('zh') ? '宿主尚未提供本会话的职业配置，无法展示。' : 'The host does not provide a profession profile for this session.') : t('noSessionItems'),
        })),
      h(M.Box, { sx: { mt: 1.5 } }, h(SectionTitle, {
        title: t('recentCalls'),
        hint: `${formatCount(data.journal.length)}`,
      })),
      data.journal.length === 0
        ? h(
          M.Typography,
          { variant: 'caption', sx: { display: 'block', color: T.tertiary, py: 1 } },
          t('noCalls'),
        )
        : h(M.Stack, { spacing: 0 }, ...data.journal.slice(-5).reverse().map((entry, index) => callRow(entry, index, t))),
      h(
        M.Typography,
        { variant: 'caption', sx: { display: 'block', mt: 1.5, color: T.tertiary, fontSize: 10.5 } },
        t('catalogHint'),
      ),
    ),
    h(
      M.DialogActions,
      { sx: { px: 2, pb: 1.75, pt: 0.5 } },
      h(
        M.Button,
        {
          size: 'small',
          onClick: data.refresh,
          startIcon: h(RefreshIcon, { sx: { fontSize: 14 } }),
          sx: { textTransform: 'none', fontSize: 11.5, color: T.secondary, borderRadius: T.radiusSm },
        },
        t('refresh'),
      ),
      h(
        M.Button,
        {
          size: 'small',
          variant: 'outlined',
          onClick: props.onClose,
          sx: {
            textTransform: 'none',
            fontSize: 11.5,
            borderRadius: T.radiusSm,
            borderColor: T.accent,
            color: T.accent,
            boxShadow: 'none',
            '&:hover': {
              borderColor: T.accent,
              backgroundColor: `color-mix(in srgb, ${T.accent} 10%, transparent)`,
            },
          },
        },
        t('close'),
      ),
    ),
  )
}

/** Compact context/compile health block for the detail dialog. */
function ContextSection(props: {
  readonly data: AmpSnapshot
  readonly t: (key: string) => string
}): React.ReactElement | null {
  const { data, t } = props
  const context = data.context
  if (context === null) return null
  const diagnostics = context.contextDiagnostics
  const recovery = context.recovery
  const outputs = context.outputs
  const lag = diagnostics?.lag ?? context.lag ?? 1
  const exclusions = diagnostics?.compilerExclusions ?? context.compilerExclusions ?? 0
  const hostExclusions = context.hostExclusionCount ?? context.hostExclusions?.length ?? 0
  const compiledAt = diagnostics?.lastCompileAt
  const parsed = compiledAt === undefined ? NaN : Date.parse(compiledAt)
  const compiledLabel = Number.isFinite(parsed) ? formatClock(parsed, currentLocale()) : '—'
  return h(
    M.Box,
    { sx: { mt: 2 } },
    h(SectionTitle, { title: t('context'), hint: lag === 0 ? t('contextLagReady') : t('contextLagPending') }),
    h(
      M.Paper,
      { variant: 'outlined', sx: { border: `1px solid ${T.border}`, borderRadius: T.radius, backgroundColor: T.surface, px: 1.25, py: 0.75 } },
      h(InfoRow, { label: t('contextLag'), value: String(lag), mono: true, tone: lag === 0 ? 'success' : 'warning' }),
      h(InfoRow, { label: t('contextExclusions'), value: formatCount(exclusions), mono: true, tone: exclusions > 0 ? 'warning' : 'success' }),
      h(InfoRow, { label: t('contextHostExclusions'), value: formatCount(hostExclusions), mono: true }),
      h(InfoRow, { label: t('contextLastCompile'), value: compiledLabel, mono: true }),
      h(InfoRow, { label: t('contextRecovery'), value: `${formatCount(recovery?.sessions)} / ${formatCount(recovery?.failures)} ${t('failures')}`, mono: true }),
      h(InfoRow, {
        label: t('contextOutputs'),
        value: `${formatCount(outputs?.spill?.records)} · ${formatCount(outputs?.retention?.records)} · ${formatCount(outputs?.prune?.records)} · ${formatCount(outputs?.compaction?.records)}`,
        mono: true,
      }),
    ),
  )
}

export function AmpPanel(props: AmpPanelProps): React.ReactElement {
  const t = ampTranslate(props.t ?? ((key: string) => key), currentLocale())
  const preferenceState = useAmpPreferences()
  const seat = props as unknown as { sessionId?: string; session?: { id?: string } }
  const sessionId = (seat.sessionId ?? seat.session?.id)?.trim()
  const scopedSession = sessionId === undefined || sessionId.length === 0 ? undefined : sessionId
  const [open, setOpen] = React.useState(false)
  // Lists are only requested while the detail dialog is open; the idle strip
  // keeps the smaller aggregate snapshot.
  const data = useAmpData(preferenceState.preferences.autoRefresh ? 5_000 : 0, scopedSession, open)

  const counts = data.status?.kernel?.counts ?? {}
  const online = data.status !== null && !data.error
  const stateLabel = online ? t('live') : data.error ? t('stale') : t('offline')
  const modules = data.status?.agentModules ?? data.modules.filter((module) => module.tier === 'agent').length
  const verbs = data.status?.exposedTools ?? totalVerbs(data.modules)
  const turns = counts.turn ?? 0
  const actions = counts.action ?? 0
  const benefits = data.context?.benefits
  const priced = benefits?.cost.priced === true
  const benefitSummary = benefits?.available === true
    ? `${t('valueToken')} ${formatCompactCount(benefits.tokens.saved)} · ${benefits.cost.priced ? formatMoney(benefits.cost.saved) : t('valueUnpriced')}`
    : t('valueUnavailable')

  return h(
    React.Fragment,
    null,
    h(
      M.Box,
      { sx: { width: '100%', maxWidth: 'var(--dsh-composer-card-max-width, 820px)', mx: 'auto' } },
      h(
        M.ButtonBase,
        {
          onClick: () => setOpen(true),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': `${t('protocol')} · ${t('detail')} · ${benefitSummary}`,
          sx: {
            width: '100%',
            display: 'block',
            textAlign: 'left',
            minHeight: 60,
            px: 1.5,
            py: 1,
            borderRadius: T.radiusSm,
            border: `1px solid ${T.borderStrong}`,
            backgroundColor: T.surface,
            color: T.text,
            transition: 'background-color 120ms ease, border-color 120ms ease',
            '&:hover': { backgroundColor: T.hover, borderColor: T.accent },
            '&.Mui-focusVisible': { outline: `2px solid ${T.focus}`, outlineOffset: 1 },
          },
        },
        h(
          M.Stack,
          { direction: 'row', alignItems: 'center', spacing: 1.25, sx: { width: '100%', minWidth: 0 } },
          h(
            M.Box,
            { sx: { width: 30, height: 30, flex: '0 0 auto', display: 'grid', placeItems: 'center', borderRadius: T.radiusSm, color: T.accent, backgroundColor: `color-mix(in srgb, ${T.accent} 10%, transparent)` } },
            h(Hub, { sx: { fontSize: 17 } }),
          ),
          h(
            M.Stack,
            { spacing: 0.25, sx: { flex: 1, minWidth: 0 } },
            h(
              M.Stack,
              { direction: 'row', alignItems: 'center', spacing: 0.75, sx: { minWidth: 0 } },
              h(M.Typography, { variant: 'caption', sx: { fontWeight: 700, fontSize: 10.5, letterSpacing: '.07em', color: T.text, lineHeight: 1.4 } }, t('amp')),
              h(M.Typography, { variant: 'caption', sx: { fontSize: 9.5, fontFamily: T.mono, color: T.tertiary } }, PROTOCOL_VERSION),
              scopedSession === undefined ? null : h(M.Chip, { size: 'small', label: t('currentSession'), sx: { ...chipSx('neutral', 16), display: { xs: 'none', sm: 'inline-flex' } } }),
            ),
            h(
              M.Typography,
              { variant: 'caption', noWrap: true, sx: { fontSize: 11, color: T.secondary, lineHeight: 1.5 } },
              `${formatCount(modules)} ${t('agents')} · ${formatCount(verbs)} ${t('verbs')} · ${formatCount(turns)} ${t('turns')} · ${formatCount(actions)} ${t('actions')}`,
            ),
            benefits?.available === true
              ? h(
                M.Stack,
                { direction: 'row', alignItems: 'center', spacing: 0.4, sx: { mt: 0.25, minWidth: 0, overflow: 'hidden' } },
                h(ValueChip, { label: `${t('valueToken')} ${formatCompactCount(benefits.tokens.saved)}`, tone: 'success' }),
                priced ? h(ValueChip, { label: formatMoney(benefits.cost.saved), tone: 'neutral' }) : null,
                priced
                  ? h(ValueChip, { label: `${t('valueBenefit')} ${formatMoney(benefits.cost.net)}`, tone: benefits.cost.net >= 0 ? 'success' : 'warning', compactHidden: true })
                  : h(ValueChip, { label: t('valueUnpriced'), tone: 'warning', compactHidden: true }),
                h(ValueChip, { label: `${t('valueCacheHit')} ${Math.round((benefits.cache.hitRate ?? 0) * 100)}%`, tone: 'neutral', compactHidden: true }),
                h(ValueChip, { label: `${t('valueQuality')} ${benefits.quality === null ? '—' : `${benefits.quality.score}%`}`, tone: 'success', compactHidden: true }),
                benefits.effectiveness === null
                  ? null
                  : h(ValueChip, {
                    label: `${t('valueEffectiveness')} ${benefits.effectiveness.score}%`,
                    tone: benefits.effectiveness.score >= 80 ? 'success' : benefits.effectiveness.score >= 60 ? 'neutral' : 'warning',
                    compactHidden: true,
                  }),
              )
              : null,
          ),
          h(
            M.Stack,
            { spacing: 0.25, alignItems: 'flex-end', sx: { flex: '0 0 auto' } },
            h(
              M.Stack,
              { direction: 'row', alignItems: 'center', spacing: 0.5 },
              h(StatusDot, { online, label: stateLabel }),
              h(M.Typography, { variant: 'caption', noWrap: true, sx: { fontSize: 10.5, fontWeight: 600, color: online ? T.success : data.error ? T.warning : T.tertiary } }, stateLabel),
            ),
            h(M.Typography, { variant: 'caption', sx: { fontSize: 10, color: T.tertiary, display: { xs: 'none', sm: 'block' } } }, t('detail')),
          ),
          h(ChevronRight, { sx: { fontSize: 15, color: T.tertiary, flex: '0 0 auto' } }),
        ),
      ),
    ),
    h(AmpDetails, { open, onClose: () => setOpen(false), data, t, ...(scopedSession === undefined ? {} : { sessionId: scopedSession }) }),
  )
}
