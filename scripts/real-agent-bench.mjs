/**
 * Real DeepSeek API benchmark for the AMP attention block.
 *
 * It measures what the synthetic benchmark cannot: the provider's own token
 * accounting and its automatic prefix cache.
 *
 * Scenarios (all `temperature: 0`, tiny `max_tokens`, so the cost is prompt-only):
 *
 *   A  baseline          — stable system prompt + long user message, twice.
 *   B  block changes      — the real `<amp_attention>` block at the end of the
 *                           system prompt, step 11 then step 12 (ids change, as
 *                           they do on every real step), twice.
 *   C  block stable      — the same block twice (control: cache ceiling).
 *   D  block only        — measures the block's real token count for estimator
 *                           calibration.
 *
 * The key is read from `DEEPSEEK_API_KEY`; it is never written anywhere.
 *
 * Usage: DEEPSEEK_API_KEY=... node scripts/real-agent-bench.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.mjs'
import { estimateTokens } from '../src/host/tokenEstimate.ts'

const KEY = process.env.DEEPSEEK_API_KEY
if (typeof KEY !== 'string' || KEY.length === 0) {
  console.error('DEEPSEEK_API_KEY is required')
  process.exit(2)
}
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
const API = 'https://api.deepseek.com/chat/completions'
const SESSION = 'real-bench'
const TURN = 1

/** Stable, realistic harness rules; deliberately long so cache effects are visible. */
const BASE_SYSTEM = (
  '你是 DeepSeek Harness 的编码代理。规则：先读大纲再读正文；改动前说明意图；' +
  '每条结论必须给出文件与行号；不确定时明确说不知道；不要编造测试结果；' +
  '回答使用中文；代码块标注语言；优先小步修改并保持测试全绿。'
).repeat(10)

const PROMPT = (
  '请你审计现有项目的上下文压缩、剪枝、缓存优化等功能，搜索资料，探索更好的算法。' +
  '要求：给出证据、指出问题、按严重程度排序，并说明每一处改动对 token 预算的影响。'
).repeat(8)

const GOAL = '把 attention-manifest-protocol 的上下文能力完整接入插件并通过回归，确认预算、缓存与剪枝指标可观测。'.repeat(4)

const TODOS = Array.from({ length: 20 }, (_, index) => ({
  content: `第 ${index + 1} 项：核对通道 ${index + 1} 的预算、排除原因与寄存器计数，确认没有静默丢失。`,
  status: index < 6 ? 'completed' : index < 8 ? 'in_progress' : 'pending',
}))

const TOOL_OUTPUTS = [
  'error TS2322: Type string is not assignable to type number.\n' + '  at src/host/context.ts:470:18\n'.repeat(40),
  JSON.stringify({ files: Array.from({ length: 40 }, (_, index) => ({ path: `src/host/file-${index}.ts`, lines: index * 13 })) }, null, 2),
]

/** Boot one plugin instance and produce real `<amp_attention>` blocks. */
async function ampBlocks(steps) {
  const directory = mkdtempSync(join(tmpdir(), 'amp-real-'))
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
    get: (name) => (name === 'goals' ? { get: () => ({ objective: GOAL }) } : undefined),
    provide: (_name, value) => {
      host = value
      return () => {}
    },
    inject: () => () => {},
  }
  try {
    await apply(ctx, {
      tenantId: 'real', rootId: 'root', storePath: join(directory, 'amp.sqlite'),
      notifications: false, prompt: false, skills: false, commands: false, routes: false,
      maxJournal: 100, maxReadChars: 100_000, maxWriteChars: 100_000,
      contextOptimization: true, contextBudgetTokens: 1200,
    })
    const emit = (name, ...args) => {
      for (const handler of handlers.get(name) ?? []) handler(...args)
    }
    const agent = { id: SESSION, status: 'running', session: { header: { cwd: directory } } }
    emit('agent/created', { agent })
    emit('session/event', { id: SESSION }, { type: 'user/message', data: { content: [{ type: 'text', text: PROMPT }] } })
    emit('session/event', { id: SESSION }, { type: 'turn/start', data: { turn: TURN } })
    emit('goal/changed', { agent, change: { goal: { id: 'g1', objective: GOAL, phase: 'active', revision: 1 } } })
    emit('session/event', { id: SESSION }, { type: 'todo/write', data: { turn: TURN, todos: TODOS } })
    TOOL_OUTPUTS.forEach((output, index) => {
      emit('session/event', { id: SESSION }, { type: 'tool/call', data: { turn: TURN, step: 1, callId: `call-${index}`, name: 'read', arguments: '{}' } })
      emit('session/event', { id: SESSION }, { type: 'tool/result', data: { turn: TURN, step: 1, message: { toolCallId: `call-${index}`, isError: false, content: [{ type: 'text', text: output }] } } })
    })
    const optimizer = host.contextOptimizer
    const prestep = handlers.get('agent/pre-step')?.[0]
    const messages = [{ role: 'user', source: 'user', content: [{ type: 'text', text: PROMPT }] }]
    const blocks = {}
    for (const step of steps) {
      await prestep({ agent, messages, turn: TURN, step }, async () => ({ kind: 'enter', messages }))
      const compiled = optimizer.contextFor(agent)
      blocks[step] = [
        '<amp_attention budget="1200 tokens">',
        compiled,
        '</amp_attention>',
        'Items excluded by the AMP attention budget remain in the AMP ledger as exclusions; do not assume they were read.',
      ].join('\n')
    }
    return { blocks, status: optimizer.status(), close: () => host.close() }
  } catch (error) {
    host?.close()
    throw error
  }
}

