/**
 * The AMP settings page.
 *
 * Information architecture, from the outside in:
 *   1. a stable header (protocol identity, connection state, refresh);
 *   2. four overview tiles that answer "is the protocol healthy?";
 *   3. one tabbed body — catalog / kernel / journal — so a 15-module catalog,
 *      kernel telemetry and call history never compete for the same scroll;
 *   4. progressive disclosure inside the catalog: a module row is scannable
 *      while collapsed, and verbs, authority and withheld reasons appear only
 *      when the row is opened.
 *
 * The page is read-only by design: AMP mutations belong to the model's tool
 * calls, not to a settings toggle.
 */
import * as React from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import SearchIcon from '@mui/icons-material/Search'
import ExpandMore from '@mui/icons-material/ExpandMore'
import CheckCircle from '@mui/icons-material/CheckCircle'
import ErrorIcon from '@mui/icons-material/Error'
import Bolt from '@mui/icons-material/Bolt'
import Hub from '@mui/icons-material/Hub'
import Memory from '@mui/icons-material/Memory'
import History from '@mui/icons-material/History'
import {
  COUNT_ORDER,
  formatClock,
  formatCount,
  mutatingVerbs,
  shortToolName,
  tierCounts,
  totalVerbs,
  useAmpData,
  type AmpJournalEntry,
  type AmpModule,
  type AmpVerb,
} from './ampData.js'
import {
  BudgetBar,
  EmptyState,
  ErrorNotice,
  InfoRow,
  Icons,
  LoadingRows,
  M,
  MetricTile,
  RefreshButton,
  SectionTitle,
  StatusDot,
  T,
  TierGlyph,
  chipSx,
  fieldSx,
  h,
  surfaceSx,
  tabSx,
  tierLabelKey,
  tierTone,
} from './ampUi.js'
import { ampTranslate } from './ampCopy.js'
import { useAmpPreferences, type AmpPreferencesState } from './preferences.js'
import { currentLocale } from './i18n.js'
import { AmpRenderBoundary } from './renderBoundary.js'

export type AmpSettingsProps = PropsRuntime<'settings.section'> & {
  readonly t?: (key: string) => string
}

type CatalogTab = 'modules' | 'kernel' | 'journal'
type TierFilter = 'all' | 'agent' | 'host' | 'hidden'
type JournalFilter = 'all' | 'failed' | 'mutating'
type IconComponent = React.ComponentType<Record<string, unknown>>

const SWITCH_SX: Record<string, unknown> = {
  ml: 1,
  mr: 0,
  '& .MuiSwitch-switchBase.Mui-checked': { color: T.accent },
  '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { backgroundColor: T.accent, opacity: 1 },
  '& .MuiSwitch-switchBase:not(.Mui-checked) .MuiSwitch-thumb': { backgroundColor: T.tertiary },
  '& .MuiSwitch-track': { backgroundColor: T.borderStrong, opacity: 1 },
}

function PreferenceRow(props: {
  readonly icon: IconComponent
  readonly title: string
  readonly hint: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly disabled?: boolean
}): React.ReactElement {
  const Icon = props.icon
  return h(
    M.Stack,
    {
      direction: 'row',
      alignItems: 'center',
      spacing: 1,
      sx: { px: 1.5, py: 1, minWidth: 0, opacity: props.disabled === true ? 0.5 : 1 },
    },
    h(
      M.Box,
      {
        sx: {
          width: 28,
          height: 28,
          flex: '0 0 auto',
          display: 'grid',
          placeItems: 'center',
          borderRadius: T.radiusSm,
          color: T.accent,
          backgroundColor: `color-mix(in srgb, ${T.accent} 9%, transparent)`,
        },
      },
      h(Icon, { sx: { fontSize: 16 } }),
    ),
    h(
      M.Box,
      { sx: { flex: 1, minWidth: 0 } },
      h(M.Typography, { variant: 'subtitle2', sx: { fontSize: 12, fontWeight: 600, color: T.text } }, props.title),
      h(
        M.Typography,
        { variant: 'caption', sx: { display: 'block', mt: 0.1, color: T.tertiary, fontSize: 10.5, lineHeight: 1.4 } },
        props.hint,
      ),
    ),
    h(M.Switch, {
      size: 'small',
      checked: props.checked,
      disabled: props.disabled,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => props.onChange(event.target.checked),
      inputProps: { 'aria-label': props.title },
      sx: SWITCH_SX,
    }),
  )
}

