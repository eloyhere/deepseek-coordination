import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteExecutionStore } from "../src/host/adapters/sqlite/execution-store.js";
import { resolveConfig } from "../src/host/config.js";
import { CoordinationDatabase } from "../src/host/database.js";
import { SystemClock } from "../src/host/handle.js";
import { SessionModule } from "../src/host/session.js";
import { CoordinationEventBus, createModuleHost } from "../src/host/module.js";
import type { TraceWriter } from "../src/host/module.js";

test("SessionModule delegates persistence through its aggregate port", () => {
  const db = new CoordinationDatabase(":memory:");
  try {
    const host = createModuleHost({
      db,
      config: resolveConfig({}),
      trace: undefined as unknown as TraceWriter,
      clock: SystemClock,
      events: new CoordinationEventBus(),
      executionStore: new SqliteExecutionStore(db),
    });
    const sessions = new SessionModule(
      host.executionStore!,
      host.config,
      host.clock,
    );

    const created = sessions.ensure("session-1", {
      cwd: "R:/workspace",
      profile: "work",
    });
    assert.equal(created.status, "active");
    assert.equal(created.generation, 1);
    assert.equal(created.scene, host.config.defaults.scene);
    assert.equal(sessions.metrics(), 1);

    sessions.update(created.identity, { profile: "review" });
    sessions.end(created.identity);
    const ended = sessions.get(created.identity);
    assert.equal(ended.status, "ended");
    assert.equal(ended.profile, "review");

    const reactivated = sessions.ensure("session-1");
    assert.equal(reactivated.identity, created.identity);
    assert.equal(reactivated.generation, 2);
    assert.equal(reactivated.status, "active");
    assert.deepEqual(
      sessions.list().map(({ handle }) => handle),
      ["session-1"],
    );
  } finally {
    db.close();
  }
});

test("SessionModule stays inside the AMP domain-to-port boundary", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/host/session.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /node:sqlite|database\.js|row\.js|\.db\b/i);
  assert.doesNotMatch(
    source,
    /\b(?:SELECT|INSERT|DELETE)\s+|\bUPDATE\s+[A-Z_\"]+\s+SET/i,
  );
});

test("TraceModule stays inside the AMP domain-to-port boundary", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/host/trace.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /node:sqlite|database\.js|row\.js|\.db\b/i);
  assert.doesNotMatch(
    source,
    /\b(?:SELECT|INSERT|DELETE)\s+|\bUPDATE\s+[A-Z_\"]+\s+SET/i,
  );
});

test("TurnModule stays inside the AMP domain-to-port boundary", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/host/turn.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /node:sqlite|database\.js|row\.js|\.db\b/i);
  assert.doesNotMatch(
    source,
    /\b(?:SELECT|INSERT|DELETE)\s+|\bUPDATE\s+[A-Z_\"]+\s+SET/i,
  );
});
