/**
 * Guards for the simplified `协调` settings page.
 *
 * Two kinds of checks, both DOM-free:
 *  - the exported pure functions that decide the first screen, the closed
 *    accordion plan, search, and the immediate reset patches;
 *  - source assertions for the parts that only exist as React state, so a later
 *    refactor cannot quietly restore the save bar, bring back a native select,
 *    reopen every section, or lose the read-only About tail.
 *
 * The source is read through `resolve('src/client/settings.ts')`, the same
 * convention `panelHardening.test.ts` uses: `npm test` runs `node --test` from
 * the repo root.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SETTINGS_DISPLAY_SWITCH_KEYS,
  SETTINGS_QUICK_SWITCH_IDS,
  SETTINGS_TASK_DEFAULT_KEYS,
  isHoistedSetting,
  isModifiedSetting,
  matchesSettingQuery,
  quickSwitchCopyFor,
  referenceLine,
  resetAllPatchFor,
  resetPatchFor,
  settingsAdvancedPages,
  settingsDisplaySwitches,
  settingsGroupInputs,
  settingsPageControls,
  settingsQuickSwitches,
  settingsSectionExpanded,
  settingsTaskDefaults,
} from '../src/client/settings.js'
import { SETTINGS_PAGE_COPY, settingsPageCopy } from '../src/client/settingsCopy.js'
import { SETTINGS_CATALOG_GROUPS, SETTINGS_CONTROLS } from '../src/shared/selection.js'
import { COPY_BY_LOCALE, LOCALES } from '../src/shared/i18n.js'
import { ABOUT } from '../src/shared/about.js'

/** The page source, for invariants that live in React state rather than data. */
function settingsSource(): string {
  return readFileSync(resolve('src/client/settings.ts'), 'utf8')
}

/** The stored control for one quick-switch slot, when this catalog has it. */
function controlById(id: string): (typeof SETTINGS_CONTROLS)[number] | undefined {
  return SETTINGS_CONTROLS.find((control) => control.id === id)
}

