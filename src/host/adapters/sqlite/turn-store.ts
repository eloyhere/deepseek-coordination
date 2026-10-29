import type { Turn } from "../../../shared/entity.js";
import type { CoordinationDatabase } from "../../database.js";
import type { Row } from "../../row.js";
import { mapTurn } from "../../row.js";
import type {
  CommandSnapshot,
  CreateTurnInput,
  PromptSnapshot,
  TurnStore,
} from "../../turn-store.js";

const ACTIVE = "status NOT IN ('done', 'failed', 'cancelled', 'abandoned')";

/** SQLite adapter for the Execution turn aggregate. */
export class SqliteTurnStore implements TurnStore {
  constructor(private readonly db: CoordinationDatabase) {}

  get(identity: number): Turn {
    return mapTurn(this.db.require<Row>("turn", identity, "turn"));
  }

  list(session: number): Turn[] {
    return this.db
      .all<Row>(
        "SELECT * FROM turn WHERE session = ? ORDER BY ordinal ASC, identity ASC",
        session,
      )
      .map(mapTurn);
  }

  active(session: number): Turn | undefined {
    const row = this.db.get<Row>(
      `SELECT * FROM turn WHERE session = ? AND ${ACTIVE} ORDER BY identity DESC LIMIT 1`,
      session,
    );
    return row === undefined ? undefined : mapTurn(row);
  }

  activeAll(): Turn[] {
    return this.db
      .all<Row>(`SELECT * FROM turn WHERE ${ACTIVE} ORDER BY identity ASC`)
      .map(mapTurn);
  }

  maxOrdinal(session: number): number {
    return Number(
      this.db.get<{ ordinal: number }>(
        "SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM turn WHERE session = ?",
        session,
      )?.ordinal ?? 0,
    );
  }

  count(session: number): number {
    return this.db.count("turn", "session = ?", session);
  }

  create(input: CreateTurnInput): Turn {
    return this.db.transaction(() => {
      const identity = this.db.insert("turn", {
        handle: input.handle,
        session: input.session,
        ordinal: input.ordinal,
        command: input.command,
        interaction: input.interaction,
        scene: input.scene,
        validation: input.validation,
        profession: input.profession,
        locked: 1,
        lockedAt: input.lockedAt,
        effort: input.effort,
        iteration: input.iteration ?? 1,
        rebuild: input.rebuild ?? 0,
        status: "pending",
        created: input.created,
      });
      const prompt = this.db.insert("prompt", {
        handle: input.prompt.handle,
        turn: identity,
        content: input.prompt.content,
        ...(input.prompt.media === undefined ? {} : { media: input.prompt.media }),
        created: input.prompt.created,
      });
      this.db.update("turn", { prompt }, "identity = ?", identity);
      if (input.commandFace !== undefined) {
        this.db.insert("command", {
          handle: input.commandFace.handle,
          turn: identity,
          type: input.commandFace.type,
          content: input.commandFace.content,
          created: input.commandFace.created,
        });
      }
      return this.get(identity);
    });
  }

  prompt(identity: number): PromptSnapshot | undefined {
    const row = this.db.get<{ content?: unknown; media?: unknown }>(
      "SELECT content, media FROM prompt WHERE identity = ?",
      identity,
    );
    if (row === undefined) return undefined;
    return {
      content: typeof row.content === "string" ? row.content : "",
      ...(typeof row.media === "string" ? { media: row.media } : {}),
    };
  }

  latestCommand(turn: number): CommandSnapshot | undefined {
    const row = this.db.get<{ type?: unknown; content?: unknown }>(
      "SELECT type, content FROM command WHERE turn = ? ORDER BY identity DESC LIMIT 1",
      turn,
    );
    if (row === undefined) return undefined;
    return {
      type: typeof row.type === "string" ? (row.type as CommandSnapshot["type"]) : "none",
      content: typeof row.content === "string" ? row.content : "",
    };
  }

  update(identity: number, patch: Record<string, unknown>): Turn {
    this.db.update("turn", patch, "identity = ?", identity);
    return this.get(identity);
  }
}
