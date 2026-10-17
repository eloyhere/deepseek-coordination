/**
 * Enumerations shared by the Host and Client halves.
 *
 * Every union is a closed domain. The Chinese labels and tooltips live next to
 * the English identifiers so the composer controls and the settings page never
 * duplicate copy that the model-facing service also needs.
 */

/** A task's single accountable duty. Locked for the duration of one task. */
export type Profession =
  | 'decision'
  | 'outcome'
  | 'resource'
  | 'personnel'
  | 'qualification'
  | 'execution'

/** How the agent organises its response. */
export type Interaction = 'emotion' | 'think' | 'heuristic' | 'converge' | 'orchestrate'

/** The working scenario (v24: writing sits between dialogue and office). */
export type Scene = 'dialogue' | 'writing' | 'office' | 'research' | 'engineering' | 'iterate'

/** Evidence and inference depth. */
export type Validation = 'low' | 'medium' | 'high'

/** The input command face; `none` runs the complete coordination pipeline. */
export type CommandType = 'none' | 'goal' | 'plan' | 'feedback' | 'compact' | 'permission'

export type TurnStatus =
  | 'pending'
  | 'commanding'
  | 'comprehending'
  | 'organizing'
  | 'planning'
  | 'scoring'
  | 'rebuilding'
  | 'orchestrating'
  | 'acting'
  | 'answering'
  | 'learning'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'abandoned'

export type SubTaskStatus =
  | 'pending'
  | 'running'
  | 'submitted'
  | 'verified'
  | 'rejected'
  | 'partial'
  | 'abandoned'

export type Verdict = 'pass' | 'fail' | 'partial' | 'unverifiable'

export type RecoverySuggestion = 'retry' | 'revise_criteria' | 'accept_partial' | 'escalate'

export type PlanStatus = 'draft' | 'scored' | 'active' | 'done' | 'failed' | 'abandoned' | 'rebuilt'

export type PlanMode = 'auto' | 'command'

export type StageName = 'emotion' | 'think' | 'heuristic' | 'converge'

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export type ProfessionStatus = 'pending' | 'running' | 'done' | 'failed' | 'abandoned'

export type TraceEvent =
  | 'lock'
  | 'rebuild'
  | 'abandon'
  | 'dispatch'
  | 'submit'
  | 'verify'
  | 'recover'
  | 'synthesize'

export type ScoreCategory =
  | 'prompt'
  | 'command'
  | 'goal'
  | 'compact'
  | 'comprehension'
  | 'organization'
  | 'turn'
  | 'plan'
  | 'predict'
  | 'reality'
  | 'action'
  | 'answer'
  | 'question'
  | 'choice'
  | 'error'
  | 'route'
  | 'failure'
  | 'subtask'

export type TakeoverType =
  | 'approval'
  | 'permission'
  | 'errorescalation'
  | 'profession'
  | 'planreview'
  | 'question'

export type TakeoverStatus = 'pending' | 'resolved' | 'cancelled'

export type ResourceKind = 'file' | 'image' | 'text' | 'binary'

/* ------------------------------------------------------------------------- *
 * v24 structural / domain vocabulary
 *
 * Closed unions taken from `docs/domain-model-v24.md` §2. They are the only
 * concept vocabulary the text parsers emit; unknown values are never guessed.
 * ------------------------------------------------------------------------- */

/**
 * Kinds of explicit structural/domain concept the text parsers can prove from a
 * source marker (front matter, heading outline, Pandoc fenced div, HTML
 * `<article>/<main>/<section>`, LaTeX sectioning, contract tag).
 *
 * A parser emits one of these as `NodeMetadata.domain.kind`; `Book`/`Article`
 * and the standalone concepts (`part`, `person`, `venue`, `condition`,
 * `paragraph`) are also emitted as their own node kinds by the parser.
 */
export type StructuralKind =
  | 'book'
  | 'part'
  | 'chapter'
  | 'article'
  | 'section'
  | 'paragraph'
  | 'condition'
  | 'person'
  | 'venue'

