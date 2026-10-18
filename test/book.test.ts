/**
 * Contract tests for the book/literature ecosystem parser (`src/host/text/book.ts`).
 *
 * The parser is the only producer of the book taxonomy in the text layer, so
 * these tests pin the two explicit structures it accepts and the strict
 * `unverifiable`-instead-of-guess behaviour around them:
 *
 *  - a `SUMMARY.md`-style table of contents: depth 1/2/3+ → part/chapter/section,
 *    link text → name, link target → locator/reference;
 *  - front matter: `type: book|article`, authors → `person`, venue keys →
 *    `venue`, every value explicit and body-free;
 *  - malformed input (unterminated front matter) reports a diagnostic and never
 *    throws; markdown/html prose without front matter produces no `article`.
 *
 * Everything here is text-in/result-out: no filesystem, no network, no model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOOK_EXTENSIONS,
  BOOK_FILENAMES,
  BookParser,
  MAX_FRONT_MATTER_LINES,
  bookParser,
  parseBook,
} from '../src/host/text/book.js'
import { MAX_METADATA_NODES, ParserRegistry } from '../src/host/text/parser.js'
import type { NodeMetadata } from '../src/host/text/parser.js'

const SUMMARY_PATH = 'books/SUMMARY.md'

function parseSummary(source: string): ReturnType<typeof parseBook> {
  return parseBook(source, { path: SUMMARY_PATH })
}

function kinds(nodes: readonly NodeMetadata[]): string[] {
  return nodes.map((node) => node.kind)
}

function names(nodes: readonly NodeMetadata[]): (string | undefined)[] {
  return nodes.map((node) => node.name)
}

function locators(nodes: readonly NodeMetadata[]): (string | undefined)[] {
  return nodes.map((node) => node.locator)
}

/** Structural concept levels (`ConceptMetadata` also covers sheet/cell concepts). */
function conceptLevels(nodes: readonly NodeMetadata[]): (number | undefined)[] {
  return nodes.map((node) => {
    const domain = node.domain
    return domain !== undefined && 'level' in domain ? domain.level : undefined
  })
}

/* ------------------------------------------------------------------------- *
 * Table of contents
 * ------------------------------------------------------------------------- */

test('SUMMARY depth maps to part/chapter/section with names, locators and references', () => {
  const source = [
    '# Summary',
    '',
    '- [Part I](part-i.md)',
    '  - [Chapter 1](ch1.md)',
    '    - [Section 1.1](ch1.md#s11)',
    '  - [Chapter 2](./ch2.md)',
    '',
    'Prose after the list is not a book structure.',
  ].join('\n')
  const result = parseSummary(source)
  const nodes = result.nodes ?? []

  assert.deepEqual(kinds(nodes), ['part', 'chapter', 'section', 'chapter'])
  assert.deepEqual(names(nodes), ['Part I', 'Chapter 1', 'Section 1.1', 'Chapter 2'])
  assert.deepEqual(locators(nodes), [
    'part:part-i.md',
    'chapter:ch1.md',
    'section:ch1.md#s11',
    'chapter:./ch2.md',
  ])

  // The link target is the body-free pointer; the flat coordinates stay on the
  // SUMMARY.md listing line that produced the node.
  assert.deepEqual(
    nodes.map((node) => node.reference?.scheme),
    ['file', 'file', 'file', 'file'],
  )
  assert.deepEqual(
    nodes.map((node) => node.reference?.path),
    ['books/part-i.md', 'books/ch1.md', 'books/ch1.md', 'books/ch2.md'],
  )
  assert.deepEqual(
    nodes.map((node) => node.reference?.target),
    ['books/part-i.md', 'books/ch1.md', 'books/ch1.md', 'books/ch2.md'],
  )
  for (const node of nodes) {
    assert.equal(node.path, SUMMARY_PATH)
    assert.equal(typeof node.byteStart, 'number')
    assert.equal(typeof node.byteEnd, 'number')
    assert.ok((node.fingerprint ?? '').startsWith('sha256:'))
    assert.equal(typeof node.lineStart, 'number')
  }

  // Nesting is recorded as locators, never as public handles.
  assert.equal(nodes[0]?.domain?.partOf, undefined)
  assert.equal(nodes[1]?.domain?.partOf, 'part:part-i.md')
  assert.equal(nodes[2]?.domain?.partOf, 'chapter:ch1.md')
  assert.equal(nodes[3]?.domain?.partOf, 'part:part-i.md')

  // The syntactic links are exposed as references for the dependency layer.
  assert.deepEqual(
    result.references.map((reference) => `${reference.kind}:${reference.specifier}`),
    [
      'markdown-link:part-i.md',
      'markdown-link:ch1.md',
      'markdown-link:ch1.md#s11',
      'markdown-link:./ch2.md',
    ],
  )
  for (const reference of result.references) {
    assert.equal(reference.external, false)
    assert.ok((reference.fingerprint ?? '').startsWith('sha256:'))
  }

  assert.deepEqual(
    result.toc.map((entry) => `${entry.kind}:${entry.level}:${entry.locator}`),
    [
      'part:1:part:part-i.md',
      'chapter:2:chapter:ch1.md',
      'section:3:section:ch1.md#s11',
      'chapter:2:chapter:./ch2.md',
    ],
  )
  assert.deepEqual(result.diagnostics, [])
  assert.equal(result.truncated, false)
})

