import type { ProfessionRecord, SubTask } from "../shared/entity.js";
import type { Profession, ProfessionStatus, SubTaskStatus } from "../shared/enum.js";

export interface CreateSubTaskInput {
  handle: string;
  parent: number;
  model: string;
  effort: string;
  task: string;
  tools: string[];
  context: string;
  acceptance: string;
  groundTruth?: string;
  profession: Profession;
  lockedAt: number;
  blockedBy: number[];
  status: SubTaskStatus;
  rejectCount: number;
  supersedes?: number;
  created: number;
}

export interface ProfessionRecordInput {
  handle: string;
  turn: number;
  subtask?: number;
  actor: string;
  profession: Profession;
  lockedAt: number;
  status: ProfessionStatus;
  input?: string;
  output?: string;
  reason?: string;
  created: number;
}

export interface ProfessionStore {
  transaction<T>(operation: () => T): T;
  getSubTask(identity: number): SubTask;
  createSubTask(input: CreateSubTaskInput): number;
  updateSubTask(identity: number, patch: Record<string, unknown>): void;
  findRecord(turn: number, subtask?: number): ProfessionRecord | undefined;
  getRecord(identity: number): ProfessionRecord;
  createRecord(input: ProfessionRecordInput): ProfessionRecord;
  updateRecord(identity: number, patch: Record<string, unknown>): ProfessionRecord;
  listRecords(session: number): ProfessionRecord[];
  updateRecordStatusByTurn(turn: number, status: ProfessionStatus, reason: string, finished: number): void;
  updateRecordStatusBySubTask(subtask: number, status: ProfessionStatus, reason: string, finished: number): void;
}
