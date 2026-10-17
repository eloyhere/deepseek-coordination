/**
 * The four-stage comprehension of one prompt (v23 §9.5, §11.9, §11.10).
 *
 * Stage order is exactly `ComprehensionStageOrder`:
 *
 *   emotion -> think -> heuristic -> converge
 *
 * `emotion` and `think` always run. `heuristic` and `converge` are Bayesian
 * stages: they are skipped for `validation === 'low'` (v23 §6.3, §9.5) but a
 * row is still written for ordinal 3 and 4 with status `skipped`, so the
 * ordinal contract never depends on the validation level.
 *
 * Everything here is deterministic local analysis. There is no LLM call and no
 * DSH import. The only async work is optional evidence search through the
 * read-only `WebSearchPort`, and a failed or slow search never fails the
 * comprehension: the stage still commits as `done` with no search evidence.
 *
 * Persistence rules:
 *
 *  - One transaction per stage covers the `comprehension_stage` insert and the
 *    `comprehension` fields that stage produced, so a crash cannot leave a
 *    stage row without the fields it owns.
 *  - `comprehension_stage` is append-only. Re-running a stage inserts a *new*
 *    row with the same ordinal and a new handle; no existing stage row is ever
 *    updated or deleted. `stages()` reads the latest row per ordinal (the four
 *    stage view), `stageHistory()` reads every row (the audit view).
 *  - `comprehension.emotion` stores the numeric intensity, not an `emotion`
 *    table identity: this module never depends on the companion module.
 *  - `stageCount` counts the distinct ordinals that produced a `done` row, so a
 *    low-validation comprehension stores 2 while still writing four rows.
 *  - `confidence` aggregates the deterministic analytical stages (think,
 *    heuristic, converge) and falls back to the think stage for `low`.
 *  - `entropy` is the normalised Shannon entropy of the last Bayesian stage
 *    (converge when it ran, otherwise heuristic); `route` and `failure` hold the
 *    ranked `RouteCandidate[]` arrays, `evidence` the labelled evidence list.
 */
import type { ModuleHost } from './module.js'
import { clamp, round } from './module.js'
import type { Comprehension, ComprehensionStageRecord } from '../shared/entity.js'
import type { Interaction, Scene, StageName, StageStatus, Validation } from '../shared/enum.js'
import {
  ComprehensionStageOrder,
  InteractionValues,
  isOneOf,
  toInteraction,
  toScene,
  toValidation,
} from '../shared/enum.js'
import type {
  ComprehensionContext,
  ConvergeStageOutput,
  EmotionStageOutput,
  HeuristicStageOutput,
  RouteCandidate,
  ThinkStageOutput,
} from '../shared/service.js'
import { InvalidArgumentError, InvalidStateError } from '../shared/error.js'
import { parseJson } from './database.js'
import { mapComprehension, mapStage, mapTurn, text } from './row.js'
import type { Row } from './row.js'

/* ------------------------------------------------------------------------- *
 * Public input
 * ------------------------------------------------------------------------- */

export interface ComprehendInput {
  turn: number
  promptIdentity: number
  prompt: string
  interaction: Interaction
  scene: Scene
  validation: Validation
  context?: ComprehensionContext
  model?: string
}

/* ------------------------------------------------------------------------- *
 * Internal types
 * ------------------------------------------------------------------------- */

/**
 * `ComprehensionContext` plus the interaction dimension. The published stage
 * methods accept `ComprehensionContext`; `comprehend` widens it so the
 * heuristic stage can honour the selected interaction without a second port.
 */
interface StageContext extends ComprehensionContext {
  interaction?: Interaction
}

type EmotionLabel = 'positive' | 'negative' | 'worry' | 'anger' | 'sadness' | 'urgency' | 'crisis' | 'neutral'

interface RouteDefinition {
  name: string
  description: string
  markers: readonly string[]
  scenes: readonly Scene[]
  interactions: readonly Interaction[]
}

interface FailureDefinition {
  name: string
  description: string
  markers: readonly string[]
  /** Success routes whose dominance makes this failure more likely. */
  successRoutes: readonly string[]
}

interface StageWrite {
  comprehension: number
  stage: StageName
  status: StageStatus
  input: unknown
  output?: unknown
  confidence?: number
  entropyBefore?: number
  entropyAfter?: number
  patch?: Record<string, unknown>
  aggregate?: boolean
}

interface StageOutcome<T> {
  output: T
  record: ComprehensionStageRecord
}

interface StageChain {
  emotion?: EmotionStageOutput
  think?: ThinkStageOutput
  heuristic?: HeuristicStageOutput
  converge?: ConvergeStageOutput
}

/* ------------------------------------------------------------------------- *
 * Deterministic lexicons (v23 §6.1, §9.5)
 * ------------------------------------------------------------------------- */

const PositiveMarker: readonly string[] = [
  '谢谢',
  '感谢',
  '太好了',
  '开心',
  '高兴',
  '满意',
  '喜欢',
  '期待',
  '太棒',
  '不错',
  '顺利',
  'thanks',
  'thank you',
  'great',
  'love',
  'happy',
  'excellent',
  'awesome',
  'perfect',
  'glad',
  'nice',
]

const NegativeMarker: readonly string[] = [
  '难过',
  '伤心',
  '失望',
  '糟糕',
  '郁闷',
  '委屈',
  '难受',
  '不舒服',
  'sad',
  'upset',
  'disappointed',
  'unhappy',
  'miserable',
  'frustrated',
  'annoying',
]

const WorryMarker: readonly string[] = [
  '担心',
  '焦虑',
  '紧张',
  '不安',
  '害怕',
  '压力',
  '万一',
  '怎么办',
  '睡不着',
  'worried',
  'worry',
  'anxious',
  'nervous',
  'afraid',
  'scared',
  'stress',
  'overwhelmed',
  'panic',
]

const AngerMarker: readonly string[] = [
  '生气',
  '愤怒',
  '讨厌',
  '烦死',
  '火大',
  '气死',
  '恼火',
  '凭什么',
  'angry',
  'furious',
  'annoyed',
  'irritated',
  'hate',
  'mad at',
]

const SadnessMarker: readonly string[] = [
  '想哭',
  '哭',
  '孤独',
  '失落',
  '心碎',
  '绝望',
  '没意思',
  'cry',
  'crying',
  'lonely',
  'depressed',
  'heartbroken',
  'hopeless',
  'grief',
]

const UrgencyMarker: readonly string[] = [
  '紧急',
  '马上',
  '立刻',
  '尽快',
  '来不及',
  '着急',
  '火速',
  'deadline',
  'urgent',
  'asap',
  'immediately',
  'right now',
  'hurry',
]

/** Self-harm and harm-to-others signals; any hit raises a crisis string. */
const CrisisMarker: readonly string[] = [
  '自杀',
  '自残',
  '不想活',
  '活着没意思',
  '想死',
  '结束生命',
  '伤害自己',
  '轻生',
  '活不下去',
  '不想活了',
  'suicide',
  'kill myself',
  'self-harm',
  'self harm',
  'hurt myself',
  'end my life',
  'want to die',
  'no reason to live',
  '杀了他',
  '杀了她',
  '杀掉',
  '弄死',
  '同归于尽',
  'kill him',
  'kill her',
  'kill them',
  'harm someone',
  'hurt someone',
]

