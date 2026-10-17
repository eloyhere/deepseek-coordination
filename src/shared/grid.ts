/**
 * Sparse sheet storage for grid-shaped UI surfaces.
 *
 * A grid is addressed by `(row, column)` pairs and stores only the cells that
 * exist. There is no dense backing array: a spreadsheet with two occupied cells
 * at `(0, 0)` and `(1_000_000, 1_000_000)` costs two entries, not a trillion
 * slots. Rows and columns are bounded by constructor options so a typo cannot
 * create an unbounded coordinate; range queries clamp to those bounds instead of
 * throwing because a query outside the sheet is naturally empty.
 *
 * Rows are the primary index (`Map<row, Map<column, T>>`) and a secondary
 * `Map<column, Set<row>>` index makes column projection cheap. Iteration is
 * deterministic row-major, with columns ascending inside each row.
 *
 * No Node, DOM, React or external dependency is used.
 */
import { InvalidArgumentError } from './error.js'

/** Default inclusive maximum row coordinate. */
const DefaultMaximumRow = 1_000_000

/** Default inclusive maximum column coordinate. */
const DefaultMaximumColumn = 1_000_000

/** Default maximum number of stored cells. */
const DefaultMaximumCell = 1_000_000

/**
 * A rectangular grid range. `top`/`left` are inclusive, `bottom`/`right` are
 * inclusive; the constructor accepts inverted corners and `normalise()` puts
 * them in order.
 *
 * `rows` and `columns` are O(1) extents of the normalised range, `contains` is
 * O(1), and `normalise` allocates one new range in O(1) time and space.
 */
export class GridRange {
  /** Inclusive top row. */
  readonly top: number
  /** Inclusive left column. */
  readonly left: number
  /** Inclusive bottom row. */
  readonly bottom: number
  /** Inclusive right column. */
  readonly right: number

  /**
   * @param top First row corner, any safe integer.
   * @param left First column corner, any safe integer.
   * @param bottom Second row corner, any safe integer.
   * @param right Second column corner, any safe integer.
   * Time O(1), space O(1). Throws `InvalidArgumentError` for non-integer
   * corners; inverted corners are legal until normalised.
   */
  constructor(top: number, left: number, bottom: number, right: number) {
    assertCoordinate(top, 'top')
    assertCoordinate(left, 'left')
    assertCoordinate(bottom, 'bottom')
    assertCoordinate(right, 'right')
    this.top = top
    this.left = left
    this.bottom = bottom
    this.right = right
  }

  /** Number of normalised rows; at least 1. Time O(1). */
  get rows(): number {
    return Math.abs(this.bottom - this.top) + 1
  }

  /** Number of normalised columns; at least 1. Time O(1). */
  get columns(): number {
    return Math.abs(this.right - this.left) + 1
  }

  /** Whether the normalised range includes `(row, column)`. Time O(1). */
  contains(row: number, column: number): boolean {
    const top = Math.min(this.top, this.bottom)
    const bottom = Math.max(this.top, this.bottom)
    const left = Math.min(this.left, this.right)
    const right = Math.max(this.left, this.right)
    return row >= top && row <= bottom && column >= left && column <= right
  }

  /**
   * A new range with the corners sorted. Time O(1), space O(1).
   * The source range is not modified.
   */
  normalise(): GridRange {
    return new GridRange(
      Math.min(this.top, this.bottom),
      Math.min(this.left, this.right),
      Math.max(this.top, this.bottom),
      Math.max(this.left, this.right),
    )
  }

  /** Plain-object projection, useful for JSON and tests. Time O(1). */
  toJSON(): { top: number; left: number; bottom: number; right: number } {
    return { top: this.top, left: this.left, bottom: this.bottom, right: this.right }
  }
}

/** One occupied cell returned by grid projections and range scans. */
export interface GridCell<T> {
  row: number
  column: number
  value: T
}

/** Constructor options for `SparseGrid`; every field has a bounded default. */
export interface SparseGridOptions {
  /** Inclusive maximum row; defaults to 1,000,000. */
  maximumRow?: number
  /** Inclusive maximum column; defaults to 1,000,000. */
  maximumColumn?: number
  /** Maximum stored cells; defaults to 1,000,000. */
  maximumCell?: number
}

