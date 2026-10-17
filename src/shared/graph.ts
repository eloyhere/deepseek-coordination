/**
 * Directed dependency graph: the primitive under import graphs, dependency
 * parsing, task DAGs and any "what must come before what" question.
 *
 * Vertices are insertion-ordered (`Map` keys) and adjacency sets preserve edge
 * insertion order, so every traversal is deterministic for a given build
 * sequence. Edges carry no weight: `shortestPath` is BFS in edge count.
 *
 * Complexity for V vertices and E edges: adjacency lookup and degree are O(1)
 * average; `topologicalSort`, `findCycle`, `bfs`, `reachable`,
 * `dependencyLevels` and `shortestPath` are O(V + E) time and O(V) space;
 * `removeVertex` is O(degree) and `removeEdge`/`addEdge` are O(1) average.
 * Edges are stored twice (outgoing and incoming), so space is O(V + E).
 *
 * No Node, DOM, React or external dependency is used.
 */

/** Empty iterator returned for a missing vertex; a fresh generator per call. */
function* iterateNothing(): IterableIterator<never> {
  // Intentionally empty.
}

/**
 * A directed multigraph-free graph: at most one edge per ordered vertex pair.
 *
 * `addEdge` auto-creates missing endpoints. Self-loops are allowed and are
 * reported as cycles by the cycle/topological helpers rather than rejected, so
 * a caller can build the graph first and diagnose it second. `size` counts
 * vertices; use `edgeCount` for edges.
 */
export class DirectedGraph<T> implements Iterable<T> {
  private readonly outgoing = new Map<T, Set<T>>()
  private readonly incoming = new Map<T, Set<T>>()
  private edgeTotal = 0

  /**
   * @param vertices Optional initial vertices, in insertion order.
   * @param edges Optional initial edges; missing endpoints are auto-created.
   * Time O(V + E), space O(V + E).
   */
  constructor(vertices?: Iterable<T>, edges?: Iterable<readonly [T, T]>) {
    if (vertices !== undefined) {
      for (const vertex of vertices) this.addVertex(vertex)
    }
    if (edges !== undefined) {
      for (const [from, to] of edges) this.addEdge(from, to)
    }
  }

  /** Number of vertices (`size` is vertex count for this graph). Time O(1). */
  get size(): number {
    return this.outgoing.size
  }

  /** Number of vertices. Time O(1). */
  get vertexCount(): number {
    return this.outgoing.size
  }

  /** Number of edges. Time O(1). */
  get edgeCount(): number {
    return this.edgeTotal
  }

  /**
   * Add a vertex. Time O(1) average, space O(1).
   * Returns true when the vertex was not already present.
   */
  addVertex(vertex: T): boolean {
    if (this.outgoing.has(vertex)) return false
    this.outgoing.set(vertex, new Set<T>())
    this.incoming.set(vertex, new Set<T>())
    return true
  }

  /**
   * Add an edge, creating either endpoint that is missing.
   * Time O(1) average, space O(1). Returns true when the edge was new.
   */
  addEdge(from: T, to: T): boolean {
    this.addVertex(from)
    this.addVertex(to)
    const targets = this.outgoing.get(from)
    const sources = this.incoming.get(to)
    if (targets === undefined || sources === undefined) return false
    if (targets.has(to)) return false
    targets.add(to)
    sources.add(from)
    this.edgeTotal += 1
    return true
  }

  /**
   * Remove an edge if present. Time O(1) average, space O(1).
   * Returns false when the edge does not exist.
   */
  removeEdge(from: T, to: T): boolean {
    const targets = this.outgoing.get(from)
    if (targets === undefined || !targets.delete(to)) return false
    const sources = this.incoming.get(to)
    if (sources !== undefined) sources.delete(from)
    this.edgeTotal -= 1
    return true
  }

