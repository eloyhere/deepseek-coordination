/**
 * The plugin's single source of user-visible and model-facing copy (v24 §22,
 * `docs/ui-copy-v24.md` §5).
 *
 * Authority for the active language is DSH's own `ctx.locale`; this module never
 * picks a language on its own. It publishes one `Copy` record per locale, so the
 * composer controls, the settings page, the typed errors and the `coordination_*`
 * tool descriptions all read the same strings instead of growing a second copy.
 *
 * Chinese is the reference language and every string here is the v24 copy
 * document's string, copied verbatim. English is a faithful per-key translation,
 * never a placeholder. `src/shared/enum.ts` still exports its label/hint
 * projection for compatibility and audit, but the hints in this file are the
 * authority for the interface: the v24 document replaces the v23 tooltips.
 *
 * Data stays canonical: the database and the wire keep English identifiers
 * (`profession`, `scene`, …); only the presentation layer is translated.
 *
 * Length budgets (v24 §1.3) are enforced by `test/i18n.test.ts`:
 * control tooltip 90/160, option and field tooltip 70/120, composer/status and
 * error line 70/120, settings group copy 70/120, `settings.whyLock` 200/320.
 */
import {
  ControlLabel,
  InteractionLabel,
  InteractionValues,
  PermissionLabel,
  ProfessionLabel,
  ProfessionValues,
  SandboxModeValues,
  SceneLabel,
  SceneValues,
  ValidationLabel,
  ValidationValues,
} from './enum.js'
import type {
  ControlName,
  Interaction,
  Profession,
  SandboxMode,
  Scene,
  Validation,
} from './enum.js'
import {
  SETTINGS_CATALOG_FIELD_IDS,
  SETTINGS_CATALOG_GROUPS,
  SETTINGS_CONTROL_CHIPS,
} from './selection.js'
import type {
  SettingsCatalogFieldId,
  SettingsCatalogGroupId,
  SettingsControlChip,
} from './selection.js'
import type { CoordinationErrorCode } from './error.js'

/** The two languages the plugin ships. `zh-CN` is the default and the fallback. */
export type Locale = 'zh-CN' | 'en-US'

/** Shipped locales in display order; the first one is the fallback. */
export const LOCALES: readonly Locale[] = ['zh-CN', 'en-US']

/**
 * Config-free fallback. An unknown or absent host locale normalises here, never
 * to whatever the host config happens to say.
 */
export const DEFAULT_LOCALE: Locale = 'zh-CN'

/**
 * Map any host/browser locale tag onto a shipped locale.
 *
 * The host's registry currently ships `zh` / `en`, while this plugin and the
 * design document speak `zh-CN` / `en-US`; `zh*` and `en*` (case-insensitive,
 * any region or script) therefore collapse onto the two shipped tags. Anything
 * unknown falls back to the Chinese default (v24 §22).
 */
export function normaliseLocale(value: unknown): Locale {
  if (typeof value !== 'string') return DEFAULT_LOCALE
  const tag = value.trim().toLowerCase()
  if (tag.startsWith('en')) return 'en-US'
  if (tag.startsWith('zh')) return 'zh-CN'
  return DEFAULT_LOCALE
}

/** One localised label plus the tooltip the design document mandates. */
export interface LabelledCopy {
  readonly label: string
  readonly hint: string
}

/** Copy of one composer control (the control itself, not its options). */
export type ControlCopy = LabelledCopy

/** Copy of one dropdown option. */
export type OptionCopy = LabelledCopy

/**
 * Copy of one validation level. `hint` is the doc-mandated tooltip,
 * `budget` the retrieval budget (`1×3` …), and `scope` the evidence scope
 * (v24 §5.6). Every level searches; the copy states it.
 */
export interface ValidationCopy extends LabelledCopy {
  readonly budget: string
  readonly scope: string
}

/**
 * Composer runtime copy: tooltip skeleton, lock/offline/status lines, the
 * permission-catalog rejections, the full-access confirmation and the
 * profession-lock escalation dialog.
 *
 * Templates use `{name}` placeholders resolved by {@link fillTemplate}.
 */
export interface ComposerCopy {
  /** The word in front of the option currently shown ("当前" / "Current"). */
  readonly currentLabel: string
  /** Option tooltip title, e.g. `{control} · {currentLabel}：{current}`. */
  readonly controlTitle: string
  /** Accessible name of the select, e.g. `{control}，{currentLabel}：{current}`. */
  readonly controlAria: string
  /** Accessible name of a locked trigger; adds `{explanation}` to the title skeleton. */
  readonly lockedAria: string
  /** Accessible name of one MenuItem, which holds keyboard focus; `{label}` + `{hint}`. */
  readonly optionAria: string
  /** Locked profession line (v24 §2.6). */
  readonly lockedLine: string
  /** Unlocked explanation shown while the profession can still be chosen. */
  readonly unlockedLine: string
  /** Validation is frozen while the turn's plan is open; says when it lifts. */
  readonly frozenByPlan: string
  /** Interaction is frozen while the turn's goal is set; says when it lifts. */
  readonly frozenByGoal: string
  /** Rejection when a frozen validation is patched anyway (server refusal). */
  readonly frozenPlanRejected: string
  /** Rejection when a frozen interaction is patched anyway (server refusal). */
  readonly frozenGoalRejected: string
  /** Host-unreachable line; appended as a second line, never replacing the hint. */
  readonly offlineLine: string
  /** The local-only clause ("only saved on this device"). */
  readonly localOnly: string
  /** Shown when DSH exposes no permission presets at all. */
  readonly permissionCatalogMissing: string
  /** Rejection when a preset is picked although no catalog exists. */
  readonly permissionApplyFailed: string
  /** Rejection when a preset is picked while the host is unreachable. */
  readonly permissionOffline: string
  /** Note that switching a preset writes to the session immediately. */
  readonly permissionWriteNow: string
  /** Explanation used when a preset has no recognised sandbox mode. */
  readonly permissionPresetDefault: string
  /** A session preset that DSH's catalog does not contain. */
  readonly customPreset: string
  /** Neutral label while no DSH permission preset is applied. */
  readonly followDsh: string
  /** Follow-DSH label naming the deployment default tier; `{mode}`. */
  readonly followDshMode: string
  /** Tooltip line explaining that no preset is applied. */
  readonly permissionFollowHint: string
  /** Shown while the host selection is still loading; the selects stay disabled. */
  readonly loadingSelection: string
  /** Approval-policy suffix of a preset tooltip; `{approval}`. */
  readonly approvalPolicy: string
  /** Always-visible reminder that every validation level searches (v24 §6.3). */
  readonly validationNote: string
  /** Short locked rejection. */
  readonly professionLocked: string
  /** Locked rejection that names the rebuild/abandon escape hatch. */
  readonly professionLockedRebuild: string
  /** Invalid-patch rejection; the previous choice was restored. */
  readonly invalidSelection: string
  /** Generic host rejection; the previous choice was restored. */
  readonly requestFailed: string
  /** Title of the inline full-access confirmation. */
  readonly permissionConfirmTitle: string
  /** Consequence sentence of the inline full-access confirmation. */
  readonly permissionConfirmBody: string
  /** Confirm button of the full-access confirmation. */
  readonly permissionConfirmAccept: string
  /** Cancel button of the full-access confirmation; also the escalation dialog's 取消. */
  readonly permissionConfirmCancel: string
  /** Escalation dialog: the current (locked) profession; `{profession}`. */
  readonly escalationCurrent: string
  /** Escalation dialog: the refused profession; `{profession}`. */
  readonly escalationRequested: string
  /** Escalation dialog action: rebuild the task with the requested profession. */
  readonly escalationRebuild: string
  /** Escalation dialog action: abandon the task. */
  readonly escalationAbandon: string
  /** Shown when the host build has no rebuild/abandon route. */
  readonly escalationUnsupported: string
}

/**
 * Copy of the service-level takeover dialog (v24 §16): approval windows and
 * question windows. Plain-language rules from `docs/ui-copy-v24.md` §1.1 apply;
 * `{index}` / `{total}` in {@link TakeoverCopy.queueLabel} are resolved by
 * {@link fillTemplate}.
 */
export interface TakeoverCopy {
  /** Generic dialog heading ("需要你决定"). */
  readonly title: string
  /** Heading of an approval window. */
  readonly approvalTitle: string
  /** Heading of a question window. */
  readonly questionTitle: string
  /** Approval action: allow this one call. */
  readonly allowOnce: string
  /** Approval action: reject. */
  readonly reject: string
  /** Dialog action: cancel the request (the answer is not submitted). */
  readonly cancel: string
  /** Question action: submit every answer. */
  readonly submit: string
  /** Placeholder of a question's optional free-text field. */
  readonly customPlaceholder: string
  /** Shown when the host says the request is already resolved. */
  readonly expired: string
  /** Shown when the host could not be reached; the dialog stays for a retry. */
  readonly hostError: string
  /** Queue indicator template, e.g. "第 1 / 3 条". */
  readonly queueLabel: string
}

/* ------------------------------------------------------------------------- *
 * Settings page copy (v24 §3, §5.9)
 * ------------------------------------------------------------------------- */

/** The settings groups, in render order (v24 §3.1 plus auto-compaction). */
export const SETTINGS_GROUP_IDS = [
  'permission',
  'composer',
  'profession',
  'scene',
  'language',
  'compaction',
  'advanced',
] as const

export type SettingsGroupId = (typeof SETTINGS_GROUP_IDS)[number]

/** The 24 setting rows, in render order (v24 §3.2). */
export const SETTINGS_FIELD_IDS = [
  'takeoverPermission',
  'takeoverControl',
  'takeoverDialogs',
  'permissionCatalog',
  'composerWorkflow',
  'composerTooltips',
  'professionLock',
  'professionDefault',
  'professionRebuild',
  'professionAbandon',
  'professionAudit',
  'professionErrorHint',
  'defaultScene',
  'defaultValidation',
  'defaultInteraction',
  'writingFlow',
  'defaultLocale',
  'currentLocale',
  'compact',
  'refreshInterval',
  'autoCompact',
  'compactionThreshold',
  'hardPrune',
  'reserve',
  'cacheEnabled',
  'webSearch',
  'groundTruth',
  'modelRouting',
] as const

