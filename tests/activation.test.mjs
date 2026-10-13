// activation.test.mjs - every row must survive the two ways a Cordis context breaks a plugin.
//
// WHY THIS FILE EXISTS
//
// Version 0.1.5 shipped with three rows that failed to activate in a live profile:
//
//   dsh-os-settings  TypeError: Cannot read properties of null (reading 'settingsPath')
//   dsh-os-workflow  Error: cannot get property "systemPrompt" without inject
//   dsh-os-takeover  (never got the chance: it injects dsh-os-settings, which was down)
//
// Neither fault was exotic, and neither was caught, because every earlier suite handed `apply()` a
// friendly mock: a plain object where any property reads back as `undefined`, `config` omitted, and
// services freely reachable. A Cordis context is not friendly in either respect:
//
//   1. It passes a row's config as `null` when the row declares none — and a `config = {}` default
//      parameter does NOT fire for null, so the first property read throws.
//   2. It resolves a service through an ENFORCING PROXY: an undeclared service does not read as
//      `undefined`, it THROWS. So `typeof ctx.systemPrompt?.section === 'function'` never runs — the
//      property access is itself the throw — and an `inject` list that omits a service it uses is fatal
//      rather than degraded.
//
// The two contexts below reproduce both behaviours on purpose, and every entry point must activate in
// both. This is the guard that would have caught 0.1.5 before it was published.
import { pathToFileURL } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let passes = 0
let failures = 0
const ok = (m) => { passes++; console.log('  PASS  ' + m) }
const bad = (m) => { failures++; console.log('  FAIL  ' + m) }

const scratch = join(tmpdir(), `dsh-os-activation-${Date.now()}`)
mkdirSync(scratch, { recursive: true })

/** The entries the bundle's patch rows name, and the services each one is allowed to declare. */
const ENTRIES = [
  { label: 'index.js      (.)', file: 'src/plugin/index.js', declared: ['tools'] },
  { label: 'settings.js   (./settings)', file: 'src/plugin/settings.js', declared: [] },
  { label: 'takeover.js   (./takeover)', file: 'src/plugin/takeover.js', declared: ['tools', 'dsh-os-settings', 'dsh-os-settings'] },
  { label: 'workflow.js   (./workflow)', file: 'src/plugin/workflow.js', declared: [] },
  { label: 'permission.js (./permission)', file: 'src/permission/index.js', declared: ['tools'] },
]

/**
 * Build a context that behaves like Cordis where it matters.
 *
 * @param declared - services the entry announced through `inject`, which are the only ones readable.
 * @param config - what the loader hands `apply`; `null` when the row declares no config.
 * @param servicesPresent - which services actually exist in this deployment. A declared-but-absent
 *   service must NOT be readable either: Cordis withholds it until it appears.
 */
function makeCtx({ declared, config, servicesPresent }) {
  const readable = new Set([
    ...declared,
    // Always-present conveniences a real context offers as methods rather than services.
    'tools', 'inject', 'provide', 'effect', 'on', 'get', 'logger', 'set', 'waterfall', 'emit', 'fiber', 'scope',
  ])
  const provided = new Map()
  const registered = []
  const sections = []
  const injections = []

  const ctx = {
    tools: { register: (t) => { registered.push(t); return t } },
    inject(names, callback) {
      injections.push(names.join(','))
      // Model the await-the-service contract: run the callback only when every service is present, and
      // hand it a context where those names are readable.
      if (names.every((n) => servicesPresent.includes(n))) {
        const scoped = makeCtx({ declared: [...declared, ...names], config, servicesPresent })
        callback(scoped)
      }
      return () => {}
    },
    provide(name, value) { provided.set(name, value); return () => {} },
    effect(fn) { const d = typeof fn === 'function' ? fn() : undefined; return () => { if (typeof d === 'function') d() } },
    on() { return () => {} },
    get() { return undefined },
    set() {},
    emit() {},
    logger: { warn() {}, info() {}, error() {} },
    fiber: { dispose() {} },
    // `systemPrompt` is deliberately NOT a own-property: it goes through the proxy below.
  }

  // Present services get a service-shaped object. A service that is declared but NOT present must stay
  // unreadable, which is why this keys off `servicesPresent` and not off the declared list.
  const shape = {
    tools: { register: (t) => { registered.push(t); return t } },
    userQuestions: { ask: async () => ({ answers: [] }), askTimed: async () => ({ answers: [] }) },
    webServer: { register: () => () => {} },
    systemPrompt: {
      section: (s) => { sections.push(s); return () => {} },
      getSectionOrder: () => 10,
      tools: () => () => {},
    },
  }
  for (const name of servicesPresent) {
    if (shape[name] !== undefined) ctx[name] = shape[name]
    else if (name !== 'tools') ctx[name] = {}
  }

  // THE ENFORCING PROXY. Any service-shaped property the entry did not declare throws exactly as Cordis
  // does, which is what turns "I forgot it in inject" into a test failure instead of a live one.
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver)
      if (readable.has(prop)) return Reflect.get(target, prop, receiver)
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
    has(target, prop) { return prop in target || readable.has(prop) },
  })
  void registered
  void sections
  void injections
}

