/**
 * A red-black tree and its set wrapper.
 *
 * The tree is the guaranteed-O(log n) counterpart to `BinaryTree` in `./tree.js`:
 * every insert, delete, lookup, min/max, successor and predecessor is O(log n)
 * worst case (not just expected), and in-order iteration is O(n). The colour
 * invariants are re-established with the standard CLRS rotations and are
 * exposed through `validate()` for tests and audits.
 *
 * No Node, DOM, React or external dependency is used.
 */
import { Comparator, compareValues, defaultComparator } from './tree.js'

type RedBlackColor = 'red' | 'black'

interface RedBlackNode<K, V> {
  key: K
  value: V
  color: RedBlackColor
  parent: RedBlackNode<K, V> | undefined
  left: RedBlackNode<K, V> | undefined
  right: RedBlackNode<K, V> | undefined
}

/**
 * A balanced red-black search tree, sorted by a comparator.
 *
 * All mutating and lookup operations are O(log n) worst-case time and O(1)
 * space per operation (rotations are O(1)); min/max are O(log n), successor and
 * predecessor O(log n), range O(log n + k) for k yielded entries, full iteration
 * and `toArray` O(n), `height`/`blackHeight`/`validate` O(n). Total space O(n).
 *
 * Duplicate keys are rejected: `set` on an existing key updates its value and
 * returns false. Iteration is ascending. Mutating during iteration is not
 * supported.
 */
export class RedBlackTree<K, V> implements Iterable<[K, V]> {
  private readonly comparator: Comparator<K>
  private root: RedBlackNode<K, V> | undefined
  private count = 0

  /**
   * @param comparator Total order over keys; defaults to the natural order.
   * Time O(1), space O(1).
   */
  constructor(comparator: Comparator<K> = defaultComparator) {
    this.comparator = comparator
  }

  /** Number of stored pairs. Time O(1). */
  get size(): number {
    return this.count
  }

