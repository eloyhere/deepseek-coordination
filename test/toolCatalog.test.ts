/**
 * `ToolCatalog`: the static context budget of the model-facing catalog.
 *
 * The audit measured ~22.6k characters of tool definitions per request; this
 * module makes that number queryable. Tests pin the parts the route depends on:
 * per-tool characters, a deterministic hash that changes with content, skill
 * sizing per locale, and disposal when a definition is unregistered.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CoordinationToolDefinition } from '../src/host/tools.js'
import { ToolCatalog, withToolCatalog } from '../src/host/toolCatalog.js'

function definition(name: string, description: string, parameters: Record<string, unknown> = { type: 'object' }): CoordinationToolDefinition {
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'object' }, render: () => [] },
    execute: () => ({ ok: true }),
  } as unknown as CoordinationToolDefinition
}

test('metrics count the catalog and sort the heaviest tool first', () => {
  const catalog = new ToolCatalog()
  catalog.add(definition('coordination_a', 'short'))
  catalog.add(definition('coordination_b', 'a much longer description for a heavier tool', { type: 'object', properties: { x: { type: 'string' } } }))
  const metrics = catalog.metrics('en-US')
  assert.equal(metrics.tools.count, 2)
  assert.equal(metrics.tools.entries[0]?.name, 'coordination_b')
  assert.ok((metrics.tools.entries[0]?.chars ?? 0) > (metrics.tools.entries[1]?.chars ?? 0))
  assert.equal(metrics.tools.chars, (metrics.tools.entries[0]?.chars ?? 0) + (metrics.tools.entries[1]?.chars ?? 0))
  assert.equal(metrics.tools.tokens, Math.ceil(metrics.tools.chars / 4))
  assert.equal(metrics.ampContext.maxChars, 4_000)
})

test('the catalog hash is deterministic and changes with the content', () => {
  const first = new ToolCatalog()
  first.add(definition('coordination_a', 'one'))
  const before = first.metrics().tools.hash

  const second = new ToolCatalog()
  second.add(definition('coordination_a', 'one'))
  assert.equal(second.metrics().tools.hash, before)

  const edited = new ToolCatalog()
  edited.add(definition('coordination_a', 'one changed'))
  assert.notEqual(edited.metrics().tools.hash, before)
  assert.equal(second.metrics().sections.tools, before, 'the section hash mirrors the catalog hash')
})

test('skills are sized for the active language and disposal removes a tool', () => {
  const catalog = new ToolCatalog()
  const dispose = catalog.add(definition('coordination_a', 'one'))
  const en = catalog.metrics('en-US')
  const zh = catalog.metrics('zh-CN')
  assert.equal(en.skills.count, 8)
  assert.ok(en.skills.chars > 0)
  assert.notEqual(en.skills.chars, zh.skills.chars, 'descriptions are localized, so the size differs')
  assert.equal(en.sections.skills, catalog.metrics('en-US').sections.skills, 'the skills hash is deterministic')
  assert.notEqual(en.sections.skills, zh.sections.skills, 'a locale switch changes the skills section hash')
  dispose()
  assert.equal(catalog.size, 0)
  assert.equal(catalog.metrics().tools.count, 0)
})

test('withToolCatalog records registrations and forgets them on dispose', () => {
  const catalog = new ToolCatalog()
  const inner: CoordinationToolDefinition[] = []
  const registry = {
    register: (value: CoordinationToolDefinition) => {
      inner.push(value)
      return () => { inner.pop() }
    },
  }
  const wrapped = withToolCatalog(registry, catalog)
  const dispose = wrapped.register(definition('coordination_a', 'one'))
  assert.equal(inner.length, 1)
  assert.equal(catalog.size, 1)
  dispose()
  assert.equal(inner.length, 0)
  assert.equal(catalog.size, 0)
})
