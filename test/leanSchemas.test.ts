/**
 * `leanSchemas`: the wire catalog ships types/enums/required/defaults, not the
 * per-property documentation text.
 *
 * Validation is unaffected because each tool validates against its own schema
 * object; the transform only changes the declaration. The tests pin both the
 * removal (nested included) and the fact that the original object is untouched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CoordinationToolDefinition } from '../src/host/tools.js'
import { leanParameters, schemaDetailFromEnv, withLeanSchemas } from '../src/host/leanSchemas.js'

test('leanParameters drops property descriptions but keeps validation keywords', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['list', 'create'], default: 'list', description: 'Operation to perform.' },
      plan: {
        type: 'object',
        additionalProperties: true,
        description: 'Complete AMP Plan object.',
        properties: {
          id: { type: 'string', pattern: '^[a-z]+$', description: 'Plan id.' },
        },
      },
      items: { type: 'array', items: { type: 'string', description: 'One item.' } },
    },
  }
  const snapshot = JSON.stringify(schema)
  const lean = leanParameters(schema) as typeof schema

  assert.equal(JSON.stringify(schema), snapshot, 'the original schema is not mutated')
  assert.equal(lean.properties.action.description, undefined)
  assert.deepEqual(lean.properties.action.enum, ['list', 'create'])
  assert.equal(lean.properties.action.default, 'list')
  assert.deepEqual(lean.required, ['action'])
  assert.equal(lean.properties.plan.description, undefined)
  assert.equal(lean.properties.plan.properties.id.description, undefined)
  assert.equal(lean.properties.plan.properties.id.pattern, '^[a-z]+$')
  assert.equal(lean.properties.items.items.description, undefined)
})

test('withLeanSchemas transforms registrations, and full detail is a pass-through', () => {
  const definition = {
    name: 'coordination_read',
    description: 'Read a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace path.' } },
    },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: () => ({}),
  } as unknown as CoordinationToolDefinition

  const recorded: CoordinationToolDefinition[] = []
  const registry = { register: (value: CoordinationToolDefinition) => { recorded.push(value); return () => { recorded.pop() } } }

  withLeanSchemas(registry, 'lean').register(definition)
  assert.equal(recorded[0]?.parameters.properties?.path.description, undefined)
  assert.equal(recorded[0]?.description, 'Read a file.')

  withLeanSchemas(registry, 'full').register(definition)
  assert.equal(recorded[1], definition)

  assert.equal(schemaDetailFromEnv({}), 'lean')
  assert.equal(schemaDetailFromEnv({ COORDINATION_SCHEMA_DETAIL: 'full' }), 'full')
})
