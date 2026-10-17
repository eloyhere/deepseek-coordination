/**
 * Generic formula detection and extraction, by dialect.
 *
 * Supported P0 dialects:
 *
 * | Dialect | Syntax | What this module extracts |
 * |---|---|---|
 * | `markdown-math` | `$...$`, `$$...$$` | text, span, delimiter, container, `\label`/`\ref` references |
 * | `tex` | `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, math environments | same, plus `equation`/`align`/`gather`/`array`/`matrix` containers |
 * | `spreadsheet` | a cell whose text starts with `=` | expression text, A1/range/name references, `computes` semantics |
 * | `mathml` / `omml` | `<math>`, `<m:oMath>` | detection only: the element span; no AST, marked `unverifiable` |
 * | `unknown` | anything else | one `unverifiable` placeholder; never a guess |
 *
 * There is no evaluation, no macro expansion, no rendering and no AST
 * evaluation. Formula text/span/references are extracted so a later layer can
 * build `Formula` nodes and `references` edges.
 *
 * Bounded: formula text 8,192 chars for TeX and 32,768 for markup/other
 * dialects; at most 5,000 formulas and 512 references per scan. Excluded ranges
 * (fenced code, inline code, comments) are honoured so code is never parsed as
 * math.
 *
 * Complexity: every scanner is a single forward pass, O(n) time in the source
 * and O(results) space. `markdownCodeRanges` is also O(n). Refs are extracted by
 * a second pass over each formula's (capped) text, so total work remains
 * O(source + formula text).
 */
import type { SourceSpan } from '../../shared/ast.js'
import { InvalidArgumentError } from '../../shared/error.js'
import { createSpanLocator, referenceForSpan } from './parser.js'
import type { NodeMetadataInput, ParseContext } from './parser.js'
import { splitTextLines } from './tokenizer.js'

/** Dialect of an embedded formula. */
export type FormulaDialect =
  | 'spreadsheet'
  | 'tex'
  | 'markdown-math'
  | 'mathml'
  | 'omml'
  | 'asciimath'
  | 'typst'
  | 'unknown'

/** Delimiter form: inline math, display block, spreadsheet cell, environment. */
export type FormulaDelimiter = 'inline' | 'block' | 'cell' | 'environment'

/** Where the formula lives. */
export type FormulaContainer = 'cell' | 'paragraph' | 'block' | 'heading'

/** What the formula is for: computation, typesetting, both or unknown. */
export type FormulaSemantics = 'computes' | 'typesets' | 'both' | 'unknown'

/** Kind of a reference made from inside a formula. */
export type FormulaReferenceKind =
  | 'cell'
  | 'range'
  | 'name'
  | 'symbol'
  | 'label'
  | 'equation'
  | 'bibliography'

/** One reference made by a formula. */
export interface FormulaReference {
  kind: FormulaReferenceKind
  sheet?: string
  start: string
  end?: string
  absoluteStart?: boolean
  absoluteEnd?: boolean
}

/**
 * The generic formula shape. Deliberately not the domain `Formula` node (that
 * node adds identity/status); this is the parser-layer projection.
 */
export interface Formula {
  dialect: FormulaDialect
  delimiter: FormulaDelimiter
  container: FormulaContainer
  semantics: FormulaSemantics
  /** Formula body without delimiters (capped). */
  text: string
  /** Full source text including delimiters. */
  raw: string
  span: SourceSpan
  references: FormulaReference[]
  /** True when text was clipped or the closing delimiter was missing. */
  truncated: boolean
  /** True when the formula cannot be trusted as complete (detection only, overflow, ...). */
  unverifiable: boolean
  /** Why the formula is unverifiable, when it is. */
  reason?: string
  /** Optional explicit name: a TeX `\label` inside the formula. */
  name?: string
  /** Spreadsheet cell address, when the dialect is `spreadsheet`. */
  address?: string
  /** Spreadsheet sheet name, when known. */
  sheet?: string
  /** TeX environment name, when the delimiter is `environment`. */
  environment?: string
}

/** Result of a scan, including whether the formula cap was hit. */
export interface FormulaScanResult {
  formulas: Formula[]
  truncated: boolean
}

/** Options shared by the scanners. */
export interface FormulaScanOptions {
  /** Source ranges the scanner must not enter (code fences, comments, ...). */
  excluded?: readonly SourceSpan[]
  /** Override the container; by default inline → paragraph, block → block. */
  containerAt?: (offset: number, delimiter: FormulaDelimiter) => FormulaContainer
  /** Maximum formulas emitted; default 5,000. */
  maxFormulas?: number
  /** Maximum formula body length; defaults by dialect. */
  maxTextLength?: number
  /** Stop hook for deadlines/aborts; consulted every ~2,048 source characters. */
  shouldStop?: () => boolean
  /** For `$` scanning: `markdown-math` (default) or `tex`. */
  dialect?: FormulaDialect
}

/** Maximum formulas per document. */
export const MAX_FORMULAS = 5_000
/** Maximum references extracted from one formula. */
export const MAX_FORMULA_REFERENCES = 512
/** Maximum TeX formula body. */
export const MAX_TEX_FORMULA_TEXT = 8_192
/** Maximum markup/other formula body. */
export const MAX_MARKUP_FORMULA_TEXT = 32_768

/** Environments that represent a typeset formula rather than a statement. */
const MATH_ENVIRONMENTS: ReadonlySet<string> = new Set([
  'equation', 'align', 'alignat', 'gather', 'multline', 'flalign', 'eqnarray',
  'array', 'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'Vmatrix', 'cases',
  'split', 'aligned', 'gathered', 'subequations',
])

