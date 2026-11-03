/**
 * A broad task is a decomposition input, not a plan condition.
 *
 * Comprehension flags "任务描述过于宽泛（A / B）" when the request uses vague
 * task markers. The plan used to carry that finding as one generic "resolve the
 * open ambiguity" step; these tests pin the replacement: one concrete sub-task
 * per flagged fragment, each with its own acceptance, and no residual step that
 * merely restates the finding.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ambiguityWithoutBroadTask,
  broadTaskMarkers,
  composeOrganization,
} from '../src/host/organization.js'
import { decodePlanStep } from '../src/host/plan.js'
import type { Comprehension } from '../src/shared/entity.js'

const broad = '任务描述过于宽泛（优化一下 / 弄一下），需要可验收的完成标准'

function comprehension(ambiguity: string): Comprehension {
  return {
    identity: 1,
    handle: 'comprehension-broad-task',
    turn: 1,
    prompt: 1,
    intent: 'optimise the indexing path',
    requirement: 'make indexing faster and keep the results stable',
    constraint: 'no new dependency',
    assumption: 'the workspace is already indexed',
    ambiguity,
    confidence: 0.6,
    created: 1,
  } as unknown as Comprehension
}

test('the broad-task finding is split into its own fragments', () => {
  assert.deepEqual(broadTaskMarkers(broad), ['优化一下', '弄一下'])
  assert.equal(ambiguityWithoutBroadTask(broad), '')
  assert.equal(
    ambiguityWithoutBroadTask(`${broad}；输入过短，缺少必要上下文`),
    '输入过短，缺少必要上下文',
  )
  assert.deepEqual(broadTaskMarkers('无明显歧义'), [])
})

test('a broad request becomes verifiable sub-tasks instead of an ambiguity condition', () => {
  const organization = composeOrganization(comprehension(broad), {
    interaction: 'think',
    scene: 'engineering',
    maxSubtask: 8,
    groundTruth: false,
  })
  const parsed = decodePlanStep(organization.step)
  assert.equal(parsed.malformed, false)

  const broadSteps = parsed.steps.filter((step) => step.step.startsWith('Turn the broad request'))
  assert.equal(broadSteps.length, 2)
  assert.equal(broadSteps[0].step, 'Turn the broad request into a verifiable sub-task: 优化一下')
  assert.equal(broadSteps[0].acceptance, '"优化一下" has an observable done condition and its evidence is recorded')
  // The finding itself never survives as a plan condition.
  assert.equal(
    parsed.steps.some((step) => step.step.includes('任务描述过于宽泛')),
    false,
  )
  assert.equal(
    parsed.steps.some((step) => step.step.startsWith('Resolve the open ambiguity')),
    false,
  )
})

test('a non-broad ambiguity keeps the ambiguity step', () => {
  const organization = composeOrganization(comprehension('指代对象不明确（上面那个 / 它），需要确认具体范围'), {
    interaction: 'think',
    scene: 'engineering',
    maxSubtask: 8,
    groundTruth: false,
  })
  const parsed = decodePlanStep(organization.step)
  const ambiguityStep = parsed.steps.find((step) => step.step.startsWith('Resolve the open ambiguity'))
  assert.ok(ambiguityStep !== undefined)
  assert.equal(ambiguityStep.step.includes('指代对象不明确'), true)
})

test('orchestration drafts decompose a broad request too', () => {
  const organization = composeOrganization(comprehension(broad), {
    interaction: 'orchestrate',
    scene: 'engineering',
    maxSubtask: 8,
    groundTruth: false,
  })
  const parsed = decodePlanStep(organization.step)
  const broadDrafts = parsed.drafts.filter((draft) => draft.task.startsWith('Turn the broad request'))
  assert.equal(broadDrafts.length, 2)
  assert.equal(broadDrafts[0].acceptance.includes('优化一下'), true)
  assert.equal(parsed.drafts.some((draft) => draft.task.includes('任务描述过于宽泛')), false)
})