function PreferencesSection(props: {
  readonly t: (key: string) => string
  readonly state: AmpPreferencesState
}): React.ReactElement {
  const { t, state } = props
  const { preferences, synced, set } = state
  return h(
    M.Paper,
    { variant: 'outlined', sx: { ...surfaceSx, overflow: 'hidden', mb: 1.5 } },
    h(
      M.Stack,
      {
        direction: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        spacing: 1,
        sx: { px: 1.5, pt: 1.25, pb: 0.5 },
      },
      h(
        M.Box,
        { sx: { minWidth: 0 } },
        h(M.Typography, { variant: 'subtitle2', sx: { fontSize: 12.5, fontWeight: 700, color: T.text } }, t('preferences')),
        h(
          M.Typography,
          { variant: 'caption', sx: { display: 'block', mt: 0.1, color: T.tertiary, fontSize: 10.5 } },
          t('preferencesHint'),
        ),
      ),
      h(
        M.Stack,
        { direction: 'row', alignItems: 'center', spacing: 0.5, sx: { flex: '0 0 auto' } },
        h(StatusDot, { online: synced, size: 5 }),
        h(
          M.Typography,
          { variant: 'caption', noWrap: true, sx: { color: synced ? T.success : T.tertiary, fontSize: 10 } },
          synced ? t('preferenceSynced') : t('preferenceLocal'),
        ),
      ),
    ),
    h(M.Divider, { sx: { borderColor: T.border } }),
    h(PreferenceRow, {
      icon: Icons.fileRead,
      title: t('takeoverFileRead'),
      hint: t('takeoverFileReadHint'),
      checked: preferences.takeoverFileRead,
      onChange: (value) => set('takeoverFileRead', value),
    }),
    h(M.Divider, { sx: { borderColor: T.border } }),
    h(PreferenceRow, {
      icon: Icons.fileWrite,
      title: t('takeoverFileWrite'),
      hint: t('takeoverFileWriteHint'),
      checked: preferences.takeoverFileWrite,
      onChange: (value) => set('takeoverFileWrite', value),
    }),
    h(M.Divider, { sx: { borderColor: T.border } }),
    h(PreferenceRow, {
      icon: Icons.search,
      title: t('takeoverSearch'),
      hint: t('takeoverSearchHint'),
      checked: preferences.takeoverSearch,
      onChange: (value) => set('takeoverSearch', value),
    }),
    h(M.Divider, { sx: { borderColor: T.border } }),
    h(PreferenceRow, {
      icon: Icons.notifications,
      title: t('takeoverNotifications'),
      hint: t('takeoverNotificationsHint'),
      checked: preferences.takeoverNotifications,
      onChange: (value) => set('takeoverNotifications', value),
    }),
    h(M.Divider, { sx: { borderColor: T.border } }),
    h(PreferenceRow, {
      icon: Icons.context,
      title: t('contextOptimization'),
      hint: t('contextOptimizationHint'),
      checked: preferences.contextOptimization,
      onChange: (value) => set('contextOptimization', value),
    }),
    h(M.Divider, { sx: { borderColor: T.border } }),
    h(PreferenceRow, {
      icon: Icons.autoRefresh,
      title: t('autoRefresh'),
      hint: t('autoRefreshHint'),
      checked: preferences.autoRefresh,
      onChange: (value) => set('autoRefresh', value),
    }),
    h(M.Divider, { sx: { borderColor: T.border } }),
    h(PreferenceRow, {
      icon: Icons.compact,
      title: t('compactCatalog'),
      hint: t('compactCatalogHint'),
      checked: preferences.compactCatalog,
      onChange: (value) => set('compactCatalog', value),
    }),
  )
}


function countLabel(t: (key: string) => string, kind: string): string {
  switch (kind) {
    case 'session': return t('sessions')
    case 'turn': return t('turns')
    case 'intent': return t('intents')
    case 'mission': return t('missions')
    case 'goal': return t('goals')
    case 'plan': return t('plans')
    case 'task': return t('tasks')
    case 'action': return t('actions')
    default: return kind
  }
}

