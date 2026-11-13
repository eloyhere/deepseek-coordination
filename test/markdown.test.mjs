import assert from 'node:assert/strict'
import test from 'node:test'
import { parseInline, parseMarkdown } from '../src/client/markdownCore.ts'

test('parses headings, paragraphs and inline emphasis', () => {
  const blocks = parseMarkdown('# Heading\n\nA **bold** and `code` line.')
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0], {
    type: 'heading',
    level: 1,
    inlines: [{ type: 'text', text: 'Heading' }],
  })
  assert.equal(blocks[1].type, 'paragraph')
  assert.deepEqual(blocks[1].inlines, [
    { type: 'text', text: 'A ' },
    { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
    { type: 'text', text: ' and ' },
    { type: 'code', text: 'code' },
    { type: 'text', text: ' line.' },
  ])
})

test('parses unordered, ordered and task lists', () => {
  const unordered = parseMarkdown('- one\n- two')
  assert.equal(unordered[0].type, 'list')
  assert.equal(unordered[0].ordered, false)
  assert.equal(unordered[0].items.length, 2)

  const ordered = parseMarkdown('3. three\n4. four')
  assert.equal(ordered[0].ordered, true)
  assert.equal(ordered[0].start, 3)

  const tasks = parseMarkdown('- [x] done\n- [ ] todo')
  assert.equal(tasks[0].type, 'list')
  assert.equal(tasks[0].items[0].checked, true)
  assert.equal(tasks[0].items[1].checked, false)
  assert.deepEqual(tasks[0].items[0].inlines, [{ type: 'text', text: 'done' }])
})

test('keeps fenced code verbatim', () => {
  const blocks = parseMarkdown('```js\nconst a = 1\n```')
  assert.deepEqual(blocks, [{ type: 'code', lang: 'js', text: 'const a = 1' }])
})

test('parses tables, quotes and horizontal rules', () => {
  const table = parseMarkdown('| A | B |\n|---|---|\n| 1 | 2 |')
  assert.equal(table[0].type, 'table')
  assert.equal(table[0].header.length, 2)
  assert.equal(table[0].rows.length, 1)
  assert.deepEqual(table[0].header[0], [{ type: 'text', text: 'A' }])

  const quote = parseMarkdown('> quoted')
  assert.equal(quote[0].type, 'quote')
  assert.equal(quote[0].blocks[0].type, 'paragraph')

  assert.equal(parseMarkdown('---')[0].type, 'hr')
})

test('renders links but drops unsafe protocols', () => {
  const safe = parseInline('[docs](https://example.com/a)')
  assert.deepEqual(safe, [{
    type: 'link',
    href: 'https://example.com/a',
    children: [{ type: 'text', text: 'docs' }],
  }])
  const unsafe = parseInline('[click](javascript:alert(1))')
  assert.equal(unsafe.some((token) => token.type === 'link'), false)
  assert.equal(unsafe.map((token) => token.type === 'text' ? token.text : '').join(''), '[click](javascript:alert(1))')
})

test('raw HTML stays text and newlines become breaks', () => {
  const tokens = parseInline('<script>alert(1)</script>\nnext')
  assert.equal(tokens.some((token) => token.type === 'link'), false)
  assert.equal(tokens.some((token) => token.type === 'br'), true)
  assert.match(tokens.filter((token) => token.type === 'text').map((token) => token.text).join(''), /<script>alert\(1\)<\/script>/)
})
