import type { OrchestrationTrace } from "../../../shared/entity.js";
import type { CoordinationDatabase } from "../../database.js";
import type { Row } from "../../row.js";
import type { TraceStore } from "../../trace-store.js";

/** SQLite adapter for the append-only governance trace. */
export class SqliteTraceStore implements TraceStore {
  constructor(private readonly db: CoordinationDatabase) {}

  latestHash(turn: number): string | undefined {
    return this.db.get<{ hash: string }>(
      "SELECT hash FROM orchestration_trace WHERE turn = ? ORDER BY identity DESC LIMIT 1",
      turn,
    )?.hash;
  }

  turnOf(identity: number): number | undefined {
    const row = this.db.get<{ turn: number }>(
      "SELECT turn FROM orchestration_trace WHERE identity = ?",
      identity,
    );
    return row === undefined ? undefined : Number(row.turn);
  }

  append(trace: Omit<OrchestrationTrace, "identity">): OrchestrationTrace {
    const identity = this.db.insert("orchestration_trace", trace);
    return mapTrace(
      this.db.require<Row>(
        "orchestration_trace",
        identity,
        "orchestration trace",
      ),
    );
  }

  list(turn: number): OrchestrationTrace[] {
    return this.db
      .all<Row>(
        "SELECT * FROM orchestration_trace WHERE turn = ? ORDER BY identity ASC",
        turn,
      )
      .map(mapTrace);
  }
}

function mapTrace(row: Row): OrchestrationTrace {
  return {
    identity: Number(row.identity),
    handle: String(row.handle),
    turn: Number(row.turn),
    event: row.event as OrchestrationTrace["event"],
    ...(row.subtask === null || row.subtask === undefined
      ? {}
      : { subtask: Number(row.subtask) }),
    actor: String(row.actor),
    ...(row.profession === null || row.profession === undefined
      ? {}
      : { profession: row.profession as OrchestrationTrace["profession"] }),
    ...(row.parentEvent === null || row.parentEvent === undefined
      ? {}
      : { parentEvent: Number(row.parentEvent) }),
    detail: String(row.detail),
    hash: String(row.hash),
    created: Number(row.created),
  };
}
