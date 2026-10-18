/**
 * Contract tests for the P0 text/dependency/import parser layer.
 *
 * Everything here is text-in/result-out: no filesystem, no network, no model.
 * The tests pin the reference kinds, symbol extraction, markup/TeX structure,
 * dependency graph semantics, resource bounds, body-free metadata, byte/line
 * agreement and charset/BOM behaviour.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  MAX_AST_DEPTH,
  MAX_BRIEF_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_VERTICES,
  MAX_PARSE_MS,
  MAX_TEXT_LENGTH,
  MAX_TOKENS,
  ParseContext,
  SourceMap,
  classifySpecifier,
  createNodeReference,
  createParserRegistry,
  detectCharset,
  extensionOf,
  isExternalSpecifier,
  parseFileText,
  parseText,
  refreshFileText,
  sha256Fingerprint,
  utf8ByteLength,
} from '../src/host/text/index.js'
import type {
  DependencyGraphResult,
  FileReference,
  JavaScriptParseResult,
  MarkdownParseResult,
  NodeMetadata,
  ParseResult,
  TexParseResult,
} from '../src/host/text/index.js'
import { tokenize } from '../src/host/text/tokenizer.js'
import {
  collectSpreadsheetReferences,
  detectFormulaDialect,
  detectMarkupFormulas,
  extractMarkdownFormulas,
  extractSpreadsheetFormulas,
  extractTexFormulas,
  extractFormulas,
} from '../src/host/text/formula.js'
import {
  MAX_GRAPH_EDGES as DEP_MAX_EDGES,
  MAX_GRAPH_VERTICES as DEP_MAX_VERTICES,
  createDependencyGraph,
  dependencyLevels,
  graphCounts,
  isolatedVertices,
  normalizePath,
  resolveSpecifier,
  topologicalOrder,
} from '../src/host/text/dependency.js'
import { ParseCache } from '../src/host/text/cache.js'

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

function jsResult(source: string, path = 'src/main.ts'): JavaScriptParseResult {
  const result = parseFileText(path, source)
  assert.ok(result !== undefined, 'javascript parser must be registered')
  return result as JavaScriptParseResult
}

function mdResult(source: string, path = 'docs/readme.md'): MarkdownParseResult {
  const result = parseFileText(path, source)
  assert.ok(result !== undefined, 'markdown parser must be registered')
  return result as MarkdownParseResult
}

function texResult(source: string, path = 'docs/main.tex'): TexParseResult {
  const result = parseFileText(path, source)
  assert.ok(result !== undefined, 'latex parser must be registered')
  return result as TexParseResult
}

function specs(result: ParseResult): string[] {
  return result.references.map((reference) => `${reference.kind}:${reference.specifier}`)
}

function codes(result: ParseResult): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code)
}

function nodeNamed(result: ParseResult, name: string): NodeMetadata | undefined {
  return result.nodes?.find((node) => node.name === name)
}

function nodesOfKind(result: ParseResult, kind: string): NodeMetadata[] {
  return (result.nodes ?? []).filter((node) => node.kind === kind)
}

function nodeSignatures(result: ParseResult): string[] {
  return (result.nodes ?? []).map((node) => `${node.kind}:${node.name ?? ''}`)
}

function fragmentSha(text: string): string {
  return `sha256:${createHash('sha256').update(new TextEncoder().encode(text)).digest('hex')}`
}

/* ------------------------------------------------------------------------- *
 * Tokenizer, registry, limits
 * ------------------------------------------------------------------------- */

test('tokenizer scans comments, strings, regex and identifiers without regex backtracking', () => {
  const source = [
    "// import fake from './fake'",
    "const value = 'import x from \"./x\"'",
    'const re = /import \'nope\'/g',
    '/* block */ function f() { return 1 }',
  ].join('\n')
  const result = tokenize(source)
  const kinds = new Set(result.tokens.map((token) => token.kind))
  assert.equal(result.truncated, false)
  assert.equal(result.tokens[result.tokens.length - 1].kind, 'eof')
  assert.ok(kinds.has('comment'))
  assert.ok(kinds.has('string'))
  assert.ok(kinds.has('keyword'))
  assert.ok(kinds.has('identifier'))
  assert.ok(kinds.has('punctuation'))
  // The regex literal is one string token, so `import` inside it is never an id.
  const regexTexts = result.tokens.filter((token) => token.kind === 'string' && token.text.startsWith('/'))
  assert.equal(regexTexts.length, 1)
})

test('tokenizer stops at maxTokens with truncated=true', () => {
  const result = tokenize('const a = 1; const b = 2; const c = 3;', { maxTokens: 5 })
  assert.equal(result.truncated, true)
  assert.equal(result.tokens.length, 5)
})

test('ParserRegistry resolves by extension first, then id; unknown is undefined', () => {
  const registry = createParserRegistry()
  assert.equal(registry.resolve('a.ts')?.id, 'javascript')
  assert.equal(registry.resolve('a.css')?.id, 'css')
  assert.equal(registry.resolve('a.html')?.id, 'html')
  assert.equal(registry.resolve('a.md')?.id, 'markdown')
  assert.equal(registry.resolve('a.tex')?.id, 'latex')
  assert.equal(registry.resolve('a.unknown'), undefined)
  assert.equal(registry.resolve(undefined, 'markdown')?.id, 'markdown')
  assert.equal(registry.resolve('a.unknown', 'css')?.id, 'css')
  assert.equal(registry.resolve('a.ts', 'css')?.id, 'javascript')
  assert.equal(extensionOf('.gitignore'), undefined)
  assert.equal(extensionOf('src/a.test.ts'), '.ts')
  assert.throws(() => registry.register(registry.parsers()[0]))
})

test('hard limits and parse-text guards are enforced', () => {
  assert.equal(MAX_TEXT_LENGTH, 1_048_576)
  assert.equal(MAX_TOKENS, 200_000)
  assert.equal(MAX_AST_DEPTH, 256)
  assert.equal(MAX_PARSE_MS, 2_000)
  assert.equal(MAX_GRAPH_VERTICES, 20_000)
  assert.equal(MAX_GRAPH_EDGES, 100_000)
  assert.equal(DEP_MAX_VERTICES, 20_000)
  assert.equal(DEP_MAX_EDGES, 100_000)

  const oversized = parseFileText('src/big.ts', 'const a = 1\n' + 'x'.repeat(MAX_TEXT_LENGTH))
  assert.ok(oversized !== undefined)
  assert.equal(oversized.truncated, true)
  assert.ok(codes(oversized).includes('text-limit'))

  const capped = parseFileText('src/cap.ts', 'const a = 1; const b = 2; const c = 3;', { maxTokens: 6 })
  assert.ok(capped !== undefined)
  assert.equal(capped.truncated, true)
  assert.ok(codes(capped).includes('token-limit'))

  const timedOut = parseFileText('src/slow.ts', 'const a = 1', { timeoutMs: 0 })
  assert.ok(timedOut !== undefined)
  assert.equal(timedOut.truncated, true)
  assert.ok(codes(timedOut).includes('timeout'))

  const controller = new AbortController()
  controller.abort()
  assert.throws(
    () => parseFileText('src/abort.ts', 'const a = 1', { signal: controller.signal }),
    (error: unknown) => (error as Error).name === 'AbortError',
  )

  assert.equal(parseText('x', {}), undefined)
  assert.equal(parseFileText('a.unknown', 'x'), undefined)
})

