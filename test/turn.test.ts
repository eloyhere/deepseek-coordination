/**
 * TurnModule: the task boundary of the coordination database (v23 §3, §9.7, §11.2).
 *
 * The host uses a deferred writer only because the turn fixture exercises the
 * normal module composition order; TraceModule itself receives only ports.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoordinationDatabase } from "../src/host/database.js";
import { resolveConfig } from "../src/host/config.js";
import { HandleGenerator, SystemClock } from "../src/host/handle.js";
import { TraceModule } from "../src/host/trace.js";
import { CoordinationEventBus, createModuleHost } from "../src/host/module.js";
import { SqliteExecutionStore } from "../src/host/adapters/sqlite/execution-store.js";
import { SqliteTraceStore } from "../src/host/adapters/sqlite/trace-store.js";
import { SqliteTurnStore } from "../src/host/adapters/sqlite/turn-store.js";
import type {
  ModuleHost,
  TraceInput,
  TraceVerification,
  TraceWriter,
} from "../src/host/module.js";
import { TurnModule } from "../src/host/turn.js";
import { ProfessionModule } from "../src/host/profession.js";
import type { TurnRequest } from "../src/host/turn.js";
import { mapProfessionRecord } from "../src/host/row.js";
import type { Row } from "../src/host/row.js";
import type { OrchestrationTrace } from "../src/shared/entity.js";
import {
  DatabaseError,
  InvalidArgumentError,
  InvalidStateError,
  NotFoundError,
} from "../src/shared/error.js";

/* ------------------------------------------------------------------------- *
 * Fixture
 * ------------------------------------------------------------------------- */

/** A TraceWriter that forwards to the real one once the host exists. */
class DeferredTrace implements TraceWriter {
  private target?: TraceWriter;

  use(target: TraceWriter): void {
    this.target = target;
  }

  append(input: TraceInput): OrchestrationTrace {
    return this.require().append(input);
  }

  list(turn: number): OrchestrationTrace[] {
    return this.require().list(turn);
  }

  verify(turn: number): TraceVerification {
    return this.require().verify(turn);
  }

  private require(): TraceWriter {
    if (this.target === undefined)
      throw new Error("trace writer is not attached yet");
    return this.target;
  }
}

interface Fixture {
  db: CoordinationDatabase;
  host: ModuleHost;
  turn: TurnModule;
  close(): void;
}

function buildFixture(options: { maxTurnPerSession?: number } = {}): Fixture {
  const db = new CoordinationDatabase(":memory:");
  const config = resolveConfig(
    options.maxTurnPerSession === undefined
      ? {}
      : { maxTurnPerSession: options.maxTurnPerSession },
  );
  const trace = new DeferredTrace();
  const host = createModuleHost({
    db,
    config,
    handles: new HandleGenerator(),
    clock: SystemClock,
    events: new CoordinationEventBus(),
    trace,
    executionStore: new SqliteExecutionStore(db),
    turnStore: new SqliteTurnStore(db),
  });
  trace.use(
    new TraceModule(new SqliteTraceStore(db), host.handles, host.clock),
  );
  const profession = new ProfessionModule(host);
  return {
    db,
    host,
    turn: new TurnModule({
      config,
      clock: host.clock,
      handles: host.handles,
      executionStore: host.executionStore!,
      turnStore: host.turnStore!,
      trace,
      profession,
    }),
    close: () => db.close(),
  };
}

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    content: "describe the repository layout",
    profession: "execution",
    interaction: "think",
    scene: "engineering",
    validation: "medium",
    ...overrides,
  };
}

function professionRecords(db: CoordinationDatabase, turnIdentity: number) {
  return db
    .all<Row>(
      "SELECT * FROM profession_record WHERE turn = ? ORDER BY identity ASC",
      turnIdentity,
    )
    .map(mapProfessionRecord);
}

/* ------------------------------------------------------------------------- *
 * create
 * ------------------------------------------------------------------------- */

