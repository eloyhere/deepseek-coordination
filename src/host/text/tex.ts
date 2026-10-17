/**
 * LaTeX parser: theorem-like environments, proofs, labels/refs, math, inputs.
 *
 * Scope (`docs/domain-model-v24.md` §5, P0): theorem-like environments
 * (`definition`, `lemma`, `theorem`, `proposition`, `corollary`, `axiom`,
 * `property`, `claim`, `example`, `remark`, `proof`), `\label{...}` and
 * `\ref`/`\eqref`/`\autoref`/`\pageref`, `\begin{proof}…\end{proof}`,
 * `$…$`, `$$…$$`, `\(…\)`, `\[…\]` and math environments
 * (`equation`/`align`/`gather`/`array`/`matrix`, starred variants), and
 * `\input`/`\include` as file references.
 *
 * Not done, by design: macro expansion (`\newcommand` is only skipped), package
 * semantics, `\write18`, bibliography targets, rendering. `\input` is a
 * dependency, never formula content. Theorem text is **not** returned; only the
 * body-free span, label, title and an explicit abstract brief are metadata.
 *
 * Complexity: comments O(n); statements O(n) because each known environment is
 * consumed once; labels/refs/inputs O(n); formulas O(n) via `formula.ts`.
 * Metadata references are O(log lines) each through `SourceMap`.
 */
import { AstTree } from '../../shared/ast.js'
import type { SourceSpan } from '../../shared/ast.js'
import {
  MAX_BRIEF_LENGTH,
  MAX_NAME_LENGTH,
  ParseContext,
  appendAstNode,
  createAstRoot,
  fragmentForSpan,
  isExternalSpecifier,
  pushNodeMetadata,
  referenceForSpan,
  sanitizeMetadataText,
} from './parser.js'
import type {
  CodeComment,
  DocumentMetadata,
  FileReference,
  FlatFragment,
  NodeMetadata,
  NodeReference,
  ParseOptions,
  ParseResult,
  Parser,
} from './parser.js'
import { formulaMetadata, scanTexFormulas, texCommentRanges } from './formula.js'
import type { Formula } from './formula.js'
import { MAX_CONCEPT_NAMES, structuralLocator } from './markup.js'
import { splitTextLines, tokenize } from './tokenizer.js'
import type { StructuralConcept } from '../../shared/entity.js'
import type { StructuralKind } from '../../shared/enum.js'

/** Statement kinds the P0 TeX parser recognises. */
export type TexStatementKind =
  | 'definition'
  | 'lemma'
  | 'theorem'
  | 'proof'
  | 'property'
  | 'axiom'
  | 'corollary'
  | 'claim'
  | 'example'
  | 'remark'

/** One explicit sectioning command (`\part`, `\chapter`, `\section`, ...). */
export interface TexSection extends FlatFragment {
  kind: 'part' | 'chapter' | 'section' | 'paragraph'
  /** Sectioning depth: part 1, chapter 2, section 3, ... paragraph 6. */
  level: number
  /** Explicit braced title. */
  title?: string
  /** True for a starred (unnumbered) command. */
  starred: boolean
  span: SourceSpan
  reference?: NodeReference
}

/** One theorem-like environment. Carries no body text. */
export interface TexStatement extends FlatFragment {
  kind: TexStatementKind
  /** Source environment name (e.g. `proposition`). */
  environment: string
  /** Explicit `\begin{theorem}[Title]` title. */
  title?: string
  /** First `\label{...}` inside the environment. */
  label?: string
  span: SourceSpan
  bodySpan: SourceSpan
  /** Target of a proof, from the first `\ref` inside it. */
  proofTarget?: string
  /** True when the environment has no `\end{...}` (explicitly incomplete evidence). */
  unterminated?: boolean
  reference?: NodeReference
}

/** One `\label{...}`. */
export interface TexLabel {
  name: string
  span: SourceSpan
}

