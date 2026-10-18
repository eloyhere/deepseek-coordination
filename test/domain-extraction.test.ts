/**
 * Domain extraction tests: Book/Article hierarchy, Person/Venue, Condition,
 * statement proof status, and the bounded CSV/TSV office surface.
 *
 * Every fixture asserts body-free metadata only: names, kinds, forms, status,
 * locators (`partOf`/`contains`) and A1 addresses. A file body marker never
 * appears in the result JSON.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  domainNodesOf,
  MarkdownParser,
  parseFileText,
  parseText,
  structuralLocator,
} from '../src/host/text/index.js'
import type {
  DelimitedParseResult,
  HtmlParseResult,
  MarkdownParseResult,
  NodeMetadata,
  ParseResult,
  TexParseResult,
} from '../src/host/text/index.js'
import type { JavaScriptParseResult } from '../src/host/text/javascript.js'
import { isStatementKind, isStructuralKind } from '../src/shared/enum.js'
import type { ConceptMetadata, OfficeConcept, StructuralConcept } from '../src/shared/entity.js'

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

function md(source: string, path = 'docs/book.md'): MarkdownParseResult {
  const result = parseFileText(path, source)
  assert.ok(result !== undefined, 'markdown parser must be registered')
  return result as MarkdownParseResult
}

function html(source: string, path = 'docs/page.html'): HtmlParseResult {
  const result = parseFileText(path, source)
  assert.ok(result !== undefined, 'html parser must be registered')
  return result as HtmlParseResult
}

function tex(source: string, path = 'docs/main.tex'): TexParseResult {
  const result = parseFileText(path, source)
  assert.ok(result !== undefined, 'latex parser must be registered')
  return result as TexParseResult
}

function js(source: string, path = 'src/a.ts'): JavaScriptParseResult {
  const result = parseFileText(path, source)
  assert.ok(result !== undefined, 'javascript parser must be registered')
  return result as JavaScriptParseResult
}

function csv(source: string, path = 'data/table.csv'): DelimitedParseResult {
  const result = parseFileText(path, source)
  assert.ok(result !== undefined, 'csv parser must be registered')
  return result as DelimitedParseResult
}

function nodesOfKind(result: ParseResult, kind: string): NodeMetadata[] {
  return (result.nodes ?? []).filter((node) => node.kind === kind)
}

function domainOf(node: NodeMetadata | undefined): StructuralConcept | undefined {
  if (node?.domain === undefined) return undefined
  return node.domain as StructuralConcept
}

function officeOf(node: NodeMetadata | undefined): OfficeConcept | undefined {
  if (node?.domain === undefined) return undefined
  return node.domain as OfficeConcept
}

/** Assert no node carries body-ish fields or the supplied body marker. */
function assertBodyFree(result: ParseResult, marker?: string): void {
  for (const node of result.nodes ?? []) {
    assert.equal('content' in node, false)
    assert.equal('text' in node, false)
    assert.equal('body' in node, false)
    assert.equal('ast' in node, false)
  }
  if (marker !== undefined) assert.ok(!JSON.stringify(result.nodes).includes(marker))
}

/* ------------------------------------------------------------------------- *
 * Markdown Book/Article + Person/Venue
 * ------------------------------------------------------------------------- */