  /**
   * Remove a vertex and every incident edge. Time O(degree), space O(1).
   * Returns false when the vertex is absent.
   */
  removeVertex(vertex: T): boolean {
    const targets = this.outgoing.get(vertex)
    if (targets === undefined) return false
    for (const target of targets) {
      const sources = this.incoming.get(target)
      if (sources !== undefined) sources.delete(vertex)
      this.edgeTotal -= 1
    }
    const sources = this.incoming.get(vertex)
    if (sources !== undefined) {
      for (const source of sources) {
        if (source === vertex) continue
        const targetsOfSource = this.outgoing.get(source)
        if (targetsOfSource !== undefined) targetsOfSource.delete(vertex)
        this.edgeTotal -= 1
      }
    }
    this.outgoing.delete(vertex)
    this.incoming.delete(vertex)
    if (this.edgeTotal < 0) this.edgeTotal = 0
    return true
  }

  /** Whether an ordered edge exists. Time O(1) average, space O(1). */
  hasEdge(from: T, to: T): boolean {
    return this.outgoing.get(from)?.has(to) === true
  }

  /** Whether a vertex exists. Time O(1) average, space O(1). */
  hasVertex(vertex: T): boolean {
    return this.outgoing.has(vertex)
  }

  /**
   * Outgoing neighbours in edge insertion order; an empty iterator for a
   * missing vertex. Time O(1) to obtain, O(degree) to exhaust.
   */
  neighbors(vertex: T): IterableIterator<T> {
    return this.outgoing.get(vertex)?.values() ?? iterateNothing()
  }

  /**
   * Incoming neighbours in edge insertion order; an empty iterator for a
   * missing vertex. Time O(1) to obtain, O(degree) to exhaust.
   */
  predecessors(vertex: T): IterableIterator<T> {
    return this.incoming.get(vertex)?.values() ?? iterateNothing()
  }

  /** Out-degree, 0 for a missing vertex. Time O(1) average. */
  outDegree(vertex: T): number {
    return this.outgoing.get(vertex)?.size ?? 0
  }

  /** In-degree, 0 for a missing vertex. Time O(1) average. */
  inDegree(vertex: T): number {
    return this.incoming.get(vertex)?.size ?? 0
  }

  /** Vertices in insertion order. Time O(V). */
  vertices(): IterableIterator<T> {
    return this.outgoing.keys()
  }

  /**
   * Edges in vertex-major insertion order. Time O(V + E), space O(1) per step.
   */
  *edges(): IterableIterator<[T, T]> {
    for (const [from, targets] of this.outgoing) {
      for (const to of targets) yield [from, to]
    }
  }

  /** Vertices in insertion order. Time O(V), space O(V). */
  toArray(): T[] {
    return [...this.outgoing.keys()]
  }

  /** Iterate vertices in insertion order. Time O(V). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.outgoing.keys()
  }

  /** Remove every vertex and edge. Time O(V + E) for reclamation. */
  clear(): void {
    this.outgoing.clear()
    this.incoming.clear()
    this.edgeTotal = 0
  }

  /**
   * Kahn topological order, deterministic: sources are emitted in insertion
   * order and newly freed vertices are appended in edge order.
   * Time O(V + E), space O(V). Returns null when the graph has a cycle.
   */
  topologicalSort(): T[] | null {
    const remaining = new Map<T, number>()
    for (const [vertex, sources] of this.incoming) remaining.set(vertex, sources.size)
    const queue: T[] = []
    for (const [vertex, degree] of remaining) {
      if (degree === 0) queue.push(vertex)
    }
    const order: T[] = []
    let cursor = 0
    while (cursor < queue.length) {
      const vertex = queue[cursor]
      cursor += 1
      order.push(vertex)
      for (const target of this.neighbors(vertex)) {
        const degree = remaining.get(target)
        if (degree === undefined) continue
        const next = degree - 1
        remaining.set(target, next)
        if (next === 0) queue.push(target)
      }
    }
    return order.length === this.outgoing.size ? order : null
  }

