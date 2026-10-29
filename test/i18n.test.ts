/**
 * Locale copy audit (v24 §22, `docs/ui-copy-v24.md` §4.6).
 *
 * These tests are the guard rail for the two-language dictionary: they prove
 * that the keys are balanced, that nothing is left empty or untranslated, that
 * every tooltip stays inside the documented length budget, that the settings
 * page really carries six groups and 24 explained rows, that no v23 mechanism
 * jargon survived, and that the defaults the page shows are values it could
 * actually read (never a hardcoded 执行/Execution).
 *
 * The test imports only shared modules; it never needs React or a DSH host.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COPY_BY_LOCALE,
  DEFAULT_LOCALE,
  LOCALES,
  SETTINGS_CHIP_IDS,
  SETTINGS_FIELD_IDS,
  SETTINGS_GROUP_IDS,
  copyFor,
  fillTemplate,
  normaliseLocale,
} from '../src/shared/i18n.js'
import type { Copy, Locale, SettingsFieldId } from '../src/shared/i18n.js'
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
} from '../src/shared/enum.js'
import type { CoordinationErrorCode } from '../src/shared/error.js'
import { buildQuestionAnswers, isQuestionAnswerComplete } from '../src/client/bridge.js'
import {
  COMPACTION_THRESHOLD_MAX,
  COMPACTION_THRESHOLD_MIN,
  COMPACTION_THRESHOLD_OPTIONS,
  compactionPercent,
  compactionRatio,
  isValidCompactionThreshold,
} from '../src/client/bridge.js'
import type { QuestionSelection, TakeoverQuestionView } from '../src/client/bridge.js'

const CONTROL_NAMES = ['profession', 'interaction', 'scene', 'validation', 'permission'] as const
const TOOL_NAMES = [
  'coordination_selection',
  'coordination_profession',
  'coordination_profession_lock',
] as const
const ERROR_CODES: readonly CoordinationErrorCode[] = [
  'PROFESSION_LOCKED',
  'PROFESSION_REQUIRED',
  'NOT_FOUND',
  'INVALID_STATE',
  'INVALID_ARGUMENT',
  'ORCHESTRATION',
  'VERIFICATION',
  'TAKEOVER',
  'PERMISSION',
  'DATABASE',
  'CONFIG',
  'UPSTREAM',
  'NOT_IMPLEMENTED',
  'BUSY',
  'UNSUPPORTED_MEDIA',
]
const REQUIRED_COMPOSER_KEYS = [
  'currentLabel',
  'controlTitle',
  'controlAria',
  'lockedAria',
  'optionAria',
  'lockedLine',
  'unlockedLine',
  'offlineLine',
  'localOnly',
  'permissionCatalogMissing',
  'permissionApplyFailed',
  'permissionOffline',
  'permissionWriteNow',
  'permissionPresetDefault',
  'customPreset',
  'approvalPolicy',
  'permissionFollowHint',
  'followDsh',
  'followDshMode',
  'loadingSelection',
  'professionLocked',
  'professionLockedRebuild',
  'requestFailed',
  'invalidSelection',
  'validationNote',
  'permissionConfirmTitle',
  'permissionConfirmBody',
  'permissionConfirmAccept',
  'permissionConfirmCancel',
  'escalationCurrent',
  'escalationRequested',
  'escalationRebuild',
  'escalationAbandon',
  'escalationUnsupported',
] as const

/** The five rows the operator can change locally (v24 §3.2). */
const EDITABLE_FIELDS: readonly SettingsFieldId[] = [
  'takeoverPermission',
  'composerWorkflow',
  'composerTooltips',
  'compact',
  'refreshInterval',
]
/** The three forced rows: no off switch exists (v24 §3.2). */
const FORCED_FIELDS: readonly SettingsFieldId[] = [
  'professionLock',
  'professionRebuild',
  'professionAbandon',
]
/** The two host-backed editable rows (auto-compaction). */
const HOST_EDITABLE_FIELDS: readonly SettingsFieldId[] = ['autoCompact', 'compactionThreshold']
/** The fifteen host-config rows. */
const HOST_FIELDS: readonly SettingsFieldId[] = [
  'takeoverDialogs',
  'professionDefault',
  'professionAudit',
  'professionErrorHint',
  'defaultScene',
  'defaultValidation',
  'defaultInteraction',
  'writingFlow',
  'defaultLocale',
  'hardPrune',
  'reserve',
  'cacheEnabled',
  'webSearch',
  'groundTruth',
  'modelRouting',
]
/** The three derived/runtime rows. */
const DERIVED_FIELDS: readonly SettingsFieldId[] = ['takeoverControl', 'permissionCatalog', 'currentLocale']
/** The service-level takeover dialog's copy keys (v24 §16). */
const TAKEOVER_KEYS = [
  'title',
  'approvalTitle',
  'questionTitle',
  'allowOnce',
  'reject',
  'cancel',
  'submit',
  'customPlaceholder',
  'expired',
  'hostError',
  'queueLabel',
] as const

interface Leaf {
  path: string
  value: string
}

