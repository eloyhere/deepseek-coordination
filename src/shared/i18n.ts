/**
 * The plugin's single source of user-visible and model-facing copy (v23 §22).
 *
 * Authority for the active language is DSH's own `ctx.locale`; this module never
 * picks a language on its own. It publishes one `Copy` record per locale, so the
 * composer controls, the settings page, the typed errors and the `coordination_*`
 * tool descriptions all read the same strings instead of growing a second copy.
 *
 * Chinese is the reference language: every label and hint reuses the constants
 * in `./enum.ts`, which are the doc-mandated Chinese projection (§6.1-6.3,
 * §15.1, §15.2). English is a faithful per-key translation, never a placeholder.
 *
 * Data stays canonical: the database and the wire keep English identifiers
 * (`profession`, `scene`, …); only the presentation layer is translated.
 */
import {
  ControlHint,
  ControlLabel,
  InteractionHint,
  InteractionLabel,
  InteractionValues,
  PermissionHint,
  PermissionLabel,
  ProfessionHint,
  ProfessionLabel,
  ProfessionValues,
  SandboxModeValues,
  SceneHint,
  SceneLabel,
  SceneValues,
  ValidationHint,
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
 * unknown falls back to the Chinese default (v23 §22).
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
 * Copy of one validation level. `hint` is the doc-mandated range description,
 * `budget` the retrieval budget (`1×3` …), `scope` the evidence scope, and
 * `tooltip` the composed menu text the composer renders.
 */
export interface ValidationCopy extends LabelledCopy {
  readonly budget: string
  readonly scope: string
  readonly tooltip: string
}

/**
 * Composer runtime copy: tooltip skeleton, lock/offline/status lines, and the
 * permission-catalog rejections. Templates use `{name}` placeholders resolved by
 * {@link fillTemplate}.
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
  /** Locked profession line; `{profession}` is the locked label. */
  readonly lockedLine: string
  /** Unlocked explanation shown while the profession can still be chosen. */
  readonly unlockedLine: string
  /** Host-unreachable line; `{localOnly}` is the local-only clause. */
  readonly offlineLine: string
  /** The local-only clause ("selecting stores the choice locally"). */
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
  /** Always-visible reminder that every validation level searches (§6.3). */
  readonly validationNote: string
  /** Short locked rejection. */
  readonly professionLocked: string
  /** Locked rejection that names the rebuild/abandon escape hatch. */
  readonly professionLockedRebuild: string
  /** Invalid-patch rejection; `{message}`. */
  readonly invalidSelection: string
  /** Generic host rejection when no more specific copy applies. */
  readonly requestFailed: string
}

/** One labelled switch row on the settings page. */
export interface SettingsSwitchCopy {
  readonly label: string
  readonly hint: string
}

/** Copy of the `协调` settings page (v23 §15.2). */
export interface SettingsCopy {
  /** Section title / settings-menu label. */
  readonly title: string
  /** Permission takeover switch, its hint, and both status lines. */
  readonly takeover: SettingsSwitchCopy & { readonly onLine: string; readonly offLine: string }
  /** Workflow switch, its hint, and both status lines. */
  readonly workflow: SettingsSwitchCopy & { readonly onLine: string; readonly offLine: string }
  /** The forced `职能 Profession` group. */
  readonly professionGroup: {
    readonly title: string
    readonly lock: SettingsSwitchCopy
    readonly defaultProfession: SettingsSwitchCopy
    /** Read-only value of the default profession; `{profession}`. */
    readonly defaultProfessionValue: string
    readonly rebuildReselect: SettingsSwitchCopy
    readonly abandonReselect: SettingsSwitchCopy
    readonly audit: SettingsSwitchCopy
    readonly lockErrorHint: SettingsSwitchCopy
    /** Marks a disabled row as a display of a config default, not a hard rule. */
    readonly displayOnly: string
  }
  /** Footer crediting the doc and DSH's preset catalog. */
  readonly footer: string
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
  readonly settings: SettingsCopy
  readonly errors: Readonly<Record<CoordinationErrorCode, string>>
  readonly tools: Readonly<Record<ToolName, ToolCopy>>
}

/** The five composer dropdowns, in render order (v23 §15.1). */
const CONTROL_NAMES: readonly ControlName[] = [
  'profession',
  'interaction',
  'scene',
  'validation',
  'permission',
]

/** Canonical retrieval budget per validation level (v23 §6.3). */
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

