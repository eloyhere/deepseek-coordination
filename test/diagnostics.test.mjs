/**
 * S1 diagnostics read-model tests.
 *
 * `AmpContextOptimizer` and `WireCapture` are TypeScript, imported directly with
 * Node 24's type stripping. Their runtime imports use the repository's `.js`
 * specifier convention, so a small synchronous resolve hook maps a relative
 * `.js` specifier to its `.ts` sibling when that sibling exists. The fake
 * context/host/kernel expose only what `contextFor` reads, which keeps these
 * tests on the real compile path without an AMP store or a plugin bootstrap.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL !== undefined &&
      specifier.endsWith('.js') &&
      (specifier.startsWith('./') || specifier.startsWith('../'))
    ) {
      const mapped = `${specifier.slice(0, -3)}.ts`
      try {
        if (existsSync(fileURLToPath(new URL(mapped, context.parentURL)))) {
          return nextResolve(mapped, context)
        }
      } catch {
        // Fall through to the original specifier.
      }
    }
    return nextResolve(specifier, context)
  },
})

const { AmpContextOptimizer } = await import('../src/host/context.ts')
const { WireCapture } = await import('../src/host/prestep.ts')

const SESSION = 'session-diagnostics'

const config = {
  tenantId: 'dsh-desktop',
  rootId: 'desktop',
  storage: 'workspace',
  storeDirectory: '.deepseek-coordination',
  notifications: false,
  prompt: false,
  skills: false,
  commands: false,
  routes: false,
  maxJournal: 100,
  maxReadChars: 100_000,
  maxWriteChars: 100_000,
  contextOptimization: true,
  contextBudgetTokens: 1200,
}

const agent = { id: SESSION, session: { header: { cwd: '' } } }

/** The only shape `contextFor` reads from `compileTurnContext`. */
function compileResult(exclusions) {
  return { compiled: { items: [], exclusions } }
}

/** Minimal `ctx`: no goals service, one turn boundary hook. */
function fakeContext() {
  return {
    get: () => undefined,
    agents: { turnBoundaryOf: () => ({ lastTurn: 1 }) },
    systemPrompt: { context: () => {}, getContextOrder: () => 0 },
  }
}

/** Minimal `host`: a caller-supplied compiler, fixed turn, enabled prefs. */
function fakeHost(compileTurnContext) {
  return {
    kernel: () => ({ flow: { compileTurnContext } }),
    currentTurn: () => 1,
    ensureTurn: () => `turn:${SESSION}:1`,
    preferencesFor: () => ({ get: () => ({ contextOptimization: true }) }),
    rootOfAgent: () => '',
  }
}

function optimizerFor(compileTurnContext, wire) {
  return new AmpContextOptimizer(fakeContext(), fakeHost(compileTurnContext), { ...config }, wire)
}

function parseable(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

test('a compile without pre-step input reports lag 1 and projects exclusions', () => {
  let compiles = 0
  const optimizer = optimizerFor(() => {
    compiles += 1
    return compileResult([
      { id: 'x', reason: 'unmounted', detail: 'old', version: 3, pointer: { kind: 'tool' } },
    ])
  })

  assert.equal(optimizer.contextFor(agent), '')
  assert.equal(compiles, 1)

  const diagnostics = optimizer.diagnostics()
  assert.equal(diagnostics.lag, 1)
  assert.equal(diagnostics.pending, false)
  assert.equal(diagnostics.compilerExclusions, 1)
  assert.deepEqual(diagnostics.lastExclusions, [{ id: 'x', reason: 'unmounted', detail: 'old' }])
  assert.ok(parseable(diagnostics.lastCompileAt), String(diagnostics.lastCompileAt))

  // The session-scoped view describes the same attempt as the global view.
  assert.deepEqual(optimizer.diagnostics(SESSION), diagnostics)
})

test('a hydrated pre-step capture makes the next compile report lag 0', () => {
  const wire = new WireCapture()
  const hydrated = wire.hydrate({ sessionId: SESSION, turn: 1, prompt: 'hi' })
  assert.ok(hydrated)

  const optimizer = optimizerFor(() => compileResult([]), wire)
  optimizer.contextFor(agent)

  const diagnostics = optimizer.diagnostics()
  assert.equal(diagnostics.lag, 0)
  assert.equal(diagnostics.pending, true)
  assert.equal(diagnostics.compilerExclusions, 0)
  assert.deepEqual(diagnostics.lastExclusions, [])
  assert.ok(parseable(diagnostics.lastCompileAt), String(diagnostics.lastCompileAt))
})

test('a throwing compiler is recorded as an empty diagnostic and not propagated', () => {
  const optimizer = optimizerFor(() => {
    throw new Error('compile failed')
  })

  let output
  assert.doesNotThrow(() => {
    output = optimizer.contextFor(agent)
  })
  assert.equal(output, '')

  const diagnostics = optimizer.diagnostics()
  assert.equal(diagnostics.lag, 1)
  assert.equal(diagnostics.pending, false)
  assert.equal(diagnostics.compilerExclusions, 0)
  assert.deepEqual(diagnostics.lastExclusions, [])
  assert.ok(parseable(diagnostics.lastCompileAt), String(diagnostics.lastCompileAt))
})

test('an unknown session returns the empty diagnostic state', () => {
  const optimizer = optimizerFor(() => compileResult([]))
  optimizer.contextFor(agent)

  const empty = optimizer.diagnostics('missing')
  assert.equal(empty.lag, 1)
  assert.equal(empty.pending, false)
  assert.equal(empty.compilerExclusions, 0)
  assert.deepEqual(empty.lastExclusions, [])
  assert.equal('lastCompileAt' in empty, false)
})

test('the projection is capped at 50 and drops malformed exclusions', () => {
  const exclusions = [
    { id: 1, reason: 'scope' },
    { id: 'ok', reason: 'budget', detail: 5, pointer: { kind: 'tool' } },
  ]
  for (let index = 0; index < 60; index += 1) {
    exclusions.push({ id: `e${index}`, reason: 'unmounted' })
  }

  const optimizer = optimizerFor(() => compileResult(exclusions))
  optimizer.contextFor(agent)

  const diagnostics = optimizer.diagnostics()
  // Every raw exclusion is counted, even ones that cannot be projected.
  assert.equal(diagnostics.compilerExclusions, 62)
  // The first 50 raw entries contain the malformed one, so 49 survive.
  assert.equal(diagnostics.lastExclusions.length, 49)
  assert.deepEqual(diagnostics.lastExclusions[0], { id: 'ok', reason: 'budget' })
  assert.equal(diagnostics.lastExclusions.every((view) => typeof view.id === 'string' && typeof view.reason === 'string'), true)
})