const EmpathyCopy: Readonly<Record<EmotionLabel, string>> = {
  positive: '听得出来你心情不错，我愿意听你多说说这份开心。',
  negative: '这件事确实让你不太舒服，你的感受很重要，我们先把最卡的地方找出来。',
  worry: '听得出来你在担心这件事，我们先把最让你不安的那一点说清楚。',
  anger: '这件事确实让人生气，你的感受有道理，我们先把它拆开看清楚。',
  sadness: '这份难过值得被好好接住，不用急着振作，我会陪着你。',
  urgency: '时间看起来确实紧，我先帮你抓住最关键的一步，其余按优先级排开。',
  crisis: '我很在意你现在的安全。请先联系身边可信任的人或当地紧急援助，我会一直在这里陪你把下一步说清楚。',
  neutral: '我在听，你可以慢慢说，我们把重点一起理清。',
}

/* ------------------------------------------------------------------------- *
 * Sentence and marker helpers
 * ------------------------------------------------------------------------- */

/** Collapse whitespace and cap the length without splitting a surrogate pair. */
function collapse(content: string, limit = 200): string {
  const compact = content.replace(/\s+/g, ' ').trim()
  if (compact.length <= limit) return compact
  return `${compact.slice(0, Math.max(1, limit - 1))}…`
}

