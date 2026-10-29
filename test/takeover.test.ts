/**
 * Permission + takeover module tests (v23 §6.4, §16, §17.1).
 *
 * The fixture builds a real in-memory coordination database, the resolved
 * config (`resolveConfig`, so schema additions never drift this file), the real
 * append-only trace writer and the same `ModuleHost` kernel the service uses.
 * Optional DSH ports (approval, agents, permission presets) are faked
 * structurally so the tests prove the fail-closed behaviour without importing
 * DSH. Sessions and turns are inserted with SQL instead of a module, keeping
 * the suite independent of the concurrently written turn/selection modules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoordinationDatabase } from "../src/host/database.js";
import { CoordinationEventBus, createModuleHost } from "../src/host/module.js";
import type {
  AgentPort,
  AgentView,
  ApprovalPort,
  ModuleHost,
  PermissionPresetPort,
} from "../src/host/module.js";
import { HandleGenerator, SystemClock } from "../src/host/handle.js";
import { TraceModule } from "../src/host/trace.js";
import { SqliteTraceStore } from "../src/host/adapters/sqlite/trace-store.js";
import { resolveConfig } from "../src/host/config.js";
import { PermissionModule } from "../src/host/permission.js";
import { TakeoverModule } from "../src/host/takeover.js";
import type { Takeover } from "../src/shared/entity.js";
import type { TakeoverType } from "../src/shared/enum.js";
import type { TakeoverPayload } from "../src/shared/service.js";
import {
  InvalidArgumentError,
  InvalidStateError,
  NotFoundError,
} from "../src/shared/error.js";

/* ------------------------------------------------------------------------- *
 * Harness
 * ------------------------------------------------------------------------- */

interface HarnessOptions {
  takeover?: boolean;
  approval?: ApprovalPort;
  agents?: AgentPort;
  permissionPresets?: PermissionPresetPort;
}

interface Harness {
  host: ModuleHost;
  db: CoordinationDatabase;
  permission: PermissionModule;
  takeover: TakeoverModule;
}

/**
 * Compose the kernel with an explicit trace persistence adapter and keep the
 * append-only domain logic independent from the database.
 */
function harness(options: HarnessOptions = {}): Harness {
  const db = new CoordinationDatabase(":memory:");
  const config = resolveConfig(undefined);
  config.ui.takeover = options.takeover ?? false;
  const handles = new HandleGenerator("test");
  const clock = SystemClock;
  const trace = new TraceModule(new SqliteTraceStore(db), handles, clock);
  const host = createModuleHost({
    db,
    config,
    trace,
    handles,
    clock,
    events: new CoordinationEventBus(),
    ...(options.approval === undefined ? {} : { approval: options.approval }),
    ...(options.agents === undefined ? {} : { agents: options.agents }),
    ...(options.permissionPresets === undefined
      ? {}
      : { permissionPresets: options.permissionPresets }),
  });
  return {
    host,
    db,
    permission: new PermissionModule(host),
    takeover: new TakeoverModule(host),
  };
}

let sessionSerial = 0;
let turnSerial = 0;

/** Create one coordination session; its handle doubles as the DSH session id. */
function startSession(context: Harness, handle?: string): number {
  sessionSerial += 1;
  return context.db.insert("session", {
    handle: handle ?? `takeover-session-${sessionSerial}`,
    principal: "test",
    sandbox: "danger-full-access",
    interaction: "think",
    scene: "dialogue",
    validation: "medium",
    profile: "default",
    generation: 1,
    status: "active",
    created: Date.now(),
  });
}

/** Insert one turn, the subject the permission command face acts on. */
function startTurn(context: Harness, session: number): number {
  turnSerial += 1;
  const next = context.db.get<{ ordinal: number }>(
    "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM turn WHERE session = ?",
    session,
  );
  return context.db.insert("turn", {
    handle: `takeover-turn-${turnSerial}`,
    session,
    ordinal: next?.ordinal ?? 1,
    interaction: "think",
    scene: "dialogue",
    validation: "medium",
    profession: "execution",
    locked: 1,
    effort: "medium",
    status: "pending",
    created: Date.now(),
  });
}