test('AST depth limit is reported and parsing continues', () => {
  const open = Array.from({ length: MAX_AST_DEPTH + 8 }, () => '::: deep').join('\n')
  const close = Array.from({ length: MAX_AST_DEPTH + 8 }, () => ':::').join('\n')
  const source = `${open}\n${close}\n\n[after](docs/after.md)\n`
  const result = mdResult(source)
  assert.equal(result.truncated, true)
  assert.ok(codes(result).includes('depth-limit'))
  assert.ok(specs(result).includes('markdown-link:docs/after.md'))
})

/* ------------------------------------------------------------------------- *
 * JavaScript
 * ------------------------------------------------------------------------- */

test('JS extracts every static import variant, including type-only', () => {
  const source = [
    "import './side-effect.css'",
    "import def from './default'",
    "import * as ns from '../namespaced'",
    "import { a, b as c } from './named'",
    "import type { T } from './types'",
    "import type TypeDefault from './type-default'",
    "import both, { d } from './both'",
    "import both2, * as ns2 from './both-ns'",
  ].join('\n')
  const result = jsResult(source)
  assert.deepEqual(specs(result), [
    'import:./side-effect.css',
    'import:./default',
    'import:../namespaced',
    'import:./named',
    'import:./types',
    'import:./type-default',
    'import:./both',
    'import:./both-ns',
  ])
  const typeOnly = result.references.filter((reference) => reference.typeOnly === true)
  assert.deepEqual(typeOnly.map((reference) => reference.specifier), ['./types', './type-default'])
  const namespaced = result.references.find((reference) => reference.specifier === '../namespaced')
  assert.deepEqual(namespaced?.names, ['*'])
  const named = result.references.find((reference) => reference.specifier === './named')
  assert.deepEqual(named?.names, ['a', 'b'])
})

test('JS ignores imports inside comments, strings, template literals and regex literals', () => {
  const source = [
    "// import nope from './nope-comment'",
    "/* import nope2 from './nope-block' */",
    "const single = 'import nope3 from \"./nope-string\"'",
    'const template = `import nope4 from "./nope-template"`',
    'const regex = /import nope5 from "\\.\\/nope-regex"/g',
    "const call = 'require(\"./nope-require\")'",
  ].join('\n')
  const result = jsResult(source)
  assert.deepEqual(result.references, [])
})

test('JS extracts exports, re-exports, wildcards and type-only exports', () => {
  const source = [
    "export { a } from './a'",
    "export * from './all'",
    "export * as namespace from './ns'",
    "export type { T } from './types'",
    "export type * from './types-all'",
    "export { local }",
    "export const value = 1",
  ].join('\n')
  const result = jsResult(source)
  assert.deepEqual(specs(result), [
    'export-from:./a',
    'export-from:./all',
    'export-from:./ns',
    'export-from:./types',
    'export-from:./types-all',
  ])
  const typed = result.references.find((reference) => reference.specifier === './types')
  assert.equal(typed?.typeOnly, true)
  const wildcard = result.references.find((reference) => reference.specifier === './all')
  assert.equal(wildcard?.wildcard, true)
  assert.ok(result.exports.some((entry) => entry.name === 'local' && entry.specifier === undefined))
  assert.ok(result.exports.some((entry) => entry.name === 'namespace' && entry.wildcard === true))
})

test('JS extracts literal dynamic import and require, and marks non-literals unverifiable', () => {
  const source = [
    "const a = await import('./dynamic')",
    "const b = require('./required')",
    'const c = import(`./template-${name}`)',
    'const d = require(variable)',
    "const e = import('./dynamic', { with: { type: 'json' } })",
    "const f = import.meta.url",
  ].join('\n')
  const result = jsResult(source)
  assert.deepEqual(specs(result).sort(), [
    'dynamic-import:./dynamic',
    'dynamic-import:./dynamic',
    'require:./required',
  ])
  const unverifiable = result.diagnostics.filter((diagnostic) => diagnostic.code === 'unverifiable')
  // Only the two non-literal specifiers produce import diagnostics; the
  // metadata warnings below are unrelated and stay out of this assertion.
  assert.deepEqual(
    unverifiable
      .filter((diagnostic) => diagnostic.message.startsWith('dynamic import') || diagnostic.message.startsWith('require'))
      .map((diagnostic) => diagnostic.message),
    [
      'dynamic import specifier is not a string literal',
      'require specifier is not a string literal',
    ],
  )
  // Every binding becomes a variable node; each literal dynamic import/require
  // becomes an importation node, in source order.
  assert.deepEqual(nodeSignatures(result), [
    'variable:a',
    'variable:b',
    'variable:c',
    'variable:d',
    'variable:e',
    'variable:f',
    'importation:./dynamic',
    'importation:./required',
    'importation:./dynamic',
  ])
  const variables = result.symbols.filter((symbol) => symbol.kind === 'variable')
  assert.deepEqual(variables.map((symbol) => symbol.name), ['a', 'b', 'c', 'd', 'e', 'f'])
  for (const variable of variables) {
    assert.equal(variable.binding, 'variable')
    assert.equal(variable.scope, 'global')
  }
  for (const node of result.nodes ?? []) {
    assert.equal('content' in node, false)
    assert.equal('text' in node, false)
    assert.equal('body' in node, false)
  }
})