/** Trim leading and trailing separators so a clause reads as a standalone unit. */
function trimPunctuation(content: string): string {
  return content
    .replace(/^[\s,，。.;；:：、!?！？"'“”‘’]+/, '')
    .replace(/[\s,，。.;；:：、]+$/, '')
    .trim()
}

function escapeRegExp(content: string): string {
  return content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * ASCII markers are matched on word boundaries so `it` cannot match inside
 * `with`; CJK markers are matched literally because there is no word boundary.
 */
function markerPattern(marker: string, flags: string): RegExp {
  const escaped = escapeRegExp(marker)
  const ascii = /^[\x20-\x7e]+$/.test(marker)
  return ascii
    ? new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, flags)
    : new RegExp(escaped, flags)
}

function markerHits(content: string, marker: string): number {
  if (marker.length === 0) return 0
  return content.match(markerPattern(marker, 'gi'))?.length ?? 0
}

function hitsOf(content: string, markers: readonly string[]): number {
  let total = 0
  for (const marker of markers) total += markerHits(content, marker)
  return total
}

function hasMarker(content: string, markers: readonly string[]): boolean {
  return markers.some((marker) => markerHits(content, marker) > 0)
}

function matchedMarkers(content: string, markers: readonly string[]): string[] {
  const found: string[] = []
  for (const marker of markers) {
    if (markerHits(content, marker) > 0) found.push(marker)
  }
  return found
}

function unique(values: readonly string[]): string[] {
  const result: string[] = []
  for (const value of values) {
    if (value.length > 0 && !result.includes(value)) result.push(value)
  }
  return result
}

/** Split a prompt into sentences on CJK sentence stops, newlines and `. ` */
function sentencesOf(content: string): string[] {
  const normalised = content.replace(/\r\n?/g, '\n')
  return normalised
    .split(/[。！？!?；;\n]+|\.(?=\s|$)/)
    .map((part) => collapse(part, 240))
    .filter((part) => part.length > 0 && /[A-Za-z0-9\u4e00-\u9fff]/.test(part))
}

function intentOf(content: string): string {
  const first = sentencesOf(content)[0]
  if (first !== undefined) {
    const trimmed = trimPunctuation(first)
    if (trimmed.length > 0) return trimmed
  }
  const fallback = trimPunctuation(collapse(content, 140))
  return fallback.length > 0 ? fallback : '未提供可识别的意图'
}

/* ------------------------------------------------------------------------- *
 * Heuristic route catalogue (success directions, v23 §6.1 启发)
 * ------------------------------------------------------------------------- */

const RouteCatalogue: readonly RouteDefinition[] = [
  {
    name: 'answer',
    description: '直接给出解释或答案，适用于信息性问题',
    markers: ['是什么', '为什么', '怎么', '如何', '解释', '说明', '区别', '意思', 'what', 'why', 'how', 'explain', 'meaning', 'difference'],
    scenes: ['dialogue', 'research', 'office'],
    interactions: ['think'],
  },
  {
    name: 'clarify',
    description: '先澄清目标、范围与验收标准，再决定动作',
    markers: ['确认', '到底', '究竟', '不清楚', '不确定', '再改', '优化一下', '看看', '随便', 'unclear', 'confirm', 'not sure', 'maybe'],
    scenes: ['dialogue', 'office', 'iterate'],
    interactions: ['emotion', 'converge', 'think'],
  },
  {
    name: 'implement',
    description: '直接实现或修改代码与文件，交付可运行结果',
    markers: ['写', '实现', '新增', '添加', '修改', '重构', '修复', '代码', '函数', '接口', '部署', '脚本', 'code', 'implement', 'add', 'create', 'refactor', 'fix', 'debug', 'build', 'deploy'],
    scenes: ['engineering', 'office', 'iterate'],
    interactions: ['think', 'orchestrate'],
  },
  {
    name: 'verify',
    description: '先测试、检查或审查，确认事实再推进',
    markers: ['检查', '测试', '验证', '审查', '复核', '跑一遍', '确认无误', 'review', 'test', 'verify', 'check', 'audit', 'validate'],
    scenes: ['engineering', 'research', 'iterate'],
    interactions: ['converge', 'think'],
  },
  {
    name: 'research',
    description: '检索资料并综合证据，再给出结论',
    markers: ['查', '搜索', '调研', '资料', '文献', '对比', '案例', '来源', 'search', 'research', 'find', 'compare', 'survey', 'evidence', 'paper'],
    scenes: ['research', 'office'],
    interactions: ['heuristic', 'think'],
  },
  {
    name: 'plan',
    description: '先规划步骤、依赖与边界，再逐项执行',
    markers: ['计划', '规划', '方案', '步骤', '拆分', '里程碑', '流程', 'plan', 'design', 'strategy', 'roadmap', 'steps', 'decompose'],
    scenes: ['office', 'engineering', 'research'],
    interactions: ['orchestrate', 'think'],
  },
  {
    name: 'iterate',
    description: '在现有结果上迭代打磨，小步改进并复验',
    markers: ['优化', '改进', '打磨', '迭代', '更好', '提升', '完善', 'improve', 'optimize', 'polish', 'iterate', 'refine', 'better'],
    scenes: ['iterate', 'engineering'],
    interactions: ['think', 'orchestrate'],
  },
  {
    name: 'delegate',
    description: '拆解为可并行的子任务并分派，再独立验收',
    markers: ['并行', '分别', '同时处理', '多个', '一起做', '分工', '子任务', 'parallel', 'delegate', 'split', 'subtask', 'sub-agent', 'team'],
    scenes: ['office', 'research', 'engineering'],
    interactions: ['orchestrate'],
  },
  {
    name: 'support',
    description: '先承接情绪与处境，再谨慎推进实际动作',
    markers: ['难过', '焦虑', '压力', '情绪', '陪我', '安慰', '崩溃', '撑不住', 'sad', 'anxious', 'stress', 'comfort', 'overwhelmed'],
    scenes: ['dialogue'],
    interactions: ['emotion'],
  },
]

/* ------------------------------------------------------------------------- *
 * Failure route catalogue (risk directions, v23 §6.1 收束)
 * ------------------------------------------------------------------------- */

const FailureCatalogue: readonly FailureDefinition[] = [
  {
    name: 'unsafe-action',
    description: '涉及不可逆或高风险操作（删除、覆盖、上线、权限变更），出错难以回滚',
    markers: ['删除', '覆盖', '上线', '发布', '生产', '权限', '清空', '迁移', '重置', 'deploy', 'delete', 'drop', 'overwrite', 'production', 'migrate', 'revoke', 'force push'],
    successRoutes: ['implement', 'delegate', 'verify'],
  },
  {
    name: 'scope-creep',
    description: '需求边界会扩大，工作量与时间超出当前 Turn',
    markers: ['顺便', '同时', '并且', '然后', '还有', '全部', '所有', '一起', '多轮', 'also', 'as well', 'and then', 'everything', 'all of'],
    successRoutes: ['plan', 'delegate', 'iterate', 'implement'],
  },
  {
    name: 'hidden-assumption',
    description: '隐含假设未经验证，可能与真实环境不符',
    markers: ['应该', '大概', '估计', '默认', '按理', '显然', 'assume', 'probably', 'should be', 'default', 'obviously'],
    successRoutes: ['support', 'answer', 'plan'],
  },
  {
    name: 'ambiguity-drift',
    description: '指代或目标不明确，执行方向可能漂移',
    markers: ['这个', '那个', '它', '这块', '那样', '随便', '看情况', '之类的', 'this', 'that', 'it', 'somehow', 'kind of'],
    successRoutes: ['clarify', 'answer'],
  },
  {
    name: 'evidence-gap',
    description: '缺少可核验的证据或数据来源，结论无法证实',
    markers: ['据说', '听说', '好像', '可能', '也许', '数据', '来源', '感觉', 'maybe', 'rumor', 'some say', 'probably', 'i think'],
    successRoutes: ['research', 'answer', 'support'],
  },
  {
    name: 'resource-overrun',
    description: '时间或 Token 预算可能超支，需要压缩范围',
    markers: ['紧急', '马上', '尽快', '大量', '反复', '多次', '来不及', 'urgent', 'asap', 'many', 'lots', 'repeat', 'again and again'],
    successRoutes: ['implement', 'research', 'delegate'],
  },
  {
    name: 'verification-gap',
    description: '没有明确验收标准，无法判定任务是否完成',
    markers: ['验收', '标准', '算完成', '做好', '搞定', 'done', 'acceptance', 'criteria', 'finished', 'complete'],
    successRoutes: ['verify', 'implement', 'iterate', 'delegate', 'plan'],
  },
]

/* ------------------------------------------------------------------------- *
 * Think-stage lexicons
 * ------------------------------------------------------------------------- */

const RequestMarker: readonly string[] = [
  '请',
  '帮我',
  '帮忙',
  '麻烦',
  '需要',
  '希望',
  '能不能',
  '可不可以',
  '能否',
  '我要',
  '我想',
  '给我',
  'please',
  'need',
  'want',
  'can you',
  'could you',
  'would you',
  'help me',
  'make sure',
  'ensure',
  'should',
]

const QuestionMarker: readonly string[] = [
  '?',
  '？',
  '怎么',
  '如何',
  '为什么',
  '什么',
  '哪些',
  '是否',
  'how',
  'what',
  'why',
  'which',
  'who',
  'when',
  'where',
  'whether',
]

const ConstraintMarker: readonly string[] = [
  '必须',
  '不能',
  '不要',
  '不得',
  '禁止',
  '只能',
  '务必',
  '一定要',
  '不允许',
  '仅限',
  '不可以',
  '不用',
  'only',
  'must',
  'cannot',
  "can't",
  'do not',
  "don't",
  'never',
  'without',
  'no more than',
  'at most',
  'at least',
  'required',
]

const VagueReferenceMarker: readonly string[] = [
  '这个',
  '那个',
  '它',
  '这块',
  '那部分',
  '上面',
  '前面',
  '这些',
  '那些',
  '那样',
  '随便',
  '看情况',
  'this',
  'that',
  'it',
  'these',
  'those',
  'them',
  'something',
  'stuff',
]

const VagueTaskMarker: readonly string[] = [
  '优化一下',
  '弄一下',
  '改一下',
  '搞一下',
  '处理一下',
  '调整一下',
  '看看',
  '更好一点',
  'fix it',
  'improve it',
  'make it better',
  'do something',
]

const EngineeringMarker: readonly string[] = [
  '代码',
  '函数',
  '接口',
  '文件',
  '项目',
  '仓库',
  '部署',
  '测试',
  '构建',
  'code',
  'function',
  'api',
  'file',
  'project',
  'repository',
  'deploy',
  'test',
  'build',
]

/* ------------------------------------------------------------------------- *
 * Comprehension module
 * ------------------------------------------------------------------------- */

export class ComprehensionModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  /**
   * Run the complete four-stage comprehension for one prompt and persist both
   * the `comprehension` row and one `comprehension_stage` row per stage.
   *
   * The comprehension row is created first (v23 §9.7 ③) and the turn is linked
   * to it, so a partially finished comprehension is still discoverable. Each
   * stage then commits in its own transaction and the row is finalised with
   * `finished` once the chain has run.
   */
  async comprehend(input: ComprehendInput): Promise<Comprehension> {
    assertPrompt(input.prompt)
    const turn = mapTurn(this.host.db.require<Row>('turn', input.turn, 'turn'))
    const promptRow = this.host.db.require<Row>('prompt', input.promptIdentity, 'prompt')
    if (Number(promptRow.turn) !== turn.identity) {
      throw new InvalidArgumentError(`prompt ${input.promptIdentity} does not belong to turn ${input.turn}`, {
        prompt: input.promptIdentity,
        turn: input.turn,
      })
    }

    const validation = toValidation(input.validation)
    const scene = toScene(input.scene)
    const interaction = toInteraction(input.interaction)
    const context: StageContext = {
      ...(input.context ?? {}),
      scene,
      validation,
      interaction,
    }

    const created = this.host.clock.now()
    const identity = this.host.db.transaction(() => {
      const inserted = this.host.db.insert('comprehension', {
        handle: this.host.handles.next('comprehension'),
        turn: turn.identity,
        prompt: input.promptIdentity,
        intent: '',
        requirement: '',
        constraint: '',
        assumption: '',
        ambiguity: '',
        confidence: 0,
        stageCount: 0,
        model: input.model,
        created,
      })
      this.host.db.update('turn', { comprehension: inserted }, 'identity = ?', turn.identity)
      return inserted
    })

    const chain: StageChain = {}
    for (const stage of ComprehensionStageOrder) {
      if (validation === 'low' && (stage === 'heuristic' || stage === 'converge')) {
        // A skipped stage still owns its ordinal: the record is written, the
        // Bayesian work is not attempted, and no search is issued.
        this.writeStage({
          comprehension: identity,
          stage,
          status: 'skipped',
          input: { stage, validation, scene, interaction },
          output: { skipped: true, reason: 'validation-low' },
        })
        continue
      }
      if (stage === 'emotion') {
        chain.emotion = (await this.executeEmotionStage(identity, input.prompt, context)).output
        continue
      }
      if (stage === 'think') {
        const emotion = chain.emotion ?? (await this.emotion(input.prompt, context))
        chain.emotion = emotion
        chain.think = (await this.executeThinkStage(identity, input.prompt, emotion)).output
        continue
      }
      if (stage === 'heuristic') {
        const think = chain.think ?? (await this.think(input.prompt, chain.emotion ?? (await this.emotion(input.prompt, context))))
        chain.think = think
        chain.heuristic = (await this.executeHeuristicStage(identity, input.prompt, think, context)).output
        continue
      }
      const heuristic = chain.heuristic ?? (await this.heuristic(input.prompt, chain.think ?? defaultThinkOutput()))
      chain.heuristic = heuristic
      chain.converge = (await this.executeConvergeStage(identity, input.prompt, heuristic)).output
    }

    const finished = this.host.clock.now()
    this.host.db.transaction(() => {
      this.host.db.update(
        'comprehension',
        {
          intent: chain.think?.intent ?? '',
          requirement: chain.think?.requirement ?? '',
          constraint: chain.think?.constraint ?? '',
          assumption: chain.think?.assumption ?? '',
          ambiguity: chain.think?.ambiguity ?? '',
          confidence: this.aggregateConfidence(identity) ?? chain.think?.confidence ?? 0,
          entropy: chain.converge?.entropy ?? chain.heuristic?.entropy,
          emotion: chain.emotion?.intensity,
          empathy: chain.emotion?.empathy,
          think: chain.think?.reasoning,
          evidence:
            chain.heuristic === undefined && chain.converge === undefined
              ? undefined
              : jsonText(this.mergedEvidence(chain.heuristic, chain.converge)),
          route: chain.heuristic === undefined ? undefined : jsonText(chain.heuristic.routes),
          failure: chain.converge === undefined ? undefined : jsonText(chain.converge.failures),
          boundary: chain.converge?.boundary,
          stageCount: this.doneStageCount(identity),
          thinkTrace: chain.think === undefined ? undefined : jsonText(chain.think),
          model: input.model,
          finished,
        },
        'identity = ?',
        identity,
      )
    })
    this.host.events.emit('comprehension/done', {
      comprehension: identity,
      turn: turn.identity,
      validation,
      stageCount: this.doneStageCount(identity),
    })
    return this.get(identity)
  }

  /**
   * Re-run one stage of an existing comprehension.
   *
   * Re-running never mutates the previous stage row: a new `comprehension_stage`
   * row is inserted with the same ordinal and a new handle, and the readers take
   * the latest row per ordinal. The comprehension fields owned by the stage are
   * refreshed in the same transaction.
   *
   * `heuristic` and `converge` stay skipped for a low-validation comprehension:
   * the §6.3 rule ("no Bayesian inference, no search") holds for explicit stage
   * re-runs too, so the method records another `skipped` row instead of running
   * the stage.
   */
  async runStage(comprehension: number, stage: StageName): Promise<ComprehensionStageRecord> {
    if (!isStageName(stage)) {
      throw new InvalidArgumentError(`unknown comprehension stage: ${String(stage)}`, {
        allowed: ComprehensionStageOrder,
      })
    }
    const record = this.get(comprehension)
    const turn = mapTurn(this.host.db.require<Row>('turn', record.turn, 'turn'))
    const prompt = this.promptOf(record)
    const validation = toValidation(turn.validation)
    const scene = toScene(turn.scene)
    const interaction = toInteraction(turn.interaction)
    const context: StageContext = { scene, validation, interaction }

    if (validation === 'low' && (stage === 'heuristic' || stage === 'converge')) {
      return this.writeStage({
        comprehension,
        stage,
        status: 'skipped',
        input: { stage, validation, scene, interaction },
        output: { skipped: true, reason: 'validation-low' },
      })
    }
    if (stage === 'emotion') {
      return (await this.executeEmotionStage(comprehension, prompt, context)).record
    }
    if (stage === 'think') {
      return (await this.executeThinkStage(comprehension, prompt, await this.emotion(prompt, context))).record
    }
    if (stage === 'heuristic') {
      const think = this.storedThink(record) ?? (await this.think(prompt, await this.emotion(prompt, context)))
      return (await this.executeHeuristicStage(comprehension, prompt, think, context)).record
    }
    const heuristic = this.storedHeuristic(record)
    if (heuristic === undefined) {
      throw new InvalidStateError(
        `comprehension ${comprehension} has no heuristic output yet; run the heuristic stage first`,
        { comprehension },
      )
    }
    return (await this.executeConvergeStage(comprehension, prompt, heuristic)).record
  }

  /**
   * Stage one: deterministic emotion reading.
   *
   * The lexicon is fixed and the output is a function of the prompt alone:
   * label, intensity 0..1, one short supportive Chinese empathy line, and a
   * crisis string when self-harm or harm-to-others markers appear. The reading
   * never diagnoses: labels are plain emotional states and the crisis line
   * points at concrete support instead of a clinical judgement.
   */
  async emotion(prompt: string, context?: ComprehensionContext): Promise<EmotionStageOutput> {
    void context // Accepted for signature parity; the lexicon sees the prompt only.
    const crisisMarkers = matchedMarkers(prompt, CrisisMarker)
    const positiveHits = hitsOf(prompt, PositiveMarker)
    const negativeHits = hitsOf(prompt, NegativeMarker)
    const worryHits = hitsOf(prompt, WorryMarker)
    const angerHits = hitsOf(prompt, AngerMarker)
    const sadnessHits = hitsOf(prompt, SadnessMarker)
    const urgencyHits = hitsOf(prompt, UrgencyMarker)
    const emotionHits = positiveHits + negativeHits + worryHits + angerHits + sadnessHits
    const exclamations = (prompt.match(/[!！]/g) ?? []).length

    let intensity = 0.12 + 0.08 * Math.min(emotionHits, 6) + 0.06 * Math.min(urgencyHits, 4) + 0.05 * Math.min(exclamations, 3)
    if (crisisMarkers.length > 0) {
      intensity = Math.max(intensity, 0.65) + 0.03 * Math.min(crisisMarkers.length, 3)
    }

    let label: EmotionLabel = 'neutral'
    if (crisisMarkers.length > 0) {
      label = 'crisis'
    } else {
      const categories: ReadonlyArray<{ label: EmotionLabel; score: number }> = [
        { label: 'anger', score: angerHits },
        { label: 'worry', score: worryHits },
        { label: 'sadness', score: sadnessHits },
        { label: 'negative', score: negativeHits },
        { label: 'positive', score: positiveHits },
        { label: 'urgency', score: urgencyHits },
      ]
      let bestScore = 0
      for (const category of categories) {
        if (category.score > bestScore) {
          label = category.label
          bestScore = category.score
        }
      }
    }

    return {
      label,
      intensity: round(clamp(intensity, 0, 1), 4),
      empathy: EmpathyCopy[label],
      ...(crisisMarkers.length === 0 ? {} : { crisis: crisisText(crisisMarkers) }),
    }
  }

  /**
   * Stage two: explicit, deterministic reasoning.
   *
   * Intent is the first meaningful sentence normalised to one line; requirement
   * is the request or question sentence; constraint collects the clauses that
   * carry a constraint marker (`必须/不能/不要/only/must` and friends);
   * assumption and ambiguity explain what the analysis had to take for granted.
   * Confidence is a bounded heuristic score, never an LLM judgement.
   */
  async think(prompt: string, emotion: EmotionStageOutput): Promise<ThinkStageOutput> {
    const sentences = sentencesOf(prompt)
    const intent = intentOf(prompt)
    const requestSentence = sentences.find((sentence) => hasMarker(sentence, RequestMarker))
    const questionSentence = sentences.find((sentence) => hasMarker(sentence, QuestionMarker))
    const requirement = trimPunctuation(collapse(requestSentence ?? questionSentence ?? intent, 180))
    const clauses = sentences
      .flatMap((sentence) => sentence.split(/[，,、]/).map((clause) => collapse(clause, 180)))
      .filter((clause) => clause.length > 0)
    const constraintClauses = unique(clauses.filter((clause) => hasMarker(clause, ConstraintMarker)))
    const constraintFound = constraintClauses.length > 0
    const constraint = constraintFound ? collapse(constraintClauses.slice(0, 4).join('；'), 240) : '无显式约束'
    const ambiguity = ambiguityOf(prompt)
    const assumption = assumptionOf({
      constraintFound,
      vague: ambiguity.vague,
      short: ambiguity.short,
      request: requestSentence !== undefined,
      engineering: hasMarker(prompt, EngineeringMarker),
      emotion,
    })

    let confidence = 0.55
    if (constraintFound) confidence += 0.12
    if (requestSentence !== undefined || questionSentence !== undefined) confidence += 0.1
    if (trimPunctuation(collapse(prompt, 400)).length >= 20) confidence += 0.06
    if (ambiguity.vague) confidence -= 0.15
    if (ambiguity.short) confidence -= 0.1
    if (emotion.label === 'crisis') confidence -= 0.1
    if (emotion.label === 'anger') confidence -= 0.03
    confidence = round(clamp(confidence, 0.2, 0.95), 4)

    const reasoning = [
      `意图：${intent}`,
      `需求：${requirement}`,
      `约束：${constraint}`,
      `假设：${assumption}`,
      `歧义：${ambiguity.text}`,
      `置信度：${confidence.toFixed(2)}`,
    ].join('\n')

    return { reasoning, intent, requirement, constraint, assumption, ambiguity: ambiguity.text, confidence }
  }

  /**
   * Stage three: candidate success routes with a log-odds update.
   *
   * Each route starts from the configured `bayesian.prior`; verb, scene,
   * interaction and evidence hits add weight in log-odds space. The resulting
   * probabilities are normalised to sum 1 (4 decimals), the routes are ranked,
   * `best` is the top route, entropy is normalised Shannon entropy and
   * confidence is `1 - entropy`.
   *
   * Evidence is never invented: it is either caller-supplied session evidence
   * (labelled `session: ...`) or real search-result titles/urls. A search that
   * fails, times out or is unavailable contributes nothing and the stage still
   * commits as `done`.
   */
  async heuristic(prompt: string, think: ThinkStageOutput, context?: ComprehensionContext): Promise<HeuristicStageOutput> {
    const validation = context?.validation ?? toValidation(this.host.config.defaults.validation)
    const scene = context?.scene ?? toScene(this.host.config.defaults.scene)
    const interaction = this.currentInteraction(context)
    const evidence = await this.successEvidence(prompt, think, context, validation)

    const scored = RouteCatalogue.map((definition) => ({
      definition,
      weight: this.routeWeight(definition, prompt, think, scene, interaction, evidence),
    }))
    const ranked = [...scored].sort(
      (left, right) => right.weight - left.weight || compareText(left.definition.name, right.definition.name),
    )
    const kept = ranked.slice(0, Math.max(1, Math.round(this.host.config.bayesian.maxRoutes)))
    const probabilities = this.normaliseProbabilities(kept.map((entry) => entry.weight))
    const routes: RouteCandidate[] = kept.map((entry, index) => ({
      name: entry.definition.name,
      description: entry.definition.description,
      probability: probabilities[index],
    }))
    routes.sort(
      (left, right) => right.probability - left.probability || compareText(left.name, right.name),
    )

    const best = routes.length > 0 ? routes[0].name : 'answer'
    const distribution = routes.map((route) => route.probability)
    const { entropy, confidence } = this.entropyOf(distribution)
    return { routes, evidence, best, confidence, entropy }
  }

  /**
   * Stage four: failure routes, the boundary and the stopping decision.
   *
   * Failure probabilities use the same prior plus risk-oriented weights
   * (irreversible operations, scope growth, unverified assumptions, missing
   * evidence, budget pressure and missing acceptance criteria). `boundary`
   * states what must be verified before irreversible work, and `stop` is true
   * when the entropy is at or below `bayesian.stopEntropy` or when no failure
   * route is above 0.5.
   *
   * The method searches failure cases when search is enabled and a web port
   * exists. Its published signature carries no validation level, so the §6.3
   * low gate is enforced by `comprehend` / `runStage` before it is called.
   */
  async converge(prompt: string, heuristic: HeuristicStageOutput): Promise<ConvergeStageOutput> {
    const evidence: string[] = []
    const hitDefinitions = FailureCatalogue.filter((definition) =>
      definition.markers.some((marker) => markerHits(prompt, marker) > 0),
    )
    if (hitDefinitions.length > 0) {
      evidence.push(`session: 命中风险标记 ${hitDefinitions.map((definition) => definition.name).slice(0, 4).join(', ')}`)
    }
    if (this.searchAllowed(undefined)) {
      const found = await this.searchEvidence(this.failureQuery(prompt, heuristic), this.maxEvidence())
      for (const entry of found) if (!evidence.includes(entry)) evidence.push(entry)
    }

    const scored = FailureCatalogue.map((definition) => ({
      definition,
      weight: this.failureWeight(definition, prompt, heuristic),
    }))
    const ranked = [...scored].sort(
      (left, right) => right.weight - left.weight || compareText(left.definition.name, right.definition.name),
    )
    const kept = ranked.slice(0, Math.max(1, Math.round(this.host.config.bayesian.maxRoutes)))
    const probabilities = this.normaliseProbabilities(kept.map((entry) => entry.weight))
    const failures: RouteCandidate[] = kept.map((entry, index) => ({
      name: entry.definition.name,
      description: entry.definition.description,
      probability: probabilities[index],
    }))
    failures.sort(
      (left, right) => right.probability - left.probability || compareText(left.name, right.name),
    )

    const distribution = failures.map((failure) => failure.probability)
    const { entropy, confidence } = this.entropyOf(distribution)
    const stop =
      entropy <= this.host.config.bayesian.stopEntropy || !failures.some((failure) => failure.probability > 0.5)
    return { failures, boundary: boundaryOf(failures, heuristic), evidence, confidence, entropy, stop }
  }

  /** Read one comprehension row. */
  get(identity: number): Comprehension {
    return mapComprehension(this.host.db.require<Row>('comprehension', identity, 'comprehension'))
  }

  /**
   * The four-stage view: the latest stage row per ordinal, ordered by ordinal.
   * A re-run produces a newer row with the same ordinal, and this view reads it.
   */
  stages(comprehension: number): ComprehensionStageRecord[] {
    this.get(comprehension)
    return this.latestStages(comprehension)
  }

  /** The audit view: every stage row ever written, ordered by ordinal then time. */
  stageHistory(comprehension: number): ComprehensionStageRecord[] {
    this.get(comprehension)
    return this.host.db
      .all<Row>(
        'SELECT * FROM comprehension_stage WHERE comprehension = ? ORDER BY ordinal ASC, identity ASC',
        comprehension,
      )
      .map(mapStage)
  }

  /* ----------------------------------------------------------------------- *
   * Stage execution: compute, then commit one stage row and its fields
   * ----------------------------------------------------------------------- */

  private async executeEmotionStage(
    comprehension: number,
    prompt: string,
    context: ComprehensionContext,
  ): Promise<StageOutcome<EmotionStageOutput>> {
    const output = await this.guardStage(comprehension, 'emotion', prompt, context, () => this.emotion(prompt, context))
    const record = this.writeStage({
      comprehension,
      stage: 'emotion',
      status: 'done',
      input: { prompt: collapse(prompt, 500), context: contextSnapshot(context) },
      output,
      patch: { emotion: output.intensity, empathy: output.empathy },
      aggregate: true,
    })
    return { output, record }
  }

  private async executeThinkStage(
    comprehension: number,
    prompt: string,
    emotion: EmotionStageOutput,
  ): Promise<StageOutcome<ThinkStageOutput>> {
    const output = await this.guardStage(comprehension, 'think', prompt, undefined, () => this.think(prompt, emotion))
    const record = this.writeStage({
      comprehension,
      stage: 'think',
      status: 'done',
      input: { prompt: collapse(prompt, 500), emotion },
      output,
      confidence: output.confidence,
      patch: {
        intent: output.intent,
        requirement: output.requirement,
        constraint: output.constraint,
        assumption: output.assumption,
        ambiguity: output.ambiguity,
        think: output.reasoning,
        thinkTrace: jsonText(output),
      },
      aggregate: true,
    })
    return { output, record }
  }

  private async executeHeuristicStage(
    comprehension: number,
    prompt: string,
    think: ThinkStageOutput,
    context: ComprehensionContext,
  ): Promise<StageOutcome<HeuristicStageOutput>> {
    const output = await this.guardStage(comprehension, 'heuristic', prompt, context, () =>
      this.heuristic(prompt, think, context),
    )
    const record = this.writeStage({
      comprehension,
      stage: 'heuristic',
      status: 'done',
      input: { prompt: collapse(prompt, 500), think, context: contextSnapshot(context) },
      output,
      confidence: output.confidence,
      entropyBefore: uniformEntropy(output.routes.length),
      entropyAfter: output.entropy,
      patch: {
        evidence: jsonText(output.evidence),
        route: jsonText(output.routes),
        entropy: output.entropy,
      },
      aggregate: true,
    })
    return { output, record }
  }

  private async executeConvergeStage(
    comprehension: number,
    prompt: string,
    heuristic: HeuristicStageOutput,
  ): Promise<StageOutcome<ConvergeStageOutput>> {
    const output = await this.guardStage(comprehension, 'converge', prompt, undefined, () =>
      this.converge(prompt, heuristic),
    )
    const record = this.writeStage({
      comprehension,
      stage: 'converge',
      status: 'done',
      input: { prompt: collapse(prompt, 500), heuristic },
      output,
      confidence: output.confidence,
      entropyBefore: uniformEntropy(output.failures.length),
      entropyAfter: output.entropy,
      patch: {
        evidence: jsonText(this.mergedEvidence(undefined, output)),
        failure: jsonText(output.failures),
        boundary: output.boundary,
        entropy: output.entropy,
      },
      aggregate: true,
    })
    return { output, record }
  }

  /**
   * Persist one stage row and the comprehension fields it owns, in one
   * transaction. Only INSERTs on `comprehension_stage`: a re-run adds a row.
   */
  private writeStage(write: StageWrite): ComprehensionStageRecord {
    const now = this.host.clock.now()
    const ordinal = ordinalOf(write.stage)
    return this.host.db.transaction(() => {
      const identity = this.host.db.insert('comprehension_stage', {
        handle: this.host.handles.next('stage'),
        comprehension: write.comprehension,
        stage: write.stage,
        ordinal,
        status: write.status,
        input: jsonText(write.input),
        output: write.output === undefined ? undefined : jsonText(write.output),
        confidence: write.confidence,
        entropyBefore: write.entropyBefore,
        entropyAfter: write.entropyAfter,
        created: now,
        finished: write.status === 'pending' || write.status === 'running' ? undefined : now,
      })
      const patch: Record<string, unknown> = { ...(write.patch ?? {}) }
      patch.stageCount = this.doneStageCount(write.comprehension)
      if (write.aggregate === true) {
        const aggregate = this.aggregateConfidence(write.comprehension)
        if (aggregate !== undefined) patch.confidence = aggregate
      }
      if (Object.keys(patch).length > 0) {
        this.host.db.update('comprehension', patch, 'identity = ?', write.comprehension)
      }
      this.host.events.emit('comprehension/stage', {
        comprehension: write.comprehension,
        stage: write.stage,
        ordinal,
        status: write.status,
        stageCount: patch.stageCount,
      })
      return mapStage(this.host.db.require<Row>('comprehension_stage', identity, 'comprehension stage'))
    })
  }

  /** Run a stage body; a thrown body records a `failed` row and rethrows. */
  private async guardStage<T>(
    comprehension: number,
    stage: StageName,
    prompt: string,
    context: ComprehensionContext | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      try {
        this.writeStage({
          comprehension,
          stage,
          status: 'failed',
          input: { stage, prompt: collapse(prompt, 500), context: contextSnapshot(context) },
          output: { failed: true, reason: error instanceof Error ? error.message : String(error) },
        })
      } catch {
        // The audit row must never hide the original stage failure.
      }
      throw error
    }
  }

  /* ----------------------------------------------------------------------- *
   * Readers and derived values
   * ----------------------------------------------------------------------- */

  private latestStages(comprehension: number): ComprehensionStageRecord[] {
    const rows = this.host.db.all<Row>(
      'SELECT * FROM comprehension_stage WHERE comprehension = ? ORDER BY ordinal ASC, identity DESC',
      comprehension,
    )
    const latest = new Map<number, ComprehensionStageRecord>()
    for (const row of rows) {
      const record = mapStage(row)
      if (!latest.has(record.ordinal)) latest.set(record.ordinal, record)
    }
    return [...latest.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1])
  }

  /** Distinct ordinals that produced a `done` row; skipped rows do not count. */
  private doneStageCount(comprehension: number): number {
    const row = this.host.db.get<{ total: number }>(
      "SELECT COUNT(DISTINCT ordinal) AS total FROM comprehension_stage WHERE comprehension = ? AND status = 'done'",
      comprehension,
    )
    return Number(row?.total ?? 0)
  }

  /**
   * Mean confidence of the analytical stages (think, heuristic, converge) that
   * have committed a `done` row. Emotion is excluded: its intensity is not a
   * confidence. `undefined` while no analytical stage has run yet.
   */
  private aggregateConfidence(comprehension: number): number | undefined {
    const records = this.latestStages(comprehension).filter(
      (record) => record.stage !== 'emotion' && record.status === 'done' && record.confidence !== undefined,
    )
    if (records.length === 0) return undefined
    const total = records.reduce((sum, record) => sum + (record.confidence ?? 0), 0)
    return round(total / records.length, 4)
  }

  private promptOf(record: Comprehension): string {
    const row = this.host.db.require<Row>('prompt', record.prompt, 'prompt')
    return text(row, 'content')
  }

  /** Recover the persisted think output, defensively. */
  private storedThink(record: Comprehension): ThinkStageOutput | undefined {
    if (record.thinkTrace === undefined) return undefined
    return readThinkOutput(parseJson<unknown>(record.thinkTrace, undefined))
  }

  /** Recover the persisted heuristic output, defensively. */
  private storedHeuristic(record: Comprehension): HeuristicStageOutput | undefined {
    const routes = readRoutes(parseJson<unknown>(record.route, []))
    if (routes.length === 0) return undefined
    const evidence = readStrings(parseJson<unknown>(record.evidence, []))
    const sorted = [...routes].sort(
      (left, right) => right.probability - left.probability || compareText(left.name, right.name),
    )
    const { entropy, confidence } = this.entropyOf(sorted.map((route) => route.probability))
    return {
      routes: sorted,
      evidence,
      best: sorted[0].name,
      confidence,
      entropy,
    }
  }

  /* ----------------------------------------------------------------------- *
   * Probability, entropy and route scoring
   * ----------------------------------------------------------------------- */

  /**
   * Log-odds update: `logit(prior) + evidenceWeight` per route, then sigmoid,
   * then normalise so the probabilities sum to 1. Rounding drift is corrected
   * on the largest entry so the rounded sum is exactly 1 at 4 decimals.
   */
  private normaliseProbabilities(weights: readonly number[]): number[] {
    if (weights.length === 0) return []
    const prior = clamp(this.host.config.bayesian.prior, 0.01, 0.99)
    const priorLogit = Math.log(prior / (1 - prior))
    const unnormalised = weights.map((weight) => 1 / (1 + Math.exp(-(priorLogit + weight))))
    const total = unnormalised.reduce((sum, value) => sum + value, 0)
    if (!(total > 0)) return weights.map(() => round(1 / weights.length, 4))
    const probabilities = unnormalised.map((value) => round(value / total, 4))
    const drift = round(1 - probabilities.reduce((sum, value) => sum + value, 0), 4)
    if (drift !== 0) {
      let largest = 0
      for (let index = 1; index < probabilities.length; index += 1) {
        if (probabilities[index] > probabilities[largest]) largest = index
      }
      probabilities[largest] = round(probabilities[largest] + drift, 4)
    }
    return probabilities
  }

  /** Normalised Shannon entropy in 0..1 and confidence `1 - entropy`. */
  private entropyOf(probabilities: readonly number[]): { entropy: number; confidence: number } {
    const positive = probabilities.filter((value) => value > 0)
    if (positive.length <= 1) return { entropy: 0, confidence: 1 }
    const shannon = -positive.reduce((sum, value) => sum + value * Math.log2(value), 0)
    const normalised = clamp(shannon / Math.log2(positive.length), 0, 1)
    return { entropy: round(normalised, 4), confidence: round(1 - normalised, 4) }
  }

  private routeWeight(
    definition: RouteDefinition,
    prompt: string,
    think: ThinkStageOutput,
    scene: Scene,
    interaction: Interaction,
    evidence: readonly string[],
  ): number {
    let weight = 0.12
    let hits = 0
    for (const marker of definition.markers) hits += markerHits(prompt, marker)
    weight += Math.min(hits, 4) * 0.45
    if (definition.scenes.includes(scene)) weight += 0.3
    if (definition.interactions.includes(interaction)) weight += 0.25
    if (definition.name === 'clarify' && think.ambiguity !== '无明显歧义') weight += 0.3
    if (definition.name === 'verify' && think.constraint !== '无显式约束') weight += 0.1
    weight += this.evidenceWeight(definition.name, definition.markers, evidence)
    return round(weight, 4)
  }

  private failureWeight(definition: FailureDefinition, prompt: string, heuristic: HeuristicStageOutput): number {
    let weight = 0.1
    let hits = 0
    for (const marker of definition.markers) hits += markerHits(prompt, marker)
    weight += Math.min(hits, 3) * 0.7
    if (definition.successRoutes.includes(heuristic.best)) weight += 0.2
    if (heuristic.confidence < 0.5 && (definition.name === 'evidence-gap' || definition.name === 'ambiguity-drift')) {
      weight += 0.15
    }
    weight += this.evidenceWeight(definition.name, definition.markers, heuristic.evidence)
    return round(Math.min(weight, 3), 4)
  }

  private evidenceWeight(name: string, keywords: readonly string[], evidence: readonly string[]): number {
    let weight = 0
    for (const entry of evidence) {
      const lowered = entry.toLowerCase()
      if (lowered.includes(name.toLowerCase())) {
        weight += 0.2
        continue
      }
      if (keywords.some((keyword) => keyword.length >= 2 && lowered.includes(keyword.toLowerCase()))) weight += 0.1
    }
    return Math.min(round(weight, 4), 0.4)
  }

  private mergedEvidence(heuristic: HeuristicStageOutput | undefined, converge: ConvergeStageOutput | undefined): string[] {
    const merged: string[] = []
    for (const entry of heuristic?.evidence ?? []) if (!merged.includes(entry)) merged.push(entry)
    for (const entry of converge?.evidence ?? []) if (!merged.includes(entry)) merged.push(entry)
    return merged
  }

  /* ----------------------------------------------------------------------- *
   * Evidence search (optional, read-only, never fatal)
   * ----------------------------------------------------------------------- */

  private maxEvidence(): number {
    return Math.max(1, Math.round(this.host.config.comprehension.maxEvidence))
  }

  /** Search needs medium/high validation, the config switch and a web port. */
  private searchAllowed(validation: Validation | undefined): boolean {
    if (!this.host.config.comprehension.searchEnabled) return false
    if (this.host.web === undefined) return false
    if (validation === 'low') return false
    return true
  }

  private async successEvidence(
    prompt: string,
    think: ThinkStageOutput,
    context: ComprehensionContext | undefined,
    validation: Validation,
  ): Promise<string[]> {
    const evidence = this.sessionEvidence(context)
    if (!this.searchAllowed(validation)) return evidence
    const found = await this.searchEvidence(this.successQuery(prompt, think), this.maxEvidence())
    for (const entry of found) if (!evidence.includes(entry)) evidence.push(entry)
    return evidence
  }

  private sessionEvidence(context: ComprehensionContext | undefined): string[] {
    const evidence: string[] = []
    for (const entry of context?.evidence ?? []) {
      const label = collapse(entry, 300)
      if (label.length > 0) evidence.push(`session: ${label}`)
    }
    return evidence
  }

  private successQuery(prompt: string, think: ThinkStageOutput): string {
    const subject = think.requirement.length > 0 && think.requirement !== think.intent ? think.requirement : think.intent
    return collapse(`${subject} success cases best practice`, 240)
  }

  private failureQuery(prompt: string, heuristic: HeuristicStageOutput): string {
    const subject = trimPunctuation(collapse(sentencesOf(prompt)[0] ?? prompt, 160))
    return collapse(`${subject} ${heuristic.best} failure cases risks`, 240)
  }

  /**
   * Search once. The timeout is derived from `comprehension.stageTimeout` (half
   * of it, floored at 50ms) so the whole stage still fits the configured
   * budget. Any failure, timeout, abort or unknown response shape yields `[]`:
   * the stage must still commit as `done`.
   */
  private async searchEvidence(query: string, maxResults: number): Promise<string[]> {
    const port = this.host.web
    if (port === undefined || !this.host.config.comprehension.searchEnabled) return []
    const trimmed = collapse(query, 240)
    if (trimmed.length === 0) return []

    const controller = new AbortController()
    let pending: Promise<unknown>
    try {
      pending = Promise.resolve(port.search({ query: trimmed, maxResults }, controller.signal))
    } catch {
      return []
    }
    // A late rejection after the timeout must not become an unhandled rejection.
    pending.catch(() => undefined)

    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(undefined)
      }, searchTimeout(this.host.config.comprehension.stageTimeout))
    })
    try {
      const result = await Promise.race([pending, expiry])
      return parseSearchResults(result, maxResults)
    } catch {
      return []
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private currentInteraction(context?: ComprehensionContext): Interaction {
    const candidate = (context as StageContext | undefined)?.interaction
    return isOneOf(candidate, InteractionValues) ? candidate : toInteraction(this.host.config.defaults.interaction)
  }
}

