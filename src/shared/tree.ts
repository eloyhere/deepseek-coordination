/**
 * Ordered trees: an unbalanced binary search tree for small in-memory sets and a
 * real B+ tree for large sorted maps.
 *
 * Neither tree touches Node, the DOM or React. Both take a comparator, reject a
 * non-finite comparator result with `InvalidArgumentError`, and never return a
 * value in an implementation-defined order.
 *
 * The companion types `Comparator`, `defaultComparator` and `compareValues` are
 * exported here because they are the shared ordering contract for the trees,
 * the skip lists in `./list.js`, the skip sets in `./set.js`, and the red-black
 * tree in `./redblack.js`.
 */
import { InvalidArgumentError, InvalidStateError } from './error.js'
import { BinaryNode } from './node.js'

/**
 * Three-way ordering function: negative when `left < right`, zero when equal,
 * positive when `left > right`. It must be a total order and must never return
 * `NaN`; a non-finite result is rejected by the collections in this library.
 */
export type Comparator<T> = (left: T, right: T) => number

/**
 * Order numbers, strings, bigints and dates with the natural `<` operators.
 *
 * Time O(1), space O(1). Throws `InvalidArgumentError` for `NaN`, for mixed
 * types, and for any value without a natural order (objects, arrays, symbols),
 * telling the caller to supply a comparator instead of guessing. `-0` and `0`
 * compare equal, matching `===`.
 */
export function defaultComparator<T>(left: T, right: T): number {
  if (left === right) return 0
  if (typeof left === 'number' && typeof right === 'number') {
    if (Number.isNaN(left) || Number.isNaN(right)) {
      throw new InvalidArgumentError('the natural comparator cannot order NaN')
    }
    return left < right ? -1 : 1
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : 1
  }
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    return left < right ? -1 : 1
  }
  if (left instanceof Date && right instanceof Date) {
    const leftTime = left.getTime()
    const rightTime = right.getTime()
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
      throw new InvalidArgumentError('the natural comparator cannot order an invalid Date')
    }
    return leftTime < rightTime ? -1 : 1
  }
  throw new InvalidArgumentError(
    'a comparator is required to order values that are not numbers, strings, bigints or dates',
    { left: typeof left, right: typeof right },
  )
}

/**
 * Run a comparator and reject a non-finite result.
 *
 * Time O(1), space O(1). A comparator that returns `NaN` or `±Infinity` would
 * corrupt every ordering in this library, so it fails loudly instead. The
 * thrown error is `InvalidArgumentError`.
 */
export function compareValues<T>(comparator: Comparator<T>, left: T, right: T): number {
  const result = comparator(left, right)
  if (!Number.isFinite(result)) {
    throw new InvalidArgumentError('comparator must return a finite number', { result })
  }
  return result
}

/**
 * An unbalanced binary search tree.
 *
 * Insert, search, delete and membership are O(h) time in the tree height and
 * O(1) space each, where h is O(log n) only for lucky insertion orders and O(n)
 * worst case (for example inserting keys in sorted order). Traversals and
 * `toArray` are O(n) time; the iterative walks use O(h) stack space. `min`,
 * `max` and the end of both traversal walks are O(h). Total space O(n).
 *
 * Duplicate values are rejected: `insert` returns false and leaves the tree
 * unchanged. `delete` replaces a two-child node with its in-order successor and
 * rethreads parents, so the tree stays a valid search tree even at its worst
 * height. Iteration is in-order (ascending).
 */
export class BinaryTree<T> implements Iterable<T> {
  private readonly comparator: Comparator<T>
  private root: BinaryNode<T> | undefined
  private count = 0

  /**
   * @param comparator Total order over `T`; defaults to the natural order.
   * Time O(1), space O(1).
   */
  constructor(comparator: Comparator<T> = defaultComparator) {
    this.comparator = comparator
  }

  /** Number of stored values. Time O(1). */
  get size(): number {
    return this.count
  }

