/** Ephemeral navigation receipts: scoped to one host, Session and workspace. */
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { AmpHost } from './amp.js'
import { storageLayout } from './storage.js'

interface NavigationState {
  projectRevision?: string
  readonly files: Map<string, string>
}

export interface ProjectOutline {
  readonly root: string
  readonly revision: string
  readonly entries: readonly { path: string; kind: 'directory' | 'file' | 'link' }[]
  readonly truncated: boolean
}

// Navigation is not a durable user rule and never enters the prompt. A new host
// or Session must see the outline again; revisions invalidate file receipts.
const navigation = new WeakMap<AmpHost, Map<string, NavigationState>>()
const MAX_SCOPES = 128
const MAX_FILES = 512
const MAX_PROJECT_ENTRIES = 100

function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function stateOf(host: AmpHost, root: string): NavigationState {
  let scopes = navigation.get(host)
  if (scopes === undefined) {
    scopes = new Map()
    navigation.set(host, scopes)
  }
  const sessionId = host.currentExec()?.agent?.id
  if (sessionId === undefined) throw new Error('read navigation requires an agent session')
  const key = JSON.stringify([sessionId, pathKey(root)])
  let state = scopes.get(key)
  if (state === undefined) {
    state = { files: new Map() }
    scopes.set(key, state)
    if (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value!)
  }
  return state
}

export function projectSnapshot(host: AmpHost, root: string): ProjectOutline {
  const absolute = resolve(root)
  const internal = pathKey(storageLayout(host.config, absolute).directory)
  const entries = readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.name !== '.git'
      && entry.name !== 'node_modules'
      && entry.name !== '.deepseek-coordination'
      && entry.name !== 'host-state.json'
      && entry.name !== 'host-state.json.tmp'
      && pathKey(resolve(absolute, entry.name)) !== internal)
    .map((entry) => ({
      path: relative(absolute, resolve(absolute, entry.name)),
      kind: entry.isSymbolicLink() ? 'link' as const : entry.isDirectory() ? 'directory' as const : 'file' as const,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  return {
    root: absolute,
    revision: `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`,
    entries: entries.slice(0, MAX_PROJECT_ENTRIES),
    truncated: entries.length > MAX_PROJECT_ENTRIES,
  }
}

/** Return and remember the compact project tree only when not yet delivered. */
export function takeProjectOutline(host: AmpHost, root: string): ProjectOutline | undefined {
  const snapshot = projectSnapshot(host, root)
  const state = stateOf(host, root)
  if (state.projectRevision === snapshot.revision) return undefined
  state.projectRevision = snapshot.revision
  return snapshot
}

/** A successful root listing has already delivered project navigation. */
export function markProjectOutlined(host: AmpHost, root: string): void {
  stateOf(host, root).projectRevision = projectSnapshot(host, root).revision
}

export function hasFileOutline(host: AmpHost, root: string, path: string, revision: string): boolean {
  return stateOf(host, root).files.get(pathKey(path)) === revision
}

export function markFileOutlined(host: AmpHost, root: string, path: string, revision: string): void {
  const files = stateOf(host, root).files
  const key = pathKey(path)
  files.delete(key)
  files.set(key, revision)
  if (files.size > MAX_FILES) files.delete(files.keys().next().value!)
}