  /**
   * Height in nodes: 0 for an empty tree, 1 for a single root.
   * Time O(n), space O(n) for the explicit traversal stacks.
   */
  get height(): number {
    if (this.root === undefined) return 0
    let maximum = 0
    const nodes: Array<RedBlackNode<K, V>> = [this.root]
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
   * Number of black nodes on a root-to-leaf path, not counting the nil children;
   * 0 for an empty tree. Every leaf path has this same count in a valid tree.
   * Time O(log n), space O(1).
   */
  get blackHeight(): number {
    let node = this.root
    let black = 0
    while (node !== undefined) {
      if (node.color === 'black') black += 1
      node = node.left
    }
    return black
  }

  /**
   * Insert a key or replace the value of an existing key, rebalancing in
   * O(log n) worst-case time and O(1) space for rotations.
   * Returns true when a new key was inserted.
   */
  set(key: K, value: V): boolean {
    if (this.root === undefined) {
      this.root = { key, value, color: 'black', parent: undefined, left: undefined, right: undefined }
      this.count = 1
      return true
    }
    let current = this.root
    while (true) {
      const comparison = this.compare(key, current.key)
      if (comparison === 0) {
        current.value = value
        return false
      }
      if (comparison < 0) {
        if (current.left === undefined) {
          current.left = {
            key,
            value,
            color: 'red',
            parent: current,
            left: undefined,
            right: undefined,
          }
          this.count += 1
          this.insertFixup(current.left)
          return true
        }
        current = current.left
      } else {
        if (current.right === undefined) {
          current.right = {
            key,
            value,
            color: 'red',
            parent: current,
            left: undefined,
            right: undefined,
          }
          this.count += 1
          this.insertFixup(current.right)
          return true
        }
        current = current.right
      }
    }
  }

  /** Read a value. Time O(log n), space O(1). */
  get(key: K): V | undefined {
    return this.findNode(key)?.value
  }

  /** Membership test. Time O(log n), space O(1). */
  has(key: K): boolean {
    return this.findNode(key) !== undefined
  }

  /**
   * Remove a key and rebalance. Time O(log n), space O(1).
   * Returns false when the key is absent.
   */
  delete(key: K): boolean {
    const node = this.findNode(key)
    if (node === undefined) return false
    this.deleteNode(node)
    this.count -= 1
    return true
  }

  /** Smallest key, or `undefined` when empty. Time O(log n), space O(1). */
  min(): K | undefined {
    return this.minimumNode(this.root)?.key
  }

  /** Largest key, or `undefined` when empty. Time O(log n), space O(1). */
  max(): K | undefined {
    return this.maximumNode(this.root)?.key
  }

  /**
   * Smallest key strictly greater than `key`, or `undefined`.
   * Works whether or not `key` is present. Time O(log n), space O(1).
   */
  successor(key: K): K | undefined {
    let current = this.root
    let candidate: K | undefined
    while (current !== undefined) {
      if (this.compare(key, current.key) < 0) {
        candidate = current.key
        current = current.left
      } else {
        current = current.right
      }
    }
    return candidate
  }

  /**
   * Largest key strictly less than `key`, or `undefined`.
   * Works whether or not `key` is present. Time O(log n), space O(1).
   */
  predecessor(key: K): K | undefined {
    let current = this.root
    let candidate: K | undefined
    while (current !== undefined) {
      if (this.compare(key, current.key) > 0) {
        candidate = current.key
        current = current.right
      } else {
        current = current.left
      }
    }
    return candidate
  }

  /**
   * Pairs with `low <= key <= high`, ascending.
   * Time O(log n + k) for k yielded pairs, space O(log n).
   * An omitted bound is unbounded; a lower bound above the upper bound yields
   * nothing.
   */
  *range(low?: K, high?: K): IterableIterator<[K, V]> {
    if (low !== undefined && high !== undefined && this.compare(low, high) > 0) return
    const stack: Array<RedBlackNode<K, V>> = []
    let current = this.root
    while (current !== undefined || stack.length > 0) {
      while (current !== undefined) {
        stack.push(current)
        current = current.left
      }
      const node = stack.pop()
      if (node === undefined) continue
      if (low !== undefined && this.compare(node.key, low) < 0) {
        current = node.right
        continue
      }
      if (high !== undefined && this.compare(node.key, high) > 0) return
      yield [node.key, node.value]
      current = node.right
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

  /** Pairs in ascending key order. Time O(n), space O(h) for the stack. */
  *entries(): IterableIterator<[K, V]> {
    const stack: Array<RedBlackNode<K, V>> = []
    let current = this.root
    while (current !== undefined || stack.length > 0) {
      while (current !== undefined) {
        stack.push(current)
        current = current.left
      }
      const node = stack.pop()
      if (node === undefined) continue
      yield [node.key, node.value]
      current = node.right
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

  /** Remove every pair. Time O(1) for the root, O(n) for reclamation. */
  clear(): void {
    this.root = undefined
    this.count = 0
  }

  /**
   * Check every red-black invariant: root is black, no red node has a red
   * child, all root-to-leaf paths have the same black height, parent links are
   * consistent, and the in-order keys are strictly ascending.
   *
   * Time O(n), space O(n) for the explicit stacks and black-height map; no
   * recursion, so a corrupted degenerate tree cannot overflow the call stack.
   * Returns true when the tree is valid.
   */
  validate(): boolean {
    if (this.root === undefined) return true
    if (this.root.color !== 'black') return false
    if (this.root.parent !== undefined) return false
    const stack: Array<RedBlackNode<K, V>> = []
    let current: RedBlackNode<K, V> | undefined = this.root
    let previousNode: RedBlackNode<K, V> | undefined
    while (current !== undefined || stack.length > 0) {
      while (current !== undefined) {
        stack.push(current)
        current = current.left
      }
      const node = stack.pop()
      if (node === undefined) continue
      if (previousNode !== undefined && this.compare(previousNode.key, node.key) >= 0) return false
      previousNode = node
      if (node.left !== undefined && node.left.parent !== node) return false
      if (node.right !== undefined && node.right.parent !== node) return false
      if (node.color === 'red') {
        if (node.left !== undefined && node.left.color === 'red') return false
        if (node.right !== undefined && node.right.color === 'red') return false
      }
      current = node.right
    }
    const blackHeights = new Map<RedBlackNode<K, V>, number>()
    const postOrder: Array<RedBlackNode<K, V>> = []
    const pending: Array<RedBlackNode<K, V>> = [this.root]
    while (pending.length > 0) {
      const node = pending.pop()
      if (node === undefined) continue
      postOrder.push(node)
      if (node.left !== undefined) pending.push(node.left)
      if (node.right !== undefined) pending.push(node.right)
    }
    while (postOrder.length > 0) {
      const node = postOrder.pop()
      if (node === undefined) continue
      const leftHeight = node.left === undefined ? 0 : blackHeights.get(node.left)
      const rightHeight = node.right === undefined ? 0 : blackHeights.get(node.right)
      if (leftHeight === undefined || rightHeight === undefined || leftHeight !== rightHeight) {
        return false
      }
      blackHeights.set(node, leftHeight + (node.color === 'black' ? 1 : 0))
    }
    return blackHeights.get(this.root) === this.blackHeight
  }

  /** Compare two keys through the configurable comparator. */
  private compare(left: K, right: K): number {
    return compareValues(this.comparator, left, right)
  }

  /** Colour of a possibly-missing node; nil is black. */
  private colorOf(node: RedBlackNode<K, V> | undefined): RedBlackColor {
    return node === undefined ? 'black' : node.color
  }

  /** Iterative lookup. */
  private findNode(key: K): RedBlackNode<K, V> | undefined {
    let current = this.root
    while (current !== undefined) {
      const comparison = this.compare(key, current.key)
      if (comparison === 0) return current
      current = comparison < 0 ? current.left : current.right
    }
    return undefined
  }

  /** Leftmost node of a subtree. */
  private minimumNode(node: RedBlackNode<K, V> | undefined): RedBlackNode<K, V> | undefined {
    let current = node
    while (current !== undefined && current.left !== undefined) current = current.left
    return current
  }

  /** Rightmost node of a subtree. */
  private maximumNode(node: RedBlackNode<K, V> | undefined): RedBlackNode<K, V> | undefined {
    let current = node
    while (current !== undefined && current.right !== undefined) current = current.right
    return current
  }

  /** Replace the subtree rooted at `target` with `replacement`. */
  private transplant(target: RedBlackNode<K, V>, replacement: RedBlackNode<K, V> | undefined): void {
    if (target.parent === undefined) this.root = replacement
    else if (target === target.parent.left) target.parent.left = replacement
    else target.parent.right = replacement
    if (replacement !== undefined) replacement.parent = target.parent
  }

  /** Rotate left around `node`. Time O(1), space O(1). */
  private rotateLeft(node: RedBlackNode<K, V>): void {
    const pivot = node.right
    if (pivot === undefined) return
    node.right = pivot.left
    if (pivot.left !== undefined) pivot.left.parent = node
    pivot.parent = node.parent
    if (node.parent === undefined) this.root = pivot
    else if (node === node.parent.left) node.parent.left = pivot
    else node.parent.right = pivot
    pivot.left = node
    node.parent = pivot
  }

  /** Rotate right around `node`. Time O(1), space O(1). */
  private rotateRight(node: RedBlackNode<K, V>): void {
    const pivot = node.left
    if (pivot === undefined) return
    node.left = pivot.right
    if (pivot.right !== undefined) pivot.right.parent = node
    pivot.parent = node.parent
    if (node.parent === undefined) this.root = pivot
    else if (node === node.parent.right) node.parent.right = pivot
    else node.parent.left = pivot
    pivot.right = node
    node.parent = pivot
  }

  /** Restore the red-black invariants after an insertion. */
  private insertFixup(start: RedBlackNode<K, V>): void {
    let node = start
    while (node.parent !== undefined && node.parent.color === 'red') {
      const parent = node.parent
      const grandparent = parent.parent
      if (grandparent === undefined) break
      if (parent === grandparent.left) {
        const uncle = grandparent.right
        if (uncle !== undefined && uncle.color === 'red') {
          parent.color = 'black'
          uncle.color = 'black'
          grandparent.color = 'red'
          node = grandparent
          continue
        }
        if (node === parent.right) {
          node = parent
          this.rotateLeft(node)
        }
        const upper = node.parent
        if (upper === undefined) break
        upper.color = 'black'
        const higher = upper.parent
        if (higher !== undefined) {
          higher.color = 'red'
          this.rotateRight(higher)
        }
      } else {
        const uncle = grandparent.left
        if (uncle !== undefined && uncle.color === 'red') {
          parent.color = 'black'
          uncle.color = 'black'
          grandparent.color = 'red'
          node = grandparent
          continue
        }
        if (node === parent.left) {
          node = parent
          this.rotateRight(node)
        }
        const upper = node.parent
        if (upper === undefined) break
        upper.color = 'black'
        const higher = upper.parent
        if (higher !== undefined) {
          higher.color = 'red'
          this.rotateLeft(higher)
        }
      }
    }
    if (this.root !== undefined) this.root.color = 'black'
  }

  /** Remove a node with the standard two-child successor replacement. */
  private deleteNode(node: RedBlackNode<K, V>): void {
    let target = node
    let targetColor = target.color
    let replacement: RedBlackNode<K, V> | undefined
    let replacementParent: RedBlackNode<K, V> | undefined
    if (node.left === undefined) {
      replacement = node.right
      replacementParent = node.parent
      this.transplant(node, node.right)
    } else if (node.right === undefined) {
      replacement = node.left
      replacementParent = node.parent
      this.transplant(node, node.left)
    } else {
      target = this.minimumNode(node.right) ?? node
      targetColor = target.color
      replacement = target.right
      if (target.parent === node) {
        replacementParent = target
      } else {
        replacementParent = target.parent
        this.transplant(target, target.right)
        target.right = node.right
        target.right.parent = target
      }
      this.transplant(node, target)
      target.left = node.left
      target.left.parent = target
      target.color = node.color
    }
    if (targetColor === 'black') this.deleteFixup(replacement, replacementParent)
    if (this.root !== undefined) this.root.color = 'black'
  }

  /** Restore the red-black invariants after a deletion. */
  private deleteFixup(node: RedBlackNode<K, V> | undefined, startParent: RedBlackNode<K, V> | undefined): void {
    let current = node
    let parent = startParent
    while (current !== this.root && this.colorOf(current) === 'black') {
      if (parent === undefined) break
      if (current === parent.left) {
        let sibling = parent.right
        if (sibling === undefined) break
        if (sibling.color === 'red') {
          sibling.color = 'black'
          parent.color = 'red'
          this.rotateLeft(parent)
          sibling = parent.right
          if (sibling === undefined) break
        }
        const leftBlack = this.colorOf(sibling.left) === 'black'
        const rightBlack = this.colorOf(sibling.right) === 'black'
        if (leftBlack && rightBlack) {
          sibling.color = 'red'
          current = parent
          parent = current.parent
          continue
        }
        if (this.colorOf(sibling.right) === 'black') {
          if (sibling.left !== undefined) sibling.left.color = 'black'
          sibling.color = 'red'
          this.rotateRight(sibling)
          sibling = parent.right
          if (sibling === undefined) break
        }
        sibling.color = parent.color
        parent.color = 'black'
        if (sibling.right !== undefined) sibling.right.color = 'black'
        this.rotateLeft(parent)
        current = this.root
        parent = undefined
      } else {
        let sibling = parent.left
        if (sibling === undefined) break
        if (sibling.color === 'red') {
          sibling.color = 'black'
          parent.color = 'red'
          this.rotateRight(parent)
          sibling = parent.left
          if (sibling === undefined) break
        }
        const leftBlack = this.colorOf(sibling.left) === 'black'
        const rightBlack = this.colorOf(sibling.right) === 'black'
        if (leftBlack && rightBlack) {
          sibling.color = 'red'
          current = parent
          parent = current.parent
          continue
        }
        if (this.colorOf(sibling.left) === 'black') {
          if (sibling.right !== undefined) sibling.right.color = 'black'
          sibling.color = 'red'
          this.rotateLeft(sibling)
          sibling = parent.left
          if (sibling === undefined) break
        }
        sibling.color = parent.color
        parent.color = 'black'
        if (sibling.left !== undefined) sibling.left.color = 'black'
        this.rotateRight(parent)
        current = this.root
        parent = undefined
      }
    }
    if (current !== undefined) current.color = 'black'
  }
}

/**
 * A sorted set backed by `RedBlackTree`.
 *
 * `add`, `delete` and `has` are O(log n) worst-case time and O(1) space; range
 * is O(log n + k); iteration and `toArray` are O(n); space O(n). Duplicate
 * values are rejected and iteration is ascending.
 */
export class RedBlackSet<T> implements Iterable<T> {
  private readonly store: RedBlackTree<T, true>

  /**
   * @param comparator Total order over values; defaults to the natural order.
   * @param values Optional initial values.
   * Time O(n log n) for n initial values, space O(n).
   */
  constructor(comparator: Comparator<T> = defaultComparator, values?: Iterable<T>) {
    this.store = new RedBlackTree<T, true>(comparator)
    if (values !== undefined) {
      for (const value of values) this.store.set(value, true)
    }
  }

  /** Number of values. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /** Tree height in nodes; 0 when empty. Time O(n). */
  get height(): number {
    return this.store.height
  }

  /**
   * Insert a value if absent. Time O(log n), space O(1).
   * Returns true only when the set grew.
   */
  add(value: T): boolean {
    return this.store.set(value, true)
  }

  /** Remove a value. Time O(log n), space O(1). */
  delete(value: T): boolean {
    return this.store.delete(value)
  }

  /** Membership test. Time O(log n), space O(1). */
  has(value: T): boolean {
    return this.store.has(value)
  }

  /** Smallest value, or `undefined`. Time O(log n). */
  first(): T | undefined {
    return this.store.min()
  }

  /** Largest value, or `undefined`. Time O(log n). */
  last(): T | undefined {
    return this.store.max()
  }

  /** Values with `low <= value <= high`, ascending. Time O(log n + k). */
  range(low?: T, high?: T): IterableIterator<T> {
    return this.values(low, high)
  }

  /** Values in ascending order. Time O(n). */
  values(low?: T, high?: T): IterableIterator<T> {
    const entries = this.store.range(low, high)
    return (function* iterate(): IterableIterator<T> {
      for (const [value] of entries) yield value
    })()
  }

  /** Remove every value. Time O(1) for the root, O(n) for reclamation. */
  clear(): void {
    this.store.clear()
  }

  /** Snapshot in ascending order. Time O(n), space O(n). */
  toArray(): T[] {
    return [...this]
  }

  /** Iterate in ascending order. Time O(n). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.values()
  }
}
