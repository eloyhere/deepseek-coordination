import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_PREVIEW_HIGHLIGHT_BYTES,
  MAX_PREVIEW_HIGHLIGHT_LINES,
  MAX_PREVIEW_HIGHLIGHT_TOKENS,
  clipPreviewSource,
  highlightPreview,
  previewLanguageOf,
  previewThemeFor,
  previewTokenStyle,
} from '../src/client/previewHighlight.js'
import type { PreviewHighlight } from '../src/client/previewHighlight.js'
import type { Theme } from '@mui/material/styles'

function typedText(result: PreviewHighlight, type: string): string {
  return result.tokens.filter((token) => token.types.includes(type)).map((token) => token.content).join('')
}

function retained(result: PreviewHighlight, source: string): void {
  assert.equal(result.tokens.map((token) => token.content).join(''), result.code)
  assert.ok(source.startsWith(result.code))
}

test('preview language detection distinguishes modules, JSX, TeX and cross-platform paths', () => {
  for (const [path, language] of [
    ['R:\\project\\src\\APP.MTS', 'typescript'],
    ['src/module.cts', 'typescript'], ['src/module.cjs', 'javascript'],
    ['src/app.tsx', 'tsx'], ['src/app.jsx', 'jsx'],
    ['notes/README.MD', 'markdown'], ['book/chapter.tex', 'latex'],
    ['book/theme.sty', 'latex'], ['book/refs.bib', 'bibtex'],
    ['src/a.py', 'python'], ['src/Main.java', 'java'], ['server.php', 'php'],
    ['settings.jsonc', 'jsonc'], ['pyproject.toml', 'toml'],
    ['.bashrc', 'bash'], ['scripts/build.ps1', 'powershell'],
    ['folder.ts/README', 'plain'], ['data.unknown', 'plain'],
  ]) assert.equal(previewLanguageOf(path), language, path)
  assert.equal(previewLanguageOf(null), 'plain')
})

test('JavaScript preserves lexical boundaries, multiline comments, strings and interpolation', () => {
  const source = '/* first\r\nsecond */\r\nconst classification = "return 42 \\"quoted\\"";\nfunction greet(value) { return `hello ${value + 2}`; }\nconst url = "https://example.test/#tag";'
  const result = highlightPreview('src/a.mjs', source)
  retained(result, source)
  assert.equal(result.truncated, false)
  assert.ok(typedText(result, 'comment').includes('first\r\nsecond'))
  assert.ok(typedText(result, 'keyword').includes('const'))
  assert.ok(!typedText(result, 'keyword').includes('classification'))
  assert.ok(!typedText(result, 'keyword').includes('return 42'))
  assert.ok(typedText(result, 'string').includes('https://example.test/#tag'))
  assert.ok(typedText(result, 'function').includes('greet'))
  assert.ok(typedText(result, 'number').includes('2'))
})

test('TypeScript and JSX use their own grammars, retaining generic and tag boundaries', () => {
  const ts = 'interface User { name: string }\nconst user: User = { name: "Ada" };'
  const result = highlightPreview('types.ts', ts)
  retained(result, ts)
  assert.ok(typedText(result, 'keyword').includes('interface'))
  assert.ok(typedText(result, 'class-name').includes('User'))
  const jsx = 'const View = () => <Widget title="a > b">{count + 1}</Widget>;'
  const tags = highlightPreview('View.tsx', jsx)
  retained(tags, jsx)
  assert.ok(typedText(tags, 'tag').includes('Widget'))
  assert.ok(typedText(tags, 'attr-value').includes('a > b'))
})

test('Python triple quoted strings and escaped quotes do not become comments or keywords', () => {
  const source = 'def greet(name):\n    doc = """line one\n# inside string: return 99\nline three"""\n    return "it\\\"s fine" # actual comment\n'
  const result = highlightPreview('greet.py', source)
  retained(result, source)
  assert.ok(typedText(result, 'string').includes('# inside string: return 99'))
  assert.ok(!typedText(result, 'comment').includes('inside string'))
  assert.ok(typedText(result, 'comment').includes('# actual comment'))
  assert.ok(typedText(result, 'function').includes('greet'))
})

test('Markdown highlights structure, inline code and fenced content without interpreting markup', () => {
  const source = '# Heading\n\n**bold** and *emphasis* and `const x = 1`\n[link](javascript:alert)\n\n```js\nconst x = "<script>";\n```\n'
  const result = highlightPreview('README.md', source)
  retained(result, source)
  assert.ok(typedText(result, 'title').includes('Heading'))
  assert.ok(typedText(result, 'bold').includes('bold'))
  assert.ok(typedText(result, 'italic').includes('emphasis'))
  assert.ok(typedText(result, 'code-snippet').includes('const x = 1'))
  assert.ok(typedText(result, 'code-block').includes('<script>'))
})

test('TeX retains multiline equations, commands, environments and escaped percent signs', () => {
  const source = '\\section{Intro}\n\\begin{equation}\n\\alpha + 2 = x^2\n\\end{equation}\nPrice \\% 20 % real comment\n$$\\frac{1}{2}\n+ x$$\n\\verb|% literal|\n\\begin{verbatim}\n% literal block\n\\end{verbatim}'
  const result = highlightPreview('chapter.tex', source)
  retained(result, source)
  assert.ok(typedText(result, 'function').includes('\\section'))
  assert.ok(typedText(result, 'class-name').includes('equation'))
  assert.ok(typedText(result, 'equation').includes('\\frac{1}{2}\n+ x'))
  assert.equal(typedText(result, 'comment'), '% real comment')
  assert.ok(typedText(result, 'string').includes('% literal'))
})

