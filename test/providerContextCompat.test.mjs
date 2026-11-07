import assert from 'node:assert/strict'
import test from 'node:test'
import { patchBody, createCompatibleFetch, apply, ProviderOptimizationRegistry, createOptimizedFetch, registerTccxyOptimization, isOpenAIModel } from '../scripts/context-compat/index.mjs'
const upstream = 'https://api.tccxy.top/v1'

test('registered relay applies all_turns to OpenAI models at each reasoning level', () => {
  for (const model of ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-4o', 'chatgpt-4o-latest', 'o1', 'o3-mini', 'o4-mini', 'codex-mini-latest', 'gpt-5-codex', 'openai/gpt-4.1', 'openai:o3', 'text-davinci-003']) {
    assert.equal(isOpenAIModel(model), true, model)
    for (const effort of ['low', 'medium', 'high']) {
      const body = { model, reasoning_effort: effort, reasoning: { effort, summary: 'auto', context: 'last_turn' }, messages: [{ role: 'user', content: 'OK' }] }
      for (const endpoint of ['chat/completions', 'responses']) {
        const patched = JSON.parse(patchBody(`${upstream}/${endpoint}`, 'POST', JSON.stringify(body)))
        assert.deepEqual(patched, { ...body, reasoning: { ...body.reasoning, context: 'all_turns' } })
        assert.equal(patchBody(`${upstream}/${endpoint}`, 'POST', JSON.stringify(patched)), undefined)
      }
    }
  }
})

test('unregistered providers, endpoints and non-OpenAI models stay unchanged', () => {
  const body = { model: 'gpt-6.1-sol', messages: [] }
  for (const url of ['https://api.openai.com/v1/chat/completions', 'https://api.tccxy.top.evil.invalid/v1/chat/completions', 'https://api.tccxy.top/v10/chat/completions', `${upstream}/models`, `${upstream}/chat/completions/extra`]) {
    assert.equal(patchBody(url, 'POST', JSON.stringify(body)), undefined, url)
  }
  for (const model of ['deepseek-chat', 'claude-opus-4', 'gemini-3-pro', 'qwen3']) {
    assert.equal(patchBody(`${upstream}/chat/completions`, 'POST', JSON.stringify({ ...body, model })), undefined)
  }
  assert.equal(patchBody(`${upstream}/chat/completions`, 'GET', JSON.stringify(body)), undefined)
  assert.equal(patchBody(`${upstream}/chat/completions`, 'POST', 'not json'), undefined)
  assert.equal(patchBody(`${upstream}/chat/completions`, 'POST', JSON.stringify({ ...body, reasoning: null })), undefined)
})

test('registry canonicalizes addresses and unregisters without a global fallback', () => {
  const registry = new ProviderOptimizationRegistry()
  const dispose = registerTccxyOptimization(registry, `${upstream}/`)
  assert.equal(registry.snapshot()[0].apiBase, upstream)
  assert.throws(() => registerTccxyOptimization(registry), /unique/)
  registry.register({ id: 'other', apiBase: 'https://other.invalid/v1', endpoints: ['responses'], optimize: body => ({ ...body, custom: true }) })
  const route = registry.resolve('https://other.invalid/v1/responses', 'POST')
  assert.deepEqual(registry.transform(route, { model: 'demo' }), { model: 'demo', custom: true })
  dispose()
  assert.equal(registry.resolve(`${upstream}/responses`, 'POST'), undefined)
  assert.equal(registry.snapshot().length, 1)
})

test('fetch preserves authentication, reasoning effort, query and cancellation', async () => {
  const abort = new AbortController()
  let patches = 0
  const original = async request => {
    assert.equal(request.headers.get('authorization'), 'Bearer test-only')
    assert.equal(request.headers.get('content-length'), null)
    assert.equal(request.url, `${upstream}/chat/completions?trace=1`)
    const body = await request.json()
    assert.equal(body.reasoning.context, 'all_turns')
    assert.equal(body.reasoning_effort, 'high')
    abort.abort()
    assert.equal(request.signal.aborted, true)
    return new Response('OK')
  }
  const fetch = createCompatibleFetch(original, upstream, () => { patches += 1 })
  const response = await fetch(`${upstream}/chat/completions?trace=1`, { method: 'POST', signal: abort.signal, headers: { authorization: 'Bearer test-only', 'content-length': '50' }, body: JSON.stringify({ model: 'gpt-6.1-sol', reasoning_effort: 'high', messages: [] }) })
  assert.equal(await response.text(), 'OK')
  assert.equal(patches, 1)
})

test('unrelated, non-JSON and encoded requests pass through with original identity', async () => {
  const registry = new ProviderOptimizationRegistry()
  registerTccxyOptimization(registry)
  for (const [url, init] of [
    ['https://other.invalid/v1/models', { method: 'GET' }],
    [`${upstream}/chat/completions`, { method: 'POST', headers: { 'content-encoding': 'gzip' }, body: 'encoded' }],
    [`${upstream}/chat/completions`, { method: 'POST', headers: { 'content-type': 'multipart/form-data' }, body: 'multipart' }],
  ]) {
    await createOptimizedFetch((input, options) => { assert.equal(input, url); assert.equal(options, init); return Promise.resolve(new Response('OK')) }, registry)(url, init)
  }
})

test('plugin registers registry diagnostics and restores fetch on disposal', () => {
  const original = globalThis.fetch
  const disposers = []
  let route
  apply({ effect(factory) { disposers.push(factory()) }, webServer: { register(value) { route = value; return () => {} } } })
  assert.notEqual(globalThis.fetch, original)
  let output
  route.handler({ method: 'GET' }, { writeHead() {}, end(text) { output = JSON.parse(text) } })
  assert.equal(output.registrations[0].id, 'tccxy-openai-reasoning-context')
  for (const dispose of disposers.reverse()) dispose()
  assert.equal(globalThis.fetch, original)
})
