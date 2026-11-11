/**
 * Context-token benchmark for the wired AMP attention pipeline.
 *
 * It boots the real plugin (`lib/index.mjs`) against a fake DSH context, feeds a
 * deliberately large session, and reports three layers:
 *
 * 1. `raw`    — every channel's full text, concatenated: the "dump everything"
 *               baseline a context assembler without pruning would carry.
 * 2. `capped` — what the plugin's per-channel caps let through (the same
 *               fixtures compiled with a budget large enough that AMP rejects
 *               nothing).
 * 3. `injected` — what the model actually receives at the production budget
 *               (default 1200), measured by the same CJK-aware estimator the
 *               compiler uses.
 *
 * `raw - capped` is hard truncation, `capped - injected` is AMP's budget
 * selection. The cache and prune counters come from the same run.
 *
 * Usage: node scripts/bench-context.mjs [budgetTokens]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.mjs'
import { estimateTokens } from '../src/host/tokenEstimate.ts'

const SESSION = 'bench-session'
const TURN = 1

/** A long, mixed-script prompt: what a real "audit this project" message looks like. */
const PROMPT = (
  '请你审计现有项目的上下文压缩、剪枝、缓存优化等功能，搜索资料，探索更好的算法。' +
  '要求：给出证据、指出问题、按严重程度排序，并说明每一处改动对 token 预算的影响。'
).repeat(14)

const GOAL = '把 attention-manifest-protocol 的上下文能力完整接入插件并通过回归，确认预算、缓存与剪枝指标可观测。'.repeat(6)

const TODOS = Array.from({ length: 24 }, (_, index) => ({
  content: `第 ${index + 1} 项：核对通道 ${index + 1} 的预算、排除原因与寄存器计数，确认没有静默丢失。`,
  status: index < 8 ? 'completed' : index < 10 ? 'in_progress' : 'pending',
}))

const TOOL_OUTPUTS = [
  'error TS2322: Type string is not assignable to type number.\n' + '  at src/host/context.ts:470:18\n'.repeat(60),
  JSON.stringify({ files: Array.from({ length: 80 }, (_, index) => ({ path: `src/host/file-${index}.ts`, lines: index * 13 })) }, null, 2),
  'PASS test/contextCache.test.mjs\n'.repeat(120),
]

const WORKSPACE = 'D:\\project\\deepseek-coordination'

/** One isolated plugin instance over a temp store. */
async function boot(budgetTokens) {
  const directory = mkdtempSync(join(tmpdir(), 'amp-bench-'))
  const handlers = new Map()
  let host
  const ctx = {
    tools: { register: () => () => {}, get: () => undefined, definitions: () => [] },
    systemPrompt: { getSectionOrder: () => 0, getContextOrder: () => 0, section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {} },
    skills: { register: () => () => {} },
    sessions: { list: () => [] },
    agents: { get: () => undefined },
    on: (name, handler) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {}
    },
    effect: (factory) => {
      const dispose = factory()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    // The goal channel reads the host goals service; provide the real shape.
    get: (name) => (name === 'goals' ? { get: () => ({ objective: GOAL }) } : undefined),
    provide: (_name, value) => {
      host = value
      return () => {}
    },
    inject: () => () => {},
  }
  await apply(ctx, {
    tenantId: 'bench', rootId: 'root', storePath: join(directory, 'amp.sqlite'),
    notifications: false, prompt: false, skills: false, commands: false, routes: false,
    maxJournal: 100, maxReadChars: 100_000, maxWriteChars: 100_000,
    contextOptimization: true, contextBudgetTokens: budgetTokens,
  })
  const emit = (name, ...args) => {
    for (const handler of handlers.get(name) ?? []) handler(...args)
  }
  const agent = { id: SESSION, status: 'running', session: { header: { cwd: directory } } }
  return { directory, handlers, emit, agent, host: () => host, close: () => host?.close() }
}

/** Drive one turn: the same fixtures for every budget, so only the budget differs. */
async function run(budgetTokens, steps) {
  const instance = await boot(budgetTokens)
  const { emit, agent } = instance
  try {
    emit('agent/created', { agent })
    emit('session/event', { id: SESSION }, { type: 'user/message', data: { content: [{ type: 'text', text: PROMPT }] } })
    emit('session/event', { id: SESSION }, { type: 'turn/start', data: { turn: TURN } })
    emit('goal/changed', { agent, change: { goal: { id: 'g1', objective: GOAL, phase: 'active', revision: 1 } } })
    emit('session/event', { id: SESSION }, { type: 'todo/write', data: { turn: TURN, todos: TODOS } })
    TOOL_OUTPUTS.forEach((output, index) => {
      emit('session/event', { id: SESSION }, { type: 'tool/call', data: { turn: TURN, step: 1, callId: `call-${index}`, name: 'read', arguments: '{}' } })
      emit('session/event', { id: SESSION }, { type: 'tool/result', data: { turn: TURN, step: 1, message: { toolCallId: `call-${index}`, isError: false, content: [{ type: 'text', text: output }] } } })
    })

    const optimizer = instance.host().contextOptimizer
    const prestep = instance.handlers.get('agent/pre-step')?.[0]
    const messages = [{ role: 'user', source: 'user', content: [{ type: 'text', text: PROMPT }] }]
    let context = ''
    for (let step = 0; step < steps; step += 1) {
      if (prestep !== undefined) {
        await prestep({ agent, messages, turn: TURN, step }, async () => ({ kind: 'enter', messages }))
      }
      context = optimizer.contextFor(agent)
    }
    // A second assembly of the same step: measures the AMP context cache.
    context = optimizer.contextFor(agent)
    const beforeReview = optimizer.status()
    const diagnostics = optimizer.diagnostics()
    const outcome = optimizer.reviewTurn(SESSION)
    const afterReview = optimizer.status()
    return { context, beforeReview, afterReview, diagnostics, outcome, close: instance.close }
  } catch (error) {
    instance.close()
    throw error
  }
}