  /**
   * Tree height: 0 for an empty tree, 1 for a single node.
   * Time O(n), space O(h) for the explicit stack.
   */
  get height(): number {
    if (this.root === undefined) return 0
    let maximum = 0
    const nodes: Array<BinaryNode<T>> = [this.root]
    const depths: number[] = [1]
    while (nodes.length > 0) {
      const node = nodes.pop()
      const depth = depths.pop()
      if (node === undefined || depth === undefined) continue
      if (depth > maximum) maximum = depth
      if (node.left !== undefined) {
        nodes.push(node.left)
        depths.push(depth + 1)
      }
      if (node.right !== undefined) {
        nodes.push(node.right)
        depths.push(depth + 1)
      }
    }
    return maximum
  }

  /**
   * Insert a value unless an equal value already exists.
   * Time O(h), worst O(n); space O(1). Returns true when a node was added.
   */
  insert(value: T): boolean {
    if (this.root === undefined) {
      this.root = new BinaryNode(value)
      this.count = 1
      return true
    }
    let current = this.root
    while (true) {
      const comparison = this.compare(value, current.value)
      if (comparison === 0) return false
      if (comparison < 0) {
        if (current.left === undefined) {
          current.left = new BinaryNode(value, current)
          this.count += 1
          return true
        }
        current = current.left
      } else {
        if (current.right === undefined) {
          current.right = new BinaryNode(value, current)
          this.count += 1
          return true
        }
        current = current.right
      }
    }
  }

  /**
   * Find the stored value equal to `value`, returning the stored instance (which
   * may carry identity a comparator considers equivalent).
   * Time O(h), worst O(n); space O(1).
   */
  search(value: T): T | undefined {
    const node = this.findNode(value)
    return node?.value
  }

  /**
   * Membership test. Time O(h), worst O(n); space O(1).
   */
  has(value: T): boolean {
    return this.findNode(value) !== undefined
  }

  /**
   * Remove the node equal to `value`, if present.
   * Time O(h), worst O(n); space O(1). Returns false when absent.
   */
  delete(value: T): boolean {
    const node = this.findNode(value)
    if (node === undefined) return false
    this.deleteNode(node)
    this.count -= 1
    return true
  }

  /**
   * Smallest stored value, or `undefined` when empty.
   * Time O(h), worst O(n); space O(1).
   */
  min(): T | undefined {
    return this.root === undefined ? undefined : this.minimumNode(this.root).value
  }

  /**
   * Largest stored value, or `undefined` when empty.
   * Time O(h), worst O(n); space O(1).
   */
  max(): T | undefined {
    return this.root === undefined ? undefined : this.maximumNode(this.root).value
  }

  /** Remove every value. Time O(1) for the root, O(n) for reclamation. */
  clear(): void {
    this.root = undefined
    this.count = 0
  }

  /**
   * Ascending in-order traversal. Time O(n) for a full walk, O(h) space for the
   * explicit stack; no recursion, so even a degenerate tree cannot overflow the
   * JavaScript call stack.
   */
  *inOrder(): IterableIterator<T> {
    const stack: Array<BinaryNode<T>> = []
    let current = this.root
    while (current !== undefined || stack.length > 0) {
      while (current !== undefined) {
        stack.push(current)
        current = current.left
      }
      const node = stack.pop()
      if (node === undefined) continue
      yield node.value
      current = node.right
    }
  }

  /**
   * Pre-order (node, left, right) traversal.
   * Time O(n), space O(h); iterative.
   */
  *preOrder(): IterableIterator<T> {
    const stack: Array<BinaryNode<T>> = []
    if (this.root !== undefined) stack.push(this.root)
    while (stack.length > 0) {
      const node = stack.pop()
      if (node === undefined) continue
      yield node.value
      if (node.right !== undefined) stack.push(node.right)
      if (node.left !== undefined) stack.push(node.left)
    }
  }