/* ------------------------------------------------------------------------- *
 * Permission
 * ------------------------------------------------------------------------- */

test("permission denies by default and allows an empty request", () => {
  const context = harness();
  const denied = context.permission.check("build", ["shell"]);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? "", /not granted/);
  assert.deepEqual(context.permission.check("build", []), { allowed: true });
  assert.equal(context.permission.check("   ", ["shell"]).allowed, false);
});

test("a recorded grant makes check allow it, for every named grant", () => {
  const context = harness();
  const session = startSession(context);

  const granted = context.permission.request(
    "build",
    ["shell", "network"],
    "integration test",
    session,
  );
  assert.equal(granted.allowed, true);
  assert.equal(granted.reason, undefined);
  assert.equal(context.permission.check("build", ["shell"]).allowed, true);
  assert.equal(
    context.permission.check("build", ["shell", "network"]).allowed,
    true,
  );

  const partial = context.permission.check("build", ["shell", "filesystem"]);
  assert.equal(partial.allowed, false);
  assert.match(partial.reason ?? "", /filesystem/);

  const again = context.permission.request(
    "build",
    ["shell"],
    "again",
    session,
  );
  assert.equal(again.allowed, true);
  assert.match(again.reason ?? "", /already granted/);
  assert.equal(
    context.db.count(
      "permission",
      "subject = ? AND grant = ?",
      "build",
      "shell",
    ),
    1,
  );
});

test("a request that cannot be recorded is refused instead of widened", () => {
  const context = harness();
  const session = startSession(context);

  const missingSession = context.permission.request(
    "build",
    ["shell"],
    "no session",
  );
  assert.equal(missingSession.allowed, false);
  assert.match(missingSession.reason ?? "", /session is required/);

  const unknownSession = context.permission.request(
    "build",
    ["shell"],
    "unknown session",
    42,
  );
  assert.equal(unknownSession.allowed, false);
  assert.match(unknownSession.reason ?? "", /not recorded/);

  const empty = context.permission.request(
    "build",
    [],
    "nothing asked",
    session,
  );
  assert.equal(empty.allowed, false);
  assert.match(empty.reason ?? "", /at least one grant/);

  const malformed = context.permission.request(
    "build",
    ["  "],
    "blank grant",
    session,
  );
  assert.equal(malformed.allowed, false);
  assert.equal(context.db.count("permission"), 0);
});

test("request never applies a sandbox preset on its own", () => {
  let presetWrites = 0;
  const presets: PermissionPresetPort = {
    catalog() {
      return {
        options: [{ value: "workspace-write", name: "workspace-write" }],
      };
    },
    current() {
      return "workspace-write";
    },
    set() {
      presetWrites += 1;
    },
  };
  const context = harness({ permissionPresets: presets });
  const session = startSession(context);
  const result = context.permission.request(
    "build",
    ["shell"],
    "no approval directive",
    session,
  );
  assert.equal(result.allowed, true);
  assert.equal(presetWrites, 0);
  assert.equal(context.permission.check("build", ["shell"]).allowed, true);
});

test("revoke withdraws grants, scopes by session, and stays idempotent", () => {
  const context = harness();
  const first = startSession(context, "first");
  const second = startSession(context, "second");

  context.permission.request(
    "build",
    ["shell", "network"],
    "grant both",
    first,
  );
  context.permission.request("build", ["shell"], "grant shell", second);
  context.permission.request("filesystem", ["read"], "grant read", first);

  context.permission.revoke("build", ["shell"], first);
  assert.equal(
    context.permission.check("build", ["shell"]).allowed,
    true,
    "the second session still grants it",
  );
  assert.equal(context.permission.check("build", ["network"]).allowed, true);
  context.permission.revoke("build", ["shell"], first);
  context.permission.revoke("build", undefined, first);
  assert.equal(context.permission.check("build", ["network"]).allowed, false);
  assert.equal(context.permission.check("build", ["shell"]).allowed, true);
  assert.equal(context.permission.check("filesystem", ["read"]).allowed, true);

  context.permission.request(
    "build",
    ["network"],
    "grant network again",
    first,
  );
  assert.equal(context.permission.check("build", ["network"]).allowed, true);
  assert.deepEqual(context.permission.list(first), [
    { subject: "build", grant: ["shell"], status: "revoked" },
    { subject: "build", grant: ["network"], status: "granted" },
    { subject: "filesystem", grant: ["read"], status: "granted" },
  ]);
});

