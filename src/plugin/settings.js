/**
 * dsh-os settings service: the state the settings panel edits and the takeover reads.
 *
 * WHY THIS EXISTS AS A SERVICE RATHER THAN A CLOSURE IN takeover.js
 *
 * The switch has to be readable by the interception on every tool call, writable by the HTTP routes the
 * browser panel talks to, and visible to both without either one owning the other. A Cordis service is
 * how that is expressed in this runtime: `takeover.js` injects `dsh-os-settings` and calls `enabled()`
 * on each call, and the routes mutate the same object.
 *
 * WHY THE STATE IS A FILE AND NOT THE PROFILE
 *
 * A toggle a user flips in a panel must survive a restart, and `cordis.patch.yml` is a deployment input
 * rather than runtime state: writing it from a plugin would make the profile's patch layer — the layer
 * a human reviews — change underneath them. The state therefore lives in its own JSON document.
 *
 * LOCATION. `DSH_HOME` is preferred over the package root when it is set, because the package directory
 * is the installed artifact: it is replaced wholesale on upgrade, it may be read-only, and on Windows it
 * commonly sits under a path that an installer owns. A setting that only survives until the next upgrade
 * is worse than no setting. The package root remains the fallback so a checkout works with no
 * environment at all.
 *
 * FAILURE POLICY. A settings file that cannot be read is treated as absent and the documented defaults
 * are used; a settings file that cannot be written fails the HTTP call with a readable reason. Neither
 * case may take the host down: the whole point of the feature is that it is optional.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

import { PKG_ROOT } from './invoke.js'
import { TAKEOVER_TOOLS } from './takeover.js'

/** Service name other plugins inject. */
export const SERVICE_NAME = 'dsh-os-settings'

/** How many recent activity entries the panel can show. */
const ACTIVITY_LIMIT = 50

/** The shape of every boolean this service stores, so a hand-edited file cannot invert a default. */
function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Normalise an arbitrary parsed document into the settings shape, keeping only known keys. */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const tools = source.tools !== null && typeof source.tools === 'object' ? source.tools : {}
  const normalizedTools = {}
  for (const tool of TAKEOVER_TOOLS) {
    normalizedTools[tool] = asBoolean(tools[tool], true)
  }
  return {
    version: 1,
    // The master switch.

    enabled: asBoolean(source.enabled, false),
    tools: normalizedTools,
    // 'target' preserves the target file's BOM and line endings; 'builtin' reproduces the built-in
    // UTF-8-without-BOM, LF behaviour exactly. 'target' is the default because it is the reason the
    // takeover exists.
    writeFormat: source.writeFormat === 'builtin' ? 'builtin' : 'target',
  }
}

/** Where the settings document lives, with the reason each candidate is in the order it is in. */
export function settingsPath(env = process.env) {
  const home = env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return join(home, 'dsh-os', 'settings.json')
  return join(PKG_ROOT, '.dsh-os-settings.json')
}

/** Read the document, or the defaults. Never throws: an unreadable file is an absent one. */
export function readSettings(file) {
  try {
    if (!existsSync(file)) return normalizeSettings(undefined)
    const raw = readFileSync(file, 'utf8')
    if (raw.trim() === '') return normalizeSettings(undefined)
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return normalizeSettings(undefined)
  }
}

/**
 * Write the document atomically: sibling temporary file, then rename.
 *
 * A panel toggle and a tool call can overlap, and a half-written settings file would be read as
 * "defaults" on the next start — silently disabling a feature the user turned on. Rename is atomic on
 * the same filesystem, and the temporary file is a sibling by construction.
 */
export function writeSettings(file, settings) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* the original failure is the one that matters */ }
    throw error
  }
}

/**
 * The live settings object, registered as a Cordis service.
 *
 * `record`/`recordFallback` exist so the panel can show what actually happened rather than only what is
 * configured: "takeover is on" and "takeover is answering calls" are different claims, and only the
 * second one is evidence that the feature works.
 */