/**
 * A sparse, bounded, row-major grid.
 *
 * Complexity (n stored cells, r rows touched, c columns touched):
 *  - `set`/`get`/`has`/`delete`: O(1) average time and space.
 *  - `rowAt(row)`: O(k log k) for k cells in the row because columns are sorted
 *    for deterministic output; `columnAt(column)` is O(k log k) for k cells in
 *    the column.
 *  - `range`: O(r + R + k log k), where r is the number of occupied rows in the
 *    whole sheet, R is the number of occupied cells in the spanned rows and k is
 *    the number returned; empty row/column gaps are never iterated, so a range
 *    spanning a million empty rows stays cheap. The row index is an unsorted
 *    `Map`, so `range` does filter every occupied row even those outside the
 *    vertical span; a red-black row index would remove that scan if profiling
 *    ever demands it.
 *  - `bounds`: O(n); `toArray`/iteration: O(n log n) for deterministic
 *    row-major order; `size`/`clear` are O(1)/O(n) for reclamation.
 *  - Space: O(n) plus the secondary column index.
 *
 * Coordinate validation throws `InvalidArgumentError` outside the configured
 * bounds or past the cell cap. `range` normalises inverted corners and clamps
 * to the sheet bounds instead of throwing (a query beyond the sheet is empty).
 */
export class SparseGrid<T> implements Iterable<GridCell<T>> {
  private readonly cells = new Map<number, Map<number, T>>()
  private readonly columnRows = new Map<number, Set<number>>()
  private readonly maximumRow: number
  private readonly maximumColumn: number
  private readonly maximumCell: number
  private count = 0

  /**
   * @param options Bounds and cell cap; omitted fields use the defaults.
   * Time O(1), space O(1). Throws `InvalidArgumentError` for a non-integer or
   * non-positive bound.
   */
  constructor(options: SparseGridOptions = {}) {
    this.maximumRow = normaliseBound(options.maximumRow, DefaultMaximumRow, 'maximumRow')
    this.maximumColumn = normaliseBound(
      options.maximumColumn,
      DefaultMaximumColumn,
      'maximumColumn',
    )
    this.maximumCell = normaliseBound(options.maximumCell, DefaultMaximumCell, 'maximumCell')
  }

  /** Number of stored cells. Time O(1). */
  get size(): number {
    return this.count
  }

  /** Maximum row coordinate. Time O(1). */
  get rowLimit(): number {
    return this.maximumRow
  }

  /** Maximum column coordinate. Time O(1). */
  get columnLimit(): number {
    return this.maximumColumn
  }

  /** Maximum stored cells. Time O(1). */
  get cellLimit(): number {
    return this.maximumCell
  }

  /**
   * Store a cell, replacing an existing value.
   * Time O(1) average, space O(1) for a new cell. Throws `InvalidArgumentError`
   * for a coordinate outside the configured bounds or a new cell past the cap.
   */
  set(row: number, column: number, value: T): this {
    this.assertCellCoordinate(row, column)
    const columns = this.cells.get(row)
    if (columns === undefined) {
      if (this.count >= this.maximumCell) {
        throw new InvalidArgumentError('sparse grid cell cap reached', {
          maximumCell: this.maximumCell,
        })
      }
      const created = new Map<number, T>()
      created.set(column, value)
      this.cells.set(row, created)
      this.addColumnRow(column, row)
      this.count += 1
      return this
    }
    if (!columns.has(column)) {
      if (this.count >= this.maximumCell) {
        throw new InvalidArgumentError('sparse grid cell cap reached', {
          maximumCell: this.maximumCell,
        })
      }
      this.addColumnRow(column, row)
      this.count += 1
    }
    columns.set(column, value)
    return this
  }

  /** Read a cell. Time O(1) average, space O(1). */
  get(row: number, column: number): T | undefined {
    return this.cells.get(row)?.get(column)
  }

  /** Whether a cell exists. Time O(1) average, space O(1). */
  has(row: number, column: number): boolean {
    return this.cells.get(row)?.has(column) === true
  }

  /**
   * Remove a cell. Time O(1) average, space O(1).
   * Returns false when the cell is absent.
   */
  delete(row: number, column: number): boolean {
    const columns = this.cells.get(row)
    if (columns === undefined || !columns.delete(column)) return false
    this.count -= 1
    const rows = this.columnRows.get(column)
    if (rows !== undefined) {
      rows.delete(row)
      if (rows.size === 0) this.columnRows.delete(column)
    }
    if (columns.size === 0) this.cells.delete(row)
    return true
  }

  /** Remove every cell. Time O(n) for reclamation, space O(1). */
  clear(): void {
    this.cells.clear()
    this.columnRows.clear()
    this.count = 0
  }

  /**
   * Cells in one row, sorted by column. Time O(k log k) for k cells, space
   * O(k). Throws `InvalidArgumentError` for a row outside the configured bound.
   */
  rowAt(row: number): Array<GridCell<T>> {
    this.assertCellCoordinate(row, 0)
    const columns = this.cells.get(row)
    if (columns === undefined) return []
    const cells: Array<GridCell<T>> = []
    for (const [column, value] of columns) cells.push({ row, column, value })
    cells.sort((left, right) => left.column - right.column)
    return cells
  }