export type SettingsFieldId = (typeof SETTINGS_FIELD_IDS)[number]

/** The state chips a row can show; labels live in `settings.values`. */
export const SETTINGS_CHIP_IDS = [
  'forced',
  'readOnlyHost',
  'readOnlyPolicy',
  'readOnly',
  'local',
  'host',
  'session',
] as const

export type SettingsChipId = (typeof SETTINGS_CHIP_IDS)[number]

/** One settings group: title, one-sentence description, always-visible helper. */
export interface SettingsGroupCopy {
  readonly title: string
  readonly desc: string
  readonly helper: string
}

/** One setting row: label plus the always-visible ≤70/120 explanation. */
export interface SettingsFieldCopy {
  readonly label: string
  readonly hint: string
}

/** Status chips and option values (v24 §5.9.4). */
export interface SettingsValuesCopy {
  readonly followHost: string
  readonly followHostConfig: string
  readonly chinese: string
  readonly english: string
  readonly on: string
  readonly off: string
  readonly forced: string
  readonly readOnly: string
  readonly readOnlyHost: string
  readonly readOnlyPolicy: string
  readonly hostConfig: string
  readonly localOnly: string
  readonly local: string
  readonly host: string
  readonly session: string
  readonly help: string
  readonly loading: string
  readonly unavailable: string
  readonly default: string
  readonly connected: string
  readonly disconnected: string
  readonly hostAccessMode: string
  readonly pluginPermission: string
  readonly dshCatalog: string
  readonly writingFlow: string
  readonly refresh2: string
  readonly refresh5: string
  readonly refresh10: string
  readonly refreshPaused: string
}

/** Empty / offline / rejection states (v24 §5.9.5 plus the compaction saves). */
export interface SettingsStatesCopy {
  readonly offline: string
  readonly loading: string
  readonly empty: string
  readonly hostRejected: string
  readonly noCatalog: string
  readonly unknownLocale: string
  readonly readOnlyHost: string
  readonly settingsLocked: string
  readonly storageBlocked: string
  /** An old host build has no `/config/compaction` route. */
  readonly configUnsupported: string
  /** Transient confirmation after a host config write. */
  readonly saved: string
}

/**
 * Small labels the full settings catalog needs: chip text, the default-value
 * marker, inline validation and the honest "stored but not read yet" note.
 */
export interface SettingsCatalogValuesCopy {
  readonly chips: Readonly<Record<SettingsControlChip, string>>
  readonly commandOptions: Readonly<Record<'none' | 'goal' | 'plan' | 'feedback' | 'compact' | 'permission', string>>
  readonly defaultValue: string
  readonly scene: string
  readonly allScenes: string
  /** Table headers of the per-scene policy tables. */
  readonly field: string
  readonly value: string
  readonly status: string
  readonly notWired: string
  /** Read when the file-tool runtime is created; an existing one keeps its limits. */
  readonly captured: string
  readonly normalized: string
  readonly invalidNumber: string
  readonly outOfRange: string
  readonly alias: string
  readonly loadFailed: string
  readonly notPersisted: string
  readonly retry: string
  readonly unsupported: string
}

/** Copy of one catalog group (same three lines as the legacy page groups). */
export type SettingsCatalogGroupCopy = SettingsGroupCopy

/** Copy of the full settings catalog: 13 groups and one row per feature. */
export interface SettingsCatalogCopy {
  readonly groups: Readonly<Record<SettingsCatalogGroupId, SettingsCatalogGroupCopy>>
  readonly fields: Readonly<Record<SettingsCatalogFieldId, SettingsFieldCopy>>
  readonly values: SettingsCatalogValuesCopy
}

/** Copy of the `协调` settings page (v24 §3, §5.9). */
export interface SettingsCopy {
  /** Section title / settings-menu label. */
  readonly title: string
  /** One-line page intro. */
  readonly intro: string
  /** Footer note: switches apply immediately, there is no save button. */
  readonly applyNote: string
  /** The two-sentence "why lock" paragraph under the profession group. */
  readonly whyLock: string
  /** Footer crediting host config as the read-only source. */
  readonly footer: string
  readonly groups: Readonly<Record<SettingsGroupId, SettingsGroupCopy>>
  readonly fields: Readonly<Record<SettingsFieldId, SettingsFieldCopy>>
  /** v24 §19: the full feature/config surface, one row per feature/key. */
  readonly catalog: SettingsCatalogCopy
  readonly values: SettingsValuesCopy
  readonly states: SettingsStatesCopy
}

/** Copy of one model-facing tool: description plus per-parameter descriptions. */
export interface ToolCopy {
  readonly description: string
  readonly parameters: Readonly<Record<string, string>>
}

/** The tools whose descriptions follow the host language; names stay English. */
export type ToolName =
  | 'coordination_selection'
  | 'coordination_profession'
  | 'coordination_professionlock'

/** Everything user-visible or model-facing, in one language. */
export interface Copy {
  readonly controls: Readonly<Record<ControlName, ControlCopy>>
  readonly professions: Readonly<Record<Profession, OptionCopy>>
  readonly interactions: Readonly<Record<Interaction, OptionCopy>>
  readonly scenes: Readonly<Record<Scene, OptionCopy>>
  readonly validations: Readonly<Record<Validation, ValidationCopy>>
  readonly permissions: Readonly<Record<SandboxMode, OptionCopy>>
  readonly composer: ComposerCopy
  readonly takeover: TakeoverCopy
  readonly settings: SettingsCopy
  readonly errors: Readonly<Record<CoordinationErrorCode, string>>
  readonly tools: Readonly<Record<ToolName, ToolCopy>>
}

/** The five composer dropdowns, in render order (v24 §15.1). */
const CONTROL_NAMES: readonly ControlName[] = [
  'profession',
  'interaction',
  'scene',
  'validation',
  'permission',
]

/** Canonical retrieval budget per validation level (v24 §6.3). */
const VALIDATION_BUDGET: Readonly<Record<Validation, string>> = {
  low: '1×3',
  medium: '2×5',
  high: '4×8',
}

/** Resolve `{name}` placeholders in a copy template. Unknown names stay visible. */
export function fillTemplate(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match: string, key: string) => {
    const value = params[key]
    return value === undefined ? match : value
  })
}

/** Build a complete record from the canonical value array. */
function recordOf<T extends string, V>(values: readonly T[], build: (value: T) => V): Record<T, V> {
  const result = {} as Record<T, V>
  for (const value of values) result[value] = build(value)
  return result
}

/**
 * Resolve one settings row's copy.
 *
 * The 28 ids of the pre-catalog page live in `settings.fields`; every newer row
 * lives in `settings.catalog.fields`. A row carries exactly one copy id, so no
 * control ever has two label sources.
 */
export function settingsControlCopy(
  settings: SettingsCopy,
  copy: string,
): SettingsFieldCopy | undefined {
  const legacy = (settings.fields as Readonly<Record<string, SettingsFieldCopy | undefined>>)[copy]
  return legacy ?? (settings.catalog.fields as Readonly<Record<string, SettingsFieldCopy | undefined>>)[copy]
}

/* ------------------------------------------------------------------------- *
 * Chinese — the reference language (v24 §5, copied verbatim)
 * ------------------------------------------------------------------------- */

const ZH_CONTROL_HINTS: Readonly<Record<ControlName, string>> = {
  profession: '定这个任务由谁负哪一份责；选定后任务内不能改，要换只能重建或丢弃任务。',
  interaction: '定它怎么回应你：陪你聊、深入想、找可行方向、排掉失败方向，或拆给多个代理。',
  scene: '定这次用哪种工作方式；会改变流程、查资料的方式，以及能不能改文件。',
  validation: '定查多少资料、看多远的历史；三档都会联网，只差检索量和证据范围。',
  permission: '定这个会话能改什么；切换立刻生效，可能影响正在跑的任务。',
}

const ZH_PROFESSION_HINTS: Readonly<Record<Profession, string>> = {
  decision: '决定做不做、方案过不过；能叫停，也能放行。任务内锁定。',
  outcome: '对最后交付的东西负责：达不达标由它签字。任务内锁定。',
  resource: '管额度和花费：用多少模型、搜索和缓存。任务内锁定。',
  personnel: '管分工：谁来做、几个人、合不合规。任务内锁定。',
  qualification: '只检查模型能不能胜任，不参与干活。任务内锁定。',
  execution: '按给定条件把活做完，不验收自己的成果。任务内锁定。',
}

const ZH_INTERACTION_HINTS: Readonly<Record<Interaction, string>> = {
  emotion: '先接住情绪：听你说、理解感受，不急着给方案。',
  think: '把推理摊开，给深度分析和答案。',
  heuristic: '先找走得通的路，按成功经验排序，给最值得试的方向。',
  converge: '先排除走不通的路，说清边界、失败原因和止损点。',
  orchestrate: '拆成子任务分给多个代理，独立验收后汇总；更慢更贵，简单对话不必用。',
}

const ZH_SCENE_HINTS: Readonly<Record<Scene, string>> = {
  dialogue: '闲聊和简单问答；快，但不够深入。',
  writing: '文章、文案、报告、邮件；先定受众、语气和字数，列提纲、再改稿，最多 3 轮；不跑命令。',
  office: '整理文件、生成报告；只在工作区内操作。',
  research: '查资料、给证据和引用；慢，但结论有出处。',
  engineering: '写代码、构建、调试；能跑命令，改动不出工作区。',
  iterate: '先写、再批、再改，循环打磨；质量高，调用次数多。',
}

const ZH_VALIDATION_HINTS: Readonly<Record<Validation, string>> = {
  low: '也联网：1 次 × 3 条，只看这一轮，不翻旧会话。',
  medium: '也联网：2 次 × 5 条，看当前会话全部内容，不翻旧会话。',
  high: '也联网：4 次 × 8 条，加上全部本地会话和工作区文件，最全也最慢。',
}

const ZH_VALIDATION_SCOPE: Readonly<Record<Validation, string>> = {
  low: '当轮',
  medium: '当前会话',
  high: '本地全部',
}

