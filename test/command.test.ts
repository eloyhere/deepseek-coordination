/**
 * Command family tests: the command prefix parser/router, the Goal module, the
 * Compact module (including its refusal to fake a DSH compaction) and the
 * Directive record.
 *
 * The fixture builds the real `CoordinationDatabase` and the real
 * `TraceModule`; a session and one pending turn are inserted with SQL so the
 * tests do not depend on the concurrently written TurnModule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoordinationDatabase } from "../src/host/database.js";
import type { CoordinationConfig } from "../src/host/config.js";
import { SceneProfiles } from "../src/shared/enum.js";
import {
  createModuleHost,
  type AgentPort,
  type CompactionPort,
  type ModuleHost,
  type TraceWriter,
} from "../src/host/module.js";
import { TraceModule } from "../src/host/trace.js";
import { SqliteTraceStore } from "../src/host/adapters/sqlite/trace-store.js";
import { CommandModule, COMMAND_PREFIX } from "../src/host/command.js";
import type { CommandHandlers } from "../src/host/command.js";
import { GoalModule } from "../src/host/goal.js";
import { CompactModule } from "../src/host/compact.js";
import { DirectiveModule } from "../src/host/directive.js";
import {
  InvalidArgumentError,
  InvalidStateError,
  NotImplementedError,
  NotFoundError,
} from "../src/shared/error.js";

/** Only `db`, `clock` and `handles` are read by these modules; trace is unused. */
const unusedTrace: TraceWriter = {
  append() {
    throw new Error(
      "orchestration trace is not exercised by the command family",
    );
  },
  list() {
    return [];
  },
  verify() {
    return { ok: true };
  },
};

interface SetupOptions {
  compaction?: CompactionPort;
  agents?: AgentPort;
  clarifyTimeout?: number;
}

interface Fixture {
  host: ModuleHost;
  db: CoordinationDatabase;
  session: number;
  turn: number;
}

/**
 * Mirror of `resolveConfig()`'s resolved shape. `config.ts` imports
 * `@deepseek-ai/schemastery` at runtime, which this unit test deliberately does
 * not need; the command family only reads `clarifyTimeout`.
 */
function createConfig(clarifyTimeout = 30000): CoordinationConfig {
  return {
    database: "coordination",
    databasePath: "",
    maxTurnPerSession: 1000,
    defaultLease: 30000,
    clarifyTimeout,
    profession: {
      enabled: true,
      lock: true,
      default: "execution",
      rebuildCanReselect: true,
      abandonCanReselect: true,
      audit: true,
      errorHint: true,
    },
    plan: {
      threshold: 0.5,
      maxRebuild: 3,
      weights: {
        feasibility: 0.15,
        coverage: 0.15,
        clarity: 0.1,
        specificity: 0.1,
        alignment: 0.2,
        risk: 0.1,
        cost: 0.1,
        efficiency: 0.1,
      },
      dimensions: {
        feasibility: 0.5,
        coverage: 0.6,
        clarity: 0.5,
        specificity: 0.5,
        alignment: 0.7,
        risk: 0.7,
        cost: 0.8,
        efficiency: 0.5,
      },
    },
    orchestration: {
      maxReject: 2,
      maxSubTask: 32,
      groundTruth: true,
      groundTruthTimeout: 5000,
      allowShellGroundTruth: false,
      modelRouting: true,
    },
    cache: {
      enabled: true,
      ttl: 60000,
      fingerprintWindow: 50,
      effortWarning: true,
    },
    bayesian: {
      prior: 0.5,
      stopEntropy: 0.05,
      infoGain: 0.01,
      maxRoutes: 12,
      calibrationFloor: 0.1,
    },
    comprehension: {
      stageTimeout: 30000,
      searchEnabled: true,
      maxEvidence: 8,
      highHistoryWindow: 50,
    },
    compaction: {
      auto: true,
      soft: 0.7,
      hard: 0.88,
      reserve: 2048,
      recentTurns: 6,
      cooldown: 30000,
      maxPerSession: 20,
    },
    parser: {
      enabled: true,
      maxFileBytes: 1_048_576,
      maxTokens: 200_000,
      maxAstDepth: 256,
      timeoutMs: 2000,
      cacheCapacity: 256,
      dependencyGraphMaxVertices: 20_000,
      dependencyGraphMaxEdges: 100_000,
    },
    chain: { depth: 8, links: 50, tokenBudget: 1500 },
    tools: { maxResultBytes: 0 },
    scenes: SceneProfiles,
    ui: {
      toolbar: true,
      showTooltip: true,
      takeover: false,
      refreshInterval: 5000,
      compact: true,
      locale: "auto",
    },
    defaults: {
      profession: "execution",
      interaction: "think",
      scene: "dialogue",
      validation: "medium",
      command: "none",
    },
  };
}

