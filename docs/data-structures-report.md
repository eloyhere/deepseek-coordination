# Shared data structures — phase 1 contract

Generated from the code in `src/shared/` (not aspiration). Every class is pure ES2022,
deterministic, and free of Node/DOM/React/external imports. Only `./error.js` and sibling
files in this folder are imported. The later parser/audit agent should treat signatures,
order and complexity below as the contract; `npm test` and `tsc -p tsconfig.json` are green.

## 1. Files and guarantees

| File | Exports |
|---|---|
| `src/shared/hash.ts` | `hashString`, `hashNumber`, `hashCombine`, `stableHash`, `normaliseCapacity`, `HashLruList`, `HashWeakLruList` |
| `src/shared/node.ts` | `LinearNode`, `BinaryNode`, `SkipNode` |
| `src/shared/tree.ts` | `Comparator`, `defaultComparator`, `compareValues`, `BinaryTree`, `BPlusTree` |
| `src/shared/redblack.ts` | `RedBlackTree`, `RedBlackSet` |
| `src/shared/heap.ts` | `BinaryHeap`, `IndexedHeap` |
| `src/shared/stack.ts` | `Deque`, `Stack`, `Queue` |
| `src/shared/map.ts` | `OrderedMap`, `UnorderedMap` |
| `src/shared/list.ts` | `OrderedSkipList`, `UnorderedSkipList` |
| `src/shared/set.ts` | `OrderedSet`, `UnorderedSet`, `OrderedSkipSet`, `UnorderedSkipSet` |
| `src/shared/lru.ts` | `LruList`, `WeakLruList`, `OrderedLruSet`, `UnorderedLruSet`, `OrderedLruList`, `UnorderedLruList` |
| `src/shared/ast.ts` | `SourceSpan`, `TokenKind`, `Token`, `AstJson`, `AstVisitor`, `mergeSpans`, `AstNode`, `AstTree`, `visitAst`, `TokenStream`, `AstIndex` |
| `src/shared/graph.ts` | `DirectedGraph` |
| `src/shared/trie.ts` | `Trie`, `assertTrieKey` |
| `src/shared/grid.ts` | `GridRange`, `GridCell`, `SparseGridOptions`, `SparseGrid` |

Conventions: full-English identifiers, PascalCase classes, camelCase members, no `_`.
Invalid arguments throw `InvalidArgumentError` from `./error.js`; internal invariant guards
throw `InvalidStateError`. Comparators must return finite numbers or the collection throws.
Capacity is an integer clamped to 1..100000 (`normaliseCapacity`); non-integers throw.
Every collection has `size`, `clear`, `toArray`, and `[Symbol.iterator]`; iteration order is
documented below. Mutating during iteration is unspecified everywhere.

## 2. Structure reference

### Hash functions — `hash.ts`
`hashString(value: string): number` FNV-1a over UTF-16 code units, O(n)/O(1), no allocation.
`hashNumber(value: number): number` IEEE-754 bit mix; NaN collapses, `-0 === 0`, O(1).
`hashCombine(left, right): number` order-sensitive mix, O(1). `stableHash(value: unknown): number`
structural hash of primitives/arrays/plain objects (sorted keys)/Date/Map/Set, depth cap 6,
cycle-safe via seen set, O(size); symbols hash by description, functions by name, prototypes
and non-enumerables ignored. `normaliseCapacity(number): number` clamps 1..100000, throws on
non-integer. Example: `const bucket = hashString(key) % 64; const id = stableHash({ kind, text })`.

### HashLruList<K, V> — `hash.ts`
`constructor(capacity = 64)`. `size: number`, `capacity: number`, `tombstoneCount: number`,
`get(K): V | undefined` (promotes), `peek(K): V | undefined` (does not), `touch(K): boolean`,
`set(K, V): this` (promotes; evicts LRU over capacity), `delete(K): boolean`, `has(K): boolean`,
`resize(number): void`, `clear(): void`, `keys()/values()/entries()`, `toArray(): [K,V][]`,
iterator. Order: most-recent → least-recent. Duplicate keys update in place and promote.
O(1) amortized per operation, O(capacity) space; compaction rebuilds the array when tombstones
exceed half, amortized constant. Failures: non-integer capacity. Example:
`const cache = new HashLruList<string, number>(128); cache.set('a', 1); cache.get('a')`.