/** TeX commands that make a formula reference. */
const REFERENCE_COMMANDS: Readonly<Record<string, FormulaReferenceKind>> = {
  label: 'label',
  ref: 'label',
  eqref: 'equation',
  autoref: 'label',
  pageref: 'label',
  cite: 'bibliography',
  citep: 'bibliography',
  citet: 'bibliography',
}

/**
 * Detect the formula dialect from an explicit dialect/language/path and then
 * from unambiguous content signals.
 *
 * Explicit input always wins. Path/language mapping is deterministic. Content
 * detection only recognises declared markers (`<m:oMath`, `<math`,
 * `\documentclass`/`\begin`, `\(`/`\[`, `$`, a leading `=`); anything else is
 * `unknown` — this function does not guess.
 */
export interface FormulaDialectInput {
  dialect?: FormulaDialect
  language?: string
  path?: string
  text?: string
  /** True when the caller is inspecting a spreadsheet cell. */
  spreadsheetCell?: boolean
}

/** Detect a formula dialect; `unknown` when no explicit signal exists. */
export function detectFormulaDialect(input: FormulaDialectInput): FormulaDialect {
  if (input.dialect !== undefined) return input.dialect
  if (input.spreadsheetCell === true) return 'spreadsheet'
  const language = input.language?.toLowerCase()
  if (language !== undefined) {
    const mapped = languageDialect(language)
    if (mapped !== undefined) return mapped
  }
  if (input.path !== undefined) {
    const lower = input.path.toLowerCase()
    if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')) {
      return 'markdown-math'
    }
    if (lower.endsWith('.tex') || lower.endsWith('.ltx') || lower.endsWith('.latex')) return 'tex'
    if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return 'spreadsheet'
    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      return input.text !== undefined && containsMathMl(input.text) ? 'mathml' : 'unknown'
    }
  }
  const text = input.text
  if (text === undefined) return 'unknown'
  if (text.trimStart().startsWith('=')) return 'spreadsheet'
  const lower = text.toLowerCase()
  if (lower.includes('<m:omath')) return 'omml'
  if (lower.includes('<math')) return 'mathml'
  if (text.includes('\\documentclass') || text.includes('\\begin{') || text.includes('\\(') || text.includes('\\[')) {
    return 'tex'
  }
  if (text.includes('$$') || text.includes('$')) return 'markdown-math'
  return 'unknown'
}

/** Map a `Language` string to a formula dialect, or undefined. */
function languageDialect(language: string): FormulaDialect | undefined {
  switch (language) {
    case 'markdown':
      return 'markdown-math'
    case 'latex':
    case 'tex':
      return 'tex'
    case 'xlsx':
    case 'csv':
      return 'spreadsheet'
    case 'html':
      return 'unknown'
    default:
      return undefined
  }
}

/**
 * Ranges of Markdown code that must never be scanned for links or formulas:
 * fenced code blocks (including their bodies) and inline code spans.
 *
 * Single pass over the lines; time O(n), space O(ranges).
 */
export function markdownCodeRanges(text: string): { fences: SourceSpan[]; inline: SourceSpan[] } {
  const lines = splitTextLines(text)
  const locate = createSpanLocator(text)
  const fences: SourceSpan[] = []
  const inline: SourceSpan[] = []
  let fenceStartLine = -1
  let fenceMarker = ''
  let fenceLength = 0
  let fenceStartOffset = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (fenceStartLine >= 0) {
      const trimmed = line.text.trimStart()
      if (isClosingFence(trimmed, fenceMarker, fenceLength)) {
        fences.push(locate(fenceStartOffset, line.end))
        fenceStartLine = -1
        fenceMarker = ''
        fenceLength = 0
      }
      continue
    }
    const trimmed = line.text.trimStart()
    const fence = matchOpeningFence(trimmed)
    if (fence !== undefined) {
      fenceStartLine = index
      fenceMarker = fence.marker
      fenceLength = fence.length
      fenceStartOffset = line.start
      continue
    }
    // Inline code spans on a non-fence line.
    let cursor = 0
    while (cursor < line.text.length) {
      if (line.text[cursor] !== '`') {
        cursor += 1
        continue
      }
      let runEnd = cursor
      while (runEnd < line.text.length && line.text[runEnd] === '`') runEnd += 1
      const run = runEnd - cursor
      let close = findBacktickRun(line.text, runEnd, run)
      if (close < 0) {
        cursor = runEnd
        continue
      }
      inline.push(locate(line.start + cursor, line.start + close + run))
      cursor = close + run
    }
  }
  if (fenceStartLine >= 0) {
    // Unterminated fence: everything to EOF is code.
    fences.push(locate(fenceStartOffset, text.length))
  }
  return { fences, inline }
}

/** Extract `$...$`/`$$...$$` formulas from Markdown, excluding code ranges. */
export function extractMarkdownFormulas(text: string, options: FormulaScanOptions = {}): Formula[] {
  const code = markdownCodeRanges(text)
  const excluded = [...code.fences, ...code.inline, ...(options.excluded ?? [])]
  return scanDollarFormulas(text, { ...options, excluded, dialect: 'markdown-math' }).formulas
}

/** Extract all TeX math delimiters and environments. */
export function extractTexFormulas(text: string, options: FormulaScanOptions = {}): Formula[] {
  const excluded = [...texCommentRanges(text), ...(options.excluded ?? [])]
  return scanTexFormulas(text, { ...options, excluded }).formulas
}

