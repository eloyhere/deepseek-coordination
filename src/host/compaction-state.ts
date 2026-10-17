/**
 * Bounded per-session bookkeeping for automatic compaction (v24 §5).
 *
 * `CoordinationService.maybeCompact` remembers, per DSH session, when the last
 * host compaction happened and how many have happened in this process. The
 * record only feeds two rate limits (cooldown, `maxPerSession`), so it must
 * never grow without bound with the number of sessions a long-lived host has
 * seen.
 *
 * The store is a capacity-bounded LRU keyed by the DSH session id:
 *
 * - capacity is `CompactionStateCapacity` (the library's maximum), far above
 *   the number of sessions one host process can compact; a deployment large
 *   enough to reach it has long exceeded every other per-session bound;
 * - eviction would reset one session's counter, so the cap is deliberately set
 *   where eviction is unreachable in practice rather than where it is cheap;
 * - `applyCompactionPolicy` and `dispose` clear the store outright, because a
 *   new policy or a shut-down service has no in-flight bookkeeping to keep.
 *
 * This module is pure (`LruList` only) so the cap is testable without Cordis.
 */
import { LruList } from '../shared/lru.js'

/** One session's compaction bookkeeping. */
export interface CompactionSessionState {
  /** Clock time of the last successful compaction. */
  lastAt: number
  /** Compactions this process has performed for the session. */
  count: number
}

/**
 * Maximum sessions with remembered compaction state.
 *
 * Chosen as the largest capacity the shared LRU supports (1..100000): the
 * record is a rate limit, so a smaller cap would trade a documented safety
 * property (per-session compaction ceiling) for memory that is already bounded
 * at a few megabytes in the worst case.
 */
export const CompactionStateCapacity = 100000

/** Capacity-bounded session -> compaction-state map. */
export class CompactionStateStore {
  private readonly store: LruList<string, CompactionSessionState>

  /**
   * @param capacity Maximum remembered sessions; defaults to the service's
   *   `CompactionStateCapacity` and exists as a parameter so the cap is
   *   testable without a hundred thousand rows.
   */
  constructor(capacity: number = CompactionStateCapacity) {
    this.store = new LruList<string, CompactionSessionState>(capacity)
  }

  /** Live entries; at most `capacity`. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /** Configured maximum number of live entries. Time O(1). */
  get capacity(): number {
    return this.store.capacity
  }

  /** Read one session's state and mark it recently used. Time O(1) amortized. */
  get(session: string): CompactionSessionState | undefined {
    return this.store.get(session)
  }

  /** Record one session's state. Time O(1) amortized. */
  set(session: string, state: CompactionSessionState): void {
    this.store.set(session, state)
  }

  /** Drop every entry; used on policy change and dispose. Time O(n). */
  clear(): void {
    this.store.clear()
  }
}