/** One cross-reference command (`\ref`, `\eqref`, `\autoref`, `\pageref`). */
export interface TexReference {
  command: 'ref' | 'eqref' | 'autoref' | 'pageref'
  name: string
  span: SourceSpan
}

/** TeX parser result. */
export interface TexParseResult extends ParseResult {
  statements: TexStatement[]
  labels: TexLabel[]
  crossReferences: TexReference[]
  formulas: Formula[]
  comments: CodeComment[]
  /** Explicit sectioning commands, in source order. */
  sections: TexSection[]
}

/**
 * Sectioning command vocabulary. Only these commands are structural; an unknown
 * command is never treated as a heading.
 */
const SECTION_COMMANDS: Readonly<Record<string, { kind: TexSection['kind']; level: number }>> = {
  part: { kind: 'part', level: 1 },
  chapter: { kind: 'chapter', level: 2 },
  section: { kind: 'section', level: 3 },
  subsection: { kind: 'section', level: 4 },
  subsubsection: { kind: 'section', level: 5 },
  paragraph: { kind: 'paragraph', level: 6 },
  subparagraph: { kind: 'paragraph', level: 7 },
}

const STATEMENT_ENVIRONMENTS: Readonly<Record<string, TexStatementKind>> = {
  definition: 'definition',
  lemma: 'lemma',
  theorem: 'theorem',
  proposition: 'theorem',
  corollary: 'corollary',
  axiom: 'axiom',
  property: 'property',
  claim: 'claim',
  example: 'example',
  remark: 'remark',
  proof: 'proof',
}

const REFERENCE_COMMANDS: Readonly<Record<string, TexReference['command']>> = {
  ref: 'ref',
  eqref: 'eqref',
  autoref: 'autoref',
  pageref: 'pageref',
}

/**
 * Parse LaTeX.
 *
 * Time O(n), space O(statements + labels + formulas). Throws only for a
 * pre-aborted signal.
 */