### HashWeakLruList<K extends object, V> — `hash.ts`
Same methods as `HashLruList`, plus GC awareness. Keys via `WeakRef`, values strong;
`FinalizationRegistry` registered when available. `size` is O(n) because it sweeps dead refs;
keyed ops O(1) amortized; iteration skips dead keys. GC timing is not deterministic, so a dead
entry may occupy capacity until the next sweep/finalizer; strings/numbers are rejected by the
`K extends object` type. Example: `const weak = new HashWeakLruList<object, string>(8); weak.set(node, 'x')`.

### LinearNode<T> / BinaryNode<T> / SkipNode<K, V> — `node.ts`
`LinearNode(value, previous?, next?)` with mutable `value/previous/next`. `BinaryNode(value, parent?)`
with `value/left/right/parent`. `SkipNode(key, value, level)` with readonly `key`, mutable `value`,
readonly `next: Array<SkipNode|undefined>` of length `level` (integer 1..1024, else
`InvalidArgumentError`). All O(1) except `SkipNode` O(level). Example:
`const node = new BinaryNode(1); node.left = new BinaryNode(0, node)`.

### BinaryTree<T> — `tree.ts`
`constructor(comparator = defaultComparator)`. `size`, `height` (0 empty, 1 single node),
`insert(T): boolean`, `search(T): T|undefined`, `has(T): boolean`, `delete(T): boolean`,
`min()/max(): T|undefined`, `inOrder()/preOrder()/postOrder(): IterableIterator<T>`,
`toArray(): T[]` (sorted), iterator, `clear()`. Ascending order; duplicates rejected.
O(h) worst O(n) per operation (unbalanced), O(n) space; traversals iterative.
Example: `const tree = new BinaryTree<number>(); tree.insert(3); tree.delete(2)`.

### BPlusTree<K, V> — `tree.ts`
`constructor(order = 32, comparator = defaultComparator)`; `order` clamped 3..64, max leaf keys
`order - 1`, leaves linked. `order: number`, `size`, `get(K): V|undefined`, `has(K): boolean`,
`set(K, V): boolean` (false = replaced existing), `delete(K): boolean`, `clear()`,
`range(low?, high?): IterableIterator<[K,V]>` inclusive, `keys()/values()/entries()`,
`toArray(): [K,V][]`, iterator. Ascending; no duplicate keys. get/has/set O(log n) comparisons
with O(m) node copies on split; delete O(log² n) comparisons/copies (borrow/merge, no rebuild);
range O(log n + k). Space O(n). Failures: non-integer order, non-finite comparator.
Example: `const index = new BPlusTree<string, number>(8); index.set('b', 2); [...index.range('a','c')]`.

### RedBlackTree<K, V> / RedBlackSet<T> — `redblack.ts`
Tree: `constructor(comparator?)`; `set(K,V): boolean`, `get`, `has`, `delete`, `min()/max(): K|undefined`,
`successor(K)/predecessor(K): K|undefined` (strict), `range(low?, high?)`, `keys/values/entries`,
`toArray`, iterator, `validate(): boolean`, `size`, `height`, `blackHeight`, `clear`.
Set: `constructor(comparator?, values?)`; `add(T): boolean`, `delete`, `has`, `first()/last()`,
`range`, `values(low?, high?)`, `toArray`, iterator, `size`, `height`, `clear`.
Ascending; duplicates rejected. All O(log n) worst case, O(n) space; range O(log n + k);
validation O(n) checks root-black/red-red/black-height/BST/parent. Example:
`const set = new RedBlackSet<number>(); set.add(2); [...set.range(1, 2)]`.

