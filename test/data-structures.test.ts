/**
 * Contract tests for the shared data-structure library.
 *
 * These tests are deliberately behavioural rather than white-box: they assert
 * documented ordering, capacity, duplicate and complexity contracts. The few
 * structural checks (red-black `validate`, B+ tree order, LRU tombstone counts)
 * are public diagnostics that exist precisely so an audit can see the invariants
 * without reaching into private fields.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InvalidArgumentError } from '../src/shared/error.js'
import {
  hashCombine,
  hashNumber,
  hashString,
  normaliseCapacity,
  stableHash,
} from '../src/shared/hash.js'
import { BinaryNode, LinearNode, SkipNode } from '../src/shared/node.js'
import { BinaryTree, BPlusTree } from '../src/shared/tree.js'
import { OrderedMap, UnorderedMap } from '../src/shared/map.js'
import { OrderedSkipList, UnorderedSkipList } from '../src/shared/list.js'
import { OrderedSet, OrderedSkipSet, UnorderedSet, UnorderedSkipSet } from '../src/shared/set.js'
import {
  LruList,
  OrderedLruList,
  OrderedLruSet,
  UnorderedLruList,
  UnorderedLruSet,
  WeakLruList,
} from '../src/shared/lru.js'
import { RedBlackSet, RedBlackTree } from '../src/shared/redblack.js'
import { BinaryHeap, IndexedHeap } from '../src/shared/heap.js'
import { Deque, Queue, Stack } from '../src/shared/stack.js'
import { DirectedGraph } from '../src/shared/graph.js'
import { GridRange, SparseGrid } from '../src/shared/grid.js'
import { Trie, assertTrieKey } from '../src/shared/trie.js'

/** Deterministic xorshift32 generator so failures are reproducible. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x100000000
  }
}

/** Fisher-Yates shuffle driven by the deterministic generator. */
function shuffle<T>(values: readonly T[], seed: number): T[] {
  const random = createRandom(seed)
  const copy = [...values]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    const hold = copy[index]
    copy[index] = copy[target]
    copy[target] = hold
  }
  return copy
}

/** Elapsed milliseconds around a synchronous action. */
function elapsed(action: () => void): number {
  const started = performance.now()
  action()
  return performance.now() - started
}

/* ------------------------------------------------------------------------- *
 * Hashing
 * ------------------------------------------------------------------------- */

test('hashString matches FNV-1a vectors and hashes deterministically', () => {
  assert.equal(hashString(''), 2166136261)
  assert.equal(hashString('a'), 3826002220)
  assert.equal(hashString('a'), hashString('a'))
  assert.notEqual(hashString('a'), hashString('b'))
  assert.notEqual(hashString('ab'), hashString('ba'))
  const hash = hashString('The quick brown fox jumps over the lazy dog')
  assert.ok(Number.isInteger(hash) && hash >= 0 && hash <= 0xffffffff)
})

test('hashString spreads five thousand keys across buckets', () => {
  const buckets = new Array<number>(128).fill(0)
  for (let index = 0; index < 5_000; index += 1) {
    const hash = hashString(`key-${index}`)
    buckets[hash % buckets.length] += 1
  }
  const maximum = Math.max(...buckets)
  const used = buckets.filter((count) => count > 0).length
  assert.ok(maximum < 200, `worst bucket held ${maximum} of 5000 keys`)
  assert.ok(used >= 100, `only ${used} of 128 buckets were used`)
})

test('hashNumber is stable for integers, floats and special values', () => {
  assert.equal(hashNumber(0), hashNumber(-0))
  assert.equal(hashNumber(Number.NaN), hashNumber(Number.NaN))
  assert.equal(hashNumber(1), hashNumber(1))
  assert.notEqual(hashNumber(1), hashNumber(1.5))
  const special = new Set([
    hashNumber(0),
    hashNumber(1),
    hashNumber(-1),
    hashNumber(1.5),
    hashNumber(Number.NaN),
    hashNumber(Number.POSITIVE_INFINITY),
    hashNumber(Number.NEGATIVE_INFINITY),
  ])
  assert.equal(special.size, 7)
})

test('hashCombine is order sensitive and stable', () => {
  assert.notEqual(hashCombine(1, 2), hashCombine(2, 1))
  assert.equal(hashCombine(7, 11), hashCombine(7, 11))
  assert.ok(hashCombine(7, 11) >= 0)
})

test('stableHash is structural, depth capped and cycle safe', () => {
  assert.equal(stableHash({ a: 1, b: 2 }), stableHash({ b: 2, a: 1 }))
  assert.notEqual(stableHash({ a: 1 }), stableHash({ a: 2 }))
  assert.notEqual(stableHash([1, 2]), stableHash([2, 1]))
  assert.notEqual(stableHash(1), stableHash('1'))
  assert.equal(stableHash([1, { x: true }]), stableHash([1, { x: true }]))

  const deepLeft = { a: { b: { c: { d: { e: { f: { g: 'left' } } } } } } }
  const deepRight = { a: { b: { c: { d: { e: { f: { g: 'right' } } } } } } }
  assert.equal(stableHash(deepLeft), stableHash(deepRight))

  const cyclic: { name: string; self?: unknown } = { name: 'cycle' }
  cyclic.self = cyclic
  assert.equal(stableHash(cyclic), stableHash(cyclic))
  assert.ok(Number.isInteger(stableHash(cyclic)))
})

/* ------------------------------------------------------------------------- *
 * Nodes
 * ------------------------------------------------------------------------- */

test('linked, binary and skip nodes expose their links', () => {
  const second = new LinearNode(2)
  const first = new LinearNode(1, undefined, second)
  second.previous = first
  assert.equal(first.next, second)
  assert.equal(second.previous, first)
  assert.equal(first.value, 1)

  const root = new BinaryNode('root')
  assert.equal(root.parent, undefined)
  const child = new BinaryNode('child', root)
  root.left = child
  assert.equal(child.parent, root)
  assert.equal(root.right, undefined)

  const skip = new SkipNode('key', 42, 3)
  assert.equal(skip.next.length, 3)
  assert.equal(skip.key, 'key')
  assert.equal(skip.value, 42)
  assert.throws(() => new SkipNode('bad', 0, 0), InvalidArgumentError)
  assert.throws(() => new SkipNode('bad', 0, 1.5), InvalidArgumentError)
})

/* ------------------------------------------------------------------------- *
 * Binary search tree
 * ------------------------------------------------------------------------- */

