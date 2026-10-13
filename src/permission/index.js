/**
 * dsh-os permission consent delegate.
 *
 * The ONLY writer of permission.json.
 *
 * Why this is a plugin and not a script subcommand: DSH's approval UI lives in the client, so only a
 * plugin can register an answerer on the approval waterfall and reach the user. The scripts
 * (dsh-os.ps1 / dsh-os.sh) therefore only ever READ the file - there is no write verb in the verb
 * table at all - and this delegate is the single component holding the write path.
 *
 * The four decisions the user can make map onto the two mechanisms available:
 *
 *   allow-once   -> the DSH approval seam. Its only grant is "allowed-once", so a one-shot decision
 *   deny-once       needs no persistence and must not create one.
 *   allow-always -> a rule in permission.json, written here. The approval seam deliberately cannot
 *   deny-always     express a durable grant, which is exactly why this delegate exists.
 *
 * Matching is deny-first, and that is a deliberate departure from "first match wins" for allow rules:
 * if a deny rule and an allow rule both match, the deny wins regardless of array order, because the
 * safe answer must not depend on the order somebody happened to append rules in.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-os-permission'

/** A service, so consumers can inject it and the tool layer can be swapped out. */
export const inject = ['tools']

// <pkg>/src/permission/index.js -> the package root is three levels up from the file.
const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** The five scopes the schema allows. */
const SCOPES = ['user', 'machine', 'process', 'session', 'any']

/** Audit is append-only and bounded; older entries are trimmed by the delegate, never edited. */
const AUDIT_LIMIT = 200

/** Written into every file this delegate produces, so a reader can tell who last wrote it. */
const WRITER = 'consent-delegate'

// NOTE: there is deliberately NO `Config` export here, and adding one back needs care.
//
// Cordis applies a plugin's `Config` export as a Standard Schema (a schemastery `z.object({...})`):
//   resolveConfig: if (!runtime.Config) return config
//                  const result = runtime.Config['~standard'].validate(config)
// A plain JavaScript object carrying JSON-Schema-shaped keys therefore fails at activation with
//   TypeError: Cannot read properties of undefined (reading 'validate')
// because `Config['~standard']` is undefined. Declaring the shape in JSON Schema does not make it a
// validator, so the object that used to live here was worse than nothing: it described the config
// truthfully while breaking every mount.
//
// Omitting `Config` is the correct choice for this package. The row's config is passed through
// unvalidated, and every field is optional with a default applied in `permissionPathOf`/`apply`, so
// there is nothing to validate. The alternative - exporting a schemastery schema - would add a runtime
// dependency to a package whose whole premise is that it has none.
//
// The config keys a deployment may set are:
//   permissionPath  absolute path to permission.json (default: <package root>/permission.json)
//   auditLimit      audit entries to keep (default: 200)

function permissionPathOf(config) {
  return config?.permissionPath ?? join(PKG_ROOT, 'permission.json')
}

/** An empty but valid document: the documented initial state is a 0-byte file, not a broken one. */
function emptyDocument() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: WRITER,
    defaults: { readOnly: 'allow', mutating: 'ask' },
    rules: [],
    audit: [],
  }
}

/**
 * Read the document.
 *
 * A 0-byte file is the documented initial state and is treated as empty, not as corruption: the
 * repository ships one so that the file's presence is not itself a signal.
 *
 * A file whose updatedBy is not this delegate is treated as untrusted. The reader then falls back to
 * defaults AND says so, because silently honouring rules somebody else wrote would defeat the whole
 * arrangement - the delegate is supposed to be the only writer.
 */
function readDocument(path) {
  if (!existsSync(path)) {
    return { document: emptyDocument(), trusted: true, exists: false, untrustedReason: null }
  }
  const raw = readFileSync(path, 'utf8')
  if (raw.trim() === '') {
    return { document: emptyDocument(), trusted: true, exists: true, untrustedReason: null }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      document: emptyDocument(),
      trusted: false,
      exists: true,
      untrustedReason: `file is not valid JSON: ${error.message}`,
    }
  }
  if (parsed.updatedBy !== WRITER) {
    // Fail closed: evaluate everything as defaults, and report the reason rather than the rules.
    return {
      document: emptyDocument(),
      trusted: false,
      exists: true,
      untrustedReason: `updatedBy is '${parsed.updatedBy}', expected '${WRITER}'`,
    }
  }
  if (!Array.isArray(parsed.rules)) parsed.rules = []
  if (!Array.isArray(parsed.audit)) parsed.audit = []
  return { document: parsed, trusted: true, exists: true, untrustedReason: null }
}

/**
 * Write the document atomically.
 *
 * Through a temporary file in the same directory plus a rename, so a crash cannot leave a half-written
 * permission file. A half-written file would read as untrusted and silently reset every durable
 * decision to defaults, which is the failure this avoids.
 */
