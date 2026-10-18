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
  CoordinationPanels,
  PanelErrorBoundary,
  getPanelError,
  isPanelDisabled,
  panelErrorTooltip,
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