function VerbRow(props: { readonly verb: AmpVerb; readonly t: (key: string) => string }): React.ReactElement {
  const { verb, t } = props
  const authorities = verb.authority ?? []
  return h(
    M.Box,
    { sx: { py: 0.6, borderTop: `1px solid ${T.border}`, minWidth: 0 } },
    h(
      M.Stack,
      { direction: 'row', alignItems: 'center', spacing: 0.5, flexWrap: 'wrap', useFlexGap: true },
      h(
        M.Typography,
        {
          variant: 'caption',
          sx: { fontFamily: T.mono, fontSize: 11.5, fontWeight: 700, color: T.text, mr: 0.25 },
        },
        verb.verb,
      ),
      h(M.Chip, {
        size: 'small',
        label: verb.mutating ? t('mutating') : t('readOnly'),
        sx: chipSx(verb.mutating ? 'warning' : 'success', 17),
      }),
      ...authorities.slice(0, 3).map((authority) => h(M.Chip, {
        key: authority,
        size: 'small',
        label: authority,
        sx: chipSx('neutral', 17),
      })),
      authorities.length > 3
        ? h(M.Typography, { variant: 'caption', sx: { color: T.tertiary, fontSize: 10 } }, `+${authorities.length - 3}`)
        : null,
    ),
    verb.summary === undefined || verb.summary.trim().length === 0
      ? null
      : h(
        M.Typography,
        { variant: 'caption', sx: { display: 'block', mt: 0.25, color: T.tertiary, fontSize: 10.5, lineHeight: 1.45 } },
        verb.summary,
      ),
  )
}

function ModuleCard(props: {
  readonly module: AmpModule
  readonly t: (key: string) => string
  readonly compact: boolean
}): React.ReactElement {
  const { module, t } = props
  const verbs = module.verbs ?? []
  const mutating = verbs.filter((verb) => verb.mutating).length
  const withheld = module.withheld ?? []
  return h(
    M.Accordion,
    {
      disableGutters: true,
      elevation: 0,
      sx: {
        border: `1px solid ${T.border}`,
        borderRadius: `${T.radius} !important`,
        backgroundColor: T.surface,
        backgroundImage: 'none',
        boxShadow: 'none',
        '&:before': { display: 'none' },
        '&.Mui-expanded': { margin: 0, backgroundColor: T.raised },
      },
    },
    h(
      M.AccordionSummary,
      {
        expandIcon: h(ExpandMore, { sx: { fontSize: 18, color: T.tertiary } }),
        sx: {
          px: 1.25,
          py: props.compact ? 0.45 : 0.75,
          minHeight: 0,
          '& .MuiAccordionSummary-content': { my: 0, minWidth: 0, alignItems: 'center' },
          '& .MuiAccordionSummary-content.Mui-expanded': { my: 0 },
          '& .MuiAccordionSummary-expandIconWrapper': { color: T.tertiary },
          '&.Mui-focusVisible': { outline: `2px solid ${T.focus}`, outlineOffset: -2 },
        },
      },
      h(
        M.Stack,
        { direction: 'row', alignItems: 'center', spacing: 1, sx: { width: '100%', minWidth: 0 } },
        h(TierGlyph, { tier: module.tier }),
        h(
          M.Box,
          { sx: { flex: 1, minWidth: 0 } },
          h(
            M.Stack,
            { direction: 'row', alignItems: 'center', spacing: 0.5, sx: { minWidth: 0 } },
            h(
              M.Typography,
              {
                variant: 'subtitle2',
                noWrap: true,
                sx: { fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text, minWidth: 0 },
              },
              module.module,
            ),
            h(M.Chip, {
              size: 'small',
              label: t(tierLabelKey(module.tier)),
              sx: chipSx(tierTone(module.tier), 17),
            }),
          ),
          props.compact
            ? null
            : h(
              M.Typography,
              { variant: 'caption', noWrap: true, sx: { display: 'block', mt: 0.1, color: T.tertiary, fontSize: 10.5 } },
              module.summary,
            ),
        ),
        h(
          M.Stack,
          { direction: 'row', alignItems: 'center', spacing: 0.5, sx: { flex: '0 0 auto' } },
          h(M.Chip, {
            size: 'small',
            label: `${formatCount(verbs.length)} ${t('verbs')}`,
            sx: chipSx(verbs.length > 0 ? 'neutral' : 'warning', 17),
          }),
          mutating > 0
            ? h(M.Chip, {
              size: 'small',
              label: `${formatCount(mutating)} ${t('mutating')}`,
              sx: chipSx('warning', 17),
            })
            : null,
        ),
      ),
    ),
      h(
        M.AccordionDetails,
        { sx: { px: 1.25, pb: 1.25, pt: 0 } },
      module.summary.length > 72
        ? h(M.Typography, { variant: 'body2', sx: { color: T.secondary, fontSize: 11.5, lineHeight: 1.5, mb: 0.75 } }, module.summary)
        : null,
      verbs.length === 0
        ? h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.tertiary, py: 0.5 } }, t('noVerbs'))
        : h(M.Stack, { spacing: 0 }, ...verbs.map((verb) => h(VerbRow, { key: verb.verb, verb, t }))),
      withheld.length === 0
        ? null
        : h(
          M.Stack,
          { spacing: 0.25, sx: { mt: 1 } },
          h(
            M.Typography,
            { variant: 'caption', sx: { color: T.warning, fontWeight: 700, fontSize: 10.5 } },
            `${t('withheld')} · ${formatCount(withheld.length)}`,
          ),
          ...withheld.map((item) => h(
            M.Typography,
            { key: item.verb, variant: 'caption', sx: { color: T.tertiary, fontSize: 10.5, lineHeight: 1.45 } },
            `${item.verb} — ${item.reason}`,
          )),
        ),
      module.tier === 'agent'
        ? h(
          M.Stack,
          { direction: 'row', alignItems: 'center', spacing: 0.5, sx: { mt: 1 } },
          h(StatusDot, { online: module.registered !== false, size: 5 }),
          h(
            M.Typography,
            { variant: 'caption', sx: { color: T.tertiary, fontSize: 10 } },
            module.registered === false ? t('notRegistered') : t('registered'),
          ),
        )
        : null,
    ),
  )
}

