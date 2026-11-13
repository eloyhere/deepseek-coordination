/** React renderer for the safe Markdown tokens used by dialogs. */
import * as React from 'react'
import { parseInline, parseMarkdown, type InlineToken, type MarkdownBlock } from './markdownCore.js'

const h = React.createElement

export interface MarkdownProps {
  readonly text: string
  readonly inline?: boolean
  readonly compact?: boolean
  readonly style?: React.CSSProperties
}

const linkStyle: React.CSSProperties = { color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2 }
const codeStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '0.9em',
  padding: '0.1em 0.3em',
  borderRadius: 3,
  background: 'rgba(127, 127, 127, 0.16)',
}

function renderInline(tokens: readonly InlineToken[]): React.ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.type) {
      case 'text': return token.text
      case 'br': return h('br', { key: index })
      case 'code': return h('code', { key: index, style: codeStyle }, token.text)
      case 'strong': return h('strong', { key: index }, ...renderInline(token.children))
      case 'em': return h('em', { key: index }, ...renderInline(token.children))
      case 'del': return h('del', { key: index }, ...renderInline(token.children))
      case 'link': return h('a', {
        key: index, href: token.href, target: '_blank', rel: 'noreferrer noopener', style: linkStyle,
      }, ...renderInline(token.children))
      default: return null
    }
  })
}

function headingStyle(level: number, compact: boolean): React.CSSProperties {
  const sizes = compact
    ? [1.05, 1.0, 0.95, 0.9, 0.88, 0.86]
    : [1.2, 1.12, 1.04, 0.98, 0.94, 0.9]
  return {
    fontSize: `${sizes[Math.min(level, 6) - 1]}rem`,
    fontWeight: 600,
    lineHeight: 1.35,
    margin: level <= 2 ? '14px 0 6px' : '12px 0 5px',
    color: 'inherit',
  }
}

function renderTable(block: Extract<MarkdownBlock, { type: 'table' }>): React.ReactElement {
  return h('div', { style: { overflowX: 'auto', margin: '8px 0' } },
    h('table', { style: { borderCollapse: 'collapse', width: '100%', fontSize: '0.85em' } },
      h('thead', null, h('tr', null, ...block.header.map((cell, index) => h('th', {
        key: index,
        style: { border: '1px solid rgba(127,127,127,0.35)', padding: '5px 7px', textAlign: 'left', verticalAlign: 'top' },
      }, ...renderInline(cell))))),
      h('tbody', null, ...block.rows.map((row, rowIndex) => h('tr', { key: rowIndex },
        ...row.map((cell, cellIndex) => h('td', {
          key: cellIndex,
          style: { border: '1px solid rgba(127,127,127,0.35)', padding: '5px 7px', verticalAlign: 'top' },
        }, ...renderInline(cell)))))),
    ))
}

function renderBlock(block: MarkdownBlock, index: number, compact: boolean): React.ReactNode {
  switch (block.type) {
    case 'heading': {
      const tag = `h${Math.min(Math.max(block.level, 1), 6)}`
      return h(tag, { key: index, style: headingStyle(block.level, compact) }, ...renderInline(block.inlines))
    }
    case 'paragraph': return h('p', {
      key: index,
      style: { margin: compact ? '0 0 6px' : '0 0 9px', lineHeight: 1.6 },
    }, ...renderInline(block.inlines))
    case 'code': return h('pre', {
      key: index,
      style: {
        margin: '8px 0', padding: '9px 11px', borderRadius: 5, overflowX: 'auto',
        background: 'rgba(127,127,127,0.12)', fontSize: '0.82em', lineHeight: 1.5,
      },
    }, h('code', null, block.text))
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul'
      return h(tag, {
        key: index,
        ...(block.ordered && block.start !== 1 ? { start: block.start } : {}),
        style: { margin: compact ? '0 0 6px' : '0 0 9px', paddingLeft: 22, lineHeight: 1.6 },
      }, ...block.items.map((item, itemIndex) => h('li', { key: itemIndex, style: { margin: '2px 0' } },
        item.checked === undefined ? null : h('input', {
          type: 'checkbox', checked: item.checked, readOnly: true, disabled: true,
          style: { marginRight: 6, verticalAlign: 'middle' },
        }),
        ...renderInline(item.inlines),
      )))
    }
    case 'quote': return h('blockquote', {
      key: index,
      style: {
        margin: '8px 0', padding: '2px 0 2px 12px', borderLeft: '3px solid rgba(127,127,127,0.4)',
        color: 'inherit', opacity: 0.92,
      },
    }, ...block.blocks.map((child, childIndex) => renderBlock(child, childIndex, compact)))
    case 'hr': return h('hr', { key: index, style: { border: 0, borderTop: '1px solid rgba(127,127,127,0.3)', margin: '12px 0' } })
    case 'table': return h(React.Fragment, { key: index }, renderTable(block))
    default: return null
  }
}

/** Render trusted Markdown syntax without injecting HTML. */
export function Markdown({ text, inline = false, compact = false, style }: MarkdownProps): React.ReactElement {
  if (inline) {
    return h('span', { style }, ...renderInline(parseInline(text)))
  }
  const blocks = parseMarkdown(text)
  return h('div', {
    style: {
      fontSize: compact ? '0.875rem' : '0.925rem',
      lineHeight: 1.6,
      overflowWrap: 'anywhere',
      ...style,
    },
  }, ...blocks.map((block, index) => renderBlock(block, index, compact)))
}
