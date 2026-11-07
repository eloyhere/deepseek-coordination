import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

// Optional browser runner: install Playwright or point PLAYWRIGHT_MODULE to an
// existing installation; BROWSER_EXECUTABLE selects an existing Chromium/Edge.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const build = await rolldown({
  input: fileURLToPath(new URL('./dialogs.fixture.ts', import.meta.url)),
  platform: 'browser',
  transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production') } },
  onLog(level, log, handler) { if (log.code !== 'MODULE_LEVEL_DIRECTIVE') handler(level, log) },
})
const generated = await build.generate({ format: 'iife' })
const bundle = generated.output.find((item) => item.type === 'chunk')?.code
assert.ok(bundle)
await build.close()
const browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), headless: true })
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
let pending = []
let submitted = []
let notices = []
let preferences = { takeoverNotifications: true }
await page.route('http://dialog.test/**', async (route) => {
  const url = new URL(route.request().url())
  let value = {}
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><button id="background" onclick="window.backgroundClicks=(window.backgroundClicks||0)+1">Background action</button><div id="app"></div><script src="/bundle.js"></script></body></html>' })
  if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle })
  if (url.pathname.endsWith('/amp/preferences')) {
    if (route.request().method() === 'PUT') preferences = JSON.parse(route.request().postData())
    value = preferences
  } else if (url.pathname.endsWith('/dialogs/pending')) value = { items: pending }
  else if (url.pathname.endsWith('/dialogs/answer') || url.pathname.endsWith('/dialogs/cancel')) {
    const body = JSON.parse(route.request().postData())
    submitted.push(body)
    pending = pending.filter((item) => item.id !== body.id)
    value = { accepted: true }
  } else if (url.pathname.endsWith('/notify/pending')) { value = { items: notices }; notices = [] }
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value }) })
})
const modal = page.locator('dialog[data-amp-dialog][open]')
async function blocksPage() {
  await modal.waitFor()
  assert.equal(await modal.evaluate((element) => element.matches(':modal')), true)
  await page.mouse.click(5, 5)
  await page.keyboard.press('Escape')
  assert.equal(await modal.count(), 1)
  assert.equal(await page.evaluate(() => window.backgroundClicks ?? 0), 0)
  await page.locator('#background').evaluate((button) => button.focus())
  assert.equal(await page.evaluate(() => document.activeElement?.id === 'background'), false)
}
try {
  await page.goto('http://dialog.test/')
  pending = [{ id: 'approval', kind: 'approval', toolName: 'write', reason: 'Confirm a write' }]
  await blocksPage()
  await modal.getByRole('button', { name: '仅本次允许' }).click()
  await modal.waitFor({ state: 'detached' })
  assert.equal(submitted.at(-1).outcome, 'allowed-once')
  console.log('PASS confirmation: native modal, page inert, outside/Escape ignored, answer forwarded')

  pending = [{ id: 'single', kind: 'questions', questions: [{ id: 'one', question: 'Choose one', options: [{ label: 'Red' }, { label: 'Blue' }] }] }]
  await blocksPage()
  await modal.getByRole('radio', { name: 'Red' }).check()
  await modal.getByRole('radio', { name: 'Blue' }).check()
  assert.equal(await modal.getByRole('radio', { name: 'Red' }).isChecked(), false)
  await modal.getByRole('button', { name: '提交回答' }).click()
  await modal.waitFor({ state: 'detached' })
  assert.deepEqual(submitted.at(-1).answers, [{ id: 'one', selected: ['Blue'] }])
  console.log('PASS single choice: exclusive MUI radios and correct payload')

  pending = [{ id: 'multiple', kind: 'questions', questions: [{ id: 'many', question: 'Choose several', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] }]
  await blocksPage()
  await modal.getByRole('checkbox', { name: 'A' }).check()
  await modal.getByRole('checkbox', { name: 'B' }).check()
  await modal.getByRole('button', { name: '提交回答' }).click()
  await modal.waitFor({ state: 'detached' })
  assert.deepEqual(submitted.at(-1).answers, [{ id: 'many', selected: ['A', 'B'] }])
  console.log('PASS multiple choice: independent MUI checkboxes and correct payload')

  pending = [{ id: 'input', kind: 'questions', questions: [{ id: 'text', question: 'Enter a description' }] }]
  await blocksPage()
  await modal.getByRole('textbox', { name: '其他回答' }).fill('User input\nSecond line')
  if (process.env.DIALOG_SCREENSHOT) await page.screenshot({ path: process.env.DIALOG_SCREENSHOT })
  await modal.getByRole('button', { name: '提交回答' }).click()
  await modal.waitFor({ state: 'detached' })
  assert.deepEqual(submitted.at(-1).answers, [{ id: 'text', selected: [], custom: 'User input\nSecond line' }])
  console.log('PASS input: MUI multiline text field and correct payload')

  notices = [{ id: 'information', surface: 'dialog', severity: 'info', message: 'Information to acknowledge', duration: 0, actions: [], anchor: 'bottom-right' }]
  await blocksPage()
  await modal.getByRole('button', { name: '知道了' }).click()
  await modal.waitFor({ state: 'detached' })
  console.log('PASS information: explicit acknowledgement')

  await page.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.id = 'host-overlay'
    overlay.setAttribute('role', 'presentation')
    overlay.innerHTML = '<div aria-hidden="true"></div><div role="dialog" aria-modal="true" aria-label="Host input"><div><h2>Host input</h2><p>Original host body</p><input aria-label="Host value" value="initial"></div><div><button>Cancel</button><button>Save</button></div></div>'
    overlay.querySelector('input').addEventListener('input', (event) => { window.hostValue = event.target.value })
    overlay.querySelectorAll('button').forEach((button) => button.onclick = () => { window.hostAction = button.textContent; overlay.remove() })
    document.body.append(overlay)
  })
  await blocksPage()
  assert.equal(await page.locator('#host-overlay').isVisible(), false)
  await modal.getByRole('textbox', { name: 'Host value' }).fill('Mirrored MUI input')
  await modal.getByRole('button', { name: 'Save' }).click()
  await modal.waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => window.hostValue), 'Mirrored MUI input')
  assert.equal(await page.evaluate(() => window.hostAction), 'Save')
  console.log('PASS shared host modal: original hidden, MUI input and original action preserved')

  await page.evaluate(() => window.openControlledNative())
  await modal.waitFor()
  await modal.getByRole('textbox', { name: 'Controlled text' }).pressSequentially('continuous input', { delay: 30 })
  assert.equal(await modal.getByRole('textbox', { name: 'Controlled text' }).inputValue(), 'continuous input')
  await modal.getByRole('checkbox', { name: 'Acknowledge' }).check()
  await modal.getByRole('button', { name: 'Submit input' }).click()
  await modal.waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => window.controlledResult), 'continuous input')
  console.log('PASS controlled host form: continuous text entry and dynamic button state')

  await page.evaluate(() => window.setTakeover(false))
  await page.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.id = 'host-disabled'
    overlay.setAttribute('role', 'presentation')
    overlay.innerHTML = '<div aria-hidden="true"></div><div role="dialog" aria-modal="true"><div><h2>Native restored</h2></div><div><button>OK</button></div></div>'
    document.body.append(overlay)
  })
  await page.waitForTimeout(100)
  assert.equal(await modal.count(), 0)
  assert.equal(await page.locator('#host-disabled').isVisible(), true)
  await page.evaluate(() => window.setTakeover(true))
  await modal.waitFor()
  assert.equal(await page.locator('#host-disabled').isVisible(), false)
  await page.evaluate(() => window.setTakeover(false))
  await modal.waitFor({ state: 'detached' })
  assert.equal(await page.locator('#host-disabled').isVisible(), true)
  assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '')
  assert.deepEqual(errors, [])
  console.log('PASS disabled preference: original host modal remains visible; no browser exceptions')
} finally { await browser.close() }