/**
 * Scan `$...$` and `$$...$$`.
 *
 * A lone or escaped `$` is text. An unterminated block formula is emitted with
 * `unverifiable: true` and `truncated: true` so the caller can decide; an
 * unterminated inline candidate is not a formula.
 *
 * Time O(n), space O(formulas).
 */
export function scanDollarFormulas(text: string, options: FormulaScanOptions = {}): FormulaScanResult {
  const state = createScanState(text, options, 'markdown-math')
  return scanDollarLike(state, options)
}

/**
 * Scan TeX math: `$`, `$$`, `\(...\)`, `\[...\]` and math environments
 * (`equation`, `align`, `gather`, `array`, `matrix`, ...).
 *
 * Time O(n), space O(formulas).
 */
export function scanTexFormulas(text: string, options: FormulaScanOptions = {}): FormulaScanResult {
  const state = createScanState(text, options, 'tex')
  const formulas: Formula[] = []
  let truncated = false
  let index = 0
  let lastCheck = 0
  while (index < text.length) {
    if (index - lastCheck >= 2_048) {
      lastCheck = index
      if (options.shouldStop?.() === true) {
        truncated = true
        break
      }
    }
    const skippedTo = skipExcluded(state, index)
    if (skippedTo !== index) {
      index = skippedTo
      continue
    }
    if (formulas.length >= state.maxFormulas) {
      truncated = true
      break
    }
    const code = text.charCodeAt(index)
    if (code === 36) {
      const next = consumeDollar(state, index, options)
      if (next.formula !== undefined) formulas.push(next.formula)
      index = next.next
      continue
    }
    if (code === 92) {
      const handled = consumeTexDelimiter(state, index, options)
      if (handled !== undefined) {
        if (handled.formula !== undefined) formulas.push(handled.formula)
        index = handled.next
        continue
      }
      index = advanceCommand(text, index)
      continue
    }
    index += 1
  }
  if (formulas.length >= state.maxFormulas) truncated = true
  return { formulas, truncated }
}

/** One spreadsheet cell's text, for `extractSpreadsheetFormulas`. */
export interface SpreadsheetCell {
  /** A1 address, e.g. `B3`. */
  address: string
  text: string
  /** Sheet name, when known. */
  sheet?: string
}

/**
 * Extract formulas from spreadsheet cells whose text starts with `=`.
 *
 * The span is cell-local (`{0, text.length, 1, 1}`) because the parsers here
 * never see the workbook grid. A cell that does not start with `=` is not a
 * formula. External `[Book]Sheet!A1` links mark the formula `unverifiable` and
 * are not resolved as references.
 *
 * Time O(total cell text), space O(formulas).
 */
export function extractSpreadsheetFormulas(
  cells: Iterable<SpreadsheetCell>,
  options: FormulaScanOptions = {},
): Formula[] {
  const maxFormulas = normaliseMaxFormulas(options.maxFormulas)
  const maxText = normaliseMaxText(options.maxTextLength, MAX_TEX_FORMULA_TEXT)
  const formulas: Formula[] = []
  for (const cell of cells) {
    if (formulas.length >= maxFormulas) break
    if (options.shouldStop?.() === true) break
    if (typeof cell.text !== 'string' || !cell.text.startsWith('=')) continue
    const expression = cell.text.slice(1)
    const clipped = expression.length > maxText
    const text = clipped ? expression.slice(0, maxText) : expression
    const extracted = collectSpreadsheetReferences(text)
    formulas.push({
      dialect: 'spreadsheet',
      delimiter: 'cell',
      container: 'cell',
      semantics: 'computes',
      text,
      raw: cell.text,
      span: { start: 0, end: cell.text.length, line: 1, column: 1 },
      references: clipped ? [] : extracted.references,
      truncated: clipped,
      unverifiable: clipped || extracted.unverifiable,
      ...(clipped
        ? { reason: `formula text exceeds ${maxText} characters` }
        : extracted.reason === undefined
          ? {}
          : { reason: extracted.reason }),
      address: cell.address,
      ...(cell.sheet === undefined ? {} : { sheet: cell.sheet }),
    })
  }
  return formulas
}

/** Detect MathML `<math>` elements. Detection only: never an AST. */
export function detectMathMlFormulas(text: string, options: FormulaScanOptions = {}): Formula[] {
  return detectElementFormulas(text, 'math', 'mathml', options)
}

/** Detect OMML `<m:oMath>` elements. Detection only: never an AST. */
export function detectOmmlFormulas(text: string, options: FormulaScanOptions = {}): Formula[] {
  return detectElementFormulas(text, 'm:omath', 'omml', options)
}

/** Detect both MathML and OMML, in source order. */
export function detectMarkupFormulas(text: string, options: FormulaScanOptions = {}): Formula[] {
  const formulas = [...detectMathMlFormulas(text, options), ...detectOmmlFormulas(text, options)]
  formulas.sort((left, right) => left.span.start - right.span.start)
  return formulas
}

/**
 * Dialect-dispatching extraction entry point.
 *
 * The dialect comes from `options.dialect`, then language/path, then content
 * detection. An `unknown` dialect yields one placeholder formula marked
 * `unverifiable` rather than an empty list plus a silent success, so callers can
 * surface "nothing was extracted because the dialect is unknown".
 */
export interface ExtractFormulaOptions extends FormulaScanOptions {
  dialect?: FormulaDialect
  language?: string
  path?: string
  /** Spreadsheet cells, when the caller has a grid. */
  cells?: Iterable<SpreadsheetCell>
}