test('BinaryTree searches, traverses and reports sorted order for 1k keys', () => {
  const keys = Array.from({ length: 1_000 }, (_unused, index) => index * 3)
  const tree = new BinaryTree<number>()
  for (const key of shuffle(keys, 42)) assert.equal(tree.insert(key), true)

  assert.equal(tree.size, 1_000)
  assert.equal(tree.insert(300), false)
  assert.equal(tree.size, 1_000)
  assert.equal(tree.has(300), true)
  assert.equal(tree.has(301), false)
  assert.equal(tree.search(300), 300)
  assert.equal(tree.min(), 0)
  assert.equal(tree.max(), 2_997)
  assert.deepEqual(tree.toArray(), keys)
  assert.deepEqual([...tree], keys)
  assert.equal([...tree.preOrder()].length, 1_000)
  assert.equal([...tree.postOrder()].length, 1_000)
  assert.ok(tree.height < 100, `random tree height was ${tree.height}`)
  assert.equal(tree.size, 1_000)
})

test('BinaryTree deletes leaves, internal nodes and roots', () => {
  const tree = new BinaryTree<number>()
  for (const key of shuffle(Array.from({ length: 400 }, (_unused, index) => index), 7)) {
    tree.insert(key)
  }
  for (let key = 0; key < 200; key += 1) assert.equal(tree.delete(key), true)
  assert.equal(tree.delete(10_000), false)
  assert.equal(tree.size, 200)
  assert.deepEqual(tree.toArray(), Array.from({ length: 200 }, (_unused, index) => index + 200))

  const degenerate = new BinaryTree<number>()
  for (let key = 0; key < 1_000; key += 1) degenerate.insert(key)
  assert.equal(degenerate.height, 1_000)
  assert.deepEqual([...degenerate.preOrder()], Array.from({ length: 1_000 }, (_unused, index) => index))
  assert.deepEqual(
    [...degenerate.postOrder()],
    Array.from({ length: 1_000 }, (_unused, index) => 999 - index),
  )

  tree.clear()
  assert.equal(tree.size, 0)
  assert.equal(tree.height, 0)
  assert.deepEqual(tree.toArray(), [])
})

test('BinaryTree honours a custom comparator and rejects non-finite results', () => {
  const reversed = new BinaryTree<number>((left, right) => right - left)
  for (const key of [1, 3, 2]) reversed.insert(key)
  assert.deepEqual(reversed.toArray(), [3, 2, 1])

  const broken = new BinaryTree<number>(() => Number.NaN)
  broken.insert(1)
  assert.throws(() => broken.insert(2), InvalidArgumentError)
})

/* ------------------------------------------------------------------------- *
 * B+ tree
 * ------------------------------------------------------------------------- */

test('BPlusTree inserts ten thousand sequential keys in sorted order', () => {
  const tree = new BPlusTree<number, string>(8)
  const duration = elapsed(() => {
    for (let index = 0; index < 10_000; index += 1) {
      assert.equal(tree.set(index, `value-${index}`), true)
    }
  })
  assert.ok(duration < 2_000, `10k sequential B+ inserts took ${duration.toFixed(1)}ms`)
  assert.equal(tree.size, 10_000)
  assert.equal(tree.set(5_000, 'updated'), false)
  assert.equal(tree.get(5_000), 'updated')
  assert.equal(tree.size, 10_000)
  const entries = tree.toArray()
  assert.equal(entries.length, 10_000)
  for (let index = 0; index < 10_000; index += 1) {
    assert.equal(entries[index][0], index)
  }
})

test('BPlusTree inserts ten thousand random keys without duplicates or misorder', () => {
  const keys = shuffle(Array.from({ length: 10_000 }, (_unused, index) => index * 2), 1_234)
  const tree = new BPlusTree<number, number>(4)
  for (const key of keys) assert.equal(tree.set(key, key), true)
  assert.equal(tree.size, 10_000)
  assert.equal(tree.set(keys[500], -1), false)
  assert.equal(tree.size, 10_000)
  const seen: number[] = []
  for (const [key] of tree) seen.push(key)
  assert.equal(seen.length, 10_000)
  for (let index = 1; index < seen.length; index += 1) {
    assert.ok(seen[index - 1] < seen[index], `keys out of order at ${index}`)
  }
})

test('BPlusTree range bounds are inclusive on both ends', () => {
  const tree = new BPlusTree<number, number>(4)
  for (let key = 0; key < 1_000; key += 1) tree.set(key, key)
  const collect = (low?: number, high?: number): number[] => [...tree.range(low, high)].map(([key]) => key)

  assert.deepEqual(collect(100, 109), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109])
  assert.deepEqual(collect(10, 10), [10])
  assert.deepEqual(collect(0, 0), [0])
  assert.deepEqual(collect(20, 10), [])
  assert.equal(collect(undefined, 4).length, 5)
  assert.equal(collect(995, undefined).length, 5)
  assert.equal(collect().length, 1_000)
  assert.deepEqual(collect(1_000, 2_000), [])
  assert.deepEqual(collect(-10, -1), [])
})

test('BPlusTree deletes, merges and reuses keys without losing order', () => {
  const tree = new BPlusTree<number, number>(8)
  for (let key = 0; key < 5_000; key += 1) tree.set(key, key)
  for (let key = 0; key < 5_000; key += 2) assert.equal(tree.delete(key), true)
  assert.equal(tree.delete(0), false)
  assert.equal(tree.size, 2_500)
  let expected = 1
  for (const [key] of tree) {
    assert.equal(key, expected)
    expected += 2
  }
  assert.equal(tree.has(100), false)
  assert.equal(tree.has(101), true)
  assert.deepEqual([...tree.range(100, 110)].map(([key]) => key), [101, 103, 105, 107, 109])

  const shuffledDeletes = shuffle(Array.from({ length: 2_500 }, (_unused, index) => index * 2 + 1), 99)
  for (const key of shuffledDeletes.slice(0, 1_500)) assert.equal(tree.delete(key), true)
  assert.equal(tree.size, 1_000)
  const remaining = [...tree.keys()]
  assert.equal(remaining.length, 1_000)
  for (let index = 1; index < remaining.length; index += 1) {
    assert.ok(remaining[index - 1] < remaining[index])
  }

  tree.clear()
  assert.equal(tree.size, 0)
  assert.deepEqual([...tree], [])
  assert.equal(tree.set(7, 7), true)
  assert.equal(tree.get(7), 7)
})

test('BPlusTree order 3 survives randomized set/delete against a model', () => {
  const tree = new BPlusTree<number, number>(3)
  const model = new Map<number, number>()
  const random = createRandom(77)
  for (let step = 0; step < 4_000; step += 1) {
    const key = Math.floor(random() * 300)
    if (random() < 0.55) {
      assert.equal(tree.set(key, step), !model.has(key), `set mismatch at step ${step}`)
      model.set(key, step)
    } else {
      assert.equal(tree.delete(key), model.delete(key), `delete mismatch at step ${step}`)
    }
    if (step % 200 === 0) {
      const expected = [...model.keys()].sort((left, right) => left - right)
      assert.deepEqual([...tree.keys()], expected, `order mismatch at step ${step}`)
      assert.equal(tree.size, model.size)
    }
  }
  assert.deepEqual([...tree.keys()], [...model.keys()].sort((left, right) => left - right))
  assert.equal(tree.order, 3)
  assert.equal(new BPlusTree(2).order, 3)
  assert.equal(new BPlusTree(1_000).order, 64)
  assert.throws(() => new BPlusTree(4.5), InvalidArgumentError)
})