function writeDocument(path, document) {
  document.version = 1
  document.updatedAt = new Date().toISOString()
  document.updatedBy = WRITER
  const dir = dirname(path)
  const tmp = join(dir, `.permission.json.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(document, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
  return document
}

/** Does a rule's verb pattern match? A trailing `.*` matches the whole namespace. */
function verbMatches(pattern, verb) {
  if (pattern === '*' || pattern === verb) return true
  if (pattern.endsWith('.*')) return verb.startsWith(pattern.slice(0, -1))
  return false
}

/** Does a rule's target match? `*` in a value matches any target. */
function targetMatches(ruleTarget, target) {
  const value = ruleTarget?.value ?? '*'
  if (value === '*') return true
  if (!target) return false
  return value === target
}

/**
 * Decide what the stored rules say about a call.
 *
 * Deny is checked across every matching rule before any allow is honoured, so the answer never depends
 * on the order rules were appended in.
 */
function evaluate(document, verb, target) {
  const matching = document.rules.filter(
    (r) => verbMatches(r.verb, verb) && targetMatches(r.target, target),
  )
  const denied = matching.find((r) => r.decision === 'deny-always')
  if (denied) {
    return { decision: 'deny-always', ruleId: denied.id, source: 'rule' }
  }
  const allowed = matching.find((r) => r.decision === 'allow-always')
  if (allowed) {
    return { decision: 'allow-always', ruleId: allowed.id, source: 'rule' }
  }
  return { decision: document.defaults.mutating, ruleId: null, source: 'defaults' }
}

function appendAudit(document, entry, limit) {
  document.audit.push(entry)
  // Trim from the front, never edit: the tail is the recent history and the earlier entries are the
  // ones dropped.
  if (document.audit.length > limit) {
    document.audit = document.audit.slice(document.audit.length - limit)
  }
}

function nextRuleId(document) {
  let max = 0
  for (const r of document.rules) {
    const m = /^r-(\d+)$/.exec(r.id ?? '')
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `r-${String(max + 1).padStart(4, '0')}`
}

export function apply(ctx, rawConfig) {
  // `?? {}` rather than a default parameter: Cordis passes a row's config as `null` when the row declares
  // none, and a default parameter only fires for `undefined`. This row happens to ship with a config, so
  // it never hit the fault — but the fix belongs here too, or a deployment that trims the row's config
  // takes the consent delegate down with it.
  const config = rawConfig ?? {}
  const path = permissionPathOf(config)
  const auditLimit = config.auditLimit ?? AUDIT_LIMIT

  /**
   * Grant a durable decision.
   *
   * A `*` target is refused without an explicit acknowledgement. The model forbids "permanent consent
   * to everything" as a side effect of a click, so a caller has to say so deliberately and the result
   * records that it was broad.
   */
  function grant({ verb, target, scope, decision, note, acknowledgeBroad }) {
    if (!verb) throw new Error('grant requires a verb')
    if (decision !== 'allow-always' && decision !== 'deny-always') {
      throw new Error(`decision must be allow-always or deny-always, got '${decision}'`)
    }
    if (scope && !SCOPES.includes(scope)) {
      throw new Error(`scope must be one of ${SCOPES.join(', ')}, got '${scope}'`)
    }
    const value = target?.value ?? '*'
    const broad = value === '*'
    if (broad && acknowledgeBroad !== true) {
      throw new Error(
        'refusing to persist a rule that matches every target without acknowledgeBroad: ' +
          'permanent consent to everything must be an explicit, separate decision',
      )
    }
    const state = readDocument(path)
    const document = state.document
    const rule = {
      id: nextRuleId(document),
      verb,
      target: { kind: target?.kind ?? 'any', value },
      scope: { kind: scope ?? 'user' },
      decision,
      grantedBy: WRITER,
      grantedAt: new Date().toISOString(),
      expiresAt: null,
      note: note ?? null,
      broad,
    }
    document.rules.push(rule)
    appendAudit(
      document,
      {
        at: new Date().toISOString(),
        verb,
        target: rule.target,
        decision,
        decidedBy: WRITER,
        ruleId: rule.id,
        broad,
      },
      auditLimit,
    )
    writeDocument(path, document)
    return { rule, fileTrusted: state.trusted }
  }

  /** Revoke a rule by id. Revoking is a durable decision too, so it takes the same path. */
  function revoke({ ruleId }) {
    if (!ruleId) throw new Error('revoke requires a ruleId')
    const state = readDocument(path)
    const document = state.document
    const index = document.rules.findIndex((r) => r.id === ruleId)
    if (index < 0) {
      throw new Error(`no rule with id '${ruleId}'`)
    }
    const [removed] = document.rules.splice(index, 1)
    appendAudit(
      document,
      {
        at: new Date().toISOString(),
        verb: removed.verb,
        target: removed.target,
        decision: 'revoked',
        decidedBy: WRITER,
        ruleId: removed.id,
      },
      auditLimit,
    )
    writeDocument(path, document)
    return { removed }
  }

  function query({ verb, target }) {
    const state = readDocument(path)
    const verdict = evaluate(state.document, verb, target?.value ?? target)
    return {
      verb,
      target: target ?? null,
      decision: verdict.decision,
      ruleId: verdict.ruleId,
      source: verdict.source,
      fileExists: state.exists,
      trusted: state.trusted,
      untrustedReason: state.untrustedReason,
      // Reported so a caller can see which strength it is actually operating at.
      aclEnforced: false,
    }
  }

  function list() {
    const state = readDocument(path)
    return {
      path,
      fileExists: state.exists,
      trusted: state.trusted,
      untrustedReason: state.untrustedReason,
      defaults: state.document.defaults,
      count: state.document.rules.length,
      rules: state.document.rules,
    }
  }

  function audit({ limit }) {
    const state = readDocument(path)
    const entries = state.document.audit
    const n = Math.max(1, Math.min(limit ?? 20, entries.length || 1))
    return {
      path,
      total: entries.length,
      returned: Math.min(n, entries.length),
      trusted: state.trusted,
      entries: entries.slice(Math.max(0, entries.length - n)),
    }
  }

  // The service other plugins and the tool layer consume.
  //
  // `ctx.provide` REGISTERS it; `ctx.set` only OVERWRITES the value of a service that was already
  // provided. Calling `set` first - as this used to - throws
  //   Error: cannot set property "dsh-os-permission" without provide
  // because the name is not yet in the fiber's property table, and that aborted the whole entry.
  // `provide` is also the form that returns a disposer, so the registration unwinds with the fiber.
  const service = { path, grant, revoke, query, list, audit, readDocument, evaluate }
  const disposeService = ctx.provide?.('dsh-os-permission', service)
  // `provide` runs inside a fiber effect, which is the documented place to register a resource. A
  // context that offers no `provide` (the unit tests' stand-in) is tolerated, but the service is then
  // simply not published, which is honest rather than silently half-registered.
  void disposeService

  const tool = (spec) => {
    if (typeof ctx.tools?.register !== 'function') return
    ctx.tools.register(spec)
  }

  tool({
    name: 'os_permission_query',
    description:
      'Ask what the stored permission rules say about one verb and target. Read-only: never writes.',
    parameters: {
      // A complete JSON Schema: `register()` does not compile the { name: {...} } property map that the
      // internal `defineTool` accepts, so the object root must be stated here explicitly.
      type: 'object',
      properties: {
        verb: { type: 'string', description: 'Verb to ask about, e.g. file.delete.' },
        target: { type: 'string', description: 'Target value, e.g. an absolute path.' },
      },
      required: ['verb'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      return JSON.stringify(query({ verb: args.verb, target: { value: args.target } }), null, 2)
    },
  })

  tool({
    name: 'os_permission_grant',
    description:
      'Persist a durable authorization decision. This is the only path that writes permission.json, ' +
      'and it must only be called after the user has chosen "allow always" or "deny always".',
    parameters: {
      type: 'object',
      properties: {
        verb: { type: 'string', description: 'Verb, or a namespace like file.*' },
        target: { type: 'string', description: 'Target value; * means every target.' },
        decision: {
          type: 'string',
          description: 'allow-always or deny-always.',
          enum: ['allow-always', 'deny-always'],
        },
        scope: { type: 'string', description: 'user, machine, process, session or any.' },
        note: { type: 'string', description: 'Optional human note.' },
        acknowledgeBroad: {
          type: 'boolean',
          description: 'Required when target is *, because consent to everything must be explicit.',
        },
      },
      required: ['verb', 'target', 'decision'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      return JSON.stringify(grant(args), null, 2)
    },
  })

  tool({
    name: 'os_permission_revoke',
    description: 'Remove a stored rule by id. Revoking is itself a durable decision.',
    parameters: {
      type: 'object',
      properties: {
        ruleId: { type: 'string', description: 'Rule id, e.g. r-0001.' },
      },
      required: ['ruleId'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      return JSON.stringify(revoke({ ruleId: args.ruleId }), null, 2)
    },
  })

  tool({
    name: 'os_permission_list',
    description: 'List the stored rules, the defaults, and whether the file is trusted.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      return JSON.stringify(list(), null, 2)
    },
  })

  tool({
    name: 'os_permission_audit',
    description: 'Read the tail of the append-only authorization audit.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many recent entries (default 20).' },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      return JSON.stringify(audit({ limit: args.limit }), null, 2)
    },
  })
}

// Exported for tests, so the matching and trust rules can be exercised without a live plugin context.
export const __internals = { evaluate, readDocument, verbMatches, targetMatches, emptyDocument }
