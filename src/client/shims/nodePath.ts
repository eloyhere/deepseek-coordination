/**
 * Browser shim for `node:path`.
 *
 * `vfile` (pulled in by `react-markdown`) imports `node:path` from its Node
 * entry and does not publish the browser variant through `exports`, so a
 * bundler that resolves the package normally externalises `node:path`. The DSH
 * client module table only serves registered package ids, so that external
 * would abort the whole web boot. This shim keeps the tiny surface vfile uses
 * (`sep`, `basename`, `join`, `dirname`) entirely in the browser bundle.
 */
export const sep = '/'

export function basename(path: string): string {
  const normalised = String(path).replace(/\\/g, '/').replace(/\/+$/, '')
  const index = normalised.lastIndexOf('/')
  return index === -1 ? normalised : normalised.slice(index + 1)
}

export function dirname(path: string): string {
  const normalised = String(path).replace(/\\/g, '/').replace(/\/+$/, '')
  const index = normalised.lastIndexOf('/')
  if (index <= 0) return index === 0 ? '/' : '.'
  return normalised.slice(0, index)
}

export function join(...parts: string[]): string {
  const segments: string[] = []
  for (const part of parts) {
    if (typeof part !== 'string' || part.length === 0) continue
    for (const segment of part.replace(/\\/g, '/').split('/')) {
      if (segment.length === 0 || segment === '.') continue
      segments.push(segment)
    }
  }
  const joined = segments.join('/')
  return parts.length > 0 && parts[0]?.startsWith('/') ? `/${joined}` : joined
}

export default { sep, basename, dirname, join }
