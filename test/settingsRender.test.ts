/**
 * Structural smoke test for the simplified `协调` settings page.
 *
 * The catalog audit already guards the *data*; this test guards the *shape* the
 * simplification introduced, which a later refactor could silently drop:
 *
 *  - the page opens with the quick switches, the new-task defaults and the
 *    display switches — ten controls, no technical rows;
 *  - every catalog group is a closed accordion header; a closed body is not
 *    mounted, so a fresh visit never pays for the full catalog;
 *  - no native `<select>` is ever rendered: enum rows use MUI `Select` only
 *    after the host answers, and the loading branch still renders text;
 *  - there is no sticky save bar, no unsaved counter and no save button: host
 *    rows write themselves on change;
 *  - the three read-only tail sections (关于 / 参考文献 / 作者) are still there
 *    and still never gain an input.
 *
 * Server rendering is enough: `CoordinationSettings` loads its config in an
 * effect, so the first render is the loading state — the same shape this test
 * describes. `console.error` is muted because MUI's `useLayoutEffect` warning is
 * expected under the server renderer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as React from 'react'
// @ts-ignore react-dom 18 ships no declarations here and @types/react-dom is not a dependency.
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CoordinationSettings,
  SETTINGS_QUICK_SWITCH_IDS,
  settingsQuickSwitches,
} from '../src/client/settings.js'
import { COPY_BY_LOCALE, settingsControlCopy } from '../src/shared/i18n.js'
import { settingsPageCopy } from '../src/client/settingsCopy.js'
import { SETTINGS_CATALOG_GROUPS } from '../src/shared/selection.js'

/** The always-visible switch slots, in reading order (missing catalog rows drop out). */
const QUICK_SWITCHES = settingsQuickSwitches()

/** Render once with the expected React server-renderer warning muted. */
function renderSettings(): string {
  const original = console.error
  console.error = () => {}
  try {
    return String(renderToStaticMarkup(React.createElement(CoordinationSettings)))
  } finally {
    console.error = original
  }
}