const ZH_PERMISSION_HINTS: Readonly<Record<SandboxMode, string>> = {
  'read-only': '只能看：不改文件，也不跑会改东西的命令。',
  'workspace-write': '能改工作区里的文件；改工作区外会被拒绝。',
  'danger-full-access': '能改任何路径，不受工作区限制；风险最高，慎用。',
}

const ZH_GROUPS: Readonly<Record<SettingsGroupId, SettingsGroupCopy>> = {
  permission: {
    title: '权限与接管',
    desc: '这个会话能改什么，以及权限控件由谁提供。',
    helper: '权限选项来自 DSH；本插件只展示并写回，不另存一份。',
  },
  composer: {
    title: '工作流与下拉框',
    desc: '输入框里显示哪些选择器，要不要提示。',
    helper: '关掉工作流只会隐藏下拉框，不会改变已保存的选择。',
  },
  profession: {
    title: '职能与审计',
    desc: '一个任务只有一个职能：怎么锁、怎么留痕。',
    helper: '锁只在任务内生效；换任务时可以换职能。',
  },
  scene: {
    title: '情景与验证默认',
    desc: '新任务默认怎么做、查多少资料。',
    helper: '验证三档都联网：低 1×3 当轮 / 中 2×5 会话 / 高 4×8 本地全部。',
  },
  language: {
    title: '语言与显示',
    desc: '界面语言、刷新快慢和疏密。',
    helper: '语言跟随 DSH；这里不提供强制切换。',
  },
  compaction: {
    title: '自动压缩',
    desc: '上下文变长时自动压缩，省额度又不丢关键内容。',
    helper: '开关和阈值写回主机；硬性阈值与保留额度只能查看。',
  },
  advanced: {
    title: '高级',
    desc: '主机级开关，影响所有会话；通常保持默认。',
    helper: '这些值来自主机配置，在本页只读。',
  },
}

const ZH_FIELDS: Readonly<Record<SettingsFieldId, SettingsFieldCopy>> = {
  takeoverPermission: {
    label: '权限接管',
    hint: '隐藏 DSH 的访问模式按钮，改用本插件的权限下拉。',
  },
  takeoverControl: {
    label: '接管权限控件',
    hint: '只替换输入框的权限控件；DSH 的弹窗不受影响。',
  },
  takeoverDialogs: {
    label: '接管宿主弹窗',
    hint: '允许本插件接管 DSH 的审批、权限等弹窗；关掉就仍由 DSH 显示。',
  },
  permissionCatalog: {
    label: '权限预设来源',
    hint: '权限选项和审批方式由 DSH 提供；本插件不定义、不改写。',
  },
  composerWorkflow: {
    label: '工作流下拉框',
    hint: '显示职能、交互、情景、验证四个下拉框；关掉只是隐藏，不改选择。',
  },
  composerTooltips: {
    label: '显示提示',
    hint: '鼠标悬停或键盘聚焦时显示说明；关掉不影响功能。',
  },
  professionLock: {
    label: '职能锁定',
    hint: '强制开启：一个任务只能有一个职能，中途不能换。',
  },
  professionDefault: {
    label: '默认职能',
    hint: '新任务没选时用这个；任务一开始仍会锁定。',
  },
  professionRebuild: {
    label: '重建后可重选',
    hint: '重建会新建任务，新任务可以重新选职能。',
  },
  professionAbandon: {
    label: '丢弃后可重选',
    hint: '丢弃不新建任务；下一个任务可以重新选职能。',
  },
  professionAudit: {
    label: '职能审计',
    hint: '每次锁定、重建、丢弃都留一条改不掉的记录。',
  },
  professionErrorHint: {
    label: '锁定错误提示',
    hint: '改不动时，提示里直接说重建或丢弃该怎么做。',
  },
  defaultScene: {
    label: '默认情景',
    hint: '新任务默认的工作方式；写作会先列提纲再改稿。',
  },
  defaultValidation: {
    label: '默认验证',
    hint: '新任务默认查多少资料；三档都会联网检索。',
  },
  defaultInteraction: {
    label: '默认交互',
    hint: '新任务默认怎么回应；选统筹会拆子任务。',
  },
  writingFlow: {
    label: '写作流程',
    hint: '写作流程固定：先定受众、语气、字数、格式，列提纲、写初稿、至少改一稿（最多 3 轮），并检查是否清楚、连贯、贴合受众。',
  },
  defaultLocale: {
    label: '默认语言',
    hint: '界面跟随 DSH 语言；这里只设 DSH 还没报语言时的兜底。',
  },
  currentLocale: {
    label: '当前语言',
    hint: '当前实际显示的语言；由 DSH 设置决定。',
  },
  compact: {
    label: '紧凑模式',
    hint: '下拉框更窄、行距更小，小屏能多放几个控件。',
  },
  refreshInterval: {
    label: '自动刷新间隔',
    hint: '多久和主机同步一次选择状态；暂停后锁定状态可能过期。',
  },
  autoCompact: {
    label: '自动压缩',
    hint: '上下文变长时，由 DSH 在安全边界自动压缩；保留最近对话和固定事实，不压缩指令。',
  },
  compactionThreshold: {
    label: '压缩触发阈值',
    hint: '上下文占用超过这个比例后触发压缩；调高会更少压缩，上下文更长。',
  },
  hardPrune: {
    label: '硬性裁剪阈值',
    hint: '达到这个比例时必须裁剪；由主机配置决定，只能查看。',
  },
  reserve: {
    label: '保留额度',
    hint: '压缩时给最近内容和固定事实留出的空间；由主机配置决定，只能查看。',
  },
  cacheEnabled: {
    label: '缓存优化',
    hint: '复用相同请求的结果，省时间省额度；关掉可能更慢。',
  },
  webSearch: {
    label: '联网检索',
    hint: '允许各档位联网；关掉后只能用手头资料。',
  },
  groundTruth: {
    label: '确定性验收',
    hint: '能用命令或文件核对时，不靠模型自己说做完了。',
  },
  modelRouting: {
    label: '模型分流',
    hint: '允许按子任务难度换模型；关掉统一用当前模型。',
  },
}

const ZH_VALUES: SettingsValuesCopy = {
  followHost: '跟随宿主',
  followHostConfig: '跟随主机配置',
  chinese: '中文',
  english: 'English',
  on: '开',
  off: '关',
  forced: '强制',
  readOnly: '只读',
  readOnlyHost: '只读（主机）',
  readOnlyPolicy: '只读（策略）',
  hostConfig: '主机配置',
  localOnly: '本机设置',
  local: '本机',
  host: '主机',
  session: '当前会话',
  help: '查看说明',
  loading: '读取中…',
  unavailable: '连接后显示',
  default: '默认',
  connected: '主机已连接',
  disconnected: '主机未连接',
  hostAccessMode: '宿主访问模式按钮',
  pluginPermission: '本插件的权限下拉',
  dshCatalog: 'DSH 目录',
  writingFlow: '提纲→初稿→修订（最多 3 轮）',
  refresh2: '2 秒',
  refresh5: '5 秒',
  refresh10: '10 秒',
  refreshPaused: '暂停',
}

const ZH_STATES: SettingsStatesCopy = {
  offline: '主机未连接，以下为本地设置。',
  loading: '正在读取主机设置…',
  empty: '还没有任务；下面显示的是默认值。',
  hostRejected: '主机拒绝了这次修改，已保持原值。',
  noCatalog: 'DSH 没有提供权限预设，只能查看说明。',
  unknownLocale: '宿主语言无法识别，先按中文显示。',
  readOnlyHost: '主机配置，只能查看；需要部署者修改。',
  settingsLocked: '本会话有任务在跑，职能已锁定。',
  storageBlocked: '浏览器禁用了本地存储，这次改动只在当前页面有效。',
  configUnsupported: '主机不支持在线修改，请在配置文件中设置。',
  saved: '已保存。',
}

const ZH_TOOLS: Readonly<Record<ToolName, ToolCopy>> = {
  coordination_selection: {
    description: '查询或设置本会话的职能 / 交互 / 情景 / 验证 / 权限选择；修改写入下一个 Turn。',
    parameters: {
      session: '目标 DSH 会话 id；省略时使用当前会话。',
      profession: '要选择的六维职能；任务开始后不可切换。',
      interaction: '要选择的交互方式：感情 / 思维 / 启发 / 收束 / 统筹。',
      scene: '要选择的工作情景：对话 / 写作 / 办公 / 研究 / 工程 / 迭代。',
      validation: '要选择的验证档位：low / medium / high；三档都联网检索。',
      command: '要选择的命令面：none / goal / plan / feedback / compact / permission。',
      preset: 'DSH 权限预设键；只作用于当前会话。',
    },
  },
  coordination_profession: {
    // v23 §18.2 table wording, verbatim.
    description: '查询/设置职能（仅任务开始前可设置）',
    parameters: {
      session: '目标 DSH 会话 id；省略时使用当前会话。',
      profession: '要设置的职能；省略时只查询当前职能。',
    },
  },
  coordination_professionlock: {
    // v23 §18.2 table wording, verbatim.
    description: '查询职能锁定状态',
    parameters: {
      session: '目标 DSH 会话 id；省略时使用当前会话。',
      turn: '目标 Turn 序号；省略时使用当前活动 Turn。',
    },
  },
}

const ZH_TAKEOVER: TakeoverCopy = {
  title: '需要你决定',
  approvalTitle: '批准这次操作',
  questionTitle: '回答一个问题',
  allowOnce: '仅本次允许',
  reject: '拒绝',
  cancel: '取消',
  submit: '提交',
  customPlaceholder: '或自己写一个答案',
  expired: '这条请求已失效，不会再提交。',
  hostError: '没能提交，请稍后重试。',
  queueLabel: '第 {index} / {total} 条',
}

/* ------------------------------------------------------------------------- *
 * Chinese — full settings catalog (v24 §19)
 * ------------------------------------------------------------------------- */