/** Extract formulas for a caller-specified or detected dialect. */
export function extractFormulas(text: string, options: ExtractFormulaOptions = {}): Formula[] {
  const dialect = detectFormulaDialect({
    ...(options.dialect === undefined ? {} : { dialect: options.dialect }),
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.path === undefined ? {} : { path: options.path }),
    text,
    spreadsheetCell: options.cells !== undefined,
  })
  switch (dialect) {
    case 'markdown-math':
      return extractMarkdownFormulas(text, options)
    case 'tex':
      return extractTexFormulas(text, options)
    case 'spreadsheet':
      return options.cells === undefined ? [] : extractSpreadsheetFormulas(options.cells, options)
    case 'mathml':
      return detectMathMlFormulas(text, options)
    case 'omml':
      return detectOmmlFormulas(text, options)
    default: {
      if (text.length === 0) return []
      const maxText = normaliseMaxText(options.maxTextLength, MAX_MARKUP_FORMULA_TEXT)
      const clipped = text.length > maxText
      return [
        {
          dialect: 'unknown',
          delimiter: 'block',
          container: 'block',
          semantics: 'unknown',
          text: clipped ? text.slice(0, maxText) : text,
          raw: text,
          span: { start: 0, end: text.length, line: 1, column: 1 },
          references: [],
          truncated: clipped,
          unverifiable: true,
          reason: 'unknown formula dialect; no extraction attempted',
        },
      ]
    }
  }
}

/**
 * `NodeMetadata` input for a formula: name from an explicit label, summary from
 * dialect/delimiter (≤200), and a body-free reference. No expression text is
 * copied into metadata; `brief` is only populated when the formula carries an
 * explicit meaning (P0 extracts none, so it stays empty and the caller reports
 * `unverifiable`). The reference points at the file span, or at the cell for a
 * spreadsheet formula.
 */
export function formulaMetadata(
  ctx: ParseContext,
  formula: Formula,
  parserId = 'formula',
): NodeMetadataInput {
  const label = formula.references.find((reference) => reference.kind === 'label' || reference.kind === 'equation')
  const cell = formula.address === undefined
    ? undefined
    : `${formula.sheet === undefined ? '' : `${formula.sheet}!`}${formula.address}`
  const target = cell ?? (ctx.path === undefined
    ? `formula:${formula.span.start}`
    : `${ctx.path}#formula:${formula.span.start}`)
  return {
    kind: 'formula',
    ...(formula.name !== undefined ? { name: formula.name } : label === undefined ? {} : { name: label.start }),
    summary: `${formula.dialect} ${formula.delimiter} formula`,
    ...(cell === undefined
      ? {
          reference: referenceForSpan(ctx, {
            scheme: 'formula',
            target,
            span: formula.span,
            parserId,
          }),
        }
      : {
          reference: {
            scheme: 'sheet-cell' as const,
            target: cell,
            charset: 'utf-8' as const,
            span: formula.span,
            parserId,
          },
        }),
    source: 'annotation',
    span: formula.span,
  }
}

/* ------------------------------------------------------------------------- *
 * Shared scanning internals
 * ------------------------------------------------------------------------- */

interface ScanState {
  text: string
  locate: (start: number, end: number) => SourceSpan
  excluded: SourceSpan[]
  maxFormulas: number
  maxText: number
  containerAt: ((offset: number, delimiter: FormulaDelimiter) => FormulaContainer) | undefined
  dialect: FormulaDialect
}

function createScanState(
  text: string,
  options: FormulaScanOptions,
  defaultDialect: FormulaDialect,
): ScanState {
  if (typeof text !== 'string') {
    throw new InvalidArgumentError('formula scanner requires a string source', { type: typeof text })
  }
  const dialect = options.dialect ?? defaultDialect
  const excluded = [...(options.excluded ?? [])]
    .filter((span) => span.start < span.end)
    .sort((left, right) => left.start - right.start)
  return {
    text,
    locate: createSpanLocator(text),
    excluded,
    maxFormulas: normaliseMaxFormulas(options.maxFormulas),
    maxText: normaliseMaxText(
      options.maxTextLength,
      dialect === 'tex' ? MAX_TEX_FORMULA_TEXT : MAX_MARKUP_FORMULA_TEXT,
    ),
    containerAt: options.containerAt,
    dialect,
  }
}

function normaliseMaxFormulas(value: number | undefined): number {
  if (value === undefined) return MAX_FORMULAS
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidArgumentError('maxFormulas must be a positive integer', { maxFormulas: value })
  }
  return value
}

function normaliseMaxText(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidArgumentError('maxTextLength must be a positive integer', { maxTextLength: value })
  }
  return value
}

/** If `offset` is inside an excluded range, return that range's end; else offset. */
function skipExcluded(state: ScanState, offset: number): number {
  for (const span of state.excluded) {
    if (span.end <= offset) continue
    if (span.start > offset) break
    return span.end
  }
  return offset
}