test("list reports the current grants of one session only", () => {
  const context = harness();
  const first = startSession(context, "first");
  const second = startSession(context, "second");

  context.permission.request("build", ["shell"], "grant shell", first);
  context.permission.request(
    "filesystem",
    ["read", "write"],
    "grant files",
    first,
  );
  context.permission.revoke("filesystem", ["read"], first);
  context.permission.request("network", ["connect"], "grant network", second);

  assert.deepEqual(context.permission.list(first), [
    { subject: "build", grant: ["shell"], status: "granted" },
    { subject: "filesystem", grant: ["read"], status: "revoked" },
    { subject: "filesystem", grant: ["write"], status: "granted" },
  ]);
  assert.deepEqual(context.permission.list(second), [
    { subject: "network", grant: ["connect"], status: "granted" },
  ]);
  assert.deepEqual(context.permission.list(999), []);
});

test("permission command face parses allow/deny/revoke/status", () => {
  const context = harness();
  const session = startSession(context);
  const turn = startTurn(context, session);

  const allow = context.permission.execute(turn, "allow build shell network");
  assert.equal(allow.allowed, true);
  assert.equal(
    context.permission.check("build", ["shell", "network"]).allowed,
    true,
  );

  const status = context.permission.execute(turn, "status build");
  assert.equal(status.allowed, true);
  assert.match(status.reason ?? "", /"build"/);
  assert.match(status.reason ?? "", /shell/);

  const deny = context.permission.execute(turn, "deny build");
  assert.equal(deny.allowed, false);
  assert.match(deny.reason ?? "", /denied/);

  const revoke = context.permission.execute(turn, "revoke build shell");
  assert.equal(revoke.allowed, false);
  assert.equal(context.permission.check("build", ["shell"]).allowed, false);
  assert.equal(context.permission.check("build", ["network"]).allowed, true);

  const unknown = context.permission.execute(turn, "approve build shell");
  assert.equal(unknown.allowed, false);
  assert.match(unknown.reason ?? "", /unknown permission command/);

  const empty = context.permission.execute(turn, "   ");
  assert.equal(empty.allowed, false);
  const missingTurn = context.permission.execute(9999, "status");
  assert.equal(missingTurn.allowed, false);
});

test("permission command face accepts the Chinese verbs", () => {
  const context = harness();
  const session = startSession(context);
  const turn = startTurn(context, session);

  assert.equal(
    context.permission.execute(turn, "允许 build shell").allowed,
    true,
  );
  assert.equal(context.permission.check("build", ["shell"]).allowed, true);

  const status = context.permission.execute(turn, "查看 build");
  assert.equal(status.allowed, true);
  assert.match(status.reason ?? "", /shell/);

  const revoke = context.permission.execute(turn, "撤销 build shell");
  assert.equal(revoke.allowed, false);
  assert.equal(context.permission.check("build", ["shell"]).allowed, false);

  assert.equal(context.permission.execute(turn, "拒绝").allowed, false);
});