test("create locks the profession and writes one record and one lock event", () => {
  const fixture = buildFixture();
  try {
    const session = fixture.turn.ensureSession("dsh-session-alpha");
    const created = fixture.turn.create(
      session.identity,
      request({ profession: "outcome", content: "review the pull request" }),
    );

    assert.equal(created.session, session.identity);
    assert.equal(created.ordinal, 1);
    assert.equal(created.profession, "outcome");
    assert.equal(created.locked, true);
    assert.equal(typeof created.lockedAt, "number");
    assert.equal(created.status, "pending");
    assert.equal(created.effort, "medium");
    assert.equal(created.iteration, 1);
    assert.equal(created.rebuild, 0);
    assert.equal(created.interaction, "think");
    assert.equal(created.scene, "engineering");
    assert.equal(created.validation, "medium");
    assert.equal(created.command, "none");
    assert.equal(typeof created.prompt, "number");

    const prompt = fixture.db.get<Row>(
      "SELECT * FROM prompt WHERE identity = ?",
      created.prompt,
    );
    assert.equal(prompt?.content, "review the pull request");
    assert.equal(prompt?.turn, created.identity);
    assert.equal(fixture.db.count("command", "turn = ?", created.identity), 0);

    const records = professionRecords(fixture.db, created.identity);
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.turn, created.identity);
    assert.equal(record.profession, "outcome");
    assert.equal(record.locked, true);
    assert.equal(typeof record.lockedAt, "number");
    assert.equal(record.status, "running");
    assert.equal(record.actor, "host");
    assert.equal(record.input, "review the pull request");
    assert.equal(record.finished, undefined);

    const trace = fixture.host.trace.list(created.identity);
    assert.equal(trace.length, 1);
    const lock = trace[0]!;
    assert.equal(lock.event, "lock");
    assert.equal(lock.profession, "outcome");
    assert.equal(lock.actor, "host");
    assert.deepEqual(JSON.parse(lock.detail), { phase: "turn-create" });
    assert.equal(fixture.host.trace.verify(created.identity).ok, true);

    // The SQLite trigger is the second line of defence for the same rule.
    assert.throws(
      () =>
        fixture.db.run(
          "UPDATE turn SET profession = ? WHERE identity = ?",
          "decision",
          created.identity,
        ),
      DatabaseError,
    );
    assert.equal(fixture.turn.get(created.identity).profession, "outcome");
  } finally {
    fixture.close();
  }
});

test("ordinal increments per session and the command face is recorded", () => {
  const fixture = buildFixture();
  try {
    const session = fixture.turn.ensureSession("dsh-session-beta");
    const first = fixture.turn.create(session.identity, request());
    const second = fixture.turn.create(
      session.identity,
      request({ command: "goal", content: "set the goal" }),
    );
    const third = fixture.turn.create(
      session.identity,
      request({ effort: "high" }),
    );

    assert.deepEqual([first.ordinal, second.ordinal, third.ordinal], [1, 2, 3]);
    assert.equal(third.effort, "high");
    assert.equal(second.command, "goal");
    assert.equal(fixture.db.count("command", "turn = ?", first.identity), 0);
    const command = fixture.db.get<Row>(
      "SELECT * FROM command WHERE turn = ?",
      second.identity,
    );
    assert.equal(command?.type, "goal");
    assert.equal(command?.content, "set the goal");
    assert.deepEqual(
      fixture.turn.list(session.identity).map((entry) => entry.ordinal),
      [1, 2, 3],
    );
  } finally {
    fixture.close();
  }
});

test("create refuses a session that reached maxTurnPerSession", () => {
  const fixture = buildFixture({ maxTurnPerSession: 2 });
  try {
    const session = fixture.turn.ensureSession("dsh-session-gamma");
    fixture.turn.create(session.identity, request());
    fixture.turn.create(session.identity, request());
    assert.throws(
      () => fixture.turn.create(session.identity, request()),
      (error: unknown) =>
        error instanceof InvalidStateError &&
        error.details.maxTurnPerSession === 2,
    );
    assert.equal(fixture.turn.list(session.identity).length, 2);
    assert.equal(fixture.db.count("profession_record"), 2);
  } finally {
    fixture.close();
  }
});

/* ------------------------------------------------------------------------- *
 * finish
 * ------------------------------------------------------------------------- */