/** Shared `$`/`$$` scanner used by Markdown and TeX. */
function scanDollarLike(state: ScanState, options: FormulaScanOptions): FormulaScanResult {
  const formulas: Formula[] = []
  const text = state.text
  let truncated = false
  let index = 0
  let lastCheck = 0
  while (index < text.length) {
    if (index - lastCheck >= 2_048) {
      lastCheck = index
      if (options.shouldStop?.() === true) {
        truncated = true
        break
      }
    }
    const skippedTo = skipExcluded(state, index)
    if (skippedTo !== index) {
      index = skippedTo
      continue
    }
    if (formulas.length >= state.maxFormulas) {
      truncated = true
      break
    }
    if (text.charCodeAt(index) !== 36 || isEscaped(text, index)) {
      index += 1
      continue
    }
    const consumed = consumeDollar(state, index, options)
    if (consumed.formula !== undefined) formulas.push(consumed.formula)
    if (consumed.truncated) truncated = true
    index = consumed.next
  }
  if (formulas.length >= state.maxFormulas) truncated = true
  return { formulas, truncated }
}

interface DollarConsumption {
  next: number
  formula?: Formula
  truncated?: boolean
}

/** Consume one `$...$`/`$$...$$` candidate starting at `start`. */
function consumeDollar(state: ScanState, start: number, options: FormulaScanOptions): DollarConsumption {
  const text = state.text
  const isBlock = text.charCodeAt(start + 1) === 36
  if (isBlock) {
    const contentStart = start + 2
    const close = findUnescaped(text, '$$', contentStart)
    if (close < 0) {
      const inner = text.slice(contentStart, Math.min(text.length, contentStart + state.maxText))
      const clipped = contentStart + state.maxText < text.length
      return {
        next: text.length,
        formula: makeFormula(state, {
          dialect: state.dialect,
          delimiter: 'block',
          content: inner,
          raw: text.slice(start),
          span: state.locate(start, text.length),
          truncated: true,
          unverifiable: true,
          reason: 'unterminated block formula',
        }),
        truncated: true,
      }
    }
    const inner = text.slice(contentStart, close)
    const raw = text.slice(start, close + 2)
    return {
      next: close + 2,
      formula: makeFormula(state, {
        dialect: state.dialect,
        delimiter: 'block',
        content: inner,
        raw,
        span: state.locate(start, close + 2),
      }),
    }
  }
  const contentStart = start + 1
  const close = findInlineDollarClose(text, contentStart)
  if (close < 0) return { next: start + 1 }
  const inner = text.slice(contentStart, close)
  if (inner.length === 0) return { next: start + 1 }
  // Currency heuristic: "$ 5" / "5 $" is text, not inline math.
  if (/\s/.test(inner[0]) || /\s/.test(inner[inner.length - 1])) return { next: start + 1 }
  return {
    next: close + 1,
    formula: makeFormula(state, {
      dialect: state.dialect,
      delimiter: 'inline',
      content: inner,
      raw: text.slice(start, close + 1),
      span: state.locate(start, close + 1),
    }),
  }
}

interface TexConsumption {
  next: number
  formula?: Formula
}

/** Consume `\(...\)`, `\[...\]` or a math environment starting at `start`. */
function consumeTexDelimiter(
  state: ScanState,
  start: number,
  options: FormulaScanOptions,
): TexConsumption | undefined {
  const text = state.text
  const marker = text[start + 1]
  if (marker === '(') {
    const close = text.indexOf('\\)', start + 2)
    if (close < 0) return { next: start + 2 }
    return {
      next: close + 2,
      formula: makeFormula(state, {
        dialect: 'tex',
        delimiter: 'inline',
        content: text.slice(start + 2, close),
        raw: text.slice(start, close + 2),
        span: state.locate(start, close + 2),
      }),
    }
  }
  if (marker === '[') {
    const close = text.indexOf('\\]', start + 2)
    if (close < 0) return { next: start + 2 }
    return {
      next: close + 2,
      formula: makeFormula(state, {
        dialect: 'tex',
        delimiter: 'block',
        content: text.slice(start + 2, close),
        raw: text.slice(start, close + 2),
        span: state.locate(start, close + 2),
      }),
    }
  }
  if (!text.startsWith('\\begin{', start)) return undefined
  const nameStart = start + '\\begin{'.length
  const nameEnd = text.indexOf('}', nameStart)
  if (nameEnd < 0) return { next: nameStart }
  const environment = text.slice(nameStart, nameEnd)
  if (!isMathEnvironment(environment)) return undefined
  const end = findEnvironmentEnd(text, environment, nameEnd + 1, state.excluded)
  if (end === undefined) {
    const contentEnd = Math.min(text.length, nameEnd + 1 + state.maxText)
    return {
      next: text.length,
      formula: makeFormula(state, {
        dialect: 'tex',
        delimiter: 'environment',
        content: text.slice(nameEnd + 1, contentEnd),
        raw: text.slice(start),
        span: state.locate(start, text.length),
        truncated: contentEnd < text.length,
        unverifiable: true,
        reason: `unterminated ${environment} environment`,
        environment,
      }),
    }
  }
  const content = text.slice(nameEnd + 1, end.start)
  return {
    next: end.next,
    formula: makeFormula(state, {
      dialect: 'tex',
      delimiter: 'environment',
      content,
      raw: text.slice(start, end.next),
      span: state.locate(start, end.next),
      environment,
    }),
  }
}