test('Markdown book front matter emits Book, Person, Venue and Chapter/Section hierarchy', () => {
  const marker = 'SECRET_BOOK_BODY_2f91'
  const source = [
    '---',
    'title: Systems Book',
    'form: book',
    'author: Ada Lovelace, Alan Turing',
    'editor: Grace Hopper',
    'venue: Journal of Systems',
    'doi: 10.1000/xyz',
    '---',
    '',
    '# Foundations',
    '',
    `Intro paragraph ${marker}.`,
    '',
    '## First Principle',
    '',
    'Details.',
    '',
    '# Applications',
    '',
    'More.',
  ].join('\n')
  const result = md(source, 'docs/book.md')
  assertBodyFree(result, marker)

  const books = nodesOfKind(result, 'book')
  assert.equal(books.length, 1)
  const book = books[0]
  assert.equal(book.name, 'Systems Book')
  const bookDomain = domainOf(book)
  assert.ok(bookDomain !== undefined)
  assert.equal(bookDomain.kind, 'book')
  assert.equal(bookDomain.explicit, true)
  assert.deepEqual(bookDomain.authors, ['Ada Lovelace', 'Alan Turing'])
  assert.deepEqual(bookDomain.editors, ['Grace Hopper'])
  assert.equal(bookDomain.venue, 'Journal of Systems')
  assert.equal(bookDomain.doi, '10.1000/xyz')

  // Person nodes are explicit front-matter authorities, never invented.
  const people = nodesOfKind(result, 'person')
  assert.equal(people.length, 3)
  assert.deepEqual(people.map((node) => node.name).sort(), ['Ada Lovelace', 'Alan Turing', 'Grace Hopper'])
  const roles = people.map((node) => domainOf(node)?.role).sort()
  assert.deepEqual(roles, ['author', 'author', 'editor'])

  const venues = nodesOfKind(result, 'venue')
  assert.equal(venues.length, 1)
  assert.equal(venues[0].name, 'Journal of Systems')
  assert.equal(domainOf(venues[0])?.form, 'unknown')

  // Headings keep the P0 `heading` kind; the domain concept is chapter/section.
  const headings = nodesOfKind(result, 'heading')
  assert.equal(headings.length, 3)
  const chapterOne = domainOf(headings[0])
  const section = domainOf(headings[1])
  const chapterTwo = domainOf(headings[2])
  assert.deepEqual(
    [chapterOne?.kind, chapterOne?.form, chapterOne?.level],
    ['chapter', 'chapter', 1],
  )
  assert.deepEqual(
    [section?.kind, section?.level, section?.partOf],
    ['section', 2, chapterOne?.locator],
  )
  assert.deepEqual(
    [chapterTwo?.kind, chapterTwo?.level, chapterTwo?.ordinal],
    ['chapter', 1, 2],
  )
  // Locally proven containment, expressed as locators (never handles).
  assert.deepEqual(bookDomain.contains, [chapterOne?.locator, chapterTwo?.locator])
  assert.ok(chapterOne?.contains?.includes(section?.locator as string))

  // Paragraph concept points at its chapter.
  const paragraphs = nodesOfKind(result, 'paragraph')
  assert.ok(paragraphs.length >= 3)
  assert.equal(domainOf(paragraphs[0])?.partOf, chapterOne?.locator)
  assert.ok(chapterOne?.contains?.includes(domainOf(paragraphs[0])?.locator as string))

  // The `document` node is still the file anchor.
  assert.equal(nodesOfKind(result, 'document').length, 1)
  assert.equal(result.document?.form, 'book')
})