const ZH_CATALOG_GROUPS: Readonly<Record<SettingsCatalogGroupId, SettingsCatalogGroupCopy>> = {
  session: {
    title: '会话与默认值',
    desc: '新任务从哪个默认值开始，以及会话级上限。',
    helper: '这些值写入主机配置；保存后立即生效。',
  },
  profession: {
    title: '职能与审计',
    desc: '一个任务只有一个职能：怎么锁、怎么留痕。',
    helper: '锁定与重选是强制项，只能查看；审计轨迹始终记录。',
  },
  scenes: {
    title: '情景策略',
    desc: '六个情景各自的执行策略；相同项只显示一次。',
    helper: '选一个情景查看字段；写作阈值由计划评分读取，其余字段保存后等执行器接入。',
  },
  plan: {
    title: '计划评分',
    desc: '计划过没过、差在哪、最多重建几次。',
    helper: '权重保存后按总和归一；维度是每一项的最低要求。',
  },
  orchestration: {
    title: '子任务与验收',
    desc: '拆多少子任务、退回几次、怎么验收。',
    helper: '验收优先用可核对的证据；超时或无法判定一律算不通过。',
  },
  cache: {
    title: '缓存',
    desc: '相同请求复用结果，省时间也省额度。',
    helper: '关掉只影响复用，不影响答案本身。',
  },
  bayesian: {
    title: '概率推断',
    desc: '初始概率、停止条件和路线数量。',
    helper: '这些值只调整推断的松紧，不改变结论格式。',
  },
  comprehension: {
    title: '理解与检索',
    desc: '理解一次请求的时间预算和资料上限。',
    helper: '三档验证都会检索；这里的上限对所有档位生效。',
  },
  compaction: {
    title: '自动压缩',
    desc: '上下文变长时自动压缩，省额度又不丢关键内容。',
    helper: '开关和两个阈值可改；保留额度、冷却等属于主机策略，只能查看。',
  },
  ui: {
    title: '界面与显示',
    desc: '输入框显示哪些控件、多久刷新一次、用什么语言。',
    helper: '语言跟随 DSH；接管弹窗默认关闭。',
  },
  parser: {
    title: '文件解析',
    desc: '读取工作区文件时的资源上限。',
    helper: '解析器在文件工具首次使用时创建；上限在那时读取，已创建的解析器要到重启或重新注册才换新值。',
  },
  chain: {
    title: '关系链',
    desc: '模型看到的关系链投影有多深、多宽。',
    helper: '关系链实例在文件工具首次使用时创建；深度、条数与预算在那时读取，已创建的实例要到重启或重新注册才换新值。',
  },
  tools: {
    title: '工具输出',
    desc: '工具结果返回给模型时的字节上限。',
    helper: '0 表示不限制，与当前行为一致；上限功能尚未接入。',
  },
}

const ZH_CATALOG_VALUES: SettingsCatalogValuesCopy = {
  chips: {
    host: '主机',
    local: '本机',
    forced: '强制',
    readOnly: '只读',
    planned: '计划中',
  },
  commandOptions: {
    none: '无',
    goal: '目标',
    plan: '计划',
    feedback: '反馈',
    compact: '压缩',
    permission: '权限',
  },
  defaultValue: '默认',
  scene: '情景',
  allScenes: '所有情景',
  field: '字段',
  value: '值',
  status: '状态',
  notWired: '已保存；当前版本尚未读取这一项。',
  captured: '保存后不会改动已经创建的文件工具；重启或重新注册工具后生效。',
  normalized: '保存后按总和归一，这里显示归一后的值。',
  invalidNumber: '请输入数字。',
  outOfRange: '超出允许范围。',
  alias: '别名，只读。',
  loadFailed: '主机返回的配置不完整。',
  notPersisted: '已在本进程生效；主机未保存。',
  retry: '重试',
  unsupported: '主机不支持在线修改，请在配置文件中设置。',
}

const ZH_CATALOG_FIELDS: Readonly<Record<SettingsCatalogFieldId, SettingsFieldCopy>> = {
  maxTurnPerSession: {
    label: '会话轮次上限',
    hint: '一个会话最多保留多少轮；达到上限后拒绝新任务。',
  },
  defaultLease: {
    label: '默认租约',
    hint: '资源锁默认租用多久；调用方只能要得更短。',
  },
  clarifyTimeout: {
    label: '澄清与接管超时',
    hint: '接管窗口和自动压缩等待答案的毫秒数；这是唯一的超时键。',
  },
  defaultCommand: {
    label: '默认命令',
    hint: '新任务默认带哪个命令面；none 走完整流程。',
  },
  professionEnabled: {
    label: '职能功能',
    hint: '强制开启：职能是核心约束，不能整体关掉。',
  },
  professionDefaultAlias: {
    label: '职能默认（别名）',
    hint: 'defaults.profession 的别名，只读；改默认职能会同步这里。',
  },
  planThreshold: {
    label: '计划通过线',
    hint: '综合评分达到多少才算通过；低于它要重建。',
  },
  planMaxRebuild: {
    label: '最多重建次数',
    hint: '连续重建几次后仍不过，就交给人处理。',
  },
  'planWeight.feasibility': { label: '权重 · 可行性', hint: '这项在综合评分里占多大比重；八项会自动归一。' },
  'planWeight.coverage': { label: '权重 · 覆盖度', hint: '这项在综合评分里占多大比重；八项会自动归一。' },
  'planWeight.clarity': { label: '权重 · 清晰度', hint: '这项在综合评分里占多大比重；八项会自动归一。' },
  'planWeight.specificity': { label: '权重 · 具体性', hint: '这项在综合评分里占多大比重；八项会自动归一。' },
  'planWeight.alignment': { label: '权重 · 一致性', hint: '这项在综合评分里占多大比重；八项会自动归一。' },
  'planWeight.risk': { label: '权重 · 风险', hint: '这项在综合评分里占多大比重；八项会自动归一。' },
  'planWeight.cost': { label: '权重 · 成本', hint: '这项在综合评分里占多大比重；八项会自动归一。' },
  'planWeight.efficiency': { label: '权重 · 效率', hint: '这项在综合评分里占多大比重；八项会自动归一。' },
  'planDimension.feasibility': { label: '门槛 · 可行性', hint: '可行性低于这个值就判定不通过。' },
  'planDimension.coverage': { label: '门槛 · 覆盖度', hint: '覆盖度低于这个值就判定不通过。' },
  'planDimension.clarity': { label: '门槛 · 清晰度', hint: '清晰度低于这个值就判定不通过。' },
  'planDimension.specificity': { label: '门槛 · 具体性', hint: '具体性低于这个值就判定不通过。' },
  'planDimension.alignment': { label: '门槛 · 一致性', hint: '与理解结果不一致到低于这个值，就判定不通过。' },
  'planDimension.risk': { label: '门槛 · 风险', hint: '风险高于这个值就判定不通过；越低越好。' },
  'planDimension.cost': { label: '门槛 · 成本', hint: '成本高于这个值就判定不通过；越低越好。' },
  'planDimension.efficiency': { label: '门槛 · 效率', hint: '效率低于这个值就判定不通过。' },
  maxReject: {
    label: '退回上限',
    hint: '一个子任务最多被退回几次；到上限只能接受部分或升级。',
  },
  maxSubTask: {
    label: '子任务上限',
    hint: '一次拆分最多能产生多少个子任务。',
  },
  groundTruthTimeout: {
    label: '验收超时',
    hint: '确定性检查最多等多久；超时按不通过处理。',
  },
  allowShellGroundTruth: {
    label: '允许命令验收',
    hint: '允许用命令退出码作为验收证据；默认关闭，避免误执行。',
  },
  cacheTtl: {
    label: '缓存有效期',
    hint: '缓存结果保留多少毫秒；0 表示立即过期。',
  },
  cacheFingerprintWindow: {
    label: '指纹窗口',
    hint: '参与指纹计算的最近消息条数上限。',
  },
  cacheEffortWarning: {
    label: '推理强度提醒',
    hint: '强度变更导致缓存失效时提醒一次。',
  },
  prior: {
    label: '初始概率',
    hint: '没有任何证据前，一条路线成功的默认概率。',
  },
  stopEntropy: {
    label: '停止熵',
    hint: '不确定性低于这个值就停止继续推断。',
  },
  infoGain: {
    label: '信息增益下限',
    hint: '新增证据至少要带来这么多新信息才被采纳。',
  },
  maxRoutes: {
    label: '路线上限',
    hint: '一次最多比较多少条候选路线。',
  },
  calibrationFloor: {
    label: '校准下限',
    hint: '校准分数低于这个值时，不再把它当作证据。',
  },
  stageTimeout: {
    label: '阶段超时',
    hint: '单个理解阶段最多花多少毫秒，超时就跳过检索。',
  },
  maxEvidence: {
    label: '证据条数上限',
    hint: '每次检索最多保留多少条证据。',
  },
  highHistoryWindow: {
    label: '历史窗口',
    hint: '最高档验证最多回看多少条本地历史。',
  },
  recentTurns: {
    label: '保留轮次',
    hint: '压缩时原样保留最近多少轮对话。',
  },
  cooldown: {
    label: '压缩冷却',
    hint: '两次自动压缩之间至少间隔多少毫秒。',
  },
  maxPerSession: {
    label: '每会话上限',
    hint: '一个会话最多自动压缩多少次。',
  },
  toolbarDeprecated: {
    label: '工作流下拉框（旧键）',
    hint: '已废弃的旧开关，只读；请改本机的工作流开关。',
  },
  parserEnabled: {
    label: '解析总开关',
    hint: '在注册文件工具时读取；改动要等下一次重注册（重启或切换语言）后生效。',
  },
  maxFileBytes: {
    label: '单文件字节上限',
    hint: '单文件最多读多少字节，超出只解析前缀并标记截断。',
  },
  maxTokens: {
    label: '词元上限',
    hint: '单文件最多产出多少词元，超出停止并标记。',
  },
  maxAstDepth: {
    label: '语法树深度',
    hint: '语法树最多到多深，超出停止并标记。',
  },
  timeoutMs: {
    label: '解析超时',
    hint: '单文件解析最多多少毫秒，超时返回已收集的引用。',
  },
  cacheCapacity: {
    label: '解析缓存条数',
    hint: '解析结果缓存最多保留多少个文件。',
  },
  dependencyGraphMaxVertices: {
    label: '依赖图节点上限',
    hint: '依赖图最多多少节点，超出停止并标记。',
  },
  dependencyGraphMaxEdges: {
    label: '依赖图边上限',
    hint: '依赖图最多多少条边，超出停止并标记。',
  },
  chainDepth: {
    label: '关系链深度',
    hint: '一次投影最多向下走几层，上限为 8。',
  },
  chainLinks: {
    label: '关系链条数',
    hint: '一次投影最多返回多少条关系。',
  },
  chainTokenBudget: {
    label: '关系链词元预算',
    hint: '一次投影大约占用多少词元。',
  },
  toolMaxResultBytes: {
    label: '工具结果字节上限',
    hint: '工具返回给模型的字节上限；0 表示不限制。',
  },
  'scene.requirePlan': {
    label: '必须出计划',
    hint: '这一情景是否必须先有可评分的计划。',
  },
  'scene.requireScore': {
    label: '必须评分',
    hint: '这一情景是否必须给产出打分。',
  },
  'scene.requireOutline': {
    label: '必须先列提纲',
    hint: '先列提纲再写正文；写作默认开启。',
  },
  'scene.requireRevision': {
    label: '必须修订',
    hint: '至少要改一稿；写作默认开启。',
  },
  'scene.requirePredict': {
    label: '必须预测',
    hint: '动手前先写出预测和验证方式；研究和工程默认开启。',
  },
  'scene.requireCitation': {
    label: '必须引用',
    hint: '结论必须带出处；研究默认开启。',
  },
  'scene.allowBash': {
    label: '允许命令',
    hint: '允许运行命令；只有工程默认开启。',
  },
  'scene.sandboxOnly': {
    label: '仅限工作区',
    hint: '只能动工作区里的文件，越界一律拒绝。',
  },
  'scene.maxIteration': {
    label: '最大迭代',
    hint: '这一情景最多循环几轮。',
  },
  'scene.allowWeb': {
    label: '允许联网（所有情景）',
    hint: '六个情景共用一个开关，一次写入全部六项。',
  },
  'scene.scoreThreshold': {
    label: '情景评分阈值（所有情景）',
    hint: '六个情景共用一个阈值；写作的阈值会被计划评分读取。',
  },
}