  /**
   * Find one directed cycle with iterative DFS.
   * Time O(V + E), space O(V). Returns vertices in traversal order without
   * repeating the first, so `[a, b, c]` means `a -> b -> c -> a`; returns null
   * when the graph is acyclic.
   */
  findCycle(): T[] | null {
    const color = new Map<T, 'white' | 'gray' | 'black'>()
    for (const vertex of this.outgoing.keys()) color.set(vertex, 'white')
    for (const start of this.outgoing.keys()) {
      if (color.get(start) !== 'white') continue
      const parents = new Map<T, T | undefined>()
      parents.set(start, undefined)
      color.set(start, 'gray')
      const stack: Array<{ vertex: T; neighbors: T[]; next: number }> = []
      const neighbors = [...this.neighbors(start)]
      stack.push({ vertex: start, neighbors, next: 0 })
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]
        if (frame.next >= frame.neighbors.length) {
          color.set(frame.vertex, 'black')
          stack.pop()
          continue
        }
        const target = frame.neighbors[frame.next]
        frame.next += 1
        const targetColor = color.get(target)
        if (targetColor === 'white') {
          parents.set(target, frame.vertex)
          color.set(target, 'gray')
          stack.push({ vertex: target, neighbors: [...this.neighbors(target)], next: 0 })
          continue
        }
        if (targetColor === 'gray') {
          const cycle: T[] = []
          let cursor: T | undefined = frame.vertex
          while (cursor !== undefined && cursor !== target) {
            cycle.push(cursor)
            cursor = parents.get(cursor)
          }
          if (cursor === undefined) continue
          cycle.push(target)
          cycle.reverse()
          return cycle
        }
      }
    }
    return null
  }

  /**
   * Vertices reachable from `start` (including `start`) in BFS discovery order.
   * Time O(V + E), space O(V). Empty when `start` is absent.
   */
  reachable(start: T): T[] {
    return this.bfs(start)
  }

  /**
   * Breadth-first traversal order from `start`, including `start`.
   * Time O(V + E), space O(V). Empty when `start` is absent.
   */
  bfs(start: T): T[] {
    if (!this.outgoing.has(start)) return []
    const visited = new Set<T>([start])
    const order: T[] = [start]
    let cursor = 0
    while (cursor < order.length) {
      const vertex = order[cursor]
      cursor += 1
      for (const target of this.neighbors(vertex)) {
        if (visited.has(target)) continue
        visited.add(target)
        order.push(target)
      }
    }
    return order
  }

  /**
   * Shortest unweighted path from `from` to `to`, inclusive, or null when no
   * path exists. Time O(V + E), space O(V).
   */
  shortestPath(from: T, to: T): T[] | null {
    if (!this.outgoing.has(from) || !this.outgoing.has(to)) return null
    if (from === to) return [from]
    const parents = new Map<T, T | undefined>()
    parents.set(from, undefined)
    const queue: T[] = [from]
    let cursor = 0
    while (cursor < queue.length) {
      const vertex = queue[cursor]
      cursor += 1
      for (const target of this.neighbors(vertex)) {
        if (parents.has(target)) continue
        parents.set(target, vertex)
        if (target === to) {
          const path: T[] = [to]
          let step: T | undefined = vertex
          while (step !== undefined) {
            path.push(step)
            step = parents.get(step)
          }
          path.reverse()
          return path
        }
        queue.push(target)
      }
    }
    return null
  }

  /**
   * Longest-path level per vertex (sources are level 0) via Kahn's algorithm.
   * Time O(V + E), space O(V). Returns null when the graph has a cycle.
   */
  dependencyLevels(): Map<T, number> | null {
    const remaining = new Map<T, number>()
    for (const [vertex, sources] of this.incoming) remaining.set(vertex, sources.size)
    const levels = new Map<T, number>()
    const queue: T[] = []
    for (const [vertex, degree] of remaining) {
      if (degree === 0) {
        levels.set(vertex, 0)
        queue.push(vertex)
      }
    }
    let cursor = 0
    let processed = 0
    while (cursor < queue.length) {
      const vertex = queue[cursor]
      cursor += 1
      processed += 1
      const level = levels.get(vertex) ?? 0
      for (const target of this.neighbors(vertex)) {
        const current = levels.get(target)
        if (current === undefined || level + 1 > current) levels.set(target, level + 1)
        const degree = remaining.get(target)
        if (degree === undefined) continue
        const next = degree - 1
        remaining.set(target, next)
        if (next === 0) queue.push(target)
      }
    }
    if (processed !== this.outgoing.size) return null
    const ordered = new Map<T, number>()
    for (const vertex of this.outgoing.keys()) {
      const level = levels.get(vertex)
      if (level !== undefined) ordered.set(vertex, level)
    }
    return ordered
  }
}
