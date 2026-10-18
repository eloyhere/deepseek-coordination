import { test } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { cFamilyParser, parseCFamily } from '../src/host/text/c-family.js'
import type { CFamilyParseResult } from '../src/host/text/c-family.js'
import { MAX_METADATA_NODES } from '../src/host/text/parser.js'
import type { NodeMetadata } from '../src/host/text/parser.js'

/**
 * C++ fixture: two includes, a namespace with class/struct/enum bodies, an
 * out-of-class constructor and method definition, a free function and two
 * const globals plus one mutable global.
 */
const CPP_SAMPLE = `#include <vector>
#include "project/widget.hpp"

namespace demo {

class Widget {
public:
    Widget();
    void render(int scale) const;
};

struct Config {
    int width;
    int height;
};

enum class Mode { Fast, Slow };

}  // namespace demo

demo::Widget::Widget() : scale_(1) {}

void demo::Widget::render(int scale) const {
    int local = scale + 1;
    (void)local;
}

int add(int left, int right) {
    return left + right;
}

const int MAX_WIDGETS = 42;
constexpr double SCALE = 1.5;
int counter = 0;
`

/** C-only translation unit: no namespace, no class, one struct and functions. */
const C_SAMPLE = `#include <stdio.h>

struct point {
    int x;
    int y;
};

typedef struct point point_t;

static int origin_x = 0;
const char *PROGRAM_NAME = "coords";

int distance(struct point a, struct point b) {
    int dx = a.x - b.x;
    return dx;
}

int main(void) {
    return distance(a, b);
}
`

/** Unterminated string, unterminated comment and an unclosed class body. */
const MALFORMED_SAMPLE = `#include <vector>
class Broken {
    void method() {
        const char *text = "unterminated;
/* trailing comment without an end
`

/** A stray `}` after a complete function must be diagnosed, not thrown. */
const UNBALANCED_SAMPLE = `int ok(void) { return 0; }
}
`

function nodesOf(result: CFamilyParseResult): NodeMetadata[] {
  return result.nodes ?? []
}

function nodeOf(result: CFamilyParseResult, kind: string, name: string): NodeMetadata {
  const node = nodesOf(result).find(
    (candidate) => candidate.kind === kind && candidate.name === name,
  )
  assert.ok(node, `expected a ${kind} node named ${name}`)
  return node
}

test('c-family parser extracts C++ includes, namespace, types, method, function and const globals', () => {
  const result = parseCFamily(CPP_SAMPLE, { path: 'src/demo/widget.cpp' })

  assert.equal(cFamilyParser.id, 'c-family')
  assert.deepEqual(cFamilyParser.extensions, ['.c', '.h', '.cc', '.cpp', '.hpp', '.cxx', '.hh'])
  assert.equal(result.parserId, 'c-family')
  assert.equal(result.truncated, false)
  assert.deepEqual(result.diagnostics, [])
  assert.ok(result.ast !== undefined)

  // One import reference per include; the specifier is the header name and the
  // span covers only the name (no `< >` / quotes).
  assert.deepEqual(
    result.references.map((reference) => [reference.kind, reference.specifier, reference.external]),
    [
      ['import', 'vector', true],
      ['import', 'project/widget.hpp', false],
    ],
  )
  const angleStart = CPP_SAMPLE.indexOf('#include <vector>') + '#include <'.length
  assert.equal(result.references[0]?.span.start, angleStart)
  assert.equal(result.references[0]?.span.end, angleStart + 'vector'.length)
  assert.deepEqual(result.references[0]?.attributes, { form: 'angle' })
  assert.deepEqual(result.references[1]?.attributes, { form: 'quoted' })

  // Kind mapping, names and labels, in deterministic source order.
  assert.deepEqual(
    nodesOf(result).map((node) => [node.kind, node.name, node.label ?? null]),
    [
      ['importation', 'vector', null],
      ['importation', 'project/widget.hpp', null],
      ['module', 'demo', null],
      ['class', 'Widget', 'class'],
      ['class', 'Config', 'struct'],
      ['class', 'Mode', 'enum'],
      ['method', 'Widget', 'demo::Widget::Widget'],
      ['method', 'render', 'demo::Widget::render'],
      ['function', 'add', null],
      ['variable', 'MAX_WIDGETS', 'const'],
      ['variable', 'SCALE', 'const'],
      ['variable', 'counter', null],
    ],
  )

  // Namespace/class/function spans are declaration headers, never bodies.
  const namespaceStart = CPP_SAMPLE.indexOf('namespace demo')
  const namespaceBrace = CPP_SAMPLE.indexOf('{', namespaceStart)
  const namespaceNode = nodeOf(result, 'module', 'demo')
  assert.equal(namespaceNode.span.start, namespaceStart)
  assert.equal(namespaceNode.span.end, namespaceBrace)
  assert.equal(namespaceNode.binding, 'identifier')
  assert.equal(namespaceNode.reference?.scheme, 'module')

  const classStart = CPP_SAMPLE.indexOf('class Widget')
  const classBrace = CPP_SAMPLE.indexOf('{', classStart)
  const classNode = nodeOf(result, 'class', 'Widget')
  assert.equal(classNode.span.start, classStart)
  assert.equal(classNode.span.end, classBrace)
  assert.equal(classNode.binding, 'class')

  const renderStart = CPP_SAMPLE.indexOf('void demo::Widget::render')
  const renderBrace = CPP_SAMPLE.indexOf('{', renderStart)
  const renderNode = nodeOf(result, 'method', 'render')
  assert.equal(renderNode.span.start, renderStart)
  assert.equal(renderNode.span.end, renderBrace)
  assert.equal(renderNode.binding, 'method')
  assert.equal(renderNode.reference?.scheme, 'symbol')

  const addStart = CPP_SAMPLE.indexOf('int add')
  const addBrace = CPP_SAMPLE.indexOf('{', addStart)
  const addNode = nodeOf(result, 'function', 'add')
  assert.equal(addNode.span.start, addStart)
  assert.equal(addNode.span.end, addBrace)

  const counterStart = CPP_SAMPLE.indexOf('int counter')
  const counterNode = nodeOf(result, 'variable', 'counter')
  assert.equal(counterNode.span.start, counterStart)
  assert.equal(counterNode.span.end, CPP_SAMPLE.indexOf(';', counterStart) + 1)
  assert.equal(counterNode.label, undefined)

  // Bodies and comments are never projected.
  const projectedNames = new Set(nodesOf(result).map((node) => node.name))
  for (const hidden of ['local', 'scale', 'width', 'height', 'left', 'right', 'Fast', 'Slow']) {
    assert.equal(projectedNames.has(hidden), false, `${hidden} must not be projected`)
  }

  // Every node carries body-free coordinates and the result is source-ordered.
  for (const node of nodesOf(result)) {
    assert.ok(node.byteStart !== undefined)
    assert.ok(node.byteEnd !== undefined)
    assert.ok(node.lineStart !== undefined)
    assert.ok(node.lineEnd !== undefined)
    assert.ok(node.span.end <= CPP_SAMPLE.length)
  }
  const starts = nodesOf(result).map((node) => node.span.start)
  assert.deepEqual(starts, [...starts].sort((left, right) => left - right))
})