const ZH: Copy = {
  controls: recordOf(CONTROL_NAMES, (name) => ({
    label: ControlLabel[name],
    hint: ZH_CONTROL_HINTS[name],
  })),
  professions: recordOf(ProfessionValues, (value) => ({
    label: ProfessionLabel[value],
    hint: ZH_PROFESSION_HINTS[value],
  })),
  interactions: recordOf(InteractionValues, (value) => ({
    label: InteractionLabel[value],
    hint: ZH_INTERACTION_HINTS[value],
  })),
  scenes: recordOf(SceneValues, (value) => ({
    label: SceneLabel[value],
    hint: ZH_SCENE_HINTS[value],
  })),
  validations: recordOf(ValidationValues, (level) => ({
    label: ValidationLabel[level],
    hint: ZH_VALIDATION_HINTS[level],
    budget: VALIDATION_BUDGET[level],
    scope: ZH_VALIDATION_SCOPE[level],
  })),
  permissions: recordOf(SandboxModeValues, (mode) => ({
    label: PermissionLabel[mode],
    hint: ZH_PERMISSION_HINTS[mode],
  })),
  composer: {
    currentLabel: '当前',
    controlTitle: '{control} · {currentLabel}：{current}',
    controlAria: '{control}，{currentLabel}：{current}',
    lockedAria: '{control} · {currentLabel}：{current}。{explanation}',
    optionAria: '{label}。{hint}',
    lockedLine: '任务已开始，职能锁定；完成或新建任务后可改。',
    unlockedLine: '现在可以选；任务一开始就锁定。',
    frozenByPlan: '计划进行中，验证已冻结；计划结束或重建后自动恢复。',
    frozenByGoal: '目标进行中，交互已冻结；清除目标或本轮结束后自动恢复。',
    frozenPlanRejected: '计划进行中，验证改不了；等计划结束或重建。',
    frozenGoalRejected: '目标进行中，交互改不了；先清除目标或结束本轮。',
    offlineLine: '主机未连接；这里的选择只存本机，不影响任务。',
    localOnly: '只存本机',
    permissionCatalogMissing: 'DSH 没有提供权限预设，这里只显示说明，不能切换。',
    permissionApplyFailed: 'DSH 没有提供权限预设，权限没有切换。',
    permissionOffline: '主机未连接，权限不能切换。',
    permissionWriteNow: '切换会立刻写进本会话的 DSH 权限。',
    permissionPresetDefault: '权限档位由 DSH 的权限预设定义。',
    customPreset: '自定义权限预设，DSH 目录里没有；切换前先确认影响。',
    followDsh: '跟随 DSH',
    followDshMode: '跟随 DSH（默认：{mode}）',
    permissionFollowHint: '当前没有应用任何权限预设，跟随 DSH 的默认档位。',
    loadingSelection: '正在加载主机选择…',
    approvalPolicy: '审批方式：{approval}',
    validationNote: '三档都联网：低 1×3 当轮 / 中 2×5 当前会话 / 高 4×8 本地全部。',
    professionLocked: '职能已锁定，改动没有生效。',
    professionLockedRebuild: '职能已锁定，改动没有生效；重建或丢弃任务后可改。',
    invalidSelection: '这个选项无效，已恢复原选择。',
    requestFailed: '主机拒绝了这次修改，已恢复原选择。',
    permissionConfirmTitle: '完全权限需要再次确认',
    permissionConfirmBody: '完全权限能改任何路径，不受工作区限制；确认后立即写进本会话。',
    permissionConfirmAccept: '确认切换',
    permissionConfirmCancel: '取消',
    escalationCurrent: '当前职能：{profession}',
    escalationRequested: '请求改为：{profession}',
    escalationRebuild: '重建任务',
    escalationAbandon: '丢弃任务',
    escalationUnsupported: '主机不支持重建，请升级插件。',
  },
  takeover: ZH_TAKEOVER,
  settings: {
    title: '协调',
    intro: '为下一个任务设默认值；设置保存后生效，个别上限要等工具重新注册。',
    applyNote: '改动会立即保存；个别上限要等工具重新注册后才生效。',
    whyLock: '一个任务只有一个职能，出事时才能找到唯一责任人：干活的不能自己验收，验收的不能自己改口。锁定只在任务内有效，换任务随时可以换。',
    footer: '只读项来自主机配置；可编辑项写回主机并尝试持久化。提示与说明共用一份文案。',
    groups: ZH_GROUPS,
    fields: ZH_FIELDS,
    catalog: { groups: ZH_CATALOG_GROUPS, fields: ZH_CATALOG_FIELDS, values: ZH_CATALOG_VALUES },
    values: ZH_VALUES,
    states: ZH_STATES,
  },
  errors: {
    PROFESSION_LOCKED: '任务已开始，职能不能改；请完成它，或重建/丢弃后再选。',
    PROFESSION_REQUIRED: '还没选职能；先选一个再开始任务。',
    NOT_FOUND: '没找到这条记录，可能已被删除。',
    INVALID_STATE: '当前状态不允许这么做。',
    INVALID_ARGUMENT: '这次填写的内容无效，请检查后重试。',
    ORCHESTRATION: '子任务没走通；检查任务拆分和前后依赖。',
    VERIFICATION: '独立验收没通过，任务不能算完成。',
    TAKEOVER: '接管窗口处理失败，请重试。',
    PERMISSION: '权限不够，或这个权限档位不可用。',
    DATABASE: '读写本地记录失败。',
    CONFIG: '插件配置有问题，请检查配置项。',
    UPSTREAM: '模型服务返回了错误，请稍后重试。',
    NOT_IMPLEMENTED: '当前部署没有提供这个功能。',
  },
  tools: ZH_TOOLS,
}

/* ------------------------------------------------------------------------- *
 * English — a faithful per-key translation (v24 §5)
 * ------------------------------------------------------------------------- */

const EN_CONTROL_LABELS: Readonly<Record<ControlName, string>> = {
  profession: 'Profession',
  interaction: 'Interaction',
  scene: 'Scene',
  validation: 'Validation',
  permission: 'Permission',
}

const EN_PROFESSION_LABELS: Readonly<Record<Profession, string>> = {
  decision: 'Decision',
  outcome: 'Outcome',
  resource: 'Resource',
  personnel: 'Personnel',
  qualification: 'Qualification',
  execution: 'Execution',
}

const EN_INTERACTION_LABELS: Readonly<Record<Interaction, string>> = {
  emotion: 'Emotion',
  think: 'Think',
  heuristic: 'Heuristic',
  converge: 'Converge',
  orchestrate: 'Orchestrate',
}

const EN_SCENE_LABELS: Readonly<Record<Scene, string>> = {
  dialogue: 'Dialogue',
  writing: 'Writing',
  office: 'Office',
  research: 'Research',
  engineering: 'Engineering',
  iterate: 'Iterate',
}

const EN_VALIDATION_LABELS: Readonly<Record<Validation, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

const EN_PERMISSION_LABELS: Readonly<Record<SandboxMode, string>> = {
  'read-only': 'Read-only',
  'workspace-write': 'Workspace write',
  'danger-full-access': 'Full access',
}

const EN_CONTROL_HINTS: Readonly<Record<ControlName, string>> = {
  profession: 'Sets which single duty this task is accountable for. It cannot change mid-task; rebuild or abandon to choose again.',
  interaction: 'Sets how it responds: listen, reason deeply, find what works, rule out what fails, or split work across agents.',
  scene: 'Sets the working mode; it changes the process, how evidence is gathered, and whether files can be changed.',
  validation: 'Sets how much evidence is gathered and how far back it looks; all three levels search the web, and only the volume and scope differ.',
  permission: 'Sets what this session may change; the switch applies immediately and can affect a running task.',
}

const EN_PROFESSION_HINTS: Readonly<Record<Profession, string>> = {
  decision: 'Decides whether to proceed and whether the plan passes; can stop or approve. Locked for the task.',
  outcome: 'Owns the final deliverable and signs off on whether it meets the goal. Locked for the task.',
  resource: 'Owns budget and cost: how much model, search, and cache the task uses. Locked for the task.',
  personnel: 'Owns staffing: who does the work, how many, and whether that is allowed. Locked for the task.',
  qualification: 'Checks whether a model is qualified, without doing the work. Locked for the task.',
  execution: 'Completes the work under the given conditions and does not verify itself. Locked for the task.',
}

