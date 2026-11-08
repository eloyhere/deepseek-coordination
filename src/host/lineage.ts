/**
 * Lineage sources: compose P3 fork/subagent items over the P2 output sources.
 *
 * `AmpContextOptimizer` accepts one {@link WireItemSource}. P2 shipped
 * `OutputSources` for spill, retention, prune and compaction; P3 adds the
 * fork and subagent trackers without touching that contract. This class is the
 * single seam: it merges the three sources, dedupes by wire id and reports
 * their statuses side by side. It never copies attention residency, evidence or
 * receipts and it never exposes inherited transcript content.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { OutputStatus, WireItemSource } from './sources.js'
import type { ForkStatus, ForkTracker } from './fork.js'
import type { SubagentStatus, SubagentTracker } from './subagent.js'
import type { WireItem } from './wire.js'

/** A source whose status is guaranteed, so the aggregate cannot lose fields. */
export type StatusedWireItemSource = WireItemSource & { status(): OutputStatus }

/** Fork and subagent statuses, kept separate from the P2 ledgers. */
export interface LineageStatus {
  readonly fork: ForkStatus
  readonly subagent: SubagentStatus
  /** Items the lineage source itself could not project. */
  readonly failures: number
}

/** Zero-valued lineage status, useful to tests and cold-start diagnostics. */
export function emptyLineageStatus(): LineageStatus {
  return {
    fork: { records: 0, observed: 0, ignored: 0, failures: 0 },
    subagent: {
      records: 0,
      parents: 0,
      running: 0,
      completed: 0,
      failed: 0,
      unknown: 0,
      delegated: 0,
      settled: 0,
      observed: 0,
      ignored: 0,
      failures: 0,
    },
    failures: 0,
  }
}

/** Shared zero status; callers that need a mutable copy use the function. */
export const EmptyLineageStatus: LineageStatus = emptyLineageStatus()

/** All-zero P2 status, used only if the base source has no usable status. */
const EMPTY_OUTPUT_STATUS: OutputStatus = {
  spill: { sessions: 0, records: 0, observed: 0, parsed: 0, duplicates: 0, evicted: 0, failures: 0 },
  retention: { records: 0, maxRecords: 0, sessions: 0, observed: 0, parsed: 0, duplicates: 0, evicted: 0, failures: 0 },
  prune: { sessions: 0, records: 0, linked: 0, pending: 0, observed: 0, pruned: 0, unlinked: 0, failures: 0 },
  compaction: { sessions: 0, records: 0, open: 0, observed: 0, starts: 0, summaries: 0, ends: 0, failures: 0 },
  failures: 0,
}

/**
 * Merge P2 output items with P3 fork/subagent items.
 *
 * Every source is isolated: a throwing or malformed source contributes fewer
 * items, never an exception into the compile step. Dedupe is by `id` because
 * `compileTurnContext` rejects duplicate declarations; later sources win only
 * if they reuse an id, which in practice means the same immutable record.
 */
export class LineageSources implements WireItemSource {
  private readonly base: StatusedWireItemSource
  private readonly fork: ForkTracker
  private readonly subagent: SubagentTracker
  // P3 trackers expose a richer status than `OutputStatus`; these adapters keep
  // the `WireItemSource` shape purely about `itemsFor` so structural typing does
  // not try to unify the two status families.
  private readonly forkSource: WireItemSource
  private readonly subagentSource: WireItemSource
  private failures = 0

  /**
   * @param base - the P2 output source, which must expose `status()`.
   * @param fork - ordinary fork tracker.
   * @param subagent - subagent delegation tracker.
   */
  constructor(base: StatusedWireItemSource, fork: ForkTracker, subagent: SubagentTracker) {
    this.base = base
    this.fork = fork
    this.subagent = subagent
    this.forkSource = { itemsFor: (agent: Agent): readonly WireItem[] => this.fork.itemsFor(agent) }
    this.subagentSource = { itemsFor: (agent: Agent): readonly WireItem[] => this.subagent.itemsFor(agent) }
  }

  /**
   * Merge base, fork and subagent items for one agent.
   *
   * @param agent - the agent whose session is being compiled.
   * @returns items deduped by wire id, in base → fork → subagent order.
   */
  itemsFor(agent: Agent): readonly WireItem[] {
    const merged = new Map<string, WireItem>()
    this.collect(merged, this.base, agent)
    this.collect(merged, this.forkSource, agent)
    this.collect(merged, this.subagentSource, agent)
    return [...merged.values()]
  }

  /**
   * Aggregated P2 status plus the two lineage statuses.
   *
   * `lineage` is an extra property on the P2 aggregate, so the result remains
   * assignable to `OutputStatus` for the optimizer while `/amp/context` can
   * report P3 state separately.
   */
  status(): OutputStatus & { readonly lineage: LineageStatus } {
    let base: OutputStatus
    try {
      base = this.base.status()
    } catch {
      base = EMPTY_OUTPUT_STATUS
      this.failures += 1
    }
    let fork: ForkStatus
    try {
      fork = this.fork.status()
    } catch {
      fork = EmptyLineageStatus.fork
      this.failures += 1
    }
    let subagent: SubagentStatus
    try {
      subagent = this.subagent.status()
    } catch {
      subagent = EmptyLineageStatus.subagent
      this.failures += 1
    }
    return { ...base, lineage: { fork, subagent, failures: this.failures } }
  }

  /** Merge one source, containing its failure to a counter. */
  private collect(target: Map<string, WireItem>, source: WireItemSource, agent: Agent): void {
    try {
      const items = source.itemsFor(agent)
      if (!Array.isArray(items)) return
      for (const item of items) {
        if (typeof item?.id !== 'string' || item.id.length === 0) continue
        target.set(item.id, item)
      }
    } catch {
      this.failures += 1
    }
  }
}