export function parseTex(text: string, options: ParseOptions = {}): TexParseResult {
  const ctx = new ParseContext(text, options)
  const scanned = tokenize(ctx.text, {
    maxTokens: ctx.maxTokens,
    shouldStop: ctx.shouldStop,
    lineComments: ['%'],
    blockComments: [],
    stringDelimiters: [],
  })
  ctx.tokens = scanned.tokens.length
  if (scanned.truncated && scanned.tokens.length >= ctx.maxTokens) {
    ctx.limit('token-limit', `token limit ${ctx.maxTokens} reached; parsed the prefix`)
  }
  const source = ctx.text
  const lines = splitTextLines(source)
  const commentRanges = texCommentRanges(source)
  const excluded = commentRanges
  const references: FileReference[] = []
  const statements: TexStatement[] = []
  const labels: TexLabel[] = []
  const crossReferences: TexReference[] = []
  const comments: CodeComment[] = commentRanges.map((span) => ({
    style: 'line',
    brief: sanitizeMetadataText(source.slice(span.start + 1, span.end), MAX_BRIEF_LENGTH),
    span,
    attachment: 'orphan',
  }))
  const nodes: NodeMetadata[] = []

  function locate(start: number, end: number): SourceSpan {
    const line = ctx.sourceMap.lineAt(start) ?? 1
    const lineInfo = lines[line - 1]
    return { start, end, line, column: lineInfo === undefined ? 1 : start - lineInfo.start + 1 }
  }

  // Statements.
  let index = 0
  let lastCheck = 0
  while (index < source.length) {
    if (index - lastCheck >= 2_048) {
      lastCheck = index
      if (!ctx.checkpoint()) break
    }
    const commentEnd = insideExcluded(excluded, index)
    if (commentEnd !== undefined) {
      index = commentEnd
      continue
    }
    if (!source.startsWith('\\begin{', index)) {
      index = source.charCodeAt(index) === 92 ? advanceCommand(source, index) : index + 1
      continue
    }
    const parsed = parseBegin(source, index)
    if (parsed === undefined) {
      index = advanceCommand(source, index)
      continue
    }
    const kind = STATEMENT_ENVIRONMENTS[parsed.environment]
    if (kind === undefined) {
      index = parsed.nameEnd + 1
      continue
    }
    const end = findEnvironmentEnd(source, parsed.environment, parsed.nameEnd + 1, excluded)
    if (end === undefined) {
      const span = locate(index, source.length)
      statements.push({
        kind,
        environment: parsed.environment,
        ...(parsed.title === undefined ? {} : { title: sanitizeMetadataText(parsed.title, MAX_NAME_LENGTH) }),
        span,
        bodySpan: locate(parsed.nameEnd + 1, source.length),
        ...(kind === 'proof' ? { unterminated: true } : {}),
        ...fragmentForSpan(ctx, span),
      })
      ctx.unverifiable(`unterminated ${parsed.environment} environment`, span)
      break
    }
    const span = locate(index, end.next)
    const statement: TexStatement = {
      kind,
      environment: parsed.environment,
      ...(parsed.title === undefined ? {} : { title: sanitizeMetadataText(parsed.title, MAX_NAME_LENGTH) }),
      span,
      bodySpan: locate(parsed.nameEnd + 1, end.start),
      ...fragmentForSpan(ctx, span),
    }
    statements.push(statement)
    index = end.next
  }

  // Labels, cross-references and file inputs.
  index = 0
  while (index < source.length) {
    if (index - lastCheck >= 2_048) {
      lastCheck = index
      if (!ctx.checkpoint()) break
    }
    const commentEnd = insideExcluded(excluded, index)
    if (commentEnd !== undefined) {
      index = commentEnd
      continue
    }
    if (source.charCodeAt(index) !== 92) {
      index += 1
      continue
    }
    const command = readCommand(source, index)
    if (command === undefined) {
      index += 1
      continue
    }
    if (command.name === 'label' || command.name === 'ref' || command.name === 'eqref' ||
      command.name === 'autoref' || command.name === 'pageref') {
      const argument = readBracedArgument(source, command.end)
      if (argument === undefined) {
        index = command.end
        continue
      }
      const span = locate(argument.start, argument.end)
      if (command.name === 'label') {
        labels.push({ name: argument.value, span })
      } else {
        const referenceCommand = REFERENCE_COMMANDS[command.name]
        crossReferences.push({ command: referenceCommand, name: argument.value, span })
      }
      index = argument.next
      continue
    }
    if (command.name === 'input' || command.name === 'include') {
      const argument = readBracedArgument(source, command.end)
      if (argument === undefined) {
        index = command.end
        continue
      }
      const span = locate(argument.start, argument.end)
      references.push({
        kind: command.name === 'input' ? 'tex-input' : 'tex-include',
        specifier: argument.value,
        external: isExternalSpecifier(argument.value),
        span,
        ...fragmentForSpan(ctx, span),
      })
      index = argument.next
      continue
    }
    index = command.end
  }

  // Explicit sectioning commands (`\part`, `\chapter`, `\section`, ...).
  const sections: TexSection[] = []
  index = 0
  while (index < source.length) {
    if (index - lastCheck >= 2_048) {
      lastCheck = index
      if (!ctx.checkpoint()) break
    }
    const commentEnd = insideExcluded(excluded, index)
    if (commentEnd !== undefined) {
      index = commentEnd
      continue
    }
    if (source.charCodeAt(index) !== 92) {
      index += 1
      continue
    }
    const command = readCommand(source, index)
    if (command === undefined) {
      index += 1
      continue
    }
    const sectioning = SECTION_COMMANDS[command.name]
    if (sectioning === undefined) {
      index = command.end
      continue
    }
    let argumentStart = command.end
    const starred = source.charCodeAt(argumentStart) === 42
    if (starred) argumentStart += 1
    const argument = readBracedArgument(source, argumentStart)
    if (argument === undefined) {
      index = command.end
      continue
    }
    const span = locate(index, argument.next)
    const sectionTitle = sanitizeMetadataText(argument.value, MAX_NAME_LENGTH)
    sections.push({
      kind: sectioning.kind,
      level: sectioning.level,
      ...(sectionTitle.length === 0 ? {} : { title: sectionTitle }),
      starred,
      span,
      ...fragmentForSpan(ctx, span),
    })
    index = argument.next
  }

  for (const statement of statements) {
    const label = labels.find((candidate) =>
      candidate.span.start >= statement.bodySpan.start && candidate.span.end <= statement.span.end)
    if (label !== undefined) statement.label = label.name
    if (statement.kind === 'proof') {
      const target = crossReferences.find((candidate) =>
        candidate.span.start >= statement.bodySpan.start && candidate.span.end <= statement.span.end)
      if (target !== undefined) statement.proofTarget = target.name
    }
  }

  /*
   * Statement proof status, derived only from explicit proof/label links:
   *
   *  - a closed proof with a `\ref` to a statement label in this file proves it;
   *  - a proof without a target (or with an unknown label) is `unverifiable`;
   *  - an unterminated proof leaves its target `unproved`.
   *
   * No `Qed`/`by` heuristic is used: the environment boundary and the label link
   * are the only evidence.
   */
  const statementByLabel = new Map<string, TexStatement>()
  for (const statement of statements) {
    if (statement.label === undefined) continue
    if (!statementByLabel.has(statement.label)) statementByLabel.set(statement.label, statement)
  }
  const statementConcepts = new Map<TexStatement, StructuralConcept>()
  for (const statement of statements) {
    const concept: StructuralConcept = {
      kind: statement.kind,
      status: statement.kind === 'axiom'
        ? 'axiomatic'
        : statement.kind === 'proof'
          ? 'unverifiable'
          : 'stated',
      ...(statement.kind === 'proof' ? { proofStatus: 'unverifiable' as const } : {}),
    }
    statementConcepts.set(statement, concept)
  }
  for (const statement of statements) {
    if (statement.kind !== 'proof') continue
    const concept = statementConcepts.get(statement)
    if (concept === undefined) continue
    const target = statement.proofTarget === undefined
      ? undefined
      : statementByLabel.get(statement.proofTarget)
    if (target === undefined) {
      concept.status = statement.unterminated === true ? 'unproved' : 'unverifiable'
      concept.proofStatus = statement.unterminated === true ? 'incomplete' : 'unverifiable'
      continue
    }
    const targetConcept = statementConcepts.get(target)
    if (statement.unterminated === true) {
      concept.status = 'unproved'
      concept.proofStatus = 'incomplete'
      if (targetConcept !== undefined) targetConcept.status = 'unproved'
      continue
    }
    concept.status = 'proved'
    concept.proofStatus = 'complete'
    concept.target = statement.proofTarget
    if (targetConcept !== undefined) targetConcept.status = 'proved'
  }

  // Formulas.
  const formulaScan = scanTexFormulas(source, {
    excluded: commentRanges,
    shouldStop: ctx.shouldStop,
    maxFormulas: 5_000,
  })
  const formulas = formulaScan.formulas
  if (formulaScan.truncated) ctx.limit('token-limit', 'formula limit reached; later formulas were dropped')

  // Document metadata: \documentclass, \title, \author, abstract.
  const documentClass = readDocumentClass(source, excluded)
  const title = readSimpleCommand(source, 'title', excluded)
  const author = readSimpleCommand(source, 'author', excluded)
  const abstract = readEnvironmentContent(source, 'abstract', excluded)
  const form = documentClassForm(documentClass)
  const cleanTitle = title === undefined ? undefined : sanitizeMetadataText(title, MAX_NAME_LENGTH)
  const cleanAuthor = author === undefined ? undefined : sanitizeMetadataText(author, MAX_NAME_LENGTH)
  const abstractBrief = abstract === undefined
    ? undefined
    : sanitizeMetadataText(abstract.replace(/\s+/g, ' ').trim(), MAX_BRIEF_LENGTH)
  const metadata: Record<string, string> = {}
  if (documentClass !== undefined) metadata.documentclass = documentClass
  if (title !== undefined) metadata.title = title
  if (author !== undefined) metadata.author = author
  const document: DocumentMetadata | undefined =
    documentClass === undefined && cleanTitle === undefined && cleanAuthor === undefined
      ? undefined
      : {
          form,
          source: documentClass === undefined ? 'none' : 'documentclass',
          ...(cleanTitle === undefined || cleanTitle.length === 0 ? {} : { title: cleanTitle }),
          ...(cleanAuthor === undefined || cleanAuthor.length === 0 ? {} : { author: cleanAuthor }),
          metadata,
        }

  const root = createAstRoot('document', ctx.text.length)
  let missingBrief = 0
  let firstMissing: SourceSpan | undefined

  if (document !== undefined) {
    const span = locate(0, source.length)
    const reference = ctx.path === undefined
      ? undefined
      : referenceForSpan(ctx, { scheme: 'file', target: ctx.path, span, parserId: 'latex' })
    pushNodeMetadata(ctx, nodes, {
      kind: 'document',
      ...(cleanTitle === undefined ? {} : { name: cleanTitle }),
      ...(abstractBrief === undefined ? {} : { brief: abstractBrief }),
      ...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
      ...(metadata.purpose === undefined ? {} : { purpose: metadata.purpose }),
      ...(reference === undefined ? {} : { reference }),
      fragment: fragmentForSpan(ctx, span),
      source: 'documentclass',
      span,
    })
    if (abstractBrief === undefined) {
      missingBrief += 1
      firstMissing = span
    }
    appendAstNode(ctx, root, 'document', span, cleanTitle)
  }

  const statementOrdinals = new Map<string, number>()
  const concepts: StructuralConcept[] = []
  for (const statement of statements) {
    const displayName = statement.title ?? statement.label
    const name = displayName === undefined ? undefined : sanitizeMetadataText(displayName, MAX_NAME_LENGTH)
    const ordinal = (statementOrdinals.get(statement.kind) ?? 0) + 1
    statementOrdinals.set(statement.kind, ordinal)
    const locator = structuralLocator(ctx.path, statement.kind, ordinal)
    const concept = statementConcepts.get(statement)
    if (concept !== undefined) {
      concept.locator = locator
      concept.ordinal = ordinal
    }
    let reference: NodeReference | undefined
    if (ctx.path !== undefined) {
      try {
        reference = referenceForSpan(ctx, {
          scheme: 'symbol',
          target: `${ctx.path}#${statement.kind}:${statement.label ?? statement.span.start}`,
          span: statement.span,
          parserId: 'latex',
        })
        statement.reference = reference
      } catch {
        reference = undefined
      }
    }
    const node = pushNodeMetadata(ctx, nodes, {
      kind: statement.kind,
      locator,
      ...(name === undefined || name.length === 0 ? {} : { name }),
      ...(statement.label === undefined ? {} : { label: statement.label }),
      ...(reference === undefined ? {} : { reference }),
      fragment: statement,
      source: 'environment',
      span: statement.span,
    })
    if (node !== undefined && concept !== undefined) {
      node.domain = concept
      concepts.push(concept)
    }
    missingBrief += 1
    firstMissing ??= statement.span
    appendAstNode(ctx, root, statement.kind, statement.span, statement.title ?? statement.label)
  }

  for (const formula of formulas) {
    if (formula.unverifiable) ctx.unverifiable(formula.reason ?? 'unverifiable formula', formula.span)
    pushNodeMetadata(ctx, nodes, formulaMetadata(ctx, formula, 'latex'))
    missingBrief += 1
    firstMissing ??= formula.span
    appendAstNode(ctx, root, 'formula', formula.span, formula.dialect)
  }

  /*
   * Work node (explicit `\documentclass{book|article}`), sectioning hierarchy
   * (`\part`/`\chapter`/`\section`/...), and Person authorities (`\author`).
   * A command that is absent creates no node; nothing is inferred from prose.
   */
  const conceptChildren = new Map<string, string[]>()
  const addConceptChild = (parent: string | undefined, child: string): void => {
    if (parent === undefined) return
    const list = conceptChildren.get(parent)
    if (list === undefined) {
      conceptChildren.set(parent, [child])
      return
    }
    if (!list.includes(child) && list.length < 64) list.push(child)
  }
  const authorNames = author === undefined
    ? []
    : author
        .split(/\\and\b/)
        .map((value) => sanitizeMetadataText(value, MAX_NAME_LENGTH))
        .filter((value) => value.length > 0)
        .slice(0, MAX_CONCEPT_NAMES)
  const workKind: 'book' | 'article' | undefined =
    form === 'book' ? 'book' : form === 'article' ? 'article' : undefined
  const workLocator = workKind === undefined ? undefined : structuralLocator(ctx.path, workKind, 1)
  if (workKind !== undefined && workLocator !== undefined) {
    const span = locate(0, source.length)
    const concept: StructuralConcept = {
      kind: workKind,
      locator: workLocator,
      explicit: true,
      ...(authorNames.length === 0 ? {} : { authors: authorNames }),
    }
    const reference = ctx.path === undefined
      ? undefined
      : referenceForSpan(ctx, { scheme: 'file', target: ctx.path, span, parserId: 'latex' })
    const node = pushNodeMetadata(ctx, nodes, {
      kind: workKind,
      locator: workLocator,
      ...(cleanTitle === undefined ? {} : { name: cleanTitle }),
      ...(reference === undefined ? {} : { reference }),
      fragment: fragmentForSpan(ctx, span),
      source: 'documentclass',
      span,
    })
    if (node !== undefined) {
      node.domain = concept
      concepts.push(concept)
      appendAstNode(ctx, root, workKind, span, cleanTitle)
    }
  }

  const sectionStack: Array<{ level: number; locator: string }> = []
  const sectionOrdinals = new Map<string, number>()
  for (const section of sections) {
    const ordinal = (sectionOrdinals.get(section.kind) ?? 0) + 1
    sectionOrdinals.set(section.kind, ordinal)
    const locator = structuralLocator(ctx.path, section.kind, ordinal)
    while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].level >= section.level) {
      sectionStack.pop()
    }
    const parent = sectionStack[sectionStack.length - 1]?.locator ?? workLocator
    const concept: StructuralConcept = {
      kind: section.kind,
      locator,
      ordinal,
      level: section.level,
      explicit: true,
      ...(section.kind === 'chapter' ? { form: 'chapter' as const } : {}),
      ...(section.kind === 'paragraph' ? { form: 'sectioning' as const } : {}),
      ...(parent === undefined ? {} : { partOf: parent }),
    }
    let reference: NodeReference | undefined
    if (ctx.path !== undefined) {
      reference = referenceForSpan(ctx, {
        scheme: 'symbol',
        target: `${ctx.path}#${section.kind}:${ordinal}`,
        span: section.span,
        parserId: 'latex',
      })
      section.reference = reference
    }
    const node = pushNodeMetadata(ctx, nodes, {
      kind: section.kind,
      locator,
      ...(section.title === undefined ? {} : { name: section.title }),
      ...(reference === undefined ? {} : { reference }),
      fragment: section,
      source: 'command',
      span: section.span,
    })
    if (node !== undefined) {
      node.domain = concept
      concepts.push(concept)
      addConceptChild(parent, locator)
      sectionStack.push({ level: section.level, locator })
    }
    appendAstNode(ctx, root, section.kind, section.span, section.title)
  }

  const authorArgument = readCommandArgument(source, 'author', excluded)
  const authorSpan = authorArgument === undefined
    ? locate(0, source.length)
    : locate(authorArgument.start, authorArgument.end)
  for (let personIndex = 0; personIndex < authorNames.length; personIndex += 1) {
    const ordinal = personIndex + 1
    const locator = structuralLocator(ctx.path, 'person', `author:${ordinal}`)
    const concept: StructuralConcept = {
      kind: 'person',
      locator,
      ordinal,
      role: 'author',
      explicit: true,
    }
    const reference = ctx.path === undefined
      ? undefined
      : referenceForSpan(ctx, {
          scheme: 'symbol',
          target: `${ctx.path}#person:author:${ordinal}`,
          span: authorSpan,
          parserId: 'latex',
        })
    const node = pushNodeMetadata(ctx, nodes, {
      kind: 'person',
      locator,
      name: authorNames[personIndex],
      ...(reference === undefined ? {} : { reference }),
      fragment: fragmentForSpan(ctx, authorSpan),
      source: 'documentclass',
      span: authorSpan,
    })
    if (node !== undefined) {
      node.domain = concept
      concepts.push(concept)
    }
  }

  for (const concept of concepts) {
    if (concept.locator === undefined) continue
    const list = conceptChildren.get(concept.locator)
    if (list !== undefined && list.length > 0) concept.contains = [...list]
  }

  if (missingBrief > 0) {
    ctx.unverifiable(
      `metadata brief missing on ${missingBrief} node(s); left empty (explicit abstract/description only)`,
      firstMissing,
    )
  }

  return {
    ...ctx.finalize({
      parserId: 'latex',
      references,
      ast: new AstTree(root),
      nodes,
      ...(document === undefined ? {} : { document }),
    }),
    statements,
    labels,
    crossReferences,
    formulas,
    comments,
    sections,
  }
}