/** Real database, real host kernel, one DSH session and one pending turn. */
function setup(options: SetupOptions = {}): Fixture {
  const db = new CoordinationDatabase(":memory:");
  const config = createConfig(options.clarifyTimeout);
  const seed = createModuleHost({ db, config, trace: unusedTrace });
  const host = createModuleHost({
    db,
    config,
    trace: new TraceModule(new SqliteTraceStore(db), seed.handles, seed.clock),
    ...(options.compaction === undefined
      ? {}
      : { compaction: options.compaction }),
    ...(options.agents === undefined ? {} : { agents: options.agents }),
  });
  const created = host.clock.now();
  const session = db.insert("session", {
    handle: "session-test",
    principal: "local",
    sandbox: "",
    interaction: "think",
    scene: "dialogue",
    validation: "medium",
    profile: "",
    generation: 1,
    status: "active",
    created,
  });
  const turn = db.insert("turn", {
    handle: host.handles.next("turn"),
    session,
    ordinal: 1,
    command: "none",
    interaction: "think",
    scene: "dialogue",
    validation: "medium",
    profession: "execution",
    locked: 0,
    effort: "medium",
    iteration: 1,
    rebuild: 0,
    status: "pending",
    created,
  });
  return { host, db, session, turn };
}

/** Five handlers, optionally with one deliberately knocked out. */
function handlers(overrides: Partial<CommandHandlers> = {}): CommandHandlers {
  return {
    goal: (turn, content) => `goal:${turn}:${content}`,
    plan: () => "plan handled",
    feedback: () => "feedback handled",
    compact: () => "compact handled",
    permission: () => "permission handled",
    ...overrides,
  } as CommandHandlers;
}

/** Read `turn.goal`, the pointer the command family maintains. */
function goalPointer(
  db: CoordinationDatabase,
  turn: number,
): number | undefined {
  const row = db.get<{ goal: number | null }>(
    "SELECT goal FROM turn WHERE identity = ?",
    turn,
  );
  return row?.goal === null || row?.goal === undefined
    ? undefined
    : Number(row.goal);
}

/** Read `turn.compact`, the pointer the Compact module maintains. */
function compactPointer(
  db: CoordinationDatabase,
  turn: number,
): number | undefined {
  const row = db.get<{ compact: number | null }>(
    "SELECT compact FROM turn WHERE identity = ?",
    turn,
  );
  return row?.compact === null || row?.compact === undefined
    ? undefined
    : Number(row.compact);
}

test("COMMAND_PREFIX documents exactly the ten accepted forms", () => {
  assert.deepEqual(COMMAND_PREFIX, {
    "/goal": "goal",
    "/目标": "goal",
    "/plan": "plan",
    "/计划": "plan",
    "/feedback": "feedback",
    "/反馈": "feedback",
    "/compact": "compact",
    "/压缩": "compact",
    "/permission": "permission",
    "/权限": "permission",
  });
});