function ModuleGrid(props: {
  readonly modules: readonly AmpModule[]
  readonly t: (key: string) => string
  readonly compact: boolean
}): React.ReactElement {
  return h(
    M.Stack,
    { spacing: 1 },
    ...props.modules.map((module) => h(ModuleCard, { key: module.module, module, t: props.t, compact: props.compact })),
  )
}

function Overview(props: {
  readonly data: ReturnType<typeof useAmpData>
  readonly t: (key: string) => string
}): React.ReactElement {
  const { data, t } = props
  const counts = data.status?.kernel?.counts ?? {}
  const agentModules = data.status?.agentModules
    ?? data.modules.filter((module) => module.tier === 'agent').length
  const verbs = data.status?.exposedTools ?? totalVerbs(data.modules)
  const mutating = mutatingVerbs(data.modules)
  const failed = data.journal.filter((entry) => entry.ok === false).length
  const entities = data.status?.kernel?.store?.entities ?? 0
  return h(
    M.Box,
    { sx: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1 } },
    h(MetricTile, {
      label: t('agentModules'),
      value: formatCount(agentModules),
      hint: `${formatCount(data.modules.length)} ${t('modules')}`,
      icon: Hub,
    }),
    h(MetricTile, {
      label: t('verbs'),
      value: formatCount(verbs),
      hint: `${formatCount(mutating)} ${t('mutating')}`,
      icon: Bolt,
      tone: 'warning',
    }),
    h(MetricTile, {
      label: t('entities'),
      value: formatCount(entities),
      hint: `${formatCount(counts.session)} ${t('sessions')} · ${formatCount(counts.turn)} ${t('turns')}`,
      icon: Memory,
    }),
    h(MetricTile, {
      label: t('journal'),
      value: formatCount(data.journal.length),
      hint: `${formatCount(failed)} ${t('failures')}`,
      icon: History,
      tone: failed > 0 ? 'error' : 'success',
    }),
  )
}