/** Build one `Formula`, applying caps, references and container rules. */
function makeFormula(
  state: ScanState,
  input: {
    dialect: FormulaDialect
    delimiter: FormulaDelimiter
    content: string
    raw: string
    span: SourceSpan
    environment?: string
    truncated?: boolean
    unverifiable?: boolean
    reason?: string
  },
): Formula {
  const clipped = input.content.length > state.maxText
  const trimmed = input.delimiter === 'inline' || input.delimiter === 'cell'
    ? input.content
    : input.content.trim()
  const text = clipped ? trimmed.slice(0, state.maxText) : trimmed
  const container =
    state.containerAt?.(input.span.start, input.delimiter) ??
    (input.delimiter === 'inline' ? 'paragraph' : 'block')
  const references = clipped ? [] : collectTexFormulaReferences(text)
  const label = references.find((reference) => reference.kind === 'label')
  return {
    dialect: input.dialect,
    delimiter: input.delimiter,
    container,
    semantics: 'typesets',
    text,
    raw: input.raw,
    span: input.span,
    references,
    truncated: clipped || input.truncated === true,
    unverifiable: clipped || input.unverifiable === true,
    ...(clipped
      ? { reason: `formula text exceeds ${state.maxText} characters` }
      : input.reason === undefined
        ? {}
        : { reason: input.reason }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(label === undefined ? {} : { name: label.start }),
  }
}

/**
 * Extract `\label`/`\ref`/`\eqref`/`\cite` references from formula text.
 * Time O(text length), space O(references).
 */
export function collectTexFormulaReferences(text: string): FormulaReference[] {
  const references: FormulaReference[] = []
  let index = 0
  while (index < text.length && references.length < MAX_FORMULA_REFERENCES) {
    const slash = text.indexOf('\\', index)
    if (slash < 0) break
    let cursor = slash + 1
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor)
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) cursor += 1
      else break
    }
    const command = text.slice(slash + 1, cursor)
    const kind = REFERENCE_COMMANDS[command]
    if (kind === undefined || text[cursor] !== '{') {
      index = slash + 1
      continue
    }
    const close = text.indexOf('}', cursor + 1)
    if (close < 0) {
      index = cursor + 1
      continue
    }
    const raw = text.slice(cursor + 1, close)
    if (command === 'cite' || command === 'citep' || command === 'citet') {
      for (const entry of raw.split(',')) {
        const name = entry.trim()
        if (name.length > 0) references.push({ kind, start: name })
        if (references.length >= MAX_FORMULA_REFERENCES) break
      }
    } else if (raw.length > 0) {
      references.push({ kind, start: raw })
    }
    index = close + 1
  }
  return references
}

/** One formula reference extraction result. */
export interface SpreadsheetReferenceResult {
  references: FormulaReference[]
  unverifiable: boolean
  reason?: string
}

/**
 * Extract A1/range/name references from a spreadsheet formula expression.
 * Skips string literals, function names, booleans and error values; external
 * `[Book]` links make the result unverifiable.
 *
 * Time O(expression length), space O(references).
 */
export function collectSpreadsheetReferences(expression: string): SpreadsheetReferenceResult {
  const references: FormulaReference[] = []
  let unverifiable = false
  let reason: string | undefined
  let index = 0
  while (index < expression.length && references.length < MAX_FORMULA_REFERENCES) {
    const character = expression[index]
    if (character === '"') {
      index = skipSpreadsheetString(expression, index)
      continue
    }
    if (character === '[') {
      const close = expression.indexOf(']', index + 1)
      unverifiable = true
      reason = 'external workbook reference is not resolved'
      // Skip the external `[Book]Sheet!A1` target as a whole: it is outside this
      // workbook, so it must not become a local reference.
      let cursor = close < 0 ? expression.length : close + 1
      const bang = expression.indexOf('!', cursor)
      if (bang >= 0 && bang - cursor < 64) {
        const cell = parseCellAt(expression, bang + 1, undefined)
        const name = readName(expression, bang + 1)
        cursor = cell?.end ?? name?.end ?? bang + 1
      }
      index = cursor
      continue
    }
    if (character === "'") {
      // Quoted sheet name: consume up to the closing quote and any `!` suffix.
      let cursor = index + 1
      while (cursor < expression.length) {
        if (expression[cursor] === "'") {
          if (expression[cursor + 1] === "'") {
            cursor += 2
            continue
          }
          break
        }
        cursor += 1
      }
      if (cursor >= expression.length) {
        index = expression.length
        continue
      }
      const sheet = expression.slice(index + 1, cursor).replaceAll("''", "'")
      const bang = expression.indexOf('!', cursor + 1)
      if (bang === cursor + 1) {
        const parsed = parseCellAt(expression, bang + 1, sheet)
        if (parsed !== undefined) {
          references.push(parsed.reference)
          index = parsed.end
          continue
        }
        const name = readName(expression, bang + 1)
        if (name !== undefined) {
          references.push({ kind: 'name', sheet, start: name.value })
          index = name.end
          continue
        }
        index = bang + 1
        continue
      }
      index = cursor + 1
      continue
    }
    const code = expression.charCodeAt(index)
    if (character === '$') {
      const cell = parseCellAt(expression, index, undefined)
      if (cell !== undefined) {
        references.push(cell.reference)
        index = cell.end
        continue
      }
      index += 1
      continue
    }
    if (isIdentifierStartCode(code)) {
      const parsed = parseSheetQualified(expression, index)
      if (parsed !== undefined) {
        references.push(parsed.reference)
        index = parsed.end
        continue
      }
      const name = readName(expression, index)
      if (name !== undefined) {
        const upper = name.value.toUpperCase()
        const isCall = expression[name.end] === '('
        const isBoolean = upper === 'TRUE' || upper === 'FALSE'
        if (!isCall && !isBoolean) references.push({ kind: 'name', start: name.value })
        // Continue inside the argument list (not past it) so `SUM(A1:B2)` still
        // contributes its cell/range references; the function name itself is not
        // a name reference.
        index = isCall ? name.end + 1 : name.end
        continue
      }
    }
    index += 1
  }
  return {
    references,
    unverifiable,
    ...(reason === undefined ? {} : { reason }),
  }
}