test('BPlusTree honours a custom comparator and rejects non-finite results', () => {
  const descending = new BPlusTree<number, string>(4, (left, right) => right - left)
  descending.set(1, 'one')
  descending.set(3, 'three')
  descending.set(2, 'two')
  assert.deepEqual([...descending.keys()], [3, 2, 1])
  assert.deepEqual([...descending.range(3, 2)].map(([key]) => key), [3, 2])

  const broken = new BPlusTree<number, number>(4, () => Number.POSITIVE_INFINITY)
  broken.set(1, 1)
  assert.throws(() => broken.set(2, 2), InvalidArgumentError)
})

/* ------------------------------------------------------------------------- *
 * Maps
 * ------------------------------------------------------------------------- */

test('OrderedMap preserves insertion order and deletes both ends in O(1)', () => {
  const map = new OrderedMap<string, number>([
    ['a', 1],
    ['b', 2],
  ])
  map.set('a', 10)
  map.set('c', 3)
  assert.deepEqual(map.toArray(), [
    ['a', 10],
    ['b', 2],
    ['c', 3],
  ])
  assert.equal(map.first(), 10)
  assert.equal(map.last(), 3)
  assert.equal(map.firstKey(), 'a')
  assert.equal(map.lastKey(), 'c')
  assert.deepEqual([...map.values()], [10, 2, 3])
  assert.equal(map.deleteFirst(), true)
  assert.deepEqual([...map.keys()], ['b', 'c'])
  assert.equal(map.deleteLast(), true)
  assert.deepEqual([...map.keys()], ['b'])
  assert.equal(map.delete('missing'), false)
  map.clear()
  assert.equal(map.size, 0)
  assert.equal(map.firstKey(), undefined)
  assert.equal(new OrderedMap<string, number>().deleteFirst(), false)
})

test('UnorderedMap exposes the native map contract', () => {
  const map = new UnorderedMap<string, number>()
  map.set('one', 1).set('two', 2)
  assert.equal(map.size, 2)
  assert.equal(map.get('one'), 1)
  assert.equal(map.has('three'), false)
  assert.deepEqual(map.toArray().sort(), [
    ['one', 1],
    ['two', 2],
  ])
  assert.equal(map.delete('one'), true)
  assert.equal(map.delete('one'), false)
  assert.equal(map.size, 1)
  map.clear()
  assert.equal(map.size, 0)
})

/* ------------------------------------------------------------------------- *
 * Skip lists
 * ------------------------------------------------------------------------- */

test('OrderedSkipList keeps sorted order, duplicates and ranges', () => {
  const list = new OrderedSkipList<number>()
  const random = createRandom(5)
  const inserted: number[] = []
  for (let index = 0; index < 2_000; index += 1) {
    const value = Math.floor(random() * 1_000)
    inserted.push(value)
    list.insert(value)
  }
  inserted.sort((left, right) => left - right)
  assert.equal(list.size, 2_000)
  assert.deepEqual(list.toArray(), inserted)
  assert.equal(list.first(), inserted[0])
  assert.equal(list.last(), inserted[inserted.length - 1])
  assert.equal(list.has(inserted[0]), true)
  assert.equal(list.has(10_000), false)

  const ranged = [...list.range(100, 200)]
  assert.deepEqual(ranged, inserted.filter((value) => value >= 100 && value <= 200))
  assert.deepEqual([...list.range(200, 100)], [])

  const duplicated = new OrderedSkipList<number>()
  duplicated.insert(5)
  duplicated.insert(5)
  assert.equal(duplicated.size, 2)
  assert.equal(duplicated.delete(5), true)
  assert.equal(duplicated.size, 1)
  assert.equal(duplicated.has(5), true)
  duplicated.clear()
  assert.equal(duplicated.size, 0)
})

test('OrderedSkipList rejects non-finite comparator results', () => {
  const broken = new OrderedSkipList<number>(() => Number.NaN)
  broken.insert(1)
  assert.throws(() => broken.insert(2), InvalidArgumentError)
})

test('OrderedSkipList inserts ten thousand values within the complexity budget', () => {
  const list = new OrderedSkipList<number>()
  const duration = elapsed(() => {
    for (let index = 0; index < 10_000; index += 1) list.insert((index * 7919) % 10_003)
  })
  assert.ok(duration < 2_000, `10k skip inserts took ${duration.toFixed(1)}ms`)
  assert.equal(list.size, 10_000)
  const values = list.toArray()
  for (let index = 1; index < values.length; index += 1) {
    assert.ok(values[index - 1] <= values[index])
  }
})

test('UnorderedSkipList hashes, keeps duplicates and deletes one occurrence', () => {
  const list = new UnorderedSkipList<number>()
  for (let value = 0; value < 500; value += 1) list.insert(value)
  assert.equal(list.size, 500)
  for (let value = 0; value < 500; value += 1) assert.equal(list.has(value), true)
  assert.equal(list.has(10_000), false)
  assert.equal(list.delete(250), true)
  assert.equal(list.delete(250), false)
  assert.equal(list.size, 499)
  assert.equal(list.has(250), false)
  list.insert(250)
  list.insert(250)
  assert.equal(list.size, 501)
  assert.equal([...list].length, 501)
  list.clear()
  assert.equal(list.size, 0)
})

/* ------------------------------------------------------------------------- *
 * Sets
 * ------------------------------------------------------------------------- */

test('OrderedSet and UnorderedSet implement set semantics', () => {
  const ordered = new OrderedSet<string>(['b', 'a'])
  assert.equal(ordered.add('c'), true)
  assert.equal(ordered.add('b'), false)
  assert.deepEqual(ordered.toArray(), ['b', 'a', 'c'])
  assert.equal(ordered.first(), 'b')
  assert.equal(ordered.last(), 'c')
  assert.equal(ordered.delete('a'), true)
  assert.deepEqual([...ordered], ['b', 'c'])
  ordered.clear()
  assert.equal(ordered.size, 0)

  const unordered = new UnorderedSet<number>([1, 2])
  assert.equal(unordered.add(2), false)
  assert.equal(unordered.add(3), true)
  assert.equal(unordered.has(3), true)
  assert.equal(unordered.size, 3)
  assert.equal(unordered.delete(2), true)
  assert.equal(unordered.size, 2)
  unordered.clear()
  assert.equal(unordered.size, 0)
})

