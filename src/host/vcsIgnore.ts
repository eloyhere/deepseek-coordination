/**
 * Keep the AMP store directory out of every file-based version-control system.
 *
 * The store is a cache (`amp.sqlite`, `host-state.json`, `preferences.json`,
 * `project.json`), not project content: committing it would leak runtime data
 * and produce noisy diffs. Whenever the host establishes a workspace store it
 * therefore makes sure the workspace's VCS ignore file names that directory.
 *
 * The host detects the VCS by walking up from the workspace root and writes
 * that system's own ignore file at its repository root:
 *
 * | Marker                  | File                              | Syntax              |
 * |-------------------------|-----------------------------------|---------------------|
 * | `.git` (or `.jj`)       | `.gitignore`                      | gitignore           |
 * | `.hg`                   | `.hgignore`                       | regexp or glob      |
 * | `_FOSSIL_`/`.fslckout`  | `.fossil-settings/ignore-glob`    | glob                |
 * | `.bzr`                  | `.bzrignore`                      | glob                |
 * | `.pijul`                | `.ignore`                         | gitignore           |
 *
 * A plain folder the agent happens to work in is left untouched, and every
 * failure is swallowed — ignore bookkeeping must never break a protocol call.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

export type VcsKind = 'git' | 'mercurial' | 'fossil' | 'bazaar' | 'pijul'

export interface VcsRoot {
  readonly kind: VcsKind
  readonly root: string
}

/** Comment written above every generated rule. */
const RULE_COMMENT = '# AMP runtime data written by deepseek-coordination'

/** Find the nearest enclosing repository, if the workspace is inside one. */
export function findVcsRoot(start: string): VcsRoot | undefined {
  let current = resolve(start)
  for (;;) {
    if (existsSync(join(current, '.git')) || existsSync(join(current, '.jj'))) return { kind: 'git', root: current }
    if (existsSync(join(current, '.hg'))) return { kind: 'mercurial', root: current }
    if (existsSync(join(current, '.fslckout')) || existsSync(join(current, '_FOSSIL_'))) return { kind: 'fossil', root: current }
    if (existsSync(join(current, '.bzr'))) return { kind: 'bazaar', root: current }
    if (existsSync(join(current, '.pijul'))) return { kind: 'pijul', root: current }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Normalise one ignore line for duplicate detection. */
function normalisePattern(line: string): string {
  return line
    .replace(/^!/, '')
    .replace(/^\*\*\//, '')
    .replace(/^\//, '')
    .replace(/^\^/, '')
    .replace(/\\(.)/g, '$1')
    .replace(/\/?\*+$/, '')
    .replace(/\/+$/, '')
    .trim()
}

function alreadyIgnored(text: string, entry: string): boolean {
  const wanted = normalisePattern(entry)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    if (normalisePattern(line) === wanted) return true
  }
  return false
}

/** Append one block to `file`, preserving an existing file's text verbatim. */
function appendRule(file: string, body: string): boolean {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (alreadyIgnored(current, body.trim())) return false
  const prefix = current.length === 0 ? '' : current.endsWith('\n') ? '\n' : '\n\n'
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${prefix}${RULE_COMMENT}\n${body}`, 'utf8')
  return true
}

/** The Mercurial pattern matching `path` under the file's current syntax. */
function mercurialPattern(text: string, path: string): string {
  const directives = [...text.matchAll(/^\s*syntax\s*:\s*([A-Za-z]+)/gm)]
  const syntax = directives.length === 0 ? 'regexp' : (directives[directives.length - 1]?.[1] ?? 'regexp').toLowerCase()
  if (syntax === 'glob') return `${path}/**`
  return `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`
}

/**
 * Append a rule hiding `directory` from the VCS that owns `root`.
 *
 * @param root - workspace root the store belongs to.
 * @param directory - absolute store directory, normally `<root>/.deepseek-coordination`.
 * @returns whether a rule was written.
 */
export function ensureStoreIgnored(root: string, directory: string): boolean {
  try {
    const workspace = resolve(root)
    const store = resolve(directory)
    let vcs = findVcsRoot(workspace)
    if (vcs === undefined) {
      // A bare `.gitignore` without a marker still means "this is a Git tree".
      if (existsSync(join(workspace, '.gitignore'))) vcs = { kind: 'git', root: workspace }
      else return false
    }
    const relativePath = relative(vcs.root, store).replace(/\\/g, '/').replace(/^\.\//, '')
    if (relativePath.length === 0 || relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) return false

    switch (vcs.kind) {
      case 'git':
      case 'pijul':
        return appendRule(
          join(vcs.root, vcs.kind === 'git' ? '.gitignore' : '.ignore'),
          `${relativePath}/\n`,
        )
      case 'mercurial': {
        const file = join(vcs.root, '.hgignore')
        const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
        return appendRule(file, `${mercurialPattern(text, relativePath)}\n`)
      }
      case 'fossil':
        return appendRule(join(vcs.root, '.fossil-settings', 'ignore-glob'), `${relativePath}/*\n`)
      case 'bazaar':
        return appendRule(join(vcs.root, '.bzrignore'), `${relativePath}\n`)
    }
  } catch {
    // A read-only workspace simply keeps its current ignore rules.
    return false
  }
}
