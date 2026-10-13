/**
 * cache-measure.mjs — measure the prefix-cache effect of this plugin's design decisions, on the real endpoint.
 *
 * THE MISTAKE THIS VERSION FIXES
 *
 * The first version salted each variant's SYSTEM PROMPT to give it its own cache lineage, and then mutated
 * the system prompt. That compares a mutated prompt against a baseline that was never the same bytes, so
 * every reading came back at ~96% and the measurement was worthless. The lineage identity and the thing
 * being mutated have to be independent, and here they are: one shared, fixed system prompt and tool
 * catalog, and the lineage distinguished by a long conversation prefix.
 *
 * METHOD
 *
 * Four users are separated by >1800 tokens of distinct filler, which exceeds the interval at which the
 * provider carves cache prefix units, so user B's requests cannot match user A's units or each other's
 * variants. Each reading is ONE request after a warm request on the same lineage — never two identical
 * requests, which would persist a longer unit and hide the variant's true cost.
 *
 * `max_tokens: 1` keeps requests cheap; the cache prefix is settled before decoding, so the cap does not
 * affect what is being measured.
 *
 * Usage: node .temporary/cache-measure.mjs
 * The key is read from $DSH_HOME/.credentials.yaml and never printed.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? 'C:/Users/Administrator/.dsh'
const MODEL = 'deepseek-flash'
const ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages'

function apiKey() {
  const text = readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8')
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith('DEEPSEEK_API_KEY:'))
  if (line === undefined) throw new Error('DEEPSEEK_API_KEY is not present in .credentials.yaml')
  const value = line.split(':').slice(1).join(':').trim()
  if (value === '') throw new Error('DEEPSEEK_API_KEY is empty')
  return value
}
const KEY = apiKey()

const FILLER = 'The quick brown fox jumps over the lazy dog and then documents the boundary conditions. '
/** Filler whose tokens differ per word, so two users' prefixes cannot coincide. */
function filler(word, blocks = 260) {
  return Array.from({ length: blocks }, (_, i) => `${i + 1}. ${word} ${FILLER}`).join('\n')
}

const BASE_SYSTEM = 'You are an AI agent powered by DeepSeek Harness. Follow the user instruction exactly.'
const TOOLS = [
  { name: 'read', description: 'Read a UTF-8 text file and return line-numbered content.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'write', description: 'Create or fully replace a UTF-8 text file.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
  { name: 'pwsh', description: 'Execute a PowerShell command and return its stdout/stderr.', input_schema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command', 'description'] } },
  { name: 'todo_write', description: 'Record and update a task list to plan multi-step work and show progress.', input_schema: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object' } } }, required: ['todos'] } },
  { name: 'workflow_plan', description: 'Intent-first workflow: agree on what is wanted and how it will be done, before doing it.', input_schema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
]

async function call({ system = BASE_SYSTEM, messages, tools = TOOLS }) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1, system, messages, tools }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  const json = JSON.parse(text)
  const u = json.usage ?? {}
  const input = u.input_tokens ?? 0
  const cacheRead = u.cache_read_input_tokens ?? 0
  const cacheWrite = u.cache_creation_input_tokens ?? 0
  const total = input + cacheRead + cacheWrite
  return { input, cacheRead, cacheWrite, total, rate: total === 0 ? 0 : cacheRead / total, content: json.content ?? [] }
}

/**
 * A tool-call turn, built by hand.
 *
 * Thinking mode rejects `tool_choice` outright ("Thinking mode does not support this tool_choice") and
 * requires every assistant turn it reads back to carry a `thinking` block, so neither a plain assistant
 * message nor a forced tool call works here. An empty thinking block beside the `tool_use` is accepted,
 * which keeps this measurement to ONE request per variant instead of paying for a model call to author
 * each turn. `max_tokens: 1` is correct for the same reason: the cache prefix is settled before decoding,
 * and the reply is not read.
 */
function toolTurn(index, action, result) {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: '' },
        { type: 'tool_use', id: `t${index}`, name: 'workflow_plan', input: { action } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${index}`, content: result }] },
  ]
}

const rows = []
function report(name, usage) {
  rows.push({ name, ...usage })
  console.log(`  ${name.padEnd(42)} read=${String(usage.cacheRead).padStart(6)}  write=${String(usage.cacheWrite).padStart(6)}  miss=${String(usage.input).padStart(5)}  total=${String(usage.total).padStart(6)}  hit=${(usage.rate * 100).toFixed(1)}%`)
  return usage
}

/** Warm one lineage once, then send the variant once. */
async function variant(user, name, mutate) {
  const base = { messages: [{ role: 'user', content: `${filler(user)}\n\nSummarise line 1 in one word.` }] }
  await call(base)
  return report(name, await call(mutate(base)))
}

console.log(`prefix-cache measurement — ${ENDPOINT} — model ${MODEL}`)
console.log('one request per variant, after one warm request on the same lineage\n')

console.log('A user: the design this plugin uses — nothing touches the system prompt or the tool catalog')
await variant('alpha', 'A1 unchanged (control)', (r) => r)
await variant('alpha', 'A2 append a user message', (r) => ({
  messages: [...r.messages, { role: 'user', content: 'Now say OK.' }],
}))
await variant('alpha', 'A3 append a tool result', (r) => ({
  messages: [...r.messages, ...toolTurn('a3', 'start', '{"ok":true,"phase":"plan","next":"call workflow_plan with action \\"plan\\""}')],
}))

console.log('\nB user: the rejected design — the phase rendered into the system prompt')
await variant('bravo', 'B1 unchanged (control)', (r) => r)
await variant('bravo', 'B2 rewrite the LEADING system prompt', () => ({
  messages: [{ role: 'user', content: `${filler('bravo')}\n\nSummarise line 1 in one word.` }],
  system: `${BASE_SYSTEM}\n## Workflow: plan. Call workflow_plan with action "plan".`,
}))
await variant('bravo', 'B3 append an in-history system message', () => ({
  messages: [{ role: 'user', content: `${filler('bravo')}\n\nSummarise line 1 in one word.` }],
  system: [
    { type: 'text', text: BASE_SYSTEM },
    { type: 'text', text: '## Workflow: plan. Call workflow_plan with action "plan".' },
  ],
}))