function Header(props: {
  readonly data: ReturnType<typeof useAmpData>
  readonly t: (key: string) => string
}): React.ReactElement {
  const { data, t } = props
  const online = data.status !== null && !data.error
  const updated = `${t('updated')} ${formatClock(data.updatedAt, currentLocale())}`
  return h(
    M.Stack,
    { direction: 'row', alignItems: 'flex-start', justifyContent: 'space-between', spacing: 1, sx: { mb: 1.5 } },
    h(
      M.Box,
      { sx: { minWidth: 0 } },
      h(
        M.Stack,
        { direction: 'row', alignItems: 'center', spacing: 0.75, flexWrap: 'wrap', useFlexGap: true },
        h(
          M.Typography,
          { variant: 'h6', sx: { fontSize: 15, fontWeight: 700, color: T.text, letterSpacing: '-.01em' } },
          t('protocol'),
        ),
        h(M.Chip, { size: 'small', label: t('protocolShort'), sx: chipSx('neutral', 18) }),
      ),
      h(
        M.Stack,
        { direction: 'row', alignItems: 'center', spacing: 0.5, sx: { mt: 0.5, minWidth: 0 } },
        h(StatusDot, { online, size: 6, label: online ? t('live') : t('offline') }),
        h(
          M.Typography,
          { variant: 'caption', noWrap: true, sx: { color: online ? T.success : T.warning, fontSize: 10.5, fontWeight: 600 } },
          online ? t('live') : data.error ? t('offline') : t('loading'),
        ),
        h(M.Typography, { variant: 'caption', noWrap: true, sx: { color: T.tertiary, fontSize: 10.5 } },
          `· ${t('readOnlyNotice')}`),
      ),
    ),
    h(
      M.Stack,
      { direction: 'row', alignItems: 'center', spacing: 0.5, sx: { flex: '0 0 auto' } },
      h(M.Typography, { variant: 'caption', noWrap: true, sx: { color: T.tertiary, fontSize: 10 } }, updated),
      h(RefreshButton, { label: t('refresh'), onClick: data.refresh, busy: data.loading }),
    ),
  )
}

function CatalogTab(props: {
  readonly data: ReturnType<typeof useAmpData>
  readonly t: (key: string) => string
  readonly compact: boolean
}): React.ReactElement {
  const { data, t } = props
  const [query, setQuery] = React.useState('')
  const [tier, setTier] = React.useState<TierFilter>('all')
  const tiers = tierCounts(data.modules)
  const needle = query.trim().toLowerCase()
  const filtered = React.useMemo(
    () => data.modules.filter((module) => {
      if (tier !== 'all' && module.tier !== tier) return false
      if (needle.length === 0) return true
      const haystack = [
        module.module,
        module.summary,
        ...(module.verbs ?? []).flatMap((verb) => [verb.verb, verb.summary ?? '']),
        ...(module.withheld ?? []).map((item) => item.verb),
      ].join(' ').toLowerCase()
      return haystack.includes(needle)
    }),
    [data.modules, needle, tier],
  )

  const filters: ReadonlyArray<readonly [TierFilter, string, number]> = [
    ['all', t('all'), data.modules.length],
    ['agent', t('agents'), tiers.agent ?? 0],
    ['host', t('host'), tiers.host ?? 0],
    ['hidden', t('hidden'), tiers.hidden ?? 0],
  ]

  return h(
    M.Stack,
    { spacing: 1.25 },
    h(
      M.TextField,
      {
        value: query,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
        placeholder: t('searchPlaceholder'),
        size: 'small',
        fullWidth: true,
        sx: fieldSx,
        inputProps: { 'aria-label': t('searchPlaceholder') },
        slotProps: {
          input: {
            startAdornment: h(
              M.InputAdornment,
              { position: 'start', sx: { '& .MuiInputAdornment-root': { mr: 0.5 } } },
              h(SearchIcon, { sx: { fontSize: 16, color: T.tertiary } }),
            ),
          },
        },
      },
    ),
    h(
      M.Stack,
      {
        direction: 'row',
        spacing: 0.5,
        flexWrap: 'wrap',
        useFlexGap: true,
        'aria-label': t('filterByTier'),
        role: 'group',
      },
      ...filters.map(([value, label, count]) => {
        const selected = tier === value
        return h(M.Chip, {
          key: value,
          clickable: true,
          label: `${label} ${formatCount(count)}`,
          'aria-pressed': selected,
          disabled: count === 0 && value !== 'all',
          onClick: () => setTier(value),
          sx: {
            ...chipSx(selected ? 'accent' : 'neutral', 22),
            fontWeight: selected ? 700 : 600,
            opacity: count === 0 && value !== 'all' ? 0.45 : 1,
            '&:hover': { backgroundColor: T.hover },
          },
        })
      }),
    ),
    h(
      M.Stack,
      { direction: 'row', alignItems: 'center', justifyContent: 'space-between', sx: { minHeight: 18 } },
      h(
        M.Typography,
        { variant: 'caption', sx: { color: T.tertiary, fontSize: 10.5 } },
        `${t('filteredCount')} ${formatCount(filtered.length)} / ${formatCount(data.modules.length)}`,
      ),
      needle.length > 0 || tier !== 'all'
        ? h(
          M.Button,
          {
            size: 'small',
            onClick: () => { setQuery(''); setTier('all') },
            sx: {
              minWidth: 0,
              p: 0,
              textTransform: 'none',
              fontSize: 10.5,
              color: T.accent,
              '&:hover': { backgroundColor: 'transparent', textDecoration: 'underline' },
            },
          },
          t('clearFilters'),
        )
        : null,
    ),
    data.loading && data.modules.length === 0
      ? h(LoadingRows, { rows: 4, label: t('loading') })
      : data.error && data.modules.length === 0
        ? h(ErrorNotice, {
          title: t('unavailable'),
          hint: t('unavailableHint'),
          action: h(M.Button, {
            size: 'small',
            color: 'inherit',
            onClick: data.refresh,
            sx: { textTransform: 'none', fontSize: 11 },
          }, t('retry')),
        })
        : filtered.length === 0
          ? h(EmptyState, {
            title: t('noMatch'),
            hint: t('noMatchHint'),
            action: h(M.Button, {
              size: 'small',
              onClick: () => { setQuery(''); setTier('all') },
              sx: { mt: 0.5, textTransform: 'none', fontSize: 11.5, color: T.accent },
            }, t('clearFilters')),
          })
          : h(ModuleGrid, { modules: filtered, t, compact: props.compact }),
  )
}