test('TeX escaped dollars do not open math and escaped percent parity respects comments', () => {
  const source = 'Price \\$5 and \\$10. Math $x + \\$ + 2$ end.\n\\% literal\n\\\\% comment'
  const result = highlightPreview('escape.tex', source)
  retained(result, source)
  assert.equal(typedText(result, 'equation'), '$x + \\$ + 2$')
  assert.equal(typedText(result, 'comment'), '% comment')
})

test('HTML and unknown text preserve hostile markup and entity spelling as inert strings', () => {
  const source = '<img src=x onerror="alert(1)">\r\n<script>alert("&lt; &amp;")</script>\n\u0000'
  for (const path of ['hostile.html', 'hostile.unknown']) {
    const result = highlightPreview(path, source)
    retained(result, source)
    assert.equal(result.code, source)
    assert.ok(result.tokens.every((token) => typeof token.content === 'string'))
  }
  assert.ok(typedText(highlightPreview('hostile.html', source), 'tag').includes('onerror'))
  assert.deepEqual(highlightPreview('hostile.unknown', source).tokens, [{ types: [], content: source }])
})

test('extra grammars keep comment markers inside strings and expose useful token categories', () => {
  for (const [path, source, stringFragment, keyword] of [
    ['Main.java', 'public class Main { String url = "https://a/#b"; }', 'https://a/#b', 'public'],
    ['index.php', '<?php function greet() { return "https://a/#b"; }', 'https://a/#b', 'function'],
    ['project.toml', 'url = "https://a/#b" # comment\n[tool.example]\ncount = 42', 'https://a/#b', ''],
    ['config.jsonc', '{"url":"https://a/#b", /* comment */ "count":42}', 'https://a/#b', ''],
  ]) {
    const result = highlightPreview(path, source)
    retained(result, source)
    assert.ok(typedText(result, 'string').includes(stringFragment), path)
    assert.ok(!typedText(result, 'comment').includes('#b'), path)
    if (keyword) assert.ok(typedText(result, 'keyword').includes(keyword), path)
  }
})

test('source limits count UTF-8 bytes and line boundaries before highlighting', () => {
  const multibyte = '😀中'.repeat(15000)
  const unicode = clipPreviewSource(multibyte)
  assert.ok(unicode.truncated)
  assert.ok(Buffer.byteLength(unicode.code, 'utf8') <= MAX_PREVIEW_HIGHLIGHT_BYTES)
  assert.ok(!/[\uD800-\uDBFF]$/.test(unicode.code))
  assert.ok(multibyte.startsWith(unicode.code))
  const singleLine = 'x'.repeat(MAX_PREVIEW_HIGHLIGHT_BYTES + 1)
  assert.equal(clipPreviewSource(singleLine).code.length, MAX_PREVIEW_HIGHLIGHT_BYTES)
  const lines = 'x\r\n'.repeat(MAX_PREVIEW_HIGHLIGHT_LINES + 10)
  const clipped = clipPreviewSource(lines)
  assert.equal(clipped.lines, MAX_PREVIEW_HIGHLIGHT_LINES)
  assert.equal(clipped.code.split('\n').length, MAX_PREVIEW_HIGHLIGHT_LINES)
  assert.ok(!clipped.code.endsWith('\r'))
  assert.equal(clipPreviewSource('a\r\nb\n').code, 'a\r\nb\n')
  assert.equal(clipPreviewSource('a\r\nb\n').lines, 3)
})

test('token limits bound DOM work without silently dropping the visible suffix', () => {
  const source = 'x=1;'.repeat(16000)
  const result = highlightPreview('many.js', source)
  retained(result, source)
  assert.ok(result.tokens.length <= MAX_PREVIEW_HIGHLIGHT_TOKENS)
  assert.ok(result.tokens.length > 100)
  assert.ok(result.tokens[result.tokens.length - 1]!.content.endsWith(result.code.slice(-10)))
})

test('theme styles use semantic palette slots and nested strings override outer tags', () => {
  const palette = {
    mode: 'light', text: { primary: 'text', secondary: 'comment' }, grey: { 400: 'grey400', 700: 'grey700' },
    primary: { light: 'primaryLight', dark: 'primaryDark' },
    success: { light: 'successLight', dark: 'successDark' },
    warning: { light: 'warningLight', dark: 'warningDark' },
    info: { light: 'infoLight', dark: 'infoDark' },
    secondary: { light: 'secondaryLight', dark: 'secondaryDark' },
  }
  const light = previewThemeFor({ palette } as unknown as Theme)
  const dark = previewThemeFor({ palette: { ...palette, mode: 'dark' } } as unknown as Theme)
  assert.equal(previewTokenStyle(light, ['comment']).color, 'comment')
  assert.equal(previewTokenStyle(light, ['keyword']).color, 'primaryDark')
  assert.equal(previewTokenStyle(dark, ['keyword']).color, 'primaryLight')
  assert.equal(previewTokenStyle(light, ['tag', 'attr-value']).color, 'successDark')
  assert.equal(previewTokenStyle(light, ['bold', 'italic']).fontWeight, '700')
  assert.equal(previewTokenStyle(light, ['bold', 'italic']).fontStyle, 'italic')
})
