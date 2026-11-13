/** Small, safe Markdown parser for question dialogs; no HTML is trusted or emitted. */

export type InlineToken =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'strong' | 'em' | 'del'; readonly children: readonly InlineToken[] }
  | { readonly type: 'link'; readonly href: string; readonly children: readonly InlineToken[] }
  | { readonly type: 'br' }

export interface ListItem {
  readonly inlines: readonly InlineToken[]
  readonly checked?: boolean
}

export type MarkdownBlock =
  | { readonly type: 'heading'; readonly level: number; readonly inlines: readonly InlineToken[] }
  | { readonly type: 'paragraph'; readonly inlines: readonly InlineToken[] }
  | { readonly type: 'code'; readonly lang?: string; readonly text: string }
  | { readonly type: 'list'; readonly ordered: boolean; readonly start: number; readonly items: readonly ListItem[] }
  | { readonly type: 'quote'; readonly blocks: readonly MarkdownBlock[] }
  | { readonly type: 'hr' }
  | { readonly type: 'table'; readonly header: readonly (readonly InlineToken[])[]; readonly rows: readonly (readonly (readonly InlineToken[])[])[] }

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/

function safeHref(raw: string): string | undefined {
  const href = raw.trim()
  if (href.length === 0) return undefined
  if (href.startsWith('#')) return href
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

function findClosing(text: string, marker: string, from: number): number {
  const index = text.indexOf(marker, from)
  return index < 0 ? -1 : index
}

/** Parse inline Markdown into typed tokens; raw HTML stays text. */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer.length > 0) {
      tokens.push({ type: 'text', text: buffer })
      buffer = ''
    }
  }
  let index = 0
  while (index < text.length) {
    const rest = text.slice(index)
    if (rest.startsWith('\\') && index + 1 < text.length && /[\\`*_{}\[\]()#+.!>~-]/.test(text[index + 1]!)) {
      buffer += text[index + 1]
      index += 2
      continue
    }
    if (text[index] === '`') {
      const end = findClosing(text, '`', index + 1)
      if (end > index) {
        flush()
        tokens.push({ type: 'code', text: text.slice(index + 1, end) })
        index = end + 1
        continue
      }
    }
    if (rest.startsWith('**') || rest.startsWith('__')) {
      const marker = rest.slice(0, 2)
      const end = findClosing(text, marker, index + 2)
      if (end > index + 2) {
        flush()
        tokens.push({ type: 'strong', children: parseInline(text.slice(index + 2, end)) })
        index = end + 2
        continue
      }
    }
    if (rest.startsWith('~~')) {
      const end = findClosing(text, '~~', index + 2)
      if (end > index + 2) {
        flush()
        tokens.push({ type: 'del', children: parseInline(text.slice(index + 2, end)) })
        index = end + 2
        continue
      }
    }
    if (text[index] === '*' || text[index] === '_') {
      const marker = text[index]!
      const end = findClosing(text, marker, index + 1)
      if (end > index + 1) {
        flush()
        tokens.push({ type: 'em', children: parseInline(text.slice(index + 1, end)) })
        index = end + 1
        continue
      }
    }
    if (text[index] === '[') {
      const close = text.indexOf('](', index + 1)
      const end = close < 0 ? -1 : text.indexOf(')', close + 2)
      if (close > index && end > close) {
        const href = safeHref(text.slice(close + 2, end))
        if (href !== undefined) {
          flush()
          tokens.push({ type: 'link', href, children: parseInline(text.slice(index + 1, close)) })
          index = end + 1
          continue
        }
      }
    }
    const autolink = /^<((?:https?:\/\/|mailto:)[^<>\s]+)>/.exec(rest)
    if (autolink !== null) {
      const href = safeHref(autolink[1]!)
      if (href !== undefined) {
        flush()
        tokens.push({ type: 'link', href, children: [{ type: 'text', text: autolink[1]! }] })
        index += autolink[0].length
        continue
      }
    }
    if (text[index] === '\n') {
      flush()
      tokens.push({ type: 'br' })
      index += 1
      continue
    }
    buffer += text[index]
    index += 1
  }
  flush()
  return tokens
}

function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || LIST.test(line) || QUOTE.test(line)
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function parseList(lines: readonly string[], start: number): { block: MarkdownBlock; next: number } {
  const first = LIST.exec(lines[start]!)!
  const ordered = /^\d/.test(first[2]!)
  const baseIndent = first[1]!.length
  const startNumber = ordered ? Number.parseInt(first[2]!, 10) : 1
  const items: ListItem[] = []
  let index = start
  while (index < lines.length) {
    const match = LIST.exec(lines[index]!)
    if (match === null) break
    const indent = match[1]!.length
    if (indent < baseIndent || (indent === baseIndent && /^\d/.test(match[2]!) !== ordered)) break
    if (indent > baseIndent) break
    let body = match[3]!
    let checked: boolean | undefined
    const task = /^\[([ xX])\]\s+(.*)$/.exec(body)
    if (task !== null) {
      checked = task[1]!.toLowerCase() === 'x'
      body = task[2]!
    }
    items.push({
      inlines: parseInline(body),
      ...(checked === undefined ? {} : { checked }),
    })
    index += 1
    // Indented continuation lines belong to the same item.
    while (index < lines.length && /^\s{2,}\S/.test(lines[index]!) && !LIST.test(lines[index]!)) {
      const continuation = lines[index]!.trim()
      const previous = items[items.length - 1]!
      items[items.length - 1] = { ...previous, inlines: [...previous.inlines, { type: 'br' }, ...parseInline(continuation)] }
      index += 1
    }
  }
  return { block: { type: 'list', ordered, start: startNumber, items }, next: index }
}

/** Parse a Markdown document into safe block tokens. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.trim().length === 0) {
      index += 1
      continue
    }
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[1]!
      const lang = fence[2]!.length > 0 ? fence[2] : undefined
      const body: string[] = []
      index += 1
      while (index < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[index]!)) {
        body.push(lines[index]!)
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ type: 'code', text: body.join('\n'), ...(lang === undefined ? {} : { lang }) })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push({ type: 'heading', level: heading[1]!.length, inlines: parseInline(heading[2]!) })
      index += 1
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'hr' })
      index += 1
      continue
    }
    if (QUOTE.test(line)) {
      const body: string[] = []
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index]!)
        if (match === null) break
        body.push(match[1]!)
        index += 1
      }
      blocks.push({ type: 'quote', blocks: parseMarkdown(body.join('\n')) })
      continue
    }
    if (LIST.test(line)) {
      const parsed = parseList(lines, index)
      blocks.push(parsed.block)
      index = parsed.next
      continue
    }
    if (line.includes('|') && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1]!)) {
      const header = splitRow(line).map(parseInline)
      const rows: InlineToken[][][] = []
      index += 2
      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim().length > 0) {
        rows.push(splitRow(lines[index]!).map(parseInline))
        index += 1
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }
    const paragraph: string[] = [line]
    index += 1
    while (index < lines.length && lines[index]!.trim().length > 0 && !isBlockStart(lines[index]!)) {
      paragraph.push(lines[index]!)
      index += 1
    }
    blocks.push({ type: 'paragraph', inlines: parseInline(paragraph.join('\n')) })
  }
  return blocks
}