  /**
   * Post-order (left, right, node) traversal.
   * Time O(n), space O(n) for the two explicit stacks; iterative.
   */
  *postOrder(): IterableIterator<T> {
    const nodes: Array<BinaryNode<T>> = []
    const reversed: Array<BinaryNode<T>> = []
    if (this.root !== undefined) nodes.push(this.root)
    while (nodes.length > 0) {
      const node = nodes.pop()
      if (node === undefined) continue
      reversed.push(node)
      if (node.left !== undefined) nodes.push(node.left)
      if (node.right !== undefined) nodes.push(node.right)
    }
    while (reversed.length > 0) {
      const node = reversed.pop()
      if (node !== undefined) yield node.value
    }
  }

  /**
   * Snapshot in ascending order. Time O(n), space O(n).
   */
  toArray(): T[] {
    return [...this.inOrder()]
  }

  /** Alias of `inOrder`, so the tree is directly iterable. Time O(n). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.inOrder()
  }

  /** Compare two values through the configurable comparator. */
  private compare(left: T, right: T): number {
    return compareValues(this.comparator, left, right)
  }

  /** Iterative search that returns the node rather than its value. */
  private findNode(value: T): BinaryNode<T> | undefined {
    let current = this.root
    while (current !== undefined) {
      const comparison = this.compare(value, current.value)
      if (comparison === 0) return current
      current = comparison < 0 ? current.left : current.right
    }
    return undefined
  }

  /** Descend to the minimum of a subtree. */
  private minimumNode(node: BinaryNode<T>): BinaryNode<T> {
    let current = node
    while (current.left !== undefined) current = current.left
    return current
  }

  /** Descend to the maximum of a subtree. */
  private maximumNode(node: BinaryNode<T>): BinaryNode<T> {
    let current = node
    while (current.right !== undefined) current = current.right
    return current
  }

  /** Replace the subtree rooted at `target` with `replacement`. Time O(1). */
  private transplant(target: BinaryNode<T>, replacement: BinaryNode<T> | undefined): void {
    if (target.parent === undefined) this.root = replacement
    else if (target === target.parent.left) target.parent.left = replacement
    else target.parent.right = replacement
    if (replacement !== undefined) replacement.parent = target.parent
  }

  /**
   * Remove a node with the standard successor transplant.
   * Time O(h), worst O(n); space O(1).
   */
  private deleteNode(node: BinaryNode<T>): void {
    if (node.left === undefined) {
      this.transplant(node, node.right)
      return
    }
    if (node.right === undefined) {
      this.transplant(node, node.left)
      return
    }
    const successor = this.minimumNode(node.right)
    if (successor.parent !== node) {
      this.transplant(successor, successor.right)
      successor.right = node.right
      successor.right.parent = successor
    }
    this.transplant(node, successor)
    successor.left = node.left
    successor.left.parent = successor
  }
}

interface BPlusLeaf<K, V> {
  readonly leaf: true
  keys: K[]
  values: V[]
  next: BPlusLeaf<K, V> | undefined
}

interface BPlusInternal<K, V> {
  readonly leaf: false
  keys: K[]
  children: Array<BPlusNode<K, V>>
}

type BPlusNode<K, V> = BPlusLeaf<K, V> | BPlusInternal<K, V>

interface BPlusPathEntry<K, V> {
  readonly node: BPlusInternal<K, V>
  index: number
}

/** Smallest accepted B+ tree order. */
const MinimumBPlusOrder = 3

/** Largest accepted B+ tree order. */
const MaximumBPlusOrder = 64

/** Default B+ tree order; a wide node keeps the tree shallow. */
const DefaultBPlusOrder = 32

/** Clamp a B+ tree order into 3..64 and reject non-integers. */
function normaliseOrder(order: number): number {
  if (!Number.isInteger(order)) {
    throw new InvalidArgumentError('B+ tree order must be an integer between 3 and 64', { order })
  }
  if (order < MinimumBPlusOrder) return MinimumBPlusOrder
  if (order > MaximumBPlusOrder) return MaximumBPlusOrder
  return order
}

/** Create an empty leaf node. */
function createLeaf<K, V>(): BPlusLeaf<K, V> {
  return { leaf: true, keys: [], values: [], next: undefined }
}