test('Markdown article collected in a book links partOf/contains; SUMMARY.md builds parts and chapters', () => {
  const articleResult = md(
    [
      '---',
      'form: article',
      'title: Methods',
      'book: Handbook of Methods',
      'venue: Proc. Conf',
      '---',
      '',
      '## Setup',
      '',
      'Prose.',
    ].join('\n'),
    'docs/methods.md',
  )
  const articleBook = nodesOfKind(articleResult, 'book')[0]
  const article = nodesOfKind(articleResult, 'article')[0]
  const articleDomain = domainOf(article)
  assert.ok(articleBook !== undefined && article !== undefined)
  assert.equal(articleBook.name, 'Handbook of Methods')
  assert.equal(article.name, 'Methods')
  assert.equal(articleDomain?.book, 'Handbook of Methods')
  assert.equal(articleDomain?.venue, 'Proc. Conf')
  assert.equal(articleDomain?.partOf, domainOf(articleBook)?.locator)
  assert.deepEqual(domainOf(articleBook)?.contains, [articleDomain?.locator])
  const setup = nodesOfKind(articleResult, 'heading')[0]
  assert.equal(domainOf(setup)?.partOf, articleDomain?.locator)

  // SUMMARY.md resolves to the book parser by design; this case exercises Markdown directly.
  const summary = new MarkdownParser().parse(
    [
      '# Summary',
      '',
      '# Part One',
      '',
      '- [Getting Started](ch1.md)',
      '  - [Install](ch1.md#install)',
      '- [Web](https://example.com/x)',
      '',
      '# Part Two',
      '',
      '- [Advanced](ch2.md)',
    ].join('\n'),
    { path: 'docs/SUMMARY.md' },
  )
  const summaryBook = nodesOfKind(summary, 'book')[0]
  const parts = nodesOfKind(summary, 'part')
  const chapters = nodesOfKind(summary, 'chapter')
  const sections = nodesOfKind(summary, 'section')
  assert.ok(summaryBook !== undefined)
  assert.equal(parts.length, 2)
  assert.equal(chapters.length, 2)
  assert.equal(sections.length, 1)
  assert.deepEqual(parts.map((node) => node.name), ['Part One', 'Part Two'])
  assert.deepEqual(chapters.map((node) => node.name), ['Getting Started', 'Advanced'])
  assert.equal(domainOf(chapters[0])?.target, 'ch1.md')
  assert.equal(domainOf(chapters[0])?.partOf, domainOf(parts[0])?.locator)
  assert.equal(domainOf(sections[0])?.kind, 'section')
  assert.equal(domainOf(sections[0])?.partOf, domainOf(chapters[0])?.locator)
  // A URL is not a chapter.
  assert.equal(chapters.some((node) => node.name === 'Web'), false)
  const bookContains = domainOf(summaryBook)?.contains ?? []
  for (const part of parts) {
    assert.ok(bookContains.includes(domainOf(part)?.locator as string))
  }
  const partOneContains = domainOf(parts[0])?.contains ?? []
  assert.ok(partOneContains.includes(domainOf(chapters[0])?.locator as string))
})

/* ------------------------------------------------------------------------- *
 * Markdown conditions and statement divs
 * ------------------------------------------------------------------------- */

test('Markdown contract divs and front-matter lists emit Condition nodes without inventing form', () => {
  const source = [
    '---',
    'title: Contract Spec',
    'requires: positive input; stable API',
    'meets: docs reviewed',
    '---',
    '',
    '::: chapter {#overview title="Overview"}',
    ':::',
    '',
    '::: require',
    'Only if the caller is authorized.',
    ':::',
    '',
    '::: precondition',
    'input > 0',
    ':::',
    '',
    '::: meet',
    'docs reviewed',
    ':::',
    '',
    '::: definition {#def-term}',
    'A term.',
    ':::',
    '',
    '::: note',
    'not a domain concept',
    ':::',
  ].join('\n')
  const result = md(source)
  assertBodyFree(result)

  const conditions = nodesOfKind(result, 'condition')
  assert.equal(conditions.length, 6)
  for (const condition of conditions) {
    const domain = domainOf(condition)
    assert.equal(domain?.kind, 'condition')
    assert.equal(domain?.status, 'unknown')
    assert.equal(domain?.explicit, true)
  }
  const frontRequires = conditions.filter((node) => domainOf(node)?.relation === 'requires')
  const frontMeets = conditions.filter((node) => domainOf(node)?.relation === 'meets')
  assert.equal(frontRequires.length, 4)
  assert.equal(frontMeets.length, 2)
  // `::: precondition` names its form; `::: require`/`::: meet` do not.
  const pre = conditions.find((node) => domainOf(node)?.form === 'precondition')
  assert.ok(pre !== undefined)
  assert.equal(domainOf(pre)?.relation, 'requires')
  const require = conditions.find((node) =>
    node.name === undefined && node.brief === undefined && domainOf(node)?.form === 'unknown')
  assert.ok(require !== undefined)

  const chapter = nodesOfKind(result, 'chapter')[0]
  assert.equal(chapter.name, 'Overview')
  assert.equal(chapter.label, 'overview')
  assert.equal(domainOf(chapter)?.kind, 'chapter')

  const definition = nodesOfKind(result, 'definition')[0]
  assert.ok(definition !== undefined)
  assert.equal(domainOf(definition)?.status, 'stated')
  assert.equal(isStatementKind(definition.domain?.kind), true)
  // A plain `::: note` div is not a domain node.
  assert.equal(nodesOfKind(result, 'note').length, 0)
  assert.equal(nodesOfKind(result, 'div').some((node) => node.name === 'note'), true)
})