/** The ten formal statement kinds; `proof` is evidence, not a claim. */
export type StatementKind =
  | 'definition'
  | 'lemma'
  | 'proof'
  | 'property'
  | 'axiom'
  | 'theorem'
  | 'corollary'
  | 'claim'
  | 'example'
  | 'remark'

/** Form of a chapter-like unit (§2.1 `Chapter.form`). */
export type ChapterForm = 'chapter' | 'preface' | 'appendix' | 'index' | 'frontmatter'

/** Logical form of a condition, mapped only from an explicit marker. */
export type ConditionForm =
  | 'precondition'
  | 'postcondition'
  | 'invariant'
  | 'guard'
  | 'assumption'
  | 'hypothesis'
  | 'constraint'
  | 'goal'
  | 'unknown'

/** Evaluable condition state. Only explicit evidence may set satisfied/violated. */
export type ConditionStatus = 'satisfied' | 'violated' | 'unknown' | 'unverifiable'

/** Statement status, derived only from explicit proof/label links. */
export type StatementStatus = 'stated' | 'proved' | 'unproved' | 'disproved' | 'axiomatic' | 'unverifiable'

/** Proof completeness, derived only from an explicit closed/unterminated proof environment. */
export type ProofStatus = 'complete' | 'incomplete' | 'admitted' | 'sorry' | 'unverifiable'

/** Publication venue form; `unknown` when the source only names a venue string. */
export type VenueForm = 'journal' | 'proceedings' | 'conference' | 'preprint' | 'unknown'

/** Any explicit structural form a concept may carry. */
export type StructuralForm = ChapterForm | ConditionForm | VenueForm | 'sectioning' | 'unknown'

/** Status field of a structural concept: condition state or statement state. */
export type StructuralStatus = ConditionStatus | StatementStatus

/** The two condition relation primitives. `requires` is necessary, `meets` sufficient. */
export type StructuralRelation = 'requires' | 'meets'

/** Authority role of a `Person` node. */
export type StructuralRole = 'author' | 'editor'

/** Office sheet/cell concept kinds (CSV/TSV surface; xlsx stays deferred). */
export type OfficeKind = 'sheet' | 'cell' | 'range'

/** Cell value type from the raw text; never an evaluated result. */
export type CellValueType = 'text' | 'number' | 'boolean' | 'error' | 'date' | 'empty' | 'unknown'

/** Every structural concept kind. */
export const StructuralKindValues: readonly StructuralKind[] = [
  'book',
  'part',
  'chapter',
  'article',
  'section',
  'paragraph',
  'condition',
  'person',
  'venue',
]

/** Every formal statement kind. */
export const StatementKindValues: readonly StatementKind[] = [
  'definition',
  'lemma',
  'proof',
  'property',
  'axiom',
  'theorem',
  'corollary',
  'claim',
  'example',
  'remark',
]

/** True when `value` is a formal statement kind. */
export function isStatementKind(value: unknown): value is StatementKind {
  return isOneOf(value, StatementKindValues)
}

/** True when `value` is a structural concept kind. */
export function isStructuralKind(value: unknown): value is StructuralKind {
  return isOneOf(value, StructuralKindValues)
}

export type InteractionStageMode = 'full' | 'light' | 'skip'

/** Labels used by the composer controls and settings page. */
export const ProfessionLabel: Readonly<Record<Profession, string>> = {
  decision: '决策',
  outcome: '成果',
  resource: '资源',
  personnel: '人员',
  qualification: '任职',
  execution: '执行',
}

/** The tooltip copy mandated by the design document (§15.1). */
export const ProfessionHint: Readonly<Record<Profession, string>> = {
  decision: '对是否执行、Plan 是否通过拥有最终批准权或否决权。任务内锁定，不可切换。',
  outcome: '对最终交付物和 goal 达成负最终责任。任务内锁定，不可切换。',
  resource: '对 Token、Provider、缓存、搜索的供给与成本负责。任务内锁定，不可切换。',
  personnel: '对 Session、Thread、Agent 的分配与合规负责。任务内锁定，不可切换。',
  qualification: '对 Provider/Model 的能力资格进行独立把关。任务内锁定，不可切换。',
  execution: '对在既定条件下完成作业负责。任务内锁定，不可切换。',
}