test("parse reads the leading prefix and keeps the trimmed remainder", (t) => {
  const { host, db } = setup();
  t.after(() => db.close());
  const command = new CommandModule(host, handlers());

  assert.deepEqual(command.parse("/goal build it"), {
    command: "goal",
    content: "build it",
    recognized: true,
  });
  assert.deepEqual(command.parse("/目标 构建目标"), {
    command: "goal",
    content: "构建目标",
    recognized: true,
  });
  assert.deepEqual(command.parse("/plan"), {
    command: "plan",
    content: "",
    recognized: true,
  });
  assert.deepEqual(command.parse("/计划 迁移"), {
    command: "plan",
    content: "迁移",
    recognized: true,
  });
  assert.deepEqual(command.parse("/feedback 太慢"), {
    command: "feedback",
    content: "太慢",
    recognized: true,
  });
  assert.deepEqual(command.parse("/反馈 太慢"), {
    command: "feedback",
    content: "太慢",
    recognized: true,
  });
  assert.deepEqual(command.parse("/compact 摘要"), {
    command: "compact",
    content: "摘要",
    recognized: true,
  });
  assert.deepEqual(command.parse("/压缩 裁剪"), {
    command: "compact",
    content: "裁剪",
    recognized: true,
  });
  assert.deepEqual(command.parse("/permission"), {
    command: "permission",
    content: "",
    recognized: true,
  });
  assert.deepEqual(command.parse("/权限 read-only"), {
    command: "permission",
    content: "read-only",
    recognized: true,
  });

  // Leading whitespace is tolerated; the prefix is still the leading token.
  assert.deepEqual(command.parse("   /goal   spaced   "), {
    command: "goal",
    content: "spaced",
    recognized: true,
  });
  assert.deepEqual(command.parse("/goal\nline one\nline two"), {
    command: "goal",
    content: "line one\nline two",
    recognized: true,
  });
});

test("parse leaves ordinary text and path-like text alone", (t) => {
  const { host, db } = setup();
  t.after(() => db.close());
  const command = new CommandModule(host, handlers());

  for (const text of [
    "/tmp/foo",
    "hello world",
    "/goals",
    "/goal/x",
    "/goal2",
    "/Goal x",
    "//goal",
    "/",
  ]) {
    assert.deepEqual(command.parse(text), {
      command: "none",
      content: text,
      recognized: false,
    });
  }
  // A known prefix must be followed by the end of the message or whitespace.
  assert.deepEqual(command.parse("/反馈:太慢"), {
    command: "none",
    content: "/反馈:太慢",
    recognized: false,
  });
  assert.deepEqual(command.parse(""), {
    command: "none",
    content: "",
    recognized: false,
  });
  assert.deepEqual(command.parse("   "), {
    command: "none",
    content: "",
    recognized: false,
  });
});

test("record appends a command row; execute finishes it and stores the report", async (t) => {
  const { host, db, turn } = setup();
  t.after(() => db.close());
  const received: Array<{ turn: number; content: string }> = [];
  const command = new CommandModule(
    host,
    handlers({
      goal: (turnNumber, content) => {
        received.push({ turn: turnNumber, content });
        return "goal saved";
      },
    }),
  );

  const row = command.record(turn, command.parse("/plan  migrate"));
  assert.equal(row.type, "plan");
  assert.equal(row.content, "migrate");
  assert.equal(row.result, undefined);
  assert.equal(row.finished, undefined);
  assert.match(row.handle, /^coordination-command-/);
  assert.equal(command.resolve(turn)?.identity, row.identity);
  const recordedTurn = db.get<{ command: string }>(
    "SELECT command FROM turn WHERE identity = ?",
    turn,
  );
  assert.equal(recordedTurn?.command, "plan");

  const result = await command.execute(turn, "/目标 发布 v23");
  assert.equal(result.action, "accepted");
  assert.equal(result.message, "goal saved");
  assert.equal(result.command.type, "goal");
  assert.equal(result.command.content, "发布 v23");
  assert.equal(result.command.result, "goal saved");
  assert.equal(typeof result.command.finished, "number");
  assert.deepEqual(received, [{ turn, content: "发布 v23" }]);
  assert.equal(command.resolve(turn)?.identity, result.command.identity);
  const executedTurn = db.get<{ command: string }>(
    "SELECT command FROM turn WHERE identity = ?",
    turn,
  );
  assert.equal(executedTurn?.command, "goal");
});

test("execute reports a thrown typed error with its code and rejects", async (t) => {
  const { host, db, turn } = setup();
  t.after(() => db.close());
  const command = new CommandModule(
    host,
    handlers({
      compact: () => {
        throw new NotImplementedError("DSH compaction port");
      },
    }),
  );

  const result = await command.execute(turn, "/compact summary");
  assert.equal(result.action, "rejected");
  assert.equal(
    result.message,
    "NOT_IMPLEMENTED: DSH compaction port is not available in this composition",
  );
  assert.equal(result.command.result, result.message);
  assert.equal(typeof result.command.finished, "number");
  assert.equal(result.command.type, "compact");
});

