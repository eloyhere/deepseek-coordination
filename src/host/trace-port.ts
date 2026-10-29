import type { OrchestrationTrace } from "../shared/entity.js";
import type { TraceEvent } from "../shared/enum.js";

export interface TraceInput {
  turn: number;
  event: TraceEvent;
  actor: string;
  subtask?: number;
  profession?: OrchestrationTrace["profession"];
  parentEvent?: number;
  detail: string | Record<string, unknown>;
}

export interface TraceVerification {
  ok: boolean;
  brokenAt?: number;
  reason?: string;
}

export interface TraceWriter {
  append(input: TraceInput): OrchestrationTrace;
  list(turn: number): OrchestrationTrace[];
  verify(turn: number): TraceVerification;
}
