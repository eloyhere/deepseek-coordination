/**
 * Locale copy audit (v23 §22).
 *
 * These tests are the guard rail for the two-language dictionary: they prove
 * that the keys are balanced, that nothing is left empty or untranslated, that
 * the Chinese projection still equals the enum constants the design document
 * mandates, and that every claim the UI makes about the v24 writing scene and
 * the all-level search policy is actually present in both languages.
 *
 * The test imports only shared modules; it never needs React or a DSH host.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COPY_BY_LOCALE,
  DEFAULT_LOCALE,
  LOCALES,
  copyFor,
  fillTemplate,
  normaliseLocale,
} from '../src/shared/i18n.js'
import type { Copy, Locale } from '../src/shared/i18n.js'
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
} from '../src/shared/enum.js'
import type { CoordinationErrorCode } from '../src/shared/error.js'

const CONTROL_NAMES = ['profession', 'interaction', 'scene', 'validation', 'permission'] as const
const TOOL_NAMES = [
  'coordination_selection',
  'coordination_profession',
  'coordination_professionlock',
] as const
const REQUIRED_ERROR_CODES: readonly CoordinationErrorCode[] = [
  'PROFESSION_LOCKED',
  'PROFESSION_REQUIRED',
  'NOT_FOUND',
  'INVALID_STATE',
  'INVALID_ARGUMENT',
  'VERIFICATION',
  'PERMISSION',
  'NOT_IMPLEMENTED',
  'UPSTREAM',
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
  'permissionFollowHint',
  'followDsh',
  'followDshMode',
  'loadingSelection',
  'professionLocked',
  'professionLockedRebuild',
  'requestFailed',
  'invalidSelection',
  'validationNote',
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

test('English is translated rather than copied, except for numeric budgets', () => {
  const zh = leafMap('zh-CN')
  const en = leafMap('en-US')
  for (const [path, value] of zh) {
    if (path.endsWith('.budget')) continue
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
 * Chinese must remain the enum/doc projection
 * ------------------------------------------------------------------------- */

test('zh-CN control copy equals the enum constants', () => {
  const copy: Copy = copyFor('zh-CN')
  for (const name of CONTROL_NAMES) {
    assert.equal(copy.controls[name].label, ControlLabel[name], `controls.${name}.label`)
    assert.equal(copy.controls[name].hint, ControlHint[name], `controls.${name}.hint`)
    expectCjk(copy.controls[name].label)
  }
})

test('zh-CN profession copy equals the enum constants', () => {
  const copy = copyFor('zh-CN')
  for (const value of ProfessionValues) {
    assert.equal(copy.professions[value].label, ProfessionLabel[value], `professions.${value}.label`)
    assert.equal(copy.professions[value].hint, ProfessionHint[value], `professions.${value}.hint`)
  }
})

test('zh-CN interaction copy equals the enum constants', () => {
  const copy = copyFor('zh-CN')
  for (const value of InteractionValues) {
    assert.equal(copy.interactions[value].label, InteractionLabel[value], `interactions.${value}.label`)
    assert.equal(copy.interactions[value].hint, InteractionHint[value], `interactions.${value}.hint`)
  }
})

test('zh-CN scene copy equals the enum constants and includes the v24 writing scene', () => {
  const copy = copyFor('zh-CN')
  assert.deepEqual(
    Object.keys(copy.scenes).sort(),
    [...SceneValues].sort(),
    'every scene must be covered',
  )
  assert.ok(SceneValues.includes('writing'), 'v24 SceneValues must include writing')
  for (const value of SceneValues) {
    assert.equal(copy.scenes[value].label, SceneLabel[value], `scenes.${value}.label`)
    assert.equal(copy.scenes[value].hint, SceneHint[value], `scenes.${value}.hint`)
  }
  assert.equal(copy.scenes.writing.label, '写作')
  expectCjk(copy.scenes.writing.hint)
})

test('zh-CN validation copy equals the enum constants and keeps the doc budget', () => {
  const copy = copyFor('zh-CN')
  for (const level of ValidationValues) {
    assert.equal(copy.validations[level].label, ValidationLabel[level], `validations.${level}.label`)
    assert.equal(copy.validations[level].hint, ValidationHint[level], `validations.${level}.hint`)
    assert.ok(
      copy.validations[level].tooltip.includes(ValidationHint[level]),
      `validations.${level}.tooltip must carry the enum hint`,
    )
  }
})