test("finish closes the turn and its profession record without a second trace event", () => {
  const fixture = buildFixture();
  try {
    const session = fixture.turn.ensureSession("dsh-session-delta");
    const created = fixture.turn.create(session.identity, request());

    assert.equal(
      fixture.turn.setStatus(created.identity, "comprehending").status,
      "comprehending",
    );

    const finished = fixture.turn.finish(created.identity, "done");
    assert.equal(finished.status, "done");
    assert.equal(typeof finished.finished, "number");

    const record = professionRecords(fixture.db, created.identity)[0]!;
    assert.equal(record.status, "done");
    assert.equal(typeof record.finished, "number");
    assert.equal(record.output, undefined);
    // The bridge owns 'synthesize'; finish must not duplicate a trace event.
    assert.equal(fixture.host.trace.list(created.identity).length, 1);

    assert.throws(
      () => fixture.turn.finish(created.identity, "failed"),
      InvalidStateError,
    );
    assert.throws(
      () => fixture.turn.finish(created.identity, "running" as never),
      InvalidArgumentError,
    );

    // A cancelled turn has no cancelled profession status; it records abandoned.
    const cancelled = fixture.turn.create(session.identity, request());
    assert.equal(
      fixture.turn.finish(cancelled.identity, "cancelled").status,
      "cancelled",
    );
    assert.equal(
      professionRecords(fixture.db, cancelled.identity)[0]!.status,
      "abandoned",
    );

    const failed = fixture.turn.create(session.identity, request());
    assert.equal(
      fixture.turn.finish(failed.identity, "failed").status,
      "failed",
    );
    assert.equal(
      professionRecords(fixture.db, failed.identity)[0]!.status,
      "failed",
    );
  } finally {
    fixture.close();
  }
});

/* ------------------------------------------------------------------------- *
 * recoverInterrupted
 * ------------------------------------------------------------------------- */

test("recoverInterrupted fails every non-terminal turn and only those", () => {
  const fixture = buildFixture();
  try {
    const session = fixture.turn.ensureSession("dsh-session-epsilon");
    const pending = fixture.turn.create(session.identity, request());
    const acting = fixture.turn.create(session.identity, request());
    fixture.turn.setStatus(acting.identity, "acting");
    const completed = fixture.turn.create(session.identity, request());
    fixture.turn.finish(completed.identity, "done");
    const abandoned = fixture.turn.create(session.identity, request());
    fixture.turn.markAbandoned(abandoned.identity);

    assert.equal(fixture.turn.recoverInterrupted(), 2);

    for (const identity of [pending.identity, acting.identity]) {
      const recovered = fixture.turn.get(identity);
      assert.equal(recovered.status, "failed");
      assert.equal(typeof recovered.finished, "number");
      const record = professionRecords(fixture.db, identity)[0]!;
      assert.equal(record.status, "failed");
      assert.equal(typeof record.finished, "number");
      assert.match(record.reason ?? "", /interrupted/);
      // Recovery is not a governance action: no extra trace event is written.
      assert.equal(fixture.host.trace.list(identity).length, 1);
    }

    assert.equal(fixture.turn.get(completed.identity).status, "done");
    assert.equal(fixture.turn.get(abandoned.identity).status, "abandoned");
    assert.equal(
      professionRecords(fixture.db, abandoned.identity)[0]!.status,
      "abandoned",
    );
    assert.equal(fixture.turn.active(session.identity), undefined);
    assert.equal(fixture.turn.recoverInterrupted(), 0);
  } finally {
    fixture.close();
  }
});

/* ------------------------------------------------------------------------- *
 * markAbandoned
 * ------------------------------------------------------------------------- */

test("markAbandoned abandons the turn and keeps its profession record", () => {
  const fixture = buildFixture();
  try {
    const session = fixture.turn.ensureSession("dsh-session-zeta");
    const created = fixture.turn.create(
      session.identity,
      request({ profession: "decision" }),
    );

    const abandoned = fixture.turn.markAbandoned(created.identity);
    assert.equal(abandoned.status, "abandoned");
    assert.equal(typeof abandoned.finished, "number");
    assert.equal(abandoned.profession, "decision");

    const records = professionRecords(fixture.db, created.identity);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.status, "abandoned");
    assert.equal(records[0]!.profession, "decision");
    assert.deepEqual(
      fixture.host.trace.list(created.identity).map((entry) => entry.event),
      ["lock", "abandon"],
    );

    // Abandoning an abandoned turn is idempotent; a finished turn is refused.
    assert.equal(
      fixture.turn.markAbandoned(created.identity).status,
      "abandoned",
    );
    const finished = fixture.turn.create(session.identity, request());
    fixture.turn.finish(finished.identity, "done");
    assert.throws(
      () => fixture.turn.markAbandoned(finished.identity),
      InvalidStateError,
    );
    assert.equal(
      professionRecords(fixture.db, finished.identity)[0]!.status,
      "done",
    );
  } finally {
    fixture.close();
  }
});

/* ------------------------------------------------------------------------- *
 * active
 * ------------------------------------------------------------------------- */