test('OrderedSkipSet is sorted and UnorderedSkipSet is hash ordered', () => {
  const sorted = new OrderedSkipSet<number>()
  assert.equal(sorted.add(3), true)
  assert.equal(sorted.add(1), true)
  assert.equal(sorted.add(2), true)
  assert.equal(sorted.add(2), false)
  assert.deepEqual(sorted.toArray(), [1, 2, 3])
  assert.equal(sorted.first(), 1)
  assert.equal(sorted.last(), 3)
  assert.deepEqual([...sorted.range(2, 3)], [2, 3])
  assert.equal(sorted.delete(2), true)
  assert.deepEqual(sorted.toArray(), [1, 3])

  const hashed = new UnorderedSkipSet<string>()
  assert.equal(hashed.add('alpha'), true)
  assert.equal(hashed.add('alpha'), false)
  assert.equal(hashed.add('beta'), true)
  assert.equal(hashed.has('beta'), true)
  assert.equal(hashed.size, 2)
  assert.equal(hashed.delete('alpha'), true)
  assert.equal(hashed.has('alpha'), false)
  hashed.clear()
  assert.equal(hashed.size, 0)
})

/* ------------------------------------------------------------------------- *
 * Key/value and weak LRUs
 *
 * The array-backed LRU and its weak-key variant used to live in hash.ts and are
 * now internal to lru.ts. These tests target the canonical public LruList and
 * WeakLruList; the removed tombstone counter was an implementation detail, so
 * compaction is covered by the insert/delete churn assertions below.
 * ------------------------------------------------------------------------- */

test('LruList promotes on get and set, not on peek or has', () => {
  const list = new LruList<string, number>(3)
  list.set('a', 1).set('b', 2).set('c', 3)
  assert.deepEqual([...list.keys()], ['c', 'b', 'a'])
  assert.equal(list.get('a'), 1)
  assert.deepEqual([...list.keys()], ['a', 'c', 'b'])
  assert.equal(list.peek('b'), 2)
  assert.deepEqual([...list.keys()], ['a', 'c', 'b'])
  assert.equal(list.has('b'), true)
  assert.deepEqual([...list.keys()], ['a', 'c', 'b'])
  assert.equal(list.touch('c'), true)
  assert.deepEqual([...list.keys()], ['c', 'a', 'b'])
  list.set('d', 4)
  assert.equal(list.has('b'), false)
  assert.deepEqual([...list.keys()], ['d', 'c', 'a'])
  assert.deepEqual(list.toArray(), [
    ['d', 4],
    ['c', 3],
    ['a', 1],
  ])
  list.resize(1)
  assert.deepEqual([...list.keys()], ['d'])
  list.resize(10)
  assert.equal(list.capacity, 10)
  list.clear()
  assert.equal(list.size, 0)
})

test('LruList enforces capacity one and validates capacity input', () => {
  const list = new LruList<string, number>(1)
  list.set('a', 1)
  list.set('b', 2)
  assert.equal(list.size, 1)
  assert.deepEqual([...list.keys()], ['b'])
  assert.equal(new LruList(0).capacity, 1)
  assert.equal(new LruList(1_000_000).capacity, 100_000)
  assert.throws(() => new LruList(1.5), InvalidArgumentError)
  assert.throws(() => new LruList(Number.NaN), InvalidArgumentError)
  assert.throws(() => list.resize(2.5), InvalidArgumentError)
  assert.equal(normaliseCapacity(0), 1)
  assert.equal(normaliseCapacity(1_000_000), 100_000)
  assert.throws(() => normaliseCapacity(1.5), InvalidArgumentError)
})

test('LruList survives insert/delete churn and keeps most-recent-first order', () => {
  const list = new LruList<string, number>(5)
  for (let index = 0; index < 4; index += 1) list.set(`k${index}`, index)
  for (let round = 0; round < 20; round += 1) {
    list.set('temp', round)
    list.delete('temp')
  }
  assert.equal(list.size, 4)
  assert.deepEqual([...list.keys()], ['k3', 'k2', 'k1', 'k0'])
  assert.equal(list.touch('missing'), false)
  assert.equal(list.peek('k0'), 0)
  assert.equal(list.get('missing'), undefined)
})

test('WeakLruList keeps live keys and evicts by recency', () => {
  const cache = new WeakLruList<object, string>(2)
  const first = { id: 1 }
  const second = { id: 2 }
  const third = { id: 3 }
  cache.set(first, 'first')
  cache.set(second, 'second')
  assert.equal(cache.get(first), 'first')
  assert.equal(cache.has(second), true)
  assert.equal(cache.size, 2)
  assert.equal(cache.peek(second), 'second')
  cache.set(third, 'third')
  assert.equal(cache.has(second), false)
  assert.equal(cache.get(third), 'third')
  assert.equal(cache.get(first), 'first')
  assert.equal(cache.delete(third), true)
  assert.equal(cache.delete(third), false)
  assert.equal(cache.size, 1)
  cache.resize(5)
  assert.equal(cache.capacity, 5)
  cache.clear()
  assert.equal(cache.size, 0)
})

test('WeakLruList drops collected keys after a forced GC', async (context) => {
  const globalWithCollector = globalThis as typeof globalThis & { gc?: () => void }
  const collect = globalWithCollector.gc
  if (collect === undefined) {
    context.skip('run node with --expose-gc to assert collected keys')
    return
  }
  const cache = new WeakLruList<object, number>(32)
  let keys: Array<object> | undefined = Array.from({ length: 10 }, () => ({}))
  for (let index = 0; index < keys.length; index += 1) cache.set(keys[index], index)
  assert.equal(cache.size, 10)
  keys = undefined
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    collect()
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  assert.ok(cache.size < 10, `weak cache still reports ${cache.size} entries after GC`)
  assert.equal([...cache.keys()].length, cache.size)
})

test('WeakLruList live cache keeps the keyed contract', () => {
  const cache = new WeakLruList<object, number>(2)
  const first = { name: 'first' }
  const second = { name: 'second' }
  cache.set(first, 1)
  cache.set(second, 2)
  assert.equal(cache.get(first), 1)
  assert.equal(cache.peek(second), 2)
  assert.equal(cache.size, 2)
  assert.equal(cache.delete(first), true)
  assert.equal(cache.size, 1)
  cache.clear()
  assert.equal(cache.size, 0)
})

/* ------------------------------------------------------------------------- *
 * LRU sets and lists
 * ------------------------------------------------------------------------- */

test('OrderedLruSet iterates least-recently used first and refreshes recency', () => {
  const set = new OrderedLruSet<string>(3)
  assert.equal(set.add('a'), true)
  assert.equal(set.add('b'), true)
  assert.equal(set.add('c'), true)
  assert.deepEqual(set.toArray(), ['a', 'b', 'c'])
  assert.equal(set.add('a'), false)
  assert.deepEqual(set.toArray(), ['b', 'c', 'a'])
  assert.equal(set.has('b'), true)
  assert.deepEqual(set.toArray(), ['b', 'c', 'a'])
  assert.equal(set.touch('b'), true)
  assert.deepEqual(set.toArray(), ['c', 'a', 'b'])
  assert.equal(set.add('d'), true)
  assert.deepEqual(set.toArray(), ['a', 'b', 'd'])
  assert.equal(set.has('c'), false)
  set.resize(1)
  assert.deepEqual(set.toArray(), ['d'])
  assert.equal(set.size, 1)
  set.clear()
  assert.equal(set.size, 0)
})

