/**
 * P4 prompt-variable tests.
 *
 * `registerAmpPrompt` is imported directly with Node's type stripping. The
 * fake context mirrors only the `systemPrompt` surface this plugin uses, so the
 * test also proves the registration works with the minimal mocks that older
 * tests pass (those mocks have no `variable` method at all).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerAmpPrompt } from '../src/host/prompt.ts'

/** A fake host with just the fields the prompt reads outside callbacks. */
function fakeHost() {
  return {
    config: { tenantId: 't', contextBudgetTokens: 1200 },
    agentModules: [{ module: 'a' }, { module: 'b' }],
    catalog: [],
  }
}

/**
 * Build a fake context that records sections, contexts and variables.
 *
 * `variableMode` is `'record'` for the normal case, `'missing'` to model a
 * composition without `systemPrompt.variable`, and `'throw'` to model a
 * registrar that rejects one name.
 */
function fakeContext(variableMode = 'record') {
  const sections = new Map()
  const contexts = new Map()
  const variables = new Map()
  const systemPrompt = {
    getSectionOrder: () => 0,
    getContextOrder: () => 0,
    section: (definition) => {
      sections.set(definition.name, definition)
      return () => {}
    },
    context: (definition) => {
      contexts.set(definition.name, definition)
      return () => {}
    },
  }
  if (variableMode === 'record') {
    systemPrompt.variable = (name, provider) => {
      variables.set(name, provider)
      return () => {}
    }
  }
  if (variableMode === 'throw') {
    systemPrompt.variable = (name, provider) => {
      if (name === 'amp_tenant') throw new Error('duplicate variable')
      variables.set(name, provider)
      return () => {}
    }
  }
  return { ctx: { systemPrompt }, sections, contexts, variables }
}

test('registers the five AMP prompt variables with stable scalar values', () => {
  const { ctx, variables } = fakeContext()
  registerAmpPrompt(ctx, fakeHost())

  assert.deepEqual([...variables.keys()].sort(), [
    'amp_budget_tokens',
    'amp_contract',
    'amp_module_count',
    'amp_session',
    'amp_tenant',
  ])
  assert.equal(variables.get('amp_tenant')({}), 't')
  assert.equal(variables.get('amp_contract')({}), 'AMP 0.7.9')
  assert.equal(variables.get('amp_budget_tokens')({}), '1200')
  assert.equal(variables.get('amp_module_count')({}), '2')
})

test('amp_session reads the assembly agent id and falls back to unbound', () => {
  const { ctx, variables } = fakeContext()
  registerAmpPrompt(ctx, fakeHost())
  const session = variables.get('amp_session')

  assert.equal(session({ agent: { id: 'session-1' } }), 'session-1')
  assert.equal(session({ agent: { id: 7 } }), 'unbound')
  assert.equal(session({ agent: { id: '' } }), 'unbound')
  assert.equal(session({ agent: undefined }), 'unbound')
  assert.equal(session({}), 'unbound')
  assert.equal(session(undefined), 'unbound')
})

test('variables are registered alongside the untouched section and contexts', () => {
  const { ctx, sections, contexts } = fakeContext()
  registerAmpPrompt(ctx, fakeHost())

  assert.ok(sections.has('deepseek-coordination:amp-contract'))
  for (const name of [
    'deepseek-coordination:bound',
    'deepseek-coordination:takeover',
    'deepseek-coordination:search-takeover',
    'deepseek-coordination:file-write-takeover',
  ]) {
    assert.ok(contexts.has(name), name)
  }
  // Variables are a separate seam: the fixed section must stay deterministic
  // and must not interpolate volatile state into the cached prompt prefix.
  assert.equal(sections.get('deepseek-coordination:amp-contract').text.includes('{{amp_'), false)
})

test('a context without systemPrompt.variable is a silent no-op', () => {
  const { ctx, sections, contexts } = fakeContext('missing')
  assert.doesNotThrow(() => registerAmpPrompt(ctx, fakeHost()))
  assert.ok(sections.has('deepseek-coordination:amp-contract'))
  assert.ok(contexts.has('deepseek-coordination:bound'))
})

test('one rejected variable does not fail activation or skip the rest', () => {
  const { ctx, variables } = fakeContext('throw')
  assert.doesNotThrow(() => registerAmpPrompt(ctx, fakeHost()))
  assert.equal(variables.has('amp_tenant'), false)
  assert.deepEqual([...variables.keys()].sort(), [
    'amp_budget_tokens',
    'amp_contract',
    'amp_module_count',
    'amp_session',
  ])
})
