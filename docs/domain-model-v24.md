# Domain model v24 — concepts, schema, parser mapping, storage

Status: design only. Behaviour stays with `docs/deepseek-coordination-v24.md`; the parser
layer stays with `docs/file-processing-v24.md`. Naming follows v24 §0: full English words,
PascalCase types, camelCase fields, singular, no underscores. One identifier scheme only:
`identity` (SQLite integer) and `handle` (opaque public id), as in `src/shared/entity.ts`
and `src/host/handle.ts`.

## 0. Ground rules

| Rule | Consequence |
|---|---|
| `kind` is the only node discriminator | Role/lexical variations use `form` (`Sign.form`, `Range.form`, `Proof.form`) or `sourceForm` (`Statement.sourceForm`), never a second `kind`. |
| `locator` is a natural upsert key, not an id | It never leaves the host; `handle` remains the only public identifier. |
| Persistent entities are dated | Every persisted row carries `created`/`changed`; derived views carry none. |
| No guessing | Uncertain parses are `unverifiable` and produce no edge; no name, target, value or proof status is invented. |
| Structures already exist | `SourceSpan`/`Token`/`AstTree`/`AstIndex`/`TokenStream` (`src/shared/ast.ts`), `DirectedGraph` (`graph.ts`), `SparseGrid`/`GridRange` (`grid.ts`), `Trie` (`trie.ts`), `RedBlackTree`, `OrderedMap`, `LruList`. No parser exists yet. |

## 1. Concept model

| # | Concept | Class | Persistent? | Definition and boundary |
|---|---|---|---|---|
| 1 | `Project` | structural container | yes | Manifest root (`package.json`, `pyproject.toml`, `tsconfig.json`, `lakefile`, Sphinx `conf.py`). Not a DSH session or every directory. |
| 2 | `Module` | referential unit | yes | One code/style compilation unit that can import/export (`.ts`, `.tsx`, `.js`, `.jsx`, `.css`). Not a package directory. |
| 3 | `Document` | structural container | yes | One authored prose/markup/office file (Markdown, HTML, LaTeX, docx, pptx, xlsx). Not a rendered page. |
| 4 | `Workbook` | Document form | yes, one `Document` row (`form='workbook'`) | One xlsx/csv/tsv file. `WorkbookView` is derived; `Document --contains--> Sheet`. Not a `Sheet`. |
| 5 | `Dependency` | referential relation | **derived** | Aggregated Module→Module or Project→external relation. Not a syntactic occurrence; no handle. |
| 6 | `Importation` | referential occurrence | yes | One import/include/stylesheet/asset/link occurrence. Not a dependency. |
| 7 | `Exportation` | referential occurrence | yes | One exported binding (named, default, re-export, wildcard). Not a dependency. |
| 8 | `Chapter` | structural surface | yes | A heading/sectioning unit with `level`. Not a `Document`. |
| 9 | `Article` | structural surface | yes | The document-level prose unit (implicit for Markdown, explicit `<article>`, LaTeX article class). Not a `Chapter`. |
| 10 | `Paragraph` | structural surface | yes | A prose block (mdast paragraph, HTML `<p>`, LaTeX text block, DocBook `para`). Not a heading, code block or table cell. |
| 11 | `Sheet` | office surface | yes | One worksheet, sibling of Chapter/Article/Paragraph under the Document. Not a `Workbook`. |
| 12 | `Slide` | office surface | yes, P2 | One slide in a deck (`Document.form='deck'`). Not a page; shape/geometry is out of scope. |
| 13 | `Cell` | office surface atom | yes | One non-empty cell at `(rowIndex, columnIndex)` with an A1 `address`. Row/Column are derived views. |
| 14 | `Range` | office surface reference | yes | A rectangular, row, column or named range. Not a `Cell`; not its expansion. |
| 15 | `Formula` | semantic expression | yes (node); AST derived | Any embedded mathematical/structured expression, any dialect. Not a code symbol; not an evaluator. |
| 16 | `Class` | code symbol | yes | A class declaration/expression with a name. A CSS class selector is **not** a `Class`. |
| 17 | `Function` | code symbol | yes | A function declaration or named function-valued binding. Not a `Method`. |
| 18 | `Method` | code symbol | yes | A class-body function (method/constructor/getter/setter), `ownerClass` set. Not a `Function`. |
| 19 | `Statement` family | formal statement | yes | Ten explicit kinds: definition, lemma, proof, property, axiom, theorem, corollary, claim, example, remark. Not a code symbol body; `Proof` is evidence, not a claim. |
| 20 | `Condition` | logical requirement | yes | A precondition/postcondition/invariant/guard/assumption/hypothesis/constraint/goal. Not a `Statement`; `Require`/`Meet` are relation primitives, not node kinds. |
| 21 | `ChainLink` | projection edge | **derived** | One agent-visible relation between two handles, with status/evidence/baseline. Not a DB edge row; not a NodeKind. |
| 22 | `Chain` | projection | **derived** | Rooted, budgeted, read-only chain of links returned to an agent. Not persisted as truth; no AST/adjacency. |
| 23 | `Comment` | annotation | yes | Extracted comment/doc-comment attached to one target by a stated rule. Not documentation prose. |
| 24 | `Code` | annotation/span | yes | A code span/block inside a `Document`. A symbol body is its span, never a `Code` duplicate. |
| 25 | `Sign` | lexical metadata | yes only when promoted | A keyword/operator/sigil/directive/annotation marker with structural meaning. Not a `Token`; not a code symbol. |
| 26 | `Book` | long-form container | yes, one `Document` row (`form='book'`) | A long-form work: front matter/preface/part/chapter/article/appendix/index, ordered. Not a `Document` file. |
| 27 | `Part` | long-form container | yes | A division of a `Book`; contains Chapter/Article. Never outside a Book. |
| 28 | `Section` | structured prose | yes | A heading/division inside an Article/Chapter/Section. Chapter is **not** a generic heading; Section is. |
| 29 | `Person` | authority | yes | An author/editor identity with a stable handle. `authored_by` targets a Person; author name strings are display metadata. |
| 30 | `Venue` | publication container | yes | Journal/proceedings/conference/preprint where an Article is published. Not a `Book`; a proceedings Book may link a Venue. |

**Count: 39 concepts = 35 `NodeKind` values + 1 Document form (`workbook`) + 3 derived views (`Dependency`, `ChainLink`, `Chain`).**
The `Statement` family contributes ten `NodeKind` values (definition, lemma, proof, property,
axiom, theorem, corollary, claim, example, remark); old `Definition.form` is gone — the kind
itself carries theorem/lemma/corollary/axiom/property/claim/example/remark. `Condition` adds
one more kind; `Require`/`Meet` add relations, not kinds; `Chain`/`ChainLink` are projections,
not kinds. `Book`/`Article` are both a `Document.form` (`book`/`article`) and exactly one
authored-work node; the Document row is the file/invalidation anchor, never duplicated.
`DocumentSurface = Book | Part | Chapter | Article | Section | Paragraph | Sheet | Slide`.
Allowed hierarchy: `Document(form='book')` contains exactly one `Book`; `Book` contains
`Part`/`Chapter`/`Article`; `Part` contains `Chapter`/`Article`; `Book` may directly contain
`Chapter`/`Article`; `Article`/`Chapter`/`Section` contain `Section`/`Paragraph`/`Formula`/
`Statement`/`Comment`/`Code`; `Paragraph` is the leaf prose unit. `Chapter` exists only inside a
`Book`/`Part`; `Section` is the generic heading inside Article/Chapter. A standalone Article is
`Document(form='article')` containing exactly one `Article`; a collected Article is the same
`Article` node with a `part_of` Book edge and an optional `published_in` Venue edge. `Deck` is
`Document.form='deck'` plus `DeckView`; `Page` is a derived print/PDF view, not persisted;
`Canvas` is excluded. `Row`/`Column` are derived views. `Workbook` contains `Sheet` through
the `Document` row; `WorkbookView.sheets` is derived.

## 2. Canonical schema

```ts
import type { Identity, Handle, Timestamp } from './entity.js'
import type { SourceSpan } from './ast.js'
export type NodeStatus = 'parsed' | 'partial' | 'truncated' | 'failed' | 'unverifiable'
export type StatementStatus = 'stated' | 'proved' | 'unproved' | 'disproved' | 'axiomatic' | 'unverifiable'
export type ConditionStatus = 'satisfied' | 'violated' | 'unknown' | 'unverifiable'
export type StatementKind = 'definition' | 'lemma' | 'proof' | 'property' | 'axiom' | 'theorem' | 'corollary' | 'claim' | 'example' | 'remark'
export type ConditionForm = 'precondition' | 'postcondition' | 'invariant' | 'guard' | 'assumption' | 'hypothesis' | 'constraint' | 'goal' | 'unknown'
export type Language = 'javascript' | 'typescript' | 'jsx' | 'tsx' | 'css' | 'html' | 'markdown' | 'latex' | 'lean' | 'coq' | 'isabelle' | 'xlsx' | 'csv' | 'docx' | 'pptx' | 'unknown'
export type NodeKind = 'project' | 'module' | 'document' | 'book' | 'part' | 'chapter' | 'article' | 'section' | 'paragraph' | 'sheet' | 'slide' | 'cell' | 'range' | 'formula' | 'class' | 'function' | 'method' | 'definition' | 'lemma' | 'proof' | 'property' | 'axiom' | 'theorem' | 'corollary' | 'claim' | 'example' | 'remark' | 'condition' | 'comment' | 'code' | 'importation' | 'exportation' | 'sign' | 'person' | 'venue'
export type DocumentForm = 'article' | 'book' | 'note' | 'workbook' | 'deck' | 'unknown'
export interface NodeCore {
  identity: Identity; handle: Handle; kind: NodeKind; locator: string
  project?: Identity; owner?: Identity; parent?: Identity
  metadata: ConceptMetadata
  span?: SourceSpan                 // absent on Project; whole-file span on Module/Document
  hash?: string                     // content hash; containers use a Merkle hash
  created: Timestamp; changed: Timestamp
}
export interface NodeBase extends NodeCore { status: NodeStatus }
export type ReferenceScheme = 'file' | 'symbol' | 'module' | 'formula' | 'sheet-cell' | 'url' | 'handle'
export type Charset =
  | 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'utf-16le-bom' | 'utf-16be-bom'
  | 'utf-32le' | 'utf-32be' | 'utf-32le-bom' | 'utf-32be-bom'
  | 'ascii' | 'latin1' | 'windows-1252' | 'gb18030' | 'gbk' | 'big5' | 'shift-jis' | 'euc-kr'
  | 'binary' | 'unknown'
export type CharsetSource = 'bom' | 'declared' | 'heuristic' | 'fallback'
export interface ByteRange { start: number; end: number }   // charset bytes, start inclusive, end EXCLUSIVE
export interface LineRange { start: number; end: number }   // 1-based decoded lines, start inclusive, end INCLUSIVE
export interface ColumnRange { start: number; end: number } // 1-based code points, start inclusive, end INCLUSIVE
export interface FileReference {
  scheme: 'file'; path: string                              // workspace-relative, normalized, no traversal
  bytes: ByteRange; lines?: LineRange; columns?: ColumnRange
  charset: Charset; charsetConfidence?: number; charsetSource?: CharsetSource
  bom: boolean; bomBytes: number
  hash?: string; fileBytes?: number; mtime?: number; mediaType?: string
}
export interface SymbolReference { scheme: 'symbol'; module: string; symbol: Handle; span?: SourceSpan; hash?: string; version?: string }
export interface ModuleReference { scheme: 'module'; path: string; version?: string }
export interface FormulaLocation { scheme: 'formula'; sheet?: string; cell?: string; label?: string; span?: SourceSpan; hash?: string }
export interface SheetCellReference { scheme: 'sheet-cell'; workbook: string; sheet: string; cell: string; bytes?: ByteRange; lines?: LineRange; columns?: ColumnRange; charset?: Charset; hash?: string; mtime?: number }
export interface UrlReference { scheme: 'url'; target: string; external: true; mediaType?: string }
export interface HandleReference { scheme: 'handle'; target: Handle }
export type Reference = FileReference | SymbolReference | ModuleReference | FormulaLocation | SheetCellReference | UrlReference | HandleReference
export interface ConceptMetadata {
  identity: Handle                 // PUBLIC handle; numeric identity never leaves the host
  name: string; kind: NodeKind
  summary: string                  // <= 200 chars, what the node is
  brief: string                    // <= 300 chars, what the content says; explicit only
  description: string              // <= 500 chars, behaviour
  usage: string                    // <= 300 chars; empty when unknown, never invented
  purpose: string                  // <= 200 chars
  reference: Reference             // locator only; no body bytes
  path?: string; byteStart?: number; byteEnd?: number; lineStart?: number; lineEnd?: number; fingerprint?: string
  charset?: Charset; charsetConfidence?: number; charsetSource?: CharsetSource; bom?: boolean; bomBytes?: number
  tags?: string[]; status?: string; language?: Language; owner?: Handle
  version?: string; source?: string; created?: Timestamp; changed?: Timestamp
}
export interface NodeCard { identity: Handle; name: string; kind: NodeKind; summary: string; brief: string; reference: Reference; path?: string; byteStart?: number; byteEnd?: number; lineStart?: number; lineEnd?: number; fingerprint?: string; charset?: Charset; charsetConfidence?: number; charsetSource?: CharsetSource; bom?: boolean; bomBytes?: number; status?: string; usage?: string; purpose?: string }
```