test("an approval policy request needs the approval port and a live agent", () => {
  const context = harness();
  const session = startSession(context);

  const refused = context.permission.request(
    "build",
    ["shell"],
    "please set approval=never",
    session,
  );
  assert.equal(refused.allowed, false);
  assert.match(refused.reason ?? "", /no approval port/);
  assert.equal(context.permission.check("build", ["shell"]).allowed, false);
  assert.deepEqual(context.permission.list(session), [
    { subject: "build", grant: ["shell"], status: "pending" },
  ]);

  const calls: Array<{ agent: AgentView; policy: unknown }> = [];
  const approval: ApprovalPort = {
    setPolicy(agent, policy) {
      calls.push({ agent, policy });
    },
  };
  const agents: AgentPort = {
    get(id) {
      return id === "live-session"
        ? { id: "agent-1", session: "live-session" }
        : undefined;
    },
    list() {
      return [];
    },
  };

  const noAgent = harness({ approval });
  const plain = startSession(noAgent, "plain-session");
  const missingAgent = noAgent.permission.request(
    "build",
    ["shell"],
    "approval=ask",
    plain,
  );
  assert.equal(missingAgent.allowed, false);
  assert.match(missingAgent.reason ?? "", /no live agent/);

  const live = harness({ approval, agents });
  const liveSession = startSession(live, "live-session");
  const applied = live.permission.request(
    "build",
    ["shell"],
    "approval=never",
    liveSession,
  );
  assert.equal(applied.allowed, true);
  assert.equal(applied.reason, 'approval policy set to "never"');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.policy, "never");
  assert.equal(live.permission.check("build", ["shell"]).allowed, true);

  const failing: ApprovalPort = {
    setPolicy() {
      throw new Error("policy rejected by DSH");
    },
  };
  const refusedPort = harness({ approval: failing, agents });
  const refusedSession = startSession(refusedPort, "live-session");
  const rejected = refusedPort.permission.request(
    "build",
    ["shell"],
    "approval=never",
    refusedSession,
  );
  assert.equal(rejected.allowed, false);
  assert.match(rejected.reason ?? "", /refused/);
  assert.equal(refusedPort.permission.check("build", ["shell"]).allowed, false);
});

/* ------------------------------------------------------------------------- *
 * Takeover
 * ------------------------------------------------------------------------- */

test("takeover is rejected while interception is disabled", () => {
  const context = harness();
  const session = startSession(context);
  const turn = startTurn(context, session);

  assert.equal(context.takeover.should("permission"), false);
  assert.deepEqual(
    context.takeover.request({
      type: "permission",
      payload: { title: "Approve shell" },
      session,
    }),
    {
      accepted: false,
      reason: "takeover disabled",
    },
  );
  assert.equal(context.takeover.list(session).length, 0);
  assert.deepEqual(
    context.takeover.escalateProfessionConflict({
      turn,
      session,
      current: "execution",
      requested: "outcome",
    }),
    { accepted: false, reason: "takeover disabled" },
  );
});

