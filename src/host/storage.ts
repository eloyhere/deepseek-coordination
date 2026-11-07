/**
 * Where AMP keeps its data, and the durable part of the host-side state.
 *
 * AMP persistence belongs to the project, not to the machine: one kernel store
 * per workspace root, opened at `<root>/.deepseek-coordination/amp.sqlite`, so
 * goals, plans, tasks, attention, receipts and evidence travel with the working
 * directory. `storage: 'user'` (or an explicit `storePath`) keeps the previous
 * machine-wide layout available for deployments that want one shared store.
 *
 * The kernel already writes its entities and workflow events transactionally.
 * The verbs that have no kernel aggregate of their own — session status lines,
 * turn/report notes, the cooperation mailbox, cited evidence ids and execution
 * result handles — live in a small JSON document beside the store and are
 * flushed after every mutating AMP call. File snapshots used by
 * `workspace.diff` stay in memory: they are derivable from the workspace.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Directory, relative to the workspace root, that holds every AMP artifact. */
export const DEFAULT_STORE_DIRECTORY = '.deepseek-coordination'
/** Kernel store file name inside the storage directory. */
export const STORE_FILE = 'amp.sqlite'
/** Host-side AMP state file inside the storage directory. */
export const STATE_FILE = 'host-state.json'
/** Takeover preferences file inside the storage directory. */
export const PREFERENCES_FILE = 'preferences.json'

/** Per-document ceilings; the JSON is written whole, so it must stay small. */
const MAX_NOTES_PER_SESSION = 100
const MAX_MAILBOX_PER_SESSION = 200
const MAX_HANDLES = 64
const MAX_STATE_BYTES = 4 * 1024 * 1024
const STATE_VERSION = 1

export type AmpStorageMode = 'workspace' | 'user' | 'explicit'

/** The directories one kernel store needs. */
export interface AmpStorageLayout {
  readonly mode: AmpStorageMode
  readonly directory: string
  readonly storePath: string
}

/** Minimal configuration surface the layout depends on. */
export interface StorageConfig {
  readonly storePath?: string
  readonly storage?: string
  readonly storeDirectory?: string
}

/** Machine-wide fallback directory (`$DSH_HOME/storages/deepseek-coordination`). */
export function userStorageDirectory(): string {
  const configuredHome = process.env.DSH_HOME?.trim()
  const home = configuredHome !== undefined && configuredHome.length > 0 ? configuredHome : join(homedir(), '.dsh')
  return join(home, 'storages', 'deepseek-coordination')
}

/** The configured directory name, with an absolute path honored as-is. */
export function storeDirectoryName(config: StorageConfig): string {
  const configured = typeof config.storeDirectory === 'string' ? config.storeDirectory.trim() : ''
  return configured.length > 0 ? configured : DEFAULT_STORE_DIRECTORY
}

/**
 * Resolve where one workspace root keeps its AMP data.
 *
 * Precedence: an explicit `storePath` (one shared store), `storage: 'user'`
 * (the machine-wide layout), then the workspace directory. Without a known
 * root the machine-wide layout is the only safe answer — the host must never
 * guess a project directory from its own process cwd.
 */
export function storageLayout(config: StorageConfig, root: string | undefined): AmpStorageLayout {
  const explicit = typeof config.storePath === 'string' ? config.storePath.trim() : ''
  if (explicit.length > 0) {
    const storePath = resolve(explicit)
    return { mode: 'explicit', directory: dirname(storePath), storePath }
  }
  if (config.storage === 'user' || root === undefined) {
    const directory = userStorageDirectory()
    return { mode: 'user', directory, storePath: join(directory, STORE_FILE) }
  }
  const name = storeDirectoryName(config)
  const directory = isAbsolute(name) ? resolve(name) : join(resolve(root), name)
  return { mode: 'workspace', directory, storePath: join(directory, STORE_FILE) }
}