### BinaryHeap<T> / IndexedHeap<T> — `heap.ts`
`constructor(comparator = defaultComparator, values?)`; comparator orders smallest first.
BinaryHeap: `push(T): this`, `pop(): T|undefined`, `peek`, `size`, `clear`, `toArray`, iterator
in heap order (not sorted). O(log n) push/pop, O(n) build, O(n) space; duplicates allowed.
IndexedHeap: identity-keyed (`Map<T, index>`, SameValueZero), duplicates rejected;
`push(T): boolean`, `pop`, `peek`, `has`, `remove(T): boolean`, `update(T): boolean`
(re-sift both ways), `decreaseKey(T): boolean` (sift up only), `toArray` (heap order).
O(log n) all mutations, O(n) space. Failures: duplicate constructor values, non-finite comparator.
Example: `const heap = new IndexedHeap<Item>((a,b) => a.rank - b.rank); heap.push(item); heap.update(item)`.

### Deque<T> / Stack<T> / Queue<T> — `stack.ts`
Deque ring buffer: `push/unshift: this`, `pop/shift: T|undefined`, `at(index): T|undefined`
(0 = front), `size`, `toArray` front→back, iterator, `clear`; O(1) amortized, O(n) space with
≤4x slack. Stack: `constructor(maxDepth?)`, `push: this` (drops oldest over cap), `pop`,
`peek`, `at(depthFromTop)`, `toArray` top→bottom, iterator, `clear`; maxDepth positive integer.
Queue: `enqueue: this`, `dequeue`, `peek`, FIFO. Index errors throw `InvalidArgumentError`.
Examples: `const stack = new Stack<number>(100); stack.push(1); stack.pop()` /
`const queue = new Queue<string>(); queue.enqueue('a'); queue.dequeue()`.

### AST layer — `ast.ts`
`SourceSpan {start,end,line,column}` half-open, 1-based line/column; `mergeSpans(left,right)`
O(1), throws if out of order. `TokenKind` union, `Token {kind,text,span}`.
`AstNode<K>`: `constructor(kind, span, value?)`; `kind`, mutable `span`, `value?`, `parent?`,
`children`; `addChild(child): void` (rejects duplicate/foreign/cyclic, O(depth+children)),
`removeChild(child): boolean`, `walk()/descendants()` (pre-order), `find(predicate)`,
`findAll(predicate)`, `ancestors()`, `depth`. `AstTree<K>`: `constructor(root?)`, `root`,
`walk`, `findAll`, `toArray`, `size`, `toJSON(): AstJson|undefined`, `validate(): boolean`
(single root, acyclic, parent links, nested spans), `clear`. `visitAst(tree, visitor)` iterative
enter/leave. All O(n) walks, no recursion. Example:
`const root = new AstNode('Program', span); root.addChild(new AstNode('Identifier', inner, 'x'))`.

### TokenStream / AstIndex — `ast.ts`
TokenStream: `constructor(tokens: Token[])` copies input; `size`, `position`, `eof`,
`peek(offset?): Token|undefined`, `next(): Token|undefined`, `expect(kind, text?): Token`,
`save(): number`, `restore(position): void`; O(1) each, O(n) space; mismatch/out-of-range throws.
AstIndex: `constructor(tree)` snapshots O(n log n); `ofKind(K): AstNode[]`, `startingAt(number):
AstNode[]` (O(1)+copy), `smallestContaining(offset): AstNode|undefined` (O(log n) typical,
O(n) worst), `kinds()`, `size`. Uses `OrderedMap` buckets. Example:
`const stream = new TokenStream(tokens); stream.expect('keyword', 'import')` and
`new AstIndex(tree).ofKind('Identifier')`.