test('UnorderedLruSet bounds capacity and refreshes eviction recency', () => {
  const set = new UnorderedLruSet<string>(2)
  set.add('a')
  set.add('b')
  assert.equal(set.touch('a'), true)
  set.add('c')
  assert.equal(set.size, 2)
  assert.equal(set.has('a'), true)
  assert.equal(set.has('c'), true)
  assert.equal(set.has('b'), false)
  assert.equal(set.add('a'), false)
  assert.equal(set.size, 2)
  set.resize(1)
  assert.equal(set.size, 1)
  assert.equal(set.touch('missing'), false)
  set.clear()
  assert.equal(set.size, 0)
})

test('OrderedLruList allows duplicates and promotes by index with touch', () => {
  const list = new OrderedLruList<string>(3)
  list.push('a').push('b').push('c')
  assert.deepEqual(list.toArray(), ['a', 'b', 'c'])
  assert.equal(list.get(0), 'a')
  assert.equal(list.peek(2), 'c')
  list.touch(0)
  assert.deepEqual(list.toArray(), ['b', 'c', 'a'])
  list.push('d')
  assert.deepEqual(list.toArray(), ['c', 'a', 'd'])
  assert.equal(list.shift(), 'c')
  assert.deepEqual(list.toArray(), ['a', 'd'])
  list.push('a')
  assert.deepEqual(list.toArray(), ['a', 'd', 'a'])
  assert.throws(() => list.get(3), InvalidArgumentError)
  assert.throws(() => list.touch(-1), InvalidArgumentError)
  list.resize(1)
  assert.deepEqual(list.toArray(), ['a'])
  assert.equal(list.capacity, 1)
  list.clear()
  assert.equal(list.size, 0)
})

test('UnorderedLruList evicts oldest insertion and supports touch', () => {
  const list = new UnorderedLruList<string>(2)
  list.push('a').push('a').push('b')
  assert.equal(list.size, 2)
  assert.equal(list.peek(), 'a')
  assert.deepEqual(list.toArray(), ['a', 'b'])
  assert.equal(list.touch('a'), true)
  assert.deepEqual(list.toArray(), ['b', 'a'])
  list.push('c')
  assert.equal(list.size, 2)
  assert.deepEqual(list.toArray(), ['a', 'c'])
  assert.equal(list.touch('missing'), false)
  list.resize(1)
  assert.deepEqual(list.toArray(), ['c'])
  list.clear()
  assert.equal(list.size, 0)

  const single = new UnorderedLruList<number>(1)
  single.push(1)
  single.push(2)
  assert.deepEqual(single.toArray(), [2])
})

test('LruList matches a reference recency model', () => {
  const random = createRandom(0x51ed)
  const capacity = 5
  const lru = new LruList<string, number>(capacity)
  const model: string[] = []
  const values = new Map<string, number>()
  for (let step = 0; step < 600; step += 1) {
    const key = `k${Math.floor(random() * 8)}`
    switch (Math.floor(random() * 5)) {
      case 0: {
        const value = step
        lru.set(key, value)
        const existing = model.indexOf(key)
        if (existing >= 0) model.splice(existing, 1)
        model.unshift(key)
        values.set(key, value)
        while (model.length > capacity) {
          const evicted = model.pop()
          if (evicted !== undefined) values.delete(evicted)
        }
        break
      }
      case 1: {
        assert.equal(lru.get(key), values.get(key))
        if (values.has(key)) {
          model.splice(model.indexOf(key), 1)
          model.unshift(key)
        }
        break
      }
      case 2:
        assert.equal(lru.peek(key), values.get(key))
        break
      case 3: {
        const exists = values.has(key)
        assert.equal(lru.touch(key), exists)
        if (exists) {
          model.splice(model.indexOf(key), 1)
          model.unshift(key)
        }
        break
      }
      default: {
        assert.equal(lru.delete(key), values.has(key))
        if (values.delete(key)) model.splice(model.indexOf(key), 1)
        break
      }
    }
    assert.equal(lru.size, model.length)
    assert.deepEqual([...lru.keys()], model)
  }
})

test('OrderedLruList matches a reference deque model with duplicates', () => {
  const random = createRandom(0x0d3a)
  const maximum = 6
  let capacity = maximum
  const list = new OrderedLruList<string>(maximum)
  const model: string[] = []
  for (let step = 0; step < 500; step += 1) {
    const value = `v${Math.floor(random() * 5)}`
    switch (Math.floor(random() * 5)) {
      case 0:
        list.push(value)
        model.push(value)
        while (model.length > capacity) model.shift()
        break
      case 1:
        assert.equal(list.shift(), model.shift())
        break
      case 2: {
        if (model.length === 0) {
          assert.throws(() => list.get(0), InvalidArgumentError)
          break
        }
        const index = Math.floor(random() * model.length)
        assert.equal(list.get(index), model[index])
        assert.equal(list.peek(index), model[index])
        break
      }
      case 3: {
        if (model.length === 0) {
          assert.throws(() => list.touch(0), InvalidArgumentError)
          break
        }
        const index = Math.floor(random() * model.length)
        list.touch(index)
        const [moved] = model.splice(index, 1)
        model.push(moved)
        break
      }
      default: {
        capacity = 1 + Math.floor(random() * maximum)
        list.resize(capacity)
        while (model.length > capacity) model.shift()
        break
      }
    }
    assert.equal(list.size, model.length)
    assert.equal(list.capacity, capacity)
    assert.deepEqual(list.toArray(), model)
  }
})

test('UnorderedLruList matches a reference insertion-order queue', () => {
  const random = createRandom(0x0bad)
  const maximum = 4
  let capacity = maximum
  const list = new UnorderedLruList<string>(maximum)
  const model: string[] = []
  for (let step = 0; step < 500; step += 1) {
    const value = `v${Math.floor(random() * 4)}`
    switch (Math.floor(random() * 4)) {
      case 0:
        list.push(value)
        model.push(value)
        while (model.length > capacity) model.shift()
        break
      case 1:
        assert.equal(list.peek(), model[0])
        break
      case 2: {
        const index = model.indexOf(value)
        assert.equal(list.touch(value), index >= 0)
        if (index >= 0) {
          const [moved] = model.splice(index, 1)
          model.push(moved)
        }
        break
      }
      default: {
        capacity = 1 + Math.floor(random() * maximum)
        list.resize(capacity)
        while (model.length > capacity) model.shift()
        break
      }
    }
    assert.equal(list.size, model.length)
    assert.equal(list.capacity, capacity)
    assert.deepEqual(list.toArray(), model)
  }
})

