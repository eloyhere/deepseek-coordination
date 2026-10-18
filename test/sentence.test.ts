import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  lineRanges,
  MAX_LINE_RANGES,
  MAX_SENTENCES,
  sentenceNodes,
  segmentSentences,
} from '../src/host/text/sentence.js'

/** Sentence texts, for readable assertions. */
function sentenceTexts(
  text: string,
  options?: { maxSentences?: number; maxLength?: number },
): string[] {
  return segmentSentences(text, options).map((segment) => text.slice(segment.start, segment.end))
}

test('splits English sentences on terminal punctuation', () => {
  const text = 'One two. Three four! Five six?  Seven.'
  assert.deepEqual(sentenceTexts(text), ['One two.', 'Three four!', 'Five six?', 'Seven.'])
  assert.deepEqual(segmentSentences(text), [
    { start: 0, end: 8, line: 1, column: 1 },
    { start: 9, end: 20, line: 1, column: 10 },
    { start: 21, end: 30, line: 1, column: 22 },
    { start: 32, end: 38, line: 1, column: 33 },
  ])
})

test('splits CJK sentences on 。！？ without requiring whitespace', () => {
  const text = '你好。世界！这是测试？'
  assert.deepEqual(sentenceTexts(text), ['你好。', '世界！', '这是测试？'])
  assert.deepEqual(segmentSentences(text), [
    { start: 0, end: 3, line: 1, column: 1 },
    { start: 3, end: 6, line: 1, column: 4 },
    { start: 6, end: 11, line: 1, column: 7 },
  ])
})

test('does not split inside parentheses, brackets or double quotes', () => {
  const parenthesised = 'A sentence (with a period. inside) ends here.'
  assert.deepEqual(sentenceTexts(parenthesised), [parenthesised])

  const bracketed = 'Use [a period. here] in one sentence.'
  assert.deepEqual(sentenceTexts(bracketed), [bracketed])

  const quoted = 'He said "stop. now" and left.'
  assert.deepEqual(sentenceTexts(quoted), [quoted])

  const nested = 'An (outer [inner. still] part) sentence.'
  assert.deepEqual(sentenceTexts(nested), [nested])
})

test('does not split after single-letter initials or inside a decimal number', () => {
  const decimal = 'Pi is 3.14 and e is 2.71. Done.'
  assert.deepEqual(sentenceTexts(decimal), ['Pi is 3.14 and e is 2.71.', 'Done.'])

  const initials = 'J. R. R. Tolkien wrote it.'
  assert.deepEqual(sentenceTexts(initials), [initials])

  const initialAtStart = 'A. Smith arrived.'
  assert.deepEqual(sentenceTexts(initialAtStart), [initialAtStart])
})

test('breaks paragraphs on blank lines, including CRLF blank lines', () => {
  const lf = 'First paragraph\n\nSecond paragraph'
  assert.deepEqual(segmentSentences(lf), [
    { start: 0, end: 15, line: 1, column: 1 },
    { start: 17, end: 33, line: 3, column: 1 },
  ])

  const crlf = 'One\r\n\r\nTwo'
  assert.deepEqual(segmentSentences(crlf), [
    { start: 0, end: 3, line: 1, column: 1 },
    { start: 7, end: 10, line: 3, column: 1 },
  ])
})

test('reports 1-based line and column coordinates across CRLF and LF', () => {
  const text = 'First.\r\n  Second.\nThird.'
  assert.deepEqual(segmentSentences(text), [
    { start: 0, end: 6, line: 1, column: 1 },
    { start: 10, end: 17, line: 2, column: 3 },
    { start: 18, end: 24, line: 3, column: 1 },
  ])
})

test('caps output by maxSentences and scanned text by maxLength', () => {
  assert.deepEqual(sentenceTexts('a. b. c.', { maxSentences: 2 }), ['a.', 'b.'])
  assert.deepEqual(sentenceTexts('a. b. c.', { maxLength: 0 }), [])
  assert.deepEqual(sentenceTexts('a. b. c.', { maxSentences: 0 }), [])
  assert.deepEqual(sentenceTexts('aaaa. bbbb. cccc.', { maxLength: 6 }), ['aaaa.'])

  // Invalid limits fall back to the defaults instead of throwing.
  assert.deepEqual(sentenceTexts('a. b.', { maxSentences: -1, maxLength: Number.NaN }), ['a.', 'b.'])

  const nodes = sentenceNodes('a. b. c.', { maxSentences: 2 })
  assert.equal(nodes.length, 2)
  assert.deepEqual(nodes.map((node) => node.kind), ['sentence', 'sentence'])
})