function KernelTab(props: {
  readonly data: ReturnType<typeof useAmpData>
  readonly t: (key: string) => string
}): React.ReactElement {
  const { data, t } = props
  const kernel = data.status?.kernel
  const counts = kernel?.counts ?? {}
  const limit = kernel?.budget?.limit ?? {}
  const settled = kernel?.budget?.settled ?? {}
  const limits = Object.entries(limit).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
  const sync = data.sync
  const counters = sync?.counters ?? {}
  const errors = sync?.errors ?? []

  if (data.status === null && data.loading) {
    return h(LoadingRows, { rows: 4, label: t('loading') })
  }

  return h(
    M.Stack,
    { spacing: 1.5 },
    h(SectionTitle, { title: t('kernelCounts'), hint: t('overview') }),
    h(
      M.Box,
      { sx: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 1 } },
      ...COUNT_ORDER.map((kind) => h(
        M.Paper,
        { key: kind, variant: 'outlined', sx: { border: `1px solid ${T.border}`, borderRadius: T.radiusSm, backgroundColor: T.surface, px: 1, py: 0.75, minWidth: 0 } },
        h(M.Typography, { variant: 'caption', noWrap: true, sx: { display: 'block', color: T.secondary, fontSize: 10 } }, countLabel(t, kind)),
        h(M.Typography, { variant: 'subtitle1', noWrap: true, sx: { fontSize: 17, lineHeight: 1.2, fontWeight: 700, color: T.text, fontFamily: T.mono } }, formatCount(counts[kind])),
      )),
    ),
    h(
      M.Paper,
      { variant: 'outlined', sx: { border: `1px solid ${T.border}`, borderRadius: T.radius, backgroundColor: T.surface, px: 1.25, py: 0.75 } },
      h(InfoRow, { label: t('workflowEvents'), value: formatCount(kernel?.workflowEvents), mono: true }),
      h(InfoRow, { label: t('receipts'), value: formatCount(kernel?.receiptCount), mono: true }),
      h(InfoRow, { label: t('evidence'), value: formatCount(kernel?.evidenceCount), mono: true }),
      h(InfoRow, { label: t('verifications'), value: formatCount(kernel?.verificationCount), mono: true }),
      h(InfoRow, { label: t('entities'), value: formatCount(kernel?.store?.entities), mono: true }),
      h(InfoRow, { label: t('events'), value: formatCount(kernel?.store?.events), mono: true }),
      h(InfoRow, { label: t('schemaVersion'), value: formatCount(kernel?.store?.schemaVersion), mono: true }),
    ),
    h(SectionTitle, { title: t('budget'), hint: limits.length === 0 ? t('noLimit') : undefined }),
    limits.length === 0
      ? h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.tertiary, fontSize: 10.5 } }, t('noLimit'))
      : h(
        M.Paper,
        { variant: 'outlined', sx: { border: `1px solid ${T.border}`, borderRadius: T.radius, backgroundColor: T.surface, px: 1.25, py: 1 } },
        h(
          M.Stack,
          { spacing: 1 },
          ...limits.map(([key, max]) => h(BudgetBar, {
            key,
            label: key === 'calls' ? t('calls') : key === 'tokens' ? 'tokens' : key === 'bytes' ? 'bytes' : key,
            used: settled[key] ?? 0,
            limit: max,
          })),
        ),
      ),
    h(SectionTitle, { title: t('projection'), hint: sync === null ? t('unavailableValue') : undefined }),
    sync === null
      ? h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.tertiary, fontSize: 10.5 } }, t('unavailableValue'))
      : h(
        M.Paper,
        { variant: 'outlined', sx: { border: `1px solid ${T.border}`, borderRadius: T.radius, backgroundColor: T.surface, px: 1.25, py: 0.75 } },
        ...['session', 'turn', 'goal', 'plan', 'task', 'action', 'result'].map((kind) => h(InfoRow, {
          key: kind,
          label: countLabel(t, kind),
          value: formatCount(counters[kind]),
          mono: true,
        })),
        h(InfoRow, {
          label: t('projectionErrors'),
          value: formatCount(errors.length),
          mono: true,
          tone: errors.length > 0 ? 'error' : 'success',
        }),
      ),
    errors.length > 0
      ? h(ErrorNotice, {
        title: t('lastErrors'),
        hint: errors.slice(-2).join(' · '),
      })
      : null,
  )
}