export class SettingsService {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.file = config.settingsPath ?? settingsPath()
    this.settings = readSettings(this.file)
    this.activity = []
    this.listeners = new Set()
  }

  /** The whole document, as the panel renders it. */
  current() {
    return {
      ...this.settings,
      path: this.file,
      tools: { ...this.settings.tools },
      activity: [...this.activity],
    }
  }

  /** Whether takeover is answering calls at all: the master switch. */
  enabled() {
    return this.settings.enabled === true
  }

  /** Whether one tool is taken over. Meaningless while the master switch is off, and reported as such. */
  toolEnabled(tool) {
    if (!this.settings.enabled) return false
    return this.settings.tools?.[tool] === true
  }

  /**
   * How a redirected write should encode its bytes: `'target'` preserves the file's own BOM and line
   * endings, `'builtin'` reproduces the built-in UTF-8-without-BOM, LF behaviour exactly.
   */
  writeFormat() {
    return this.settings.writeFormat === 'builtin' ? 'builtin' : 'target'
  }

  /** Apply a partial update, persist it, and tell the panel. Returns the new document. */
  update(patch) {
    const next = normalizeSettings({ ...this.settings, ...patch, tools: { ...this.settings.tools, ...(patch.tools ?? {}) } })
    writeSettings(this.file, next)
    this.settings = next
    this.emit()
    return this.current()
  }

  /**
   * Record one intercepted call.
   *
   * Bounded and in-memory on purpose: this is a live activity feed for a panel, not an audit log. The
   * durable trail is `permission.json`'s audit array, written by the consent delegate.
   */
  record(tool, exec, value) {
    this.push({
      at: new Date().toISOString(),
      tool,
      outcome: 'taken-over',
      // The path or command, which is what makes the feed readable at a glance.
      subject: subjectOf(tool, exec?.arguments),
      bytes: typeof value?.after === 'string' ? Buffer.byteLength(value.after, 'utf8') : undefined,
    })
  }

  /** Record that an interception declined a call and the built-in tool answered it instead. */
  recordFallback(tool, exec, error) {
    this.push({
      at: new Date().toISOString(),
      tool,
      outcome: 'fell-back',
      subject: subjectOf(tool, exec?.arguments),
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  push(entry) {
    this.activity.push(entry)
    if (this.activity.length > ACTIVITY_LIMIT) this.activity.splice(0, this.activity.length - ACTIVITY_LIMIT)
    this.emit()
  }

  /** Subscribe to changes; returns the unsubscribe function, as `ctx.effect` expects. */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit() {
    for (const listener of this.listeners) {
      try { listener() } catch { /* a panel listener must not break a tool call */ }
    }
  }
}

/** The tool-call subject a human would recognise: the file for file tools, the command for pwsh. */
function subjectOf(tool, args) {
  if (args === null || typeof args !== 'object') return ''
  if (tool === 'pwsh') return typeof args.command === 'string' ? args.command.slice(0, 200) : ''
  return typeof args.file_path === 'string' ? args.file_path : ''
}

// ---------------------------------------------------------------------------
// HTTP surface for the browser panel
// ---------------------------------------------------------------------------

/** Write one JSON response. Local rather than imported: this package has no runtime dependencies. */
function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Read one JSON request body with a ceiling, so a malformed caller cannot grow the heap. */
function readJsonBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try { resolve(JSON.parse(text)) } catch (error) { reject(new Error(`request body is not JSON: ${error.message}`)) }
    })
  })
}

/**
 * The panel's three endpoints.
 *
 * They are registered through `ctx.webServer`, the same seam the built-in SPA and the other UI plugins
 * use, so they are reachable at the same origin with no port, token or CORS negotiation.
 */
export function makeSettingsRoutes(service) {
  const state = () => ({ ok: true, settings: service.current(), available: TAKEOVER_TOOLS })
  return [
    {
      kind: 'exact',
      path: '/api/dsh-os/settings',
      handler: (req, res) => {
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        writeJson(res, 200, state())
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-os/set',
      handler: (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        readJsonBody(req).then((body) => {
          // Only known keys are forwarded: `update` normalises anyway, but refusing an unknown shape here
          // means a typo in the panel is a visible error instead of a silent no-op.
          const patch = {}
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
          if (body.writeFormat === 'target' || body.writeFormat === 'builtin') patch.writeFormat = body.writeFormat
          if (body.tools !== null && typeof body.tools === 'object') {
            patch.tools = {}
            for (const tool of TAKEOVER_TOOLS) {
              if (typeof body.tools[tool] === 'boolean') patch.tools[tool] = body.tools[tool]
            }
          }
          if (Object.keys(patch).length === 0) {
            writeJson(res, 400, { ok: false, error: 'no recognised setting in the request body' })
            return
          }
          try {
            service.update(patch)
            writeJson(res, 200, state())
          } catch (error) {
            writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }, (error) => {
          writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        })
      },
    },
  ]
}

/**
 * The plugin row for the settings service.
 *
 * There is deliberately NO `inject` here, and that is the whole point of this shape.
 *
 * An `inject: ['webServer']` on the row would gate the row's activation on a service that a profile may
 * legitimately never provide — and the settings service is what the TAKEOVER injects, so a profile
 * without a web server would not merely lose the panel, it would silently lose the interception too.
 * The panel is an interface; the interception is the feature.
 *
 * So the service is provided unconditionally, and the HTTP routes are registered through `ctx.inject`,
 * which runs its callback when (and only when) `webServer` is available and unwinds it if it goes away.
 * A headless deployment therefore keeps a working takeover with no endpoints, and a Web one gets both.
 */
export const name = 'dsh-os-settings'

export function apply(ctx, config = {}) {
  const service = new SettingsService(ctx, config)

  // `ctx.provide` REGISTERS the service and returns a disposer; `ctx.set` only overwrites the value of a
  // service that was already provided, and calling it first throws
  //   Error: cannot set property "dsh-os-settings" without provide
  // which would abort the whole entry. Same trap the consent delegate documents.
  const disposeService = ctx.provide?.(SERVICE_NAME, service)
  void disposeService

  // A context without the injection API (the unit tests' stand-in) simply gets no routes, which is
  // honest rather than half-registered.
  if (typeof ctx.inject !== 'function') return

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => {
      const disposers = makeSettingsRoutes(service).map((route) => scoped.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-os-settings: routes')
  })
}

/** Exported for tests. */
export const __internals = { normalizeSettings, writeJson, readJsonBody, subjectOf, ACTIVITY_LIMIT }
