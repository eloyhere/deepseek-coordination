/**
 * Browser shim for `node:process`.
 *
 * `vfile` calls `process.cwd()` from its Node entry; the browser build has no
 * `process` object at all. Returning `'/'` keeps vfile's path handling
 * deterministic without pretending to be a real working directory.
 */
export const browser = true
export const platform = 'browser'
export const version = ''
export const env: Record<string, string> = { NODE_ENV: 'production' }

export function cwd(): string {
  return '/'
}

export function nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void {
  void Promise.resolve().then(() => callback(...args))
}

export default { browser, platform, version, env, cwd, nextTick }