function JournalRow(props: { readonly entry: AmpJournalEntry; readonly t: (key: string) => string }): React.ReactElement {
  const { entry, t } = props
  const ok = entry.ok !== false
  return h(
    M.ListItem,
    { disableGutters: true, sx: { py: 0.6, borderTop: `1px solid ${T.border}`, minWidth: 0 } },
    h(
      M.ListItemIcon,
      { sx: { minWidth: 24, alignSelf: 'center' } },
      h(ok ? CheckCircle : ErrorIcon, { sx: { fontSize: 14, color: ok ? T.success : T.error } }),
    ),
    h(M.ListItemText, {
      disableTypography: true,
      sx: { minWidth: 0, my: 0 },
      primary: h(
        M.Stack,
        { direction: 'row', alignItems: 'center', spacing: 0.5, sx: { minWidth: 0 } },
        h(
          M.Typography,
          { variant: 'caption', noWrap: true, sx: { fontFamily: T.mono, fontSize: 11, color: T.text, minWidth: 0 } },
          shortToolName(entry.tool),
        ),
        entry.mutating === true
          ? h(M.Chip, { size: 'small', label: t('mutating'), sx: chipSx('warning', 16) })
          : null,
        entry.error === undefined
          ? null
          : h(M.Chip, { size: 'small', label: entry.error, sx: chipSx('error', 16) }),
      ),
      secondary: h(
        M.Typography,
        { variant: 'caption', sx: { color: T.tertiary, fontSize: 10 } },
        typeof entry.durationMs === 'number' ? `${Math.round(entry.durationMs)} ms` : '—',
      ),
    }),
  )
}

function JournalTab(props: {
  readonly data: ReturnType<typeof useAmpData>
  readonly t: (key: string) => string
}): React.ReactElement {
  const { data, t } = props
  const [filter, setFilter] = React.useState<JournalFilter>('all')
  const entries = React.useMemo(() => {
    const ordered = [...data.journal].reverse()
    if (filter === 'failed') return ordered.filter((entry) => entry.ok === false)
    if (filter === 'mutating') return ordered.filter((entry) => entry.mutating === true)
    return ordered
  }, [data.journal, filter])

  return h(
    M.Stack,
    { spacing: 1 },
    h(
      M.Stack,
      { direction: 'row', alignItems: 'center', justifyContent: 'space-between', spacing: 1, sx: { flexWrap: 'wrap' } },
      h(
        M.ToggleButtonGroup,
        {
          exclusive: true,
          size: 'small',
          value: filter,
          onChange: (_event: unknown, value: JournalFilter | null) => { if (value !== null) setFilter(value) },
          'aria-label': t('journalFilter'),
          sx: {
            '& .MuiToggleButton-root': {
              textTransform: 'none',
              fontSize: 10.5,
              fontWeight: 600,
              py: 0.25,
              px: 1,
              color: T.secondary,
              borderColor: T.border,
              '&.Mui-selected': { color: T.text, backgroundColor: T.raised },
              '&.Mui-selected:hover': { backgroundColor: T.raised },
            },
          },
        },
        h(M.ToggleButton, { value: 'all' }, t('all')),
        h(M.ToggleButton, { value: 'failed' }, t('filterFailed')),
        h(M.ToggleButton, { value: 'mutating' }, t('filterMutating')),
      ),
      h(
        M.Typography,
        { variant: 'caption', sx: { color: T.tertiary, fontSize: 10.5 } },
        `${t('filteredCount')} ${formatCount(entries.length)} / ${formatCount(data.journal.length)}`,
      ),
    ),
    data.loading && data.journal.length === 0
      ? h(LoadingRows, { rows: 5, label: t('loading') })
      : entries.length === 0
        ? h(EmptyState, { title: t('noCalls'), hint: t('noCallsHint') })
        : h(
          M.Paper,
          { variant: 'outlined', sx: { border: `1px solid ${T.border}`, borderRadius: T.radius, backgroundColor: T.surface, px: 1.25, py: 0.25 } },
          h(M.List, { dense: true, disablePadding: true }, ...entries.map((entry, index) => h(JournalRow, { key: `${entry.tool}-${index}`, entry, t }))),
        ),
    h(
      M.Typography,
      { variant: 'caption', sx: { display: 'block', mt: 0.5, color: T.tertiary, fontSize: 10 } },
      t('executionJournal'),
    ),
  )
}