const EN_INTERACTION_HINTS: Readonly<Record<Interaction, string>> = {
  emotion: 'Listens first: acknowledges feelings before offering solutions.',
  think: 'Lays out the reasoning and gives a deep analysis and answer.',
  heuristic: 'Finds routes that work, ranked by past successes, and names the best direction to try.',
  converge: 'Rules out routes that fail, with the boundary, the cause, and the point to stop.',
  orchestrate: 'Splits work into subtasks, verifies each independently, then synthesises. Slower and costlier; not for simple chat.',
}

const EN_SCENE_HINTS: Readonly<Record<Scene, string>> = {
  dialogue: 'Small talk and quick Q&A; fast but shallow.',
  writing: 'Articles, copy, reports, email; set audience, tone, and length, outline and revise, up to 3 rounds; no commands.',
  office: 'Organises files and generates reports; limited to the workspace.',
  research: 'Searches sources and cites evidence; slow, but conclusions are traceable.',
  engineering: 'Writes code, builds, and debugs; can run commands, with changes confined to the workspace.',
  iterate: 'Draft, critique, revise in a loop; high quality, more model calls.',
}

const EN_VALIDATION_HINTS: Readonly<Record<Validation, string>> = {
  low: 'Also searches: 1 query × 3 results, this turn only; no older sessions.',
  medium: 'Also searches: 2 queries × 5 results across this whole session; no older sessions.',
  high: 'Also searches: 4 queries × 8 results plus all local sessions and workspace files; the most complete and slowest.',
}

const EN_VALIDATION_SCOPE: Readonly<Record<Validation, string>> = {
  low: 'this turn',
  medium: 'this session',
  high: 'all local content',
}

const EN_PERMISSION_HINTS: Readonly<Record<SandboxMode, string>> = {
  'read-only': 'View only: no file changes and no commands that change anything.',
  'workspace-write': 'Can change files inside the workspace; writes outside it are refused.',
  'danger-full-access': 'Can change any path, outside the workspace too; highest risk, use with care.',
}

const EN_GROUPS: Readonly<Record<SettingsGroupId, SettingsGroupCopy>> = {
  permission: {
    title: 'Permission & takeover',
    desc: 'What this session may change, and who provides the permission control.',
    helper: 'Permission options come from DSH; this plugin only displays and writes back the chosen one.',
  },
  composer: {
    title: 'Workflow & selectors',
    desc: 'Which selectors appear in the composer, and whether hints show.',
    helper: 'Turning workflow off only hides the selectors; saved choices are unchanged.',
  },
  profession: {
    title: 'Profession & audit',
    desc: 'One duty per task: how it locks and how it is recorded.',
    helper: 'The lock lasts only for the task; a new task can choose another profession.',
  },
  scene: {
    title: 'Scene & validation defaults',
    desc: 'How new tasks work and how much evidence they gather by default.',
    helper: 'All validation levels search: low 1×3 this turn / medium 2×5 the session / high 4×8 all local content.',
  },
  language: {
    title: 'Language & display',
    desc: 'Interface language, refresh rate, and density.',
    helper: 'Language follows DSH; there is no forced override here.',
  },
  compaction: {
    title: 'Auto-compaction',
    desc: 'Compacts a long context automatically, saving budget without losing what matters.',
    helper: 'The switch and threshold are written back to the host; hard and reserve are read-only.',
  },
  advanced: {
    title: 'Advanced',
    desc: 'Host-level switches that affect every session; usually keep the defaults.',
    helper: 'These values come from host config and are read-only here.',
  },
}

const EN_FIELDS: Readonly<Record<SettingsFieldId, SettingsFieldCopy>> = {
  takeoverPermission: {
    label: 'Permission takeover',
    hint: "Hides DSH's access-mode button and uses this plugin's permission dropdown instead.",
  },
  takeoverControl: {
    label: 'Taken-over control',
    hint: "Replaces only the composer's permission control; DSH dialogs are unaffected.",
  },
  takeoverDialogs: {
    label: 'Host dialog takeover',
    hint: "Lets this plugin take over DSH approval and permission dialogs; off keeps DSH's own.",
  },
  permissionCatalog: {
    label: 'Permission preset source',
    hint: 'Permission options and approval policy come from DSH; this plugin does not define or rewrite them.',
  },
  composerWorkflow: {
    label: 'Composer selectors',
    hint: 'Shows the profession, interaction, scene, and validation dropdowns; off only hides them.',
  },
  composerTooltips: {
    label: 'Show hints',
    hint: 'Shows explanations on hover or keyboard focus; turning it off changes nothing else.',
  },
  professionLock: {
    label: 'Profession lock',
    hint: 'Forced on: a task has exactly one profession and cannot switch mid-task.',
  },
  professionDefault: {
    label: 'Default profession',
    hint: 'Used when a new task has no choice; it still locks when the task starts.',
  },
  professionRebuild: {
    label: 'Reselect after rebuild',
    hint: 'A rebuild creates a new task, which may choose a new profession.',
  },
  professionAbandon: {
    label: 'Reselect after abandon',
    hint: 'Abandoning creates no new task; the next task may choose a new profession.',
  },
  professionAudit: {
    label: 'Profession audit',
    hint: 'Every lock, rebuild, and abandon leaves a record that cannot be altered.',
  },
  professionErrorHint: {
    label: 'Lock error hint',
    hint: 'When a change is refused, the message says how to rebuild or abandon.',
  },
  defaultScene: {
    label: 'Default scene',
    hint: 'The default working mode for new tasks; writing outlines first, then revises.',
  },
  defaultValidation: {
    label: 'Default validation',
    hint: 'How much evidence new tasks gather by default; all three levels search the web.',
  },
  defaultInteraction: {
    label: 'Default interaction',
    hint: 'How new tasks respond by default; orchestrate splits them into subtasks.',
  },
  writingFlow: {
    label: 'Writing flow',
    hint: 'Writing sets audience, tone, length, and format; outlines, drafts, revises (max 3 rounds); checks clarity and fit.',
  },
  defaultLocale: {
    label: 'Default language',
    hint: "The UI follows DSH's language; this only sets the fallback before DSH reports one.",
  },
  currentLocale: {
    label: 'Current language',
    hint: "The language actually shown; decided by DSH's own setting.",
  },
  compact: {
    label: 'Compact mode',
    hint: 'Narrower dropdowns and tighter spacing so more controls fit on small screens.',
  },
  refreshInterval: {
    label: 'Auto-refresh interval',
    hint: 'How often choices sync with the host; when paused, lock state can go stale.',
  },
  autoCompact: {
    label: 'Auto-compaction',
    hint: 'Compacts a long context at a safe boundary; keeps recent messages and pinned facts, never compacts instructions.',
  },
  compactionThreshold: {
    label: 'Compaction trigger',
    hint: 'Compaction starts once the context passes this share; higher means fewer compactions and a longer context.',
  },
  hardPrune: {
    label: 'Hard prune threshold',
    hint: 'At this share the context is pruned regardless; set by host config and read-only here.',
  },
  reserve: {
    label: 'Reserved space',
    hint: 'Space kept for recent content and pinned facts during compaction; set by host config, read-only.',
  },
  cacheEnabled: {
    label: 'Cache optimization',
    hint: 'Reuses results for identical requests to save time and budget; off can be slower.',
  },
  webSearch: {
    label: 'Web search',
    hint: 'Lets every level search the web; off leaves only the material at hand.',
  },
  groundTruth: {
    label: 'Deterministic checks',
    hint: "When a command or file can prove it, the model's own word does not count as done.",
  },
  modelRouting: {
    label: 'Model routing',
    hint: 'Lets subtasks switch models by difficulty; off keeps the current model throughout.',
  },
}

const EN_VALUES: SettingsValuesCopy = {
  followHost: 'Follow host',
  followHostConfig: 'Follows host config',
  chinese: '中文',
  english: 'English',
  on: 'On',
  off: 'Off',
  forced: 'Forced',
  readOnly: 'Read-only',
  readOnlyHost: 'Read-only (host)',
  readOnlyPolicy: 'Read-only (policy)',
  hostConfig: 'Host config',
  localOnly: 'On this device',
  local: 'This device',
  host: 'Host',
  session: 'Current session',
  help: 'Show help',
  loading: 'Loading…',
  unavailable: 'Shown when connected',
  default: 'Default',
  connected: 'Host connected',
  disconnected: 'Host unreachable',
  hostAccessMode: 'DSH access-mode',
  pluginPermission: 'Plugin permission',
  dshCatalog: 'DSH catalog',
  writingFlow: 'Outline → draft → revise (max 3 rounds)',
  refresh2: '2 s',
  refresh5: '5 s',
  refresh10: '10 s',
  refreshPaused: 'Paused',
}

const EN_STATES: SettingsStatesCopy = {
  offline: 'Host unreachable; the settings below are local.',
  loading: 'Reading host settings…',
  empty: 'No task yet; the values below are defaults.',
  hostRejected: 'The host rejected the change; the previous value was kept.',
  noCatalog: 'DSH exposes no permission presets; descriptions only.',
  unknownLocale: 'The host language is not recognised; Chinese is used for now.',
  readOnlyHost: 'Host config, read-only here; a deployment admin can change it.',
  settingsLocked: 'A task is running in this session, so the profession is locked.',
  storageBlocked: 'The browser blocked local storage, so this change lasts only on this page.',
  configUnsupported: 'This host cannot change it online; set it in the configuration file.',
  saved: 'Saved.',
}

const EN_TOOLS: Readonly<Record<ToolName, ToolCopy>> = {
  coordination_selection: {
    description: 'Read or set this session\'s profession / interaction / scene / validation / permission selection; changes apply to the next turn.',
    parameters: {
      session: 'Target DSH session id; the current session when omitted.',
      profession: 'The six-dimension profession to select; it cannot be switched once the task starts.',
      interaction: 'Interaction to select: emotion / think / heuristic / converge / orchestrate.',
      scene: 'Working scene to select: dialogue / writing / office / research / engineering / iterate.',
      validation: 'Validation level to select: low / medium / high; all three levels search the web.',
      command: 'Command face to select: none / goal / plan / feedback / compact / permission.',
      preset: 'DSH permission preset key; it applies to the current session only.',
    },
  },
  coordination_profession: {
    description: 'Read or set the profession (settable only before the task starts).',
    parameters: {
      session: 'Target DSH session id; the current session when omitted.',
      profession: 'Profession to set; omit it to read the current profession.',
    },
  },
  coordination_professionlock: {
    description: 'Read the profession lock state.',
    parameters: {
      session: 'Target DSH session id; the current session when omitted.',
      turn: 'Target turn ordinal; the active turn when omitted.',
    },
  },
}