export const InteractionLabel: Readonly<Record<Interaction, string>> = {
  emotion: '感情',
  think: '思维',
  heuristic: '启发',
  converge: '收束',
  orchestrate: '统筹',
}

export const InteractionHint: Readonly<Record<Interaction, string>> = {
  emotion: '共情与倾听：识别情绪、校准共情、承接并陪伴。',
  think: '显式推理链：给出深度分析与答案。',
  heuristic: '贝叶斯推断 + 成功案例检索：排序成功路线并选择最佳方向。',
  converge: '贝叶斯推断 + 失败案例检索：排序失败路线、界定边界与缘由。',
  orchestrate: '任务分解、派发、独立验收与综合：产出经独立验收的子任务集合。',
}

export const SceneLabel: Readonly<Record<Scene, string>> = {
  dialogue: '对话',
  writing: '写作',
  office: '办公',
  research: '研究',
  engineering: '工程',
  iterate: '迭代',
}

/** Tooltip copy mandated by the v24 §15.1 scene table. */
export const SceneHint: Readonly<Record<Scene, string>> = {
  dialogue: '快速自然交互，适合闲聊和简单问答。缺点：不深入。',
  writing: '内容创作与文本打磨，适合文章、文案、报告、邮件、技术文档。优点：结构化产出、多轮打磨。缺点：需要多轮交互，不适合即时问答。',
  office: '文件管理和任务自动化，适合整理、生成。缺点：限于沙箱内。',
  research: '多步检索和证据综合，适合文献综述。优点：带引用。缺点：耗时。',
  engineering: '代码生成和调试，适合软件开发。优点：支持 bash。缺点：需要沙箱。',
  iterate: 'generate → critique → revise 闭环，适合打磨。优点：质量高。缺点：多轮调用。',
}

/**
 * Per-scene execution policy (v24 §19). One table shared by the config
 * defaults, the plan pipeline, and the UI copy, so a scene is never described
 * in one place and enforced in another.
 */
export interface SceneProfile {
  thinking: 'enabled' | 'disabled'
  reasoningEffort: string
  requirePlan: boolean
  requireScore: boolean
  requireOutline: boolean
  requireRevision: boolean
  requirePredict: boolean
  requireCitation: boolean
  allowBash: boolean
  allowWeb: boolean
  sandboxOnly: boolean
  maxIteration: number
  scoreThreshold: number
}

export const SceneProfiles: Readonly<Record<Scene, SceneProfile>> = {
  dialogue: {
    thinking: 'disabled',
    reasoningEffort: 'medium',
    requirePlan: false,
    requireScore: false,
    requireOutline: false,
    requireRevision: false,
    requirePredict: false,
    requireCitation: false,
    allowBash: false,
    allowWeb: true,
    sandboxOnly: false,
    maxIteration: 1,
    scoreThreshold: 0.6,
  },
  writing: {
    thinking: 'enabled',
    reasoningEffort: 'high',
    requirePlan: true,
    requireScore: true,
    requireOutline: true,
    requireRevision: true,
    requirePredict: false,
    requireCitation: false,
    allowBash: false,
    allowWeb: true,
    sandboxOnly: false,
    maxIteration: 3,
    scoreThreshold: 0.6,
  },
  office: {
    thinking: 'disabled',
    reasoningEffort: 'medium',
    requirePlan: true,
    requireScore: false,
    requireOutline: false,
    requireRevision: false,
    requirePredict: false,
    requireCitation: false,
    allowBash: false,
    allowWeb: true,
    sandboxOnly: true,
    maxIteration: 1,
    scoreThreshold: 0.6,
  },
  research: {
    thinking: 'enabled',
    reasoningEffort: 'high',
    requirePlan: true,
    requireScore: false,
    requireOutline: false,
    requireRevision: false,
    requirePredict: true,
    requireCitation: true,
    allowBash: false,
    allowWeb: true,
    sandboxOnly: false,
    maxIteration: 3,
    scoreThreshold: 0.6,
  },
  engineering: {
    thinking: 'enabled',
    reasoningEffort: 'high',
    requirePlan: true,
    requireScore: false,
    requireOutline: false,
    requireRevision: false,
    requirePredict: true,
    requireCitation: false,
    allowBash: true,
    allowWeb: true,
    sandboxOnly: true,
    maxIteration: 3,
    scoreThreshold: 0.6,
  },
  iterate: {
    thinking: 'enabled',
    reasoningEffort: 'high',
    requirePlan: false,
    requireScore: true,
    requireOutline: false,
    requireRevision: false,
    requirePredict: false,
    requireCitation: false,
    allowBash: false,
    allowWeb: true,
    sandboxOnly: false,
    maxIteration: 3,
    scoreThreshold: 0.6,
  },
}