/** Bytes a naive assembler would concatenate, measured with the same estimator. */
function rawTokens() {
  const plan = TODOS.map((todo) => `${todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]'} ${todo.content}`).join('\n')
  return {
    prompt: estimateTokens(PROMPT),
    goal: estimateTokens(GOAL),
    plan: estimateTokens(plan),
    tools: TOOL_OUTPUTS.reduce((sum, output) => sum + estimateTokens(output), 0),
    workspace: estimateTokens(`workspace: ${WORKSPACE}`),
  }
}

const budget = Number(process.argv[2] ?? 1200)
const STEPS = 12

const small = await run(budget, STEPS)
const large = await run(1_000_000, STEPS)
try {
  const raw = rawTokens()
  const rawTotal = Object.values(raw).reduce((sum, value) => sum + value, 0)
  const injected = small.beforeReview.lastTokens
  const capped = large.beforeReview.lastTokens
  const cappedCacheMiss = large.beforeReview.cache

  const pct = (part, whole) => `${((part / whole) * 100).toFixed(1)}%`
  console.log('\n=== AMP attention token benchmark ===')
  console.log(`budget=${budget} steps=${STEPS} chars(prompt)=${PROMPT.length}`)
  console.log('\n-- raw channel content (what a dump-everything assembler carries) --')
  for (const [channel, tokens] of Object.entries(raw)) console.log(`  ${channel.padEnd(10)} ${String(tokens).padStart(7)} tok`)
  console.log(`  ${'TOTAL'.padEnd(10)} ${String(rawTotal).padStart(7)} tok`)
  console.log('\n-- after the plugin pipeline --')
  console.log(`  capped (no budget pressure)  ${String(capped).padStart(7)} tok  (${pct(rawTotal - capped, rawTotal)} less than raw)`)
  console.log(`  injected at budget ${String(budget).padEnd(7)} ${String(injected).padStart(7)} tok  (${pct(rawTotal - injected, rawTotal)} less than raw)`)
  console.log(`  AMP budget selection removed ${String(capped - injected).padStart(7)} tok  (${pct(capped - injected, capped)} of the capped set)`)
  console.log('\n-- items actually injected --')
  for (const item of small.context.split('\n')) {
    if (item.trim().length > 0) console.log(`  ${estimateTokens(item)} tok  ${item.slice(0, 80)}`)
  }
  console.log('\n-- cache --')
  console.log(`  hits=${small.beforeReview.cache.hits} misses=${small.beforeReview.cache.misses} hitRate=${(small.beforeReview.cache.hitRate * 100).toFixed(0)}%`)
  console.log(`  savedTokens=${small.beforeReview.cache.savedTokens} entries=${small.beforeReview.cache.entries} failures=${small.beforeReview.cache.failures}`)
  console.log('\n-- prune --')
  console.log(`  reviews=${small.afterReview.prune.reviews} applied=${small.afterReview.prune.applied} verified=${small.afterReview.prune.verified} failed=${small.afterReview.prune.failed}`)
  if (small.outcome !== undefined) {
    console.log(`  kept=${small.outcome.kept} pruned=${small.outcome.pruned} savedTokens=${small.outcome.savedTokens} decisions=${small.outcome.decisionCount}`)
    const reasons = {}
    for (const decision of small.outcome.decisions) {
      if (decision.action === 'prune') reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1
    }
    console.log(`  prune reasons=${JSON.stringify(reasons)}`)
  } else {
    console.log('  no prune review produced')
  }
  console.log(`\n-- exclusions in the last compile (${small.beforeReview.excluded}) --`)
  for (const exclusion of small.diagnostics.lastExclusions) console.log(`  ${exclusion.reason.padEnd(10)} ${exclusion.id}`)
  console.log(`\n  status line: ${small.afterReview.line}`)
  console.log(`  capped-cache miss check: hits=${cappedCacheMiss.hits} savedTokens=${cappedCacheMiss.savedTokens}`)
} finally {
  small.close()
  large.close()
}