/** Canonical identity of a store, used to share one kernel between roots. */
export function storeIdentity(storePath: string): string {
  const canonical = resolve(storePath).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

/**
 * Seed a workspace's takeover preferences from the machine-wide file on first
 * use. The switches are ergonomic host state, not project content; without this
 * a layout upgrade would silently reset them, and the second-run cost of
 * copying four booleans is negligible.
 */
export function inheritUserPreferences(directory: string): void {
  try {
    const target = join(directory, PREFERENCES_FILE)
    if (existsSync(target)) return
    const home = userStorageDirectory()
    // Only a legacy layout has preferences worth carrying over; once the
    // machine-wide store is gone, new workspaces start from the defaults.
    if (!existsSync(join(home, STORE_FILE))) return
    const source = join(home, PREFERENCES_FILE)
    if (!existsSync(source)) return
    mkdirSync(directory, { recursive: true })
    writeFileSync(target, readFileSync(source, 'utf8'), 'utf8')
  } catch {
    // A read-only workspace simply keeps the defaults.
  }
}

/** File size in bytes, or `undefined` when the file is absent/unreadable. */
export function fileBytes(path: string): number | undefined {
  try {
    const stat = statSync(path)
    return stat.isFile() ? stat.size : undefined
  } catch {
    return undefined
  }
}

function readDocument(file: string): unknown {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Durable host-side AMP state for one store: notes, status lines, mailboxes,
 * cited evidence ids and execution handles.
 *
 * Maps are mutated directly by the handlers, exactly as before; `flush()` writes
 * the whole document atomically and is called after each AMP call and on
 * shutdown. A failed write is ignored: this state is an audit convenience and
 * must never fail a protocol call.
 */
export class AmpStateStore {
  readonly notes = new Map<string, unknown[]>()
  readonly statusLines = new Map<string, string>()
  readonly mailboxes = new Map<string, unknown[]>()
  readonly citations = new Set<string>()
  readonly handles = new Map<string, unknown>()
  /** Text last read per workspace path; volatile by design. */
  readonly baseContents = new Map<string, string>()

  private readonly file: string
  private written: string | undefined

  constructor(file: string) {
    this.file = file
    this.load()
  }

  /** Write the document when it changed since the last successful flush. */
  flush(): void {
    try {
      while (this.handles.size > MAX_HANDLES) {
        const oldest = this.handles.keys().next().value
        if (oldest === undefined) break
        this.handles.delete(oldest)
      }
      const payload: Record<string, unknown> = {
        version: STATE_VERSION,
        notes: Object.fromEntries(this.notes),
        statusLines: Object.fromEntries(this.statusLines),
        mailboxes: Object.fromEntries(this.mailboxes),
        citations: [...this.citations],
        handles: Object.fromEntries(this.handles),
      }
      let text = `${JSON.stringify(payload, null, 2)}\n`
      if (text.length > MAX_STATE_BYTES) {
        // Handles hold tool output and are the only unbounded part; the rest of
        // the document is capped per collection and stays useful without them.
        payload.handles = {}
        text = `${JSON.stringify(payload, null, 2)}\n`
      }
      if (text === this.written) return
      mkdirSync(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, text, 'utf8')
      renameSync(temporary, this.file)
      this.written = text
    } catch {
      // Audit state is best-effort; a read-only workspace must not break a call.
    }
  }

  /** Flush and drop references so a disposed host holds nothing alive. */
  dispose(): void {
    this.flush()
    this.notes.clear()
    this.statusLines.clear()
    this.mailboxes.clear()
    this.citations.clear()
    this.handles.clear()
    this.baseContents.clear()
  }

  private load(): void {
    const document = readDocument(this.file)
    if (!isRecord(document)) return
    const notes = isRecord(document.notes) ? document.notes : {}
    const mailboxes = isRecord(document.mailboxes) ? document.mailboxes : {}
    const statusLines = isRecord(document.statusLines) ? document.statusLines : {}
    for (const [sessionId, value] of Object.entries(notes)) {
      if (Array.isArray(value)) this.notes.set(sessionId, value.slice(-MAX_NOTES_PER_SESSION))
    }
    for (const [sessionId, value] of Object.entries(statusLines)) {
      if (typeof value === 'string' && value.trim().length > 0) this.statusLines.set(sessionId, value)
    }
    for (const [sessionId, value] of Object.entries(mailboxes)) {
      if (Array.isArray(value)) this.mailboxes.set(sessionId, value.slice(-MAX_MAILBOX_PER_SESSION))
    }
    if (Array.isArray(document.citations)) {
      for (const id of document.citations) {
        if (typeof id === 'string' && id.length > 0) this.citations.add(id)
      }
    }
    const handles = isRecord(document.handles) ? document.handles : {}
    for (const [id, value] of Object.entries(handles).slice(-MAX_HANDLES)) {
      this.handles.set(id, value)
    }
  }
}