/** Flatten a copy object into `path -> string` leaves for parity checks. */
function flatten(value: unknown, prefix = ''): Leaf[] {
  if (typeof value === 'string') return [{ path: prefix, value }]
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => flatten(entry, `${prefix}[${index}]`))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) =>
      flatten(entry, prefix === '' ? key : `${prefix}.${key}`),
    )
  }
  return [{ path: prefix, value: String(value) }]
}

function leaves(locale: Locale): Leaf[] {
  return flatten(copyFor(locale)).sort((left, right) => left.path.localeCompare(right.path))
}

function leafMap(locale: Locale): Map<string, string> {
  return new Map(leaves(locale).map((leaf) => [leaf.path, leaf.value]))
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}

/** v24 §1.3: Chinese counts Unicode code points, English counts characters. */
function measure(locale: Locale, value: string): number {
  return locale === 'zh-CN' ? Array.from(value).length : value.length
}

function assertBudget(locale: Locale, path: string, value: string, zhMax: number, enMax: number): void {
  const limit = locale === 'zh-CN' ? zhMax : enMax
  assert.ok(
    measure(locale, value) <= limit,
    `${locale}:${path} is ${measure(locale, value)} long, budget ${limit}: "${value}"`,
  )
}

function expectCjk(value: string): void {
  assert.match(value, /[\u4e00-\u9fff]/, `expected Chinese text, got "${value}"`)
}

function expectLatin(value: string): void {
  assert.match(value, /[A-Za-z]/, `expected English text, got "${value}"`)
}

/* ------------------------------------------------------------------------- *
 * Key parity and non-empty copy
 * ------------------------------------------------------------------------- */

test('both locales expose exactly the same non-empty copy keys', () => {
  const zh = leaves('zh-CN')
  const en = leaves('en-US')
  assert.deepEqual(
    en.map((leaf) => leaf.path),
    zh.map((leaf) => leaf.path),
    'zh-CN and en-US must ship identical copy keys',
  )

  for (const locale of LOCALES) {
    for (const leaf of leaves(locale)) {
      assert.equal(typeof leaf.value, 'string', `${locale}:${leaf.path} must be a string`)
      assert.ok(leaf.value.trim().length > 0, `${locale}:${leaf.path} must not be empty`)
      assert.doesNotMatch(leaf.value, /\bTODO\b|lorem ipsum/i, `${locale}:${leaf.path} is a placeholder`)
    }
  }
})

test('templates keep the same placeholders in both languages', () => {
  const zh = leafMap('zh-CN')
  const en = leafMap('en-US')
  for (const [path, value] of zh) {
    assert.deepEqual(
      placeholders(en.get(path) ?? ''),
      placeholders(value),
      `${path} must use the same {placeholders} in both locales`,
    )
  }
})

test('English is translated rather than copied, except budgets and language names', () => {
  const zh = leafMap('zh-CN')
  const en = leafMap('en-US')
  // These are deliberately identical: numeric budgets and the two endonyms.
  const identical = new Set([
    'settings.values.chinese',
    'settings.values.english',
  ])
  for (const [path, value] of zh) {
    if (path.endsWith('.budget') || identical.has(path)) continue
    assert.notEqual(en.get(path), value, `${path} is identical in both locales`)
  }
})