/**
 * A B+ tree: sorted key/value map with linked leaves and internal routing.
 *
 * `order` is the maximum number of children of an internal node and also
 * `maxLeafKeys = order - 1`. It is clamped to 3..64.
 *
 * Complexity (n = entries, m = order):
 *  - `get`, `has`: O(log_m n) node visits, each an O(log m) binary search, so
 *    O(log n) comparisons and O(log n) space; O(log_m n) extra stack space.
 *  - `set`: O(log n) comparisons plus at most O(log_m n) node splits, each
 *    O(m); O(m · log_m n) worst-case space for the split path. Amortized O(m)
 *    copying per insertion, i.e. O(log n) for fixed m.
 *  - `delete`: O(log n) comparisons, O(m · log_m n) copying for borrow/merge,
 *    plus `refreshSeparators`, which recomputes exact separator keys along the
 *    path at O(log²_m n) cost. There is no full-tree rebuild. Worst case
 *    O(log n · log n) comparisons and O(m · log n) copying.
 *  - `range`, iteration, `toArray`: O(log n + k) for k yielded entries.
 *  - Space: O(n).
 *
 * Internal nodes store separator keys equal to the minimum key of the child to
 * their right; leaves are linked in ascending order. Duplicate keys are not
 * stored: `set` on an existing key replaces the value and returns false.
 * Mutating during iteration is not supported.
 */
export class BPlusTree<K, V> implements Iterable<[K, V]> {
  /** Effective order after clamping to 3..64. */
  readonly order: number

  private readonly comparator: Comparator<K>
  private readonly leafMinimum: number
  private readonly internalMinimum: number
  private root: BPlusNode<K, V> = createLeaf<K, V>()
  private count = 0

  /**
   * @param order Maximum children per internal node; clamped to 3..64.
   * @param comparator Total order over keys; defaults to the natural order.
   * Time O(1), space O(1).
   */
  constructor(order = DefaultBPlusOrder, comparator: Comparator<K> = defaultComparator) {
    this.order = normaliseOrder(order)
    this.comparator = comparator
    this.leafMinimum = Math.floor(this.order / 2)
    this.internalMinimum = Math.ceil(this.order / 2) - 1
  }

  /** Number of stored key/value pairs. Time O(1). */
  get size(): number {
    return this.count
  }

  /**
   * Read the value stored under `key`. Time O(log n), space O(log n) worst case
   * for the path array; O(1) additional per node.
   */
  get(key: K): V | undefined {
    return this.findEntry(key)?.value
  }

  /** Membership test. Time O(log n), space O(log n) worst case. */
  has(key: K): boolean {
    return this.findEntry(key) !== undefined
  }

  /**
   * Insert a new key or replace the value of an existing key.
   * Time O(log n) amortized plus splits, space O(log n) worst case.
   * Returns true when a new key was inserted, false when a value was replaced.
   */
  set(key: K, value: V): boolean {
    const path: Array<BPlusPathEntry<K, V>> = []
    const leaf = this.findLeaf(key, path)
    const index = this.lowerBound(leaf.keys, key)
    if (index < leaf.keys.length && this.compare(leaf.keys[index], key) === 0) {
      leaf.values[index] = value
      return false
    }
    leaf.keys.splice(index, 0, key)
    leaf.values.splice(index, 0, value)
    this.count += 1
    if (leaf.keys.length > this.order - 1) this.splitLeaf(leaf, path)
    return true
  }

  /**
   * Remove a key. Time O(log n) worst-case comparisons plus O(log² n) separator
   * maintenance, space O(log n); no subtree or tree rebuild.
   * Returns false when the key is absent.
   */
  delete(key: K): boolean {
    if (this.count === 0) return false
    const path: Array<BPlusPathEntry<K, V>> = []
    const leaf = this.findLeaf(key, path)
    const index = this.lowerBound(leaf.keys, key)
    if (index >= leaf.keys.length || this.compare(leaf.keys[index], key) !== 0) return false
    leaf.keys.splice(index, 1)
    leaf.values.splice(index, 1)
    this.count -= 1
    if (leaf !== this.root && leaf.keys.length < this.leafMinimum) this.rebalance(path)
    this.refreshSeparators(path)
    return true
  }

