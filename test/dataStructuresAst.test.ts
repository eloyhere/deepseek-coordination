/**
 * Contract tests for the AST support layer and its end-to-end smoke path.
 *
 * The tokenizer and import-graph glue live *in this test file on purpose*: phase
 * one ships primitives, not a production parser. The smoke test proves the
 * primitives compose into the shape the phase-two parser will need.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InvalidArgumentError } from '../src/shared/error.js'
import {
  AstIndex,
  AstNode,
  AstTree,
  TokenStream,
  mergeSpans,
  visitAst,
} from '../src/shared/ast.js'
import type { AstVisitor, SourceSpan, Token, TokenKind } from '../src/shared/ast.js'
import { DirectedGraph } from '../src/shared/graph.js'

type TestKind =
  | 'Program'
  | 'ImportDeclaration'
  | 'Keyword'
  | 'Identifier'
  | 'StringLiteral'

/** Build a span literal quickly. */
function span(start: number, end: number, line = 1, column = 1): SourceSpan {
  return { start, end, line, column }
}

/** Build a two-level fixture: Program -> ImportDeclaration -> tokens. */
function createFixture(): {
  tree: AstTree<TestKind>
  root: AstNode<TestKind>
  declaration: AstNode<TestKind>
  keyword: AstNode<TestKind>
  identifier: AstNode<TestKind>
  literal: AstNode<TestKind>
} {
  const root = new AstNode<TestKind>('Program', span(0, 100))
  const declaration = new AstNode<TestKind>('ImportDeclaration', span(0, 40))
  const keyword = new AstNode<TestKind>('Keyword', span(0, 6), 'import')
  const identifier = new AstNode<TestKind>('Identifier', span(7, 8), 'x')
  const literal = new AstNode<TestKind>('StringLiteral', span(15, 20), './y')
  declaration.addChild(keyword)
  declaration.addChild(identifier)
  declaration.addChild(literal)
  root.addChild(declaration)
  return { tree: new AstTree<TestKind>(root), root, declaration, keyword, identifier, literal }
}

test('mergeSpans and AST spans validate their coordinates', () => {
  assert.deepEqual(mergeSpans(span(0, 5, 1, 1), span(5, 10, 1, 6)), span(0, 10, 1, 1))
  assert.throws(() => mergeSpans(span(10, 20), span(0, 5)), InvalidArgumentError)
  assert.throws(() => new AstNode<TestKind>('Program', { start: 5, end: 2, line: 1, column: 1 }), InvalidArgumentError)
  assert.throws(() => new AstNode<TestKind>('Program', { start: 0, end: 2, line: 0, column: 1 }), InvalidArgumentError)
  assert.throws(() => new AstNode<TestKind>('Program', { start: 0.5, end: 2, line: 1, column: 1 }), InvalidArgumentError)
})

test('AstNode walks, finds, reports depth and ancestor chains', () => {
  const fixture = createFixture()
  assert.equal(fixture.root.parent, undefined)
  assert.equal(fixture.declaration.parent, fixture.root)
  assert.equal(fixture.keyword.parent, fixture.declaration)
  assert.equal(fixture.keyword.depth, 2)
  assert.equal(fixture.root.depth, 0)

  assert.deepEqual(
    [...fixture.root.walk()].map((node) => node.kind),
    ['Program', 'ImportDeclaration', 'Keyword', 'Identifier', 'StringLiteral'],
  )
  assert.deepEqual(
    [...fixture.root.descendants()].map((node) => node.kind),
    ['ImportDeclaration', 'Keyword', 'Identifier', 'StringLiteral'],
  )
  assert.deepEqual([...fixture.keyword.ancestors()].map((node) => node.kind), [
    'ImportDeclaration',
    'Program',
  ])
  assert.equal(fixture.root.find((node) => node.value === 'x'), fixture.identifier)
  assert.equal(fixture.root.find((node) => node.value === 'missing'), undefined)
  assert.deepEqual(
    fixture.root.findAll((node) => node.kind !== 'Keyword').map((node) => node.kind),
    ['Program', 'ImportDeclaration', 'Identifier', 'StringLiteral'],
  )
  assert.equal(fixture.tree.size, 5)
  assert.equal(fixture.tree.toArray().length, 5)
})

