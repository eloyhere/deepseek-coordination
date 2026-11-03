/**
 * `coordination_chain`'s empty-relation diagnostic.
 *
 * A fully indexed workspace can still answer a relation with zero links — an
 * index built before relation persistence, or a relation the parser never
 * produces. The tool used to return a silently empty projection; this helper
 * names the count and the next action, and never fires for a truncated result.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chainDiagnosticOf } from '../src/host/tools.js'

test('an indexed workspace with no relation edges explains itself', () => {
  const diagnostic = chainDiagnosticOf({
    relation: 'depends',
    counts: { nodes: 37_043, links: 0, omitted: 0 },
  })
  assert.equal(diagnostic?.code, 'no_links')
  assert.match(diagnostic?.hint ?? '', /37,043 nodes/)
  assert.match(diagnostic?.hint ?? '', /coordination_index rebuild/)
})

test('a result with links, a truncated result and an empty graph stay silent', () => {
  assert.equal(chainDiagnosticOf({ relation: 'depends', counts: { nodes: 10, links: 2 } }), undefined)
  assert.equal(chainDiagnosticOf({ relation: 'depends', counts: { nodes: 10, links: 0, omitted: 3 } }), undefined)
  assert.equal(chainDiagnosticOf({ counts: { nodes: 0, links: 0 } }), undefined)
  assert.equal(chainDiagnosticOf({}), undefined)
})