### DirectedGraph<T> — `graph.ts`
`constructor(vertices?, edges?)`; `addVertex(T): boolean`, `addEdge(T,T): boolean` (auto-creates
endpoints), `removeEdge`, `removeVertex`, `hasEdge`, `hasVertex`, `neighbors/predecessors(T):
IterableIterator<T>`, `outDegree/inDegree(T): number`, `vertices()`, `edges(): IterableIterator<[T,T]>`,
`size/vertexCount/edgeCount`, `toArray`, iterator, `clear`, `topologicalSort(): T[]|null` (Kahn,
deterministic, null on cycle), `findCycle(): T[]|null` (iterative DFS; `[a,b,c]` means a→b→c→a),
`reachable(T): T[]`, `bfs(T): T[]`, `shortestPath(T,T): T[]|null`, `dependencyLevels():
Map<T,number>|null`. All traversals O(V+E)/O(V); adjacency O(1) average; edges stored twice.
Self-loops allowed and reported as cycles. Example:
`const g = new DirectedGraph<string>(); g.addEdge('entry', './y'); g.topologicalSort()`.

### Trie<V> — `trie.ts`
`constructor(entries?)`; `insert(key,value): boolean` (false = updated), `get`, `has`,
`startsWith(prefix): boolean`, `keysWithPrefix(prefix): string[]`,
`entriesWithPrefix(prefix): [string,V][]`, `delete(key): boolean` (prunes), `size`, `clear`,
`toArray(): [string,V][]`, iterator. O(k) per key op, O(k+m) prefix emit, O(total chars) space.
Prefix output is child-insertion order, **not** lexicographic. Empty string is a legal key.
`assertTrieKey(key: unknown)` asserts string for untyped JSON input. Example:
`const trie = new Trie<number>(); trie.insert('src/host', 1); trie.keysWithPrefix('src/')`.

### OrderedMap<K, V> / UnorderedMap<K, V> — `map.ts`
OrderedMap: `constructor(entries?)`; `get`, `set: this`, `delete`, `deleteFirst/deleteLast:
boolean`, `has`, `first()/last(): V|undefined`, `firstKey()/lastKey(): K|undefined`, `size`,
`keys/values/entries`, `toArray`, iterator, `clear`. Insertion order; updating keeps position.
O(1) average all ops, O(n) space (Map + linked list). UnorderedMap: same core without end
access/order promise; native Map semantics. Neither throws for missing keys. Example:
`const map = new OrderedMap<string, number>([['a', 1]]); map.deleteFirst()`.

### OrderedSkipList<T> / UnorderedSkipList<T> — `list.ts`
Ordered: `constructor(comparator?, seed = 0x9e3779b9)`; `insert(T): void`, `delete(T): boolean`
(one occurrence), `has`, `first()/last(): T|undefined`, `range(low?, high?)`,
`toArray`, `entries`, iterator, `size`, `clear`. Ascending, duplicates allowed.
Expected O(log n) ops (worst O(n) if towers degenerate), O(n) space; level cap 24; seeded
xorshift32 makes the level sequence reproducible; non-finite comparator throws.
Unordered: `constructor(seed?)`; same insert/delete/has/size/clear/toArray/iterator but
ordered by `(stableHash(value), insertion serial)` and backed by a hash bucket index;
`has` O(1+bucket) average, O(n) worst collisions; insert/delete O(log n + hash cost); no order
promise. Examples: `new OrderedSkipList<number>().insert(3)` /
`new UnorderedSkipList<string>().insert('a')`.

### Set wrappers — `set.ts`
`OrderedSet<T>(values?)` and `UnorderedSet<T>(values?)`: `add(T): boolean` (false = present),
`delete`, `has`, `size`, `clear`, `toArray`, iterator; OrderedSet also `first/last`. O(1) average.
`OrderedSkipSet<T>(comparator?, seed?)`: sorted `add/delete/has`, `first/last`, `range`,
`toArray`, iterator; expected O(log n), duplicates rejected. `UnorderedSkipSet<T>(seed?)`:
hash-ordered `add/delete/has`, no ordering promise; O(1) average has. All reject duplicates.
Example: `const set = new OrderedSet<string>(); set.add('x'); set.add('x') === false`.