/* ------------------------------------------------------------------------- *
 * Pure helpers
 * ------------------------------------------------------------------------- */

function isStageName(value: unknown): value is StageName {
  return isOneOf(value, ComprehensionStageOrder)
}

function ordinalOf(stage: StageName): number {
  const index = ComprehensionStageOrder.indexOf(stage)
  if (index < 0) {
    throw new InvalidArgumentError(`unknown comprehension stage: ${String(stage)}`, {
      allowed: ComprehensionStageOrder,
    })
  }
  return index + 1
}

function assertPrompt(content: unknown): asserts content is string {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new InvalidArgumentError('prompt must be a non-empty string')
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function uniformEntropy(count: number): number {
  return count <= 1 ? 0 : round(Math.log2(count), 4)
}

function searchTimeout(stageTimeout: number): number {
  const bounded = Number.isFinite(stageTimeout) && stageTimeout > 0 ? stageTimeout : 30000
  return Math.max(50, Math.floor(bounded / 2))
}

function contextSnapshot(context: ComprehensionContext | undefined): Record<string, unknown> {
  if (context === undefined) return {}
  return {
    ...(context.session === undefined ? {} : { session: context.session }),
    ...(context.scene === undefined ? {} : { scene: context.scene }),
    ...(context.validation === undefined ? {} : { validation: context.validation }),
    ...(context.history === undefined ? {} : { historyCount: context.history.length }),
    ...(context.evidence === undefined ? {} : { evidenceCount: context.evidence.length }),
  }
}

function crisisText(markers: readonly string[]): string {
  const shown = markers.slice(0, 3).join('、')
  return `检测到与安全相关的表达（${shown}）。请优先联系当地紧急服务或可信任的人，尽量不独处；我会陪你先稳住当下。`
}

function ambiguityOf(content: string): { text: string; vague: boolean; short: boolean } {
  const findings: string[] = []
  const references = matchedMarkers(content, VagueReferenceMarker)
  const tasks = matchedMarkers(content, VagueTaskMarker)
  if (references.length > 0) {
    findings.push(`指代对象不明确（${references.slice(0, 3).join(' / ')}），需要确认具体范围`)
  }
  if (tasks.length > 0) {
    findings.push(`任务描述过于宽泛（${tasks.slice(0, 2).join(' / ')}），需要可验收的完成标准`)
  }
  const compact = trimPunctuation(collapse(content, 400))
  const english = /^[A-Za-z0-9\s.,;:'"()\-]+$/.test(compact)
  const short = compact.length > 0 && (compact.length < 10 || (english && compact.split(' ').filter(Boolean).length <= 2))
  if (short) findings.push('输入过短，缺少必要上下文')
  return {
    text: findings.length === 0 ? '无明显歧义' : findings.slice(0, 2).join('；'),
    vague: references.length > 0 || tasks.length > 0,
    short,
  }
}

function assumptionOf(input: {
  constraintFound: boolean
  vague: boolean
  short: boolean
  request: boolean
  engineering: boolean
  emotion: EmotionStageOutput
}): string {
  const assumptions: string[] = []
  if (!input.constraintFound) assumptions.push('未写出硬性约束，按当前会话既有约定处理')
  if (input.vague || input.short) assumptions.push('用户已在上文交代必要背景，必要时先确认再执行')
  if (input.request) assumptions.push('用户期望可直接执行的结论，而不是泛泛解释')
  if (input.engineering) assumptions.push('运行环境与当前工程现状一致')
  if (input.emotion.label === 'crisis') assumptions.push('用户当前处于高风险状态，行动以安全为第一优先')
  if (assumptions.length === 0) assumptions.push('用户描述即为其真实目标')
  return assumptions.slice(0, 3).join('；')
}

function boundaryOf(failures: readonly RouteCandidate[], heuristic: HeuristicStageOutput): string {
  const top = failures[0]
  if (top === undefined) {
    return `边界：未识别出明确的失败路线，按最小改动推进，不执行不可逆操作；可推进方向是「${heuristic.best}」。`
  }
  return `边界：优先验证「${top.name}」——${top.description}；在被验证前不执行不可逆操作。可继续推进的成功路线是「${heuristic.best}」。`
}

function defaultThinkOutput(): ThinkStageOutput {
  return {
    reasoning: '意图：未提供可识别的意图\n需求：无\n约束：无显式约束\n假设：用户描述即为其真实目标\n歧义：无明显歧义\n置信度：0.20',
    intent: '未提供可识别的意图',
    requirement: '无',
    constraint: '无显式约束',
    assumption: '用户描述即为其真实目标',
    ambiguity: '无明显歧义',
    confidence: 0.2,
  }
}

function readThinkOutput(value: unknown): ThinkStageOutput | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const required = ['reasoning', 'intent', 'requirement', 'constraint', 'assumption', 'ambiguity'] as const
  for (const field of required) {
    if (typeof record[field] !== 'string') return undefined
  }
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) return undefined
  return {
    reasoning: String(record.reasoning),
    intent: String(record.intent),
    requirement: String(record.requirement),
    constraint: String(record.constraint),
    assumption: String(record.assumption),
    ambiguity: String(record.ambiguity),
    confidence: round(clamp(Number(record.confidence), 0, 1), 4),
  }
}