test("a takeover is pending until resolved and resolution is terminal", () => {
  const context = harness({ takeover: true });
  const session = startSession(context);
  assert.equal(context.takeover.should("approval"), true);

  const requested = context.takeover.request({
    type: "approval",
    payload: { title: "Run tests?" },
    session,
  });
  assert.equal(requested.accepted, true);
  const value = requested.value as { handle: string; status: string };
  assert.equal(value.status, "pending");

  const pending = context.takeover.get(value.handle);
  assert.equal(pending.status, "pending");
  assert.equal(pending.type, "approval");
  assert.equal(pending.session, session);
  assert.equal(pending.finished, undefined);

  const resolved = context.takeover.resolve(value.handle, {
    accepted: true,
    value: { choice: "yes" },
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(typeof resolved.finished, "number");
  assert.equal(
    (JSON.parse(resolved.result ?? "{}") as { accepted?: boolean }).accepted,
    true,
  );

  assert.throws(
    () => context.takeover.resolve(value.handle, { accepted: false }),
    (error: unknown) =>
      error instanceof InvalidStateError && error.code === "INVALID_STATE",
  );
  assert.throws(
    () => context.takeover.cancel(value.handle),
    (error: unknown) => error instanceof InvalidStateError,
  );
  assert.equal(context.takeover.get(value.handle).status, "resolved");
});

test("cancel is idempotent and a cancelled takeover cannot be resolved", () => {
  const context = harness({ takeover: true });
  const session = startSession(context);
  const requested = context.takeover.request({
    type: "permission",
    payload: { message: "grant shell?" },
    session,
  });
  const handle = (requested.value as { handle: string }).handle;

  const cancelled = context.takeover.cancel(handle);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(typeof cancelled.finished, "number");

  const again = context.takeover.cancel(handle);
  assert.equal(again.status, "cancelled");
  assert.equal(again.identity, cancelled.identity);
  assert.equal(again.finished, cancelled.finished);

  assert.throws(
    () => context.takeover.resolve(handle, { accepted: true }),
    (error: unknown) =>
      error instanceof InvalidStateError && error.code === "INVALID_STATE",
  );
  assert.equal(context.takeover.get(handle).status, "cancelled");
});

test("profession conflict escalation carries current/requested and the rebuild/abandon hint", () => {
  const context = harness({ takeover: true });
  const session = startSession(context);
  const turn = startTurn(context, session);

  const result = context.takeover.escalateProfessionConflict({
    turn,
    session,
    current: "execution",
    requested: "outcome",
  });
  assert.equal(result.accepted, true);
  const handle = (result.value as { handle: string }).handle;
  const takeover = context.takeover.get(handle);
  assert.equal(takeover.type, "errorescalation");
  assert.equal(takeover.session, session);

  const payload = JSON.parse(takeover.payload) as Record<string, unknown>;
  assert.equal(payload.current, "execution");
  assert.equal(payload.requested, "outcome");
  assert.equal(payload.turn, turn);
  assert.match(String(payload.hint), /rebuild/);
  assert.match(String(payload.hint), /abandon/);
  assert.deepEqual(payload.options, ["rebuild", "abandon"]);
  assert.deepEqual(payload.fields, ["current", "requested", "action"]);

  const resolved = context.takeover.resolve(handle, {
    accepted: true,
    value: { action: "rebuild", profession: "outcome" },
  });
  assert.equal(resolved.status, "resolved");

  const other = startSession(context, "other");
  assert.throws(
    () =>
      context.takeover.escalateProfessionConflict({
        turn,
        session: other,
        current: "execution",
        requested: "outcome",
      }),
    (error: unknown) => error instanceof InvalidArgumentError,
  );
});

test("takeovers are listed per session and emit lifecycle events", () => {
  const context = harness({ takeover: true });
  const first = startSession(context, "first");
  const second = startSession(context, "second");
  const requested: Takeover[] = [];
  const resolved: Takeover[] = [];
  context.host.events.on("takeover/requested", (payload) => {
    requested.push(payload as Takeover);
  });
  context.host.events.on("takeover/resolved", (payload) => {
    resolved.push(payload as Takeover);
  });

  const firstRequest = context.takeover.request({
    type: "planreview",
    payload: { title: "review plan" },
    session: first,
  });
  const secondRequest = context.takeover.request({
    type: "question",
    payload: { message: "which route?" },
    session: second,
  });
  const firstHandle = (firstRequest.value as { handle: string }).handle;
  const secondHandle = (secondRequest.value as { handle: string }).handle;

  assert.equal(context.takeover.list(first).length, 1);
  assert.equal(context.takeover.list(second).length, 1);
  assert.equal(context.takeover.list(first)[0]?.handle, firstHandle);
  assert.equal(context.takeover.list(second)[0]?.handle, secondHandle);
  assert.deepEqual(context.takeover.list(999), []);

  context.takeover.cancel(secondHandle);
  assert.equal(requested.length, 2);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.status, "cancelled");
  assert.equal(resolved[0]?.handle, secondHandle);

  assert.throws(
    () => context.takeover.get("missing-handle"),
    (error: unknown) =>
      error instanceof NotFoundError && error.code === "NOT_FOUND",
  );
});

test("a takeover request validates its type, payload and session", () => {
  const context = harness({ takeover: true });
  assert.throws(
    () =>
      context.takeover.request({ type: "bogus" as TakeoverType, payload: {} }),
    (error: unknown) => error instanceof InvalidArgumentError,
  );
  assert.throws(
    () =>
      context.takeover.request({
        type: "approval",
        payload: undefined as unknown as TakeoverPayload,
      }),
    (error: unknown) => error instanceof InvalidArgumentError,
  );
  assert.throws(
    () =>
      context.takeover.request({ type: "approval", payload: {}, session: 99 }),
    (error: unknown) => error instanceof NotFoundError,
  );
});
