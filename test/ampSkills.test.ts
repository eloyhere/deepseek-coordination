/** Bundled provider contracts, plugin lifetime, precedence and instruction examples. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Goal, Plan } from 'attention-manifest-protocol/goal/plan.js'
import { validateGoal, validatePlan } from '../src/protocol/index.js'
import { validatePlanInput } from 'attention-manifest-protocol/goal/plan.js'
import {
  AMP_PLANNING_SKILLS, registerAmpPlanningSkills,
  type AmpSkillDefinition, type AmpSkillProvider,
} from '../src/host/ampSkills.js'

const skillRoot = resolve('skills')
function fixture(root = skillRoot) {
  let provider!: AmpSkillProvider
  let invalidations = 0
  let disposals = 0
  const lifecycle = new AbortController()
  const expectedDisposer = (): void => { disposals += 1; lifecycle.abort(new Error('provider disposed')) }
  const dispose = registerAmpPlanningSkills({
    registerProvider(create) {
      provider = create({ signal: lifecycle.signal, invalidate() { invalidations += 1 } })
      return expectedDisposer
    },
  }, root)
  return { provider, lifecycle, dispose, expectedDisposer, get invalidations() { return invalidations }, get disposals() { return disposals } }
}
async function definitions(provider: AmpSkillProvider): Promise<AmpSkillDefinition[]> {
  const result: AmpSkillDefinition[] = []
  for (const candidate of await provider.list({})) {
    const definition = await provider.get(candidate, {})
    assert.ok(definition)
    result.push(definition)
  }
  return result
}

test('one bundled provider publishes immutable rank-600 candidates and loads their packaged bodies', async () => {
  const f = fixture()
  try {
    assert.equal(f.provider.name, 'deepseek-coordination')
    const candidates = await f.provider.list({})
    assert.equal(candidates.length, 8)
    assert.deepEqual(candidates.map(skill => skill.name), AMP_PLANNING_SKILLS.map(skill => skill.name))
    assert.ok(Object.isFrozen(candidates))
    for (const candidate of candidates) {
      assert.equal(candidate.rank, BUNDLED_SKILL_RANK)
      assert.equal(candidate.source, 'bundled')
      assert.equal(candidate.provider, 'deepseek-coordination')
      assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
      assert.equal(candidate.path, resolve('skills', candidate.name, 'SKILL.md'))
      assert.deepEqual(candidate.resourceBase, { kind: 'directory', path: resolve('skills', candidate.name) })
      assert.ok(Object.isFrozen(candidate))
      const skill = await f.provider.get(candidate, {})
      assert.ok(skill)
      assert.ok(skill.content.length > 500)
      assert.ok(!skill.content.startsWith('---'), 'frontmatter stays outside injected instructions')
      assert.equal('rank' in skill, false)
      assert.equal('locator' in skill, false)
      assert.match(skill.content, /中文要点/)
    }
    assert.equal(await f.provider.get({ locator: { path: candidates[0]!.path } }, {}), undefined, 'foreign locators cannot select arbitrary files')
    assert.equal(f.invalidations, 0, 'immutable catalog needs no provider invalidation')
    assert.equal(f.dispose, f.expectedDisposer, 'return exact Cordis disposer')
  } finally { f.dispose() }
})

test('enabled control-registry skills are projected as runtime candidates and invalidate on write', async () => {
  let provider!: AmpSkillProvider
  let invalidate!: () => void
  let invalidations = 0
  const lifecycle = new AbortController()
  const dynamic = [
    { name: 'custom-skill', description: 'Custom instructions', content: 'Do the custom thing', userInvocable: false },
    // Invalid kebab-case, empty body and a bundled name are all filtered out.
    { name: 'bad_name', description: 'bad', content: 'x' },
    { name: 'empty-skill', description: 'empty', content: '' },
    { name: 'amp-plans', description: 'shadowed by bundled', content: 'x' },
  ]
  const dispose = registerAmpPlanningSkills({
    registerProvider(create) {
      provider = create({ signal: lifecycle.signal, invalidate() { invalidations += 1 } })
      return () => { lifecycle.abort(new Error('provider disposed')) }
    },
  }, skillRoot, () => dynamic, (control) => { invalidate = control.invalidate })
  try {
    const candidates = await provider.list({ cwd: 'R:\\ws' })
    assert.deepEqual(
      candidates.map(skill => skill.name),
      [...AMP_PLANNING_SKILLS.map(skill => skill.name), 'custom-skill'],
    )
    const custom = candidates.find(skill => skill.name === 'custom-skill')
    assert.ok(custom)
    assert.equal(custom.rank, 500)
    assert.equal(custom.source, 'control registry')
    assert.deepEqual(custom.invocation, { modelInvocable: true, userInvocable: false })
    const definition = await provider.get(custom, {})
    assert.equal(definition?.content, 'Do the custom thing')
    assert.equal(definition?.source, 'control registry')
    assert.equal(definition?.invocation.userInvocable, false)
    // A locator is data from one lookup; malformed dynamic locators stay invisible.
    assert.equal(await provider.get({
      locator: { kind: 'control-skill', name: 'bad_name', description: 'bad', content: 'x' },
    }, {}), undefined)
    invalidate()
    assert.equal(invalidations, 1)
  } finally {
    dispose()
    await assert.rejects(provider.list({}), /provider disposed/)
  }
})

test('reactive Cordis inject waits for a late skill service, then follows its replacement lifecycle', async () => {  const context = new Context()
  const plugin = context.plugin(child => {
    child.inject(['skills'], skillContext => {
      skillContext.effect(() => registerAmpPlanningSkills(skillContext.get('skills'), skillRoot))
    })
  })
  let firstRegistry: ReturnType<Context['plugin']> | undefined
  let secondRegistry: ReturnType<Context['plugin']> | undefined
  try {
    await plugin
    assert.equal(context.get('skills'), undefined, 'the outer plugin remains healthy while the optional service is absent')
    firstRegistry = context.plugin(SkillRegistry, {})
    await firstRegistry
    const first = context.get('skills')
    assert.ok(first)
    assert.deepEqual((await first.list()).map(skill => skill.name), AMP_PLANNING_SKILLS.map(skill => skill.name).sort())
    await firstRegistry.dispose()
    assert.equal(context.get('skills'), undefined, 'service teardown removes its dependent injection fiber')
    secondRegistry = context.plugin(SkillRegistry, {})
    await secondRegistry
    const second = context.get('skills')
    assert.ok(second)
    assert.deepEqual((await second.list()).map(skill => skill.name), AMP_PLANNING_SKILLS.map(skill => skill.name).sort())
    assert.equal((await second.get('amp-collaboration'))?.provider, 'deepseek-coordination')
    await plugin.dispose()
    assert.deepEqual(await second.list(), [])
  } finally {
    await plugin.dispose()
    await firstRegistry?.dispose()
    await secondRegistry?.dispose()
  }
})

test('real DSH registry exposes all skills, permits user priority overrides and removes the plugin contribution', async () => {
  const context = new Context()
  const registryFiber = context.plugin(SkillRegistry, {})
  await registryFiber
  const plugin = context.plugin(child => {
    child.effect(() => registerAmpPlanningSkills(child.get('skills'), skillRoot))
  })
  let override: ReturnType<Context['plugin']> | undefined
  try {
    await plugin
    const registry = context.get('skills')
    assert.ok(registry)
    assert.deepEqual((await registry.list()).map(skill => skill.name), AMP_PLANNING_SKILLS.map(skill => skill.name).sort())
    assert.equal((await registry.get('amp-plans'))?.provider, 'deepseek-coordination')
    override = context.plugin(child => {
      const skills = child.get('skills')
      assert.ok(skills)
      skills.registerProvider(() => ({
        name: 'user-skills-test',
        async list() { return [{ name: 'amp-plans', description: 'User override', provider: 'user-skills-test', source: 'user-dsh', invocation: { modelInvocable: true, userInvocable: true }, rank: 400, locator: 'override' }] },
        async get() { return { name: 'amp-plans', description: 'User override', provider: 'user-skills-test', source: 'user-dsh', invocation: { modelInvocable: true, userInvocable: true }, content: 'User instructions' } },
      }))
    })
    await override
    assert.equal((await registry.get('amp-plans'))?.content, 'User instructions')
    await override.dispose()
    assert.equal((await registry.get('amp-plans'))?.provider, 'deepseek-coordination')
    await plugin.dispose()
    assert.deepEqual(await registry.list(), [])
  } finally {
    await override?.dispose()
    await plugin.dispose()
    await registryFiber.dispose()
  }
})

test('provider respects caller cancellation and registration lifetime for list and get', async () => {
  const f = fixture()
  const candidate = (await f.provider.list({}))[0]!
  const caller = new AbortController()
  caller.abort(new Error('caller cancelled'))
  await assert.rejects(f.provider.list({ signal: caller.signal }), /caller cancelled/)
  await assert.rejects(f.provider.get(candidate, { signal: caller.signal }), /caller cancelled/)
  f.dispose()
  await assert.rejects(f.provider.list({}), /provider disposed/)
  await assert.rejects(f.provider.get(candidate, {}), /provider disposed/)
  assert.equal(f.disposals, 1)
})

test('missing service does not open files, and missing package bodies fail only on demand', async () => {
  assert.doesNotThrow(registerAmpPlanningSkills(undefined, resolve('does-not-exist')))
  const f = fixture(resolve('does-not-exist'))
  try {
    const candidates = await f.provider.list({})
    assert.equal(candidates.length, 8)
    await assert.rejects(f.provider.get(candidates[0]!, {}), /ENOENT/)
  } finally { f.dispose() }
})

test('body loads read current content without changing the catalog or accepting empty instructions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coordination-skills-'))
  const f = fixture(directory)
  try {
    const candidate = (await f.provider.list({}))[0]!
    mkdirSync(join(directory, candidate.name))
    writeFileSync(candidate.path, '\uFEFF---\r\nname: amp-planning\r\n---\r\nFirst body')
    assert.equal((await f.provider.get(candidate, {}))?.content, 'First body')
    writeFileSync(candidate.path, 'Updated body')
    assert.equal((await f.provider.get(candidate, {}))?.content, 'Updated body')
    writeFileSync(candidate.path, '---\nname: amp-planning\n---\n  ')
    await assert.rejects(f.provider.get(candidate, {}), /no instruction body/)
    assert.equal(f.invalidations, 0)
  } finally { f.dispose(); rmSync(directory, { recursive: true, force: true }) }
})

test('registration failures are propagated without manufacturing a disposer', () => {
  assert.throws(() => registerAmpPlanningSkills({ registerProvider() { throw new Error('duplicate provider') } }, skillRoot), /duplicate provider/)
})

test('documented planning creation examples validate against actual AMP artifact rules', async () => {
  const f = fixture()
  try {
    let goalExamples = 0
    let planExamples = 0
    for (const skill of await definitions(f.provider)) {
      for (const [, text] of skill.content.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)) {
        const example = JSON.parse(text!) as { action: string; goal?: Goal; plan?: Plan }
        if (example.goal !== undefined) { goalExamples += 1; assert.deepEqual(validateGoal(example.goal), [], skill.name) }
        if (example.plan !== undefined) {
          planExamples += 1
          assert.deepEqual(validatePlan(example.plan as unknown as Parameters<typeof validatePlan>[0]), [], skill.name)
          assert.deepEqual(validatePlanInput({ tasks: example.plan.tasks, edges: example.plan.edges, abandonIf: example.plan.abandon_if }), [], skill.name)
        }
      }
    }
    assert.equal(goalExamples, 2)
    assert.equal(planExamples, 1)
  } finally { f.dispose() }
})

test('bundled metadata matches names and collaboration instructions preserve execution and evidence boundaries', async () => {
  const f = fixture()
  try {
    for (const skill of await definitions(f.provider)) {
      assert.match(readFileSync(skill.path, 'utf8'), new RegExp(`^---\\r?\\nname: ${skill.name}\\r?\\n`))
      if (['amp-collaboration', 'amp-duties', 'amp-delegation', 'amp-handoffs'].includes(skill.name)) {
        assert.match(skill.content, /coordination_collaboration/)
        assert.match(skill.content, /subagent|send_message/)
        assert.match(skill.content, /不会自动执行/)
      }
    }
  } finally { f.dispose() }
})

test('bundled descriptions follow the host language instead of carrying both', async () => {
  let locale: 'en-US' | 'zh-CN' = 'en-US'
  let provider!: AmpSkillProvider
  const dispose = registerAmpPlanningSkills({
    registerProvider(create) {
      provider = create({ signal: new AbortController().signal, invalidate() {} })
      return () => {}
    },
  }, skillRoot, undefined, undefined, () => locale)
  try {
    const english = await provider.list({})
    assert.equal(english.length, AMP_PLANNING_SKILLS.length)
    for (const candidate of english) {
      assert.doesNotMatch(candidate.description, /\p{Script=Han}/u, `${candidate.name} must not ship Chinese in English`)
    }
    const goalsEn = english.find((candidate) => candidate.name === 'amp-goals')
    assert.ok(goalsEn)
    assert.match(goalsEn!.description, /observable AMP goals/)

    locale = 'zh-CN'
    const chinese = await provider.list({})
    const goalsZh = chinese.find((candidate) => candidate.name === 'amp-goals')
    assert.ok(goalsZh)
    assert.match(goalsZh!.description, /\p{Script=Han}/u)
    assert.doesNotMatch(goalsZh!.description, /Create observable/, 'the Chinese copy must not embed the English sentence')

    // `get` reports the same localized sentence as the listing did.
    const definition = await provider.get(goalsZh!, {})
    assert.equal(definition?.description, goalsZh!.description)
  } finally {
    dispose()
  }
})