const EN_TAKEOVER: TakeoverCopy = {
  title: 'Needs your decision',
  approvalTitle: 'Approve this action',
  questionTitle: 'Answer a question',
  allowOnce: 'Allow once',
  reject: 'Reject',
  cancel: 'Cancel',
  submit: 'Submit',
  customPlaceholder: 'Or write your own answer',
  expired: 'This request is no longer valid and was not submitted.',
  hostError: 'Could not submit; try again in a moment.',
  queueLabel: '{index} of {total}',
}

/* ------------------------------------------------------------------------- *
 * English — full settings catalog (v24 §19)
 * ------------------------------------------------------------------------- */

const EN_CATALOG_GROUPS: Readonly<Record<SettingsCatalogGroupId, SettingsCatalogGroupCopy>> = {
  session: {
    title: 'Session & defaults',
    desc: 'Where a new task starts, and the per-session caps.',
    helper: 'These values are written to host config and apply immediately.',
  },
  profession: {
    title: 'Profession & audit',
    desc: 'One duty per task: how it locks and how it is recorded.',
    helper: 'The lock and reselect flags are forced and read-only; the audit trail always records.',
  },
  scenes: {
    title: 'Scene policy',
    desc: 'Per-scene execution policy; identical fields appear once.',
    helper: 'Pick a scene to see its fields; plan scoring reads the writing threshold, the rest waits for the scene executor.',
  },
  plan: {
    title: 'Plan scoring',
    desc: 'Whether a plan passes, what failed, and how many rebuilds.',
    helper: 'Weights are normalised to sum 1 on save; each dimension is a floor.',
  },
  orchestration: {
    title: 'Subtasks & verification',
    desc: 'How many subtasks, how many rejections, how work is accepted.',
    helper: 'Acceptance prefers checkable evidence; a timeout or an undecidable check fails closed.',
  },
  cache: {
    title: 'Cache',
    desc: 'Reuse results for identical requests to save time and budget.',
    helper: 'Turning it off only drops reuse; answers are unaffected.',
  },
  bayesian: {
    title: 'Probability inference',
    desc: 'Starting probability, stop rule and route count.',
    helper: 'These values adjust how tight inference is, not the shape of an answer.',
  },
  comprehension: {
    title: 'Understanding & retrieval',
    desc: 'Time and material limits for understanding one request.',
    helper: 'All three validation levels search; these caps apply to every level.',
  },
  compaction: {
    title: 'Auto-compaction',
    desc: 'Compacts a long context automatically without losing what matters.',
    helper: 'The switch and two thresholds are editable; reserve and cooldown are host policy and read-only.',
  },
  ui: {
    title: 'Interface & display',
    desc: 'Which controls show, how often to refresh, and the language.',
    helper: 'Language follows DSH; the takeover dialog is off by default.',
  },
  parser: {
    title: 'File parsing',
    desc: 'Resource caps when reading workspace files.',
    helper: 'The parser is created on first file-tool use; the caps are read then, and an existing parser keeps its values until a restart or re-registration.',
  },
  chain: {
    title: 'Relation chain',
    desc: 'How deep and wide the chain projection the model sees is.',
    helper: 'The chain instance is created on first file-tool use; depth, links and budget are read then, and an existing instance keeps its values until a restart or re-registration.',
  },
  tools: {
    title: 'Tool output',
    desc: 'Byte cap on a tool result returned to the model.',
    helper: '0 means no cap, matching current behaviour; the cap is not wired yet.',
  },
}

const EN_CATALOG_VALUES: SettingsCatalogValuesCopy = {
  chips: {
    host: 'Host',
    local: 'This device',
    forced: 'Forced',
    readOnly: 'Read-only',
    planned: 'Planned',
  },
  commandOptions: {
    none: 'None',
    goal: 'Goal',
    plan: 'Plan',
    feedback: 'Feedback',
    compact: 'Compact',
    permission: 'Permission',
  },
  defaultValue: 'Default',
  scene: 'Scene',
  allScenes: 'All scenes',
  field: 'Field',
  value: 'Value',
  status: 'Status',
  notWired: 'Saved; this build does not read this value yet.',
  captured: 'Does not change an already-created file tool; it applies after a restart or tool re-registration.',
  normalized: 'Normalised on save; the value shown is the normalised one.',
  invalidNumber: 'Enter a number.',
  outOfRange: 'Outside the allowed range.',
  alias: 'Alias, read-only.',
  loadFailed: 'The host returned an incomplete config.',
  notPersisted: 'Active for this process; the host did not save it.',
  retry: 'Retry',
  unsupported: 'This host cannot change it online; set it in the configuration file.',
}

const EN_CATALOG_FIELDS: Readonly<Record<SettingsCatalogFieldId, SettingsFieldCopy>> = {
  maxTurnPerSession: {
    label: 'Turn cap per session',
    hint: 'How many turns a session keeps; new tasks are refused at the cap.',
  },
  defaultLease: {
    label: 'Default lease',
    hint: 'Default resource-lock lease in milliseconds; callers may ask for less.',
  },
  clarifyTimeout: {
    label: 'Clarify & takeover timeout',
    hint: 'Milliseconds a takeover or compaction waits for an answer; the only timeout key.',
  },
  defaultCommand: {
    label: 'Default command',
    hint: 'Command face a new task starts with; none runs the full flow.',
  },
  professionEnabled: {
    label: 'Profession feature',
    hint: 'Forced on: the profession dimension is core and cannot be switched off.',
  },
  professionDefaultAlias: {
    label: 'Profession default (alias)',
    hint: 'Alias of defaults.profession, read-only; changing the default updates it.',
  },
  planThreshold: {
    label: 'Plan pass line',
    hint: 'Overall score a plan must reach; below it the plan is rebuilt.',
  },
  planMaxRebuild: {
    label: 'Max rebuilds',
    hint: 'Rebuilds allowed before the plan goes to a human.',
  },
  'planWeight.feasibility': { label: 'Weight · Feasibility', hint: 'Share of the overall score; all eight weights are normalised together.' },
  'planWeight.coverage': { label: 'Weight · Coverage', hint: 'Share of the overall score; all eight weights are normalised together.' },
  'planWeight.clarity': { label: 'Weight · Clarity', hint: 'Share of the overall score; all eight weights are normalised together.' },
  'planWeight.specificity': { label: 'Weight · Specificity', hint: 'Share of the overall score; all eight weights are normalised together.' },
  'planWeight.alignment': { label: 'Weight · Alignment', hint: 'Share of the overall score; all eight weights are normalised together.' },
  'planWeight.risk': { label: 'Weight · Risk', hint: 'Share of the overall score; all eight weights are normalised together.' },
  'planWeight.cost': { label: 'Weight · Cost', hint: 'Share of the overall score; all eight weights are normalised together.' },
  'planWeight.efficiency': { label: 'Weight · Efficiency', hint: 'Share of the overall score; all eight weights are normalised together.' },
  'planDimension.feasibility': { label: 'Floor · Feasibility', hint: 'A plan fails when feasibility falls below this value.' },
  'planDimension.coverage': { label: 'Floor · Coverage', hint: 'A plan fails when coverage falls below this value.' },
  'planDimension.clarity': { label: 'Floor · Clarity', hint: 'A plan fails when clarity falls below this value.' },
  'planDimension.specificity': { label: 'Floor · Specificity', hint: 'A plan fails when specificity falls below this value.' },
  'planDimension.alignment': { label: 'Floor · Alignment', hint: 'A plan fails when alignment with the request falls below this value.' },
  'planDimension.risk': { label: 'Floor · Risk', hint: 'A plan fails when risk rises above this value; lower is better.' },
  'planDimension.cost': { label: 'Floor · Cost', hint: 'A plan fails when cost rises above this value; lower is better.' },
  'planDimension.efficiency': { label: 'Floor · Efficiency', hint: 'A plan fails when efficiency falls below this value.' },
  maxReject: {
    label: 'Rejection cap',
    hint: 'Times a subtask may be rejected; then only partial acceptance or escalation.',
  },
  maxSubTask: {
    label: 'Subtask cap',
    hint: 'Subtasks one split may create.',
  },
  groundTruthTimeout: {
    label: 'Acceptance timeout',
    hint: 'How long a deterministic check may run; a timeout counts as a failure.',
  },
  allowShellGroundTruth: {
    label: 'Command acceptance',
    hint: 'Lets a command exit code count as acceptance evidence; off by default.',
  },
  cacheTtl: {
    label: 'Cache lifetime',
    hint: 'Milliseconds a cached result stays valid; 0 expires it at once.',
  },
  cacheFingerprintWindow: {
    label: 'Fingerprint window',
    hint: 'Upper bound on recent messages used for a fingerprint.',
  },
  cacheEffortWarning: {
    label: 'Effort-change warning',
    hint: 'Warns once when a reasoning-effort change invalidates the cache.',
  },
  prior: {
    label: 'Starting probability',
    hint: 'Default success probability of a route before any evidence.',
  },
  stopEntropy: {
    label: 'Stop entropy',
    hint: 'Stops inferring once uncertainty falls below this value.',
  },
  infoGain: {
    label: 'Information-gain floor',
    hint: 'New evidence must add at least this much information to count.',
  },
  maxRoutes: {
    label: 'Route cap',
    hint: 'Candidate routes compared at once.',
  },
  calibrationFloor: {
    label: 'Calibration floor',
    hint: 'A calibration score below this value no longer counts as evidence.',
  },
  stageTimeout: {
    label: 'Stage timeout',
    hint: 'Milliseconds one understanding stage may spend; search is skipped on timeout.',
  },
  maxEvidence: {
    label: 'Evidence cap',
    hint: 'Evidence entries kept per search.',
  },
  highHistoryWindow: {
    label: 'History window',
    hint: 'Local history entries the high validation level may read.',
  },
  recentTurns: {
    label: 'Kept turns',
    hint: 'Recent turns kept verbatim during compaction.',
  },
  cooldown: {
    label: 'Compaction cooldown',
    hint: 'Minimum milliseconds between two automatic compactions.',
  },
  maxPerSession: {
    label: 'Per-session cap',
    hint: 'Automatic compactions allowed per session.',
  },
  toolbarDeprecated: {
    label: 'Workflow selectors (legacy)',
    hint: 'Deprecated legacy switch, read-only; use the local workflow switch instead.',
  },
  parserEnabled: {
    label: 'Parser switch',
    hint: 'Read when the file tools are registered; a change applies after the next re-registration (restart or language switch).',
  },
  maxFileBytes: {
    label: 'Bytes per file',
    hint: 'Bytes read per file; beyond it only the prefix is parsed and marked truncated.',
  },
  maxTokens: {
    label: 'Tokens per file',
    hint: 'Tokens emitted per file; parsing stops and marks truncation above it.',
  },
  maxAstDepth: {
    label: 'Syntax-tree depth',
    hint: 'Maximum syntax-tree depth; deeper nodes stop and mark truncation.',
  },
  timeoutMs: {
    label: 'Parse timeout',
    hint: 'Milliseconds one parse may run; collected references are returned on timeout.',
  },
  cacheCapacity: {
    label: 'Parse cache size',
    hint: 'Files kept in the parse-result cache.',
  },
  dependencyGraphMaxVertices: {
    label: 'Graph node cap',
    hint: 'Maximum nodes in a dependency graph; exceeding it stops and marks truncation.',
  },
  dependencyGraphMaxEdges: {
    label: 'Graph edge cap',
    hint: 'Maximum edges in a dependency graph; exceeding it stops and marks truncation.',
  },
  chainDepth: {
    label: 'Chain depth',
    hint: 'Levels one projection may follow; capped at 8.',
  },
  chainLinks: {
    label: 'Chain links',
    hint: 'Links one projection may return.',
  },
  chainTokenBudget: {
    label: 'Chain budget',
    hint: 'Approximate word units one projection may use.',
  },
  toolMaxResultBytes: {
    label: 'Tool result bytes',
    hint: 'Byte cap on a tool result returned to the model; 0 means no cap.',
  },
  'scene.requirePlan': {
    label: 'Plan required',
    hint: 'Whether this scene must produce a scoreable plan first.',
  },
  'scene.requireScore': {
    label: 'Score required',
    hint: 'Whether this scene must score its output.',
  },
  'scene.requireOutline': {
    label: 'Outline required',
    hint: 'Outline before drafting; on by default for writing.',
  },
  'scene.requireRevision': {
    label: 'Revision required',
    hint: 'At least one revision round; on by default for writing.',
  },
  'scene.requirePredict': {
    label: 'Prediction required',
    hint: 'State a prediction and its check before acting; on for research and engineering.',
  },
  'scene.requireCitation': {
    label: 'Citation required',
    hint: 'Conclusions must cite sources; on by default for research.',
  },
  'scene.allowBash': {
    label: 'Commands allowed',
    hint: 'Lets the scene run commands; only engineering enables it by default.',
  },
  'scene.sandboxOnly': {
    label: 'Workspace only',
    hint: 'Only workspace files may change; anything outside is refused.',
  },
  'scene.maxIteration': {
    label: 'Max iterations',
    hint: 'Loop rounds allowed for this scene.',
  },
  'scene.allowWeb': {
    label: 'Web access (all scenes)',
    hint: 'One switch for all six scenes; writes all six values.',
  },
  'scene.scoreThreshold': {
    label: 'Score threshold (all scenes)',
    hint: 'One threshold for all six scenes; the writing value is read by plan scoring.',
  },
}

