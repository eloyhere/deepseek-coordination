import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJavaScript } from '../src/host/text/javascript.js'
import type { CodeSymbol, JavaScriptParseResult } from '../src/host/text/javascript.js'
import type { NodeMetadata } from '../src/host/text/parser.js'

function symbolNamed(result: JavaScriptParseResult, name: string): CodeSymbol {
  const found = result.symbols.find((candidate) => candidate.name === name)
  assert.ok(found, `expected a symbol named ${name}`)
  return found
}

function nodeNamed(result: JavaScriptParseResult, name: string): NodeMetadata {
  const found = (result.nodes ?? []).find((candidate) => candidate.name === name)
  assert.ok(found, `expected a metadata node named ${name}`)
  return found
}

test('top-level const is a global variable symbol and metadata node', () => {
  const result = parseJavaScript('const x = 1')
  const symbol = symbolNamed(result, 'x')
  assert.equal(symbol.kind, 'variable')
  assert.equal(symbol.binding, 'variable')
  assert.equal(symbol.scope, 'global')
  const node = nodeNamed(result, 'x')
  assert.equal(node.kind, 'variable')
  assert.equal(node.binding, 'variable')
  assert.equal(node.scope, 'global')
})

test('const inside a function body is a local variable', () => {
  const result = parseJavaScript('function f() { const y = 2 }')
  assert.equal(symbolNamed(result, 'f').kind, 'function')
  assert.equal(symbolNamed(result, 'f').scope, 'global')
  const y = symbolNamed(result, 'y')
  assert.equal(y.kind, 'variable')
  assert.equal(y.binding, 'variable')
  assert.equal(y.scope, 'local')
  assert.equal(nodeNamed(result, 'y').scope, 'local')
})

test('static class field is a static variable symbol', () => {
  const result = parseJavaScript('class C { static s = 1 }')
  const klass = symbolNamed(result, 'C')
  assert.equal(klass.kind, 'class')
  assert.equal(klass.binding, 'class')
  assert.equal(klass.scope, 'global')
  const field = symbolNamed(result, 's')
  assert.equal(field.kind, 'variable')
  assert.equal(field.binding, 'variable')
  assert.equal(field.scope, 'static')
  assert.equal(nodeNamed(result, 's').scope, 'static')
})

test('static method is static and its body declarations are local', () => {
  const result = parseJavaScript('class C { static m() { const z = 1 } }')
  const method = symbolNamed(result, 'm')
  assert.equal(method.kind, 'method')
  assert.equal(method.binding, 'method')
  assert.equal(method.scope, 'static')
  const z = symbolNamed(result, 'z')
  assert.equal(z.kind, 'variable')
  assert.equal(z.scope, 'local')
})

test('declarations inside a static block are static', () => {
  const result = parseJavaScript('class C { static { const inner = 1 } }')
  const inner = symbolNamed(result, 'inner')
  assert.equal(inner.kind, 'variable')
  assert.equal(inner.binding, 'variable')
  assert.equal(inner.scope, 'static')
})

test('arrow function assigned to a binding stays a function', () => {
  const result = parseJavaScript('const f = (value: number) => value + 1')
  const f = symbolNamed(result, 'f')
  assert.equal(f.kind, 'function')
  assert.equal(f.binding, 'function')
  assert.equal(f.scope, 'global')
  assert.equal(result.symbols.filter((candidate) => candidate.name === 'f').length, 1)
})

test('destructured bindings emit one variable node per name', () => {
  const result = parseJavaScript('const { a, b: c, ...rest } = obj')
  for (const name of ['a', 'c', 'rest']) {
    const symbol = symbolNamed(result, name)
    assert.equal(symbol.kind, 'variable')
    assert.equal(symbol.scope, 'global')
  }
  assert.equal(result.symbols.some((candidate) => candidate.name === 'b'), false)
})

test('TypeScript interface is the interface kind and binds an identifier', () => {
  const result = parseJavaScript('interface Shape { area(): number }')
  const shape = symbolNamed(result, 'Shape')
  assert.equal(shape.kind, 'interface')
  assert.equal(shape.binding, 'identifier')
  assert.equal(shape.scope, 'global')
  assert.equal(nodeNamed(result, 'Shape').kind, 'interface')
})

test('TypeScript type alias is the type kind', () => {
  const result = parseJavaScript('type Id = string | number')
  const id = symbolNamed(result, 'Id')
  assert.equal(id.kind, 'type')
  assert.equal(id.binding, 'identifier')
  assert.equal(id.scope, 'global')
  assert.equal(nodeNamed(result, 'Id').kind, 'type')
})

test('TypeScript enum is the enumeration kind', () => {
  const result = parseJavaScript('enum Color { Red, Blue }')
  const color = symbolNamed(result, 'Color')
  assert.equal(color.kind, 'enumeration')
  assert.equal(color.binding, 'identifier')
  assert.equal(color.scope, 'global')
  assert.equal(nodeNamed(result, 'Color').kind, 'enumeration')
})

test('TypeScript const enum is an enumeration and keeps the export flag', () => {
  const result = parseJavaScript('export const enum Mode { A, B }')
  const mode = symbolNamed(result, 'Mode')
  assert.equal(mode.kind, 'enumeration')
  assert.equal(mode.exported, true)
  assert.equal(nodeNamed(result, 'Mode').kind, 'enumeration')
})

test('TypeScript namespace is the namespace kind', () => {
  const result = parseJavaScript('namespace Util { export const x = 1 }')
  const util = symbolNamed(result, 'Util')
  assert.equal(util.kind, 'namespace')
  assert.equal(util.binding, 'identifier')
  assert.equal(util.scope, 'global')
  assert.equal(nodeNamed(result, 'Util').kind, 'namespace')
})

test('TypeScript module declaration is a namespace', () => {
  const result = parseJavaScript('module Legacy { export const x = 1 }')
  const legacy = symbolNamed(result, 'Legacy')
  assert.equal(legacy.kind, 'namespace')
  assert.equal(legacy.binding, 'identifier')
  assert.equal(legacy.scope, 'global')
  assert.equal(nodeNamed(result, 'Legacy').kind, 'namespace')
})

test('declare creates no node of its own and keeps declarations global', () => {
  const result = parseJavaScript('declare const version: string\ndeclare function boot(): void')
  assert.equal(result.symbols.some((candidate) => candidate.name === 'declare'), false)
  const version = symbolNamed(result, 'version')
  assert.equal(version.kind, 'variable')
  assert.equal(version.scope, 'global')
  const boot = symbolNamed(result, 'boot')
  assert.equal(boot.kind, 'function')
  assert.equal(boot.scope, 'global')
})

test('declare global keeps contained declarations global', () => {
  const result = parseJavaScript('declare global { interface Window { title: string } }')
  const window = symbolNamed(result, 'Window')
  assert.equal(window.kind, 'interface')
  assert.equal(window.binding, 'identifier')
  assert.equal(window.scope, 'global')
  assert.equal(nodeNamed(result, 'Window').kind, 'interface')
})
