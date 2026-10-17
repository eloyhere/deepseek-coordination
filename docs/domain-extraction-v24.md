# Domain extraction v24 — Book/Article, Person/Venue, Condition, proof status, CSV/TSV

Status: **parser layer implemented and tested**; NodeCard/registry projection already wired by the
file layer; chain hierarchy projection and `ParsedStructure` exposure are the remaining seams.
This note closes limitation 2 of 0.10.0 ("Book/Article hierarchy, Person/Venue,
Chapter/Section/Paragraph, Condition status, Sign promotion, office sheets and proof status are
design/planned"). It does not change the design in `docs/domain-model-v24.md`; it implements the
explicit-marker subset that a lexical parser can prove without inventing semantics.

## 1. Contract

- `src/shared/entity.ts` — `StructuralConcept` (Book/Part/Chapter/Article/Section/Paragraph/
  Condition/Person/Venue/statement) and `OfficeConcept` (sheet/cell/range); `ConceptBase` carries
  `locator`, `partOf`, `contains`. `ConceptMetadata` is the union.
- `src/shared/enum.ts` — closed unions `StructuralKind`, `StatementKind`, `ChapterForm`,
  `ConditionForm`, `ConditionStatus`, `StatementStatus`, `ProofStatus`, `VenueForm`,
  `StructuralForm`, `StructuralRelation`, `StructuralRole`, `OfficeKind`, `CellValueType`, plus
  `isStatementKind`/`isStructuralKind`. Additive only.
- `src/host/text/parser.ts` — `NodeMetadata.domain?: ConceptMetadata` and three extra
  `MetadataSource` values (`paragraph`, `summary`, `command`, plus `sheet`). No parser internals
  changed.
- New node kinds emitted by parsers: `book`, `article`, `part`, `chapter`, `section`,
  `paragraph`, `condition`, `person`, `venue`, `sheet`, `cell`, `range`.
- **Headings keep `kind='heading'`.** Their semantic concept is `domain.kind='chapter'|'section'`
  so `nodeHandleFor(path,'heading',…)`, the existing chain heading hierarchy and the TeX proof
  code keep their handles. Conditions/paragraphs/sheets/cells are new nodes, so they use their
  semantic kind directly.
- `domain` is attached **only** from an explicit marker (front matter, heading outline, Pandoc
  fenced div, `SUMMARY.md` link list, HTML element, LaTeX sectioning command, doc-comment contract
  tag, CSV/TSV structure). No prose, class-name, font-style or filename heuristic is used.
- `partOf`/`contains` are parser locators, never public handles:
  `document:<path>/<kind>:<n>`, `module:<path>/condition:<n>`,
  `document:<path>/sheet:1/cell:B3`. Ordinals are 1-based per kind in source order. `contains` is
  capped at 16 entries and names at 8 (the authoritative parent link is always the child's
  `partOf`). No body, AST or cell text is stored.

## 2. Detection matrix (all explicit-marker only)

| Source | Detected |
|---|---|
| Markdown front matter | `form`/`type`/`document` (book/article/note/workbook/deck), `book`, `article`, `author`/`authors`, `editor`/`editors`, `venue`, `doi`, `requires`, `meets`; YAML block lists (`key:` + `- item`) for the list keys |
| Markdown headings | book: level 1 → `chapter`, deeper → `section`; article/note/unknown: `section`; nesting from heading levels; every heading carries `domain`, and body paragraphs become `paragraph` nodes with `partOf` |
| Markdown fenced divs | `book`/`article`/`part`/`chapter`/`section`/`paragraph`; `condition`/`precondition`/`postcondition`/`invariant`/`guard`/`assumption`/`hypothesis`/`constraint`/`goal`/`require`/`meet`; statement kinds (`definition`…`remark`); `#id` and `title="…"` are label/name |
| `SUMMARY.md` | `# Part` headings → `part`; link list items → `chapter` (indent 0) or nested `section`; `target` keeps the specifier as written; URL items are not chapters |
| HTML | `<article>`/`<main>` → `article`; `<section>` → `section`; `h1`–`h6` name/nest; `<p>` → `paragraph`; `<title>`/`meta[name=description]` feed the file metadata |
| LaTeX | `\documentclass{book|article|report|memoir}` → work node; `\title`, `\author` (`\and` split); `\part`, `\chapter`, `\section`, `\subsection`, `\subsubsection`, `\paragraph`, `\subparagraph` (starred too) → `part`/`chapter`/`section`/`paragraph` (`form='sectioning'`) |
| LaTeX statements | existing theorem environments get `status`/`proofStatus` from explicit proof/label links only |
| JS/TS doc comments | `@requires`/`@pre` → `condition` `form='precondition'`, `relation='requires'`; `@ensures`/`@post` → `postcondition`; `@invariant` → `invariant`; `@param`/`@returns`/`@throws` are not conditions |
| CSV/TSV | RFC 4180 rows (quotes, `""`, embedded comma/newline, CRLF), `sheet` + non-empty `cell` nodes with A1 addresses + one used `range`; leading `=`/`+`/`-`/`@`/tab/CR is `text` + `injectionRisk`, never a formula |

## 3. Statement / proof status rules

| Evidence | Result |
|---|---|
| Statement environment with no proof link | `status='stated'` |
| `axiom` environment | `status='axiomatic'` (explicit environment, not a heuristic) |
| Closed `proof` with `\ref{label}` matching a statement label in the file | proof `status='proved'`, `proofStatus='complete'`, `target=label`; target statement `status='proved'` |
| Proof without a `\ref` (or with an unknown label) | proof `status='unverifiable'`, `proofStatus='unverifiable'`; target unchanged |
| Unterminated proof environment | proof `status='unproved'`, `proofStatus='incomplete'`; an explicit target becomes `unproved` |

`proved` is never claimed from `Qed`/`by`/`Admitted` text alone. Conditions default to
`status='unknown'`; nothing in the parser writes `satisfied`/`violated`.

## 4. Wired vs still-to-project vs deferred

**Wired (parser + tests).**

- All of §2 and §3; `test/domain-extraction.test.ts` covers Markdown/HTML/TeX/JS/CSV fixtures,
  `partOf`/`contains`, proof status and negative/malformed cases.
- Semantic nodes are ordinary `NodeMetadata` in `result.nodes`, so `ParseService.build()` already
  copies them into `ParsedFile.nodes`; `NodeRegistry.register` and `ChainEngine.index` accept them
  unchanged (they receive file-level `contains`/`part_of` edges today).
- `src/host/node-registry.ts:159` already projects `domain` into `NodeCard`, and `:444` puts it on
  the card; the persistence row also carries it (`:487`).
- `domainNodesOf(result)` (`src/host/text/index.ts`) is the convenience projection helper.
- `parseFileText('x.csv'|'x.tsv', …)` now resolves the bounded `delimited` parser; `.sheet`,
  `.rowCount`, `.columnCount`, `.cellCount` are on the result.

**Needs file-layer projection (do not edit from this branch's parser work).**

1. `ParsedStructure` (`src/host/parse-service.ts:156`) / `extractStructure` (`:1080`): add a
   `concepts` array, e.g. `{ kind, key, concept }` from
   `(result.nodes ?? []).filter(n => n.domain)` with `key = n.locator ?? \`${n.kind}:${n.span.start}\``
   (the same natural key as `nodeKeyOf`). This is only for callers that read `structure`; the nodes
   themselves are already present.
2. `ChainEngine.index` (`src/host/chain.ts:567`): after the node loop, build
   `locator → handle` and add `contains` (parent→child) / `part_of` (child→parent) edges from
   `domain.partOf`/`domain.contains`; add `requires`/`meets` from condition `relation` +
   `appliesTo`; optionally add `proves` from statement `domain.target`/`status`. Today only the
   generic file↔node edges and the legacy `heading` level stack are built, so the new Chapter/
   Section/Part edges are not queryable through `coordination_chain` yet.
3. `NodeFacts` (`src/host/node-registry.ts:163`/`:446`): optionally carry `domain` for chain code
   that prefers facts over `ParsedFile.nodes`; not required by the current indexer.
4. `ParseService.fileKind` (`:1119`): `.csv`/`.tsv` currently return `document`; the parser already
   sets `result.document.form='workbook'`, so a `workbook` kind is a one-line projection.
5. `boundCard` (`node-registry.ts`): the parser bounds `domain` (16 locators, 8 names), but a
   1 KiB card overflow should trim `domain.contains` before dropping `reference`.

**Deferred (explicitly not faked).**

- **xlsx**: no zip/XML/OOXML reader was added and no dependency is allowed; only CSV/TSV is
  parsed. `.xlsx` remains an unknown extension for the text registry. No sheet/cell/range nodes are
  emitted for it.
- **Sign promotion**: the tokenizer exposes `Token`s, but the parser result still has no promotable
  `sign` contract (allowlist of `import`/`@`/`#`/`\begin` plus role/target). No `sign` nodes are
  emitted, and this is intentionally deferred rather than inventing a promotion rule.
- Lean 4 / Coq / Isabelle proof status: no parser exists, so only TeX statement/proof links are
  wired.
- LaTeX prose paragraphs (only sectioning `\paragraph` is a concept), cross-file `\include`
  chapter ownership, `<dfn>`/`data-kind`/`<aside class="proof">`, docx style names, EPUB/JATS/
  DocBook, venue form classification, DOI resolution/citation graph, CSV header/named/row/column
  ranges, condition evaluation and `partOf` linking from a `SUMMARY.md` target into the target
  file are deferred to the file layer / later phases.
- Workspace-wide Book↔Article composition (a `SUMMARY.md` `target` resolved to a parsed Chapter in
  another file) requires cross-file graph work; the parser only records the specifier.