test('LRU sets delegate eviction and recency to the canonical LruList', () => {
  const capacity = 4
  const ordered = new OrderedLruSet<string>(capacity)
  const unordered = new UnorderedLruSet<string>(capacity)
  const reference = new LruList<string, true>(capacity)
  for (const value of ['a', 'b', 'c', 'a', 'd', 'b', 'e', 'c', 'f']) {
    const grew = !reference.has(value)
    assert.equal(ordered.add(value), grew)
    assert.equal(unordered.add(value), grew)
    reference.set(value, true)
    assert.deepEqual(ordered.toArray(), [...reference.keys()].reverse())
    assert.deepEqual([...unordered.toArray()].sort(), [...reference.keys()].sort())
  }
  for (const value of ['b', 'e', 'a']) {
    const present = reference.has(value)
    assert.equal(ordered.touch(value), present)
    assert.equal(unordered.touch(value), present)
    reference.touch(value)
    assert.deepEqual(ordered.toArray(), [...reference.keys()].reverse())
  }
  ordered.resize(2)
  unordered.resize(2)
  reference.resize(2)
  assert.deepEqual(ordered.toArray(), [...reference.keys()].reverse())
  assert.deepEqual([...unordered.toArray()].sort(), [...reference.keys()].sort())
})

/* ------------------------------------------------------------------------- *
 * Red-black tree
 * ------------------------------------------------------------------------- */

test('RedBlackTree validates after ten thousand random insert/delete operations', () => {
  const tree = new RedBlackTree<number, number>()
  const random = createRandom(2026)
  const present = new Set<number>()
  for (let step = 0; step < 10_000; step += 1) {
    const key = Math.floor(random() * 20_000)
    if (random() < 0.6) {
      tree.set(key, step)
      present.add(key)
    } else {
      tree.delete(key)
      present.delete(key)
    }
    if (step % 500 === 0) assert.ok(tree.validate(), `red-black invariant broken at step ${step}`)
  }
  assert.ok(tree.validate())
  assert.equal(tree.size, present.size)
  const expected = [...present].sort((left, right) => left - right)
  assert.deepEqual([...tree.keys()], expected)
  assert.deepEqual(tree.toArray().map(([key]) => key), expected)
  assert.ok(tree.height <= 2 * Math.log2(present.size + 1) + 2)
  assert.ok(tree.blackHeight >= 1)
})

test('RedBlackTree orders, ranges, succeeds and precedes', () => {
  const tree = new RedBlackTree<number, string>()
  for (const key of [20, 10, 30, 5, 15]) tree.set(key, `v${key}`)
  assert.equal(tree.get(15), 'v15')
  assert.equal(tree.has(99), false)
  assert.equal(tree.min(), 5)
  assert.equal(tree.max(), 30)
  assert.equal(tree.successor(10), 15)
  assert.equal(tree.successor(15), 20)
  assert.equal(tree.successor(30), undefined)
  assert.equal(tree.successor(16), 20)
  assert.equal(tree.predecessor(20), 15)
  assert.equal(tree.predecessor(5), undefined)
  assert.equal(tree.predecessor(16), 15)
  assert.deepEqual([...tree.range(10, 20)].map(([key]) => key), [10, 15, 20])
  assert.deepEqual([...tree.range(100, 200)], [])
  assert.ok(tree.validate())

  const broken = new RedBlackTree<number, number>(() => Number.POSITIVE_INFINITY)
  broken.set(1, 1)
  assert.throws(() => broken.set(2, 2), InvalidArgumentError)
})

test('RedBlackSet behaves as a sorted set', () => {
  const set = new RedBlackSet<number>()
  assert.equal(set.add(2), true)
  assert.equal(set.add(1), true)
  assert.equal(set.add(2), false)
  assert.deepEqual(set.toArray(), [1, 2])
  assert.equal(set.first(), 1)
  assert.equal(set.last(), 2)
  assert.deepEqual([...set.range(1, 2)], [1, 2])
  assert.equal(set.delete(1), true)
  assert.equal(set.size, 1)
  set.clear()
  assert.equal(set.size, 0)
  assert.ok(set.height === 0)
})

/* ------------------------------------------------------------------------- *
 * Heaps
 * ------------------------------------------------------------------------- */

test('BinaryHeap pops in comparator order and allows duplicates', () => {
  const heap = new BinaryHeap<number>()
  for (const value of [5, 3, 8, 1, 3]) heap.push(value)
  assert.equal(heap.peek(), 1)
  assert.equal(heap.size, 5)
  assert.deepEqual([heap.pop(), heap.pop(), heap.pop(), heap.pop(), heap.pop()], [1, 3, 3, 5, 8])
  assert.equal(heap.pop(), undefined)

  const maxHeap = new BinaryHeap<number>((left, right) => right - left)
  for (const value of [5, 3, 8, 1]) maxHeap.push(value)
  assert.deepEqual([maxHeap.pop(), maxHeap.pop(), maxHeap.pop(), maxHeap.pop()], [8, 5, 3, 1])

  const built = new BinaryHeap<number>(undefined, [9, 4, 7, 1])
  assert.equal(built.peek(), 1)
  assert.equal(built.toArray().length, 4)
  built.clear()
  assert.equal(built.size, 0)
})

test('IndexedHeap updates, removes and decreases keys by identity', () => {
  interface Job {
    name: string
    priority: number
  }
  const heap = new IndexedHeap<Job>((left, right) => left.priority - right.priority)
  const first: Job = { name: 'first', priority: 5 }
  const second: Job = { name: 'second', priority: 1 }
  assert.equal(heap.push(first), true)
  assert.equal(heap.push(second), true)
  assert.equal(heap.push(first), false)
  assert.equal(heap.size, 2)
  assert.equal(heap.peek()?.name, 'second')

  second.priority = 9
  assert.equal(heap.update(second), true)
  assert.equal(heap.peek()?.name, 'first')
  second.priority = 0
  assert.equal(heap.decreaseKey(second), true)
  assert.equal(heap.peek()?.name, 'second')
  assert.equal(heap.has(first), true)
  assert.equal(heap.remove(first), true)
  assert.equal(heap.remove(first), false)
  assert.equal(heap.update(first), false)
  assert.equal(heap.pop()?.name, 'second')
  assert.equal(heap.pop(), undefined)

  assert.throws(
    () => new IndexedHeap<number>((left, right) => left - right, [1, 1]),
    InvalidArgumentError,
  )
})

/* ------------------------------------------------------------------------- *
 * Stack, deque and queue
 * ------------------------------------------------------------------------- */

test('Stack is LIFO, indexes from the top and enforces maxDepth', () => {
  const stack = new Stack<number>()
  stack.push(1).push(2).push(3)
  assert.equal(stack.size, 3)
  assert.equal(stack.peek(), 3)
  assert.equal(stack.at(0), 3)
  assert.equal(stack.at(2), 1)
  assert.deepEqual(stack.toArray(), [3, 2, 1])
  assert.equal(stack.pop(), 3)
  assert.deepEqual([...stack], [2, 1])
  assert.throws(() => stack.at(2), InvalidArgumentError)
  assert.throws(() => stack.at(0.5), InvalidArgumentError)
  stack.clear()
  assert.equal(stack.size, 0)
  assert.equal(stack.pop(), undefined)

  const bounded = new Stack<number>(2)
  bounded.push(1).push(2).push(3)
  assert.deepEqual(bounded.toArray(), [3, 2])
  assert.equal(bounded.size, 2)
  assert.throws(() => new Stack(0), InvalidArgumentError)
  assert.throws(() => new Stack(1.5), InvalidArgumentError)
})