test('c-family parser handles a C-only translation unit without classes', () => {
  const result = parseCFamily(C_SAMPLE, { path: 'src/coords.c' })

  assert.equal(result.parserId, 'c-family')
  assert.equal(result.truncated, false)
  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual(
    nodesOf(result).map((node) => [node.kind, node.name, node.label ?? null]),
    [
      ['importation', 'stdio.h', null],
      ['class', 'point', 'struct'],
      ['variable', 'origin_x', null],
      ['variable', 'PROGRAM_NAME', 'const'],
      ['function', 'distance', null],
      ['function', 'main', null],
    ],
  )

  // `typedef` names are aliases, not variables/classes, and function bodies
  // produce no local nodes.
  const names = new Set(nodesOf(result).map((node) => node.name))
  assert.equal(names.has('point_t'), false)
  assert.equal(names.has('dx'), false)
  assert.equal(nodesOf(result).some((node) => node.kind === 'method'), false)
})

test('c-family parser reports malformed C/C++ without throwing', () => {
  const result = parseCFamily(MALFORMED_SAMPLE, { path: 'src/broken.cpp' })

  // The malformed file still yields the nodes it could prove, plus diagnostics
  // instead of an exception.
  const messages = result.diagnostics.map((diagnostic) => diagnostic.message)
  assert.ok(result.diagnostics.length > 0, 'expected at least one diagnostic')
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'parse-error'))
  assert.ok(messages.some((message) => message.includes('unterminated string literal')))
  assert.ok(messages.some((message) => message.includes('unterminated block comment')))
  assert.ok(messages.some((message) => message.includes('unterminated type declaration body')))
  assert.equal(nodeOf(result, 'class', 'Broken').label, 'class')

  assert.doesNotThrow(() => parseCFamily(MALFORMED_SAMPLE, { path: 'src/broken.cpp' }))

  const unbalanced = parseCFamily(UNBALANCED_SAMPLE, { path: 'src/unbalanced.c' })
  assert.ok(
    unbalanced.diagnostics.some(
      (diagnostic) => diagnostic.code === 'parse-error' && diagnostic.message.includes('unbalanced'),
    ),
  )

  // Parsing an empty file is not an error.
  const empty = parseCFamily('', { path: 'src/empty.c' })
  assert.deepEqual(empty.diagnostics, [])
  assert.deepEqual(nodesOf(empty), [])
  assert.equal(empty.truncated, false)
})

test('c-family parser handles a large generated file within a generous time bound', () => {
  const lines: string[] = []
  for (let index = 0; index < 2_000; index += 1) {
    lines.push(`int generated_${index}(int left, int right) { return left + right; }`)
    lines.push(`const int GENERATED_${index} = ${index};`)
  }
  const source = lines.join('\n')

  const startedAt = performance.now()
  const result = parseCFamily(source, { path: 'src/generated.cpp' })
  const elapsed = performance.now() - startedAt

  assert.equal(result.truncated, false)
  assert.deepEqual(result.diagnostics, [])
  assert.equal(nodesOf(result).length, 4_000)
  assert.ok(elapsed < 5_000, `parse took ${elapsed.toFixed(1)} ms, expected under 5000 ms`)
})

test('c-family parser caps node metadata at MAX_METADATA_NODES', () => {
  const lines: string[] = []
  for (let index = 0; index < MAX_METADATA_NODES + 500; index += 1) {
    lines.push(`int value_${index};`)
  }

  const result = parseCFamily(lines.join('\n'), { path: 'src/many.c' })

  assert.equal(nodesOf(result).length, MAX_METADATA_NODES)
  assert.equal(result.truncated, true)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'node-limit'))
})
