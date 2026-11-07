/**
 * Harness has no general Modal bus. Its shared Modal presentation exposes the
 * standard aria-modal dialog contract. Mirror that presentation into our native
 * modal while keeping the original React tree mounted for its action callbacks.
 * Approval and user questions are intercepted at the host waterfall instead.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import { createPortal } from 'react-dom'
import { BlockingDialog } from './modal.js'
import { ampPreferencesSnapshot, subscribeAmpPreferences } from './preferences.js'
import { useCopy } from './i18n.js'

const h = React.createElement
const MuiButton = Button as unknown as React.ComponentType<Record<string, unknown>>
const MuiTypography = Typography as unknown as React.ComponentType<Record<string, unknown>>
const MuiTextField = TextField as unknown as React.ComponentType<Record<string, unknown>>

function NativeTextInput({ original }: { original: HTMLInputElement | HTMLTextAreaElement }): React.ReactElement {
  const [value, setValue] = React.useState(original.value)
  const hostValue = original.value
  React.useLayoutEffect(() => { setValue(hostValue) }, [hostValue])
  const label = original.getAttribute('aria-label') ?? original.labels?.[0]?.textContent ?? original.placeholder
  return h(MuiTextField, {
    label, value, fullWidth: true, multiline: original instanceof HTMLTextAreaElement,
    minRows: original instanceof HTMLTextAreaElement ? Math.max(3, original.rows) : undefined,
    type: original instanceof HTMLInputElement ? original.type : undefined,
    disabled: original.disabled, required: original.required,
    slotProps: { htmlInput: { maxLength: original.maxLength > 0 ? original.maxLength : undefined } },
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value
      setValue(next)
      const prototype = original instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(original, next)
      original.dispatchEvent(new Event('input', { bubbles: true }))
      original.dispatchEvent(new Event('change', { bubbles: true }))
    },
  })
}
const SELECTOR = '[role="dialog"][aria-modal="true"]'

interface Captured {
  source: HTMLElement
  overlay: HTMLElement
  hidden: boolean
  root: ReturnType<typeof createRoot>
  mount: HTMLElement
  observer: MutationObserver
  dispose: () => void
}

/** Clone body markup, forwarding user input to the live host-owned control. */
function MirroredContent({ source, revision }: { source: HTMLElement; revision: number }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null)
  const previous = React.useRef<{ originals: HTMLElement[]; copies: HTMLElement[] } | null>(null)
  const [fields, setFields] = React.useState<{ mount: HTMLElement; original: HTMLInputElement | HTMLTextAreaElement }[]>([])
  React.useLayoutEffect(() => {
    const container = ref.current
    if (!container) return
    const live = [source, ...source.querySelectorAll<HTMLElement>('*')]
    const before = previous.current
    if (before && live.length === before.originals.length && live.every((element, index) => element === before.originals[index])) {
      // React controlled inputs update value/disabled attributes on every key.
      // Keep the mounted MUI field (and its caret) when the host DOM identity
      // has not changed; only synchronize passive attributes and label text.
      for (let index = 0; index < live.length; index++) {
        const original = live[index]!
        const copy = before.copies[index]!
        if (original instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
          copy.checked = original.checked
          copy.disabled = original.disabled
        } else if (original instanceof HTMLButtonElement && copy instanceof HTMLButtonElement) copy.disabled = original.disabled
        else if (!original.children.length && original.textContent !== copy.textContent) copy.textContent = original.textContent
      }
      return
    }
    const clone = source.cloneNode(true) as HTMLElement
    clone.removeAttribute('role')
    clone.removeAttribute('aria-modal')
    clone.removeAttribute('aria-label')
    clone.style.position = 'static'
    clone.style.width = '100%'
    clone.style.maxWidth = '100%'
    clone.style.maxHeight = 'none'
    clone.style.boxShadow = 'none'
    clone.style.background = 'transparent'
    if (source.children.length > 1) (clone.lastElementChild as HTMLElement | null)?.style.setProperty('display', 'none')
    clone.querySelector('h1,h2,h3,[role="heading"]')?.setAttribute('hidden', '')
    const originals = [source, ...source.querySelectorAll<HTMLElement>('*')]
    const copies = [clone, ...clone.querySelectorAll<HTMLElement>('*')]
    const mapping = new WeakMap<Element, HTMLElement>()
    for (let index = 0; index < copies.length; index++) {
      const copy = copies[index]!
      const original = originals[index]!
      mapping.set(copy, original)
      // Avoid duplicate ids while the hidden host React tree is retained.
      if (copy.id) copy.id = `amp-mirror-${copy.id}`
      for (const attribute of ['for', 'aria-labelledby', 'aria-describedby', 'aria-controls']) {
        const value = copy.getAttribute(attribute)
        if (value) copy.setAttribute(attribute, value.split(' ').map((id) => `amp-mirror-${id}`).join(' '))
      }
      if (copy instanceof HTMLInputElement && original instanceof HTMLInputElement) {
        copy.value = original.value
        copy.checked = original.checked
      } else if ((copy instanceof HTMLTextAreaElement && original instanceof HTMLTextAreaElement)
        || (copy instanceof HTMLSelectElement && original instanceof HTMLSelectElement)) copy.value = original.value
      // The original close icon is an ambient dismissal affordance. Explicit
      // Cancel/Close footer buttons remain available below.
      if (copy instanceof HTMLButtonElement && !copy.textContent?.trim()) copy.hidden = true
    }
    const forwardClick = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      const copy = target?.closest<HTMLElement>('button,a,input[type="checkbox"],input[type="radio"],label,[role="button"]')
      if (!copy || !clone.contains(copy)) return
      const original = mapping.get(copy)
      if (!original) return
      // Checkbox/radio activation happens before click listeners. Cancelling
      // that click would roll back checked after the forwarded host update.
      const checkable = copy instanceof HTMLInputElement && (copy.type === 'checkbox' || copy.type === 'radio')
      if (!checkable) event.preventDefault()
      event.stopPropagation()
      original.click()
      const syncChecks = (): void => {
        for (let index = 0; index < copies.length; index++) {
          const control = copies[index]
          const origin = originals[index]
          if (control instanceof HTMLInputElement && origin instanceof HTMLInputElement) control.checked = origin.checked
        }
      }
      if (checkable) syncChecks()
      else window.setTimeout(syncChecks)
    }
    const forwardInput = (event: Event): void => {
      const copy = event.target
      if (!(copy instanceof HTMLInputElement || copy instanceof HTMLTextAreaElement || copy instanceof HTMLSelectElement)) return
      if (copy instanceof HTMLInputElement && (copy.type === 'checkbox' || copy.type === 'radio')) return
      const original = mapping.get(copy)
      if (!(original instanceof HTMLInputElement || original instanceof HTMLTextAreaElement || original instanceof HTMLSelectElement)) return
      const prototype = original instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : original instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(original, copy.value)
      original.dispatchEvent(new Event(event.type, { bubbles: true }))
    }
    clone.addEventListener('click', forwardClick)
    clone.addEventListener('input', forwardInput)
    clone.addEventListener('change', forwardInput)
    const inputs: { mount: HTMLElement; original: HTMLInputElement | HTMLTextAreaElement }[] = []
    for (const copy of clone.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"]):not([type="range"]):not([type="color"]),textarea')) {
      const original = mapping.get(copy)
      if (!(original instanceof HTMLInputElement || original instanceof HTMLTextAreaElement)) continue
      const mount = document.createElement('div')
      mount.dataset.ampInput = ''
      copy.replaceWith(mount)
      inputs.push({ mount, original })
    }
    container.replaceChildren(clone)
    previous.current = { originals, copies }
    setFields(inputs)
  }, [source, revision])
  return h(React.Fragment, null,
    h('div', { ref, 'data-amp-mirrored-content': true }),
    ...fields.map(({ mount, original }, index) => createPortal(h(NativeTextInput, { original }), mount, String(index))),
  )
}

