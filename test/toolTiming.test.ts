/**
 * `withToolTiming`: every model-facing result carries `tookMs`.
 *
 * The decorator is registry-level, so the tests exercise it with a fake
 * registry: a value gains the timing, the output schema declares the optional
 * field on every top-level branch, and the original schema constant is not
 * mutated (tools share those constants).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CoordinationToolDefinition } from '../src/host/tools.js'
import { schemaWithTookMs, withToolTiming } from '../src/host/toolTiming.js'

function fakeRegistry(): {
  registry: { register(definition: CoordinationToolDefinition): () => void }
  definitions: CoordinationToolDefinition[]
} {
  const definitions: CoordinationToolDefinition[] = []
  return {
    definitions,
    registry: {
      register(definition) {
        definitions.push(definition)
        return () => { definitions.pop() }
      },
    },
  }
}

function definition(execute: CoordinationToolDefinition['execute'], schema: Record<string, unknown>): CoordinationToolDefinition {
  return {
    name: 'coordination_parse',
    description: 'test',
    parameters: { type: 'object' },
    output: { schema, render: () => [] },
    execute,
  } as unknown as CoordinationToolDefinition
}

test('a tool result gains tookMs and the schema declares it without mutation', async () => {
  const originalSchema = {
    oneOf: [
      { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      { type: 'object', additionalProperties: false, properties: { error: { type: 'object' } } },
    ],
  }
  const snapshot = JSON.stringify(originalSchema)
  const { registry, definitions } = fakeRegistry()
  const timed = withToolTiming(registry)
  timed.register(definition(async () => ({ ok: true }), originalSchema))
  assert.equal(definitions.length, 1)

  const value = await definitions[0]!.execute({}, undefined) as Record<string, unknown>
  assert.equal(value.ok, true)
  assert.equal(typeof value.tookMs, 'number')
  assert.ok((value.tookMs as number) >= 0)

  const schema = definitions[0]!.output!.schema as {
    oneOf: Array<{ properties: Record<string, unknown> }>
  }
  assert.ok('tookMs' in schema.oneOf[0]!.properties)
  assert.ok('tookMs' in schema.oneOf[1]!.properties)
  assert.equal(JSON.stringify(originalSchema), snapshot, 'the shared schema constant is not mutated')
})

test('error envelopes, arrays and primitives behave sensibly', async () => {
  const { registry, definitions } = fakeRegistry()
  const timed = withToolTiming(registry)
  timed.register(definition(async () => ({ error: { code: 'INVALID_ARGUMENT', message: 'no' } }), { type: 'object' }))
  timed.register(definition(async () => [1, 2, 3], { type: 'object' }))
  timed.register(definition(async () => 'text', { type: 'object' }))

  const failed = await definitions[0]!.execute({}, undefined) as Record<string, unknown>
  assert.equal(typeof failed.tookMs, 'number')
  assert.deepEqual(await definitions[1]!.execute({}, undefined), [1, 2, 3])
  assert.equal(await definitions[2]!.execute({}, undefined), 'text')
})

test('schemaWithTookMs leaves non-object roots alone', () => {
  assert.deepEqual(schemaWithTookMs({ type: 'string' }), { type: 'string' })
  assert.equal(schemaWithTookMs(undefined), undefined)
})
