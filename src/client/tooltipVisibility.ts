/**
 * One "which tooltip may be visible" flag for the composer dropdowns.
 *
 * Each dropdown still owns its own MUI Tooltip and anchor (so it renders where
 * it belongs and never jitters), but only the dropdown whose id is active may
 * have `open=true`. Hovering another control takes ownership immediately, so
 * two tooltips can never stay on screen together.
 */
let active: string | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export const tooltipVisibility = {
  /** Take ownership; the previously active tooltip closes. */
  request(id: string): void {
    if (active === id) return
    active = id
    emit()
  },

  /** Release ownership only when `id` still owns it. */
  release(id: string): void {
    if (active !== id) return
    active = null
    emit()
  },

  releaseAll(): void {
    if (active === null) return
    active = null
    emit()
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },

  getSnapshot(): string | null {
    return active
  },
}
