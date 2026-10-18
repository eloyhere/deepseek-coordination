/**
 * Python parser tests.
 *
 * Registration is deferred to the integrator, so these tests import
 * `parsePython`/`pythonParser` directly instead of resolving `.py` through the
 * shared registry. Everything is text-in/result-out: no filesystem, no network,
 * no model, and no body/docstring/comment text is expected on any node.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pythonParser, parsePython } from '../src/host/text/python.js'
import type { PythonParseResult } from '../src/host/text/python.js'

function python(source: string, path = 'src/service.py'): PythonParseResult {
  return parsePython(source, { path })
}

/** One module with two imports, a class + method, a function and two assignments. */
const SOURCE = [
  '"""MODULE_DOCSTRING_MARKER: never emitted."""',
  '',
  'import app.models as models',
  'from app.services import Service, Worker as Team',
  '',
  '@registered',
  'class Greeter(Base):',
  '    """CLASS_DOCSTRING_MARKER: never emitted."""',
  '',
  '    @staticmethod',
  '    def greet(name: str) -> str:',
  '        """METHOD_DOCSTRING_MARKER: never emitted."""',
  '        local = name  # LOCAL_ASSIGNMENT_MARKER',
  '        return local',
  '',
  'def build(value):',
  '    inner = value  # FUNCTION_LOCAL_MARKER',
  '    return inner',
  '',
  'PRIMARY = 1',
  'secondary: int = 2',
  '',
].join('\n')

const EXPECTED_SYMBOLS = [
  'class:Greeter',
  'method:greet',
  'function:build',
  'variable:PRIMARY',
  'variable:secondary',
]

test('python parser declares its id and extensions', () => {
  assert.equal(pythonParser.id, 'python')
  assert.deepEqual([...pythonParser.extensions], ['.py', '.pyi', '.pyw'])
  const result = pythonParser.parse('value = 1\n', { path: 'src/a.py' })
  assert.equal(result.parserId, 'python')
  assert.deepEqual(result.references, [])
})

test('python parser emits imports, class, method, function and module assignments', () => {
  const result = python(SOURCE)

  assert.equal(result.parserId, 'python')
  assert.deepEqual(
    result.references.map((reference) => `${reference.kind}:${reference.specifier}`),
    ['import:app.models', 'import:app.services'],
  )
  const fromImport = result.references[1]
  assert.deepEqual(fromImport.names, ['Service', 'Worker'])
  assert.equal(fromImport.external, true)

  assert.deepEqual(
    result.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`),
    EXPECTED_SYMBOLS,
  )

  const nodes = result.nodes ?? []
  assert.deepEqual(
    nodes.filter((node) => node.kind !== 'importation').map((node) => `${node.kind}:${node.name}`),
    EXPECTED_SYMBOLS,
  )
  const importationNodes = nodes.filter((node) => node.kind === 'importation')
  assert.deepEqual(importationNodes.map((node) => node.name), ['app.models', 'app.services'])
  assert.equal(importationNodes[1]?.label, 'Service, Worker')

  // Class/method/function spans are headers only: no body, no decorator, no
  // docstring and no trailing comment.
  const classSymbol = result.symbols[0]
  assert.equal(SOURCE.slice(classSymbol.span.start, classSymbol.span.end), 'class Greeter(Base):')
  const methodSymbol = result.symbols[1]
  assert.equal(methodSymbol.scope, 'class')
  assert.equal(methodSymbol.ownerClass, 'Greeter')
  assert.equal(SOURCE.slice(methodSymbol.span.start, methodSymbol.span.end), 'def greet(name: str) -> str:')
  const functionSymbol = result.symbols[2]
  assert.equal(functionSymbol.scope, 'module')
  assert.equal(SOURCE.slice(functionSymbol.span.start, functionSymbol.span.end), 'def build(value):')
  // Variable spans point at the bound name, not at the assignment expression.
  assert.equal(SOURCE.slice(result.symbols[3].span.start, result.symbols[3].span.end), 'PRIMARY')
  assert.equal(SOURCE.slice(result.symbols[4].span.start, result.symbols[4].span.end), 'secondary')

  const ast = result.ast
  assert.ok(ast !== undefined)
  const root = ast.root
  assert.ok(root !== undefined)
  assert.equal(root.kind, 'module')
  assert.deepEqual(
    root.children.map((child) => child.kind),
    ['import', 'import', 'class', 'method', 'function', 'variable', 'variable'],
  )
})

test('python parser handles dotted, aliased and relative imports', () => {
  const result = python([
    'import alpha.beta',
    'import gamma.delta as gd',
    'from package import One, Two as T',
    'from .local import helper',
    'from __future__ import annotations',
    '',
  ].join('\n'))

  assert.deepEqual(
    result.references.map((reference) => reference.specifier),
    ['alpha.beta', 'gamma.delta', 'package', '.local', '__future__'],
  )
  assert.deepEqual(
    result.references.map((reference) => reference.external),
    [true, true, true, false, true],
  )
  assert.deepEqual(result.references[2].names, ['One', 'Two'])
  assert.deepEqual(result.references[3].names, ['helper'])
})

test('python parser ignores decorators, docstrings, comments and function-local assignments', () => {
  const result = python(SOURCE)
  const symbolNames = result.symbols.map((symbol) => symbol.name)

  for (const local of ['local', 'inner']) {
    assert.equal(symbolNames.includes(local), false, `${local} is function-local and must not be emitted`)
  }
  assert.equal(result.symbols.length, 5)

  const nodeNames = (result.nodes ?? []).map((node) => node.name)
  assert.equal(nodeNames.includes('registered'), false)
  assert.equal(nodeNames.includes('staticmethod'), false)

  // Body/docstring/comment text is never projected onto the result.
  const serialized = JSON.stringify({
    nodes: result.nodes,
    symbols: result.symbols,
    references: result.references,
  })
  for (const marker of [
    'MODULE_DOCSTRING_MARKER',
    'CLASS_DOCSTRING_MARKER',
    'METHOD_DOCSTRING_MARKER',
    'LOCAL_ASSIGNMENT_MARKER',
    'FUNCTION_LOCAL_MARKER',
  ]) {
    assert.equal(serialized.includes(marker), false, `${marker} leaked into the result`)
  }
})

test('python parser expands annotated, tuple and chained assignment targets', () => {
  const result = python([
    'LEFT, RIGHT = (1, 2)',
    'first = second = 3',
    'annotated: int = 4',
    '',
  ].join('\n'))

  assert.deepEqual(
    result.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`),
    [
      'variable:LEFT',
      'variable:RIGHT',
      'variable:first',
      'variable:second',
      'variable:annotated',
    ],
  )
})