function CapturedDialog({ source, revision }: { source: HTMLElement; revision: number }): React.ReactElement {
  const copy = useCopy()
  const titleId = React.useId()
  const heading = source.querySelector('h1,h2,h3,[role="heading"]')
  const title = source.getAttribute('aria-label') ?? heading?.textContent ?? ''
  // Footer actions are rendered with MUI and forward to the existing callback.
  const footer = source.children.length > 1 ? source.lastElementChild : null
  const buttons = [...(footer?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter((button) => button.textContent?.trim())
  return h(BlockingDialog, { titleId },
    h(MuiTypography, { id: titleId, component: 'h2', variant: 'h6', sx: { mb: 2 } }, title),
    h(MirroredContent, { source, revision }),
    h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16, flexWrap: 'wrap' } },
      ...buttons.map((button, index) => h(MuiButton, {
        key: index, disabled: button.disabled, variant: index === buttons.length - 1 ? 'contained' : 'outlined',
        onClick: () => button.click(),
      }, button.textContent)),
      buttons.length === 0 ? h(MuiButton, { variant: 'contained', onClick: () => source.querySelector<HTMLButtonElement>('button')?.click() }, copy.dismiss) : null),

  )
}

export function installNativeDialogTakeover(): () => void {
  const active = new Map<HTMLElement, Captured>()
  let stopped = false
  const scan = (): void => {
    if (stopped) return
    if (!ampPreferencesSnapshot().takeoverNotifications) {
      for (const item of active.values()) item.dispose()
      return
    }
    for (const item of active.values()) if (!item.source.isConnected) item.dispose()
    for (const source of document.querySelectorAll<HTMLElement>(SELECTOR)) {
      if (source.closest('[data-amp-dialog]') || source.closest('[data-amp-native-copy]') || active.has(source)) continue
      // Harness's shared Modal portals a presentation root with a backdrop and
      // the aria-modal dialog. Only claim that contract; settings/search panels
      // that happen to use role=dialog must keep their own behavior.
      const overlay = source.parentElement
      if (!overlay || overlay.getAttribute('role') !== 'presentation'
        || ![...overlay.children].some((element) => element !== source && element.getAttribute('aria-hidden') === 'true')) continue
      const mount = document.createElement('div')
      mount.dataset.ampNativeCopy = ''
      document.body.append(mount)
      const root = createRoot(mount)
      const hidden = overlay.hidden
      const style = overlay.style.display
      overlay.hidden = true
      overlay.style.setProperty('display', 'none', 'important')
      let revision = 0
      const render = (): void => root.render(h(CapturedDialog, { source, revision: revision++ }))
      const observer = new MutationObserver(render)
      observer.observe(source, { childList: true, subtree: true, attributes: true, characterData: true })
      const item: Captured = {
        source, overlay, hidden, mount, root, observer,
        dispose: () => {
          observer.disconnect()
          active.delete(source)
          root.unmount()
          mount.remove()
          overlay.hidden = hidden
          overlay.style.display = style
        },
      }
      active.set(source, item)
      render()
    }
  }
  const observer = new MutationObserver(scan)
  observer.observe(document.body, { childList: true, subtree: true })
  const unsubscribe = subscribeAmpPreferences(scan)
  scan()
  return () => {
    stopped = true
    observer.disconnect()
    unsubscribe()
    for (const item of active.values()) item.dispose()
  }
}