### 2.1 Entity interfaces

```ts
export interface Project extends NodeBase { kind: 'project'; root: string; manifest: 'package' | 'pyproject' | 'tsconfig' | 'lake' | 'sphinx' | 'unknown'; manifestPath?: string; name: string; moduleCount: number; documentCount: number; truncated: boolean }
export interface Module extends NodeBase { kind: 'module'; path: string; language: Language; media: string; bytes: number; parser: string; symbolCount: number; importCount: number; exportCount: number }
export interface Document extends NodeBase { kind: 'document'; path: string; form: DocumentForm; media: string; parser: string; bytes: number; title?: string; surfaceCount: number }
export interface Workbook extends Document { form: 'workbook'; sheetCount: number; namedRangeCount: number; formulaCount: number }

export interface Book extends NodeBase { kind: 'book'; title: string; authors: string[]; edition?: string; isbn?: string; language: Language; publisher?: string; year?: number; metadata?: string }
export interface Part extends NodeBase { kind: 'part'; title: string; ordinal: number }
export interface Chapter extends NodeBase { kind: 'chapter'; title: string; ordinal: number; form?: 'chapter' | 'preface' | 'appendix' | 'index' | 'frontmatter' }
export interface Article extends NodeBase { kind: 'article'; title: string; authors: string[]; keywords: string[]; venue?: string; doi?: string; year?: number; standalone: boolean; explicit: boolean; ordinal: number }
export interface Section extends NodeBase { kind: 'section'; title?: string; level: number; ordinal: number }
export interface Person extends NodeBase { kind: 'person'; name: string; orcid?: string; affiliation?: string; email?: string }
export interface Venue extends NodeBase { kind: 'venue'; form: 'journal' | 'proceedings' | 'conference' | 'preprint' | 'unknown'; name: string; publisher?: string; issn?: string; year?: number }
export interface Paragraph extends NodeBase { kind: 'paragraph'; ordinal: number }
export interface Slide extends NodeBase { kind: 'slide'; ordinal: number; title?: string; shapeCount: number; hidden: boolean }
export interface Sheet extends NodeBase { kind: 'sheet'; ordinal: number; name: string; rowCount: number; columnCount: number; cellCount: number; formulaCount: number; truncated: boolean }
export interface Cell extends NodeBase { kind: 'cell'; sheet: Identity; rowIndex: number; columnIndex: number; address: string; valueType: 'text' | 'number' | 'boolean' | 'error' | 'date' | 'empty' | 'unknown'; cached: boolean; injectionRisk: boolean }
export interface Range extends NodeBase { kind: 'range'; sheet?: Identity; form: 'cell' | 'row' | 'column' | 'named'; name?: string; start: string; end?: string; cellCount: number; truncated: boolean }
export interface RowView { sheet: Identity; rowIndex: number; cell: Handle[] }
export interface ColumnView { sheet: Identity; columnIndex: number; cell: Handle[] }
export type DocumentSurface = Book | Part | Chapter | Article | Section | Paragraph | Sheet | Slide

export interface Statement extends NodeCore {
  kind: StatementKind; label?: string; title?: string
  container: 'document' | 'section' | 'paragraph' | 'sheet' | 'html-section' | 'lean-module'
  formal: boolean; formalSystem?: 'lean' | 'coq' | 'isabelle' | 'agda' | 'other'
  status: StatementStatus; evidence?: Identity                              // Proof identity
  sourceForm?: string                                                       // e.g. 'proposition'
}
export interface Definition extends Statement { kind: 'definition' }
export interface Lemma extends Statement { kind: 'lemma' }
export interface Theorem extends Statement { kind: 'theorem' }
export interface Corollary extends Statement { kind: 'corollary' }
export interface Property extends Statement { kind: 'property' }
export interface Axiom extends Statement { kind: 'axiom' }
export interface Claim extends Statement { kind: 'claim' }
export interface Example extends Statement { kind: 'example' }
export interface Remark extends Statement { kind: 'remark' }
export interface Proof extends Statement { kind: 'proof'; form: 'tactic' | 'term' | 'environment' | 'informal' | 'unknown'; proofStatus?: 'complete' | 'incomplete' | 'admitted' | 'sorry' | 'unverifiable'; target?: Identity }
export interface SymbolView { kind: 'class' | 'function' | 'method' | 'definition'; handle: Handle; name: string; owner?: Handle }
export interface Condition extends NodeCore {
  kind: 'condition'; form: ConditionForm; formula?: Identity
  container: 'statement' | 'plan-step' | 'function' | 'module' | 'document' | 'section' | 'sheet' | 'html-section' | 'condition'
  status: ConditionStatus; evidence?: Identity; author?: string; source?: string
  negated: boolean; appliesTo?: Handle
}
export interface RequireView { target: Handle; condition: Handle }  // necessary, "only if"
export interface MeetView { target: Handle; condition: Handle }     // sufficient, "if"

export type ChainRelation = 'depends' | 'satisfies' | 'baseline' | 'prerequisite' | 'requires' | 'meets' | 'proves' | 'defines' | 'imports' | 'exports' | 'annotates' | 'labels' | 'property_of' | 'part_of' | 'published_in' | 'cites' | 'edition_of' | 'authored_by'
export type ChainStatus = 'satisfied' | 'unmet' | 'unknown' | 'stale' | 'unverifiable'
export interface ChainLink {
  handle: Handle; from: Handle; to: Handle; relation: ChainRelation; direction: 'forward' | 'reverse'
  status: ChainStatus; depth: number; evidenceHandle?: Handle; baselineVersion?: string
  kind?: NodeKind; name?: string; label?: string; title?: string; brief?: string
  path?: string; byteStart?: number; byteEnd?: number; lineStart?: number; lineEnd?: number; fingerprint?: string; charset?: Charset
  span?: SourceSpan; created: Timestamp; changed: Timestamp
}
export interface Chain {
  root: Handle; link: ChainLink[]; depth: number; truncated: boolean
  cycle?: Handle[]; computedAt: Timestamp; projectionVersion: string
}

export type FormulaDialect = 'spreadsheet' | 'tex' | 'markdown-math' | 'mathml' | 'omml' | 'asciimath' | 'typst' | 'unknown'
export type FormulaDelimiter = 'inline' | 'block' | 'cell' | 'environment'
export type FormulaContainer = 'cell' | 'paragraph' | 'block' | 'heading'
export type FormulaSemantics = 'computes' | 'typesets' | 'both' | 'unknown'
export interface Formula extends NodeBase {
  kind: 'formula'; dialect: FormulaDialect; delimiter: FormulaDelimiter; container: FormulaContainer; semantics: FormulaSemantics
  form?: 'arithmetic' | 'comparison' | 'function' | 'reference' | 'mixed'
  sheet?: Identity; anchor?: Identity                                        // spreadsheet only
  ast?: FormulaNode; referenceCount: number
  cachedValue?: string; cachedType?: 'number' | 'text' | 'boolean' | 'error' | 'unknown'; cachedAt?: Timestamp
  truncated: boolean
}
export type FormulaReferenceKind = 'cell' | 'range' | 'name' | 'symbol' | 'label' | 'equation' | 'bibliography'
export interface FormulaReference { kind: FormulaReferenceKind; sheet?: string; start: string; end?: string; absoluteStart?: boolean; absoluteEnd?: boolean }
export type FormulaNode =
  | { kind: 'literal'; span: SourceSpan; children: []; valueType: 'number' | 'text' | 'boolean' | 'error'; value: string }
  | { kind: 'symbol'; span: SourceSpan; children: FormulaNode[]; name: string }
  | { kind: 'cell'; span: SourceSpan; children: []; reference: FormulaReference }
  | { kind: 'range'; span: SourceSpan; children: []; reference: FormulaReference }
  | { kind: 'name'; span: SourceSpan; children: []; reference: FormulaReference }
  | { kind: 'call'; span: SourceSpan; children: FormulaNode[]; name: string }
  | { kind: 'operator'; span: SourceSpan; children: FormulaNode[]; operator: string }
  | { kind: 'fraction'; span: SourceSpan; children: [FormulaNode, FormulaNode] }
  | { kind: 'superscript' | 'subscript'; span: SourceSpan; children: FormulaNode[] }
  | { kind: 'radical'; span: SourceSpan; children: FormulaNode[] }
  | { kind: 'matrix'; span: SourceSpan; children: FormulaNode[][] }
  | { kind: 'environment'; span: SourceSpan; children: FormulaNode[]; name: string }
  | { kind: 'delimiter'; span: SourceSpan; children: FormulaNode[]; open: string; close: string }
  | { kind: 'unknown'; span: SourceSpan; children: []; raw: string }

export interface ClassSymbol extends NodeBase { kind: 'class'; name: string; signature?: string; abstract: boolean; exported: boolean }
export interface FunctionSymbol extends NodeBase { kind: 'function'; name: string; signature?: string; async: boolean; generator: boolean; exported: boolean }
export interface MethodSymbol extends NodeBase { kind: 'method'; name: string; signature?: string; form: 'method' | 'constructor' | 'getter' | 'setter'; ownerClass: Identity; exported: boolean }
export interface Comment extends NodeBase { kind: 'comment'; style: 'line' | 'block' | 'doc' | 'html'; attachment: 'leading' | 'trailing' | 'inner' | 'orphan'; target?: Identity }
export interface Code extends NodeBase { kind: 'code'; form: 'span' | 'block'; language?: string; digest: string; executable: false }
export interface Importation extends NodeBase { kind: 'importation'; specifier?: string; resolution: 'resolved' | 'external' | 'unresolved' | 'unverifiable'; typeOnly: boolean; names?: string[]; target?: Identity }
export interface Exportation extends NodeBase { kind: 'exportation'; name: string; names?: string[]; source?: Identity; wildcard: boolean; typeOnly: boolean }
export interface Sign extends NodeBase { kind: 'sign'; form: 'keyword' | 'operator' | 'sigil' | 'directive' | 'annotation'; role?: 'label' | 'reference' | 'cite' | 'decorator' | 'at-rule' | 'heading' | 'fence' | 'directive'; language: Language; meaning?: string; target?: Identity }
export interface DependencyView { source: Handle; target?: Handle; kind: 'import' | 'include' | 'stylesheet' | 'asset' | 'manifest' | 'formula'; specifier: string; external: boolean; typeOnly: boolean; origin: 'import' | 'manifest' | 'formula' }
```

