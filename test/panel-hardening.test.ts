/**
 * Hardening tests for the docked coordination panels.
 *
 * The panel is a browser module, but the behaviours that contain a failure are
 * framework-level and can be exercised on Node with a small DOM shim:
 *
 *  - a healthy boundary renders its children;
 *  - a throwing child is replaced by `null`, logged once with the component
 *    stack, and remembered for the title-bar status chip;
 *  - `localStorage['coordination.panel.disabled']` short-circuits mounting;
 *  - importing this module never touches `window`/`document` at module scope.
 *
 * React does not run error boundaries during server rendering, so the two
 * render tests use `react-dom/client` plus a minimal DOM rather than
 * `react-dom/server`. No jsdom dependency is added for this.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as React from 'react'
// @ts-ignore react-dom 18 ships no declarations here and @types/react-dom is not a dependency.
import { createRoot as createRootUntyped } from 'react-dom/client'
import {
  COLUMN_SX,
  CoordinationPanels,
  HEADER_SX,
  LEFT_PANEL_ROUTES,
  LEFT_PANEL_TABS,
  MESSAGE_SANITIZE_CONFIG,
  NAV_SX,
  PANEL_COLLAPSED_FLEX,
  PANEL_CONTENT_SX,
  PANEL_EXPANDED_FLEX,
  PANEL_ITEM_SX,
  PANEL_RESIZE_TRANSITION,
  PANEL_ROW_ACTION_SX,
  PANEL_ROW_HEIGHT,
  PANEL_ROW_ICON_SX,
  PANEL_ROW_SX,
  PanelErrorBoundary,
  RIGHT_PANEL_ROUTES,
  RIGHT_PANEL_TABS,
  SCOPE_BAR_SX,
  SCROLL_THUMB_SX,
  SCROLL_TRACK_SX,
  Task,
  createVirtualListAdapter,
  createVirtualTreeAdapter,
  entryTreeAdapter,
  estimateMessageHeight,
  fitScale,
  getPanelError,
  getTaskQueue,
  groupOutlineByProject,
  initialPanelNavigation,
  isOutlineStructureKind,
  isPanelDisabled,
  layoutRadius,
  messageAlignment,
  messageCanExpand,
  messageRoleKind,
  outermostOutlineProjects,
  outlineProjectOf,
  panelErrorTooltip,
  panelNavigationReducer,
  sanitizeMessageHtml,
  shouldDrawLabel,
  splitPanelHeights,
  taskQueue,
  visibleTreeRows,
  workspaceRelativeRoot,
} from '../src/client/panel.js'

interface ClientRoot {
  render(node: React.ReactNode): void
  unmount(): void
}

const createRoot = createRootUntyped as (container: Element) => ClientRoot

/**
 * `React.act()` falls back to a MessageChannel when it cannot reach a CommonJS
 * `require('timers')` binding (the bundled react-dom closure shadows `module`).
 * Real MessagePorts keep Node's event loop alive after the tests, so this
 * in-process shim delivers the same callback without creating a handle.
 */
class ActMessageChannel {
  port1: { onmessage: ((event: unknown) => void) | null; close(): void } = {
    onmessage: null,
    close: () => {},
  }

  port2 = {
    postMessage: (): void => {
      queueMicrotask(() => this.port1.onmessage?.({ data: null }))
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Minimal DOM (only what React DOM needs for a class-component tree)
 * ------------------------------------------------------------------------- */

type FakeNodeLike = FakeNode

class FakeNode {
  nodeType: number
  nodeName: string
  childNodes: FakeNodeLike[] = []
  parentNode: FakeNodeLike | null = null
  ownerDocument: FakeDocument | null = null
  nodeValue = ''

  constructor(nodeType: number, nodeName: string) {
    this.nodeType = nodeType
    this.nodeName = nodeName
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  get nextSibling(): FakeNode | null {
    if (this.parentNode === null) return null
    const index = this.parentNode.childNodes.indexOf(this)
    return this.parentNode.childNodes[index + 1] ?? null
  }

  get previousSibling(): FakeNode | null {
    if (this.parentNode === null) return null
    const index = this.parentNode.childNodes.indexOf(this)
    return index > 0 ? this.parentNode.childNodes[index - 1] : null
  }

  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore<T extends FakeNode>(child: T, before: FakeNode | null): T {
    if (before === null) return this.appendChild(child)
    const index = this.childNodes.indexOf(before)
    if (index === -1) return this.appendChild(child)
    child.parentNode = this
    this.childNodes.splice(index, 0, child)
    return child
  }

  removeChild<T extends FakeNode>(child: T): T {
    const index = this.childNodes.indexOf(child)
    if (index !== -1) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }

  replaceChild(next: FakeNode, previous: FakeNode): FakeNode {
    this.insertBefore(next, previous)
    return this.removeChild(previous)
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.childNodes = []
    if (value !== '' && value != null) {
      this.appendChild(this.ownerDocument!.createTextNode(String(value)))
    }
  }

  contains(node: FakeNode | null): boolean {
    for (let current: FakeNode | null = node; current !== null; current = current.parentNode) {
      if (current === this) return true
    }
    return false
  }

  getRootNode(): FakeNode {
    let node: FakeNode = this
    while (node.parentNode !== null) node = node.parentNode
    return node
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true
  }

  getBoundingClientRect(): Record<string, number> {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }
  }

  focus(): void {}
  blur(): void {}
  scrollIntoView(): void {}
}

class FakeText extends FakeNode {
  constructor(data: string) {
    super(3, '#text')
    this.nodeValue = data
  }

  get textContent(): string {
    return this.nodeValue
  }

  set textContent(value: string) {
    this.nodeValue = String(value)
  }
}

class FakeComment extends FakeNode {
  constructor(data: string) {
    super(8, '#comment')
    this.nodeValue = data
  }

  get textContent(): string {
    return this.nodeValue
  }
}

class FakeElement extends FakeNode {
  tagName: string
  namespaceURI: string
  attributes: Record<string, string> = Object.create(null)
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  id = ''
  className = ''

  constructor(tagName: string, namespaceURI = 'http://www.w3.org/1999/xhtml') {
    super(1, tagName.toUpperCase())
    this.tagName = tagName.toUpperCase()
    this.namespaceURI = namespaceURI
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name.toLowerCase()] = String(value)
    if (name === 'id') this.id = String(value)
    if (name === 'class') this.className = String(value)
  }

  getAttribute(name: string): string | null {
    const value = this.attributes[name.toLowerCase()]
    return value === undefined ? null : value
  }

  hasAttribute(name: string): boolean {
    return this.attributes[name.toLowerCase()] !== undefined
  }

  removeAttribute(name: string): void {
    delete this.attributes[name.toLowerCase()]
  }

  attachShadow(): FakeElement {
    return this
  }

  get sheet(): null {
    return null
  }
}

class FakeDocument extends FakeNode {
  documentElement: FakeElement
  head: FakeElement
  body: FakeElement
  activeElement: FakeElement
  readyState = 'complete'
  compatMode = 'CSS1Compat'

  constructor() {
    super(9, '#document')
    this.ownerDocument = this
    this.documentElement = this.createElement('html')
    this.head = this.createElement('head')
    this.body = this.createElement('body')
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.appendChild(this.documentElement)
    this.activeElement = this.body
  }

  createElement(tagName: string): FakeElement {
    const element = new FakeElement(tagName)
    element.ownerDocument = this
    return element
  }

  createElementNS(namespaceURI: string, tagName: string): FakeElement {
    const element = new FakeElement(tagName, namespaceURI)
    element.ownerDocument = this
    return element
  }

  createTextNode(data: string): FakeText {
    const node = new FakeText(String(data))
    node.ownerDocument = this
    return node
  }

  createComment(data: string): FakeComment {
    const node = new FakeComment(String(data))
    node.ownerDocument = this
    return node
  }

  createDocumentFragment(): FakeNode {
    const fragment = new FakeNode(11, '#document-fragment')
    fragment.ownerDocument = this
    return fragment
  }

  getElementById(): null {
    return null
  }

  querySelector(): null {
    return null
  }

  querySelectorAll(): [] {
    return []
  }
}

interface FakeStorage {
  values: Map<string, string>
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function createStorage(): FakeStorage {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value)
    },
  }
}