function controlsOf(): Readonly<Record<ControlName, ControlCopy>> {
  return recordOf(CONTROL_NAMES, (name) => ({ label: ControlLabel[name], hint: ControlHint[name] }))
}

function professionsOf(): Readonly<Record<Profession, OptionCopy>> {
  return recordOf(ProfessionValues, (value) => ({ label: ProfessionLabel[value], hint: ProfessionHint[value] }))
}

function interactionsOf(): Readonly<Record<Interaction, OptionCopy>> {
  return recordOf(InteractionValues, (value) => ({ label: InteractionLabel[value], hint: InteractionHint[value] }))
}

function scenesOf(): Readonly<Record<Scene, OptionCopy>> {
  return recordOf(SceneValues, (value) => ({ label: SceneLabel[value], hint: SceneHint[value] }))
}

function permissionsOf(): Readonly<Record<SandboxMode, OptionCopy>> {
  return recordOf(SandboxModeValues, (value) => ({ label: PermissionLabel[value], hint: PermissionHint[value] }))
}

/* ------------------------------------------------------------------------- *
 * Chinese — the reference language, built from the enum constants
 * ------------------------------------------------------------------------- */

const ZH_VALIDATION_SCOPE: Readonly<Record<Validation, string>> = {
  low: '当轮对话',
  medium: '当前会话',
  high: '本地全部内容',
}