### 2.2 Statement kinds and status

| Kind | Introduces / asserts | Required relation | Status default |
|---|---|---|---|
| `definition` | A term, symbol or type | `defines` → `SymbolView` | `stated` |
| `axiom` | An assumption | has no `proves` incoming; others `assumes` it | `axiomatic` |
| `property` | A claim about an entity/type | `property_of` → entity/type | `stated` |
| `lemma` | An auxiliary statement | `supports` → statement it supports | `stated` |
| `theorem` / `corollary` | First-class results (never folded into lemma) | `proves` incoming from `Proof` | `stated` |
| `claim` | An asserted statement awaiting proof | `proves` or `disproves` incoming | `stated` |
| `example` / `remark` | Illustration or commentary | optional `uses`/`references` | `stated` |
| `proof` | Evidence, not a claim | `proves`/`disproves` → target | `unverifiable` without target |

`proposition` is not a NodeKind; it maps to `kind='theorem'` with `sourceForm='proposition'`
when the source explicitly says so. Status rules: explicit marker without a proof link is
`stated`; `unproved` only when a proof is claimed/expected but missing or truncated; `proved`
only when an explicit `proves` edge reaches the statement; `disproved` only from an explicit
`disproves` edge; `axiomatic` only for axioms; a formal declaration without an explicit checked
artifact is `unverifiable`, never `proved` from `Qed`/`by` alone. A `Proof` with no recognizable
target is `status='unverifiable'` and `proofStatus='unverifiable'`.

### 2.3 Conditions: Require vs Meet

| Primitive | Reading | Direction | If violated | If satisfied |
|---|---|---|---|---|
| `Require` | Necessary, "only if": target holds/executes ⇒ condition holds | target → condition (`requires`) | invalidates the target | does **not** guarantee the target |
| `Meet` | Sufficient, "if": condition holds ⇒ target holds | condition → target (`meets`) | says nothing about the target | guarantees the target only with explicit evidence |
| both | Necessary and sufficient (iff) | both directions | — | `equivalent`/`iff` is a **derived view**, not a third truth primitive |

`Satisfy`/`Violate` are status/evidence relations (`satisfies`, `violates`), never synonyms of
`Require`/`Meet`. `Require` and `Meet` are relation primitives and `RequireView`/`MeetView`
views, not `NodeKind` values. The condition implication graph uses `entails`; cycles are legal
and produce equivalence strongly connected components.

| Collision | Correct classification |
|---|---|
| Coq `Require Import` / `Require` | `Importation` + `imports` edge; never `Condition`. |
| Lean/Lake `require` | Package/module dependency (`Importation`); never `Condition`. |
| Python `assert` | Code statement/control flow; `Condition` only when an explicit contract tag annotates it. |
| JavaScript `throw` | Control flow; never `Condition`. |
| JSDoc/TSDoc `@requires` | `Condition` only in a contract tag context; `@throws`/`@param` are not conditions. |
| JML/Dafny/Why3/ACSL `@requires`/`@ensures`/`@pre`/`@post`/`@invariant` | `Condition` (contract tag allowlist). |
| `Require` (entity/relation) vs `requires` (edge) | `Require`/`Meet` are relation views; the SQL edges are `requires`/`meets`. |

Status rules: default `unknown`; explicit but structurally unevaluable is `unverifiable`;
`satisfied`/`violated` only from explicit `satisfies`/`violates` evidence, never a solver or
heuristic. A violated `Require` makes a `Statement` target at most `unproved` and a `SubTask`
`rejected`/`failed`; a `Meet` may raise a target to `proved` only with explicit evidence.
`unknown` never auto-passes. `Require + Meet` yields the derived `equivalent` view; no third
truth value is stored. `Condition.form` maps the requested `kind` (`precondition`/…); the node
`kind` is `condition`. A `Condition` has no stored expression text; `metadata.brief` gives the
gist and `metadata.reference` locates the source span; the `formula` link optionally points to
a derived `Formula` AST, never serialized to the agent.

### 2.4 Concept metadata and agent cards

Every persisted node carries `ConceptMetadata`; `Dependency`, `ChainLink` and `Chain` are
projected as metadata but never persisted. **Blueprint invariant:** the node row stores
identity/name/kind/summary/brief/description/usage/purpose/reference/tags/status/language/
version/source and **no** file body, raw source text, attachment bytes, or full AST. Derived
ASTs, patch data and formula ASTs are at most bounded in-memory caches keyed by
`reference.hash + mtime`, never persisted as content. `identity` is the public `handle`; the
internal numeric `identity` never leaves the host and is not a second ID scheme.

| Kind group | `name` | `summary` (what it is) | `brief` (what content says) | `description` | `usage`/`purpose` |
|---|---|---|---|---|---|
| class/function/method | symbol name | first doc-comment line | first doc sentence | ≤ 500-char doc excerpt | explicit `@usage`/`Purpose:` only |
| module/project | path/manifest name | README/package description if explicit | package purpose sentence | exports/imports or manifest scope | explicit docs only |
| book/article/chapter/section/paragraph | title/heading | structural role | abstract/front-matter sentence | structure/ordering | never inferred from prose |
| formula | optional label | dialect + form | what the formula means | computes/typesets semantics | explicit label/target only |
| definition/lemma/proof/property/axiom | kind + label | formal statement kind | statement gist | formal system/status context | explicit `\uses`/contract tag only |
| condition | kind | condition form | logic gist (necessary/sufficient) | target/scope | explicit target |
| comment/code/sign/importation/exportation | explicit text/path/specifier | one-line role | explicit first line/specifier | attachment/role | explicit source only |
| sheet/cell/range | sheet/cell/range label | data role | formula/meaning if explicit | bounds/type | explicit sheet context |
| person/venue/part | name/title | authority/publication role | role/venue context | authority/publication scope | explicit metadata only |

`NodeCard` is identity, name, kind, summary, brief, reference (locator only), the six flat
fields (`path`, `byteStart`, `byteEnd`, `lineStart`, `lineEnd`, `fingerprint`) plus optional
status/usage/purpose, capped at ~300 tokens / 1 KiB. `ChainLink` carries identity, name,
relation, status, depth, evidenceHandle, `brief` ≤ 120 chars and, only when budget allows,
`path` + one range + `fingerprint`; it carries no reference body, description, usage or purpose.
`coordination_describe` (read-only) accepts
`{handle, fields?: ['summary','description','usage','purpose']}` and always returns `brief`,
`reference` and the six flat fields; the body is never returned. `coordination_read` is the only
content path (§2.5). Caps: `name` non-empty for persisted nodes; `summary` ≤ 200, `brief` ≤ 300,
`description` ≤ 500, `usage` ≤ 300, `purpose` ≤ 200; total metadata ≤ 4 KiB; strip HTML/secrets;
language-aware; missing fields are empty plus `unverifiable`, never fabricated.
`describe(handle)` / `nodeCard(handle)` are O(log n); `findByName` O(log n + k);
`searchSummary` is bounded by `LIMIT` with explicit `truncated`; `listChildren` returns cards,
never bodies.

### 2.5 File references, coordinate semantics, and reads

`FileReference` is the only way a file-backed node points at content: a workspace-relative
`path` plus **both** a byte range and a line range, never the bytes. `bytes` are byte offsets in
the file's `charset` (UTF-8 in P0), `start` inclusive and `end` **exclusive**; CRLF is two bytes
in UTF-8 (four in UTF-16LE) and a BOM is part of the file but **not** part of any fragment range
(`byteStart >= bomBytes`). `lines` are 1-based decoded line numbers, `start` inclusive and
`end` **inclusive**; LF, CRLF and CR each count as one decoded break and a final line without a
newline still counts. `columns` are optional 1-based Unicode code points. The asymmetry is
deliberate: byte ranges are half-open for slicing; line ranges are inclusive for readers. LSP
positions are 0-based UTF-16 line/character; this model is charset bytes + 1-based inclusive
lines, so convert through the line index and a decode step — never mix LSP offsets with bytes.
Both ranges are required for text files and must be produced by the same scan; if they cannot
agree (binary/unknown charset), the reference is bytes-only with `lines` absent and the node
is `unverifiable`. `hash` covers the referenced range (not the whole file); `fileBytes` and
`mtime` support bounds and staleness. `path` is normalized, workspace-relative, and rejects
traversal, absolute paths outside the workspace, credentials and `data:` bodies. The six flat
fields on the node (`path`, `byteStart`, `byteEnd`, `lineStart`, `lineEnd`, `fingerprint`) are
authoritative; the nested `reference` is a convenience locator. `fingerprint` is
`sha256:<hex>` over the exact fragment bytes only (path/range not mixed in), host-computed and
never agent-supplied; identical text at another location has the same fingerprint, while
position + fingerprint detects both content and layout changes.

`coordination_read` (host-authorized): args
`{handle? | path, mode: 'bytes'|'lines', start: number, end: number, maxBytes?: number, maxLines?: number, charset?: Charset}`.
Bytes mode uses charset byte offsets with `end` exclusive; lines mode uses 1-based decoded lines
with `end` inclusive and maps through a host-only line index. A node read defaults to its recorded
range and stored charset; a `charset` override is diagnostics-only. An explicit override must
stay inside `fileBytes`/line count. Response:
`{path, mode, requested, returned, content, truncated, hash, charset, nextStart?, lineRange?, byteRange?}`;
`content` is the only place real text is returned, subject to 256 KiB/2,000 lines/16k tokens
per read, redaction and token budget. NUL/`binary`/`unknown` or undecodable sequences refuse text
reading (metadata only); invalid sequences are never silently replaced/corrupted.
`resolveReference(handle)` validates and returns a locator; `readReference(handle, mode, start,
end)` reads; `lineToByte`/`byteToLine` are O(log n) via a per-file line-start index in a bounded
LRU (BPlusTree/OrderedSkipList or sorted-array binary search); read is O(k). Cache invalidation
uses `fingerprint` + `charset` + `mtime`; NodeCard/Chain/list never include content.

### 2.6 Charset detection and support

`Charset` is closed: `'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'utf-16le-bom' |
'utf-16be-bom' | 'utf-32le' | 'utf-32be' | 'utf-32le-bom' | 'utf-32be-bom' | 'ascii' | 'latin1' |
'windows-1252' | 'gb18030' | 'gbk' | 'big5' | 'shift-jis' | 'euc-kr' | 'binary' | 'unknown'`.
Unknown values are rejected, never guessed. `utf-8-bom` means `EF BB BF`; `utf-16*-bom`/`utf-32*-bom`
mean the BOM is present; `binary` is non-text/undecodable; `unknown` is detection failure. `ascii`
only when every byte is `< 0x80`; otherwise valid UTF-8 is `utf-8`. Detection order: UTF-32 BOM
(`FF FE 00 00` / `00 00 FE FF`) before UTF-16 (`FF FE` / `FE FF`) before UTF-8 (`EF BB BF`), so
UTF-32 is never misread as UTF-16. Without a BOM: valid UTF-8 ⇒ `utf-8`; all bytes `< 0x80` ⇒
`ascii`; UTF-16/32 only with high-confidence NUL patterns; legacy candidates (gb18030/gbk/big5/
shift-jis/euc-kr/latin1/windows-1252) only when declared or detected above a documented confidence
threshold, else `unknown`/`binary`. No silent transcoding. `charsetConfidence` (0..1) and
`charsetSource` (`bom`/`declared`/`heuristic`/`fallback`) are recorded.