/** `Parser` implementation for LaTeX. */
export class LatexParser implements Parser {
  readonly id = 'latex'
  readonly extensions: readonly string[] = ['.tex', '.ltx', '.latex']

  parse(text: string, options: ParseOptions = {}): ParseResult {
    return parseTex(text, options)
  }
}

export const latexParser = new LatexParser()

/* ------------------------------------------------------------------------- *
 * Scanning helpers
 * ------------------------------------------------------------------------- */

function insideExcluded(ranges: readonly SourceSpan[], offset: number): number | undefined {
  let low = 0
  let high = ranges.length - 1
  let candidate = -1
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (ranges[middle].start <= offset) {
      candidate = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (candidate < 0) return undefined
  const range = ranges[candidate]
  return offset < range.end ? range.end : undefined
}

/** Advance past one command name (`\begin`, `\%`, `\\`). */
function advanceCommand(source: string, index: number): number {
  let cursor = index + 1
  while (cursor < source.length && isAsciiLetter(source.charCodeAt(cursor))) cursor += 1
  return cursor > index + 1 ? cursor : index + 1
}

interface Command {
  name: string
  end: number
}

function readCommand(source: string, index: number): Command | undefined {
  if (source.charCodeAt(index) !== 92) return undefined
  let cursor = index + 1
  while (cursor < source.length && isAsciiLetter(source.charCodeAt(cursor))) cursor += 1
  if (cursor === index + 1) return undefined
  return { name: source.slice(index + 1, cursor), end: cursor }
}

interface BracedArgument {
  value: string
  start: number
  end: number
  next: number
}

function readBracedArgument(source: string, from: number): BracedArgument | undefined {
  let cursor = from
  while (cursor < source.length && (source[cursor] === ' ' || source[cursor] === '\t')) cursor += 1
  if (source[cursor] !== '{') return undefined
  const start = cursor + 1
  let depth = 1
  cursor = start
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === '\\') {
      cursor += 2
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        return { value: source.slice(start, cursor), start, end: cursor, next: cursor + 1 }
      }
    }
    cursor += 1
  }
  return undefined
}