test('JS extracts classes, functions, arrows, methods and export flags', () => {
  const source = [
    'export class Widget {',
    '  constructor(x) { this.x = x }',
    '  render(y) { return y }',
    '  async load() { await import("./lazy") }',
    '  static make() { return new Widget(1) }',
    '  get value() { return this.x }',
    '  set value(next) { this.x = next }',
    '}',
    'export function named(a, b) { return a + b }',
    'async function later() {}',
    'function* generator() {}',
    'const arrow = (x) => x * 2',
    'const asyncArrow = async (x) => x',
  ].join('\n')
  const result = jsResult(source)
  const names = result.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)
  assert.ok(names.includes('class:Widget'))
  assert.ok(names.includes('method:render'))
  assert.ok(names.includes('method:constructor'))
  assert.ok(names.includes('method:load'))
  assert.ok(names.includes('method:make'))
  assert.ok(names.includes('method:value'))
  assert.ok(names.includes('function:named'))
  assert.ok(names.includes('function:later'))
  assert.ok(names.includes('function:generator'))
  assert.ok(names.includes('function:arrow'))
  assert.ok(names.includes('function:asyncArrow'))
  const widget = result.symbols.find((symbol) => symbol.name === 'Widget')
  assert.equal(widget?.exported, true)
  const render = result.symbols.find((symbol) => symbol.name === 'render')
  assert.equal(render?.ownerClass, 'Widget')
  assert.equal(render?.form, 'method')
  const constructor = result.symbols.find((symbol) => symbol.name === 'constructor')
  assert.equal(constructor?.form, 'constructor')
  const getter = result.symbols.find((symbol) => symbol.name === 'value' && symbol.form === 'getter')
  assert.ok(getter !== undefined)
  const make = result.symbols.find((symbol) => symbol.name === 'make')
  assert.equal(make?.static, true)
  const later = result.symbols.find((symbol) => symbol.name === 'later')
  assert.equal(later?.async, true)
  const generator = result.symbols.find((symbol) => symbol.name === 'generator')
  assert.equal(generator?.generator, true)
  // One metadata node per symbol, in source order. Arrow bindings stay function
  // symbols, so no duplicate `variable` nodes appear.
  assert.deepEqual(nodeSignatures(result), [
    'class:Widget',
    'method:constructor',
    'method:render',
    'method:load',
    'method:make',
    'method:value',
    'method:value',
    'function:named',
    'function:later',
    'function:generator',
    'function:arrow',
    'function:asyncArrow',
  ])
  assert.equal(nodesOfKind(result, 'variable').length, 0)
  assert.equal(widget?.binding, 'class')
  assert.equal(widget?.scope, 'global')
  assert.equal(render?.binding, 'method')
  const named = result.symbols.find((symbol) => symbol.name === 'named')
  assert.equal(named?.binding, 'function')
  assert.equal(named?.scope, 'global')
  assert.equal(later?.scope, 'global')
  for (const node of result.nodes ?? []) {
    assert.equal('content' in node, false)
    assert.equal('text' in node, false)
    assert.equal('body' in node, false)
  }
})

test('JS comments attach to the nearest following symbol and never leak the body', () => {
  const source = [
    '/**',
    ' * Adds two numbers.',
    ' * @usage add(1, 2)',
    ' * Purpose: sum two numbers',
    ' */',
    'export function add(a, b) { return a + b }',
    '',
    '// line comment',
    'function second() {}',
    '',
    'function bare() {}',
  ].join('\n')
  const result = jsResult(source)
  const add = result.symbols.find((symbol) => symbol.name === 'add')
  assert.equal(add?.brief, 'Adds two numbers.')
  assert.equal(add?.usage, 'add(1, 2)')
  assert.equal(add?.purpose, 'sum two numbers')
  assert.equal(add?.summary, 'Adds two numbers.')
  assert.ok((add?.reference?.hash ?? '').startsWith('sha256:'))
  const addNode = nodeNamed(result, 'add')
  assert.equal(addNode?.brief, 'Adds two numbers.')
  assert.equal(addNode?.usage, 'add(1, 2)')
  assert.equal(addNode?.purpose, 'sum two numbers')
  assert.ok(!JSON.stringify(addNode).includes('return a + b'))
  const bare = nodeNamed(result, 'bare')
  assert.equal(bare?.brief, undefined)
  assert.ok(codes(result).includes('unverifiable'))
})

test('JS metadata is capped, sanitised and explicit-only', () => {
  const longLine = 'x'.repeat(400)
  const source = [
    '/**',
    ` * ${longLine}`,
    ' * @usage ' + 'u'.repeat(400),
    ' * @purpose ' + 'p'.repeat(400),
    ' * password: hunter2',
    ' * <b>bold</b> body',
    ' */',
    'function big() {}',
    'function noDoc() {}',
  ].join('\n')
  const result = jsResult(source)
  const node = nodeNamed(result, 'big')
  assert.ok((node?.brief?.length ?? 0) <= MAX_BRIEF_LENGTH)
  assert.ok((node?.description?.length ?? 0) <= MAX_DESCRIPTION_LENGTH)
  assert.ok(!JSON.stringify(node).includes('hunter2'))
  assert.ok(!JSON.stringify(node).includes('<b>'))
  const bare = nodeNamed(result, 'noDoc')
  assert.equal(bare?.usage, undefined)
  assert.equal(bare?.purpose, undefined)
  assert.equal(bare?.brief, undefined)
})

test('JS metadata carries flat file coordinates and a range fingerprint', () => {
  const source = 'export function first() {}\nexport function second() {}\n'
  const result = jsResult(source, 'src/coords.ts')
  const first = nodeNamed(result, 'first')
  const second = nodeNamed(result, 'second')
  assert.ok(first !== undefined && second !== undefined)
  assert.equal(first.path, 'src/coords.ts')
  assert.equal(first.charset, 'ascii')
  assert.equal(first.reference?.path, 'src/coords.ts')
  assert.equal(first.reference?.charset, 'ascii')
  assert.equal(first.reference?.lines?.start, 1)
  assert.equal(first.reference?.lines?.end, 1)
  assert.ok((first.byteStart ?? -1) >= 0)
  assert.ok((first.byteEnd ?? 0) > (first.byteStart ?? 0))
  assert.ok((second.byteStart ?? 0) > (first.byteEnd ?? 0))
  assert.equal(first.fingerprint, fragmentSha(source.slice(first.span.start, first.span.end)))
  assert.equal(first.fingerprint, first.reference?.hash)
})

test('JSX text and object keys are not mistaken for declarations', () => {
  const source = [
    'const view = <p>import fake from "./fake"</p>',
    'const obj = { class: 1, function: 2 }',
    'class Real {}',
  ].join('\n')
  const result = jsResult(source)
  assert.deepEqual(specs(result), [])
  assert.ok(result.symbols.some((symbol) => symbol.name === 'Real'))
})

/* ------------------------------------------------------------------------- *
 * CSS / HTML / Markdown
 * ------------------------------------------------------------------------- */

test('CSS extracts @import and url() while excluding data: and comments', () => {
  const source = [
    '@import "reset.css";',
    '@import url("theme.css") screen;',
    '/* @import "commented.css"; url(commented.png); */',
    '.hero { background: url(../img/hero.png); mask: url(#clip); }',
    '@font-face { src: url(data:font/woff2;base64,AAAA) format("woff2"); }',
    'body { content: "url(not-a-ref.png)"; }',
  ].join('\n')
  const result = parseFileText('styles/site.css', source)
  assert.ok(result !== undefined)
  assert.deepEqual(specs(result), [
    'css-import:reset.css',
    'css-import:theme.css',
    'css-url:../img/hero.png',
    'css-url:#clip',
  ])
  const themed = result.references.find((reference) => reference.specifier === 'theme.css')
  assert.equal(themed?.attributes?.media, 'screen')
  assert.ok(result.references.every((reference) => (reference.byteStart ?? 0) >= 0))
})