| Scope | Supported | Behaviour |
|---|---|---|
| P0 | `utf-8`, `utf-8-bom`, `ascii` | full parse with bytes + lines + fingerprint |
| P1 | `utf-16le/be` (+BOM), `gb18030`, `big5`, `shift-jis`, `euc-kr` | detect/declared, lossless transcode for parsing; original byte offsets and raw-byte fingerprint; lossy/exact-map failure ⇒ `unverifiable`, bytes only |
| P2 | `utf-32*`, `latin1`, `windows-1252`, other legacy | best effort; `binary`/`unknown` never parsed as text, bytes only + diagnostic |

BOM bytes count in `fileBytes` but are outside all fragment ranges (`bom: true`, `bomBytes`);
line numbers are decoded lines. `fingerprint` is sha256 over the original fragment bytes before
any decoding/transcoding, so charset and content changes both invalidate. Unknown/low-confidence
charset produces no line range, only bytes + fingerprint. Host APIs: `nodesByCharset(charset)`
O(log n + k), `detectCharset(pathBytes)` host-only (not agent), `validateCharsetDeclared(path,
declared)` rejects a declared charset that contradicts the BOM.

### 2.7 Post-edit refresh contract

The agent may modify a file only through an authorized write/edit command. The host then
re-reads/reparses the affected file (or the affected span plus a bounded reparse window),
recomputes `byteStart`/`byteEnd`/`lineStart`/`lineEnd` and `fingerprint` for every affected
fragment, and returns the updated fragment metadata. The agent **must not** compute or write
`fingerprint`, `byteEnd`, `lineEnd` or `path`; it uses the returned values. An insert/delete
before a fragment shifts all downstream ranges even when text is unchanged; the fingerprint
stays stable, so the pair (position, fingerprint) detects both content and layout changes.
A cached handle whose fingerprint no longer matches is `stale` and must be refreshed via
`coordination_describe`/`coordination_refresh` before reuse. If the host cannot reparse safely
(binary, too large, timeout), it marks `unverifiable`/`stale` and never guesses ranges.

`coordination_write` args
`{path, byteStart?, byteEnd?, lineStart?, lineEnd?, content, expectedFingerprint?, charset?: Charset, bom?: boolean}`;
omitted `charset`/`bom` preserve the file's current charset/BOM; changing either invalidates every
fragment and must be explicit. An `expectedFingerprint` mismatch (or an implicit charset change)
returns `CONFLICT` and writes nothing. Response:
`{path, fileBytes, mtime, charset, charsetConfidence, charsetSource, bom, bomBytes, fragments:[{handle,path,byteStart,byteEnd,lineStart,lineEnd,fingerprint,charset,bom}], truncated}`.
`coordination_refresh` args `{path}` or `{handles[]}` returns updated fragment metadata only,
never content. Reads remain byte/line based; `path+byteStart/byteEnd` and
`path+lineStart/lineEnd` must resolve to the same span, otherwise `stale`/`unverifiable`.
Storage indexes `(path,byteStart)` and `(path,lineStart)`; cache key is
`path + fingerprint + charset`; `fingerprint` is never accepted from the agent.

### 2.8 SQLite (schema version 24, new tables only)

Existing tables are untouched; `restriction` remains the table for `Constraint`.
`SCHEMA_VERSION` becomes 24. The node row stores metadata and locators only; no file body,
raw source text, attachment bytes, `content`, `value` or full AST.

```sql
CREATE TABLE IF NOT EXISTS node (
  identity INTEGER PRIMARY KEY AUTOINCREMENT, handle TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, locator TEXT NOT NULL,
  project INTEGER, owner INTEGER, parent INTEGER, path TEXT, name TEXT, title TEXT, label TEXT, ordinal INTEGER NOT NULL DEFAULT 0, level INTEGER,
  byteStart INTEGER, byteEnd INTEGER, lineStart INTEGER, lineEnd INTEGER, fingerprint TEXT,
  charset TEXT, charsetConfidence REAL, charsetSource TEXT, bom INTEGER, bomBytes INTEGER, hash TEXT, status TEXT NOT NULL DEFAULT 'parsed',
  language TEXT, form TEXT, sourceForm TEXT, signature TEXT, specifier TEXT, resolution TEXT, external INTEGER, typeOnly INTEGER,
  target INTEGER, sheet INTEGER, anchor INTEGER, formula INTEGER, rowIndex INTEGER, columnIndex INTEGER, address TEXT, valueType TEXT, rangeForm TEXT,
  rangeStart TEXT, rangeEnd TEXT, cellCount INTEGER, rowCount INTEGER, columnCount INTEGER, dialect TEXT, delimiter TEXT, container TEXT,
  semantics TEXT, formal INTEGER, formalSystem TEXT, evidence INTEGER, proofStatus TEXT, role TEXT, meaning TEXT,
  summary TEXT, brief TEXT, description TEXT, usage TEXT, purpose TEXT, reference TEXT, tags TEXT, version TEXT,
  appliesTo TEXT, author TEXT, source TEXT, negated INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, changed INTEGER NOT NULL, detail TEXT,
  CHECK (byteStart IS NULL OR byteEnd IS NULL OR byteStart <= byteEnd),
  CHECK (lineStart IS NULL OR lineEnd IS NULL OR lineStart <= lineEnd),
  CHECK (kind = 'project' OR project IS NOT NULL),
  FOREIGN KEY (project) REFERENCES node(identity), FOREIGN KEY (owner) REFERENCES node(identity), FOREIGN KEY (parent) REFERENCES node(identity),
  FOREIGN KEY (target) REFERENCES node(identity), FOREIGN KEY (sheet) REFERENCES node(identity), FOREIGN KEY (anchor) REFERENCES node(identity),
  FOREIGN KEY (formula) REFERENCES node(identity), FOREIGN KEY (evidence) REFERENCES node(identity)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_locator ON node(kind, locator);
CREATE INDEX IF NOT EXISTS idx_node_project ON node(project, kind);
CREATE INDEX IF NOT EXISTS idx_node_owner ON node(owner, kind, ordinal);
CREATE INDEX IF NOT EXISTS idx_node_parent ON node(parent, ordinal);
CREATE INDEX IF NOT EXISTS idx_node_name ON node(kind, name);
CREATE INDEX IF NOT EXISTS idx_node_meta ON node(kind, status, name);
CREATE INDEX IF NOT EXISTS idx_node_summary ON node(kind, summary);
CREATE INDEX IF NOT EXISTS idx_node_path ON node(kind, path);
CREATE INDEX IF NOT EXISTS idx_node_position ON node(path, byteStart);
CREATE INDEX IF NOT EXISTS idx_node_line ON node(path, lineStart);
CREATE INDEX IF NOT EXISTS idx_node_fingerprint ON node(fingerprint);
CREATE INDEX IF NOT EXISTS idx_node_charset ON node(charset);
CREATE INDEX IF NOT EXISTS idx_node_sheet ON node(sheet, rowIndex, columnIndex);
CREATE INDEX IF NOT EXISTS idx_node_label ON node(owner, kind, role);
CREATE INDEX IF NOT EXISTS idx_node_statement ON node(project, kind, status);
CREATE INDEX IF NOT EXISTS idx_node_condition ON node(project, kind, status);
CREATE INDEX IF NOT EXISTS idx_node_applies ON node(appliesTo);
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_formula_anchor ON node(anchor) WHERE kind = 'formula' AND anchor IS NOT NULL;

CREATE TABLE IF NOT EXISTS edge (
  identity INTEGER PRIMARY KEY AUTOINCREMENT, handle TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, source INTEGER NOT NULL,
  target INTEGER, project INTEGER NOT NULL, label TEXT NOT NULL DEFAULT '', baselineVersion TEXT, ordinal INTEGER NOT NULL DEFAULT 0,
  weight REAL NOT NULL DEFAULT 1, spanStart INTEGER, spanEnd INTEGER, created INTEGER NOT NULL,
  FOREIGN KEY (source) REFERENCES node(identity), FOREIGN KEY (target) REFERENCES node(identity), FOREIGN KEY (project) REFERENCES node(identity)
);
CREATE INDEX IF NOT EXISTS idx_edge_source ON edge(source, kind, ordinal);
CREATE INDEX IF NOT EXISTS idx_edge_target ON edge(target, kind);
CREATE INDEX IF NOT EXISTS idx_edge_project ON edge(project, kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_key ON edge(source, kind, coalesce(target, 0), label);

CREATE TABLE IF NOT EXISTS snapshot (
  identity INTEGER PRIMARY KEY AUTOINCREMENT, handle TEXT UNIQUE NOT NULL, node INTEGER NOT NULL, path TEXT NOT NULL,
  size INTEGER NOT NULL, modified INTEGER NOT NULL, parser TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL,
  nodeCount INTEGER NOT NULL DEFAULT 0, edgeCount INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, changed INTEGER NOT NULL,
  UNIQUE(node), FOREIGN KEY (node) REFERENCES node(identity)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_path ON snapshot(path, modified, size, parser);
```

`node.reference` is the JSON locator; `brief` is the explicit synopsis; the six flat fields
(`path`, `byteStart`, `byteEnd`, `lineStart`, `lineEnd`, `fingerprint`) and `charset`/`bom`
are authoritative. There is no `node.content`, `node.value` or content blob. `appliesTo` is an
opaque handle for Plan/SubTask targets that are not domain nodes. `edge.baselineVersion` is the
pinned version/hash of a `baseline` link. `detail` holds rare non-body metadata (`cached*`).
`locator` examples:
`project:<root>`, `module:<path>`, `document:<path>/lemma:2`,
`module:<path>/function:foo#1`, `document:<path>/sheet:1/cell:B3`,
`document:<path>/formula:7`, `module:<path>/sign:@120`.

## 3. Opaque boundary and Chain projection

**The agent never touches or serializes internal structures.** The host pipeline is
`parser → internal graph/index → status evaluator → chain projector → tool result`; the agent
receives only a `Chain` (or a digest). It cannot read DB rows, ASTs, graphs, adjacency maps,
`RedBlackTree`/`LRU`/`Trie`/`SparseGrid` internals, handles' internals, or raw file text.
`ChainLink`/`Chain` are projections, not persisted truth; no `NodeKind`, no table.