test('python parser reports diagnostics for malformed input and never throws', () => {
  const cases: Array<{ source: string; recovered?: string }> = [
    { source: 'def broken(:\n    pass\n' },
    { source: 'value = "unterminated\nclass Recovered:\n    pass\n', recovered: 'Recovered' },
    { source: 'value = (1]\nclass Later:\n    pass\n', recovered: 'Later' },
    { source: 'def spaced():\n\t value = 1\n' },
  ]

  for (const { source, recovered } of cases) {
    let result: PythonParseResult | undefined
    assert.doesNotThrow(() => {
      result = python(source)
    })
    assert.ok(result !== undefined)
    const parsed = result as PythonParseResult
    assert.equal(parsed.parserId, 'python')
    assert.ok(
      parsed.diagnostics.some((diagnostic) => diagnostic.code === 'parse-error'),
      `expected a parse-error diagnostic for ${JSON.stringify(source)}`,
    )
    if (recovered !== undefined) {
      assert.ok(
        parsed.symbols.some((symbol) => symbol.name === recovered),
        `expected the scan to recover and find ${recovered}`,
      )
    }
  }
})

test('python parser handles a large generated module within a generous time bound', () => {
  const parts: string[] = []
  for (let index = 0; index < 2_000; index += 1) {
    parts.push(`import package_${index}.module as module_${index}`)
    parts.push(`CONST_${index} = ${index}`)
    if (index % 40 === 0) {
      parts.push(
        '',
        `def helper_${index}(value):`,
        `    inner_${index} = value`,
        `    return inner_${index}`,
        '',
      )
    }
  }
  const source = parts.join('\n')
  assert.ok(source.length >= 100_000, `generated source is only ${source.length} characters`)

  const start = Date.now()
  const result = python(source, 'src/generated.py')
  const elapsed = Date.now() - start

  assert.equal(result.truncated, false)
  assert.ok(result.references.length >= 2_000)
  assert.ok(result.symbols.length >= 2_000)
  assert.ok((result.nodes?.length ?? 0) >= 4_000)
  assert.ok(elapsed < 3_000, `parse took ${elapsed} ms`)
})