test('HTML extracts script/link/img references case-insensitively, quoted or not', () => {
  const source = [
    '<!doctype html>',
    '<HTML><head>',
    '<TITLE>My Page</TITLE>',
    '<meta name="description" content="A short description">',
    '<LINK HREF=\'a.css\' rel="stylesheet">',
    '<link href=b.css rel=preload>',
    '<script src="./app.js" defer></script>',
    '<img SRC=logo.png alt="x">',
    '<img src="logo2.png">',
    '<!-- <script src="commented.js"></script> -->',
    '<script>var fake = \'<img src="inline.png">\'</script>',
    '<article>',
    '<h1>Heading One</h1>',
    '<p>Paragraph <b>text</b>.</p>',
    '</article>',
    '</head></HTML>',
  ].join('\n')
  const result = parseFileText('site/index.html', source)
  assert.ok(result !== undefined)
  assert.deepEqual(specs(result).sort(), [
    'html-image:logo.png',
    'html-image:logo2.png',
    'html-link:a.css',
    'html-link:b.css',
    'html-script:./app.js',
  ])
  const html = result as import('../src/host/text/markup.js').HtmlParseResult
  assert.equal(html.headings[0]?.title, 'Heading One')
  assert.match(html.paragraphs[0]?.preview ?? '', /Paragraph/)
  assert.equal(result.document?.title, 'My Page')
  assert.equal(result.document?.form, 'article')
  const documentNode = result.nodes?.find((node) => node.kind === 'document')
  assert.equal(documentNode?.brief, 'A short description')
})

test('Markdown extracts inline/reference links and images, excluding code and comments', () => {
  const source = [
    '# Title',
    '',
    'Inline [doc](docs/a.md) and ![pic](img/pic.png).',
    'Reference [guide][g] and collapsed [other][] and shortcut [short].',
    '[g]: ./ref.md "Guide"',
    '[other]: ./collapsed.md',
    '[short]: ./shortcut.md',
    '[unused]: ./unused.md',
    '',
    '`[code](ignored.md)`',
    '```',
    '[fenced](ignored2.md)',
    '```',
    '<!-- [commented](ignored3.md) -->',
  ].join('\n')
  const result = mdResult(source)
  const found = specs(result).filter((entry) => entry.startsWith('markdown-link:') || entry.startsWith('markdown-image:'))
  assert.deepEqual(found.sort(), [
    'markdown-image:img/pic.png',
    'markdown-link:./collapsed.md',
    'markdown-link:./ref.md',
    'markdown-link:./shortcut.md',
    'markdown-link:./unused.md',
    'markdown-link:docs/a.md',
  ])
})

test('Markdown parses front matter, fenced divs, headings and paragraphs', () => {
  const source = [
    '---',
    'title: Design Notes',
    'author: Ada',
    'form: book',
    'description: This document explains the design.',
    'usage: cite in the RFC',
    'purpose: align the team',
    'requires: r1',
    '---',
    '',
    '# Chapter One',
    '',
    'A paragraph with [a link](docs/chapter.md).',
    '',
    '::: definition',
    'A definition with $x^2$.',
    '',
    '$$',
    '\\frac{a}{b}',
    '$$',
    ':::',
    '',
    '::: require',
    'must be positive',
    ':::',
    '',
    '::: meet',
    'may pass',
    ':::',
    '',
    '::: condition',
    'guard',
    ':::',
  ].join('\n')
  const result = mdResult(source)
  assert.equal(result.document?.form, 'book')
  assert.equal(result.document?.title, 'Design Notes')
  assert.equal(result.document?.author, 'Ada')
  const keys = result.frontMatter.map((entry) => entry.key)
  assert.deepEqual(keys, ['title', 'author', 'form', 'description', 'usage', 'purpose', 'requires'])
  assert.deepEqual(result.divs.map((div) => div.name), ['definition', 'require', 'meet', 'condition'])
  assert.equal(result.headings[0]?.title, 'Chapter One')
  assert.ok(result.paragraphs.length >= 1)
  assert.deepEqual(result.formulas.map((formula) => formula.delimiter), ['inline', 'block'])
  const documentNode = result.nodes?.find((node) => node.kind === 'document')
  assert.equal(documentNode?.name, 'Design Notes')
  assert.equal(documentNode?.brief, 'This document explains the design.')
  assert.equal(documentNode?.usage, 'cite in the RFC')
  assert.equal(documentNode?.purpose, 'align the team')
})

test('Markdown excludes fenced/inline code from formulas and honours escaped dollars', () => {
  const source = [
    'Inline $a+b$ and escaped \\$not-math\\$.',
    '',
    '```ts',
    'const price = "$5"',
    '```',
    '',
    '`$inline-code$`',
    '',
    '$$',
    'x = y',
    '$$',
  ].join('\n')
  const result = mdResult(source)
  assert.deepEqual(result.formulas.map((formula) => formula.text), ['a+b', 'x = y'])
  assert.ok(result.formulas.every((formula) => formula.dialect === 'markdown-math'))
})

test('Markdown without a body source never invents a brief and reports it', () => {
  const result = mdResult('# Only a heading\n\nProse that is not a description field.\n')
  const heading = nodeNamed(result, 'Only a heading')
  assert.equal(heading?.brief, undefined)
  assert.ok(codes(result).includes('unverifiable'))
})

test('Markdown level-1 heading emits a chapter node with its text as name', () => {
  const source = ['# Chapter One', '', '## Section One', '', '### Detail'].join('\n')
  const result = mdResult(source)
  const chapters = nodesOfKind(result, 'chapter')
  assert.equal(chapters.length, 1)
  assert.equal(chapters[0]?.name, 'Chapter One')
  const heading = nodesOfKind(result, 'heading').find((node) => node.name === 'Chapter One')
  assert.ok(heading !== undefined)
  assert.equal(chapters[0]?.span.start, heading.span.start)
  assert.equal(chapters[0]?.span.end, heading.span.end)
  // Deeper headings keep the `heading` kind; only level 1 becomes a chapter.
  assert.equal(nodesOfKind(result, 'chapter').some((node) => node.name === 'Section One'), false)
  for (const node of chapters) {
    assert.equal('content' in node, false)
    assert.equal('text' in node, false)
    assert.equal('body' in node, false)
  }
})

test('Markdown links and images emit one link node per reference with the destination as name', () => {
  const source = [
    '[doc](docs/a.md) and ![pic](img/pic.png) and [guide][g].',
    '',
    '[g]: ./ref.md "Guide"',
    '',
    '`[inline-code](ignored.md)`',
    '',
    '```',
    '[fenced](ignored2.md)',
    '```',
    '',
    '<!-- [commented](ignored3.md) -->',
  ].join('\n')
  const result = mdResult(source)
  const links = nodesOfKind(result, 'link')
  assert.deepEqual(links.map((node) => node.name), ['docs/a.md', 'img/pic.png', './ref.md'])
  const references = result.references.filter((reference) =>
    reference.kind === 'markdown-link' || reference.kind === 'markdown-image')
  assert.equal(links.length, references.length)
  for (const link of links) {
    assert.equal('content' in link, false)
    assert.equal('text' in link, false)
    assert.equal('body' in link, false)
    const reference = references.find((entry) => entry.span.start === link.span.start)
    assert.ok(reference !== undefined)
    assert.equal(link.span.end, reference.span.end)
    assert.equal(link.byteStart, reference.byteStart)
    assert.equal(link.fingerprint, reference.fingerprint)
  }
})

