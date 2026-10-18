/**
 * TeX statement/condition concept tests.
 *
 * Everything here is explicit-marker driven: derivation environments become
 * `calculation` statements, condition qualifiers become `ConditionForm` values,
 * `\requires`/`\meets` set the relation primitive, and prose never creates a
 * condition. All metadata is body-free.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTex } from '../src/host/text/tex.js'
import type { TexParseResult } from '../src/host/text/tex.js'
import type { NodeMetadata } from '../src/host/text/parser.js'
import type { StructuralConcept } from '../src/shared/entity.js'
import { StatementKindValues, isStatementKind } from '../src/shared/enum.js'

function tex(source: string): TexParseResult {
  return parseTex(source, { path: 'docs/main.tex' })
}

function nodesOfKind(result: TexParseResult, kind: string): NodeMetadata[] {
  return (result.nodes ?? []).filter((node) => node.kind === kind)
}

function domainOf(node: NodeMetadata | undefined): StructuralConcept | undefined {
  if (node?.domain === undefined) return undefined
  return node.domain as StructuralConcept
}

test('calculation/computation/derivation environments emit calculation statements', () => {
  const bodyMarker = 'CALCULATION_BODY_MARKER_7d31'
  const source = [
    String.raw`\begin{calculation}\label{calc:one}${bodyMarker}\end{calculation}`,
    String.raw`\begin{computation}\label{comp:one}${bodyMarker}\end{computation}`,
    String.raw`\begin{derivation}\label{der:one}${bodyMarker}\end{derivation}`,
  ].join('\n')
  const result = tex(source)

  assert.deepEqual(
    result.statements.map((statement) => `${statement.kind}:${statement.environment}`),
    ['calculation:calculation', 'calculation:computation', 'calculation:derivation'],
  )
  assert.deepEqual(
    nodesOfKind(result, 'calculation').map((node) => node.label),
    ['calc:one', 'comp:one', 'der:one'],
  )

  const calculation = nodesOfKind(result, 'calculation')[0]
  const domain = domainOf(calculation)
  assert.equal(domain?.kind, 'calculation')
  assert.equal(domain?.status, 'stated')
  assert.equal(domain?.proofStatus, undefined)
  // Body text is never copied onto a statement node.
  assert.equal(JSON.stringify(result.nodes).includes(bodyMarker), false)
})

test('explicit necessary marker yields a precondition condition', () => {
  const result = tex(String.raw`\necessary{the input is positive}`)
  const condition = nodesOfKind(result, 'condition')[0]
  const domain = domainOf(condition)

  assert.ok(condition, 'a condition node must exist')
  assert.equal(condition?.kind, 'condition')
  assert.equal(condition?.brief, 'the input is positive')
  assert.equal(domain?.kind, 'condition')
  assert.equal(domain?.form, 'precondition')
  assert.equal(domain?.status, 'unknown')
  assert.equal(domain?.explicit, true)
  // The qualifier states a form only; it is not a relation marker.
  assert.equal(domain?.relation, undefined)
  // No explicit work and no enclosing statement: no appliesTo is invented.
  assert.equal(domain?.appliesTo, undefined)
})

test('explicit adequate/sufficient markers yield postcondition conditions', () => {
  for (const marker of ['adequate', 'sufficient'] as const) {
    const result = tex(`\\${marker}{the output is stable}`)
    const conditions = nodesOfKind(result, 'condition')
    assert.equal(conditions.length, 1, `${marker} must emit one condition`)
    const domain = domainOf(conditions[0])
    assert.equal(domain?.form, 'postcondition', `${marker} maps to postcondition`)
    assert.equal(domain?.relation, undefined)
  }
})

test('prose containing necessary/sufficient/adequate creates no condition and no form', () => {
  const result = tex('A necessary condition is positive. Sufficient evidence is adequate.')
  assert.equal(nodesOfKind(result, 'condition').length, 0)
  assert.equal(
    (result.nodes ?? []).some((node) => domainOf(node)?.form !== undefined),
    false,
  )
})

test('existing lemma environment still yields a lemma node', () => {
  const result = tex(String.raw`\begin{lemma}\label{lem:a}A lemma.\end{lemma}`)
  const lemma = nodesOfKind(result, 'lemma')[0]

  assert.ok(lemma, 'a lemma node must exist')
  assert.equal(lemma?.kind, 'lemma')
  assert.equal(lemma?.label, 'lem:a')
  assert.equal(domainOf(lemma)?.kind, 'lemma')
  assert.equal(domainOf(lemma)?.status, 'stated')
})

test('requires/meets markers emit the relation primitive only when present', () => {
  const result = tex(String.raw`\requires{input is positive}\meets{output is stable}`)
  const conditions = nodesOfKind(result, 'condition')
  assert.equal(conditions.length, 2)

  const requires = conditions.find((node) => domainOf(node)?.relation === 'requires')
  const meets = conditions.find((node) => domainOf(node)?.relation === 'meets')
  assert.equal(domainOf(requires)?.form, 'precondition')
  assert.equal(requires?.brief, 'input is positive')
  assert.equal(domainOf(meets)?.form, 'postcondition')
  assert.equal(meets?.brief, 'output is stable')

  // No marker means no edge and no condition node.
  const plain = tex(String.raw`\begin{lemma}\label{lem:r}No explicit marker here.\end{lemma}`)
  assert.equal(nodesOfKind(plain, 'condition').length, 0)
})

test('condition environments accept explicit qualifiers and apply to the enclosing statement', () => {
  const source = [
    String.raw`\begin{theorem}\label{thm:a}`,
    String.raw`\begin{condition}[necessary condition]the input is positive\end{condition}`,
    String.raw`\end{theorem}`,
  ].join('\n')
  const result = tex(source)
  const condition = nodesOfKind(result, 'condition')[0]
  const theorem = nodesOfKind(result, 'theorem')[0]

  assert.equal(nodesOfKind(result, 'condition').length, 1)
  assert.equal(domainOf(condition)?.form, 'precondition')
  assert.equal(domainOf(condition)?.relation, undefined)
  assert.equal(domainOf(condition)?.appliesTo, domainOf(theorem)?.locator)
})

test('a condition outside any statement applies to the explicit work', () => {
  const result = tex(['\\documentclass{article}', String.raw`\requires{input is positive}`].join('\n'))
  const condition = nodesOfKind(result, 'condition')[0]
  const article = nodesOfKind(result, 'article')[0]

  assert.equal(domainOf(condition)?.relation, 'requires')
  assert.equal(domainOf(condition)?.appliesTo, domainOf(article)?.locator)
})

test('commented-out condition markers produce no condition node', () => {
  const mixed = tex([
    String.raw`% \necessary{commented out}`,
    String.raw`\necessary{explicit only}`,
  ].join('\n'))
  const conditions = nodesOfKind(mixed, 'condition')
  assert.equal(conditions.length, 1)
  assert.equal(conditions[0]?.brief, 'explicit only')

  const commentedOnly = tex([
    String.raw`% \requires{hidden}`,
    String.raw`% \meets{hidden}`,
    '% \\begin{condition}[necessary]hidden\\end{condition}',
  ].join('\n'))
  assert.equal(nodesOfKind(commentedOnly, 'condition').length, 0)
})

test('calculation is a statement kind and isStatementKind agrees', () => {
  assert.ok(StatementKindValues.includes('calculation'))
  assert.equal(isStatementKind('calculation'), true)
  assert.equal(isStatementKind('condition'), false)
})