test('handles empty and whitespace-only input', () => {
  assert.deepEqual(segmentSentences(''), [])
  assert.deepEqual(sentenceNodes(''), [])
  assert.deepEqual(lineRanges(''), [])
  assert.deepEqual(segmentSentences('   \n\t\r\n '), [])
  assert.deepEqual(sentenceNodes('   \n\t\r\n '), [])
  // Runtime guards: a non-string never throws.
  assert.deepEqual(segmentSentences(undefined as unknown as string), [])
  assert.deepEqual(lineRanges(null as unknown as string), [])
})

test('never splits inside a fenced code block', () => {
  const text = ['Start', '```ts', 'First. Second.', '```', 'End.'].join('\n')
  assert.deepEqual(sentenceTexts(text), [text])

  const blankInside = ['One.', '```', 'A. B.', '', 'C. D.', '```', 'Two.'].join('\n')
  assert.deepEqual(sentenceTexts(blankInside), ['One.', 'Two.'])
})

test('returns body-free sentence nodes with the same spans as segments', () => {
  const text = 'One. Two? Three!'
  const segments = segmentSentences(text)
  const nodes = sentenceNodes(text)
  assert.equal(nodes.length, segments.length)
  for (let index = 0; index < segments.length; index += 1) {
    const node = nodes[index]
    assert.equal(node.kind, 'sentence')
    assert.deepEqual(Object.keys(node).sort(), ['kind', 'span'])
    assert.equal('text' in node, false)
    assert.deepEqual(node.span, {
      start: segments[index].start,
      end: segments[index].end,
      line: segments[index].line,
      column: segments[index].column,
    })
  }
})

test('computes CRLF, LF, lone-CR and final-line ranges', () => {
  assert.deepEqual(lineRanges('alpha\r\nbeta\ngamma'), [
    { start: 0, end: 5, line: 1 },
    { start: 7, end: 11, line: 2 },
    { start: 12, end: 17, line: 3 },
  ])
  assert.deepEqual(lineRanges('a\rb'), [
    { start: 0, end: 1, line: 1 },
    { start: 2, end: 3, line: 2 },
  ])
  // A trailing newline leaves a final empty line, matching SourceMap numbering.
  assert.deepEqual(lineRanges('one\r\ntwo\r\n'), [
    { start: 0, end: 3, line: 1 },
    { start: 5, end: 8, line: 2 },
    { start: 10, end: 10, line: 3 },
  ])

  const lines = Array.from({ length: 50 }, (_, index) => `line${index}`).join('\n')
  const capped = lineRanges(lines, 10)
  assert.equal(capped.length, 10)
  assert.deepEqual(capped[0], { start: 0, end: 5, line: 1 })
  assert.deepEqual(capped[9], { start: 54, end: 59, line: 10 })
  assert.deepEqual(lineRanges(lines, 0), [])

  const many = Array.from({ length: 25_000 }, (_, index) => String(index)).join('\n')
  assert.equal(lineRanges(many).length, MAX_LINE_RANGES)
})

test('handles pathological bracket and quote nesting without throwing', () => {
  const pathological = '('.repeat(100_000) + 'Sentence. '.repeat(1_000) + ')'.repeat(100_000)
  let segments: ReturnType<typeof segmentSentences> = []
  assert.doesNotThrow(() => {
    segments = segmentSentences(pathological, {
      maxLength: pathological.length,
      maxSentences: 5_000,
    })
  })
  assert.ok(Array.isArray(segments))

  const quotes = '"'.repeat(50_000)
  assert.doesNotThrow(() => segmentSentences(quotes))
  assert.equal(segmentSentences(quotes).length, 1)

  // NUL/control code units and lone surrogates are handled as opaque content.
  const binary = '\u0000\u0001\uD800 sentence. \uDC00\uFFFF'
  assert.doesNotThrow(() => segmentSentences(binary))
  assert.doesNotThrow(() => lineRanges(binary))
  assert.deepEqual(sentenceTexts(binary), ['\u0000\u0001\uD800 sentence.', '\uDC00\uFFFF'])
})

test('scans a 500k-character input under a generous time bound and respects caps', () => {
  const huge = 'Sentence. '.repeat(50_000)
  assert.equal(huge.length, 500_000)

  const started = performance.now()
  const capped = segmentSentences(huge)
  const cappedElapsed = performance.now() - started
  assert.equal(capped.length, MAX_SENTENCES)
  assert.ok(capped[capped.length - 1].end <= 200_000)
  assert.ok(cappedElapsed < 2_000, `capped scan took ${cappedElapsed.toFixed(1)}ms`)

  const fullStarted = performance.now()
  const full = segmentSentences(huge, { maxLength: huge.length, maxSentences: 60_000 })
  const fullElapsed = performance.now() - fullStarted
  assert.equal(full.length, 50_000)
  // The final trailing space is trimmed from the reported range.
  assert.equal(full[full.length - 1].end, 499_999)
  assert.ok(fullElapsed < 2_000, `full scan took ${fullElapsed.toFixed(1)}ms`)
})
