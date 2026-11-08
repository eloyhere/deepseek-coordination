/**
 * Output-side wire sources: spill, prune and compaction.
 *
 * `AmpContextOptimizer` already merges the P1 input items captured on
 * `PendingInput`; this module is the equivalent seam for the P2 output
 * channels. It adds no policy of its own: each tracker owns its records and
 * wire projection, while `OutputSources` concatenates, deduplicates and
 * exposes the host-side exclusion ledgers separately from compiler
 * exclusions (wire.md §4.6's three ledgers).
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionTracker } from './compaction.js'
import type { CompactionStatus } from './compaction.js'
import { PruneTracker } from './prune.js'
import type { PruneStatus } from './prune.js'
import { RetentionLedger } from './retention.js'
import type { RetentionStatus } from './retention.js'
import { SpillIndex } from './spill.js'
import type { SpillStatus } from './spill.js'
import type { WireExclusion, WireItem } from './wire.js'

/**
 * One source of compiled-context candidates.
 *
 * Implementations must be synchronous and fail-open: a malformed or missing
 * record yields fewer items, never an exception into the compile step.
 */
export interface WireItemSource {
  itemsFor(agent: Agent): readonly WireItem[]
  /** Optional aggregate status for the optimizer's `/amp/context` view. */
  status?(): OutputStatus
}

/** The trackers composed by {@link OutputSources}. */
export interface OutputSourceParts {
  readonly spill: SpillIndex
  readonly retention: RetentionLedger
  readonly prune: PruneTracker
  readonly compaction: CompactionTracker
}

/** Aggregated status for `/amp/context`; each ledger stays separately readable. */
export interface OutputStatus {
  readonly spill: SpillStatus
  readonly retention: RetentionStatus
  readonly prune: PruneStatus
  readonly compaction: CompactionStatus
  /** Items or exclusions that could not be projected from a broken record. */
  readonly failures: number
}

/**
 * Compose the output channels over their trackers.
 *
 * `itemsFor` merges spill, prune and compaction items and dedupes by wire id;
 * `exclusions` merges the host-side retention and prune ledgers. The two
 * collection methods stay separate on purpose: an exclusion is not an item,
 * and a host exclusion never enters `compileTurnContext`.
 */
export class OutputSources implements WireItemSource {
  private readonly spill: SpillIndex
  private readonly retention: RetentionLedger
  private readonly prune: PruneTracker
  private readonly compaction: CompactionTracker
  private failures = 0

  /** @param parts - the trackers to compose, injected by the composition root. */
  constructor(parts: OutputSourceParts) {
    this.spill = parts.spill
    this.retention = parts.retention
    this.prune = parts.prune
    this.compaction = parts.compaction
  }

  /**
   * Merge every output channel's items for one agent.
   *
   * @param agent - the agent whose session is being compiled.
   * @returns items deduped by `id`, in spill → prune → compaction order.
   */
  itemsFor(agent: Agent): readonly WireItem[] {
    const merged = new Map<string, WireItem>()
    for (const source of [this.spill, this.prune, this.compaction]) {
      try {
        for (const item of source.itemsFor(agent)) {
          if (typeof item?.id !== 'string' || item.id.length === 0) continue
          merged.set(item.id, item)
        }
      } catch {
        this.failures += 1
      }
    }
    return [...merged.values()]
  }

  /**
   * Host-side exclusions for pruned originals and retention omissions.
   *
   * @returns exclusions deduped by `id`; retention and prune ids never overlap.
   */
  exclusions(): readonly WireExclusion[] {
    const merged = new Map<string, WireExclusion>()
    try {
      for (const exclusion of this.retention.allExclusions()) merged.set(exclusion.id, exclusion)
    } catch {
      this.failures += 1
    }
    try {
      for (const exclusion of this.prune.hostExclusions()) merged.set(exclusion.id, exclusion)
    } catch {
      this.failures += 1
    }
    return [...merged.values()]
  }

  /** Aggregated, allocation-bounded status for diagnostics; never throws. */
  status(): OutputStatus {
    return {
      spill: this.spill.status(),
      retention: this.retention.status(),
      prune: this.prune.status(),
      compaction: this.compaction.status(),
      failures: this.failures,
    }
  }
}
