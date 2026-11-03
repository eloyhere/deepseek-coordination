/**
 * Bounded, lossless source highlighting for read-only file previews.
 *
 * Use `token.content` as a React text child. This module never produces HTML,
 * interprets URLs, or changes the source (including CRLF and escaped markup).
 * The installed Prism instance already owns the common programming grammars;
 * the small extra grammars below fill its TeX/config/shell/Java/PHP gaps.
 */
import { Prism } from 'prism-react-renderer'
import type { PrismGrammar, PrismTheme } from 'prism-react-renderer'
import type { Theme } from '@mui/material/styles'
import type { CSSProperties } from 'react'

export const MAX_PREVIEW_HIGHLIGHT_BYTES = 64 * 1024
export const MAX_PREVIEW_HIGHLIGHT_LINES = 2000
export const MAX_PREVIEW_HIGHLIGHT_TOKENS = 16000

export interface PreviewHighlightToken {
  readonly types: readonly string[]
  readonly content: string
}

export interface PreviewHighlight {
  readonly language: string
  /** The exact source prefix shown, without an injected ellipsis/newline. */
  readonly code: string
  readonly tokens: readonly PreviewHighlightToken[]
  readonly truncated: boolean
  readonly lines: number
}

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  py: 'python', pyw: 'python', pyi: 'python',
  md: 'markdown', markdown: 'markdown', mdown: 'markdown', mdx: 'markdown',
  tex: 'latex', latex: 'latex', sty: 'latex', cls: 'latex', ltx: 'latex', bib: 'bibtex',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
  css: 'css', json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  java: 'java', rs: 'rust', go: 'go', php: 'php',
  kt: 'kotlin', kts: 'kotlin', swift: 'swift', sql: 'sql', graphql: 'graphql', gql: 'graphql',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell',
}

const texMath: PrismGrammar = {
  function: /\\(?:[a-zA-Z@]+\*?|[^a-zA-Z\s])/,
  number: /\b\d+(?:\.\d+)?\b/,
  operator: /[=+*/^_<>-]/,
  punctuation: /[{}[\]$&]/,
}