/* ------------------------------------------------------------------------- *
 * HTML
 * ------------------------------------------------------------------------- */

test('HTML article/main/section/paragraph build a section hierarchy; a bare page does not', () => {
  const source = [
    '<!doctype html>',
    '<html><head>',
    '<title>Field Guide</title>',
    '<meta name="description" content="A short guide">',
    '</head><body>',
    '<main>',
    '<article>',
    '<h1>Field Guide</h1>',
    '<section>',
    '<h2>Birds</h2>',
    '<p>Birds are animals.</p>',
    '</section>',
    '<section>',
    '<h2>Plants</h2>',
    '<p>Plants are organisms.</p>',
    '</section>',
    '</article>',
    '</main>',
    '</body></html>',
  ].join('\n')
  const result = html(source, 'docs/guide.html')
  assertBodyFree(result)

  // `article` is a book concept: an HTML <article> element is a sectioning
  // container and maps to `document` (root level) or `section` (nested), so it
  // never produces an `article` node and no Article hierarchy is invented.
  assert.equal(nodesOfKind(result, 'article').length, 0)
  const documents = nodesOfKind(result, 'document')
  assert.equal(documents.length, 1)
  assert.equal(documents[0]?.name, 'Field Guide')
  assert.equal(nodesOfKind(result, 'chapter').length, 1)
  assert.equal(nodesOfKind(result, 'chapter')[0]?.name, 'Field Guide')

  // The root <main>/<article> pair stays transparent: the two nested
  // <section> elements are the only emitted section nodes.
  const sections = nodesOfKind(result, 'section')
  assert.equal(sections.length, 2)
  assert.deepEqual(sections.map((node) => node.name), ['Birds', 'Plants'])
  assert.deepEqual(sections.map((node) => domainOf(node)?.kind), ['section', 'section'])
  assert.equal(domainOf(sections[0])?.partOf, undefined)
  assert.equal(domainOf(sections[1])?.level, 1)

  const headings = nodesOfKind(result, 'heading')
  assert.equal(headings.length, 3)
  // The h1 belongs to the document, not to an article concept.
  assert.equal(domainOf(headings[0])?.kind, 'section')
  assert.equal(domainOf(headings[0])?.partOf, undefined)
  assert.equal(domainOf(headings[1])?.kind, 'section')
  assert.equal(domainOf(headings[1])?.partOf, undefined)
  assert.equal(domainOf(headings[1])?.locator, domainOf(sections[0])?.locator)
  assert.equal(domainOf(headings[2])?.locator, domainOf(sections[1])?.locator)

  const paragraphs = nodesOfKind(result, 'paragraph')
  assert.equal(paragraphs.length, 2)
  assert.equal(domainOf(paragraphs[0])?.partOf, domainOf(sections[0])?.locator)
  assert.equal(domainOf(paragraphs[1])?.partOf, domainOf(sections[1])?.locator)
  assert.equal(result.document?.form, 'article')

  // Negative: a page without article/main/section invents no container.
  const bare = html('<html><body><p>Just prose.</p></body></html>', 'docs/bare.html')
  assert.equal(nodesOfKind(bare, 'article').length, 0)
  assert.equal(nodesOfKind(bare, 'section').length, 0)
  assert.equal(nodesOfKind(bare, 'paragraph').length, 1)
})

/* ------------------------------------------------------------------------- *
 * LaTeX
 * ------------------------------------------------------------------------- */