/** Installed once, before the render tests; panel import already happened. */
const document = new FakeDocument()
const storage = createStorage()
const fakeWindow = {
  document,
  navigator: { userAgent: 'node' },
  localStorage: storage,
  HTMLElement: FakeElement,
  Element: FakeElement,
  Node: FakeNode,
  Text: FakeText,
  Document: FakeDocument,
  SVGElement: FakeElement,
  HTMLIFrameElement: class {},
  HTMLInputElement: class {},
  HTMLTextAreaElement: class {},
  HTMLSelectElement: class {},
  MutationObserver: class {
    observe(): void {}
    disconnect(): void {}
  },
  addEventListener(): void {},
  removeEventListener(): void {},
  getComputedStyle(): { getPropertyValue: () => string } {
    return { getPropertyValue: () => '' }
  },
  requestAnimationFrame: (callback: () => void): ReturnType<typeof setTimeout> => setTimeout(callback, 0),
  cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>): void => clearTimeout(handle),
  devicePixelRatio: 1,
}

const globals = globalThis as unknown as Record<string, unknown>
const hadNoWindowAtImport = globals.window === undefined

/*
 * Install the shim only for the individual test that needs it. `npm test`
 * imports every test bundle into one process, so any global installed at module
 * scope or in a file-level hook would leak into unrelated tests.
 */
function installDom(): () => void {
  const saved = {
    document: globals.document,
    window: globals.window,
    MessageChannel: globals.MessageChannel,
    actEnvironment: globals.IS_REACT_ACT_ENVIRONMENT,
  }
  globals.document = document
  globals.window = fakeWindow
  globals.MessageChannel = ActMessageChannel
  globals.IS_REACT_ACT_ENVIRONMENT = true
  return () => {
    const restore = (key: string, value: unknown): void => {
      if (value === undefined) delete globals[key]
      else globals[key] = value
    }
    restore('document', saved.document)
    restore('window', saved.window)
    restore('MessageChannel', saved.MessageChannel)
    restore('IS_REACT_ACT_ENVIRONMENT', saved.actEnvironment)
  }
}

function createHost(): { container: FakeElement; root: ClientRoot } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container as unknown as Element)
  return { container, root }
}

/* ------------------------------------------------------------------------- *
 * Tests
 * ------------------------------------------------------------------------- */

test('PanelErrorBoundary renders healthy children normally', async () => {
  const restoreDom = installDom()
  const { container, root } = createHost()
  try {
    await React.act(async () => {
      root.render(
        React.createElement(
          PanelErrorBoundary,
          null,
          React.createElement('span', { id: 'healthy' }, 'healthy panel'),
        ),
      )
    })
    assert.equal(container.textContent, 'healthy panel')
    assert.equal(container.childNodes.length, 1)
  } finally {
    await React.act(async () => {
      root.unmount()
    })
    restoreDom()
  }
})

test('a throwing child renders null, reports once, and records the error', async () => {
  const restoreDom = installDom()
  const boom = new Error('panel rendering exploded')
  const logged: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]): void => {
    logged.push(args)
  }

  const { container, root } = createHost()
  try {
    await React.act(async () => {
      root.render(
        React.createElement(
          PanelErrorBoundary,
          null,
          React.createElement(function ThrowingChild(): React.ReactElement {
            throw boom
          }),
        ),
      )
    })
    assert.equal(container.textContent, '')
    assert.equal(container.childNodes.length, 0)

    const reports = logged.filter((args) => args[0] === '[coordination] panel failed')
    assert.equal(reports.length, 1, 'boundary must report the failure exactly once')
    assert.equal(reports[0]?.[1], boom)
    assert.equal(typeof reports[0]?.[2], 'string')
    assert.match(String(reports[0]?.[2]), /ThrowingChild/)

    assert.equal(getPanelError(), boom)
    assert.equal(panelErrorTooltip(boom), 'panel rendering exploded')
  } finally {
    console.error = originalError
    await React.act(async () => {
      root.unmount()
    })
    restoreDom()
  }
})

test('panelErrorTooltip caps the message at 200 characters', () => {
  assert.equal(panelErrorTooltip(new Error('x'.repeat(500))).length, 200)
})

test('isPanelDisabled accepts 1/true and keeps every other value disabled', () => {
  const restoreDom = installDom()
  try {
    for (const [value, expected] of [
      ['1', true],
      ['true', true],
      ['0', false],
      ['false', false],
      ['', false],
      [null, false],
    ] as const) {
      if (value === null) storage.values.delete('coordination.panel.disabled')
      else storage.values.set('coordination.panel.disabled', value)
      assert.equal(isPanelDisabled(), expected, `value ${JSON.stringify(value)}`)
    }
  } finally {
    storage.values.delete('coordination.panel.disabled')
    restoreDom()
  }
})

test('the disabled flag short-circuits mounting the whole column', async () => {
  const restoreDom = installDom()
  storage.values.set('coordination.panel.disabled', '1')
  const { container, root } = createHost()
  try {
    await React.act(async () => {
      root.render(React.createElement(CoordinationPanels, { sessionId: 'hardening-test' }))
    })
    assert.equal(container.textContent, '')
    assert.equal(container.childNodes.length, 0)
  } finally {
    storage.values.delete('coordination.panel.disabled')
    await React.act(async () => {
      root.unmount()
    })
    restoreDom()
  }
})

