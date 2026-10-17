/**
 * Linked nodes shared by the ordered collections.
 *
 * These are deliberately thin data holders: they allocate no closures and keep
 * every link public so a collection can rethread them in place. They are not
 * iterable collections themselves, so they do not expose `size`/`clear`; the
 * owning collection does.
 *
 * Nothing here touches the platform: no Node APIs, no DOM, no React.
 */
import { InvalidArgumentError } from './error.js'

/**
 * A node in a doubly linked list.
 *
 * Construction is O(1) time and O(1) space. Links are intentionally mutable so
 * a list can splice nodes in O(1); `value` is mutable for callers that update a
 * payload in place (an ordered map updates its value without rethreading).
 */
export class LinearNode<T> {
  /** Payload carried by the node. */
  value: T
  /** Previous node, or `undefined` at the head. */
  previous: LinearNode<T> | undefined
  /** Next node, or `undefined` at the tail. */
  next: LinearNode<T> | undefined

  /**
   * @param value Payload to carry.
   * @param previous Previous node, when the caller is building a chain.
   * @param next Next node, when the caller is building a chain.
   * Time O(1), space O(1).
   */
  constructor(value: T, previous?: LinearNode<T>, next?: LinearNode<T>) {
    this.value = value
    this.previous = previous
    this.next = next
  }
}

/**
 * A node in a binary tree.
 *
 * `left`, `right` and `parent` are undefined for absent links. Time O(1) to
 * construct, space O(1). Callers own the invariants: this class never rebalances
 * or validates, and a malformed parent link is not detected here.
 */
export class BinaryNode<T> {
  /** Payload carried by the node. */
  value: T
  /** Left child, or `undefined`. */
  left: BinaryNode<T> | undefined
  /** Right child, or `undefined`. */
  right: BinaryNode<T> | undefined
  /** Parent node, or `undefined` at the root. */
  parent: BinaryNode<T> | undefined

  /**
   * @param value Payload to carry.
   * @param parent Parent node when the caller already knows it.
   * Time O(1), space O(1).
   */
  constructor(value: T, parent?: BinaryNode<T>) {
    this.value = value
    this.left = undefined
    this.right = undefined
    this.parent = parent
  }
}

/**
 * A node in a skip list level tower.
 *
 * `level` is the tower height. `next` has exactly `level` slots, indexed from
 * the bottom level (0); each slot is the next node at that level or `undefined`
 * at the end of the list. Constructor time and space are O(level). Skip lists in
 * this library cap the level at 24, but a standalone node may use up to 1024 so
 * that callers experimenting with other shapes are not silently clamped.
 */
export class SkipNode<K, V> {
  /** Sort key. Read-only after construction. */
  readonly key: K
  /** Payload; mutable so a set-like owner can refresh a stored value. */
  value: V
  /** Forward links, one per level, bottom-up. */
  readonly next: Array<SkipNode<K, V> | undefined>

  /**
   * @param key Sort key.
   * @param value Payload.
   * @param level Tower height, an integer in 1..1024.
   * Time O(level), space O(level).
   */
  constructor(key: K, value: V, level: number) {
    if (!Number.isInteger(level) || level < 1 || level > 1024) {
      throw new InvalidArgumentError('skip node level must be an integer between 1 and 1024', { level })
    }
    this.key = key
    this.value = value
    this.next = new Array<SkipNode<K, V> | undefined>(level).fill(undefined)
  }
}