export function AmpSettings(props: AmpSettingsProps): React.ReactElement {
  return h(AmpRenderBoundary, { surface: 'settings', children: h(AmpSettingsContent, props) })
}

function AmpSettingsContent(props: AmpSettingsProps): React.ReactElement {
  const t = ampTranslate(props.t ?? ((key: string) => key), currentLocale())
  const preferenceState = useAmpPreferences()
  const data = useAmpData(preferenceState.preferences.autoRefresh ? 5_000 : 0)
  const [tab, setTab] = React.useState<CatalogTab>('modules')

  return h(
    M.Box,
    { sx: { width: '100%', pb: 1.5 } },
    h(PreferencesSection, { t, state: preferenceState }),
    h(Header, { data, t }),
    data.error
      ? h(M.Box, { sx: { mb: 1.25 } }, h(ErrorNotice, {
        title: t('unavailable'),
        hint: t('unavailableHint'),
        action: h(M.Button, {
          size: 'small',
          color: 'inherit',
          onClick: data.refresh,
          sx: { textTransform: 'none', fontSize: 11 },
        }, t('retry')),
      }))
      : null,
    h(Overview, { data, t }),
    h(M.Box, { sx: { mt: 1.5 } }, h(
      M.Tabs,
      {
        value: tab,
        onChange: (_event: unknown, value: CatalogTab) => setTab(value),
        variant: 'fullWidth',
        'aria-label': t('protocol'),
        sx: tabSx,
        // The default indicator slides for 300 ms; with three full-width tabs
        // that motion reads as input lag. The panel switch itself is instant.
        slotProps: { indicator: { sx: { transition: 'none' } } },
      },
      h(M.Tab, { value: 'modules', label: t('catalog') }),
      h(M.Tab, { value: 'kernel', label: t('kernel') }),
      h(M.Tab, { value: 'journal', label: t('journal') }),
    )),
    h(
      M.Box,
      { sx: { pt: 1.5 } },
      // Keep every panel mounted: remounting 27 MUI Accordions was the visible
      // hitch when returning to the catalog. `display:none` keeps scroll and
      // expansion state while making the swap synchronous.
      h(
        M.Box,
        { sx: { display: tab === 'modules' ? 'block' : 'none' } },
        h(CatalogTab, { data, t, compact: preferenceState.preferences.compactCatalog }),
      ),
      h(
        M.Box,
        { sx: { display: tab === 'kernel' ? 'block' : 'none' } },
        h(KernelTab, { data, t }),
      ),
      h(
        M.Box,
        { sx: { display: tab === 'journal' ? 'block' : 'none' } },
        h(JournalTab, { data, t }),
      ),
    ),
    h(
      M.Stack,
      {
        direction: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        spacing: 1,
        sx: { mt: 2, pt: 1, borderTop: `1px solid ${T.border}` },
      },
      h(
        M.Typography,
        { variant: 'caption', noWrap: true, sx: { color: T.tertiary, fontFamily: T.mono, fontSize: 9.5, minWidth: 0 } },
        `${data.status?.tenantId ?? '—'} · ${data.status?.rootId ?? '—'}`,
      ),
      h(M.Typography, { variant: 'caption', noWrap: true, sx: { color: T.tertiary, fontSize: 9.5 } }, t('protocolShort')),
    ),
  )
}