### LruList / WeakLruList — `lru.ts`
`LruList<K,V>(capacity = 64)`: `get` promotes, `peek`/`has` do not, `touch(K): boolean`,
`set: this`, `delete`, `size`, `capacity`, `resize`, `clear`, `keys/values/entries`
(most-recent first), `toArray`, iterator. `WeakLruList<K extends object,V>` mirrors it with
WeakRef semantics and O(n) `size` sweep. Delegates to the hash LRUs (one implementation).
Example: `const lru = new LruList<string, number>(50); lru.set('a', 1); lru.touch('a')`.

### LRU sets and lists — `lru.ts`
`OrderedLruSet<T>(capacity)`: `add(T): boolean`, `has`, `touch`, `delete`, `size`, `capacity`,
`resize`, `clear`, `toArray`, iterator; iteration LRU→MRU; add/touch refresh; O(1) average.
`UnorderedLruSet<T>`: same API/semantics, no order promise.
`OrderedLruList<T>(capacity)`: `push: this`, `get(index): T|undefined`, `peek(index)`,
`touch(index): void`, `shift(): T|undefined`, `size/capacity/resize/clear`, `toArray`/iterator
oldest→newest; duplicates allowed; invalid index throws. `UnorderedLruList<T>`:
`push`, `peek(): T|undefined` (next eviction candidate), `touch(value): boolean` (O(n)),
`size/capacity/resize/clear`, `toArray`/iterator, no index access, no order promise.
All evict exactly to capacity (1..100000). Example:
`const list = new OrderedLruList<string>(3); list.push('a'); list.touch(0)`.

### GridRange / SparseGrid<T> — `grid.ts`
`GridRange(top,left,bottom,right)` with readonly corners, `rows`, `columns`,
`contains(row,column): boolean`, `normalise(): GridRange`, `toJSON()`; constructor rejects
non-safe-integer corners, inverted corners are legal until normalised.
`SparseGrid<T>(options?)` (`maximumRow`/`maximumColumn`/`maximumCell`, defaults 1e6/1e6/1e6):
`set(row,column,value): this`, `get`, `has`, `delete`, `size`, `clear`,
`rowAt(row): GridCell[]`, `columnAt(column): GridCell[]`, `range(range): GridCell[]`,
`bounds(): GridRange|undefined`, `toArray()`, iterator (row-major, columns ascending), with
`rowLimit/columnLimit/cellLimit`. O(1) cell access; row/column projections O(k log k); range
O(r + R + k log k) where r is occupied rows in the whole sheet and R occupied cells in the
spanned rows (empty coordinate gaps are never iterated); bounds O(n); no dense allocation even
at coordinate 1,000,000. Out-of-bounds coordinates and cell-cap overflow throw; range clamps
inverted/out-of-sheet bounds. Example:
`const sheet = new SparseGrid<string>(); sheet.set(2, 3, 'x'); sheet.range(new GridRange(0,0,10,10))`.

## 3. Where to adopt (current hotspots)

