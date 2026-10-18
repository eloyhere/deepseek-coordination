/**
 * Security invariants of the cache proxy.
 *
 * The proxy sees every prompt and every answer, so the risk is not a bug that
 * breaks a call — it is a bug that turns the plugin into an exfiltration path.
 * These tests pin the properties that make that impossible: structural tracing
 * only, a provider allowlist, and no transport or credential surface at all.
 *
 * The static scan reads the shipped sources as text. It strips comments first,
 * because the files *describe* the forbidden operations in their security
 * notes; only executable code is searched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PROXY_ALLOWED_PROVIDERS,
  createProxyAdapter,
  isProxyProviderAllowed,
} from '../src/host/proxy-adapter.js'
import type { ProxyTraceEvent } from '../src/host/proxy-adapter.js'

// `npm test` runs from the repository root; the bundles themselves live under
// `.tmp/test-build`, so the sources are resolved from the working directory.
const sourceRoot = join(process.cwd(), 'src')

/** Remove block and line comments so the scan only reads executable code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function sourceOf(relative: string): string {
  return stripComments(readFileSync(join(sourceRoot, relative), 'utf8'))
}

/** Operations that would create an egress or credential surface. */
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\bfetch\s*\(/, why: 'network egress' },
  { pattern: /\bhttps?\.request\s*\(/, why: 'network egress' },
  // A *value* import of a network module is an egress surface; a type-only
  // import of `node:http` is the inbound request/response contract and is fine.
  { pattern: /import\s+(?!type\s)[^'"]*from ['"]node:(?:http|https|net|tls)['"]/, why: 'network egress' },
  { pattern: /require\(['"]node:(?:https?|net|tls)['"]\)/, why: 'network egress' },
  { pattern: /\bnew WebSocket\b/, why: 'network egress' },
  { pattern: /\bXMLHttpRequest\b/, why: 'network egress' },
  { pattern: /\bAuthorization\b/, why: 'credential handling' },
  { pattern: /\bBearer\b/, why: 'credential handling' },
  { pattern: /\bapiKey\b/, why: 'credential handling' },
  { pattern: /\bcredentials\b/, why: 'credential handling' },
  { pattern: /\.credentials\.ya?ml/, why: 'credential handling' },
  { pattern: /process\.env\.[A-Z_]*KEY\b/, why: 'credential handling' },
]

test('the proxy module has no transport, credential or persistence surface', () => {
  const code = sourceOf('host/proxy-adapter.ts')
  for (const { pattern, why } of FORBIDDEN) {
    assert.doesNotMatch(code, pattern, `proxy-adapter.ts must not contain ${why} (${pattern})`)
  }
  // A pure module: no imports means no IO primitive can hide behind one.
  assert.doesNotMatch(code, /^\s*import\b/m, 'proxy-adapter.ts must stay import-free')
  assert.doesNotMatch(code, /^\s*export\s+\{[^}]*createHash/m, 'no hashing of user content either')
})

test('the routing half of the host adds no transport or credential read', () => {
  // The routing and installation half moved to `host/proxy-service.ts`; scan
  // both files so the move cannot silently drop one from the audit.
  for (const relative of ['index.ts', 'host/proxy-service.ts']) {
    const code = sourceOf(relative)
    for (const { pattern, why } of FORBIDDEN) {
      assert.doesNotMatch(code, pattern, `${relative} must not contain ${why} (${pattern})`)
    }
  }
})

test('tracing is structural: no prompt or answer text reaches the sink', () => {
  const events: ProxyTraceEvent[] = []
  const secret = 'sk-live-DO-NOT-LEAK-0123456789'
  const { adapter } = proxyFor({ provider: 'deepseek-account' }, (event) => events.push(event))

  adapter.stream(Object.freeze({
    provider: 'coordination-proxy',
    model: 'deepseek-flash',
    messages: Object.freeze([
      Object.freeze({ role: 'user', content: `my key is ${secret}` }),
      Object.freeze({ role: 'assistant', content: Object.freeze([{ type: 'text', text: secret }]) }),
    ]),
    tools: [{ name: 'read' }],
  }))

  assert.ok(events.some((event) => event.event === 'forward'), 'the forward is traced')
  const serialised = JSON.stringify(events)
  assert.equal(serialised.includes(secret), false, 'no trace event may carry message text')
  // The size and shape are present, the content is not.
  const forward = events.find((event) => event.event === 'forward')
  assert.equal(forward?.messages, 2)
  assert.ok((forward?.chars ?? 0) > 0)
  assert.equal(forward?.tools, 1)

  const allowedKeys = new Set([
    'event',
    'provider',
    'model',
    'brand',
    'messages',
    'chars',
    'tools',
    'reason',
    'upstreamProvider',
    'prefix',
    'stable',
    'from',
    'to',
  ])
  for (const event of events) {
    for (const key of Object.keys(event)) {
      assert.ok(allowedKeys.has(key), `unexpected trace field "${key}" — content could hide here`)
    }
  }
})

test('a provider outside the allowlist is refused, never proxied', () => {
  const events: ProxyTraceEvent[] = []
  const { adapter, sent } = proxyFor(
    { provider: 'someone-elses-provider' },
    (event) => events.push(event),
    ['deepseek-account'],
  )

  assert.throws(() => adapter.stream(Object.freeze({ provider: 'coordination-proxy', messages: [] })),
    /not on the allowlist/)
  assert.equal(sent.length, 0, 'nothing is forwarded to a foreign provider')
  assert.ok(events.some((event) => event.event === 'refuse' && event.reason === 'provider-not-allowlisted'))
})

test('the allowlist names only the deployment routes', () => {
  assert.deepEqual([...PROXY_ALLOWED_PROVIDERS].sort(), ['deepseek', 'deepseek-account', 'deepseek-official'])
  for (const provider of PROXY_ALLOWED_PROVIDERS) {
    assert.equal(isProxyProviderAllowed(provider), true)
  }
  for (const foreign of ['', 'openai', 'someone-elses-provider', 'coordination-proxy', undefined, 42]) {
    assert.equal(isProxyProviderAllowed(foreign), false, `"${String(foreign)}" must not be proxied`)
  }
})

test('refusals name the route, never the contents', () => {
  const secret = 'sk-live-DO-NOT-LEAK-0123456789'
  const { adapter } = proxyFor({ provider: 'coordination-proxy' }, () => {})
  try {
    adapter.stream(Object.freeze({ messages: [{ role: 'user', content: secret }] }))
    assert.fail('a self-forward must throw')
  } catch (error) {
    assert.doesNotMatch(String((error as Error).message), /DO-NOT-LEAK/, 'a refusal must not quote the request')
  }
})

/** Build an adapter over a fake runtime with an optional allowlist. */
function proxyFor(
  route: { provider: string; model?: string },
  trace: (event: ProxyTraceEvent) => void,
  allowProviders?: readonly string[],
): { adapter: ReturnType<typeof createProxyAdapter>; sent: unknown[] } {
  const sent: unknown[] = []
  const adapter = createProxyAdapter({
    provider: 'coordination-proxy',
    routeOf: () => route,
    llm: {
      stream: (options: unknown) => {
        sent.push(options)
        return 'stream'
      },
      resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: model }),
      listModels: async () => [],
    },
    ...(allowProviders === undefined ? {} : { allowProviders }),
    trace,
  })
  return { adapter, sent }
}