function zhValidations(): Readonly<Record<Validation, ValidationCopy>> {
  return recordOf(ValidationValues, (level) => ({
    label: ValidationLabel[level],
    hint: ValidationHint[level],
    budget: VALIDATION_BUDGET[level],
    scope: ZH_VALIDATION_SCOPE[level],
    // Matches the composer's earlier wording (the raw canonical level) and adds
    // the retrieval budget the doc table states for this level.
    tooltip: `档位 ${level} · ${VALIDATION_BUDGET[level]}：${ValidationHint[level]}`,
  }))
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

const ZH: Copy = {
  controls: controlsOf(),
  professions: professionsOf(),
  interactions: interactionsOf(),
  scenes: scenesOf(),
  validations: zhValidations(),
  permissions: permissionsOf(),
  composer: {
    currentLabel: '当前',
    controlTitle: '{control} · {currentLabel}：{current}',
    controlAria: '{control}，{currentLabel}：{current}',
    lockedAria: '{control} · {currentLabel}：{current}。{explanation}',
    optionAria: '{label}。{hint}',
    lockedLine: '本 Turn 的职能已锁定为「{profession}」。重建（rebuild）或丢弃（abandon）任务后才能重新选择。',
    unlockedLine: '选择后会在本 Turn 开始时锁定，Turn 结束前不可切换。',
    offlineLine: '未连接主机：{localOnly}。',
    localOnly: '选择仅保存在本地',
    permissionCatalogMissing: 'DSH 未提供权限预设目录，当前仅显示只读说明。',
    permissionApplyFailed: 'DSH 未提供权限预设目录，无法切换权限。',
    permissionOffline: '未连接主机，无法切换权限预设。',
    permissionWriteNow: '切换后会立即写入本会话的 DSH 权限预设。',
    permissionPresetDefault: '权限档位由 DSH 的权限预设定义。',
    customPreset: '当前会话的权限预设不在目录中（自定义预设）。',
    followDsh: '跟随 DSH',
    followDshMode: '跟随 DSH（默认：{mode}）',
    permissionFollowHint: '当前未应用任何 DSH 权限预设，跟随 DSH 的默认档位。',
    loadingSelection: '正在加载主机选择…',
    approvalPolicy: '审批策略：{approval}',
    validationNote: '三档都联网检索并做贝叶斯更新：low 1×3 当轮 / medium 2×5 当前会话 / high 4×8 本地全部内容。',
    professionLocked: '职能已锁定：本 Turn 内不能切换。',
    professionLockedRebuild: '职能已锁定：本 Turn 内不能切换。重建或丢弃任务后可重新选择。',
    invalidSelection: '选择无效：{message}',
    requestFailed: '主机拒绝了这次修改',
  },
  settings: {
    title: '协调',
    takeover: {
      label: '权限接管',
      hint: '已接管时隐藏 DSH 输入框的访问模式控件，改用协调面板的权限下拉；未接管时保留 DSH 自带控件。',
      onLine: '已接管：输入框中的权限下拉已被隐藏，替换为协调面板的权限下拉。',
      offLine: '未接管：输入框保留宿主自带的权限下拉。',
    },
    workflow: {
      label: '工作流',
      hint: '显示或隐藏输入框中的职能 / 交互 / 情景 / 验证四个下拉框；关闭后该位置不贡献任何控件。',
      onLine: '工作流开启：输入框显示职能 / 交互 / 情景 / 验证四个下拉框。',
      offLine: '工作流关闭：输入框隐藏职能 / 交互 / 情景 / 验证四个下拉框。',
    },
    professionGroup: {
      title: '职能 Profession',
      lock: {
        label: '职能锁定',
        hint: '强制开关：每个任务只能有一个职能，Turn 内不可切换。关闭它等于放弃问责链，因此不提供关闭入口。',
      },
      defaultProfession: {
        label: '默认职能',
        hint: '配置项 profession.default；本页不读取配置值，只标注跟随配置。agent 在任务开始时可以改选，但本 Turn 开始后即锁定。',
      },
      defaultProfessionValue: '{profession}（配置默认）',
      rebuildReselect: {
        label: '重建时可重选',
        hint: '重建任务（rebuild）结束旧任务并创建新任务，新任务可以重新选择职能。',
      },
      abandonReselect: {
        label: '丢弃时可重选',
        hint: '丢弃任务（abandon）不创建新任务；下一个任务可以重新选择职能。',
      },
      audit: {
        label: '职能审计',
        hint: '每次锁定、重建、丢弃写入 OrchestrationTrace，形成不可篡改的哈希链。',
      },
      lockErrorHint: {
        label: '锁定错误提示',
        hint: '拒绝修改已锁定职能时，错误会带上重建（rebuild）或丢弃（abandon）的提示。',
      },
      displayOnly: '默认开启，可在配置中关闭。',
    },
    footer: '下拉框的选项提示来自 v23 §15.1；权限预设目录由 DSH 提供，本插件只读展示并写回所选预设。',
  },
  errors: {
    PROFESSION_LOCKED: '职能已锁定：本 Turn 内不能切换。请重建（rebuild）或丢弃（abandon）任务后重试。',
    PROFESSION_REQUIRED: '尚未选择职能：请先选择职能再执行任务。',
    NOT_FOUND: '目标记录不存在或已被删除。',
    INVALID_STATE: '当前状态不允许该操作。',
    INVALID_ARGUMENT: '参数无效，请检查后重试。',
    ORCHESTRATION: '统筹编排失败，请检查子任务与依赖。',
    VERIFICATION: '独立验收未通过，任务不能标记为完成。',
    TAKEOVER: '接管处理失败。',
    PERMISSION: '权限不足或权限档位不可用。',
    DATABASE: '数据库操作失败。',
    CONFIG: '插件配置无效。',
    UPSTREAM: '上游模型或服务返回错误。',
    NOT_IMPLEMENTED: '当前组合未提供该功能。',
  },
  tools: ZH_TOOLS,
}

/* ------------------------------------------------------------------------- *
 * English — a faithful per-key translation
 * ------------------------------------------------------------------------- */

function enValidations(): Readonly<Record<Validation, ValidationCopy>> {
  const hint: Readonly<Record<Validation, string>> = {
    low: 'Light web search (1×3), updating priors/posteriors from the current turn only; no cross-session history.',
    medium: 'Web search (2×5), performing a full prior/posterior update over the whole current session; no cross-session history.',
    high: 'Web search (4×8) over the current session, all local session history, and workspace files, with a full prior/posterior update across all interactions and global weighted fusion.',
  }
  const scope: Readonly<Record<Validation, string>> = {
    low: 'current turn',
    medium: 'current session',
    high: 'local all content',
  }
  return recordOf(ValidationValues, (level) => ({
    label: level === 'low' ? 'Low' : level === 'medium' ? 'Medium' : 'High',
    hint: hint[level],
    budget: VALIDATION_BUDGET[level],
    scope: scope[level],
    tooltip: `Level ${level}: ${hint[level]}`,
  }))
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

const EN: Copy = {
  controls: {
    profession: {
      label: 'Profession',
      hint: 'The single accountable duty within a task. Once chosen it cannot be switched for this turn; only rebuilding or abandoning the task allows a new choice.',
    },
    interaction: {
      label: 'Interaction',
      hint: 'Determines how the agent responds: emotion / think / heuristic / converge / orchestrate.',
    },
    scene: {
      label: 'Scene',
      hint: 'Determines the working scene: dialogue / writing / office / research / engineering / iterate.',
    },
    validation: {
      label: 'Validation',
      hint: 'Determines the retrieval budget and evidence scope: low current turn / medium current session / high all local content. All three levels search the web and run Bayesian updates.',
    },
    permission: {
      label: 'Permission',
      hint: 'Determines this session\'s sandbox and approval tier: read-only / workspace-write / full access.',
    },
  },
  professions: {
    decision: {
      label: 'Decision',
      hint: 'Holds final approval or veto over whether to execute and whether the plan passes. Locked within a task; cannot be switched.',
    },
    outcome: {
      label: 'Outcome',
      hint: 'Bears final responsibility for the deliverable and for reaching the goal. Locked within a task; cannot be switched.',
    },
    resource: {
      label: 'Resource',
      hint: 'Responsible for the supply and cost of tokens, providers, cache, and search. Locked within a task; cannot be switched.',
    },
    personnel: {
      label: 'Personnel',
      hint: 'Responsible for allocating and governing sessions, threads, and agents. Locked within a task; cannot be switched.',
    },
    qualification: {
      label: 'Qualification',
      hint: 'Independently gates provider/model capability qualification. Locked within a task; cannot be switched.',
    },
    execution: {
      label: 'Execution',
      hint: 'Responsible for completing the work under the given conditions. Locked within a task; cannot be switched.',
    },
  },
  interactions: {
    emotion: {
      label: 'Emotion',
      hint: 'Empathy and listening: recognise feelings, calibrate empathy, and accompany the user.',
    },
    think: {
      label: 'Think',
      hint: 'Explicit reasoning chain: deep analysis and answers.',
    },
    heuristic: {
      label: 'Heuristic',
      hint: 'Bayesian inference + success-case retrieval: rank successful routes and pick the best direction.',
    },
    converge: {
      label: 'Converge',
      hint: 'Bayesian inference + failure-case retrieval: rank failure routes and define their boundaries and causes.',
    },
    orchestrate: {
      label: 'Orchestrate',
      hint: 'Task decomposition, dispatch, independent verification, and synthesis: a set of independently verified subtasks.',
    },
  },
  scenes: {
    dialogue: {
      label: 'Dialogue',
      hint: 'Fast, natural interaction; good for small talk and simple Q&A. Weakness: shallow.',
    },
    writing: {
      label: 'Writing',
      hint: 'Content creation and text refinement; good for articles, copy, reports, email, and technical docs. Strengths: structured output and multiple revision rounds. Weakness: needs back-and-forth, so it is not for instant Q&A.',
    },
    office: {
      label: 'Office',
      hint: 'File management and task automation; good for organising and generating. Weakness: sandbox-only.',
    },
    research: {
      label: 'Research',
      hint: 'Multi-step retrieval and evidence synthesis; good for literature reviews. Strength: citations. Weakness: slow.',
    },
    engineering: {
      label: 'Engineering',
      hint: 'Code generation and debugging; good for software development. Strength: bash is available. Weakness: needs a sandbox.',
    },
    iterate: {
      label: 'Iterate',
      hint: 'generate → critique → revise loop; good for polishing. Strength: high quality. Weakness: multiple calls.',
    },
  },
  validations: enValidations(),
  permissions: {
    'read-only': {
      label: 'Read-only',
      hint: 'Can only read the workspace; writes and changes are refused.',
    },
    'workspace-write': {
      label: 'Workspace write',
      hint: 'Can read and write files inside the workspace; writes outside it are refused.',
    },
    'danger-full-access': {
      label: 'Full access',
      hint: 'Not restricted to the workspace; can write any path. Highest risk.',
    },
  },
  composer: {
    currentLabel: 'Current',
    controlTitle: '{control} · {currentLabel}: {current}',
    controlAria: '{control}, {currentLabel}: {current}',
    lockedAria: '{control} · {currentLabel}: {current}. {explanation}',
    optionAria: '{label}. {hint}',
    lockedLine: 'This turn\'s profession is locked to "{profession}". Rebuild or abandon the task to choose again.',
    unlockedLine: 'The choice locks when this turn starts and cannot be switched until the turn ends.',
    offlineLine: 'Host unreachable: {localOnly}.',
    localOnly: 'choices are saved locally only',
    permissionCatalogMissing: 'DSH exposes no permission preset catalog; only read-only descriptions are shown.',
    permissionApplyFailed: 'DSH exposes no permission preset catalog; the permission cannot be switched.',
    permissionOffline: 'Host unreachable; the permission preset cannot be switched.',
    permissionWriteNow: 'Switching applies the DSH permission preset to this session immediately.',
    permissionPresetDefault: 'The permission tier is defined by DSH permission presets.',
    customPreset: 'The current session preset is not in the catalog (custom preset).',
    followDsh: 'Follow DSH',
    followDshMode: 'Follow DSH (default: {mode})',
    permissionFollowHint: 'No DSH permission preset is applied; the DSH default tier is in force.',
    loadingSelection: 'Loading the host selection…',
    approvalPolicy: 'Approval policy: {approval}',
    validationNote: 'All three levels search the web and run Bayesian updates: low 1×3 current turn / medium 2×5 current session / high 4×8 local all content.',
    professionLocked: 'Profession locked: it cannot be switched within this turn.',
    professionLockedRebuild: 'Profession locked: it cannot be switched within this turn. Rebuild or abandon the task to choose again.',
    invalidSelection: 'Invalid selection: {message}',
    requestFailed: 'The host rejected this change.',
  },
  settings: {
    title: 'Coordination',
    takeover: {
      label: 'Permission takeover',
      hint: 'When on, the DSH access-mode control in the composer is hidden and replaced by this panel\'s permission dropdown; when off, DSH\'s own control stays.',
      onLine: 'Taken over: the composer\'s access-mode control is hidden and replaced by this panel\'s permission dropdown.',
      offLine: 'Not taken over: the composer keeps DSH\'s own permission dropdown.',
    },
    workflow: {
      label: 'Workflow',
      hint: 'Shows or hides the profession / interaction / scene / validation dropdowns in the composer; off, the slot contributes nothing.',
      onLine: 'Workflow on: the composer shows the profession / interaction / scene / validation dropdowns.',
      offLine: 'Workflow off: the composer hides the profession / interaction / scene / validation dropdowns.',
    },
    professionGroup: {
      title: 'Profession',
      lock: {
        label: 'Profession lock',
        hint: 'Forced switch: a task has exactly one profession and it cannot be switched within a turn. Turning it off would break the accountability chain, so no off switch exists.',
      },
      defaultProfession: {
        label: 'Default profession',
        hint: 'Config key profession.default; this page does not read the configured value and only marks that it follows configuration. The agent may choose another profession when the task starts, but it locks once this turn starts.',
      },
      defaultProfessionValue: '{profession} (config default)',
      rebuildReselect: {
        label: 'Reselect on rebuild',
        hint: 'Rebuilding ends the old task and creates a new one; the new task can choose a new profession.',
      },
      abandonReselect: {
        label: 'Reselect on abandon',
        hint: 'Abandoning creates no new task; the next task can choose a new profession.',
      },
      audit: {
        label: 'Profession audit',
        hint: 'Every lock, rebuild, and abandon is written to OrchestrationTrace as a tamper-evident hash chain.',
      },
      lockErrorHint: {
        label: 'Lock error hint',
        hint: 'Rejecting a change to a locked profession carries the rebuild or abandon escape hatch in the error.',
      },
      displayOnly: 'On by default; it can be switched off in the configuration.',
    },
    footer: 'Option tooltips follow v23 §15.1; the permission preset catalog comes from DSH, and this plugin only displays it and writes back the chosen preset.',
  },
  errors: {
    PROFESSION_LOCKED: 'Profession locked: it cannot be switched within this turn. Rebuild or abandon the task and retry.',
    PROFESSION_REQUIRED: 'No profession selected: choose one before the task executes.',
    NOT_FOUND: 'The target record does not exist or has been deleted.',
    INVALID_STATE: 'The current state does not allow this operation.',
    INVALID_ARGUMENT: 'Invalid argument; check the input and retry.',
    ORCHESTRATION: 'Orchestration failed; check the subtasks and their dependencies.',
    VERIFICATION: 'Independent verification failed; the task cannot be marked complete.',
    TAKEOVER: 'Handling the takeover failed.',
    PERMISSION: 'Insufficient permission, or the permission tier is unavailable.',
    DATABASE: 'The database operation failed.',
    CONFIG: 'The plugin configuration is invalid.',
    UPSTREAM: 'The upstream model or service returned an error.',
    NOT_IMPLEMENTED: 'This feature is not available in this composition.',
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