/** Parse `Sheet!A1`, `Sheet!Name`, `A1:B3` or a bare cell at `start`. */
function parseSheetQualified(
  expression: string,
  start: number,
): { reference: FormulaReference; end: number } | undefined {
  const name = readName(expression, start)
  if (name === undefined) return undefined
  if (expression[name.end] === '!') {
    const sheet = name.value
    const parsed = parseCellAt(expression, name.end + 1, sheet)
    if (parsed !== undefined) return parsed
    const referenceName = readName(expression, name.end + 1)
    if (referenceName !== undefined) {
      return { reference: { kind: 'name', sheet, start: referenceName.value }, end: referenceName.end }
    }
    return undefined
  }
  return parseCellAt(expression, start, undefined)
}

/** Parse a cell or range starting at `start`; `sheet` is attached when known. */
function parseCellAt(
  expression: string,
  start: number,
  sheet: string | undefined,
): { reference: FormulaReference; end: number } | undefined {
  const first = parseSingleCell(expression, start)
  if (first === undefined) return undefined
  if (expression[first.end] === ':') {
    const second = parseSingleCell(expression, first.end + 1)
    if (second !== undefined) {
      return {
        reference: {
          kind: 'range',
          ...(sheet === undefined ? {} : { sheet }),
          start: first.address,
          end: second.address,
          ...(first.absoluteColumn || first.absoluteRow ? { absoluteStart: true } : {}),
          ...(second.absoluteColumn || second.absoluteRow ? { absoluteEnd: true } : {}),
        },
        end: second.end,
      }
    }
  }
  return {
    reference: {
      kind: 'cell',
      ...(sheet === undefined ? {} : { sheet }),
      start: first.address,
      ...(first.absoluteColumn || first.absoluteRow ? { absoluteStart: true } : {}),
    },
    end: first.end,
  }
}

interface SingleCell {
  address: string
  end: number
  absoluteColumn: boolean
  absoluteRow: boolean
}

/** Parse `$?[A-Za-z]{1,3}$?[0-9]{1,7}` at `start`. */
function parseSingleCell(expression: string, start: number): SingleCell | undefined {
  let cursor = start
  let absoluteColumn = false
  let absoluteRow = false
  if (expression[cursor] === '$') {
    absoluteColumn = true
    cursor += 1
  }
  const columnStart = cursor
  while (cursor < expression.length && isAsciiLetterCode(expression.charCodeAt(cursor))) cursor += 1
  const columnLength = cursor - columnStart
  if (columnLength < 1 || columnLength > 3) return undefined
  if (expression[cursor] === '$') {
    absoluteRow = true
    cursor += 1
  }
  const rowStart = cursor
  while (cursor < expression.length && expression.charCodeAt(cursor) >= 48 && expression.charCodeAt(cursor) <= 57) {
    cursor += 1
  }
  const rowLength = cursor - rowStart
  if (rowLength < 1 || rowLength > 7) return undefined
  if (expression[cursor] === '$') return undefined
  return {
    address: expression.slice(start, cursor),
    end: cursor,
    absoluteColumn,
    absoluteRow,
  }
}

/** Read `[A-Za-z_][A-Za-z0-9_.]*` at `start`. */
function readName(expression: string, start: number): { value: string; end: number } | undefined {
  if (!isIdentifierStartCode(expression.charCodeAt(start))) return undefined
  let cursor = start + 1
  while (cursor < expression.length) {
    const code = expression.charCodeAt(cursor)
    if (
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 95 ||
      code === 46
    ) {
      cursor += 1
      continue
    }
    break
  }
  return { value: expression.slice(start, cursor), end: cursor }
}

/** Skip a function call argument list starting at `(`. */
function skipCall(expression: string, open: number): number {
  let depth = 0
  let cursor = open
  while (cursor < expression.length) {
    const character = expression[cursor]
    if (character === '"') {
      cursor = skipSpreadsheetString(expression, cursor)
      continue
    }
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth === 0) return cursor + 1
    }
    cursor += 1
  }
  return cursor
}

/** Skip a `"`-quoted spreadsheet string; doubled quotes escape. */
function skipSpreadsheetString(expression: string, start: number): number {
  let cursor = start + 1
  while (cursor < expression.length) {
    if (expression[cursor] === '"') {
      if (expression[cursor + 1] === '"') {
        cursor += 2
        continue
      }
      return cursor + 1
    }
    cursor += 1
  }
  return cursor
}

/** Detect `<tag ...>...</tag>` style math containers. Detection only. */
function detectElementFormulas(
  text: string,
  tag: string,
  dialect: FormulaDialect,
  options: FormulaScanOptions,
): Formula[] {
  const maxFormulas = normaliseMaxFormulas(options.maxFormulas)
  const maxText = normaliseMaxText(options.maxTextLength, MAX_MARKUP_FORMULA_TEXT)
  const locate = createSpanLocator(text)
  const formulas: Formula[] = []
  const lower = text.toLowerCase()
  let index = 0
  let lastCheck = 0
  while (index < lower.length && formulas.length < maxFormulas) {
    if (index - lastCheck >= 2_048) {
      lastCheck = index
      if (options.shouldStop?.() === true) break
    }
    const open = lower.indexOf(`<${tag}`, index)
    if (open < 0) break
    const openEnd = lower.indexOf('>', open)
    if (openEnd < 0) break
    const close = lower.indexOf(`</${tag}`, openEnd + 1)
    const end = close < 0 ? text.length : lower.indexOf('>', close) + 1 || text.length
    const contentStart = openEnd + 1
    const contentEnd = close < 0 ? text.length : close
    const clipped = contentEnd - contentStart > maxText
    formulas.push({
      dialect,
      delimiter: 'block',
      container: options.containerAt?.(open, 'block') ?? 'block',
      semantics: 'typesets',
      text: text.slice(contentStart, clipped ? contentStart + maxText : contentEnd),
      raw: text.slice(open, end),
      span: locate(open, end),
      references: [],
      truncated: clipped || close < 0,
      unverifiable: true,
      reason: 'malformed or detection-only math container; no AST extraction',
    })
    index = end
  }
  return formulas
}