test('zh-CN permission copy equals the enum constants', () => {
  const copy = copyFor('zh-CN')
  for (const mode of SandboxModeValues) {
    assert.equal(copy.permissions[mode].label, PermissionLabel[mode], `permissions.${mode}.label`)
    assert.equal(copy.permissions[mode].hint, PermissionHint[mode], `permissions.${mode}.hint`)
  }
})

/* ------------------------------------------------------------------------- *
 * v24 writing scene and all-level search
 * ------------------------------------------------------------------------- */

test('scene copy names the writing scene in both locales', () => {
  const zh = copyFor('zh-CN')
  const en = copyFor('en-US')
  assert.deepEqual(Object.keys(zh.scenes).sort(), [...SceneValues].sort())
  assert.deepEqual(Object.keys(en.scenes).sort(), [...SceneValues].sort())
  assert.equal(zh.scenes.writing.label, '写作')
  assert.equal(en.scenes.writing.label, 'Writing')
  expectCjk(zh.scenes.writing.hint)
  expectLatin(en.scenes.writing.hint)
  assert.match(zh.scenes.writing.hint, /内容创作/)
  assert.match(en.scenes.writing.hint, /content creation/i)
})

test('validation copy states 1×3 / 2×5 / 4×8 and that all levels search', () => {
  const budget: Record<string, string> = { low: '1×3', medium: '2×5', high: '4×8' }
  const scopeZh: Record<string, RegExp> = {
    low: /当轮/,
    medium: /当前会话/,
    high: /本地全部内容/,
  }
  const scopeEn: Record<string, RegExp> = {
    low: /current turn/i,
    medium: /current session/i,
    high: /local all content/i,
  }

  for (const locale of LOCALES) {
    const copy = copyFor(locale)
    for (const level of ValidationValues) {
      const entry = copy.validations[level]
      assert.equal(entry.budget, budget[level], `${locale}:validations.${level}.budget`)
      assert.ok(entry.tooltip.includes(budget[level]), `${locale}:${level} tooltip must state ${budget[level]}`)
      assert.ok(entry.tooltip.includes(entry.hint), `${locale}:${level} tooltip must include the hint`)
    }
    assert.match(copy.validations.low.scope, locale === 'zh-CN' ? scopeZh.low : scopeEn.low)
    assert.match(copy.validations.medium.scope, locale === 'zh-CN' ? scopeZh.medium : scopeEn.medium)
    assert.match(copy.validations.high.scope, locale === 'zh-CN' ? scopeZh.high : scopeEn.high)
    for (const level of ValidationValues) {
      assert.match(
        copy.validations[level].hint,
        locale === 'zh-CN' ? /联网/ : /web search/i,
        `${locale}:${level} must say it searches the web`,
      )
    }
  }

  // The control-level note repeats all three budgets and the all-level policy.
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

  // The stale v23 sentence ("only medium/high search") must be gone.
  for (const locale of LOCALES) {
    const copy = copyFor(locale)
    for (const leaf of flatten(copy)) {
      assert.doesNotMatch(
        leaf.value,
        /medium 与 high|medium and high (only )?(may |can )?search/i,
        `${locale}:${leaf.path} still claims only medium/high search`,
      )
    }
  }
})

/* ------------------------------------------------------------------------- *
 * Runtime copy, settings, errors, tools
 * ------------------------------------------------------------------------- */