| Chain relation | Exact semantics | Stored edge |
|---|---|---|
| `depends` | A needs B to exist/be valid (import/module/dependency); missing/stale/broken B makes A `unverifiable` or `blocked`. | `depends`/`imports` edge |
| `satisfies` | Evidence/condition/implementation E satisfies target T; only a verifier/host may write it; an agent claim is not satisfaction. | `satisfies` edge |
| `baseline` | A uses B as its reference version/decision; B changes ⇒ A `stale`; version/hash is stored on the link. | `baseline` edge + `baselineVersion` |
| `prerequisite` | A's necessary task/step input is B (work item, condition, definition); unmet ⇒ A `blocked`/fail-closed. | `prerequisite` edge |
| `requires` | Necessary **condition** on a target ("only if"), condition-level; violated ⇒ target invalid. | `requires` edge |
| `meets` | Sufficient **condition** ("if"), condition-level; met alone never proves without evidence. | `meets` edge |
| `proves` / `defines` / `imports` / `exports` / `annotates` / `labels` / `property_of` | Existing semantics from §4; projected unchanged. | corresponding edge |
| `part_of` | Article/Chapter → Book; baseline edition is carried by `edition_of`/`baselineVersion`. | `part_of` edge |
| `published_in` | Article → Venue (journal/proceedings/conference/preprint). | `published_in` edge |
| `cites` | Article/Book → Article/Book/Statement; citation cycles are legal and reported; external URLs have no target. | `cites` edge |
| `edition_of` / `authored_by` | Book → Book baseline / Book/Article → Person; stale edition invalidates dependents. | `edition_of`/`authored_by` edge |

`prerequisite` is task/step-level necessary input; `requires` is a logical necessary condition;
`baseline` is a version/decision reference; `depends` is existence/validity. They are not
interchangeable. `coordination_chain` (read-only): args
`{handle?: string, action: 'dependencies'|'dependents'|'satisfies'|'satisfied_by'|'baseline'|'prerequisites'|'unmet'|'path', depth?: 1..8, relation?: ChainRelation, limit?: 1..50}`;
returns `{root, links[], depth, truncated, cycle?, version}` with only handle, name, kind,
relation, status, depth, evidenceHandle, brief ≤ 120 and, when budget allows, a compact locator
(path + one range + fingerprint); never the body. Budget: depth ≤ 8,
links ≤ 50, ~1,500 tokens; truncation is explicit (`truncated: true`), never silent. No AST, no
adjacency map, no raw text, no full object graph. Writes (`satisfy`/`verify`/`baseline`) are
host/service operations with authorization; the agent may request them, never assert them.

## 4. Relations, direction, cardinality, indexing

```ts
export type EdgeKind = 'contains' | 'imports' | 'exports' | 'declares' | 'references' | 'defines' | 'proves' | 'disproves' | 'assumes' | 'supports' | 'property_of' | 'formalizes' | 'comments' | 'annotates' | 'marks' | 'computes' | 'typesets' | 'labels' | 'uses' | 'depends' | 'requires' | 'meets' | 'satisfies' | 'violates' | 'entails' | 'precondition_of' | 'postcondition_of' | 'invariant_of' | 'guard_of' | 'baseline' | 'prerequisite' | 'part_of' | 'published_in' | 'cites' | 'edition_of' | 'translates' | 'compiles' | 'authored_by'
```

Requested `depends_on` is `depends` for cells and `uses` for statements (no underscores).
`evaluates_to`/`renders_as` are `Formula.cachedValue`/`rendered`, not edges. `shares_sheet`
is derived by `contains` (equal `sheet`). `statementGraph` uses
`uses`/`assumes`/`supports`/`proves`/`disproves`/`formalizes`. `conditionGraph` uses
`requires`/`meets`/`satisfies`/`violates`/`entails`; `equivalent` is derived from mutual
`entails` or from `requires` + `meets`, never a stored edge.