interface BeginParse {
  environment: string
  nameEnd: number
  title?: string
}

function parseBegin(source: string, index: number): BeginParse | undefined {
  const open = '\\begin{'
  if (!source.startsWith(open, index)) return undefined
  const nameStart = index + open.length
  const nameEnd = source.indexOf('}', nameStart)
  if (nameEnd < 0) return undefined
  const environment = source.slice(nameStart, nameEnd)
  if (!/^[A-Za-z]+\*?$/.test(environment)) return undefined
  let cursor = nameEnd + 1
  while (cursor < source.length && (source[cursor] === ' ' || source[cursor] === '\t')) cursor += 1
  let title: string | undefined
  if (source[cursor] === '[') {
    const close = source.indexOf(']', cursor + 1)
    if (close >= 0) {
      title = source.slice(cursor + 1, close)
      cursor = close + 1
    }
  }
  return { environment, nameEnd, ...(title === undefined ? {} : { title }) }
}

function findEnvironmentEnd(
  source: string,
  environment: string,
  from: number,
  excluded: readonly SourceSpan[],
): { start: number; next: number } | undefined {
  const open = `\\begin{${environment}}`
  const close = `\\end{${environment}}`
  let depth = 1
  let index = from
  while (index < source.length) {
    const openIndex = source.indexOf(open, index)
    const closeIndex = source.indexOf(close, index)
    if (closeIndex < 0) return undefined
    if (openIndex >= 0 && openIndex < closeIndex) {
      if (insideExcluded(excluded, openIndex) === undefined) depth += 1
      index = openIndex + open.length
      continue
    }
    if (insideExcluded(excluded, closeIndex) !== undefined) {
      index = closeIndex + close.length
      continue
    }
    depth -= 1
    if (depth === 0) return { start: closeIndex, next: closeIndex + close.length }
    index = closeIndex + close.length
  }
  return undefined
}

