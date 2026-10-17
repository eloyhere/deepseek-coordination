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

/** The working scenario. */
export type Scene = 'dialogue' | 'office' | 'research' | 'engineering' | 'iterate'

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

export type SubTaskStatus = 'pending' | 'running' | 'submitted' | 'verified' | 'rejected' | 'partial'

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
  office: '办公',
  research: '研究',
  engineering: '工程',
  iterate: '迭代',
}

export const SceneHint: Readonly<Record<Scene, string>> = {
  dialogue: '快速自然交互：闲聊、简单问答。',
  office: '文件管理、任务自动化：整理文件、生成报告。',
  research: '多步检索、证据综合：文献综述、市场调研。',
  engineering: '代码生成、构建、调试：软件开发、重构。',
  iterate: 'generate → critique → revise：代码优化、文档打磨。',
}

export const ValidationLabel: Readonly<Record<Validation, string>> = {
  low: '低',
  medium: '中',
  high: '高',
}

export const ValidationHint: Readonly<Record<Validation, string>> = {
  low: '只执行选定交互：不做贝叶斯推断，不搜索资料，不读取跨会话历史。',
  medium: '对选定模式做贝叶斯推断：证据来自当前会话 + 联网搜索，不读取跨会话历史。',
  high: '对全部交互模式做完整贝叶斯推断：当前会话 + 联网搜索 + 跨会话历史，并做全局加权融合。',
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
export const SceneValues: readonly Scene[] = ['dialogue', 'office', 'research', 'engineering', 'iterate']
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
