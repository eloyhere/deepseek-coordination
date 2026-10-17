/**
 * Emotion, empathy, companion and crisis (v23 §6.1 emotion mode, §6.3
 * validation, §9.5 stage one; entities §11.17).
 *
 * The module is the persistence half of stage one. `ComprehensionModule` reads
 * the same lexicon into its stage output; this module owns the `emotion`,
 * `companion` and `crisis` tables, so a turn keeps a durable reading and an
 * operator can audit what support was offered.
 *
 * Doctrine
 * --------
 * - **No diagnosis.** Labels are plain emotional states (`positive`, `worry`,
 *   `sadness`, `anger`, `urgency`, `negative`, `crisis`, `neutral`), never a
 *   clinical category, and the copy offers support instead of a judgement.
 * - **Deterministic.** The reading is a pure function of the prompt: the fixed
 *   lexicon below, the same intensity formula as the stage-one output, and the
 *   same short Chinese empathy line. No optional `ModuleHost` port is used, so
 *   the module also works in a bare test host.
 * - **Short Chinese copy.** §6.1 fixes the emotion mode's voice, and enum.ts
 *   owns control labels rather than conversation copy; the supportive strings
 *   therefore live here, exactly as the stage-one copy does in
 *   `comprehension.ts`.
 * - **Conservative crisis.** A crisis row is written only for an explicit
 *   self-harm or harm-to-others statement that survives every veto below.
 *   Anything ambiguous, quoted, negated, reported about someone else, or
 *   discussed as a topic returns no crisis at all: `null` is the default.
 *
 * Crisis vetoes (all must pass)
 * -----------------------------
 * 1. The marker must sit outside a quoted span (`“”`, `「」`, `『』`, `‘’`, `"`).
 * 2. It must not be negated directly before the marker (`不`, `没`, `不会`,
 *    `not`, `never`, ...).
 * 3. The sentence must not be a discussion of the topic (`预防`, `研究`,
 *    `论文`, `报道`, `电影`, `prevention`, `research`, ...).
 * 4. A self-harm statement must be first-person or a very short clause
 *    (`我想死`, `不想活了`) and must not name another person; a harm-to-others
 *    statement must name a target (`杀了他`, `harm someone`).
 * 5. A measurement noun directly after the marker (`自杀率`) is not an intent.
 *
 * Severity is `high` for a surviving explicit statement and `critical` when the
 * same sentence also carries an imminence/means marker. `none`, `low` and
 * `medium` are never emitted: every reading that would deserve them is treated
 * as uncertain and returns `null` instead.
 *
 * Persistence
 * -----------
 * `detect` appends one `emotion` row per reading (a re-reading is another
 * observation, not an overwrite). `crisis` is idempotent per turn and returns
 * the existing row first, because an escalation is an event, not a reading.
 * `companion` appends one supportive `companion` row per call, linked to the
 * turn's session and to the emotion it answers.
 */
import type { ModuleHost } from './module.js'
import { clamp, round } from './module.js'
import type { Companion, Crisis, Emotion } from '../shared/entity.js'
import type { EmpathyProfile } from '../shared/service.js'
import { InvalidArgumentError, NotFoundError } from '../shared/error.js'
import { number, optionalNumber, text } from './row.js'
import type { Row } from './row.js'

/* ------------------------------------------------------------------------- *
 * Lexicon (v23 §6.1, §9.5 stage one)
 * ------------------------------------------------------------------------- */

export type EmotionLabel =
  | 'positive'
  | 'negative'
  | 'worry'
  | 'anger'
  | 'sadness'
  | 'urgency'
  | 'crisis'
  | 'neutral'

export const EmotionLabelValues: readonly EmotionLabel[] = [
  'positive',
  'negative',
  'worry',
  'anger',
  'sadness',
  'urgency',
  'crisis',
  'neutral',
]

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

/** Explicit self-harm statements; every one still passes the veto list. */
const SelfHarmMarker: readonly string[] = [
  '自杀',
  '自残',
  '想死',
  '不想活',
  '活着没意思',
  '活不下去',
  '结束生命',
  '伤害自己',
  '轻生',
  '了结自己',
  'suicide',
  'kill myself',
  'end my life',
  'want to die',
  'self-harm',
  'self harm',
  'hurt myself',
  'no reason to live',
  'take my life',
]