test('AstNode rejects duplicate, foreign and cyclic children', () => {
  const root = new AstNode<TestKind>('Program', span(0, 100))
  const first = new AstNode<TestKind>('Identifier', span(0, 1), 'first')
  const second = new AstNode<TestKind>('Identifier', span(2, 3), 'second')
  root.addChild(first)
  assert.throws(() => root.addChild(first), InvalidArgumentError)

  const foreignParent = new AstNode<TestKind>('ImportDeclaration', span(0, 10))
  foreignParent.addChild(second)
  assert.throws(() => root.addChild(second), InvalidArgumentError)

  const detached = new AstNode<TestKind>('Identifier', span(4, 5), 'detached')
  const ancestor = new AstNode<TestKind>('Program', span(0, 100))
  const descendant = new AstNode<TestKind>('Identifier', span(0, 1), 'descendant')
  ancestor.addChild(descendant)
  assert.throws(() => descendant.addChild(ancestor), InvalidArgumentError)
  assert.throws(() => detached.addChild(detached), InvalidArgumentError)
  assert.throws(() => root.addChild(root), InvalidArgumentError)

  assert.equal(root.removeChild(first), true)
  assert.equal(first.parent, undefined)
  assert.equal(root.removeChild(first), false)
})

test('AstTree validates parent links, nesting and acyclicity', () => {
  const fixture = createFixture()
  assert.equal(fixture.tree.validate(), true)

  const originalParent = fixture.identifier.parent
  fixture.identifier.parent = fixture.keyword
  assert.equal(fixture.tree.validate(), false)
  fixture.identifier.parent = originalParent
  assert.equal(fixture.tree.validate(), true)

  const wideChild = new AstNode<TestKind>('Identifier', span(90, 200), 'wide')
  fixture.declaration.addChild(wideChild)
  assert.equal(fixture.tree.validate(), false)
  fixture.declaration.removeChild(wideChild)

  const cycle = new AstNode<TestKind>('Program', span(0, 100))
  const loop = new AstNode<TestKind>('Identifier', span(0, 1), 'loop')
  cycle.addChild(loop)
  loop.children.push(cycle)
  const cyclicTree = new AstTree<TestKind>(cycle)
  assert.equal(cyclicTree.validate(), false)

  const tree = new AstTree<TestKind>(fixture.root)
  tree.root = fixture.declaration
  assert.equal(tree.validate(), false)
  assert.equal(new AstTree<TestKind>().validate(), true)
})

test('AstTree toJSON projects spans and only present values', () => {
  const root = new AstNode<TestKind>('Program', span(0, 10))
  root.addChild(new AstNode<TestKind>('Identifier', span(0, 1), 'x'))
  root.addChild(new AstNode<TestKind>('StringLiteral', span(2, 5)))
  const tree = new AstTree<TestKind>(root)
  assert.deepEqual(tree.toJSON(), {
    kind: 'Program',
    span: span(0, 10),
    children: [
      { kind: 'Identifier', span: span(0, 1), children: [], value: 'x' },
      { kind: 'StringLiteral', span: span(2, 5), children: [] },
    ],
  })
  assert.equal(new AstTree<TestKind>().toJSON(), undefined)
  tree.clear()
  assert.equal(tree.root, undefined)
  assert.equal(tree.size, 0)
})

