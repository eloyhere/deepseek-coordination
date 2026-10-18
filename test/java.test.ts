import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { performance } from 'node:perf_hooks'
import { javaParser, parseJava } from '../src/host/text/java.js'
import type { JavaParseResult } from '../src/host/text/java.js'
import type { NodeMetadata } from '../src/host/text/parser.js'

const SAMPLE = `package com.example.app;

import java.util.List;
import static java.util.Collections.emptyList;

/** A sample type. */
@SuppressWarnings("unused")
public class Sample {
    private int count = 0;
    static final String NAME = "sample";

    @Deprecated
    public int add(int delta) {
        return count + delta;
    }
}
`

function nodeOf(result: JavaParseResult, kind: string, name: string): NodeMetadata {
  const node = (result.nodes ?? []).find(
    (candidate) => candidate.kind === kind && candidate.name === name,
  )
  assert.ok(node, `expected a ${kind} node named ${name}`)
  return node
}

test('java parser extracts package, imports, type, fields and method', () => {
  const result = parseJava(SAMPLE, { path: 'src/com/example/app/Sample.java' })

  assert.equal(javaParser.id, 'java')
  assert.deepEqual(javaParser.extensions, ['.java'])
  assert.equal(result.parserId, 'java')
  assert.equal(result.packageName, 'com.example.app')
  assert.equal(result.truncated, false)
  assert.deepEqual(result.diagnostics, [])

  // Two literal imports become the same FileReference shape the JavaScript
  // parser emits (kind 'import' + specifier), so the dependency layer can use
  // them unchanged.
  assert.equal(result.references.length, 2)
  assert.deepEqual(
    result.references.map((reference) => [reference.kind, reference.specifier]),
    [
      ['import', 'java.util.List'],
      ['import', 'java.util.Collections.emptyList'],
    ],
  )
  for (const reference of result.references) {
    assert.equal(reference.kind, 'import')
    assert.equal(reference.external, true)
    const start = SAMPLE.indexOf(reference.specifier)
    assert.equal(reference.span.start, start)
    assert.equal(reference.span.end, start + reference.specifier.length)
    assert.ok(reference.byteStart !== undefined)
    assert.ok(reference.byteEnd !== undefined)
  }
  assert.equal(result.references[1]?.attributes?.static, 'true')

  const packageNode = nodeOf(result, 'module', 'com.example.app')
  const classNode = nodeOf(result, 'class', 'Sample')
  const field = nodeOf(result, 'variable', 'count')
  const constant = nodeOf(result, 'variable', 'NAME')
  const method = nodeOf(result, 'method', 'add')

  assert.equal(field.label, undefined)
  assert.equal(constant.label, 'constant')
  assert.equal(method.label, undefined)

  // The annotations are ignored as nodes but must not break declaration
  // scanning; they are part of the declaration signature spans.
  const packageStart = SAMPLE.indexOf('package')
  assert.equal(packageNode.span.start, packageStart)
  assert.equal(packageNode.span.end, SAMPLE.indexOf(';', packageStart) + 1)

  const classStart = SAMPLE.indexOf('@SuppressWarnings')
  const classBody = SAMPLE.indexOf('{', SAMPLE.indexOf('class Sample'))
  assert.equal(classNode.span.start, classStart)
  assert.equal(classNode.span.end, classBody)

  const fieldStart = SAMPLE.indexOf('private int count')
  assert.equal(field.span.start, fieldStart)
  assert.equal(field.span.end, SAMPLE.indexOf(';', fieldStart) + 1)

  const constantStart = SAMPLE.indexOf('static final String NAME')
  assert.equal(constant.span.start, constantStart)
  assert.equal(constant.span.end, SAMPLE.indexOf(';', constantStart) + 1)

  const methodStart = SAMPLE.indexOf('@Deprecated')
  const methodBody = SAMPLE.indexOf('{', SAMPLE.indexOf('public int add'))
  assert.equal(method.span.start, methodStart)
  assert.equal(method.span.end, methodBody)

  // Deterministic source order, no comment nodes, and a parsed AST.
  assert.deepEqual(
    (result.nodes ?? []).map((node) => node.kind),
    ['module', 'importation', 'importation', 'class', 'variable', 'variable', 'method'],
  )
  const starts = (result.nodes ?? []).map((node) => node.span.start)
  assert.deepEqual(starts, [...starts].sort((left, right) => left - right))
  assert.equal((result.nodes ?? []).some((node) => node.kind === 'comment'), false)
  assert.ok(result.ast)
})