test("active ignores terminal turns", () => {
  const fixture = buildFixture();
  try {
    const session = fixture.turn.ensureSession("dsh-session-eta");
    assert.equal(fixture.turn.active(session.identity), undefined);

    const first = fixture.turn.create(session.identity, request());
    assert.equal(
      fixture.turn.active(session.identity)?.identity,
      first.identity,
    );
    fixture.turn.finish(first.identity, "failed");
    assert.equal(fixture.turn.active(session.identity), undefined);

    const second = fixture.turn.create(session.identity, request());
    assert.equal(
      fixture.turn.active(session.identity)?.identity,
      second.identity,
    );
    fixture.turn.markAbandoned(second.identity);
    assert.equal(fixture.turn.active(session.identity), undefined);

    const third = fixture.turn.create(session.identity, request());
    fixture.turn.setStatus(third.identity, "orchestrating");
    assert.equal(
      fixture.turn.active(session.identity)?.identity,
      third.identity,
    );
    fixture.turn.setStatus(third.identity, "done");
    assert.equal(fixture.turn.active(session.identity), undefined);
  } finally {
    fixture.close();
  }
});

/* ------------------------------------------------------------------------- *
 * handle vs identity
 * ------------------------------------------------------------------------- */

test("createForHandle reuses one session row and identity confusion is refused", () => {
  const fixture = buildFixture();
  try {
    const first = fixture.turn.createForHandle("dsh-session-theta", request());
    const second = fixture.turn.createForHandle("dsh-session-theta", request());
    assert.equal(first.session, second.session);
    assert.deepEqual([first.ordinal, second.ordinal], [1, 2]);
    assert.equal(
      fixture.db.count("session", "handle = ?", "dsh-session-theta"),
      1,
    );
    assert.equal(fixture.turn.list(first.session).length, 2);

    assert.throws(
      () =>
        fixture.turn.create(
          "dsh-session-theta" as unknown as number,
          request(),
        ),
      InvalidArgumentError,
    );
    assert.throws(
      () => fixture.turn.ensureSession(first.session as unknown as string),
      InvalidArgumentError,
    );
    assert.throws(() => fixture.turn.get(9_999), NotFoundError);
    assert.throws(() => fixture.turn.create(9_999, request()), NotFoundError);
  } finally {
    fixture.close();
  }
});

/* ------------------------------------------------------------------------- *
 * attach / setStatus
 * ------------------------------------------------------------------------- */

test("attach binds pipeline artifacts and validates their identities", () => {
  const fixture = buildFixture();
  try {
    const session = fixture.turn.ensureSession("dsh-session-iota");
    const created = fixture.turn.create(session.identity, request());

    const attached = fixture.turn.attach(created.identity, {
      comprehension: 11,
      organization: 12,
      plan: 13,
      goal: 14,
      compact: 15,
    });
    assert.equal(attached.comprehension, 11);
    assert.equal(attached.organization, 12);
    assert.equal(attached.plan, 13);
    assert.equal(attached.goal, 14);
    assert.equal(attached.compact, 15);

    assert.equal(fixture.turn.attach(created.identity, {}).plan, 13);
    assert.throws(
      () => fixture.turn.attach(created.identity, { plan: 0 }),
      InvalidArgumentError,
    );
    assert.throws(
      () => fixture.turn.attach(9_999, { plan: 13 }),
      NotFoundError,
    );
  } finally {
    fixture.close();
  }
});

test("setStatus refuses unknown values and terminal reversal", () => {
  const fixture = buildFixture();
  try {
    const session = fixture.turn.ensureSession("dsh-session-kappa");
    const created = fixture.turn.create(session.identity, request());

    assert.equal(
      fixture.turn.setStatus(created.identity, "comprehending").status,
      "comprehending",
    );
    assert.equal(
      fixture.turn.setStatus(created.identity, "comprehending").status,
      "comprehending",
    );
    assert.throws(
      () => fixture.turn.setStatus(created.identity, "sleeping" as never),
      InvalidArgumentError,
    );

    const closed = fixture.turn.setStatus(created.identity, "done");
    assert.equal(closed.status, "done");
    assert.equal(
      professionRecords(fixture.db, created.identity)[0]!.status,
      "done",
    );
    assert.throws(
      () => fixture.turn.setStatus(created.identity, "acting"),
      InvalidStateError,
    );

    const abandoned = fixture.turn.create(session.identity, request());
    assert.equal(
      fixture.turn.setStatus(abandoned.identity, "abandoned").status,
      "abandoned",
    );
    assert.equal(
      professionRecords(fixture.db, abandoned.identity)[0]!.status,
      "abandoned",
    );
  } finally {
    fixture.close();
  }
});