| Edge | From → To | Cardinality | Transitive | Persisted/indexed by |
|---|---|---|---|---|
| `contains` | Project → Module/Document/Workbook; Document(book/article) → Book/Article; Book → Part/Chapter/Article; Part → Chapter/Article; Article/Chapter/Section → Section/Paragraph/Formula/Statement/Comment/Code; Module/Class/Function → child | 1→n | yes | `node.parent`, `idx_node_parent`, `AstTree`/`AstIndex`, `OrderedMap` outline |
| `imports` | Module → Module | n→m | no (closure query) | `edge(source,kind)`, `DirectedGraph` |
| `exports` | Module → Exportation | 1→n | no | `edge`, `OrderedMap` declaration order |
| `declares` | Module/Class/Function → Class/Function/Method | 1→n | no | `edge`, `RedBlackTree<name,Handle>`, `Trie` |
| `references` | any → any (`\ref`, type, link, label) | n→m | no | `edge`, `DirectedGraph` + reverse `RedBlackTree` |
| `defines` | Definition → Class/Function/Method (SymbolView) | n→1 | no | `edge`, `OrderedMap` |
| `proves` | Proof → Lemma/Theorem/Corollary/Property/Claim | n→1 | no | `edge(target,kind)`, reverse `RedBlackTree` |
| `disproves` | Proof → Theorem/Property/Claim | n→1 | no | `edge(target,kind)` |
| `assumes` | Statement/Proof → Axiom | n→m | no | `edge`, `DirectedGraph` |
| `supports` | Lemma → Statement it supports | n→m | no | `edge`, `OrderedMap` |
| `property_of` | Property → Class/Function/Method/Definition/Module/Document | n→1 | no | `edge(target,kind)` |
| `formalizes` | formal Statement → informal Statement | n→1 | no | `edge`, `Trie<label,Handle>` |
| `comments` | Comment → Module/Class/Function/Method/Document/Paragraph | 1→1 | no | `edge(target,kind)`, `OrderedMap` |
| `annotates` | Sign/Document/Paragraph/Comment → symbol/definition/proof | n→m | no | `edge`, `DirectedGraph`, `Trie` |
| `marks` | Sign → Chapter/Code/Definition/Importation/Formula | 1→1 | no | `edge`, `OrderedMap<Sign,Handle>` |
| `computes` | Formula → Cell (`spreadsheet` only) | 1→1 | no | `edge`, `DirectedGraph`, `idx_node_formula_anchor` |
| `typesets` | Formula → Paragraph/Chapter/Article | n→1 | no | `edge`, `OrderedMap` |
| `labels` | Formula/Statement → Sign | 1→n | no | `edge`, `Trie<label,Handle>` |
| `uses` | Statement/Proof/Formula → Definition/Axiom/Lemma/Theorem/Class/Function | n→m | no | `edge`, `DirectedGraph`, `Trie` |
| `depends` | Cell → Cell (`spreadsheet` only) | n→m | yes (impact) | `edge`, `DirectedGraph`, `BinaryHeap`/`IndexedHeap` |
| `requires` | target (Statement/Function/Module/Document/Plan step/SubTask) → Condition | n→m | yes (closure) | `edge(source,kind)`, `DirectedGraph`; Plan/SubTask via `appliesTo` |
| `meets` | Condition → target (Statement/Function/Module/Document/Plan step/SubTask) | n→m | yes (closure) | `edge(target,kind)`, reverse `DirectedGraph`; Plan/SubTask via `appliesTo` |
| `satisfies` / `violates` | Evidence (Proof/Statement/Code/Formula/Condition) → Condition; only verifier/host writes `satisfies` | n→1 | no | `edge(target,kind)`, `OrderedMap` |
| `entails` | Condition → Condition | n→m | yes (closure; cycles legal) | `edge`, `DirectedGraph`, SCC |
| `precondition_of` / `postcondition_of` / `invariant_of` / `guard_of` | Condition → Function/Statement/Module/Document/Class | n→1 | no | `edge(target,kind)`, `OrderedMap` |
| `baseline` | A → B (B is A's reference version/decision) | n→1 | no | `edge` + `baselineVersion`, `OrderedMap`/`Trie` |
| `prerequisite` | A → B (B is A's necessary task/step input) | n→1 | no | `edge`, `DirectedGraph` |
| `part_of` | Article/Chapter → Book | n→1 | no | `edge(target,kind)`, `idx_edge_target` |
| `published_in` | Article → Venue | n→1 | no | `edge(target,kind)` |
| `cites` | Article/Book → Article/Book/Statement (external URL: target NULL + label) | n→m | no | `edge`, `DirectedGraph` |
| `edition_of` | Book → Book baseline | n→1 | no | `edge` + `baselineVersion` |
| `translates` | Book/Article → Book/Article | n→1 | no | `edge` |
| `compiles` | Book → Article ordering | 1→n | no | `edge(ordinal)`, `OrderedMap` |
| `authored_by` | Book/Article → Person | n→m | no | `edge`, `OrderedMap` |

`contains` must be acyclic; insertion checks would-be ancestors. `imports`, `references`,
`uses`, `depends`, `statementGraph`, `conditionGraph` and `entails` may cycle.
`DirectedGraph.findCycle()` reports one path and `topologicalSort()`/`dependencyLevels()` return
`null`. A cycle is a legal result, never an exception and never retried.

## 5. Parser mapping

A `Token` is every lexical unit from `ast.ts`; a `Sign` is a *promoted* token. JS `if` is a
Token, not a Sign; `import`, `export`, `@` are Signs. CSS `@media` is a Sign; a quoted string
is not. Markdown `#` is a Sign; paragraph text is not. Only promoted signs are persisted.

| Family | Extracted | Syntax | Out of scope / `unverifiable` |
|---|---|---|---|
| JS/TS/JSX | Module, Importation, Exportation, Class/Function/Method, Comment, Code, Sign | static `import`, `import type`, `export … from`, `export *`, `export =`, literal `import()`, literal `require()`; decorators `@` | non-literal specifiers; computed properties; JSX tags; decorator semantics; TS type-only symbols |
| CSS | Module, Importation, Comment, Sign | `@import`, `url(...)`, `@media`/`@supports`/`@font-face` | CSS class selectors are **not** `Class`; no cascade/value evaluation |
| HTML | Document, Book/Article, Chapter, Section, Paragraph, Code, Comment, Sign, Importation, Statement | `<article>`, `<main>`, `<section>`, `<h1>`–`<h6>`, `<p>`, `<pre><code>`, `<!-- -->`, `<script src>`, `<link href>`, `<img src>`, `<dfn>`, `<section data-kind>`, `<aside class="proof">`, `rel=prev/next`, ARIA roles | inline `<script>` bodies; class-name guesses without a documented allowlist; DOM runtime state |
| Markdown | Document, Book/Article, Chapter, Section, Paragraph, Code, Comment, Importation, Formula, Sign, Statement | headings + labels, fenced code, inline code, links/images, `$...$`/`$$...$$`, front-matter `title/author/book/article/venue/doi`, `SUMMARY.md` chapter list, Pandoc fenced divs `::: book|article|chapter|definition`, admonitions | heading-text heuristics alone; raw HTML blocks; footnote expansion; unknown math macros |
| LaTeX | Document, Book/Article, Part/Chapter/Section, Paragraph, Code, Comment, Formula, Statement, Importation, Sign | `\documentclass{book|article}`, `\part`/`\chapter`/`\section`, `\title`/`\author`/`\date`, `\begin{abstract}`, `\newtheorem` allowlist, statement/proof environments, `\label`/`\ref`/`\cite`, `\input`/`\include` | macro expansion; `\write18`; unknown environment names; custom theorem names not in the allowlist; `\bibliography` targets |
| Lean 4 | Module, Importation, Statement, Proof, Comment, Sign | `import`, `def`, `theorem`, `lemma`, `axiom`, `structure`, `example`, `by`, `sorry` | typeclass/term elaboration; metaprogramming; kernel checking; no prover execution |
| Coq | Module, Importation, Statement, Proof, Comment, Sign | `Require Import`, `Definition`, `Lemma`, `Theorem`, `Axiom`, `Property`, `Proof … Qed/Defined/Admitted` | tactics semantics; sections/variables; `Admitted` is incomplete |
| Isabelle | Module, Importation, Statement, Proof, Comment, Sign | `definition`, `lemma`, `theorem`, `axiomatization`, `proof`/`qed` | Isar semantics; proof checking; locale/typeclass resolution |
| xlsx | Document (workbook), Sheet, Cell, Range, Formula, Sign | sheet XML, shared strings, `<f>`, `<v>`, `<dimension>`, `<definedNames>`, `$` anchors, `Sheet1!A1` | macros, external links, DDE/OLE, array/spill semantics, evaluation |
| docx/pptx | Document, Book/Article (explicit metadata only), Paragraph, Statement, Formula (`omml`), Slide (P2) | Word headings/outline, paragraph styles named Definition/Lemma/Theorem/Proof, core properties, docx custom XML, `m:oMath`, comments | style-name guesses outside an allowlist; tracked changes; layout/geometry; rendering |
| EPUB/JATS/DocBook | Document, Book/Article, Part/Chapter/Section, Paragraph, Formula, Statement, Person, Venue (P1–P2) | OPF spine/manifest/metadata, EPUB `nav`, JATS `<book-meta>`/`<article-meta>`/`<sec>`, DocBook `book`/`article`/`chapter`/`section` | malformed OPF; missing metadata; full-text extraction; rendering |
| Conditions | Condition | `@requires`/`@ensures`/`@pre`/`@post`/`@invariant`; `::: condition`/`::: require`/`::: meet`; `\begin{condition}`; `\Require`/`\Ensure`; front-matter `requires:`/`meets:`; `data-kind="condition"`; Word style names | prose wording alone ("necessary", "sufficient", 前提, 条件); `assert`/`throw`; Coq `Require Import` (import graph) |
| CSV/TSV | Document (workbook), Sheet, Cell, Range | RFC 4180 quoting, header row, delimiter `,`/`\t` | **no formulas**; a leading `=` is text + `injectionRisk`; charset guessing |
| MathML | Formula (`mathml`) | `<math>`, `mi`, `mn`, `mo`, `mfrac`, `msqrt`, `msup`, `msub`, `mtable`, `apply` | external refs, annotation semantics, rendering |
| Typst/AsciiMath | Formula (`typst`/`asciimath`), P2 | `$...$`, `frac`, `mat`, `vec`, `sqrt` | evaluation, package imports, rendering; unknown commands |

### 5.1 Formula dialects

| Dialect | Delimiters / syntax | Structural extraction | Never guessed |
|---|---|---|---|
| `spreadsheet` | cell `<f>` text beginning `=`; A1, `$A$1`, `A1:B3`, `Sheet1!A1`, names, operators, strings/numbers/errors | `FormulaNode`; `computes` anchor; `references` cell/range/name; `depends` cell→cell | external `[Book]Sheet!A1` links, unknown names, 3-D refs in P1, cached values as truth |
| `tex` | `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, `equation`/`align`/`gather`/`array`/`matrix` | fraction, scripts, radical, matrix, environment, delimiter, symbol, call, label/ref | macro expansion, `\input`/`\include` content, `\write18`, package semantics |
| `markdown-math` | `$...$` inline, `$$...$$` block; escaped `\$` is text; code fences/spans excluded | generic nodes; KaTeX/MathJax subset | unknown macros, raw HTML math, rendering |
| `mathml` | `<math>` presentation/content | `mi`/`mn`/`mo`/`mfrac`/`msqrt`/`msup`/`msub`/`mtable`/`apply` | external refs, entities/DTD, annotation semantics |
| `omml` | `m:oMath` in docx/pptx | `m:f`/`m:rad`/`m:sSup`/`m:sSub`/`m:m`/runs | external refs, layout, equation options |
| `asciimath` | P2; `sqrt`, `frac`, `sum`, `int`, `matrix` | generic nodes | evaluation, unknown commands |
| `typst` | P2; `$...$`, `frac`, `mat`, `vec`, calls | generic nodes | evaluation, package imports |
| `unknown` | no declared dialect | none | everything; no parse |

### 5.2 Chain edge sources

| Source syntax | Chain relation(s) |
|---|---|
| JS/TS `import`/`export`/`require`, CSS `@import`/`url()`, HTML `script`/`link`/`img`, Markdown links/images, LaTeX `\input`/`\include`/`\includegraphics`, Lean/Coq/Isabelle imports | `imports` → projected as `depends` |
| Contract tags `@requires`/`@ensures`/`@pre`/`@post`/`@invariant` (JML/Dafny/Why3/ACSL), `::: require`/`::: meet`, `\Require`/`\Ensure`, front-matter `requires:`/`meets:` | `requires` (necessary) / `meets` (sufficient) |
| Explicit proof links (`\begin{proof}` + target, Lean `by`, Coq `Proof…Qed`, Isabelle `proof…qed`) | `proves` (host/verifier writes satisfaction) |
| Statement dependencies (`uses`, `assumes`, `supports`) | `depends` / `prerequisite` projection |
| Formula cell/range/name references | `references` → `depends` for spreadsheet cells |
| Baseline metadata (`@baseline`, `baseline:` front matter, pinned version/lockfile) | `baseline` + `baselineVersion` |
| Task/step input metadata (`blockedBy`, step input handle) | `prerequisite` |
| Verifier result / explicit evidence artifact | `satisfies` (host-only; agent claim is `unknown`) |

## 6. Storage, indexing, query APIs

Layering: `src/host/text/*` parsers, `src/host/domain.ts` store/query, `src/shared/domain.ts`
types; all inside the existing `ModuleHost`; no new DSH port in P0/P1.

| Concept | Persist? | Store / index | In-memory | Invalidation |
|---|---|---|---|---|
| Project | yes | `node`; `idx_node_path` | none | manifest fingerprint |
| Module / Document / Workbook | yes | `node` + `snapshot` | parse LRU 256 | `path+modified+size+parser` |
| Book / Part / Chapter / Article / Section / Paragraph | yes | `node`; `contains`/`part_of`; ordinal | outline `OrderedMap` | file/edition hash change |
| Person / Venue | yes | `node`; `authored_by`/`published_in` | `OrderedMap`/`Trie` | owner/metadata change |
| Sheet / Cell / Range | yes | `node`; `idx_node_sheet`; sparse rows | `SparseGrid<Cell>` LRU 4 | workbook hash change |
| Formula | yes (node); AST derived | `node`; `edge`; partial anchor index | AST LRU 2,000 / 32 MiB | owner change; formula hash |
| Statement / Proof | yes | `node`; `idx_node_statement`; statement edges | `OrderedMap`/`DirectedGraph` | owner change |
| Condition | yes | `node`; `idx_node_condition`; condition edges | `OrderedMap`/`DirectedGraph` | owner change |
| Chain / ChainLink | **derived** | none | projection LRU keyed `(root, relationSet, depth, graphVersion)` | parse/baseline/status change |
| Class / Function / Method | yes | `node`; `declares` edge | `RedBlackTree`/`Trie` per project | owner change |
| Comment / Code | yes | `node`; `comments`/`marks` edge | `OrderedMap` by target | owner change |
| Importation / Exportation | yes | `node`; `imports`/`exports` edge | `DirectedGraph`/`OrderedMap` | owner change |
| Sign | promoted only | `node`; `idx_node_owner` + span | `Trie` text + span map | owner change |
| Dependency | **derived** | none | `DirectedGraph` per project | graph cache eviction |

Formula ASTs are **not** persisted: reference + fingerprint + edges are enough. Document formulas
persist the node and `labels`/`references`/`uses` edges, but not `computes`/`depends`; spreadsheet
formulas persist references and cell-level `depends`. `snapshot` is the invalidation authority;
delete edges before nodes in one transaction, reparse, then re-resolve only reverse
importers/formulas (`O(indeg)`).

| Query API | SQL / index | Complexity |
|---|---|---|
| `projectGraph(project)` | `edge WHERE project=?` + `contains`/`imports` | O(V+E) first; O(1) cached |
| `outline(document)` | `idx_node_owner` ordered by `ordinal` | O(log n + k) |
| `bookOutline(book)` | `contains` ordered by `ordinal` | O(log n + k) |
| `articlesIn(book/venue)` | `contains`/`part_of`/`published_in` | O(log E + degree) |
| `bookOf(article/chapter)` | `idx_edge_target(target,'part_of')` | O(log E + indegree) |
| `articleSections(article)` | `contains` ordered | O(log E + degree) |
| `paragraphsOf(article/chapter)` | bounded subtree traversal | O(V+E) bounded |
| `citationGraph(project)` | `cites` edges | O(V+E); cycles legal/reported |
| `editionsOf(book)` | `idx_edge_target(target,'edition_of')` | O(log E + indegree) |
| `findSymbol(name, project)` | `idx_node_name`; `Trie` prefix | O(log n + k); O(k+m) prefix |
| `importsOf(module)` / `exportsOf(module)` | `idx_edge_source` | O(log E + degree) |
| `dependentsOf(module)` | `idx_edge_target` | O(log E + indegree) |
| `statementsIn(container)` | `idx_node_owner`/`idx_node_parent` | O(log n + k) |
| `definitionOf(symbol)` | `idx_edge_target(target,'defines')` | O(log E + indegree) |
| `proofsOf(statement)` | `idx_edge_target(target,'proves')` | O(log E + indegree) |
| `dependenciesOf(statement)` | `idx_edge_source(source,'uses'/'assumes')` | O(log E + degree) |
| `unprovedStatements(document/project)` | `idx_node_statement(project,kind,status)` | O(log n + k) |
| `axiomsOf(project)` | `idx_node_project(project,'axiom')` | O(log n + k) |
| `statementGraph(target)` | `uses`/`assumes`/`supports`/`proves`/`disproves`/`formalizes` | O(V+E) |
| `conditionsOf(target)` / `requiresOf(target)` / `meetsOf(target)` | `idx_edge_source` / `idx_edge_target` | O(log E + degree) |
| `unmetRequirements(target)` | `requires` edges + `condition.status` | O(log E + degree + k) |
| `sufficientFor(target)` / `satisfiedBy(condition)` | `meets` / `satisfies` edges | O(log E + indegree) |
| `conditionGraph(target)` | `requires`/`meets`/`satisfies`/`violates`/`entails` | O(V+E) |
| `contradictions(target)` | explicit satisfied+violated or negated pair | O(log E + degree + k) |
| `dependenciesOf(handle,depth)` / `dependentsOf(handle)` / `pathBetween` / `cycleAt` | `DirectedGraph` bounded depth ≤ 8 | O(V+E) bounded |
| `satisfiersOf` / `satisfiedBy` / `baselineOf` / `baselinesUsing` / `prerequisitesOf` / `unmetChain` / `staleDependents` | edge indexes + projection cache | O(log E + degree) or O(V+E) bounded |
| `chainProjection(root, relationSet, depth)` | cache hit O(1); miss O(V+E) bounded | O(1) / O(V+E) |
| `commentsOf(symbol)` | `idx_edge_target(target,'comments')` | O(log E + indegree) |
| `signsOf(owner)` / `signAt(owner,span)` | `idx_node_owner` / `idx_node_position` | O(log n + k) |
| `formulasIn(container)` / `formulaAt(owner,span)` | `idx_node_owner` / `idx_node_position` | O(log n + k) |
| `formulaOf(cell)` | `idx_node_formula_anchor` | O(log n) |
| `referencesOf(formula)` / `symbolsOf(formula)` | `idx_edge_source` | O(log E + degree) |
| `labelsOf(document)` | `idx_node_label(owner,'sign','label')` | O(log n + k) |
| `precedentsOf(cell)` | `idx_edge_source(cell,'depends')` + range expansion | O(log E + degree + k), k ≤ 1,024 |
| `dependentsOf(cell)` | `idx_edge_target(cell,'depends')` | O(log E + indegree) |
| `calculationOrder(sheet)` | `DirectedGraph.topologicalSort()` | O(V+E); `null` on cycle/truncation |
| `formulaGraph(workbook)` | `computes`/`references`/`depends` | O(V+E) |
| `namedRanges(sheet)` | `node kind='range' form='named'` | O(log n + k) |
| `sheetGrid(sheet)` | load `Cell` rows into `SparseGrid` | O(n log n) load; O(1) cached |
| `rowAt` / `columnAt` | `idx_node_sheet` | O(log n + k log k) |
| `resolveReference(handle)` | node row + reference validation | O(log n) |
| `readReference(handle,mode,start,end)` | line-index LRU + read caps | O(log n + k) |
| `lineToByte` / `byteToLine` | per-file line-start index | O(log n) |
| `coordination_write` / `coordination_refresh` | host tx + reparse window | O(affected + k); conflict/stale fail-closed |
| `nodesByCharset(charset)` | `idx_node_charset` | O(log n + k) |

`SparseGrid` is 0-based; `Cell.rowIndex`/`columnIndex` are 0-based, while `Cell.address` and
`Range.start`/`end` are A1/1-based. `Row`/`Column` are never persisted.

## 7. Size, limits, fail-closed

| Item | Hard cap | On overflow |
|---|---|---|
| File read / tokens / AST depth / parse time | 1 MiB / 200,000 / 256 / 2 s | `truncated=true`; parsed prefix only |
| Graph vertices / edges | 20,000 / 100,000 (import); 50,000 / 200,000 (statement) | stop; `truncated`; no transitive answer |
| Nodes / project; nodes / file | 200,000; 20,000 | stop file parse; `status='truncated'` |
| Articles / book; sections / article; paragraphs / section; citations | 512; 256; 2,000; 10,000 | `truncated`; no partial ordering/citation edge |
| Signs / module, / document, / project | 1,000; 500; 100,000 | keep first by span; `truncated` |
| Statements / document, / project; statement metadata | 5,000; 50,000; brief ≤ 300, reference target ≤ 1,024 | `truncated`; no proof/status inference |
| Conditions / target; condition AST nodes; condition graph | 256; 2,000; 50,000 / 200,000 | `truncated`; no solver/evaluator |
| Proof fragment / nested proof depth | metadata only; 32 | `truncated`; `proofStatus='unverifiable'` |
| Formulas / document, / workbook, / project | 5,000; 20,000; 50,000 | stop; `truncated`; no formula graph for overflow |
| Formula AST depth / nodes / refs | 64; 2,000; 512 | `truncated`; no AST and **no dependency edges** |
| TeX macros / expansion depth / expanded bytes | 256; 8; 2× source | `unverifiable`; no expansion |
| Sheets / workbook; rows / sheet; columns / sheet | 256; 100,000; 1,024 | `truncated`; no calculation order |
| Cells / workbook; formulas / workbook; named ranges | 200,000; 20,000; 1,000 | `truncated`; keep sparse prefix |
| Range expansion for cell edges | 1,024 cells | keep `Range` reference; `depends` incomplete; `truncated` |
| Metadata / NodeCard / brief / reference target | 4 KiB / 1 KiB / 300 chars / 1,024 chars | truncate, `truncated`; never fabricate |
| Read caps | 256 KiB / 2,000 lines / 16k tokens per read | `truncated`; explicit `nextStart` |
| xlsx zip: uncompressed / entries / ratio / XML depth | 64 MiB / 10,000 / 100:1 / 64 | reject workbook; `unverifiable` |
| Caches: parse / graph / formula AST / sheet grid | 256 files / 2 projects / 2,000 ASTs / 4 sheets | LRU eviction; 64 + 64 + 32 + 64 MiB |
| Chain projection | depth ≤ 8; links ≤ 50; ~1,500 tokens | `truncated=true`; `cycle` path; no AST/adjacency/raw text |
| Database size | 512 MiB | `InvalidStateError` on next write; reads still work |

**Security:** never execute/evaluate/render. TeX `\write18`, `\input`, `\include`, `\openout`
are not executed (input is only a file dependency); macros are not expanded; MathML/OMML
external refs, DTD/entities are ignored; xlsx macros, external links, DDE/OLE are never loaded;
zip-bomb caps apply; CSV/TSV leading `=`, `+`, `-`, `@`, tab or CR is text with
`injectionRisk=true`. References validate scheme/target: reject traversal, absolute paths outside
the workspace, `file:` credentials and `data:` bodies; target ≤ 1,024 chars; `binary`/`unknown`
never get a line range; `fingerprint`/ranges are host-computed only, and an
`expectedFingerprint` mismatch is `CONFLICT`/`stale`. A truncated statement/formula/sheet/file/
graph never yields a partial edge that could be mistaken for complete evidence; callers check
`truncated`/`status`. Cycles are reported with a cycle path; `calculationOrder`/`topologicalSort`
return `null` and the Plan must not invent an order.

## 8. Coordination integration

| Digest | Max tokens | Fields only |
|---|---|---|
| `ProjectDigest` | 200 | handle, name, manifest, module/document counts, truncated |
| `ModuleDigest` | 80 | handle, path, language, symbol/import/export counts, status |
| `SymbolDigest` | 60 | handle, kind, name, signature ≤ 120 chars, line |
| `StatementDigest` / `ProofDigest` | 120 | handle, kind, label, status, formal, line |
| `FormulaDigest` | 100 | handle, dialect, delimiter, brief ≤ 160 chars, reference, reference count, truncated |
| `ChainDigest` | 200 | root, ≤ 8 links, depth, truncated, cycle, version |
| `SubgraphView` | 1,000 | ≤ 64 entity handles, ≤ 128 edges, `omitted`, `truncated` |

```ts
interface PlanConstraint { kind: 'dependency-order' | 'formula-order' | 'statement-order' | 'condition' | 'prerequisite' | 'baseline' | 'impact'; before: Handle; after: Handle; reason: string }
interface SubgraphView { root: Handle; entity: Handle[]; edge: Array<{ kind: EdgeKind; source: Handle; target: Handle }>; omitted: number; truncated: boolean }
```

`Plan.constraint`/`SubTask.acceptance` store compact JSON `PlanConstraint`; `Evidence.source` is
`node:<handle>` and `Evidence.content` is a digest, never a file body. Plan/Answer evidence uses
only `ChainDigest`/`Chain` (read-only, bounded); the agent never receives adjacency maps, rows
or ASTs. Unproved lemmas/properties, `unprovedStatements`, every `Axiom` and unmet
`prerequisite`/`Require` become explicit Plan risks/constraints or acceptance criteria; a proof
obligation can be `SubTask.acceptance` with `groundTruth` = `proofsOf(statement)` returning a
`proves` edge. An axiom is always surfaced as an explicit assumption, never silently accepted.
Orchestration derives `blockedBy` from `topologicalSort()`; on a cycle it sets the subtask
`verdict='unverifiable'` and the parent chooses manual ordering. The verifier compares handles,
hashes and deterministic parse/graph results, never prose; `satisfies` is written only by the
verifier/host, never by the agent. `TokenGovernor` receives `ContextChunk{kind:'evidence'}` with
`score = valuePerToken` rank, where entity importance is
`0.35*centrality + 0.25*proofWeight + 0.20*recency + 0.20*explicitness` clamped to [0,1];
`tokens = estimateTokens(digest)`. Pinned chunks are only `PlanConstraint` handles and
acceptance handles. **Never in model context:** raw file bodies, full ASTs, full `FormulaNode`
trees, full statement/proof text, full sheet grids, adjacency maps, complete comment threads,
complete edge lists, absolute home paths, or cached formula values treated as truth.

## 9. Tooling / LSP / tree-sitter evaluation

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| tree-sitter native | incremental, error-tolerant, queries, many grammars [S1][S28] | native addon ABI, per-platform builds, grammar assets, DSH bundle cannot ship them safely | reject P0/P1 |
| tree-sitter WASM | portable, no native ABI | runtime + grammar payload, async init, memory, grammar drift | defer P2 behind a port |
| LSP (`DocumentSymbol`/`SymbolKind`) | precise symbols/references, standard [S2] | spawns tsserver/pyright/clangd, async, permissions, non-deterministic, heavy | optional P2 port |
| SCIP / LSIF | precise cross-repo code intelligence [S3][S4] | external indexer required, index format/version, not live | optional P2 import |
| TypeScript compiler API | precise TS symbols/imports | large runtime dependency, typechecker cost, bundle policy violation | reject |
| Hand-written tokenizer/scanner | O(n), no dependencies, matches `file-processing-v24.md` | no types, no scope resolution, literal-only specifiers | **accept P0/P1** |
| Formula/statement/condition parsers | per-dialect AST, no evaluation | grammar subsets, macro/extension gaps | **hand-written P0–P2** |

Recommendation: keep the hand-written scanner/tokenizer and the `AstTree`/`DirectedGraph`/
`SparseGrid` primitives; do not add a parser dependency. The subset is lexical: declarations,
literal specifiers, headings, delimiters, labels, styles, worksheet cells and formula tokens;
anything requiring a typechecker, macro expander, layout engine, prover or resolver is
`unverifiable`. A future `IndexPort` may ingest SCIP/LSIF or LSP symbols, disabled by default.

## 10. Phases, acceptance tests, non-goals

**P0 — structure, references, symbols, signs, statements, conditions, chain projection, prose
formulas.** JS/TS/JSX + CSS + HTML + Markdown structure; imports/exports/dependencies;
Class/Function/Method; comments; code spans; promoted Sign; TeX theorem-like environments;
explicit Markdown fenced divs and front-matter statement lists; labels/refs/proofs;
Markdown/TeX formula detection; code contract tags (`@requires`/`@ensures`/`@pre`/`@post`/
`@invariant`), `::: require`/`::: meet`, `\Require`/`\Ensure`; Require/Meet semantics and
host-only `Chain` projection. Also detect explicit Markdown front-matter
`book/article/chapter/title/author/venue/doi` and LaTeX `\documentclass{book|article}`,
`\part`/`\chapter`, `\title`/`\author`, `\begin{abstract}`; never infer Book/Article from prose.
Acceptance: fixture repo parses all four families; static/`import
type`/re-export/literal `import()`/literal `require()` produce `Importation` + `imports`;
non-literal and unresolved produce `resolution='unverifiable'` and no edge;
`outline`/`findSymbol`/`commentsOf` match counts; Markdown `$x^2$` and `$$\frac{a}{b}$$`
produce `Formula`; `\label`/`\ref` produce `labels`/`references`; explicit proof → target
`proved`; proof without target → `unverifiable`; `axiom` → `axiomatic`; require-only,
meet-only and iff fixtures distinguish `requires`/`meets`/`equivalent`; violated Require
invalidates its target; met Meet raises status only with explicit evidence; Coq `Require
Import` is an `Importation`, never a `Condition`; Book→Chapter/Article, standalone Article,
collected Article `part_of` Book and LaTeX book-vs-article fixtures pass; `Chain` projection is
≤ 8 deep/≤ 50 links/≤ 1,500 tokens, truncation explicit, cycle path reported, and contains no
AST/adjacency/raw text; reparse idempotent by `locator`; 1 MiB/200k/depth 256/2 s/20k-node caps
tested. Metadata tests: every NodeKind has metadata; no body bytes; brief missing ⇒ empty +
`unverifiable`; six flat fields agree with bytes/lines; UTF-8/UTF-8-BOM/ASCII, CRLF/LF, BOM
excluded from fragment range; insert before shifts ranges while fingerprint stable; edit inside
changes fingerprint; stale refresh; `expectedFingerprint` mismatch ⇒ `CONFLICT`; traversal
rejected; NodeCard/Chain/describe never include content.

**P1 — office, HTML/EPUB/JATS/DocBook and proof-assistant statements; sheets and cross-format
formulas.** LaTeX/Lean 4/Coq/Isabelle statement/proof/import parsing; xlsx structural parse +
CSV/TSV sheets; Sheet/Cell/Range; spreadsheet Formula AST, `computes`/`references`/`depends`,
named ranges, cycle detection; OMML/MathML extraction; Office styles/HTML semantics; EPUB
spine/OPF metadata, JATS/DocBook `book-meta`/`article-meta`/`sec`; venue/DOI/citation graph;
UTF-16/legacy charsets. Acceptance: `proofsOf(statement)` returns proofs and incomplete marks;
`calculationOrder` stable and `null` + cycle path on A1↔B1; range refs expand only under 1,024;
sheet-qualified refs resolve, external links fail closed; OMML/MathML fixtures extract
fraction/script/matrix nodes; formula caps produce `truncated` and no edges; CSV `=cmd` is text
with `injectionRisk=true`; docx style/HTML `data-kind` fixtures map only explicit markers;
EPUB spine order and citation cycle fixtures pass; `bookOf`/`articlesIn`/`citationGraph`
return deterministic results; baseline/prerequisite stale/unmet fail closed; sheet cell
byte/line ranges validated; lossy charset ⇒ bytes only + `unverifiable`.

**P2 — workspace and cross-project book/article/statement/condition/chain graph,
formal↔informal linking, editions/translations, office surfaces.** Cross-project/workspace
graph; incremental updates by fingerprint; `formalizes` linking; `edition_of`/`translates`
anthology graph; Slide/Deck minimal; Typst/AsciiMath; formula AST cache; optional external
renderer; optional SCIP/LSP `IndexPort`; cross-project `staleDependents`. Acceptance:
two-project workspace links only through declared dependencies/path aliases; a changed file
invalidates only its owner subtree plus reverse importers; `edition_of` preserves version and
marks stale; `translates` requires explicit link; citation cycles reported; 20k nodes/100k edges
build under 5 s; Slide count/title deterministic; renderer absence leaves `rendered` absent.

Non-goals: typechecking/inference, macro expansion, formula evaluation, spreadsheet
recalculation, proof checking, rendering, PDF pagination, shape/geometry extraction, code
execution, network resolution, `node_modules` traversal, binary assets, generated/minified
files, CSS cascade, LaTeX package loading, cross-language FFI, UI rendering.

## 11. Open questions (with recommended defaults)

| # | Question | Recommended default |
|---|---|---|
| 1 | Is `Workbook` a node kind or a `Document` form? | `Document.form='workbook'` + `WorkbookView`; no new kind. |
| 2 | How to represent `proposition` environments? | `kind='theorem'`, `sourceForm='proposition'`; no new NodeKind. |
| 3 | Persist paragraphs or derive them? | Persist with `brief ≤ 300` and a 20k/file cap. |
| 4 | Persist Formula ASTs? | No; text + edges persisted, AST derived and LRU-cached. |
| 5 | Persist document (TeX/Markdown) formula edges? | `labels`/`references`/`uses` only; no cell `depends` outside `spreadsheet`. |
| 6 | Expand TeX macros? | No expansion in P1; bounded local macros only in P2 if ever. |
| 7 | Evaluate spreadsheet formulas or prover files? | Never in this plugin; cached values and kernel results are untrusted until an explicit artifact exists. |
| 8 | Do dependency/formula/statement/condition cycles block a Plan? | No; report cycle, mark ordering `unverifiable`, require parent decision. |
| 9 | Are `Slide`/`Page`/`Canvas` entities? | `Slide` P2 minimal; `Page` derived render view; `Canvas` excluded. |
| 10 | Should `Sign` persist every token? | No; only promoted signs, capped; other tokens stay in `TokenStream`. |
| 11 | Is cross-project graph on by default? | No; opt-in P2 per workspace. |
| 12 | Use tree-sitter in P2? | Only behind an optional port; hand-written remains the default. |
| 13 | Are `Chain`/`ChainLink` persisted? | No; projections only, LRU-cached and invalidated on parse/baseline/status change. |
| 14 | Who may write `satisfies`/`baseline`? | Host/verifier only; agent requests, never asserts. |
| 15 | Default projection budget? | depth 8, 50 links, ~1,500 tokens; explicit `truncated` beyond that. |
| 16 | How is a standalone Article represented? | `Document(form='article')` with exactly one `Article` node; no duplicate. |
| 17 | What is the Book hierarchy? | Book → Part/Chapter/Article; Part → Chapter/Article; Section is generic inside Article/Chapter. |
| 18 | Who owns byte/line/fingerprint truth? | Host only; flat fields + raw-byte SHA-256 are authoritative; agent never supplies them. |
| 19 | Which charsets in P0? | UTF-8, UTF-8-BOM, ASCII only; legacy/UTF-16/32 later with explicit confidence. |

## Sources

| Id | Source | Kind | URL | Used for |
|---|---|---|---|---|
| S1 | Tree-sitter documentation | vendor doc | https://tree-sitter.github.io/tree-sitter/ | incremental parsing, queries, grammars |
| S2 | LSP 3.17 specification | specification | https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/ | DocumentSymbol, SymbolKind, semantic tokens |
| S3 | SCIP Code Intelligence Protocol | project doc | https://github.com/scip-code/scip | precise code intelligence |
| S4 | LSIF 0.4.0 specification | specification | https://microsoft.github.io/language-server-protocol/specifications/lsif/0.4.0/specification/ | index format prior art |
| S5 | TypeScript module resolution | vendor doc | https://www.typescriptlang.org/docs/handbook/modules/reference.html | import resolution, `paths`/`baseUrl` |
| S6 | Node.js ESM resolution | vendor doc | https://nodejs.org/api/esm.html | ESM specifiers, exports, conditions |
| S7 | Python import system | vendor doc | https://docs.python.org/3/reference/import.html | package/relative imports |
| S8 | mdast | project doc | https://github.com/syntax-tree/mdast | Markdown AST node names |
| S9 | CommonMark 0.31.2 | specification | https://spec.commonmark.org/0.31.2/ | headings, paragraphs, code, links |
| S10 | CSSOM Level 1 | specification | https://drafts.csswg.org/cssom/ | CSS rule model |
| S11 | DocBook 5.1 `chapter` | project doc | https://tdg.docbook.org/tdg/5.1/chapter.html | chapter/article/para prior art |
| S12 | DITA 1.3 Part 1 | specification | https://docs.oasis-open.org/dita/dita/v1.3/os/part1-base/dita-v1.3-os-part1-base.html | topic/concept/task prior art |
| S13 | Sphinx directives | vendor doc | https://www.sphinx-doc.org/en/master/usage/restructuredtext/directives.html | document/toctree structure |
| S14 | Theorem Proving in Lean 4 | vendor doc | https://lean-lang.org/theorem_proving_in_lean4/ | `def`/`theorem`/`by` |
| S15 | Coq/Rocq reference manual | vendor doc | https://docs.rocq-prover.org/ | `Definition`/`Proof`/`Qed`/`Admitted` |
| S16 | Isabelle/Isar reference manual | vendor doc | https://isabelle.in.tum.de/doc/isar-ref.pdf | `definition`/`lemma`/`theorem`/`proof` |
| S17 | amsthm | package doc | https://www.ctan.org/pkg/amsthm | `\newtheorem`, theorem environments |
| S18 | Pandoc fenced divs | vendor doc | https://pandoc.org/MANUAL.html#fenced-divs | `::: definition` Markdown statements |
| S19 | HTML: the `dfn` element and sectioning | specification | https://html.spec.whatwg.org/multipage/grouping-content.html#the-dfn-element | `<dfn>`, `<section>`, semantics |
| S20 | MathML 3.0 | specification | https://www.w3.org/TR/MathML3/ | `math`, `mfrac`, `msqrt`, `mtable` |
| S21 | KaTeX supported functions | vendor doc | https://katex.org/docs/supported.html | TeX math subset |
| S22 | Typst math reference | vendor doc | https://typst.app/docs/reference/math/ | `$...$`, `frac`, `mat` |
| S23 | ECMA-376 (Office Open XML) | specification | https://ecma-international.org/publications-and-standards/standards/ecma-376/ | xlsx/OMML/OPC packaging, docx styles |
| S24 | RFC 4180 (CSV) | specification | https://www.rfc-editor.org/rfc/rfc4180.html | CSV parsing |
| S25 | Overview of formulas in Excel | vendor doc | https://support.microsoft.com/en-us/excel/get-started/overview-of-formulas-in-excel | A1 refs, `$`, ranges, operators |
| S26 | OWASP CSV injection | security guidance | https://owasp.org/www-community/attacks/CSV_Injection | formula injection |
| S27 | Spreadsheet dependent-cell recomputation | paper | https://arxiv.org/abs/cs/0301036 | dependency recomputation graph |
| S28 | Tree-sitter incremental parsing paper | paper | https://harmonia.cs.berkeley.edu/papers/twagner-parsing.pdf | incremental parsing research |
| S29 | ECMAScript lexical grammar | specification | https://tc39.es/ecma262/#sec-ecmascript-language-lexical-grammar | keyword/token distinction |
| S30 | TSDoc | vendor doc | https://tsdoc.org/ | doc-comment tags for attachment |
| S31 | PEP 257 | specification | https://peps.python.org/pep-0257/ | Python docstrings for attachment |
| S32 | W3C PROV-O | specification | https://www.w3.org/TR/prov-o/ | provenance/chain model |
| S33 | Semantic Versioning | specification | https://semver.org/ | baseline version semantics |
| S34 | Design by Contract (Meyer) | paper | https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf | require/ensure/invariant semantics |
| S35 | JML, Dafny, Why3, ACSL | vendor docs | https://www.openjml.org/ · https://dafny.org/ · https://www.why3.org/ · https://frama-c.com/acsl.html | contract tag conventions |
| S36 | Coq `Require` reference | vendor doc | https://docs.rocq-prover.org/V8.20/refman/language/core/modules.html | `Require Import` disambiguation |
| S37 | EPUB 3.3 | specification | https://www.w3.org/TR/epub-33/ | OPF spine/manifest, EPUB metadata |
| S38 | JATS | specification | https://jats.nlm.nih.gov/ | `book-meta`/`article-meta`/`sec` |
| S39 | LaTeX document structure | community wiki | https://en.wikibooks.org/wiki/LaTeX/Document_Structure | `book`/`article`, `\part`/`\chapter` |
| S40 | Pandoc metadata blocks | vendor doc | https://pandoc.org/MANUAL.html#metadata-blocks | front-matter book/article/venue/doi |
| S41 | WHATWG Encoding Standard | specification | https://encoding.spec.whatwg.org/ | charset labels/decoding |
| S42 | Unicode BOM FAQ | vendor doc | https://www.unicode.org/faq/utf_bom.html | BOM detection/precedence |
| S43 | RFC 3629 (UTF-8) | specification | https://www.rfc-editor.org/rfc/rfc3629 | UTF-8 validity/byte semantics |
| S44 | RFC 3986 / RFC 6901 | specification | https://www.rfc-editor.org/rfc/rfc3986 · https://www.rfc-editor.org/rfc/rfc6901 | URI/IRI and JSON Pointer locators |
| S45 | OWASP path traversal | security guidance | https://owasp.org/www-community/attacks/Path_Traversal | reference path validation |
| S46 | OpenAPI / schema.org metadata | specification | https://spec.openapis.org/oas/latest.html · https://schema.org/name | summary/description/name conventions |