/** TeX `%` comment ranges (including the `%`). Escaped `%` is text. */
export function texCommentRanges(text: string): SourceSpan[] {
  const ranges: SourceSpan[] = []
  const locate = createSpanLocator(text)
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (code === 37 && !isEscaped(text, index)) {
      const start = index
      while (index < text.length) {
        const next = text.charCodeAt(index)
        if (next === 10 || next === 13) break
        index += 1
      }
      ranges.push(locate(start, index))
      continue
    }
    index += 1
  }
  return ranges
}

/** True for a math environment name (starred variants included). */
export function isMathEnvironment(name: string): boolean {
  return MATH_ENVIRONMENTS.has(name.endsWith('*') ? name.slice(0, -1) : name)
}

/** Find the matching `\end{name}`; returns the content end and the next offset. */
function findEnvironmentEnd(
  text: string,
  name: string,
  from: number,
  excluded: readonly SourceSpan[],
): { start: number; next: number } | undefined {
  const open = `\\begin{${name}}`
  const close = `\\end{${name}}`
  let depth = 1
  let index = from
  while (index < text.length) {
    const openIndex = text.indexOf(open, index)
    const closeIndex = text.indexOf(close, index)
    if (closeIndex < 0) return undefined
    if (openIndex >= 0 && openIndex < closeIndex) {
      if (!isInsideExcluded(excluded, openIndex)) depth += 1
      index = openIndex + open.length
      continue
    }
    if (isInsideExcluded(excluded, closeIndex)) {
      index = closeIndex + close.length
      continue
    }
    depth -= 1
    if (depth === 0) return { start: closeIndex, next: closeIndex + close.length }
    index = closeIndex + close.length
  }
  return undefined
}

function isInsideExcluded(excluded: readonly SourceSpan[], offset: number): boolean {
  for (const span of excluded) {
    if (span.end <= offset) continue
    if (span.start > offset) return false
    return true
  }
  return false
}

/** Find an unescaped `needle` from `from`; O(distance). */
function findUnescaped(text: string, needle: string, from: number): number {
  let index = from
  while (index < text.length) {
    const found = text.indexOf(needle, index)
    if (found < 0) return -1
    if (!isEscaped(text, found)) return found
    index = found + needle.length
  }
  return -1
}

/** Find the closing `$` of an inline formula, stopping at a line break. */
function findInlineDollarClose(text: string, from: number): number {
  let cursor = from
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor)
    if (code === 92) {
      cursor += 2
      continue
    }
    if (code === 10 || code === 13) return -1
    if (code === 36) return cursor
    cursor += 1
  }
  return -1
}

/** True when the character at `index` is preceded by an odd run of backslashes. */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0
  let cursor = index - 1
  while (cursor >= 0 && text.charCodeAt(cursor) === 92) {
    backslashes += 1
    cursor -= 1
  }
  return backslashes % 2 === 1
}

/** Advance past one TeX command (`\name`, `\\`, `\%`, ...). */
function advanceCommand(text: string, index: number): number {
  let cursor = index + 1
  while (cursor < text.length && isAsciiLetterCode(text.charCodeAt(cursor))) cursor += 1
  return cursor > index + 1 ? cursor : index + 1
}

/** Match an opening code fence (``` or ~~~, 3+ chars). */
function matchOpeningFence(trimmed: string): { marker: string; length: number } | undefined {
  const marker = trimmed[0]
  if (marker !== '`' && marker !== '~') return undefined
  let length = 0
  while (length < trimmed.length && trimmed[length] === marker) length += 1
  if (length < 3) return undefined
  return { marker, length }
}

/** True when a trimmed line closes a fence opened with `marker` × `length`. */
function isClosingFence(trimmed: string, marker: string, length: number): boolean {
  if (marker.length !== 1) return false
  let count = 0
  while (count < trimmed.length && trimmed[count] === marker) count += 1
  if (count < length) return false
  return trimmed.slice(count).trim().length === 0
}

/** Find a run of exactly `length` backticks at or after `from` within a line. */
function findBacktickRun(line: string, from: number, length: number): number {
  let cursor = from
  while (cursor < line.length) {
    if (line[cursor] !== '`') {
      cursor += 1
      continue
    }
    let end = cursor
    while (end < line.length && line[end] === '`') end += 1
    if (end - cursor === length) return cursor
    cursor = end
  }
  return -1
}

function isAsciiLetterCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isIdentifierStartCode(code: number): boolean {
  return isAsciiLetterCode(code) || code === 95
}

/** True when text contains a `<math` element opener (case-insensitive). */
function containsMathMl(text: string): boolean {
  return text.toLowerCase().includes('<math')
}