test("execute rejects an unregistered handler and accepts plain text as none", async (t) => {
  const { host, db, turn } = setup();
  t.after(() => db.close());
  const command = new CommandModule(host, handlers({ permission: undefined }));

  const rejected = await command.execute(turn, "/permission read-only");
  assert.equal(rejected.action, "rejected");
  assert.match(
    rejected.message ?? "",
    /no handler is registered for command "permission"/,
  );
  assert.equal(typeof rejected.command.finished, "number");

  const plain = await command.execute(turn, "please review the plan");
  assert.equal(plain.action, "accepted");
  assert.equal(plain.command.type, "none");
  assert.match(plain.message ?? "", /no command prefix/);
  assert.equal(typeof plain.command.finished, "number");
});

test("goal set, update, view and clear keep history and the turn pointer", (t) => {
  const { host, db, session, turn } = setup();
  t.after(() => db.close());
  const goals = new GoalModule(host);

  assert.throws(
    () => goals.update(turn, "nothing yet"),
    (error: unknown) => error instanceof NotFoundError,
  );
  assert.throws(
    () => goals.set(turn, "   "),
    (error: unknown) => error instanceof InvalidArgumentError,
  );

  const first = goals.set(turn, "ship v23");
  assert.equal(first.status, "set");
  assert.equal(first.session, session);
  assert.equal(goalPointer(db, turn), first.identity);
  assert.equal(goals.get(turn).identity, first.identity);

  // Re-sending the same goal is a no-op; the history stays one row long.
  const same = goals.set(turn, "ship v23");
  assert.equal(same.identity, first.identity);
  assert.equal(goals.list(session).length, 1);

  const second = goals.set(turn, "ship v23.1");
  assert.equal(second.status, "updated");
  assert.equal(typeof second.changed, "number");
  assert.equal(goalPointer(db, turn), second.identity);
  assert.equal(goals.list(session).length, 2);

  const viewed = goals.execute(turn, "查看");
  assert.equal(viewed.goal.status, "viewed");
  assert.equal(viewed.goal.content, "ship v23.1");
  assert.equal(viewed.rescored, false);
  assert.equal(viewed.plan, undefined);
  assert.equal(goalPointer(db, turn), viewed.goal.identity);

  const cleared = goals.execute(turn, "clear");
  assert.equal(cleared.goal.status, "cleared");
  assert.equal(cleared.goal.reason, "cleared");
  assert.equal(goals.current(turn), undefined);
  assert.throws(
    () => goals.get(turn),
    (error: unknown) => error instanceof NotFoundError,
  );
  assert.throws(
    () => goals.execute(turn, ""),
    (error: unknown) => error instanceof NotFoundError,
  );
  assert.equal(goals.list(session).length, 4);

  // A cleared goal can be set again; the Chinese verbs are accepted too.
  const fresh = goals.execute(turn, "ship v24");
  assert.equal(fresh.goal.status, "set");
  assert.equal(goals.execute(turn, "view").goal.status, "viewed");
  assert.equal(goals.execute(turn, "清除").goal.status, "cleared");
  assert.equal(goals.list(session).length, 7);
});

test("goal and command writes are refused once the turn is terminal", (t) => {
  const { host, db, turn } = setup();
  t.after(() => db.close());
  db.update(
    "turn",
    { status: "done", finished: host.clock.now() },
    "identity = ?",
    turn,
  );

  const goals = new GoalModule(host);
  assert.throws(
    () => goals.set(turn, "too late"),
    (error: unknown) => error instanceof InvalidStateError,
  );

  const command = new CommandModule(host, handlers());
  assert.throws(
    () => command.record(turn, command.parse("/goal x")),
    (error: unknown) => error instanceof InvalidStateError,
  );
});

test("directives are recorded as pending and listed by session", (t) => {
  const { host, db, session, turn } = setup();
  t.after(() => db.close());
  const directives = new DirectiveModule(host);

  const row = directives.execute(turn, "  make the plan smaller  ");
  assert.equal(row.content, "make the plan smaller");
  assert.equal(row.status, "pending");
  assert.equal(row.finished, undefined);
  assert.match(row.handle, /^coordination-directive-/);
  assert.deepEqual(
    directives.list(session).map((item) => item.identity),
    [row.identity],
  );
  assert.deepEqual(directives.list(session + 999), []);
  assert.throws(
    () => directives.execute(turn, "   "),
    (error: unknown) => error instanceof InvalidArgumentError,
  );
});