test('LaTeX sectioning builds Part/Chapter/Section/Paragraph and proof status follows explicit links', () => {
  const marker = 'SECRET_TEX_BODY_77a1'
  const source = String.raw`\documentclass{book}
\title{Proofs}
\author{Ada Lovelace \and Alan Turing}
\begin{document}
\part{Foundations}
\chapter{Basics}
\section{Motivation}
\paragraph{Aside}
\begin{theorem}\label{thm:main}
Every finite set is countable. ${marker}
\end{theorem}
\begin{proof}
By \ref{thm:main}.
\end{proof}
\begin{lemma}\label{lem:open}
An unproved claim.
\end{lemma}
\begin{proof}
No reference here.
\end{proof}
\begin{axiom}\label{ax:one}
A basic assumption.
\end{axiom}
\end{document}
`
  const result = tex(source)
  assertBodyFree(result, marker)

  const books = nodesOfKind(result, 'book')
  assert.equal(books.length, 1)
  assert.equal(books[0].name, 'Proofs')
  assert.deepEqual(domainOf(books[0])?.authors, ['Ada Lovelace', 'Alan Turing'])

  const people = nodesOfKind(result, 'person')
  assert.equal(people.length, 2)
  assert.deepEqual(people.map((node) => domainOf(node)?.role), ['author', 'author'])

  const part = nodesOfKind(result, 'part')[0]
  const chapter = nodesOfKind(result, 'chapter')[0]
  const section = nodesOfKind(result, 'section')[0]
  const paragraph = nodesOfKind(result, 'paragraph')[0]
  assert.ok(part !== undefined && chapter !== undefined && section !== undefined && paragraph !== undefined)
  assert.equal(domainOf(part)?.level, 1)
  assert.equal(domainOf(chapter)?.partOf, domainOf(part)?.locator)
  assert.equal(domainOf(section)?.partOf, domainOf(chapter)?.locator)
  assert.equal(domainOf(paragraph)?.form, 'sectioning')
  assert.equal(domainOf(paragraph)?.partOf, domainOf(section)?.locator)
  assert.deepEqual(domainOf(part)?.contains, [domainOf(chapter)?.locator])
  assert.deepEqual(domainOf(chapter)?.contains, [domainOf(section)?.locator])

  const theorem = nodesOfKind(result, 'theorem')[0]
  const lemma = nodesOfKind(result, 'lemma')[0]
  const axiom = nodesOfKind(result, 'axiom')[0]
  const proofs = nodesOfKind(result, 'proof')
  assert.equal(proofs.length, 2)
  const [proving, unproved] = proofs
  assert.equal(domainOf(theorem)?.status, 'proved')
  assert.equal(domainOf(lemma)?.status, 'stated')
  assert.equal(domainOf(axiom)?.status, 'axiomatic')
  assert.equal(domainOf(proving)?.status, 'proved')
  assert.equal(domainOf(proving)?.proofStatus, 'complete')
  assert.equal(domainOf(proving)?.target, 'thm:main')
  assert.equal(domainOf(unproved)?.status, 'unverifiable')
  assert.equal(domainOf(unproved)?.proofStatus, 'unverifiable')
  // The proof environment is explicit evidence, never inferred from `Qed`.
  assert.equal('proofStatus' in (domainOf(theorem) ?? {}), false)
})

test('LaTeX without a documentclass emits no Book and no proof status invention', () => {
  const source = String.raw`\section{Only a section}
\begin{lemma}\label{lem:one}
A claim.
\end{lemma}
`
  const result = tex(source)
  assert.equal(nodesOfKind(result, 'book').length, 0)
  assert.equal(nodesOfKind(result, 'article').length, 0)
  assert.equal(nodesOfKind(result, 'section').length, 1)
  assert.equal(domainOf(nodesOfKind(result, 'lemma')[0])?.status, 'stated')
})

/* ------------------------------------------------------------------------- *
 * JavaScript contract tags
 * ------------------------------------------------------------------------- */