test('visitAst enters parents before children and leaves after them', () => {
  const fixture = createFixture()
  const events: string[] = []
  const visitor: AstVisitor<TestKind> = {
    enter: (node) => events.push(`enter:${node.kind}`),
    leave: (node) => events.push(`leave:${node.kind}`),
  }
  visitAst(fixture.tree, visitor)
  assert.deepEqual(events, [
    'enter:Program',
    'enter:ImportDeclaration',
    'enter:Keyword',
    'leave:Keyword',
    'enter:Identifier',
    'leave:Identifier',
    'enter:StringLiteral',
    'leave:StringLiteral',
    'leave:ImportDeclaration',
    'leave:Program',
  ])
  const emptyEvents: string[] = []
  visitAst(new AstTree<TestKind>(), { enter: () => emptyEvents.push('enter') })
  assert.deepEqual(emptyEvents, [])
})

test('TokenStream peeks, consumes, expects, saves and restores', () => {
  const tokens: Token[] = [
    { kind: 'keyword', text: 'import', span: span(0, 6) },
    { kind: 'identifier', text: 'x', span: span(7, 8, 1, 8) },
    { kind: 'keyword', text: 'from', span: span(9, 13, 1, 10) },
    { kind: 'string', text: "'./y'", span: span(14, 19, 1, 15) },
    { kind: 'eof', text: '', span: span(19, 19, 1, 20) },
  ]
  const stream = new TokenStream(tokens)
  assert.equal(stream.size, 5)
  assert.equal(stream.position, 0)
  assert.equal(stream.eof, false)
  assert.equal(stream.peek(0)?.text, 'import')
  assert.equal(stream.peek(1)?.text, 'x')
  assert.equal(stream.peek(5), undefined)
  assert.throws(() => stream.peek(-1), InvalidArgumentError)

  const saved = stream.save()
  assert.equal(stream.expect('keyword', 'import').text, 'import')
  assert.equal(stream.expect('identifier').text, 'x')
  assert.throws(() => stream.expect('string'), InvalidArgumentError)
  stream.restore(saved)
  assert.equal(stream.position, 0)
  assert.equal(stream.next()?.text, 'import')
  stream.restore(saved)
  assert.equal(stream.next()?.text, 'import')
  assert.equal(stream.next()?.text, 'x')
  assert.equal(stream.next()?.text, 'from')
  assert.equal(stream.next()?.text, "'./y'")
  assert.equal(stream.eof, true)
  assert.equal(stream.next()?.kind, 'eof')
  assert.equal(stream.next(), undefined)
  assert.equal(stream.eof, true)
  assert.throws(() => stream.restore(-1), InvalidArgumentError)
  assert.throws(() => stream.restore(6), InvalidArgumentError)

  tokens[0] = { kind: 'eof', text: '', span: span(0, 0) }
  stream.restore(0)
  assert.equal(stream.peek(0)?.text, 'import')
})

test('AstIndex looks up kinds, start offsets and innermost spans', () => {
  const root = new AstNode<TestKind>('Program', span(0, 100))
  const first = new AstNode<TestKind>('Identifier', span(0, 10), 'first')
  const second = new AstNode<TestKind>('Identifier', span(10, 100), 'second')
  const inner = new AstNode<TestKind>('StringLiteral', span(20, 30), './inner')
  root.addChild(first)
  root.addChild(second)
  second.addChild(inner)
  const index = new AstIndex<TestKind>(new AstTree<TestKind>(root))

  assert.equal(index.size, 4)
  assert.deepEqual(index.ofKind('Identifier').map((node) => node.value), ['first', 'second'])
  assert.deepEqual(index.ofKind('Keyword'), [])
  assert.deepEqual(index.startingAt(0).map((node) => node.kind), ['Program', 'Identifier'])
  assert.deepEqual(index.startingAt(99), [])
  assert.equal(index.smallestContaining(25), inner)
  assert.equal(index.smallestContaining(15), second)
  assert.equal(index.smallestContaining(5), first)
  assert.equal(index.smallestContaining(200), undefined)
  assert.deepEqual([...index.kinds()].sort(), ['Identifier', 'Program', 'StringLiteral'])

  const returned = index.ofKind('Identifier')
  returned.length = 0
  assert.equal(index.ofKind('Identifier').length, 2)
})