test('the default locale is zh-CN and unknown host tags fall back to it', () => {
  assert.equal(DEFAULT_LOCALE, 'zh-CN')
  assert.deepEqual([...LOCALES], ['zh-CN', 'en-US'])
  assert.equal(COPY_BY_LOCALE['zh-CN'], copyFor('zh-CN'))
  assert.equal(copyFor('zh-CN'), copyFor('zh-CN'), 'copy references must be stable per locale')

  const cases: Array<[unknown, Locale]> = [
    ['zh', 'zh-CN'],
    ['zh-CN', 'zh-CN'],
    ['zh-TW', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['ZH', 'zh-CN'],
    ['en', 'en-US'],
    ['en-US', 'en-US'],
    ['en-GB', 'en-US'],
    ['EN-us', 'en-US'],
    ['fr-FR', 'zh-CN'],
    ['de', 'zh-CN'],
    ['', 'zh-CN'],
    ['   ', 'zh-CN'],
    [undefined, 'zh-CN'],
    [null, 'zh-CN'],
    [42, 'zh-CN'],
    [{}, 'zh-CN'],
    [[], 'zh-CN'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(normaliseLocale(input), expected, `normaliseLocale(${String(input)})`)
  }
})

/* ------------------------------------------------------------------------- *
 * Labels stay the doc projection; hints are the v24 copy
 * ------------------------------------------------------------------------- */

test('zh-CN labels equal the enum label projection', () => {
  const copy: Copy = copyFor('zh-CN')
  for (const name of CONTROL_NAMES) {
    assert.equal(copy.controls[name].label, ControlLabel[name], `controls.${name}.label`)
    expectCjk(copy.controls[name].label)
  }
  for (const value of ProfessionValues) {
    assert.equal(copy.professions[value].label, ProfessionLabel[value], `professions.${value}.label`)
  }
  for (const value of InteractionValues) {
    assert.equal(copy.interactions[value].label, InteractionLabel[value], `interactions.${value}.label`)
  }
  for (const value of SceneValues) {
    assert.equal(copy.scenes[value].label, SceneLabel[value], `scenes.${value}.label`)
  }
  for (const level of ValidationValues) {
    assert.equal(copy.validations[level].label, ValidationLabel[level], `validations.${level}.label`)
  }
  for (const mode of SandboxModeValues) {
    assert.equal(copy.permissions[mode].label, PermissionLabel[mode], `permissions.${mode}.label`)
  }
})

test('scene order keeps writing between dialogue and office', () => {
  assert.deepEqual(
    [...SceneValues],
    ['dialogue', 'writing', 'office', 'research', 'engineering', 'iterate'],
  )
  for (const locale of LOCALES) {
    const copy = copyFor(locale)
    assert.deepEqual(Object.keys(copy.scenes), [...SceneValues], `${locale}: scene key order`)
    assert.deepEqual(Object.keys(copy.controls), [...CONTROL_NAMES], `${locale}: control order`)
  }
})

/* ------------------------------------------------------------------------- *
 * Tooltip budget: 5 controls + 23 options (v24 §2.5)
 * ------------------------------------------------------------------------- */

test('the five control tooltips and 23 option tooltips stay within budget', () => {
  for (const locale of LOCALES) {
    const copy = copyFor(locale)
    for (const name of CONTROL_NAMES) {
      assertBudget(locale, `controls.${name}.hint`, copy.controls[name].hint, 90, 160)
    }
    const optionGroups: Array<[string, string]> = [
      ...ProfessionValues.map((value): [string, string] => [`professions.${value}.hint`, copy.professions[value].hint]),
      ...InteractionValues.map((value): [string, string] => [`interactions.${value}.hint`, copy.interactions[value].hint]),
      ...SceneValues.map((value): [string, string] => [`scenes.${value}.hint`, copy.scenes[value].hint]),
      ...ValidationValues.map((value): [string, string] => [`validations.${value}.hint`, copy.validations[value].hint]),
      ...SandboxModeValues.map((value): [string, string] => [`permissions.${value}.hint`, copy.permissions[value].hint]),
    ]
    assert.equal(optionGroups.length, 23, `${locale}: 6 + 5 + 6 + 3 + 3 option tooltips`)
    for (const [path, value] of optionGroups) {
      assert.ok(value.trim().length > 0, `${locale}:${path}`)
      assertBudget(locale, path, value, 70, 120)
    }
  }
})

/* ------------------------------------------------------------------------- *
 * v24 writing scene and all-level search
 * ------------------------------------------------------------------------- */

test('scene copy names the writing scene in both locales', () => {
  const zh = copyFor('zh-CN')
  const en = copyFor('en-US')
  assert.equal(zh.scenes.writing.label, '写作')
  assert.equal(en.scenes.writing.label, 'Writing')
  expectCjk(zh.scenes.writing.hint)
  expectLatin(en.scenes.writing.hint)
  assert.match(zh.scenes.writing.hint, /提纲/)
  assert.match(zh.scenes.writing.hint, /3 轮/)
  assert.match(en.scenes.writing.hint, /3 rounds/i)
  assert.match(en.scenes.writing.hint, /outline/i)
})

test('validation copy states 1×3 / 2×5 / 4×8 and that all levels search', () => {
  const budget: Record<string, string> = { low: '1×3', medium: '2×5', high: '4×8' }
  // v24 §4.4 spells the budget out in prose inside the hint ("1 次 × 3 条" /
  // "1 query × 3 results"); the compact token lives in budget/note/helper copy.
  const spelledZh: Record<string, string> = { low: '1 次 × 3 条', medium: '2 次 × 5 条', high: '4 次 × 8 条' }
  const spelledEn: Record<string, string> = {
    low: '1 query × 3 results',
    medium: '2 queries × 5 results',
    high: '4 queries × 8 results',
  }
  const scopeZh: Record<string, RegExp> = { low: /当轮/, medium: /当前会话/, high: /本地全部/ }
  const scopeEn: Record<string, RegExp> = { low: /this turn/i, medium: /this session/i, high: /all local content/i }

  for (const locale of LOCALES) {
    const copy = copyFor(locale)
    for (const level of ValidationValues) {
      const entry = copy.validations[level]
      assert.equal(entry.budget, budget[level], `${locale}:validations.${level}.budget`)
      assert.ok(
        entry.hint.includes(locale === 'zh-CN' ? spelledZh[level] : spelledEn[level]),
        `${locale}:${level} hint must spell out ${budget[level]}`,
      )
      assert.match(
        entry.hint,
        locale === 'zh-CN' ? /联网/ : /search/i,
        `${locale}:${level} must say it searches the web`,
      )
    }
    assert.match(copy.validations.low.scope, locale === 'zh-CN' ? scopeZh.low : scopeEn.low)
    assert.match(copy.validations.medium.scope, locale === 'zh-CN' ? scopeZh.medium : scopeEn.medium)
    assert.match(copy.validations.high.scope, locale === 'zh-CN' ? scopeZh.high : scopeEn.high)
  }

  // The fixed note repeats all three budgets and the all-level policy.
  const zhNote = copyFor('zh-CN').composer.validationNote
  const enNote = copyFor('en-US').composer.validationNote
  for (const token of ['1×3', '2×5', '4×8']) {
    assert.ok(zhNote.includes(token), `zh validationNote must state ${token}`)
    assert.ok(enNote.includes(token), `en validationNote must state ${token}`)
  }
  assert.match(zhNote, /三档/)
  assert.match(zhNote, /联网/)
  assert.match(enNote, /all three levels/i)
  assert.match(enNote, /search/i)
})

test('no v23 mechanism jargon or "low does no inference" copy survives', () => {
  /*
   * v24 §4.2 bans "证据范围", but the mandated validation control tooltip in
   * §5.2 says "只差检索量和证据范围". The tooltip table is the more specific
   * instruction and requirement 2 says to copy it verbatim, so the phrase is
   * allowed in that one string; every other v23 mechanism term stays banned.
   */
  const allowedEvidenceScope = new Set(['controls.validation.hint'])
  const banned = /贝叶斯|先验|后验|检索预算|问责轴|问责维度|哈希链|治理轨迹|编排|派发|沙箱|幂等|快照|能力资格|\bMCP\b|\bProvider\b|\bToken\b|fail-closed|Bayesian|prior\/posterior|hash chain|sandbox|idempotent|orchestrat(e|ion) (trace|chain)/i
  for (const locale of LOCALES) {
    for (const leaf of flatten(copyFor(locale))) {
      // `tools.*` is model-facing copy and explicitly out of scope (v24 §4.2).
      if (leaf.path.startsWith('tools.')) continue
      assert.doesNotMatch(leaf.value, banned, `${locale}:${leaf.path} uses banned jargon: "${leaf.value}"`)
      if (!allowedEvidenceScope.has(leaf.path)) {
        assert.doesNotMatch(
          leaf.value,
          /证据范围/,
          `${locale}:${leaf.path} uses the banned phrase 证据范围`,
        )
      }
      assert.doesNotMatch(
        leaf.value,
        /low\s*(不做|does not|doesn't).*(推断|infer)|不做贝叶斯/i,
        `${locale}:${leaf.path} repeats the stale low/no-inference claim`,
      )
    }
  }
})

/* ------------------------------------------------------------------------- *
 * Runtime copy: lock / offline / rejection / confirm / escalation
 * ------------------------------------------------------------------------- */

test('composer runtime copy covers lock, offline, rejection, confirm and escalation lines', () => {
  for (const locale of LOCALES) {
    const copy = copyFor(locale)
    for (const key of REQUIRED_COMPOSER_KEYS) {
      assert.ok(copy.composer[key].trim().length > 0, `${locale}:composer.${key}`)
      assertBudget(locale, `composer.${key}`, copy.composer[key], 70, 120)
    }
    // Interpolated lines must resolve completely.
    const current = copy.professions.execution.label
    const currentLine = fillTemplate(copy.composer.escalationCurrent, { profession: current })
    assert.ok(currentLine.includes(current))
    assert.doesNotMatch(currentLine, /\{\w+\}/)
    const requestedLine = fillTemplate(copy.composer.escalationRequested, { profession: current })
    assert.ok(requestedLine.includes(current))
    const lockedAria = fillTemplate(copy.composer.lockedAria, {
      control: copy.controls.profession.label,
      currentLabel: copy.composer.currentLabel,
      current,
      explanation: copy.composer.lockedLine,
    })
    assert.ok(lockedAria.includes(copy.composer.lockedLine))
    assert.doesNotMatch(lockedAria, /\{\w+\}/)
    const approval = fillTemplate(copy.composer.approvalPolicy, { approval: 'on-request' })
    assert.ok(approval.includes('on-request'))
    const follow = fillTemplate(copy.composer.followDshMode, { mode: copy.permissions['read-only'].label })
    assert.ok(follow.includes(copy.permissions['read-only'].label))
  }

  // The doc strings the v24 document fixes word-for-word.
  const zh = copyFor('zh-CN')
  assert.equal(zh.composer.lockedLine, '任务已开始，职能锁定；完成或新建任务后可改。')
  assert.equal(zh.composer.offlineLine, '主机未连接；这里的选择只存本机，不影响任务。')
  assert.equal(zh.composer.professionLocked, '职能已锁定，改动没有生效。')
  assert.equal(zh.composer.invalidSelection, '这个选项无效，已恢复原选择。')
  assert.equal(zh.composer.requestFailed, '主机拒绝了这次修改，已恢复原选择。')
  assert.equal(zh.composer.permissionConfirmTitle, '完全权限需要再次确认')
  assert.equal(zh.composer.escalationRebuild, '重建任务')
  assert.equal(zh.composer.escalationAbandon, '丢弃任务')
  // The escalation dialog's 取消 reuses this key; one word, one copy.
  assert.equal(zh.composer.permissionConfirmCancel, '取消')
  assert.match(zh.composer.escalationUnsupported, /升级插件/)
  assert.match(zh.composer.professionLockedRebuild, /重建或丢弃/)
  assert.match(zh.composer.permissionConfirmBody, /完全权限/)
  assert.match(zh.composer.permissionConfirmBody, /工作区/)

  const en = copyFor('en-US')
  assert.match(en.composer.professionLockedRebuild, /rebuild/i)
  assert.match(en.composer.professionLockedRebuild, /abandon/i)
  assert.match(en.composer.escalationUnsupported, /upgrade/i)
  assert.match(en.composer.permissionConfirmTitle, /confirm/i)
  assert.match(en.composer.offlineLine, /on this device only/i)
})

/* ------------------------------------------------------------------------- *
 * Settings: seven groups, 28 rows, honest roles
 * ------------------------------------------------------------------------- */

test('settings copy ships seven ordered groups with titles, descriptions and helpers', () => {
  assert.deepEqual(
    [...SETTINGS_GROUP_IDS],
    ['permission', 'composer', 'profession', 'scene', 'language', 'compaction', 'advanced'],
  )
  const zhTitles: Record<string, string> = {
    permission: '权限与接管',
    composer: '工作流与下拉框',
    profession: '职能与审计',
    scene: '情景与验证默认',
    language: '语言与显示',
    compaction: '自动压缩',
    advanced: '高级',
  }
  for (const locale of LOCALES) {
    const settings = copyFor(locale).settings
    assert.deepEqual(Object.keys(settings.groups), [...SETTINGS_GROUP_IDS], `${locale}: group order`)
    for (const id of SETTINGS_GROUP_IDS) {
      const group = settings.groups[id]
      assert.ok(group.title.trim().length > 0, `${locale}:groups.${id}.title`)
      assert.ok(group.desc.trim().length > 0, `${locale}:groups.${id}.desc`)
      assert.ok(group.helper.trim().length > 0, `${locale}:groups.${id}.helper`)
      assertBudget(locale, `groups.${id}.title`, group.title, 12, 30)
      assertBudget(locale, `groups.${id}.desc`, group.desc, 70, 120)
      assertBudget(locale, `groups.${id}.helper`, group.helper, 70, 120)
    }
  }
  assert.equal(copyFor('zh-CN').settings.groups.permission.title, zhTitles.permission)
  assert.equal(copyFor('zh-CN').settings.groups.composer.title, zhTitles.composer)
  assert.equal(copyFor('zh-CN').settings.groups.profession.title, zhTitles.profession)
  assert.equal(copyFor('zh-CN').settings.groups.scene.title, zhTitles.scene)
  assert.equal(copyFor('zh-CN').settings.groups.language.title, zhTitles.language)
  assert.equal(copyFor('zh-CN').settings.groups.compaction.title, zhTitles.compaction)
  assert.equal(copyFor('zh-CN').settings.groups.advanced.title, zhTitles.advanced)
  // No v23 leftovers: a flat takeover/workflow/professionGroup layout is gone.
  assert.equal(Object.hasOwn(copyFor('zh-CN').settings, 'professionGroup'), false)
  assert.equal(Object.hasOwn(copyFor('zh-CN').settings, 'takeover'), false)
  assert.equal(Object.hasOwn(copyFor('zh-CN').settings, 'workflow'), false)
})

test('settings copy ships all 28 explained rows within budget', () => {
  assert.equal(SETTINGS_FIELD_IDS.length, 28)
  for (const locale of LOCALES) {
    const settings = copyFor(locale).settings
    assert.deepEqual(Object.keys(settings.fields), [...SETTINGS_FIELD_IDS], `${locale}: field order`)
    for (const id of SETTINGS_FIELD_IDS) {
      const field = settings.fields[id]
      assert.ok(field.label.trim().length > 0, `${locale}:fields.${id}.label`)
      assert.ok(field.hint.trim().length > 0, `${locale}:fields.${id}.hint`)
      assertBudget(locale, `fields.${id}.label`, field.label, 12, 32)
      assertBudget(locale, `fields.${id}.hint`, field.hint, 70, 120)
    }
    assertBudget(locale, 'settings.whyLock', settings.whyLock, 200, 320)
    assertBudget(locale, 'settings.intro', settings.intro, 70, 120)
    assertBudget(locale, 'settings.applyNote', settings.applyNote, 70, 120)
    assertBudget(locale, 'settings.footer', settings.footer, 70, 160)
    assertBudget(locale, 'settings.title', settings.title, 10, 20)
  }
})

test('settings rows are honest: forced rows say forced and defaults never hardcode a value', () => {
  // 5 local + 2 host-editable + 3 forced + 15 host + 3 derived = 28, no duplicates.
  const all = [
    ...EDITABLE_FIELDS,
    ...HOST_EDITABLE_FIELDS,
    ...FORCED_FIELDS,
    ...HOST_FIELDS,
    ...DERIVED_FIELDS,
  ]
  assert.equal(all.length, 28)
  assert.equal(new Set(all).size, 28)
  assert.deepEqual([...all].sort(), [...SETTINGS_FIELD_IDS].sort())

  for (const locale of LOCALES) {
    const settings = copyFor(locale).settings
    // The group's safety constraint is stated once, on the lock row itself.
    assert.match(
      settings.fields.professionLock.hint,
      locale === 'zh-CN' ? /强制/ : /forced/i,
      `${locale}:fields.professionLock.hint must say the switch is forced`,
    )
    assert.ok(settings.values.forced.trim().length > 0, `${locale}:values.forced`)
    // The default-profession row may only show a value it read; the fallback is
    // "follows host config", never a live 执行/Execution claim.
    const follow = settings.values.followHostConfig
    assert.match(follow, locale === 'zh-CN' ? /跟随主机配置/ : /follows host config/i)
    assert.doesNotMatch(follow, /执行|Execution/)
    for (const [key, value] of Object.entries(settings.values)) {
      assert.doesNotMatch(value, /执行|Execution/, `${locale}:settings.values.${key} hardcodes a profession`)
    }
    assert.doesNotMatch(settings.fields.professionDefault.hint, /执行|Execution/)
    assert.doesNotMatch(settings.fields.defaultScene.hint, /^对话|Dialogue$/)
    for (const id of HOST_EDITABLE_FIELDS) {
      assert.doesNotMatch(settings.fields[id].hint, /执行|Execution/, `${locale}:fields.${id}.hint`)
    }
  }
})

test('settings values and states cover every chip and page state', () => {
  for (const locale of LOCALES) {
    const settings = copyFor(locale).settings
    for (const chip of SETTINGS_CHIP_IDS) {
      assert.ok(settings.values[chip].trim().length > 0, `${locale}:values.${chip}`)
    }
    for (const [key, value] of Object.entries(settings.values)) {
      assert.ok(value.trim().length > 0, `${locale}:values.${key}`)
    }
    for (const [key, value] of Object.entries(settings.states)) {
      assert.ok(value.trim().length > 0, `${locale}:states.${key}`)
      assertBudget(locale, `states.${key}`, value, 70, 120)
    }
    // The states the page can show must be distinguishable, not one vague line.
    assert.notEqual(settings.states.offline, settings.states.hostRejected)
    assert.notEqual(settings.states.noCatalog, settings.states.storageBlocked)
    // The refresh select and the locale rows need their option text.
    for (const key of ['refresh2', 'refresh5', 'refresh10', 'refreshPaused'] as const) {
      assert.ok(settings.values[key].trim().length > 0, `${locale}:values.${key}`)
    }
    assert.equal(settings.values.chinese, '中文')
    assert.equal(settings.values.english, 'English')
  }
  assert.equal(copyFor('zh-CN').settings.values.forced, '强制')
  assert.equal(copyFor('zh-CN').settings.values.readOnlyHost, '只读（主机）')
  assert.equal(copyFor('zh-CN').settings.values.followHost, '跟随宿主')
  assert.equal(copyFor('zh-CN').settings.title, '协调')
  assert.equal(copyFor('en-US').settings.title, 'Coordination')
})

test('auto-compaction copy and threshold options stay valid', () => {
  // The four offers are whole percentages inside the accepted 30–90 band.
  assert.deepEqual([...COMPACTION_THRESHOLD_OPTIONS], [60, 70, 80, 88])
  assert.equal(COMPACTION_THRESHOLD_MIN, 30)
  assert.equal(COMPACTION_THRESHOLD_MAX, 90)
  for (const option of COMPACTION_THRESHOLD_OPTIONS) {
    assert.ok(
      option >= COMPACTION_THRESHOLD_MIN && option <= COMPACTION_THRESHOLD_MAX,
      `threshold ${option} is outside the accepted band`,
    )
    assert.equal(isValidCompactionThreshold(option), true, `threshold ${option}`)
    // The host stores a 0–1 utilisation ratio, so the wire value must be the
    // ratio and the round trip must return the same percent.
    const ratio = compactionRatio(option)
    assert.ok(ratio >= 0.3 && ratio <= 0.9, `ratio ${ratio} is outside the host band`)
    assert.equal(compactionPercent(ratio), option, `percent round trip for ${option}`)
  }
  assert.equal(compactionRatio(60), 0.6)
  assert.equal(compactionRatio(88), 0.88)
  assert.equal(compactionPercent(0.7), 70)
  assert.equal(compactionPercent(undefined), undefined)
  assert.equal(compactionPercent('70'), undefined)
  assert.equal(isValidCompactionThreshold(29), false)
  assert.equal(isValidCompactionThreshold(91), false)
  assert.equal(isValidCompactionThreshold(60.5), false)
  assert.equal(isValidCompactionThreshold('60'), false)
  assert.equal(isValidCompactionThreshold(undefined), false)

  for (const locale of LOCALES) {
    const settings = copyFor(locale).settings
    // The two host-backed editable rows and the two read-only derived rows.
    for (const id of HOST_EDITABLE_FIELDS) {
      assert.ok(settings.fields[id].label.trim().length > 0, `${locale}:fields.${id}.label`)
      assert.ok(settings.fields[id].hint.trim().length > 0, `${locale}:fields.${id}.hint`)
    }
    for (const id of ['hardPrune', 'reserve'] as const) {
      assert.ok(settings.fields[id].label.trim().length > 0, `${locale}:fields.${id}.label`)
      assert.ok(settings.fields[id].hint.trim().length > 0, `${locale}:fields.${id}.hint`)
    }
    // The switch copy states the safe-boundary / keep-recent behaviour, and the
    // read-only rows say the host owns the value.
    assert.match(settings.fields.autoCompact.hint, locale === 'zh-CN' ? /安全边界/ : /safe boundary/i)
    assert.match(settings.fields.autoCompact.hint, locale === 'zh-CN' ? /不压缩指令/ : /never compacts instructions/i)
    assert.match(settings.fields.hardPrune.hint, locale === 'zh-CN' ? /只能查看/ : /read-only/i)
    assert.match(settings.fields.reserve.hint, locale === 'zh-CN' ? /只能查看/ : /read-only/i)
    assert.ok(settings.states.configUnsupported.trim().length > 0)
    assert.ok(settings.states.saved.trim().length > 0)
    assert.ok(settings.values.host.trim().length > 0)
  }
  // A 404 from an older host must tell the operator where to set the value.
  assert.match(copyFor('zh-CN').settings.states.configUnsupported, /配置文件/)
  assert.match(copyFor('en-US').settings.states.configUnsupported, /configuration file/i)
  assert.equal(copyFor('zh-CN').settings.states.saved, '已保存。')
})

/* ------------------------------------------------------------------------- *
 * Errors and tools
 * ------------------------------------------------------------------------- */

test('every CoordinationError wire code has localized user text within budget', () => {
  for (const locale of LOCALES) {
    const copy = copyFor(locale)
    assert.deepEqual(Object.keys(copy.errors).sort(), [...ERROR_CODES].sort())
    for (const code of ERROR_CODES) {
      assert.ok(copy.errors[code].trim().length > 0, `${locale}:errors.${code}`)
      assertBudget(locale, `errors.${code}`, copy.errors[code], 70, 120)
    }
    // A locked profession must name the escape hatch in both languages.
    if (locale === 'zh-CN') {
      assert.match(copy.errors.PROFESSION_LOCKED, /重建/)
      assert.match(copy.errors.PROFESSION_LOCKED, /丢弃/)
    } else {
      assert.match(copy.errors.PROFESSION_LOCKED, /rebuild/i)
      assert.match(copy.errors.PROFESSION_LOCKED, /abandon/i)
    }
  }
  assert.match(copyFor('zh-CN').errors.PROFESSION_LOCKED, /重建/)
  assert.match(copyFor('zh-CN').errors.PROFESSION_LOCKED, /丢弃/)
})

test('tool copy exists for every coordination tool, names stay English', () => {
  for (const locale of LOCALES) {
    const copy = copyFor(locale)
    assert.deepEqual(Object.keys(copy.tools).sort(), [...TOOL_NAMES].sort())
    for (const name of TOOL_NAMES) {
      const tool = copy.tools[name]
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.trim().length > 0, `${locale}:tools.${name}.description`)
      const parameters = Object.keys(tool.parameters)
      assert.ok(parameters.length > 0, `${locale}:tools.${name} must describe its parameters`)
      for (const parameter of parameters) {
        assert.ok(
          tool.parameters[parameter].trim().length > 0,
          `${locale}:tools.${name}.parameters.${parameter}`,
        )
      }
    }
    assert.match(copy.tools.coordination_selection.description, /职能|scene|interaction/i)
    assert.match(copy.tools.coordination_profession.description, /职能|profession/i)
    assert.match(copy.tools.coordination_profession_lock.description, /锁定|lock/i)
  }
  // The two v23 §18.2 tool descriptions are reproduced verbatim in Chinese.
  assert.equal(
    copyFor('zh-CN').tools.coordination_profession.description,
    '查询/设置职能（仅任务开始前可设置）',
  )
  assert.equal(copyFor('zh-CN').tools.coordination_profession_lock.description, '查询职能锁定状态')
})

test('fillTemplate replaces known names and leaves unknown ones visible', () => {
  assert.equal(fillTemplate('a {b} c', { b: 'B' }), 'a B c')
  assert.equal(fillTemplate('a {b} c', {}), 'a {b} c')
  assert.equal(fillTemplate('{a}{a}', { a: 'x' }), 'xx')
})

/* ------------------------------------------------------------------------- *
 * Service-level takeover dialog (v24 §16)
 * ------------------------------------------------------------------------- */

test('takeover copy ships every dialog string in both locales within budget', () => {
  for (const locale of LOCALES) {
    const takeover = copyFor(locale).takeover
    assert.deepEqual(
      Object.keys(takeover).sort(),
      [...TAKEOVER_KEYS].sort(),
      `${locale}: takeover keys`,
    )
    for (const key of TAKEOVER_KEYS) {
      assert.ok(takeover[key].trim().length > 0, `${locale}:takeover.${key}`)
      assertBudget(locale, `takeover.${key}`, takeover[key], 70, 120)
    }
    // The queue badge is a template and must resolve without leftovers.
    const label = fillTemplate(takeover.queueLabel, { index: '1', total: '3' })
    assert.match(label, /1/)
    assert.match(label, /3/)
    assert.doesNotMatch(label, /\{\w+\}/)
  }
  assert.equal(copyFor('zh-CN').takeover.allowOnce, '仅本次允许')
  assert.equal(copyFor('zh-CN').takeover.reject, '拒绝')
  assert.equal(copyFor('zh-CN').takeover.cancel, '取消')
  assert.equal(copyFor('zh-CN').takeover.submit, '提交')
  assert.equal(copyFor('en-US').takeover.allowOnce, 'Allow once')
  assert.equal(copyFor('en-US').takeover.reject, 'Reject')
  // A failed/expired host answer must be explained, not left silent.
  assert.match(copyFor('zh-CN').takeover.expired, /失效/)
  assert.match(copyFor('en-US').takeover.expired, /no longer valid/i)
  assert.ok(copyFor('zh-CN').takeover.hostError.length > 0)
})

test('buildQuestionAnswers returns exactly the host answer shape', () => {
  const questions: TakeoverQuestionView[] = [
    {
      id: 'scope',
      question: 'Which files?',
      options: [{ label: 'workspace' }, { label: 'outside' }],
      multiSelect: false,
    },
    { id: 'why', question: 'Why?', options: [], multiSelect: false },
    {
      id: 'tags',
      question: 'Tags',
      options: [{ label: 'a' }, { label: 'b' }],
      multiSelect: true,
    },
  ]
  const selection: Record<string, QuestionSelection> = {
    scope: { selected: ['workspace'], custom: '  also this  ' },
    why: { selected: [], custom: '  because  ' },
    tags: { selected: ['a', 'b', 'a'], custom: '' },
  }
  assert.deepEqual(buildQuestionAnswers(questions, selection), [
    // The host rejects option + custom together for an options question, so
    // custom is omitted once an option is selected.
    { id: 'scope', selected: ['workspace'] },
    // Custom text is trimmed; `selected` stays an array even when empty.
    { id: 'why', selected: [], custom: 'because' },
    // Multi-select keeps every distinct option, in the operator's order.
    { id: 'tags', selected: ['a', 'b'] },
  ])
  // An options question with no option chosen may still answer in free text.
  assert.deepEqual(
    buildQuestionAnswers(questions.slice(0, 1), { scope: { selected: [], custom: 'something else' } }),
    [{ id: 'scope', selected: [], custom: 'something else' }],
  )
  // A custom-only answer omits nothing the host requires and drops empty custom.
  assert.deepEqual(
    buildQuestionAnswers(
      [{ id: 'free', question: 'Anything else?', options: [], multiSelect: false }],
      { free: { selected: [], custom: 'note' } },
    ),
    [{ id: 'free', selected: [], custom: 'note' }],
  )
})

test('buildQuestionAnswers rejects incomplete or invalid input', () => {
  const single: TakeoverQuestionView = {
    id: 'scope',
    question: 'Which files?',
    options: [{ label: 'workspace' }, { label: 'outside' }],
    multiSelect: false,
  }
  assert.throws(() => buildQuestionAnswers([single], {}), /no answer/)
  assert.throws(
    () => buildQuestionAnswers([single], { scope: { selected: ['elsewhere'], custom: '' } }),
    /not offered/,
  )
  assert.throws(
    () => buildQuestionAnswers([single], { scope: { selected: ['workspace', 'outside'], custom: '' } }),
    /only one option/,
  )
  assert.throws(
    () => buildQuestionAnswers([single], { scope: { selected: [], custom: '   ' } }),
    /no answer/,
  )
  assert.equal(isQuestionAnswerComplete([single], {}), false)
  assert.equal(isQuestionAnswerComplete([single], { scope: { selected: [], custom: 'x' } }), true)
  assert.equal(isQuestionAnswerComplete([single], { scope: { selected: ['outside'], custom: '' } }), true)
})

test('workspace panel names the import tab 导入 / Imports, not a combined label', () => {
  const zh = copyFor('zh-CN').panel
  const en = copyFor('en-US').panel
  assert.equal(zh.tabs.imports, '导入')
  assert.equal(en.tabs.imports, 'Imports')
  assert.equal(zh.imports.empty, '尚无导入记录。')
  assert.equal(en.imports.empty, 'No import records yet.')
  assert.equal(zh.tip.tabImports, '查看导入')
  assert.equal(en.tip.tabImports, 'View imports')
  assert.ok(!zh.tabs.imports.includes('导出'))
  assert.ok(!en.tabs.imports.includes('export'))
})