function readRoutes(value: unknown): RouteCandidate[] {
  if (!Array.isArray(value)) return []
  const routes: RouteCandidate[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.name !== 'string' || typeof record.description !== 'string') continue
    const probability =
      typeof record.probability === 'number' && Number.isFinite(record.probability)
        ? round(clamp(record.probability, 0, 1), 4)
        : 0
    routes.push({ name: record.name, description: record.description, probability })
  }
  return routes
}

function readStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

const SearchContainerSkip = ['meta', 'metadata', 'pagination', 'stats', 'timing', 'debug', 'requestid', 'query']

function collectSearchResults(value: unknown, found: string[], depth: number): void {
  if (depth > 4 || found.length > 200) return
  if (typeof value === 'string') {
    if (value.trim().length > 0) found.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSearchResults(item, found, depth + 1)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  const title = firstString(record, ['title', 'name', 'heading', 'label'])
  const link = firstString(record, ['url', 'link', 'href', 'sourceUrl', 'source'])
  if (title !== undefined && link !== undefined) found.push(`${title} — ${link}`)
  else if (link !== undefined) found.push(link)
  else if (title !== undefined) found.push(title)
  const snippet = firstString(record, ['snippet', 'content', 'text', 'summary', 'description', 'answer'])
  if (snippet !== undefined && snippet !== title) found.push(snippet)
  for (const [key, item] of Object.entries(record)) {
    if (SearchContainerSkip.includes(key.toLowerCase())) continue
    if (typeof item === 'object' && item !== null) collectSearchResults(item, found, depth + 1)
  }
}

/** Turn an unknown web-search response into a bounded, deduplicated string[]. */
function parseSearchResults(value: unknown, limit: number): string[] {
  const found: string[] = []
  collectSearchResults(value, found, 0)
  const uniqueStrings: string[] = []
  for (const entry of found) {
    const cleaned = collapse(entry, 400)
    if (cleaned.length === 0 || uniqueStrings.includes(cleaned)) continue
    uniqueStrings.push(cleaned)
    if (uniqueStrings.length >= limit) break
  }
  return uniqueStrings
}