async function chat(system, user, maxTokens = 8) {
  const started = performance.now()
  const response = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        ...(system.length === 0 ? [] : [{ role: 'system', content: system }]),
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0,
      stream: false,
    }),
  })
  const body = await response.json()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`)
  }
  const usage = body.usage ?? {}
  return {
    prompt: usage.prompt_tokens ?? 0,
    hit: usage.prompt_cache_hit_tokens ?? 0,
    miss: usage.prompt_cache_miss_tokens ?? 0,
    completion: usage.completion_tokens ?? 0,
    ms: Math.round(performance.now() - started),
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const line = (label, result) =>
  `${label.padEnd(26)} prompt=${String(result.prompt).padStart(5)}  hit=${String(result.hit).padStart(5)}  miss=${String(result.miss).padStart(5)}  out=${result.completion}  ${result.ms}ms`

const plugin = await ampBlocks([11, 12])
try {
  const block11 = plugin.blocks[11]
  const block12 = plugin.blocks[12]

  console.log(`model=${MODEL}  block chars=${block11.length}  estimated=${estimateTokens(block11)} tok`)
  console.log(`plugin status: ${plugin.status.line}\n`)

  // D: empty system baseline, isolates per-request overhead.
  const overhead = await chat('', 'hi')
  // A: stable prompt, same request twice.
  const a1 = await chat(BASE_SYSTEM, PROMPT)
  await sleep(1500)
  const a2 = await chat(BASE_SYSTEM, PROMPT)
  // B: block changes every step, as in a real turn.
  const b1 = await chat(`${BASE_SYSTEM}\n\n${block11}`, PROMPT)
  await sleep(1500)
  const b2 = await chat(`${BASE_SYSTEM}\n\n${block12}`, PROMPT)
  // C: control — identical block, identical request.
  const c1 = await chat(`${BASE_SYSTEM}\n\n${block11}`, PROMPT)
  await sleep(1500)
  const c2 = await chat(`${BASE_SYSTEM}\n\n${block11}`, PROMPT)
  // E: block only, to calibrate the estimator.
  const e1 = await chat(block11, 'hi')

  console.log('-- calls --')
  console.log(line('A1 no-block', a1))
  console.log(line('A2 no-block repeat', a2))
  console.log(line('B1 block step11', b1))
  console.log(line('B2 block step12', b2))
  console.log(line('C1 block q once', c1))
  console.log(line('C2 block q again', c2))
  console.log(line('D empty', overhead))
  console.log(line('E block only', e1))

  const blockTokens = e1.prompt - overhead.prompt
  const estimate = estimateTokens(block11)
  console.log('\n-- analysis --')
  console.log(`AMP block cost (provider):      ${blockTokens} tok`)
  console.log(`AMP block estimate (estimator): ${estimate} tok  (error ${(((estimate - blockTokens) / blockTokens) * 100).toFixed(1)}%)`)
  console.log(`A: repeat request cached        ${a2.hit} / ${a2.prompt} tok  (${((a2.hit / Math.max(1, a2.prompt)) * 100).toFixed(1)}%)`)
  console.log(`B: block changed  cached        ${b2.hit} / ${b2.prompt} tok  (${((b2.hit / Math.max(1, b2.prompt)) * 100).toFixed(1)}%)`)
  console.log(`C: block stable   cached        ${c2.hit} / ${c2.prompt} tok  (${((c2.hit / Math.max(1, c2.prompt)) * 100).toFixed(1)}%)`)
  console.log(`prefix lost when block changes  ${Math.max(0, a2.hit - b2.hit)} tok`)
  console.log(`latency A2/B2/C2                ${a2.ms}ms / ${b2.ms}ms / ${c2.ms}ms`)
} finally {
  plugin.close()
}