export const ValidationLabel: Readonly<Record<Validation, string>> = {
  low: '低',
  medium: '中',
  high: '高',
}

export const ValidationHint: Readonly<Record<Validation, string>> = {
  low: '少量联网检索（1 次 × 3 条），只结合当轮对话做轻量先验/后验更新；不读取跨会话历史。',
  medium: '联网检索（2 次 × 5 条），结合当前会话全部内容做完整先验/后验更新；不读取跨会话历史。',
  high: '联网检索（4 次 × 8 条），结合当前会话 + 本地全部会话历史 + 工作区文件，对所有交互做完整先验/后验更新与全局加权融合。',
}

/** The retrieval budget and evidence scope the Bayesian/comprehension policy uses. */
export interface ValidationBudget {
  query: number
  result: number
  scope: 'turn' | 'session' | 'local'
  interaction: 'selected' | 'all'
}

export const ValidationBudgetByLevel: Readonly<Record<Validation, ValidationBudget>> = {
  low: { query: 1, result: 3, scope: 'turn', interaction: 'selected' },
  medium: { query: 2, result: 5, scope: 'session', interaction: 'selected' },
  high: { query: 4, result: 8, scope: 'local', interaction: 'all' },
}

/**
 * The composer's five dropdown controls (v23 §15.1). The command face is a
 * message prefix rather than a control, so it is documented here but not shown
 * as a sixth dropdown.
 */
export type ControlName = 'profession' | 'interaction' | 'scene' | 'validation' | 'permission'

export const ControlLabel: Readonly<Record<ControlName, string>> = {
  profession: '职能',
  interaction: '交互',
  scene: '情景',
  validation: '验证',
  permission: '权限',
}

/** Tooltip of the control itself, shown on hover before the menu opens. */
export const ControlHint: Readonly<Record<ControlName, string>> = {
  profession: '任务内唯一且锁定的问责维度。选择后本 Turn 不可切换，只能重建或丢弃任务。',
  interaction: '决定 Agent 如何回应：感情 / 思维 / 启发 / 收束 / 统筹。',
  scene: '决定工作情景：对话 / 写作 / 办公 / 研究 / 工程 / 迭代。',
  validation: '决定检索预算与证据范围：low 当轮 / medium 当前会话 / high 本地全部内容。三档都联网并做贝叶斯更新。',
  permission: '决定本会话的沙箱与审批档位：仅可查看 / 工作区内修改 / 完全权限。',
}

/** The three DSH sandbox modes the permission dropdown mirrors. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export const SandboxModeValues: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/** Wording aligned with DSH's own access-mode menu (v22 §15, kept by v23 §16). */
export const PermissionLabel: Readonly<Record<SandboxMode, string>> = {
  'read-only': '仅可查看',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全权限',
}

export const PermissionHint: Readonly<Record<SandboxMode, string>> = {
  'read-only': '只能读取工作区，不能写入或执行改动。',
  'workspace-write': '可以在工作区内读写文件，越出工作区的写入会被拒绝。',
  'danger-full-access': '不受工作区限制，可写入任意路径；风险最高。',
}