test('composer runtime copy covers every lock/offline/rejection line', () => {
  for (const locale of LOCALES) {
    const copy = copyFor(locale)
    for (const key of REQUIRED_COMPOSER_KEYS) {
      assert.ok(copy.composer[key].trim().length > 0, `${locale}:composer.${key}`)
    }
    // Interpolated lines must resolve completely.
    const locked = fillTemplate(copy.composer.lockedLine, {
      profession: copy.professions.execution.label,
    })
    assert.ok(locked.includes(copy.professions.execution.label))
    assert.doesNotMatch(locked, /\{\w+\}/)
    const offline = fillTemplate(copy.composer.offlineLine, { localOnly: copy.composer.localOnly })
    assert.ok(offline.includes(copy.composer.localOnly))
    assert.doesNotMatch(offline, /\{\w+\}/)
    const approval = fillTemplate(copy.composer.approvalPolicy, { approval: 'on-request' })
    assert.ok(approval.includes('on-request'))
    const invalid = fillTemplate(copy.composer.invalidSelection, { message: 'x' })
    assert.ok(invalid.includes('x'))
    const aria = fillTemplate(copy.composer.controlAria, {
      control: copy.controls.scene.label,
      currentLabel: copy.composer.currentLabel,
      current: copy.scenes.writing.label,
    })
    assert.ok(aria.includes(copy.controls.scene.label))
    assert.ok(aria.includes(copy.composer.currentLabel))
    assert.ok(aria.includes(copy.scenes.writing.label))
    const optionAria = fillTemplate(copy.composer.optionAria, { label: 'L', hint: 'H' })
    assert.ok(optionAria.includes('L'))
    assert.ok(optionAria.includes('H'))
    const follow = fillTemplate(copy.composer.followDshMode, {
      mode: copy.permissions['read-only'].label,
    })
    assert.ok(follow.includes(copy.permissions['read-only'].label))
  }
})

test('settings copy covers both switches, the profession group, and the footer', () => {
  for (const locale of LOCALES) {
    const settings = copyFor(locale).settings
    assert.ok(settings.title.trim().length > 0)
    for (const name of ['takeover', 'workflow'] as const) {
      const entry = settings[name]
      assert.ok(entry.label.trim().length > 0, `${locale}:${name}.label`)
      assert.ok(entry.hint.trim().length > 0, `${locale}:${name}.hint`)
      assert.ok(entry.onLine.trim().length > 0, `${locale}:${name}.onLine`)
      assert.ok(entry.offLine.trim().length > 0, `${locale}:${name}.offLine`)
    }
    const group = settings.professionGroup
    assert.ok(group.title.trim().length > 0)
    for (const name of [
      'lock',
      'defaultProfession',
      'rebuildReselect',
      'abandonReselect',
      'audit',
      'lockErrorHint',
    ] as const) {
      assert.ok(group[name].label.trim().length > 0, `${locale}:professionGroup.${name}.label`)
      assert.ok(group[name].hint.trim().length > 0, `${locale}:professionGroup.${name}.hint`)
    }
    // The value row follows profession.default; it must not hardcode a value.
    assert.ok(group.defaultProfessionValue.trim().length > 0)
    assert.doesNotMatch(group.defaultProfessionValue, /执行|Execution/)
    assert.ok(group.displayOnly.trim().length > 0)
    assert.ok(settings.footer.trim().length > 0)
  }
  assert.equal(copyFor('zh-CN').settings.title, '协调')
  assert.equal(copyFor('en-US').settings.title, 'Coordination')
})

test('every CoordinationError wire code has localized user text', () => {
  for (const locale of LOCALES) {
    const copy = copyFor(locale)
    for (const code of REQUIRED_ERROR_CODES) {
      assert.ok(copy.errors[code].trim().length > 0, `${locale}:errors.${code}`)
    }
    // A locked profession must name the escape hatch in both languages.
    assert.match(copy.errors.PROFESSION_LOCKED, /rebuild/i)
    assert.match(copy.errors.PROFESSION_LOCKED, /abandon/i)
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
    // Canonical identifiers appear in the descriptions, not localized names.
    assert.match(copy.tools.coordination_selection.description, /职能|scene|interaction/i)
    assert.match(copy.tools.coordination_profession.description, /职能|profession/i)
    assert.match(copy.tools.coordination_professionlock.description, /锁定|lock/i)
  }
  assert.match(copyFor('zh-CN').tools.coordination_professionlock.description, /职能锁定/)
  assert.match(copyFor('en-US').tools.coordination_professionlock.description, /lock/i)
  // The two v23 §18.2 tool descriptions are reproduced verbatim in Chinese.
  assert.equal(
    copyFor('zh-CN').tools.coordination_profession.description,
    '查询/设置职能（仅任务开始前可设置）',
  )
  assert.equal(copyFor('zh-CN').tools.coordination_professionlock.description, '查询职能锁定状态')
})

test('fillTemplate replaces known names and leaves unknown ones visible', () => {
  assert.equal(fillTemplate('a {b} c', { b: 'B' }), 'a B c')
  assert.equal(fillTemplate('a {b} c', {}), 'a {b} c')
  assert.equal(fillTemplate('{a}{a}', { a: 'x' }), 'xx')
})