/** Explicit harm-to-others statements; a named target is also required. */
const HarmOtherMarker: readonly string[] = [
  '杀了他',
  '杀了她',
  '杀掉他',
  '杀掉她',
  '弄死他',
  '弄死她',
  '同归于尽',
  '伤害他人',
  'kill him',
  'kill her',
  'kill them',
  'harm someone',
  'hurt someone',
  'shoot them',
]

/** Topic context: a statement inside these sentences is discussion, not intent. */
const DiscussionMarker: readonly string[] = [
  '预防',
  '防止',
  '避免',
  '研究',
  '论文',
  '文献',
  '报道',
  '新闻',
  '统计',
  '数据',
  '案例',
  '科普',
  '电影',
  '小说',
  '游戏',
  '剧情',
  '干预',
  '如何帮助',
  '帮助他人',
  '求助渠道',
  'prevention',
  'research',
  'study',
  'article',
  'news',
  'statistics',
  'report',
  'movie',
  'film',
  'game',
  'documentary',
]

/** Negation immediately before a marker cancels the statement. */
const NegationSuffix: readonly string[] = [
  '不',
  '没',
  '别',
  '无',
  '未',
  '非',
  '不想',
  '不会',
  '不要',
  '没有',
  '不是',
  '并不',
  '从未',
  'not',
  'never',
  'no',
  "n't",
  'without',
]

/** First-person reference makes a short self-harm clause an explicit intent. */
const FirstPersonMarker: readonly string[] = [
  '我',
  '自己',
  '本人',
  '俺',
  '咱',
  'i',
  'im',
  "i'm",
  'me',
  'my',
  'mine',
  'myself',
]

/** A self-harm clause that names someone else is reported speech, not intent. */
const OtherPersonMarker: readonly string[] = [
  '他',
  '她',
  '他们',
  '她们',
  '朋友',
  '同事',
  '同学',
  '家人',
  '父母',
  '孩子',
  '别人',
  '身边人',
  '室友',
  '对象',
  '领导',
  'he',
  'she',
  'they',
  'him',
  'her',
  'them',
  'friend',
  'friends',
  'someone',
  'somebody',
  'colleague',
  'others',
]

/** Harm to others needs a target, or it is venting rather than intent. */
const HarmTargetMarker: readonly string[] = [
  '他',
  '她',
  '他们',
  '她们',
  '人',
  '别人',
  '同事',
  '同学',
  '家人',
  '所有人',
  'everyone',
  'him',
  'her',
  'them',
  'someone',
  'somebody',
  'people',
]

/** Same-sentence means or imminence raises severity to `critical`. */
const ImminenceMarker: readonly string[] = [
  '今晚',
  '现在就',
  '马上',
  '立刻',
  '已经',
  '遗书',
  '割腕',
  '跳楼',
  '上吊',
  '吞药',
  '安眠药',
  '刀',
  '枪',
  '告别',
  '最后',
  'tonight',
  'right now',
  'already',
  'goodbye',
  'farewell',
  'gun',
  'knife',
  'pills',
]

/* ------------------------------------------------------------------------- *
 * Copy
 * ------------------------------------------------------------------------- */

/** The stage-one empathy line, kept identical to the comprehension module. */
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

/** `EmpathyProfile.tone`: the voice to answer in, per reading. */
const ToneCopy: Readonly<Record<EmotionLabel, string>> = {
  positive: '轻快、真诚',
  negative: '温和、稳定',
  worry: '平稳、安抚',
  anger: '平静、承认',
  sadness: '柔和、缓慢',
  urgency: '简洁、果断',
  crisis: '镇定、关切、直接',
  neutral: '自然、不评判',
}