test('the page opens with the quick switches and closed accordions', () => {
  const html = renderSettings()
  const copy = COPY_BY_LOCALE['zh-CN']
  const page = settingsPageCopy('zh-CN')

  // Findability: the search field is still the primary discovery affordance.
  assert.match(html, /id="settings-search"/)
  assert.ok(html.includes(copy.settings.layout.searchPlaceholder))

  // The quick-switch rows are the only settings rows mounted on load.
  assert.ok(html.includes(page.quickTitle), 'the quick-switch heading is missing')
  assert.match(html, /data-settings-page="quick-switches"/)
  for (const control of QUICK_SWITCHES) {
    const field = settingsControlCopy(copy.settings, control.copy)
    assert.ok(field !== undefined, `missing copy for ${control.id}`)
    assert.ok(html.includes(field.label), `${control.id} label missing`)
  }
  const renderedIds = [...html.matchAll(/data-setting="([^"]+)"/g)]
    .map((match) => match[1] as string)
    .sort()
  assert.deepEqual(renderedIds, QUICK_SWITCHES.map((control) => control.id).sort())

  // The slot order is pinned even when the catalog is missing the newest row.
  assert.equal(SETTINGS_QUICK_SWITCH_IDS.length, 4)
  assert.equal(
    SETTINGS_QUICK_SWITCH_IDS.indexOf('setting:ui.takeoverFiles'),
    SETTINGS_QUICK_SWITCH_IDS.indexOf('setting:ui.takeover') + 1,
  )
  // The fourth switch is named by the page itself when the catalog carries it.
  if (QUICK_SWITCHES.some((control) => control.id === 'setting:ui.takeoverFiles')) {
    assert.ok(html.includes(page.takeoverFilesLabel), 'the file-takeover label is missing')
    assert.ok(html.includes(page.takeoverFilesHint), 'the file-takeover hint is missing')
  }

  // The defaults and display blocks are closed accordion headers; their bodies
  // (and therefore their controls) are not mounted.
  for (const key of ['task-defaults', 'display-switches']) {
    assert.match(html, new RegExp(`data-settings-page="${key}"`), `${key} accordion missing`)
  }
  assert.ok(html.includes(page.defaultsTitle), 'the defaults heading is missing')
  assert.ok(html.includes(page.displayTitle), 'the display heading is missing')
  assert.doesNotMatch(html, /data-settings-body="task-defaults"/)
  assert.doesNotMatch(html, /data-settings-body="display-switches"/)
  assert.doesNotMatch(html, /data-setting="setting:defaults\.profession"/)
  assert.doesNotMatch(html, /data-setting="setting:ui\.compact"/)

  // Every catalog group is a closed accordion header: present, body not mounted.
  assert.ok(html.includes(page.advanced), 'the advanced label is missing')
  for (const group of SETTINGS_CATALOG_GROUPS) {
    assert.match(html, new RegExp(`data-settings-page="${group}"`), `${group} accordion missing`)
    assert.ok(html.includes(copy.settings.catalog.groups[group].title), `${group} header missing`)
    assert.doesNotMatch(html, new RegExp(`data-settings-body="${group}"`))
  }
  assert.doesNotMatch(html, /data-settings-body=/)
  assert.doesNotMatch(html, /data-setting="setting:maxTurnPerSession"/)

  // Every settings accordion plus the three-page tail is closed.
  const closed = html.match(/aria-expanded="false"/g) ?? []
  assert.ok(
    closed.length >= SETTINGS_CATALOG_GROUPS.length + 2,
    `expected ${SETTINGS_CATALOG_GROUPS.length + 2}+ closed accordions, got ${closed.length}`,
  )

  // A closed page offers the two local switch inputs but no host control, and
  // never a native <select> (enums render as text until the host answers).
  assert.equal((html.match(/role="switch"/g) ?? []).length, 2)
  assert.doesNotMatch(html, /<select/)
  assert.doesNotMatch(html, /<option/)
  assert.doesNotMatch(html, /role="dialog"/)

  // Apply-on-change chrome: restore-all is named, but the save bar is gone.
  assert.ok(html.includes(page.restoreAll), 'the restore-all action is missing')
  assert.ok(html.includes(page.applyHint), 'the apply hint is missing')
  assert.doesNotMatch(html, /aria-label="保存状态"/)
  assert.doesNotMatch(html, /未保存改动/)
  assert.doesNotMatch(html, />保存</)
  assert.ok(html.includes(copy.settings.states.loading))

  // The page tail is unchanged in intent: three read-only sections, and nothing
  // after the About title is a settings row.
  assert.ok(html.includes(copy.about.title), 'about section is missing')
  assert.ok(html.includes(copy.references.title), 'references section is missing')
  assert.ok(html.includes(copy.author.title), 'author section is missing')
  const aboutAt = html.indexOf(copy.about.title)
  assert.ok(aboutAt > 0, 'about section is missing')
  assert.doesNotMatch(html.slice(aboutAt), /data-setting=/)
})

test('no reset, unsaved or save affordance appears before a default is known', () => {
  const html = renderSettings()
  const copy = COPY_BY_LOCALE['zh-CN']

  assert.ok(!html.includes('恢复默认值'), 'a reset affordance appeared without a known default')
  assert.ok(!html.includes('未保存'), 'an unsaved marker appeared without a host value')
  assert.doesNotMatch(html, /aria-label="保存状态"/)
  assert.doesNotMatch(html, />保存</)
  // Host booleans/enums are text until loaded; only the two local switches are real.
  assert.equal((html.match(/role="switch"/g) ?? []).length, 2)
  assert.doesNotMatch(html, /<select/)
  assert.doesNotMatch(html, /<option/)
  assert.ok(html.includes(copy.settings.states.loading))
})
