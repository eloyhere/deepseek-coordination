/**
 * Tool profiles: `core` narrows the catalog to the high-frequency set.
 *
 * The default stays `full`; the test pins the filter, the no-op disposer for
 * skipped tools, and the env parsing so the profile cannot silently register
 * administration tools.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CoordinationToolDefinition } from '../src/host/tools.js'
import { CORE_TOOL_NAMES, profileFromEnv, withToolProfile } from '../src/host/toolProfiles.js'

function definition(name: string): CoordinationToolDefinition {
  return {
    name,
    description: 'test',
    parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: () => ({}),
  } as unknown as CoordinationToolDefinition
}

function registry() {
  const names: string[] = []
  let disposed = 0
  return {
    names,
    disposed: () => disposed,
    register: (value: CoordinationToolDefinition) => {
      names.push(value.name)
      return () => { disposed += 1; names.pop() }
    },
  }
}

test('core registers only the high-frequency set; full is a pass-through', () => {
  const core = registry()
  const wrapped = withToolProfile(core, 'core')
  const disposeRead = wrapped.register(definition('coordination_read'))
  const disposeControl = wrapped.register(definition('coordination_control'))
  assert.deepEqual(core.names, ['coordination_read'])
  disposeControl()
  assert.equal(core.disposed(), 0, 'a skipped tool has a no-op disposer')
  disposeRead()
  assert.equal(core.disposed(), 1)

  const full = registry()
  withToolProfile(full, 'full').register(definition('coordination_control'))
  assert.deepEqual(full.names, ['coordination_control'])
})

test('the core set contains the read/planning surface and not the administration surface', () => {
  for (const name of ['coordination_read', 'coordination_parse', 'coordination_plan', 'coordination_selection']) {
    assert.equal(CORE_TOOL_NAMES.has(name), true, name)
  }
  for (const name of ['coordination_control', 'coordination_environment', 'coordination_notification', 'coordination_approve']) {
    assert.equal(CORE_TOOL_NAMES.has(name), false, name)
  }
  assert.equal(profileFromEnv({}), 'full')
  assert.equal(profileFromEnv({ COORDINATION_TOOL_PROFILE: 'core' }), 'core')
  assert.equal(profileFromEnv({ COORDINATION_TOOL_PROFILE: 'other' }), 'full')
})