/** `EmpathyProfile.boundary`: what this turn will not do. */
const BoundaryCopy: Readonly<Record<EmotionLabel, string>> = {
  positive: '不夸大、不替你许诺；只把这份好说清楚。',
  negative: '不评判、不追问隐私；只承接感受并给出一小步。',
  worry: '不制造新的担忧；只处理你此刻说出来的事。',
  anger: '不站队、不激化；承认感受，把事实和情绪分开。',
  sadness: '不催促振作；不替你定义痛苦的程度。',
  urgency: '不制造催促；只压缩范围，不压缩质量。',
  crisis: '不诊断、不替代专业援助；确认安全并引导你联系当地紧急援助。',
  neutral: '不诊断、不评判；只倾听并给出可执行的一小步。',
}

/** Sustained support copy for the `companion` row. */
const CompanionCopy: Readonly<Record<EmotionLabel, string>> = {
  positive: '这份好值得多留一会儿。我在这儿，你想说到哪儿就说到哪儿。',
  negative: '这阵不舒服不用马上好起来。我陪着你，我们慢慢来。',
  worry: '担心的事可以一件一件说。我在这儿，不急着要答案。',
  anger: '气还没消也没关系。我陪你把这口气理清楚，不评判。',
  sadness: '难过的时候不用撑着。我在这儿，你想安静一会儿也可以。',
  urgency: '忙乱的时候我帮你守住节奏。先做一小步，剩下的我陪你排。',
  crisis: '我一直在。先确认你现在是安全的，然后我们一起联系能马上帮你的人。',
  neutral: '我在。你想说就说，不想说我们就安静待一会儿。',
}

const CrisisActionSelf = '先确认当下安全，并联系身边可信任的人或当地紧急援助（110 / 120），不要独自处理。'
const CrisisActionSelfImminent = '如果已经在行动或受伤，请立刻拨打当地急救电话（110 / 120），并让身边可信任的人陪着你。'
const CrisisActionOther = '先与对方拉开距离并保证彼此安全，联系当地紧急援助（110 / 120），不要独自处理。'
const CrisisActionOtherImminent = '立刻拨打当地紧急援助（110 / 120），先保证你与对方的安全，不要独自前往。'

/* ------------------------------------------------------------------------- *
 * Numeric and text limits
 * ------------------------------------------------------------------------- */

/** The opening of a prompt carries the emotional register; bound the scan. */
const MaxAnalysisLength = 4000
/** A clause at most this long can be an explicit intent without a pronoun. */
const ShortClauseLength = 12
/** How far before a marker a negator may sit. */
const NegationWindow = 8
/** Sentence stops: discussion and imminence are judged per sentence. */
const SentenceStop = /[。！？!?；;\n\r]/
/** Clause stops: person references are judged per comma-level clause. */
const ClauseStop = /[。！？!?；;\n\r，,]/

/* ------------------------------------------------------------------------- *
 * Marker matching
 * ------------------------------------------------------------------------- */

export function isEmotionLabel(value: unknown): value is EmotionLabel {
  return typeof value === 'string' && (EmotionLabelValues as readonly string[]).includes(value)
}