const EN: Copy = {
  controls: recordOf(CONTROL_NAMES, (name) => ({
    label: EN_CONTROL_LABELS[name],
    hint: EN_CONTROL_HINTS[name],
  })),
  professions: recordOf(ProfessionValues, (value) => ({
    label: EN_PROFESSION_LABELS[value],
    hint: EN_PROFESSION_HINTS[value],
  })),
  interactions: recordOf(InteractionValues, (value) => ({
    label: EN_INTERACTION_LABELS[value],
    hint: EN_INTERACTION_HINTS[value],
  })),
  scenes: recordOf(SceneValues, (value) => ({
    label: EN_SCENE_LABELS[value],
    hint: EN_SCENE_HINTS[value],
  })),
  validations: recordOf(ValidationValues, (level) => ({
    label: EN_VALIDATION_LABELS[level],
    hint: EN_VALIDATION_HINTS[level],
    budget: VALIDATION_BUDGET[level],
    scope: EN_VALIDATION_SCOPE[level],
  })),
  permissions: recordOf(SandboxModeValues, (mode) => ({
    label: EN_PERMISSION_LABELS[mode],
    hint: EN_PERMISSION_HINTS[mode],
  })),
  composer: {
    currentLabel: 'Current',
    controlTitle: '{control} · {currentLabel}: {current}',
    controlAria: '{control}, {currentLabel}: {current}',
    lockedAria: '{control} · {currentLabel}: {current}. {explanation}',
    optionAria: '{label}. {hint}',
    lockedLine: 'Task started: profession locked. Finish it or start a new task to change it.',
    unlockedLine: 'You can choose now; it locks when the task starts.',
    frozenByPlan: 'A plan is running, so validation is frozen; it unfreezes when the plan ends or is rebuilt.',
    frozenByGoal: 'A goal is set, so interaction is frozen; it unfreezes when the goal is cleared or the turn ends.',
    frozenPlanRejected: 'A plan is running, so validation cannot change yet; finish or rebuild the plan.',
    frozenGoalRejected: 'A goal is set, so interaction cannot change yet; clear it or finish the turn.',
    offlineLine: 'Host unreachable; choices here are saved on this device only and do not affect the task.',
    localOnly: 'saved on this device only',
    permissionCatalogMissing: 'DSH exposes no permission presets; this is informational and cannot be switched.',
    permissionApplyFailed: 'DSH exposes no permission preset catalog, so the permission was not switched.',
    permissionOffline: 'Host unreachable; the permission cannot be switched.',
    permissionWriteNow: 'Switching applies the DSH permission to this session immediately.',
    permissionPresetDefault: 'The permission tier is defined by DSH permission presets.',
    customPreset: "A custom permission preset not in DSH's catalog; check the impact before switching.",
    followDsh: 'Follow DSH',
    followDshMode: 'Follow DSH (default: {mode})',
    permissionFollowHint: 'No permission preset is applied; the DSH default tier is in force.',
    loadingSelection: 'Loading the host selection…',
    approvalPolicy: 'Approval: {approval}',
    validationNote: 'All three levels search: low 1×3 this turn / medium 2×5 this session / high 4×8 all local content.',
    professionLocked: 'Profession is locked, so the change was not applied.',
    professionLockedRebuild: 'Profession is locked, so the change was not applied. Rebuild or abandon the task to choose again.',
    invalidSelection: 'That option is not valid; the previous choice was restored.',
    requestFailed: 'The host rejected the change; the previous choice was restored.',
    permissionConfirmTitle: 'Confirm full access',
    permissionConfirmBody: 'Full access can change any path, outside the workspace too; it applies as soon as you confirm.',
    permissionConfirmAccept: 'Switch to full access',
    permissionConfirmCancel: 'Cancel',
    escalationCurrent: 'Current profession: {profession}',
    escalationRequested: 'Requested profession: {profession}',
    escalationRebuild: 'Rebuild task',
    escalationAbandon: 'Abandon task',
    escalationUnsupported: 'The host does not support rebuild; upgrade the plugin.',
  },
  takeover: EN_TAKEOVER,
  settings: {
    title: 'Coordination',
    intro: 'Defaults for the next task; saved values apply on change, though a few caps wait for tool re-registration.',
    applyNote: 'Changes save immediately; a few caps take effect only after the tools re-register.',
    whyLock: 'One duty per task means one accountable owner: whoever does the work cannot sign it off, and whoever signs off cannot quietly change it. The lock lasts only for the task; a new task can choose another duty.',
    footer: 'Read-only rows come from host config; editable rows write back and try to persist. Tooltips and hints share one source.',
    groups: EN_GROUPS,
    fields: EN_FIELDS,
    catalog: { groups: EN_CATALOG_GROUPS, fields: EN_CATALOG_FIELDS, values: EN_CATALOG_VALUES },
    values: EN_VALUES,
    states: EN_STATES,
  },
  errors: {
    PROFESSION_LOCKED: 'The task has started, so the profession cannot change. Finish it, or rebuild/abandon it to choose again.',
    PROFESSION_REQUIRED: 'No profession yet; choose one before the task starts.',
    NOT_FOUND: 'That record was not found; it may have been deleted.',
    INVALID_STATE: 'The current state does not allow this.',
    INVALID_ARGUMENT: 'The submitted value is not valid; check it and try again.',
    ORCHESTRATION: 'The subtasks did not go through; check the split and the dependencies.',
    VERIFICATION: 'Independent verification failed, so the task cannot count as done.',
    TAKEOVER: 'Handling the takeover window failed; try again.',
    PERMISSION: 'Permission is insufficient, or this tier is unavailable.',
    DATABASE: 'Reading or writing the local records failed.',
    CONFIG: 'The plugin configuration has a problem; check its settings.',
    UPSTREAM: 'The model service returned an error; try again later.',
    NOT_IMPLEMENTED: 'This deployment does not provide that feature.',
  },
  tools: EN_TOOLS,
}

/** Every shipped language, keyed by its canonical tag. */
export const COPY_BY_LOCALE: Readonly<Record<Locale, Copy>> = {
  'zh-CN': ZH,
  'en-US': EN,
}

/** Copy for one locale; callers hold the module's frozen per-locale object. */
export function copyFor(locale: Locale): Copy {
  return COPY_BY_LOCALE[locale]
}

/** The default-language copy, used before a host locale has ever been read. */
export const DEFAULT_COPY: Copy = COPY_BY_LOCALE[DEFAULT_LOCALE]