test('module import does not touch window/document at module scope', () => {
  assert.equal(hadNoWindowAtImport, true, 'panel.js was imported before the DOM shim existed')

  const sourcePath = resolve(process.cwd(), 'src/client/panel.ts')
  const source = readFileSync(sourcePath, 'utf8')
  const offenders: Array<{ line: number; text: string }> = []
  source.split(/\r?\n/).forEach((text, index) => {
    if (/^\s/.test(text)) return
    const code = text.replace(/^\s+/, '')
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
    if (/\b(?:window|document|ResizeObserver|requestAnimationFrame)\s*[.(]/.test(code)) {
      offenders.push({ line: index + 1, text })
    }
  })
  assert.deepEqual(offenders, [], 'module-scope browser globals found in panel.ts')
})

test('index.ts lazy-loads panel.js instead of statically importing it', () => {
  const sourcePath = resolve(process.cwd(), 'src/client/index.ts')
  const source = readFileSync(sourcePath, 'utf8')
  assert.doesNotMatch(
    source,
    /import\s*\{[^}]*CoordinationPanels[^}]*\}\s*from\s*['"]\.\/panel\.js['"]/,
    'panel.js must not be imported statically',
  )
  assert.match(source, /React\.lazy\([\s\S]*import\(['"]\.\/panel\.js['"]\)/)
  assert.match(source, /React\.Suspense/)
})

/* ------------------------------------------------------------------------- *
 * Panel navigation: component state is the source of truth
 * ------------------------------------------------------------------------- */

const RIGHT_ROUTED_VIEWS = ['files', 'outline', 'dependencies', 'imports', 'preview'] as const
const LEFT_ROUTED_VIEWS = ['files', 'agents', 'agent', 'dependencies', 'imports', 'exports'] as const

test('view switching is reducer state; the hash is read once as a deep link', () => {
  // The deep link seeds the named side exactly once, including its selection.
  assert.deepEqual(
    initialPanelNavigation(
      '#coordination/panel/right/outline?path=src%2Fa.ts',
      'right',
      RIGHT_ROUTED_VIEWS,
      'files',
    ),
    { view: 'outline', path: 'src/a.ts', id: null },
  )
  assert.deepEqual(
    initialPanelNavigation(
      '#coordination/panel/left/agent?id=agent-1',
      'left',
      LEFT_ROUTED_VIEWS,
      'files',
    ),
    { view: 'agent', path: null, id: 'agent-1' },
  )

  // A hash that names the other side (or is a host route) is not consumed.
  assert.deepEqual(
    initialPanelNavigation(
      '#coordination/panel/right/outline?path=src%2Fa.ts',
      'left',
      LEFT_ROUTED_VIEWS,
      'files',
    ),
    { view: 'files', path: null, id: null },
  )
  assert.deepEqual(
    initialPanelNavigation('#some/host/route', 'right', RIGHT_ROUTED_VIEWS, 'files'),
    { view: 'files', path: null, id: null },
  )

  // A tab click is a local transition; it never consults the hash again.
  const initial = initialPanelNavigation(
    '#coordination/panel/right/outline?path=src%2Fa.ts',
    'right',
    RIGHT_ROUTED_VIEWS,
    'files',
  )
  const switched = panelNavigationReducer(initial, { type: 'navigate', view: 'dependencies' })
  assert.deepEqual(switched, { view: 'dependencies', path: null, id: null })

  // Selecting a file keeps the view; dropping it returns to workspace mode.
  const selected = panelNavigationReducer(switched, {
    type: 'navigate',
    view: 'dependencies',
    path: 'src/a.ts',
  })
  assert.deepEqual(selected, { view: 'dependencies', path: 'src/a.ts', id: null })
  assert.deepEqual(
    panelNavigationReducer(selected, { type: 'navigate', view: 'dependencies' }),
    { view: 'dependencies', path: null, id: null },
  )

  // The same action returns the same object (no needless re-render).
  assert.equal(
    panelNavigationReducer(selected, { type: 'navigate', view: 'dependencies', path: 'src/a.ts' }),
    selected,
  )
})

test('the hash cannot clobber local state: no hashchange/popstate subscription', () => {
  const sourcePath = resolve(process.cwd(), 'src/client/panel.ts')
  const source = readFileSync(sourcePath, 'utf8')

  assert.doesNotMatch(source, /addEventListener\(\s*['"]hashchange['"]/)
  assert.doesNotMatch(source, /addEventListener\(\s*['"]popstate['"]/)
  assert.doesNotMatch(source, /useSyncExternalStore\(\s*subscribeRoute/)
  // One mount-time read feeds the reducer; navigation then mirrors the hash.
  assert.match(source, /initialPanelNavigation\(\s*readHash\(\)/)
  assert.match(source, /history\.replaceState/)
  // The mirror is best-effort: a throwing host router must not undo a click.
  const mirror = /function mirrorHash[\s\S]*?\n}/.exec(source)
  assert.ok(mirror !== null, 'mirrorHash must exist')
  assert.match(mirror[0], /try\s*\{[\s\S]*replaceState[\s\S]*\}\s*catch/)
})

/* ------------------------------------------------------------------------- *
 * Panel layout: bottom anchoring and a bounded internal stack
 * ------------------------------------------------------------------------- */

test('column is bottom-anchored so expansion pushes the upper panel up', () => {
  assert.equal(COLUMN_SX.justifyContent, 'flex-end')
  assert.equal(COLUMN_SX.flexDirection, 'column')
  assert.equal(COLUMN_SX.display, 'flex')
})

test('two expanded panels split the column height equally', () => {
  // Identical flex-basis/grow for every expanded panel -> 50/50 split; the
  // collapsed panel is pinned to its 48 px title bar instead.
  assert.equal(PANEL_EXPANDED_FLEX, '1 1 0')
  assert.equal(PANEL_COLLAPSED_FLEX, '0 0 48px')
  assert.equal(PANEL_ITEM_SX.minHeight, 0)
})

test('height changes animate with the MUI collapse timing', () => {
  assert.match(PANEL_RESIZE_TRANSITION, /flex-grow/)
  assert.match(PANEL_RESIZE_TRANSITION, /flex-basis/)
  assert.match(PANEL_RESIZE_TRANSITION, /220ms/)
  assert.match(PANEL_RESIZE_TRANSITION, /cubic-bezier\(0\.4, 0, 0\.2, 1\)/)
})

test('title bar is the blue primary bar with contrast text', () => {
  assert.equal(HEADER_SX.backgroundColor, 'primary.main')
  assert.equal(HEADER_SX.color, 'primary.contrastText')
  assert.equal(HEADER_SX.flex, 'none')
  assert.equal(HEADER_SX.height, 48)
})

test('header search is a MUI Autocomplete, not the old bare TextField', () => {
  const sourcePath = resolve(process.cwd(), 'src/client/panel.ts')
  const source = readFileSync(sourcePath, 'utf8')
  assert.match(source, /import Autocomplete from '@mui\/material\/Autocomplete'/)
  assert.match(source, /h\(MuiAutocomplete, \{/)
  assert.match(source, /renderSearchInput/)
  assert.match(source, /filterOptions:/)
  // The old standalone result list is gone: results live in the listbox.
  assert.doesNotMatch(source, /function SearchResults\(/)
})

test('Autocomplete dropdown replaces the native bar with the React scrollbar', () => {
  // Transparent groove, light-grey thumb.
  assert.equal(SCROLL_TRACK_SX.backgroundColor, 'transparent')
  assert.equal(SCROLL_THUMB_SX.backgroundColor, 'rgba(0, 0, 0, 0.22)')

  const sourcePath = resolve(process.cwd(), 'src/client/panel.ts')
  const source = readFileSync(sourcePath, 'utf8')
  assert.match(source, /export function ScrollBar\(/)
  assert.match(source, /function AutocompleteScrollListboxBase\(/)
  assert.match(source, /const AutocompleteScrollListbox = React\.forwardRef\(/)
  assert.match(source, /slots: \{ listbox: AutocompleteScrollListbox \}/)
  // The native bar is hidden so only the custom thumb remains.
  assert.match(source, /scrollbarWidth: 'none'/)
  assert.match(source, /&::-webkit-scrollbar/)
})

/* ------------------------------------------------------------------------- *
 * Canvas graph density: auto-fit, label declutter and gap-aware layout radius
 * ------------------------------------------------------------------------- */

test('fitScale clamps auto-fit zoom to [0.15, 1]', () => {
  const viewport = { width: 400, height: 300 }

  // A huge graph hits the interactive floor; a tight one keeps the 1:1 ceiling.
  assert.equal(fitScale({ minX: 0, minY: 0, maxX: 8000, maxY: 8000 }, viewport, 48), 0.15)
  assert.equal(fitScale({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, viewport, 48), 1)

  // `pad` takes part in the formula: 400 / (600 + 48), not 400 / 600.
  const padded = fitScale({ minX: 0, minY: 0, maxX: 600, maxY: 0 }, viewport, 48)
  assert.ok(Math.abs(padded - 400 / 648) < 1e-12, `unexpected fit scale ${padded}`)

  // The default pad matches the documented ~48 px breathing room.
  assert.equal(
    fitScale({ minX: 0, minY: 0, maxX: 600, maxY: 0 }, viewport),
    fitScale({ minX: 0, minY: 0, maxX: 600, maxY: 0 }, viewport, 48),
  )
})

test('fitScale returns 1 for a single node and an empty graph', () => {
  // A one-node bbox is degenerate: even a tiny viewport must not zoom out.
  assert.equal(
    fitScale({ minX: 7, minY: 9, maxX: 7, maxY: 9 }, { width: 20, height: 20 }, 48),
    1,
  )
  // No positions at all (empty/loading graph) keeps the neutral view.
  assert.equal(fitScale(null, { width: 400, height: 300 }, 48), 1)
  // An unmeasured viewport must not collapse the scale to the floor.
  assert.equal(fitScale({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { width: 0, height: 0 }, 48), 1)
})

test('shouldDrawLabel hides inactive labels only below the 0.55 threshold', () => {
  const cases: Array<{ scale: number; active: boolean; expected: boolean }> = [
    { scale: 3, active: false, expected: true },
    { scale: 1, active: false, expected: true },
    { scale: 0.55, active: false, expected: true },
    { scale: 0.549, active: false, expected: false },
    { scale: 0.3, active: false, expected: false },
    { scale: 0.15, active: false, expected: false },
    { scale: 1, active: true, expected: true },
    { scale: 0.549, active: true, expected: true },
    { scale: 0.15, active: true, expected: true },
  ]
  for (const entry of cases) {
    assert.equal(
      shouldDrawLabel(entry.scale, entry.active),
      entry.expected,
      `scale=${entry.scale} active=${entry.active}`,
    )
  }
})

test('layoutRadius grows with sqrt(nodeCount) and stays bounded', () => {
  const counts = [0, 1, 2, 5, 20, 50, 120, 200]
  const radii = counts.map((count) => layoutRadius(count))
  for (let index = 1; index < radii.length; index += 1) {
    assert.ok(
      radii[index] > radii[index - 1],
      `radius must grow monotonically at ${counts[index]} nodes`,
    )
  }
  assert.ok(radii[0] >= 48, 'radius has a floor')
  assert.ok(radii[radii.length - 1] <= 640, 'radius is capped for the 200-node limit')
  assert.ok(layoutRadius(120) > layoutRadius(20), '120 nodes get a wider ring than 20')

  // Degenerate counts are neutral, and the cap wins above the node limit.
  assert.equal(layoutRadius(-5), layoutRadius(0))
  assert.equal(layoutRadius(Number.NaN), layoutRadius(0))
  assert.equal(layoutRadius(5000), layoutRadius(200))
})

test('panel internals form a bounded stack: header / scope / scroll / nav', () => {
  // Panels may share the column, never stretch it.
  assert.equal(PANEL_ITEM_SX.minHeight, 0)
  assert.equal(PANEL_ITEM_SX.overflow, 'hidden')

  // Fixed 48 px title bar.
  assert.equal(HEADER_SX.flex, 'none')
  assert.equal(HEADER_SX.height, 48)
  assert.equal(HEADER_SX.minHeight, 48)
  assert.equal(HEADER_SX.maxHeight, 48)

  // Fixed scope bar and a content column that owns the scroll.
  assert.equal(SCOPE_BAR_SX.flex, 'none')
  assert.equal(PANEL_CONTENT_SX.flexDirection, 'column')
  assert.equal(PANEL_CONTENT_SX.minHeight, 0)
  assert.equal(PANEL_CONTENT_SX.overflow, 'hidden')
  assert.match(String(PANEL_CONTENT_SX.flex), /^1 /)

  // Fixed-height bottom navigation, separate from the scroller.
  assert.equal(NAV_SX.flex, 'none')
  assert.equal(typeof NAV_SX.height, 'number')
  assert.equal(typeof NAV_SX.maxHeight, 'number')
  assert.ok((NAV_SX.height as number) > 0)
})

/* ------------------------------------------------------------------------- *
 * Virtual tree / list API
 * ------------------------------------------------------------------------- */

interface TreeNode {
  name: string
  children?: TreeNode[]
}

const TREE: TreeNode[] = [
  {
    name: 'a',
    children: [
      { name: 'a1' },
      { name: 'a2', children: [{ name: 'a2x' }] },
    ],
  },
  { name: 'b' },
]

function treeAdapter(nodes: readonly TreeNode[]) {
  return createVirtualTreeAdapter<TreeNode>(
    nodes,
    (node) => node.name,
    (node) => node.children ?? [],
  )
}

function rowsOf(nodes: readonly TreeNode[], collapsed: readonly string[] = []) {
  return visibleTreeRows(treeAdapter(nodes), new Set(collapsed)).map((row) => [
    row.depth,
    row.index,
    row.value.name,
  ])
}

test('visibleTreeRows flattens pre-order with a continuous array index', () => {
  assert.deepEqual(rowsOf(TREE), [
    [0, 0, 'a'],
    [1, 1, 'a1'],
    [1, 2, 'a2'],
    [2, 3, 'a2x'],
    [0, 4, 'b'],
  ])
})

test('visibleTreeRows keeps a collapsed branch row but skips its subtree', () => {
  assert.deepEqual(rowsOf(TREE, ['a']), [
    [0, 0, 'a'],
    [0, 1, 'b'],
  ])
  // Collapsing a nested branch only hides that branch, and indices stay
  // continuous across the remaining rows.
  assert.deepEqual(rowsOf(TREE, ['a2']), [
    [0, 0, 'a'],
    [1, 1, 'a1'],
    [1, 2, 'a2'],
    [0, 3, 'b'],
  ])
})

test('visibleTreeRows handles the empty tree and a single node', () => {
  assert.deepEqual(visibleTreeRows(treeAdapter([]), new Set()), [])
  assert.deepEqual(visibleTreeRows(treeAdapter([{ name: 'only' }]), new Set()), [
    { depth: 0, index: 0, value: { name: 'only' } },
  ])
})

test('tree keys are stable across an equivalent rebuild', () => {
  interface KeyedEntry {
    key: string
    value: string
    children?: KeyedEntry[]
  }
  const build = (): KeyedEntry[] => [
    { key: 'a', value: 'A', children: [{ key: 'a1', value: 'A1' }] },
    { key: 'b', value: 'B' },
  ]
  const first = entryTreeAdapter(build())
  const second = entryTreeAdapter(build())
  assert.deepEqual(
    visibleTreeRows(first, new Set()).map((row) => row.value.key),
    ['a', 'a1', 'b'],
  )
  // The same collapsed key hides the same subtree after the rebuild.
  assert.deepEqual(
    visibleTreeRows(second, new Set(['a'])).map((row) => row.value.key),
    ['a', 'b'],
  )
})

test('createVirtualTreeAdapter treats a missing children callback as a leaf', () => {
  const adapter = createVirtualTreeAdapter(['x', 'y'], (value) => value)
  assert.deepEqual(adapter.children('x'), [])
  assert.deepEqual(visibleTreeRows(adapter, new Set()).map((row) => row.value), ['x', 'y'])
})

test('createVirtualListAdapter covers the size boundaries', () => {
  const empty = createVirtualListAdapter<number>([])
  assert.equal(empty.size, 0)
  assert.equal(empty.at(0), undefined)

  const one = createVirtualListAdapter(['only'])
  assert.equal(one.size, 1)
  assert.equal(one.at(0), 'only')
  assert.equal(one.at(1), undefined)
  assert.equal(one.at(-1), undefined)
  assert.equal(one.key(0), '0')

  const keyed = createVirtualListAdapter(['a', 'b'], (value, index) => `${index}:${value}`)
  assert.equal(keyed.size, 2)
  assert.equal(keyed.key(1), '1:b')
})

/* ------------------------------------------------------------------------- *
 * MUI dense row recipe and canvas tab routes
 * ------------------------------------------------------------------------- */

function panelSource(): string {
  return readFileSync(resolve(process.cwd(), 'src/client/panel.ts'), 'utf8')
}

test('panel rows use the MUI dense ListItemButton recipe', () => {
  assert.equal(PANEL_ROW_HEIGHT, 48)
  assert.equal(PANEL_ROW_SX.height, 48)
  assert.equal(PANEL_ROW_SX.minHeight, 48)
  assert.equal(PANEL_ROW_SX.maxHeight, 48)
  assert.equal(PANEL_ROW_SX.padding, '4px 8px')
  assert.equal(PANEL_ROW_SX.display, 'flex')
  assert.equal(PANEL_ROW_SX.alignItems, 'center')
  assert.equal(PANEL_ROW_SX.width, '100%')
  assert.equal(PANEL_ROW_SX.borderRadius, 4)
  assert.equal(PANEL_ROW_SX['&:hover'].backgroundColor, 'action.hover')
  assert.equal(PANEL_ROW_SX['&.Mui-selected'].backgroundColor, 'action.selected')

  // Inset 2 px primary focus ring.
  assert.equal(PANEL_ROW_SX['&:focus-visible'].outline, '2px solid')
  assert.equal(PANEL_ROW_SX['&:focus-visible'].outlineColor, 'primary.main')
  assert.equal(PANEL_ROW_SX['&:focus-visible'].outlineOffset, -2)

  // Reduced motion disables the background transition; the ripple is untouched.
  assert.equal(
    PANEL_ROW_SX['@media (prefers-reduced-motion: reduce)'].transition,
    'none',
  )
  assert.equal(PANEL_ROW_ACTION_SX.opacity, 0)
  assert.match(String(PANEL_ROW_ACTION_SX.transition), /opacity/)
  assert.equal(
    PANEL_ROW_ACTION_SX['@media (prefers-reduced-motion: reduce)'].transition,
    'none',
  )
  assert.equal(PANEL_ROW_ICON_SX.minWidth, 32)
  assert.equal(PANEL_ROW_ICON_SX['& svg'].fontSize, 20)
})

test('every list row is a ListItemButton with icon + two-line text', () => {
  const source = panelSource()
  assert.ok((source.match(/h\(\s*MuiListItemButton,/g) ?? []).length >= 4)
  assert.ok((source.match(/h\(\s*MuiListItemIcon,/g) ?? []).length >= 4)
  assert.ok((source.match(/h\(\s*MuiListItemText,/g) ?? []).length >= 4)
  assert.ok((source.match(/paddingLeft: 8 \+ depth \* 16/g) ?? []).length >= 2)
  assert.match(source, /role: 'treeitem'/)
  assert.match(source, /'aria-level': depth \+ 1/)
  assert.match(source, /'aria-expanded': hasChildren \? expanded : undefined/)
  assert.match(source, /role: 'option'/)
  assert.match(source, /'aria-selected': selected/)
  assert.match(source, /className: 'coordination-row-action'/)
})

test('the two panels keep separate tab and route sets', () => {
  assert.deepEqual([...RIGHT_PANEL_TABS], [
    'files',
    'outline',
    'dependencies',
    'imports',
    'exports',
  ])
  assert.deepEqual([...LEFT_PANEL_TABS], [
    'files',
    'agents',
    'dependencies',
    'imports',
    'exports',
  ])
  // `preview` / `agent` are routed detail pages, never tabs.
  assert.equal(RIGHT_PANEL_TABS.includes('preview'), false)
  assert.equal(LEFT_PANEL_TABS.includes('agent'), false)
  assert.equal(RIGHT_PANEL_ROUTES.includes('preview'), true)
  assert.equal(LEFT_PANEL_ROUTES.includes('agent'), true)

  // Each tab is its own hash route.
  for (const tab of RIGHT_PANEL_TABS) {
    assert.equal(
      initialPanelNavigation(
        `#coordination/panel/right/${tab}`,
        'right',
        RIGHT_PANEL_ROUTES,
        'files',
      ).view,
      tab,
    )
  }

  // The detail routes deep-link when validated against `routes`...
  assert.deepEqual(
    initialPanelNavigation(
      '#coordination/panel/right/preview?path=src%2Fa.ts',
      'right',
      RIGHT_PANEL_ROUTES,
      'files',
    ),
    { view: 'preview', path: 'src/a.ts', id: null },
  )
  assert.deepEqual(
    initialPanelNavigation(
      '#coordination/panel/left/agent?id=agent-1',
      'left',
      LEFT_PANEL_ROUTES,
      'files',
    ),
    { view: 'agent', path: null, id: 'agent-1' },
  )
  // ...and are rejected when a caller cheats by validating against tabs only.
  assert.equal(
    initialPanelNavigation(
      '#coordination/panel/right/preview?path=src%2Fa.ts',
      'right',
      RIGHT_PANEL_TABS,
      'files',
    ).view,
    'files',
  )
  assert.equal(
    initialPanelNavigation(
      '#coordination/panel/left/agent?id=agent-1',
      'left',
      LEFT_PANEL_TABS,
      'files',
    ).view,
    'files',
  )
})

test('imports and exports are WebGL canvas pages on both panels', () => {
  const source = panelSource()
  assert.doesNotMatch(source, /function ImportsView\(/)
  assert.doesNotMatch(source, /imports: ImportsView/)
  assert.equal((source.match(/imports: ImportsCanvasView/g) ?? []).length, 2)
  assert.equal((source.match(/exports: ExportsCanvasView/g) ?? []).length, 2)
  // The imports tab icon differs from exports.
  assert.match(source, /IconImports = CallReceivedIcon/)
  assert.match(source, /IconExports = CallMadeIcon/)
  assert.match(source, /tabImportsGraph/)
  assert.match(source, /tabExportsGraph/)
})

/* ------------------------------------------------------------------------- *
 * Agent transcript: sanitized Markdown, roles and read-only controls
 * ------------------------------------------------------------------------- */

test('sanitizeMessageHtml strips script/event handlers/javascript: URLs', () => {
  const dirty = [
    '<p>safe</p>',
    '<script>alert(1)</script>',
    '<img src="x" onerror="alert(1)">',
    '<a href="javascript:alert(1)">click</a>',
    '<iframe src="https://example.test"></iframe>',
    '<div style="color:red" contenteditable="true" onclick="alert(1)">text</div>',
  ].join('')
  const clean = sanitizeMessageHtml(dirty)
  assert.match(clean, /<p>safe<\/p>/)
  assert.match(clean, /<img src="x">/)
  assert.match(clean, /click/)
  for (const forbidden of [
    /<script/i,
    /onerror/i,
    /onclick/i,
    /javascript:/i,
    /<iframe/i,
    /style=/i,
    /contenteditable/i,
    /srcset=/i,
  ]) {
    assert.doesNotMatch(clean, forbidden)
  }
})

test('sanitizeMessageHtml runs the DOMPurify pass first, then the scrub', () => {
  let seenConfig: unknown
  const html = sanitizeMessageHtml('<p>raw</p>', {
    sanitize: (raw: string, config?: Record<string, unknown>) => {
      seenConfig = config
      return `${raw}<script>bad</script><b>ok</b>`
    },
  })
  assert.equal(seenConfig, MESSAGE_SANITIZE_CONFIG)
  assert.equal(html, '<p>raw</p><b>ok</b>')
})

test('MESSAGE_SANITIZE_CONFIG denies the documented tags and attributes', () => {
  for (const tag of [
    'script',
    'style',
    'iframe',
    'object',
    'embed',
    'form',
    'input',
    'textarea',
    'select',
    'button',
    'video',
    'audio',
  ]) {
    assert.ok(MESSAGE_SANITIZE_CONFIG.FORBID_TAGS.includes(tag), `missing FORBID_TAGS ${tag}`)
  }
  for (const attr of ['onerror', 'onclick', 'contenteditable', 'style', 'srcset']) {
    assert.ok(MESSAGE_SANITIZE_CONFIG.FORBID_ATTR.includes(attr), `missing FORBID_ATTR ${attr}`)
  }
  assert.ok(MESSAGE_SANITIZE_CONFIG.ADD_ATTR.includes('target'))
  assert.ok(MESSAGE_SANITIZE_CONFIG.ADD_ATTR.includes('rel'))
  const source = panelSource()
  assert.match(source, /purify\.sanitize\(html, MESSAGE_SANITIZE_CONFIG\)/)
  assert.match(source, /renderToStaticMarkup/)
  assert.match(source, /target: '_blank', rel: 'noreferrer'/)
})

test('message roles map to the documented bubble alignment', () => {
  assert.equal(messageRoleKind('USER'), 'user')
  assert.equal(messageRoleKind('assistant'), 'assistant')
  assert.equal(messageRoleKind('tool'), 'tool')
  assert.equal(messageRoleKind('system'), 'system')
  assert.equal(messageRoleKind('developer'), 'assistant')
  assert.equal(messageRoleKind(''), 'assistant')

  assert.equal(messageAlignment('user'), 'flex-end')
  assert.equal(messageAlignment('assistant'), 'flex-start')
  assert.equal(messageAlignment('tool'), 'center')
  assert.equal(messageAlignment('system'), 'center')
})

test('transcript rows expand inside the 48–240 px estimate', () => {
  assert.ok(estimateMessageHeight({ text: '' }, false) >= 48)
  assert.ok(estimateMessageHeight({ text: 'x'.repeat(10_000) }, true) <= 240)
  assert.ok(
    estimateMessageHeight({ text: 'x'.repeat(600) }, true) >
      estimateMessageHeight({ text: 'x'.repeat(600) }, false),
  )
  assert.equal(messageCanExpand({ text: 'short' }), false)
  assert.equal(messageCanExpand({ text: 'x'.repeat(500) }), true)
})

test('agent detail is virtualized, truncation-aware and has no composer', () => {
  const source = panelSource()
  const viewStart = source.indexOf('function AgentMessagesView')
  assert.ok(viewStart !== -1, 'AgentMessagesView must exist')
  const view = source.slice(viewStart, source.indexOf('const RIGHT_VIEW_REGISTRY', viewStart))
  assert.match(view, /h\(VirtualList<AgentMessageData>, \{/)
  assert.match(view, /rowHeight,/)
  assert.match(view, /data\.truncated/)
  assert.match(view, /props\.copy\.agentTruncated/)
  assert.doesNotMatch(view, /MuiTextField/)
  assert.doesNotMatch(view, /<input|<textarea|<form/)
  assert.doesNotMatch(view, /SendIcon|sendMessage|onSend|MuiButton[^]*发送/)

  // The raw message text is never handed to dangerouslySetInnerHTML directly.
  const bubbleStart = source.indexOf('function MessageBubble')
  assert.ok(bubbleStart !== -1)
  const bubble = source.slice(bubbleStart, source.indexOf('const EMPTY_AGENT_MESSAGES', bubbleStart))
  assert.match(bubble, /dangerouslySetInnerHTML: \{ __html: html \}/)
  assert.doesNotMatch(bubble, /__html: props\.message\.text/)
  assert.match(bubble, /messageRoleKind/)
  assert.match(bubble, /messageAlignment/)
  assert.match(bubble, /formatAgentTime/)
  assert.match(bubble, /copy\.messageExpand/)
  assert.match(bubble, /copy\.messageCollapse/)
})

test('agent detail is a routed page and Escape returns to the roster', () => {
  const source = panelSource()
  assert.match(source, /agent: AgentMessagesView/)
  assert.match(source, /if \(view === 'agent'\) \{\s*go\('agents'\)/)
  assert.match(source, /navigate\(props\.side, 'agents'\)/)
})

/* ------------------------------------------------------------------------- *
 * Outline: one route, two modes
 * ------------------------------------------------------------------------- */

test('the local outline keeps only document-structure node kinds', () => {
  for (const kind of [
    'module',
    'class',
    'function',
    'method',
    'interface',
    'type',
    'enumeration',
    'namespace',
    'chapter',
    'heading',
  ]) {
    assert.equal(isOutlineStructureKind(kind), true, `${kind} must be kept`)
  }
  for (const kind of [
    'variable',
    'property',
    'static',
    'import',
    'export',
    'line',
    'sentence',
    'Variable',
    '  PROPERTY  ',
  ]) {
    assert.equal(isOutlineStructureKind(kind), false, `${kind} must be filtered`)
  }
})

test('manifest projects are grouped one level deep (outermost manifest wins)', () => {
  // Nested manifests never create nested projects.
  const projects = [
    { root: 'packages/app', name: 'app', manifest: 'package.json', files: [] },
    { root: 'packages', name: 'packages', manifest: 'pom.xml', files: [] },
    { root: 'tools/cli', name: 'cli', manifest: 'package.json', files: [] },
  ]
  assert.deepEqual(
    outermostOutlineProjects(projects).map((project) => project.root),
    ['packages', 'tools/cli'],
  )

  const groups = [
    { path: 'packages/app/src/a.ts', family: 'project', nodes: [] },
    { path: 'packages/lib/b.ts', family: 'project', nodes: [] },
    { path: 'tools/cli/main.ts', family: 'project', nodes: [] },
    { path: 'docs/readme.md', family: 'document', nodes: [] },
  ]
  const bucketed = groupOutlineByProject(groups, projects)
  assert.deepEqual(
    bucketed.projects.map((bucket) => ({
      root: bucket.project.root,
      files: bucket.groups.map((group) => group.path),
    })),
    [
      { root: 'packages', files: ['packages/app/src/a.ts', 'packages/lib/b.ts'] },
      { root: 'tools/cli', files: ['tools/cli/main.ts'] },
    ],
  )
  // No manifest claims these: they hang off the workspace root.
  assert.deepEqual(bucketed.loose.map((group) => group.path), ['docs/readme.md'])
  assert.equal(outlineProjectOf('packages/app/src/a.ts', projects)?.root, 'packages')
  assert.equal(outlineProjectOf('docs/readme.md', projects), undefined)

  // With no projects the UI shows one workspace root and never invents one.
  const noProjects = groupOutlineByProject(groups, [])
  assert.deepEqual(noProjects.projects, [])
  assert.deepEqual(noProjects.loose.map((group) => group.path), groups.map((group) => group.path))
})

test('an absolute project root is displayed relative to the workspace root', () => {
  assert.equal(workspaceRelativeRoot('R:\\ws', 'R:\\ws'), '')
  assert.equal(workspaceRelativeRoot('R:\\ws\\packages\\app', 'R:\\ws'), 'packages/app')
  assert.equal(workspaceRelativeRoot('/ws/packages/app', '/ws/'), 'packages/app')
  assert.equal(workspaceRelativeRoot('packages/app', 'R:\\ws'), 'packages/app')
  // A workspace-root manifest claims every file; nested manifests fold in.
  const rootProject = [{ root: '', name: 'workspace', manifest: 'package.json', files: [] }]
  assert.deepEqual(outermostOutlineProjects(rootProject).map((project) => project.root), [''])
  assert.equal(outlineProjectOf('src/a.ts', rootProject)?.root, '')
})

test('outline mode is selected by the path parameter, with a back affordance', () => {
  const source = panelSource()
  assert.match(source, /withPath\('\/graph\/outline', props\.path\)/)
  // Global mode: group rows navigate to the local route (`path` present).
  assert.match(source, /navigate\(props\.side, 'outline', \{ path: value\.group\.path \}\)/)
  // Local mode: the DockedPanel scope bar owns the back button.
  assert.match(source, /view === 'outline' && viewPath !== null/)
  assert.match(source, /copy\.outlineBack/)
  assert.match(source, /onClick: leaveOutlineLocal/)
  assert.match(source, /const leaveOutlineLocal = \(\): void => \{[\s\S]*?go\('outline'\)/)
  // Escape follows the same path back and drops `path` from the hash mirror.
  assert.match(source, /view === 'outline' && path !== null\) \{\s*leaveOutlineLocal\(\)/)
  assert.match(source, /mirrorHash\(props\.side, next, params\)/)
  // Both modes render the one controlled VirtualTree.
  const start = source.indexOf('function OutlineView')
  const outline = source.slice(start, source.indexOf('function DependenciesView', start))
  assert.equal((outline.match(/h\(VirtualTree/g) ?? []).length, 1)
  assert.match(outline, /if \(local\) \{/)
  assert.match(outline, /if \(scope !== 'workspace' \|\| collapsedWorkspace\.current \|\| groupKeys\.length === 0\) return/)
  assert.match(outline, /copy\.outlineNodeCount/)
  assert.match(outline, /copy\.outlineKind/)
  assert.match(outline, /sx: \{ fontWeight: 500 \}/)
  assert.match(outline, /paddingLeft: 8 \+ depth \* 16/)

  // Local mode renders only the requested file's `nodes`; it never turns the
  // workspace `groups` payload into the local list.
  assert.match(outline, /data !== null && data\.scope === 'file' \? structureNodes\(data\.nodes\)/)
  assert.match(outline, /if \(local && state\.value\.scope !== 'file'\)/)
  assert.match(outline, /return h\(EmptyState, \{ message: props\.copy\.outline\.empty \}\)/)

  // Global mode roots at the resolved workspace root (never a path prefix) and
  // groups only by the outermost manifest projects.
  assert.match(outline, /useGraph\(local \? null : '\/graph\/tree', parseTree/)
  assert.match(outline, /workspaceRoot = \(data\?\.root \?\? ''\)\.length > 0/)
  assert.match(outline, /const bucketed = groupOutlineByProject\(groups, effectiveProjects\)/)
  assert.match(outline, /key: `workspace-root:/)
  assert.match(outline, /kind: 'project'/)
  // The family chip exists only in the group branch, not on root/project rows.
  const rootBranch = outline.slice(
    outline.indexOf("if (value.kind === 'root' || value.kind === 'project')"),
    outline.indexOf("if (value.kind === 'group')"),
  )
  assert.doesNotMatch(rootBranch, /MuiChip/)
  assert.match(outline, /label: family/)
})

test('the outline component stays mounted across the global/local route flip', () => {
  const source = panelSource()
  // The Fade key is stable for `outline` so the view's collapse state survives
  // the path change; other views still remount per selection.
  assert.match(source, /key: view === 'outline' \? 'view:outline'/)
  assert.match(source, /outlineScrollRef/)
  assert.match(source, /pendingScrollRef\.current = outlineScrollRef\.current/)
})

/* ------------------------------------------------------------------------- *
 * Column height budget
 * ------------------------------------------------------------------------- */

test('the column is bounded above and below and never scrolls its own box', () => {
  assert.equal(COLUMN_SX.top, 72)
  assert.equal(COLUMN_SX.bottom, 120)
  assert.equal(COLUMN_SX.overflow, 'hidden')
  assert.equal(COLUMN_SX.display, 'flex')
  assert.equal(COLUMN_SX.flexDirection, 'column')
  assert.match(String(COLUMN_SX.maxHeight), /calc\(100dvh - 192px\)/)
  const fallback = COLUMN_SX['@supports not (height: 100dvh)']
  assert.match(String(fallback.maxHeight), /calc\(100vh - 192px\)/)
  // Panel items shrink inside the column; fixed 320 px minimums are gone.
  assert.equal(PANEL_ITEM_SX.minHeight, 0)
  assert.equal(PANEL_ITEM_SX.maxHeight, '100%')
  assert.equal(PANEL_ITEM_SX.overflow, 'hidden')
  assert.doesNotMatch(panelSource(), /minHeight: 320/)
})

test('splitPanelHeights keeps both panels inside the container', () => {
  for (const height of [96, 150, 199, 200, 240, 400, 808, 1200]) {
    for (const left of [true, false]) {
      for (const right of [true, false]) {
        const split = splitPanelHeights(height, left, right)
        assert.ok(split.left >= 48, `left floor at ${height}`)
        assert.ok(split.right >= 48, `right floor at ${height}`)
        assert.ok(
          split.left + split.right <= height,
          `sum ${split.left + split.right} must fit ${height}`,
        )
      }
    }
  }

  // Too short for two title bars: both are forced collapsed.
  assert.deepEqual(splitPanelHeights(150, false, false), { left: 48, right: 48 })
  assert.deepEqual(splitPanelHeights(0, false, false), { left: 48, right: 48 })
  // Both expanded: equal halves of (container - gap).
  const both = splitPanelHeights(808, false, false)
  assert.equal(both.left + both.right, 800)
  assert.equal(both.left, both.right)
  // One collapsed: the other takes the rest.
  assert.deepEqual(splitPanelHeights(400, true, false), { left: 48, right: 344 })
  assert.deepEqual(splitPanelHeights(400, false, true), { left: 344, right: 48 })
})

/* ------------------------------------------------------------------------- *
 * Header search animation
 * ------------------------------------------------------------------------- */

test('header search expands horizontally from the right', () => {
  const source = panelSource()
  assert.match(source, /const SEARCH_SLOT_WIDTH = 240/)
  assert.match(source, /orientation: 'horizontal'/)
  assert.match(source, /collapsedSize: 0/)
  assert.match(source, /unmountOnExit: true/)
  assert.match(source, /timeout: props\.reducedMotion \? 0 : SEARCH_ANIMATION_MS/)
  assert.match(source, /easing: PANEL_EASING/)
  assert.match(source, /'& \.MuiCollapse-wrapper, & \.MuiCollapse-wrapperInner': \{ minWidth: 0 \}/)
  // The field never squeezes the title-bar buttons out; the title ellipsizes.
  assert.match(source, /minWidth: 0,\s*flex: '0 0 auto'/)
  assert.match(source, /h\(MuiTypography, \{ variant: 'subtitle2', noWrap: true \}, props\.title\)/)
})

test('search open state drives aria, focus and clearing', () => {
  const source = panelSource()
  assert.match(source, /'aria-expanded': searchOpen/)
  assert.match(source, /'aria-controls': SEARCH_INPUT_ID/)
  assert.match(source, /id: SEARCH_INPUT_ID/)
  assert.match(source, /copy\.tip\.closeSearch/)
  // Focus only after the horizontal Collapse reports entered.
  assert.match(source, /onEntered: \(\): void => \{[\s\S]*?searchRef\.current\?\.focus\(\)/)
  // Closing (button, title area or Esc) clears query + results.
  assert.match(source, /if \(searchOpen\) \{\s*setSearchOpen\(false\)\s*clearSearch\(\)/)
  assert.match(source, /setSearchOpen\(false\)\s*clearSearch\(\)/)
})

test('the file tree roots at the workspace and groups outermost projects', () => {
  const source = panelSource()
  const start = source.indexOf('function FilesView')
  const files = source.slice(start, source.indexOf('function familyLabel', start))
  // Workspace root row, never a common path prefix such as `src`.
  assert.match(files, /key: `workspace-root:\$\{root\}`/)
  assert.match(files, /state\.value\.projects/)
  assert.match(files, /workspaceRelativeRoot\(project\.root, root\)/)
  assert.match(files, /key: `project-root:\$\{index\}:\$\{project\.root\}`/)
  assert.match(files, /manifest: project\.manifest/)
  // Root/project heading rows fold; they never navigate.
  const heading = files.slice(
    files.indexOf("if (node.key.startsWith('workspace-root:') || projectRoot)"),
    files.indexOf('const selected = props.path === entry.path'),
  )
  assert.doesNotMatch(heading, /navigate\(/)
})

/* ------------------------------------------------------------------------- *
 * Priority task queue
 * ------------------------------------------------------------------------- */

interface FakeScheduler {
  readonly frames: Map<number, FrameRequestCallback>
  readonly idles: Map<number, (deadline: { didTimeout: boolean; timeRemaining(): number }) => void>
  runFrame(): void
  runIdle(remaining?: number, didTimeout?: boolean): void
  restore(): void
}

function installFakeScheduler(): FakeScheduler {
  const saved = {
    requestAnimationFrame: globals.requestAnimationFrame,
    cancelAnimationFrame: globals.cancelAnimationFrame,
    requestIdleCallback: globals.requestIdleCallback,
    cancelIdleCallback: globals.cancelIdleCallback,
  }
  const frames = new Map<number, FrameRequestCallback>()
  const idles = new Map<number, (deadline: { didTimeout: boolean; timeRemaining(): number }) => void>()
  let nextId = 1
  globals.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = nextId
    nextId += 1
    frames.set(id, callback)
    return id
  }
  globals.cancelAnimationFrame = (id: number): void => {
    frames.delete(id)
  }
  globals.requestIdleCallback = (
    callback: (deadline: { didTimeout: boolean; timeRemaining(): number }) => void,
  ): number => {
    const id = nextId
    nextId += 1
    idles.set(id, callback)
    return id
  }
  globals.cancelIdleCallback = (id: number): void => {
    idles.delete(id)
  }
  return {
    frames,
    idles,
    runFrame(): void {
      const entry = [...frames.entries()][0]
      assert.ok(entry !== undefined, 'a frame callback must be scheduled')
      frames.delete(entry[0])
      entry[1](performance.now())
    },
    runIdle(remaining = 50, didTimeout = false): void {
      const entry = [...idles.entries()][0]
      assert.ok(entry !== undefined, 'an idle callback must be scheduled')
      idles.delete(entry[0])
      entry[1]({ didTimeout, timeRemaining: () => remaining })
    },
    restore(): void {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globals[key]
        else globals[key] = value
      }
      frames.clear()
      idles.clear()
    },
  }
}

test('Task drains high, then medium, then low', () => {
  const queue: Task = getTaskQueue()
  queue.reset()
  const scheduler = installFakeScheduler()
  const order: string[] = []
  try {
    queue.schedule('low', 'low', () => order.push('low'))
    queue.schedule('high', 'high', () => order.push('high'))
    queue.schedule('medium', 'medium', () => order.push('medium'))
    assert.equal(queue.pending, 3)
    // The first pump was scheduled for `low` (idle) and upgraded to a frame
    // when `high` arrived.
    assert.equal(scheduler.frames.size, 1)
    assert.equal(scheduler.idles.size, 0)

    scheduler.runFrame()
    assert.deepEqual(order, ['high'])
    assert.equal(scheduler.idles.size, 1)

    scheduler.runIdle(50)
    assert.deepEqual(order, ['high', 'medium'])
    scheduler.runIdle(50)
    assert.deepEqual(order, ['high', 'medium', 'low'])
    assert.equal(queue.pending, 0)
    assert.equal(scheduler.frames.size, 0)
    assert.equal(scheduler.idles.size, 0)
  } finally {
    queue.reset()
    scheduler.restore()
  }
})

test('Task runs one high task per animation frame', () => {
  const queue = getTaskQueue()
  queue.reset()
  const scheduler = installFakeScheduler()
  const calls: string[] = []
  try {
    queue.schedule('high', 'first', () => calls.push('first'))
    queue.schedule('high', 'second', () => calls.push('second'))
    assert.equal(queue.pending, 2)
    scheduler.runFrame()
    assert.deepEqual(calls, ['first'])
    assert.equal(queue.pending, 1)
    assert.equal(scheduler.frames.size, 1)
    scheduler.runFrame()
    assert.deepEqual(calls, ['first', 'second'])
    assert.equal(scheduler.frames.size, 0)
  } finally {
    queue.reset()
    scheduler.restore()
  }
})

test('Task runs one idle task per callback and yields under 4 ms', () => {
  const queue = getTaskQueue()
  queue.reset()
  const scheduler = installFakeScheduler()
  const calls: string[] = []
  try {
    queue.schedule('medium', 'm1', () => calls.push('m1'))
    queue.schedule('medium', 'm2', () => calls.push('m2'))
    assert.equal(scheduler.idles.size, 1)
    scheduler.runIdle(2)
    assert.deepEqual(calls, [], 'a nearly exhausted deadline must yield')
    assert.equal(scheduler.idles.size, 1)
    scheduler.runIdle(40)
    assert.deepEqual(calls, ['m1'])
    assert.equal(queue.pending, 1)
    scheduler.runIdle(40)
    assert.deepEqual(calls, ['m1', 'm2'])
    assert.equal(scheduler.idles.size, 0)
  } finally {
    queue.reset()
    scheduler.restore()
  }
})

test('Task merges the same key and keeps only the highest priority', () => {
  const queue = getTaskQueue()
  queue.reset()
  const scheduler = installFakeScheduler()
  const calls: string[] = []
  try {
    queue.schedule('low', 'paint', () => calls.push('low'))
    queue.schedule('low', 'paint', () => calls.push('low-again'))
    assert.equal(queue.pending, 1, 'same priority is ignored, not duplicated')
    queue.schedule('high', 'paint', () => calls.push('high'))
    assert.equal(queue.pending, 1, 'an upgrade moves the single entry')
    scheduler.runFrame()
    assert.deepEqual(calls, ['high'])
    assert.equal(queue.pending, 0)
  } finally {
    queue.reset()
    scheduler.restore()
  }
})

test('Task isolates a throwing task and keeps draining', () => {
  const queue = getTaskQueue()
  queue.reset()
  const scheduler = installFakeScheduler()
  const calls: string[] = []
  const logged: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]): void => {
    logged.push(args)
  }
  try {
    queue.schedule('high', 'boom', () => {
      throw new Error('boom')
    })
    queue.schedule('high', 'after', () => calls.push('after'))
    scheduler.runFrame()
    assert.deepEqual(calls, [])
    scheduler.runFrame()
    assert.deepEqual(calls, ['after'])
    const reports = logged.filter((args) => args[0] === '[coordination] task failed')
    assert.equal(reports.length, 1)
  } finally {
    console.error = originalError
    queue.reset()
    scheduler.restore()
  }
})

test('Task dispose no-ops safely and reset re-arms it', () => {
  const queue = getTaskQueue()
  queue.reset()
  const scheduler = installFakeScheduler()
  const calls: string[] = []
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]): void => {
    warnings.push(args)
  }
  try {
    queue.schedule('high', 'pending', () => calls.push('pending'))
    assert.equal(scheduler.frames.size, 1)
    queue.dispose()
    assert.equal(queue.pending, 0)
    assert.equal(scheduler.frames.size, 0, 'dispose cancels the pending callback')
    assert.doesNotThrow(() => {
      queue.schedule('high', 'after-dispose', () => calls.push('after-dispose'))
    })
    assert.equal(queue.pending, 0)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0]?.[0], '[coordination] task queue disposed')

    queue.reset()
    queue.schedule('high', 'again', () => calls.push('again'))
    scheduler.runFrame()
    assert.deepEqual(calls, ['again'])
  } finally {
    console.warn = originalWarn
    queue.reset()
    scheduler.restore()
  }
})

test('Task falls back to setTimeout without requestAnimationFrame/idleCallback', () => {
  const queue = getTaskQueue()
  queue.reset()
  const saved = {
    setTimeout: globals.setTimeout,
    clearTimeout: globals.clearTimeout,
    requestAnimationFrame: globals.requestAnimationFrame,
    cancelAnimationFrame: globals.cancelAnimationFrame,
    requestIdleCallback: globals.requestIdleCallback,
    cancelIdleCallback: globals.cancelIdleCallback,
  }
  const timers = new Map<number, () => void>()
  let nextId = 1
  globals.setTimeout = ((callback: () => void): number => {
    const id = nextId
    nextId += 1
    timers.set(id, callback)
    return id
  }) as unknown as typeof setTimeout
  globals.clearTimeout = ((id: number): void => {
    timers.delete(id)
  }) as unknown as typeof clearTimeout
  delete globals.requestAnimationFrame
  delete globals.cancelAnimationFrame
  delete globals.requestIdleCallback
  delete globals.cancelIdleCallback
  const order: string[] = []
  const runTimer = (): void => {
    const entry = [...timers.entries()][0]
    assert.ok(entry !== undefined, 'a timeout must be scheduled')
    timers.delete(entry[0])
    entry[1]()
  }
  try {
    queue.schedule('high', 'high', () => order.push('high'))
    assert.equal(timers.size, 1)
    runTimer()
    assert.deepEqual(order, ['high'])
    queue.schedule('medium', 'medium', () => order.push('medium'))
    assert.equal(timers.size, 1, 'idle falls back to setTimeout(16)')
    runTimer()
    assert.deepEqual(order, ['high', 'medium'])
    queue.schedule('low', 'low', () => order.push('low'))
    runTimer()
    assert.deepEqual(order, ['high', 'medium', 'low'])
    assert.equal(queue.pending, 0)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globals[key]
      else globals[key] = value
    }
    timers.clear()
    queue.reset()
  }
})

test('the task queue is a module-level singleton', () => {
  assert.strictEqual(getTaskQueue(), getTaskQueue())
  assert.strictEqual(taskQueue, getTaskQueue())
  // Exactly one construction site in the whole panel module.
  assert.equal((panelSource().match(/new Task\(/g) ?? []).length, 1)
})