function readDocumentClass(source: string, excluded: readonly SourceSpan[]): string | undefined {
  const index = findCommand(source, 'documentclass', excluded)
  if (index === undefined) return undefined
  let cursor = index
  while (cursor < source.length && (source[cursor] === ' ' || source[cursor] === '\t')) cursor += 1
  if (source[cursor] === '[') {
    const close = source.indexOf(']', cursor + 1)
    if (close < 0) return undefined
    cursor = close + 1
  }
  const argument = readBracedArgument(source, cursor)
  return argument?.value
}

function readSimpleCommand(source: string, name: string, excluded: readonly SourceSpan[]): string | undefined {
  const index = findCommand(source, name, excluded)
  if (index === undefined) return undefined
  return readBracedArgument(source, index)?.value
}

/** First braced argument of one command, with its offsets (no body returned). */
function readCommandArgument(
  source: string,
  name: string,
  excluded: readonly SourceSpan[],
): BracedArgument | undefined {
  const index = findCommand(source, name, excluded)
  if (index === undefined) return undefined
  return readBracedArgument(source, index)
}

function findCommand(source: string, name: string, excluded: readonly SourceSpan[]): number | undefined {
  const needle = `\\${name}`
  let index = 0
  while (index < source.length) {
    const found = source.indexOf(needle, index)
    if (found < 0) return undefined
    const after = source.charCodeAt(found + needle.length)
    if (isAsciiLetter(after)) {
      index = found + needle.length
      continue
    }
    if (insideExcluded(excluded, found) !== undefined) {
      index = found + needle.length
      continue
    }
    return found + needle.length
  }
  return undefined
}

function readEnvironmentContent(
  source: string,
  environment: string,
  excluded: readonly SourceSpan[],
): string | undefined {
  const begin = source.indexOf(`\\begin{${environment}}`)
  if (begin < 0 || insideExcluded(excluded, begin) !== undefined) return undefined
  const end = findEnvironmentEnd(source, environment, begin + `\\begin{${environment}}`.length, excluded)
  if (end === undefined) return undefined
  return source.slice(begin + `\\begin{${environment}}`.length, end.start)
}

function documentClassForm(name: string | undefined): DocumentMetadata['form'] {
  switch (name?.toLowerCase()) {
    case 'book':
    case 'memoir':
    case 'report':
      return 'book'
    case 'article':
      return 'article'
    case 'beamer':
      return 'deck'
    default:
      return 'unknown'
  }
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}
