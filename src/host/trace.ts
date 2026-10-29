/**
 * Append-only governance trace.
 *
 * Each row hashes the previous row's hash plus this event's canonical content.
 * SQLite triggers reject UPDATE and DELETE, so the chain is both tamper
 * evident and tamper resistant. `verify` recomputes the chain for one turn.
 */
import { createHash } from "node:crypto";
import type { OrchestrationTrace } from "../shared/entity.js";
import type { TraceInput, TraceVerification, TraceWriter } from "./trace-port.js";
import type { Clock } from "./handle.js";
import type { HandleGenerator } from "./handle.js";
import type { TraceStore } from "./trace-store.js";

export class TraceModule implements TraceWriter {
  private readonly store: TraceStore;
  private readonly handles: HandleGenerator;
  private readonly clock: Clock;

  constructor(store: TraceStore, handles: HandleGenerator, clock: Clock) {
    this.store = store;
    this.handles = handles;
    this.clock = clock;
  }

  append(input: TraceInput): OrchestrationTrace {
    const detail =
      typeof input.detail === "string"
        ? input.detail
        : JSON.stringify(input.detail);
    const created = this.clock.now();
    const parentHash = this.store.latestHash(input.turn) ?? "0";
    const hash = hashTrace(parentHash, {
      turn: input.turn,
      event: input.event,
      subtask: input.subtask ?? null,
      actor: input.actor,
      profession: input.profession ?? null,
      parentEvent: input.parentEvent ?? null,
      detail,
      created,
    });

    if (input.parentEvent !== undefined) {
      const parentTurn = this.store.turnOf(input.parentEvent);
      if (parentTurn === undefined) {
        throw new Error(
          `trace parent event ${input.parentEvent} does not exist`,
        );
      }
      if (parentTurn !== input.turn) {
        throw new Error(
          `trace parent event ${input.parentEvent} belongs to another turn`,
        );
      }
    }

    return this.store.append({
      handle: this.handles.next("trace"),
      turn: input.turn,
      event: input.event,
      subtask: input.subtask,
      actor: input.actor,
      profession: input.profession,
      parentEvent: input.parentEvent,
      detail,
      hash,
      created,
    });
  }

  list(turn: number): OrchestrationTrace[] {
    return this.store.list(turn);
  }

  verify(turn: number): TraceVerification {
    const rows = this.list(turn);
    let previous = "0";
    for (const row of rows) {
      const expected = hashTrace(previous, {
        turn: row.turn,
        event: row.event,
        subtask: row.subtask ?? null,
        actor: row.actor,
        profession: row.profession ?? null,
        parentEvent: row.parentEvent ?? null,
        detail: row.detail,
        created: row.created,
      });
      if (expected !== row.hash) {
        return {
          ok: false,
          brokenAt: row.identity,
          reason: "hash chain mismatch",
        };
      }
      previous = row.hash;
    }
    return { ok: true };
  }
}

/** Hash one trace payload with a stable key order. */
export function hashTrace(
  previousHash: string,
  payload: Record<string, unknown>,
): string {
  const canonical = JSON.stringify(sortKeys(payload));
  return createHash("sha256")
    .update(previousHash)
    .update("\n")
    .update(canonical)
    .digest("hex");
}

/** Recursively sort object keys so the JSON is canonical. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return result;
}