test('java type declarations use precise node kinds', () => {
  const source = `package kinds;

interface Runner { void run(); }
enum Mode { FAST, SLOW }
record Point(int x, int y) { }
class Box { }
@interface Marker { String value(); }
`
  const result = parseJava(source, { path: 'kinds/Kinds.java' })

  // `interface` and `enum` no longer fold into `class`; `record` and
  // `@interface` keep the closest kind and record the form in `label`.
  const expected = [
    { name: 'Runner', kind: 'interface', label: undefined },
    { name: 'Mode', kind: 'enumeration', label: undefined },
    { name: 'Point', kind: 'class', label: 'record' },
    { name: 'Box', kind: 'class', label: undefined },
    { name: 'Marker', kind: 'interface', label: 'annotation' },
  ] as const
  for (const entry of expected) {
    const mapped = nodeOf(result, entry.kind, entry.name)
    assert.equal(mapped.kind, entry.kind, `${entry.name} must use the ${entry.kind} kind`)
    assert.equal(mapped.label, entry.label, `${entry.name} must carry label ${entry.label}`)
  }
  // Only a plain `class` or a `record` is a `class` node.
  assert.deepEqual(
    (result.nodes ?? []).filter((node) => node.kind === 'class').map((node) => node.name),
    ['Point', 'Box'],
  )
  assert.deepEqual(
    (result.nodes ?? []).filter((node) => node.kind === 'enumeration').map((node) => node.name),
    ['Mode'],
  )
  assert.equal(nodeOf(result, 'method', 'run').kind, 'method')
  assert.equal(nodeOf(result, 'method', 'value').kind, 'method')
  assert.deepEqual(result.diagnostics, [])
})

test('java labels only explicit static final fields as constants', () => {
  const source = `class Labels {
    int plain;
    static int staticOnly;
    final int finalOnly;
    static final int CONSTANT = 1;
    final static String ALSO_CONSTANT = "x";
}
`
  const result = parseJava(source, { path: 'labels/Labels.java' })

  const plain = nodeOf(result, 'variable', 'plain')
  const staticOnly = nodeOf(result, 'variable', 'staticOnly')
  const finalOnly = nodeOf(result, 'variable', 'finalOnly')
  const constant = nodeOf(result, 'variable', 'CONSTANT')
  const alsoConstant = nodeOf(result, 'variable', 'ALSO_CONSTANT')

  assert.equal(plain.kind, 'variable')
  assert.equal(staticOnly.label, undefined)
  assert.equal(finalOnly.label, undefined)
  assert.equal(constant.label, 'constant')
  assert.equal(alsoConstant.label, 'constant')
  assert.deepEqual(result.diagnostics, [])
})

test('java comment text never produces nodes', () => {
  const source = `// class Ghost { void haunted() {} }
/* class Spectral { int value; } */
package comments;

class Real { }
`
  const result = parseJava(source, { path: 'comments/Real.java' })
  const names = (result.nodes ?? []).map((node) => node.name)

  assert.equal(names.includes('Ghost'), false)
  assert.equal(names.includes('Spectral'), false)
  assert.equal(names.includes('haunted'), false)
  assert.equal(names.includes('value'), false)
  assert.equal(result.references.length, 0)
  assert.equal((result.nodes ?? []).some((node) => node.kind === 'comment'), false)
  assert.deepEqual(
    (result.nodes ?? []).map((node) => [node.kind, node.name]),
    [
      ['module', 'comments'],
      ['class', 'Real'],
    ],
  )
  assert.deepEqual(result.diagnostics, [])
})

test('malformed java input reports diagnostics and never throws', () => {
  const cases = [
    'class Broken { String value = "unterminated; }',
    'class Broken { void run() { if (true) { }',
    '/* unterminated comment',
  ]

  for (const source of cases) {
    const result = parseJava(source)
    assert.equal(result.parserId, 'java')
    assert.ok(result.diagnostics.length > 0, `expected diagnostics for: ${source}`)
  }
})

test('large generated java file parses within a generous bound', () => {
  const classCount = 1_500
  const chunks: string[] = ['package generated;', '']
  for (let index = 0; index < classCount; index += 1) {
    chunks.push(`public class C${index} {`)
    chunks.push(`    private int value${index};`)
    chunks.push(`    public int get${index}() { return value${index}; }`)
    chunks.push('}')
    chunks.push('')
  }
  const source = chunks.join('\n')

  const started = performance.now()
  const result = parseJava(source, { path: 'generated/Generated.java' })
  const elapsed = performance.now() - started

  assert.equal(result.parserId, 'java')
  assert.equal(result.truncated, false)
  assert.ok(result.nodes !== undefined)
  // Each class contributes a class, a field and a method node.
  assert.ok(
    (result.nodes?.length ?? 0) >= classCount * 3,
    `expected at least ${classCount * 3} nodes, got ${result.nodes?.length ?? 0}`,
  )
  assert.ok(elapsed < 1_500, `parse took ${elapsed.toFixed(1)} ms (budget 1500 ms)`)
})