test('Markdown fenced code emits a body-free code node named by its info string', () => {
  const marker = 'SECRET_CODE_BODY_9f3c'
  const source = [
    '```ts',
    `const secret = '${marker}'`,
    '```',
    '',
    '```',
    `plain ${marker}`,
    '```',
  ].join('\n')
  const result = mdResult(source)
  const code = nodesOfKind(result, 'code')
  assert.equal(code.length, 2)
  assert.equal(code[0]?.name, 'ts')
  assert.equal(code[1]?.name, undefined)
  assert.ok(!JSON.stringify(result.nodes).includes(marker))
  for (const node of code) {
    assert.equal('content' in node, false)
    assert.equal('text' in node, false)
    assert.equal('body' in node, false)
  }
})

test('HTML anchors and pre/code blocks emit link and body-free code nodes', () => {
  const marker = 'SECRET_HTML_CODE_5a71'
  const source = [
    '<!doctype html>',
    '<html><head><title>Docs</title></head><body>',
    '<a href="docs/a.md">Doc</a>',
    '<p>Inline <a href="./anchor.md">anchor</a>.</p>',
    `<pre><code class="language-ts">const hidden = "${marker}"</code></pre>`,
    '<p>Use <code>npm test</code> locally.</p>',
    '</body></html>',
  ].join('\n')
  const result = parseFileText('site/page.html', source)
  assert.ok(result !== undefined)
  const links = nodesOfKind(result, 'link')
  assert.deepEqual(links.map((node) => node.name), ['docs/a.md', './anchor.md'])
  const code = nodesOfKind(result, 'code')
  assert.equal(code.length, 2)
  assert.equal(code[0]?.name, 'ts')
  assert.equal(code[1]?.name, undefined)
  assert.ok(!JSON.stringify(result.nodes).includes(marker))
  assert.equal(nodesOfKind(result, 'document').length, 1)
  for (const node of [...links, ...code]) {
    assert.equal('content' in node, false)
    assert.equal('text' in node, false)
    assert.equal('body' in node, false)
  }
})

test('HTML <article> is a sectioning container: no article node, root maps to document', () => {
  const source = [
    '<html><body>',
    '<article>',
    '<h1>Field Guide</h1>',
    '<section><h2>Birds</h2><article><h2>Nested</h2></article></section>',
    '</article>',
    '</body></html>',
  ].join('\n')
  const result = parseFileText('docs/guide.html', source)
  assert.ok(result !== undefined)
  assert.equal(nodesOfKind(result, 'article').length, 0)
  assert.equal(nodesOfKind(result, 'document').length, 1)
  // The root <article> is transparent; the nested one becomes a section.
  assert.equal(nodesOfKind(result, 'section').length, 2)
})

/* ------------------------------------------------------------------------- *
 * TeX
 * ------------------------------------------------------------------------- */

test('TeX extracts theorem-like environments, labels, refs and proof targets', () => {
  const source = String.raw`\documentclass{article}
\begin{document}
\begin{definition}[Widget]\label{def:widget}
A widget is $x^2$.
\end{definition}
\begin{lemma}\label{lem:a}A lemma.\end{lemma}
\begin{theorem}[Main]\label{thm:main}
For all $x$, \[ x = x \].
\end{theorem}
\begin{proposition}\label{prop:b}Proposition.\end{proposition}
\begin{corollary}\label{cor:c}Corollary.\end{corollary}
\begin{axiom}\label{ax:d}Axiom.\end{axiom}
\begin{property}\label{pr:e}Property.\end{property}
\begin{claim}\label{cl:f}Claim.\end{claim}
\begin{example}\label{ex:g}Example.\end{example}
\begin{remark}\label{re:h}Remark.\end{remark}
\begin{proof}
By \ref{thm:main}.
\end{proof}
\end{document}`
  const result = texResult(source)
  assert.deepEqual(result.statements.map((statement) => `${statement.kind}:${statement.label ?? ''}`), [
    'definition:def:widget',
    'lemma:lem:a',
    'theorem:thm:main',
    'theorem:prop:b',
    'corollary:cor:c',
    'axiom:ax:d',
    'property:pr:e',
    'claim:cl:f',
    'example:ex:g',
    'remark:re:h',
    'proof:',
  ])
  assert.equal(result.statements[0].title, 'Widget')
  assert.equal(result.statements[2].title, 'Main')
  const proposition = result.statements.find((statement) => statement.environment === 'proposition')
  assert.equal(proposition?.kind, 'theorem')
  const proof = result.statements.find((statement) => statement.kind === 'proof')
  assert.equal(proof?.proofTarget, 'thm:main')
  assert.deepEqual(result.crossReferences.map((reference) => reference.name), ['thm:main'])
  assert.ok(result.labels.length >= 10)
})

test('TeX extracts math delimiters/environments and input/include references, excluding comments', () => {
  const source = String.raw`\input{chapters/one}
\include{appendix}
% \input{commented}
Inline $a+b$ and \(c+d\) and \[e=f\].
\begin{equation} x = y \end{equation}
\begin{align*} a &= b \\ c &= d \end{align*}
\begin{array}{cc} 1 & 2 \end{array}
$100\%$ of math.`
  const result = texResult(source)
  assert.deepEqual(specs(result), ['tex-input:chapters/one', 'tex-include:appendix'])
  const delimiters = result.formulas.map((formula) => `${formula.delimiter}:${formula.dialect}`)
  assert.ok(delimiters.includes('inline:tex'))
  assert.ok(delimiters.includes('block:tex'))
  assert.ok(delimiters.filter((entry) => entry === 'environment:tex').length >= 2)
  assert.ok(result.formulas.every((formula) => !formula.text.includes('commented')))
})

test('TeX detects document class, title, author and abstract without returning the body', () => {
  const source = String.raw`\documentclass{book}
\title{The Big Book}
\author{Ada}
\begin{document}
\begin{abstract}
This book explains the design of the system in detail.
\end{abstract}
\chapter{One}
\end{document}`
  const result = texResult(source)
  assert.equal(result.document?.form, 'book')
  assert.equal(result.document?.title, 'The Big Book')
  assert.equal(result.document?.author, 'Ada')
  const documentNode = result.nodes?.find((node) => node.kind === 'document')
  assert.match(documentNode?.brief ?? '', /explains the design/)
  assert.ok(!JSON.stringify(result.nodes).includes('\\chapter'))
})

/* ------------------------------------------------------------------------- *
 * Formulas
 * ------------------------------------------------------------------------- */