test('deeper sections and duplicate targets keep deterministic unique locators', () => {
  const source = [
    '- [Part](p.md)',
    '  - [Chapter](c.md)',
    '    - [Section A](c.md#a)',
    '      - [Subsection](c.md#b)',
    '    - [Section A again](c.md#a)',
  ].join('\n')
  const result = parseBook(source, { path: SUMMARY_PATH })
  const nodes = result.nodes ?? []

  assert.deepEqual(kinds(nodes), ['part', 'chapter', 'section', 'section', 'section'])
  assert.deepEqual(locators(nodes), [
    'part:p.md',
    'chapter:c.md',
    'section:c.md#a',
    'section:c.md#b',
    'section:c.md#a~2',
  ])
  assert.deepEqual(conceptLevels(nodes), [1, 2, 3, 4, 3])
})

test('TOC targets: https links become url references, anchors and escaping targets stay locator-only', () => {
  const source = [
    '- [Web](https://example.com/ch)',
    '  - [Anchor](#intro)',
    '    - [Escape](../../outside.md)',
    '  - [Drive](C:\\notes.md)',
  ].join('\n')
  const result = parseBook(source, { path: SUMMARY_PATH })
  const nodes = result.nodes ?? []

  assert.deepEqual(kinds(nodes), ['part', 'chapter', 'section', 'chapter'])
  assert.equal(nodes[0]?.reference?.scheme, 'url')
  assert.equal(nodes[0]?.reference?.target, 'https://example.com/ch')
  assert.equal(nodes[0]?.reference?.external, true)
  for (const node of nodes.slice(1)) {
    assert.equal(node.reference, undefined)
  }
  assert.deepEqual(locators(nodes), [
    'part:https://example.com/ch',
    'chapter:#intro',
    'section:../../outside.md',
    'chapter:C:\\notes.md',
  ])

  // Without the TOC file's workspace path there is no explicit base for a
  // relative target, so no file reference is fabricated.
  const withoutPath = parseBook('- [Part](p.md)')
  assert.equal(withoutPath.nodes?.[0]?.kind, 'part')
  assert.equal(withoutPath.nodes?.[0]?.reference, undefined)
  assert.equal(withoutPath.nodes?.[0]?.locator, 'part:p.md')
})