test('the first screen pins four switch slots in order, three defaults and two display switches', () => {
  const quick = settingsQuickSwitches()
  const defaults = settingsTaskDefaults()
  const display = settingsDisplaySwitches()

  // The fourth slot is host-executed file takeover, immediately after dialogs.
  assert.deepEqual([...SETTINGS_QUICK_SWITCH_IDS], [
    'setting:local.takeoverPermission',
    'setting:local.composerWorkflow',
    'setting:ui.takeover',
    'setting:ui.takeoverFiles',
  ])
  assert.equal(
    SETTINGS_QUICK_SWITCH_IDS.indexOf('setting:ui.takeoverFiles'),
    SETTINGS_QUICK_SWITCH_IDS.indexOf('setting:ui.takeover') + 1,
  )

  // A quick id absent from the catalog is filtered out; the resolved rows stay
  // in slot order and never contain an undefined entry.
  const known = new Set(SETTINGS_CONTROLS.map((control) => control.id))
  const expectedQuick = [...SETTINGS_QUICK_SWITCH_IDS].filter((id) => known.has(id))
  assert.deepEqual(quick.map((control) => control.id), expectedQuick)
  assert.equal(new Set(quick.map((control) => control.id)).size, quick.length)

  assert.deepEqual(defaults.map((control) => control.keys[0]), [...SETTINGS_TASK_DEFAULT_KEYS])
  assert.deepEqual(display.map((control) => control.keys[0]), [...SETTINGS_DISPLAY_SWITCH_KEYS])

  const firstScreen = [...quick, ...defaults, ...display]
  assert.equal(firstScreen.length, quick.length + 5)
  assert.equal(new Set(firstScreen.map((control) => control.id)).size, firstScreen.length)

  // A hoisted control lives on the first screen only; its group must not repeat it.
  const pages = settingsAdvancedPages(settingsGroupInputs())
  for (const control of firstScreen) {
    assert.equal(isHoistedSetting(control), true)
    const page = pages.find((entry) => entry.group === control.group)
    assert.ok(page !== undefined, `missing advanced page for ${control.group}`)
    assert.ok(
      !settingsPageControls(page).some((entry) => entry.id === control.id),
      `${control.id} is repeated inside its group`,
    )
  }

  // When the host catalog carries the fourth row it is a normal host gate,
  // exactly like `接管宿主弹窗` — not a local browser preference.
  const files = controlById('setting:ui.takeoverFiles')
  if (files !== undefined) {
    assert.equal(files.group, 'ui')
    assert.equal(files.chip, 'host')
    assert.deepEqual([...files.keys], ['ui.takeoverFiles'])
    assert.equal(files.kind, 'boolean')
    assert.equal(quick.at(-1)?.id, 'setting:ui.takeoverFiles')
  }

  // The page names the file gate itself (the catalog row borrows the dialog
  // copy id), with exactly the promised label and a one-sentence host hint.
  const zh = settingsPageCopy('zh-CN')
  assert.equal(zh.takeoverFilesLabel, '接管文件读写')
  assert.equal(
    zh.takeoverFilesHint,
    '开启后由本插件判定文件读写：越界写入会被拒绝、读取会被记录；关闭时完全不介入。',
  )
  assert.equal(settingsPageCopy('en-US').takeoverFilesLabel, 'File read/write takeover')
  assert.equal(
    settingsPageCopy('en-US').takeoverFilesHint,
    'When on, this plugin decides file access: writes outside the workspace are refused and reads are recorded; off leaves DSH untouched.',
  )
  // The override is keyed by control id, marks the row as a host gate, and
  // falls back to the shared catalog for every other id.
  assert.deepEqual(quickSwitchCopyFor('setting:ui.takeoverFiles', zh), {
    label: zh.takeoverFilesLabel,
    hint: zh.takeoverFilesHint,
    host: true,
  })
  assert.equal(quickSwitchCopyFor('setting:ui.takeover', zh), undefined)
  assert.equal(quickSwitchCopyFor('setting:local.takeoverPermission', zh), undefined)
  assert.equal(quickSwitchCopyFor('setting:local.composerWorkflow', zh), undefined)

  const source = settingsSource()
  // A page-level override table keyed by control id, with a catalog fallback.
  assert.match(source, /const QUICK_SWITCH_COPY: Readonly</)
  assert.match(source, /'setting:ui\.takeoverFiles': \(copy\) => \(\{/)
  assert.match(source, /export function quickSwitchCopyFor\(/)
  assert.match(source, /settingsControlCopy\(settings, control\.copy\) \?\? \{ label: control\.id, hint: '' \}/)
})

test('every group keeps one closed accordion and every remaining row is covered', () => {
  assert.deepEqual(
    settingsGroupInputs().map((entry) => entry.group),
    [...SETTINGS_CATALOG_GROUPS],
  )
  const pages = settingsAdvancedPages(settingsGroupInputs())
  assert.equal(pages.length, SETTINGS_CATALOG_GROUPS.length)
  assert.equal(new Set(pages.map((page) => page.group)).size, pages.length)

  const firstScreenRows = settingsQuickSwitches().length
    + settingsTaskDefaults().length
    + settingsDisplaySwitches().length
  const advancedRows = pages.reduce((count, page) => count + page.rows, 0)
  assert.equal(firstScreenRows + advancedRows, SETTINGS_CONTROLS.length)

  for (const page of pages) {
    assert.ok(page.rows > 0, `${page.key} must not be an empty accordion`)
    assert.equal(page.rows, settingsPageControls(page).length)
    assert.equal(page.key, page.group)
  }
})

test('every accordion is closed by default and a search hit opens it', () => {
  assert.equal(settingsSectionExpanded({ open: false, searching: false }), false)
  assert.equal(settingsSectionExpanded({ open: true, searching: false }), true)
  assert.equal(settingsSectionExpanded({ open: false, searching: true }), true)

  const source = settingsSource()
  // The state starts empty, so no section is open on first render.
  assert.match(
    source,
    /const \[openSections, setOpenSections\] = React\.useState<Record<string, boolean>>\(\{\}\)/,
  )
  assert.match(
    source,
    /settingsSectionExpanded\(\{ open: openSections\[block\.key\] === true, searching \}\)/,
  )
  // A closed accordion does not mount its body.
  assert.match(source, /expanded\s*\n\s*\? React\.createElement\(/)
  assert.match(source, /MuiAccordionDetails/)
})

test('search matches label, hint and config key only', () => {
  const entry = {
    label: '会话轮次上限',
    hint: '一个会话最多保留多少轮；达到上限后拒绝新任务。',
    keys: ['maxTurnPerSession'],
  }

  assert.equal(matchesSettingQuery(entry, ''), true)
  assert.equal(matchesSettingQuery(entry, '   '), true)
  assert.equal(matchesSettingQuery(entry, '轮次'), true)
  assert.equal(matchesSettingQuery(entry, '一个会话'), true)
  assert.equal(matchesSettingQuery(entry, 'MAXTURN'), true)
  assert.equal(matchesSettingQuery(entry, '  maxTurnPerSession  '), true)
  // A group title or a neighbouring key is not part of this row's haystack.
  assert.equal(matchesSettingQuery(entry, '计划评分'), false)
  assert.equal(matchesSettingQuery(entry, 'plan.threshold'), false)
})

test('one reset writes exactly the keys of that row', () => {
  const single = SETTINGS_CONTROLS.find(
    (control) => control.chip === 'host' && control.keys.length === 1,
  )
  assert.ok(single !== undefined, 'the catalog must keep a single-key host row')

  const one = resetPatchFor(single, false)
  assert.deepEqual(Object.keys(one), [single.keys[0]])
  assert.equal(one[single.keys[0] as string], false)

  // A shared scene row owns its six scene keys and nothing else.
  const shared = SETTINGS_CONTROLS.find((control) => control.keys.length > 1)
  assert.ok(shared !== undefined, 'the catalog must keep a shared scene row')
  const many = resetPatchFor(shared, 0.5)
  assert.deepEqual(Object.keys(many).sort(), [...shared.keys].sort())
  assert.equal('plan.threshold' in many, false)
  assert.equal('maxTurnPerSession' in many, false)
})

test('restore-all patches only changed editable rows, with their schema defaults', () => {
  const threshold = SETTINGS_CONTROLS.find((control) => control.keys[0] === 'plan.threshold')
  const turns = SETTINGS_CONTROLS.find((control) => control.keys[0] === 'maxTurnPerSession')
  const tooltip = SETTINGS_CONTROLS.find((control) => control.keys[0] === 'ui.showTooltip')
  assert.ok(threshold !== undefined && turns !== undefined && tooltip !== undefined)

  const view = {
    values: { plan: { threshold: 0.6 }, maxTurnPerSession: 10, ui: { showTooltip: true } },
    defaults: { plan: { threshold: 0.5 }, maxTurnPerSession: 10, ui: { showTooltip: true } },
  }

  // Only `plan.threshold` differs, so only it is written — and to its default.
  assert.deepEqual(resetAllPatchFor(view, [threshold, turns, tooltip]), { 'plan.threshold': 0.5 })

  // `isModifiedSetting` is the same predicate: unchanged rows are not targets.
  assert.equal(isModifiedSetting(view, threshold), true)
  assert.equal(isModifiedSetting(view, turns), false)
  assert.equal(isModifiedSetting(view, tooltip), false)

  // Local and read-only rows never appear in a restore patch.
  const local = SETTINGS_CONTROLS.find((control) => control.chip === 'local')
  assert.ok(local !== undefined)
  assert.deepEqual(resetAllPatchFor(view, [local]), {})

  // Nothing changed → nothing to write.
  const equal = {
    values: { plan: { threshold: 0.5 } },
    defaults: { plan: { threshold: 0.5 } },
  }
  assert.deepEqual(resetAllPatchFor(equal, [threshold]), {})
})

test('the page is a single column of closed accordions with MUI selects and no save bar', () => {
  const source = settingsSource()

  // No left/right navigation, no horizontal chip rail.
  assert.doesNotMatch(source, /NAV_STYLE/)
  assert.doesNotMatch(source, /overflowX/)
  assert.doesNotMatch(source, /aria-current/)
  assert.doesNotMatch(source, /role: 'tablist'/)
  assert.doesNotMatch(source, /layout\.expandAll/)
  assert.doesNotMatch(source, /layout\.collapseAll/)
  assert.doesNotMatch(source, /layout\.modifiedOnly/)
  assert.doesNotMatch(source, /IntersectionObserver/)

  // The four switch slots are always visible; the groups are accordions.
  assert.match(source, /renderQuick\(QUICK_SWITCHES\)/)
  assert.match(source, /MuiAccordion/)
  assert.match(source, /data-settings-page/)
  assert.match(source, /settingsAdvancedPages\(settingsGroupInputs\(\)\)/)

  // Accessibility: switches and a labelled accordion summary.
  assert.match(source, /role: 'switch'/)
  assert.match(source, /'aria-checked': props\.checked/)
  assert.match(source, /'aria-controls': `settings-acc-body:\$\{block\.key\}`/)
  assert.match(source, /'aria-labelledby': `\$\{control\.id\}:label`/)

  // Every dropdown is MUI: Select + MenuItem, a stable value, an accessible
  // label and a localised renderValue. No native select/option anywhere.
  assert.match(source, /from '@mui\/material\/Select'/)
  assert.match(source, /from '@mui\/material\/MenuItem'/)
  assert.match(source, /const MuiSelect = Select as unknown as Loose/)
  assert.match(source, /const MuiMenuItem = MenuItem as unknown as Loose/)
  assert.match(source, /renderValue: \(value: unknown\)/)
  assert.match(source, /labelId: props\.labelId/)
  assert.match(source, /'aria-label': props\.label/)
  assert.match(source, /onChange: \(event: SelectChangeEvent<unknown>\)/)
  assert.match(source, /const selected = current\.length > 0 \? current : \(options\[0\] \?\? ''\)/)
  assert.match(source, /maxWidth: '100%'/)
  assert.doesNotMatch(source, /createElement\(\s*'select'/)
  assert.doesNotMatch(source, /createElement\(\s*'option'/)
  assert.doesNotMatch(source, /'<select'/)
  assert.doesNotMatch(source, /'<option'/)
  assert.doesNotMatch(source, /multiple: false/)

  // No staging state machine, no save bar, no unsaved counter.
  assert.doesNotMatch(source, /SAVE_BAR_STYLE/)
  assert.doesNotMatch(source, /pageCopy\.saveBar/)
  assert.doesNotMatch(source, /pageCopy\.unsaved/)
  assert.doesNotMatch(source, /pageCopy\.save\b/)
  assert.doesNotMatch(source, /dirtyCount/)
  assert.doesNotMatch(source, /dirtyOf/)
  assert.doesNotMatch(source, /canSave/)
  assert.doesNotMatch(source, /const save = /)
  assert.doesNotMatch(source, /const baseline|setBaseline/)
  assert.doesNotMatch(source, /setSaving/)
  assert.doesNotMatch(source, /position: 'sticky'/)
  assert.doesNotMatch(source, /MuiSnackbar/)
  assert.doesNotMatch(source, /discardChanges|confirmDiscard|kind: 'discard'/)

  // Every host edit POSTs immediately through the existing write function, with
  // a row-level optimistic update and a row-level rollback on refusal.
  assert.match(source, /const writePatch = \(/)
  assert.match(source, /await saveConfig\(patch\)/)
  assert.match(source, /writePatch\(resetPatchFor\(control, value\), \[control\]/)
  assert.match(source, /withControlValue\(current, control, previous as ConfigScalar\)/)
  assert.match(source, /pageCopy\.writeOffline/)
  assert.match(source, /pageCopy\.writeRejected/)
  assert.match(source, /pageCopy\.restoreAllOffline/)
  assert.match(source, /pageCopy\.restoreAllRejected/)
  assert.match(source, /writeError/)

  // Both destructive actions confirm first and then write immediately.
  assert.match(source, /pageCopy\.restoreOneTitle/)
  assert.match(source, /pageCopy\.restoreAllTitle/)
  assert.match(source, /MuiDialog/)
  assert.match(source, /applyConfirmation/)
  assert.match(source, /const resetControl = \(control: SettingsControl\): void => \{/)
  assert.match(source, /const resetAll = \(\): void => \{/)
  assert.match(source, /resetAllPatchFor\(view, targets\)/)
})

test('restore confirms once and then applies immediately in both locales', () => {
  for (const locale of LOCALES) {
    const page = settingsPageCopy(locale)
    // The confirmation body promises an immediate write, not a staged draft.
    assert.match(page.restoreOneBody, /立即|immediately/, `${locale} restore-one is immediate`)
    assert.match(page.restoreAllBody, /立即|immediately/, `${locale} restore-all is immediate`)
    assert.doesNotMatch(page.applyHint, /保存|Save/, `${locale} apply hint has no save action`)
  }

  const source = settingsSource()
  // The dialog only ever queues one of the two restore kinds.
  assert.match(source, /if \(pending\.kind === 'one'\) resetControl\(pending\.control\)\n\s*else resetAll\(\)/)
  // Both restore paths hand their patch straight to the immediate writer.
  const resetControlBody = source.slice(
    source.indexOf('const resetControl'),
    source.indexOf('const resetAll'),
  )
  assert.match(resetControlBody, /writePatch\(patch, \[control\]/)
  const resetAllBody = source.slice(
    source.indexOf('const resetAll'),
    source.indexOf('const modifiedControls'),
  )
  assert.match(resetAllBody, /writePatch\(patch, targets/)
})

test('the read-only About, References and Author tail is kept accurate', () => {
  const source = settingsSource()
  assert.match(source, /function AboutAccordion\(/)
  assert.match(source, /function ReferencesAccordion\(/)
  assert.match(source, /function AuthorAccordion\(/)
  assert.match(source, /React\.createElement\(AboutAccordion, \{ copy, summary: aboutSummary \}\)/)
  assert.match(source, /React\.createElement\(ReferencesAccordion, \{ copy, summary: referencesSummary \}\)/)
  assert.match(source, /React\.createElement\(AuthorAccordion, \{ copy, summary: authorSummary \}\)/)
  assert.match(source, /ABOUT\.dependencies\.length/)
  assert.match(source, /ABOUT\.tooling\.length/)
  assert.match(source, /ABOUT\.references\.length/)
  assert.match(source, /ABOUT\.author\.name/)
  assert.match(source, /\.\.\.ABOUT\.references\.map\(/)
  assert.match(source, /reference\.reason/)
  // The license line is no longer duplicated at the end of the About body.
  assert.equal((source.match(/about\.license/g) ?? []).length, 1)

  // Every citation line carries all four bibliographic fields.
  const about = COPY_BY_LOCALE['zh-CN'].about
  for (const reference of ABOUT.references) {
    const line = referenceLine(about.referenceItem, reference)
    assert.ok(line.includes(reference.authors), `${reference.id}: authors`)
    assert.ok(line.includes(String(reference.year)), `${reference.id}: year`)
    assert.ok(line.includes(reference.title), `${reference.id}: title`)
    assert.ok(line.includes(reference.venue), `${reference.id}: venue`)
  }

  // The data behind the tail is complete and uniquely identified.
  assert.ok(ABOUT.dependencies.length > 0)
  assert.ok(ABOUT.tooling.length > 0)
  assert.equal(
    new Set(ABOUT.references.map((reference) => reference.id)).size,
    ABOUT.references.length,
  )
  for (const dependency of [...ABOUT.dependencies, ...ABOUT.tooling]) {
    assert.ok(dependency.name.trim().length > 0)
    assert.ok(dependency.version.trim().length > 0)
    assert.ok(dependency.role.trim().length > 0)
    assert.ok(dependency.reason.trim().length > 0)
  }
  assert.ok(ABOUT.author.name.trim().length > 0)
  assert.ok(ABOUT.author.email.trim().length > 0)
  assert.ok(ABOUT.author.github.trim().length > 0)
  assert.ok(ABOUT.author.npm.trim().length > 0)
})

test('the page copy is complete in both locales and keeps no save vocabulary', () => {
  assert.deepEqual(
    Object.keys(SETTINGS_PAGE_COPY['en-US']).sort(),
    Object.keys(SETTINGS_PAGE_COPY['zh-CN']).sort(),
  )
  for (const locale of LOCALES) {
    const page = settingsPageCopy(locale)
    for (const [key, value] of Object.entries(page)) {
      assert.equal(typeof value, 'string', `${locale}.${key}`)
      assert.ok(value.trim().length > 0, `${locale}.${key}`)
      // No page-chrome string talks about saving anymore.
      assert.doesNotMatch(
        value,
        locale === 'zh-CN' ? /保存/ : /\bsav(e|ed|ing)\b/i,
        `${locale}.${key} keeps save wording`,
      )
    }
    for (const template of [
      page.advancedCount,
      page.restoreOneBody,
      page.restoreAllBody,
      page.aboutSummary,
      page.referencesSummary,
      page.authorSummary,
    ]) {
      assert.match(template, /\{\w+\}/, `${locale} template placeholder`)
    }
    // The staged-save vocabulary is gone from the page chrome.
    const record = page as unknown as Record<string, unknown>
    for (const legacy of ['save', 'saving', 'unsaved', 'allSaved', 'discard', 'saveBar', 'saveHint', 'unsavedRow']) {
      assert.equal(legacy in record, false, `${locale} keeps legacy copy key ${legacy}`)
    }
  }
})