test('formula dialect detection honours explicit input and unambiguous signals', () => {
  assert.equal(detectFormulaDialect({ dialect: 'tex', text: '$x$' }), 'tex')
  assert.equal(detectFormulaDialect({ path: 'docs/a.md' }), 'markdown-math')
  assert.equal(detectFormulaDialect({ path: 'docs/a.tex' }), 'tex')
  assert.equal(detectFormulaDialect({ text: '=SUM(A1)' }), 'spreadsheet')
  assert.equal(detectFormulaDialect({ text: '<m:oMath><m:r>x</m:r></m:oMath>' }), 'omml')
  assert.equal(detectFormulaDialect({ text: '<math><mi>x</mi></math>' }), 'mathml')
  assert.equal(detectFormulaDialect({ text: 'plain prose' }), 'unknown')
})

test('formula scanners extract spans, references and unverifiable placeholders', () => {
  const markdown = extractMarkdownFormulas('Before $x^2$ and $$\\frac{a}{b}$$ after.')
  assert.deepEqual(markdown.map((formula) => formula.text), ['x^2', '\\frac{a}{b}'])
  assert.deepEqual(markdown.map((formula) => formula.delimiter), ['inline', 'block'])
  assert.equal(markdown[0].container, 'paragraph')
  assert.equal(markdown[1].container, 'block')
  assert.ok(markdown.every((formula) => formula.span.end > formula.span.start))

  const tex = extractTexFormulas(String.raw`$a$ \[b\] \begin{equation}c\label{eq:c}\end{equation}`)
  assert.ok(tex.some((formula) => formula.delimiter === 'environment'))
  const labeled = tex.find((formula) => formula.name === 'eq:c')
  assert.ok(labeled !== undefined)
  assert.ok(labeled.references.some((reference) => reference.kind === 'label'))

  const unterminated = extractMarkdownFormulas('$$ never closed')
  assert.equal(unterminated.length, 1)
  assert.equal(unterminated[0].unverifiable, true)
  assert.equal(unterminated[0].truncated, true)

  const unknown = extractFormulas('plain prose', { dialect: 'unknown' })
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0].unverifiable, true)
  assert.equal(unknown[0].raw, 'plain prose')
})

test('spreadsheet formulas extract cell, range, name and sheet references without evaluation', () => {
  const references = collectSpreadsheetReferences('SUM(A1:B2) + C3 * rate + Sheet2!D4')
  assert.deepEqual(references.references.map((reference) => `${reference.kind}:${reference.sheet ?? ''}:${reference.start}`), [
    'range::A1',
    'cell::C3',
    'name::rate',
    'cell:Sheet2:D4',
  ])
  const [formula] = extractSpreadsheetFormulas([{ address: 'B1', text: '=SUM(A1:B2)' }])
  assert.equal(formula.dialect, 'spreadsheet')
  assert.equal(formula.delimiter, 'cell')
  assert.equal(formula.container, 'cell')
  assert.equal(formula.semantics, 'computes')
  assert.equal(formula.address, 'B1')
  assert.deepEqual(formula.references.map((reference) => reference.kind), ['range'])

  const [external] = extractSpreadsheetFormulas([{ address: 'B2', text: '=[Book1]Sheet1!A1' }])
  assert.equal(external.unverifiable, true)
  assert.deepEqual(external.references, [])

  const [unit] = extractSpreadsheetFormulas([{ address: 'B3', text: 'plain text' }])
  assert.equal(unit, undefined)
})

test('MathML and OMML detection only marks formulas unverifiable', () => {
  const markup = detectMarkupFormulas('<math><mfrac><mi>a</mi><mi>b</mi></mfrac></math><m:oMath><m:r>x</m:r></m:oMath>')
  assert.deepEqual(markup.map((formula) => formula.dialect), ['mathml', 'omml'])
  assert.ok(markup.every((formula) => formula.unverifiable === true))
})

/* ------------------------------------------------------------------------- *
 * Dependency graph
 * ------------------------------------------------------------------------- */

test('dependency path normalisation, resolution and external classification', () => {
  assert.equal(normalizePath('./a/../b'), 'b')
  assert.equal(normalizePath('a\\b\\..\\c'), 'a/c')
  assert.equal(normalizePath('/a/./b/../c'), '/a/c')
  assert.equal(normalizePath('C:\\work\\..\\x'), 'C:/x')
  assert.equal(normalizePath('../../x'), '../../x')

  assert.equal(resolveSpecifier('./b', 'src/a.ts'), 'src/b')
  assert.equal(resolveSpecifier('../shared/c', 'src/host/a.ts'), 'src/shared/c')
  assert.equal(resolveSpecifier('./b'), 'b')
  assert.equal(resolveSpecifier('/abs/d', 'src/a.ts'), '/abs/d')
  assert.equal(resolveSpecifier('react', 'src/a.ts'), undefined)
  assert.equal(resolveSpecifier('https://x/y', 'src/a.ts'), undefined)
  assert.equal(resolveSpecifier('#frag', 'src/a.ts'), undefined)
  assert.equal(resolveSpecifier('../../../escape', 'a.ts'), undefined)

  assert.equal(classifySpecifier('./a'), 'relative')
  assert.equal(classifySpecifier('/a'), 'absolute')
  assert.equal(classifySpecifier('react'), 'external')
  assert.equal(classifySpecifier('#x'), 'fragment')
  assert.equal(isExternalSpecifier('node:fs'), true)
  assert.equal(isExternalSpecifier('data:text/plain,x'), true)
})

function dependencyFixture(): DependencyGraphResult {
  return createDependencyGraph([
    {
      path: 'src/a.ts',
      references: [
        { kind: 'import', specifier: './b.ts', external: false, span: { start: 0, end: 0, line: 1, column: 1 } },
        { kind: 'import', specifier: 'react', external: true, span: { start: 0, end: 0, line: 1, column: 1 } },
      ],
    },
    {
      path: 'src/b.ts',
      references: [
        { kind: 'import', specifier: './c.ts', external: false, span: { start: 0, end: 0, line: 1, column: 1 } },
        { kind: 'import', specifier: '../missing.ts', external: false, span: { start: 0, end: 0, line: 1, column: 1 } },
      ],
    },
    {
      path: 'src/c.ts',
      references: [
        { kind: 'import', specifier: './a.ts', external: false, span: { start: 0, end: 0, line: 1, column: 1 } },
      ],
    },
  ])
}

test('dependency graph builds edges, filters externals and reports counts', () => {
  const result = dependencyFixture()
  assert.equal(result.counts.files, 3)
  assert.equal(result.counts.references, 5)
  assert.equal(result.counts.edges, 4)
  assert.equal(result.counts.external, 1)
  assert.equal(result.counts.vertices, 4) // src/a, src/b, src/c, missing.ts
  assert.deepEqual(
    result.external.map((entry) => entry.specifier),
    ['react'],
  )
  assert.ok(result.graph.hasEdge('src/a.ts', 'src/b.ts'))
  assert.ok(result.graph.hasEdge('src/b.ts', 'src/c.ts'))
  assert.ok(result.graph.hasEdge('src/b.ts', 'missing.ts'))
  assert.equal(result.counts.isolated, 0)
})