/** Minimal test-only tokenizer; the phase-two parser will replace it. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  let line = 1
  let column = 1
  while (index < text.length) {
    const character = text[index]
    if (character === ' ' || character === '\t' || character === '\r') {
      index += 1
      column += 1
      continue
    }
    if (character === '\n') {
      index += 1
      line += 1
      column = 1
      continue
    }
    if (character === "'" || character === '"') {
      const start = index
      const startLine = line
      const startColumn = column
      index += 1
      column += 1
      while (index < text.length && text[index] !== character) {
        index += 1
        column += 1
      }
      if (index < text.length) {
        index += 1
        column += 1
      }
      tokens.push({
        kind: 'string',
        text: text.slice(start, index),
        span: { start, end: index, line: startLine, column: startColumn },
      })
      continue
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index
      const startLine = line
      const startColumn = column
      while (index < text.length && /[A-Za-z0-9_$]/.test(text[index])) {
        index += 1
        column += 1
      }
      const word = text.slice(start, index)
      const kind: TokenKind = word === 'import' || word === 'from' ? 'keyword' : 'identifier'
      tokens.push({ kind, text: word, span: { start, end: index, line: startLine, column: startColumn } })
      continue
    }
    tokens.push({ kind: 'punctuation', text: character, span: { start: index, end: index + 1, line, column } })
    index += 1
    column += 1
  }
  tokens.push({ kind: 'eof', text: '', span: { start: index, end: index, line, column } })
  return tokens
}

test('end-to-end import parsing smoke: tokens, AST and import graph', () => {
  const text = "import x from './y'"
  const tokens = tokenize(text)
  const stream = new TokenStream(tokens)

  const keyword = stream.expect('keyword', 'import')
  const identifier = stream.expect('identifier')
  const from = stream.expect('keyword', 'from')
  const literal = stream.expect('string')
  assert.equal(stream.eof, true)
  assert.deepEqual([keyword.text, identifier.text, from.text, literal.text], [
    'import',
    'x',
    'from',
    "'./y'",
  ])

  const root = new AstNode<TestKind>('Program', { start: 0, end: text.length, line: 1, column: 1 })
  const declaration = new AstNode<TestKind>('ImportDeclaration', {
    start: keyword.span.start,
    end: literal.span.end,
    line: keyword.span.line,
    column: keyword.span.column,
  })
  declaration.addChild(new AstNode<TestKind>('Keyword', keyword.span, keyword.text))
  declaration.addChild(new AstNode<TestKind>('Identifier', identifier.span, identifier.text))
  declaration.addChild(new AstNode<TestKind>('StringLiteral', literal.span, literal.text))
  root.addChild(declaration)
  const tree = new AstTree<TestKind>(root)
  assert.equal(tree.validate(), true)
  assert.equal(tree.size, 5)
  const json = tree.toJSON()
  assert.ok(json !== undefined)
  assert.equal(json.children[0].kind, 'ImportDeclaration')
  assert.equal(json.children[0].children[2].value, "'./y'")

  const index = new AstIndex<TestKind>(tree)
  assert.equal(index.ofKind('ImportDeclaration').length, 1)
  assert.equal(index.smallestContaining(14)?.kind, 'StringLiteral')

  const importPath = literal.text.slice(1, -1)
  const graph = new DirectedGraph<string>(['entry'])
  graph.addEdge('entry', importPath)
  graph.addEdge(importPath, 'leaf')
  assert.deepEqual(graph.topologicalSort(), ['entry', importPath, 'leaf'])
  const levels = graph.dependencyLevels()
  assert.ok(levels !== null)
  assert.equal(levels.get('entry'), 0)
  assert.equal(levels.get(importPath), 1)
  assert.equal(levels.get('leaf'), 2)

  const visited: string[] = []
  visitAst(tree, { enter: (node) => visited.push(node.kind) })
  assert.deepEqual(visited, [
    'Program',
    'ImportDeclaration',
    'Keyword',
    'Identifier',
    'StringLiteral',
  ])
})