test('front matter beyond the line cap is rejected without trusting partial values', () => {
  const lines = ['---']
  for (let index = 0; index < MAX_FRONT_MATTER_LINES; index += 1) {
    lines.push(`key${index}: value${index}`)
  }
  lines.push('---', '- [Part](p.md)')
  const result = parseBook(lines.join('\n'), { path: SUMMARY_PATH })

  // The block is malformed (out of budget), so no front-matter value is
  // trusted; the real TOC line after it is still an explicit structure.
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'unverifiable'))
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes('front matter')))
  assert.equal(result.nodes?.length, 1)
  assert.equal(result.nodes?.[0]?.kind, 'part')
  assert.equal(result.frontMatter.length, 0)
})

test('node emission stops at MAX_METADATA_NODES', () => {
  const entries = MAX_METADATA_NODES + 25
  const source = Array.from({ length: entries }, (_, index) => `- [P${index}](p${index}.md)`).join('\n')
  const result = parseBook(source, { path: SUMMARY_PATH })

  assert.equal(result.nodes?.length, MAX_METADATA_NODES)
  assert.equal(result.truncated, true)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'node-limit'))
  assert.equal(
    result.nodes?.[MAX_METADATA_NODES - 1]?.locator,
    `part:p${MAX_METADATA_NODES - 1}.md`,
  )
})

/* ------------------------------------------------------------------------- *
 * Front matter
 * ------------------------------------------------------------------------- */

test('front matter type: book yields a book node, one person per author and a venue', () => {
  const source = [
    '---',
    'type: book',
    'title: The Book of Parsers',
    'author: Ada Lovelace, Alan Turing',
    'venue: Mémoires',
    '---',
    '',
    '- [Part I](part-i.md)',
  ].join('\n')
  const result = parseSummary(source)
  const nodes = result.nodes ?? []

  assert.deepEqual(kinds(nodes), ['book', 'person', 'person', 'venue', 'part'])
  const [book, firstAuthor, secondAuthor, venue, part] = nodes

  assert.equal(book?.name, 'The Book of Parsers')
  assert.equal(book?.label, 'book')
  assert.equal(book?.locator, 'book:1')

  assert.deepEqual([firstAuthor?.name, secondAuthor?.name], ['Ada Lovelace', 'Alan Turing'])
  assert.deepEqual([firstAuthor?.label, secondAuthor?.label], ['author', 'author'])
  assert.deepEqual(locators([firstAuthor, secondAuthor]), ['person:author:1', 'person:author:2'])

  assert.equal(venue?.name, 'Mémoires')
  assert.equal(venue?.label, 'venue')
  assert.equal(venue?.locator, 'venue:1')
  assert.equal(venue?.domain?.kind, 'venue')
  assert.equal(part?.kind, 'part')

  assert.equal(result.document?.form, 'book')
  assert.equal(result.document?.source, 'front-matter')
  assert.equal(result.document?.title, 'The Book of Parsers')
  assert.equal(result.document?.author, 'Ada Lovelace, Alan Turing')
  assert.equal(result.document?.metadata?.type, 'book')
})

test('front matter type: article yields an article; markdown/html text without front matter yields none', () => {
  const article = parseSummary([
    '---',
    'type: article',
    'title: On the Parsing of Books',
    'author: Grace Hopper; Barbara Liskov',
    'journal: Journal of Test Parsers',
    '---',
  ].join('\n'))
  const nodes = article.nodes ?? []
  assert.deepEqual(kinds(nodes), ['article', 'person', 'person', 'venue'])
  assert.equal(nodes[0]?.kind, 'article')
  assert.equal(nodes[0]?.name, 'On the Parsing of Books')
  assert.equal(nodes[0]?.label, 'article')
  assert.equal(nodes[0]?.locator, 'article:1')
  assert.deepEqual([nodes[1]?.name, nodes[2]?.name], ['Grace Hopper', 'Barbara Liskov'])
  assert.equal(nodes[3]?.kind, 'venue')
  assert.equal(nodes[3]?.name, 'Journal of Test Parsers')
  assert.equal(nodes[3]?.label, 'journal')
  assert.equal(article.document?.form, 'article')

  const prose = [
    '# A Markdown Article',
    '',
    'This is prose about an article, not a book, and it names a chapter.',
  ].join('\n')
  const html = [
    '<article>',
    '  <h1>HTML article element</h1>',
    '  <p>Not a publication article.</p>',
    '</article>',
  ].join('\n')
  for (const [text, path] of [
    [prose, 'docs/note.md'],
    [html, 'docs/note.html'],
  ] as const) {
    const result = parseBook(text, { path })
    assert.ok(
      !(result.nodes ?? []).some((node) => node.kind === 'article'),
      `${path} must not produce an article without explicit front matter`,
    )
    assert.equal(result.nodes, undefined)
  }
})