test('topological order, cycles and dependency levels report legal results', () => {
  const cyclic = dependencyFixture()
  const cycle = topologicalOrder(cyclic.graph)
  assert.equal(cycle.order, null)
  assert.ok((cycle.cycle?.length ?? 0) >= 3)
  assert.ok(cycle.cycle?.includes('src/a.ts'))
  const levels = dependencyLevels(cyclic.graph)
  assert.equal(levels.levels, null)
  assert.ok((levels.cycle?.length ?? 0) >= 3)

  const acyclic = createDependencyGraph([
    { path: 'a.ts', references: [{ kind: 'import', specifier: './b.ts', external: false, span: { start: 0, end: 0, line: 1, column: 1 } }] },
    { path: 'b.ts', references: [{ kind: 'import', specifier: './c.ts', external: false, span: { start: 0, end: 0, line: 1, column: 1 } }] },
    { path: 'c.ts', references: [] },
    { path: 'orphan.ts', references: [] },
  ])
  const order = topologicalOrder(acyclic.graph)
  assert.deepEqual(order.order, ['a.ts', 'orphan.ts', 'b.ts', 'c.ts'])
  assert.equal(order.cycle, null)
  const levelResult = dependencyLevels(acyclic.graph)
  assert.equal(levelResult.cycle, null)
  assert.equal(levelResult.levels?.get('a.ts'), 0)
  assert.equal(levelResult.levels?.get('b.ts'), 1)
  assert.equal(levelResult.levels?.get('c.ts'), 2)
  assert.deepEqual(isolatedVertices(acyclic.graph), ['orphan.ts'])
  assert.deepEqual(graphCounts(acyclic.graph), {
    vertices: 4,
    edges: 2,
    sources: 2,
    sinks: 2,
    isolated: 1,
  })
})

test('dependency graph fails closed at lowered caps', () => {
  const vertexLimited = createDependencyGraph(
    [
      { path: 'a.ts', references: [] },
      { path: 'b.ts', references: [] },
      { path: 'c.ts', references: [] },
    ],
    { maxVertices: 2 },
  )
  assert.equal(vertexLimited.truncated, true)
  assert.ok(vertexLimited.diagnostics.some((diagnostic) => diagnostic.code === 'graph-limit'))
  assert.equal(vertexLimited.graph.vertexCount, 2)

  const edgeLimited = createDependencyGraph(
    [
      {
        path: 'a.ts',
        references: [
          { kind: 'import', specifier: './b.ts', external: false, span: { start: 0, end: 0, line: 1, column: 1 } },
          { kind: 'import', specifier: './c.ts', external: false, span: { start: 0, end: 0, line: 1, column: 1 } },
        ],
      },
      { path: 'b.ts', references: [] },
      { path: 'c.ts', references: [] },
    ],
    { maxEdges: 1 },
  )
  assert.equal(edgeLimited.truncated, true)
  assert.equal(edgeLimited.graph.edgeCount, 1)
})

/* ------------------------------------------------------------------------- *
 * Parse cache
 * ------------------------------------------------------------------------- */

test('parse cache keys on path+mtime+size+parserId and evicts LRU entries', () => {
  const cache = new ParseCache(2)
  const parse = jsResult('const a = 1\n')
  const base = { path: 'src/a.ts', mtime: 1, size: 10, parserId: 'javascript' }
  cache.set(base, parse)
  assert.equal(cache.get(base), parse)
  assert.equal(cache.stats().hits, 1)

  assert.equal(cache.get({ ...base, mtime: 2 }), undefined)
  assert.equal(cache.get({ ...base, size: 11 }), undefined)
  assert.equal(cache.get({ ...base, parserId: 'javascript@2' }), undefined)
  assert.equal(cache.stats().misses, 3)

  cache.set({ path: 'src/b.ts', mtime: 1, size: 10, parserId: 'javascript' }, parse)
  cache.set({ path: 'src/c.ts', mtime: 1, size: 10, parserId: 'javascript' }, parse)
  assert.equal(cache.size, 2)
  assert.equal(cache.has(base), false)
  assert.equal(cache.stats().evictions, 1)
  assert.equal(cache.delete({ path: 'src/c.ts', mtime: 1, size: 10, parserId: 'javascript' }), true)
  cache.clear()
  assert.equal(cache.size, 0)
})

/* ------------------------------------------------------------------------- *
 * Byte/line ranges, fingerprints and charset
 * ------------------------------------------------------------------------- */

test('SourceMap agrees on bytes, lines and columns for CRLF/LF/BOM/last line', () => {
  const crlf = new SourceMap('a\r\nb\nc')
  assert.deepEqual(crlf.rangeFor({ start: 3, end: 4, line: 2, column: 1 }), {
    bytes: { start: 3, end: 4 },
    lines: { start: 2, end: 2 },
    columns: { start: 1, end: 2 },
  })
  assert.deepEqual(crlf.rangeFor({ start: 5, end: 6, line: 3, column: 1 }).lines, { start: 3, end: 3 })
  // Last line without a newline counts.
  assert.equal(crlf.lineAt(5), 3)
  assert.equal(crlf.byteLength, 6)
  assert.equal(utf8ByteLength('a\r\nb\nc'), 6)

  const bom = new SourceMap('\uFEFFa')
  assert.equal(bom.byteAt(0), 0)
  assert.equal(bom.byteAt(1), 3)
  assert.equal(bom.byteLength, 4)
  assert.deepEqual(bom.rangeFor({ start: 1, end: 2, line: 1, column: 2 }), {
    bytes: { start: 3, end: 4 },
    lines: { start: 1, end: 1 },
    columns: { start: 2, end: 3 },
  })

  const unicode = new SourceMap('é中😀')
  assert.equal(unicode.byteLength, 2 + 3 + 4)
  assert.deepEqual(unicode.rangeFor({ start: 0, end: 3, line: 1, column: 1 }).bytes, { start: 0, end: 9 })
})

test('detectCharset recognises BOM order, ASCII and invalid UTF-8', () => {
  assert.equal(detectCharset(new Uint8Array([0x61, 0x62])).charset, 'ascii')
  assert.equal(detectCharset(new TextEncoder().encode('héllo')).charset, 'utf-8')
  const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61])
  assert.equal(detectCharset(utf8Bom).charset, 'utf-8-bom')
  assert.equal(detectCharset(utf8Bom).bomBytes, 3)
  assert.equal(detectCharset(new Uint8Array([0xff, 0xfe, 0x61, 0x00])).charset, 'utf-16le-bom')
  assert.equal(detectCharset(new Uint8Array([0xfe, 0xff, 0x00, 0x61])).charset, 'utf-16be-bom')
  assert.equal(
    detectCharset(new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00])).charset,
    'utf-32le-bom',
  )
  const invalid = detectCharset(new Uint8Array([0xff, 0xfe, 0xfd, 0x80, 0x00]))
  assert.equal(invalid.charset, 'utf-16le-bom')
  const binary = detectCharset(new Uint8Array([0x00, 0x01, 0x02, 0x03]))
  assert.equal(binary.charset, 'binary')
  assert.equal(binary.binary, true)
})