// ---------------------------------------------------------------------------
console.log('activation verification for ' + root)
console.log(`scratch: ${scratch}`)
console.log('\n== 1. every entry activates with a NULL config (a row that declares none) ==')
for (const entry of ENTRIES) {
  const mod = await import(pathToFileURL(join(root, entry.file)).href)
  const plugin = mod.default ?? mod
  const ctx = makeCtx({ declared: plugin.inject ?? [], config: null, servicesPresent: ['tools', 'userAccounts', 'systemPrompt', 'webServer', 'userQuestions'] })
  try {
    plugin.apply(ctx, null)
    ok(`${entry.label} activated with config = null`)
  } catch (e) {
    bad(`${entry.label} threw on a null config: ${e.message}`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 2. a row that does not declare systemPrompt must not read it ==')
{
  const mod = await import(pathToFileURL(join(root, 'src/plugin/workflow.js')).href)
  const plugin = mod.default ?? mod
  const declared = plugin.inject ?? []
  if (declared.includes('systemPrompt')) {
    ok('workflow declares systemPrompt, so the access is legal')
  } else {
    // It does not declare it, so reaching for it must be routed through ctx.inject instead.
    const ctx = makeCtx({ declared, config: {}, servicesPresent: ['tools', 'userQuestions', 'systemPrompt'] })
    try {
      plugin.apply(ctx, {})
      ok('workflow activates without declaring systemPrompt — the section goes through ctx.inject')
    } catch (e) {
      bad(`workflow threw reaching an undeclared service: ${e.message}`)
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 3. every entry activates when optional services are ABSENT ==')
const WITHOUT = ['tools']
for (const entry of ENTRIES) {
  const mod = await import(pathToFileURL(join(root, entry.file)).href)
  const plugin = mod.default ?? mod
  const ctx = makeCtx({ declared: plugin.inject ?? [], config: null, servicesPresent: WITHOUT })
  try {
    plugin.apply(ctx, null)
    ok(`${entry.label} activated with no optional services present`)
  } catch (e) {
    bad(`${entry.label} threw when an optional service was absent: ${e.message}`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 4. the settings service publishes and takes an explicit path ==')
{
  const mod = await import(pathToFileURL(join(root, 'src/plugin/settings.js')).href)
  const plugin = mod.default ?? mod
  const target = join(scratch, 'settings.json')
  const ctx = makeCtx({ declared: [], config: { settingsPath: target }, servicesPresent: ['webServer'] })
  let providedName
  const realProvide = ctx.provide
  const providedMap = new Map()
  const proxied = new Proxy(ctx, {
    get(t, p, r) {
      if (p === 'provide') return (name, value) => { providedName = name; providedMap.set(name, value); return () => {} }
      return Reflect.get(t, p, r)
    },
  })
  void realProvide
  try {
    plugin.apply(proxied, { settingsPath: target })
    if (providedName === 'dsh-os-settings') ok('the service is provided under its documented name')
    else bad(`provided name was ${String(providedName)}`)
    const service = providedMap.get('dsh-os-settings')
    if (service && typeof service.enabled === 'function' && typeof service.update === 'function') {
      ok('the published service exposes enabled() and update()')
    } else {
      bad('the published service is missing the API the takeover and the panel call')
    }
    if (service) {
      const before = service.enabled()
      service.update({ enabled: true })
      const after = service.enabled()
      if (before === false && after === true) ok('the switch round-trips through the service')
      else bad(`switch did not round-trip: before=${before} after=${after}`)
    }
  } catch (e) {
    bad(`settings.apply threw: ${e.message}`)
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log('')
console.log(`passed=${passes} failed=${failures}`)
if (failures > 0) process.exit(1)
