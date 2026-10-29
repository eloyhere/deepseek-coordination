import type { OrchestrationTrace } from "../shared/entity.js";

/** Persistence port for the append-only governance trace. */
export interface TraceStore {
  latestHash(turn: number): string | undefined;
  turnOf(identity: number): number | undefined;
  append(trace: Omit<OrchestrationTrace, "identity">): OrchestrationTrace;
  list(turn: number): OrchestrationTrace[];
}