test('JavaScript contract tags emit Condition nodes; other tags do not', () => {
  const marker = 'SECRET_JS_BODY_91bc'
  const source = [
    '/**',
    ' * Adds two numbers.',
    ' * @requires left >= 0 && right >= 0',
    ' * @ensures result >= 0',
    ' * @throws when an argument is not a number',
    ' * @param left the left operand',
    ' */',
    'export function add(left: number, right: number): number {',
    `  return left + right + '${marker}'.length`,
    '}',
    '',
    '// @invariant size > 0',
    'export const size = 1',
  ].join('\n')
  const result = js(source)
  assertBodyFree(result, marker)
  assert.ok(result.conditions.length >= 2)
  const forms = result.conditions.map((node) => domainOf(node)?.form)
  assert.ok(forms.includes('precondition'))
  assert.ok(forms.includes('postcondition'))
  assert.ok(forms.includes('invariant'))
  // `@throws` and `@param` are not conditions.
  assert.equal(result.conditions.some((node) => node.brief?.includes('throws')), false)
  const precondition = result.conditions.find((node) => domainOf(node)?.form === 'precondition')
  assert.equal(domainOf(precondition)?.relation, 'requires')
  assert.equal(domainOf(precondition)?.appliesTo, 'add')
  assert.equal(domainOf(precondition)?.status, 'unknown')

  // Negative: a plain comment produces no condition node.
  const plain = js('/** just a comment */\nexport function f(): number { return 1 }\n', 'src/plain.ts')
  assert.equal(plain.conditions.length, 0)
})

/* ------------------------------------------------------------------------- *
 * CSV / TSV
 * ------------------------------------------------------------------------- */

test('CSV/TSV parse into Sheet, Cell and used Range without formulas or cell text', () => {
  const marker = 'SECRET_CELL_TEXT_5521'
  const source = [
    'name,qty,note',
    `"Widget, small",2,"=cmd ${marker}"`,
    '=B1,3,ok',
  ].join('\n')
  const result = csv(source, 'data/table.csv')
  assert.equal(result.parserId, 'delimited')
  assert.equal(result.rowCount, 3)
  assert.equal(result.columnCount, 3)
  assert.equal(result.cellCount, 9)
  assertBodyFree(result, marker)

  const sheets = nodesOfKind(result, 'sheet')
  assert.equal(sheets.length, 1)
  assert.equal(sheets[0].name, 'table')
  const sheetDomain = officeOf(sheets[0])
  assert.equal(sheetDomain?.kind, 'sheet')
  assert.equal(sheetDomain?.rowCount, 3)
  assert.equal(sheetDomain?.columnCount, 3)
  assert.equal(sheetDomain?.cellCount, 9)

  const cells = nodesOfKind(result, 'cell')
  assert.equal(cells.length, 9)
  const byAddress = new Map(cells.map((node) => [node.label, node]))
  assert.equal(officeOf(byAddress.get('B2'))?.valueType, 'number')
  assert.equal(officeOf(byAddress.get('A2'))?.valueType, 'text')
  // RFC 4180 quoted comma stays one cell.
  assert.equal(officeOf(byAddress.get('A2'))?.columnIndex, 0)
  // A leading `=` is text with injection risk, never a formula.
  assert.equal(officeOf(byAddress.get('A3'))?.valueType, 'text')
  assert.equal(officeOf(byAddress.get('A3'))?.injectionRisk, true)
  assert.equal(officeOf(byAddress.get('C2'))?.injectionRisk, true)
  assert.equal(officeOf(byAddress.get('C3'))?.injectionRisk, false)
  for (const cell of cells) {
    assert.equal(officeOf(cell)?.partOf, sheetDomain?.locator)
  }
  assert.equal(result.references.length, 0)
  assert.equal(nodesOfKind(result, 'formula').length, 0)
  assert.equal(result.document?.form, 'workbook')

  const ranges = nodesOfKind(result, 'range')
  assert.equal(ranges.length, 1)
  assert.equal(ranges[0].name, 'A1:C3')
  assert.equal(officeOf(ranges[0])?.kind, 'range')
  assert.equal(officeOf(ranges[0])?.cellCount, 9)

  // TSV uses the tab delimiter from the extension.
  const tsvResult = csv('a\tb\n1\t2\n', 'data/table.tsv')
  assert.equal(tsvResult.rowCount, 2)
  assert.equal(tsvResult.columnCount, 2)
  assert.equal(nodesOfKind(tsvResult, 'cell').length, 4)
})

