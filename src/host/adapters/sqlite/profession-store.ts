import type { ProfessionRecord, SubTask } from "../../../shared/entity.js";
import type { ProfessionStatus } from "../../../shared/enum.js";
import type { CoordinationDatabase } from "../../database.js";
import { mapProfessionRecord, mapSubTask } from "../../row.js";
import type { Row } from "../../row.js";
import type {
  CreateSubTaskInput,
  ProfessionRecordInput,
  ProfessionStore,
} from "../../profession-store.js";

export class SqliteProfessionStore implements ProfessionStore {
  constructor(private readonly db: CoordinationDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation);
  }

  getSubTask(identity: number): SubTask {
    return mapSubTask(this.db.require<Row>("subtask", identity, "subtask"));
  }

  createSubTask(input: CreateSubTaskInput): number {
    return this.db.insert("subtask", {
      handle: input.handle,
      parent: input.parent,
      model: input.model,
      effort: input.effort,
      task: input.task,
      tools: input.tools,
      context: input.context,
      acceptance: input.acceptance,
      groundTruth: input.groundTruth,
      profession: input.profession,
      locked: 1,
      lockedAt: input.lockedAt,
      blockedBy: input.blockedBy,
      status: input.status,
      rejectCount: input.rejectCount,
      supersedes: input.supersedes,
      created: input.created,
    });
  }

  updateSubTask(identity: number, patch: Record<string, unknown>): void {
    this.db.update("subtask", patch, "identity = ?", identity);
  }

  findRecord(turn: number, subtask?: number): ProfessionRecord | undefined {
    const row = subtask === undefined
      ? this.db.get<Row>(
          "SELECT * FROM profession_record WHERE turn = ? AND subtask IS NULL ORDER BY identity DESC LIMIT 1",
          turn,
        )
      : this.db.get<Row>(
          "SELECT * FROM profession_record WHERE turn = ? AND subtask = ? ORDER BY identity DESC LIMIT 1",
          turn,
          subtask,
        );
    return row === undefined ? undefined : mapProfessionRecord(row);
  }

  getRecord(identity: number): ProfessionRecord {
    return mapProfessionRecord(this.db.require<Row>("profession_record", identity, "profession record"));
  }

  createRecord(input: ProfessionRecordInput): ProfessionRecord {
    const identity = this.db.insert("profession_record", {
      handle: input.handle,
      turn: input.turn,
      subtask: input.subtask,
      actor: input.actor,
      profession: input.profession,
      locked: 1,
      lockedAt: input.lockedAt,
      status: input.status,
      input: input.input,
      output: input.output,
      reason: input.reason,
      created: input.created,
    });
    return this.getRecord(identity);
  }

  updateRecord(identity: number, patch: Record<string, unknown>): ProfessionRecord {
    this.db.update("profession_record", patch, "identity = ?", identity);
    return this.getRecord(identity);
  }

  listRecords(session: number): ProfessionRecord[] {
    return this.db
      .all<Row>(
        `SELECT pr.* FROM profession_record pr
         JOIN turn t ON t.identity = pr.turn
         WHERE t.session = ? ORDER BY pr.identity ASC`,
        session,
      )
      .map(mapProfessionRecord);
  }

  updateRecordStatusByTurn(turn: number, status: ProfessionStatus, reason: string, finished: number): void {
    this.db.run(
      "UPDATE profession_record SET status = ?, reason = ?, finished = ? WHERE turn = ? AND subtask IS NULL",
      status,
      reason,
      finished,
      turn,
    );
  }

  updateRecordStatusBySubTask(subtask: number, status: ProfessionStatus, reason: string, finished: number): void {
    this.db.run(
      "UPDATE profession_record SET status = ?, reason = ?, finished = ? WHERE subtask = ?",
      status,
      reason,
      finished,
      subtask,
    );
  }
}