/** Owned locally: do not mutate the shared Prism language registry. */
const EXTRA_GRAMMARS: Readonly<Record<string, PrismGrammar>> = {
  latex: {
    // Verbatim bodies take precedence over comments and math delimiters.
    string: [
      { pattern: /\\begin\{(verbatim\*?|lstlisting|minted)\}[\s\S]*?\\end\{\1\}/, greedy: true },
      { pattern: /\\verb\*?([^a-zA-Z\s])[\s\S]*?\1/, greedy: true },
    ],
    comment: { pattern: /((?:^|[^\\])(?:\\\\)*)%[^\r\n]*/, lookbehind: true, greedy: true },
    equation: {
      pattern: /((?:^|[^\\])(?:\\\\)*)(?:\$\$(?:\\[\s\S]|(?!\$\$)[^\\])*\$\$|\$(?:\\[^\r\n]|[^\\$\r\n])+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/,
      lookbehind: true,
      greedy: true,
      inside: texMath,
    },
    keyword: { pattern: /\\(?:begin|end)\{[^{}\r\n]+\}/, inside: { function: /\\[a-z]+/, 'class-name': /[^{}\\]+/, punctuation: /[{}]/ } },
    function: texMath.function!,
    number: texMath.number!,
    operator: texMath.operator!,
    punctuation: texMath.punctuation!,
  },
  bibtex: {
    comment: /%[^\r\n]*/,
    keyword: /@[a-zA-Z]+/,
    property: /\b[\w-]+(?=\s*=)/,
    string: { pattern: /"(?:\\[\s\S]|[^"\\])*"/, greedy: true },
    number: /\b\d+\b/,
    punctuation: /[{},=]/,
  },
  java: {
    ...Prism.languages.clike,
    keyword: /\b(?:abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|exports|extends|final|finally|float|for|if|implements|import|instanceof|int|interface|long|module|native|new|non-sealed|open|opens|package|permits|private|protected|provides|public|record|requires|return|sealed|short|static|strictfp|super|switch|synchronized|this|throw|throws|to|transient|transitive|try|uses|var|void|volatile|while|with|yield)\b/,
    annotation: { pattern: /@[\w.]+/, alias: 'builtin' },
  },
  php: {
    comment: [{ pattern: /\/\*[\s\S]*?(?:\*\/|$)/, greedy: true }, { pattern: /\/\/[^\r\n]*|#[^\r\n]*/, greedy: true }],
    string: { pattern: /(["'])(?:\\[\s\S]|(?!\1)[^\\])*\1/, greedy: true },
    keyword: /\b(?:abstract|array|as|break|case|catch|class|clone|const|continue|declare|default|do|echo|else|elseif|empty|endfor|endif|extends|final|finally|fn|for|foreach|function|global|if|implements|include|instanceof|interface|isset|list|match|namespace|new|parent|print|private|protected|public|readonly|require|return|self|static|switch|throw|trait|try|unset|use|var|while|yield)\b/,
    variable: /\$[a-zA-Z_\x80-\xff][\w\x80-\xff]*/,
    boolean: /\b(?:true|false|null)\b/i,
    number: /\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/i,
    function: /\b\w+(?=\s*\()/,
    operator: /[-+*/%=!<>?:.&|^~]+/,
    punctuation: /[{}[\];(),]/,
  },
  toml: {
    comment: { pattern: /#[^\r\n]*/, greedy: true },
    string: [
      { pattern: /"""[\s\S]*?"""|'''[\s\S]*?'''/, greedy: true },
      { pattern: /"(?:\\[^\r\n]|[^"\\\r\n])*"|'[^'\r\n]*'/, greedy: true },
    ],
    'class-name': /^\s*\[\[?[^\]\r\n]+\]\]?/m,
    property: /[\w.-]+(?=\s*=)/,
    boolean: /\b(?:true|false)\b/,
    number: /\b(?:0x[\da-f_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.[\d_]+)?(?:e[+-]?[\d_]+)?)\b/i,
    punctuation: /[{}[\],.=]/,
  },
  ini: {
    comment: /^[\t ]*[;#][^\r\n]*/m,
    'class-name': /^\s*\[[^\]\r\n]+\]/m,
    property: /^[\t ]*[^=\r\n]+(?==)/m,
    string: /"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'/,
    boolean: /\b(?:true|false|yes|no|on|off)\b/i,
    number: /\b\d+(?:\.\d+)?\b/,
    punctuation: /=/,
  },
  bash: {
    comment: { pattern: /(^|[\s;])#[^\r\n]*/, lookbehind: true, greedy: true },
    string: { pattern: /"(?:\\[\s\S]|[^"\\])*"|'[^']*'/, greedy: true },
    variable: /\$\{[^}\r\n]*\}|\$(?:[\w]+|[?$!#@*\d-])/,
    keyword: /\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|in|function|select|until|export|local|return|exit)\b/,
    builtin: /\b(?:echo|printf|read|cd|pwd|set|unset|source|test|exec)\b/,
    number: /\b\d+\b/,
    operator: /&&|\|\||[|<>;&=]/,
    punctuation: /[{}[\]();]/,
  },
  powershell: {
    comment: [{ pattern: /<#[\s\S]*?#>/, greedy: true }, { pattern: /#[^\r\n]*/, greedy: true }],
    string: { pattern: /"(?:`[\s\S]|[^"`])*"|'(?:''|[^'])*'/, greedy: true },
    variable: /\$(?:\{[^}]*\}|[\w:]+)/,
    keyword: /\b(?:begin|break|catch|class|continue|data|do|dynamicparam|else|elseif|end|enum|exit|filter|finally|for|foreach|from|function|if|in|param|process|return|switch|throw|trap|try|until|using|while)\b/i,
    function: /\b[a-z]+-[a-z][\w-]*\b/i,
    boolean: /\$(?:true|false|null)\b/i,
    number: /\b\d+(?:\.\d+)?\b/,
    operator: /-[a-z]+\b|[-+*/%=!<>|&]+/i,
    punctuation: /[{}[\]();,.]/,
  },
  jsonc: {
    comment: [{ pattern: /\/\*[\s\S]*?(?:\*\/|$)/, greedy: true }, { pattern: /\/\/[^\r\n]*/, greedy: true }],
    ...Prism.languages.json,
  },
}

/** Cross-platform filename detection, including uppercase and module extensions. */
export function previewLanguageOf(path: string | null | undefined): string {
  const filename = (path ?? '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  if (filename === '.bashrc' || filename === '.zshrc' || filename === '.profile') return 'bash'
  const dot = filename.lastIndexOf('.')
  const language = dot >= 0 ? EXTENSION_LANGUAGES[filename.slice(dot + 1)] : undefined
  return language && (EXTRA_GRAMMARS[language] || Prism.languages[language]) ? language : 'plain'
}

/** Clip before tokenizing, counting UTF-8 bytes without allocating the whole input. */
export function clipPreviewSource(content: string): Pick<PreviewHighlight, 'code' | 'truncated' | 'lines'> {
  let offset = 0
  let bytes = 0
  let lines = 1
  while (offset < content.length) {
    const point = content.codePointAt(offset)!
    const width = point > 0xffff ? 2 : 1
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes + size > MAX_PREVIEW_HIGHLIGHT_BYTES) break
    if (point === 10 && lines >= MAX_PREVIEW_HIGHLIGHT_LINES) break
    // Keep CRLF together if the byte/line boundary lands between them.
    if (point === 13 && content.charCodeAt(offset + 1) === 10 &&
        (bytes + 2 > MAX_PREVIEW_HIGHLIGHT_BYTES || lines >= MAX_PREVIEW_HIGHLIGHT_LINES)) break
    bytes += size
    offset += width
    if (point === 10) lines += 1
  }
  return { code: content.slice(0, offset), truncated: offset < content.length, lines }
}

/** Flat tokens are directly renderable as React text children, never innerHTML. */
export function highlightPreview(path: string | null | undefined, content: string): PreviewHighlight {
  const clipped = clipPreviewSource(content)
  const language = previewLanguageOf(path)
  const grammar = EXTRA_GRAMMARS[language] ?? Prism.languages[language]
  const tokens: PreviewHighlightToken[] = []
  let consumed = 0
  let exhausted = false
  const append = (text: string, types: readonly string[]): void => {
    if (!text || exhausted) return
    if (tokens.length >= MAX_PREVIEW_HIGHLIGHT_TOKENS - 1) {
      tokens.push({ types: [], content: clipped.code.slice(consumed) })
      exhausted = true
      return
    }
    const previous = tokens[tokens.length - 1]
    if (previous && previous.types.join('\0') === types.join('\0')) {
      tokens[tokens.length - 1] = { types: previous.types, content: previous.content + text }
    } else {
      tokens.push({ types, content: text })
    }
    consumed += text.length
  }
  const flatten = (items: string | Prism.Token | (string | Prism.Token)[], inherited: readonly string[] = []): void => {
    if (exhausted) return
    if (typeof items === 'string') { append(items, inherited); return }
    if (Array.isArray(items)) { for (const item of items) flatten(item, inherited); return }
    const aliases = typeof items.alias === 'string' ? [items.alias] : items.alias ?? []
    flatten(items.content, [...inherited, items.type, ...aliases])
  }
  try {
    flatten(grammar ? Prism.tokenize(clipped.code, grammar) : clipped.code)
  } catch {
    // A grammar failure must leave a readable, unmodified source preview.
    tokens.length = 0
    tokens.push({ types: [], content: clipped.code })
  }
  return { ...clipped, language, tokens }
}

/** Semantic palette slots keep the source legible in both theme modes. */
export function previewThemeFor(muiTheme: Theme): PrismTheme {
  const palette = muiTheme.palette
  const dark = palette.mode === 'dark'
  return {
    plain: { color: palette.text.primary, backgroundColor: 'transparent' },
    styles: [
      { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: palette.text.secondary, fontStyle: 'italic' } },
      { types: ['punctuation', 'operator'], style: { color: dark ? palette.grey[400] : palette.grey[700] } },
      { types: ['keyword', 'builtin', 'tag', 'important', 'atrule'], style: { color: dark ? palette.primary.light : palette.primary.dark, fontWeight: '600' } },
      { types: ['string', 'char', 'attr-value', 'regex', 'url', 'code', 'code-block', 'code-snippet'], style: { color: dark ? palette.success.light : palette.success.dark } },
      { types: ['number', 'boolean', 'constant', 'symbol', 'deleted'], style: { color: dark ? palette.warning.light : palette.warning.dark } },
      { types: ['function', 'class-name', 'function-variable'], style: { color: dark ? palette.info.light : palette.info.dark } },
      { types: ['variable', 'parameter', 'property', 'attr-name', 'selector', 'rule', 'title'], style: { color: dark ? palette.secondary.light : palette.secondary.dark } },
      { types: ['bold'], style: { fontWeight: '700' } },
      { types: ['italic'], style: { fontStyle: 'italic' } },
      { types: ['url'], style: { textDecorationLine: 'underline' } },
    ],
  }
}

/** Resolve nested Prism types in order, so inner strings override outer tags. */
export function previewTokenStyle(theme: PrismTheme, types: readonly string[]): CSSProperties {
  const style: CSSProperties = {}
  for (const type of types) {
    for (const entry of theme.styles) {
      if (entry.types.includes(type)) Object.assign(style, entry.style)
    }
  }
  return style
}