function escapeRegExp(content: string): string {
  return content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** ASCII markers are matched on word boundaries; CJK markers are literal. */
function markerRegex(marker: string): RegExp {
  const escaped = escapeRegExp(marker)
  const ascii = /^[\x20-\x7e]+$/.test(marker)
  return ascii ? new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi') : new RegExp(escaped, 'gi')
}

interface Span {
  start: number
  end: number
}

function markerSpans(content: string, marker: string): Span[] {
  if (marker.length === 0) return []
  const spans: Span[] = []
  const regex = markerRegex(marker)
  for (;;) {
    const match = regex.exec(content)
    if (match === null) break
    spans.push({ start: match.index, end: match.index + match[0].length })
    if (match[0].length === 0) regex.lastIndex += 1
  }
  return spans
}

function hasMarker(content: string, markers: readonly string[]): boolean {
  return markers.some(marker => markerSpans(content, marker).length > 0)
}

function hitsOf(content: string, markers: readonly string[]): number {
  let total = 0
  for (const marker of markers) total += markerSpans(content, marker).length
  return total
}

function unique(values: readonly string[]): string[] {
  const result: string[] = []
  for (const value of values) {
    if (value.length > 0 && !result.includes(value)) result.push(value)
  }
  return result
}

/** Text of the clause around `index`, bounded by sentence and comma stops. */
function clauseAt(content: string, index: number): string {
  let start = index
  while (start > 0 && !ClauseStop.test(content[start - 1] ?? '')) start -= 1
  let end = index
  while (end < content.length && !ClauseStop.test(content[end] ?? '')) end += 1
  return content.slice(start, end)
}

/** Text of the sentence around `index`, bounded by sentence stops only. */
function sentenceAt(content: string, index: number): string {
  let start = index
  while (start > 0 && !SentenceStop.test(content[start - 1] ?? '')) start -= 1
  let end = index
  while (end < content.length && !SentenceStop.test(content[end] ?? '')) end += 1
  return content.slice(start, end)
}

const QuotePairs: ReadonlyArray<readonly [string, string]> = [
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ['‘', '’'],
  ['"', '"'],
]

/** Spans of quoted speech; a statement inside one is reported, not intent. */
function quotedSpans(content: string): Span[] {
  const spans: Span[] = []
  for (const [open, close] of QuotePairs) {
    let from = 0
    for (;;) {
      const start = content.indexOf(open, from)
      if (start < 0) break
      const closeAt = content.indexOf(close, start + open.length)
      if (closeAt < 0) break
      const end = closeAt + close.length
      spans.push({ start, end })
      from = end
    }
  }
  return spans
}

function insideSpan(index: number, spans: readonly Span[]): boolean {
  return spans.some(span => index >= span.start && index < span.end)
}

function negatedBefore(content: string, index: number): boolean {
  const before = content.slice(Math.max(0, index - NegationWindow), index).toLowerCase()
  if (before.trim().length === 0) return false
  return NegationSuffix.some(suffix => {
    const lower = suffix.toLowerCase()
    return before.endsWith(lower) || before.endsWith(`${lower} `) || before.endsWith(`${lower}　`)
  })
}

/** `自杀率` measures a phenomenon; it is not an intent. */
function followedByMeasure(content: string, end: number): boolean {
  const after = content.slice(end, end + 2)
  return after.startsWith('率')
}

/* ------------------------------------------------------------------------- *
 * Reading
 * ------------------------------------------------------------------------- */

interface CrisisHit {
  family: 'self' | 'other'
  marker: string
  imminent: boolean
}

interface EmotionReading {
  label: EmotionLabel
  intensity: number
  empathy: string
  crisis: CrisisHit[]
}

/**
 * Explicit crises only. Every veto in the module header is applied here, so
 * `detect` and `crisis` never disagree about the same prompt.
 */
function crisisHits(content: string): CrisisHit[] {
  const spans = quotedSpans(content)
  const hits: CrisisHit[] = []
  const consider = (family: CrisisHit['family'], markers: readonly string[]): void => {
    for (const marker of markers) {
      for (const span of markerSpans(content, marker)) {
        if (insideSpan(span.start, spans)) continue
        if (negatedBefore(content, span.start)) continue
        if (followedByMeasure(content, span.end)) continue
        const sentence = sentenceAt(content, span.start)
        if (hasMarker(sentence, DiscussionMarker)) continue
        const clause = clauseAt(content, span.start)
        if (family === 'self') {
          if (hasMarker(clause, OtherPersonMarker)) continue
          if (clause.trim().length > ShortClauseLength && !hasMarker(clause, FirstPersonMarker)) continue
        } else if (!hasMarker(clause, HarmTargetMarker)) {
          continue
        }
        hits.push({ family, marker, imminent: hasMarker(sentence, ImminenceMarker) })
      }
    }
  }
  consider('self', SelfHarmMarker)
  consider('other', HarmOtherMarker)
  return hits
}

/**
 * The deterministic reading of one prompt: a label, an intensity in [0, 1], one
 * short empathy line, and the surviving crisis hits (if any).
 *
 * Intensity reuses the stage-one formula, so the persisted value and the
 * comprehension stage output agree for the same prompt.
 */
function readEmotion(prompt: string): EmotionReading {
  const content = prompt.slice(0, MaxAnalysisLength).toLowerCase()
  const crisis = crisisHits(content)
  const positiveHits = hitsOf(content, PositiveMarker)
  const negativeHits = hitsOf(content, NegativeMarker)
  const worryHits = hitsOf(content, WorryMarker)
  const angerHits = hitsOf(content, AngerMarker)
  const sadnessHits = hitsOf(content, SadnessMarker)
  const urgencyHits = hitsOf(content, UrgencyMarker)
  const emotionHits = positiveHits + negativeHits + worryHits + angerHits + sadnessHits
  const exclamations = (content.match(/[!！]/g) ?? []).length

  let intensity = 0.12 + 0.08 * Math.min(emotionHits, 6) + 0.06 * Math.min(urgencyHits, 4) + 0.05 * Math.min(exclamations, 3)
  if (crisis.length > 0) {
    intensity = Math.max(intensity, 0.65) + 0.03 * Math.min(crisis.length, 3)
  }

  let label: EmotionLabel = 'neutral'
  if (crisis.length > 0) {
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
    crisis,
  }
}

/** Deterministic pace for an empathy profile: slower as intensity rises. */
function paceOf(intensity: number): string {
  if (intensity >= 0.7) return '放慢，一次只说一件事'
  if (intensity >= 0.4) return '放缓，先确认再推进'
  return '自然的对话节奏'
}

/* ------------------------------------------------------------------------- *
 * Row mappers (row.ts covers the v23 shared entities only)
 * ------------------------------------------------------------------------- */

function mapEmotion(row: Row): Emotion {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    label: text(row, 'label', 'neutral'),
    intensity: number(row, 'intensity'),
    ...(row.empathy === null || row.empathy === undefined ? {} : { empathy: text(row, 'empathy') }),
    created: number(row, 'created'),
  }
}