  /**
   * Cells in one column, sorted by row. Time O(k log k) for k cells, space
   * O(k). Throws `InvalidArgumentError` for a column outside the configured
   * bound.
   */
  columnAt(column: number): Array<GridCell<T>> {
    this.assertCellCoordinate(0, column)
    const rows = this.columnRows.get(column)
    if (rows === undefined) return []
    const cells: Array<GridCell<T>> = []
    for (const row of rows) {
      const columns = this.cells.get(row)
      if (columns === undefined) continue
      cells.push({ row, column, value: columns.get(column) as T })
    }
    cells.sort((left, right) => left.row - right.row)
    return cells
  }

  /**
   * Cells inside `range`, row-major, sorted columns within each row.
   * Time O(r + R + k log k) for r occupied rows in the whole sheet, R occupied
   * cells in the spanned rows and k returned; space O(k). Empty row/column gaps
   * are never iterated, so a range spanning a million empty rows costs the same
   * as a range spanning one. Inverted corners are normalised and out-of-sheet
   * bounds are clamped rather than throwing.
   */
  range(range: GridRange): Array<GridCell<T>> {
    const normalised = range.normalise()
    const top = Math.max(0, normalised.top)
    const bottom = Math.min(this.maximumRow, normalised.bottom)
    const left = Math.max(0, normalised.left)
    const right = Math.min(this.maximumColumn, normalised.right)
    if (top > bottom || left > right) return []
    const rows = [...this.cells.keys()]
      .filter((row) => row >= top && row <= bottom)
      .sort((leftRow, rightRow) => leftRow - rightRow)
    const cells: Array<GridCell<T>> = []
    for (const row of rows) {
      const columns = this.cells.get(row)
      if (columns === undefined) continue
      const matches: Array<GridCell<T>> = []
      for (const [column, value] of columns) {
        if (column >= left && column <= right) matches.push({ row, column, value })
      }
      matches.sort((leftCell, rightCell) => leftCell.column - rightCell.column)
      cells.push(...matches)
    }
    return cells
  }

  /**
   * Smallest normalised range containing every cell, or `undefined` when empty.
   * Time O(n), space O(1).
   */
  bounds(): GridRange | undefined {
    if (this.count === 0) return undefined
    let top = Number.POSITIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    let left = Number.POSITIVE_INFINITY
    let right = Number.NEGATIVE_INFINITY
    for (const [row, columns] of this.cells) {
      if (row < top) top = row
      if (row > bottom) bottom = row
      for (const column of columns.keys()) {
        if (column < left) left = column
        if (column > right) right = column
      }
    }
    return new GridRange(top, left, bottom, right)
  }

  /**
   * Every cell in deterministic row-major order.
   * Time O(n log n), space O(n).
   */
  toArray(): Array<GridCell<T>> {
    return [...this]
  }

  /**
   * Iterate every cell in deterministic row-major order. Time O(n log n),
   * space O(n) for the sorted row keys.
   */
  *[Symbol.iterator](): IterableIterator<GridCell<T>> {
    const rows = [...this.cells.keys()].sort((left, right) => left - right)
    for (const row of rows) {
      const columns = this.cells.get(row)
      if (columns === undefined) continue
      const columnKeys = [...columns.keys()].sort((left, right) => left - right)
      for (const column of columnKeys) {
        yield { row, column, value: columns.get(column) as T }
      }
    }
  }

  /** Record that `row` holds a cell in `column`. */
  private addColumnRow(column: number, row: number): void {
    const rows = this.columnRows.get(column)
    if (rows === undefined) this.columnRows.set(column, new Set<number>([row]))
    else rows.add(row)
  }

  /** Throw unless `(row, column)` is inside the configured sheet. */
  private assertCellCoordinate(row: number, column: number): void {
    assertCoordinate(row, 'row')
    assertCoordinate(column, 'column')
    if (row < 0 || row > this.maximumRow) {
      throw new InvalidArgumentError('sparse grid row is outside the configured bounds', {
        row,
        maximumRow: this.maximumRow,
      })
    }
    if (column < 0 || column > this.maximumColumn) {
      throw new InvalidArgumentError('sparse grid column is outside the configured bounds', {
        column,
        maximumColumn: this.maximumColumn,
      })
    }
  }
}

/** Throw unless `value` is a safe integer. */
function assertCoordinate(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new InvalidArgumentError(`${name} must be a safe integer`, { [name]: value })
  }
}

/** Validate a positive bound option, falling back to its default. */
function normaliseBound(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidArgumentError(`${name} must be a positive safe integer`, { [name]: value })
  }
  return value
}