test('CSV/TSV malformed and empty input never crashes or invents cells', () => {
  const empty = csv('', 'data/empty.csv')
  assert.equal(empty.rowCount, 0)
  assert.equal(empty.cellCount, 0)
  assert.equal(nodesOfKind(empty, 'cell').length, 0)
  assert.equal(nodesOfKind(empty, 'range').length, 0)

  const unterminated = csv('"unterminated\nnext,row', 'data/broken.csv')
  assert.ok(unterminated.rowCount >= 1)
  assert.equal(nodesOfKind(unterminated, 'cell').some((node) => node.label === 'A1'), true)

  // A quoted `""` escape and CRLF line ending are handled.
  const escaped = csv('"say ""hi""",b\r\n1,2\r\n', 'data/quote.csv')
  assert.equal(escaped.rowCount, 2)
  assert.equal(escaped.columnCount, 2)
  assert.equal(nodesOfKind(escaped, 'cell').length, 4)
})

/* ------------------------------------------------------------------------- *
 * Negatives, determinism and the projection helper
 * ------------------------------------------------------------------------- */

test('no explicit marker means no Book/Person/Venue/Condition metadata', () => {
  const result = md('# Title\n\nPlain prose with no front matter.')
  assert.equal(nodesOfKind(result, 'book').length, 0)
  // Every level-1 `#` heading is a Chapter, so plain prose with a title has one.
  const chapters = nodesOfKind(result, 'chapter')
  assert.equal(chapters.length, 1)
  assert.equal(chapters[0]?.name, 'Title')
  assert.equal(nodesOfKind(result, 'person').length, 0)
  assert.equal(nodesOfKind(result, 'venue').length, 0)
  assert.equal(nodesOfKind(result, 'condition').length, 0)
  // An implicit Article is the model's Markdown document unit, marked as such.
  const article = nodesOfKind(result, 'article')[0]
  assert.equal(domainOf(article)?.explicit, false)
  const section = domainOf(nodesOfKind(result, 'heading')[0])
  assert.equal(section?.kind, 'section')
  assert.equal(section?.partOf, domainOf(article)?.locator)
})

test('malformed front matter and empty input do not crash', () => {
  assert.doesNotThrow(() => md('---\ntitle: Broken\n\n# Heading\n'))
  const broken = md('---\ntitle: Broken\n\n# Heading\n')
  assert.ok(broken.nodes !== undefined)
  const empty = md('')
  assert.ok(empty.nodes === undefined || empty.nodes.length === 0)
  assert.doesNotThrow(() => parseText('# x', { parserId: 'markdown' }))
})

test('domain extraction is deterministic and the projection helper returns domain nodes', () => {
  const source = [
    '---',
    'form: book',
    'title: Determinism',
    'author: Ada',
    '---',
    '',
    '# One',
    '',
    '::: require',
    'explicit',
    ':::',
    '',
    '## Two',
  ].join('\n')
  const first = md(source, 'docs/determinism.md')
  const second = md(source, 'docs/determinism.md')
  assert.deepEqual(first.nodes, second.nodes)
  const domainNodes = domainNodesOf(first)
  assert.ok(domainNodes.length >= 4)
  for (const node of domainNodes) {
    assert.ok(node.domain !== undefined)
    const concept: ConceptMetadata = node.domain
    assert.ok(isStructuralKind(concept.kind) || isStatementKind(concept.kind))
  }
  assert.equal(structuralLocator('docs/a.md', 'chapter', 2), 'document:docs/a.md/chapter:2')
  assert.equal(structuralLocator(undefined, 'condition', 1), 'document/condition:1')
})