/** Reverse lookup for persisted Chinese labels and legacy settings. */
export function toSandboxMode(value: unknown): SandboxMode {
  if (isOneOf(value, SandboxModeValues)) return value
  if (value === PermissionLabel['read-only']) return 'read-only'
  if (value === PermissionLabel['workspace-write']) return 'workspace-write'
  if (value === PermissionLabel['danger-full-access']) return 'danger-full-access'
  return 'workspace-write'
}

export const CommandLabel: Readonly<Record<CommandType, string>> = {
  none: '无',
  goal: '目标',
  plan: '计划',
  feedback: '反馈',
  compact: '压缩',
  permission: '权限',
}

export const CommandHint: Readonly<Record<CommandType, string>> = {
  none: '走完整流程：理解 → 组织 → Plan → 评分 → 执行。',
  goal: '设定或查看当前 Turn 的目标，跳过理解与组织。',
  plan: '查看或修改当前 Turn 的计划，跳过理解与组织。',
  feedback: '对当前 Turn 或 Plan 给出反馈，跳过理解与组织。',
  compact: '压缩当前会话上下文，跳过理解、组织与 Plan。',
  permission: '查看或修改当前会话权限，跳过整个 Turn 流程。',
}

export const TurnStatusLabel: Readonly<Record<TurnStatus, string>> = {
  pending: '待开始',
  commanding: '命令中',
  comprehending: '理解中',
  organizing: '组织中',
  planning: '计划中',
  scoring: '评分中',
  rebuilding: '重建中',
  orchestrating: '统筹中',
  acting: '执行中',
  answering: '作答中',
  learning: '学习中',
  done: '完成',
  failed: '失败',
  cancelled: '取消',
  abandoned: '丢弃',
}

export const InteractionValues: readonly Interaction[] = ['emotion', 'think', 'heuristic', 'converge', 'orchestrate']
export const SceneValues: readonly Scene[] = ['dialogue', 'writing', 'office', 'research', 'engineering', 'iterate']
export const ValidationValues: readonly Validation[] = ['low', 'medium', 'high']
export const ProfessionValues: readonly Profession[] = [
  'decision',
  'outcome',
  'resource',
  'personnel',
  'qualification',
  'execution',
]
export const CommandValues: readonly CommandType[] = ['none', 'goal', 'plan', 'feedback', 'compact', 'permission']

/** Whether an interaction/scene pair is recommended by the §6.5 matrix. */
export type MatrixMark = 'yes' | 'limited' | 'no'

export const InteractionSceneMatrix: Readonly<Record<Scene, Readonly<Record<Interaction, MatrixMark>>>> = {
  dialogue: { emotion: 'yes', think: 'yes', heuristic: 'yes', converge: 'yes', orchestrate: 'limited' },
  writing: { emotion: 'limited', think: 'yes', heuristic: 'yes', converge: 'yes', orchestrate: 'yes' },
  office: { emotion: 'limited', think: 'yes', heuristic: 'yes', converge: 'yes', orchestrate: 'yes' },
  research: { emotion: 'no', think: 'yes', heuristic: 'yes', converge: 'yes', orchestrate: 'yes' },
  engineering: { emotion: 'no', think: 'yes', heuristic: 'limited', converge: 'yes', orchestrate: 'yes' },
  iterate: { emotion: 'no', think: 'yes', heuristic: 'yes', converge: 'yes', orchestrate: 'yes' },
}

/** The four comprehension stages, in their fixed order. */
export const ComprehensionStageOrder: readonly StageName[] = ['emotion', 'think', 'heuristic', 'converge']

/** Normalise an unknown string to a known profession, falling back to execution. */
export function toProfession(value: unknown): Profession {
  return isOneOf(value, ProfessionValues) ? value : 'execution'
}

export function toInteraction(value: unknown): Interaction {
  return isOneOf(value, InteractionValues) ? value : 'think'
}

export function toScene(value: unknown): Scene {
  return isOneOf(value, SceneValues) ? value : 'dialogue'
}

export function toValidation(value: unknown): Validation {
  return isOneOf(value, ValidationValues) ? value : 'medium'
}

export function toCommandType(value: unknown): CommandType {
  return isOneOf(value, CommandValues) ? value : 'none'
}

/** True when `value` is a member of the readonly union array. */
export function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}