  /** Remove every entry. Time O(1) for the root, O(n) for reclamation. */
  clear(): void {
    this.root = createLeaf<K, V>()
    this.count = 0
  }

  /**
   * Entries with `low <= key <= high`, ascending, in O(log n + k) time and
   * O(log n) space for k yielded entries. An omitted bound is unbounded; a
   * lower bound greater than the upper bound yields nothing.
   */
  *range(low?: K, high?: K): IterableIterator<[K, V]> {
    if (low !== undefined && high !== undefined && this.compare(low, high) > 0) return
    let leaf: BPlusLeaf<K, V>
    if (low === undefined) {
      leaf = this.leftmostLeaf()
    } else {
      let node: BPlusNode<K, V> = this.root
      while (true) {
        if (node.leaf) {
          leaf = node
          break
        }
        node = node.children[this.findChildIndex(node, low)]
      }
    }
    let index = low === undefined ? 0 : this.lowerBound(leaf.keys, low)
    while (true) {
      while (index < leaf.keys.length) {
        const key = leaf.keys[index]
        if (high !== undefined && this.compare(key, high) > 0) return
        yield [key, leaf.values[index]]
        index += 1
      }
      if (leaf.next === undefined) return
      leaf = leaf.next
      index = 0
    }
  }

  /** Keys in ascending order. Time O(n), space O(1) per step. */
  *keys(): IterableIterator<K> {
    for (const [key] of this.entries()) yield key
  }

  /** Values in ascending key order. Time O(n), space O(1) per step. */
  *values(): IterableIterator<V> {
    for (const [, value] of this.entries()) yield value
  }

  /**
   * `[key, value]` pairs in ascending key order.
   * Time O(n), space O(1) per step (plus the linked-leaf walk).
   */
  *entries(): IterableIterator<[K, V]> {
    let leaf: BPlusLeaf<K, V> | undefined = this.leftmostLeaf()
    while (leaf !== undefined) {
      for (let index = 0; index < leaf.keys.length; index += 1) {
        yield [leaf.keys[index], leaf.values[index]]
      }
      leaf = leaf.next
    }
  }

  /** Snapshot in ascending key order. Time O(n), space O(n). */
  toArray(): Array<[K, V]> {
    return [...this.entries()]
  }

