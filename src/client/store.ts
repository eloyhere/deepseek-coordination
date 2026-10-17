/**
 * Composer-side switches (takeover / workflow), shared by the composer controls
 * and the settings page.
 *
 * Both values survive a reload in `localStorage`; a blocked storage still keeps
 * the in-memory choice working. The takeover rule is managed here because the
 * settings page and the plugin entry both need to apply and remove it.
 */
const TAKEOVER_KEY = 'deepseek-coordination:takeover'
const WORKFLOW_KEY = 'deepseek-coordination:workflow'
const TAKEOVER_STYLE_ID = 'dsh-coordination-takeover'

/**
 * The host's resident access-mode control, addressed by its accessible name so
 * the rule survives hashed CSS-module class names. Both locales are matched.
 */
const ACCESS_MODE_SELECTOR = 'button[aria-label^="访问模式"], button[aria-label^="Access mode"]'

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(key)
    return stored === null ? fallback : stored === '1'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // A blocked storage must not break the switch; the choice stays in memory.
  }
}

function createFlagStore(key: string, fallback: boolean): {
  subscribe: (listener: () => void) => () => void
  snapshot: () => boolean
  set: (value: boolean) => void
  listeners: Set<() => void>
  state: () => boolean
} {
  let value = readFlag(key, fallback)
  const listeners = new Set<() => void>()
  return {
    listeners,
    state: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    snapshot: () => value,
    set: (next) => {
      if (value === next) return
      value = next
      writeFlag(key, next)
      for (const listener of listeners) listener()
    },
  }
}

export const takeoverStore = createFlagStore(TAKEOVER_KEY, false)
export const workflowStore = createFlagStore(WORKFLOW_KEY, true)

let takeoverStyle: HTMLStyleElement | null = null

/** Create the injected rule once and apply the stored takeover state. */
export function installTakeoverStyle(): HTMLStyleElement {
  if (takeoverStyle !== null && takeoverStyle.isConnected) return takeoverStyle
  const style = document.createElement('style')
  style.id = TAKEOVER_STYLE_ID
  document.head.append(style)
  takeoverStyle = style
  applyTakeoverStyle(takeoverStore.snapshot(), style)
  return style
}

export function disposeTakeoverStyle(): void {
  takeoverStyle?.remove()
  takeoverStyle = null
}

/** Rewrite the injected rule; the host control is hidden only while takeover is on. */
export function applyTakeoverStyle(on: boolean, style: HTMLStyleElement | null = takeoverStyle): void {
  if (style === null) return
  style.textContent = on ? `${ACCESS_MODE_SELECTOR} { display: none !important; }` : ''
}

/** Set takeover and rewrite the rule in one step. */
export function setTakeover(next: boolean): void {
  takeoverStore.set(next)
  applyTakeoverStyle(next)
}

export function setWorkflow(next: boolean): void {
  workflowStore.set(next)
}