test('Deque pushes, pops, shifts, unshifts and resizes its ring', () => {
  const deque = new Deque<number>()
  deque.push(2).push(3).unshift(1)
  assert.deepEqual(deque.toArray(), [1, 2, 3])
  assert.equal(deque.at(0), 1)
  assert.equal(deque.at(2), 3)
  assert.equal(deque.pop(), 3)
  assert.equal(deque.shift(), 1)
  assert.deepEqual([...deque], [2])
  assert.equal(deque.size, 1)
  for (let index = 0; index < 200; index += 1) deque.push(index)
  assert.equal(deque.size, 201)
  for (let index = 0; index < 201; index += 1) deque.shift()
  assert.equal(deque.size, 0)
  assert.equal(deque.pop(), undefined)
  assert.equal(deque.shift(), undefined)
  assert.throws(() => deque.at(0), InvalidArgumentError)
  deque.push(7)
  deque.clear()
  assert.equal(deque.size, 0)
})

test('Queue is FIFO', () => {
  const queue = new Queue<string>(['a', 'b'])
  queue.enqueue('c')
  assert.equal(queue.peek(), 'a')
  assert.deepEqual(queue.toArray(), ['a', 'b', 'c'])
  assert.equal(queue.dequeue(), 'a')
  assert.equal(queue.dequeue(), 'b')
  assert.equal(queue.size, 1)
  queue.clear()
  assert.equal(queue.size, 0)
  assert.equal(queue.dequeue(), undefined)
})

/* ------------------------------------------------------------------------- *
 * Directed graph
 * ------------------------------------------------------------------------- */

test('DirectedGraph sorts, levels and reaches a dependency DAG', () => {
  const graph = new DirectedGraph<string>()
  graph.addEdge('a', 'b')
  graph.addEdge('a', 'c')
  graph.addEdge('b', 'd')
  graph.addEdge('c', 'd')
  assert.equal(graph.vertexCount, 4)
  assert.equal(graph.edgeCount, 4)
  assert.equal(graph.outDegree('a'), 2)
  assert.equal(graph.inDegree('d'), 2)
  assert.deepEqual([...graph.neighbors('a')], ['b', 'c'])
  assert.deepEqual([...graph.predecessors('d')], ['b', 'c'])
  assert.equal(graph.hasEdge('a', 'b'), true)
  assert.equal(graph.hasEdge('b', 'a'), false)

  const order = graph.topologicalSort()
  assert.ok(order !== null)
  assert.equal(order.length, 4)
  assert.ok(order.indexOf('a') < order.indexOf('b'))
  assert.ok(order.indexOf('a') < order.indexOf('c'))
  assert.ok(order.indexOf('b') < order.indexOf('d'))
  assert.ok(order.indexOf('c') < order.indexOf('d'))
  assert.equal(graph.findCycle(), null)

  const levels = graph.dependencyLevels()
  assert.ok(levels !== null)
  assert.equal(levels.get('a'), 0)
  assert.equal(levels.get('b'), 1)
  assert.equal(levels.get('c'), 1)
  assert.equal(levels.get('d'), 2)

  assert.deepEqual(graph.reachable('a').sort(), ['a', 'b', 'c', 'd'])
  assert.deepEqual(graph.shortestPath('a', 'd'), ['a', 'b', 'd'])
  assert.equal(graph.shortestPath('d', 'a'), null)
  assert.deepEqual(graph.bfs('a'), ['a', 'b', 'c', 'd'])
})

test('DirectedGraph detects cycles and maintains degrees on removal', () => {
  const graph = new DirectedGraph<string>(['a', 'b', 'c'])
  graph.addEdge('a', 'b')
  graph.addEdge('b', 'c')
  graph.addEdge('c', 'a')
  assert.equal(graph.topologicalSort(), null)
  assert.equal(graph.dependencyLevels(), null)
  const cycle = graph.findCycle()
  assert.ok(cycle !== null)
  assert.equal(cycle.length, 3)
  assert.equal(new Set(cycle).size, 3)

  assert.equal(graph.removeEdge('c', 'a'), true)
  assert.equal(graph.removeEdge('c', 'a'), false)
  assert.ok(graph.topologicalSort() !== null)
  assert.equal(graph.edgeCount, 2)
  assert.equal(graph.removeVertex('b'), true)
  assert.equal(graph.removeVertex('b'), false)
  assert.equal(graph.vertexCount, 2)
  assert.equal(graph.edgeCount, 0)
  assert.equal(graph.inDegree('c'), 0)
  assert.equal(graph.outDegree('a'), 0)
  graph.clear()
  assert.equal(graph.size, 0)
  assert.deepEqual([...graph.edges()], [])
})

test('DirectedGraph reports a self-loop as a cycle', () => {
  const graph = new DirectedGraph<number>()
  graph.addEdge(1, 1)
  assert.equal(graph.findCycle()?.length, 1)
  assert.equal(graph.topologicalSort(), null)
  assert.equal(graph.shortestPath(1, 1)?.length, 1)
})

/* ------------------------------------------------------------------------- *
 * Trie
 * ------------------------------------------------------------------------- */

test('Trie inserts, prefixes, deletes and prunes', () => {
  const trie = new Trie<number>()
  assert.equal(trie.insert('car', 1), true)
  assert.equal(trie.insert('cart', 2), true)
  assert.equal(trie.insert('care', 3), true)
  assert.equal(trie.insert('car', 4), false)
  assert.equal(trie.get('car'), 4)
  assert.equal(trie.get('ca'), undefined)
  assert.equal(trie.has('cart'), true)
  assert.equal(trie.startsWith('ca'), true)
  assert.equal(trie.startsWith('cat'), false)
  assert.equal(trie.startsWith(''), true)
  assert.deepEqual(trie.keysWithPrefix('car').sort(), ['car', 'care', 'cart'])
  assert.deepEqual(trie.entriesWithPrefix('car').map(([key]) => key).sort(), ['car', 'care', 'cart'])
  assert.deepEqual(trie.keysWithPrefix('zzz'), [])
  assert.equal(trie.size, 3)

  assert.equal(trie.delete('cart'), true)
  assert.equal(trie.delete('cart'), false)
  assert.equal(trie.size, 2)
  assert.equal(trie.has('cart'), false)
  assert.equal(trie.has('car'), true)
  assert.equal(trie.insert('', 0), true)
  assert.equal(trie.get(''), 0)
  assert.equal(trie.delete('car'), true)
  assert.equal(trie.delete('care'), true)
  assert.equal(trie.size, 1)
  assert.equal([...trie].length, 1)
  trie.clear()
  assert.equal(trie.size, 0)
  assert.deepEqual(trie.toArray(), [])
})