| Hotspot | Current shape | Adopt |
|---|---|---|
| `src/host/coordination.ts:73` `dshTurns` | unbounded `Map<string, TurnSlot>` | `LruList<string, TurnSlot>` (cap active sessions) |
| `src/host/coordination.ts:76` `compactionState` | `Map<string, {lastAt,count}>` | `HashLruList` or `LruList` |
| `src/host/takeover-gate.ts:91` `pending` | `Map<string, PendingEntry>` with manual delete | `OrderedMap` (oldest-first cleanup) or `LruList` |
| `src/host/provider.ts:139` catalog `cache` | TTL `Map<string, ModelCacheEntry>` | `LruList` + TTL check in `cached()` |
| `src/host/cache.ts:88` `efforts` | `Map<number, string>` | `HashLruList<number, string>` |
| `src/host/token.ts:1014` module `memo` | `Map<string, MemoEntry>` capped manually at 256 | `HashLruList` (same cap, documented eviction) |
| `src/host/resource.ts:238` `baseEdges` | `Map<number, number>` | `OrderedMap` if order matters, else keep native |
| `src/client/controls.ts:689` `stateCache` | unbounded `Map<string, SelectionState>` | `LruList` (cap sessions) |
| `src/client/controls.ts:504` `widthCache` | unbounded `Map<number, ...>` | `LruList` (cap widths) |
| `src/host/token.ts` `selectContext` | ephemeral `Set<string>` dedupe keys | `OrderedSet<string>` for deterministic dedupe |
| `src/host/plan.ts` score/dimension ordering; `src/host/bayesian.ts` routes/evidence | arrays sorted ad hoc | `RedBlackTree`/`BPlusTree` for ranges, `BinaryHeap` for ranking |
| `src/host/orchestration.ts` subtask dependencies/recovery | status sets + manual checks | `DirectedGraph` for deps/topo/cycles/levels |
| phase-2 text/import parser (`src/host/`) | none yet | `TokenStream`, `AstTree`/`AstNode`, `visitAst`, `AstIndex` |
| phase-2 import graph | none yet | `DirectedGraph`, `Trie` for path prefixes, `LruList` parser cache |
| future sheet-like UI surface | none yet | `SparseGrid` + `GridRange` |

## 4. Do not use

- `BinaryTree` for large sorted indexes or deletion-heavy data: O(n) degenerate. Use `RedBlackTree` or `BPlusTree`.
- `UnorderedSkipList` / `UnorderedSkipSet` when order matters; hash order is deterministic but not sorted.
- `WeakLruList` / `HashWeakLruList` with strings, numbers or frozen primitives (`K extends object` only).
- Weak LRUs where capacity must be exact at a given instant: GC timing is not deterministic; `size` sweeps.
- `BPlusTree.delete` where strict O(log n) worst-case comparisons are required: separator refresh costs O(log² n) (no rebuild).
- `BinaryHeap.toArray()` / iteration as sorted output: it is heap order; pop repeatedly instead.
- `UnorderedMap`, `UnorderedLruSet`, `UnorderedLruList` when a stable order is part of the contract.
- `Trie.keysWithPrefix` when lexicographic output is required: it is child-insertion order.
- `SparseGrid.range` on grids with very many occupied rows but tiny ranges: the row index is an unsorted Map and filters all occupied rows.
- Mutable objects as keys after insertion in hash/sorted structures: changing a hash key's fields or a comparator key breaks lookups.
- `normaliseCapacity` when an exact capacity is required: it clamps silently to 1..100000.

## 5. Verified complexity/perf and tests

Measured on the local Node 24 run (`npm test`, `.tmp/test-build`):

| Check | Result |
|---|---|
| full suite | 324 tests, 323 pass, 1 skipped (`--expose-gc` GC assertion), 0 fail, ~1.6 s |
| `data-structures.test.ts` | 52 tests: 51 pass + 1 GC skip; 52/52 pass with `node --expose-gc` |
| `data-structures-ast.test.ts` | 9 tests, 9 pass |
| B+ tree, 10k sequential inserts (order 8) | 8.3 ms (guard 2 s) |
| B+ tree, 10k random inserts (order 4) | 9.8 ms |
| Ordered skip list, 10k inserts | 6.4 ms (guard 2 s) |
| Red-black, 10k random set/delete + periodic `validate()` | 13.5 ms |
| SparseGrid, 10k cells + projections | 5.1 ms |
| `hashString`, 100k calls | 4.3 ms (guard 2 s) |

Intentional tradeoffs already encoded in code comments: B+ delete borrow/merge plus exact
separator refresh (no full rebuild); array-LRU tombstones compacted at >50%; weak LRU finalizer
is best-effort; skip levels use a per-instance seeded xorshift; `AstIndex` start-offset search
is O(log n) typical / O(n) worst; `SparseGrid` has no sorted row tree.