  /** Alias of `entries`. Time O(n). */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries()
  }

  /** Compare two keys through the configurable comparator. */
  private compare(left: K, right: K): number {
    return compareValues(this.comparator, left, right)
  }

  /** First index whose key is >= `key`; binary search, O(log m). */
  private lowerBound(keys: K[], key: K): number {
    let low = 0
    let high = keys.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.compare(keys[middle], key) < 0) low = middle + 1
      else high = middle
    }
    return low
  }

  /** Child index to descend into: number of separator keys <= `key`, O(log m). */
  private findChildIndex(node: BPlusInternal<K, V>, key: K): number {
    let low = 0
    let high = node.keys.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.compare(key, node.keys[middle]) < 0) high = middle
      else low = middle + 1
    }
    return low
  }

  /** Descend to the leaf that may contain `key`, recording the internal path. */
  private findLeaf(key: K, path: Array<BPlusPathEntry<K, V>>): BPlusLeaf<K, V> {
    let node: BPlusNode<K, V> = this.root
    while (true) {
      if (node.leaf) return node
      const index = this.findChildIndex(node, key)
      path.push({ node, index })
      node = node.children[index]
    }
  }

  /** Look up a key, allocating one small result object. */
  private findEntry(key: K): { readonly value: V } | undefined {
    const path: Array<BPlusPathEntry<K, V>> = []
    const leaf = this.findLeaf(key, path)
    const index = this.lowerBound(leaf.keys, key)
    if (index >= leaf.keys.length) return undefined
    if (this.compare(leaf.keys[index], key) !== 0) return undefined
    return { value: leaf.values[index] }
  }

  /** Leftmost leaf, O(log n). */
  private leftmostLeaf(): BPlusLeaf<K, V> {
    let node: BPlusNode<K, V> = this.root
    while (true) {
      if (node.leaf) return node
      if (node.children.length === 0) throw new InvalidStateError('B+ tree internal node has no children')
      node = node.children[0]
    }
  }

  /** Split an overflowing leaf and push the promoted separator upward. */
  private splitLeaf(leaf: BPlusLeaf<K, V>, path: Array<BPlusPathEntry<K, V>>): void {
    const middle = Math.floor(leaf.keys.length / 2)
    const rightKeys = leaf.keys.splice(middle)
    const rightValues = leaf.values.splice(middle)
    const right: BPlusLeaf<K, V> = { leaf: true, keys: rightKeys, values: rightValues, next: leaf.next }
    leaf.next = right
    this.integrateSplit(path, rightKeys[0], right)
  }

  /** Walk the split up the recorded path, splitting internal nodes as needed. */
  private integrateSplit(
    path: Array<BPlusPathEntry<K, V>>,
    promotedKey: K,
    promotedNode: BPlusNode<K, V>,
  ): void {
    let key = promotedKey
    let right = promotedNode
    let depth = path.length - 1
    while (depth >= 0) {
      const entry = path[depth]
      const parent = entry.node
      parent.keys.splice(entry.index, 0, key)
      parent.children.splice(entry.index + 1, 0, right)
      if (parent.keys.length <= this.order - 1) return
      const middle = Math.floor(parent.keys.length / 2)
      const internalKey = parent.keys[middle]
      const rightKeys = parent.keys.splice(middle + 1)
      const rightChildren = parent.children.splice(middle + 1)
      parent.keys.length = middle
      const internal: BPlusInternal<K, V> = { leaf: false, keys: rightKeys, children: rightChildren }
      key = internalKey
      right = internal
      depth -= 1
    }
    const previousRoot = this.root
    this.root = { leaf: false, keys: [key], children: [previousRoot, right] }
  }

  /** Minimum number of keys a non-root node of this kind may hold. */
  private minimumKeyCount(node: BPlusNode<K, V>): number {
    return node.leaf ? this.leafMinimum : this.internalMinimum
  }

  /** Current number of keys; internal nodes keep one key per child minus one. */
  private keyCount(node: BPlusNode<K, V>): number {
    return node.keys.length
  }

  /**
   * Restore the B+ tree minimum-fill invariant after a deletion by borrowing
   * from a sibling when possible, otherwise merging and propagating upward.
   */
  private rebalance(path: Array<BPlusPathEntry<K, V>>): void {
    let depth = path.length - 1
    while (depth >= 0) {
      const entry = path[depth]
      const parent = entry.node
      const childIndex = entry.index
      const current = parent.children[childIndex]
      if (current === undefined) break
      if (this.keyCount(current) >= this.minimumKeyCount(current)) break
      let resolved = false
      if (childIndex > 0) {
        const left = parent.children[childIndex - 1]
        if (left !== undefined && this.keyCount(left) > this.minimumKeyCount(left)) {
          this.borrowFromLeft(parent, childIndex)
          resolved = true
        }
      }
      if (!resolved && childIndex + 1 < parent.children.length) {
        const right = parent.children[childIndex + 1]
        if (right !== undefined && this.keyCount(right) > this.minimumKeyCount(right)) {
          this.borrowFromRight(parent, childIndex)
          resolved = true
        }
      }
      if (resolved) break
      if (childIndex > 0) {
        this.mergeChildren(parent, childIndex - 1)
        entry.index = childIndex - 1
      } else {
        this.mergeChildren(parent, childIndex)
        entry.index = childIndex
      }
      depth -= 1
    }
    this.collapseRoot()
  }

  /** Move one entry from the left sibling into the underfull child. */
  private borrowFromLeft(parent: BPlusInternal<K, V>, childIndex: number): void {
    const child = parent.children[childIndex]
    const sibling = parent.children[childIndex - 1]
    if (child === undefined || sibling === undefined) {
      throw new InvalidStateError('B+ tree borrow target is missing')
    }
    if (child.leaf && sibling.leaf) {
      const lastIndex = sibling.keys.length - 1
      const movedKey = sibling.keys[lastIndex]
      const movedValue = sibling.values[lastIndex]
      sibling.keys.splice(lastIndex, 1)
      sibling.values.splice(lastIndex, 1)
      child.keys.unshift(movedKey)
      child.values.unshift(movedValue)
      parent.keys[childIndex - 1] = movedKey
      return
    }
    if (!child.leaf && !sibling.leaf) {
      const separator = parent.keys[childIndex - 1]
      const lastIndex = sibling.children.length - 1
      const movedChild = sibling.children[lastIndex]
      const movedKey = sibling.keys[lastIndex - 1]
      sibling.children.splice(lastIndex, 1)
      sibling.keys.splice(lastIndex - 1, 1)
      child.children.unshift(movedChild)
      child.keys.unshift(separator)
      parent.keys[childIndex - 1] = movedKey
      return
    }
    throw new InvalidStateError('B+ tree siblings must be at the same level')
  }

  /** Move one entry from the right sibling into the underfull child. */
  private borrowFromRight(parent: BPlusInternal<K, V>, childIndex: number): void {
    const child = parent.children[childIndex]
    const sibling = parent.children[childIndex + 1]
    if (child === undefined || sibling === undefined) {
      throw new InvalidStateError('B+ tree borrow target is missing')
    }
    if (child.leaf && sibling.leaf) {
      const movedKey = sibling.keys[0]
      const movedValue = sibling.values[0]
      sibling.keys.splice(0, 1)
      sibling.values.splice(0, 1)
      child.keys.push(movedKey)
      child.values.push(movedValue)
      parent.keys[childIndex] = sibling.keys[0]
      return
    }
    if (!child.leaf && !sibling.leaf) {
      const separator = parent.keys[childIndex]
      const movedKey = sibling.keys[0]
      const movedChild = sibling.children[0]
      sibling.keys.splice(0, 1)
      sibling.children.splice(0, 1)
      child.keys.push(separator)
      child.children.push(movedChild)
      parent.keys[childIndex] = movedKey
      return
    }
    throw new InvalidStateError('B+ tree siblings must be at the same level')
  }

  /** Merge two adjacent siblings and drop the separator from the parent. */
  private mergeChildren(parent: BPlusInternal<K, V>, leftIndex: number): void {
    const left = parent.children[leftIndex]
    const right = parent.children[leftIndex + 1]
    if (left === undefined || right === undefined) {
      throw new InvalidStateError('B+ tree merge target is missing')
    }
    if (left.leaf && right.leaf) {
      left.keys.push(...right.keys)
      left.values.push(...right.values)
      left.next = right.next
    } else if (!left.leaf && !right.leaf) {
      const separator = parent.keys[leftIndex]
      left.keys.push(separator, ...right.keys)
      left.children.push(...right.children)
    } else {
      throw new InvalidStateError('B+ tree siblings must be at the same level')
    }
    parent.keys.splice(leftIndex, 1)
    parent.children.splice(leftIndex + 1, 1)
  }

  /** Collapse a root that has lost all but one child. */
  private collapseRoot(): void {
    while (!this.root.leaf && this.root.children.length === 1) {
      this.root = this.root.children[0]
    }
  }

  /**
   * Recompute exact separator keys along the path so stale minima cannot affect
   * routing. Time O(log² n), space O(1).
   */
  private refreshSeparators(path: Array<BPlusPathEntry<K, V>>): void {
    for (const entry of path) {
      if (entry.index > 0 && entry.index < entry.node.children.length) {
        entry.node.keys[entry.index - 1] = this.firstKey(entry.node.children[entry.index])
      }
    }
  }

  /** Minimum key in a subtree; O(log n). */
  private firstKey(node: BPlusNode<K, V>): K {
    let current = node
    while (!current.leaf) {
      const child = current.children[0]
      if (child === undefined) throw new InvalidStateError('B+ tree internal node has no children')
      current = child
    }
    if (current.keys.length === 0) throw new InvalidStateError('B+ tree leaf has no keys')
    return current.keys[0]
  }
}
