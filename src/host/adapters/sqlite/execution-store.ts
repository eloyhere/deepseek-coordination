import type { CoordinationDatabase } from "../../database.js";
import type { Session } from "../../../shared/entity.js";
import { toInteraction, toScene, toValidation } from "../../../shared/enum.js";
import type { Row } from "../../row.js";
import type { ExecutionStore } from "../../execution-store.js";

/** SQLite adapter for the Execution aggregate; SQL and row shape stay behind this boundary. */
export class SqliteExecutionStore implements ExecutionStore {
  private readonly db: CoordinationDatabase;

  constructor(db: CoordinationDatabase) {
    this.db = db;
  }

  findByHandle(handle: string): Session | undefined {
    const row = this.db.get<Row>(
      "SELECT * FROM session WHERE handle = ?",
      handle,
    );
    return row === undefined ? undefined : mapSession(row);
  }

  get(identity: number): Session {
    return mapSession(this.db.require<Row>("session", identity, "session"));
  }

  list(): Session[] {
    return this.db
      .all<Row>("SELECT * FROM session ORDER BY identity ASC")
      .map(mapSession);
  }

  create(session: Omit<Session, "identity">): Session {
    const identity = this.db.insert("session", session);
    return this.get(identity);
  }

  update(
    identity: number,
    patch: Partial<
      Pick<Session, "interaction" | "scene" | "validation" | "profile">
    >,
  ): void {
    this.db.update("session", patch, "identity = ?", identity);
  }

  reactivate(identity: number, generation: number): void {
    this.db.update(
      "session",
      { status: "active", ended: null, generation },
      "identity = ?",
      identity,
    );
  }

  end(identity: number, ended: number): void {
    this.db.update(
      "session",
      { status: "ended", ended },
      "identity = ?",
      identity,
    );
  }

  count(): number {
    return this.db.count("session");
  }
}

function mapSession(row: Row): Session {
  return {
    identity: Number(row.identity),
    handle: String(row.handle),
    principal: String(row.principal),
    sandbox: String(row.sandbox),
    interaction: toInteraction(row.interaction),
    scene: toScene(row.scene),
    validation: toValidation(row.validation),
    profile: String(row.profile),
    generation: Number(row.generation),
    status: row.status === "ended" ? "ended" : "active",
    created: Number(row.created),
    ...(row.ended === null || row.ended === undefined
      ? {}
      : { ended: Number(row.ended) }),
  };
}