console.log('\nC user: the tool catalog')
await variant('charlie', 'C1 unchanged (control)', (r) => r)
await variant('charlie', 'C2 change one tool description', (r) => ({
  messages: r.messages,
  tools: TOOLS.map((t) => (t.name === 'workflow_plan' ? { ...t, description: `${t.description} (edited)` } : t)),
}))
await variant('charlie', 'C3 swap two tools', (r) => ({
  messages: r.messages,
  tools: [TOOLS[1], TOOLS[0], ...TOOLS.slice(2)],
}))

console.log('\nD user: one whole workflow, four calls, system prompt and catalog never moving')
const workflow = await (async () => {
  const messages = [{ role: 'user', content: `${filler('delta')}\n\nSummarise line 1 in one word.` }]
  await call({ messages })
  const steps = []
  const phases = [
    ['start', '{"ok":true,"phase":"plan","next":"call workflow_plan with action \\"plan\\""}'],
    ['plan', '{"ok":true,"phase":"choose","next":"call workflow_plan with action \\"choose\\""}'],
    ['choose', '{"ok":true,"phase":"run","next":"call workflow_plan with action \\"run\\""}'],
    ['run', '{"ok":true,"phase":"done","next":null}'],
  ]
  for (const [index, [action, result]] of phases.entries()) {
    messages.push(...toolTurn(index, action, result))
    const usage = await call({ messages })
    steps.push(usage)
    console.log(`  ${String(index + 1)} ${action.padEnd(38)} read=${String(usage.cacheRead).padStart(6)}  write=${String(usage.cacheWrite).padStart(6)}  miss=${String(usage.input).padStart(5)}  total=${String(usage.total).padStart(6)}  hit=${(usage.rate * 100).toFixed(1)}%`)
  }
  return steps
})()

console.log('\nE user: the same four phases with the prompt rewritten each time')
const rewritten = await (async () => {
  const messages = [{ role: 'user', content: `${filler('echo')}\n\nSummarise line 1 in one word.` }]
  await call({ messages })
  const out = []
  for (const phase of ['plan', 'choose', 'run']) {
    const usage = await call({ messages, system: `${BASE_SYSTEM}\n## Workflow: ${phase}.` })
    out.push(usage)
    console.log(`  phase -> ${phase.padEnd(34)} read=${String(usage.cacheRead).padStart(6)}  write=${String(usage.cacheWrite).padStart(6)}  miss=${String(usage.input).padStart(5)}  total=${String(usage.total).padStart(6)}  hit=${(usage.rate * 100).toFixed(1)}%`)
  }
  return out
})()

// --- verdict -----------------------------------------------------------------------------------
const mean = (list) => list.reduce((a, u) => a + u.rate, 0) / list.length
const find = (prefix) => rows.find((r) => r.name.startsWith(prefix))
const workflowRate = mean(workflow)
const rewriteRate = mean(rewritten)
const appendRate = (find('A2').rate + find('A3').rate) / 2
const inHistory = find('B3').rate
const leading = find('B2').rate
const missCost = rewritten.reduce((a, u) => a + u.input, 0)

console.log('\n=== results ===')
console.log(`appending history (the plugin's shape)     : ${(appendRate * 100).toFixed(1)}% mean hit`)
console.log(`one workflow, four calls, appending only  : ${(workflowRate * 100).toFixed(1)}% mean hit`)
console.log(`rewriting the leading system prompt       : ${(leading * 100).toFixed(1)}% hit, and ${(rewriteRate * 100).toFixed(1)}% across three phases`)
console.log(`appending an in-history system message    : ${(inHistory * 100).toFixed(1)}% hit`)
console.log(`changing a tool description               : ${(find('C2').rate * 100).toFixed(1)}% hit`)
console.log(`swapping two tools                        : ${(find('C3').rate * 100).toFixed(1)}% hit`)
console.log(`cache reads the four appended calls kept  : ${workflow.reduce((a, u) => a + u.cacheRead, 0)} tokens`)

/**
 * The claims this experiment is entitled to make.
 *
 * Only the append side. The mutation readings (rewriting the prompt, editing or reordering tools) are NOT
 * asserted here, and that is a deliberate retreat after measuring them twice and getting opposite answers:
 * the first run read 0.0% for all of them, the second read 97%. The provider documents why — it persists a
 * common prefix once it detects one ACROSS requests, so by the second run my own repeated identical
 * prefixes had been learned, and a mutation that changes them still matched. Per-variant A/B isolation on
 * a shared account therefore cannot settle the mutation side; the append side is stable across both runs
 * and is what this plugin's design actually depends on.
 */
const claims = {
  'appending history keeps the cache (>= 90%)': appendRate >= 0.9,
  'a whole workflow of appended calls stays warm (>= 90%)': workflowRate >= 0.9,
}
console.log('\n=== claims ===')
let failed = 0
for (const [claim, ok] of Object.entries(claims)) {
  console.log(`  ${ok ? 'HOLDS  ' : 'FAILED '} ${claim}`)
  if (!ok) failed += 1
}
console.log(failed === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failed} claim(s) did not hold)`)
process.exit(failed === 0 ? 0 : 1)