test('BOM is excluded from every fragment range but counts in file bytes and charset', () => {
  const source = '\uFEFFexport function bom() {}\n'
  const result = jsResult(source, 'src/bom.ts')
  assert.equal(result.charset, 'utf-8-bom')
  assert.equal(result.bomBytes, 3)
  const node = nodeNamed(result, 'bom')
  assert.ok(node !== undefined)
  assert.equal(node.byteStart, 3)
  assert.equal(node.lineStart, 1)
  assert.equal(node.byteEnd, utf8ByteLength(source) - 1) // trailing "\n" is not in the symbol
  const fragmentText = source.slice(node.span.start, node.span.end)
  assert.equal(node.fingerprint, fragmentSha(fragmentText))
  assert.ok((node.byteStart ?? 0) >= (result.bomBytes ?? 0))
})

test('a non-UTF-8 declared charset produces bytes and fingerprint only, with unverifiable lines', () => {
  const result = parseFileText('docs/legacy.tex', String.raw`\begin{theorem}\label{thm:x}x\end{theorem}`, {
    charset: 'utf-16le',
  })
  assert.ok(result !== undefined)
  assert.equal(result.charset, 'utf-16le')
  assert.equal(result.bomBytes, 0)
  const node = result.nodes?.find((entry) => entry.kind === 'theorem')
  assert.ok(node !== undefined)
  assert.equal(node.lineStart, undefined)
  assert.equal(node.lineEnd, undefined)
  assert.ok((node.byteStart ?? -1) >= 0)
  assert.ok((node.fingerprint ?? '').startsWith('sha256:'))
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'unverifiable'))

  const unrepresentable = new SourceMap('a\ud800b')
  assert.equal(unrepresentable.representable, false)
  const range = unrepresentable.rangeFor({ start: 0, end: 3, line: 1, column: 1 })
  assert.equal(range.lines, undefined)
  assert.ok(range.bytes.end > 0)
})

test('fingerprints are stable for unchanged fragments and change on an inside edit', () => {
  const original = 'export function value() { return 1 }\n'
  const first = jsResult(original, 'src/f.ts')
  const inserted = '// header\n' + original
  const shifted = jsResult(inserted, 'src/f.ts')
  const edited = 'export function value() { return 2 }\n'
  const changed = jsResult(edited, 'src/f.ts')

  const firstNode = nodeNamed(first, 'value')
  const shiftedNode = nodeNamed(shifted, 'value')
  const changedNode = nodeNamed(changed, 'value')
  assert.ok(firstNode !== undefined && shiftedNode !== undefined && changedNode !== undefined)
  assert.equal(shiftedNode.fingerprint, firstNode.fingerprint)
  assert.notEqual(changedNode.fingerprint, firstNode.fingerprint)
  assert.ok((shiftedNode.byteStart ?? 0) > (firstNode.byteStart ?? 0))
  assert.equal(shiftedNode.lineStart, 2)
})

test('reference paths reject traversal and absolute targets', () => {
  assert.throws(() => createNodeReference({ scheme: 'file', target: '../secret', path: '../secret' }))
  assert.throws(() => createNodeReference({ scheme: 'file', target: 'C:/x', path: 'C:/x' }))
  assert.throws(() => createNodeReference({ scheme: 'file', target: '/etc/passwd', path: '/etc/passwd' }))
  assert.throws(() => createNodeReference({ scheme: 'url', target: 'file:///etc/passwd' }))
  const valid = createNodeReference({
    scheme: 'symbol',
    path: './src/a.ts',
    target: 'function:f',
    bytes: { start: 0, end: 4 },
    lines: { start: 1, end: 1 },
    charset: 'utf-8',
  })
  assert.equal(valid.path, 'src/a.ts')
  assert.equal(valid.charset, 'utf-8')
  assert.equal(valid.encoding, 'utf-8')

  // A hostile path is ignored rather than trusting it for references.
  const result = parseFileText('../outside.ts', 'export const x = 1\n')
  assert.ok(result !== undefined)
  assert.equal(result.nodes?.[0]?.path, undefined)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'parse-error'))
})

test('nested fragments keep byte and line containment', () => {
  const source = ['::: outer', '::: inner', 'body line', ':::', ':::', ''].join('\n')
  const result = mdResult(source, 'docs/nested.md')
  const outer = result.divs.find((div) => div.name === 'outer')
  const inner = result.divs.find((div) => div.name === 'inner')
  assert.ok(outer !== undefined && inner !== undefined)
  assert.equal(inner.depth, 2)
  assert.ok((outer.byteStart ?? 0) <= (inner.byteStart ?? 0))
  assert.ok((outer.byteEnd ?? 0) >= (inner.byteEnd ?? 0))
  assert.ok((outer.lineStart ?? 0) <= (inner.lineStart ?? 0))
  assert.ok((outer.lineEnd ?? 0) >= (inner.lineEnd ?? 0))
  assert.ok((outer.byteStart ?? -1) >= 0)
  assert.equal(outer.fingerprint, fragmentSha(source.slice(outer.span.start, outer.span.end)))
})

test('metadata nodes carry no body/content/text field', () => {
  const source = 'export function leak() { return "SECRET_BODY_MARKER" }\n'
  const result = jsResult(source)
  assert.ok(result.nodes !== undefined)
  for (const node of result.nodes) {
    assert.equal('content' in node, false)
    assert.equal('contentRef' in node, false)
    assert.equal('text' in node, false)
    assert.equal('body' in node, false)
    assert.ok(!JSON.stringify(node).includes('SECRET_BODY_MARKER'))
  }
  for (const comment of result.comments) {
    assert.equal('content' in comment, false)
    assert.ok((comment.brief?.length ?? 0) <= MAX_BRIEF_LENGTH)
  }
})

test('reparsing the same text is deterministic and refresh recomputes ranges', () => {
  const source = '# Title\n\n[link](docs/a.md) and $x$\n'
  const first = mdResult(source, 'docs/same.md')
  const second = mdResult(source, 'docs/same.md')
  assert.deepEqual(first.nodes, second.nodes)
  assert.deepEqual(first.references, second.references)
  const refreshed = refreshFileText('docs/same.md', source)
  assert.deepEqual(refreshed?.nodes, first.nodes)
  assert.deepEqual(refreshed?.references, first.references)
})

/* ------------------------------------------------------------------------- *
 * Complexity smoke
 * ------------------------------------------------------------------------- */

test('O(n) smoke: tokenizing and parsing 100k characters stays bounded', () => {
  const imports = Array.from({ length: 500 }, (_, index) => `import { x${index} } from './mod${index}'`).join('\n')
  const filler = 'const value = 1\n'.repeat(6_000)
  const source = `${imports}\n${filler}`
  assert.ok(source.length >= 100_000)
  const start = Date.now()
  const result = jsResult(source, 'src/large.ts')
  const elapsed = Date.now() - start
  assert.ok(result.references.length >= 500)
  assert.ok(result.tokens > 0)
  assert.ok(elapsed < 3_000, `parse took ${elapsed} ms`)
  assert.ok(elapsed >= 0)
})