test("compact without the DSH compaction port is refused, never fabricated", async (t) => {
  const { host, db, turn } = setup();
  t.after(() => db.close());
  const compact = new CompactModule(host);

  await assert.rejects(
    compact.execute(turn, "summary"),
    (error: unknown) =>
      error instanceof NotImplementedError &&
      error.message.includes("DSH compaction port"),
  );
  await assert.rejects(
    compact.compress(turn, "prune"),
    (error: unknown) => error instanceof NotImplementedError,
  );
});

test("compact refuses when no live agent can be resolved", async (t) => {
  const compaction: CompactionPort = { compactNow: async () => "compacted" };
  const agents: AgentPort = { get: () => undefined, list: () => [] };
  const { host, db, turn } = setup({ compaction, agents });
  t.after(() => db.close());
  const compact = new CompactModule(host);

  await assert.rejects(
    compact.compress(turn, "hybrid"),
    (error: unknown) => error instanceof NotImplementedError,
  );
});

test("compact records the port result, the ratio and the turn pointer", async (t) => {
  let reply: unknown = {
    before: "x".repeat(20),
    after: "y".repeat(5),
    reason: "test",
  };
  const compaction: CompactionPort = { compactNow: async () => reply };
  const agents: AgentPort = {
    get: (id) => (id === "session-test" ? { id } : undefined),
    list: () => [],
  };
  const { host, db, turn } = setup({ compaction, agents });
  t.after(() => db.close());
  const compact = new CompactModule(host);

  const result = await compact.execute(turn, "摘要");
  assert.equal(result.cacheBroken, true);
  assert.equal(result.compact.strategy, "summary");
  assert.equal(result.compact.before, "x".repeat(20));
  assert.equal(result.compact.after, "y".repeat(5));
  assert.equal(result.compact.beforeSize, 20);
  assert.equal(result.compact.afterSize, 5);
  assert.equal(result.compact.ratio, 0.25);
  assert.equal(result.compact.reason, "test");
  assert.equal(compactPointer(db, turn), result.compact.identity);

  // A plain string result has no before; it is still recorded defensively.
  reply = "a compacted summary";
  const hybrid = await compact.execute(turn, "no-strategy-word");
  assert.equal(hybrid.compact.strategy, "hybrid");
  assert.equal(hybrid.compact.before, "");
  assert.equal(hybrid.compact.beforeSize, 0);
  assert.equal(hybrid.compact.after, "a compacted summary");
  assert.equal(hybrid.compact.ratio, 1);
  assert.equal(compactPointer(db, turn), hybrid.compact.identity);

  // An unknown result shape is JSON encoded rather than trusted.
  reply = { summary: "pruned context" };
  const object = await compact.execute(turn, "裁剪");
  assert.equal(object.compact.strategy, "prune");
  assert.equal(object.compact.after, '{"summary":"pruned context"}');
  assert.equal(object.compact.reason, "command");

  // A port that reports nothing keeps the audit row, with empty content.
  reply = undefined;
  const empty = await compact.execute(turn, "prune");
  assert.equal(empty.compact.strategy, "prune");
  assert.equal(empty.compact.before, "");
  assert.equal(empty.compact.after, "");
  assert.equal(empty.compact.afterSize, 0);
  assert.equal(empty.compact.ratio, 1);
});

test("compact aborts at clarifyTimeout and reports a typed state error", async (t) => {
  const compaction: CompactionPort = {
    compactNow: (_agent, signal) =>
      new Promise<unknown>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  const agents: AgentPort = {
    get: () => ({ id: "agent-test" }),
    list: () => [],
  };
  const { host, db, turn } = setup({ compaction, agents, clarifyTimeout: 10 });
  t.after(() => db.close());
  const compact = new CompactModule(host);

  await assert.rejects(
    compact.execute(turn, "summary"),
    (error: unknown) =>
      error instanceof InvalidStateError && /timed out/.test(error.message),
  );
});