test('unterminated front matter reports an unverifiable diagnostic and never throws', () => {
  const source = ['---', 'type: book', 'title: Never Closed'].join('\n')
  let result: ReturnType<typeof parseBook> | undefined
  assert.doesNotThrow(() => {
    result = parseBook(source, { path: SUMMARY_PATH })
  })
  assert.ok(result !== undefined)

  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'unverifiable'))
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes('front matter')))
  assert.equal(result.nodes, undefined)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.frontMatter, [])
  assert.deepEqual(result.toc, [])
})

test('nodes stay body-free: no prose fields, capped names and flat file coordinates', () => {
  const longTitle = `Title ${'x'.repeat(400)}`
  const source = [
    '---',
    'type: article',
    `title: ${longTitle}`,
    'author: Ada Lovelace, Alan Turing',
    'publisher: Test Press',
    '---',
    '- [Chapter 1](ch1.md)',
  ].join('\n')
  const result = parseBook(source, { path: SUMMARY_PATH })
  const nodes = result.nodes ?? []

  assert.equal(nodes.length, 5)
  for (const node of nodes) {
    // Only name/label/locator/reference-style metadata; never a body excerpt.
    assert.equal(node.brief, undefined)
    assert.equal(node.description, undefined)
    assert.equal(node.summary, undefined)
    assert.equal(node.usage, undefined)
    assert.equal(node.purpose, undefined)
    assert.ok((node.name ?? '').length <= 200)
    assert.equal(node.path, SUMMARY_PATH)
    assert.ok((node.byteStart ?? -1) >= 0)
    assert.ok((node.byteEnd ?? -1) >= (node.byteStart ?? 0))
    assert.ok((node.fingerprint ?? '').startsWith('sha256:'))
    assert.ok((node.lineStart ?? 0) >= 1)
    assert.ok((node.lineEnd ?? 0) >= (node.lineStart ?? 0))
  }
})

/* ------------------------------------------------------------------------- *
 * Parser identity
 * ------------------------------------------------------------------------- */

test('BookParser claims id book, the .book extension and the SUMMARY file names', () => {
  assert.equal(bookParser.id, 'book')
  assert.deepEqual([...BOOK_EXTENSIONS], ['.book'])
  assert.deepEqual([...bookParser.extensions], [...BOOK_EXTENSIONS])
  assert.deepEqual([...BOOK_FILENAMES], ['summary.md', 'summary.txt'])
  assert.deepEqual([...(bookParser.filenames ?? [])], [...BOOK_FILENAMES])

  const registry = new ParserRegistry().register(bookParser)
  assert.equal(registry.resolve('docs/SUMMARY.md')?.id, 'book')
  assert.equal(registry.resolve('books/summary.txt')?.id, 'book')
  assert.equal(registry.resolve('books/story.book')?.id, 'book')
  assert.equal(registry.resolve('docs/readme.md'), undefined)
  assert.equal(registry.resolve('books/story.txt'), undefined)

  const viaClass = new BookParser().parse('- [Part](p.md)\n', { path: SUMMARY_PATH })
  assert.deepEqual(viaClass.nodes?.map((node) => node.kind), ['part'])
})