function mapCompanion(row: Row): Companion {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    session: number(row, 'session'),
    emotion: number(row, 'emotion'),
    response: text(row, 'response'),
    created: number(row, 'created'),
  }
}

function mapCrisis(row: Row): Crisis {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    severity: text(row, 'severity', 'high') as Crisis['severity'],
    signal: text(row, 'signal'),
    action: text(row, 'action'),
    created: number(row, 'created'),
  }
}

/* ------------------------------------------------------------------------- *
 * Guards
 * ------------------------------------------------------------------------- */

function requireIdentity(value: unknown, kind: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentError(`${kind} must be a positive integer identity`, { [kind]: value })
  }
  return value
}

function requirePrompt(value: unknown): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError('prompt must be a string when present', { prompt: value })
  }
  return value
}

/* ------------------------------------------------------------------------- *
 * Module
 * ------------------------------------------------------------------------- */

export class EmotionModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  /**
   * Read the prompt of one turn and append one `emotion` row.
   *
   * When `prompt` is omitted the turn's prompt row is read: the pointer first,
   * then the latest prompt of the turn (a fixture or a command-mode turn may
   * not have wired the pointer). A turn with no prompt reads as `neutral`.
   */
  detect(turn: number, prompt?: string): Emotion {
    const row = this.turnRow(turn)
    const turnIdentity = number(row, 'identity')
    const content = prompt === undefined ? this.promptOf(turnIdentity, row) : requirePrompt(prompt)
    const reading = readEmotion(content)
    const identity = this.host.db.insert('emotion', {
      handle: this.host.handles.next('emotion'),
      turn: turnIdentity,
      label: reading.label,
      intensity: reading.intensity,
      empathy: reading.empathy,
      created: this.host.clock.now(),
    })
    return mapEmotion(this.host.db.require<Row>('emotion', identity, 'emotion'))
  }

  /**
   * The deterministic empathy profile for one reading: tone, pace and boundary.
   * Pure — it writes nothing, because a profile is a way of answering rather
   * than a record. An unreadable label falls back to the neutral profile
   * instead of throwing: the profile is copy, not data.
   */
  empathy(emotion: Emotion): EmpathyProfile {
    if (typeof emotion !== 'object' || emotion === null) {
      throw new InvalidArgumentError('emotion must be an Emotion value', { emotion })
    }
    const label = isEmotionLabel(emotion.label) ? emotion.label : 'neutral'
    const intensity = typeof emotion.intensity === 'number' && Number.isFinite(emotion.intensity)
      ? clamp(emotion.intensity, 0, 1)
      : 0.5
    return {
      tone: ToneCopy[label],
      pace: paceOf(intensity),
      boundary: BoundaryCopy[label],
    }
  }

  /**
   * The explicit crisis of one turn, or null.
   *
   * Idempotent per turn: an existing row wins, so a stage and a service call
   * cannot record the same escalation twice. `null` means "nothing explicit
   * enough was said", which is also the answer for every ambiguous prompt.
   */
  crisis(turn: number): Crisis | null {
    const row = this.turnRow(turn)
    const turnIdentity = number(row, 'identity')
    const existing = this.host.db.get<Row>(
      'SELECT * FROM crisis WHERE turn = ? ORDER BY identity DESC LIMIT 1',
      turnIdentity,
    )
    if (existing !== undefined) return mapCrisis(existing)
    const reading = readEmotion(this.promptOf(turnIdentity, row))
    if (reading.crisis.length === 0) return null
    const imminent = reading.crisis.some(hit => hit.imminent)
    const self = reading.crisis.some(hit => hit.family === 'self')
    const severity: Crisis['severity'] = imminent ? 'critical' : 'high'
    const action = self
      ? imminent
        ? CrisisActionSelfImminent
        : CrisisActionSelf
      : imminent
        ? CrisisActionOtherImminent
        : CrisisActionOther
    const identity = this.host.db.insert('crisis', {
      handle: this.host.handles.next('crisis'),
      turn: turnIdentity,
      severity,
      signal: unique(reading.crisis.map(hit => hit.marker)).join(', '),
      action,
      created: this.host.clock.now(),
    })
    return mapCrisis(this.host.db.require<Row>('crisis', identity, 'crisis'))
  }

  /**
   * Append one companion row for sustained support.
   *
   * A companion answers the latest emotion of the turn; when the turn has not
   * been read yet, the reading is taken first. One supportive line is appended
   * per call, so the UI can always show the newest one.
   */
  companion(turn: number): Companion {
    const row = this.turnRow(turn)
    const turnIdentity = number(row, 'identity')
    const session = number(row, 'session')
    const latest = this.host.db.get<Row>(
      'SELECT * FROM emotion WHERE turn = ? ORDER BY identity DESC LIMIT 1',
      turnIdentity,
    )
    const emotion = latest === undefined ? this.detect(turnIdentity) : mapEmotion(latest)
    const label = isEmotionLabel(emotion.label) ? emotion.label : 'neutral'
    const identity = this.host.db.insert('companion', {
      handle: this.host.handles.next('companion'),
      session,
      emotion: emotion.identity,
      response: CompanionCopy[label],
      created: this.host.clock.now(),
    })
    return mapCompanion(this.host.db.require<Row>('companion', identity, 'companion'))
  }

  /** Every emotion row of one turn, oldest first (the audit order). */
  list(turn: number): Emotion[] {
    const row = this.turnRow(turn)
    return this.host.db
      .all<Row>('SELECT * FROM emotion WHERE turn = ? ORDER BY identity ASC', number(row, 'identity'))
      .map(mapEmotion)
  }

  /* ----------------------------------------------------------------------- *
   * Internals
   * ----------------------------------------------------------------------- */

  private turnRow(turn: number): Row {
    const turnIdentity = requireIdentity(turn, 'turn')
    const row = this.host.db.get<Row>('SELECT * FROM turn WHERE identity = ?', turnIdentity)
    if (row === undefined) throw new NotFoundError('turn', turnIdentity)
    return row
  }

  /** The prompt content of one turn: pointer first, then the latest row. */
  private promptOf(turnIdentity: number, row: Row): string {
    const pointer = optionalNumber(row, 'prompt')
    if (pointer !== undefined) {
      const prompt = this.host.db.get<Row>('SELECT content FROM prompt WHERE identity = ?', pointer)
      if (prompt !== undefined) return text(prompt, 'content')
    }
    const latest = this.host.db.get<Row>(
      'SELECT content FROM prompt WHERE turn = ? ORDER BY identity DESC LIMIT 1',
      turnIdentity,
    )
    return latest === undefined ? '' : text(latest, 'content')
  }
}