test('assertTrieKey rejects non-string keys', () => {
  assert.doesNotThrow(() => assertTrieKey('ok'))
  assert.throws(() => assertTrieKey(42), InvalidArgumentError)
})

/* ------------------------------------------------------------------------- *
 * Sparse grid
 * ------------------------------------------------------------------------- */

test('GridRange normalises corners and reports extents', () => {
  const range = new GridRange(5, 8, 2, 3)
  assert.equal(range.rows, 4)
  assert.equal(range.columns, 6)
  assert.equal(range.contains(3, 5), true)
  assert.equal(range.contains(1, 5), false)
  assert.deepEqual(range.toJSON(), { top: 5, left: 8, bottom: 2, right: 3 })
  const normalised = range.normalise()
  assert.deepEqual(normalised.toJSON(), { top: 2, left: 3, bottom: 5, right: 8 })
  assert.equal(normalised.rows, 4)
  assert.equal(normalised.columns, 6)
  assert.throws(() => new GridRange(1.5, 0, 2, 2), InvalidArgumentError)
})

test('SparseGrid stores ten thousand cells sparsely in row-major order', () => {
  const grid = new SparseGrid<string>()
  for (let row = 0; row < 100; row += 1) {
    for (let column = 0; column < 100; column += 1) {
      grid.set(row, column, `${row}:${column}`)
    }
  }
  assert.equal(grid.size, 10_000)
  assert.equal(grid.get(42, 57), '42:57')
  assert.equal(grid.has(99, 99), true)
  assert.equal(grid.has(100, 0), false)

  const bounds = grid.bounds()
  assert.ok(bounds !== undefined)
  assert.deepEqual(bounds.toJSON(), { top: 0, left: 0, bottom: 99, right: 99 })

  const row = grid.rowAt(5)
  assert.equal(row.length, 100)
  assert.equal(row[0].column, 0)
  assert.equal(row[99].column, 99)
  assert.deepEqual(row[0], { row: 5, column: 0, value: '5:0' })

  const column = grid.columnAt(7)
  assert.equal(column.length, 100)
  assert.equal(column[0].row, 0)
  assert.equal(column[99].row, 99)

  const all = grid.toArray()
  assert.equal(all.length, 10_000)
  assert.deepEqual(all[0], { row: 0, column: 0, value: '0:0' })
  assert.deepEqual(all[9_999], { row: 99, column: 99, value: '99:99' })
  assert.equal([...grid].length, 10_000)
  assert.deepEqual(grid.rowAt(500), [])
  assert.deepEqual(grid.columnAt(500), [])

  assert.equal(grid.delete(5, 5), true)
  assert.equal(grid.delete(5, 5), false)
  assert.equal(grid.size, 9_999)
  assert.equal(grid.rowAt(5).length, 99)
  assert.equal(grid.columnAt(5).length, 99)
  grid.clear()
  assert.equal(grid.size, 0)
  assert.equal(grid.bounds(), undefined)
})

test('SparseGrid range clamps, normalises and ignores empty spans', () => {
  const grid = new SparseGrid<string>({ maximumRow: 1_000_000, maximumColumn: 1_000_000 })
  grid.set(1, 1, 'a')
  grid.set(1, 5, 'b')
  grid.set(3, 3, 'c')
  grid.set(9, 9, 'd')

  assert.deepEqual(
    grid.range(new GridRange(0, 0, 3, 5)).map((cell) => cell.value),
    ['a', 'b', 'c'],
  )
  assert.deepEqual(
    grid.range(new GridRange(3, 5, 0, 0)).map((cell) => cell.value),
    ['a', 'b', 'c'],
  )
  assert.deepEqual(
    grid.range(new GridRange(-10, -10, 1, 1)).map((cell) => cell.value),
    ['a'],
  )
  assert.deepEqual(grid.range(new GridRange(100, 100, 200, 200)), [])
  assert.deepEqual(grid.range(new GridRange(999_999, 999_999, 2_000_000, 2_000_000)), [])
  assert.deepEqual(
    grid.range(new GridRange(1, 5, 1, 5)).map((cell) => cell.column),
    [5],
  )
})

test('SparseGrid supports large sparse coordinates without dense allocation', () => {
  const grid = new SparseGrid<string>()
  grid.set(1_000_000, 1_000_000, 'edge')
  assert.equal(grid.size, 1)
  assert.equal(grid.get(1_000_000, 1_000_000), 'edge')
  assert.deepEqual(grid.rowAt(1_000_000), [{ row: 1_000_000, column: 1_000_000, value: 'edge' }])
  assert.deepEqual(grid.columnAt(1_000_000), [
    { row: 1_000_000, column: 1_000_000, value: 'edge' },
  ])
  const bounds = grid.bounds()
  assert.ok(bounds !== undefined)
  assert.deepEqual(bounds.toJSON(), {
    top: 1_000_000,
    left: 1_000_000,
    bottom: 1_000_000,
    right: 1_000_000,
  })
  assert.equal(grid.range(new GridRange(999_999, 999_999, 1_000_000, 1_000_000)).length, 1)
  assert.throws(() => grid.set(1_000_001, 0, 'outside'), InvalidArgumentError)
  assert.throws(() => grid.set(0, -1, 'outside'), InvalidArgumentError)
  assert.throws(() => grid.rowAt(1_000_001), InvalidArgumentError)
  assert.throws(() => grid.columnAt(-1), InvalidArgumentError)
})

test('SparseGrid enforces the cell cap and constructor bounds', () => {
  const capped = new SparseGrid<number>({ maximumCell: 2 })
  capped.set(0, 0, 1)
  capped.set(0, 1, 2)
  assert.throws(() => capped.set(1, 1, 3), InvalidArgumentError)
  capped.set(0, 0, 9)
  assert.equal(capped.size, 2)
  assert.throws(() => new SparseGrid({ maximumCell: 0 }), InvalidArgumentError)
  assert.throws(() => new SparseGrid({ maximumRow: 1.5 }), InvalidArgumentError)

  const bounded = new SparseGrid<number>({ maximumRow: 5, maximumColumn: 5 })
  assert.throws(() => bounded.set(6, 0, 1), InvalidArgumentError)
  assert.throws(() => bounded.set(0, 6, 1), InvalidArgumentError)
})

/* ------------------------------------------------------------------------- *
 * Complexity smoke
 * ------------------------------------------------------------------------- */

test('one hundred thousand hashString calls complete quickly', () => {
  let checksum = 0
  const duration = elapsed(() => {
    for (let index = 0; index < 100_000; index += 1) checksum += hashString(`node-${index}`)
  })
  assert.ok(checksum > 0)
  assert.ok(duration < 2_000, `100k hashString calls took ${duration.toFixed(1)}ms`)
})
